import { addSuppression, killSoldier } from "./casualty.ts";
import { spawnRicochet } from "./combat.ts";
import { damageBuildings } from "./buildingDamage.ts";
import { SIM_DT } from "./constants.ts";
import { hasLOS } from "./los.ts";
import { TERRAIN } from "./terrain.ts";
import { vehicleCost, vehiclePassable } from "./terrain.ts";
import { apHitChance, resolveArmorHit } from "./vehicleCombat.ts";
import { VEHICLES } from "./vehicleDefs.ts";
import { Soldier, Vehicle, World } from "./world.ts";
import { sound } from "../render/sound.ts";

// One step of armored-vehicle behaviour: acquire targets, traverse the turret, fire
// (AP at armor, HE + MG at infantry), then move. Knocked-out hulls just burn.
export function updateVehicles(world: World): void {
  const dt = SIM_DT;
  for (const v of world.vehicles) {
    if (v.status === "ko") {
      emitSmoke(world, v, dt);
      sound.setEngine(v.id, false, v.x, v.y); // dead engine — cut the loop
      v.px = v.x;
      v.py = v.y;
      continue;
    }
    v.px = v.x;
    v.py = v.y;
    v.suppression = Math.max(0, v.suppression - 0.2 * dt);
    woundSmoke(world, v, dt); // a hurt-but-running tank trails smoke so its state shows
    acquire(world, v);
    aimAndFire(world, v, dt);
    selfPreserve(world, v, dt);
    move(world, v, dt);
    // Run the engine loop whenever the hull actually shifted this step.
    const moved = (v.x - v.px) ** 2 + (v.y - v.py) ** 2 > 1e-7;
    sound.setEngine(v.id, moved, v.x, v.y);
  }
  separateVehicles(world);
}

// Keep tanks from driving into/through one another. Pathing alone doesn't stop two
// hulls converging on the same ground (a tank isn't a grid-cell-sized obstacle to
// another tank's pathfinder), so after everyone's moved this step, gently push apart
// any two whose hulls have come closer than their combined half-lengths — the same
// after-the-fact separation infantry already gets (see separateSoldiers in sim.ts).
// O(n²) is fine: a side fields at most a handful of vehicles.
function separateVehicles(world: World): void {
  const vehicles = world.vehicles.filter((v) => v.status !== "ko");
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < vehicles.length; i++) {
      const a = vehicles[i];
      const aR = vehicleRadius(a);
      for (let j = i + 1; j < vehicles.length; j++) {
        const b = vehicles[j];
        const sep = aR + vehicleRadius(b);
        let ox = b.x - a.x, oy = b.y - a.y;
        let d2 = ox * ox + oy * oy;
        if (d2 >= sep * sep) continue;
        let d = Math.sqrt(d2);
        if (d < 1e-4) { // dead-on overlap: pick a stable direction so they don't jitter
          const ang = ((a.id * 2654435761) >>> 0) / 4294967296 * Math.PI * 2;
          ox = Math.cos(ang); oy = Math.sin(ang); d = 1;
        }
        const ux = ox / d, uy = oy / d;
        const overlap = sep - d;
        pushVehicle(world, a, -ux, -uy, overlap * 0.5);
        pushVehicle(world, b, ux, uy, overlap * 0.5);
      }
    }
  }
}

// A circle guaranteed to cover the hull's rotated footprint (radius = half the longer
// dimension) — simpler than tracking each hull's exact facing, and close enough at this
// scale; it just means two tanks settle a hair further apart than the tightest possible
// side-by-side squeeze.
export function vehicleRadius(v: Vehicle): number {
  const def = VEHICLES[v.cls];
  return Math.max(def.hullLen, def.hullWid) / 2;
}

function pushVehicle(world: World, v: Vehicle, ux: number, uy: number, d: number): void {
  const passable = (cx: number, cy: number) => world.grid.inBounds(cx, cy) && vehiclePassable(world.grid.get(cx, cy));
  const nx = v.x + ux * d, ny = v.y + uy * d;
  if (passable(Math.floor(nx), Math.floor(ny))) { v.x = nx; v.y = ny; }
  else if (passable(Math.floor(v.x + ux * d), Math.floor(v.y))) v.x += ux * d;
  else if (passable(Math.floor(v.x), Math.floor(v.y + uy * d))) v.y += uy * d;
}

