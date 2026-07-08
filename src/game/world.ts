import { GameMap, MapFeatures, SquadSpawn } from "./gamemap.ts";
import { Grid } from "./grid.ts";
import { Cell, findPath, smoothPath } from "./pathfinding.ts";
import { isBuildingInterior, Terrain, TERRAIN, vehicleCost, vehiclePassable } from "./terrain.ts";
import { VehicleClass, VEHICLES } from "./vehicleDefs.ts";
import { WeaponId, WEAPONS } from "./weapons.ts";

export type Faction = "us" | "axis";
export type Status = "active" | "wounded" | "dead" | "surrendered";
// Visible morale/suppression state, derived each step. The Close Combat spectrum.
export type MoraleState = "steady" | "shaken" | "pinned" | "panicked" | "routing";
// Posture the player commands. Move/Fast/Sneak are movement orders; Defend/Ambush
// are held positions. Governs speed, whether/when men fire, and how easily spotted.
export type Stance = "move" | "fast" | "sneak" | "defend" | "ambush" | "charge";

// The setting a battle is fought in. Each era swaps the whole armoury and unit roster.
export type Era = "ww2" | "acw" | "medieval" | "starwars";

// Eras that fight like WW2 — dispersed squads moving loose from cover to cover with
// modern (or better) small arms, short spotting ranges, and armored vehicles. The other
// eras (ACW, medieval) fight in massed formed lines in the open.
export function modernEra(era: Era): boolean {
  return era === "ww2" || era === "starwars";
}

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
  setupTime: number; // seconds an MG has been deployed-and-stationary (gates MG fire)
  meleeCD: number; // seconds until this man can strike again in hand-to-hand
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
  // Hero unit (optional "Support" pick, one per side): a named, period-accurate elite
  // fighter — tougher and deadlier than a line soldier, not a different kind of unit.
  hero?: boolean;
  heroHP?: number; // extra lives: a would-be kill/wound is shrugged off until this hits 0 (see casualty.ts)
  heroMelee?: number; // melee kill-chance multiplier (champion's greatsword, Jedi/Sith's blade)
  deflect?: number; // 0..1 chance to deflect an incoming blaster bolt outright (lightsaber only)
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
  volleyCD: number; // Civil War line infantry: shared reload timer so the squad fires by volley
  // Marching in formation: a shared guide route the squad's centre walks along; each man
  // holds his slot (ox,oy) relative to the advancing centre, so the whole body moves as one
  // column instead of scattering. Null when the squad isn't marching in formation.
  march: { guide: Cell[]; idx: number; x: number; y: number; hx: number; hy: number } | null;
}

export type EffectKind = "tracer" | "shotline" | "arrow" | "flash" | "hit" | "ap" | "rocket" | "spark" | "smoke" | "fire" | "lob" | "ricochet" | "blocked" | "blood" | "deflect";

// A burning smoke canister that emits into the smoke grid over its lifetime.
export interface SmokeSource { cx: number; cy: number; t: number; }

// A grenade in flight: thrown toward a (scattered) landing point, it arcs for `fuse`
// seconds and only then detonates — so the burst is synced to where and when it lands,
// not to the throw. An anti-tank bundle carries the id of the tank it's meant for.
export interface PendingGrenade {
  x: number;
  y: number;
  fuse: number;
  faction: Faction;
  tankId: number | null;
}

// Live capture-and-hold state for one objective.
export interface ObjState {
  cx: number;
  cy: number;
  radius: number;
  owner: Faction | "neutral"; // who currently controls it ("neutral" = up for grabs)
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
  color?: number; // tracer/ap override — Star Wars blaster bolts are faction-colored
}

// Star Wars bolt colors, straight from the first corridor fight in A New Hope: Rebel
// fleet troopers fire BLUE bolts, stormtroopers fire RED. Undefined outside that era,
// so every other period keeps its normal amber tracers.
export function boltColor(era: Era, f: Faction): number | undefined {
  if (era !== "starwars") return undefined;
  return f === "us" ? 0x4da2ff : 0xff3d30;
}

