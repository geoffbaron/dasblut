import { GameLoop } from "./game/loop.ts";
import { BATTLE_TIME_S, OBJECTIVE_HOLD_TO_WIN, SPEED_STEPS, VIS_INTERVAL } from "./game/constants.ts";
import { GameMap } from "./game/gamemap.ts";
import { step } from "./game/sim.ts";
import { Stance, World } from "./game/world.ts";
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
// plus broadcasting). German/spectator clients render the host's snapshots. If no WS
// server answers (offline / Vite dev), we just start the normal single-player game.
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

async function startGame(map: GameMap) {
  const mount = document.getElementById("app")!;
  const world = new World(map);
  // Pre-warm visibility so the first rendered frame shows your forces, not all-black fog.
  updateVisibility(world, VIS_INTERVAL);
  const renderer = new Renderer();
  await renderer.init(mount, world);

  const statusEl = document.getElementById("status")!;
  const clockEl = document.getElementById("clock")!;
  const forcesEl = document.getElementById("forces")!;
  const objectiveEl = document.getElementById("objective")!;
  const bannerEl = document.getElementById("banner")!;
  const bannerBig = document.getElementById("bannerBig")!;
  const bannerSub = document.getElementById("bannerSub")!;
  const deployBar = document.getElementById("deployBar")!;
  const launchBtn = document.getElementById("launchBtn")!;

  deployBar.style.display = "flex";
  launchBtn.addEventListener("click", () => {
    world.phase = "battle";
    deployBar.style.display = "none";
    renderer.centerOnObjective(world);
  });

  const refreshStatus = () => {
    // Force tracker.
    let us = 0;
    let axisSeen = 0;
    for (const s of world.soldiers) {
      if (s.status !== "active") continue;
      if (s.faction === "us") us++;
      else if (s.seen) axisSeen++;
    }
    forcesEl.textContent = `US ${us} · AXIS ${axisSeen > 0 ? axisSeen + " seen" : "?"}`;

    // Objective panel.
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

    // Outcome banner.
    if (world.outcome) {
      bannerEl.style.display = "flex";
      bannerBig.textContent = world.outcome === "win" ? "OBJECTIVE SECURED" : "ATTACK REPULSED";
      bannerBig.style.color = world.outcome === "win" ? "#9fcf6f" : "#e0533a";
      bannerSub.textContent =
        world.outcome === "win" ? "You hold the victory location." : "The defenders held the line.";
    }

    // Selected vehicle.
    if (world.selectedVehicleId != null) {
      const v = world.vehicle(world.selectedVehicleId)!;
      const tags: string[] = [];
      if (v.status === "ko") tags.push(`<span class="tag s-routing">knocked out</span>`);
      else {
        if (v.immobilized) tags.push(`<span class="tag s-pinned">immobilized</span>`);
        if (v.suppression > 0.85) tags.push(`<span class="tag s-shaken">buttoned up</span>`);
      }
      statusEl.innerHTML =
        `<div class="name">${v.name} <span class="dim">· ${v.status === "ko" ? "wreck" : v.stance}</span></div>` +
        `<div class="dim">crew ${v.crew} · AP ${v.apAmmo} · HE ${v.heAmmo}</div>` +
        (tags.length ? `<div class="row">${tags.join("")}</div>` : "");
      return;
    }

    if (world.selectedTeamIds.size === 0) {
      statusEl.innerHTML = `<span class="dim">No team selected</span>`;
      return;
    }
    // Multi-select: show a combined summary instead of per-team detail.
    if (world.selectedTeamIds.size > 1) {
      let totalLive = 0, total = 0;
      for (const tid of world.selectedTeamIds) {
        const t = world.team(tid);
        if (!t) continue;
        total += t.soldierIds.length;
        for (const sid of t.soldierIds)
          if (world.soldier(sid)?.status === "active") totalLive++;
      }
      statusEl.innerHTML =
        `<div class="name">${world.selectedTeamIds.size} squads selected</div>` +
        `<div class="dim">${totalLive} effective · ${total - totalLive} down</div>`;
      return;
    }
    const team = world.team(world.selectedTeamId!)!;
    const live = team.soldierIds.map((id) => world.soldier(id)!).filter((s) => s.status === "active");
    const counts: Record<string, number> = {};
    let moraleSum = 0;
    for (const s of live) {
      counts[s.state] = (counts[s.state] ?? 0) + 1;
      moraleSum += s.morale;
    }
    const casualties = team.soldierIds.length - live.length;
    const avgMorale = live.length ? Math.round((moraleSum / live.length) * 100) : 0;
    const tags = (["steady", "shaken", "pinned", "panicked", "routing"] as const)
      .filter((st) => counts[st])
      .map((st) => `<span class="tag s-${st}">${counts[st]} ${st}</span>`)
      .join("");
    const stance = live[0]?.stance ?? "move";
    statusEl.innerHTML =
      `<div class="name">${team.name} <span class="dim">· ${stance}</span></div>` +
      `<div class="dim">${live.length} effective · ${casualties} down · morale ${avgMorale}%</div>` +
      `<div class="row">${tags}</div>`;
  };
  refreshStatus();

  // --- Orders system ---
  const ordersBar = document.getElementById("orders")!;
  const orderBtns = Array.from(ordersBar.querySelectorAll<HTMLButtonElement>("button"));
  let armed: ArmedOrder = "move";

  const updateOrdersBar = () => {
    const show = (world.selectedTeamIds.size > 0 || world.selectedVehicleId != null) && !world.outcome;
    ordersBar.style.display = show ? "flex" : "none";
    const deployPhase = world.phase === "deploy";
    // Smoke is a mortar-team-only order (and not for tanks / deployment).
    const hasMortar =
      world.selectedVehicleId == null &&
      [...world.selectedTeamIds].some((id) => world.team(id)?.kind === "mortar");
    for (const b of orderBtns) {
      const order = b.dataset.order!;
      let hidden = deployPhase && (order === "fire" || order === "fast" || order === "ambush" || order === "defend");
      if (order === "smoke") hidden = deployPhase || !hasMortar;
      b.style.display = hidden ? "none" : "";
      b.classList.toggle("armed", order === armed);
    }
  };

  // Flash a red "can't go there" marker at a world point and give a soft cue.
  const flagBlocked = (x: number, y: number) => {
    world.effects.push({ kind: "blocked", x0: x, y0: y, x1: x, y1: y, ttl: 0.8 });
  };

  // A left-click on the ground issues the currently armed order to all selected teams.
  const handleOrder = (x: number, y: number) => {
    const cell = { cx: Math.floor(x), cy: Math.floor(y) };

    // During deployment, US squads can only move within their southern zone.
    if (world.phase === "deploy" && cell.cy < world.deployY0Us) {
      flagBlocked(x, y); // clicked outside the deploy zone
      return;
    }

    if (world.selectedVehicleId != null) {
      const vid = world.selectedVehicleId;
      if (armed === "fire") world.orderVehicleFire(vid, x, y);
      else if (!world.orderVehicleMove(vid, cell, armed === "fast")) flagBlocked(x, y);
      refreshStatus();
      return;
    }

    const teamIds = [...world.selectedTeamIds];
    if (teamIds.length === 0) return;

    if (armed === "smoke") {
      // Lay a smoke screen — only mortar teams in the selection respond.
      let anyTube = false;
      for (const tid of teamIds) if (world.orderSmoke(tid, cell)) anyTube = true;
      if (!anyTube) { flagBlocked(x, y); refreshStatus(); return; } // no mortars selected
      sound.playUI("ui_order");
      refreshStatus();
      return;
    } else if (armed === "fire") {
      // Fire is aimed by the primary (first selected) team only.
      const primary = world.selectedTeamId!;
      const enemy = world.soldiers.find(
        (s) => s.faction === "axis" && s.status === "active" && s.seen && Math.hypot(s.x - x, s.y - y) < 1.4,
      );
      if (enemy) world.orderFireUnit(primary, enemy.id);
      else world.orderAreaFire(primary, cell);
    } else {
      // Group move: fan teams out horizontally around the target so they don't pile up.
      const n = teamIds.length;
      let anyOk = false;
      teamIds.forEach((tid, i) => {
        const col = Math.round(i - (n - 1) / 2); // -1, 0, 1 for n=3 etc.
        if (world.orderMove(tid, { cx: cell.cx + col * 4, cy: cell.cy }, armed as Stance)) anyOk = true;
      });
      if (!anyOk) { flagBlocked(x, y); refreshStatus(); return; } // nobody could reach it
    }
    sound.playUI("ui_order");
    refreshStatus();
  };

  // Clicking an order button: Defend/Ambush apply in place; the rest arm a map click.
  const pickOrder = (order: string) => {
    // Smoke is mortar-only — ignore it (incl. the hotkey) when no mortar team is selected.
    if (order === "smoke") {
      const hasMortar =
        world.selectedVehicleId == null &&
        [...world.selectedTeamIds].some((id) => world.team(id)?.kind === "mortar");
      if (!hasMortar) return;
    }
    if (world.selectedVehicleId != null) {
      if (order === "defend" || order === "ambush") world.orderVehiclePosture(world.selectedVehicleId);
      else if (order !== "smoke") armed = (order === "sneak" ? "move" : order) as ArmedOrder;
      updateOrdersBar();
      refreshStatus();
      return;
    }
    if (world.selectedTeamIds.size === 0) return;
    if (order === "defend" || order === "ambush") {
      // Posture orders apply to every team in the group.
      for (const tid of world.selectedTeamIds) world.orderPosture(tid, order as Stance);
    } else {
      armed = order as ArmedOrder;
    }
    updateOrdersBar();
    refreshStatus();
  };
  for (const b of orderBtns) b.addEventListener("click", () => pickOrder(b.dataset.order!));

  const input = new Input(renderer, world,
    () => {
      armed = "move";
      sound.playUI("ui_select");
      updateOrdersBar();
      refreshStatus();
      refreshRoster();
    },
    handleOrder,
    (sx0, sy0, sx1, sy1) => {
      // Convert screen box to world space and find all US teams with a soldier inside.
      const wA = renderer.screenToWorld(Math.min(sx0, sx1), Math.min(sy0, sy1));
      const wB = renderer.screenToWorld(Math.max(sx0, sx1), Math.max(sy0, sy1));
      const ids = new Set<number>();
      for (const team of world.teams) {
        if (team.faction !== "us") continue;
        for (const sid of team.soldierIds) {
          const s = world.soldier(sid);
          if (!s || s.status !== "active") continue;
          if (s.x >= wA.x && s.x <= wB.x && s.y >= wA.y && s.y <= wB.y) {
            ids.add(team.id);
            break; // one soldier inside = whole team selected
          }
        }
      }
      if (ids.size === 0) return;
      world.selectedTeamIds = ids;
      world.selectedTeamId = [...ids][0];
      world.selectedVehicleId = null;
      armed = "move";
      sound.playUI("ui_select");
      updateOrdersBar();
      refreshStatus();
      refreshRoster();
    },
  );
  updateOrdersBar();

  // --- Unit navigator (Close Combat-style roster) ---
  // One card per friendly team showing weapon kind, strength, morale and ammo.
  // Click a card to select that squad and snap the camera to it.
  const rosterEl = document.getElementById("roster")!;
  const KIND_LABEL: Record<string, string> = { rifle: "RIFLE", mg: "MG", at: "AT", mortar: "MORTAR" };
  interface RosterCard {
    el: HTMLDivElement; count: HTMLSpanElement;
    moraleFill: HTMLDivElement; ammoFill: HTMLDivElement; strFill: HTMLDivElement;
  }
  const rosterCards = new Map<number, RosterCard>();
  const vehicleCards = new Map<number, RosterCard>();

  const buildRoster = () => {
    for (const team of world.teams) {
      if (team.faction !== "us") continue;
      const el = document.createElement("div");
      el.className = "rcard";
      el.innerHTML =
        `<div class="rhead"><span class="rname">${team.name}</span>` +
        `<span class="rbadge ${team.kind}">${KIND_LABEL[team.kind]}</span>` +
        `<span class="rcount"></span></div>` +
        `<div class="rbars">` +
        `<div class="rbar"><span class="rlabel">S</span><div class="rtrack"><div class="rfill" data-k="str"></div></div></div>` +
        `<div class="rbar"><span class="rlabel">M</span><div class="rtrack"><div class="rfill" data-k="mor"></div></div></div>` +
        `<div class="rbar"><span class="rlabel">A</span><div class="rtrack"><div class="rfill" data-k="ammo"></div></div></div>` +
        `</div>`;
      el.addEventListener("click", () => {
        world.selectedTeamId = team.id;
        world.selectedTeamIds = new Set([team.id]);
        world.selectedVehicleId = null;
        armed = "move";
        sound.playUI("ui_select");
        renderer.centerOnTeam(world, team.id);
        updateOrdersBar();
        refreshStatus();
        refreshRoster();
      });
      rosterEl.appendChild(el);
      rosterCards.set(team.id, {
        el,
        count: el.querySelector(".rcount") as HTMLSpanElement,
        strFill: el.querySelector('[data-k="str"]') as HTMLDivElement,
        moraleFill: el.querySelector('[data-k="mor"]') as HTMLDivElement,
        ammoFill: el.querySelector('[data-k="ammo"]') as HTMLDivElement,
      });
    }

    // Tank cards: armor shows up as its own unit (crew strength + gun ammo).
    for (const v of world.vehicles) {
      if (v.faction !== "us") continue;
      const el = document.createElement("div");
      el.className = "rcard";
      el.innerHTML =
        `<div class="rhead"><span class="rname">${v.name}</span>` +
        `<span class="rbadge tank">TANK</span>` +
        `<span class="rcount"></span></div>` +
        `<div class="rbars">` +
        `<div class="rbar"><span class="rlabel">C</span><div class="rtrack"><div class="rfill" data-k="str"></div></div></div>` +
        `<div class="rbar"><span class="rlabel">R</span><div class="rtrack"><div class="rfill" data-k="mor"></div></div></div>` +
        `<div class="rbar"><span class="rlabel">A</span><div class="rtrack"><div class="rfill" data-k="ammo"></div></div></div>` +
        `</div>`;
      el.addEventListener("click", () => {
        world.selectedVehicleId = v.id;
        world.selectedTeamId = null;
        world.selectedTeamIds.clear();
        armed = "move";
        sound.playUI("ui_select");
        renderer.centerOnVehicle(world, v.id);
        updateOrdersBar();
        refreshStatus();
        refreshRoster();
      });
      rosterEl.appendChild(el);
      vehicleCards.set(v.id, {
        el,
        count: el.querySelector(".rcount") as HTMLSpanElement,
        strFill: el.querySelector('[data-k="str"]') as HTMLDivElement,
        moraleFill: el.querySelector('[data-k="mor"]') as HTMLDivElement,
        ammoFill: el.querySelector('[data-k="ammo"]') as HTMLDivElement,
      });
    }
  };

  const refreshRoster = () => {
    for (const team of world.teams) {
      const card = rosterCards.get(team.id);
      if (!card) continue;
      let live = 0, moraleSum = 0, ammo = 0, ammoMax = 0;
      for (const id of team.soldierIds) {
        const s = world.soldier(id)!;
        ammoMax += WEAPONS[s.weapon].ammo;
        if (s.status !== "active") continue;
        live++;
        moraleSum += s.morale;
        ammo += s.ammo;
      }
      const total = team.soldierIds.length;
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
      const ready = ko ? 0 : 1 - v.suppression; // crew readiness (buttoned-up under fire)
      const ammo = v.apAmmo + v.heAmmo;
      const ammoMax = def.apAmmo + def.heAmmo;
      card.count.textContent = ko ? "wreck" : `AP ${v.apAmmo}·HE ${v.heAmmo}`;
      card.strFill.style.width = `${crewFrac * 100}%`;
      card.strFill.style.background = crewFrac > 0.6 ? "#8fbf6f" : crewFrac > 0.3 ? "#e0a23a" : "#e0533a";
      card.moraleFill.style.width = `${Math.round(ready * 100)}%`;
      card.moraleFill.style.background = ready > 0.55 ? "#8fbf6f" : ready > 0.3 ? "#e0a23a" : "#e0533a";
      card.ammoFill.style.width = `${ammoMax ? Math.round((ammo / ammoMax) * 100) : 0}%`;
      card.ammoFill.style.background = "#c7a23f";
      card.el.classList.toggle("sel", world.selectedVehicleId === v.id);
      card.el.classList.toggle("dead", ko);
    }
  };
  buildRoster();
  refreshRoster();

  // Dev-only handle for debugging from the console / preview tools.
  (window as { __game?: unknown }).__game = { world, renderer };

  // --- Multiplayer host wiring -----------------------------------------------------
  // Apply orders relayed from the German commander, and toggle the Axis AI off while
  // a human is in command.
  onAxisOrderHost = (o) => applyAxisOrder(world, o);
  onGermanPresentHost = (present) => { world.axisHuman = present; };
  let setupSent = false;
  let netAccum = 0;

  let lastRenderTs = performance.now();
  let prevObjOwner = world.objOwner;
  const loop = new GameLoop(
    () => step(world),
    (alpha) => {
      const now = performance.now();
      const dtSec = (now - lastRenderTs) / 1000;
      input.update(now - lastRenderTs);
      lastRenderTs = now;
      renderer.render(world, alpha);
      // Host: publish the map once, then broadcast entity snapshots at ~8 Hz.
      if (net.role === "host") {
        if (!setupSent) { net.sendSetup(encodeSetup(world)); setupSent = true; }
        netAccum += dtSec;
        if (netAccum >= 0.12) { net.sendSnapshot(encodeSnapshot(world)); netAccum = 0; }
      }
      // Distant battlefield ambience while the fighting is live.
      sound.updateAmbient(dtSec, world.phase === "battle" && !world.outcome && !loop.paused);
      if (world.objOwner !== prevObjOwner) {
        sound.playUI(world.objOwner === "us" ? "obj_capture" : "obj_lost");
        prevObjOwner = world.objOwner;
      }
      if (world.phase === "deploy") {
        clockEl.textContent = "DEPLOY";
        clockEl.style.color = "#7fa8e8";
      } else {
        const left = Math.max(0, BATTLE_TIME_S - world.time);
        const m = Math.floor(left / 60);
        const s = Math.floor(left % 60);
        clockEl.textContent = `⏱ ${m}:${s.toString().padStart(2, "0")}`;
        clockEl.style.color = left < 60 ? "#e0796f" : "";
      }
      refreshStatus();
      updateOrdersBar();
      refreshRoster();
    },
  );
  loop.start();

  // --- HUD wiring ---
  const pauseBtn = document.getElementById("pauseBtn") as HTMLButtonElement;
  const speedBtn = document.getElementById("speedBtn") as HTMLButtonElement;
  const speedPill = document.getElementById("speedPill")!;
  let speedIdx = 0;

  const setPaused = (p: boolean) => {
    loop.paused = p;
    pauseBtn.textContent = p ? "▶ Resume" : "⏸ Pause";
    sound.setMuted(p); // silence loops/ambience while frozen
  };
  pauseBtn.addEventListener("click", () => setPaused(!loop.paused));
  speedBtn.addEventListener("click", () => {
    speedIdx = (speedIdx + 1) % SPEED_STEPS.length;
    loop.speed = SPEED_STEPS[speedIdx];
    speedPill.textContent = `${loop.speed}×`;
  });
  const ORDER_KEYS: Record<string, string> = {
    q: "move", w: "fast", e: "sneak", r: "defend", t: "ambush", f: "fire", g: "smoke",
  };
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space") {
      e.preventDefault();
      setPaused(!loop.paused);
      return;
    }
    if (e.key.toLowerCase() === "o") { renderer.centerOnObjective(world); return; }
    const order = ORDER_KEYS[e.key.toLowerCase()];
    if (order && (world.selectedTeamId != null || world.selectedVehicleId != null)) pickOrder(order);
  });

  document.title = `DasBlut — ${world.mapName}`;
}

