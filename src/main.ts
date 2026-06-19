import { GameLoop } from "./game/loop.ts";
import { BATTLE_TIME_S, OBJECTIVE_HOLD_TO_WIN, SPEED_STEPS, VIS_INTERVAL } from "./game/constants.ts";
import { GameMap } from "./game/gamemap.ts";
import { step } from "./game/sim.ts";
import { Cell } from "./game/pathfinding.ts";
import { Faction, Stance, World } from "./game/world.ts";
import { WEAPONS } from "./game/weapons.ts";
import { VEHICLES } from "./game/vehicleDefs.ts";
import { updateVisibility } from "./game/visibility.ts";
import { Renderer } from "./render/renderer.ts";
import { Input } from "./render/input.ts";
import { runMenu } from "./render/menu.ts";
import { sound } from "./render/sound.ts";
import { net } from "./net/net.ts";
import {
  applySnapshot, AxisOrder, buildClientWorld, encodeSetup, encodeSnapshot, Setup, Snapshot,
} from "./net/snapshot.ts";

// Armed map-click order: which movement/fire order a left-click issues.
type ArmedOrder = "move" | "fast" | "sneak" | "fire" | "smoke";

// --- Multiplayer bootstrap ---------------------------------------------------------
// The host runs the authoritative sim and plays US (the normal single-player flow,
// plus broadcasting). German/spectator clients render the host's snapshots and get
// the same HUD (the German commands the Axis; a spectator can look but not touch). If
// no WS server answers (offline / Vite dev), we just start the normal single game.
let booted = false;
let pendingSetup: Setup | null = null;
// Host hooks, wired up once startGame has built the world.
let onAxisOrderHost: ((o: AxisOrder) => void) | null = null;
let onGermanPresentHost: ((present: boolean) => void) | null = null;
// Client hook, wired up by startClientView.
let onSnapshotClient: ((s: Snapshot) => void) | null = null;

net.connect({
  onRole: (role, germanPresent) => {
    if (role === "spectator" && !germanPresent) net.claimGerman(); // first joiner takes the Axis
    if (role === "host") startOffline();
    else maybeStartClient();
  },
  onGermanPresent: (p) => onGermanPresentHost?.(p),
  onSetup: (d) => { pendingSetup = d as Setup; maybeStartClient(); },
  onSnapshot: (d) => onSnapshotClient?.(d as Snapshot),
  onAxisOrder: (d) => onAxisOrderHost?.(d as AxisOrder),
  onClose: () => startOffline(), // host left / disconnected → fall back to local play
});
// If nothing answers shortly, there's no multiplayer server: play offline.
setTimeout(() => startOffline(), 900);

function startOffline(): void {
  if (booted) return;
  booted = true;
  runMenu(startGame);
}
function maybeStartClient(): void {
  if (booted || !pendingSetup) return; // wait until the host has published a map
  if (net.role !== "german" && net.role !== "spectator") return;
  booted = true;
  startClientView(pendingSetup);
}

// === Shared HUD ====================================================================

const SIDE_LABEL: Record<Faction, string> = { us: "US", axis: "AXIS" };

// An order issuer: the host applies orders to the world directly; a client relays
// them to the host over the network (and only an active German commander may do so).
interface Issuer {
  move(teamId: number, cell: Cell, stance: Stance): boolean;
  fireUnit(teamId: number, enemyId: number): void;
  areaFire(teamId: number, cell: Cell): void;
  smoke(teamId: number, cell: Cell): boolean;
  posture(teamId: number, stance: Stance): void;
  vehMove(vid: number, cell: Cell, fast: boolean): boolean;
  vehFire(vid: number, x: number, y: number): void;
  vehPosture(vid: number): void;
}

