import { CASUALTY_SHOCK, SHOCK_RADIUS } from "./constants.ts";
import { faceStruck, VEHICLES } from "./vehicleDefs.ts";
import { Vehicle, World } from "./world.ts";
import { sound } from "../render/sound.ts";

// Resolve a confirmed hit on a vehicle: work out which armor face was struck, roll
// penetration vs that face (with range falloff), and apply the outcome — bounce,
// crew casualty, immobilization, or a catastrophic brew-up. Flank and rear shots
// are far deadlier than the frontal plate: the heart of armored tactics.
export function resolveArmorHit(
  world: World,
  target: Vehicle,
  penetration: number,
  shooterX: number,
  shooterY: number,
  dist: number,
  range: number,
): void {
  const def = VEHICLES[target.cls];
  const face = faceStruck(target.facing, target.x, target.y, shooterX, shooterY);
  const armor = def.armor[face];
  const effPen = penetration * (1 - 0.3 * Math.min(1, dist / range));

  if (effPen * (0.8 + Math.random() * 0.4) < armor) {
    // Bounce — sparks skip off the plate and the crew is rattled, but no real harm.
    // Reads as a hard "clang, no effect" so the player learns the shot didn't bite.
    sound.play("ricochet", target.x, target.y);
    world.effects.push({ kind: "spark", x0: target.x, y0: target.y, x1: target.x, y1: target.y, ttl: 0.22 });
    for (let i = 0; i < 3; i++) {
      const a = Math.random() * Math.PI * 2, len = 0.8 + Math.random() * 1.4;
      world.effects.push({ kind: "ricochet", x0: target.x, y0: target.y, x1: target.x + Math.cos(a) * len, y1: target.y + Math.sin(a) * len, ttl: 0.16 });
    }
    target.suppression = Math.min(1, target.suppression + 0.12);
    return;
  }

  // Penetration — an unmistakable strike: a white flash, fireball, sparks and a gout
  // of smoke, so the player sees plainly that this one went through.
  sound.play("tank_hit", target.x, target.y);
  world.effects.push({ kind: "flash", x0: target.x, y0: target.y, x1: target.x, y1: target.y, ttl: 0.14 });
  world.effects.push({ kind: "fire", x0: target.x, y0: target.y, x1: target.x, y1: target.y, ttl: 0.45 });
  world.effects.push({ kind: "fire", x0: target.x, y0: target.y, x1: target.x, y1: target.y, ttl: 0.28 });
  world.effects.push({ kind: "hit", x0: target.x, y0: target.y, x1: target.x, y1: target.y, ttl: 0.3 });
  world.effects.push({ kind: "smoke", x0: target.x, y0: target.y, x1: 0, y1: 0, ttl: 1.4, maxTtl: 1.4 });
  for (let i = 0; i < 4; i++) {
    const a = Math.random() * Math.PI * 2, len = 1 + Math.random() * 1.8;
    world.effects.push({ kind: "ricochet", x0: target.x, y0: target.y, x1: target.x + Math.cos(a) * len, y1: target.y + Math.sin(a) * len, ttl: 0.18 });
  }
  const r = Math.random();
  if (r < 0.3) {
    knockOut(world, target);
  } else if (r < 0.62) {
    target.crew -= 1;
    target.suppression = Math.min(1, target.suppression + 0.45);
    if (target.crew <= 0) knockOut(world, target);
  } else if (r < 0.85) {
    target.immobilized = true;
    target.path = null;
    target.suppression = Math.min(1, target.suppression + 0.35);
  } else {
    target.suppression = Math.min(1, target.suppression + 0.6); // crew shaken, gun silenced briefly
  }
}

export function knockOut(world: World, v: Vehicle): void {
  if (v.status === "ko") return;
  v.status = "ko";
  v.path = null;
  v.crew = 0;
  v.targetVehId = null;
  v.targetInfId = null;
  v.smokeCD = 0;
  sound.play("tank_destroy", v.x, v.y);
  // Initial fireball.
  for (let i = 0; i < 3; i++)
    world.effects.push({ kind: "fire", x0: v.x, y0: v.y, x1: v.x, y1: v.y, ttl: 0.4 + i * 0.2 });
  koShock(world, v);
}

// Losing your tank is demoralizing — nearby friendly infantry feel it.
function koShock(world: World, v: Vehicle): void {
  for (const s of world.soldiers) {
    if (s.faction !== v.faction || s.status !== "active") continue;
    const d = Math.hypot(s.x - v.x, s.y - v.y);
    if (d > SHOCK_RADIUS) continue;
    s.morale = Math.max(0, s.morale - CASUALTY_SHOCK * (1 - d / SHOCK_RADIUS));
  }
}

// Hit chance for a tank main gun firing AP at another vehicle.
export function apHitChance(
  baseAccuracy: number,
  dist: number,
  range: number,
  shooterMoving: boolean,
  targetMoving: boolean,
  shooterSuppression: number,
): number {
  let p = baseAccuracy * (1 - 0.4 * Math.min(1, dist / range));
  if (targetMoving) p *= 0.7;
  if (shooterMoving) p *= 0.6;
  p *= 1 - 0.5 * shooterSuppression;
  return Math.max(0.05, Math.min(0.95, p));
}
