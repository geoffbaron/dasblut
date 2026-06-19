// WW2 infantry weapons. Ranges are in cells (1 cell ≈ 2 m). Values are tuned for
// the map's scale and for Close Combat's feel: fire mostly *suppresses*; kills are
// the exception, not the rule. rof = rounds/sec of effective aimed fire.

export type WeaponId = "rifle" | "smg" | "lmg" | "bazooka" | "panzerfaust" | "mortar";

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
}

export const WEAPONS: Record<WeaponId, Weapon> = {
  rifle: { id: "rifle", name: "Rifle", rangeCells: 36, rof: 0.8, accuracy: 0.5, suppression: 0.09, lethality: 0.6, ammo: 80, tracerRate: 0.5 },
  smg:   { id: "smg",   name: "SMG",   rangeCells: 14, rof: 7,   accuracy: 0.2, suppression: 0.05, lethality: 0.45, ammo: 240, tracerRate: 0.25 },
  lmg:   { id: "lmg",   name: "LMG",   rangeCells: 42, rof: 9,   accuracy: 0.17, suppression: 0.08, lethality: 0.5, ammo: 400, tracerRate: 0.3 },
  // Anti-tank: short range, slow reload, few rounds, but deadly to armor — and far
  // more so against the flanks and rear than the frontal plate.
  bazooka:     { id: "bazooka",     name: "Bazooka",     rangeCells: 13, rof: 0.25, accuracy: 0.5, suppression: 0.04, lethality: 0.5, ammo: 6, tracerRate: 1, penetration: 90 },
  panzerfaust: { id: "panzerfaust", name: "Panzerfaust", rangeCells: 8,  rof: 0.2,  accuracy: 0.55, suppression: 0.04, lethality: 0.5, ammo: 3, tracerRate: 1, penetration: 115 },
  // Light mortar: indirect HE. Lobs over walls and hedges onto a designated patch,
  // heavy on suppression with a real casualty radius. Slow, finite bombs, and blind
  // up close — it needs the player to call the shot.
  mortar:      { id: "mortar",      name: "Mortar",      rangeCells: 70, rof: 0.5,  accuracy: 0.5, suppression: 0.5, lethality: 0.6, ammo: 20, tracerRate: 0, indirect: true, minRangeCells: 8, blastCells: 3 },
};

export function isAntiTank(id: WeaponId): boolean {
  return WEAPONS[id].penetration != null;
}
