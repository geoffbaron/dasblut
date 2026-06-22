import { SPOT_BASE, SPOT_HYSTERESIS, VISION_CELLS } from "./constants.ts";
import { hasLOS } from "./los.ts";
import { TERRAIN } from "./terrain.ts";
import { Soldier, Vehicle, World } from "./world.ts";

interface Spotter {
  x: number;
  y: number;
}

// Recomputes, for the visibility tick:
//  1. The US shroud grid (cells currently in any friendly unit's line of sight).
//  2. Each soldier's and vehicle's `seen` flag — whether the opposing faction spots it.
// Both infantry and tank crews act as spotters. Spotting falls off with the target's
// concealment and rises if it is moving or firing; tanks are big and loud and easy to
// pick out. A short hysteresis keeps contacts from flickering.
export function updateVisibility(world: World, dt: number): void {
  const atk = world.attacker;
  const atkPts: Spotter[] = [];
  const defPts: Spotter[] = [];
  for (const s of world.soldiers) {
    if (s.status === "dead") continue;
    (s.faction === atk ? atkPts : defPts).push({ x: s.x, y: s.y });
  }
  for (const v of world.vehicles) {
    if (v.status === "ko") continue;
    (v.faction === atk ? atkPts : defPts).push({ x: v.x, y: v.y });
  }

  // 1. Attacker's shroud (the human player's line of sight).
  world.visGrid.fill(0);
  for (const p of atkPts) markVision(world, p.x, p.y);
  world.visVersion++;

  // 2. Spotting both ways.
  for (const s of world.soldiers) spotSoldier(world, s, s.faction === atk ? defPts : atkPts, dt);
  for (const v of world.vehicles) spotVehicle(world, v, v.faction === atk ? defPts : atkPts, dt);
}

function markVision(world: World, x: number, y: number): void {
  const { grid } = world;
  const ox = Math.floor(x);
  const oy = Math.floor(y);
  const r = VISION_CELLS;
  const r2 = r * r;
  for (let cy = oy - r; cy <= oy + r; cy++) {
    for (let cx = ox - r; cx <= ox + r; cx++) {
      if (!grid.inBounds(cx, cy)) continue;
      const dx = cx - ox;
      const dy = cy - oy;
      if (dx * dx + dy * dy > r2) continue;
      const i = grid.idx(cx, cy);
      if (world.visGrid[i]) continue;
      if (hasLOS(grid, ox, oy, cx, cy)) world.visGrid[i] = 1;
    }
  }
}

function spotSoldier(world: World, t: Soldier, spotters: Spotter[], dt: number): void {
  const { grid } = world;
  const tcx = Math.floor(t.x);
  const tcy = Math.floor(t.y);
  const conceal = grid.inBounds(tcx, tcy) ? TERRAIN[grid.get(tcx, tcy)].concealment : 0;
  const moving = t.path != null && t.status === "active";
  const firing = t.firedTimer > 0;
  let range = SPOT_BASE * (1 - conceal * 0.6);
  if (moving) range *= 1.3;
  if (firing) range *= 1.4;
  if (t.stance === "sneak") range *= 0.45;
  else if (t.stance === "fast") range *= 1.3;
  else if (t.stance === "ambush" || t.stance === "defend") range *= 0.85;
  applySeen(world, t, spotters, tcx, tcy, range, dt);
}

function spotVehicle(world: World, v: Vehicle, spotters: Spotter[], dt: number): void {
  // Tanks are conspicuous; movement and the gun going off give them away further.
  let range = SPOT_BASE * 1.4;
  if (v.path) range *= 1.2;
  applySeen(world, v, spotters, Math.floor(v.x), Math.floor(v.y), range, dt);
}

function applySeen(
  world: World,
  t: { x: number; y: number; seen: boolean; seenTimer: number },
  spotters: Spotter[],
  tcx: number,
  tcy: number,
  range: number,
  dt: number,
): void {
  const range2 = range * range;
  let visible = false;
  for (const s of spotters) {
    const dx = s.x - t.x;
    const dy = s.y - t.y;
    if (dx * dx + dy * dy > range2) continue;
    // Smoke blocks spotting (but not the friendly shroud above) — that's what makes
    // a mortar screen hide a moving squad from the enemy.
    if (hasLOS(world.grid, Math.floor(s.x), Math.floor(s.y), tcx, tcy, world.smokeGrid)) {
      visible = true;
      break;
    }
  }
  if (visible) t.seenTimer = SPOT_HYSTERESIS;
  else t.seenTimer = Math.max(0, t.seenTimer - dt);
  t.seen = t.seenTimer > 0;
}
