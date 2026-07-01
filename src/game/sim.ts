import { acquireTargets, ensureFleeGoal } from "./ai.ts";
import { commandAI } from "./axisAI.ts";
import { resolveFire, updateGrenades, updateMelee } from "./combat.ts";
import {
  BASE_MOVE_SPEED,
  BATTLE_TIME_S,
  COHESION_GAIN,
  COHESION_LEAD,
  COHESION_MAX,
  COHESION_NEAR,
  OBJECTIVE_CAPTURE_TIME,
  OBJECTIVE_HOLD_TO_WIN,
  REGROUP_DIST,
  SIM_DT,
  SMOKE_BUILD,
  SMOKE_CAP,
  SMOKE_DECAY,
  SMOKE_EMIT,
  SMOKE_LIFE,
  SMOKE_RADIUS,
  STANCE_SPEED,
  VIS_INTERVAL,
} from "./constants.ts";
import { Faction } from "./world.ts";
import { hasLOS } from "./los.ts";
import { updateMorale } from "./morale.ts";
import { findPath, smoothPath } from "./pathfinding.ts";
import { TERRAIN } from "./terrain.ts";
import { updateVehicles } from "./vehicleSim.ts";
import { updateVisibility } from "./visibility.ts";
import { Soldier, Team, unitPassable, World } from "./world.ts";

// One fixed simulation step, in the order that makes the firefight read correctly:
// see → acquire → fire → feel → act.
export function step(world: World): void {
  // During deployment the clock is frozen; only movement and spotting run.
  if (world.phase === "deploy") {
    ageEffects(world, SIM_DT); // let transient markers (e.g. blocked-move) fade
    world.visAccum += SIM_DT;
    if (world.visAccum >= VIS_INTERVAL) {
      updateVisibility(world, world.visAccum);
      world.visAccum = 0;
    }
    moveSoldiers(world);
    return;
  }

  world.time += SIM_DT;
  ageEffects(world, SIM_DT);
  updateSmoke(world, SIM_DT);

  world.visAccum += SIM_DT;
  if (world.visAccum >= VIS_INTERVAL) {
    updateVisibility(world, world.visAccum);
    world.visAccum = 0;
  }

  if (!world.aiHuman) commandAI(world, SIM_DT); // a human opponent replaces the AI
  acquireTargets(world);
  resolveFire(world, SIM_DT);
  updateGrenades(world, SIM_DT); // detonate grenades whose fuse has run out
  updateMelee(world, SIM_DT); // resolve hand-to-hand for everyone in contact
  updateVehicles(world);
  updateMorale(world, SIM_DT);
  moveSoldiers(world);
  updateObjective(world, SIM_DT);

  if (!world.outcome) world.outcome = checkOutcome(world);
  // Time's up. An attacker that doesn't hold all objectives by the deadline has failed;
  // a defender that still denies them has held. The winner is resolved relative to the
  // human player.
  if (!world.outcome && world.time >= BATTLE_TIME_S) world.outcome = timeoutOutcome(world);
}

// Who wins if the clock runs out: whoever holds every objective wins outright; if nobody
// does, the defending side has held (denial). In a meeting (both attack, no defender)
// the side holding more objectives wins, ties going to the AI. Expressed as the human's
// result.
function timeoutOutcome(world: World): "win" | "lose" {
  const holder = world.objAllOwner();
  let winner: Faction;
  if (holder) {
    winner = holder;
  } else if (world.roleOf("us") === "defend") {
    winner = "us";
  } else if (world.roleOf("axis") === "defend") {
    winner = "axis";
  } else {
    let us = 0, axis = 0;
    for (const o of world.objectives) { if (o.owner === "us") us++; else if (o.owner === "axis") axis++; }
    winner = us > axis ? "us" : axis > us ? "axis" : world.aiFaction;
  }
  return winner === world.player ? "win" : "lose";
}

