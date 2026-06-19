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
      const erode =
        MORALE_UNDERFIRE * s.suppression * (1.1 - s.training * 0.4) * (leaderNear ? 0.7 : 1) * (dugIn ? 0.8 : 1);
      s.morale = Math.max(0, s.morale - erode * dt);
    } else {
      // Quiet: recover toward a veterancy-based ceiling.
      const ceiling = 0.6 + s.training * 0.35;
      const rate = MORALE_RECOVERY * (leaderNear ? 1.7 : 1) * (dugIn ? 1.25 : 1) * (0.6 + s.training * 0.4);
      if (s.morale < ceiling) s.morale = Math.min(ceiling, s.morale + rate * dt);
    }

    s.state = deriveState(s);
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