// A line for the casualty ticker and the end-of-battle report. `faction` is whoever
// suffered the loss (the side that's down a man or a vehicle), not who caused it.
export interface BattleEvent {
  seq: number; // monotonic — lets multiplayer clients ask for "everything after N"
  time: number; // world.time this happened
  faction: Faction;
  kind: "kill" | "wound" | "vehicle";
  text: string; // e.g. "Rifle killed", "M4 Sherman destroyed"
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

// A soldier's slot within his unit. WW2 squads use the loose blob above. Civil War units
// fall in shoulder-to-shoulder: infantry and cavalry form a wide two-rank LINE (men along
// the x axis, facing the enemy across the field), while a gun crew clusters tight around
// its piece. Offsets are returned in cells for ACW (used directly) and in blob units for
// WW2 (scaled by FORMATION_SPACING at spawn).
function formationSlot(era: Era, kind: SquadKind, i: number, count: number): { ox: number; oy: number } {
  if (modernEra(era)) return FORMATION[i % FORMATION.length]; // WW2/Star Wars: loose blob
  // ACW and medieval both fall in as ordered lines around a crew-served engine.
  if (kind === "artillery") {
    const crew = [{ ox: 0, oy: 0 }, { ox: -0.9, oy: 0.7 }, { ox: 0.9, oy: 0.7 }, { ox: -0.9, oy: -0.7 }, { ox: 0.9, oy: -0.7 }];
    return crew[i % crew.length];
  }
  const ranks = 2;
  const perRank = Math.ceil(count / ranks);
  const col = i % perRank;
  const rank = Math.floor(i / perRank);
  const spacing = kind === "cavalry" ? 1.1 : 0.8; // horsemen (and knights) need more elbow room
  return { ox: (col - (perRank - 1) / 2) * spacing, oy: rank * 0.9 };
}

// Squad templates decide the weapon mix. The first man is always the leader (SMG);
// the rest follow the list, padded with riflemen. This is what makes an AT or
// mortar team meaningfully different from a rifle squad.
export type SquadKind =
  | "rifle" | "mg" | "at" | "mortar" // WW2
  | "infantry" | "cavalry" | "artillery" // ACW (also medieval foot/horse/siege)
  | "archers" // medieval
  | "hero"; // a one-man elite unit, any era

function squadLoadout(kind: SquadKind, count: number, faction: Faction, era: Era): WeaponId[] {
  if (era === "acw") return acwLoadout(kind, count);
  if (era === "medieval") return medievalLoadout(kind, count);
  if (era === "starwars") return starwarsLoadout(kind, count);
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

// Star Wars loadouts, mirroring the WW2 squad shapes: every trooper carries a blaster;
// support teams swap in a repeating blaster, shoulder rockets (the anti-walker arm both
// sides field), or the same indirect mortar tube (a proton mortar in all but name).
function starwarsLoadout(kind: SquadKind, count: number): WeaponId[] {
  const tail: WeaponId[] =
    kind === "mg" ? ["heavyblaster", "heavyblaster", "blaster"]
    : kind === "at" ? ["rocket", "rocket", "blaster"]
    : kind === "mortar" ? ["mortar", "blaster", "blaster"]
    : ["heavyblaster", "blaster", "blaster"]; // trooper squad
  const out: WeaponId[] = ["blaster"];
  for (let i = 1; i < count; i++) out.push(tail[i - 1] ?? "blaster");
  return out;
}

// Civil War loadouts. A line-infantry platoon is all rifle muskets; cavalry all carbines;
// an artillery section is a crew of cannoneers (rifle muskets for self-defence) serving a
// single field gun — kill the crew and the gun falls silent.
function acwLoadout(kind: SquadKind, count: number): WeaponId[] {
  if (kind === "cavalry") return Array.from({ length: count }, () => "carbine" as WeaponId);
  if (kind === "artillery") {
    const out: WeaponId[] = ["riflemusket"]; // the gun sergeant
    for (let i = 1; i < count; i++) out.push(i === 1 ? "cannon" : "riflemusket"); // one gun + crew
    return out;
  }
  return Array.from({ length: count }, () => "riflemusket" as WeaponId); // line infantry
}

// Medieval loadouts. Men-at-arms are a shieldwall of swords stiffened with spearmen;
// archers are massed longbows; knights ride with the lance; a siege crew serves a single
// catapult (swords for self-defence) — kill the crew and the engine is silenced.
function medievalLoadout(kind: SquadKind, count: number): WeaponId[] {
  if (kind === "cavalry") return Array.from({ length: count }, () => "lance" as WeaponId);
  if (kind === "archers") return Array.from({ length: count }, () => "bow" as WeaponId);
  if (kind === "artillery") {
    const out: WeaponId[] = ["sword"]; // the master gunner
    for (let i = 1; i < count; i++) out.push(i === 1 ? "catapult" : "sword"); // one engine + crew
    return out;
  }
  // Men-at-arms: mostly swords, roughly every third man a spearman to anchor the line.
  return Array.from({ length: count }, (_, i) => (i % 3 === 1 ? "spear" : "sword") as WeaponId);
}

// The Hero: a single named, period-accurate elite fighter, fielded like the
// tank/gun "Support" pick — a Jedi/Sith duelist in Star Wars, a Thompson-toting
// one-man-army NCO in WW2, a Henry-repeater-armed officer in the Civil War, an
// armored champion in melee. Tougher (heroHP) and deadlier (its own weapon stats,
// or heroMelee for the two melee heroes) than a line soldier, not a new kind of unit.
function heroWeapon(era: Era): WeaponId {
  if (era === "acw") return "henry";
  if (era === "medieval") return "champion";
  if (era === "starwars") return "lightsaber";
  return "tommygun";
}
function heroLabel(era: Era, f: Faction): string {
  if (era === "acw") return f === "us" ? "Union Hero" : "Confederate Hero";
  if (era === "medieval") return "Champion";
  if (era === "starwars") return f === "us" ? "Jedi Knight" : "Sith Lord";
  return "War Hero";
}
// Extra lives before a hero can actually be killed/wounded like anyone else — see
// killSoldier/woundSoldier in casualty.ts. The Jedi/Sith leans on deflection instead,
// so needs fewer.
function heroLives(era: Era): number {
  return era === "starwars" ? 3 : era === "medieval" ? 4 : 3;
}

// Remap a WW2 spawn list to a Civil War order of battle, keeping the deployment
// positions: large rifle-musket platoons with one mounted cavalry troop among them.
// (Artillery is added separately from the support-unit selector.)
function acwOrbat(list: SquadSpawn[]): SquadSpawn[] {
  const ord = ["1st", "2nd", "3rd", "4th", "5th", "6th"];
  return list.map((s, i) => {
    const cav = i === 2; // the middle slot rides
    return {
      name: cav ? "Cavalry Troop" : `${ord[i] ?? i + 1} Platoon`,
      cx: s.cx, cy: s.cy,
      count: cav ? 10 : 18,
      kind: cav ? "cavalry" : "infantry",
    };
  });
}

// Remap a WW2 spawn list to a medieval host: large bodies of men-at-arms, a company of
// archers, and one mounted knightly conroi. (Siege engines come from the support selector.)
function medievalOrbat(list: SquadSpawn[]): SquadSpawn[] {
  const ord = ["1st", "2nd", "3rd", "4th", "5th", "6th"];
  return list.map((s, i) => {
    const knights = i === 2; // the middle body rides
    const archers = i === 4; // a single company of archers; the rest are men-at-arms
    const kind: SquadKind = knights ? "cavalry" : archers ? "archers" : "infantry";
    const name = knights ? "Knights" : archers ? `${ord[i] ?? i + 1} Archers` : `${ord[i] ?? i + 1} Men-at-Arms`;
    return { name, cx: s.cx, cy: s.cy, count: knights ? 10 : archers ? 14 : 18, kind };
  });
}

// Scatter era-appropriate field fortifications across the contested ground when the player
// asks for extra cover. Everything is baked straight into the terrain grid (so combat/LOS
// read it for free) and, for hedges, into the feature list so they render as bocage.
//   WW2      → hedgerows, trenches, and sandbag bunkers
//   Civil War→ ditches (dug cover) and rail fences
//   Medieval → earthworks and timber palisades
function addFortifications(
  grid: Grid,
  features: MapFeatures,
  era: Era,
  objectives: { cx: number; cy: number; radius: number }[],
  northY1: number,
  southY0: number,
): void {
  const W = grid.width, H = grid.height;
  // Fortifications only go on natural open ground — never on paved roads, water, woods, or
  // buildings. A line/hedge simply skips any cell that isn't open, so it breaks cleanly at a
  // road or a house (a hedgerow with a gate) instead of being painted straight across it.
  const buildable = (cx: number, cy: number) => {
    if (!grid.inBounds(cx, cy)) return false;
    const t = grid.get(cx, cy);
    return t === Terrain.Open || t === Terrain.Grass;
  };
  const rnd = () => Math.random();

  // Lay a run of `t` from (cx,cy) heading (dx,dy) for `len` cells, wandering a little so a
  // line reads hand-dug rather than ruler-straight. Only open cells are set; for a hedge the
  // bocage feature is emitted per unbroken open run, so it never draws over a road/building.
  const layLine = (cx: number, cy: number, dx: number, dy: number, len: number, t: Terrain, isHedge = false): void => {
    let x = cx, y = cy;
    let segStart: { x: number; y: number } | null = null;
    let lastGood: { x: number; y: number } | null = null;
    const flush = () => {
      if (isHedge && segStart && lastGood && (segStart.x !== lastGood.x || segStart.y !== lastGood.y))
        features.hedges.push({ x0: segStart.x, y0: segStart.y, x1: lastGood.x, y1: lastGood.y });
      segStart = null; lastGood = null;
    };
    for (let i = 0; i < len; i++) {
      const gx = Math.round(x), gy = Math.round(y);
      if (buildable(gx, gy)) {
        grid.set(gx, gy, t);
        if (isHedge) { if (!segStart) segStart = { x: gx, y: gy }; lastGood = { x: gx, y: gy }; }
      } else if (isHedge) {
        flush(); // hit a road/building/water — end this hedge run, resume on the far side
      }
      x += dx; y += dy;
      if (rnd() < 0.3) { x += (rnd() - 0.5) * 0.7; y += (rnd() - 0.5) * 0.7; } // wander
    }
    if (isHedge) flush();
  };

  // A short L- or line-shaped sandbag emplacement — a defensive strongpoint.
  const layEmplacement = (cx: number, cy: number): void => {
    const horiz = rnd() < 0.5;
    const n = 3 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      const gx = cx + (horiz ? i : 0), gy = cy + (horiz ? 0 : i);
      if (buildable(gx, gy)) grid.set(gx, gy, Terrain.Sandbag);
    }
    // a short return leg for an L
    if (rnd() < 0.6) {
      for (let i = 1; i < 3; i++) {
        const gx = cx + (horiz ? 0 : i), gy = cy + (horiz ? i : 0);
        if (buildable(gx, gy)) grid.set(gx, gy, Terrain.Sandbag);
      }
    }
  };

  // Prefer horizontal lines (across the north↔south line of advance) so a defensive line
  // actually faces the attack. Anchor most cover near the objectives; sprinkle the rest.
  const midY = () => northY1 + 2 + Math.floor(rnd() * (southY0 - northY1 - 4));
  const midX = () => 4 + Math.floor(rnd() * (W - 8));

  // Find a bit of open ground in the contested band to start a run on, so a line begins in a
  // field rather than in the middle of a house or a river. Gives up after a few tries.
  const openAnchor = (): { cx: number; cy: number } | null => {
    for (let i = 0; i < 24; i++) {
      const cx = midX(), cy = midY();
      if (buildable(cx, cy)) return { cx, cy };
    }
    return null;
  };
  const scatterLine = (t: Terrain, dx: number, dy: number, len: number, isHedge = false): void => {
    const a = openAnchor();
    if (a) layLine(a.cx, a.cy, dx, dy, len, t, isHedge);
  };
  // Set up a strongpoint near an objective on open ground (searching a ring around it).
  const emplacementNear = (cx: number, cy: number): void => {
    for (let r = 0; r < 6; r++) {
      for (let k = 0; k < 6; k++) {
        const gx = cx + Math.round((rnd() - 0.5) * r * 2), gy = cy + Math.round((rnd() - 0.5) * r * 2);
        if (buildable(gx, gy)) { layEmplacement(gx, gy); return; }
      }
    }
  };

  const trenchRuns = 3 + Math.floor((W * H) / 6000);
  const lineRuns = 3 + Math.floor((W * H) / 5000);

  if (modernEra(era)) {
    // WW2 and Star Wars dig in the same way: hedgerows/scrub lines, trenches, and
    // sandbag/barricade strongpoints around the objectives.
    for (let i = 0; i < lineRuns; i++) scatterLine(Terrain.Hedge, rnd() < 0.7 ? 1 : 0, rnd() < 0.7 ? 0 : 1, 8 + Math.floor(rnd() * 9), true);
    for (let i = 0; i < trenchRuns; i++) scatterLine(Terrain.Trench, 1, (rnd() - 0.5) * 0.3, 6 + Math.floor(rnd() * 8));
    for (const o of objectives) {
      layLine(o.cx - 5, o.cy - o.radius, 1, 0, 10, Terrain.Trench);
      emplacementNear(o.cx + 2, o.cy + 3);
      emplacementNear(o.cx - 4, o.cy - 3);
    }
  } else if (era === "acw") {
    for (let i = 0; i < lineRuns + 2; i++) scatterLine(Terrain.Fence, rnd() < 0.5 ? 1 : 0, rnd() < 0.5 ? 0 : 1, 8 + Math.floor(rnd() * 12));
    for (let i = 0; i < trenchRuns; i++) scatterLine(Terrain.Trench, 1, (rnd() - 0.5) * 0.3, 6 + Math.floor(rnd() * 8));
    for (const o of objectives) layLine(o.cx - 6, o.cy - o.radius, 1, 0, 12, Terrain.Fence);
    // Post-and-rail fences lining the roads through the contested ground — the Emmitsburg
    // Road effect: at Gettysburg the roadside fences held attacking lines under canister.
    // Fences go on the open cells flanking a road, with gaps, never on the road itself.
    for (let cy = northY1; cy <= southY0; cy++) {
      for (let cx = 1; cx < W - 1; cx++) {
        if (grid.get(cx, cy) !== Terrain.Road) continue;
        for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
          const nx = cx + dx, ny = cy + dy;
          if (buildable(nx, ny) && rnd() < 0.55) grid.set(nx, ny, Terrain.Fence);
        }
      }
    }
  } else {
    for (let i = 0; i < lineRuns; i++) scatterLine(Terrain.Fence, rnd() < 0.6 ? 1 : 0, rnd() < 0.6 ? 0 : 1, 8 + Math.floor(rnd() * 10));
    for (let i = 0; i < trenchRuns; i++) scatterLine(Terrain.Trench, 1, (rnd() - 0.5) * 0.3, 6 + Math.floor(rnd() * 8));
    for (const o of objectives) layLine(o.cx - 5, o.cy - o.radius, 1, 0, 10, Terrain.Trench);
  }
}

