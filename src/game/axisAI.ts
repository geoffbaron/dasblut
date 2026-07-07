import { AI_INTERVAL } from "./constants.ts";
import { hasLOS } from "./los.ts";
import { Cell } from "./pathfinding.ts";
import { isPassable, TERRAIN, vehiclePassable } from "./terrain.ts";
import { WEAPONS } from "./weapons.ts";
import { Faction, Soldier, Team, Vehicle, World } from "./world.ts";

// The computer commander, run on a throttle. It fights with combined arms instead of
// shoving every squad at the flag: machine guns set up as a base of fire that rakes the
// objective, mortars drop HE on spotted clusters, and rifle squads bound forward on
// multiple axes — pulling back to cover to recover when a team is shot to pieces. This
// covers all three roles (defend / attack / meeting); per-soldier firing is still the
// combat AI's job. Targeting only ever uses what the AI has actually spotted (`seen`),
// so it never cheats the fog of war.
export function commandAI(world: World, dt: number): void {
  world.aiAccum += dt;
  if (world.aiAccum < AI_INTERVAL) return;
  world.aiAccum = 0;

  const ai = world.aiFaction;
  const foe = other(ai);
  const objs = world.objectives;
  const needs = (o: { owner: string; capturing: string | null; contested: boolean }) =>
    o.owner !== ai || o.capturing === foe || o.contested;
  const anyNeed = objs.some(needs);
  const changed = anyNeed !== world.aiThreatPrev;
  world.aiThreatPrev = anyNeed;

  const aiTeams = world.teams.filter((t) => t.faction === ai);
  aiTeams.forEach((team, idx) => {
    const men = team.soldierIds.map((id) => world.soldier(id)!).filter((s) => s.status === "active");
    if (men.length === 0) return;
    if (men.every((s) => s.state === "panicked" || s.state === "routing")) return; // broken — let them run

    const o = objs[idx % objs.length];
    if (team.kind === "mg") commandSupport(world, team, men, o, foe, WEAPONS.lmg.rangeCells);
    else if (team.kind === "artillery") commandSupport(world, team, men, o, foe, WEAPONS.cannon.rangeCells * 0.7);
    else if (team.kind === "mortar") commandMortar(world, team, men, objs, foe);
    else if (team.kind === "cavalry") commandCavalry(world, team, men, o, idx, aiTeams.length, foe, needs, changed);
    else if (team.kind === "at") commandAT(world, team, men, o, idx, aiTeams.length, foe, needs, changed);
    else commandAssault(world, team, men, o, idx, aiTeams.length, foe, needs, changed, false);
  });

  // Armor pushes onto the nearest objective that needs taking, else holds near one.
  const vt = objs.find(needs) ?? objs[0];
  for (const v of world.vehicles) {
    if (v.faction !== ai || v.status === "ko" || !vt) continue;
    const d = Math.hypot(v.x - vt.cx, v.y - vt.cy);
    if (needs(vt) && d > 6) {
      if (changed || !v.path) world.orderVehicleMove(v.id, { cx: vt.cx, cy: vt.cy }, false);
    } else if (!needs(vt) && d > 10 && !v.path) {
      world.orderVehicleMove(v.id, nearestVehCell(world, vt.cx, vt.cy), false);
    }
  }
}

