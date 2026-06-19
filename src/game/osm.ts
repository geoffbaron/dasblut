import { BATTLEFIELD_H_M, BATTLEFIELD_W_M, METERS_PER_CELL, OBJECTIVE_RADIUS } from "./constants.ts";
import { GameMap, MapFeatures, Objective, Pt, Spawns, SquadSpawn, VehicleSpawn } from "./gamemap.ts";
import { Grid } from "./grid.ts";
import { isPassable, Terrain, vehiclePassable } from "./terrain.ts";

// Turns a real-world location into a playable battlefield: fetch OpenStreetMap
// features around a point via the Overpass API, project lat/lon to a local metric
// grid, and rasterize buildings, roads, woods, water, and hedges into terrain. The
// result is a GameMap the rest of the engine consumes exactly like the test map.

const OVERPASS = "https://overpass-api.de/api/interpreter";

interface LatLon {
  lat: number;
  lon: number;
}
interface OsmWay {
  type: string;
  tags?: Record<string, string>;
  geometry?: LatLon[];
}

export async function generateMap(centerLat: number, centerLon: number, label: string): Promise<GameMap> {
  const mLat = 111320;
  const mLon = 111320 * Math.cos((centerLat * Math.PI) / 180);
  const halfLat = BATTLEFIELD_H_M / 2 / mLat;
  const halfLon = BATTLEFIELD_W_M / 2 / mLon;
  const south = centerLat - halfLat;
  const north = centerLat + halfLat;
  const west = centerLon - halfLon;
  const east = centerLon + halfLon;

  const ways = await fetchOverpass(south, west, north, east);

  const width = Math.round(BATTLEFIELD_W_M / METERS_PER_CELL);
  const height = Math.round(BATTLEFIELD_H_M / METERS_PER_CELL);
  const grid = new Grid(width, height, Terrain.Grass);
  const features: MapFeatures = { buildings: [], hedges: [] };

  const project = (p: LatLon): Pt => ({
    x: ((p.lon - west) * mLon) / METERS_PER_CELL,
    y: ((north - p.lat) * mLat) / METERS_PER_CELL,
  });

  // Bucket features so we can paint them back-to-front (ground → roads → structures).
  const areas: { poly: Pt[]; t: Terrain }[] = [];
  const roads: { line: Pt[]; w: number }[] = [];
  const buildings: Pt[][] = [];
  const hedges: Pt[][] = [];

  for (const way of ways) {
    if (!way.geometry || way.geometry.length < 2) continue;
    const tags = way.tags ?? {};
    let poly = way.geometry.map(project);

    // OSM ways close the ring (last node == first node). Strip the duplicate so
    // downstream code sees a clean open polygon (rasterizer handles it either way,
    // but asAxisRect in the painter needs exactly 4 points for rectangular buildings).
    if (poly.length > 1) {
      const f = poly[0], l = poly[poly.length - 1];
      if (Math.abs(f.x - l.x) < 0.01 && Math.abs(f.y - l.y) < 0.01) poly = poly.slice(0, -1);
    }

    if (tags.building) buildings.push(poly);
    else if (tags.highway) roads.push({ line: poly, w: roadWidth(tags.highway) });
    else if (tags.natural === "wood" || tags.landuse === "forest") areas.push({ poly, t: Terrain.Woods });
    else if (tags.natural === "water" || tags.water || tags.waterway || tags.landuse === "reservoir")
      areas.push({ poly, t: Terrain.Water });
    else if (tags.barrier === "hedge" || tags.barrier === "wall" || tags.barrier === "fence") hedges.push(poly);
    // (grass/meadow/farmland already match the default grass ground.)
  }

  for (const a of areas) fillPolygon(grid, a.poly, a.t);
  for (const r of roads) rasterizeLine(grid, r.line, r.w, Terrain.Road);
  for (const poly of buildings) rasterizeBuilding(grid, poly, features);
  for (const poly of hedges) rasterizeHedge(grid, poly, features);

  // A bare patch of countryside still wants a little cover to fight over.
  if (buildings.length === 0 && areas.length < 2) scatterCover(grid, features);

  const spawns = generateSpawns(grid);
  const objective = pickObjective(grid, features);
  return { name: label, grid, features, spawns, objective };
}

