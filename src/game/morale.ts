import {
  LEADER_RADIUS,
  MORALE_RECOVERY,
  MORALE_UNDERFIRE,
  SUPPRESSION_DECAY,
} from "./constants.ts";
import { MoraleState, Soldier, World } from "./world.ts";

// Updates each soldier's suppression and morale, then derives the visible state.
// This is the psychological core: sustained fire wears men down; casualties shock
// them; a nearby living leader steadies them; quiet lets them recover. The derived
// state then governs whether they advance, hold, cower, or run (see ai/movement).
export function updateMorale(world: World, dt: number): void {
  for (const s of world.soldiers) {
    // Dead/surrendered take no further part; their `state` is ignored by rendering.
    if (s.status === "dead" || s.status === "surrendered") continue;
    if (s.status === "wounded") {
      s.suppression = Math.max(0, s.suppression - SUPPRESSION_DECAY * dt);
      continue;
    }

    // Suppression bleeds off over time.
    s.suppression = Math.max(0, s.suppression - SUPPRESSION_DECAY * dt);

    const leaderNear = hasLivingLeaderNear(world, s);
    const dugIn = s.stance === "defend" || s.stance === "ambush"; // holding cover steadies men
    // Under fire, resolve erodes (faster the heavier the fire, slower for veterans,
    // men beside their leader, and men holding a prepared position).
    if (s.suppression > 0.05) {
      // Training's effect on erosion was too flat to read as "green vs veteran" (a
      // recruit at 0.3 training and an elite at 0.9 eroded at nearly the same rate) —
      // widened so a veteran squad visibly shrugs off fire a green one would break under.
      const erode =
        MORALE_UNDERFIRE * s.suppression * (1.3 - s.training * 0.85) * (leaderNear ? 0.7 : 1) * (dugIn ? 0.8 : 1);
      s.morale = Math.max(0, s.morale - erode * dt);
    } else {
      // Quiet: recover toward a veterancy-based ceiling.
      const ceiling = 0.6 + s.training * 0.35;
      const rate = MORALE_RECOVERY * (leaderNear ? 1.7 : 1) * (dugIn ? 1.25 : 1) * (0.6 + s.training * 0.4);
      if (s.morale < ceiling) s.morale = Math.min(ceiling, s.morale + rate * dt);
    }

    s.state = deriveState(s);

    // A broken man who is cut off, with the enemy closing in, throws up his hands rather
    // than die where he stands — CC's surrender, the reward for isolating and overwhelming
    // a position instead of trading shots to the last man.
    if (s.state === "routing" || s.state === "panicked") maybeSurrender(world, s, dt);
  }
}

// Surrender check for an already-broken soldier. He gives up only when his resolve is
// gone, he's under fire, he has almost no comrades left beside him, and an enemy is
// right on top of him. A small per-step hazard makes it happen over a second or two
// rather than instantly, so a position caves man-by-man as it's overrun.
function maybeSurrender(world: World, s: Soldier, dt: number): void {
  if (s.morale > 0.12 || s.suppression < 0.3) return;
  let friends = 0;
  let nearestEnemy2 = Infinity;
  for (const o of world.soldiers) {
    if (o.status !== "active" || o === s) continue;
    const d2 = (o.x - s.x) ** 2 + (o.y - s.y) ** 2;
    if (o.faction === s.faction) { if (d2 < 36) friends++; } // a comrade within 6 cells
    else if (d2 < nearestEnemy2) nearestEnemy2 = d2;
  }
  if (friends >= 2 || nearestEnemy2 > 100) return; // not alone, or no enemy within 10 cells
  if (Math.random() < 0.5 * dt) { // ~0.5/s hazard once cornered → typically gives up within ~2s
    s.status = "surrendered";
    s.path = null;
    s.targetId = null;
    s.targetVehId = null;
  }
}

function deriveState(s: Soldier): MoraleState {
  if (s.morale < 0.2) {
    // Broken: flee if under fire, otherwise freeze and cower.
    return s.suppression > 0.35 ? "routing" : "panicked";
  }
  if (s.suppression > 0.65) return "pinned";
  if (s.morale < 0.5 || s.suppression > 0.35) return "shaken";
  return "steady";
}

function hasLivingLeaderNear(world: World, s: Soldier): boolean {
  const team = world.team(s.teamId);
  if (!team || team.leaderId < 0) return false;
  if (s.isLeader) return true; // the leader steadies himself
  const leader = world.soldier(team.leaderId);
  if (!leader || leader.status !== "active") return false;
  const dx = leader.x - s.x;
  const dy = leader.y - s.y;
  return dx * dx + dy * dy <= LEADER_RADIUS * LEADER_RADIUS;
}