export type Role = "attack" | "defend";

// How a battle is configured: who the human commands, each side's role (attack the
// objectives or defend them), and how many tanks each side fields (1-10).
export interface GameSetup {
  era: Era;
  player: Faction;
  usRole: Role;
  axisRole: Role;
  usTanks: number; // in ACW these count field guns instead of tanks
  axisTanks: number;
  fortify?: boolean; // scatter era-appropriate field cover (hedgerows/trenches/bunkers, ditches/fences…)
  objectiveHoldS?: number; // seconds the attacker must hold every objective at once to win (default 180)
  snow?: boolean; // paint the battlefield in winter dress (Bulge-style snow cover)
  usHero?: boolean; // field a one-man elite Hero unit (period-accurate per era; a Jedi/Sith in Star Wars)
  axisHero?: boolean;
}

export const DEFAULT_SETUP: GameSetup = {
  era: "ww2", player: "us", usRole: "attack", axisRole: "defend", usTanks: 1, axisTanks: 1,
};

// The two sides' display names and colours, per era. Internally the factions stay
// "us"/"axis"; only their presentation changes.
export function factionName(era: Era, f: Faction): string {
  if (era === "medieval") return f === "us" ? "Aldmere" : "Corvath";
  if (era === "acw") return f === "us" ? "Union" : "Confederate";
  if (era === "starwars") return f === "us" ? "Rebellion" : "Empire";
  return f === "us" ? "US" : "Wehrmacht";
}
export function factionColor(era: Era, f: Faction): number {
  if (f === "us") return era === "medieval" ? 0x3f68c8 : era === "acw" ? 0x3f6fc4 : era === "starwars" ? 0xd07a35 : 0x4f7fd1; // Aldmere / Union blue, Rebel orange, US blue
  return era === "medieval" ? 0xb03636 : era === "acw" ? 0x8d8f99 : era === "starwars" ? 0xaab2bc : 0xc4514a; // Corvath crimson / Confederate grey / stormtrooper white / German red
}

