// Armored vehicle definitions. Armor and penetration are abstract units (roughly
// proportional to mm) tuned for the map's scale, not historical exactness. The point
// is the Close Combat dynamic: tanks dominate infantry, but a flank or rear shot —
// from another tank or a brave man with a Panzerfaust — kills them.

export type VehicleClass = "sherman" | "panzer4" | "atst" | "aac1";

export interface VehicleDef {
  name: string;
  faction: "us" | "axis";
  bodyColor: number;
  turretColor: number;
  hullLen: number; // cells (along facing)
  hullWid: number; // cells (across)
  hasTurret: boolean;
  /** A legged walker (AT-ST): drawn with feet instead of tracks, head instead of turret. */
  walker?: boolean;
  crew: number;
  speed: number; // cells/sec on open ground
  hullTurn: number; // rad/sec
  turretTraverse: number; // rad/sec
  armor: { front: number; side: number; rear: number; top: number };
  gun: {
    pen: number; // AP penetration at point blank
    rangeCells: number;
    reload: number; // seconds between main-gun shots
    accuracy: number; // base hit chance vs a vehicle
    heRadius: number; // cells; HE splash vs infantry
    heKill: number; // kill chance at the center of an HE burst
  };
  mg: { rangeCells: number; rof: number; suppression: number; lethality: number };
  apAmmo: number;
  heAmmo: number;
}

export const VEHICLES: Record<VehicleClass, VehicleDef> = {
  sherman: {
    name: "M4 Sherman",
    faction: "us",
    bodyColor: 0x4a5532,
    turretColor: 0x434d2d,
    hullLen: 2.7,
    hullWid: 1.5,
    hasTurret: true,
    crew: 5,
    speed: 2.4,
    hullTurn: 1.1,
    turretTraverse: 0.9,
    armor: { front: 70, side: 38, rear: 35, top: 18 },
    gun: { pen: 85, rangeCells: 40, reload: 3.6, accuracy: 0.7, heRadius: 2.2, heKill: 0.55 },
    mg: { rangeCells: 22, rof: 9, suppression: 0.08, lethality: 0.45 },
    apAmmo: 30,
    heAmmo: 40,
  },
  panzer4: {
    name: "Panzer IV",
    faction: "axis",
    bodyColor: 0x55584c,
    turretColor: 0x4c4f44,
    hullLen: 2.7,
    hullWid: 1.5,
    hasTurret: true,
    crew: 5,
    speed: 2.3,
    hullTurn: 1.05,
    turretTraverse: 0.85,
    armor: { front: 80, side: 30, rear: 30, top: 16 },
    gun: { pen: 95, rangeCells: 42, reload: 3.8, accuracy: 0.7, heRadius: 2.2, heKill: 0.55 },
    mg: { rangeCells: 22, rof: 9, suppression: 0.08, lethality: 0.45 },
    apAmmo: 28,
    heAmmo: 42,
  },

  // --- Star Wars ---
  // AT-ST: a fast, agile scout walker with a small footprint and a quick-swiveling head.
  // Murder on infantry (twin blaster cannons + grenade launcher), but lightly plated —
  // even its front gives way to a rocket, and a flank shot is a sure kill.
  atst: {
    name: "AT-ST",
    faction: "axis",
    bodyColor: 0x8b8f96,
    turretColor: 0x7d828a,
    hullLen: 1.7,
    hullWid: 1.2,
    hasTurret: true,
    walker: true,
    crew: 2,
    speed: 2.9,
    hullTurn: 1.6,
    turretTraverse: 1.3,
    armor: { front: 48, side: 32, rear: 26, top: 12 },
    gun: { pen: 62, rangeCells: 36, reload: 2.4, accuracy: 0.65, heRadius: 1.9, heKill: 0.5 },
    mg: { rangeCells: 24, rof: 11, suppression: 0.09, lethality: 0.5 },
    apAmmo: 26,
    heAmmo: 48,
  },
  // AAC-1 hovertank: the Rebels' repulsorlift gun platform. Slower-firing but heavier-
  // hitting than the walker's cannon, better plated, and quick over the ground — the
  // classic tank trade against the AT-ST's speed and anti-infantry firepower.
  aac1: {
    name: "AAC-1 Hovertank",
    faction: "us",
    bodyColor: 0x9a8a66,
    turretColor: 0x8a7a58,
    hullLen: 2.5,
    hullWid: 1.6,
    hasTurret: true,
    crew: 3,
    speed: 3.0,
    hullTurn: 1.3,
    turretTraverse: 1.0,
    armor: { front: 60, side: 40, rear: 32, top: 16 },
    gun: { pen: 80, rangeCells: 40, reload: 3.2, accuracy: 0.7, heRadius: 2.1, heKill: 0.55 },
    mg: { rangeCells: 22, rof: 9, suppression: 0.08, lethality: 0.45 },
    apAmmo: 30,
    heAmmo: 40,
  },
};

export type ArmorFace = "front" | "side" | "rear" | "top";

// Which armor face a shot coming FROM `shooter` strikes, given the hull's facing.
export function faceStruck(
  hullFacing: number,
  targetX: number,
  targetY: number,
  shooterX: number,
  shooterY: number,
): ArmorFace {
  const incoming = Math.atan2(shooterY - targetY, shooterX - targetX); // target→shooter
  let rel = incoming - hullFacing;
  while (rel > Math.PI) rel -= 2 * Math.PI;
  while (rel < -Math.PI) rel += 2 * Math.PI;
  const a = Math.abs(rel);
  if (a < Math.PI / 4) return "front";
  if (a > (3 * Math.PI) / 4) return "rear";
  return "side";
}
