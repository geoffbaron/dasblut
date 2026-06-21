import { Grid } from "./grid.ts";
import { Terrain, isPassable } from "./terrain.ts";

// Procedural building interiors. A building starts as a hollow Wall ring with a
// Floor fill; this turns the empty box into a believable floor plan — interior
// partition walls carve out 2-4 rooms joined by doorways, the perimeter gets a
// couple of exterior doors onto passable ground, and the remaining outer walls
// are dotted with windows infantry can climb through and fire out of.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Carve a rectangular building given its wall bounds (inclusive). The ring
// (x0,y0)-(x1,y1) is already Wall and the interior already Floor.
export function carveBuilding(grid: Grid, x0: number, y0: number, x1: number, y1: number): void {
  const seed = (Math.imul(x0 + 1, 73856093) ^ Math.imul(y0 + 1, 19349663) ^ Math.imul(x1 + 1, 83492791)) >>> 0;
  const rng = mulberry32(seed);
  const iw = x1 - x0 - 1;
  const ih = y1 - y0 - 1;
  if (iw < 1 || ih < 1) return;

  if (iw >= 2 && ih >= 2) partition(grid, x0 + 1, y0 + 1, x1 - 1, y1 - 1, rng, 0);
  carveExteriorDoors(grid, x0, y0, x1, y1, rng);
  carveWindows(grid, x0, y0, x1, y1, rng);
}

// Recursively split a room with a wall + single doorway until the pieces get small.
function partition(grid: Grid, ax0: number, ay0: number, ax1: number, ay1: number, rng: () => number, depth: number): void {
  const w = ax1 - ax0 + 1;
  const h = ay1 - ay0 + 1;
  if (depth >= 2) return;
  const canV = w >= 5;
  const canH = h >= 5;
  if (!canV && !canH) return;
  const splitV = canV && (!canH || rng() < (w >= h ? 0.62 : 0.4));
  if (splitV) {
    const sx = ax0 + 2 + Math.floor(rng() * (w - 4));
    for (let y = ay0; y <= ay1; y++) grid.set(sx, y, Terrain.Wall);
    grid.set(sx, ay0 + Math.floor(rng() * h), Terrain.Floor); // doorway
    partition(grid, ax0, ay0, sx - 1, ay1, rng, depth + 1);
    partition(grid, sx + 1, ay0, ax1, ay1, rng, depth + 1);
  } else {
    const sy = ay0 + 2 + Math.floor(rng() * (h - 4));
    for (let x = ax0; x <= ax1; x++) grid.set(x, sy, Terrain.Wall);
    grid.set(ax0 + Math.floor(rng() * w), sy, Terrain.Floor); // doorway
    partition(grid, ax0, ay0, ax1, sy - 1, rng, depth + 1);
    partition(grid, ax0, sy + 1, ax1, ay1, rng, depth + 1);
  }
}

// Knock 1-2 doorways through the outer wall wherever it faces open, walkable ground.
function carveExteriorDoors(grid: Grid, x0: number, y0: number, x1: number, y1: number, rng: () => number): void {
  const cands: { cx: number; cy: number }[] = [];
  for (let x = x0 + 1; x <= x1 - 1; x++) {
    if (outsideClear(grid, x, y0 - 1)) cands.push({ cx: x, cy: y0 });
    if (outsideClear(grid, x, y1 + 1)) cands.push({ cx: x, cy: y1 });
  }
  for (let y = y0 + 1; y <= y1 - 1; y++) {
    if (outsideClear(grid, x0 - 1, y)) cands.push({ cx: x0, cy: y });
    if (outsideClear(grid, x1 + 1, y)) cands.push({ cx: x1, cy: y });
  }
  if (cands.length === 0) return;
  // shuffle, then take 1-2 doors that aren't right next to another door
  for (let i = cands.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [cands[i], cands[j]] = [cands[j], cands[i]];
  }
  const want = 1 + (cands.length > 6 ? Math.floor(rng() * 2) : 0);
  let made = 0;
  for (const c of cands) {
    if (made >= want) break;
    if (neighborIs(grid, c.cx, c.cy, Terrain.Floor, true)) continue; // keep doors apart
    grid.set(c.cx, c.cy, Terrain.Floor);
    made++;
  }
  if (made === 0) grid.set(cands[0].cx, cands[0].cy, Terrain.Floor);
}

// Dot windows along the remaining outer walls, spaced out and never on corners.
function carveWindows(grid: Grid, x0: number, y0: number, x1: number, y1: number, rng: () => number): void {
  const edge: { cx: number; cy: number; ox: number; oy: number }[] = [];
  for (let x = x0 + 1; x <= x1 - 1; x++) {
    edge.push({ cx: x, cy: y0, ox: 0, oy: -1 });
    edge.push({ cx: x, cy: y1, ox: 0, oy: 1 });
  }
  for (let y = y0 + 1; y <= y1 - 1; y++) {
    edge.push({ cx: x0, cy: y, ox: -1, oy: 0 });
    edge.push({ cx: x1, cy: y, ox: 1, oy: 0 });
  }
  for (const e of edge) {
    if (grid.get(e.cx, e.cy) !== Terrain.Wall) continue; // skip doorways
    if (!grid.inBounds(e.cx + e.ox, e.cy + e.oy)) continue; // window needs an outside
    if (neighborIs(grid, e.cx, e.cy, Terrain.Window, true)) continue; // no adjacent windows
    if (rng() < 0.4) grid.set(e.cx, e.cy, Terrain.Window);
  }
}

// True only for a passable, building-free cell — somewhere a door could open onto.
function outsideClear(grid: Grid, cx: number, cy: number): boolean {
  if (!grid.inBounds(cx, cy)) return false;
  const t = grid.get(cx, cy);
  return isPassable(t) && t !== Terrain.Floor && t !== Terrain.Window;
}

function neighborIs(grid: Grid, cx: number, cy: number, t: Terrain, orthoOnly: boolean): boolean {
  const dirs = orthoOnly
    ? [[1, 0], [-1, 0], [0, 1], [0, -1]]
    : [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (const [dx, dy] of dirs) {
    if (grid.inBounds(cx + dx, cy + dy) && grid.get(cx + dx, cy + dy) === t) return true;
  }
  return false;
}
