// Core tunables for the Phase 0 slice. Real-world scale: 1 cell ≈ 2 meters.
export const CELL_SIZE = 22; // pixels per cell on screen
export const METERS_PER_CELL = 2;

// Fixed-timestep simulation. Render interpolates between steps.
export const SIM_HZ = 30;
export const SIM_DT = 1 / SIM_HZ; // seconds per simulation step
export const MAX_FRAME_DT = 0.25; // clamp to avoid spiral-of-death after a stall

// Base infantry move speed in cells/second at "Move" pace on open ground.
// Terrain moveCost divides this; e.g. woods (cost 2) → half speed.
export const BASE_MOVE_SPEED = 2.2;

export const SPEED_STEPS = [1, 2, 4] as const;

// --- Line of sight / spotting (Phase 1) ---
export const VISION_CELLS = 17; // how far a soldier can see clear ground
export const SPOT_BASE = 16; // base spotting range vs an exposed target
// Civil War: open-field daylight battles, massed upright formations — you see the enemy
// lines across the field, so both the shroud and spotting reach much further than WW2.
export const ACW_VISION_CELLS = 28;
export const ACW_SPOT_BASE = 34;
export const SPOT_HYSTERESIS = 1.6; // seconds a spotted unit stays spotted after LOS breaks
export const VIS_INTERVAL = 0.2; // seconds between visibility/spotting recomputes

// --- Morale & suppression (Phase 2) ---
export const SUPPRESSION_DECAY = 0.22; // per second
export const MORALE_RECOVERY = 0.055; // per second when safe
export const MORALE_UNDERFIRE = 0.15; // morale loss rate, scaled by suppression
export const CASUALTY_SHOCK = 0.25; // morale hit when a nearby comrade falls
export const LEADER_RADIUS = 8; // cells; leader steadies men within this
export const SHOCK_RADIUS = 6; // cells; how far a casualty's shock spreads

// --- Squad cohesion: a squad should move and arrive as one body, and any man left
// behind should hurry back to the group instead of stranding himself. ---
export const COHESION_NEAR = 2.2;  // cells from the squad's center before catch-up kicks in
export const COHESION_GAIN = 0.45; // extra speed fraction per cell of lag beyond NEAR
export const COHESION_MAX = 1.85;  // cap on the lagging-man catch-up multiplier
export const COHESION_LEAD = 0.7;  // a man out front of the squad eases to this pace so they close up
export const REGROUP_DIST = 4.5;   // an idle man this far from the squad re-paths to rejoin

// --- Orders / stances (Phase 3) ---
export const STANCE_SPEED = { move: 1, fast: 1.6, sneak: 0.5, defend: 0, ambush: 0, charge: 2.0 } as const;
export const AMBUSH_RANGE = 9; // cells; ambushers hold fire until an enemy is this close
export const AMBUSH_BONUS_TIME = 3; // seconds the first-volley bonus lasts
export const AMBUSH_ACC_MULT = 1.7; // accuracy/suppression multiplier on the opening burst
export const AREA_FIRE_RADIUS = 1.8; // cells; suppression splash of area (suppressing) fire

// --- Machine guns: a belt-fed LMG must be set up on its bipod before it can fire, and
// it loses that setup the instant it picks up to move. It also fires within a limited
// arc — swing it onto a target outside that cone and it has to re-lay, which costs time.
// This is why CC machine guns anchor a position but are beaten by flanking.
export const MG_SETUP_TIME = 2.5;   // seconds stationary before an MG can open fire
export const MG_ARC = 0.9;          // radians either side of facing the gun can fire within (~50°)
export const MG_TRAVERSE = 1.2;     // radians/sec the gun can swing to re-lay onto a new target
// A field gun must be unlimbered and laid before it can fire, and it can't fire on the move —
// it loses that setup the instant the crew picks it up to relocate.
export const CANNON_SETUP_TIME = 3.5; // seconds stationary before a cannon can open fire

// --- Generated battlefield size (Phase 5) ---
export const BATTLEFIELD_W_M = 380;
export const BATTLEFIELD_H_M = 300;

// --- Objective: capture & hold (Phase 6) ---
// --- Mortar smoke screens ---
// A shell pops on impact, then the canister keeps emitting: the cloud blooms outward
// over a few seconds, holds thick for most of a minute, then thins as the source
// burns out and the grid decays. Tuned so a screen blocks LOS for ~60s total.
export const SMOKE_RADIUS = 4.5;    // cells; the cloud's full bloom radius
export const SMOKE_EMIT = 0.75;     // density added per second at a source's center
export const SMOKE_CAP = 1.6;       // max density a cell holds
export const SMOKE_DECAY = 0.11;    // density lost per second (sets the fade-out tail)
export const SMOKE_BUILD = 4;       // seconds for the cloud to bloom to full size
export const SMOKE_LIFE = 52;       // seconds the canister keeps emitting before burning out
export const SMOKE_LOS_BLOCK = 0.5; // density at/above which a cell blocks line of sight
export const SMOKE_INITIAL = 0.45;  // density of the puff the instant the shell lands

export const OBJECTIVE_RADIUS = 7; // cells; the capture zone
export const OBJECTIVE_CAPTURE_TIME = 6; // seconds of uncontested presence to flip it
export const OBJECTIVE_HOLD_TO_WIN = 60; // seconds the attacker must hold it to win
export const BATTLE_TIME_S = 360; // the attacker must take the objective before this expires
export const AI_INTERVAL = 1.5; // seconds between enemy command re-evaluations