// Capture-and-hold. A side captures an objective by being the only one with units in
// its zone for OBJECTIVE_CAPTURE_TIME; the attacker (US) wins by controlling EVERY
// objective at once for OBJECTIVE_HOLD_TO_WIN seconds. Elimination still ends it.
function updateObjective(world: World, dt: number): void {
  for (const o of world.objectives) {
    const r2 = o.radius * o.radius;
    let us = 0, axis = 0;
    for (const s of world.soldiers) {
      if (s.status !== "active") continue;
      if ((s.x - o.cx - 0.5) ** 2 + (s.y - o.cy - 0.5) ** 2 <= r2) (s.faction === "us" ? us++ : axis++);
    }
    for (const v of world.vehicles) {
      if (v.status === "ko") continue;
      if ((v.x - o.cx - 0.5) ** 2 + (v.y - o.cy - 0.5) ** 2 <= r2) (v.faction === "us" ? (us += 2) : (axis += 2));
    }

    o.contested = us > 0 && axis > 0;
    const sole: Faction | null = us > 0 && axis === 0 ? "us" : axis > 0 && us === 0 ? "axis" : null;
    // A sole presence captures from anyone who isn't them (including a neutral flag).
    o.capturing = sole && sole !== o.owner ? sole : null;

    if (o.capturing) {
      o.progress += dt / OBJECTIVE_CAPTURE_TIME;
      if (o.progress >= 1) { o.owner = o.capturing; o.progress = 0; o.capturing = null; }
    } else if (!o.contested) {
      o.progress = Math.max(0, o.progress - dt / OBJECTIVE_CAPTURE_TIME);
    }
  }

  // An ATTACKING side that holds EVERY objective for the hold time wins. Defenders win
  // by denial at the timeout, not by sitting on what they started with — so the timer
  // only runs for an attacker. Losing any objective resets it.
  const holder = world.objAllOwner();
  if (holder && world.roleOf(holder) === "attack") {
    if (world.holdFaction !== holder) { world.holdFaction = holder; world.objHoldTimer = 0; }
    world.objHoldTimer += dt;
    if (world.objHoldTimer >= OBJECTIVE_HOLD_TO_WIN && !world.outcome) {
      world.outcome = holder === world.player ? "win" : "lose";
    }
  } else {
    world.holdFaction = null;
    world.objHoldTimer = 0;
  }
}

function moveSoldiers(world: World): void {
  // Where each squad's body of men currently is — the rally point for cohesion.
  const centers = teamCenters(world);

  // Walk each marching formation's guide-point forward as one body, before the men move.
  for (const team of world.teams) if (team.march) advanceMarch(world, team);

  for (const s of world.soldiers) {
    s.px = s.x;
    s.py = s.y;
    if (s.status !== "active") continue;

    // If a soldier somehow ended up on impassable terrain (bad spawn, building
    // collapse edge-case), snap them to the nearest clear cell immediately.
    const scx = Math.floor(s.x);
    const scy = Math.floor(s.y);
    if (!world.grid.passable(scx, scy)) {
      const c = world.nearestPassable(scx, scy, { cx: scx, cy: scy });
      s.x = c.cx + 0.5;
      s.y = c.cy + 0.5;
      s.path = null;
    }

    switch (s.state) {
      case "panicked":
        s.path = null; // freeze and cower
        continue;
      case "pinned":
        continue; // hug the ground; keep the order to resume once fire lifts
      case "routing":
        ensureFleeGoal(world, s);
        advance(world, s, 1.25 * s.gait);
        continue;
      default: {
        // With an enemy inside sprinting distance, close the ground and go at him with the
        // bayonet/sabre instead of trading fire — the melee itself is resolved in updateMelee.
        const rushTarget = meleeRush(world, s);
        if (rushTarget) { rushToward(world, s, rushTarget); break; }
        const team = world.team(s.teamId);
        if (team && team.march) {
          // Marching in formation: hold your slot relative to the advancing guide-point.
          steerToSlot(world, s, team);
        } else {
          // Pace set by the commanded stance and the man's own gait, slowed if shaken,
          // then nudged by cohesion so the squad stays a single body on the move.
          const mul = STANCE_SPEED[s.stance] * (s.state === "shaken" ? 0.7 : 1) * s.gait;
          advance(world, s, mul * cohesionFactor(s, centers.get(s.teamId)));
        }
      }
    }
  }

  regroupStragglers(world, centers);
}

interface Pt2 { x: number; y: number; }

// Center of mass of each squad's still-standing men.
function teamCenters(world: World): Map<number, Pt2> {
  const acc = new Map<number, { x: number; y: number; n: number }>();
  for (const s of world.soldiers) {
    if (s.status !== "active") continue;
    let a = acc.get(s.teamId);
    if (!a) { a = { x: 0, y: 0, n: 0 }; acc.set(s.teamId, a); }
    a.x += s.x;
    a.y += s.y;
    a.n++;
  }
  const out = new Map<number, Pt2>();
  for (const [id, a] of acc) out.set(id, { x: a.x / a.n, y: a.y / a.n });
  return out;
}