function other(f: Faction): Faction { return f === "us" ? "axis" : "us"; }

// Mounted troops (carbine cavalry, lance-armed knights), crew-served engines (field gun,
// catapult) and the mortar (which needs open sky above it to fire) keep out of building
// interiors; everyone else uses normal infantry passability. Shared by every pathing call
// so these units route around houses rather than setting up inside them.
export function unitPassable(grid: Grid, weapon: WeaponId): (cx: number, cy: number) => boolean {
  if (weapon === "carbine" || weapon === "cannon" || weapon === "lance" || weapon === "catapult" || weapon === "mortar")
    return (cx, cy) => grid.passable(cx, cy) && !isBuildingInterior(grid.get(cx, cy));
  return (cx, cy) => grid.passable(cx, cy);
}

export class World {
  grid: Grid;
  features: MapFeatures;
  soldiers: Soldier[] = [];
  teams: Team[] = [];
  vehicles: Vehicle[] = [];
  effects: Effect[] = [];
  // Grenades mid-flight, detonated when their fuse runs out (see updateGrenades).
  pendingGrenades: PendingGrenade[] = [];
  time = 0;
  // The battle begins immediately from the units' static spawn positions — there is no
  // separate deployment phase to position squads first.
  phase: "deploy" | "battle" = "battle";
  // The human commands `player`; the AI commands `aiFaction`. Each side either attacks
  // (advance & take the objectives) or defends (hold them). Both can attack (a meeting
  // engagement over a neutral objective).
  player: Faction = "axis";
  aiFaction: Faction = "us";
  usRole: Role = "defend";
  axisRole: Role = "attack";
  // Which historical setting this battle is fought in — picks the weapons, unit types,
  // vehicles, and the two sides' names/colors. WW2: US vs Wehrmacht. ACW: Union vs Confederate.
  era: Era = "ww2";
  // Winter dress — a snow-covered battlefield (Bastogne et al). Purely visual; picked up
  // by paintBattlefield, otherwise doesn't touch gameplay.
  snow = false;
  // The faction deploying along the south edge; the other deploys north.
  southFaction: Faction = "axis";
  // Deployment bands (grid rows): south band [deploySouthY0, height), north [0, deployNorthY1).
  deploySouthY0 = 0;
  deployNorthY1 = 0;
  selectedTeamId: number | null = null;
  selectedTeamIds: Set<number> = new Set();
  // `selectedVehicleId` is the "primary" vehicle (mirrors selectedTeamId), the one shown
  // in detail and used for single-vehicle order shorthand; `selectedVehicleIds` is the
  // actual multi-vehicle group orders apply to (mirrors selectedTeamIds). Vehicle
  // selection and squad selection remain mutually exclusive — selecting one clears the
  // other — but multiple vehicles can now be grouped together the same way squads can.
  selectedVehicleId: number | null = null;
  selectedVehicleIds: Set<number> = new Set();
  // A human opponent (multiplayer) commands the AI side → suppress the AI.
  aiHuman = false;
  outcome: "win" | "lose" | null = null;

  // Capture-and-hold objectives (1-3). Each starts under the defender; the
  // attacker wins by controlling ALL of them at once for objectiveHoldS seconds.
  objectives: ObjState[] = [];
  objHoldTimer = 0; // seconds the current holder has held EVERY objective simultaneously
  holdFaction: Faction | null = null; // which attacker the hold timer is counting for
  objectiveHoldS = 180; // configurable 1-10 min via the menu; set from setup in the constructor
  // The clock the attacker has to take AND hold the objective before it's ruled a defensive
  // win. Scales with objectiveHoldS so a long hold setting isn't mathematically impossible to
  // reach — the original fixed value (with the old holdS=60 default) was 360s.
  battleTimeS = 480;

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

