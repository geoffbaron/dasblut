import { CELL_SIZE } from "../game/constants.ts";
import { Building, HedgeSeg, MapFeatures, Pt } from "../game/gamemap.ts";
import { Grid } from "../game/grid.ts";
import { Terrain } from "../game/terrain.ts";
import { fbm, mulberry32, valueNoise } from "./noise.ts";

// Paints the entire battlefield to an offscreen canvas, imitating Close Combat's
// hand-painted aerial maps: noise-mottled ground with irregular edges, scattered
// tree canopies with shadows, dirt roads, bocage, and pitched-roof buildings with
// cast shadows. Rendered once at load; used as the static background texture.
//
// SS = internal supersample so detail/edges stay crisp on hi-dpi displays. The
// ground base is computed per-pixel at 1× (it's noisy anyway) and upscaled; all
// vector detail is drawn at SS.

const SUN = { x: -0.6, y: -0.8 }; // light from top-left → shadows to bottom-right

interface RGB {
  r: number;
  g: number;
  b: number;
}

// Naturalistic, muted palette. Each entry is a base color plus a second color the
// per-pixel noise blends toward, giving mottled, painterly ground.
const GROUND: Partial<Record<Terrain, [RGB, RGB]>> = {
  [Terrain.Open]: [rgb(0x8d8159), rgb(0x756b48)],
  [Terrain.Grass]: [rgb(0x6f763e), rgb(0x59602f)],
  [Terrain.Woods]: [rgb(0x46512c), rgb(0x36421f)],
  [Terrain.Water]: [rgb(0x3a5a72), rgb(0x2c4a60)],
  [Terrain.Road]: [rgb(0x9a8a68), rgb(0x7e6f4f)],
  [Terrain.Rubble]: [rgb(0x796f60), rgb(0x615847)],
  // Walls & hedges sit on a grassy/dirt base; structures are drawn on top.
  [Terrain.Wall]: [rgb(0x6f763e), rgb(0x59602f)],
  [Terrain.Hedge]: [rgb(0x6f763e), rgb(0x59602f)],
};

export interface PaintedMap {
  canvas: HTMLCanvasElement;
  scale: number; // multiply canvas px by this to get logical (CSS) px
}

