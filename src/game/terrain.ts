// Terrain is the substrate every later system (pathfinding, LOS, combat) reads from.
// Each type carries Close Combat's two key tactical values: cover (protection from
// fire) and concealment (how hard you are to spot), plus a movement cost.

export enum Terrain {
  Open,
  Road,
  Grass,
  Woods,
  Water,
  Wall, // building footprint / solid wall — blocks movement & sight
  Rubble,
  Hedge, // bocage-style cover line, passable but slow
  Floor, // building interior — strong cover, occupants fire out the windows
}

export interface TerrainDef {
  name: string;
  color: number;
  /** Movement cost multiplier; Infinity = impassable. */
  moveCost: number;
  /** 0..1 protection from incoming fire (used from Phase 2 on). */
  cover: number;
  /** 0..1 how well it hides an occupant (used from Phase 1 on). */
  concealment: number;
  /** Blocks line of sight (buildings, dense woods). */
  blocksSight: boolean;
}

export const TERRAIN: Record<Terrain, TerrainDef> = {
  [Terrain.Open]:   { name: "Open ground", color: 0x6b6a4e, moveCost: 1,        cover: 0.0,  concealment: 0.0,  blocksSight: false },
  [Terrain.Road]:   { name: "Road",        color: 0x8a8270, moveCost: 0.8,      cover: 0.0,  concealment: 0.0,  blocksSight: false },
  [Terrain.Grass]:  { name: "Grass",       color: 0x5f7141, moveCost: 1,        cover: 0.05, concealment: 0.15, blocksSight: false },
  [Terrain.Woods]:  { name: "Woods",       color: 0x33502f, moveCost: 2,        cover: 0.35, concealment: 0.6,  blocksSight: true  },
  [Terrain.Water]:  { name: "Water",       color: 0x2f4b63, moveCost: Infinity, cover: 0.0,  concealment: 0.0,  blocksSight: false },
  [Terrain.Wall]:   { name: "Building",    color: 0x4a4036, moveCost: Infinity, cover: 0.8,  concealment: 0.8,  blocksSight: true  },
  [Terrain.Rubble]: { name: "Rubble",      color: 0x57514a, moveCost: 1.6,      cover: 0.45, concealment: 0.4,  blocksSight: false },
  [Terrain.Hedge]:  { name: "Hedge",       color: 0x445a30, moveCost: 1.8,      cover: 0.5,  concealment: 0.55, blocksSight: true  },
  [Terrain.Floor]:  { name: "Building",    color: 0x6a5d4a, moveCost: 1,        cover: 0.6,  concealment: 0.5,  blocksSight: false },
};

export function isPassable(t: Terrain): boolean {
  return TERRAIN[t].moveCost !== Infinity;
}

// Vehicles can't enter woods, water, or buildings; they crush hedges (slowly) and
// race down roads. Used for vehicle pathfinding.
export function vehiclePassable(t: Terrain): boolean {
  return t !== Terrain.Woods && t !== Terrain.Water && t !== Terrain.Wall && t !== Terrain.Floor;
}

export function vehicleCost(t: Terrain): number {
  switch (t) {
    case Terrain.Road:
      return 0.6;
    case Terrain.Rubble:
      return 2.4;
    case Terrain.Hedge:
      return 3;
    default:
      return 1;
  }
}
