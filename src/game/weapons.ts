// WW2 infantry weapons. Ranges are in cells (1 cell ≈ 2 m). Values are tuned for
// the map's scale and for Close Combat's feel: fire mostly *suppresses*; kills are
// the exception, not the rule. rof = rounds/sec of effective aimed fire.

export type WeaponId =
  | "rifle" | "smg" | "lmg" | "bazooka" | "panzerfaust" | "mortar" // WW2
  | "riflemusket" | "carbine" | "cannon"; // American Civil War

export interface Weapon {
  id: WeaponId;
  name: string;
  rangeCells: number;
  rof: number;
  /** Base hit chance vs an exposed, standing target at close range. */
  accuracy: number;
  /** Suppression added to the target per shot fired at it (hit or miss). */
  suppression: number;
  /** Chance a clean hit incapacitates (split between kill / wound). */
  lethality: number;
  ammo: number;
  /** Fraction of shots that leave a visible tracer. */
  tracerRate: number;
  /** Anti-tank penetration (abstract units). Present → can hurt armor. */
  penetration?: number;
  /** Indirect fire (mortar): lobs HE onto a target cell with no line-of-sight needed. */
  indirect?: boolean;
  /** Minimum range in cells — indirect weapons can't drop rounds right on top of themselves. */
  minRangeCells?: number;
  /** Blast radius in cells for area weapons (mortar HE). */
  blastCells?: number;
  /** Direct-fire artillery (a cannon): needs line of sight, lobs a shell that bursts at the
   *  aimpoint. Inside `canisterCells` it switches to canister — a wider, deadlier anti-personnel cone. */
  artillery?: boolean;
  /** Range at/under which a cannon fires canister instead of shell. */
  canisterCells?: number;
}

export const WEAPONS: Record<WeaponId, Weapon> = {
  rifle: { id: "rifle", name: "Rifle", rangeCells: 36, rof: 0.8, accuracy: 0.21, suppression: 0.09, lethality: 0.6, ammo: 80, tracerRate: 0.85 },
  smg:   { id: "smg",   name: "SMG",   rangeCells: 14, rof: 7,   accuracy: 0.085, suppression: 0.05, lethality: 0.45, ammo: 240, tracerRate: 0.5 },
  lmg:   { id: "lmg",   name: "LMG",   rangeCells: 42, rof: 9,   accuracy: 0.072, suppression: 0.08, lethality: 0.5, ammo: 400, tracerRate: 0.65 },
  // Anti-tank: short range, slow reload, few rounds, but deadly to armor — and far
  // more so against the flanks and rear than the frontal plate.
  bazooka:     { id: "bazooka",     name: "Bazooka",     rangeCells: 18, rof: 0.13, accuracy: 0.42, suppression: 0.04, lethality: 0.5, ammo: 6, tracerRate: 1, penetration: 90 },
  panzerfaust: { id: "panzerfaust", name: "Panzerfaust", rangeCells: 11, rof: 0.13, accuracy: 0.46, suppression: 0.04, lethality: 0.5, ammo: 3, tracerRate: 1, penetration: 115 },
  // Light mortar: indirect HE. Lobs over walls and hedges onto a designated patch,
  // heavy on suppression with a real casualty radius. Slow, finite bombs, and blind
  // up close — it needs the player to call the shot.
  mortar:      { id: "mortar",      name: "Mortar",      rangeCells: 70, rof: 0.25, accuracy: 0.5, suppression: 0.5, lethality: 0.6, ammo: 20, tracerRate: 0, indirect: true, minRangeCells: 8, blastCells: 3 },

  // --- American Civil War ---
  // Rifled musket (Springfield/Enfield): the war's main arm. A muzzleloader — deadly and
  // long-ranged for its day, but agonizingly slow to reload (~3 rounds/min), so a firing
  // line lives and dies by its volume of fire and its nerve. No tracers (black powder).
  // Muzzle-loader: a trained man got off only ~2-3 rounds a minute, so each volley is
  // precious and the bayonet/charge decides what fire can't. rof ~1/14s.
  riflemusket: { id: "riflemusket", name: "Rifle Musket", rangeCells: 32, rof: 0.071, accuracy: 0.34, suppression: 0.07, lethality: 0.72, ammo: 40, tracerRate: 0 },
  // Cavalry carbine (Sharps): breech-loaded, so it reloads far faster than the infantry
  // musket (~10 rounds/min). Carried by mounted troops who skirmish, scout, and charge home.
  carbine:     { id: "carbine",     name: "Carbine",     rangeCells: 20, rof: 0.167, accuracy: 0.28, suppression: 0.05, lethality: 0.55, ammo: 50, tracerRate: 0 },
  // Field gun (12-pdr Napoleon): direct line-of-sight artillery, slow to serve (~1 aimed
  // round / 16s). At range it throws a shell that bursts in the enemy ranks; inside canister
  // range the muzzle vomits a giant shotgun blast that scythes down massed infantry.
  cannon:      { id: "cannon",      name: "Field Gun",   rangeCells: 58, rof: 0.0625, accuracy: 0.6, suppression: 0.45, lethality: 0.7, ammo: 60, tracerRate: 0, artillery: true, blastCells: 3, canisterCells: 24 },
};

export function isAntiTank(id: WeaponId): boolean {
  return WEAPONS[id].penetration != null;
}
