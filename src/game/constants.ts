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
export const SPOT_HYSTERESIS = 1.6; // seconds a spotted unit stays spotted after LOS breaks
export const VIS_INTERVAL = 0.2; // seconds between visibility/spotting recomputes

// --- Morale & suppression (Phase 2) ---
export const SUPPRESSION_DECAY = 0.22; // per second
export const MORALE_RECOVERY = 0.055; // per second when safe
export const MORALE_UNDERFIRE = 0.15; // morale loss rate, scaled by suppression
export const CASUALTY_SHOCK = 0.25; // morale hit when a nearby comrade falls
export const LEADER_RADIUS = 8; // cells; leader steadies men within this
export const SHOCK_RADIUS = 6; // cells; how far a casualty's shock spreads

// --- Orders / stances (Phase 3) ---
export const STANCE_SPEED = { move: 1, fast: 1.6, sneak: 0.5, defend: 0, ambush: 0 } as const;
export const AMBUSH_RANGE = 9; // cells; ambushers hold fire until an enemy is this close
export const AMBUSH_BONUS_TIME = 3; // seconds the first-volley bonus lasts
export const AMBUSH_ACC_MULT = 1.7; // accuracy/suppression multiplier on the opening burst
export const AREA_FIRE_RADIUS = 1.8; // cells; suppression splash of area (suppressing) fire

// --- Generated battlefield size (Phase 5) ---
export const BATTLEFIELD_W_M = 380;
export const BATTLEFIELD_H_M = 300;

// --- Objective: capture & hold (Phase 6) ---
// --- Mortar smoke screens ---
export const SMOKE_DEPOSIT = 1.6;   // density a smoke round stamps at its center cell
export const SMOKE_RADIUS = 4;      // cells; how wide a smoke round blooms
export const SMOKE_DECAY = 0.085;   // density lost per second (a screen lasts ~18s)
export const SMOKE_LOS_BLOCK = 0.5; // density at/above which a cell blocks line of sight
export const SMOKE_RELOAD = 2.2;    // seconds between smoke rounds (faster than HE)

export const OBJECTIVE_RADIUS = 7; // cells; the capture zone
export const OBJECTIVE_CAPTURE_TIME = 6; // seconds of uncontested presence to flip it
export const OBJECTIVE_HOLD_TO_WIN = 35; // seconds the attacker must hold it to win
export const BATTLE_TIME_S = 360; // the attacker must take the objective before this expires
export const AI_INTERVAL = 1.5; // seconds between enemy command re-evaluations

