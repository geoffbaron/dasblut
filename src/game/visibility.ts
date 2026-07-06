import { ACW_SPOT_BASE, ACW_VISION_CELLS, SPOT_BASE, SPOT_HYSTERESIS, VISION_CELLS } from "./constants.ts";
import { hasLOS } from "./los.ts";
import { isBuildingInterior, TERRAIN } from "./terrain.ts";
import { WEAPONS } from "./weapons.ts";
import { modernEra, Soldier, Vehicle, World } from "./world.ts";

interface Spotter {
  x: number;
  y: number;
  // A buttoned-up tank crew has poor close-in vision, especially peering into a
  // building — this is what lets an AT team hole up in a house rather than being
  // spotted through the wall the instant a tank rolls into view.
  vehicle?: boolean;
  // An anti-tank man watches for armor and knows what he's looking for — he spots a
  // tank at a real distance instead of squinting at a generic distant shape.
  atCapable?: boolean;
}

// Recomputes, for the visibility tick:
//  1. The US shroud grid (cells currently in any friendly unit's line of sight).
//  2. Each soldier's and vehicle's `seen` flag — whether the opposing faction spots it.
// Both infantry and tank crews act as spotters. Spotting falls off with the target's
// concealment and rises if it is moving or firing; tanks are big and loud and easy to
// pick out. A short hysteresis keeps contacts from flickering.
export function updateVisibility(world: World, dt: number): void {
  const me = world.player;
  const myPts: Spotter[] = [];
  const foePts: Spotter[] = [];
  for (const s of world.soldiers) {
    if (s.status === "dead" || s.status === "surrendered") continue; // a man with his hands up isn't scouting
    const atCapable = WEAPONS[s.weapon].penetration != null;
    (s.faction === me ? myPts : foePts).push({ x: s.x, y: s.y, atCapable });
  }
  for (const v of world.vehicles) {
    if (v.status === "ko") continue;
    (v.faction === me ? myPts : foePts).push({ x: v.x, y: v.y, vehicle: true });
  }

  // 1. The human player's shroud (their line of sight).
  world.visGrid.fill(0);
  for (const p of myPts) markVision(world, p.x, p.y);
  world.visVersion++;

  // 2. Spotting both ways.
  for (const s of world.soldiers) spotSoldier(world, s, s.faction === me ? foePts : myPts, dt);
  for (const v of world.vehicles) spotVehicle(world, v, v.faction === me ? foePts : myPts, dt);
}

function markVision(world: World, x: number, y: number): void {
  const { grid } = world;
  const ox = Math.floor(x);
  const oy = Math.floor(y);
  // The Civil War is fought in the open in daylight: you can see across the field, so the
  // shroud lifts much further than the close, concealed WW2 battlefield.
  const r = modernEra(world.era) ? VISION_CELLS : ACW_VISION_CELLS;
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
  const terrain = grid.inBounds(tcx, tcy) ? grid.get(tcx, tcy) : null;
  const conceal = terrain != null ? TERRAIN[terrain].concealment : 0;
  const moving = t.path != null && t.status === "active";
  const firing = t.firedTimer > 0;
  // Massed ranks standing upright in the open are visible at long range in the Civil War;
  // a gun and its crew (and powder smoke) are more conspicuous still. WW2 keeps the short
  // base — dispersed, prone, camouflaged men are hard to pick out.
  const base = (modernEra(world.era) ? SPOT_BASE : ACW_SPOT_BASE) * (t.weapon === "cannon" || t.weapon === "catapult" ? 1.6 : 1);
  let range = base * (1 - conceal * 0.6);
  if (moving) range *= 1.3;
  if (t.stance === "sneak") range *= 0.45;
  else if (t.stance === "fast") range *= 1.3;
  else if (t.stance === "ambush" || t.stance === "defend") range *= 0.85;
  // Muzzle flash, smoke and tracers give a firing soldier away. A man shooting is
  // spottable out to the range he's actually shooting at, by anyone with a clear line
  // to him — concealment only thins it a little. Because LOS is mutual, whoever he's
  // firing on can always spot him back, so you can never be killed from concealment by
  // an enemy you had no chance of seeing. (Holding fire — ambush/sneak — stays hidden.)
  if (firing) range = Math.max(range, WEAPONS[t.weapon].rangeCells * (1 - conceal * 0.3));
  // A buttoned-up tank crew, peering through narrow vision slits/periscopes, is far worse
  // than infantry at picking a man out of a doorway or window — this is what lets an AT
  // team hole up in a house and let armor close in without being spotted through the wall
  // the instant it comes into general view.
  const indoors = terrain != null && isBuildingInterior(terrain);
  applySeen(world, t, spotters, tcx, tcy, (s) => (s.vehicle && indoors ? range * 0.45 : range), dt);
}

function spotVehicle(world: World, v: Vehicle, spotters: Spotter[], dt: number): void {
  // Tanks are conspicuous; movement and the gun going off give them away further.
  let range = SPOT_BASE * 1.4;
  if (v.path) range *= 1.2;
  // An anti-tank man watches for armor — he picks a tank's silhouette/engine note out at
  // real distance instead of needing it as close as a rifleman would.
  applySeen(world, v, spotters, Math.floor(v.x), Math.floor(v.y), (s) => (s.atCapable ? range * 1.5 : range), dt);
}

function applySeen(
  world: World,
  t: { x: number; y: number; seen: boolean; seenTimer: number },
  spotters: Spotter[],
  tcx: number,
  tcy: number,
  rangeFor: (s: Spotter) => number,
  dt: number,
): void {
  let visible = false;
  for (const s of spotters) {
    const range = rangeFor(s);
    const dx = s.x - t.x;
    const dy = s.y - t.y;
    if (dx * dx + dy * dy > range * range) continue;
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
