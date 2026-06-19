import { Terrain } from "./terrain.ts";
import { World } from "./world.ts";

// Structural damage to buildings. High explosive — tank HE, mortar bombs, hand
// grenades — chews through walls and floors. Each hit accumulates damage on the
// building cells inside its blast; once a cell passes the collapse threshold it
// caves in to Rubble, punching a breach that opens up movement, sight and fire.

const COLLAPSE = 1.0; // accumulated damage at which a building cell becomes rubble

function isBuilding(t: Terrain): boolean {
  return t === Terrain.Wall || t === Terrain.Floor;
}

/**
 * Apply an explosive blast of structural damage centred on (cx,cy). Damages every
 * building cell within `radius`, falling off with distance and scaled by `power`
 * (≈ how many cells of wall one blast can level at the centre). Returns true if any
 * cell collapsed, so callers can leave it to the version bump for redraws.
 */
export function damageBuildings(world: World, cx: number, cy: number, radius: number, power: number): void {
  const grid = world.grid;
  const r = Math.ceil(radius);
  let changed = false;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (!grid.inBounds(x, y)) continue;
      const t = grid.get(x, y);
      if (!isBuilding(t)) continue;
      const d = Math.hypot(dx, dy);
      if (d > radius) continue;
      const i = grid.idx(x, y);
      // Walls are sturdier than interior floors; both take falloff damage.
      const resist = t === Terrain.Wall ? 1.6 : 1.0;
      world.buildDmg[i] += (power * (1 - d / radius)) / resist;
      changed = true;
      if (world.buildDmg[i] >= COLLAPSE && (t === Terrain.Wall || t === Terrain.Floor)) {
        grid.set(x, y, Terrain.Rubble);
      }
    }
  }
  if (changed) world.buildDmgVersion++;
}