  // Permanent blood decals left where men fall — the field reads as fought-over rather
  // than pristine even once the fighting has moved on. `big` marks a violent (blast/
  // melee) death, which gets a wider splatter plus a few scattered gib chunks rather
  // than a plain pool. Capped so a long battle can't grow the draw list unbounded.
  bloodDecals: { x: number; y: number; seed: number; big: boolean }[] = [];
  bloodVersion = 0;

  addBloodDecal(x: number, y: number, big: boolean): void {
    this.bloodDecals.push({ x, y, seed: (Math.random() * 0xffffffff) >>> 0, big });
    if (this.bloodDecals.length > 300) this.bloodDecals.shift();
    this.bloodVersion++;
  }

  // Casualty/loss feed — drives the on-screen ticker and the end-of-battle report.
  // Capped well past anything the ticker itself ever shows, but bounded all the same.
  events: BattleEvent[] = [];
  eventsVersion = 0;
  private nextEventSeq = 0;

  logEvent(faction: Faction, kind: BattleEvent["kind"], text: string): void {
    this.events.push({ seq: this.nextEventSeq++, time: this.time, faction, kind, text });
    if (this.events.length > 200) this.events.shift();
    this.eventsVersion++;
  }

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

  constructor(map: GameMap, objectiveCount = map.objectives.length, setup: GameSetup = DEFAULT_SETUP) {
    this.mapName = map.name;
    this.grid = map.grid;
    this.features = map.features;
    this.era = setup.era;
    this.snow = setup.snow ?? false;
    this.player = setup.player;
    this.aiFaction = other(setup.player);
    this.usRole = setup.usRole;
    this.axisRole = setup.axisRole;
    this.objectiveHoldS = setup.objectiveHoldS ?? 180;
    this.battleTimeS = this.objectiveHoldS + 300; // 5 min to fight to the objective, then hold it
    // The lone attacker takes the south edge; in a meeting (both attack) the US holds
    // the south by convention (its historical line of advance).
    this.southFaction =
      setup.usRole === "attack" && setup.axisRole === "defend" ? "us"
      : setup.axisRole === "attack" && setup.usRole === "defend" ? "axis"
      : "us";
    const northFaction = other(this.southFaction);

    // The defender owns the objectives at the start; a meeting starts them neutral.
    const startOwner: Faction | "neutral" =
      setup.usRole === "defend" && setup.axisRole === "attack" ? "us"
      : setup.axisRole === "defend" && setup.usRole === "attack" ? "axis"
      : "neutral";
    const n = Math.max(1, Math.min(objectiveCount, map.objectives.length));
    this.objectives = map.objectives.slice(0, n).map((o) => ({
      cx: o.cx, cy: o.cy, radius: o.radius,
      owner: startOwner, capturing: null, progress: 0, contested: false,
    }));
    this.visGrid = new Uint8Array(this.grid.width * this.grid.height);
    this.buildDmg = new Float32Array(this.grid.width * this.grid.height);
    this.smokeGrid = new Float32Array(this.grid.width * this.grid.height);
    this.deploySouthY0 = Math.floor(this.grid.height * 0.75);
    this.deployNorthY1 = Math.ceil(this.grid.height * 0.25);

    // Optional field fortifications — dig in extra cover across the contested ground.
    if (setup.fortify) addFortifications(this.grid, this.features, this.era, this.objectives, this.deployNorthY1, this.deploySouthY0);

    // map.spawns.us is always the south positions, map.spawns.axis the north ones; the
    // faction occupying each depends on who's attacking from where.
    const colorOf = (f: Faction) => factionColor(this.era, f);
    // Each squad's veterancy is rolled on its own, so a force is a mix of green and
    // seasoned teams — CC's recruit/veteran/elite texture, where one squad folds under
    // fire that another shrugs off. The attacking side averages a touch higher (assault
    // troops tend to be the better units).
    // WW2 attackers average a touch more veteran; in the Civil War both sides draw from the
    // same pool (no attacker edge) so a stand-up fight is decided by ground, nerve and the
    // bayonet — not a built-in advantage.
    const trainOf = (f: Faction) => {
      const base = !modernEra(this.era) ? 0.6 : this.roleOf(f) === "attack" ? 0.64 : 0.56;
      return Math.max(0.3, Math.min(0.9, base + (Math.random() - 0.5) * 0.5));
    };
    // The maps carry a WW2 order of battle; Star Wars keeps the same squad structure
    // (troopers/repeater/rocket/mortar teams), while ACW and medieval remap the same
    // deployment positions into period units — rifle-musket platoons or men-at-arms.
    const orbat = (list: SquadSpawn[]) =>
      modernEra(this.era) ? list : this.era === "medieval" ? medievalOrbat(list) : acwOrbat(list);
    for (const s of orbat(map.spawns.us)) this.spawnSquad(s, this.southFaction, colorOf(this.southFaction), trainOf(this.southFaction));
    for (const s of orbat(map.spawns.axis)) this.spawnSquad(s, northFaction, colorOf(northFaction), trainOf(northFaction));

    // Heavy support, clustered at each side's band anchor. WW2 fields tanks; the Civil War
    // fields field-gun batteries. The 1-10 selector counts whichever the era uses.
    const southAnchor = map.spawns.usVehicles[0] ?? { cx: (this.grid.width / 2) | 0, cy: this.grid.height - 5 };
    const northAnchor = map.spawns.axisVehicles[0] ?? { cx: (this.grid.width / 2) | 0, cy: 5 };
    const southCount = this.southFaction === "us" ? setup.usTanks : setup.axisTanks;
    const northCount = northFaction === "us" ? setup.usTanks : setup.axisTanks;
    if (modernEra(this.era)) {
      this.spawnTanks(this.southFaction, southCount, southAnchor.cx, southAnchor.cy, -Math.PI / 2);
      this.spawnTanks(northFaction, northCount, northAnchor.cx, northAnchor.cy, Math.PI / 2);
    } else {
      this.spawnGuns(this.southFaction, southCount, southAnchor.cx, southAnchor.cy, trainOf(this.southFaction));
      this.spawnGuns(northFaction, northCount, northAnchor.cx, northAnchor.cy, trainOf(northFaction));
    }

    // Hero: an optional one-man elite unit per side, fielded like a tank/gun pick.
    const southHero = this.southFaction === "us" ? setup.usHero : setup.axisHero;
    const northHero = northFaction === "us" ? setup.usHero : setup.axisHero;
    if (southHero) this.spawnHero(this.southFaction, southAnchor.cx, southAnchor.cy, trainOf(this.southFaction));
    if (northHero) this.spawnHero(northFaction, northAnchor.cx, northAnchor.cy, trainOf(northFaction));
  }

