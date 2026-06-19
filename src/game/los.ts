import { SMOKE_LOS_BLOCK } from "./constants.ts";
import { Grid } from "./grid.ts";
import { TERRAIN } from "./terrain.ts";

// Line of sight over the terrain grid. Walks a Bresenham line between two cells;
// any intermediate cell that blocks sight (buildings, woods, hedges) breaks LOS.
// A cell immediately adjacent to either endpoint never blocks: this lets a man at a
// window fire out of his own building, and lets you spot a man hugging the far wall,
// without seeing clear through a whole structure.
// When a `smoke` density grid is supplied, any sufficiently thick smoke cell along
// the line also breaks LOS — that's how a mortar screen conceals a moving squad.
export function hasLOS(grid: Grid, x0: number, y0: number, x1: number, y1: number, smoke?: Float32Array): boolean {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let cx = x0;
  let cy = y0;

  for (;;) {
    if (cx === x1 && cy === y1) return true;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      cx += sx;
    }
    if (e2 < dx) {
      err += dx;
      cy += sy;
    }
    if (cx === x1 && cy === y1) return true;
    if (!grid.inBounds(cx, cy)) return false;
    // Skip blocking for cells touching an endpoint (window/edge rule).
    const nearStart = Math.abs(cx - x0) <= 1 && Math.abs(cy - y0) <= 1;
    const nearEnd = Math.abs(cx - x1) <= 1 && Math.abs(cy - y1) <= 1;
    if (!nearStart && !nearEnd) {
      if (TERRAIN[grid.get(cx, cy)].blocksSight) return false;
      if (smoke && smoke[grid.idx(cx, cy)] >= SMOKE_LOS_BLOCK) return false;
    }
  }
}
