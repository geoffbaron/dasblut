import { GameLoop } from "./game/loop.ts";
import { SPEED_STEPS, VIS_INTERVAL } from "./game/constants.ts";
import { GameMap } from "./game/gamemap.ts";
import { step } from "./game/sim.ts";
import { Cell } from "./game/pathfinding.ts";
import { DEFAULT_SETUP, factionName, Faction, GameSetup, Stance, World } from "./game/world.ts";
import { WEAPONS } from "./game/weapons.ts";
import { VEHICLES } from "./game/vehicleDefs.ts";
import { updateVisibility } from "./game/visibility.ts";
import { Renderer } from "./render/renderer.ts";
import { Input } from "./render/input.ts";
import { runMenu, MenuHandle } from "./render/menu.ts";
import { sound } from "./render/sound.ts";
import { net } from "./net/net.ts";
import {
  applySnapshot, AxisOrder, buildClientWorld, encodeSetup, encodeSnapshot, Setup, Snapshot,
} from "./net/snapshot.ts";

// Armed map-click order: which movement/fire order a left-click issues.
type ArmedOrder = "move" | "fast" | "sneak" | "fire" | "smoke" | "charge";

// --- Multiplayer bootstrap ---------------------------------------------------------
// The host runs the authoritative sim and plays US (the normal single-player flow,
// plus broadcasting), and can be joined by a German commander (Axis) or spectators.
// There is no lobby/session concept — server/index.js runs a single global room, so
// every visitor to the site shares one match. That makes joining a DELIBERATE, opt-in
// action: every tab always gets its own private single-player menu first; the only way
// into someone else's battle is the explicit "Join Live Battle" prompt below. (An
// earlier version auto-joined/auto-claimed Axis for any non-host connection, which
// meant a stale connection or a simple page reload could silently swap a solo player
// into commanding the wrong side of someone else's game, discarding their own menu
// picks entirely — that's why this is opt-in now.)
let booted = false;        // this tab has committed to a screen (its own menu, or a joined client view)
let localStarted = false;  // the local player's own game has actually started (hides the join prompt)
let joined = false;        // this tab has joined/spectated the live battle instead
let pendingSetup: Setup | null = null;
// True when a human German commander is connected (the host's "opponent ready" flag).
let opponentPresent = false;
// Host hooks, wired up once startGame has built the world.
let onAxisOrderHost: ((o: AxisOrder) => void) | null = null;
let onGermanPresentHost: ((present: boolean) => void) | null = null;
// Client hook, wired up by startClientView.
let onSnapshotClient: ((s: Snapshot) => void) | null = null;
let menuHandle: MenuHandle | null = null;

net.connect({
  onRole: (_role, germanPresent) => {
    opponentPresent = germanPresent;
    startOffline(); // always show THIS tab's own local menu, whatever role the server assigned
    updateJoinBattleUI();
  },
  onGermanPresent: (p) => {
    if (p && !opponentPresent) toast("A human German commander has joined — the AI stands down.");
    opponentPresent = p;
    onGermanPresentHost?.(p);
    updateJoinBattleUI();
  },
  onSetup: (d) => { pendingSetup = d as Setup; updateJoinBattleUI(); },
  onSnapshot: (d) => onSnapshotClient?.(d as Snapshot),
  onAxisOrder: (d) => onAxisOrderHost?.(d as AxisOrder),
  onClose: () => startOffline(), // host left / disconnected → fall back to local play
});

// Brief on-screen notice (e.g. when an opponent connects).
function toast(msg: string): void {
  let t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    t.style.cssText =
      "position:fixed;top:44px;left:50%;transform:translateX(-50%);z-index:40;" +
      "font:600 13px ui-monospace,monospace;padding:8px 16px;border-radius:8px;" +
      "background:rgba(20,40,20,0.92);border:1px solid #6f9f4f;color:#cfe8bf;" +
      "transition:opacity 0.4s;pointer-events:none;";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = "1";
  window.setTimeout(() => { if (t) t.style.opacity = "0"; }, 4000);
}
// If nothing answers shortly, there's no multiplayer server: play offline.
setTimeout(() => startOffline(), 900);