  roleOf(f: Faction): Role { return f === "us" ? this.usRole : this.axisRole; }

  /** The faction that owns EVERY objective right now, or null if mixed/neutral. */
  objAllOwner(): Faction | null {
    if (this.objectives.length === 0) return null;
    const first = this.objectives[0].owner;
    if (first === "neutral") return null;
    return this.objectives.every((o) => o.owner === first) ? (first as Faction) : null;
  }
  /** True when the human player controls every objective. */
  playerHoldsAll(): boolean { return this.objAllOwner() === this.player; }

  // Spawn `count` tanks of the faction's class, all facing the given heading. The armour
  // starts up WITH its infantry — at the leading edge of the friendly formation — rather
  // than parked off on its own at the map edge. Called after the infantry are placed.
  private spawnTanks(faction: Faction, count: number, fallbackCx: number, fallbackCy: number, facing: number): void {
    const cls: VehicleClass = this.era === "starwars"
      ? (faction === "us" ? "aac1" : "atst")
      : (faction === "us" ? "sherman" : "panzer4");
    const n = Math.max(1, Math.min(10, count));
    // Anchor on this side's own troops: centre on their mean X, and sit at their front rank
    // (the edge nearest the enemy) so the tanks lead the advance instead of trailing it.
    const homeDir = faction === this.southFaction ? 1 : -1; // home edge is +y (south) / -y (north)
    let sumX = 0, m = 0, frontY = homeDir > 0 ? Infinity : -Infinity;
    for (const s of this.soldiers) {
      if (s.faction !== faction) continue;
      sumX += s.x; m++;
      if (homeDir > 0 ? s.y < frontY : s.y > frontY) frontY = s.y;
    }
    const baseX = m ? Math.round(sumX / m) : fallbackCx;
    const baseY = m && isFinite(frontY)
      ? Math.max(0, Math.min(this.grid.height - 1, Math.round(frontY - homeDir * 1.5)))
      : fallbackCy;
    for (let i = 0; i < n; i++) {
      const off = i === 0 ? 0 : (i % 2 === 1 ? 1 : -1) * Math.ceil(i / 2) * 3;
      const cell = this.nearestVehicleCell(baseX + off, baseY);
      this.spawnVehicle(cls, cell.cx, cell.cy, facing);
    }
  }

  // Spawn `count` field-gun batteries (crewed cannon teams). They set up BEHIND their own
  // infantry, toward the home edge, so the guns fire over their troops' heads instead of
  // standing out in front. Called after the infantry are placed.
  private spawnGuns(faction: Faction, count: number, cx: number, cy: number, training: number): void {
    const n = Math.max(1, Math.min(10, count));
    // Find the rear rank of this side's already-spawned foot/horse and post the guns just
    // behind it, centred on the line.
    const homeDir = faction === this.southFaction ? 1 : -1; // home edge is +y (south) / -y (north)
    let sumX = 0, m = 0, rearY = homeDir > 0 ? -Infinity : Infinity;
    for (const s of this.soldiers) {
      if (s.faction !== faction) continue;
      sumX += s.x; m++;
      if (homeDir > 0 ? s.y > rearY : s.y < rearY) rearY = s.y;
    }
    const baseX = m ? Math.round(sumX / m) : cx;
    const baseY = m && isFinite(rearY)
      ? Math.max(0, Math.min(this.grid.height - 1, Math.round(rearY + homeDir * 2)))
      : cy;
    const pass = unitPassable(this.grid, "cannon"); // never plant an engine inside a building
    const label = this.era === "medieval" ? "Catapult" : "Battery";
    for (let i = 0; i < n; i++) {
      const off = i === 0 ? 0 : (i % 2 === 1 ? 1 : -1) * Math.ceil(i / 2) * 4;
      const cell = this.nearestPassable(baseX + off, baseY, { cx: baseX, cy: baseY }, pass);
      const spawn: SquadSpawn = { name: n > 1 ? `${label} ${i + 1}` : label, cx: cell.cx, cy: cell.cy, count: 5, kind: "artillery" };
      this.spawnSquad(spawn, faction, factionColor(this.era, faction), training);
    }
  }