// Machine gun = base of fire. Set up in cover with a clear line to the objective and rake
// it: suppress a spotted enemy near the flag, otherwise hold and watch the arc. The MG
// never rushes onto the objective itself — it anchors the squad's advance from behind.
function commandSupport(world: World, team: Team, men: Soldier[], o: Objective, foe: Faction, range: number): void {
  const a = men[0];
  const d = Math.hypot(a.x - o.cx, a.y - o.cy);
  const los = hasLOS(world.grid, Math.floor(a.x), Math.floor(a.y), o.cx, o.cy);
  if (los && d >= 4 && d <= range * 0.9) {
    // Good firing position. Suppress a spotted enemy by the objective, else just hold.
    const tgt = spottedEnemyNear(world, o.cx, o.cy, o.radius + 5, foe);
    if (tgt) {
      if (!sameCell(firstFireCell(men), tgt)) world.orderAreaFire(team.id, tgt);
    } else if (teamFiring(men) || !defending(men)) {
      world.orderPosture(team.id, "defend"); // no target → stop hosing empty ground, watch
    }
    return;
  }
  if (!moving(men)) {
    // Only re-path when actually meaningfully out of position. Without this, a team
    // that's arrived close to the ideal post but doesn't quite satisfy the LOS/range
    // check above (fractional position, a building revealed since, whatever) got a
    // fresh "corrective" order every AI tick forever — for an MG that's just wasted
    // pathing, but for a cannon/catapult (which also route through here) each of those
    // orders re-zeros its setupTime (combat.ts), so it could end up perpetually
    // re-arming its stillness gate and never actually finish laying the gun.
    const goal = supportPost(world, o, range);
    if (Math.hypot(a.x - goal.cx, a.y - goal.cy) > 1.5) world.orderMove(team.id, goal, "move");
  }
}

// Mortar = indirect support. Drop HE on the densest spotted enemy cluster in range that's
// clear of our own men; if there's nothing worth a bomb, hold the tube.
function commandMortar(world: World, team: Team, men: Soldier[], objs: Objective[], foe: Faction): void {
  void objs;
  const tube = men.find((s) => WEAPONS[s.weapon].indirect) ?? men[0];
  const target = bestMortarTarget(world, tube, foe);
  if (target) {
    if (!sameCell(firstFireCell(men), target)) world.orderAreaFire(team.id, target);
  } else if (teamFiring(men) || !defending(men)) {
    world.orderPosture(team.id, "defend");
  }
}

// Rifle/AT squads take ground. A mauled team breaks contact and pulls back to cover to
// recover; otherwise it bounds toward the objective on its own axis (AT trails, watching
// for armor) and digs in once it's there.
function commandAssault(
  world: World, team: Team, men: Soldier[], o: Objective, idx: number, n: number,
  foe: Faction, needs: (o: Objective) => boolean, changed: boolean, holdBack: boolean,
): void {
  void foe;
  if (isMauled(men)) {
    if (!moving(men)) world.orderMove(team.id, fallbackPost(world, men), "move"); // recover in cover
    return;
  }
  if (!needs(o)) {
    if (!defending(men)) world.orderPosture(team.id, "defend"); // hold what we've taken
    return;
  }
  const goal = holdBack ? supportPost(world, o, 12) : approachCell(world, o, idx, n);
  const a = men[0];
  const d = Math.hypot(a.x - goal.cx, a.y - goal.cy);
  const lost = o.owner === foe;
  if (d > 3) {
    if (changed || !moving(men) || !headedTo(men, goal)) world.orderMove(team.id, goal, lost ? "fast" : "move");
  } else if (!defending(men)) {
    world.orderPosture(team.id, "defend");
  }
}