function localIssuer(world: World): Issuer {
  return {
    move: (t, c, s) => world.orderMove(t, c, s),
    fireUnit: (t, e) => world.orderFireUnit(t, e),
    areaFire: (t, c) => world.orderAreaFire(t, c),
    smoke: (t, c) => world.orderSmoke(t, c),
    posture: (t, s) => world.orderPosture(t, s),
    vehMove: (v, c, f) => world.orderVehicleMove(v, c, f),
    vehFire: (v, x, y) => world.orderVehicleFire(v, x, y),
    vehPosture: (v) => world.orderVehiclePosture(v),
  };
}
// Networked issuer — only the German commander's orders are actually sent.
function netIssuer(): Issuer {
  const ok = () => net.role === "german";
  return {
    move: (teamId, cell, s) => { if (ok()) net.sendAxisOrder({ kind: s === "fast" ? "fast" : s === "sneak" ? "sneak" : "move", teamId, cell }); return ok(); },
    fireUnit: (teamId, enemyId) => { if (ok()) net.sendAxisOrder({ kind: "fire", teamId, enemyId }); },
    areaFire: (teamId, cell) => { if (ok()) net.sendAxisOrder({ kind: "fire", teamId, cell }); },
    smoke: (teamId, cell) => { if (ok()) net.sendAxisOrder({ kind: "smoke", teamId, cell }); return ok(); },
    posture: (teamId, s) => { if (ok()) net.sendAxisOrder({ kind: s === "ambush" ? "ambush" : "defend", teamId }); },
    vehMove: (vid, cell, fast) => { if (ok()) net.sendAxisOrder({ kind: fast ? "vehFast" : "vehMove", vid, cell }); return ok(); },
    vehFire: (vid, x, y) => { if (ok()) net.sendAxisOrder({ kind: "vehFire", vid, x, y }); },
    vehPosture: (vid) => { if (ok()) net.sendAxisOrder({ kind: "vehDefend", vid }); },
  };
}

interface HudOpts {
  side: Faction | null; // controllable side; null = pure spectator
  local: boolean;       // host applies orders locally; client relays them
}