function acquire(world: World, v: Vehicle): void {
  const def = VEHICLES[v.cls];
  const gunRange = def.gun.rangeCells;
  const sightRange = Math.max(gunRange, def.mg.rangeCells);

  let veh = validVeh(world, v, v.manualVeh, gunRange);
  let inf = veh ? null : validInf(world, v, v.manualInf, sightRange);

  if (!veh && !inf) {
    veh = nearestEnemyVeh(world, v, gunRange);
    inf = nearestEnemyInf(world, v, sightRange);
  }
  v.targetVehId = veh ? veh.id : null;
  v.targetInfId = inf ? inf.id : null;
}

function aimAndFire(world: World, v: Vehicle, dt: number): void {
  const def = VEHICLES[v.cls];
  v.gunCD -= dt;
  v.mgCD -= dt;

  // Player-directed ground bombardment takes priority over auto-acquired targets.
  if (v.fireCell) {
    const tx = v.fireCell.cx + 0.5;
    const ty = v.fireCell.cy + 0.5;
    const d = Math.hypot(tx - v.x, ty - v.y);
    const ang = Math.atan2(ty - v.y, tx - v.x);
    v.turret = rotateToward(v.turret, ang, def.turretTraverse * dt);
    const aligned = Math.abs(angleDiff(v.turret, ang)) < 0.16;
    if (v.suppression > 0.85) return;
    if (
      aligned && v.gunCD <= 0 && v.heAmmo > 0 && d <= def.gun.rangeCells &&
      hasLOS(world.grid, Math.floor(v.x), Math.floor(v.y), v.fireCell.cx, v.fireCell.cy)
    ) {
      fireHEAtPoint(world, v, tx, ty, def);
      v.heAmmo--;
      v.gunCD = def.gun.reload * (1 + 0.5 * v.suppression);
    }
    return;
  }

  const veh = v.targetVehId != null ? world.vehicle(v.targetVehId) : null;
  const inf = v.targetInfId != null ? world.soldier(v.targetInfId) : null;
  const priority = veh ?? inf;
  if (!priority) return;

  // Traverse the turret onto the priority target.
  const ang = Math.atan2(priority.y - v.y, priority.x - v.x);
  v.turret = rotateToward(v.turret, ang, def.turretTraverse * dt);
  const aligned = Math.abs(angleDiff(v.turret, ang)) < 0.16;
  if (v.suppression > 0.85) return; // crew buttoned up under fire

  // Main gun: AP at armor (priority), else HE at infantry.
  if (aligned && v.gunCD <= 0) {
    if (veh && v.apAmmo > 0) {
      fireAP(world, v, veh, def);
      v.apAmmo--;
      v.gunCD = def.gun.reload * (1 + 0.5 * v.suppression);
    } else if (inf && v.heAmmo > 0) {
      fireHE(world, v, inf, def);
      v.heAmmo--;
      v.gunCD = def.gun.reload * (1 + 0.5 * v.suppression);
    }
  }

  // Machine gun hoses infantry independently of the main gun's reload — but it's coax,
  // mounted in the turret, so it only covers wherever the barrel is currently pointed.
  // A tank whose turret is still traversing onto a vehicle (or hasn't turned to face a
  // man who closed in from an angle) can't hose him until it swings onto him — the same
  // aim gate the main gun already respects.
  if (inf && v.mgAmmo > 0) {
    const mgAng = Math.atan2(inf.y - v.y, inf.x - v.x);
    const mgAligned = Math.abs(angleDiff(v.turret, mgAng)) < 0.16;
    const d = Math.hypot(inf.x - v.x, inf.y - v.y);
    if (mgAligned && d <= def.mg.rangeCells && hasLOS(world.grid, Math.floor(v.x), Math.floor(v.y), Math.floor(inf.x), Math.floor(inf.y), world.smokeGrid)) {
      let guard = 6;
      while (v.mgCD <= 0 && v.mgAmmo > 0 && guard-- > 0) {
        v.mgCD += 1 / def.mg.rof;
        v.mgAmmo--;
        mgShot(world, v, inf, def, d);
      }
    }
  }
}