  private nearestVehicleCell(cx: number, cy: number): { cx: number; cy: number } {
    for (let r = 0; r < 24; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++)
          if (this.grid.inBounds(cx + dx, cy + dy) && vehiclePassable(this.grid.get(cx + dx, cy + dy)))
            return { cx: cx + dx, cy: cy + dy };
    return { cx, cy };
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

  private spawnSquad(spawn: SquadSpawn, faction: Faction, color: number, training: number): Team {
    const kind: SquadKind = spawn.kind ?? "rifle";
    // The assaulting side fields heavier rifle squads: CC always hands the attacker a
    // material edge to pay for crossing open ground into a dug-in defender. Support
    // teams (MG/AT/mortar) keep their fixed crews; only the rifle line swells. A meeting
    // engagement (no defender) leaves both sides at full strength, so neither is favored.
    // WW2 hands the attacker a numerical edge to pay for crossing open ground; the Civil
    // War keeps the two sides evenly matched, so only WW2 rifle squads are reinforced.
    const reinforced = kind === "rifle" && this.roleOf(faction) === "attack" && this.roleOf(other(faction)) === "defend";
    const count = reinforced ? Math.round(spawn.count * 1.4) : spawn.count;
    const team: Team = {
      id: this.nextId++,
      name: spawn.name,
      faction,
      color,
      soldierIds: [],
      leaderId: -1,
      post: null,
      kind,
      volleyCD: Math.random() * 1.5, // stagger squads' first volley a little
      march: null,
    };
    this.teams.push(team);
    const loadout = squadLoadout(kind, count, faction, this.era);
    for (let i = 0; i < count; i++) {
      // Civil War and medieval units fall in as a formed line (offsets already in cells);
      // WW2 squads use the loose-blob template scaled tight. The same per-man offset (ox,oy)
      // drives both this spawn and every later move/regroup, so a line re-forms as it advances.
      const f = formationSlot(this.era, kind, i, count);
      const spawnScale = modernEra(this.era) ? FORMATION_SPACING : 1;
      const sx = spawn.cx + f.ox * spawnScale + 0.5;
      const sy = spawn.cy + f.oy * spawnScale + 0.5;
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
        facing: faction === this.southFaction ? -Math.PI / 2 : Math.PI / 2,
        gait: 0.9 + Math.random() * 0.22, // 0.90–1.12: each man's natural pace

        weapon,
        ammo: WEAPONS[weapon].ammo,
        status: "active",
        training,
        stance: this.roleOf(faction) === "defend" ? "defend" : "move",
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
        setupTime: 0,
        meleeCD: 0,
        // Riflemen, SMG men and blaster troopers carry grenades; specialists don't.
        grenades: weapon === "rifle" || weapon === "smg" || weapon === "blaster" ? 5 : 0,
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
    return team;
  }

  // Field a single Hero soldier — the "Support" pick's third slot alongside tanks/guns.
  // Built through the normal squad machinery (a one-man team) so selection, orders, AI
  // targeting and morale all treat him like any other soldier; only his weapon and the
  // heroHP/heroMelee/deflect stats set below make him play differently.
  private spawnHero(faction: Faction, fallbackCx: number, fallbackCy: number, training: number): void {
    const homeDir = faction === this.southFaction ? 1 : -1;
    let sumX = 0, m = 0, frontY = homeDir > 0 ? Infinity : -Infinity;
    for (const s of this.soldiers) {
      if (s.faction !== faction) continue;
      sumX += s.x; m++;
      if (homeDir > 0 ? s.y < frontY : s.y > frontY) frontY = s.y;
    }
    const baseX = m ? Math.round(sumX / m) : fallbackCx;
    const baseY = m && isFinite(frontY)
      ? Math.max(0, Math.min(this.grid.height - 1, Math.round(frontY - homeDir * 1.5)))
      : fallbackCy;
    const pass = unitPassable(this.grid, "rifle");
    const cell = this.nearestPassable(baseX, baseY, { cx: baseX, cy: baseY }, pass);
    const team = this.spawnSquad(
      { name: heroLabel(this.era, faction), cx: cell.cx, cy: cell.cy, count: 1, kind: "hero" },
      faction, factionColor(this.era, faction), Math.max(training, 0.85),
    );
    const s = this.soldier(team.soldierIds[0]);
    if (!s) return;
    const weapon = heroWeapon(this.era);
    s.weapon = weapon;
    s.ammo = WEAPONS[weapon].ammo;
    s.hero = true;
    s.heroHP = heroLives(this.era);
    s.heroMelee = weapon === "champion" || weapon === "lightsaber" ? 2.4 : 1;
    s.deflect = weapon === "lightsaber" ? 0.55 : 0;
    // More weapons, not just more health: WW2's Thompson-armed hero carries extra
    // grenades, matching the era's own convention (only rifle/SMG/blaster carriers do —
    // grenades weren't a Civil War infantryman's kit, so the Henry-armed hero skips them).
    s.grenades = weapon === "tommygun" ? 8 : 0;
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
    const men = team.soldierIds.map((id) => this.soldier(id)!).filter((s) => s && s.status === "active");
    if (men.length === 0) return true;

    for (const s of men) {
      s.fleeGoal = null;
      s.stance = stance;
      s.manualTargetId = null;
      s.manualVehId = null;
      s.fireCell = null;
      s.fireSmoke = false;
    }

    // Modern squads (WW2, Star Wars) don't march in formation: they move as a loose
    // gaggle and each man makes for the best bit of cover near where he's sent.
    if (modernEra(this.era)) {
      team.march = null;
      return this.orderLooseMove(men, target, team.kind);
    }

    // The squad's centre and the direction to the objective.
    let cx = 0, cy = 0;
    for (const s of men) { cx += s.x; cy += s.y; }
    cx /= men.length; cy /= men.length;
    let hx = target.cx + 0.5 - cx, hy = target.cy + 0.5 - cy;
    const hlen = Math.hypot(hx, hy);
    const targetIsBuildingInterior = this.grid.inBounds(target.cx, target.cy)
      && isBuildingInterior(this.grid.get(target.cx, target.cy));

    // Short shuffle: just re-path each man to his standing formation slot (no column).
    // Also force per-man pathing when the click is inside a building so infantry can
    // route through doors/windows instead of taking the squad-wide "avoid buildings"
    // march guide.
    if (hlen <= 3.5 || targetIsBuildingInterior) {
      team.march = null;
      let anyPathed = false;
      for (const s of men) {
        const pass = unitPassable(this.grid, s.weapon);
        const goal = this.nearestPassable(Math.round(target.cx + s.ox), Math.round(target.cy + s.oy), target, pass);
        const start: Cell = { cx: Math.floor(s.x), cy: Math.floor(s.y) };
        const raw = findPath(this.grid, start, goal, { passable: pass });
        if (raw && raw.length > 1) { s.path = smoothPath(this.grid, raw, { passable: pass }); s.pathIndex = 1; anyPathed = true; }
        else if (raw && raw.length === 1 && start.cx === goal.cx && start.cy === goal.cy) { s.path = null; anyPathed = true; }
        else s.path = null;
      }
      return anyPathed;
    }

    // A real march: build ONE guide route the squad's centre follows, and give each man his
    // slot in a broad LINE ABREAST, two ranks deep — men shoulder to shoulder across the
    // front (horizontal for the usual north/south advance), a second rank close behind. The
    // movement step walks the whole formation down the guide as one body (see moveSoldiers).
    hx /= hlen; hy /= hlen;
    const RANKS = 2;
    const perRank = Math.ceil(men.length / RANKS); // men abreast in each rank
    const FILE_SPACING = 0.9, RANK_SPACING = 0.95;
    const perpx = -hy, perpy = hx;
    men.forEach((s, j) => {
      const file = j % perRank;
      const rank = Math.floor(j / perRank);
      const across = (file - (perRank - 1) / 2) * FILE_SPACING; // wide, across the heading
      const depth = -rank * RANK_SPACING; // rank 0 in front, rank 1 just behind
      s.ox = depth * hx + across * perpx;
      s.oy = depth * hy + across * perpy;
      s.path = null; // driven by the shared guide, not an individual path
    });

    // Guide path (centre → objective) routes the whole formation AROUND buildings (not
    // through them): a broad line can't thread a doorway, and men clipping the walls is
    // what caused the pop-in/out. ("cannon" passability treats building interiors as solid.)
    const guidePass = unitPassable(this.grid, "cannon");
    const start: Cell = this.nearestPassable(Math.round(cx), Math.round(cy), { cx: Math.round(cx), cy: Math.round(cy) }, guidePass);
    const goal = this.nearestPassable(target.cx, target.cy, target, guidePass);
    const raw = findPath(this.grid, start, goal, { passable: guidePass });
    if (!raw || raw.length < 2) { team.march = null; return raw != null; }
    const guide = smoothPath(this.grid, raw, { passable: guidePass });
    team.march = { guide, idx: 1, x: cx, y: cy, hx, hy };
    return true;
  }

  // WW2-style loose move: send each man off on his own path to a distinct patch of cover
  // near the destination — a hedge, a wall, woods, rubble, or just inside a house — so the
  // squad travels as a scattered gaggle and goes to ground on arrival instead of standing
  // in a neat block in the open. Falls back to spread-out open cells when cover is scarce.
  // A mortar team is the exception: the tube already can't enter a building (it needs open
  // sky to fire — see unitPassable), but its rifle-armed escorts otherwise would, splitting
  // the crew from its guard. They stay outdoors by default; only when the player's own
  // click lands inside a building do they treat it as a deliberate order and go in.
  private orderLooseMove(men: Soldier[], target: Cell, kind: SquadKind): boolean {
    const targetIsInterior = this.grid.inBounds(target.cx, target.cy) && isBuildingInterior(this.grid.get(target.cx, target.cy));
    const avoidBuildings = kind === "mortar" && !targetIsInterior;
    const R = 5; // how far around the destination to look for cover
    // Score every reachable cell in the neighbourhood by how good a fighting position it is.
    const cands: { cx: number; cy: number; score: number }[] = [];
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const gcx = target.cx + dx, gcy = target.cy + dy;
        if (!this.grid.inBounds(gcx, gcy) || !this.grid.passable(gcx, gcy)) continue;
        const d = Math.hypot(dx, dy);
        if (d > R) continue;
        const t = this.grid.get(gcx, gcy) as Terrain;
        if (avoidBuildings && isBuildingInterior(t)) continue;
        const def = TERRAIN[t];
        // Cover + concealment make a good spot; a house interior is best; closer to the
        // aimpoint is preferred, with a little noise so identical cells don't tie forever.
        const score = def.cover * 2 + def.concealment + (isBuildingInterior(t) ? 1.4 : 0)
          - d * 0.14 + Math.random() * 0.25;
        cands.push({ cx: gcx, cy: gcy, score });
      }
    }
    cands.sort((a, b) => b.score - a.score);

    // Assign the closest men to the best spots first (so a nearby man grabs nearby cover),
    // one man per cell, spilling into the next-best positions as they fill up.
    const order = [...men].sort((a, b) =>
      ((a.x - target.cx) ** 2 + (a.y - target.cy) ** 2) - ((b.x - target.cx) ** 2 + (b.y - target.cy) ** 2));
    const used = new Set<number>();
    let anyPathed = false;
    for (const s of order) {
      const basePass = unitPassable(this.grid, s.weapon);
      // Every man in a mortar team stays out of buildings on a plain move order, not just
      // the tube (whose weapon already forces this) — an escort rifleman ducking indoors
      // would otherwise strand the crew he's meant to be guarding.
      const pass = avoidBuildings
        ? (cx: number, cy: number) => basePass(cx, cy) && !isBuildingInterior(this.grid.get(cx, cy))
        : basePass;
      let goal: Cell | null = null;
      for (const c of cands) {
        const key = c.cy * this.grid.width + c.cx;
        if (used.has(key)) continue;
        if (!pass(c.cx, c.cy)) continue; // e.g. a vehicle-crew weapon that can't enter a house
        used.add(key);
        goal = { cx: c.cx, cy: c.cy };
        break;
      }
      if (!goal) goal = this.nearestPassable(target.cx, target.cy, target, pass);
      const start: Cell = { cx: Math.floor(s.x), cy: Math.floor(s.y) };
      const raw = findPath(this.grid, start, goal, { passable: pass });
      s.ox = 0; s.oy = 0; // no formation slot — each man just holds his cover
      if (raw && raw.length > 1) { s.path = smoothPath(this.grid, raw, { passable: pass }); s.pathIndex = 1; anyPathed = true; }
      else if (raw && raw.length === 1 && start.cx === goal.cx && start.cy === goal.cy) { s.path = null; anyPathed = true; }
      else s.path = null;
    }
    return anyPathed;
  }

  /** Hold position in a Defend or Ambush posture, facing the nearest known threat. */
  orderPosture(teamId: number, stance: Stance): void {
    const team = this.team(teamId);
    if (!team) return;
    team.march = null;
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
    team.march = null;
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
    team.march = null;
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
    team.march = null;
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
    team.march = null;
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
    team.march = null;
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

  nearestPassable(cx: number, cy: number, fallback: Cell, passable?: (cx: number, cy: number) => boolean): Cell {
    const ok = passable ?? ((x, y) => this.grid.passable(x, y));
    if (ok(cx, cy)) return { cx, cy };
    if (ok(fallback.cx, fallback.cy)) return fallback;
    for (let r = 1; r <= 6; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (ok(cx + dx, cy + dy)) return { cx: cx + dx, cy: cy + dy };
        }
      }
    }
    return fallback;
  }
}
