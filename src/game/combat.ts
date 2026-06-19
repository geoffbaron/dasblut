import { addSuppression, killSoldier, woundSoldier } from "./casualty.ts";
import { damageBuildings } from "./buildingDamage.ts";
import { AMBUSH_ACC_MULT, AREA_FIRE_RADIUS, SMOKE_DEPOSIT, SMOKE_RADIUS } from "./constants.ts";
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
        if (d <= w.rangeCells && hasLOS(world.grid, Math.floor(s.x), Math.floor(s.y), Math.floor(veh.x), Math.floor(veh.y), world.smokeGrid)) {
          s.fireCD -= dt;
          if (s.fireCD <= 0 && s.ammo > 0) {
            s.fireCD = 1 / w.rof;
            s.ammo--;
            s.firedTimer = 0.6;
            sound.play(s.weapon as SfxId, s.x, s.y);
            bazookaEffect(world, s.x, s.y, veh.x, veh.y);
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

    // Indirect mortar fire: lob HE — or a smoke screen — onto the designated cell
    // with no line-of-sight, so long as it's within the min/max range arc.
    if (s.fireCell && w.indirect) {
      const d = Math.hypot(s.fireCell.cx + 0.5 - s.x, s.fireCell.cy + 0.5 - s.y);
      if (d < (w.minRangeCells ?? 0) || d > w.rangeCells) continue;
      s.fireCD -= dt * rateMul;
      if (s.fireCD <= 0 && s.ammo > 0) {
        s.ammo--;
        s.firedTimer = 0.5;
        if (s.fireSmoke) {
          // One smoke shell per order — fire it, then the screen stands on its own.
          smokeShot(world, s);
          s.fireSmoke = false;
          s.fireCell = null;
        } else {
          s.fireCD += 1 / w.rof;
          mortarShot(world, s);
        }
      }
      continue;
    }

    // Area (suppressing) fire onto a designated patch of ground.
    if (s.fireCell) {
      if (!hasLOS(world.grid, Math.floor(s.x), Math.floor(s.y), s.fireCell.cx, s.fireCell.cy, world.smokeGrid)) continue;
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
    if (!hasLOS(world.grid, Math.floor(s.x), Math.floor(s.y), Math.floor(target.x), Math.floor(target.y), world.smokeGrid))
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
  if (Math.random() < w.tracerRate) {
    world.effects.push({ kind: "tracer", x0: s.x, y0: s.y, x1: tx, y1: ty, ttl: 0.06 });
    spawnRicochet(world, tx, ty);
  }

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
      if (Math.random() < 0.5) killSoldier(world, e);
      else woundSoldier(world, e);
    }
  }
}

// A smoke round: lands near the aimpoint and blooms a screen — stamping the smoke
// grid (which breaks line of sight) and seeding drifting visual puffs. No casualties;
// this is for covering an advance, not killing.
function smokeShot(world: World, s: Soldier): void {
  const cell = s.fireCell!;
  // Smoke is meant to land where you asked, so dispersion is tighter than HE.
  const tx = cell.cx + 0.5 + (Math.random() - 0.5) * 1.4;
  const ty = cell.cy + 0.5 + (Math.random() - 0.5) * 1.4;

  sound.play("mortar", s.x, s.y); // tube thump at the firing position
  world.effects.push({ kind: "flash", x0: s.x, y0: s.y, x1: s.x, y1: s.y, ttl: 0.12 });
  world.effects.push({ kind: "lob", x0: s.x, y0: s.y, x1: tx, y1: ty, ttl: 0.7, maxTtl: 0.7 });

  // Stamp the smoke grid in a soft disc, densest at the center.
  const grid = world.grid;
  const r = SMOKE_RADIUS;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const x = Math.floor(tx) + dx;
      const y = Math.floor(ty) + dy;
      if (!grid.inBounds(x, y)) continue;
      const dist = Math.hypot(dx, dy);
      if (dist > r) continue;
      const add = SMOKE_DEPOSIT * (1 - dist / r);
      const i = grid.idx(x, y);
      world.smokeGrid[i] = Math.min(2.2, world.smokeGrid[i] + add);
    }
  }
  // A couple of visual puffs to sell the burst the moment it lands.
  for (let k = 0; k < 3; k++) {
    world.effects.push({
      kind: "smoke",
      x0: tx + (Math.random() - 0.5) * 2, y0: ty + (Math.random() - 0.5) * 2,
      x1: 0, y1: 0, ttl: 2.4, maxTtl: 2.4,
    });
  }
}