// Builds the entire HUD (force tracker, objective panel, roster, orders bar, selection
// + map input, keybinds, win/lose banner) for one viewer. Returns a per-frame update.
// Shared by the US host and the German/spectator clients so both sides play the same.
function installHUD(world: World, renderer: Renderer, opts: HudOpts): { frame: () => void; update: (ms: number) => void } {
  const side = opts.side;
  const enemy: Faction = side === "axis" ? "us" : "axis";
  const issuer = opts.local ? localIssuer(world) : netIssuer();
  const canCommand = side != null;

  const statusEl = document.getElementById("status")!;
  const clockEl = document.getElementById("clock")!;
  const forcesEl = document.getElementById("forces")!;
  const objectiveEl = document.getElementById("objective")!;
  const bannerEl = document.getElementById("banner")!;
  const bannerBig = document.getElementById("bannerBig")!;
  const bannerSub = document.getElementById("bannerSub")!;
  const deployBar = document.getElementById("deployBar")!;
  const launchBtn = document.getElementById("launchBtn")!;
  const ordersBar = document.getElementById("orders")!;
  const rosterEl = document.getElementById("roster")!;

  // Multiplayer role badge.
  let badge = document.getElementById("netbadge");
  if (!badge) {
    badge = document.createElement("div");
    badge.id = "netbadge";
    badge.style.cssText =
      "position:fixed;top:8px;right:12px;z-index:30;font:600 12px ui-monospace,monospace;" +
      "padding:4px 10px;border-radius:6px;background:rgba(20,19,15,0.85);border:1px solid #4a463c;color:#cfc8b6;";
    document.body.appendChild(badge);
  }

  // The deploy bar + launch belong to the host (US), who controls the battle phase.
  if (opts.local && side === "us") {
    deployBar.style.display = "flex";
    launchBtn.addEventListener("click", () => {
      world.phase = "battle";
      deployBar.style.display = "none";
      renderer.centerOnObjective(world);
    });
  } else {
    deployBar.style.display = "none";
  }
  if (!canCommand) { ordersBar.style.display = "none"; rosterEl.style.display = "none"; }

  const inDeployZone = (cy: number): boolean =>
    side === "axis" ? cy < world.deployY1Axis : cy >= world.deployY0Us;

  // --- force tracker / objective / selection / banner ---
  const refreshStatus = () => {
    let mine = 0, enemySeen = 0, enemyTotal = 0;
    for (const s of world.soldiers) {
      if (s.status !== "active") continue;
      if (s.faction === (side ?? "us")) mine++;
      else { enemyTotal++; if (s.seen) enemySeen++; }
    }
    if (side) forcesEl.textContent = `${SIDE_LABEL[side]} ${mine} · ${SIDE_LABEL[enemy]} ${enemySeen > 0 ? enemySeen + " seen" : "?"}`;
    else forcesEl.textContent = `US ${mine} · AXIS ${enemyTotal}`;

    {
      const ownerCls = world.objOwner === "us" ? "obj-us" : "obj-axis";
      const ownerName = world.objOwner === "us" ? "US holds" : "Axis holds";
      let line: string;
      if (world.objContested) line = `<span class="obj-contested">CONTESTED</span>`;
      else if (world.objCapturing)
        line = `<span class="obj-${world.objCapturing}">${world.objCapturing === "us" ? "US" : "Axis"} capturing… ${Math.round(world.objProgress * 100)}%</span>`;
      else if (world.objOwner === "us")
        line = `<span class="obj-hold">HOLD ${Math.ceil(world.objHoldTimer)} / ${OBJECTIVE_HOLD_TO_WIN}s</span>`;
      else line = `<span class="${ownerCls}">${ownerName}</span>`;
      objectiveEl.innerHTML = `<div class="obj-title">OBJECTIVE</div><div>${line}</div>`;
    }

    if (world.outcome) {
      bannerEl.style.display = "flex";
      // win/lose meaning flips for the Axis commander.
      const iWon = side === "axis" ? world.outcome === "lose" : world.outcome === "win";
      bannerBig.textContent = iWon ? (side === "axis" ? "POSITION HELD" : "OBJECTIVE SECURED") : (side === "axis" ? "POSITION OVERRUN" : "ATTACK REPULSED");
      bannerBig.style.color = iWon ? "#9fcf6f" : "#e0533a";
      bannerSub.textContent = iWon ? "The field is yours." : "The battle is lost.";
    }

    if (!canCommand) { statusEl.innerHTML = `<span class="dim">spectating</span>`; return; }

    if (world.selectedVehicleId != null) {
      const v = world.vehicle(world.selectedVehicleId)!;
      const tags: string[] = [];
      if (v.status === "ko") tags.push(`<span class="tag s-routing">knocked out</span>`);
      statusEl.innerHTML =
        `<div class="name">${v.name} <span class="dim">· ${v.status === "ko" ? "wreck" : v.stance}</span></div>` +
        `<div class="dim">crew ${v.crew} · AP ${v.apAmmo} · HE ${v.heAmmo}</div>` +
        (tags.length ? `<div class="row">${tags.join("")}</div>` : "");
      return;
    }
    if (world.selectedTeamIds.size === 0) { statusEl.innerHTML = `<span class="dim">No team selected</span>`; return; }
    if (world.selectedTeamIds.size > 1) {
      let live = 0, total = 0;
      for (const tid of world.selectedTeamIds) {
        const t = world.team(tid); if (!t) continue;
        total += t.soldierIds.length;
        for (const sid of t.soldierIds) if (world.soldier(sid)?.status === "active") live++;
      }
      statusEl.innerHTML = `<div class="name">${world.selectedTeamIds.size} squads selected</div><div class="dim">${live} effective · ${total - live} down</div>`;
      return;
    }
    const team = world.team(world.selectedTeamId!);
    if (!team) { statusEl.innerHTML = `<span class="dim">No team selected</span>`; return; }
    const live = team.soldierIds.map((id) => world.soldier(id)!).filter((s) => s && s.status === "active");
    const counts: Record<string, number> = {};
    for (const s of live) counts[s.state] = (counts[s.state] ?? 0) + 1;
    const casualties = team.soldierIds.length - live.length;
    const tags = (["steady", "shaken", "pinned", "panicked", "routing"] as const)
      .filter((st) => counts[st]).map((st) => `<span class="tag s-${st}">${counts[st]} ${st}</span>`).join("");
    statusEl.innerHTML =
      `<div class="name">${team.name} <span class="dim">· ${live[0]?.stance ?? "move"}</span></div>` +
      `<div class="dim">${live.length} effective · ${casualties} down</div><div class="row">${tags}</div>`;
  };

  // --- orders bar ---
  const orderBtns = Array.from(ordersBar.querySelectorAll<HTMLButtonElement>("button"));
  let armed: ArmedOrder = "move";
  const updateOrdersBar = () => {
    if (!canCommand) return;
    const show = (world.selectedTeamIds.size > 0 || world.selectedVehicleId != null) && !world.outcome;
    ordersBar.style.display = show ? "flex" : "none";
    const deployPhase = world.phase === "deploy";
    const hasMortar = world.selectedVehicleId == null && [...world.selectedTeamIds].some((id) => world.team(id)?.kind === "mortar");
    for (const b of orderBtns) {
      const order = b.dataset.order!;
      let hidden = deployPhase && (order === "fire" || order === "fast" || order === "ambush" || order === "defend");
      if (order === "smoke") hidden = deployPhase || !hasMortar;
      b.style.display = hidden ? "none" : "";
      b.classList.toggle("armed", order === armed);
    }
  };

  const flagBlocked = (x: number, y: number) => { world.effects.push({ kind: "blocked", x0: x, y0: y, x1: x, y1: y, ttl: 0.8 }); };

  const handleOrder = (x: number, y: number) => {
    if (!canCommand) return;
    const cell = { cx: Math.floor(x), cy: Math.floor(y) };
    if (world.phase === "deploy" && !inDeployZone(cell.cy)) { flagBlocked(x, y); return; }

    if (world.selectedVehicleId != null) {
      const vid = world.selectedVehicleId;
      if (armed === "fire") issuer.vehFire(vid, x, y);
      else if (!issuer.vehMove(vid, cell, armed === "fast")) flagBlocked(x, y);
      refreshStatus();
      return;
    }
    const teamIds = [...world.selectedTeamIds];
    if (teamIds.length === 0) return;

    if (armed === "smoke") {
      let anyTube = false;
      for (const tid of teamIds) if (issuer.smoke(tid, cell)) anyTube = true;
      if (!anyTube) { flagBlocked(x, y); refreshStatus(); return; }
    } else if (armed === "fire") {
      const primary = world.selectedTeamId!;
      const foe = world.soldiers.find((s) => s.faction === enemy && s.status === "active" && s.seen && Math.hypot(s.x - x, s.y - y) < 1.4);
      if (foe) issuer.fireUnit(primary, foe.id);
      else issuer.areaFire(primary, cell);
    } else {
      const n = teamIds.length;
      let anyOk = false;
      teamIds.forEach((tid, i) => {
        const col = Math.round(i - (n - 1) / 2);
        if (issuer.move(tid, { cx: cell.cx + col * 4, cy: cell.cy }, armed as Stance)) anyOk = true;
      });
      if (!anyOk) { flagBlocked(x, y); refreshStatus(); return; }
    }
    sound.playUI("ui_order");
    refreshStatus();
  };

  const pickOrder = (order: string) => {
    if (!canCommand) return;
    if (order === "smoke") {
      const hasMortar = world.selectedVehicleId == null && [...world.selectedTeamIds].some((id) => world.team(id)?.kind === "mortar");
      if (!hasMortar) return;
    }
    if (world.selectedVehicleId != null) {
      if (order === "defend" || order === "ambush") issuer.vehPosture(world.selectedVehicleId);
      else if (order !== "smoke") armed = (order === "sneak" ? "move" : order) as ArmedOrder;
      updateOrdersBar(); refreshStatus(); return;
    }
    if (world.selectedTeamIds.size === 0) return;
    if (order === "defend" || order === "ambush") for (const tid of world.selectedTeamIds) issuer.posture(tid, order as Stance);
    else armed = order as ArmedOrder;
    updateOrdersBar(); refreshStatus();
  };
  for (const b of orderBtns) b.addEventListener("click", () => pickOrder(b.dataset.order!));

  // --- roster ---
  const KIND_LABEL: Record<string, string> = { rifle: "RIFLE", mg: "MG", at: "AT", mortar: "MORTAR" };
  interface RosterCard { el: HTMLDivElement; count: HTMLSpanElement; moraleFill: HTMLDivElement; ammoFill: HTMLDivElement; strFill: HTMLDivElement; }
  const rosterCards = new Map<number, RosterCard>();
  const vehicleCards = new Map<number, RosterCard>();
  const mkCard = (el: HTMLDivElement): RosterCard => ({
    el,
    count: el.querySelector(".rcount") as HTMLSpanElement,
    strFill: el.querySelector('[data-k="str"]') as HTMLDivElement,
    moraleFill: el.querySelector('[data-k="mor"]') as HTMLDivElement,
    ammoFill: el.querySelector('[data-k="ammo"]') as HTMLDivElement,
  });
  const buildRoster = () => {
    if (!canCommand) return;
    for (const team of world.teams) {
      if (team.faction !== side) continue;
      const el = document.createElement("div");
      el.className = "rcard";
      el.innerHTML =
        `<div class="rhead"><span class="rname">${team.name}</span><span class="rbadge ${team.kind}">${KIND_LABEL[team.kind]}</span><span class="rcount"></span></div>` +
        `<div class="rbars"><div class="rbar"><span class="rlabel">S</span><div class="rtrack"><div class="rfill" data-k="str"></div></div></div>` +
        `<div class="rbar"><span class="rlabel">M</span><div class="rtrack"><div class="rfill" data-k="mor"></div></div></div>` +
        `<div class="rbar"><span class="rlabel">A</span><div class="rtrack"><div class="rfill" data-k="ammo"></div></div></div></div>`;
      el.addEventListener("click", () => {
        world.selectedTeamId = team.id; world.selectedTeamIds = new Set([team.id]); world.selectedVehicleId = null;
        armed = "move"; sound.playUI("ui_select"); renderer.centerOnTeam(world, team.id);
        updateOrdersBar(); refreshStatus(); refreshRoster();
      });
      rosterEl.appendChild(el);
      rosterCards.set(team.id, mkCard(el));
    }
    for (const v of world.vehicles) {
      if (v.faction !== side) continue;
      const el = document.createElement("div");
      el.className = "rcard";
      el.innerHTML =
        `<div class="rhead"><span class="rname">${v.name}</span><span class="rbadge tank">TANK</span><span class="rcount"></span></div>` +
        `<div class="rbars"><div class="rbar"><span class="rlabel">C</span><div class="rtrack"><div class="rfill" data-k="str"></div></div></div>` +
        `<div class="rbar"><span class="rlabel">R</span><div class="rtrack"><div class="rfill" data-k="mor"></div></div></div>` +
        `<div class="rbar"><span class="rlabel">A</span><div class="rtrack"><div class="rfill" data-k="ammo"></div></div></div></div>`;
      el.addEventListener("click", () => {
        world.selectedVehicleId = v.id; world.selectedTeamId = null; world.selectedTeamIds.clear();
        armed = "move"; sound.playUI("ui_select"); renderer.centerOnVehicle(world, v.id);
        updateOrdersBar(); refreshStatus(); refreshRoster();
      });
      rosterEl.appendChild(el);
      vehicleCards.set(v.id, mkCard(el));
    }
  };
  const refreshRoster = () => {
    if (!canCommand) return;
    for (const team of world.teams) {
      const card = rosterCards.get(team.id);
      if (!card) continue;
      let live = 0, moraleSum = 0, ammo = 0, ammoMax = 0;
      for (const id of team.soldierIds) {
        const s = world.soldier(id); if (!s) continue;
        ammoMax += WEAPONS[s.weapon].ammo;
        if (s.status !== "active") continue;
        live++; moraleSum += s.morale; ammo += s.ammo;
      }
      const total = team.soldierIds.length || 1;
      const morale = live ? moraleSum / live : 0;
      card.count.textContent = `${live}/${total}`;
      card.strFill.style.width = `${(live / total) * 100}%`;
      card.strFill.style.background = live / total > 0.5 ? "#8fbf6f" : live / total > 0.25 ? "#e0a23a" : "#e0533a";
      card.moraleFill.style.width = `${Math.round(morale * 100)}%`;
      card.moraleFill.style.background = morale > 0.55 ? "#8fbf6f" : morale > 0.3 ? "#e0a23a" : "#e0533a";
      card.ammoFill.style.width = `${ammoMax ? Math.round((ammo / ammoMax) * 100) : 0}%`;
      card.ammoFill.style.background = "#c7a23f";
      card.el.classList.toggle("sel", world.selectedTeamIds.has(team.id));
      card.el.classList.toggle("dead", live === 0);
    }
    for (const v of world.vehicles) {
      const card = vehicleCards.get(v.id);
      if (!card) continue;
      const def = VEHICLES[v.cls];
      const ko = v.status === "ko";
      const crewFrac = ko ? 0 : v.crew / def.crew;
      const ammo = v.apAmmo + v.heAmmo, ammoMax = def.apAmmo + def.heAmmo;
      card.count.textContent = ko ? "wreck" : `AP ${v.apAmmo}·HE ${v.heAmmo}`;
      card.strFill.style.width = `${crewFrac * 100}%`;
      card.strFill.style.background = crewFrac > 0.6 ? "#8fbf6f" : crewFrac > 0.3 ? "#e0a23a" : "#e0533a";
      card.moraleFill.style.width = `${ko ? 0 : 100}%`;
      card.moraleFill.style.background = "#8fbf6f";
      card.ammoFill.style.width = `${ammoMax ? Math.round((ammo / ammoMax) * 100) : 0}%`;
      card.ammoFill.style.background = "#c7a23f";
      card.el.classList.toggle("sel", world.selectedVehicleId === v.id);
      card.el.classList.toggle("dead", ko);
    }
  };
  buildRoster();

  // --- map input (selection + orders) ---
  // One Input per viewer drives the camera (pan/zoom) for everyone; selection and
  // orders only do anything for a commanding side (spectators just look around).
  const inputSide: Faction = side ?? "axis";
  const onSel = () => {
    armed = "move";
    if (canCommand) sound.playUI("ui_select");
    updateOrdersBar(); refreshStatus(); refreshRoster();
  };
  const onBox = (sx0: number, sy0: number, sx1: number, sy1: number) => {
    if (!canCommand) return;
    const a = renderer.screenToWorld(Math.min(sx0, sx1), Math.min(sy0, sy1));
    const b = renderer.screenToWorld(Math.max(sx0, sx1), Math.max(sy0, sy1));
    const ids = new Set<number>();
    for (const team of world.teams) {
      if (team.faction !== side) continue;
      for (const sid of team.soldierIds) {
        const s = world.soldier(sid);
        if (s && s.status === "active" && s.x >= a.x && s.x <= b.x && s.y >= a.y && s.y <= b.y) { ids.add(team.id); break; }
      }
    }
    if (ids.size === 0) return;
    world.selectedTeamIds = ids; world.selectedTeamId = [...ids][0]; world.selectedVehicleId = null;
    onSel();
  };
  const input = new Input(renderer, world, onSel, handleOrder, onBox, inputSide);

  if (canCommand) {
    const ORDER_KEYS: Record<string, string> = { q: "move", w: "fast", e: "sneak", r: "defend", t: "ambush", f: "fire", g: "smoke" };
    window.addEventListener("keydown", (e) => {
      if (e.key.toLowerCase() === "o") { renderer.centerOnObjective(world); return; }
      const order = ORDER_KEYS[e.key.toLowerCase()];
      if (order && (world.selectedTeamId != null || world.selectedVehicleId != null)) pickOrder(order);
    });
  }
  updateOrdersBar();

  // --- per-frame HUD refresh ---
  const frame = () => {
    if (world.phase === "deploy") { clockEl.textContent = "DEPLOY"; clockEl.style.color = "#7fa8e8"; }
    else {
      const left = Math.max(0, BATTLE_TIME_S - world.time);
      clockEl.textContent = `⏱ ${Math.floor(left / 60)}:${Math.floor(left % 60).toString().padStart(2, "0")}`;
      clockEl.style.color = left < 60 ? "#e0796f" : "";
    }
    if (net.connected) {
      badge!.style.display = "block";
      badge!.textContent = net.role === "host" ? "MULTIPLAYER · HOST (US)" : net.role === "german" ? "MULTIPLAYER · COMMANDING AXIS" : "MULTIPLAYER · SPECTATING";
    } else badge!.style.display = "none";
    refreshStatus(); updateOrdersBar(); refreshRoster();
  };
  return { frame, update: (ms: number) => input.update(ms) };
}