// Anti-tank teams actively hunt a flank/rear shot on the nearest spotted enemy tank,
// instead of parking in a generic support position near the objective and slugging it
// out head-on. A tank's frontal plate is the one angle a bazooka/Panzerfaust struggles
// against (see resolveArmorHit) — the AI used to fight there anyway, simply because it
// held a static post while the tank beelined the objective and arrived nose-first. Now,
// once a tank is spotted, the team maneuvers to its flank/rear arc at engagement range
// and locks onto it with orderFireVehicle; with no tank in sight it falls back to the
// ordinary objective-support behaviour.
function commandAT(
  world: World, team: Team, men: Soldier[], o: Objective, idx: number, n: number,
  foe: Faction, needs: (o: Objective) => boolean, changed: boolean,
): void {
  if (isMauled(men)) {
    if (!moving(men)) world.orderMove(team.id, fallbackPost(world, men), "move");
    return;
  }
  const a = men[0];
  let tank: Vehicle | null = null;
  let bestD = Infinity;
  for (const v of world.vehicles) {
    if (v.faction !== foe || v.status === "ko" || !v.seen) continue;
    const d = Math.hypot(v.x - a.x, v.y - a.y);
    if (d < bestD) { bestD = d; tank = v; }
  }
  if (tank) {
    const ENGAGE_RANGE = 13; // comfortably inside both bazooka (18) and Panzerfaust (11) reach
    // Fire the instant the CURRENT position already qualifies (in range, off the front
    // arc, clear LOS) — don't wait to reach some freshly recomputed "ideal" cell. Judging
    // readiness by distance-to-a-recomputed-flank-cell instead of by the tank itself let
    // the team dither forever: flankPosition can return a slightly different cell every AI
    // tick (rounding, a tank inching its facing), so "am I within 3 of the goal" never
    // reliably went true even after the team had, in practice, arrived.
    const dTank = Math.hypot(a.x - tank.x, a.y - tank.y);
    const bearing = Math.atan2(a.y - tank.y, a.x - tank.x);
    let rel = bearing - tank.facing;
    while (rel > Math.PI) rel -= 2 * Math.PI;
    while (rel < -Math.PI) rel += 2 * Math.PI;
    const offFront = Math.abs(rel) >= Math.PI / 4; // side or rear arc — where armor is thin
    const clearLOS = hasLOS(world.grid, Math.floor(a.x), Math.floor(a.y), Math.floor(tank.x), Math.floor(tank.y));
    if (dTank <= ENGAGE_RANGE && offFront && clearLOS) {
      world.orderFireVehicle(team.id, tank.id);
      return;
    }
    // Sneak, not a "fast" sprint or even a plain walk — a bazooka team's whole advantage
    // is not being spotted before it's ready to shoot. A tank's MG reaches out to 22
    // cells, well past the ~13-cell engagement range the flank position is chosen
    // within, so the WHOLE approach happens inside its potential engagement envelope.
    // Sneaking cuts the enemy's spotting range on them by more than half (see
    // visibility.ts) — slower, but a team that arrives alive and unnoticed is worth far
    // more than one that gets machine-gunned crossing open ground at a jog.
    // orderFireVehicle (above) already un-sneaks them the instant they're ready to fire.
    const goal = flankPosition(world, tank, ENGAGE_RANGE);
    if (changed || !moving(men) || !headedTo(men, goal)) world.orderMove(team.id, goal, "sneak");
    return;
  }
  commandAssault(world, team, men, o, idx, n, foe, needs, changed, true);
}

// A passable, LOS-clear cell within the tank's flank or rear arc (±90°/180° off its hull
// facing — deliberately skipping the front ±45° cone, the one angle armor actually holds
// up), preferring cover and a distance near the target engagement range.
function flankPosition(world: World, tank: Vehicle, range: number): Cell {
  let best: Cell | null = null;
  let bestScore = -Infinity;
  for (const off of [Math.PI / 2, -Math.PI / 2, Math.PI * 0.75, -Math.PI * 0.75, Math.PI]) {
    const ang = tank.facing + off;
    for (let rr = range * 0.5; rr <= range; rr += 2) {
      const x = Math.round(tank.x + Math.cos(ang) * rr);
      const y = Math.round(tank.y + Math.sin(ang) * rr);
      if (!world.grid.inBounds(x, y)) continue;
      const t = world.grid.get(x, y);
      if (!isPassable(t)) continue;
      if (!hasLOS(world.grid, x, y, Math.floor(tank.x), Math.floor(tank.y))) continue;
      const score = TERRAIN[t].cover * 2 + TERRAIN[t].concealment - Math.abs(rr - range * 0.75) * 0.05;
      if (score > bestScore) { bestScore = score; best = { cx: x, cy: y }; }
    }
  }
  return best ?? world.nearestPassable(Math.round(tank.x), Math.round(tank.y), { cx: Math.floor(tank.x), cy: Math.floor(tank.y) });
}

