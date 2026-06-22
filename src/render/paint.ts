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
  buildings: BuildingArt[]; // per-building floor + roof sprites
}

// A small canvas positioned in map space.
export interface Tile {
  canvas: HTMLCanvasElement;
  x: number; // logical-px position of the top-left in map space
  y: number;
  scale: number; // multiply canvas px by this to get logical px
}

// One building's art: a floor-plan tile (shown when a unit is inside) and a roof tile
// (shown when it's empty), both masked to the exact same footprint cells so they line
// up perfectly. `cells` drives the reveal-on-entry test.
export interface BuildingArt {
  floor: Tile;
  roof: Tile;
  cells: number[];
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
  // Battle scars: scorched ground, shell craters, and scattered debris. Drawn on the
  // open ground (under trees/buildings) so the field reads as fought-over, not pristine.
  drawScorch(ctx, grid, rng);
  drawCraters(ctx, grid, rng);
  drawDebris(ctx, grid, rng);
  // Woods canopy (the big visual win) and rubble debris.
  drawWoods(ctx, grid, rng);
  drawRubble(ctx, grid, rng);
  // Bocage hedgerows.
  for (const h of features.hedges) drawHedge(ctx, h, rng);
  // Buildings: only the cast shadows go into the static ground. The floor plan and the
  // roof are each their own masked tile (below), so they always line up and the floor
  // never pokes blocks out from under the roof.
  for (const b of features.buildings) drawBuildingShadow(ctx, b);
  // Global grade: soft vignette.
  drawVignette(ctx, mapW, mapH);

  const buildings = features.buildings.map((b) => paintBuilding(grid, b));

  return { canvas, scale: 1 / SS, buildings };
}

// ---------------------------------------------------------------------------

