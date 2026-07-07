import { CASUALTY_SHOCK, SHOCK_RADIUS } from "./constants.ts";
import { Soldier, World } from "./world.ts";
import { WEAPONS } from "./weapons.ts";
import { sound } from "../render/sound.ts";

// Shared casualty/suppression helpers, used by both infantry fire and vehicle HE/MG
// so the morale-shock rules stay in one place.

export function addSuppression(s: Soldier, amt: number): void {
  s.suppression = Math.min(1, s.suppression + amt);
}

// "gun"/"melee" leave the body whole (a normal blood pool); "blast" (HE, canister,
// catapult stone, grenade) is violent enough to warrant the wider splatter + gib decal.
export type DeathCause = "gun" | "blast" | "melee";

// A Hero shrugs off what would otherwise be a killing/wounding hit — a glancing blow a
// line soldier wouldn't survive, consuming one of his extra lives instead. Once those
// run out he's exactly as mortal as anyone else. Centralized here (rather than at each
// of fireShot/mortarShot/canisterBlast/meleeStrike/grenadeBurst/etc.) so every damage
// source gets it automatically.
function shrugsOffHit(world: World, t: Soldier): boolean {
  if (!t.heroHP || t.heroHP <= 0) return false;
  t.heroHP--;
  addSuppression(t, 0.35);
  t.morale = Math.max(0, t.morale - 0.1);
  world.effects.push({ kind: "hit", x0: t.x, y0: t.y, x1: t.x, y1: t.y, ttl: 0.2 });
  return true;
}

export function killSoldier(world: World, t: Soldier, shockMul = 1, cause: DeathCause = "gun"): void {
  if (t.status === "dead") return;
  if (shrugsOffHit(world, t)) return;
  t.status = "dead";
  t.path = null;
  t.targetId = null;
  t.targetVehId = null;
  world.effects.push({ kind: "hit", x0: t.x, y0: t.y, x1: t.x, y1: t.y, ttl: 0.3 });
  // A burst of blood flying off the body at the moment of death, plus the permanent
  // pool (and, for a violent blast death, scattered gib) it leaves on the ground.
  const violent = cause === "blast";
  for (let i = 0; i < (violent ? 7 : 3); i++) {
    const a = Math.random() * Math.PI * 2, r = (violent ? 1.4 : 0.7) * Math.random();
    world.effects.push({ kind: "blood", x0: t.x, y0: t.y, x1: t.x + Math.cos(a) * r, y1: t.y + Math.sin(a) * r, ttl: 0.22 + Math.random() * 0.15 });
  }
  world.addBloodDecal(t.x, t.y, violent);
  world.logEvent(t.faction, "kill", `${WEAPONS[t.weapon].name} killed`);
  // A man screaming as he falls — Germans and Americans sound distinct. Routed
  // through the priority audio budget so it's never drowned out by gunfire.
  sound.play(t.faction === "axis" ? "soldier_scream" : "soldier_scream_us", t.x, t.y, true);
  casualtyShock(world, t, CASUALTY_SHOCK * shockMul);
}

export function woundSoldier(world: World, t: Soldier): void {
  if (t.status !== "active") return;
  if (shrugsOffHit(world, t)) return;
  t.status = "wounded";
  t.path = null;
  t.targetId = null;
  t.targetVehId = null;
  world.effects.push({ kind: "hit", x0: t.x, y0: t.y, x1: t.x, y1: t.y, ttl: 0.25 });
  for (let i = 0; i < 2; i++) {
    const a = Math.random() * Math.PI * 2, r = 0.5 * Math.random();
    world.effects.push({ kind: "blood", x0: t.x, y0: t.y, x1: t.x + Math.cos(a) * r, y1: t.y + Math.sin(a) * r, ttl: 0.18 + Math.random() * 0.1 });
  }
  world.addBloodDecal(t.x, t.y, false); // a smaller pool — he's down bleeding, not blown apart
  sound.play("soldier_hit", t.x, t.y, true); // a cry of pain, also priority
  casualtyShock(world, t, CASUALTY_SHOCK * 0.6);
}

// A man falling shakes everyone who sees it — more so close by, and the squad
// leader's loss is felt hardest.
export function casualtyShock(world: World, fallen: Soldier, base: number): void {
  const leaderHit = fallen.isLeader ? 1.8 : 1;
  for (const o of world.soldiers) {
    if (o.faction !== fallen.faction || o.status !== "active") continue;
    const dx = o.x - fallen.x;
    const dy = o.y - fallen.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > SHOCK_RADIUS * SHOCK_RADIUS) continue;
    const prox = 1 - Math.sqrt(d2) / SHOCK_RADIUS;
    const sameSquad = o.teamId === fallen.teamId ? 1.4 : 1;
    o.morale = Math.max(0, o.morale - base * prox * leaderHit * sameSquad * (1.1 - o.training * 0.4));
  }
}