// Cavalry skirmish with carbines like assault troops, but seize the chance to charge: if
// an enemy is right on top of them, or a wavering one is within a short gallop, they ride
// it down (the melee is resolved in updateCavalry). A mauled troop pulls back instead.
function commandCavalry(
  world: World, team: Team, men: Soldier[], o: Objective, idx: number, n: number,
  foe: Faction, needs: (o: Objective) => boolean, changed: boolean,
): void {
  if (!isMauled(men)) {
    const a = men[0];
    let tgt: Soldier | null = null;
    let bestD = Infinity;
    for (const e of world.soldiers) {
      if (e.faction !== foe || e.status !== "active" || !e.seen) continue;
      const d = (e.x - a.x) ** 2 + (e.y - a.y) ** 2;
      if (d < bestD) { bestD = d; tgt = e; }
    }
    if (tgt) {
      const d = Math.sqrt(bestD);
      const wavering = tgt.state !== "steady";
      if (d <= 6 || (wavering && d <= 12)) {
        const goal = { cx: Math.floor(tgt.x), cy: Math.floor(tgt.y) };
        // Dedup like every other command function here: re-aim the charge only when the
        // target has actually drifted from where the troop is already riding, instead of
        // re-issuing the order (and re-arming the marching-fire gate) every AI tick — a
        // troop still genuinely charging shouldn't be firing carbines anyway, but it
        // also shouldn't be handed a brand-new order group each 1.5s for no reason.
        if (!moving(men) || !headedTo(men, goal)) world.orderMove(team.id, goal, "charge");
        return;
      }
    }
  }
  commandAssault(world, team, men, o, idx, n, foe, needs, changed, false);
}

// --- helpers ---

interface Objective { cx: number; cy: number; radius: number; owner: string; capturing: string | null; contested: boolean; }

function other(f: Faction): Faction { return f === "us" ? "axis" : "us"; }
function defending(men: Soldier[]): boolean { return men.every((s) => s.stance === "defend" && !s.path); }
function moving(men: Soldier[]): boolean { return men.some((s) => s.path != null); }
function teamFiring(men: Soldier[]): boolean { return men.some((s) => s.fireCell != null); }
function firstFireCell(men: Soldier[]): Cell | null { for (const s of men) if (s.fireCell) return s.fireCell; return null; }
function sameCell(a: Cell | null, b: Cell | null): boolean { return !!a && !!b && a.cx === b.cx && a.cy === b.cy; }

// Half the team pinned or broken → it's been mauled and should fall back to recover.
// Also breaks on a flat casualty count (MAULED_ABS), not just the fraction: a 5-man WW2
// squad and an 18-man Civil War line have the same per-man morale model, but scaling
// purely by fraction meant the AI fed a massed line into canister/volley fire until 9+
// men were down before reacting — far more absolute punishment than a small squad ever
// takes before the same AI pulls it back. The absolute floor makes large formations
// react at a casualty count in the same ballpark as a small one, not a fixed fraction.
const MAULED_ABS = 4;
function isMauled(men: Soldier[]): boolean {
  let down = 0;
  for (const s of men) if (s.state === "pinned" || s.state === "panicked" || s.state === "routing") down++;
  return down * 2 >= men.length || down >= MAULED_ABS;
}

function headedTo(men: Soldier[], goal: Cell): boolean {
  const p = men[0].path;
  if (!p || p.length === 0) return false;
  const end = p[p.length - 1];
  return Math.hypot(end.cx - goal.cx, end.cy - goal.cy) < 6;
}

// The nearest spotted enemy within `radius` of a point, as a cell to suppress.
function spottedEnemyNear(world: World, cx: number, cy: number, radius: number, foe: Faction): Cell | null {
  let best: Cell | null = null;
  let bestD = radius * radius;
  for (const e of world.soldiers) {
    if (e.faction !== foe || e.status !== "active" || !e.seen) continue;
    const d = (e.x - cx) ** 2 + (e.y - cy) ** 2;
    if (d < bestD) { bestD = d; best = { cx: Math.floor(e.x), cy: Math.floor(e.y) }; }
  }
  return best;
}