// === Host (US) / offline single-player =============================================

async function startGame(map: GameMap) {
  const mount = document.getElementById("app")!;
  const world = new World(map);
  updateVisibility(world, VIS_INTERVAL);
  const renderer = new Renderer();
  await renderer.init(mount, world);
  (window as { __game?: unknown }).__game = { world, renderer };

  const hud = installHUD(world, renderer, { side: "us", local: true });

  // Multiplayer host: apply relayed Axis orders; disable the Axis AI while a human is in.
  onAxisOrderHost = (o) => applyAxisOrder(world, o);
  onGermanPresentHost = (present) => { world.axisHuman = present; };
  let setupSent = false, netAccum = 0;

  let lastRenderTs = performance.now();
  let prevObjOwner = world.objOwner;
  const loop = new GameLoop(
    () => step(world),
    (alpha) => {
      const now = performance.now();
      const dtSec = (now - lastRenderTs) / 1000;
      hud.update(now - lastRenderTs); // keyboard pan
      lastRenderTs = now;
      renderer.render(world, alpha);
      if (net.role === "host") {
        if (!setupSent) { net.sendSetup(encodeSetup(world)); setupSent = true; }
        netAccum += dtSec;
        if (netAccum >= 0.12) { net.sendSnapshot(encodeSnapshot(world)); netAccum = 0; }
      }
      sound.updateAmbient(dtSec, world.phase === "battle" && !world.outcome && !loop.paused);
      if (world.objOwner !== prevObjOwner) { sound.playUI(world.objOwner === "us" ? "obj_capture" : "obj_lost"); prevObjOwner = world.objOwner; }
      hud.frame();
    },
  );
  loop.start();

  // Pause / speed (host controls the sim).
  const pauseBtn = document.getElementById("pauseBtn") as HTMLButtonElement;
  const speedBtn = document.getElementById("speedBtn") as HTMLButtonElement;
  const speedPill = document.getElementById("speedPill")!;
  let speedIdx = 0;
  const setPaused = (p: boolean) => { loop.paused = p; pauseBtn.textContent = p ? "▶ Resume" : "⏸ Pause"; sound.setMuted(p); };
  pauseBtn.addEventListener("click", () => setPaused(!loop.paused));
  speedBtn.addEventListener("click", () => { speedIdx = (speedIdx + 1) % SPEED_STEPS.length; loop.speed = SPEED_STEPS[speedIdx]; speedPill.textContent = `${loop.speed}×`; });
  window.addEventListener("keydown", (e) => { if (e.code === "Space") { e.preventDefault(); setPaused(!loop.paused); } });

  document.title = `DasBlut — ${world.mapName}`;
}