// Rubber-band a moving man to his squad: if the squad's center is ahead of him he's
// lagging, so hurry up; if he's the one out front, ease off so the others close the gap.
function cohesionFactor(s: Soldier, center: Pt2 | undefined): number {
  if (!center || !s.path) return 1;
  if (s.stance === "defend" || s.stance === "ambush") return 1; // held posture: don't shuffle
  if (s.weapon === "cannon") return 1; // the gun plods at its own slow pace, never hurried by the crew
  const toCx = center.x - s.x;
  const toCy = center.y - s.y;
  const d = Math.hypot(toCx, toCy);
  if (d < COHESION_NEAR) return 1;
  const wp = s.path[s.pathIndex];
  if (!wp) return 1;
  const hx = wp.cx + 0.5 - s.x;
  const hy = wp.cy + 0.5 - s.y;
  const hl = Math.hypot(hx, hy) || 1;
  const dot = (toCx / d) * (hx / hl) + (toCy / d) * (hy / hl); // is the squad ahead of me?
  if (dot > 0.1) return Math.min(COHESION_MAX, 1 + (d - COHESION_NEAR) * COHESION_GAIN);
  if (dot < -0.1) return COHESION_LEAD;
  return 1;
}

// Any man who has stopped moving but is stranded far from his squad re-paths to rejoin.
// Held postures (Defend/Ambush), men firing in place, and the pinned/panicked are left
// where they are — this only gathers up the genuinely-left-behind.
function regroupStragglers(world: World, centers: Map<number, Pt2>): void {
  for (const team of world.teams) {
    if (team.march) continue; // a marching formation keeps its own shape
    const center = centers.get(team.id);
    if (!center) continue;
    for (const id of team.soldierIds) {
      const s = world.soldier(id)!;
      if (s.status !== "active" || s.path) continue;
      if (s.stance === "defend" || s.stance === "ambush") continue;
      if (s.fireCell || s.manualTargetId != null) continue;
      if (s.state !== "steady" && s.state !== "shaken") continue;
      if (Math.hypot(center.x - s.x, center.y - s.y) <= REGROUP_DIST) continue;

      const gx = Math.round(center.x - 0.5 + s.ox * 0.6);
      const gy = Math.round(center.y - 0.5 + s.oy * 0.6);
      const pass = unitPassable(world.grid, s.weapon);
      const goal = world.nearestPassable(gx, gy, { cx: Math.floor(center.x), cy: Math.floor(center.y) }, pass);
      const start = { cx: Math.floor(s.x), cy: Math.floor(s.y) };
      const raw = findPath(world.grid, start, goal, { passable: pass });
      if (raw && raw.length > 1) {
        s.path = smoothPath(world.grid, raw, { passable: pass });
        s.pathIndex = 1;
      }
    }
  }
}

// Per-man ground-speed multiplier. Cavalry cover ground faster than men on foot; a heavy
// field gun is manhandled slowly. Civil War foot soldiers hold a measured pace and only
// really move out at the double when ordered to charge.
function weaponMoveFactor(s: Soldier): number {
  return s.weapon === "carbine" ? 1.7
    : s.weapon === "cannon" ? 0.4
    : s.weapon === "riflemusket" ? (s.stance === "charge" ? 1.15 : 0.55)
    : 1;
}

// Walk a marching squad's guide-point forward this step at the pace of its slowest man, so
// the whole formation advances as one body. Clears the march once it reaches the objective,
// or pauses it if the squad is mostly pinned/broken (no one left to follow).
function advanceMarch(world: World, team: Team): void {
  const m = team.march;
  if (!m) return;
  const men = team.soldierIds.map((id) => world.soldier(id)).filter((s): s is Soldier => !!s && s.status === "active");
  const following = men.filter((s) => s.state === "steady" || s.state === "shaken");
  if (men.length === 0) { team.march = null; return; }
  if (following.length * 2 < men.length) return; // squad's not moving — hold the guide in place

  let minFactor = Infinity;
  for (const s of men) minFactor = Math.min(minFactor, weaponMoveFactor(s));
  const cx = Math.floor(m.x), cy = Math.floor(m.y);
  const cost = world.grid.inBounds(cx, cy) ? TERRAIN[world.grid.get(cx, cy)].moveCost : 1;
  const stanceMul = STANCE_SPEED[following[0]?.stance ?? "move"] ?? 1;
  let budget = (BASE_MOVE_SPEED / (isFinite(cost) ? cost : 1)) * stanceMul * minFactor * SIM_DT;

  while (budget > 0 && m.idx < m.guide.length) {
    const wp = m.guide[m.idx];
    const tx = wp.cx + 0.5, ty = wp.cy + 0.5;
    const dx = tx - m.x, dy = ty - m.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-4) { m.idx++; continue; }
    m.hx = dx / dist; m.hy = dy / dist;
    if (dist <= budget) { m.x = tx; m.y = ty; budget -= dist; m.idx++; }
    else { m.x += (dx / dist) * budget; m.y += (dy / dist) * budget; budget = 0; }
  }
  if (m.idx >= m.guide.length) team.march = null; // arrived; men settle at their slots
}

