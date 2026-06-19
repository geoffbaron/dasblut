import { Grid } from "./grid.ts";
import { TERRAIN } from "./terrain.ts";

export interface Cell {
  cx: number;
  cy: number;
}

export interface PathOpts {
  /** Whether a cell may be entered (defaults to infantry passability). */
  passable?: (cx: number, cy: number) => boolean;
  /** Per-cell movement cost (defaults to terrain moveCost). */
  cost?: (cx: number, cy: number) => number;
}

// 8-directional A* over the terrain grid, weighted by each cell's moveCost so units
// prefer roads and avoid slow/dangerous ground. Diagonals may not cut through the
// corner of an impassable cell. `opts` lets vehicles use their own passability/cost.
export function findPath(grid: Grid, start: Cell, goal: Cell, opts: PathOpts = {}): Cell[] | null {
  const passable = opts.passable ?? ((cx, cy) => grid.passable(cx, cy));
  const cost = opts.cost ?? ((cx, cy) => TERRAIN[grid.get(cx, cy)].moveCost);
  if (!passable(goal.cx, goal.cy)) return null;
  if (start.cx === goal.cx && start.cy === goal.cy) return [start];

  const w = grid.width;
  const startI = grid.idx(start.cx, start.cy);
  const goalI = grid.idx(goal.cx, goal.cy);

  const gScore = new Map<number, number>();
  const cameFrom = new Map<number, number>();
  const open = new MinHeap();

  gScore.set(startI, 0);
  open.push(startI, heuristic(start, goal));

  while (open.size > 0) {
    const current = open.pop()!;
    if (current === goalI) return reconstruct(cameFrom, current, w);

    const ccx = current % w;
    const ccy = (current / w) | 0;
    const baseG = gScore.get(current)!;

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = ccx + dx;
        const ny = ccy + dy;
        if (!passable(nx, ny)) continue;
        // Prevent diagonal corner-cutting past blocked cells.
        if (dx !== 0 && dy !== 0) {
          if (!passable(ccx + dx, ccy) || !passable(ccx, ccy + dy)) continue;
        }
        const ni = grid.idx(nx, ny);
        const step = (dx !== 0 && dy !== 0 ? Math.SQRT2 : 1) * cost(nx, ny);
        const tentative = baseG + step;
        if (tentative < (gScore.get(ni) ?? Infinity)) {
          cameFrom.set(ni, current);
          gScore.set(ni, tentative);
          open.push(ni, tentative + heuristic({ cx: nx, cy: ny }, goal));
        }
      }
    }
  }
  return null;
}

function heuristic(a: Cell, b: Cell): number {
  // Octile distance — admissible for 8-way movement.
  const dx = Math.abs(a.cx - b.cx);
  const dy = Math.abs(a.cy - b.cy);
  return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
}

// Post-process an A* path by removing redundant waypoints wherever a direct
// straight line between two non-adjacent points stays inside passable terrain.
// This eliminates the stair-step jitter A* leaves on open ground and makes
// routes around buildings look direct instead of hugging every grid corner.
export function smoothPath(grid: Grid, path: Cell[], opts: PathOpts = {}): Cell[] {
  const passable = opts.passable ?? ((cx, cy) => grid.passable(cx, cy));
  if (path.length <= 2) return path;
  const result: Cell[] = [path[0]];
  let anchor = 0;
  for (let i = 2; i < path.length; i++) {
    if (!lineClear(path[anchor], path[i], passable)) {
      result.push(path[i - 1]);
      anchor = i - 1;
    }
  }
  result.push(path[path.length - 1]);
  return result;
}

// Supercover DDA: checks every cell the line from a→b passes through.
function lineClear(a: Cell, b: Cell, passable: (cx: number, cy: number) => boolean): boolean {
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  if (steps === 0) return true;
  for (let i = 1; i <= steps; i++) {
    const cx = Math.round(a.cx + (dx * i) / steps);
    const cy = Math.round(a.cy + (dy * i) / steps);
    if (!passable(cx, cy)) return false;
  }
  return true;
}

function reconstruct(cameFrom: Map<number, number>, current: number, w: number): Cell[] {
  const path: Cell[] = [];
  let c: number | undefined = current;
  while (c !== undefined) {
    path.push({ cx: c % w, cy: (c / w) | 0 });
    c = cameFrom.get(c);
  }
  return path.reverse();
}

// Compact binary min-heap keyed by priority, storing cell indices.
class MinHeap {
  private items: number[] = [];
  private prio: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: number, priority: number): void {
    this.items.push(item);
    this.prio.push(priority);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.prio[p] <= this.prio[i]) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): number | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0];
    const lastItem = this.items.pop()!;
    const lastPrio = this.prio.pop()!;
    if (this.items.length > 0) {
      this.items[0] = lastItem;
      this.prio[0] = lastPrio;
      let i = 0;
      const n = this.items.length;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < n && this.prio[l] < this.prio[m]) m = l;
        if (r < n && this.prio[r] < this.prio[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    [this.prio[a], this.prio[b]] = [this.prio[b], this.prio[a]];
  }
}