function startOffline(): void {
  if (booted) return;
  booted = true;
  menuHandle = runMenu((map, objectiveCount, setup) => {
    localStarted = true;
    updateJoinBattleUI(); // this tab has committed to its own game — hide the join prompt
    return startGame(map, objectiveCount, setup);
  });
}

// The ONLY path into commanding/spectating another tab's match — never automatic.
// Shown only before the local player has started their own game, only once we know
// we're not the host of this room, and only once the host has actually published a map.
function updateJoinBattleUI(): void {
  const el = document.getElementById("joinBattle");
  const msg = document.getElementById("joinBattleMsg");
  const btn = document.getElementById("joinBattleBtn") as HTMLButtonElement | null;
  if (!el || !msg || !btn) return;
  const show = !joined && !localStarted && net.role !== "host" && pendingSetup != null;
  el.style.display = show ? "flex" : "none";
  if (show) {
    msg.textContent = `⚔ A battle is in progress (${pendingSetup!.mapName})`;
    btn.textContent = opponentPresent ? "Spectate" : "Join as Axis Commander";
  }
}
document.getElementById("joinBattleBtn")?.addEventListener("click", () => {
  if (!pendingSetup || joined) return;
  joined = true;
  if (!opponentPresent) net.claimGerman();
  menuHandle?.dispose();
  const el = document.getElementById("joinBattle");
  if (el) el.style.display = "none";
  startClientView(pendingSetup);
});

// === Shared HUD ====================================================================


// An order issuer: the host applies orders to the world directly; a client relays
// them to the host over the network (and only an active German commander may do so).
interface Issuer {
  move(teamId: number, cell: Cell, stance: Stance): boolean;
  fireUnit(teamId: number, enemyId: number): void;
  fireVehicle(teamId: number, vehId: number): boolean;
  areaFire(teamId: number, cell: Cell): void;
  smoke(teamId: number, cell: Cell): boolean;
  ceaseFire(teamId: number): void;
  posture(teamId: number, stance: Stance): void;
  vehMove(vid: number, cell: Cell, fast: boolean): boolean;
  vehFire(vid: number, x: number, y: number): void;
  vehPosture(vid: number): void;
}

