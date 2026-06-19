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

// Armed map-click order: which movement/fire order a left-click issues.
type ArmedOrder = "move" | "fast" | "sneak" | "fire";

// Show the deploy menu first; once a battlefield is chosen, start the battle.
runMenu(startGame);

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
    for (const b of orderBtns) {
      const order = b.dataset.order!;
      b.style.display = deployPhase && (order === "fire" || order === "fast" || order === "ambush" || order === "defend") ? "none" : "";
      b.classList.toggle("armed", order === armed);
    }
  };

  // A left-click on the ground issues the currently armed order to all selected teams.
  const handleOrder = (x: number, y: number) => {
    const cell = { cx: Math.floor(x), cy: Math.floor(y) };

    // During deployment, US squads can only move within their southern zone.
    if (world.phase === "deploy" && cell.cy < world.deployY0Us) return;

    if (world.selectedVehicleId != null) {
      const vid = world.selectedVehicleId;
      if (armed === "fire") world.orderVehicleFire(vid, x, y);
      else world.orderVehicleMove(vid, cell, armed === "fast");
      refreshStatus();
      return;
    }

    const teamIds = [...world.selectedTeamIds];
    if (teamIds.length === 0) return;

    if (armed === "fire") {
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
      teamIds.forEach((tid, i) => {
        const col = Math.round(i - (n - 1) / 2); // -1, 0, 1 for n=3 etc.
        world.orderMove(tid, { cx: cell.cx + col * 4, cy: cell.cy }, armed as Stance);
      });
    }
    sound.playUI("ui_order");
    refreshStatus();
  };

  // Clicking an order button: Defend/Ambush apply in place; the rest arm a map click.
  const pickOrder = (order: string) => {
    if (world.selectedVehicleId != null) {
      if (order === "defend" || order === "ambush") world.orderVehiclePosture(world.selectedVehicleId);
      else armed = (order === "sneak" ? "move" : order) as ArmedOrder;
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

  let lastRenderTs = performance.now();
  let prevObjOwner = world.objOwner;
  const loop = new GameLoop(
    () => step(world),
    (alpha) => {
      const now = performance.now();
      input.update(now - lastRenderTs);
      lastRenderTs = now;
      renderer.render(world, alpha);
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
  };
  pauseBtn.addEventListener("click", () => setPaused(!loop.paused));
  speedBtn.addEventListener("click", () => {
    speedIdx = (speedIdx + 1) % SPEED_STEPS.length;
    loop.speed = SPEED_STEPS[speedIdx];
    speedPill.textContent = `${loop.speed}×`;
  });
  const ORDER_KEYS: Record<string, string> = {
    q: "move", w: "fast", e: "sneak", r: "defend", t: "ambush", f: "fire",
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
