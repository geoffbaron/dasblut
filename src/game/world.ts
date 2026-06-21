import { GameMap, MapFeatures, SquadSpawn } from "./gamemap.ts";
import { Grid } from "./grid.ts";
import { Cell, findPath, smoothPath } from "./pathfinding.ts";
import { vehicleCost, vehiclePassable } from "./terrain.ts";
import { VehicleClass, VEHICLES } from "./vehicleDefs.ts";
import { WeaponId, WEAPONS } from "./weapons.ts";

export type Faction = "us" | "axis";
export type Status = "active" | "wounded" | "dead" | "surrendered";
// Visible morale/suppression state, derived each step. The Close Combat spectrum.
export type MoraleState = "steady" | "shaken" | "pinned" | "panicked" | "routing";
// Posture the player commands. Move/Fast/Sneak are movement orders; Defend/Ambush
// are held positions. Governs speed, whether/when men fire, and how easily spotted.
export type Stance = "move" | "fast" | "sneak" | "defend" | "ambush";

// A deliberately small, ECS-flavored world: flat arrays of entities with plain
// component data. Enough structure to grow into a real ECS later, no ceremony now.
export interface Soldier {
  id: number;
  teamId: number;
  faction: Faction;
  isLeader: boolean;
  // Position in cell-space (fractional). One cell ≈ 2 m.
  x: number;
  y: number;
  px: number;
  py: number;
  // Movement.
  path: Cell[] | null;
  pathIndex: number;
  ox: number;
  oy: number;
  facing: number;
  gait: number; // small per-man speed multiplier so a squad doesn't march in lockstep
  // Combat.
  weapon: WeaponId;
  ammo: number;
  status: Status;
  training: number; // 0..1, veterancy
  stance: Stance;
  targetId: number | null;
  targetVehId: number | null; // AT men engage enemy armor
  manualTargetId: number | null; // player-designated focus-fire target
  manualVehId: number | null; // player-designated enemy tank for AT men to engage
  fireCell: Cell | null; // player-designated area (suppressing) fire point
  fireSmoke: boolean; // when firing on fireCell, lay smoke instead of HE (mortars)
  smokeAmmo: number; // smoke rounds remaining (mortars only)
  ambushTimer: number; // >0 → opening-volley bonus active
  fireCD: number; // seconds until the next shot is ready
  firedTimer: number; // >0 shortly after firing (muzzle flash / easier to spot)
  grenades: number; // hand grenades remaining
  grenadeCD: number; // seconds until this man can throw again
  // Psychology.
  suppression: number; // 0..1 short-term, from incoming fire
  morale: number; // 0..1 longer-term resolve
  state: MoraleState;
  // Perception.
  seen: boolean; // currently spotted by the opposing faction
  seenTimer: number;
  fleeGoal: Cell | null;
}

export interface Team {
  id: number;
  name: string;
  faction: Faction;
  color: number;
  soldierIds: number[];
  leaderId: number;
  post: Cell | null; // AI-assigned defensive position (enemy squads)
  kind: SquadKind; // weapon mix: rifle / mg / at / mortar
}

export type EffectKind = "tracer" | "flash" | "hit" | "ap" | "spark" | "smoke" | "fire" | "lob" | "ricochet" | "blocked";

// A burning smoke canister that emits into the smoke grid over its lifetime.
export interface SmokeSource { cx: number; cy: number; t: number; }

// Live capture-and-hold state for one objective.
export interface ObjState {
  cx: number;
  cy: number;
  radius: number;
  owner: Faction; // who currently controls it
  capturing: Faction | null; // who is in the middle of flipping it
  progress: number; // 0..1 toward the capturing side taking it
  contested: boolean; // both sides present
}
export interface Effect {
  kind: EffectKind;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  ttl: number;
  maxTtl?: number; // for effects that grow/fade over their lifetime (smoke)
}

