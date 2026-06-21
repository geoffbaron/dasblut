import { addSuppression, killSoldier } from "./casualty.ts";
import { spawnRicochet } from "./combat.ts";
import { damageBuildings } from "./buildingDamage.ts";
import { SIM_DT } from "./constants.ts";
import { hasLOS } from "./los.ts";
import { TERRAIN } from "./terrain.ts";
import { vehicleCost } from "./terrain.ts";
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

  // Machine gun hoses infantry independently of the main gun's reload.
  if (inf && v.mgAmmo > 0) {
    const d = Math.hypot(inf.x - v.x, inf.y - v.y);
    if (d <= def.mg.rangeCells && hasLOS(world.grid, Math.floor(v.x), Math.floor(v.y), Math.floor(inf.x), Math.floor(inf.y), world.smokeGrid)) {
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
    if (Math.random() < def.gun.heKill * falloff * (1 - cover * 0.5)) killSoldier(world, s, 1.1);
    else addSuppression(s, 0.6 * falloff);
  }
}

function mgShot(world: World, v: Vehicle, target: Soldier, def: (typeof VEHICLES)[keyof typeof VEHICLES], d: number): void {
  sound.play("tank_mg", v.x, v.y);
  if (Math.random() < 0.3) {
    world.effects.push({ kind: "tracer", x0: v.x, y0: v.y, x1: target.x, y1: target.y, ttl: 0.06 });
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

function move(world: World, v: Vehicle, dt: number): void {
  if (v.immobilized || !v.path) return;
  const def = VEHICLES[v.cls];
  const cx = Math.floor(v.x);
  const cy = Math.floor(v.y);
  const cost = world.grid.inBounds(cx, cy) ? vehicleCost(world.grid.get(cx, cy)) : 1;
  const speed = (def.speed / cost) * (v.stance === "fast" ? 1.5 : 1);

  let budget = speed * dt;
  while (budget > 0 && v.path) {
    const wp = v.path[v.pathIndex];
    const tx = wp.cx + 0.5;
    const ty = wp.cy + 0.5;
    const dx = tx - v.x;
    const dy = ty - v.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= budget) {
      v.x = tx;
      v.y = ty;
      budget -= dist;
      v.pathIndex++;
      if (v.pathIndex >= v.path.length) v.path = null;
    } else {
      v.x += (dx / dist) * budget;
      v.y += (dy / dist) * budget;
      budget = 0;
    }
  }
  const mvx = v.x - v.px;
  const mvy = v.y - v.py;
  if (mvx * mvx + mvy * mvy > 1e-6) v.facing = rotateToward(v.facing, Math.atan2(mvy, mvx), def.hullTurn * dt);
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
