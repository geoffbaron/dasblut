import { addSuppression, killSoldier, woundSoldier } from "./casualty.ts";
import { damageBuildings } from "./buildingDamage.ts";
import { AMBUSH_ACC_MULT, AREA_FIRE_RADIUS } from "./constants.ts";
import { hasLOS } from "./los.ts";
import { TERRAIN } from "./terrain.ts";
import { resolveArmorHit } from "./vehicleCombat.ts";
import { WEAPONS } from "./weapons.ts";
import { Soldier, World } from "./world.ts";
import { sound } from "../render/sound.ts";
import type { SfxId } from "../render/sound.ts";

// Resolves all firing for one sim step. Soldiers fire at their acquired target at
// their weapon's rate; each shot rolls to hit (modified by range, the target's
// cover/concealment, movement, and the shooter's own suppression, morale, and
// veterancy). Most fire suppresses rather than kills — the firefight is won by
// pinning the enemy, exactly as in Close Combat.
export function resolveFire(world: World, dt: number): void {
  for (const s of world.soldiers) {
    s.firedTimer = Math.max(0, s.firedTimer - dt);
    s.ambushTimer = Math.max(0, s.ambushTimer - dt);
    s.grenadeCD = Math.max(0, s.grenadeCD - dt);
    if (s.status !== "active") continue;
    if (s.state === "panicked" || s.state === "routing" || s.stance === "sneak") continue;

    // Grenades: close-in, used to flush an enemy out of hard cover (a building,
    // hedgerow, rubble) where rifle fire just can't reach him.
    tryThrowGrenade(world, s);

    if (s.ammo <= 0) continue;

    const w = WEAPONS[s.weapon];
    const rateMul = s.state === "pinned" ? 0.35 : s.state === "shaken" ? 0.75 : 1;

    // Anti-tank fire: a bazooka/Panzerfaust man engaging armor.
    if (s.targetVehId != null && w.penetration != null) {
      const veh = world.vehicle(s.targetVehId);
      if (!veh || veh.status === "ko") {
        s.targetVehId = null;
      } else {
        const d = Math.hypot(veh.x - s.x, veh.y - s.y);
        if (d <= w.rangeCells && hasLOS(world.grid, Math.floor(s.x), Math.floor(s.y), Math.floor(veh.x), Math.floor(veh.y))) {
          s.fireCD -= dt;
          if (s.fireCD <= 0 && s.ammo > 0) {
            s.fireCD = 1 / w.rof;
            s.ammo--;
            s.firedTimer = 0.6;
            sound.play(s.weapon as SfxId, s.x, s.y);
            world.effects.push({ kind: "ap", x0: s.x, y0: s.y, x1: veh.x, y1: veh.y, ttl: 0.12 });
            let hit = w.accuracy * (1 - 0.3 * (d / w.rangeCells)) * (veh.path ? 0.75 : 1);
            hit *= 1 - s.suppression * 0.6;
            hit *= 0.7 + 0.3 * s.training;
            if (Math.random() < Math.max(0.05, Math.min(0.95, hit)))
              resolveArmorHit(world, veh, w.penetration, s.x, s.y, d, w.rangeCells);
          }
        }
      }
      continue;
    }

    // Indirect mortar fire: lob HE onto the designated cell with no line-of-sight,
    // so long as it's within the min/max range arc.
    if (s.fireCell && w.indirect) {
      const d = Math.hypot(s.fireCell.cx + 0.5 - s.x, s.fireCell.cy + 0.5 - s.y);
      if (d < (w.minRangeCells ?? 0) || d > w.rangeCells) continue;
      s.fireCD -= dt * rateMul;
      if (s.fireCD <= 0 && s.ammo > 0) {
        s.fireCD += 1 / w.rof;
        s.ammo--;
        s.firedTimer = 0.5;
        mortarShot(world, s);
      }
      continue;
    }

    // Area (suppressing) fire onto a designated patch of ground.
    if (s.fireCell) {
      if (!hasLOS(world.grid, Math.floor(s.x), Math.floor(s.y), s.fireCell.cx, s.fireCell.cy)) continue;
      s.fireCD -= dt * rateMul;
      let guard = 8;
      while (s.fireCD <= 0 && s.ammo > 0 && guard-- > 0) {
        s.fireCD += 1 / w.rof;
        s.ammo--;
        s.firedTimer = 0.5;
        areaShot(world, s);
      }
      continue;
    }

    // Indirect weapons never snap-fire at spotted men; they only drop rounds on a
    // player-designated cell (handled above).
    if (w.indirect) continue;

    const target = s.targetId != null ? world.soldier(s.targetId) : undefined;
    if (!target || target.status !== "active") {
      s.targetId = null;
      continue;
    }
    const dist = Math.hypot(target.x - s.x, target.y - s.y);
    if (dist > w.rangeCells) continue;
    if (!hasLOS(world.grid, Math.floor(s.x), Math.floor(s.y), Math.floor(target.x), Math.floor(target.y)))
      continue;

    s.fireCD -= dt * rateMul;
    let guard = 8;
    while (s.fireCD <= 0 && s.ammo > 0 && guard-- > 0) {
      s.fireCD += 1 / w.rof;
      s.ammo--;
      s.firedTimer = 0.5;
      fireShot(world, s, target, dist);
    }
  }
}

