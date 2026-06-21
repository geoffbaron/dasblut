import { OBJECTIVE_RADIUS } from "./constants.ts";
import { GameMap, MapFeatures, rectPoly, Spawns } from "./gamemap.ts";
import { Grid } from "./grid.ts";
import { carveBuilding, rectCells } from "./interiors.ts";
import { Terrain } from "./terrain.ts";

// A hand-authored Normandy-ish hamlet: a road through fields, a cluster of
// buildings, bocage hedgerows, a wood line, and a stream. The reliable, tuned
// battlefield used for development and as a fallback for the map generator.
export function buildTestMap(): GameMap {
  const g = new Grid(56, 42, Terrain.Grass);
  const features: MapFeatures = { buildings: [], hedges: [] };

  const addBuilding = (x0: number, y0: number, x1: number, y1: number, levels = 1) => {
    g.building(x0, y0, x1, y1); // walls for collision
    g.fillRect(x0 + 1, y0 + 1, x1 - 1, y1 - 1, Terrain.Floor); // cover-bearing interior
    carveBuilding(g, x0, y0, x1, y1); // rooms, doorways, windows
    features.buildings.push({ poly: rectPoly(x0, y0, x1, y1), levels, cells: rectCells(g, x0, y0, x1, y1) });
  };
  const addHedge = (x0: number, y0: number, x1: number, y1: number) => {
    if (y0 === y1) g.hLine(Math.min(x0, x1), Math.max(x0, x1), y0, Terrain.Hedge);
    else g.vLine(x0, Math.min(y0, y1), Math.max(y0, y1), Terrain.Hedge);
    features.hedges.push({ x0, y0, x1, y1 });
  };

  g.fillRect(0, 0, 55, 5, Terrain.Open);
  g.fillRect(0, 36, 55, 41, Terrain.Open);

  g.vLine(46, 0, 18, Terrain.Water);
  g.vLine(46, 22, 41, Terrain.Water);
  g.vLine(47, 0, 18, Terrain.Water);
  g.vLine(47, 22, 41, Terrain.Water);

  g.fillRect(0, 24, 55, 25, Terrain.Road);
  g.vLine(20, 8, 24, Terrain.Road);
  g.vLine(21, 8, 24, Terrain.Road);

  addBuilding(14, 9, 19, 14, 2);
  addBuilding(22, 10, 27, 15, 1);
  addBuilding(15, 17, 20, 21, 1);
  addBuilding(24, 18, 30, 23, 2);

  addHedge(2, 30, 18, 30);
  addHedge(24, 30, 44, 30);
  addHedge(10, 30, 10, 35);
  addHedge(34, 25, 34, 35);
  g.set(10, 33, Terrain.Grass);

  g.fillRect(2, 6, 11, 12, Terrain.Woods);
  g.fillRect(38, 32, 45, 40, Terrain.Woods);
  g.fillRect(50, 26, 55, 33, Terrain.Woods);

  g.fillRect(31, 12, 34, 15, Terrain.Rubble);

  const spawns: Spawns = {
    us: [
      { name: "1st Squad", cx: 18, cy: 37, count: 8, kind: "rifle" },
      { name: "2nd Squad", cx: 22, cy: 38, count: 8, kind: "rifle" },
      { name: "LMG Team", cx: 30, cy: 38, count: 6, kind: "mg" },
      { name: "AT Team", cx: 26, cy: 37, count: 5, kind: "at" },
      { name: "Mortar Team", cx: 20, cy: 41, count: 5, kind: "mortar" },
    ],
    // Axis deploy well back (rows 6-8, north of the buildings) so they're not sitting
    // on top of the objective — the US has room to advance before contact.
    axis: [
      { name: "Garrison", cx: 18, cy: 7, count: 6, kind: "rifle" },
      { name: "MG Team", cx: 24, cy: 6, count: 6, kind: "mg" },
      { name: "Outpost", cx: 30, cy: 7, count: 6, kind: "rifle" },
    ],
    usVehicles: [{ cls: "sherman", cx: 30, cy: 37, facing: -Math.PI / 2 }],
    axisVehicles: [{ cls: "panzer4", cx: 38, cy: 8, facing: Math.PI / 2 }],
  };

  // Candidate objectives (the chosen count uses the first N). The crossroads at the
  // heart of the hamlet is the primary; a west and an east flag spread the fight out.
  const objectives = [
    { cx: 22, cy: 17, radius: OBJECTIVE_RADIUS }, // center crossroads
    { cx: 9, cy: 15, radius: OBJECTIVE_RADIUS },  // west
    { cx: 38, cy: 19, radius: OBJECTIVE_RADIUS }, // east
  ];

  return { name: "Carentan Approach (test map)", grid: g, features, spawns, objectives };
}