function localIssuer(world: World): Issuer {
  return {
    move: (t, c, s) => world.orderMove(t, c, s),
    fireUnit: (t, e) => world.orderFireUnit(t, e),
    fireVehicle: (t, v) => world.orderFireVehicle(t, v),
    areaFire: (t, c) => world.orderAreaFire(t, c),
    smoke: (t, c) => world.orderSmoke(t, c),
    ceaseFire: (t) => world.orderCeaseFire(t),
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
    fireVehicle: () => false, // Axis fields no AT teams — never invoked from a client
    areaFire: (teamId, cell) => { if (ok()) net.sendAxisOrder({ kind: "fire", teamId, cell }); },
    smoke: (teamId, cell) => { if (ok()) net.sendAxisOrder({ kind: "smoke", teamId, cell }); return ok(); },
    ceaseFire: (teamId) => { if (ok()) net.sendAxisOrder({ kind: "defend", teamId }); }, // cease-fire doubles as defend
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
  // Side label follows the era (US/WEHRMACHT in WW2, UNION/CONFEDERATE in the Civil War).
  const sideLabel = (f: Faction) => factionName(world.era, f).toUpperCase();
  const objectiveEl = document.getElementById("objective")!;
  const bannerEl = document.getElementById("banner")!;
  const bannerBig = document.getElementById("bannerBig")!;
  const bannerSub = document.getElementById("bannerSub")!;
  // The battle is genuinely over at this point (no more orders can be given — see the
  // orders-bar visibility check below); the only way back in is a fresh battle.
  document.getElementById("bannerNewBattle")?.addEventListener("click", () => location.reload());
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
      "position:fixed;bottom:12px;right:12px;z-index:30;font:600 12px ui-monospace,monospace;" +
      "padding:5px 12px;border-radius:6px;background:rgba(20,19,15,0.88);border:1px solid #4a463c;color:#cfc8b6;";
    document.body.appendChild(badge);
  }

  // There is no deployment phase any more — the battle starts at once from the static
  // spawn positions, so the deploy bar and Launch button are never shown.
  deployBar.style.display = "none";
  void launchBtn;
  if (!canCommand) { ordersBar.style.display = "none"; rosterEl.style.display = "none"; }

  // --- force tracker / objective / selection / banner ---
  const refreshStatus = () => {
    let mine = 0, enemySeen = 0, enemyTotal = 0;
    for (const s of world.soldiers) {
      if (s.status !== "active") continue;
      if (s.faction === (side ?? "us")) mine++;
      else { enemyTotal++; if (s.seen) enemySeen++; }
    }
    if (side) forcesEl.textContent = `${sideLabel(side)} ${mine} · ${sideLabel(enemy)} ${enemySeen > 0 ? enemySeen + " seen" : "?"}`;
    else forcesEl.textContent = `${sideLabel("us")} ${mine} · ${sideLabel("axis")} ${enemyTotal}`;

    {
      const objs = world.objectives;
      const total = objs.length;
      const holder = world.objAllOwner();
      const contested = objs.some((o) => o.contested);
      const myOwned = objs.filter((o) => o.owner === world.player).length;
      const foe = world.aiFaction;
      let line: string;
      if (holder && world.roleOf(holder) === "attack") {
        const c = holder === world.player ? "hold" : holder;
        line = `<span class="obj-${c}">${sideLabel(holder)} HOLD ${Math.ceil(world.objHoldTimer)} / ${world.objectiveHoldS}s</span>`;
      } else if (total === 1) {
        const o = objs[0];
        if (contested) line = `<span class="obj-contested">CONTESTED</span>`;
        else if (o.capturing) line = `<span class="obj-${o.capturing}">${sideLabel(o.capturing as Faction)} capturing… ${Math.round(o.progress * 100)}%</span>`;
        else if (o.owner === "neutral") line = `<span class="obj-contested">UP FOR GRABS</span>`;
        else line = `<span class="obj-${o.owner}">${sideLabel(o.owner as Faction)} holds</span>`;
      } else {
        const cls = myOwned >= total - myOwned ? `obj-${world.player}` : `obj-${foe}`;
        line = `<span class="${cls}">${sideLabel(world.player)} ${myOwned} / ${total}</span>` + (contested ? ` <span class="obj-contested">· contested</span>` : "");
      }
      objectiveEl.innerHTML = `<div class="obj-title">${total > 1 ? "OBJECTIVES" : "OBJECTIVE"}</div><div>${line}</div>`;
    }

    if (world.outcome) {
      bannerEl.style.display = "flex";
      const iWon = world.outcome === "win"; // outcome is already player-relative
      const amDefender = world.roleOf(world.player) === "defend";
      bannerBig.textContent = iWon ? (amDefender ? "POSITION HELD" : "OBJECTIVE SECURED") : (amDefender ? "POSITION OVERRUN" : "ATTACK REPULSED");
      bannerBig.style.color = iWon ? "#9fcf6f" : "#e0533a";
      bannerSub.textContent = (iWon ? "The field is yours. " : "The battle is lost. ") + "This engagement has ended — no further orders.";
    }

    if (!canCommand) { statusEl.innerHTML = `<span class="dim">spectating</span>`; return; }

    if (world.selectedVehicleId != null) {
      const v = world.vehicle(world.selectedVehicleId)!;
      const tags: string[] = [];
      if (v.status === "ko") tags.push(`<span class="tag s-routing">knocked out</span>`);
      else if (v.immobilized) tags.push(`<span class="tag s-pinned">immobilized</span>`);
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
    let ammoLine = "";
    if (team.kind === "mortar") {
      const tube = live.find((s) => WEAPONS[s.weapon].indirect);
      if (tube) ammoLine = ` · HE ${tube.ammo} · Smoke ${tube.smokeAmmo}`;
    }
    statusEl.innerHTML =
      `<div class="name">${team.name} <span class="dim">· ${live[0]?.stance ?? "move"}</span></div>` +
      `<div class="dim">${live.length} effective · ${casualties} down${ammoLine}</div><div class="row">${tags}</div>`;
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
    const primaryTeam = world.selectedTeamId != null ? world.team(world.selectedTeamId) : null;
    const mortarFiring = hasMortar && primaryTeam?.kind === "mortar" && world.teamIsFiring(world.selectedTeamId!);
    // In the Civil War and the medieval age any foot or horse unit can be sent in with cold
    // steel; in WW2 only cavalry charge (none on the WW2 roster, so the button stays hidden).
    const canCharge = world.selectedVehicleId == null && [...world.selectedTeamIds].some((id) => {
      const k = world.team(id)?.kind;
      return k === "cavalry" || (world.era !== "ww2" && k === "infantry");
    });
    for (const b of orderBtns) {
      const order = b.dataset.order!;
      let hidden = deployPhase && (order === "fire" || order === "fast" || order === "ambush" || order === "defend");
      if (order === "smoke") hidden = deployPhase || !hasMortar;
      if (order === "charge") hidden = deployPhase || !canCharge; // shock action (cavalry, or ACW infantry)
      b.style.display = hidden ? "none" : "";
      b.classList.toggle("armed", order === armed);
      // While a mortar is sustaining fire, label the Fire button "STOP" and pulse it.
      if (order === "fire") {
        b.textContent = "";
        if (mortarFiring) {
          b.innerHTML = `Stop Fire<br><span class="k">F</span>`;
          b.style.borderColor = "#e0533a";
          b.style.color = "#e0a0a0";
        } else {
          b.innerHTML = `Fire<br><span class="k">F</span>`;
          b.style.borderColor = "";
          b.style.color = "";
        }
      }
    }
  };

  const flagBlocked = (x: number, y: number) => { world.effects.push({ kind: "blocked", x0: x, y0: y, x1: x, y1: y, ttl: 0.8 }); };

  const handleOrder = (x: number, y: number) => {
    if (!canCommand) return;
    const cell = { cx: Math.floor(x), cy: Math.floor(y) };

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
      const primaryTeam = world.team(primary);
      // Mortar teams sustain fire until toggled off. If the mortar is already firing,
      // a second fire order is a cease-fire (toggle). For direct-fire squads the order
      // re-aims to a new target without needing a toggle.
      if (primaryTeam?.kind === "mortar") {
        if (world.teamIsFiring(primary)) {
          for (const tid of teamIds) issuer.ceaseFire(tid);
          armed = "move";
          sound.playUI("ui_select");
          updateOrdersBar(); refreshStatus();
          return;
        }
        issuer.areaFire(primary, cell);
      } else {
        // Clicking an enemy tank sends the squad's AT men after it (real armor
        // engagement); clicking an enemy soldier focus-fires him; otherwise it's
        // suppressing area fire on the ground.
        const tank = world.vehicles.find((v) => v.faction === enemy && v.status !== "ko" && v.seen && Math.hypot(v.x - x, v.y - y) < 2);
        const foe = world.soldiers.find((s) => s.faction === enemy && s.status === "active" && s.seen && Math.hypot(s.x - x, s.y - y) < 1.4);
        if (tank && issuer.fireVehicle(primary, tank.id)) {
          // AT men locked on — done.
        } else if (foe) issuer.fireUnit(primary, foe.id);
        else issuer.areaFire(primary, cell);
      }
    } else if (teamIds.length === 1) {
      if (!issuer.move(teamIds[0], cell, armed as Stance)) { flagBlocked(x, y); refreshStatus(); return; }
    } else {
      // Move the group as a body: keep each squad's position relative to the group's
      // centre, so the formation advances intact instead of collapsing onto one point.
      const centers = teamIds.map((tid) => teamCenter(world, tid)).filter((c): c is { x: number; y: number } => c != null);
      const gx = centers.reduce((s, c) => s + c.x, 0) / (centers.length || 1);
      const gy = centers.reduce((s, c) => s + c.y, 0) / (centers.length || 1);
      let anyOk = false;
      for (const tid of teamIds) {
        const c = teamCenter(world, tid);
        if (!c) continue;
        const goal = { cx: Math.round(cell.cx + (c.x - gx)), cy: Math.round(cell.cy + (c.y - gy)) };
        if (issuer.move(tid, goal, armed as Stance)) anyOk = true;
      }
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
  const KIND_LABEL: Record<string, string> = { rifle: "RIFLE", mg: "MG", at: "AT", mortar: "MORTAR", infantry: "INFANTRY", cavalry: "CAVALRY", artillery: "ARTILLERY", archers: "ARCHERS" };
  // Medieval units read with period names rather than the generic branch labels.
  const MED_KIND_LABEL: Record<string, string> = { infantry: "MEN-AT-ARMS", cavalry: "KNIGHTS", artillery: "CATAPULT", archers: "ARCHERS" };
  const kindLabel = (kind: string): string => (world.era === "medieval" && MED_KIND_LABEL[kind]) || KIND_LABEL[kind] || kind.toUpperCase();
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
        `<div class="rhead"><span class="rname">${team.name}</span><span class="rbadge ${team.kind}">${kindLabel(team.kind)}</span><span class="rcount"></span></div>` +
        `<div class="rbars"><div class="rbar"><span class="rlabel">S</span><div class="rtrack"><div class="rfill" data-k="str"></div></div></div>` +
        `<div class="rbar"><span class="rlabel">M</span><div class="rtrack"><div class="rfill" data-k="mor"></div></div></div>` +
        `<div class="rbar"><span class="rlabel">A</span><div class="rtrack"><div class="rfill" data-k="ammo"></div></div></div></div>`;
      el.addEventListener("click", (e) => {
        if (e.shiftKey && world.selectedVehicleId == null) {
          // Shift-click a card to add/remove that squad from the current group.
          if (world.selectedTeamIds.has(team.id)) world.selectedTeamIds.delete(team.id);
          else world.selectedTeamIds.add(team.id);
          world.selectedTeamId = world.selectedTeamIds.size ? [...world.selectedTeamIds][world.selectedTeamIds.size - 1] : null;
        } else {
          world.selectedTeamId = team.id; world.selectedTeamIds = new Set([team.id]); renderer.centerOnTeam(world, team.id);
        }
        world.selectedVehicleId = null;
        armed = "move"; sound.playUI("ui_select");
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
        if (team.kind === "mortar") {
          if (WEAPONS[s.weapon].indirect) { ammoMax += WEAPONS[s.weapon].ammo + 2; if (s.status === "active") ammo += s.ammo + s.smokeAmmo; }
        } else {
          ammoMax += WEAPONS[s.weapon].ammo;
          if (s.status === "active") ammo += s.ammo;
        }
        if (s.status !== "active") continue;
        live++; moraleSum += s.morale;
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
    // Only click when the user actually selected a unit — not when deselecting
    // (right-click) or dragging an empty selection box.
    const hasSel = world.selectedTeamId != null || world.selectedVehicleId != null || world.selectedTeamIds.size > 0;
    if (canCommand && hasSel) sound.playUI("ui_select");
    updateOrdersBar(); refreshStatus(); refreshRoster();
  };
  const onBox = (sx0: number, sy0: number, sx1: number, sy1: number, additive = false) => {
    if (!canCommand) return;
    const a = renderer.screenToWorld(Math.min(sx0, sx1), Math.min(sy0, sy1));
    const b = renderer.screenToWorld(Math.max(sx0, sx1), Math.max(sy0, sy1));
    const ids = additive ? new Set(world.selectedTeamIds) : new Set<number>();
    for (const team of world.teams) {
      if (team.faction !== side) continue;
      for (const sid of team.soldierIds) {
        const s = world.soldier(sid);
        if (s && s.status === "active" && s.x >= a.x && s.x <= b.x && s.y >= a.y && s.y <= b.y) { ids.add(team.id); break; }
      }
    }
    if (ids.size === 0) return;
    world.selectedTeamIds = ids; world.selectedTeamId = [...ids][ids.size - 1]; world.selectedVehicleId = null;
    onSel();
  };
  const input = new Input(renderer, world, onSel, handleOrder, onBox, inputSide);

  if (canCommand) {
    const ORDER_KEYS: Record<string, string> = { q: "move", w: "fast", e: "sneak", r: "defend", t: "ambush", f: "fire", g: "smoke", c: "charge" };
    // Control groups: Ctrl/Cmd+1‥9 stores the current squad selection; 1‥9 recalls it
    // (RTS-style), so you can keep, say, your firing line on 1 and your flanking force on 2.
    const groups = new Map<number, number[]>();
    window.addEventListener("keydown", (e) => {
      if (e.key.toLowerCase() === "o") { renderer.centerOnObjective(world); return; }
      if (/^[1-9]$/.test(e.key)) {
        const g = parseInt(e.key, 10);
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          groups.set(g, [...world.selectedTeamIds]);
          sound.playUI("ui_select");
        } else {
          const live = (groups.get(g) ?? []).filter((id) => world.team(id)?.soldierIds.some((sid) => world.soldier(sid)?.status === "active"));
          if (live.length) {
            world.selectedTeamIds = new Set(live);
            world.selectedTeamId = live[live.length - 1];
            world.selectedVehicleId = null;
            onSel();
            renderer.centerOnTeam(world, live[0]);
          }
        }
        return;
      }
      const order = ORDER_KEYS[e.key.toLowerCase()];
      if (order && (world.selectedTeamId != null || world.selectedVehicleId != null)) pickOrder(order);
    });
  }
  updateOrdersBar();

  // --- per-frame HUD refresh ---
  const frame = () => {
    if (world.phase === "deploy") { clockEl.textContent = "DEPLOY"; clockEl.style.color = "#7fa8e8"; }
    else {
      const left = Math.max(0, world.battleTimeS - world.time);
      clockEl.textContent = `⏱ ${Math.floor(left / 60)}:${Math.floor(left % 60).toString().padStart(2, "0")}`;
      clockEl.style.color = left < 60 ? "#e0796f" : "";
    }
    // Lift the badge above the deploy bar so it doesn't overlap the launch button.
    badge!.style.bottom = world.phase === "deploy" ? "56px" : "12px";
    badge!.style.display = "block";
    if (!net.connected) {
      badge!.textContent = "SINGLE PLAYER";
      badge!.style.color = "#9a9484";
    } else if (net.role === "host") {
      badge!.textContent = opponentPresent ? "MULTIPLAYER · YOU: US · GERMAN: human ✓" : "MULTIPLAYER · YOU: US · waiting for opponent…";
      badge!.style.color = opponentPresent ? "#9fcf6f" : "#e0c060";
    } else if (net.role === "german") {
      badge!.textContent = "MULTIPLAYER · YOU: GERMAN (Axis)";
      badge!.style.color = "#e0a06a";
    } else {
      badge!.textContent = "MULTIPLAYER · SPECTATING";
      badge!.style.color = "#9a9484";
    }
    refreshStatus(); updateOrdersBar(); refreshRoster();
  };
  return { frame, update: (ms: number) => input.update(ms) };
}

// === Host (US) / offline single-player =============================================

// Centre of mass of a team's still-standing men — used to move a multi-squad group as a
// body while keeping each squad's place in the formation.
function teamCenter(world: World, teamId: number): { x: number; y: number } | null {
  const team = world.team(teamId);
  if (!team) return null;
  let x = 0, y = 0, n = 0;
  for (const id of team.soldierIds) {
    const s = world.soldier(id);
    if (s && s.status === "active") { x += s.x; y += s.y; n++; }
  }
  return n ? { x: x / n, y: y / n } : null;
}

// Rewrite the help/tutorial card to match the era, so opening Help mid-battle reflects
// whether you're fighting WW2 or the Civil War (units, mission flavour, the charge order).
function applyEraTutorial(world: World): void {
  const era = world.era;
  const set = (id: string, html: string) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
  const sub = era === "medieval" ? "Close-Combat-style medieval battles. Here's how to play."
    : era === "acw" ? "Close-Combat-style US Civil War tactics. Here's how to play."
    : "Close-Combat-style WW2 tactics. Here's how to play.";
  set("tutSub", sub);
  const holdS = world.objectiveHoldS;
  const holdTxt = holdS % 60 === 0 ? `${holdS / 60} minute${holdS === 60 ? "" : "s"}` : `${holdS} seconds`;
  const mission = era === "medieval"
    ? `Take the crossroads <b>objective</b> and hold it for <b>${holdTxt}</b> before the clock runs out. Aldmere (blue) and Corvath (crimson) contest the ground.`
    : era === "acw"
    ? `Take the crossroads <b>objective</b> and hold it for <b>${holdTxt}</b> before the clock runs out. Union (blue) and Confederate (grey) fight for the ground.`
    : `Take the crossroads <b>objective</b> and hold it for <b>${holdTxt}</b> before the clock runs out. US (blue) and the Germans (red) fight for the ground.`;
  set("tutMission", mission);
  const units = era === "medieval"
    ? "<li><b>MEN-AT-ARMS</b> — a shieldwall of swords and spears; they advance and settle it hand-to-hand.</li>"
      + "<li><b>ARCHERS</b> — massed longbows; loose volleys to break up an advance from range.</li>"
      + "<li><b>KNIGHTS</b> — heavy horse with the lance; <b>charge</b> to ride down shaken men.</li>"
      + "<li><b>CATAPULT</b> — a crew-served engine; hurls boulders that smash walls and ranks. Kill the crew to wreck it.</li>"
    : era === "acw"
    ? "<li><b>INFANTRY</b> — big rifle-musket platoons; deadly volleys, but a slow muzzle-loading reload.</li>"
      + "<li><b>CAVALRY</b> — mounted carbines; fast skirmishers that can <b>charge</b> and ride down shaken men.</li>"
      + "<li><b>ARTILLERY</b> — a field-gun battery; shells at range, <b>canister</b> up close. Kill the crew to silence it.</li>"
    : "<li><b>RIFLE</b> — line infantry; the backbone of the assault.</li>"
      + "<li><b>MG</b> — light machine gun; superb at <b>suppressing</b> the enemy so others can move.</li>"
      + "<li><b>AT</b> — bazooka team; kills tanks — aim for the <b>flank or rear</b>.</li>"
      + "<li><b>MORTAR</b> — one tube, slow to reload; lobs HE or <b>smoke</b> over walls. You must call the shot.</li>"
      + "<li><b>TANK</b> — your Sherman; click to direct its fire.</li>";
  set("tutUnits", units);
  const chargeRow = document.getElementById("tutChargeRow");
  if (chargeRow) chargeRow.style.display = era !== "ww2" ? "" : "none";
}

async function startGame(map: GameMap, objectiveCount = 1, setup: GameSetup = DEFAULT_SETUP) {
  const mount = document.getElementById("app")!;
  const world = new World(map, objectiveCount, setup);
  sound.era = world.era; // picks the ambient bed (no aircraft in the Civil War)
  applyEraTutorial(world);
  updateVisibility(world, VIS_INTERVAL);
  const renderer = new Renderer();
  await renderer.init(mount, world);
  (window as { __game?: unknown }).__game = { world, renderer };

  const hud = installHUD(world, renderer, { side: world.player, local: true });

  // Multiplayer host: apply relayed orders; disable the AI side while a human is in.
  onAxisOrderHost = (o) => applyAxisOrder(world, o);
  onGermanPresentHost = (present) => { world.aiHuman = present; };
  let setupSent = false, netAccum = 0;

  let lastRenderTs = performance.now();
  let prevAtkOwned = world.objectives.filter((o) => o.owner === world.player).length;
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
      const atkOwned = world.objectives.filter((o) => o.owner === world.player).length;
      if (atkOwned !== prevAtkOwned) { sound.playUI(atkOwned > prevAtkOwned ? "obj_capture" : "obj_lost"); prevAtkOwned = atkOwned; }
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

  // With no deployment phase, the battle is live the instant the map loads. If the
  // first-time help card is up, hold the fight paused behind it — it's the new "ready?"
  // gate — and resume the moment the player dismisses it.
  const tut = document.getElementById("tutorial");
  if (tut && getComputedStyle(tut).display !== "none") {
    setPaused(true);
    const obs = new MutationObserver(() => {
      if (getComputedStyle(tut).display === "none") { setPaused(false); obs.disconnect(); }
    });
    obs.observe(tut, { attributes: true, attributeFilter: ["style"] });
  }

  document.title = `Any War — ${world.mapName}`;
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
  if (o.kind === "defend" || o.kind === "ambush") { world.orderPosture(o.teamId, o.kind); world.orderCeaseFire(o.teamId); }
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
  document.title = `Any War — ${world.mapName}`;
}