const GRENADE_RANGE = 6; // cells (~12 m) — throwing distance
const GRENADE_RADIUS = 1.8; // blast radius in cells
const GRENADE_COOLDOWN = 3.5; // seconds between throws per man
const GRENADE_POINT_BLANK = 3.5; // within this, lob one even at an exposed enemy

// Look for a nearby visible enemy and, if he's in cover (where rifle fire is wasted)
// or simply close enough, lob a grenade at him. Grenades ignore cover (that's their
// job) and crack the building they land in.
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
    // Grenade a man in any real cover, or anyone who's right on top of us.
    if (tc < 0.2 && d > GRENADE_POINT_BLANK) continue;
    if (!hasLOS(world.grid, Math.floor(s.x), Math.floor(s.y), Math.floor(e.x), Math.floor(e.y), world.smokeGrid)) continue;
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
      if (Math.random() < 0.5) killSoldier(world, e);
      else woundSoldier(world, e);
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
  if (Math.random() < w.tracerRate) {
    world.effects.push({ kind: "tracer", x0: s.x, y0: s.y, x1: target.x, y1: target.y, ttl: 0.06 });
    spawnRicochet(world, target.x, target.y);
  }

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
    if (r < lethal * 0.5) killSoldier(world, target);
    else if (r < lethal) woundSoldier(world, target);
    else addSuppression(target, 0.3); // a graze / near-miss hammers morale
  }
}

// A bazooka/Panzerfaust rocket: muzzle flash and a back-blast plume behind the
// firer, a bright rocket streak downrange, then a fiery burst at the target so the
// shot reads clearly even when it bounces off armor.
function bazookaEffect(world: World, sx: number, sy: number, tx: number, ty: number): void {
  const ang = Math.atan2(ty - sy, tx - sx);
  // Back-blast: smoke kicked out behind the launcher.
  const bx = sx - Math.cos(ang) * 1.2;
  const by = sy - Math.sin(ang) * 1.2;
  world.effects.push({ kind: "flash", x0: sx, y0: sy, x1: sx, y1: sy, ttl: 0.1 });
  world.effects.push({ kind: "smoke", x0: bx, y0: by, x1: 0, y1: 0, ttl: 0.9, maxTtl: 0.9 });
  // Rocket streak in flight.
  world.effects.push({ kind: "ap", x0: sx, y0: sy, x1: tx, y1: ty, ttl: 0.14 });
  // Impact burst.
  world.effects.push({ kind: "flash", x0: tx, y0: ty, x1: tx, y1: ty, ttl: 0.1 });
  world.effects.push({ kind: "fire", x0: tx, y0: ty, x1: tx, y1: ty, ttl: 0.4 });
  world.effects.push({ kind: "hit", x0: tx, y0: ty, x1: tx, y1: ty, ttl: 0.3 });
  world.effects.push({ kind: "smoke", x0: tx, y0: ty, x1: 0, y1: 0, ttl: 1.1, maxTtl: 1.1 });
  sound.play("explosion", tx, ty);
}

// Some rounds spit off the ground/cover where a tracer lands: a quick bright spark
// streak shooting away in a random direction, with the occasional audible zing.
export function spawnRicochet(world: World, x: number, y: number): void {
  if (Math.random() > 0.22) return; // only a fraction of tracers kick off
  const a = Math.random() * Math.PI * 2;
  const len = 1.2 + Math.random() * 2.2;
  world.effects.push({
    kind: "ricochet",
    x0: x, y0: y,
    x1: x + Math.cos(a) * len, y1: y + Math.sin(a) * len,
    ttl: 0.14,
  });
  if (Math.random() < 0.35) sound.play("ricochet", x, y);
}

function splashSuppression(world: World, around: Soldier, amt: number): void {
  for (const o of world.soldiers) {
    if (o === around || o.faction !== around.faction || o.status !== "active") continue;
    const dx = o.x - around.x;
    const dy = o.y - around.y;
    if (dx * dx + dy * dy <= 2.25) addSuppression(o, amt);
  }
}
