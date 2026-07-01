import { addSuppression, killSoldier, woundSoldier } from "./casualty.ts";
import { damageBuildings } from "./buildingDamage.ts";
import { AMBUSH_ACC_MULT, AREA_FIRE_RADIUS, CANNON_SETUP_TIME, GUN_CREW_TO_SERVE, MG_ARC, MG_SETUP_TIME, MG_TRAVERSE, SMOKE_INITIAL } from "./constants.ts";
import { hasLOS } from "./los.ts";
import { isHardSurface, TERRAIN } from "./terrain.ts";
import { knockOut, resolveArmorHit } from "./vehicleCombat.ts";
import { WEAPONS } from "./weapons.ts";
import { Faction, PendingGrenade, Soldier, Vehicle, World } from "./world.ts";
import { sound } from "../render/sound.ts";
import type { SfxId } from "../render/sound.ts";

// Resolves all firing for one sim step. Soldiers fire at their acquired target at
// their weapon's rate; each shot rolls to hit (modified by range, the target's
// cover/concealment, movement, and the shooter's own suppression, morale, and
// veterancy). Most fire suppresses rather than kills — the firefight is won by
// pinning the enemy, exactly as in Close Combat.
export function resolveFire(world: World, dt: number): void {
  // Volley cadence: a Civil War line fires and reloads as one body. Tick each squad's
  // volley timer; a squad looses the instant it hits zero, then reloads together. The
  // set records which squads fired this step so we can restart their reload after.
  for (const t of world.teams) if (t.volleyCD > 0) t.volleyCD = Math.max(0, t.volleyCD - dt);
  const volleyed = new Set<number>();

  for (const s of world.soldiers) {
    s.firedTimer = Math.max(0, s.firedTimer - dt);
    s.ambushTimer = Math.max(0, s.ambushTimer - dt);
    s.grenadeCD = Math.max(0, s.grenadeCD - dt);
    // A machine gun (on its bipod) and a field gun (unlimbered and laid) both have to be
    // set up before they can fire, and both lose that setup the instant the crew picks them
    // up to move — so neither can fire on the march. Track deployed-and-still time; any
    // movement (an individual path OR drifting with the marching formation) resets it.
    if (s.weapon === "lmg" || s.weapon === "cannon" || s.weapon === "catapult") {
      const movedSq = (s.x - s.px) ** 2 + (s.y - s.py) ** 2;
      const cap = (s.weapon === "lmg" ? MG_SETUP_TIME : CANNON_SETUP_TIME) + 1;
      if (s.path != null || movedSq > 1e-4) s.setupTime = 0;
      else s.setupTime = Math.min(cap, s.setupTime + dt);
    }
    if (s.status !== "active") continue;
    if (s.state === "panicked" || s.state === "routing" || s.stance === "sneak") continue;

    // Melee arms never shoot — they close and settle it hand-to-hand (updateMelee).
    if (WEAPONS[s.weapon].meleeOnly) continue;

    // Grenades: close-in, used to flush an enemy out of hard cover (a building,
    // hedgerow, rubble) where rifle fire just can't reach him.
    tryThrowGrenade(world, s);

    if (s.ammo <= 0) continue;

    const w = WEAPONS[s.weapon];
    const rateMul = s.state === "pinned" ? 0.35 : s.state === "shaken" ? 0.75 : 1;

    // Field gun: direct line-of-sight artillery. Fires at a player-designated cell
    // (bombardment) or, failing that, an acquired enemy. Long range with a shell that
    // bursts in the ranks; close in it switches to canister (handled in cannonShot).
    if (w.artillery) {
      // Can't fire while limbered/on the move, or before the crew has re-laid the gun.
      if (s.setupTime < CANNON_SETUP_TIME) continue;
      // A gun is nothing without hands to serve it — undermanned, it falls silent.
      if (gunCrew(world, s) < GUN_CREW_TO_SERVE) continue;
      let ax = 0, ay = 0, ok = false;
      if (s.fireCell && hasLOS(world.grid, Math.floor(s.x), Math.floor(s.y), s.fireCell.cx, s.fireCell.cy, world.smokeGrid)) {
        ax = s.fireCell.cx + 0.5; ay = s.fireCell.cy + 0.5; ok = true;
      } else if (s.targetId != null) {
        const t = world.soldier(s.targetId);
        if (t && t.status === "active") { ax = t.x; ay = t.y; ok = true; } else s.targetId = null;
      }
      if (ok) {
        const d = Math.hypot(ax - s.x, ay - s.y);
        if (d <= w.rangeCells && hasLOS(world.grid, Math.floor(s.x), Math.floor(s.y), Math.floor(ax), Math.floor(ay), world.smokeGrid)) {
          s.fireCD -= dt * rateMul;
          if (s.fireCD <= 0 && s.ammo > 0) {
            s.fireCD = 1 / w.rof;
            s.ammo--;
            s.firedTimer = 0.6;
            cannonShot(world, s, ax, ay, d);
          }
        }
      }
      continue;
    }

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
            bazookaLaunch(world, s.x, s.y, veh.x, veh.y);
            let hit = w.accuracy * (1 - 0.3 * (d / w.rangeCells)) * (veh.path ? 0.75 : 1);
            hit *= 1 - s.suppression * 0.6;
            hit *= 0.7 + 0.3 * s.training;
            if (Math.random() < Math.max(0.05, Math.min(0.95, hit))) {
              // A solid strike on the hull — resolveArmorHit shows the result
              // (bounce spark vs penetration fireball) and applies the damage.
              world.effects.push({ kind: "flash", x0: veh.x, y0: veh.y, x1: veh.x, y1: veh.y, ttl: 0.12 });
              resolveArmorHit(world, veh, w.penetration, s.x, s.y, d, w.rangeCells);
            } else {
              bazookaMiss(world, veh.x, veh.y);
            }
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
      if (s.fireSmoke) {
        if (s.fireCD <= 0 && s.smokeAmmo > 0) {
          s.smokeAmmo--;
          s.firedTimer = 0.5;
          smokeShot(world, s);
          s.fireSmoke = false;
          s.fireCell = null;
        }
      } else if (s.fireCD <= 0 && s.ammo > 0) {
        s.ammo--;
        s.firedTimer = 0.5;
        s.fireCD += 1 / w.rof;
        mortarShot(world, s);
      }
      continue;
    }

    // Area (suppressing) fire onto a designated patch of ground.
    if (s.fireCell) {
      if (!hasLOS(world.grid, Math.floor(s.x), Math.floor(s.y), s.fireCell.cx, s.fireCell.cy, world.smokeGrid)) continue;
      if (!mgGate(s, s.fireCell.cx + 0.5, s.fireCell.cy + 0.5, dt)) continue;
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
    if (!mgGate(s, target.x, target.y, dt)) continue;

    // Civil War line infantry fire by VOLLEY at a distance: every man holds through the
    // squad's long reload, then on the volley window each one with a clear shot looses
    // together — a wall of smoke and lead. But once the enemy is CLOSE, or the line is
    // rattled, fire discipline breaks down and the men load and fire at will: ragged,
    // sporadic individual shots (the code falls through to the per-man path below).
    const team = world.team(s.teamId);
    const lineInfantry = s.weapon === "riflemusket" && team && team.kind === "infantry";
    const fireAtWill = dist < CLOSE_FIRE_RANGE || s.state === "shaken" || s.state === "pinned";
    if (lineInfantry && !fireAtWill) {
      if (team.volleyCD > 0) continue; // still reloading
      s.ammo--;
      s.firedTimer = 0.6;
      fireShot(world, s, target, dist);
      volleyed.add(team.id);
      continue;
    }

    s.fireCD -= dt * rateMul;
    let guard = 8;
    while (s.fireCD <= 0 && s.ammo > 0 && guard-- > 0) {
      s.fireCD += 1 / w.rof;
      s.ammo--;
      s.firedTimer = 0.5;
      fireShot(world, s, target, dist);
    }
  }

  // Squads that just volleyed begin their (slightly jittered) reload before the next one.
  const reload = 1 / WEAPONS.riflemusket.rof;
  for (const id of volleyed) {
    const t = world.team(id);
    if (t) t.volleyCD = reload * (0.85 + Math.random() * 0.4);
  }
}

