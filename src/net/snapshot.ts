// Serialization between the host's authoritative World and the compact messages sent
// to German/spectator clients. The host sends "setup" once (the map + team list) and
// "snapshot" frequently (entity positions/state). Clients rebuild a render-only World.

import { GameMap, MapFeatures, Objective } from "../game/gamemap.ts";
import { Grid } from "../game/grid.ts";
import { Cell } from "../game/pathfinding.ts";
import { Faction, SquadKind, Soldier, Status, Vehicle, World } from "../game/world.ts";
import { WeaponId, WEAPONS } from "../game/weapons.ts";

const STATUS: Status[] = ["active", "wounded", "dead", "surrendered"];

export interface SnapTeam { id: number; name: string; faction: Faction; kind: SquadKind; color: number; }

export interface Setup {
  mapName: string;
  w: number;
  h: number;
  cells: number[];
  features: MapFeatures;
  objectives: Objective[];
  teams: SnapTeam[];
}

// Tight per-entity tuples keep snapshots small at ~8 Hz.
type SnapSoldier = [id: number, f: number, x: number, y: number, fa: number, st: number, teamId: number, seen: number];
type SnapVehicle = [id: number, f: number, x: number, y: number, fa: number, tu: number, st: number, cls: string, name: string];
// Per-objective dynamic state, in objectives order: [owner, capturing, progress*100, contested].
type SnapObj = [owner: number, capturing: number, progress: number, contested: number];

export interface Snapshot {
  time: number;
  phase: number; // 0 deploy, 1 battle
  outcome: string; // "", "win", "lose"
  O: SnapObj[]; oh: number; // objective states + the hold-all-to-win timer
  S: SnapSoldier[];
  V: SnapVehicle[];
  sm: number[]; // sparse smoke: [cellIndex, density*100, …] so both sides see screens
}

// --- host side ---

export function encodeSetup(world: World): Setup {
  return {
    mapName: world.mapName,
    w: world.grid.width,
    h: world.grid.height,
    cells: Array.from(world.grid.cells),
    features: world.features,
    objectives: world.objectives.map((o) => ({ cx: o.cx, cy: o.cy, radius: o.radius })),
    teams: world.teams.map((t) => ({ id: t.id, name: t.name, faction: t.faction, kind: t.kind, color: t.color })),
  };
}