function fireAP(world: World, v: Vehicle, target: Vehicle, def: (typeof VEHICLES)[keyof typeof VEHICLES]): void {
  const muzzle = gunMuzzle(v);
  sound.play("tank_ap", muzzle.x, muzzle.y);
  world.effects.push({ kind: "ap", x0: muzzle.x, y0: muzzle.y, x1: target.x, y1: target.y, ttl: 0.12 });
  world.effects.push({ kind: "flash", x0: muzzle.x, y0: muzzle.y, x1: muzzle.x, y1: muzzle.y, ttl: 0.08 });
  const d = Math.hypot(target.x - v.x, target.y - v.y);
  const p = apHitChance(def.gun.accuracy, d, def.gun.rangeCells, v.path != null, target.path != null, v.suppression);
  if (Math.random() < p) resolveArmorHit(world, target, def.gun.pen, v.x, v.y, d, def.gun.rangeCells);
  else world.effects.push({ kind: "spark", x0: target.x + (Math.random() - 0.5), y0: target.y + (Math.random() - 0.5), x1: 0, y1: 0, ttl: 0.12 });
}

function fireHE(world: World, v: Vehicle, target: Soldier, def: (typeof VEHICLES)[keyof typeof VEHICLES]): void {
  fireHEAtPoint(world, v, target.x, target.y, def);
}

// HE burst at a point — used both for firing at a spotted man and for player-directed
// ground bombardment. Splashes onto enemy infantry within the shell's radius.
function fireHEAtPoint(world: World, v: Vehicle, tx: number, ty: number, def: (typeof VEHICLES)[keyof typeof VEHICLES]): void {
  const muzzle = gunMuzzle(v);
  sound.play("tank_he", muzzle.x, muzzle.y);
  sound.play("explosion", tx, ty);
  world.effects.push({ kind: "ap", x0: muzzle.x, y0: muzzle.y, x1: tx, y1: ty, ttl: 0.1 });
  world.effects.push({ kind: "flash", x0: muzzle.x, y0: muzzle.y, x1: muzzle.x, y1: muzzle.y, ttl: 0.08 });
  world.effects.push({ kind: "hit", x0: tx, y0: ty, x1: tx, y1: ty, ttl: 0.35 });
  world.effects.push({ kind: "smoke", x0: tx, y0: ty, x1: 0, y1: 0, ttl: 1.2, maxTtl: 1.2 });
  const radius = def.gun.heRadius;
  damageBuildings(world, Math.floor(tx), Math.floor(ty), Math.max(1.5, radius), 1.2);
  for (const s of world.soldiers) {
    if (s.faction === v.faction || s.status !== "active") continue;
    const d = Math.hypot(s.x - tx, s.y - ty);
    if (d > radius) continue;
    const falloff = 1 - d / radius;
    // HE ignores small-arms cover but is blunted by a roof/wall overhead.
    const tcx = Math.floor(s.x);
    const tcy = Math.floor(s.y);
    const cover = world.grid.inBounds(tcx, tcy) ? TERRAIN[world.grid.get(tcx, tcy)].cover : 0;
    if (Math.random() < def.gun.heKill * falloff * (1 - cover * 0.5)) killSoldier(world, s, 1.1, "blast");
    else addSuppression(s, 0.6 * falloff);
  }
}

function mgShot(world: World, v: Vehicle, target: Soldier, def: (typeof VEHICLES)[keyof typeof VEHICLES], d: number): void {
  sound.play("tank_mg", v.x, v.y);
  if (Math.random() < 0.55) {
    world.effects.push({ kind: "tracer", x0: v.x, y0: v.y, x1: target.x, y1: target.y, ttl: 0.16 });
    spawnRicochet(world, target.x, target.y);
  }
  world.effects.push({ kind: "flash", x0: v.x, y0: v.y, x1: v.x, y1: v.y, ttl: 0.05 });
  const tcx = Math.floor(target.x);
  const tcy = Math.floor(target.y);
  const cover = world.grid.inBounds(tcx, tcy) ? TERRAIN[world.grid.get(tcx, tcy)].cover : 0;
  addSuppression(target, def.mg.suppression);
  let p = 0.3 * (1 - 0.5 * (d / def.mg.rangeCells)) * (1 - cover * 0.7);
  if (target.path) p *= 0.8;
  if (Math.random() < p && Math.random() < def.mg.lethality) killSoldier(world, target);
}