// Host-side: apply an order relayed from the German commander to an Axis team.
function applyAxisOrder(world: World, o: AxisOrder): void {
  const team = world.team(o.teamId);
  if (!team || team.faction !== "axis") return;
  if (o.kind === "defend" || o.kind === "ambush") world.orderPosture(o.teamId, o.kind);
  else if (o.kind === "fire" && o.cell) world.orderAreaFire(o.teamId, o.cell);
  else if (o.cell) world.orderMove(o.teamId, o.cell, o.kind === "fast" ? "fast" : "move");
}

// German / spectator view: render the host's snapshots; the German player can select
// and command Axis squads, which are relayed to the host. No local simulation runs.
async function startClientView(setup: Setup): Promise<void> {
  const mount = document.getElementById("app")!;
  const world = buildClientWorld(setup);
  const renderer = new Renderer();
  await renderer.init(mount, world);
  renderer.revealAll = true; // clients see the whole field (host owns the fog)

  onSnapshotClient = (snap) => applySnapshot(world, snap);
  (window as { __game?: unknown }).__game = { world, renderer };

  // Hide the host-only HUD; show a role banner + objective.
  for (const id of ["deployBar", "orders", "roster"]) {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  }
  const statusEl = document.getElementById("status")!;
  const isGerman = () => net.role === "german";
  const setBanner = () => {
    statusEl.innerHTML = isGerman()
      ? `<div class="name">COMMANDING · AXIS</div><div class="dim">click a squad, then click the map to move · F = fire</div>`
      : `<div class="name">SPECTATING</div><div class="dim">watching the battle</div>`;
  };
  setBanner();

  // Pointer: right/middle drag pans, wheel zooms; left-click commands (German only).
  const canvas = renderer.app.canvas;
  let dragBtn: number | null = null, lx = 0, ly = 0;
  let selTeam: number | null = null;
  let armed: "move" | "fire" = "move";
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    renderer.setZoom(renderer.zoom * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top, world);
  }, { passive: false });
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button === 2 || e.button === 1) { dragBtn = e.button; lx = e.clientX; ly = e.clientY; return; }
    if (e.button === 0 && isGerman()) {
      const r = canvas.getBoundingClientRect();
      const { x, y } = renderer.screenToWorld(e.clientX - r.left, e.clientY - r.top);
      const tid = nearestAxisTeam(world, x, y, 1.6);
      if (tid != null) { selTeam = tid; armed = "move"; }
      else if (selTeam != null) {
        net.sendAxisOrder({ kind: armed, teamId: selTeam, cell: { cx: Math.floor(x), cy: Math.floor(y) } });
      }
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (dragBtn == null) return;
    const dx = e.clientX - lx, dy = e.clientY - ly; lx = e.clientX; ly = e.clientY;
    renderer.panBy(-dx, -dy, world);
  });
  canvas.addEventListener("pointerup", (e) => { if (e.button === dragBtn) dragBtn = null; });
  window.addEventListener("keydown", (e) => {
    if (!isGerman()) return;
    const k = e.key.toLowerCase();
    if (k === "f") armed = "fire";
    else if (k === "q" || k === "m") armed = "move";
  });

  const bannerEl = document.getElementById("banner")!;
  const bannerBig = document.getElementById("bannerBig")!;
  const bannerSub = document.getElementById("bannerSub")!;
  const tick = () => {
    setBanner();
    renderer.render(world, 1);
    if (world.outcome) {
      bannerEl.style.display = "block";
      // From the German player's seat the win/lose meaning is inverted.
      const axisWon = world.outcome === "lose";
      bannerBig.textContent = axisWon ? "ATTACK REPULSED" : "OBJECTIVE LOST";
      bannerSub.textContent = axisWon ? "The line held." : "The Americans took the objective.";
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  document.title = `DasBlut — ${world.mapName}`;
}

function nearestAxisTeam(world: World, x: number, y: number, radius: number): number | null {
  let best: number | null = null;
  let bestD = radius * radius;
  for (const s of world.soldiers) {
    if (s.faction !== "axis" || s.status !== "active") continue;
    const d = (s.x - x) ** 2 + (s.y - y) ** 2;
    if (d < bestD) { bestD = d; best = s.teamId; }
  }
  return best;
}