// An armored vehicle. Hull and turret face independently; armor is directional, so
// where a shot lands (front/side/rear) decides whether it bounces or brews up.
export interface Vehicle {
  id: number;
  faction: Faction;
  cls: VehicleClass;
  name: string;
  x: number;
  y: number;
  px: number;
  py: number;
  facing: number; // hull facing
  turret: number; // turret facing (gun direction)
  path: Cell[] | null;
  pathIndex: number;
  stance: "move" | "fast" | "defend";
  status: "active" | "ko";
  immobilized: boolean;
  crew: number;
  apAmmo: number;
  heAmmo: number;
  mgAmmo: number;
  targetVehId: number | null;
  targetInfId: number | null;
  manualVeh: number | null; // player-directed armor target
  manualInf: number | null; // player-directed infantry target
  fireCell: Cell | null; // player-directed ground bombardment (HE at a point)
  gunCD: number;
  mgCD: number;
  suppression: number; // crew suppression — slows the gun, hurts spotting
  seen: boolean;
  seenTimer: number;
  smokeCD: number; // emits smoke while burning
  backoffCD: number; // throttle on the "reverse away from close infantry" reflex
}

const FORMATION: { ox: number; oy: number }[] = [
  { ox: 0, oy: 0 },
  { ox: -1, oy: 0 },
  { ox: 1, oy: 0 },
  { ox: -1, oy: 1 },
  { ox: 1, oy: 1 },
  { ox: 0, oy: 1 },
  { ox: -1, oy: -1 },
  { ox: 1, oy: -1 },
];

// Per-soldier spacing of the spawn formation, in cells. Kept tight so a squad
// lands as a recognizable clump the player can grab, not a scattered line.
const FORMATION_SPACING = 0.42;

// Squad templates decide the weapon mix. The first man is always the leader (SMG);
// the rest follow the list, padded with riflemen. This is what makes an AT or
// mortar team meaningfully different from a rifle squad.
export type SquadKind = "rifle" | "mg" | "at" | "mortar";

function squadLoadout(kind: SquadKind, count: number, faction: Faction): WeaponId[] {
  const at: WeaponId = faction === "us" ? "bazooka" : "panzerfaust";
  const tail: WeaponId[] =
    kind === "mg" ? ["lmg", "lmg", "rifle"]
    : kind === "at" ? [at, at, "rifle"]
    : kind === "mortar" ? ["mortar", "rifle", "rifle"] // a single tube + crew
    : ["lmg", "rifle", "rifle"]; // rifle squad
  const out: WeaponId[] = ["smg"];
  for (let i = 1; i < count; i++) out.push(tail[i - 1] ?? "rifle");
  return out;
}

export class World {
  grid: Grid;
  features: MapFeatures;
  soldiers: Soldier[] = [];
  teams: Team[] = [];
  vehicles: Vehicle[] = [];
  effects: Effect[] = [];
  time = 0;
  phase: "deploy" | "battle" = "deploy";
  // Deployment zones (in grid cells): US south band, Axis north band.
  deployY0Us: number = 0;   // US zone: rows deployY0Us..grid.height-1
  deployY1Axis: number = 0; // Axis zone: rows 0..deployY1Axis-1
  selectedTeamId: number | null = null;
  selectedTeamIds: Set<number> = new Set();
  selectedVehicleId: number | null = null;
  // When a human (multiplayer German) is commanding the Axis, suppress the enemy AI.
  axisHuman = false;
  outcome: "win" | "lose" | null = null;

  // Capture-and-hold objectives (1-3). Each starts under the defender (Axis); the
  // attacker (US) wins by controlling ALL of them at once for objHoldTimer seconds.
  objectives: ObjState[] = [];
  objHoldTimer = 0; // seconds the US has held EVERY objective simultaneously

  // Battle clock + enemy-AI throttle.
  aiAccum = 0;
  aiThreatPrev = false;

  // US visibility shroud, recomputed on the visibility tick.
  visGrid: Uint8Array;
  visVersion = 0;
  visAccum = 0;

  // Per-cell accumulated structural damage to building cells (Wall/Floor). When a
  // cell's damage crosses 1.0 it collapses to Rubble (a breach). `buildDmgVersion`
  // bumps whenever damage or collapse changes, so the renderer can redraw its overlay.
  buildDmg: Float32Array;
  buildDmgVersion = 0;

  // Per-cell smoke density (0..~1.6). Decays over time; cells above SMOKE_LOS_BLOCK
  // break line of sight, so a mortar smoke screen conceals units moving behind it.
  smokeGrid: Float32Array;
  // Active smoke canisters: each keeps emitting into smokeGrid (blooming then holding)
  // until it burns out. `t` is seconds since the shell landed.
  smokeSources: SmokeSource[] = [];

