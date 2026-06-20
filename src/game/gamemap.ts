import { Grid } from "./grid.ts";
import { VehicleClass } from "./vehicleDefs.ts";

// A battlefield, however it was produced — the hand-authored test map or one
// generated from OpenStreetMap. The grid drives the simulation; `features` and the
// spawns drive rendering and force placement.

export interface Pt {
  x: number;
  y: number;
}

export interface Building {
  poly: Pt[]; // footprint corners in cell coordinates
  levels: number;
}

export interface HedgeSeg {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface MapFeatures {
  buildings: Building[];
  hedges: HedgeSeg[];
}

export interface SquadSpawn {
  name: string;
  cx: number;
  cy: number;
  count: number;
  kind?: "rifle" | "mg" | "at" | "mortar";
}

export interface VehicleSpawn {
  cls: VehicleClass;
  cx: number;
  cy: number;
  facing: number;
}

export interface Spawns {
  us: SquadSpawn[];
  axis: SquadSpawn[];
  usVehicles: VehicleSpawn[];
  axisVehicles: VehicleSpawn[];
}

// The victory location the attacker must capture and hold.
export interface Objective {
  cx: number;
  cy: number;
  radius: number;
}

export interface GameMap {
  name: string;
  grid: Grid;
  features: MapFeatures;
  spawns: Spawns;
  // Candidate victory locations (1-3). The chosen count selects how many are used.
  objectives: Objective[];
}

/** Axis-aligned rectangle footprint as a 4-corner polygon (cell coords). */
export function rectPoly(x0: number, y0: number, x1: number, y1: number): Pt[] {
  return [
    { x: x0, y: y0 },
    { x: x1 + 1, y: y0 },
    { x: x1 + 1, y: y1 + 1 },
    { x: x0, y: y1 + 1 },
  ];
}
