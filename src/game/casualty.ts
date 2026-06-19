import { CASUALTY_SHOCK, SHOCK_RADIUS } from "./constants.ts";
import { Soldier, World } from "./world.ts";
import { sound } from "../render/sound.ts";

// Shared casualty/suppression helpers, used by both infantry fire and vehicle HE/MG
// so the morale-shock rules stay in one place.

export function addSuppression(s: Soldier, amt: number): void {
  s.suppression = Math.min(1, s.suppression + amt);
}

export function killSoldier(world: World, t: Soldier, shockMul = 1): void {
  if (t.status === "dead") return;
  t.status = "dead";
  t.path = null;
  t.targetId = null;
  t.targetVehId = null;
  world.effects.push({ kind: "hit", x0: t.x, y0: t.y, x1: t.x, y1: t.y, ttl: 0.3 });
  // A man screaming as he falls — Germans and Americans sound distinct. Routed
  // through the priority audio budget so it's never drowned out by gunfire.
  sound.play(t.faction === "axis" ? "soldier_scream" : "soldier_scream_us", t.x, t.y, true);
  casualtyShock(world, t, CASUALTY_SHOCK * shockMul);
}

export function woundSoldier(world: World, t: Soldier): void {
  if (t.status !== "active") return;
  t.status = "wounded";
  t.path = null;
  t.targetId = null;
  t.targetVehId = null;
  world.effects.push({ kind: "hit", x0: t.x, y0: t.y, x1: t.x, y1: t.y, ttl: 0.25 });
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