// Suppressing fire onto a point: tracers in, suppression splashed over any enemy
// near the aimpoint. Rattles defenders out of a window or treeline without needing
// to see them clearly.
function areaShot(world: World, s: Soldier): void {
  const w = WEAPONS[s.weapon];
  const cell = s.fireCell!;
  const tx = cell.cx + 0.5 + (Math.random() - 0.5);
  const ty = cell.cy + 0.5 + (Math.random() - 0.5);
  sound.play(s.weapon as SfxId, s.x, s.y);
  world.effects.push({ kind: "flash", x0: s.x, y0: s.y, x1: s.x, y1: s.y, ttl: 0.07 });
  if (Math.random() < w.tracerRate)
    world.effects.push({ kind: "tracer", x0: s.x, y0: s.y, x1: tx, y1: ty, ttl: 0.06 });

  for (const e of world.soldiers) {
    if (e.faction === s.faction || e.status !== "active") continue;
    const d = Math.hypot(e.x - cell.cx - 0.5, e.y - cell.cy - 0.5);
    if (d <= AREA_FIRE_RADIUS) addSuppression(e, w.suppression * (1 - d / AREA_FIRE_RADIUS));
  }
}

// An indirect HE round: thumps out of the tube, lands with dispersion near the
// aimpoint, and bursts — suppressing and wounding everyone (friend or foe) inside
// the blast. Realistic friendly-fire risk is the price of calling it close.
function mortarShot(world: World, s: Soldier): void {
  const w = WEAPONS[s.weapon];
  const cell = s.fireCell!;
  // Dispersion grows a little with range; rounds rarely land dead-on.
  const tx = cell.cx + 0.5 + (Math.random() - 0.5) * 3;
  const ty = cell.cy + 0.5 + (Math.random() - 0.5) * 3;

  sound.play("mortar", s.x, s.y); // tube thump at the firing position
  sound.play("explosion", tx, ty); // burst downrange
  // Muzzle flash at the tube and a round arcing downrange to the impact point.
  world.effects.push({ kind: "flash", x0: s.x, y0: s.y, x1: s.x, y1: s.y, ttl: 0.12 });
  world.effects.push({ kind: "lob", x0: s.x, y0: s.y, x1: tx, y1: ty, ttl: 0.7, maxTtl: 0.7 });
  world.effects.push({ kind: "fire", x0: tx, y0: ty, x1: tx, y1: ty, ttl: 0.4 });
  world.effects.push({ kind: "smoke", x0: tx, y0: ty, x1: tx, y1: ty, ttl: 1.6, maxTtl: 1.6 });

  const blast = w.blastCells ?? 3;
  damageBuildings(world, Math.floor(tx), Math.floor(ty), blast, 1.4);
  for (const e of world.soldiers) {
    if (e.status !== "active") continue;
    const d = Math.hypot(e.x - tx, e.y - ty);
    if (d > blast) continue;
    const falloff = 1 - d / blast;
    addSuppression(e, w.suppression * falloff);
    if (Math.random() < w.lethality * falloff * 0.5) {
      if (Math.random() < 0.5) {
        sound.play("soldier_scream", e.x, e.y);
        killSoldier(world, e);
      } else {
        sound.play("soldier_hit", e.x, e.y);
        woundSoldier(world, e);
      }
    }
  }
}

const GRENADE_RANGE = 5; // cells (~10 m) — throwing distance
const GRENADE_RADIUS = 1.8; // blast radius in cells
const GRENADE_COOLDOWN = 6; // seconds between throws per man

