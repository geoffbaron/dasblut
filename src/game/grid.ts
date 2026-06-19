import { Terrain, isPassable } from "./terrain.ts";

/** A rectangular battlefield of terrain cells. The shared substrate. */
export class Grid {
  readonly width: number;
  readonly height: number;
  readonly cells: Terrain[];

  constructor(width: number, height: number, fill: Terrain = Terrain.Open) {
    this.width = width;
    this.height = height;
    this.cells = new Array(width * height).fill(fill);
  }

  inBounds(cx: number, cy: number): boolean {
    return cx >= 0 && cy >= 0 && cx < this.width && cy < this.height;
  }

  idx(cx: number, cy: number): number {
    return cy * this.width + cx;
  }

  get(cx: number, cy: number): Terrain {
    return this.cells[this.idx(cx, cy)];
  }

  set(cx: number, cy: number, t: Terrain): void {
    if (this.inBounds(cx, cy)) this.cells[this.idx(cx, cy)] = t;
  }

  passable(cx: number, cy: number): boolean {
    return this.inBounds(cx, cy) && isPassable(this.get(cx, cy));
  }

  // --- authoring helpers used to paint the hand-made test map ---

  fillRect(x0: number, y0: number, x1: number, y1: number, t: Terrain): void {
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) this.set(x, y, t);
  }

  /** Hollow rectangle — a building shell with solid walls. */
  building(x0: number, y0: number, x1: number, y1: number): void {
    for (let x = x0; x <= x1; x++) {
      this.set(x, y0, Terrain.Wall);
      this.set(x, y1, Terrain.Wall);
    }
    for (let y = y0; y <= y1; y++) {
      this.set(x0, y, Terrain.Wall);
      this.set(x1, y, Terrain.Wall);
    }
  }

  hLine(x0: number, x1: number, y: number, t: Terrain): void {
    for (let x = x0; x <= x1; x++) this.set(x, y, t);
  }

  vLine(x: number, y0: number, y1: number, t: Terrain): void {
    for (let y = y0; y <= y1; y++) this.set(x, y, t);
  }
}