// Steer a man toward his formation slot (a fixed offset from the advancing guide-point),
// a touch faster than the formation so a lagging man closes up rather than trailing off.
function steerToSlot(world: World, s: Soldier, team: Team): void {
  const m = team.march!;
  const tx = m.x + s.ox, ty = m.y + s.oy;
  const dx = tx - s.x, dy = ty - s.y;
  const dist = Math.hypot(dx, dy);
  const cx = Math.floor(s.x), cy = Math.floor(s.y);
  const cost = world.grid.inBounds(cx, cy) ? TERRAIN[world.grid.get(cx, cy)].moveCost : 1;
  const step = (BASE_MOVE_SPEED / (isFinite(cost) ? cost : 1)) * (STANCE_SPEED[s.stance] ?? 1) * weaponMoveFactor(s) * s.gait * SIM_DT * 1.6;
  s.facing = Math.atan2(m.hy, m.hx); // face the line of march
  if (dist <= 1e-4) return;
  // Move only onto walkable ground — never teleport-snap (that's what made men pop in and
  // out of buildings). If a wall is dead ahead, slide along it; if truly boxed in, hold.
  moveOnto(world, s, dx / dist, dy / dist, Math.min(step, dist));
}

const SPRINT_MELEE_RANGE = 6; // cells; an enemy this close is rushed with cold steel
const MELEE_STOP = 0.8; // cells; how close the rusher pulls up (inside melee reach)

// If an enemy is within sprinting distance and in view, return the nearest one to charge.
// Only assault troops rush — crew-served weapons (MG, mortar, gun) and hidden men hold.
function meleeRush(world: World, s: Soldier): Soldier | null {
  if (s.stance === "sneak" || s.stance === "ambush") return null;
  const w = s.weapon;
  if (w === "lmg" || w === "mortar" || w === "cannon" || w === "bazooka" || w === "panzerfaust") return null;
  let best: Soldier | null = null;
  let bestD = SPRINT_MELEE_RANGE * SPRINT_MELEE_RANGE;
  for (const e of world.soldiers) {
    if (e.faction === s.faction || e.status !== "active") continue;
    const d = (e.x - s.x) ** 2 + (e.y - s.y) ** 2;
    if (d >= bestD) continue;
    if (!hasLOS(world.grid, Math.floor(s.x), Math.floor(s.y), Math.floor(e.x), Math.floor(e.y), world.smokeGrid)) continue;
    best = e; bestD = d;
  }
  return best;
}

// Sprint a man in to contact with the enemy he's charging (movement only; the blow lands
// in updateMelee once he's in reach). He drops his order and formation to close the gap.
function rushToward(world: World, s: Soldier, e: Soldier): void {
  s.path = null;
  const dx = e.x - s.x, dy = e.y - s.y;
  const dist = Math.hypot(dx, dy) || 1;
  s.facing = Math.atan2(dy, dx);
  const cx = Math.floor(s.x), cy = Math.floor(s.y);
  const cost = world.grid.inBounds(cx, cy) ? TERRAIN[world.grid.get(cx, cy)].moveCost : 1;
  const rushMul = s.weapon === "carbine" ? 3.0 : 2.0; // a cavalry gallop vs an infantry run
  const sprint = (BASE_MOVE_SPEED / (isFinite(cost) ? cost : 1)) * rushMul * s.gait * SIM_DT;
  const move = Math.min(sprint, Math.max(0, dist - MELEE_STOP));
  if (move > 0) moveOnto(world, s, dx / dist, dy / dist, move);
}