  private nextId = 1;
  private byId = new Map<number, Soldier>();
  private byVid = new Map<number, Vehicle>();

  readonly mapName: string;

  constructor(map: GameMap, objectiveCount = map.objectives.length) {
    this.mapName = map.name;
    this.grid = map.grid;
    this.features = map.features;
    // Use the first N candidate objectives; all start under the defender.
    const n = Math.max(1, Math.min(objectiveCount, map.objectives.length));
    this.objectives = map.objectives.slice(0, n).map((o) => ({
      cx: o.cx, cy: o.cy, radius: o.radius,
      owner: "axis", capturing: null, progress: 0, contested: false,
    }));
    this.visGrid = new Uint8Array(this.grid.width * this.grid.height);
    this.buildDmg = new Float32Array(this.grid.width * this.grid.height);
    this.smokeGrid = new Float32Array(this.grid.width * this.grid.height);
    // Deployment zones: each side gets the outer 25% of map depth.
    this.deployY0Us    = Math.floor(this.grid.height * 0.75);
    this.deployY1Axis  = Math.ceil(this.grid.height  * 0.25);

    for (const s of map.spawns.us) this.spawnSquad(s, "us", 0x4f7fd1, 0.65);
    for (const s of map.spawns.axis) this.spawnSquad(s, "axis", 0xc4514a, 0.6);
    for (const v of map.spawns.usVehicles) this.spawnVehicle(v.cls, v.cx, v.cy, v.facing);
    for (const v of map.spawns.axisVehicles) this.spawnVehicle(v.cls, v.cx, v.cy, v.facing);
  }

  /** True when the US controls every objective — the win/hold condition. */
  usHoldsAll(): boolean {
    return this.objectives.length > 0 && this.objectives.every((o) => o.owner === "us");
  }

  /** Center point of all objectives, for framing the camera. */
  objectivesCentroid(): { cx: number; cy: number } {
    const n = this.objectives.length || 1;
    let cx = 0, cy = 0;
    for (const o of this.objectives) { cx += o.cx; cy += o.cy; }
    return { cx: cx / n, cy: cy / n };
  }

  private spawnVehicle(cls: VehicleClass, cx: number, cy: number, facing: number): void {
    const def = VEHICLES[cls];
    const v: Vehicle = {
      id: this.nextId++,
      faction: def.faction,
      cls,
      name: def.name,
      x: cx + 0.5,
      y: cy + 0.5,
      px: cx + 0.5,
      py: cy + 0.5,
      facing,
      turret: facing,
      path: null,
      pathIndex: 0,
      stance: def.faction === "axis" ? "defend" : "move",
      status: "active",
      immobilized: false,
      crew: def.crew,
      apAmmo: def.apAmmo,
      heAmmo: def.heAmmo,
      mgAmmo: 2000,
      targetVehId: null,
      targetInfId: null,
      manualVeh: null,
      manualInf: null,
      fireCell: null,
      gunCD: 0,
      mgCD: 0,
      suppression: 0,
      seen: false,
      seenTimer: 0,
      smokeCD: 0,
      backoffCD: 0,
    };
    this.vehicles.push(v);
    this.byVid.set(v.id, v);
  }

  vehicle(id: number): Vehicle | undefined {
    return this.byVid.get(id);
  }