// The densest knot of spotted enemies the tube can reach without dropping near our men.
function bestMortarTarget(world: World, tube: Soldier, foe: Faction): Cell | null {
  const w = WEAPONS[tube.weapon];
  const min = (w.minRangeCells ?? 8) + 1;
  const max = w.rangeCells;
  let best: Cell | null = null;
  let bestN = 2; // worth a bomb only on a real cluster (3+)
  for (const e of world.soldiers) {
    if (e.faction !== foe || e.status !== "active" || !e.seen) continue;
    const d = Math.hypot(e.x - tube.x, e.y - tube.y);
    if (d < min || d > max) continue;
    let n = 0;
    let friendlyNear = false;
    for (const o of world.soldiers) {
      if (o.status !== "active") continue;
      const dd = Math.hypot(o.x - e.x, o.y - e.y);
      if (o.faction === foe) { if (o.seen && dd <= 3) n++; }
      else if (dd <= 5) { friendlyNear = true; break; }
    }
    if (friendlyNear) continue;
    if (n > bestN) { bestN = n; best = { cx: Math.floor(e.x), cy: Math.floor(e.y) }; }
  }
  return best;
}

// A cover cell set back from the objective with a clear line to it — where an MG (or AT
// team) overwatches the advance. Biased to the AI's own side of the flag.
function supportPost(world: World, o: Objective, range: number): Cell {
  const ideal = Math.min(range * 0.7, 14);
  const homeDir = world.aiFaction === world.southFaction ? 1 : -1; // south side = larger y
  let best: Cell | null = null;
  let bestScore = -Infinity;
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 12) {
    for (let rr = ideal - 4; rr <= ideal + 4; rr += 2) {
      const x = Math.round(o.cx + Math.cos(a) * rr);
      const y = Math.round(o.cy + Math.sin(a) * rr);
      if (!world.grid.inBounds(x, y)) continue;
      const t = world.grid.get(x, y);
      if (!isPassable(t)) continue;
      if (!hasLOS(world.grid, x, y, o.cx, o.cy)) continue;
      const onHomeSide = (y - o.cy) * homeDir > 0 ? 1 : 0;
      const score = TERRAIN[t].cover * 2 + TERRAIN[t].concealment + onHomeSide - Math.abs(rr - ideal) * 0.1;
      if (score > bestScore) { bestScore = score; best = { cx: x, cy: y }; }
    }
  }
  return best ?? { cx: o.cx, cy: o.cy };
}

// An entry point on the objective, fanned out by team index so squads converge from
// different bearings instead of funnelling up one lane.
function approachCell(world: World, o: Objective, idx: number, n: number): Cell {
  const ang = (idx / Math.max(1, n)) * Math.PI * 2;
  const r = Math.max(0, o.radius - 2);
  const tx = Math.round(o.cx + Math.cos(ang) * r);
  const ty = Math.round(o.cy + Math.sin(ang) * r);
  return world.nearestPassable(tx, ty, { cx: o.cx, cy: o.cy });
}

// Cover a few cells back toward the AI's home edge — where a mauled team retires to.
function fallbackPost(world: World, men: Soldier[]): Cell {
  let cx = 0, cy = 0;
  for (const s of men) { cx += s.x; cy += s.y; }
  cx /= men.length; cy /= men.length;
  const homeDir = world.aiFaction === world.southFaction ? 1 : -1;
  const ty = cy + homeDir * 7;
  let best: Cell | null = null;
  let bestScore = -Infinity;
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = Math.round(cx + dx), y = Math.round(ty + dy);
      if (!world.grid.inBounds(x, y)) continue;
      const t = world.grid.get(x, y);
      if (!isPassable(t)) continue;
      const score = TERRAIN[t].cover * 2 + TERRAIN[t].concealment - Math.hypot(dx, dy) * 0.05;
      if (score > bestScore) { bestScore = score; best = { cx: x, cy: y }; }
    }
  }
  return best ?? world.nearestPassable(Math.round(cx), Math.round(ty), { cx: Math.round(cx), cy: Math.round(cy) });
}

function nearestVehCell(world: World, cx: number, cy: number): Cell {
  for (let s = 0; s < 30; s++)
    for (let dy = -s; dy <= s; dy++)
      for (let dx = -s; dx <= s; dx++)
        if (world.grid.inBounds(cx + dx, cy + dy) && vehiclePassable(world.grid.get(cx + dx, cy + dy)))
          return { cx: cx + dx, cy: cy + dy };
  return { cx, cy };
}