// The victory location: the building whose centroid is closest to the map centre
// (the "town square" heuristic). Falls back to the map centre if no buildings.
// Snapped to passable ground.
function pickObjective(grid: Grid, features: MapFeatures): Objective {
  const gx = grid.width / 2;
  const gy = grid.height / 2;
  let tx = gx;
  let ty = gy;
  if (features.buildings.length) {
    let bestD = Infinity;
    for (const b of features.buildings) {
      const bx = b.poly.reduce((s, p) => s + p.x, 0) / b.poly.length;
      const by = b.poly.reduce((s, p) => s + p.y, 0) / b.poly.length;
      const d = Math.hypot(bx - gx, by - gy);
      if (d < bestD) { bestD = d; tx = bx; ty = by; }
    }
  }
  const c = nearestPassableCell(grid, Math.round(tx), Math.round(ty));
  return { cx: c.cx, cy: c.cy, radius: OBJECTIVE_RADIUS };
}

function nearestPassableCell(grid: Grid, cx: number, cy: number): { cx: number; cy: number } {
  if (grid.inBounds(cx, cy) && isPassable(grid.get(cx, cy))) return { cx, cy };
  for (let r = 1; r < 30; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++)
        if (grid.inBounds(cx + dx, cy + dy) && isPassable(grid.get(cx + dx, cy + dy)))
          return { cx: cx + dx, cy: cy + dy };
  return { cx, cy };
}

async function fetchOverpass(s: number, w: number, n: number, e: number): Promise<OsmWay[]> {
  const bbox = `${s},${w},${n},${e}`;
  const q =
    `[out:json][timeout:25];(` +
    `way["building"](${bbox});` +
    `way["highway"](${bbox});` +
    `way["natural"~"wood|water"](${bbox});` +
    `way["landuse"~"forest|reservoir"](${bbox});` +
    `way["waterway"](${bbox});` +
    `way["barrier"~"hedge|wall|fence"](${bbox});` +
    `);out geom;`;
  const res = await fetch(OVERPASS, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "data=" + encodeURIComponent(q),
  });
  if (!res.ok) throw new Error(`Overpass ${res.status}`);
  const json = (await res.json()) as { elements: OsmWay[] };
  return json.elements ?? [];
}

function roadWidth(highway: string): number {
  if (/motorway|trunk|primary/.test(highway)) return 2; // ~5 cells wide — major road
  if (/secondary|tertiary/.test(highway)) return 1;      // ~3 cells — town road
  if (/residential|unclassified/.test(highway)) return 0; // 1 cell — lane
  return 0; // footways/tracks — 1 cell
}

// --- rasterization ---

