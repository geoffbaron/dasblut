import { CELL_SIZE } from "../game/constants.ts";
import { Building, HedgeSeg, MapFeatures, Pt, WaterLineSeg } from "../game/gamemap.ts";
import { Grid } from "../game/grid.ts";
import { Terrain } from "../game/terrain.ts";
import type { Era } from "../game/world.ts";
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

// Bright, sunlit palette in the spirit of Age of Empires' hand-painted maps: lush
// saturated grass, warm sandy earth, vivid water. Each entry is a base color plus a
// second color the per-pixel noise blends toward, giving mottled, painterly ground.
const GROUND: Partial<Record<Terrain, [RGB, RGB]>> = {
  [Terrain.Open]: [rgb(0xb59d68), rgb(0x96814e)],
  [Terrain.Grass]: [rgb(0x679440), rgb(0x4f7a2e)],
  [Terrain.Woods]: [rgb(0x477232), rgb(0x365e24)],
  [Terrain.Water]: [rgb(0x3f7fa8), rgb(0x2c6089)],
  [Terrain.Road]: [rgb(0xc4aa79), rgb(0xa38a58)],
  [Terrain.Rubble]: [rgb(0x8f8474), rgb(0x746a57)],
  // Walls & hedges sit on a grassy/dirt base; structures are drawn on top.
  [Terrain.Wall]: [rgb(0x679440), rgb(0x4f7a2e)],
  [Terrain.Hedge]: [rgb(0x679440), rgb(0x4f7a2e)],
  // Fortifications: a fence sits on grass; a trench is dug earth; sandbags on scuffed dirt.
  [Terrain.Fence]: [rgb(0x679440), rgb(0x4f7a2e)],
  [Terrain.Trench]: [rgb(0x5a4a30), rgb(0x43351f)],
  [Terrain.Sandbag]: [rgb(0x9c8c5e), rgb(0x827145)],
};

// Large-scale meadow tones the grass drifts toward (see the per-pixel pass): sun-dried
// yellow-green swathes and deep lush pockets, so open country reads painterly zoomed out.
const MEADOW_WARM = rgb(0x8cab4c);
const MEADOW_DEEP = rgb(0x41682c);
// Field-parcel tones for the farmland patchwork: harvested straw stubble and rich crop green.
const STUBBLE = rgb(0xb3a05e);
const CROP_DEEP = rgb(0x3f6a2e);
// Elevation tones: high ground bakes dry and warm, hollows hold damp, deeper green.
const DRY_HIGH = rgb(0x9aa257);
const DAMP_LOW = rgb(0x44703a);

// --- Snow variant: a Bulge-winter reskin of the same terrain set. Ground disappears
// under a pale blue-white blanket; only the elevation/clump shading (already computed
// above) keeps it from reading as one flat sheet — drifts catch the light, hollows sit
// in cold shadow. Roads are packed/salted snow, water runs colder and greyer, hedges/
// walls/fences keep their ground tone since they're structures, not open ground.
const GROUND_SNOW: Partial<Record<Terrain, [RGB, RGB]>> = {
  [Terrain.Open]: [rgb(0xe4e9ee), rgb(0xc9d3da)],
  [Terrain.Grass]: [rgb(0xdde6ec), rgb(0xc0cdd6)],
  [Terrain.Woods]: [rgb(0xaebdc4), rgb(0x8fa2ac)], // snow-laden canopy floor, still shadowed
  [Terrain.Water]: [rgb(0x4a7a92), rgb(0x355d72)], // colder, greyer than the summer palette
  [Terrain.Road]: [rgb(0xa89d8f), rgb(0x867a6c)], // churned slush/mud — reads against pristine snow
  [Terrain.Rubble]: [rgb(0x9aa1a6), rgb(0x7e858a)],
  [Terrain.Wall]: [rgb(0xdde6ec), rgb(0xc0cdd6)],
  [Terrain.Hedge]: [rgb(0xdde6ec), rgb(0xc0cdd6)],
  [Terrain.Fence]: [rgb(0xdde6ec), rgb(0xc0cdd6)],
  [Terrain.Trench]: [rgb(0x5a4a30), rgb(0x43351f)], // dug earth still shows through
  [Terrain.Sandbag]: [rgb(0x9c8c5e), rgb(0x827145)],
};
const MEADOW_SNOW_WARM = rgb(0xeef2f5); // wind-scoured, brighter drift
const MEADOW_SNOW_DEEP = rgb(0xb9c6cf); // settled, bluer drift
const DRY_HIGH_SNOW = rgb(0xf2f5f7); // crest catching full light
const DAMP_LOW_SNOW = rgb(0x9fb0ba); // hollow sitting in cold shadow

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