// Advance a soldier by `d` cells along the unit vector (ux,uy) but only into passable
// cells: try the diagonal, then each axis alone, otherwise don't move. No teleporting.
function moveOnto(world: World, s: Soldier, ux: number, uy: number, d: number): void {
  const nx = s.x + ux * d, ny = s.y + uy * d;
  if (world.grid.passable(Math.floor(nx), Math.floor(ny))) { s.x = nx; s.y = ny; }
  else if (world.grid.passable(Math.floor(s.x + ux * d), Math.floor(s.y))) { s.x += ux * d; }
  else if (world.grid.passable(Math.floor(s.x), Math.floor(s.y + uy * d))) { s.y += uy * d; }
}

function advance(world: World, s: Soldier, speedMul: number): void {
  if (!s.path) return;
  const cx = Math.floor(s.x);
  const cy = Math.floor(s.y);
  const cost = world.grid.inBounds(cx, cy) ? TERRAIN[world.grid.get(cx, cy)].moveCost : 1;
  const speed = (BASE_MOVE_SPEED / (isFinite(cost) ? cost : 1)) * speedMul * weaponMoveFactor(s);

  let budget = speed * SIM_DT;
  while (budget > 0 && s.path) {
    const wp = s.path[s.pathIndex];
    const tx = wp.cx + 0.5;
    const ty = wp.cy + 0.5;
    const dx = tx - s.x;
    const dy = ty - s.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= budget) {
      s.x = tx;
      s.y = ty;
      budget -= dist;
      s.pathIndex++;
      if (s.pathIndex >= s.path.length) {
        s.path = null;
        s.fleeGoal = null;
      }
    } else {
      s.x += (dx / dist) * budget;
      s.y += (dy / dist) * budget;
      budget = 0;
    }
  }

  const mvx = s.x - s.px;
  const mvy = s.y - s.py;
  if (mvx * mvx + mvy * mvy > 1e-6) s.facing = Math.atan2(mvy, mvx);
}

// Smoke dynamics: each active canister emits into the grid (the cloud blooms outward
// over SMOKE_BUILD seconds, then holds while emission outpaces decay) until it burns
// out at SMOKE_LIFE; meanwhile the whole grid decays, which both caps the plateau and
// fades the screen away over ~10s once the source is gone.
function updateSmoke(world: World, dt: number): void {
  const g = world.smokeGrid;
  const grid = world.grid;
  const srcs = world.smokeSources;
  for (let k = srcs.length - 1; k >= 0; k--) {
    const src = srcs[k];
    src.t += dt;
    if (src.t > SMOKE_LIFE) { srcs.splice(k, 1); continue; }
    // Bloom: radius grows from ~30% to full over SMOKE_BUILD seconds.
    const radius = SMOKE_RADIUS * Math.min(1, 0.3 + src.t / SMOKE_BUILD);
    const r = Math.ceil(radius);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = src.cx + dx, y = src.cy + dy;
        if (!grid.inBounds(x, y)) continue;
        const dist = Math.hypot(dx, dy);
        if (dist > radius) continue;
        const i = grid.idx(x, y);
        const add = SMOKE_EMIT * dt * (1 - dist / (radius + 0.001)); // densest at center
        if (add > 0) g[i] = Math.min(SMOKE_CAP, g[i] + add);
      }
    }
  }
  const d = SMOKE_DECAY * dt;
  for (let i = 0; i < g.length; i++) if (g[i] > 0) g[i] = Math.max(0, g[i] - d);
}

function ageEffects(world: World, dt: number): void {
  const e = world.effects;
  let w = 0;
  for (let r = 0; r < e.length; r++) {
    e[r].ttl -= dt;
    if (e[r].ttl > 0) e[w++] = e[r];
  }
  e.length = w;
}

function checkOutcome(world: World): "win" | "lose" | null {
  let us = 0;
  let axis = 0;
  for (const s of world.soldiers) {
    if (s.status !== "active") continue;
    if (s.faction === "us") us++;
    else axis++;
  }
  for (const v of world.vehicles) {
    if (v.status === "ko") continue;
    if (v.faction === "us") us++;
    else axis++;
  }
  // Eliminating the human's enemy is a win; being wiped out is a loss.
  const playerCount = world.player === "us" ? us : axis;
  const enemyCount = world.player === "us" ? axis : us;
  if (enemyCount === 0) return "win";
  if (playerCount === 0) return "lose";
  return null;
}