// A tank moves on tracks: it must rotate the hull to point at (or directly away from)
// the next waypoint, then drive forward or reverse along its hull axis. It can't slide
// sideways. When the hull is still turning toward the waypoint the tank creeps or
// pivots in place; once roughly aligned it accelerates to full speed.
function move(world: World, v: Vehicle, dt: number): void {
  if (v.immobilized || !v.path) return;
  const def = VEHICLES[v.cls];
  const cx = Math.floor(v.x);
  const cy = Math.floor(v.y);
  const cost = world.grid.inBounds(cx, cy) ? vehicleCost(world.grid.get(cx, cy)) : 1;
  const maxSpeed = (def.speed / cost) * (v.stance === "fast" ? 1.5 : 1);

  const wp = v.path[v.pathIndex];
  const tx = wp.cx + 0.5;
  const ty = wp.cy + 0.5;
  const dx = tx - v.x;
  const dy = ty - v.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.01) {
    v.pathIndex++;
    if (v.pathIndex >= v.path.length) v.path = null;
    return;
  }

  const desired = Math.atan2(dy, dx);
  const fwdOff = Math.abs(angleDiff(v.facing, desired)); // how far off forward
  const revOff = Math.abs(angleDiff(v.facing, desired + Math.PI)); // how far off reverse

  // Choose whichever is closer — drive forward or reverse — so the tank doesn't
  // do a 170° pivot when backing up 10° would reach the waypoint.
  const reverse = revOff < fwdOff;
  const targetFacing = reverse ? desired + Math.PI : desired;
  // Normalise into [-π, π]
  const normFacing = Math.atan2(Math.sin(targetFacing), Math.cos(targetFacing));

  // Rotate the hull toward the chosen heading.
  v.facing = rotateToward(v.facing, normFacing, def.hullTurn * dt);

  // How far off-axis is the hull now? Only drive when roughly aligned; the more
  // misaligned, the slower, down to zero (pure pivot) beyond ~40°.
  const misalign = Math.abs(angleDiff(v.facing, normFacing));
  const driveFrac = Math.max(0, 1 - misalign / 0.7); // 0.7 rad ≈ 40°
  const speed = maxSpeed * driveFrac * (reverse ? 0.6 : 1); // reverse is slower
  const step = speed * dt;
  if (step < 0.001) return; // still pivoting in place

  // Drive along the hull's forward axis (or backward if reversing).
  const driveAng = reverse ? v.facing + Math.PI : v.facing;
  const mx = Math.cos(driveAng) * step;
  const my = Math.sin(driveAng) * step;

  // Advance toward the waypoint, but never overshoot it.
  if (step >= dist) {
    v.x = tx;
    v.y = ty;
    v.pathIndex++;
    if (v.pathIndex >= v.path.length) v.path = null;
  } else {
    v.x += mx;
    v.y += my;
  }
}

// Tank terror, from the tank's side: a buttoned-up crew with enemy infantry right on
// the hull — and no friendly infantry screening it — reverses out rather than sit
// there to be grenaded. Only kicks in for an idle/holding tank (it won't override a
// move order already in progress), so a parked Sherman swarmed by Grenadiers — or a
// lone Panzer among GIs — backs off to where its gun can do the work safely.
const THREAT_RANGE = 5; // enemy infantry this close are a tank-killing threat
const SCREEN_RANGE = 6; // friendly infantry this close count as a screen
const BACKOFF_DIST = 9; // cells to reverse when pulling out

function selfPreserve(world: World, v: Vehicle, dt: number): void {
  v.backoffCD = Math.max(0, v.backoffCD - dt);
  if (v.immobilized || v.path || v.backoffCD > 0) return;

  let ex = 0, ey = 0, threat = 0, screen = 0;
  for (const s of world.soldiers) {
    if (s.status !== "active") continue;
    const d = Math.hypot(s.x - v.x, s.y - v.y);
    if (s.faction === v.faction) {
      if (d <= SCREEN_RANGE) screen++;
    } else if (d <= THREAT_RANGE) {
      threat++;
      ex += v.x - s.x; // accumulate a vector pointing away from the threat
      ey += v.y - s.y;
    }
  }
  if (threat === 0 || threat <= screen) return; // not swarmed, or our infantry have it

  const len = Math.hypot(ex, ey) || 1;
  const gx = Math.round(v.x + (ex / len) * BACKOFF_DIST);
  const gy = Math.round(v.y + (ey / len) * BACKOFF_DIST);
  v.backoffCD = world.orderVehicleMove(v.id, { cx: gx, cy: gy }, false) ? 1.5 : 0.6;
}