export function paintBattlefield(grid: Grid, features: MapFeatures, era: Era = "ww2", snow = false): PaintedMap {
  const groundPal = snow ? GROUND_SNOW : GROUND;
  const meadowWarm = snow ? MEADOW_SNOW_WARM : MEADOW_WARM;
  const meadowDeep = snow ? MEADOW_SNOW_DEEP : MEADOW_DEEP;
  const dryHigh = snow ? DRY_HIGH_SNOW : DRY_HIGH;
  const dampLow = snow ? DAMP_LOW_SNOW : DAMP_LOW;
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

  // --- Rolling-terrain hillshade, the Close Combat depth cue: a coarse heightfield of
  // long, gentle rises, shaded by slope against the NW sun (lit faces bright, reverse
  // slopes dim), precomputed at 1/8 resolution and bilinearly sampled per pixel so it
  // costs almost nothing in the main loop.
  const RSTEP = 8;
  const rw = Math.ceil(mapW / RSTEP) + 2;
  const rh = Math.ceil(mapH / RSTEP) + 2;
  const relief = new Float32Array(rw * rh);
  for (let ry = 0; ry < rh; ry++) {
    for (let rx = 0; rx < rw; rx++) {
      const X = rx * RSTEP, Y = ry * RSTEP;
      // Long swells plus a faint secondary undulation.
      relief[ry * rw + rx] = fbm(X * 0.0035, Y * 0.0035, seed + 131, 2) + fbm(X * 0.011, Y * 0.011, seed + 177, 2) * 0.3;
    }
  }
  const rshade = new Float32Array(rw * rh);
  const HILL = 2.6; // strength of the slope lighting
  for (let ry = 0; ry < rh; ry++) {
    for (let rx = 0; rx < rw; rx++) {
      const i0 = ry * rw + rx;
      const hL = relief[ry * rw + Math.max(0, rx - 1)];
      const hR = relief[ry * rw + Math.min(rw - 1, rx + 1)];
      const hU = relief[Math.max(0, ry - 1) * rw + rx];
      const hD = relief[Math.min(rh - 1, ry + 1) * rw + rx];
      // Height rising toward the SE tilts the face toward the NW light → brighter.
      const s = 1 + ((hR - hL) * 0.6 + (hD - hU) * 0.8) * HILL;
      rshade[i0] = Math.max(0.8, Math.min(1.16, s));
    }
  }

  for (let py = 0; py < mapH; py++) {
    for (let px = 0; px < mapW; px++) {
      // Warp the sampling point so cell boundaries become wavy, not gridded; the extra
      // high-frequency jitter dithers each boundary into a speckled AoE-style blend band
      // (pixels of each terrain scatter a few px into the neighbor) instead of a clean line.
      const jit = (valueNoise(px * 0.6, py * 0.6, seed + 41) - 0.5) * 7;
      const wx = px + (valueNoise(px * 0.05, py * 0.05, seed) - 0.5) * 2 * warpAmp + jit;
      const wy = py + (valueNoise(px * 0.05, py * 0.05, seed + 99) - 0.5) * 2 * warpAmp - jit;
      let cx = Math.floor(wx / CELL_SIZE);
      let cy = Math.floor(wy / CELL_SIZE);
      if (cx < 0) cx = 0;
      else if (cx >= grid.width) cx = grid.width - 1;
      if (cy < 0) cy = 0;
      else if (cy >= grid.height) cy = grid.height - 1;

      const terrain = grid.get(cx, cy);
      const pair = groundPal[terrain] ?? groundPal[Terrain.Grass]!;
      // Two scales of noise: fine mottle + broad patches.
      const fine = valueNoise(px * 0.18, py * 0.18, seed + 7);
      const broad = fbm(px * 0.012, py * 0.012, seed + 23, 2);
      const t = fine * 0.45 + broad * 0.55;
      let shade = 0.88 + t * 0.34; // bright but with real contrast, so the ground has grain
      shade *= 0.96 + broad * 0.08;
      // Mid-frequency clumps: light/dark dapples a couple of cells wide, so the ground
      // reads as real turf relief (hummocks, worn dips) — strong enough to see while playing.
      const clump = valueNoise(px * 0.06, py * 0.06, seed + 55);
      shade *= 0.89 + clump * 0.22;

      // Hillshade + elevation: bilinear-sample the precomputed relief so the whole map
      // rolls — sunlit rises, dim reverse slopes — like Close Combat's photographed ground.
      // The height itself also feeds a subtle tint below (dry crests, damp hollows).
      const rxf = px / RSTEP, ryf = py / RSTEP;
      const rx0 = rxf | 0, ry0 = ryf | 0;
      const rfx = rxf - rx0, rfy = ryf - ry0;
      const ri = ry0 * rw + rx0;
      const w00 = (1 - rfx) * (1 - rfy), w10 = rfx * (1 - rfy), w01 = (1 - rfx) * rfy, w11 = rfx * rfy;
      shade *= rshade[ri] * w00 + rshade[ri + 1] * w10 + rshade[ri + rw] * w01 + rshade[ri + rw + 1] * w11;
      const hgt = relief[ri] * w00 + relief[ri + 1] * w10 + relief[ri + rw] * w01 + relief[ri + rw + 1] * w11;

      const i = (py * mapW + px) * 4;
      let c = mix(pair[0], pair[1], t);
      // Grass gets very-large-scale meadow patches — swathes drift toward sunlit
      // yellow-green or deep lush green, so open country reads painterly from any
      // zoom instead of one flat green carpet.
      if (terrain === Terrain.Grass || terrain === Terrain.Woods || terrain === Terrain.Wall || terrain === Terrain.Hedge) {
        const m = fbm(px * 0.006, py * 0.006, seed + 77, 2);
        c = mix(c, m > 0.5 ? meadowWarm : meadowDeep, Math.min(0.7, Math.abs(m - 0.5) * 2.2));
        // Elevation tint: crests bake dry and warm, hollows hold damp deeper green (or,
        // under snow, a sunlit crest vs. a cold blue-shadowed hollow) — the contour
        // banding that makes the relief legible even where the slopes flatten out.
        c = mix(c, hgt > 0.65 ? dryHigh : dampLow, Math.min(0.22, Math.abs(hgt - 0.65) * 0.75));
      }
      // Farmland patchwork: open country is a quilt of field parcels — some straw stubble,
      // some rich crop, some ploughed with directional furrows — with boundaries that wander
      // (they reuse the warped lookup). This is the countryside texture CC maps live on.
      // Buried under snow cover, so skipped entirely for the snow variant.
      if (!snow && (terrain === Terrain.Grass || terrain === Terrain.Open)) {
        const FIELD = CELL_SIZE * 15; // 15-cell parcels — the same lattice orchards & bocage use
        let fh = ((Math.floor(wx / FIELD) * 374761393 + Math.floor(wy / FIELD) * 668265263 + seed * 69069) >>> 0);
        fh = (fh ^ (fh >>> 13)) >>> 0;
        fh = (fh * 1274126177) >>> 0;
        const kind = (fh >>> 8) & 255;       // which crop this parcel grows
        const angBits = (fh >>> 16) & 3;     // furrow direction
        if (kind < 70) c = mix(c, STUBBLE, 0.2);        // harvested stubble
        else if (kind < 130) c = mix(c, CROP_DEEP, 0.14); // lush crop
        if (kind >= 180) { // ploughed: fine parallel furrows catching the light
          const ang = 0.15 + angBits * 0.42;
          const s = Math.sin((px * Math.cos(ang) + py * Math.sin(ang)) * 0.85 + fh);
          shade *= 1 + s * 0.05;
        }
      }
      // Per-pixel film grain — a fast hash gives every pixel a tiny random light/dark
      // kick, so no area is ever a dead-flat fill. This fine grit is what makes AoE2
      // and Close Combat maps read as painted/photographic rather than vector-clean.
      let hgrain = (px * 374761393 + py * 668265263 + seed * 1103515245) >>> 0;
      hgrain = (hgrain ^ (hgrain >>> 13)) >>> 0;
      const grain = 1 + ((hgrain & 255) / 255 - 0.5) * 0.16; // ±8%
      data[i] = clamp8(c.r * shade * grain);
      data[i + 1] = clamp8(c.g * shade * grain);
      data[i + 2] = clamp8(c.b * shade * grain);
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
  // A dense scatter of small gritty props — pebbles, dirt clods, dry-grass patches,
  // molehills, twigs — so no patch of ground is ever bare.
  scatterGrit(ctx, grid, rng);
  // Orchard parcels: neat rows of small fruit trees on some fields.
  drawOrchards(ctx, grid, rng, seed);
  // Road ruts.
  drawRoadRuts(ctx, grid, rng);
  // A smooth vector ribbon along the real watercourse centreline, painted before the
  // per-cell ripple/shore detail below — a narrow river/stream is only 1-3 cells wide,
  // so its raster edge stair-steps badly on a diagonal course (the same problem roads
  // had). The ribbon covers that blocky edge with a clean curve; the per-cell pass then
  // lays ripples, foam and reeds on top exactly as it already did.
  for (const wl of features.waterLines) drawWaterLine(ctx, wl);
  // Water ripples + shoreline.
  drawWater(ctx, grid, rng, snow);
  // Battle scars: scorched ground, shell craters, and scattered debris. Drawn on the
  // open ground (under trees/buildings) so the field reads as fought-over, not pristine.
  drawScorch(ctx, grid, rng);
  drawCraters(ctx, grid, rng);
  drawDebris(ctx, grid, rng);
  // Woods canopy (the big visual win) and rubble debris.
  drawWoods(ctx, grid, rng, snow);
  drawRubble(ctx, grid, rng);
  // Field fortifications (trenches/ditches, fences, sandbag emplacements) if placed.
  drawFortifications(ctx, grid, rng);
  // Bocage hedgerows.
  for (const h of features.hedges) drawHedge(ctx, h, rng, snow);
  // Buildings: only the cast shadows go into the static ground. The floor plan and the
  // roof are each their own masked tile (below), so they always line up and the floor
  // never pokes blocks out from under the roof.
  for (const b of features.buildings) drawBuildingShadow(ctx, b);
  // Global grade: soft vignette.
  drawVignette(ctx, mapW, mapH);

  const buildings = features.buildings.map((b) => paintBuilding(grid, b, era, snow));

  return { canvas, scale: 1 / SS, buildings };
}

// ---------------------------------------------------------------------------

// A dense, varied scatter of small ground props across all walkable terrain — the fine
// clutter that makes AoE2 / Close Combat maps feel like real dirt rather than a colored
// fill. Each cell rolls a handful of independent small features.
function scatterGrit(ctx: CanvasRenderingContext2D, grid: Grid, rng: () => number): void {
  for (let cy = 0; cy < grid.height; cy++) {
    for (let cx = 0; cx < grid.width; cx++) {
      const t = grid.get(cx, cy);
      if (t !== Terrain.Grass && t !== Terrain.Open && t !== Terrain.Road) continue;
      const bx = cx * CELL_SIZE, by = cy * CELL_SIZE;
      const grassy = t === Terrain.Grass;

      // Pebbles: a little cluster of tiny lit stones with a dark side.
      if (rng() < (grassy ? 0.35 : 0.7)) {
        const n = 1 + Math.floor(rng() * 3);
        for (let k = 0; k < n; k++) {
          const x = bx + rng() * CELL_SIZE, y = by + rng() * CELL_SIZE;
          const s = 0.5 + rng() * 1.3;
          ctx.fillStyle = "rgba(20,16,12,0.28)"; // shadow to SE
          ctx.beginPath(); ctx.ellipse(x + 0.5, y + 0.5, s, s * 0.75, 0, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = `hsl(${34 + rng() * 16},${8 + rng() * 10}%,${44 + rng() * 22}%)`;
          ctx.beginPath(); ctx.ellipse(x, y, s, s * 0.75, 0, 0, Math.PI * 2); ctx.fill();
        }
      }
      // Dirt clod / bare-earth smudge — darker where turf has worn through.
      if (rng() < (grassy ? 0.22 : 0.35)) {
        const x = bx + rng() * CELL_SIZE, y = by + rng() * CELL_SIZE;
        const r = 1.5 + rng() * 3.5;
        const g = ctx.createRadialGradient(x, y, r * 0.2, x, y, r);
        g.addColorStop(0, `rgba(74,60,40,${0.16 + rng() * 0.14})`);
        g.addColorStop(1, "rgba(74,60,40,0)");
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.ellipse(x, y, r, r * (0.6 + rng() * 0.3), rng() * Math.PI, 0, Math.PI * 2); ctx.fill();
      }
      // Dry / dead grass fleck — pale straw scattered over green.
      if (grassy && rng() < 0.4) {
        const x = bx + rng() * CELL_SIZE, y = by + rng() * CELL_SIZE;
        ctx.strokeStyle = `hsla(${44 + rng() * 12},40%,${52 + rng() * 16}%,${0.3 + rng() * 0.25})`;
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        for (let b = 0; b < 2; b++) {
          ctx.moveTo(x + (rng() - 0.5) * 1.4, y);
          ctx.lineTo(x + (rng() - 0.5) * 2.4, y - 1.8 - rng() * 2);
        }
        ctx.stroke();
      }
      // Twig / dead stick.
      if (rng() < 0.14) {
        const x = bx + rng() * CELL_SIZE, y = by + rng() * CELL_SIZE;
        const len = 2 + rng() * 3.5, a = rng() * Math.PI;
        ctx.strokeStyle = `hsla(30,24%,${22 + rng() * 12}%,${0.4 + rng() * 0.2})`;
        ctx.lineWidth = 0.6 + rng() * 0.4;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
        ctx.stroke();
      }
      // Molehill / dirt mound on grass — a small lit-topped dark heap.
      if (grassy && rng() < 0.03) {
        const x = bx + rng() * CELL_SIZE, y = by + rng() * CELL_SIZE;
        const r = 2 + rng() * 2;
        ctx.fillStyle = "rgba(18,14,10,0.3)";
        ctx.beginPath(); ctx.ellipse(x + 1, y + 1.2, r, r * 0.6, 0, 0, Math.PI * 2); ctx.fill();
        const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, 0.5, x, y, r);
        g.addColorStop(0, "#6a5236");
        g.addColorStop(1, "#3e301e");
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.6, 0, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
}

// Orchards: some field parcels are planted with fruit trees in neat rows — small regular
// canopies with soft shadows, straight off a CC Normandy map. Uses the same parcel hash as
// the per-pixel patchwork (the 130-154 "kind" band, left untinted there) so art and parcels
// agree. Purely decorative: trees only go on open grass/dirt cells, so roads, water and
// buildings stay clear.
function drawOrchards(ctx: CanvasRenderingContext2D, grid: Grid, rng: () => number, seed: number): void {
  const FIELD = CELL_SIZE * 15;
  const cols = Math.ceil((grid.width * CELL_SIZE) / FIELD);
  const rows = Math.ceil((grid.height * CELL_SIZE) / FIELD);
  for (let pj = 0; pj < rows; pj++) {
    for (let pi = 0; pi < cols; pi++) {
      let fh = ((pi * 374761393 + pj * 668265263 + seed * 69069) >>> 0);
      fh = (fh ^ (fh >>> 13)) >>> 0;
      fh = (fh * 1274126177) >>> 0;
      const kind = (fh >>> 8) & 255;
      if (kind < 130 || kind >= 155) continue; // ~10% of parcels are orchards
      const alongX = ((fh >>> 16) & 1) === 0; // planting-row direction
      const SP = CELL_SIZE * 2.2;  // tree spacing within a row
      const ROW = CELL_SIZE * 2.7; // spacing between rows
      const x0 = pi * FIELD + CELL_SIZE, y0 = pj * FIELD + CELL_SIZE; // margin off the lattice
      const x1 = (pi + 1) * FIELD - CELL_SIZE, y1 = (pj + 1) * FIELD - CELL_SIZE;
      for (let ty = y0; ty < y1; ty += alongX ? ROW : SP) {
        for (let tx = x0; tx < x1; tx += alongX ? SP : ROW) {
          const ox = tx + (rng() - 0.5) * 5, oy = ty + (rng() - 0.5) * 5;
          const cx = Math.floor(ox / CELL_SIZE), cy = Math.floor(oy / CELL_SIZE);
          if (!grid.inBounds(cx, cy)) continue;
          const t = grid.get(cx, cy);
          if (t !== Terrain.Grass && t !== Terrain.Open) continue;
          const r = CELL_SIZE * (0.24 + rng() * 0.08);
          ctx.fillStyle = "rgba(20,28,14,0.3)"; // soft shadow to the SE
          ctx.beginPath();
          ctx.ellipse(ox - SUN.x * r * 0.8, oy - SUN.y * r * 0.8, r * 0.95, r * 0.8, 0, 0, Math.PI * 2);
          ctx.fill();
          const hue = 78 + rng() * 20; // fruit trees run a touch yellower than forest
          const g = ctx.createRadialGradient(ox + SUN.x * r * 0.4, oy + SUN.y * r * 0.4, r * 0.15, ox, oy, r);
          g.addColorStop(0, `hsl(${hue},50%,50%)`);
          g.addColorStop(1, `hsl(${hue},55%,26%)`);
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(ox, oy, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }
}

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
          const hue = 84 + Math.floor(rng() * 30);
          const light = 38 + Math.floor(rng() * 18);
          ctx.strokeStyle = `hsla(${hue},52%,${light}%,0.5)`;
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
  const isRoad = (x: number, y: number) => grid.inBounds(x, y) && grid.get(x, y) === Terrain.Road;
  for (let cy = 0; cy < grid.height; cy++) {
    for (let cx = 0; cx < grid.width; cx++) {
      if (grid.get(cx, cy) !== Terrain.Road) continue;
      const bx = cx * CELL_SIZE, by = cy * CELL_SIZE;

      // Verge wear: a soft dark grime concentrated where the road meets the fields, so
      // the track sits INTO the land (CC roads are grimed at the shoulders, not pasted
      // on). Scattered speckle rather than a stroked line along the cell edge — a single
      // straight per-cell edge is exactly what turns a diagonal road into a staircase (a
      // hard, grid-aligned stroke has nowhere to hide the quantization the way an
      // irregular scatter does).
      const edges: [number, number][] = [];
      if (!isRoad(cx, cy - 1)) edges.push([0, -1]);
      if (!isRoad(cx, cy + 1)) edges.push([0, 1]);
      if (!isRoad(cx - 1, cy)) edges.push([-1, 0]);
      if (!isRoad(cx + 1, cy)) edges.push([1, 0]);
      for (const [ex, ey] of edges) {
        for (let k = 0; k < 3; k++) {
          const along = rng() * CELL_SIZE;
          const depth = 1 + rng() * 3.5; // how far the grime creeps in from the verge
          const px = bx + (ex === 0 ? along : ex > 0 ? CELL_SIZE - depth : depth);
          const py = by + (ey === 0 ? along : ey > 0 ? CELL_SIZE - depth : depth);
          ctx.fillStyle = `rgba(58,48,32,${0.14 + rng() * 0.1})`;
          ctx.beginPath();
          ctx.ellipse(px, py, 1 + rng() * 1.4, 0.7 + rng() * 1, rng() * Math.PI, 0, Math.PI * 2);
          ctx.fill();
        }
      }
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

// One segment of a real watercourse centreline, stroked as a solid ribbon a shade under
// the rasterized width so it sits inside the raster water without spilling onto land.
// Round caps/joins mean consecutive segments of the same way connect into one smooth
// curve — real OSM rivers already have plenty of vertices, so this reads as a natural
// winding course rather than the grid's staircase.
function drawWaterLine(ctx: CanvasRenderingContext2D, seg: WaterLineSeg): void {
  const width = (seg.w * 2 + 1) * CELL_SIZE * 0.92;
  ctx.strokeStyle = "#356f97"; // between the two GROUND[Water] stops
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(seg.x0 * CELL_SIZE, seg.y0 * CELL_SIZE);
  ctx.lineTo(seg.x1 * CELL_SIZE, seg.y1 * CELL_SIZE);
  ctx.stroke();
}

function drawWater(ctx: CanvasRenderingContext2D, grid: Grid, rng: () => number, snow = false): void {
  for (let cy = 0; cy < grid.height; cy++) {
    for (let cx = 0; cx < grid.width; cx++) {
      if (grid.get(cx, cy) !== Terrain.Water) continue;
      const bx = cx * CELL_SIZE, by = cy * CELL_SIZE;
      // Woven wave bands: paired dark/light horizontal strokes give the surface the
      // patterned, textile-like water texture AoE maps have.
      for (let k = 0; k < 2; k++) {
        const x = bx + rng() * CELL_SIZE, y = by + rng() * CELL_SIZE;
        const len = 5 + rng() * 8;
        ctx.strokeStyle = `rgba(20,50,85,${0.12 + rng() * 0.1})`;
        ctx.lineWidth = 1.0 + rng() * 0.5;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.quadraticCurveTo(x + len / 2, y + (rng() - 0.5) * 1.5, x + len, y);
        ctx.stroke();
        ctx.strokeStyle = `rgba(150,195,220,${0.1 + rng() * 0.08})`;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(x + 1, y + 1.2);
        ctx.quadraticCurveTo(x + 1 + len / 2, y + 1.2 + (rng() - 0.5) * 1.5, x + 1 + len, y + 1.2);
        ctx.stroke();
      }
      // Sparkling ripple highlights — brighter, sunnier water.
      for (let k = 0; k < 3; k++) {
        const x = bx + rng() * CELL_SIZE, y = by + rng() * CELL_SIZE;
        ctx.strokeStyle = `rgba(180,215,235,${0.18 + rng() * 0.16})`;
        ctx.lineWidth = 0.6 + rng() * 0.6;
        ctx.beginPath();
        ctx.arc(x, y, 1.2 + rng() * 2.5, rng() * Math.PI, rng() * Math.PI + 1.5 + rng());
        ctx.stroke();
      }
      // Deep-water saturate (center of large water bodies) — richer blue, not murk. A
      // feathered radial wash rather than a flat cell-rect: overlapping softly with its
      // neighbours, it blends across cells instead of stair-stepping a diagonal shore.
      const edges = [!isWater(grid, cx - 1, cy), !isWater(grid, cx + 1, cy), !isWater(grid, cx, cy - 1), !isWater(grid, cx, cy + 1)];
      const shore = edges.some(Boolean);
      const wash = (color: string, alpha: number) => {
        const gr = ctx.createRadialGradient(bx + CELL_SIZE / 2, by + CELL_SIZE / 2, 0, bx + CELL_SIZE / 2, by + CELL_SIZE / 2, CELL_SIZE * 0.95);
        gr.addColorStop(0, `rgba(${color},${alpha})`);
        gr.addColorStop(1, `rgba(${color},0)`);
        ctx.fillStyle = gr;
        ctx.fillRect(bx - CELL_SIZE * 0.5, by - CELL_SIZE * 0.5, CELL_SIZE * 2, CELL_SIZE * 2);
      };
      if (!shore) wash(snow ? "20,45,60" : "18,55,95", 0.22);
      // Shoreline: a shallow-water tint (sandy in summer, icy grey-white in snow) plus a
      // broken white foam line hugging the land edge — the classic bright coast read.
      // Foam is scattered dabs biased toward the shore edge rather than one stroke traced
      // along the cell boundary — a continuous per-cell-edge line is exactly what turns a
      // diagonal coast into a staircase (see the same fix applied to road verges).
      if (shore) {
        wash(snow ? "210,220,225" : "190,205,175", 0.4);
        // A cell with NO orthogonal water neighbour at all (only diagonal) is a link in a
        // 1-cell-wide diagonal run — a narrow stream/river, already covered by the smooth
        // vector ribbon drawn above. Foam scattered at its raster edges would trace that
        // same staircase the ribbon exists to hide, so skip it there; broad lake/pond
        // shores (which DO have orthogonal water neighbours) still get the full foam line.
        const isolatedDiag = edges.every(Boolean);
        const foam = (x0: number, y0: number, x1: number, y1: number) => {
          const ex = x1 === x0 ? 1 : 0, ey = y1 === y0 ? 1 : 0; // unit vector along the edge
          for (let f = 0; f < 4; f++) {
            const t = rng();
            const fx = x0 + (x1 - x0) * t + ey * (rng() - 0.5) * 3;
            const fy = y0 + (y1 - y0) * t + ex * (rng() - 0.5) * 3;
            ctx.fillStyle = `rgba(240,248,248,${0.32 + rng() * 0.28})`;
            ctx.beginPath();
            ctx.ellipse(fx, fy, 0.7 + rng() * 1.1, 0.4 + rng() * 0.6, rng() * Math.PI, 0, Math.PI * 2);
            ctx.fill();
          }
        };
        if (!isolatedDiag) {
          if (edges[0]) foam(bx + 1, by, bx + 1, by + CELL_SIZE); // land to the west
          if (edges[1]) foam(bx + CELL_SIZE - 1, by, bx + CELL_SIZE - 1, by + CELL_SIZE);
          if (edges[2]) foam(bx, by + 1, bx + CELL_SIZE, by + 1); // land to the north
          if (edges[3]) foam(bx, by + CELL_SIZE - 1, bx + CELL_SIZE, by + CELL_SIZE - 1);
        }
        // Reeds at the waterline — bare, snow-dusted stalks in winter rather than green.
        if (rng() < 0.35) {
          const n = 2 + Math.floor(rng() * 3);
          for (let k = 0; k < n; k++) {
            const rx = bx + rng() * CELL_SIZE, ry = by + rng() * CELL_SIZE;
            ctx.strokeStyle = snow ? `rgba(150,140,120,${0.4 + rng() * 0.25})` : `rgba(88,110,48,${0.45 + rng() * 0.25})`;
            ctx.lineWidth = 0.7;
            ctx.beginPath();
            ctx.moveTo(rx, ry);
            ctx.lineTo(rx + (rng() - 0.5) * 2, ry - 3 - rng() * 3);
            ctx.stroke();
          }
        }
      }
    }
  }
}

function drawWoods(ctx: CanvasRenderingContext2D, grid: Grid, rng: () => number, snow = false): void {
  // Leaf litter on the forest floor before trees go up — dead leaves, twigs, and
  // dappled light patches that make the ground under the canopy read differently.
  for (let cy = 0; cy < grid.height; cy++) {
    for (let cx = 0; cx < grid.width; cx++) {
      if (grid.get(cx, cy) !== Terrain.Woods) continue;
      const bx = cx * CELL_SIZE, by = cy * CELL_SIZE;
      for (let k = 0; k < 5; k++) {
        const lx = bx + rng() * CELL_SIZE, ly = by + rng() * CELL_SIZE;
        const s = 0.5 + rng() * 1.4;
        // Warm dead-leaf litter in summer; cold blue-grey shadow dapples under snow.
        ctx.fillStyle = snow
          ? `hsla(200,15%,${60 + rng() * 14}%,${0.2 + rng() * 0.15})`
          : `hsla(${35 + rng() * 20},20%,${22 + rng() * 14}%,${0.25 + rng() * 0.2})`;
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
  // Canopies — bright, layered crowns with a strong sunlit side so each tree reads as
  // its own rounded mass, the way AoE's forests do.
  for (const t of trees) {
    const r = t.conifer ? t.r * 0.7 : t.r;
    const sat = t.conifer ? 52 : 46;
    const g = ctx.createRadialGradient(
      t.x + SUN.x * r * 0.4,
      t.y + SUN.y * r * 0.4,
      r * 0.15,
      t.x,
      t.y,
      r,
    );
    g.addColorStop(0, `hsl(${t.hue},${sat}%,52%)`);
    g.addColorStop(0.6, `hsl(${t.hue},${sat + 4}%,36%)`);
    g.addColorStop(1, `hsl(${t.hue},${sat + 6}%,22%)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(t.x, t.y, r, 0, Math.PI * 2);
    ctx.fill();
    // Dark under-rim on the shade (SE) side — grounds the crown as a rounded mass.
    ctx.strokeStyle = `hsla(${t.hue},${sat}%,14%,0.4)`;
    ctx.lineWidth = r * 0.2;
    ctx.beginPath();
    ctx.arc(t.x, t.y, r * 0.87, -0.3, 1.85);
    ctx.stroke();
    // Canopy edge texture: bumps breaking the circle — lit on the sun side, dark below.
    for (let b = 0; b < 5; b++) {
      const a = rng() * Math.PI * 2;
      const br = r * (0.2 + rng() * 0.25);
      const sunSide = Math.cos(a) * SUN.x + Math.sin(a) * SUN.y > 0;
      ctx.fillStyle = `hsl(${t.hue},${sat}%,${sunSide ? 40 + rng() * 14 : 24 + rng() * 10}%)`;
      ctx.beginPath();
      ctx.arc(t.x + Math.cos(a) * r * 0.7, t.y + Math.sin(a) * r * 0.7, br, 0, Math.PI * 2);
      ctx.fill();
    }
    // A few bright leaf-cluster dots on the crown for sparkle.
    for (let b = 0; b < 3; b++) {
      ctx.fillStyle = `hsla(${t.hue + 8},${sat + 10}%,${55 + rng() * 12}%,0.7)`;
      ctx.beginPath();
      ctx.arc(t.x + SUN.x * r * 0.35 + (rng() - 0.5) * r * 0.6, t.y + SUN.y * r * 0.35 + (rng() - 0.5) * r * 0.6, r * (0.08 + rng() * 0.1), 0, Math.PI * 2);
      ctx.fill();
    }
    // Snow-capped crown: a bright white dusting on the upper (sun-facing) half of the
    // canopy, the same silhouette every winter forest photo shows.
    if (snow) {
      const g2 = ctx.createRadialGradient(t.x - SUN.x * r * 0.3, t.y - SUN.y * r * 0.3, 0, t.x - SUN.x * r * 0.3, t.y - SUN.y * r * 0.3, r * 0.9);
      g2.addColorStop(0, "rgba(240,245,248,0.85)");
      g2.addColorStop(1, "rgba(240,245,248,0)");
      ctx.fillStyle = g2;
      ctx.beginPath();
      ctx.arc(t.x, t.y, r, 0, Math.PI * 2);
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

// Draw the field fortifications baked into the grid: dug trenches/ditches, rail fences, and
// sandbag emplacements. Each scans its own terrain and orients to its run's neighbours so
// linear works read as continuous lines rather than disconnected stamps.
function drawFortifications(ctx: CanvasRenderingContext2D, grid: Grid, rng: () => number): void {
  const is = (cx: number, cy: number, t: Terrain) => grid.inBounds(cx, cy) && grid.get(cx, cy) === t;
  for (let cy = 0; cy < grid.height; cy++) {
    for (let cx = 0; cx < grid.width; cx++) {
      const t = grid.get(cx, cy);
      if (t === Terrain.Trench) drawTrenchCell(ctx, cx, cy, is, rng);
      else if (t === Terrain.Fence) drawFenceCell(ctx, cx, cy, is, rng);
      else if (t === Terrain.Sandbag) drawSandbagCell(ctx, cx, cy, rng);
    }
  }
}

type IsFn = (cx: number, cy: number, t: Terrain) => boolean;

// A dug trench: a spoil berm (light thrown earth) with the ditch and its shadow below it,
// running along whichever axis the neighbouring trench cells lie on.
function drawTrenchCell(ctx: CanvasRenderingContext2D, cx: number, cy: number, is: IsFn, rng: () => number): void {
  const x = cx * CELL_SIZE, y = cy * CELL_SIZE, C = CELL_SIZE;
  const horiz = is(cx - 1, cy, Terrain.Trench) || is(cx + 1, cy, Terrain.Trench) || !(is(cx, cy - 1, Terrain.Trench) || is(cx, cy + 1, Terrain.Trench));
  ctx.save();
  ctx.translate(x + C / 2, y + C / 2);
  if (!horiz) ctx.rotate(Math.PI / 2);
  // Muted, blended into the turf rather than a bold black gouge — a dug trench should
  // read as ground relief you'd notice on approach, not a stripe painted over the field.
  ctx.fillStyle = "rgba(122,102,66,0.55)"; // spoil berm on the near lip
  ctx.fillRect(-C / 2 - 1, -C * 0.34, C + 2, C * 0.22);
  ctx.fillStyle = "rgba(58,46,28,0.6)"; // the ditch — recessed channel, softened
  ctx.fillRect(-C / 2 - 1, -C * 0.1, C + 2, C * 0.34);
  ctx.fillStyle = "rgba(0,0,0,0.16)"; // inner shadow
  ctx.fillRect(-C / 2 - 1, -C * 0.1, C + 2, C * 0.1);
  ctx.strokeStyle = "rgba(20,14,8,0.2)"; ctx.lineWidth = 0.5; // revetment ticks
  for (let i = 0; i < 2; i++) {
    const px = -C / 2 + rng() * C;
    ctx.beginPath(); ctx.moveTo(px, -C * 0.08); ctx.lineTo(px, C * 0.22); ctx.stroke();
  }
  ctx.restore();
}

// A rail fence / palisade: two posts and a rail spanning the cell along its run.
function drawFenceCell(ctx: CanvasRenderingContext2D, cx: number, cy: number, is: IsFn, rng: () => number): void {
  const x = cx * CELL_SIZE, y = cy * CELL_SIZE, C = CELL_SIZE;
  const horiz = is(cx - 1, cy, Terrain.Fence) || is(cx + 1, cy, Terrain.Fence) || !(is(cx, cy - 1, Terrain.Fence) || is(cx, cy + 1, Terrain.Fence));
  ctx.save();
  ctx.translate(x + C / 2, y + C / 2);
  if (!horiz) ctx.rotate(Math.PI / 2);
  // A thin wooden line, not a bold black bar — a rail fence should read as a marker you
  // notice up close, not a stripe that dominates the field from across the map.
  ctx.strokeStyle = "rgba(10,8,4,0.16)"; ctx.lineWidth = 1.4; ctx.lineCap = "round"; // shadow
  ctx.beginPath(); ctx.moveTo(-C / 2, 1.5); ctx.lineTo(C / 2, 1.5); ctx.stroke();
  ctx.strokeStyle = "rgba(120,96,60,0.85)"; ctx.lineWidth = 1.1; // rail
  ctx.beginPath(); ctx.moveTo(-C / 2, -0.6 + (rng() - 0.5)); ctx.lineTo(C / 2, -0.6 + (rng() - 0.5)); ctx.stroke();
  ctx.strokeStyle = "rgba(76,60,38,0.85)"; ctx.lineWidth = 1.1; // posts
  for (const px of [-C * 0.32, C * 0.18]) {
    ctx.beginPath(); ctx.moveTo(px, -3.2); ctx.lineTo(px, 2.4); ctx.stroke();
  }
  ctx.restore();
}

// A sandbag emplacement: a couple of rows of stacked tan bags with dark seams and a shadow.
function drawSandbagCell(ctx: CanvasRenderingContext2D, cx: number, cy: number, rng: () => number): void {
  const x = cx * CELL_SIZE, y = cy * CELL_SIZE, C = CELL_SIZE;
  ctx.fillStyle = "rgba(12,10,6,0.3)";
  ctx.fillRect(x + 1.5, y + 2, C - 1, C - 3); // drop shadow
  for (let row = 0; row < 2; row++) {
    const oy = y + 3 + row * (C * 0.44);
    const off = row % 2 ? C * 0.16 : 0; // brick-lay the courses
    for (let i = 0; i < 3; i++) {
      const bx = x + 1 + off + i * (C * 0.34);
      const g = ctx.createLinearGradient(bx, oy, bx, oy + C * 0.4);
      g.addColorStop(0, `hsl(45,26%,${58 + rng() * 8}%)`);
      g.addColorStop(1, "#7d6e42");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(bx + C * 0.16, oy + C * 0.2, C * 0.2, C * 0.15, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(40,30,14,0.5)"; ctx.lineWidth = 0.6;
      ctx.stroke();
    }
  }
}

// Soft burn scars on the turf — where fire or HE has scorched the ground black.
function drawScorch(ctx: CanvasRenderingContext2D, grid: Grid, rng: () => number): void {
  const count = Math.round(grid.width * grid.height * 0.003);
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
  const count = Math.round(grid.width * grid.height * 0.003);
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
  const count = Math.round(grid.width * grid.height * 0.008);
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

function drawHedge(ctx: CanvasRenderingContext2D, h: HedgeSeg, rng: () => number, snow = false): void {
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
    g.addColorStop(0, "hsl(95,48%,44%)");
    g.addColorStop(1, "hsl(100,50%,24%)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Snow-capped bocage: the same white dusting the tree canopies get, so a hedgerow
  // doesn't read as a jarring patch of full summer green against the snow.
  if (snow) {
    for (const b of blobs) {
      const g = ctx.createRadialGradient(b.x - SUN.x * b.r * 0.3, b.y - SUN.y * b.r * 0.3, 0, b.x, b.y, b.r * 0.85);
      g.addColorStop(0, "rgba(238,244,247,0.8)");
      g.addColorStop(1, "rgba(238,244,247,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// Warm, saturated village palette: bright terracotta and clay dominate, the way an
// AoE town square reads. Weathered slate is the rare cool note.
const ROOF_PALETTES = [
  ["#d4784a", "#a35331"], // terracotta tile
  ["#c98f56", "#996636"], // clay / tan
  ["#c26843", "#92492c"], // brick red
  ["#a89a84", "#80735f"], // weathered slate
  ["#8f939c", "#686c75"], // blue-grey slate
  ["#b8a26e", "#8c7846"], // sun-bleached tan
];

// Medieval villages are thatched: golden straw fresh off the rick, weathered grey-brown
// straw, and the odd mossy roof — with wooden shingles as the rare upgrade.
const THATCH_PALETTES = [
  ["#c9a95e", "#97793a"], // fresh straw
  ["#b3924e", "#82662e"], // weathered straw
  ["#a39d5f", "#75713a"], // mossy thatch
  ["#8a6f4a", "#63492c"], // wooden shingle (uncommon)
];

function pickRoofPalette(rng: () => number, burned: boolean, era: Era): string[] {
  if (burned) return ["#3a3026", "#2a221c"]; // warm dark char, not pure black
  if (era === "medieval") return rng() < 0.8 ? THATCH_PALETTES[Math.floor(rng() * 3)] : THATCH_PALETTES[3];
  // Mostly warm terracotta/clay/brick, with slate and bleached-tan outliers so a town
  // block shows real variety instead of one repeated orange.
  return rng() < 0.7 ? ROOF_PALETTES[Math.floor(rng() * 3)] : ROOF_PALETTES[3 + Math.floor(rng() * 3)];
}

// --- per-building floor + roof tiles, masked to the exact footprint cells ---

// Build both tiles for one building from its cell mask, so floor and roof line up
// cell-for-cell and nothing pokes out from under the roof.
function paintBuilding(grid: Grid, b: Building, era: Era, snow = false): BuildingArt {
  const W = grid.width;
  let minCx = Infinity, maxCx = -Infinity, minCy = Infinity, maxCy = -Infinity;
  for (const idx of b.cells) {
    const cx = idx % W, cy = (idx / W) | 0;
    if (cx < minCx) minCx = cx; if (cx > maxCx) maxCx = cx;
    if (cy < minCy) minCy = cy; if (cy > maxCy) maxCy = cy;
  }
  const seed = ((minCx * 92837) ^ (minCy * 689287)) >>> 0;
  const floor = paintFloorTile(grid, b, minCx, minCy, maxCx, maxCy);
  const roof = paintRoofTile(b, minCx, minCy, maxCx, maxCy, mulberry32(seed), era, snow);
  return { floor, roof, cells: b.cells };
}

function paintFloorTile(grid: Grid, b: Building, minCx: number, minCy: number, maxCx: number, maxCy: number): Tile {
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
  // Clip the interior to the building's smooth polygon, so the floor's edge lines up with
  // the roofline/wall exactly instead of showing the stair-stepped per-cell footprint
  // poking out. (Rectangular houses' poly == their cell block, so nothing changes there;
  // this only cleans up the irregular OSM footprints.)
  const clip = b.poly.length >= 3;
  if (clip) {
    ctx.save();
    const p = new Path2D();
    p.moveTo(b.poly[0].x * CELL_SIZE, b.poly[0].y * CELL_SIZE);
    for (let i = 1; i < b.poly.length; i++) p.lineTo(b.poly[i].x * CELL_SIZE, b.poly[i].y * CELL_SIZE);
    p.closePath();
    ctx.clip(p);
  }
  // 1. One open room: floorboards across the entire footprint (walls included — the
  //    thin wall line is drawn over the top, so there's no gap beneath it).
  for (const idx of b.cells) drawFloorCell(ctx, grid, idx % W, (idx / W) | 0);
  // 2. A sparse scatter of furniture on the open floor.
  for (const idx of b.cells) {
    if (grid.cells[idx] === Terrain.Floor && fRng() < 0.04) drawFurniture(ctx, idx % W, (idx / W) | 0, fRng);
  }
  if (clip) ctx.restore();
  // 3. The exterior wall: a thin stone line traced along the building's polygon, so it
  //    follows the roofline exactly and reads as a real wall, not a ring of blocks.
  drawThinWall(ctx, b);
  // 4. Windows: small panes set into the wall line where the perimeter has them.
  for (const idx of b.cells) {
    if (grid.cells[idx] === Terrain.Window) drawWindowPane(ctx, idx % W, (idx / W) | 0);
  }
  return { canvas, x: x0, y: y0, scale: 1 / SS };
}

// The exterior wall as a thin outline along the building polygon — a soft shadow, a
// stone body, and a sunlit inner highlight, all just a few pixels wide.
function drawThinWall(ctx: CanvasRenderingContext2D, b: Building): void {
  const pts = b.poly.map((p) => [p.x * CELL_SIZE, p.y * CELL_SIZE] as [number, number]);
  if (pts.length < 2) return;
  const trace = () => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
  };
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(18,14,10,0.4)"; trace(); ctx.lineWidth = 5; ctx.stroke();
  ctx.strokeStyle = "#6b6157"; trace(); ctx.lineWidth = 3; ctx.stroke();
  ctx.strokeStyle = "rgba(255,248,235,0.16)"; trace(); ctx.lineWidth = 0.9; ctx.stroke();
}

// A window pane set into the thin wall: a small dark frame with muted glass, centered on
// the window cell (which sits on the perimeter), so it reads as an opening in the wall.
function drawWindowPane(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  const x = cx * CELL_SIZE, y = cy * CELL_SIZE;
  const m = CELL_SIZE * 0.3;
  const px = x + m, py = y + m, pw = CELL_SIZE - 2 * m, ph = CELL_SIZE - 2 * m;
  ctx.fillStyle = "#241d16";
  ctx.fillRect(px - 1.2, py - 1.2, pw + 2.4, ph + 2.4);
  ctx.fillStyle = "rgba(150,170,180,0.6)";
  ctx.fillRect(px, py, pw, ph);
  ctx.strokeStyle = "rgba(36,29,22,0.85)";
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  ctx.moveTo(x + CELL_SIZE / 2, py);
  ctx.lineTo(x + CELL_SIZE / 2, py + ph);
  ctx.stroke();
}

function paintRoofTile(b: Building, minCx: number, minCy: number, maxCx: number, maxCy: number, rng: () => number, era: Era, snow = false): Tile {
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
  if (isRect) drawPitchedRoof(ctx, minCx, minCy, maxCx + 1, maxCy + 1, rng, burned, era);
  else drawFlatRoof(ctx, b, rng, burned, era);
  // Snow dusting: a soft white wash weighted toward the sun-facing (NW) slope, plus a
  // crisp bright line along the ridge/eave where snow actually piles up. The roof art
  // above is an irregular polygon (pitched rectangle or an arbitrary OSM footprint) that
  // doesn't necessarily fill this tile's axis-aligned bounding box — "source-atop"
  // confines the wash to pixels the roof itself already painted, instead of a plain
  // fillRect spilling into the transparent eave margin around a rotated/irregular roof.
  if (snow && !burned) {
    ctx.save();
    ctx.globalCompositeOperation = "source-atop";
    const cx0 = x0 + M, cy0 = y0 + M, cw = w - 2 * M, ch = h - 2 * M;
    const gx = cx0 + cw * (0.5 + SUN.x * 0.3), gy = cy0 + ch * (0.5 + SUN.y * 0.3);
    const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, Math.max(cw, ch) * 0.75);
    g.addColorStop(0, "rgba(238,244,247,0.55)");
    g.addColorStop(1, "rgba(238,244,247,0.05)");
    ctx.fillStyle = g;
    ctx.fillRect(cx0, cy0, cw, ch);
    ctx.fillStyle = "rgba(240,246,248,0.7)";
    ctx.fillRect(cx0, cy0, cw, ch * 0.14); // ridge line catching the most snow
    ctx.restore();
  }
  return { canvas, x: x0, y: y0, scale: 1 / SS };
}

function drawBuildingShadow(ctx: CanvasRenderingContext2D, b: Building): void {
  // Taller buildings throw longer shadows — the AoE2 depth cue that sells the town.
  const lift = 4.5 + b.levels * 3.5;
  // NO ctx.filter here: canvas blur filters force full-canvas intermediates, and at
  // hundreds of shadow fills on a 4000×3000+ map Chrome intermittently drops earlier
  // canvas content (which silently erased the bocage hedges). Softness comes from
  // layered low-alpha fills at growing offsets instead — cheap and reliable.
  ctx.save();
  const rect = asAxisRect(b.poly);
  for (let pass = 0; pass < 3; pass++) {
    const grow = pass * 1.8;
    ctx.fillStyle = `rgba(15,15,12,${0.2 - pass * 0.055})`;
    if (rect) {
      const x = rect.x0 * CELL_SIZE, y = rect.y0 * CELL_SIZE;
      ctx.fillRect(
        x - SUN.x * lift - grow, y - SUN.y * lift - grow,
        (rect.x1 - rect.x0) * CELL_SIZE + grow * 2, (rect.y1 - rect.y0) * CELL_SIZE + grow * 2,
      );
    } else {
      const pts = b.poly.map((p) => [p.x * CELL_SIZE, p.y * CELL_SIZE] as [number, number]);
      poly2(ctx, pts.map(([x, y]) => [x - SUN.x * lift + grow * 0.4, y - SUN.y * lift + grow * 0.4] as [number, number]));
    }
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

// (Legacy block-wall, interior-partition, and full-cell window renderers removed —
// buildings are now one open room walled by a thin polygon outline; see drawThinWall
// and drawWindowPane.)

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

// Irregular (OSM) footprints get a low-pitch hip roof, clipped to the smooth building
// polygon (not the per-cell mask) so the roof edge reads clean instead of stair-stepped.
// The floor plan below is a separate sprite that only shows once the roof has faded, so
// the slight poly/cell mismatch at the rim is never visible.
function drawFlatRoof(ctx: CanvasRenderingContext2D, b: Building, rng: () => number, burned: boolean, era: Era): void {
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
  const pal = pickRoofPalette(rng, burned, era);

  // Walls first: extruded faces on the away-from-sun edges give the block real volume.
  if (pts.length >= 3) drawWallFaces(ctx, pts, burned, era, rng);

  ctx.save();
  ctx.clip(mask);
  // Two hard-lit slopes split along the long axis — a sunlit face and a shaded face —
  // so even a sprawling OSM footprint reads as a 3D roof, not a flat painted slab.
  const horiz = bb.x1 - bb.x0 >= bb.y1 - bb.y0;
  const midY = (bb.y0 + bb.y1) / 2, midX = (bb.x0 + bb.x1) / 2;
  ctx.fillStyle = lightenHex(pal[0], 26); // sun-facing slope — bright, so the pitch is unmistakable
  if (horiz) ctx.fillRect(bb.x0, bb.y0, bb.x1 - bb.x0, midY - bb.y0);
  else ctx.fillRect(bb.x0, bb.y0, midX - bb.x0, bb.y1 - bb.y0);
  ctx.fillStyle = pal[1]; // shaded slope
  if (horiz) ctx.fillRect(bb.x0, midY, bb.x1 - bb.x0, bb.y1 - midY);
  else ctx.fillRect(midX, bb.y0, bb.x1 - midX, bb.y1 - bb.y0);
  if (era === "medieval" && !burned) {
    thatchTexture(ctx, bb.x0, bb.y0, bb.x1 - bb.x0, bb.y1 - bb.y0, horiz, rng);
  } else {
    // Tile courses across the longer axis, strong enough to survive 1× supersampling.
    ctx.strokeStyle = "rgba(0,0,0,0.2)";
    ctx.lineWidth = 0.7;
    if (horiz) for (let ly = bb.y0 + 3; ly < bb.y1; ly += 3.5) line(ctx, bb.x0, ly, bb.x1, ly);
    else for (let lx = bb.x0 + 3; lx < bb.x1; lx += 3.5) line(ctx, lx, bb.y0, lx, bb.y1);
  }
  // Ridge down the spine: sunlit tile cap, or a dark timber pole on thatch.
  if (horiz) ridge(ctx, bb.x0, midY, bb.x1, midY, era === "medieval" && !burned);
  else ridge(ctx, midX, bb.y0, midX, bb.y1, era === "medieval" && !burned);
  if (burned) burnDamage(ctx, bb, rng);
  ctx.restore();
  // Eave: trace just the building's outer polygon (not the per-cell mask, which would
  // draw a grid) so adjacent buildings read as separate blocks.
  if (b.poly.length >= 2) {
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = 1.6;
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

// The 2.5D wall extrusion that gives a building its volume. For each polygon edge that
// faces away from the sun (south or east), draw a parallelogram wall face dropping
// down-right; east faces catch grazing light, south faces sit in shade. A thin dark
// ground-contact line anchors the base. Medieval walls get half-timber studs.
const WALL_DX = 4.2; // how far the walls drop to the east…
const WALL_DY = 5.4; // …and to the south (sun from the NW) — tall enough to read at any zoom
function drawWallFaces(
  ctx: CanvasRenderingContext2D,
  pts: [number, number][],
  burned: boolean,
  era: Era,
  rng: () => number,
): void {
  const litWall = burned ? "#463b2e" : era === "medieval" ? "#c9b48e" : "#c0b090";
  const shadeWall = burned ? "#2e261e" : era === "medieval" ? "#94805c" : "#8d7f63";
  // Centroid, to orient each edge's outward normal regardless of polygon winding.
  let cx = 0, cy = 0;
  for (const [px, py] of pts) { cx += px; cy += py; }
  cx /= pts.length; cy /= pts.length;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    const ex = x1 - x0, ey = y1 - y0;
    let nx = -ey, ny = ex;
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; } // point away from center
    if (nx <= 0 && ny <= 0) continue; // north/west faces are hidden under the roof
    const face: [number, number][] = [
      [x0, y0], [x1, y1],
      [x1 + WALL_DX, y1 + WALL_DY], [x0 + WALL_DX, y0 + WALL_DY],
    ];
    ctx.fillStyle = ny > Math.abs(nx) ? shadeWall : litWall; // south = shade, east = lit
    poly(ctx, face);
    // Ground-contact line along the face's foot.
    ctx.strokeStyle = "rgba(12,10,6,0.5)";
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(x0 + WALL_DX, y0 + WALL_DY);
    ctx.lineTo(x1 + WALL_DX, y1 + WALL_DY);
    ctx.stroke();
    // Half-timber studs on medieval walls — short dark verticals along the face.
    if (era === "medieval" && !burned) {
      const len = Math.hypot(ex, ey);
      const n = Math.max(1, Math.floor(len / 9));
      ctx.strokeStyle = "rgba(74,56,30,0.7)";
      ctx.lineWidth = 0.9;
      for (let k = 1; k <= n; k++) {
        const f = (k - 0.3 + rng() * 0.5) / (n + 0.4);
        const bx = x0 + ex * f, by = y0 + ey * f;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + WALL_DX, by + WALL_DY);
        ctx.stroke();
      }
    }
  }
}

function drawPitchedRoof(
  ctx: CanvasRenderingContext2D,
  gx0: number,
  gy0: number,
  gx1: number,
  gy1: number,
  rng: () => number,
  burned = false,
  era: Era = "ww2",
): void {
  const x = gx0 * CELL_SIZE;
  const y = gy0 * CELL_SIZE;
  const w = (gx1 - gx0) * CELL_SIZE;
  const h = (gy1 - gy0) * CELL_SIZE;
  const thatch = era === "medieval" && !burned;

  // 2. Wall faces — the building is extruded like an AoE2 sprite: with the sun at the
  // top-left, the south and east walls peek out from under the roofline, the east face
  // catching more light than the south. Medieval walls are half-timbered wattle-and-daub.
  drawWallFaces(ctx, [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], burned, era, rng);

  // 3. Pitched roof: ridge along the longer axis, two shaded faces. Charred timber tones
  // for a gutted house. The roof covers the full footprint; walls show only to the SE.
  const pal = pickRoofPalette(rng, burned, era);
  const rx = x;
  const ry = y;
  const rw = w;
  const rh = h;

  if (rw >= rh) {
    // Horizontal ridge.
    const midY = ry + rh / 2;
    ctx.fillStyle = lightenHex(pal[0], 18); // sun-facing (upper) slope
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
    if (thatch) thatchTexture(ctx, rx, ry, rw, rh, true, rng);
    else roofLines(ctx, rx, ry, rw, rh, true);
    if (!burned) ridge(ctx, rx, midY, rx + rw, midY, thatch);
  } else {
    // Vertical ridge.
    const midX = rx + rw / 2;
    ctx.fillStyle = lightenHex(pal[0], 18);
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
    if (thatch) thatchTexture(ctx, rx, ry, rw, rh, false, rng);
    else roofLines(ctx, rx, ry, rw, rh, false);
    if (!burned) ridge(ctx, midX, ry, midX, ry + rh, thatch);
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

function ridge(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, timber = false): void {
  // Tile roofs catch the sun along the ridge; a thatched roof is capped with a dark
  // timber ridge pole instead.
  ctx.strokeStyle = timber ? "rgba(74,56,30,0.75)" : "rgba(255,240,220,0.35)";
  ctx.lineWidth = timber ? 1.7 : 1.4;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

// Thatch: combed straw strands running down each slope (away from the ridge), plus a
// scatter of loose-straw flecks, so a medieval roof reads as woven straw rather than
// tile courses.
function thatchTexture(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  horizRidge: boolean,
  rng: () => number,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  // Strands: short strokes perpendicular to the ridge, jittered so they look combed.
  const n = Math.max(10, Math.round((w * h) / 26));
  for (let i = 0; i < n; i++) {
    const sx = x + rng() * w, sy = y + rng() * h;
    const len = 2.5 + rng() * 3;
    const jitter = (rng() - 0.5) * 1.2;
    ctx.strokeStyle = `hsla(${40 + rng() * 12},${30 + rng() * 20}%,${28 + rng() * 26}%,${0.2 + rng() * 0.2})`;
    ctx.lineWidth = 0.5 + rng() * 0.5;
    ctx.beginPath();
    if (horizRidge) { ctx.moveTo(sx, sy); ctx.lineTo(sx + jitter, sy + len); }
    else { ctx.moveTo(sx, sy); ctx.lineTo(sx + len, sy + jitter); }
    ctx.stroke();
  }
  // Loose straw flecks catching the light.
  for (let i = 0; i < n / 6; i++) {
    ctx.fillStyle = `hsla(45,55%,${58 + rng() * 14}%,${0.25 + rng() * 0.2})`;
    ctx.fillRect(x + rng() * w, y + rng() * h, 1 + rng(), 0.8);
  }
  ctx.restore();
}

function drawVignette(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  // Barely-there edge grade — the map should stay bright and sunlit to the corners.
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.45, w / 2, h / 2, Math.max(w, h) * 0.72);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(20,18,12,0.12)");
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