function fillPolygon(grid: Grid, poly: Pt[], t: Terrain): void {
  let ymin = Infinity;
  let ymax = -Infinity;
  for (const p of poly) {
    if (p.y < ymin) ymin = p.y;
    if (p.y > ymax) ymax = p.y;
  }
  const cy0 = Math.max(0, Math.floor(ymin));
  const cy1 = Math.min(grid.height - 1, Math.ceil(ymax));
  for (let cy = cy0; cy <= cy1; cy++) {
    const yc = cy + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if ((a.y <= yc && b.y > yc) || (b.y <= yc && a.y > yc)) {
        xs.push(a.x + ((yc - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.floor(xs[k]));
      const x1 = Math.min(grid.width - 1, Math.floor(xs[k + 1]));
      for (let cx = x0; cx <= x1; cx++) grid.set(cx, cy, t);
    }
  }
}

function rasterizeLine(grid: Grid, line: Pt[], halfW: number, t: Terrain): void {
  for (let i = 0; i + 1 < line.length; i++) stroke(grid, line[i], line[i + 1], halfW, t);
}

function stroke(grid: Grid, a: Pt, b: Pt, halfW: number, t: Terrain): void {
  const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
  for (let s = 0; s <= steps; s++) {
    const x = a.x + ((b.x - a.x) * s) / steps;
    const y = a.y + ((b.y - a.y) * s) / steps;
    const cx = Math.round(x);
    const cy = Math.round(y);
    const r = Math.floor(halfW);
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) if (grid.inBounds(cx + dx, cy + dy)) grid.set(cx + dx, cy + dy, t);
  }
}

function rasterizeBuilding(grid: Grid, poly: Pt[], features: MapFeatures): void {
  // Fill the footprint, then convert its rim to walls and punch a doorway so troops
  // can enter.
  const inside: [number, number][] = [];
  fillCollect(grid, poly, (cx, cy) => {
    grid.set(cx, cy, Terrain.Floor);
    inside.push([cx, cy]);
  });
  if (inside.length === 0) return;

  const walls: [number, number][] = [];
  for (const [cx, cy] of inside) {
    if (
      grid.get(cx - 1, cy) !== Terrain.Floor && grid.get(cx - 1, cy) !== Terrain.Wall ||
      grid.get(cx + 1, cy) !== Terrain.Floor && grid.get(cx + 1, cy) !== Terrain.Wall ||
      grid.get(cx, cy - 1) !== Terrain.Floor && grid.get(cx, cy - 1) !== Terrain.Wall ||
      grid.get(cx, cy + 1) !== Terrain.Floor && grid.get(cx, cy + 1) !== Terrain.Wall ||
      !grid.inBounds(cx - 1, cy) || !grid.inBounds(cx + 1, cy) || !grid.inBounds(cx, cy - 1) || !grid.inBounds(cx, cy + 1)
    ) {
      walls.push([cx, cy]);
    }
  }
  for (const [cx, cy] of walls) grid.set(cx, cy, Terrain.Wall);

  // Doorway: a wall cell that touches passable open ground outside.
  for (const [cx, cy] of walls) {
    const out = [
      [cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1],
    ].some(([nx, ny]) => grid.inBounds(nx, ny) && passableOpen(grid.get(nx, ny)));
    if (out) {
      grid.set(cx, cy, Terrain.Floor);
      break;
    }
  }

  const lvl = 1 + (inside.length > 30 ? 1 : 0);
  features.buildings.push({ poly, levels: lvl });
}

function rasterizeHedge(grid: Grid, line: Pt[], features: MapFeatures): void {
  for (let i = 0; i + 1 < line.length; i++) {
    stroke(grid, line[i], line[i + 1], 0, Terrain.Hedge);
    features.hedges.push({ x0: line[i].x, y0: line[i].y, x1: line[i + 1].x, y1: line[i + 1].y });
  }
}

function fillCollect(grid: Grid, poly: Pt[], cb: (cx: number, cy: number) => void): void {
  let ymin = Infinity;
  let ymax = -Infinity;
  for (const p of poly) {
    if (p.y < ymin) ymin = p.y;
    if (p.y > ymax) ymax = p.y;
  }
  const cy0 = Math.max(0, Math.floor(ymin));
  const cy1 = Math.min(grid.height - 1, Math.ceil(ymax));
  for (let cy = cy0; cy <= cy1; cy++) {
    const yc = cy + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if ((a.y <= yc && b.y > yc) || (b.y <= yc && a.y > yc)) {
        xs.push(a.x + ((yc - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.floor(xs[k]));
      const x1 = Math.min(grid.width - 1, Math.floor(xs[k + 1]));
      for (let cx = x0; cx <= x1; cx++) cb(cx, cy);
    }
  }
}

function passableOpen(t: Terrain): boolean {
  return t === Terrain.Open || t === Terrain.Grass || t === Terrain.Road;
}

function scatterCover(grid: Grid, features: MapFeatures): void {
  // Sparse hedgerows + a copse so an empty field still plays like a battlefield.
  const midY = Math.floor(grid.height / 2);
  for (let x = 4; x < grid.width - 4; x += 3) grid.set(x, midY, Terrain.Hedge);
  features.hedges.push({ x0: 4, y0: midY, x1: grid.width - 4, y1: midY });
  const wx = Math.floor(grid.width * 0.25);
  const wy = Math.floor(grid.height * 0.3);
  for (let dy = 0; dy < 8; dy++) for (let dx = 0; dx < 10; dx++) grid.set(wx + dx, wy + dy, Terrain.Woods);
}

// --- force placement ---

function generateSpawns(grid: Grid): Spawns {
  const us: SquadSpawn[] = [];
  const axis: SquadSpawn[] = [];
  const usVehicles: VehicleSpawn[] = [];
  const axisVehicles: VehicleSpawn[] = [];

  const usBand = passableInBand(grid, grid.height - 8, grid.height - 3);
  const axisBand = passableInBand(grid, 3, 8);
  const usVehBand = vehicleInBand(grid, grid.height - 8, grid.height - 3);
  const axisVehBand = vehicleInBand(grid, 3, 8);

  const usSquads: { name: string; kind: SquadSpawn["kind"]; count: number }[] = [
    { name: "1st Squad", kind: "rifle", count: 8 },
    { name: "2nd Squad", kind: "rifle", count: 8 },
    { name: "LMG Team", kind: "mg", count: 6 },
    { name: "AT Team", kind: "at", count: 5 },
    { name: "Mortar Team", kind: "mortar", count: 5 },
  ];
  const axisSquads: { name: string; kind: SquadSpawn["kind"]; count: number }[] = [
    { name: "Garrison", kind: "rifle", count: 6 },
    { name: "MG Team", kind: "mg", count: 6 },
    { name: "Outpost", kind: "rifle", count: 6 },
    { name: "Reserve", kind: "rifle", count: 6 },
  ];
  cluster(usBand, usSquads.length).forEach((c, i) =>
    us.push({ name: usSquads[i].name, cx: c.cx, cy: c.cy, count: usSquads[i].count, kind: usSquads[i].kind }));
  cluster(axisBand, axisSquads.length).forEach((c, i) =>
    axis.push({ name: axisSquads[i].name, cx: c.cx, cy: c.cy, count: axisSquads[i].count, kind: axisSquads[i].kind }));

  if (usVehBand.length) {
    const c = usVehBand[Math.floor(usVehBand.length / 2)];
    usVehicles.push({ cls: "sherman", cx: c.cx, cy: c.cy, facing: -Math.PI / 2 });
  }
  if (axisVehBand.length) {
    const c = axisVehBand[Math.floor(axisVehBand.length / 2)];
    axisVehicles.push({ cls: "panzer4", cx: c.cx, cy: c.cy, facing: Math.PI / 2 });
  }
  return { us, axis, usVehicles, axisVehicles };
}

function passableInBand(grid: Grid, y0: number, y1: number): { cx: number; cy: number }[] {
  const cells: { cx: number; cy: number }[] = [];
  for (let cy = Math.max(0, y0); cy <= Math.min(grid.height - 1, y1); cy++)
    for (let cx = 0; cx < grid.width; cx++) {
      const t = grid.get(cx, cy);
      // Exclude building interiors (Floor) so squads never spawn inside a building
      // and can't get trapped if the doorway is narrow or blocked.
      if (isPassable(t) && t !== Terrain.Floor) cells.push({ cx, cy });
    }
  return cells;
}
function vehicleInBand(grid: Grid, y0: number, y1: number): { cx: number; cy: number }[] {
  const cells: { cx: number; cy: number }[] = [];
  for (let cy = Math.max(0, y0); cy <= Math.min(grid.height - 1, y1); cy++)
    for (let cx = 0; cx < grid.width; cx++) if (vehiclePassable(grid.get(cx, cy))) cells.push({ cx, cy });
  return cells;
}
// Pick `n` cells in a tight cluster near the middle of the band, so a side's
// squads start grouped together (a few cells apart) rather than strung across the
// whole map width. Each squad is snapped to the nearest passable band cell.
function cluster(cells: { cx: number; cy: number }[], n: number): { cx: number; cy: number }[] {
  if (cells.length === 0) return [];
  const sorted = [...cells].sort((a, b) => a.cx - b.cx);
  const centerCx = sorted[Math.floor(sorted.length / 2)].cx;
  const SPACING = 4; // cells between adjacent squad anchors
  const out: { cx: number; cy: number }[] = [];
  for (let i = 0; i < n; i++) {
    const targetCx = centerCx + Math.round((i - (n - 1) / 2) * SPACING);
    let best = sorted[0];
    let bestD = Infinity;
    for (const c of sorted) {
      const d = Math.abs(c.cx - targetCx);
      if (d < bestD) { bestD = d; best = c; }
    }
    out.push(best);
  }
  return out;
}