function emitSmoke(world: World, v: Vehicle, dt: number): void {
  v.smokeCD -= dt;
  if (v.smokeCD <= 0) {
    v.smokeCD = 0.35;
    world.effects.push({ kind: "smoke", x0: v.x + (Math.random() - 0.5) * 0.5, y0: v.y, x1: 0, y1: 0, ttl: 2.2, maxTtl: 2.2 });
  }
}

// A tank that's been hurt but is still fighting — a broken track or a lost crewman —
// trails a thin wisp of smoke. It's a persistent, at-a-glance "this one is damaged" cue
// so the player can see their AT fire is telling, short of a full brew-up.
function woundSmoke(world: World, v: Vehicle, dt: number): void {
  const def = VEHICLES[v.cls];
  const hurt = v.immobilized || v.crew < def.crew;
  if (!hurt) return;
  v.smokeCD -= dt;
  if (v.smokeCD <= 0) {
    v.smokeCD = 0.9; // sparser/thinner than a wreck's billowing column
    world.effects.push({ kind: "smoke", x0: v.x + (Math.random() - 0.5) * 0.4, y0: v.y, x1: 0, y1: 0, ttl: 1.4, maxTtl: 1.4 });
  }
}

// --- target selection helpers ---

function validVeh(world: World, v: Vehicle, id: number | null, range: number): Vehicle | null {
  if (id == null) return null;
  const t = world.vehicle(id);
  if (!t || t.faction === v.faction || t.status === "ko" || !t.seen) return null;
  return inRangeLOS(world, v, t.x, t.y, range) ? t : null;
}
function validInf(world: World, v: Vehicle, id: number | null, range: number): Soldier | null {
  if (id == null) return null;
  const t = world.soldier(id);
  if (!t || t.faction === v.faction || t.status !== "active" || !t.seen) return null;
  return inRangeLOS(world, v, t.x, t.y, range) ? t : null;
}
function nearestEnemyVeh(world: World, v: Vehicle, range: number): Vehicle | null {
  let best: Vehicle | null = null;
  let bestD = range * range;
  for (const t of world.vehicles) {
    if (t.faction === v.faction || t.status === "ko" || !t.seen) continue;
    const d = (t.x - v.x) ** 2 + (t.y - v.y) ** 2;
    if (d < bestD && hasLOS(world.grid, Math.floor(v.x), Math.floor(v.y), Math.floor(t.x), Math.floor(t.y), world.smokeGrid)) {
      best = t;
      bestD = d;
    }
  }
  return best;
}
function nearestEnemyInf(world: World, v: Vehicle, range: number): Soldier | null {
  let best: Soldier | null = null;
  let bestD = range * range;
  for (const t of world.soldiers) {
    if (t.faction === v.faction || t.status !== "active" || !t.seen) continue;
    const d = (t.x - v.x) ** 2 + (t.y - v.y) ** 2;
    if (d < bestD && hasLOS(world.grid, Math.floor(v.x), Math.floor(v.y), Math.floor(t.x), Math.floor(t.y), world.smokeGrid)) {
      best = t;
      bestD = d;
    }
  }
  return best;
}
function inRangeLOS(world: World, v: Vehicle, x: number, y: number, range: number): boolean {
  return (
    (x - v.x) ** 2 + (y - v.y) ** 2 <= range * range &&
    hasLOS(world.grid, Math.floor(v.x), Math.floor(v.y), Math.floor(x), Math.floor(y), world.smokeGrid)
  );
}

function gunMuzzle(v: Vehicle): { x: number; y: number } {
  const len = VEHICLES[v.cls].hullLen * 0.9;
  return { x: v.x + Math.cos(v.turret) * len, y: v.y + Math.sin(v.turret) * len };
}

function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
function rotateToward(cur: number, target: number, maxStep: number): number {
  const d = angleDiff(target, cur);
  if (Math.abs(d) <= maxStep) return target;
  return cur + Math.sign(d) * maxStep;
}