// Host-side: apply an order relayed from the German commander to an Axis unit.
function applyAxisOrder(world: World, o: AxisOrder): void {
  if (o.vid != null) {
    const v = world.vehicle(o.vid);
    if (!v || v.faction !== "axis") return;
    if (o.kind === "vehDefend") world.orderVehiclePosture(o.vid);
    else if (o.kind === "vehFire" && o.x != null && o.y != null) world.orderVehicleFire(o.vid, o.x, o.y);
    else if (o.cell) world.orderVehicleMove(o.vid, o.cell, o.kind === "vehFast");
    return;
  }
  if (o.teamId == null) return;
  const team = world.team(o.teamId);
  if (!team || team.faction !== "axis") return;
  if (o.kind === "defend" || o.kind === "ambush") world.orderPosture(o.teamId, o.kind);
  else if (o.kind === "smoke" && o.cell) world.orderSmoke(o.teamId, o.cell);
  else if (o.kind === "fire") { if (o.enemyId != null) world.orderFireUnit(o.teamId, o.enemyId); else if (o.cell) world.orderAreaFire(o.teamId, o.cell); }
  else if (o.cell) world.orderMove(o.teamId, o.cell, o.kind === "fast" ? "fast" : o.kind === "sneak" ? "sneak" : "move");
}

// === German / spectator client =====================================================

async function startClientView(setup: Setup) {
  const mount = document.getElementById("app")!;
  const world = buildClientWorld(setup);
  const renderer = new Renderer();
  await renderer.init(mount, world);
  renderer.revealAll = true; // clients see the whole field (the host owns the fog)
  (window as { __game?: unknown }).__game = { world, renderer };

  onSnapshotClient = (snap) => applySnapshot(world, snap);

  // Every client gets the Axis HUD; only an active German commander's orders are sent
  // (netIssuer gates on net.role), so a spectator can look around but not interfere.
  const hud = installHUD(world, renderer, { side: "axis", local: false });

  // Pause/speed are meaningless for a client — hide them.
  for (const id of ["pauseBtn", "speedBtn", "speedPill"]) {
    const el = document.getElementById(id); if (el) el.style.display = "none";
  }

  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    hud.update(now - last); // keyboard pan
    last = now;
    renderer.render(world, 1);
    hud.frame();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  document.title = `DasBlut — ${world.mapName}`;
}