function scatterGroundDetail(ctx: CanvasRenderingContext2D, grid: Grid, rng: () => number): void {
  for (let cy = 0; cy < grid.height; cy++) {
    for (let cx = 0; cx < grid.width; cx++) {
      const t = grid.get(cx, cy);
      if (t !== Terrain.Grass && t !== Terrain.Open) continue;
      const bx = cx * CELL_SIZE, by = cy * CELL_SIZE;

      if (t === Terrain.Grass) {
        // Grass tufts — 4-6 multi-blade clusters, slightly different greens.
        const n = 4 + Math.floor(rng() * 3);
        for (let k = 0; k < n; k++) {
          const x = bx + rng() * CELL_SIZE, y = by + rng() * CELL_SIZE;
          const hue = 82 + Math.floor(rng() * 28);
          const light = 30 + Math.floor(rng() * 16);
          ctx.strokeStyle = `hsla(${hue},42%,${light}%,0.45)`;
          ctx.lineWidth = 0.7 + rng() * 0.4;
          ctx.beginPath();
          for (let b = 0; b < 3; b++) {
            ctx.moveTo(x + (rng() - 0.5) * 1.6, y);
            ctx.lineTo(x + (rng() - 0.5) * 3, y - 2.5 - rng() * 2.5);
          }
          ctx.stroke();
        }
        // Wildflower dots (sparse).
        if (rng() < 0.35) {
          const fx = bx + rng() * CELL_SIZE, fy = by + rng() * CELL_SIZE;
          const colors = ["rgba(200,180,80,0.6)", "rgba(180,110,70,0.5)", "rgba(160,160,110,0.5)"];
          ctx.fillStyle = colors[Math.floor(rng() * colors.length)];
          ctx.beginPath();
          ctx.arc(fx, fy, 0.6 + rng() * 0.6, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        // Open ground: sparse grass + dirt patches + scattered stones.
        if (rng() < 0.6) {
          const x = bx + rng() * CELL_SIZE, y = by + rng() * CELL_SIZE;
          ctx.strokeStyle = `rgba(150,138,96,0.3)`;
          ctx.lineWidth = 0.7;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + (rng() - 0.5) * 2, y - 1.8 - rng() * 1.5);
          ctx.stroke();
        }
        // Dirt patch (darker, irregular smudge).
        if (rng() < 0.18) {
          const x = bx + rng() * CELL_SIZE, y = by + rng() * CELL_SIZE;
          ctx.fillStyle = `rgba(80,68,48,${0.12 + rng() * 0.12})`;
          ctx.beginPath();
          ctx.ellipse(x, y, 2 + rng() * 3, 1.5 + rng() * 2, rng() * Math.PI, 0, Math.PI * 2);
          ctx.fill();
        }
        // Small stone or pebble.
        if (rng() < 0.2) {
          const x = bx + rng() * CELL_SIZE, y = by + rng() * CELL_SIZE;
          const s = 0.5 + rng() * 1.2;
          ctx.fillStyle = `rgba(22,18,14,0.2)`;
          ctx.fillRect(x + 0.3, y + 0.3, s, s);
          ctx.fillStyle = `hsl(36,8%,${52 + rng() * 18}%)`;
          ctx.fillRect(x, y, s, s);
        }
      }
    }
  }
}

function drawRoadRuts(ctx: CanvasRenderingContext2D, grid: Grid, rng: () => number): void {
  ctx.save();
  for (let cy = 0; cy < grid.height; cy++) {
    for (let cx = 0; cx < grid.width; cx++) {
      if (grid.get(cx, cy) !== Terrain.Road) continue;
      const bx = cx * CELL_SIZE, by = cy * CELL_SIZE;
      // Gravel speckle — more pebbles for texture.
      for (let k = 0; k < 8; k++) {
        const x = bx + rng() * CELL_SIZE, y = by + rng() * CELL_SIZE;
        ctx.fillStyle = `rgba(90,78,55,${0.2 + rng() * 0.2})`;
        ctx.beginPath();
        ctx.arc(x, y, 0.4 + rng() * 0.8, 0, Math.PI * 2);
        ctx.fill();
      }
      // Tire ruts / wheel tracks (faint parallel lines, connected to adjacent road cells).
      const below = grid.inBounds(cx, cy + 1) && grid.get(cx, cy + 1) === Terrain.Road;
      const right = grid.inBounds(cx + 1, cy) && grid.get(cx + 1, cy) === Terrain.Road;
      if (below && rng() < 0.4) {
        const ox = 3 + rng() * 4;
        ctx.strokeStyle = `rgba(65,55,38,${0.15 + rng() * 0.1})`;
        ctx.lineWidth = 1.0 + rng() * 0.6;
        ctx.beginPath();
        ctx.moveTo(bx + ox, by);
        ctx.lineTo(bx + ox + (rng() - 0.5) * 1.5, by + CELL_SIZE);
        ctx.stroke();
      }
      if (right && rng() < 0.4) {
        const oy = 3 + rng() * 4;
        ctx.strokeStyle = `rgba(65,55,38,${0.15 + rng() * 0.1})`;
        ctx.lineWidth = 1.0 + rng() * 0.6;
        ctx.beginPath();
        ctx.moveTo(bx, by + oy);
        ctx.lineTo(bx + CELL_SIZE, by + oy + (rng() - 0.5) * 1.5);
        ctx.stroke();
      }
      // Puddle stain (occasional dark wet patch).
      if (rng() < 0.08) {
        const px = bx + rng() * CELL_SIZE, py = by + rng() * CELL_SIZE;
        ctx.fillStyle = `rgba(50,45,35,${0.18 + rng() * 0.12})`;
        ctx.beginPath();
        ctx.ellipse(px, py, 2 + rng() * 3, 1.2 + rng() * 2, rng() * Math.PI, 0, Math.PI * 2);
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
      const bx = cx * CELL_SIZE, by = cy * CELL_SIZE;
      // Ripple highlights — more, varied curvature.
      for (let k = 0; k < 5; k++) {
        const x = bx + rng() * CELL_SIZE, y = by + rng() * CELL_SIZE;
        ctx.strokeStyle = `rgba(150,185,205,${0.14 + rng() * 0.14})`;
        ctx.lineWidth = 0.6 + rng() * 0.6;
        ctx.beginPath();
        ctx.arc(x, y, 1.2 + rng() * 2.5, rng() * Math.PI, rng() * Math.PI + 1.5 + rng());
        ctx.stroke();
      }
      // Deep-water darken (center of large water bodies).
      const edges = [!isWater(grid, cx - 1, cy), !isWater(grid, cx + 1, cy), !isWater(grid, cx, cy - 1), !isWater(grid, cx, cy + 1)];
      const shore = edges.some(Boolean);
      if (!shore) {
        ctx.fillStyle = "rgba(20,35,50,0.12)";
        ctx.fillRect(bx, by, CELL_SIZE, CELL_SIZE);
      }
      // Lighter shoreline where water meets land.
      if (shore) {
        ctx.fillStyle = "rgba(120,155,155,0.22)";
        ctx.fillRect(bx, by, CELL_SIZE, CELL_SIZE);
        // Cattails / reeds at shoreline.
        if (rng() < 0.45) {
          const n = 2 + Math.floor(rng() * 3);
          for (let k = 0; k < n; k++) {
            const rx = bx + rng() * CELL_SIZE, ry = by + rng() * CELL_SIZE;
            ctx.strokeStyle = `rgba(75,88,42,${0.4 + rng() * 0.25})`;
            ctx.lineWidth = 0.7;
            ctx.beginPath();
            ctx.moveTo(rx, ry);
            ctx.lineTo(rx + (rng() - 0.5) * 2, ry - 3 - rng() * 3);
            ctx.stroke();
            // Cattail head (small dark oval at top of some).
            if (rng() < 0.4) {
              ctx.fillStyle = "rgba(60,40,25,0.6)";
              ctx.beginPath();
              ctx.ellipse(rx + (rng() - 0.5), ry - 4.5 - rng() * 2, 0.6, 1.2, 0, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
      }
    }
  }
}

function drawWoods(ctx: CanvasRenderingContext2D, grid: Grid, rng: () => number): void {
  // Leaf litter on the forest floor before trees go up — dead leaves, twigs, and
  // dappled light patches that make the ground under the canopy read differently.
  for (let cy = 0; cy < grid.height; cy++) {
    for (let cx = 0; cx < grid.width; cx++) {
      if (grid.get(cx, cy) !== Terrain.Woods) continue;
      const bx = cx * CELL_SIZE, by = cy * CELL_SIZE;
      for (let k = 0; k < 5; k++) {
        const lx = bx + rng() * CELL_SIZE, ly = by + rng() * CELL_SIZE;
        const s = 0.5 + rng() * 1.4;
        ctx.fillStyle = `hsla(${35 + rng() * 20},20%,${22 + rng() * 14}%,${0.25 + rng() * 0.2})`;
        ctx.beginPath();
        ctx.ellipse(lx, ly, s, s * 0.6, rng() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      }
      // Dappled sunlight patch (rare bright spot where canopy gaps).
      if (rng() < 0.15) {
        const dx = bx + rng() * CELL_SIZE, dy = by + rng() * CELL_SIZE;
        ctx.fillStyle = `rgba(140,145,70,${0.08 + rng() * 0.06})`;
        ctx.beginPath();
        ctx.ellipse(dx, dy, 2 + rng() * 3, 1.5 + rng() * 2, rng() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // Collect tree positions: varied sizes and shapes.
  const trees: { x: number; y: number; r: number; hue: number; conifer: boolean }[] = [];
  for (let cy = 0; cy < grid.height; cy++) {
    for (let cx = 0; cx < grid.width; cx++) {
      if (grid.get(cx, cy) !== Terrain.Woods) continue;
      const count = 2 + Math.floor(rng() * 2);
      for (let k = 0; k < count; k++) {
        trees.push({
          x: (cx + rng()) * CELL_SIZE,
          y: (cy + rng()) * CELL_SIZE,
          r: CELL_SIZE * (0.4 + rng() * 0.35),
          hue: 72 + Math.floor(rng() * 36),
          conifer: rng() < 0.2,
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
  // Canopies — deciduous get a round blob, conifers a slightly pointed smaller shape.
  for (const t of trees) {
    const r = t.conifer ? t.r * 0.7 : t.r;
    const sat = t.conifer ? 48 : 38;
    const g = ctx.createRadialGradient(
      t.x + SUN.x * r * 0.4,
      t.y + SUN.y * r * 0.4,
      r * 0.15,
      t.x,
      t.y,
      r,
    );
    g.addColorStop(0, `hsl(${t.hue},${sat}%,42%)`);
    g.addColorStop(0.7, `hsl(${t.hue},${sat + 4}%,28%)`);
    g.addColorStop(1, `hsl(${t.hue},${sat + 7}%,18%)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(t.x, t.y, r, 0, Math.PI * 2);
    ctx.fill();
    // Canopy edge texture: a few small bumps breaking the perfect circle.
    for (let b = 0; b < 4; b++) {
      const a = rng() * Math.PI * 2;
      const br = r * (0.2 + rng() * 0.25);
      ctx.fillStyle = `hsl(${t.hue},${sat}%,${24 + rng() * 12}%)`;
      ctx.beginPath();
      ctx.arc(t.x + Math.cos(a) * r * 0.7, t.y + Math.sin(a) * r * 0.7, br, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawRubble(ctx: CanvasRenderingContext2D, grid: Grid, rng: () => number): void {
  for (let cy = 0; cy < grid.height; cy++) {
    for (let cx = 0; cx < grid.width; cx++) {
      if (grid.get(cx, cy) !== Terrain.Rubble) continue;
      const bx = cx * CELL_SIZE, by = cy * CELL_SIZE;
      // Stone chunks — varied sizes and shapes.
      for (let k = 0; k < 8; k++) {
        const x = bx + rng() * CELL_SIZE, y = by + rng() * CELL_SIZE;
        const w = 1 + rng() * 3, h = 0.8 + rng() * 2;
        ctx.fillStyle = `rgba(30,26,22,0.3)`;
        ctx.save();
        ctx.translate(x + 0.8, y + 0.8);
        ctx.rotate(rng() * Math.PI);
        ctx.fillRect(-w / 2, -h / 2, w, h);
        ctx.fillStyle = `hsl(${30 + rng() * 20},${10 + rng() * 10}%,${40 + rng() * 22}%)`;
        ctx.translate(-0.8, -0.8);
        ctx.fillRect(-w / 2, -h / 2, w, h);
        ctx.restore();
      }
      // Rebar / twisted metal (dark thin lines sticking out at angles).
      if (rng() < 0.4) {
        const rx = bx + rng() * CELL_SIZE, ry = by + rng() * CELL_SIZE;
        ctx.strokeStyle = `rgba(55,48,42,${0.45 + rng() * 0.25})`;
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        const len = 3 + rng() * 5;
        const ang = rng() * Math.PI;
        ctx.moveTo(rx, ry);
        ctx.quadraticCurveTo(rx + Math.cos(ang) * len * 0.5, ry + Math.sin(ang) * len * 0.5 - 2, rx + Math.cos(ang) * len, ry + Math.sin(ang) * len);
        ctx.stroke();
      }
      // Dust patch.
      if (rng() < 0.3) {
        const dx = bx + rng() * CELL_SIZE, dy = by + rng() * CELL_SIZE;
        ctx.fillStyle = `rgba(110,98,78,${0.12 + rng() * 0.1})`;
        ctx.beginPath();
        ctx.ellipse(dx, dy, 2.5 + rng() * 3, 1.5 + rng() * 2, rng() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

// Soft burn scars on the turf — where fire or HE has scorched the ground black.
function drawScorch(ctx: CanvasRenderingContext2D, grid: Grid, rng: () => number): void {
  const count = Math.round(grid.width * grid.height * 0.012);
  let placed = 0, tries = 0;
  while (placed < count && tries < count * 14) {
    tries++;
    const cx = Math.floor(rng() * grid.width);
    const cy = Math.floor(rng() * grid.height);
    const t = grid.get(cx, cy);
    if (t !== Terrain.Open && t !== Terrain.Grass && t !== Terrain.Road) continue;
    const x = (cx + rng()) * CELL_SIZE;
    const y = (cy + rng()) * CELL_SIZE;
    const r = CELL_SIZE * (0.6 + rng() * 1.2);
    const g = ctx.createRadialGradient(x, y, r * 0.2, x, y, r);
    g.addColorStop(0, "rgba(22,18,13,0.5)");
    g.addColorStop(0.7, "rgba(22,18,13,0.22)");
    g.addColorStop(1, "rgba(22,18,13,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * (0.7 + rng() * 0.25), rng() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
    placed++;
  }
}

// Shell craters: a scorched halo, a sunlit raised lip, a dark bowl, and ejecta streaks.
function drawCraters(ctx: CanvasRenderingContext2D, grid: Grid, rng: () => number): void {
  const count = Math.round(grid.width * grid.height * 0.011);
  let placed = 0, tries = 0;
  while (placed < count && tries < count * 14) {
    tries++;
    const cx = Math.floor(rng() * grid.width);
    const cy = Math.floor(rng() * grid.height);
    const t = grid.get(cx, cy);
    if (t !== Terrain.Open && t !== Terrain.Grass && t !== Terrain.Road) continue;
    const x = (cx + rng()) * CELL_SIZE;
    const y = (cy + rng()) * CELL_SIZE;
    crater(ctx, x, y, CELL_SIZE * (0.32 + rng() * 0.5), rng);
    placed++;
    if (rng() < 0.4) {
      // a twin impact close by — guns rarely land just one round
      crater(ctx, x + (rng() - 0.5) * CELL_SIZE * 1.8, y + (rng() - 0.5) * CELL_SIZE * 1.8,
        CELL_SIZE * (0.22 + rng() * 0.35), rng);
    }
  }
}

function crater(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, rng: () => number): void {
  // Scorched halo.
  let g = ctx.createRadialGradient(x, y, r * 0.3, x, y, r * 1.45);
  g.addColorStop(0, "rgba(18,14,10,0.5)");
  g.addColorStop(1, "rgba(18,14,10,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r * 1.45, 0, Math.PI * 2);
  ctx.fill();
  // Raised earth lip, brighter on the top-left sun side.
  ctx.lineWidth = r * 0.34;
  ctx.strokeStyle = "rgba(124,106,78,0.45)";
  ctx.beginPath();
  ctx.ellipse(x, y, r, r * 0.85, 0, 0, Math.PI * 2);
  ctx.stroke();
  // Dark bowl with a shaded inner wall.
  g = ctx.createRadialGradient(x - r * 0.25, y - r * 0.25, r * 0.1, x, y, r * 0.85);
  g.addColorStop(0, "rgba(52,43,31,0.95)");
  g.addColorStop(0.7, "rgba(28,22,16,0.95)");
  g.addColorStop(1, "rgba(40,33,24,0.6)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(x, y, r * 0.8, r * 0.66, 0, 0, Math.PI * 2);
  ctx.fill();
  // Ejecta streaks thrown clear of the rim.
  for (let i = 0; i < 5; i++) {
    const a = rng() * Math.PI * 2;
    const l = r * (1.1 + rng() * 0.9);
    ctx.strokeStyle = `rgba(28,22,16,${0.18 + rng() * 0.22})`;
    ctx.lineWidth = 0.7 + rng();
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(a) * r * 0.7, y + Math.sin(a) * r * 0.6);
    ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    ctx.stroke();
  }
}

// Scattered wreckage — splintered planks and broken brick flung across the ground.
function drawDebris(ctx: CanvasRenderingContext2D, grid: Grid, rng: () => number): void {
  const count = Math.round(grid.width * grid.height * 0.03);
  let placed = 0, tries = 0;
  while (placed < count && tries < count * 8) {
    tries++;
    const cx = Math.floor(rng() * grid.width);
    const cy = Math.floor(rng() * grid.height);
    const t = grid.get(cx, cy);
    if (t === Terrain.Water || t === Terrain.Wall || t === Terrain.Woods) continue;
    const x = (cx + rng()) * CELL_SIZE;
    const y = (cy + rng()) * CELL_SIZE;
    const n = 1 + Math.floor(rng() * 3);
    for (let k = 0; k < n; k++) {
      const px = x + (rng() - 0.5) * CELL_SIZE * 0.7;
      const py = y + (rng() - 0.5) * CELL_SIZE * 0.7;
      if (rng() < 0.5) {
        // A plank or beam.
        const len = 2 + rng() * 4.5;
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(rng() * Math.PI);
        ctx.fillStyle = "rgba(14,11,8,0.3)";
        ctx.fillRect(-len / 2 + 0.6, 0.2, len, 1.6);
        ctx.fillStyle = `hsl(30,18%,${26 + rng() * 16}%)`;
        ctx.fillRect(-len / 2, -0.8, len, 1.6);
        ctx.restore();
      } else {
        // A brick or chunk of masonry.
        const s = 1 + rng() * 1.7;
        ctx.fillStyle = "rgba(14,11,8,0.3)";
        ctx.fillRect(px + 0.6, py + 0.6, s, s);
        ctx.fillStyle = `hsl(18,26%,${34 + rng() * 16}%)`;
        ctx.fillRect(px, py, s, s);
      }
    }
    placed++;
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

// Warm Close-Combat palette: terracotta/clay/brick dominate; weathered slate is the
// rare cool note. Picked with a warm bias so a town reads warm, not grey.
const ROOF_PALETTES = [
  ["#bf6a3f", "#8f4a2a"], // terracotta tile
  ["#b07d4c", "#85562f"], // clay / tan
  ["#a85c3a", "#7e3f27"], // brick red
  ["#9c8f7a", "#766b58"], // weathered slate (lighter, uncommon)
];

function pickRoofPalette(rng: () => number, burned: boolean): string[] {
  if (burned) return ["#3a3026", "#2a221c"]; // warm dark char, not pure black
  return rng() < 0.8 ? ROOF_PALETTES[Math.floor(rng() * 3)] : ROOF_PALETTES[3];
}

// --- per-building floor + roof tiles, masked to the exact footprint cells ---

// Build both tiles for one building from its cell mask, so floor and roof line up
// cell-for-cell and nothing pokes out from under the roof.
function paintBuilding(grid: Grid, b: Building): BuildingArt {
  const W = grid.width;
  let minCx = Infinity, maxCx = -Infinity, minCy = Infinity, maxCy = -Infinity;
  for (const idx of b.cells) {
    const cx = idx % W, cy = (idx / W) | 0;
    if (cx < minCx) minCx = cx; if (cx > maxCx) maxCx = cx;
    if (cy < minCy) minCy = cy; if (cy > maxCy) maxCy = cy;
  }
  const seed = ((minCx * 92837) ^ (minCy * 689287)) >>> 0;
  const floor = paintFloorTile(grid, b.cells, minCx, minCy, maxCx, maxCy);
  const roof = paintRoofTile(b, minCx, minCy, maxCx, maxCy, mulberry32(seed));
  return { floor, roof, cells: b.cells };
}

function paintFloorTile(grid: Grid, cells: number[], minCx: number, minCy: number, maxCx: number, maxCy: number): Tile {
  const SS = 2;
  const W = grid.width;
  const x0 = minCx * CELL_SIZE, y0 = minCy * CELL_SIZE;
  const w = (maxCx - minCx + 1) * CELL_SIZE, h = (maxCy - minCy + 1) * CELL_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(w * SS);
  canvas.height = Math.ceil(h * SS);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(SS, SS);
  ctx.translate(-x0, -y0);
  const fRng = mulberry32((((minCx + 7) * 40503) ^ ((minCy + 13) * 12289)) >>> 0);
  // 1. Floorboards under every interior cell — including under interior partition walls,
  //    so rooms read as open floor split by thin dividers rather than a maze of blocks.
  for (const idx of cells) {
    const t = grid.cells[idx], cx = idx % W, cy = (idx / W) | 0;
    if (t === Terrain.Floor || t === Terrain.Window || (t === Terrain.Wall && !isExteriorWall(grid, cx, cy))) {
      drawFloorCell(ctx, grid, cx, cy);
    }
  }
  // 2. Solid stone only for the outer perimeter walls.
  for (const idx of cells) {
    const cx = idx % W, cy = (idx / W) | 0;
    if (grid.cells[idx] === Terrain.Wall && isExteriorWall(grid, cx, cy)) drawWallCell(ctx, cx, cy);
  }
  // 3. Interior walls as thin partition bars over the floor.
  for (const idx of cells) {
    const cx = idx % W, cy = (idx / W) | 0;
    if (grid.cells[idx] === Terrain.Wall && !isExteriorWall(grid, cx, cy)) drawInteriorWall(ctx, grid, cx, cy);
  }
  // 4. Windows punched through the perimeter.
  for (const idx of cells) {
    if (grid.cells[idx] === Terrain.Window) drawWindowCell(ctx, idx % W, (idx / W) | 0);
  }
  // 5. A sparse scatter of furniture.
  for (const idx of cells) {
    if (grid.cells[idx] === Terrain.Floor && fRng() < 0.05) drawFurniture(ctx, idx % W, (idx / W) | 0, fRng);
  }
  return { canvas, x: x0, y: y0, scale: 1 / SS };
}

function paintRoofTile(b: Building, minCx: number, minCy: number, maxCx: number, maxCy: number, rng: () => number): Tile {
  const SS = 2;
  const M = CELL_SIZE; // margin for eave / chimney overhang
  const x0 = minCx * CELL_SIZE - M, y0 = minCy * CELL_SIZE - M;
  const w = (maxCx - minCx + 1) * CELL_SIZE + 2 * M, h = (maxCy - minCy + 1) * CELL_SIZE + 2 * M;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(w * SS);
  canvas.height = Math.ceil(h * SS);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(SS, SS);
  ctx.translate(-x0, -y0);
  const area = (maxCx - minCx + 1) * (maxCy - minCy + 1);
  const isRect = b.cells.length === area; // a solid rectangle fills its whole bbox
  // Only small houses burn out, and rarely — a town shouldn't be a field of char.
  const burned = rng() < 0.1 && b.cells.length < 40;
  if (isRect) drawPitchedRoof(ctx, minCx, minCy, maxCx + 1, maxCy + 1, rng, burned);
  else drawFlatRoof(ctx, b, rng, burned);
  return { canvas, x: x0, y: y0, scale: 1 / SS };
}

function drawBuildingShadow(ctx: CanvasRenderingContext2D, b: Building): void {
  const lift = 3 + b.levels * 2.5;
  ctx.save();
  ctx.filter = "blur(4px)";
  ctx.fillStyle = "rgba(15,15,12,0.32)"; // lighter so dense blocks don't merge to mud
  const rect = asAxisRect(b.poly);
  if (rect) {
    const x = rect.x0 * CELL_SIZE, y = rect.y0 * CELL_SIZE;
    ctx.fillRect(x - SUN.x * lift, y - SUN.y * lift, (rect.x1 - rect.x0) * CELL_SIZE, (rect.y1 - rect.y0) * CELL_SIZE);
  } else {
    const pts = b.poly.map((p) => [p.x * CELL_SIZE, p.y * CELL_SIZE] as [number, number]);
    poly2(ctx, pts.map(([x, y]) => [x - SUN.x * lift, y - SUN.y * lift] as [number, number]));
  }
  ctx.restore();
}

// Worn floorboards: continuous planks (keyed to absolute coords so they run the length
// of a room instead of resetting per cell), with a soft shadow where a wall abuts.
function drawFloorCell(ctx: CanvasRenderingContext2D, grid: Grid, cx: number, cy: number): void {
  const x = cx * CELL_SIZE, y = cy * CELL_SIZE;
  ctx.fillStyle = "#6a5942";
  ctx.fillRect(x, y, CELL_SIZE, CELL_SIZE);
  const first = Math.ceil(y / 6) * 6;
  for (let ly = first; ly < y + CELL_SIZE; ly += 6) {
    ctx.fillStyle = (((ly / 6) | 0) & 1) ? "rgba(0,0,0,0.07)" : "rgba(255,235,200,0.045)";
    ctx.fillRect(x, ly, CELL_SIZE, 3);
    ctx.strokeStyle = "rgba(30,22,14,0.35)";
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(x, ly);
    ctx.lineTo(x + CELL_SIZE, ly);
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  if (grid.get(cx - 1, cy) === Terrain.Wall) ctx.fillRect(x, y, 2, CELL_SIZE);
  if (grid.get(cx + 1, cy) === Terrain.Wall) ctx.fillRect(x + CELL_SIZE - 2, y, 2, CELL_SIZE);
  if (grid.get(cx, cy - 1) === Terrain.Wall) ctx.fillRect(x, y, CELL_SIZE, 2);
  if (grid.get(cx, cy + 1) === Terrain.Wall) ctx.fillRect(x, y + CELL_SIZE - 2, CELL_SIZE, 2);
}

// Perimeter wall: a beveled stone block forming the building's solid outer shell.
function drawWallCell(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  const x = cx * CELL_SIZE, y = cy * CELL_SIZE;
  ctx.fillStyle = "#6b6157";
  ctx.fillRect(x, y, CELL_SIZE, CELL_SIZE);
  // Bevel: top-left catches the light, bottom-right falls into shadow.
  ctx.fillStyle = "rgba(255,250,240,0.12)";
  ctx.fillRect(x, y, CELL_SIZE, 1.3);
  ctx.fillRect(x, y, 1.3, CELL_SIZE);
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  ctx.fillRect(x, y + CELL_SIZE - 1.3, CELL_SIZE, 1.3);
  ctx.fillRect(x + CELL_SIZE - 1.3, y, 1.3, CELL_SIZE);
}

// Interior partition: a thin plaster bar drawn along the wall's run (over the floor that
// was already painted under it), so rooms read open instead of as solid blocks. Bars in
// adjacent cells share the same offset, so a partition reads as one continuous wall.
function drawInteriorWall(ctx: CanvasRenderingContext2D, grid: Grid, cx: number, cy: number): void {
  const x = cx * CELL_SIZE, y = cy * CELL_SIZE;
  const isW = (a: number, b: number) => grid.get(a, b) === Terrain.Wall;
  const horiz = isW(cx - 1, cy) || isW(cx + 1, cy);
  const vert = isW(cx, cy - 1) || isW(cx, cy + 1);
  const th = CELL_SIZE * 0.32;
  const off = (CELL_SIZE - th) / 2;
  const bar = (rx: number, ry: number, rw: number, rh: number) => {
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fillRect(rx + 1, ry + 1, rw, rh); // soft drop shadow for depth
    ctx.fillStyle = "#9b8f7c"; // plaster
    ctx.fillRect(rx, ry, rw, rh);
    ctx.fillStyle = "rgba(255,250,240,0.14)"; // top-edge highlight
    ctx.fillRect(rx, ry, rw, 1);
  };
  if (horiz) bar(x, y + off, CELL_SIZE, th);
  if (vert) bar(x + off, y, th, CELL_SIZE);
  if (!horiz && !vert) bar(x + off, y + off, th, th); // isolated stub
}

// A window: a small recessed pane set into the wall, not a full-cell glass block.
function drawWindowCell(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  const x = cx * CELL_SIZE, y = cy * CELL_SIZE;
  ctx.fillStyle = "#6b6157"; // wall surround
  ctx.fillRect(x, y, CELL_SIZE, CELL_SIZE);
  const m = CELL_SIZE * 0.3; // deeper inset → smaller pane
  const px = x + m, py = y + m, pw = CELL_SIZE - 2 * m, ph = CELL_SIZE - 2 * m;
  ctx.fillStyle = "#241d16"; // dark frame / sill
  ctx.fillRect(px - 1, py - 1, pw + 2, ph + 2);
  ctx.fillStyle = "rgba(120,140,150,0.5)"; // muted glass
  ctx.fillRect(px, py, pw, ph);
  ctx.strokeStyle = "rgba(36,29,22,0.85)"; // single mullion
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  ctx.moveTo(x + CELL_SIZE / 2, py);
  ctx.lineTo(x + CELL_SIZE / 2, py + ph);
  ctx.stroke();
}

// One piece of furniture in a room cell — a table, bed, or crate, drawn so it reads as
// an object rather than a featureless block.
function drawFurniture(ctx: CanvasRenderingContext2D, cx: number, cy: number, rng: () => number): void {
  const x = cx * CELL_SIZE, y = cy * CELL_SIZE;
  const kind = rng();
  if (kind < 0.4) {
    // Table: a wood top with a darker inset, a slight gap from the cell edge.
    const w = CELL_SIZE * 0.62, h = CELL_SIZE * 0.46;
    const ox = x + (CELL_SIZE - w) / 2, oy = y + (CELL_SIZE - h) / 2;
    shadowRect(ctx, ox, oy, w, h);
    ctx.fillStyle = "#6e4f31";
    ctx.fillRect(ox, oy, w, h);
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.fillRect(ox + 1.5, oy + 1.5, w - 3, h - 3);
  } else if (kind < 0.72) {
    // Bed: a frame with a pale pillow at one end.
    const w = CELL_SIZE * 0.5, h = CELL_SIZE * 0.74;
    const ox = x + (CELL_SIZE - w) / 2, oy = y + (CELL_SIZE - h) / 2;
    shadowRect(ctx, ox, oy, w, h);
    ctx.fillStyle = "#7a5a3c"; // frame
    ctx.fillRect(ox, oy, w, h);
    ctx.fillStyle = "#9a8f7e"; // blanket
    ctx.fillRect(ox + 1, oy + h * 0.28, w - 2, h * 0.7 - 1);
    ctx.fillStyle = "#cfc6b6"; // pillow
    ctx.fillRect(ox + 1.5, oy + 1.5, w - 3, h * 0.24);
  } else {
    // Crate: a small boxy chest with a plank line.
    const s = CELL_SIZE * 0.42;
    const ox = x + (CELL_SIZE - s) / 2, oy = y + (CELL_SIZE - s) / 2;
    shadowRect(ctx, ox, oy, s, s);
    ctx.fillStyle = "#5d4a32";
    ctx.fillRect(ox, oy, s, s);
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(ox, oy + s / 2);
    ctx.lineTo(ox + s, oy + s / 2);
    ctx.stroke();
  }
}

function shadowRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.fillStyle = "rgba(8,6,4,0.3)";
  ctx.fillRect(x + 1.5, y + 1.5, w, h);
}

// A wall cell is "exterior" when an orthogonal neighbour is outside the building
// (not Wall/Floor/Window) or off the map — those face the world and cast windows.
function isExteriorWall(grid: Grid, cx: number, cy: number): boolean {
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    if (!grid.inBounds(cx + dx, cy + dy)) return true;
    const t = grid.get(cx + dx, cy + dy);
    if (t !== Terrain.Wall && t !== Terrain.Floor && t !== Terrain.Window) return true;
  }
  return false;
}

// Irregular (OSM) footprints get a low-pitch hip roof, clipped to the smooth building
// polygon (not the per-cell mask) so the roof edge reads clean instead of stair-stepped.
// The floor plan below is a separate sprite that only shows once the roof has faded, so
// the slight poly/cell mismatch at the rim is never visible.
function drawFlatRoof(ctx: CanvasRenderingContext2D, b: Building, rng: () => number, burned: boolean): void {
  const pts = b.poly.map((p) => [p.x * CELL_SIZE, p.y * CELL_SIZE] as [number, number]);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const bb = { x0, y0, x1, y1 };
  const mask = new Path2D();
  mask.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) mask.lineTo(pts[i][0], pts[i][1]);
  mask.closePath();
  const pal = pickRoofPalette(rng, burned);

  ctx.save();
  ctx.clip(mask);
  // Base: light on the sun (top-left) side, falling to shade bottom-right.
  const grad = ctx.createLinearGradient(bb.x0, bb.y0, bb.x1, bb.y1);
  grad.addColorStop(0, lightenHex(pal[0], 18));
  grad.addColorStop(0.55, pal[0]);
  grad.addColorStop(1, pal[1]);
  ctx.fillStyle = grad;
  ctx.fillRect(bb.x0, bb.y0, bb.x1 - bb.x0, bb.y1 - bb.y0);
  // Tile courses across the longer axis.
  const horiz = bb.x1 - bb.x0 >= bb.y1 - bb.y0;
  ctx.strokeStyle = "rgba(0,0,0,0.13)";
  ctx.lineWidth = 0.6;
  if (horiz) for (let ly = bb.y0 + 3; ly < bb.y1; ly += 3.5) line(ctx, bb.x0, ly, bb.x1, ly);
  else for (let lx = bb.x0 + 3; lx < bb.x1; lx += 3.5) line(ctx, lx, bb.y0, lx, bb.y1);
  // Ridge highlight down the spine.
  ctx.strokeStyle = "rgba(255,238,214,0.3)";
  ctx.lineWidth = 1.3;
  if (horiz) line(ctx, bb.x0, (bb.y0 + bb.y1) / 2, bb.x1, (bb.y0 + bb.y1) / 2);
  else line(ctx, (bb.x0 + bb.x1) / 2, bb.y0, (bb.x0 + bb.x1) / 2, bb.y1);
  if (burned) burnDamage(ctx, bb, rng);
  ctx.restore();
  // Eave: trace just the building's outer polygon (not the per-cell mask, which would
  // draw a grid) so adjacent buildings read as separate blocks.
  if (b.poly.length >= 2) {
    ctx.strokeStyle = "rgba(0,0,0,0.38)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(b.poly[0].x * CELL_SIZE, b.poly[0].y * CELL_SIZE);
    for (let i = 1; i < b.poly.length; i++) ctx.lineTo(b.poly[i].x * CELL_SIZE, b.poly[i].y * CELL_SIZE);
    ctx.closePath();
    ctx.stroke();
  }
}

// Collapsed-roof holes (open to a dark, rubble-strewn interior) and soot streaks,
// drawn inside an already-clipped building footprint. Holes are capped small so big
// footprints don't turn into black voids.
function burnDamage(ctx: CanvasRenderingContext2D, bb: { x0: number; y0: number; x1: number; y1: number }, rng: () => number): void {
  const w = bb.x1 - bb.x0;
  const h = bb.y1 - bb.y0;
  const holes = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < holes; i++) {
    const hx = bb.x0 + rng() * w;
    const hy = bb.y0 + rng() * h;
    const hr = 2 + rng() * 3; // capped, not size-scaled
    ctx.fillStyle = "rgba(30,22,15,0.82)"; // warm dark, not pure black
    ctx.beginPath();
    ctx.ellipse(hx, hy, hr, hr * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();
    for (let k = 0; k < 3; k++) {
      ctx.fillStyle = `hsl(28,10%,${22 + rng() * 16}%)`; // charred rubble
      ctx.fillRect(hx + (rng() - 0.5) * hr, hy + (rng() - 0.5) * hr, 1 + rng() * 1.5, 1 + rng() * 1.5);
    }
  }
  for (let i = 0; i < 4; i++) {
    ctx.strokeStyle = `rgba(20,14,10,${0.1 + rng() * 0.14})`;
    ctx.lineWidth = 1 + rng() * 1.5;
    const sx = bb.x0 + rng() * w;
    ctx.beginPath();
    ctx.moveTo(sx, bb.y0);
    ctx.lineTo(sx + (rng() - 0.5) * 4, bb.y1);
    ctx.stroke();
  }
}

function line(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function drawPitchedRoof(
  ctx: CanvasRenderingContext2D,
  gx0: number,
  gy0: number,
  gx1: number,
  gy1: number,
  rng: () => number,
  burned = false,
): void {
  const x = gx0 * CELL_SIZE;
  const y = gy0 * CELL_SIZE;
  const w = (gx1 - gx0) * CELL_SIZE;
  const h = (gy1 - gy0) * CELL_SIZE;

  // 2. Wall block (eaves) — a slightly larger dark base the roof sits on. A burned-out
  // shell shows blackened, soot-stained walls instead.
  ctx.fillStyle = burned ? "#3a3026" : "#5d5346";
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2);

  // 3. Pitched roof: ridge along the longer axis, two shaded faces. Charred timber tones
  // for a gutted house.
  const pal = pickRoofPalette(rng, burned);
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
    if (!burned) ridge(ctx, rx, midY, rx + rw, midY);
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
    if (!burned) ridge(ctx, midX, ry, midX, ry + rh);
  }

  // 3b. Gutted roof: punch collapse holes through to a dark interior, plus soot.
  if (burned) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(rx, ry, rw, rh);
    ctx.clip();
    burnDamage(ctx, { x0: rx, y0: ry, x1: rx + rw, y1: ry + rh }, rng);
    ctx.restore();
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