// Gate (and aim) an MG's fire. A non-MG always passes. A machine gun fires only when
// it's both finished setting up and trained within its arc on the aimpoint; otherwise
// it swings the gun toward the target (a slow traverse) and holds fire. Swinging onto a
// target outside the cone re-lays the gun, eating into its setup — so a flanker who
// appears off the gun's shoulder gets free moments before it can answer.
function mgGate(s: Soldier, aimX: number, aimY: number, dt: number): boolean {
  if (s.weapon !== "lmg") return true;
  const bearing = Math.atan2(aimY - s.y, aimX - s.x);
  let off = bearing - s.facing;
  off = Math.atan2(Math.sin(off), Math.cos(off)); // normalize to [-π, π]
  if (Math.abs(off) > MG_ARC) {
    s.facing += Math.sign(off) * Math.min(Math.abs(off), MG_TRAVERSE * dt); // traverse toward it
    s.setupTime = Math.max(0, s.setupTime - dt); // re-laying costs setup
    return false;
  }
  s.facing = bearing; // keep the gun trained
  return s.setupTime >= MG_SETUP_TIME;
}

// Draw the path of a shot so the player can read, at a glance, who is firing at what.
// Modern arms leave a glowing tracer on a fraction of rounds (and the round can spit off
// a ricochet where it lands); black-powder muskets and carbines have no tracer at all, so
// their discharge is marked with a brief pale muzzle-flash streak instead — on every shot,
// since a firing line is otherwise just anonymous puffs of smoke.
function emitShot(world: World, s: Soldier, tx: number, ty: number): void {
  const w = WEAPONS[s.weapon];
  // Black-powder muskets/carbines mark each shot with a pale muzzle streak; an arrow shows
  // as a slightly longer-lived shaft in flight. Neither leaves a modern glowing tracer.
  if (s.weapon === "riflemusket" || s.weapon === "carbine" || s.weapon === "bow") {
    world.effects.push({ kind: "shotline", x0: s.x, y0: s.y, x1: tx, y1: ty, ttl: s.weapon === "bow" ? 0.22 : 0.12 });
    return;
  }
  if (Math.random() < w.tracerRate) {
    world.effects.push({ kind: "tracer", x0: s.x, y0: s.y, x1: tx, y1: ty, ttl: 0.16 });
    spawnRicochet(world, tx, ty);
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
  emitShot(world, s, tx, ty);

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

// The crew still standing at a crew-served engine — its teammates who aren't the piece itself.
function gunCrew(world: World, gun: Soldier): number {
  let n = 0;
  for (const o of world.soldiers) {
    if (o.teamId === gun.teamId && o.status === "active" && !WEAPONS[o.weapon].crewServed) n++;
  }
  return n;
}

// Silence and abandon any crew-served engine (field gun, catapult) whose crew has been wiped
// out. Called each step after casualties resolve: with no hands to work it, it's left wrecked.
export function updateGunCrews(world: World): void {
  for (const s of world.soldiers) {
    if (s.status !== "active" || !WEAPONS[s.weapon].crewServed) continue;
    if (gunCrew(world, s) > 0) continue;
    s.status = "dead"; // the engine is out of action — treated as a wreck on the field
    s.targetId = null;
    s.fireCell = null;
    s.path = null;
    for (let i = 0; i < 3; i++) world.effects.push({ kind: "smoke", x0: s.x + (Math.random() - 0.5), y0: s.y + (Math.random() - 0.5), x1: 0, y1: 0, ttl: 1.6, maxTtl: 1.6 });
    world.effects.push({ kind: "hit", x0: s.x, y0: s.y, x1: s.x, y1: s.y, ttl: 0.4 });
  }
}

// A crew-served engine's discharge. A catapult hurls a boulder; a field gun beyond canister
// range lobs a shell that bursts in the ranks, and inside canister range switches to
// grapeshot. Only the enemies of the firing side are caught: crews fire over their own ranks.
function cannonShot(world: World, s: Soldier, tx: number, ty: number, dist: number): void {
  const w = WEAPONS[s.weapon];
  if (s.weapon === "catapult") catapultBoulder(world, s, tx, ty);
  else if (dist <= (w.canisterCells ?? 0)) canisterBlast(world, s, tx, ty);
  else shellBurst(world, s, tx, ty);
}

// A catapult stone: hurled in a high arc, it comes down and smashes — pulping anyone in the
// fall and cracking any wall it strikes. No fire or shrapnel, just a bone-breaking impact and
// a gout of dust. Blunt but brutal inside its footprint.
function catapultBoulder(world: World, s: Soldier, tx: number, ty: number): void {
  const w = WEAPONS[s.weapon];
  sound.play("catapult", s.x, s.y); // the arm's release
  world.effects.push({ kind: "lob", x0: s.x, y0: s.y, x1: tx, y1: ty, ttl: 0.85, maxTtl: 0.85 }); // stone arcs over
  // Impact: a heavy crash, a plume of dust and a scatter of thrown earth — no flame.
  sound.play("boulder", tx, ty, true);
  world.effects.push({ kind: "hit", x0: tx, y0: ty, x1: tx, y1: ty, ttl: 0.45 });
  for (let i = 0; i < 3; i++) {
    const a = Math.random() * Math.PI * 2, r = 1 + Math.random() * 1.6;
    world.effects.push({ kind: "smoke", x0: tx + Math.cos(a) * r * 0.5, y0: ty + Math.sin(a) * r * 0.5, x1: 0, y1: 0, ttl: 1.4, maxTtl: 1.6 });
    world.effects.push({ kind: "spark", x0: tx, y0: ty, x1: tx + Math.cos(a) * (r + 1.5), y1: ty + Math.sin(a) * (r + 1.5), ttl: 0.22 });
  }
  const radius = w.blastCells ?? 3;
  damageBuildings(world, Math.floor(tx), Math.floor(ty), radius, 1.6); // a stone stoves in a wall
  for (const e of world.soldiers) {
    if (e.faction === s.faction || e.status !== "active") continue;
    const d = Math.hypot(e.x - tx, e.y - ty);
    if (d > radius) continue;
    const falloff = 1 - d / radius;
    addSuppression(e, w.suppression * falloff);
    if (Math.random() < w.lethality * falloff * 0.75) { // crushing: mostly kills, cover barely helps
      if (Math.random() < 0.7) killSoldier(world, e);
      else woundSoldier(world, e);
    }
  }
}

// Shell/solid shot: a single projectile streaks downrange and bursts in the ranks — a
// fierce multi-burst of flash, fireballs, thrown dirt, a shock ring and a gout of smoke.
function shellBurst(world: World, s: Soldier, tx: number, ty: number): void {
  const w = WEAPONS[s.weapon];
  sound.play("cannon", s.x, s.y);
  // Muzzle: hard flash, a big bank of black-powder smoke, and the round streaking out.
  world.effects.push({ kind: "flash", x0: s.x, y0: s.y, x1: s.x, y1: s.y, ttl: 0.2 });
  world.effects.push({ kind: "fire", x0: s.x, y0: s.y, x1: s.x, y1: s.y, ttl: 0.18 });
  for (let i = 0; i < 2; i++) world.effects.push({ kind: "smoke", x0: s.x + (Math.random() - 0.5), y0: s.y + (Math.random() - 0.5), x1: 0, y1: 0, ttl: 1.8, maxTtl: 1.8 });
  world.effects.push({ kind: "ap", x0: s.x, y0: s.y, x1: tx, y1: ty, ttl: 0.16 }); // round in flight
  sound.play("explosion", tx, ty);
  sound.play("explosion", tx, ty, true);
  world.effects.push({ kind: "flash", x0: tx, y0: ty, x1: tx, y1: ty, ttl: 0.16 });
  world.effects.push({ kind: "fire", x0: tx, y0: ty, x1: tx, y1: ty, ttl: 0.5 });
  for (let i = 0; i < 3; i++) {
    const a = Math.random() * Math.PI * 2, r = Math.random() * 1.6;
    world.effects.push({ kind: "fire", x0: tx + Math.cos(a) * r, y0: ty + Math.sin(a) * r, x1: tx, y1: ty, ttl: 0.3 + Math.random() * 0.25 });
    world.effects.push({ kind: "spark", x0: tx, y0: ty, x1: tx + Math.cos(a) * (r + 2), y1: ty + Math.sin(a) * (r + 2), ttl: 0.2 });
  }
  world.effects.push({ kind: "hit", x0: tx, y0: ty, x1: tx, y1: ty, ttl: 0.36 });
  for (let i = 0; i < 2; i++) world.effects.push({ kind: "smoke", x0: tx + (Math.random() - 0.5) * 1.5, y0: ty + (Math.random() - 0.5) * 1.5, x1: 0, y1: 0, ttl: 1.8, maxTtl: 1.8 });

  const radius = w.blastCells ?? 3;
  damageBuildings(world, Math.floor(tx), Math.floor(ty), radius, 1.2);
  for (const e of world.soldiers) {
    if (e.faction === s.faction || e.status !== "active") continue;
    const d = Math.hypot(e.x - tx, e.y - ty);
    if (d > radius) continue;
    const falloff = 1 - d / radius;
    addSuppression(e, w.suppression * falloff);
    if (Math.random() < 0.5 * falloff) {
      if (Math.random() < 0.6) killSoldier(world, e);
      else woundSoldier(world, e);
    }
  }
}

// Canister (grapeshot): the round is a tin can packed with iron balls that ruptures at the
// muzzle, turning the field gun into a giant shotgun. There is NO shell downrange — the gun
// throws a cone of balls that scythes every man in a shallow arc out to short range, the
// killing done all along the cone. Its unmistakable signature is a wide fan of ball-streaks
// spraying from the muzzle and dirt kicked up across the swath. This is the round that made
// guns murderous against a close assault.
function canisterBlast(world: World, s: Soldier, tx: number, ty: number): void {
  const w = WEAPONS[s.weapon];
  const range = w.canisterCells ?? 20;
  const ang0 = Math.atan2(ty - s.y, tx - s.x);
  const SPREAD = 0.32; // radians half-angle of the cone (~18°)

  sound.play("cannon", s.x, s.y);
  // Muzzle: a hard double flash and a great bank of powder smoke — but no round arcs away.
  world.effects.push({ kind: "flash", x0: s.x, y0: s.y, x1: s.x, y1: s.y, ttl: 0.22 });
  world.effects.push({ kind: "flash", x0: s.x + Math.cos(ang0) * 0.8, y0: s.y + Math.sin(ang0) * 0.8, x1: s.x, y1: s.y, ttl: 0.16 });
  world.effects.push({ kind: "fire", x0: s.x, y0: s.y, x1: s.x, y1: s.y, ttl: 0.18 });
  for (let i = 0; i < 3; i++) world.effects.push({ kind: "smoke", x0: s.x + Math.cos(ang0) * 0.8 + (Math.random() - 0.5), y0: s.y + Math.sin(ang0) * 0.8 + (Math.random() - 0.5), x1: 0, y1: 0, ttl: 1.6, maxTtl: 1.6 });
  // The swarm of balls: a fan of pale streaks across the cone, each kicking up a spark of
  // dirt where it strikes. This spray IS the "shotgun" tell that reads instantly as grapeshot.
  for (let i = 0; i < 20; i++) {
    const a = ang0 + (Math.random() * 2 - 1) * SPREAD;
    const r = range * (0.4 + Math.random() * 0.6);
    const ex = s.x + Math.cos(a) * r, ey = s.y + Math.sin(a) * r;
    world.effects.push({ kind: "shotline", x0: s.x + Math.cos(ang0) * 0.6, y0: s.y + Math.sin(ang0) * 0.6, x1: ex, y1: ey, ttl: 0.16 });
    world.effects.push({ kind: "spark", x0: ex, y0: ey, x1: ex, y1: ey, ttl: 0.16 });
  }

  // Casualties: every enemy inside the cone and within range is raked, worst up close and
  // dead on the axis. No friendly fire — the balls go out over the gun's own line.
  for (const e of world.soldiers) {
    if (e.faction === s.faction || e.status !== "active") continue;
    const dx = e.x - s.x, dy = e.y - s.y;
    const d = Math.hypot(dx, dy);
    if (d > range || d < 0.4) continue;
    const off = Math.abs(Math.atan2(Math.sin(Math.atan2(dy, dx) - ang0), Math.cos(Math.atan2(dy, dx) - ang0)));
    if (off > SPREAD) continue;
    const rangeFall = 1 - d / range;
    const coneFall = 1 - off / SPREAD;
    addSuppression(e, 0.55 * rangeFall);
    const p = 0.9 * rangeFall * (0.5 + 0.5 * coneFall); // brutal near the muzzle, on-axis
    if (Math.random() < p) {
      if (Math.random() < 0.7) killSoldier(world, e);
      else woundSoldier(world, e);
    }
  }
}

// A smoke round: lands near the aimpoint, pops a small puff on impact, and drops a
// burning canister that emits a screen which blooms over a few seconds and lasts most
// of a minute (see updateSmoke). No casualties — this is for covering an advance.
function smokeShot(world: World, s: Soldier): void {
  const cell = s.fireCell!;
  // Smoke is meant to land where you asked, so dispersion is tighter than HE.
  const tx = cell.cx + 0.5 + (Math.random() - 0.5) * 1.4;
  const ty = cell.cy + 0.5 + (Math.random() - 0.5) * 1.4;
  const cx = Math.floor(tx), cy = Math.floor(ty);

  sound.play("mortar", s.x, s.y); // tube thump at the firing position
  world.effects.push({ kind: "flash", x0: s.x, y0: s.y, x1: s.x, y1: s.y, ttl: 0.12 });
  world.effects.push({ kind: "lob", x0: s.x, y0: s.y, x1: tx, y1: ty, ttl: 0.7, maxTtl: 0.7 });
  // A small puff the instant it lands; the cloud then builds from the canister.
  world.effects.push({ kind: "smoke", x0: tx, y0: ty, x1: 0, y1: 0, ttl: 1.6, maxTtl: 1.6 });
  if (world.grid.inBounds(cx, cy)) {
    const i = world.grid.idx(cx, cy);
    world.smokeGrid[i] = Math.max(world.smokeGrid[i], SMOKE_INITIAL);
  }
  world.smokeSources.push({ cx, cy, t: 0 });
}

const CLOSE_FIRE_RANGE = 9; // cells; inside this a line stops volleying and fires at will
const GRENADE_RANGE = 6; // cells (~12 m) — throwing distance
const GRENADE_RADIUS = 1.8; // blast radius in cells
const GRENADE_COOLDOWN = 3.5; // seconds between throws per man
const GRENADE_POINT_BLANK = 3.5; // within this, lob one even at an exposed enemy
const TANK_GRENADE_RANGE = 4; // must get close to put a bundle on the deck/tracks

// Look for a nearby visible enemy and, if he's in cover (where rifle fire is wasted)
// or simply close enough, lob a grenade at him. Grenades ignore cover (that's their
// job) and crack the building they land in. A tank that has driven in among the
// infantry is the bigger threat — men will spend a grenade on its deck/tracks first.
function tryThrowGrenade(world: World, s: Soldier): void {
  if (s.grenades <= 0 || s.grenadeCD > 0) return;
  if (s.suppression > 0.6) return; // too pinned to pop up and throw

  // Tank-killing with hand grenades: only at point-blank, where a man can reach the
  // engine deck or run a bundle under the tracks. Far weaker than a Panzerfaust, but
  // it's why armor should never wade into infantry alone (CC's "tank terror").
  const veh = nearestEnemyVehicle(world, s, TANK_GRENADE_RANGE);
  if (veh) {
    s.grenades--;
    s.grenadeCD = GRENADE_COOLDOWN;
    s.firedTimer = 0.5;
    grenadeTank(world, s, veh);
    return;
  }

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
  // A grenade thrown by hand is imprecise: it scatters more the farther it's lobbed
  // and the greener the thrower, so a long toss can land wide and waste itself. The
  // aimpoint is offset randomly within a disc that grows with range.
  const dist = Math.hypot(tx - s.x, ty - s.y);
  const scatter = (0.35 + dist * 0.24) * (1.3 - 0.5 * s.training);
  const a = Math.random() * Math.PI * 2;
  const r = scatter * Math.sqrt(Math.random()); // uniform over the scatter disc
  scheduleGrenade(world, s.x, s.y, tx + Math.cos(a) * r, ty + Math.sin(a) * r, s.faction, null, dist);
}

// Loft a grenade from (sx,sy) to its landing point: show it arc, and queue the
// detonation for the instant it lands. Flight time grows with range so a long throw
// visibly hangs in the air before it bursts.
function scheduleGrenade(world: World, sx: number, sy: number, lx: number, ly: number, faction: Faction, tankId: number | null, dist: number): void {
  const flight = 0.4 + dist * 0.08;
  world.effects.push({ kind: "lob", x0: sx, y0: sy, x1: lx, y1: ly, ttl: flight, maxTtl: flight });
  world.pendingGrenades.push({ x: lx, y: ly, fuse: flight, faction, tankId });
}

// Advance every grenade in flight and detonate each as its fuse expires. Called once
// per sim step so the burst lands exactly where (and when) the thrown grenade does.
export function updateGrenades(world: World, dt: number): void {
  const g = world.pendingGrenades;
  let w = 0;
  for (let i = 0; i < g.length; i++) {
    g[i].fuse -= dt;
    if (g[i].fuse > 0) { g[w++] = g[i]; continue; }
    detonateGrenade(world, g[i]);
  }
  g.length = w;
}

const MELEE_REACH = 1.3; // cells; how close two men must be to cross steel
const MELEE_TEMPO = 0.85; // seconds between blows — a clash is a struggle, not an instant kill
const SCRUM_RADIUS2 = 4; // cells² (~2 cells) over which local numbers are counted

// Hand-to-hand. Unlike fire, melee is MUTUAL: every man in contact with an enemy — the
// charger AND the man he's hit — trades blows. The clash is decided by impetus (a unit at
// the charge hits far harder), local numbers (the side with more men in the scrum grinds
// the other down), morale and training, and the defender's cover. Routing or cowering men
// don't fight — they're cut down or run. Both cavalry (sabre) and infantry (bayonet) brawl.
export function updateMelee(world: World, dt: number): void {
  for (const s of world.soldiers) {
    if (s.status !== "active" || s.state === "routing" || s.state === "panicked") continue;
    // nearest enemy within reach — the man we're locked with
    let foe: Soldier | null = null;
    for (const e of world.soldiers) {
      if (e.faction === s.faction || e.status !== "active") continue;
      const dx = e.x - s.x, dy = e.y - s.y;
      if (dx * dx + dy * dy <= MELEE_REACH * MELEE_REACH) { foe = e; break; }
    }
    if (!foe) { s.meleeCD = 0; continue; }
    s.facing = Math.atan2(foe.y - s.y, foe.x - s.x);
    s.meleeCD -= dt;
    if (s.meleeCD > 0) continue;
    s.meleeCD = MELEE_TEMPO * (0.8 + Math.random() * 0.4);
    meleeStrike(world, s, foe);
  }
}

function meleeStrike(world: World, s: Soldier, foe: Soldier): void {
  // Local odds: who has the weight of men in the immediate press (s counts for his side).
  let friends = 1, foes = 0;
  for (const o of world.soldiers) {
    if (o.status !== "active" || o === s) continue;
    const dx = o.x - s.x, dy = o.y - s.y;
    if (dx * dx + dy * dy <= SCRUM_RADIUS2) (o.faction === s.faction ? friends++ : foes++);
  }
  const odds = friends / (friends + foes); // 0.5 = even, >0.5 = s outnumbers
  const charging = s.stance === "charge";
  const foeWavering = foe.state !== "steady";
  const fc = world.grid.inBounds(Math.floor(foe.x), Math.floor(foe.y)) ? TERRAIN[world.grid.get(Math.floor(foe.x), Math.floor(foe.y))] : null;
  const cover = fc ? fc.cover : 0;

  // Clash feedback: the ring of steel, a struck marker, a spark between the two men, dust.
  sound.play("melee", s.x, s.y);
  const mx = (s.x + foe.x) / 2, my = (s.y + foe.y) / 2;
  world.effects.push({ kind: "hit", x0: foe.x, y0: foe.y, x1: foe.x, y1: foe.y, ttl: 0.2 });
  world.effects.push({ kind: "spark", x0: mx, y0: my, x1: mx + (Math.random() - 0.5) * 1.5, y1: my + (Math.random() - 0.5) * 1.5, ttl: 0.16 });

  // Melee is terror: it hammers the morale of the man struck and shakes the men at his
  // back. Kept moderate so a losing unit still trades a few blows before it breaks rather
  // than evaporating the instant contact is made.
  const shock = charging ? 0.16 : 0.1;
  foe.morale = Math.max(0, foe.morale - shock);
  addSuppression(foe, charging ? 0.35 : 0.22);
  for (const o of world.soldiers) {
    if (o.faction !== foe.faction || o.status !== "active" || o === foe) continue;
    const dx = o.x - foe.x, dy = o.y - foe.y;
    if (dx * dx + dy * dy <= 9) { o.morale = Math.max(0, o.morale - shock * 0.4); addSuppression(o, 0.12); }
  }

  // Cut him down. Charging impetus and the weight of numbers carry the scrum; a wavering
  // man is easy meat, a steady man behind a wall or hedge is hard to get at. Numbers tilt
  // the odds but don't make it a one-sided massacre — the loser still draws blood.
  let kill = 0.08;
  if (charging) kill += 0.10;
  if (foeWavering) kill += 0.09;
  kill *= 0.65 + 0.7 * odds;
  kill *= 1 - cover * 0.4;
  kill *= 0.7 + 0.3 * s.training;
  kill = Math.max(0.015, Math.min(0.45, kill));
  if (Math.random() < kill) {
    if (Math.random() < 0.6) killSoldier(world, foe, 1.4); // a man cut down in the melee shakes his fellows hard
    else woundSoldier(world, foe);
  }
}

function detonateGrenade(world: World, g: PendingGrenade): void {
  grenadeBurst(world, g.x, g.y);
  // Anti-tank bundle: resolve against the tank it was placed on, if it's still alive.
  if (g.tankId != null) {
    const v = world.vehicle(g.tankId);
    if (v && v.status !== "ko") resolveTankGrenade(world, v);
    return;
  }
  damageBuildings(world, Math.floor(g.x), Math.floor(g.y), GRENADE_RADIUS, 0.7);
  for (const e of world.soldiers) {
    if (e.faction === g.faction || e.status !== "active") continue;
    const d = Math.hypot(e.x - g.x, e.y - g.y);
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

// A hand-grenade burst: a hard flash, a fireball, an expanding shock puff and a gout
// of smoke — an unmistakable crump right where the grenade comes down.
function grenadeBurst(world: World, x: number, y: number): void {
  sound.play("explosion", x, y);
  world.effects.push({ kind: "flash", x0: x, y0: y, x1: x, y1: y, ttl: 0.12 });
  world.effects.push({ kind: "fire", x0: x, y0: y, x1: x, y1: y, ttl: 0.4 });
  world.effects.push({ kind: "fire", x0: x + (Math.random() - 0.5) * 0.5, y0: y + (Math.random() - 0.5) * 0.5, x1: x, y1: y, ttl: 0.26 });
  world.effects.push({ kind: "hit", x0: x, y0: y, x1: x, y1: y, ttl: 0.32 });
  world.effects.push({ kind: "smoke", x0: x, y0: y, x1: 0, y1: 0, ttl: 1.1, maxTtl: 1.1 });
}

// Nearest live enemy tank within `range` cells and in line of sight — the candidate
// for a close-in grenade attack.
function nearestEnemyVehicle(world: World, s: Soldier, range: number): Vehicle | null {
  let best: Vehicle | null = null;
  let bestD = range;
  for (const v of world.vehicles) {
    if (v.faction === s.faction || v.status === "ko") continue;
    const d = Math.hypot(v.x - s.x, v.y - s.y);
    if (d > bestD) continue;
    if (!hasLOS(world.grid, Math.floor(s.x), Math.floor(s.y), Math.floor(v.x), Math.floor(v.y), world.smokeGrid)) continue;
    best = v;
    bestD = d;
  }
  return best;
}

// A grenade bundle aimed at a tank: lofted onto the deck/tracks at point-blank, so it
// barely scatters. It arcs across and detonates on the hull (see resolveTankGrenade).
function grenadeTank(world: World, s: Soldier, v: Vehicle): void {
  const dist = Math.hypot(v.x - s.x, v.y - s.y);
  scheduleGrenade(world, s.x, s.y, v.x, v.y, s.faction, v.id, dist);
}

// The bundle going off on a tank: it lands on the deck or under the tracks, so most of
// the time it breaks a track (immobilize) or shakes the crew; now and then it cooks
// off something vital and knocks the tank out. Deliberately far weaker than rocket AT.
function resolveTankGrenade(world: World, v: Vehicle): void {
  const r = Math.random();
  if (r < 0.08) {
    knockOut(world, v);
  } else if (r < 0.33) {
    v.immobilized = true;
    v.path = null;
    v.suppression = Math.min(1, v.suppression + 0.4);
  } else if (r < 0.5) {
    v.crew = Math.max(0, v.crew - 1);
    v.suppression = Math.min(1, v.suppression + 0.4);
    if (v.crew <= 0) knockOut(world, v);
  } else {
    v.suppression = Math.min(1, v.suppression + 0.5);
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

  // Muzzle flash + a tracer or black-powder shot streak so the firing line is legible.
  sound.play(s.weapon as SfxId, s.x, s.y);
  world.effects.push({ kind: "flash", x0: s.x, y0: s.y, x1: s.x, y1: s.y, ttl: 0.07 });
  emitShot(world, s, target.x, target.y);
  // Black-powder arms belch a thick cloud of white smoke with every shot — a firing line
  // quickly fogs itself in. Pushed slightly toward the target (out of the muzzle).
  if (s.weapon === "riflemusket" || s.weapon === "carbine") {
    const a = Math.atan2(target.y - s.y, target.x - s.x);
    world.effects.push({ kind: "smoke", x0: s.x + Math.cos(a) * 0.6, y0: s.y + Math.sin(a) * 0.6, x1: 0, y1: 0, ttl: 0.9 + Math.random() * 0.5, maxTtl: 1.4 });
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

// The launch and flight of a bazooka/Panzerfaust rocket: a hard muzzle flash, a
// back-blast plume behind the firer, a thick bright rocket streak downrange, and a
// stuttering smoke trail along its path — so every shot is an unmistakable event.
// The impact itself is shown by resolveArmorHit (on a strike) or bazookaMiss (a miss).
function bazookaLaunch(world: World, sx: number, sy: number, tx: number, ty: number): void {
  const ang = Math.atan2(ty - sy, tx - sx);
  // Back-blast: a plume of smoke kicked out behind the launcher.
  const bx = sx - Math.cos(ang) * 1.3;
  const by = sy - Math.sin(ang) * 1.3;
  world.effects.push({ kind: "flash", x0: sx, y0: sy, x1: sx, y1: sy, ttl: 0.16 });
  world.effects.push({ kind: "smoke", x0: bx, y0: by, x1: 0, y1: 0, ttl: 1.2, maxTtl: 1.2 });
  // Bright rocket streak in flight.
  world.effects.push({ kind: "ap", x0: sx, y0: sy, x1: tx, y1: ty, ttl: 0.2 });
  // Smoke trail puffs along the flight path — the rocket's signature.
  const segs = 5;
  for (let i = 1; i <= segs; i++) {
    const t = i / (segs + 1);
    const px = sx + (tx - sx) * t;
    const py = sy + (ty - sy) * t;
    world.effects.push({ kind: "smoke", x0: px, y0: py, x1: 0, y1: 0, ttl: 0.45 + t * 0.4, maxTtl: 0.9 });
  }
}

// A clean miss: the rocket goes wide or long and bursts on the ground short of / past
// the tank, with no armor effect — so a miss looks distinctly different from a strike.
function bazookaMiss(world: World, tx: number, ty: number): void {
  const mx = tx + (Math.random() - 0.5) * 2.6;
  const my = ty + (Math.random() - 0.5) * 2.6;
  sound.play("explosion", mx, my);
  world.effects.push({ kind: "flash", x0: mx, y0: my, x1: mx, y1: my, ttl: 0.1 });
  world.effects.push({ kind: "fire", x0: mx, y0: my, x1: mx, y1: my, ttl: 0.3 });
  world.effects.push({ kind: "hit", x0: mx, y0: my, x1: mx, y1: my, ttl: 0.3 });
  world.effects.push({ kind: "smoke", x0: mx, y0: my, x1: 0, y1: 0, ttl: 1.0, maxTtl: 1.0 });
}

// Some rounds spit off a hard surface where a tracer lands: a quick bright spark
// streak shooting away in a random direction, with the occasional audible zing. Only
// stone, brick, paving and rubble spark — a round that strikes soil, grass or a man
// just thuds in, so infantry hit in the open never throw a ricochet.
export function spawnRicochet(world: World, x: number, y: number): void {
  const cx = Math.floor(x), cy = Math.floor(y);
  if (!world.grid.inBounds(cx, cy) || !isHardSurface(world.grid.get(cx, cy))) return;
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
