import { acquireTargets, ensureFleeGoal } from "./ai.ts";
import { commandAxis } from "./axisAI.ts";
import { resolveFire } from "./combat.ts";
import {
  BASE_MOVE_SPEED,
  BATTLE_TIME_S,
  OBJECTIVE_CAPTURE_TIME,
  OBJECTIVE_HOLD_TO_WIN,
  SIM_DT,
  SMOKE_DECAY,
  STANCE_SPEED,
  VIS_INTERVAL,
} from "./constants.ts";
import { Faction } from "./world.ts";
import { updateMorale } from "./morale.ts";
import { TERRAIN } from "./terrain.ts";
import { updateVehicles } from "./vehicleSim.ts";
import { updateVisibility } from "./visibility.ts";
import { Soldier, World } from "./world.ts";

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
  decaySmoke(world, SIM_DT);

  world.visAccum += SIM_DT;
  if (world.visAccum >= VIS_INTERVAL) {
    updateVisibility(world, world.visAccum);
    world.visAccum = 0;
  }

  commandAxis(world, SIM_DT);
  acquireTargets(world);
  resolveFire(world, SIM_DT);
  updateVehicles(world);
  updateMorale(world, SIM_DT);
  moveSoldiers(world);
  updateObjective(world, SIM_DT);

  if (!world.outcome) world.outcome = checkOutcome(world);
  if (!world.outcome && world.time >= BATTLE_TIME_S) world.outcome = world.objOwner === "us" ? "win" : "lose";
}

// Capture-and-hold. A side "captures" the objective by being the only one with units
// in the zone for OBJECTIVE_CAPTURE_TIME; the attacker (US) wins by holding it for
// OBJECTIVE_HOLD_TO_WIN seconds. Elimination still ends it (see checkOutcome).
function updateObjective(world: World, dt: number): void {
  const o = world.objective;
  const r2 = o.radius * o.radius;
  let us = 0;
  let axis = 0;
  for (const s of world.soldiers) {
    if (s.status !== "active") continue;
    if ((s.x - o.cx - 0.5) ** 2 + (s.y - o.cy - 0.5) ** 2 <= r2) (s.faction === "us" ? us++ : axis++);
  }
  for (const v of world.vehicles) {
    if (v.status === "ko") continue;
    if ((v.x - o.cx - 0.5) ** 2 + (v.y - o.cy - 0.5) ** 2 <= r2) (v.faction === "us" ? (us += 2) : (axis += 2));
  }

  world.objContested = us > 0 && axis > 0;
  const sole: Faction | null = us > 0 && axis === 0 ? "us" : axis > 0 && us === 0 ? "axis" : null;
  world.objCapturing = sole && sole !== world.objOwner ? sole : null;

  if (world.objCapturing) {
    world.objProgress += dt / OBJECTIVE_CAPTURE_TIME;
    if (world.objProgress >= 1) {
      world.objOwner = world.objCapturing;
      world.objProgress = 0;
      world.objCapturing = null;
    }
  } else if (!world.objContested) {
    world.objProgress = Math.max(0, world.objProgress - dt / OBJECTIVE_CAPTURE_TIME);
  }

  // The attacker holds to win; a recapture by the defender resets the clock.
  if (world.objOwner === "us") {
    world.objHoldTimer += dt;
    if (world.objHoldTimer >= OBJECTIVE_HOLD_TO_WIN && !world.outcome) world.outcome = "win";
  } else {
    world.objHoldTimer = 0;
  }
}

function moveSoldiers(world: World): void {
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
        advance(world, s, 1.25);
        continue;
      default: {
        // Pace set by the commanded stance, slowed if the man is shaken.
        const mul = STANCE_SPEED[s.stance] * (s.state === "shaken" ? 0.7 : 1);
        advance(world, s, mul);
      }
    }
  }
}

function advance(world: World, s: Soldier, speedMul: number): void {
  if (!s.path) return;
  const cx = Math.floor(s.x);
  const cy = Math.floor(s.y);
  const cost = world.grid.inBounds(cx, cy) ? TERRAIN[world.grid.get(cx, cy)].moveCost : 1;
  const speed = (BASE_MOVE_SPEED / (isFinite(cost) ? cost : 1)) * speedMul;

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

// Smoke thins out over time; once a cell drops below the LOS-blocking threshold it
// stops concealing, and at ~0 it's gone entirely.
function decaySmoke(world: World, dt: number): void {
  const g = world.smokeGrid;
  const d = SMOKE_DECAY * dt;
  for (let i = 0; i < g.length; i++) {
    if (g[i] > 0) g[i] = Math.max(0, g[i] - d);
  }
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
  if (axis === 0) return "win";
  if (us === 0) return "lose";
  return null;
}