  private spawnSquad(spawn: SquadSpawn, faction: Faction, color: number, training: number): void {
    const count = spawn.count;
    const kind: SquadKind = spawn.kind ?? "rifle";
    const team: Team = {
      id: this.nextId++,
      name: spawn.name,
      faction,
      color,
      soldierIds: [],
      leaderId: -1,
      post: null,
      kind,
    };
    this.teams.push(team);
    const loadout = squadLoadout(kind, count, faction);
    for (let i = 0; i < count; i++) {
      const f = FORMATION[i % FORMATION.length];
      const sx = spawn.cx + f.ox * FORMATION_SPACING + 0.5;
      const sy = spawn.cy + f.oy * FORMATION_SPACING + 0.5;
      const isLeader = i === 0;
      const weapon: WeaponId = loadout[i] ?? "rifle";
      const s: Soldier = {
        id: this.nextId++,
        teamId: team.id,
        faction,
        isLeader,
        x: sx,
        y: sy,
        px: sx,
        py: sy,
        path: null,
        pathIndex: 0,
        ox: f.ox,
        oy: f.oy,
        facing: faction === "us" ? -Math.PI / 2 : Math.PI / 2,
        gait: 0.9 + Math.random() * 0.22, // 0.90–1.12: each man's natural pace

        weapon,
        ammo: WEAPONS[weapon].ammo,
        status: "active",
        training,
        stance: faction === "axis" ? "defend" : "move",
        targetId: null,
        targetVehId: null,
        manualTargetId: null,
        manualVehId: null,
        fireCell: null,
        fireSmoke: false,
        smokeAmmo: WEAPONS[weapon].indirect ? 2 : 0,
        ambushTimer: 0,
        fireCD: Math.random() * 0.5,
        firedTimer: 0,
        // Riflemen and SMG men carry grenades; specialists (LMG/AT/mortar) don't.
        grenades: weapon === "rifle" || weapon === "smg" ? 5 : 0,
        grenadeCD: 0,
        suppression: 0,
        morale: 0.6 + training * 0.3,
        state: "steady",
        seen: false,
        seenTimer: 0,
        fleeGoal: null,
      };
      this.soldiers.push(s);
      this.byId.set(s.id, s);
      team.soldierIds.push(s.id);
      if (isLeader) team.leaderId = s.id;
    }
  }

  team(id: number): Team | undefined {
    return this.teams.find((t) => t.id === id);
  }

  soldier(id: number): Soldier | undefined {
    return this.byId.get(id);
  }