export function paintBattlefield(grid: Grid, features: MapFeatures): PaintedMap {
  const mapW = grid.width * CELL_SIZE;
  const mapH = grid.height * CELL_SIZE;
  const seed = 1337;
  // Supersample for crisp detail on small maps; drop to 1× on big generated maps to
  // keep the texture within sane memory/time bounds.
  const SS = grid.width * grid.height > 9000 ? 1 : 2;

  // --- 1. Per-pixel ground base (1×), with domain-warped lookups for organic edges.
  const base = document.createElement("canvas");
  base.width = mapW;
  base.height = mapH;
  const bctx = base.getContext("2d")!;
  const img = bctx.createImageData(mapW, mapH);
  const data = img.data;
  const warpAmp = CELL_SIZE * 0.45;

  for (let py = 0; py < mapH; py++) {
    for (let px = 0; px < mapW; px++) {
      // Warp the sampling point so cell boundaries become wavy, not gridded.
      const wx = px + (valueNoise(px * 0.05, py * 0.05, seed) - 0.5) * 2 * warpAmp;
      const wy = py + (valueNoise(px * 0.05, py * 0.05, seed + 99) - 0.5) * 2 * warpAmp;
      let cx = Math.floor(wx / CELL_SIZE);
      let cy = Math.floor(wy / CELL_SIZE);
      if (cx < 0) cx = 0;
      else if (cx >= grid.width) cx = grid.width - 1;
      if (cy < 0) cy = 0;
      else if (cy >= grid.height) cy = grid.height - 1;

      const pair = GROUND[grid.get(cx, cy)] ?? GROUND[Terrain.Grass]!;
      // Two scales of noise: fine mottle + broad patches.
      const fine = valueNoise(px * 0.18, py * 0.18, seed + 7);
      const broad = fbm(px * 0.012, py * 0.012, seed + 23, 2);
      const t = fine * 0.45 + broad * 0.55;
      let shade = 0.82 + t * 0.36; // brightness multiplier
      // A touch of extra darkening in low broad-noise areas → soft "AO" puddles.
      shade *= 0.94 + broad * 0.12;

      const i = (py * mapW + px) * 4;
      const c = mix(pair[0], pair[1], t);
      data[i] = clamp8(c.r * shade);
      data[i + 1] = clamp8(c.g * shade);
      data[i + 2] = clamp8(c.b * shade);
      data[i + 3] = 255;
    }
  }
  bctx.putImageData(img, 0, 0);

  // --- 2. Main canvas at SS: upscale the ground, then draw crisp vector detail.
  const canvas = document.createElement("canvas");
  canvas.width = mapW * SS;
  canvas.height = mapH * SS;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(SS, SS);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(base, 0, 0, mapW, mapH);

  const rng = mulberry32(seed ^ 0x55aa);

  // Field furrows + grass tufts give the open ground some life.
  scatterGroundDetail(ctx, grid, rng);
  // Road ruts.
  drawRoadRuts(ctx, grid, rng);
  // Water ripples + shoreline.
  drawWater(ctx, grid, rng);
  // Woods canopy (the big visual win) and rubble debris.
  drawWoods(ctx, grid, rng);
  drawRubble(ctx, grid, rng);
  // Bocage hedgerows.
  for (const h of features.hedges) drawHedge(ctx, h, rng);
  // Buildings: cast shadow → walls → pitched roof.
  for (const b of features.buildings) drawBuilding(ctx, b, rng);
  // Global grade: soft vignette.
  drawVignette(ctx, mapW, mapH);

  return { canvas, scale: 1 / SS };
}

// ---------------------------------------------------------------------------

function scatterGroundDetail(ctx: CanvasRenderingContext2D, grid: Grid, rng: () => number): void {
  for (let cy = 0; cy < grid.height; cy++) {
    for (let cx = 0; cx < grid.width; cx++) {
      const t = grid.get(cx, cy);
      if (t !== Terrain.Grass && t !== Terrain.Open) continue;
      const n = t === Terrain.Grass ? 3 : 1;
      for (let k = 0; k < n; k++) {
        const x = (cx + rng()) * CELL_SIZE;
        const y = (cy + rng()) * CELL_SIZE;
        ctx.strokeStyle = `rgba(${t === Terrain.Grass ? "108,120,58" : "150,138,96"},0.35)`;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + (rng() - 0.5) * 2, y - 2 - rng() * 2);
        ctx.stroke();
      }
    }
  }
}

