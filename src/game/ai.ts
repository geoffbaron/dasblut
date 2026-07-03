import { findPath } from "./pathfinding.ts";
import { hasLOS } from "./los.ts";
import { AMBUSH_BONUS_TIME, AMBUSH_RANGE } from "./constants.ts";
import { WEAPONS } from "./weapons.ts";
import { Cell } from "./pathfinding.ts";
import { Soldier, unitPassable, Vehicle, World } from "./world.ts";

// Target acquisition, governed by the soldier's stance:
//  • sneak — never fires (stays hidden);
//  • fast  — cannot fire while running;
//  • ambush — holds fire until an enemy closes inside AMBUSH_RANGE, then a bonus volley;
//  • a player-designated manual target overrides auto-selection;
//  • area fire (fireCell) is resolved in combat, not here.
// Shared spotting (one man's contact, the whole squad can shoot at) mirrors CC.
export function acquireTargets(world: World): void {
  for (const s of world.soldiers) {
    const had = s.targetId;
    if (s.status !== "active" || s.state === "panicked" || s.state === "routing") {
      s.targetId = null;
      s.targetVehId = null;
      continue;
    }
    // Stances / orders that suppress unit acquisition this step.
    if (s.stance === "sneak" || s.fireCell || (s.stance === "fast" && s.path)) {
      s.targetId = null;
      s.targetVehId = null;
      continue;
    }

    // An archer needs firm footing to draw and loose a shot — he can't nock an arrow at
    // a dead run. Hold fire while on the march (individually pathing, or advancing in the
    // squad's line-abreast formation) and resume the instant he stops or a manual Fire
    // order halts him (orderFireUnit/orderAreaFire already clear the march themselves).
    if (s.weapon === "bow" && (s.path != null || world.team(s.teamId)?.march)) {
      s.targetId = null;
      s.targetVehId = null;
      continue;
    }

    const w = WEAPONS[s.weapon];
    const scx = Math.floor(s.x);
    const scy = Math.floor(s.y);

    // AT specialists hunt armor: engage the nearest spotted enemy tank in range/LOS.
    // A player-designated tank takes priority and is held even slightly out of range —
    // the combat step won't loose a rocket until it's actually in range with LOS, so the
    // crew tracks it and fires the moment it closes. When none is designated and none is
    // near, they hold their few rounds rather than waste them on infantry.
    if (w.penetration != null) {
      s.targetId = null;
      if (s.manualVehId != null) {
        const tv = world.vehicle(s.manualVehId);
        if (tv && tv.status !== "ko") {
          s.targetVehId = tv.id;
          if (!s.path) s.facing = Math.atan2(tv.y - s.y, tv.x - s.x);
          continue;
        }
        s.manualVehId = null; // it's dead/gone — release the lock and auto-hunt
      }
      s.targetVehId = acquireVehicle(world, s, w.rangeCells);
      continue;
    }

    // Manual focus-fire target, if still valid.
    if (s.manualTargetId != null) {
      const t = world.soldier(s.manualTargetId);
      if (t && t.status === "active" && t.seen) {
        const d = Math.hypot(t.x - s.x, t.y - s.y);
        if (d <= w.rangeCells && hasLOS(world.grid, scx, scy, Math.floor(t.x), Math.floor(t.y), world.smokeGrid)) {
          s.targetId = t.id;
          // An MG keeps its own facing (it traverses on its mount in combat); everyone
          // else snaps to face the target they're firing on.
          if (!s.path && s.weapon !== "lmg") s.facing = Math.atan2(t.y - s.y, t.x - s.x);
          continue;
        }
      } else {
        s.manualTargetId = null;
      }
    }

    const maxRange = s.stance === "ambush" ? Math.min(w.rangeCells, AMBUSH_RANGE) : w.rangeCells;
    const range2 = maxRange * maxRange;
    let best: Soldier | null = null;
    let bestD = Infinity;
    for (const t of world.soldiers) {
      if (t.faction === s.faction || t.status !== "active" || !t.seen) continue;
      const dx = t.x - s.x;
      const dy = t.y - s.y;
      const d = dx * dx + dy * dy;
      if (d > range2 || d >= bestD) continue;
      if (!hasLOS(world.grid, scx, scy, Math.floor(t.x), Math.floor(t.y), world.smokeGrid)) continue;
      best = t;
      bestD = d;
    }
    s.targetId = best ? best.id : null;
    if (best) {
      // Ambushers get an opening-volley bonus the instant they open up.
      if (s.stance === "ambush" && had == null) s.ambushTimer = AMBUSH_BONUS_TIME;
      // An MG traverses on its mount (handled in combat); everyone else snaps to face.
      if (!s.path && s.weapon !== "lmg") s.facing = Math.atan2(best.y - s.y, best.x - s.x);
    }
  }
}

function acquireVehicle(world: World, s: Soldier, range: number): number | null {
  let best: Vehicle | null = null;
  let bestD = range * range;
  const scx = Math.floor(s.x);
  const scy = Math.floor(s.y);
  for (const v of world.vehicles) {
    if (v.faction === s.faction || v.status === "ko") continue;
    const d = (v.x - s.x) ** 2 + (v.y - s.y) ** 2;
    if (d > bestD) continue;
    // An AT man engages any enemy tank he can personally see in range — he trusts his
    // own eyes (LOS), not just the squad's shared spotting flag, so he never holds a
    // clean shot at armour bearing down on him.
    if (!hasLOS(world.grid, scx, scy, Math.floor(v.x), Math.floor(v.y), world.smokeGrid)) continue;
    best = v;
    bestD = d;
  }
  return best ? best.id : null;
}

// Routing men flee toward their own side's edge, away from the nearest known enemy.
// Called from movement when a soldier's state is "routing".
export function ensureFleeGoal(world: World, s: Soldier): void {
  if (s.fleeGoal && Math.hypot(s.fleeGoal.cx + 0.5 - s.x, s.fleeGoal.cy + 0.5 - s.y) > 1.2 && s.path) return;

  // Direction away from the nearest enemy we can see; fall back to the home edge.
  let ex = 0;
  let ey = 0;
  let found = false;
  let nearest = Infinity;
  for (const t of world.soldiers) {
    if (t.faction === s.faction || t.status !== "active" || !t.seen) continue;
    const d = (t.x - s.x) ** 2 + (t.y - s.y) ** 2;
    if (d < nearest) {
      nearest = d;
      ex = s.x - t.x;
      ey = s.y - t.y;
      found = true;
    }
  }
  if (!found) {
    ex = 0;
    ey = s.faction === "us" ? 1 : -1; // US flees south, Axis north
  }
  const len = Math.hypot(ex, ey) || 1;
  const gx = Math.round(s.x + (ex / len) * 8);
  const gy = Math.round(s.y + (ey / len) * 8);
  const pass = unitPassable(world.grid, s.weapon);
  const goal: Cell = world.nearestPassable(gx, gy, { cx: Math.floor(s.x), cy: Math.floor(s.y) }, pass);
  const path = findPath(world.grid, { cx: Math.floor(s.x), cy: Math.floor(s.y) }, goal, { passable: pass });
  if (path && path.length > 1) {
    s.path = path;
    s.pathIndex = 1;
    s.fleeGoal = goal;
  }
}