  /** Find the team (of the given faction) whose nearest active soldier is within `radius`. */
  pickTeamAt(x: number, y: number, radius: number, faction: Faction = "us"): number | null {
    let best: number | null = null;
    let bestDist = radius * radius;
    for (const s of this.soldiers) {
      if (s.faction !== faction || s.status !== "active") continue;
      const dx = s.x - x;
      const dy = s.y - y;
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        best = s.teamId;
      }
    }
    return best;
  }

  /**
   * Issue a movement order (Move/Fast/Sneak): each soldier paths to a formation slot.
   * Returns true if at least one soldier found a route — false means the destination
   * is unreachable, so the caller can flag the order as impossible.
   */
  orderMove(teamId: number, target: Cell, stance: Stance = "move"): boolean {
    const team = this.team(teamId);
    if (!team) return false;
    let anyPathed = false;
    let anyActive = false;
    for (const id of team.soldierIds) {
      const s = this.soldier(id)!;
      if (s.status !== "active") continue;
      anyActive = true;
      s.fleeGoal = null;
      s.stance = stance;
      s.manualTargetId = null;
      s.manualVehId = null;
      s.fireCell = null;
      s.fireSmoke = false;
      const goal = this.nearestPassable(target.cx + s.ox, target.cy + s.oy, target);
      const start: Cell = { cx: Math.floor(s.x), cy: Math.floor(s.y) };
      const raw = findPath(this.grid, start, goal);
      if (raw && raw.length > 1) {
        s.path = smoothPath(this.grid, raw);
        s.pathIndex = 1;
        anyPathed = true;
      } else if (raw && raw.length === 1 && start.cx === goal.cx && start.cy === goal.cy) {
        // Already standing on the goal cell — a valid (no-op) order, not a failure.
        s.path = null;
        anyPathed = true;
      } else {
        s.path = null;
      }
    }
    return anyPathed || !anyActive;
  }

  /** Hold position in a Defend or Ambush posture, facing the nearest known threat. */
  orderPosture(teamId: number, stance: Stance): void {
    const team = this.team(teamId);
    if (!team) return;
    for (const id of team.soldierIds) {
      const s = this.soldier(id)!;
      if (s.status !== "active") continue;
      s.path = null;
      s.fleeGoal = null;
      s.stance = stance;
      s.manualTargetId = null;
      s.manualVehId = null;
      s.fireCell = null;
      s.fireSmoke = false;
      const enemy = this.nearestSpottedEnemy(s);
      if (enemy) s.facing = Math.atan2(enemy.y - s.y, enemy.x - s.x);
    }
  }

  /** Focus-fire a specific spotted enemy. */
  orderFireUnit(teamId: number, enemyId: number): void {
    const team = this.team(teamId);
    if (!team) return;
    for (const id of team.soldierIds) {
      const s = this.soldier(id)!;
      if (s.status !== "active") continue;
      s.manualTargetId = enemyId;
      s.manualVehId = null;
      s.fireCell = null;
      s.fireSmoke = false;
      if (s.stance === "sneak" || s.stance === "ambush") s.stance = "defend";
    }
  }

  /** Suppress a patch of ground (a window, treeline, suspected position). */
  orderAreaFire(teamId: number, cell: Cell): void {
    const team = this.team(teamId);
    if (!team) return;
    for (const id of team.soldierIds) {
      const s = this.soldier(id)!;
      if (s.status !== "active") continue;
      s.path = null;
      s.manualTargetId = null;
      s.manualVehId = null;
      s.fireCell = cell;
      s.fireSmoke = false;
      if (s.stance === "sneak" || s.stance === "ambush") s.stance = "defend";
      s.facing = Math.atan2(cell.cy + 0.5 - s.y, cell.cx + 0.5 - s.x);
    }
  }

  /**
   * Point a team's anti-tank men at a specific enemy tank. They lock onto it and fire
   * the instant it's in range with line of sight (the combat step enforces both), so the
   * player can call the shot before it closes. Returns false if the team has no AT men,
   * so the UI can fall back to area fire. The rest of the squad just faces the threat.
   */
  orderFireVehicle(teamId: number, vehId: number): boolean {
    const team = this.team(teamId);
    if (!team) return false;
    const veh = this.vehicle(vehId);
    let anyAT = false;
    for (const id of team.soldierIds) {
      const s = this.soldier(id)!;
      if (s.status !== "active") continue;
      s.fireCell = null;
      s.fireSmoke = false;
      s.manualTargetId = null;
      if (WEAPONS[s.weapon].penetration != null) {
        s.path = null;
        s.manualVehId = vehId;
        if (s.stance === "sneak" || s.stance === "ambush") s.stance = "defend";
        anyAT = true;
      } else {
        s.manualVehId = null;
      }
      if (veh) s.facing = Math.atan2(veh.y - s.y, veh.x - s.x);
    }
    return anyAT;
  }

  /**
   * Order a mortar team to lay a smoke screen on a cell. Only the indirect-fire tubes
   * respond (the rest of the team holds); returns false if the team has no mortars,
   * so the UI can reflect that smoke is a mortar-only order.
   */
  orderSmoke(teamId: number, cell: Cell): boolean {
    const team = this.team(teamId);
    if (!team) return false;
    let anyTube = false;
    for (const id of team.soldierIds) {
      const s = this.soldier(id)!;
      if (s.status !== "active") continue;
      if (WEAPONS[s.weapon].indirect && s.smokeAmmo > 0) {
        s.path = null;
        s.manualTargetId = null;
        s.fireCell = cell;
        s.fireSmoke = true;
        anyTube = true;
      } else {
        // Riflemen/leader just hold — no point spraying the smoked ground.
        s.fireCell = null;
        s.fireSmoke = false;
      }
    }
    return anyTube;
  }

  /** Stop all fire orders on a team — clears fireCell and resets to defend-in-place. */
  orderCeaseFire(teamId: number): void {
    const team = this.team(teamId);
    if (!team) return;
    for (const id of team.soldierIds) {
      const s = this.soldier(id)!;
      if (s.status !== "active") continue;
      s.fireCell = null;
      s.manualTargetId = null;
      s.manualVehId = null;
      s.fireSmoke = false;
    }
  }

  /** True if any active soldier in the team has a fire order assigned. */
  teamIsFiring(teamId: number): boolean {
    const team = this.team(teamId);
    if (!team) return false;
    return team.soldierIds.some((id) => {
      const s = this.soldier(id);
      return s?.status === "active" && (s.fireCell != null || s.manualTargetId != null);
    });
  }

  // --- Vehicle selection & orders ---

  pickVehicleAt(x: number, y: number, radius: number, faction: Faction = "us"): number | null {
    let best: number | null = null;
    let bestD = radius * radius;
    for (const v of this.vehicles) {
      if (v.faction !== faction || v.status === "ko") continue;
      const d = (v.x - x) ** 2 + (v.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = v.id;
      }
    }
    return best;
  }

  private vehPathOpts() {
    return {
      passable: (cx: number, cy: number) => this.grid.inBounds(cx, cy) && vehiclePassable(this.grid.get(cx, cy)),
      cost: (cx: number, cy: number) => vehicleCost(this.grid.get(cx, cy)),
    };
  }

  /** Returns true if the vehicle found a route; false means the target is unreachable. */
  orderVehicleMove(vid: number, target: Cell, fast: boolean): boolean {
    const v = this.vehicle(vid);
    if (!v || v.status === "ko" || v.immobilized) return false;
    v.stance = fast ? "fast" : "move";
    v.manualVeh = null;
    v.manualInf = null;
    v.fireCell = null;
    const opts = this.vehPathOpts();
    const start: Cell = { cx: Math.floor(v.x), cy: Math.floor(v.y) };
    // A click can land on a building/woods/water. Try the nearest drivable cells in
    // expanding rings until one actually routes — so the tank pulls up next to the
    // target instead of silently refusing the order and looking "stuck".
    for (const goal of this.vehicleGoalCandidates(target.cx, target.cy)) {
      const raw = findPath(this.grid, start, goal, opts);
      if (raw && raw.length > 1) {
        v.path = smoothPath(this.grid, raw, opts);
        v.pathIndex = 1;
        return true;
      }
    }
    v.path = null;
    return false;
  }

  // Drivable goal cells near a click, nearest first, so orderVehicleMove can retry until
  // it finds one the tank can actually reach.
  private vehicleGoalCandidates(cx: number, cy: number): Cell[] {
    const out: Cell[] = [];
    const R = 18;
    const consider = (x: number, y: number) => {
      if (this.grid.inBounds(x, y) && vehiclePassable(this.grid.get(x, y))) out.push({ cx: x, cy: y });
    };
    consider(cx, cy);
    for (let r = 1; r <= R && out.length < 24; r++) {
      for (let dx = -r; dx <= r; dx++) { consider(cx + dx, cy - r); consider(cx + dx, cy + r); }
      for (let dy = -r + 1; dy <= r - 1; dy++) { consider(cx - r, cy + dy); consider(cx + r, cy + dy); }
    }
    return out;
  }

  orderVehiclePosture(vid: number): void {
    const v = this.vehicle(vid);
    if (!v || v.status === "ko") return;
    v.path = null;
    v.stance = "defend";
  }

  /**
   * Direct a tank's fire. If the click lands on a spotted enemy, lock onto it;
   * otherwise treat it as a ground-bombardment order — the tank shells that spot
   * with HE, area-suppressing whatever's there (a building, treeline, suspected
   * position) even with nothing visibly in the open.
   */
  orderVehicleFire(vid: number, x: number, y: number): void {
    const v = this.vehicle(vid);
    if (!v || v.status === "ko") return;
    const veh = this.vehicles.find(
      (t) => t.faction !== v.faction && t.status !== "ko" && t.seen && Math.hypot(t.x - x, t.y - y) < 1.8,
    );
    if (veh) {
      v.manualVeh = veh.id;
      v.manualInf = null;
      v.fireCell = null;
      return;
    }
    const inf = this.soldiers.find(
      (s) => s.faction !== v.faction && s.status === "active" && s.seen && Math.hypot(s.x - x, s.y - y) < 1.6,
    );
    if (inf) {
      v.manualInf = inf.id;
      v.manualVeh = null;
      v.fireCell = null;
      return;
    }
    // Empty ground: bombard the cell.
    v.fireCell = { cx: Math.floor(x), cy: Math.floor(y) };
    v.manualVeh = null;
    v.manualInf = null;
  }

  nearestSpottedEnemy(s: Soldier): Soldier | null {
    let best: Soldier | null = null;
    let bestD = Infinity;
    for (const t of this.soldiers) {
      if (t.faction === s.faction || t.status !== "active" || !t.seen) continue;
      const d = (t.x - s.x) ** 2 + (t.y - s.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    return best;
  }

  nearestPassable(cx: number, cy: number, fallback: Cell): Cell {
    if (this.grid.passable(cx, cy)) return { cx, cy };
    if (this.grid.passable(fallback.cx, fallback.cy)) return fallback;
    for (let r = 1; r <= 4; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (this.grid.passable(cx + dx, cy + dy)) return { cx: cx + dx, cy: cy + dy };
        }
      }
    }
    return fallback;
  }
}