// Look for a nearby enemy hunkered in cover and, if one's in range and visible,
// lob a grenade at him. Grenades ignore cover (that's their job) and crack the
// building they land in.
function tryThrowGrenade(world: World, s: Soldier): void {
  if (s.grenades <= 0 || s.grenadeCD > 0) return;
  if (s.suppression > 0.6) return; // too pinned to pop up and throw

  let target: Soldier | null = null;
  let bestD = GRENADE_RANGE;
  for (const e of world.soldiers) {
    if (e.faction === s.faction || e.status !== "active") continue;
    const d = Math.hypot(e.x - s.x, e.y - s.y);
    if (d > bestD) continue;
    const tc = world.grid.inBounds(Math.floor(e.x), Math.floor(e.y))
      ? TERRAIN[world.grid.get(Math.floor(e.x), Math.floor(e.y))].cover
      : 0;
    if (tc < 0.35) continue; // only bother if he's actually in cover
    if (!hasLOS(world.grid, Math.floor(s.x), Math.floor(s.y), Math.floor(e.x), Math.floor(e.y))) continue;
    target = e;
    bestD = d;
  }
  if (!target) return;

  s.grenades--;
  s.grenadeCD = GRENADE_COOLDOWN;
  s.firedTimer = 0.5;
  throwGrenade(world, s, target.x, target.y);
}

function throwGrenade(world: World, s: Soldier, tx: number, ty: number): void {
  sound.play("explosion", tx, ty);
  world.effects.push({ kind: "lob", x0: s.x, y0: s.y, x1: tx, y1: ty, ttl: 0.5, maxTtl: 0.5 });
  world.effects.push({ kind: "hit", x0: tx, y0: ty, x1: tx, y1: ty, ttl: 0.3 });
  damageBuildings(world, Math.floor(tx), Math.floor(ty), GRENADE_RADIUS, 0.7);

  for (const e of world.soldiers) {
    if (e.faction === s.faction || e.status !== "active") continue;
    const d = Math.hypot(e.x - tx, e.y - ty);
    if (d > GRENADE_RADIUS) continue;
    const falloff = 1 - d / GRENADE_RADIUS;
    // Frag ignores small-arms cover — the whole point of grenading a holed-up man.
    if (Math.random() < 0.55 * falloff) {
      if (Math.random() < 0.5) {
        sound.play("soldier_scream", e.x, e.y);
        killSoldier(world, e);
      } else {
        sound.play("soldier_hit", e.x, e.y);
        woundSoldier(world, e);
      }
    } else {
      addSuppression(e, 0.5 * falloff);
    }
  }
}

function fireShot(world: World, s: Soldier, target: Soldier, dist: number): void {
  const w = WEAPONS[s.weapon];
  const bonus = s.ambushTimer > 0 ? AMBUSH_ACC_MULT : 1;
  const tcx = Math.floor(target.x);
  const tcy = Math.floor(target.y);
  const cell = world.grid.inBounds(tcx, tcy) ? TERRAIN[world.grid.get(tcx, tcy)] : null;
  const cover = cell ? cell.cover : 0;
  const conceal = cell ? cell.concealment : 0;

  // Muzzle flash + occasional tracer.
  sound.play(s.weapon as SfxId, s.x, s.y);
  world.effects.push({ kind: "flash", x0: s.x, y0: s.y, x1: s.x, y1: s.y, ttl: 0.07 });
  if (Math.random() < w.tracerRate)
    world.effects.push({ kind: "tracer", x0: s.x, y0: s.y, x1: target.x, y1: target.y, ttl: 0.06 });

  // Hit probability.
  let p = w.accuracy * (1 - 0.55 * (dist / w.rangeCells));
  p *= 1 - cover * 0.7;
  p *= 1 - conceal * 0.4;
  if (target.path) p *= 0.75; // moving is harder to hit...
  else p *= 0.85; // ...but a prone/static man is small too
  p *= 1 - s.suppression * 0.7; // a suppressed shooter aims poorly
  p *= 0.6 + 0.4 * s.morale;
  p *= 0.7 + 0.3 * s.training;
  p *= bonus; // ambush opening volley
  p = Math.max(0, Math.min(0.95, p));

  // Incoming fire always rattles the target (and splashes onto neighbours).
  addSuppression(target, w.suppression * bonus);
  splashSuppression(world, target, w.suppression * 0.4);

  if (Math.random() < p) {
    const lethal = w.lethality * (1 - cover * 0.5);
    const r = Math.random();
    if (r < lethal * 0.5) {
      sound.play("soldier_scream", target.x, target.y);
      killSoldier(world, target);
    } else if (r < lethal) {
      sound.play("soldier_hit", target.x, target.y);
      woundSoldier(world, target);
    } else {
      addSuppression(target, 0.3); // a graze / near-miss hammers morale
    }
  }
}

function splashSuppression(world: World, around: Soldier, amt: number): void {
  for (const o of world.soldiers) {
    if (o === around || o.faction !== around.faction || o.status !== "active") continue;
    const dx = o.x - around.x;
    const dy = o.y - around.y;
    if (dx * dx + dy * dy <= 2.25) addSuppression(o, amt);
  }
}