export function encodeSnapshot(world: World): Snapshot {
  const S: SnapSoldier[] = [];
  for (const s of world.soldiers) {
    S.push([s.id, s.faction === "us" ? 0 : 1, round2(s.x), round2(s.y), round2(s.facing), STATUS.indexOf(s.status), s.teamId, s.seen ? 1 : 0]);
  }
  const V: SnapVehicle[] = world.vehicles.map((v) => [
    v.id, v.faction === "us" ? 0 : 1, round2(v.x), round2(v.y), round2(v.facing), round2(v.turret), v.status === "ko" ? 1 : 0, v.cls, v.name,
  ]);
  // Smoke is sparse (only a few dozen cells), so send just the lit cells.
  const sm: number[] = [];
  const g = world.smokeGrid;
  for (let i = 0; i < g.length; i++) if (g[i] > 0.05) { sm.push(i, Math.round(g[i] * 100)); }
  const O: SnapObj[] = world.objectives.map((o) => [
    o.owner === "us" ? 0 : 1,
    o.capturing == null ? -1 : o.capturing === "us" ? 0 : 1,
    Math.round(o.progress * 100),
    o.contested ? 1 : 0,
  ]);
  return {
    time: world.time,
    phase: world.phase === "deploy" ? 0 : 1,
    outcome: world.outcome ?? "",
    O, oh: world.objHoldTimer,
    S, V, sm,
  };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

// --- client side ---

// Build a render-only World from a setup message: real grid/features/objective but no
// spawned units (those arrive via snapshots). Team metadata comes from the host so the
// German player can select and command Axis squads with the host's own ids.
export function buildClientWorld(setup: Setup): World {
  const grid = new Grid(setup.w, setup.h);
  for (let i = 0; i < setup.cells.length; i++) grid.cells[i] = setup.cells[i];
  const map: GameMap = {
    name: setup.mapName,
    grid,
    features: setup.features,
    objectives: setup.objectives,
    spawns: { us: [], axis: [], usVehicles: [], axisVehicles: [] },
  };
  const world = new World(map);
  // Recreate the host's teams (empty rosters; soldiers attach themselves via teamId).
  world.teams = setup.teams.map((t) => ({
    id: t.id, name: t.name, faction: t.faction, color: t.color, kind: t.kind,
    soldierIds: [], leaderId: -1, post: null,
  }));
  return world;
}

export function applySnapshot(world: World, snap: Snapshot): void {
  world.time = snap.time;
  world.phase = snap.phase === 0 ? "deploy" : "battle";
  world.outcome = snap.outcome === "" ? null : (snap.outcome as "win" | "lose");
  world.objHoldTimer = snap.oh;
  // Objectives keep their positions (from setup); only their dynamic state updates.
  for (let i = 0; i < world.objectives.length && i < snap.O.length; i++) {
    const [owner, cap, prog, cont] = snap.O[i];
    const o = world.objectives[i];
    o.owner = owner === 0 ? "us" : "axis";
    o.capturing = cap === -1 ? null : cap === 0 ? "us" : "axis";
    o.progress = prog / 100;
    o.contested = cont === 1;
  }

  // Index the previous soldiers so we can carry interpolation positions across frames.
  const prev = new Map<number, Soldier>();
  for (const s of world.soldiers) prev.set(s.id, s);

  const soldiers: Soldier[] = [];
  const byId = new Map<number, Soldier>();
  for (const t of world.teams) t.soldierIds = [];
  for (const d of snap.S) {
    const [id, f, x, y, fa, st, teamId, seen] = d;
    const old = prev.get(id);
    const s: Soldier = old ?? makeSoldier(id, teamId, f === 0 ? "us" : "axis");
    s.px = old ? old.x : x;
    s.py = old ? old.y : y;
    s.x = x; s.y = y; s.facing = fa; s.status = STATUS[st]; s.seen = seen === 1;
    soldiers.push(s);
    byId.set(id, s);
    const team = world.teams.find((tt) => tt.id === teamId);
    if (team) { team.soldierIds.push(id); if (team.leaderId < 0) team.leaderId = id; }
  }
  world.soldiers = soldiers;
  setMap(world, "byId", byId);

  const prevV = new Map<number, Vehicle>();
  for (const v of world.vehicles) prevV.set(v.id, v);
  const vehicles: Vehicle[] = [];
  const byVid = new Map<number, Vehicle>();
  for (const d of snap.V) {
    const [id, f, x, y, fa, tu, st, cls, name] = d;
    const old = prevV.get(id);
    const v: Vehicle = old ?? makeVehicle(id, f === 0 ? "us" : "axis", cls, name);
    v.px = old ? old.x : x; v.py = old ? old.y : y;
    v.x = x; v.y = y; v.facing = fa; v.turret = tu; v.status = st === 1 ? "ko" : "active";
    vehicles.push(v);
    byVid.set(id, v);
  }
  world.vehicles = vehicles;
  setMap(world, "byVid", byVid);

  // Rebuild the smoke grid from the sparse list so clients see the same screens.
  world.smokeGrid.fill(0);
  const sm = snap.sm;
  if (sm) for (let k = 0; k < sm.length; k += 2) world.smokeGrid[sm[k]] = sm[k + 1] / 100;
}

// World keeps byId/byVid private; on the client we own the instance, so poke them.
function setMap(world: World, key: string, value: unknown): void {
  (world as unknown as Record<string, unknown>)[key] = value;
}

function makeSoldier(id: number, teamId: number, faction: Faction): Soldier {
  const weapon: WeaponId = "rifle";
  return {
    id, teamId, faction, isLeader: false,
    x: 0, y: 0, px: 0, py: 0, path: null, pathIndex: 0, ox: 0, oy: 0, facing: 0, gait: 1,
    weapon, ammo: WEAPONS[weapon].ammo, status: "active", training: 0.6, stance: "move",
    targetId: null, targetVehId: null, manualTargetId: null, fireCell: null, fireSmoke: false, smokeAmmo: 0,
    ambushTimer: 0, fireCD: 0, firedTimer: 0, grenades: 0, grenadeCD: 0,
    suppression: 0, morale: 0.8, state: "steady", seen: false, seenTimer: 0, fleeGoal: null,
  };
}

function makeVehicle(id: number, faction: Faction, cls: string, name: string): Vehicle {
  return {
    id, faction, cls: cls as Vehicle["cls"], name,
    x: 0, y: 0, px: 0, py: 0, facing: 0, turret: 0, path: null, pathIndex: 0,
    stance: "defend", status: "active", immobilized: false, crew: 5, apAmmo: 0, heAmmo: 0, mgAmmo: 0,
    targetVehId: null, targetInfId: null, manualVeh: null, manualInf: null, fireCell: null,
    gunCD: 0, mgCD: 0, suppression: 0, seen: false, seenTimer: 0, smokeCD: 0, backoffCD: 0,
  };
}

// An order the German client sends to the host. Mirrors the full US command set so
// the German experience matches: team moves/fire/smoke/postures and vehicle orders.
export interface AxisOrder {
  kind:
    | "move" | "fast" | "sneak" | "fire" | "smoke" | "defend" | "ambush"
    | "vehMove" | "vehFast" | "vehFire" | "vehDefend";
  teamId?: number;
  vid?: number;
  enemyId?: number; // focus-fire a specific spotted enemy
  x?: number; y?: number; // world coords (vehicle fire)
  cell?: Cell;
}