function drawRoadRuts(ctx: CanvasRenderingContext2D, grid: Grid, rng: () => number): void {
  ctx.save();
  for (let cy = 0; cy < grid.height; cy++) {
    for (let cx = 0; cx < grid.width; cx++) {
      if (grid.get(cx, cy) !== Terrain.Road) continue;
      // Darken edges and add gravel speckle.
      for (let k = 0; k < 5; k++) {
        const x = (cx + rng()) * CELL_SIZE;
        const y = (cy + rng()) * CELL_SIZE;
        ctx.fillStyle = `rgba(90,78,55,${0.25 + rng() * 0.2})`;
        ctx.beginPath();
        ctx.arc(x, y, 0.6 + rng() * 0.9, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.restore();
}

function drawWater(ctx: CanvasRenderingContext2D, grid: Grid, rng: () => number): void {
  for (let cy = 0; cy < grid.height; cy++) {
    for (let cx = 0; cx < grid.width; cx++) {
      if (grid.get(cx, cy) !== Terrain.Water) continue;
      // Ripple highlights.
      for (let k = 0; k < 3; k++) {
        const x = (cx + rng()) * CELL_SIZE;
        const y = (cy + rng()) * CELL_SIZE;
        ctx.strokeStyle = `rgba(150,185,205,${0.18 + rng() * 0.12})`;
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.arc(x, y, 1.5 + rng() * 2, 0.6, 2.4);
        ctx.stroke();
      }
      // Lighter shoreline where water meets non-water.
      if (!isWater(grid, cx - 1, cy) || !isWater(grid, cx + 1, cy)) {
        ctx.fillStyle = "rgba(120,150,150,0.25)";
        ctx.fillRect(cx * CELL_SIZE, cy * CELL_SIZE, CELL_SIZE, CELL_SIZE);
      }
    }
  }
}

function drawWoods(ctx: CanvasRenderingContext2D, grid: Grid, rng: () => number): void {
  // Collect tree positions first so we can paint all shadows, then all canopies.
  const trees: { x: number; y: number; r: number }[] = [];
  for (let cy = 0; cy < grid.height; cy++) {
    for (let cx = 0; cx < grid.width; cx++) {
      if (grid.get(cx, cy) !== Terrain.Woods) continue;
      const count = 2 + Math.floor(rng() * 2);
      for (let k = 0; k < count; k++) {
        trees.push({
          x: (cx + rng()) * CELL_SIZE,
          y: (cy + rng()) * CELL_SIZE,
          r: CELL_SIZE * (0.45 + rng() * 0.3),
        });
      }
    }
  }
  // Soft shadows.
  ctx.fillStyle = "rgba(20,28,14,0.33)";
  for (const t of trees) {
    ctx.beginPath();
    ctx.ellipse(t.x - SUN.x * t.r * 0.7, t.y - SUN.y * t.r * 0.7, t.r * 0.95, t.r * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // Canopies with a top-left highlight.
  for (const t of trees) {
    const g = ctx.createRadialGradient(
      t.x + SUN.x * t.r * 0.4,
      t.y + SUN.y * t.r * 0.4,
      t.r * 0.15,
      t.x,
      t.y,
      t.r,
    );
    const hue = 80 + Math.floor(rng() * 20);
    g.addColorStop(0, `hsl(${hue},38%,42%)`);
    g.addColorStop(0.7, `hsl(${hue},42%,30%)`);
    g.addColorStop(1, `hsl(${hue},45%,20%)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawRubble(ctx: CanvasRenderingContext2D, grid: Grid, rng: () => number): void {
  for (let cy = 0; cy < grid.height; cy++) {
    for (let cx = 0; cx < grid.width; cx++) {
      if (grid.get(cx, cy) !== Terrain.Rubble) continue;
      for (let k = 0; k < 6; k++) {
        const x = (cx + rng()) * CELL_SIZE;
        const y = (cy + rng()) * CELL_SIZE;
        const s = 1 + rng() * 2.5;
        ctx.fillStyle = `rgba(30,26,22,0.3)`;
        ctx.fillRect(x + 1, y + 1, s, s); // chunk shadow
        ctx.fillStyle = `hsl(40,12%,${45 + rng() * 20}%)`;
        ctx.fillRect(x, y, s, s);
      }
    }
  }
}

function drawHedge(ctx: CanvasRenderingContext2D, h: HedgeSeg, rng: () => number): void {
  const horiz = h.y0 === h.y1;
  const len = horiz ? Math.abs(h.x1 - h.x0) : Math.abs(h.y1 - h.y0);
  const steps = Math.max(2, Math.round(len * 1.6));
  const blobs: { x: number; y: number; r: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const cxCell = h.x0 + (h.x1 - h.x0) * f + 0.5;
    const cyCell = h.y0 + (h.y1 - h.y0) * f + 0.5;
    blobs.push({
      x: cxCell * CELL_SIZE + (rng() - 0.5) * 4,
      y: cyCell * CELL_SIZE + (rng() - 0.5) * 4,
      r: CELL_SIZE * (0.42 + rng() * 0.18),
    });
  }
  ctx.fillStyle = "rgba(18,26,12,0.35)";
  for (const b of blobs) {
    ctx.beginPath();
    ctx.ellipse(b.x + 2, b.y + 3, b.r, b.r * 0.85, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const b of blobs) {
    const g = ctx.createRadialGradient(b.x - 2, b.y - 2, 1, b.x, b.y, b.r);
    g.addColorStop(0, "hsl(95,35%,34%)");
    g.addColorStop(1, "hsl(100,40%,18%)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fill();
  }
}

const ROOF_PALETTES = [
  ["#9a4f3c", "#7c3e2e"], // red tile
  ["#7d7a73", "#5f5c55"], // grey slate
  ["#8a6b4a", "#6d5238"], // brown
];

// Axis-aligned rectangles get the nice pitched roof; arbitrary OSM footprints get a
// flat, shaded roof with a cast shadow — both read clearly as buildings from above.
function drawBuilding(ctx: CanvasRenderingContext2D, b: Building, rng: () => number): void {
  const rect = asAxisRect(b.poly);
  if (rect) drawPitchedBuilding(ctx, rect.x0, rect.y0, rect.x1, rect.y1, b.levels, rng);
  else drawFlatBuilding(ctx, b.poly, b.levels, rng);
}

function drawFlatBuilding(ctx: CanvasRenderingContext2D, poly: Pt[], levels: number, rng: () => number): void {
  const pts = poly.map((p) => [p.x * CELL_SIZE, p.y * CELL_SIZE] as [number, number]);
  const lift = 3 + levels * 2.5;
  const pal = ROOF_PALETTES[Math.floor(rng() * ROOF_PALETTES.length)];

  // Cast shadow.
  ctx.save();
  ctx.filter = "blur(4px)";
  ctx.fillStyle = "rgba(15,15,12,0.4)";
  poly2(ctx, pts.map(([x, y]) => [x - SUN.x * lift, y - SUN.y * lift] as [number, number]));
  ctx.restore();

  // Roof, shaded by a top-left light.
  const bb = bbox(pts);
  const grad = ctx.createLinearGradient(bb.x0, bb.y0, bb.x1, bb.y1);
  grad.addColorStop(0, lightenHex(pal[0], 14));
  grad.addColorStop(1, pal[1]);
  ctx.fillStyle = grad;
  poly2(ctx, pts);
  // Eave outline.
  ctx.strokeStyle = "rgba(0,0,0,0.4)";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.stroke();
  // Roof texture, clipped to the footprint.
  ctx.save();
  ctx.clip();
  ctx.strokeStyle = "rgba(0,0,0,0.1)";
  ctx.lineWidth = 0.6;
  for (let lx = bb.x0; lx < bb.x1; lx += 4) {
    ctx.beginPath();
    ctx.moveTo(lx, bb.y0);
    ctx.lineTo(lx, bb.y1);
    ctx.stroke();
  }
  ctx.restore();
}

function drawPitchedBuilding(
  ctx: CanvasRenderingContext2D,
  gx0: number,
  gy0: number,
  gx1: number,
  gy1: number,
  levels: number,
  rng: () => number,
): void {
  const x = gx0 * CELL_SIZE;
  const y = gy0 * CELL_SIZE;
  const w = (gx1 - gx0) * CELL_SIZE;
  const h = (gy1 - gy0) * CELL_SIZE;
  const lift = 3 + levels * 2.5; // taller buildings → longer shadow

  // 1. Cast shadow, softened.
  ctx.save();
  ctx.filter = "blur(4px)";
  ctx.fillStyle = "rgba(15,15,12,0.4)";
  ctx.fillRect(x - SUN.x * lift, y - SUN.y * lift, w, h);
  ctx.restore();

  // 2. Wall block (eaves) — a slightly larger dark base the roof sits on.
  ctx.fillStyle = "#5d5346";
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2);

  // 3. Pitched roof: ridge along the longer axis, two shaded faces.
  const roofPalettes = [
    ["#9a4f3c", "#7c3e2e"], // red tile
    ["#7d7a73", "#5f5c55"], // grey slate
    ["#8a6b4a", "#6d5238"], // brown
  ];
  const pal = roofPalettes[Math.floor(rng() * roofPalettes.length)];
  const inset = 1.5;
  const rx = x + inset;
  const ry = y + inset;
  const rw = w - inset * 2;
  const rh = h - inset * 2;

  if (rw >= rh) {
    // Horizontal ridge.
    const midY = ry + rh / 2;
    ctx.fillStyle = pal[0]; // sun-facing (upper) slope
    poly(ctx, [
      [rx, ry],
      [rx + rw, ry],
      [rx + rw, midY],
      [rx, midY],
    ]);
    ctx.fillStyle = pal[1]; // shaded (lower) slope
    poly(ctx, [
      [rx, midY],
      [rx + rw, midY],
      [rx + rw, ry + rh],
      [rx, ry + rh],
    ]);
    roofLines(ctx, rx, ry, rw, rh, true);
    ridge(ctx, rx, midY, rx + rw, midY);
  } else {
    // Vertical ridge.
    const midX = rx + rw / 2;
    ctx.fillStyle = pal[0];
    poly(ctx, [
      [rx, ry],
      [midX, ry],
      [midX, ry + rh],
      [rx, ry + rh],
    ]);
    ctx.fillStyle = pal[1];
    poly(ctx, [
      [midX, ry],
      [rx + rw, ry],
      [rx + rw, ry + rh],
      [midX, ry + rh],
    ]);
    roofLines(ctx, rx, ry, rw, rh, false);
    ridge(ctx, midX, ry, midX, ry + rh);
  }

  // 4. Eave outline.
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 1;
  ctx.strokeRect(rx, ry, rw, rh);

  // 5. A small chimney with its own shadow, for charm.
  const chx = rx + rw * (0.2 + rng() * 0.6);
  const chy = ry + rh * (0.2 + rng() * 0.6);
  ctx.fillStyle = "rgba(15,15,12,0.4)";
  ctx.fillRect(chx - SUN.x * 4, chy - SUN.y * 4, 3.5, 3.5);
  ctx.fillStyle = "#4a4038";
  ctx.fillRect(chx, chy, 3.5, 3.5);
}

function roofLines(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  horiz: boolean,
): void {
  ctx.strokeStyle = "rgba(0,0,0,0.12)";
  ctx.lineWidth = 0.6;
  if (horiz) {
    for (let lx = x + 4; lx < x + w; lx += 4) {
      ctx.beginPath();
      ctx.moveTo(lx, y);
      ctx.lineTo(lx, y + h);
      ctx.stroke();
    }
  } else {
    for (let ly = y + 4; ly < y + h; ly += 4) {
      ctx.beginPath();
      ctx.moveTo(x, ly);
      ctx.lineTo(x + w, ly);
      ctx.stroke();
    }
  }
}

function ridge(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  ctx.strokeStyle = "rgba(255,240,220,0.35)";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function drawVignette(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.65);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(20,18,12,0.4)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

// --- small helpers ---

function poly(ctx: CanvasRenderingContext2D, pts: [number, number][]): void {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fill();
}
const poly2 = poly;

function bbox(pts: [number, number][]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

// If the footprint is an axis-aligned rectangle, return its cell-coord corners.
function asAxisRect(p: Pt[]): { x0: number; y0: number; x1: number; y1: number } | null {
  if (p.length !== 4) return null;
  const xs = new Set(p.map((q) => q.x));
  const ys = new Set(p.map((q) => q.y));
  if (xs.size !== 2 || ys.size !== 2) return null;
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

function lightenHex(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${clamp8((n >> 16) + amt)},${clamp8(((n >> 8) & 255) + amt)},${clamp8((n & 255) + amt)})`;
}

function isWater(grid: Grid, cx: number, cy: number): boolean {
  return grid.inBounds(cx, cy) && grid.get(cx, cy) === Terrain.Water;
}

function rgb(hex: number): RGB {
  return { r: (hex >> 16) & 255, g: (hex >> 8) & 255, b: hex & 255 };
}
function mix(a: RGB, b: RGB, t: number): RGB {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}
function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}
