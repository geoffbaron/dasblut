import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { BATTLEFIELD_H_M, BATTLEFIELD_W_M } from "../game/constants.ts";
import { GameMap } from "../game/gamemap.ts";
import { generateMap } from "../game/osm.ts";
import { buildTestMap } from "../game/testmap.ts";

// The deploy menu: a slippy map you frame your battlefield on, a place search, and
// the two entry points (deploy a real location, or play the tuned test map). On
// deploy it fetches OSM and hands the generated GameMap to `onStart`.
import type { GameSetup } from "../game/world.ts";

export interface MenuHandle {
  /** Hide the menu and tear down its Leaflet map — for a caller that needs to take over
   *  the screen without the user submitting the deploy form (e.g. joining someone else's
   *  live battle instead of starting a local one). */
  dispose(): void;
}

export function runMenu(onStart: (map: GameMap, objectiveCount: number, setup: GameSetup) => void): MenuHandle {
  const menu = document.getElementById("menu")!;
  const loading = document.getElementById("loading")!;
  const loadingMsg = document.getElementById("loadingMsg")!;
  const reticle = document.getElementById("reticleBox") as HTMLElement;
  const objCount = () => parseInt((document.getElementById("objCount") as HTMLSelectElement)?.value || "1", 10);
  const tanks = (id: string) => parseInt((document.getElementById(id) as HTMLSelectElement)?.value || "1", 10);
  // The mode dropdown encodes both who the human plays and each side's role.
  const setup = (): GameSetup => {
    const mode = (document.getElementById("gameMode") as HTMLSelectElement)?.value || "us-attacks";
    const eraVal = (document.getElementById("era") as HTMLSelectElement)?.value;
    const era = (eraVal === "acw" || eraVal === "medieval" ? eraVal : "ww2") as GameSetup["era"];
    const usTanks = tanks("usTanks"), axisTanks = tanks("axisTanks");
    const fortify = (document.getElementById("cover") as HTMLSelectElement)?.value === "1";
    const objectiveHoldS = parseInt((document.getElementById("holdTime") as HTMLSelectElement)?.value || "180", 10);
    const snow = (document.getElementById("terrain") as HTMLSelectElement)?.value === "1";
    switch (mode) {
      case "us-attacks":   return { era, player: "us",   usRole: "attack", axisRole: "defend", usTanks, axisTanks, fortify, objectiveHoldS, snow };
      // Play the defender while the AI attacks — e.g. commanding the Union line at
      // Gettysburg while the Confederates make the charge.
      case "us-defends":   return { era, player: "us",   usRole: "defend", axisRole: "attack", usTanks, axisTanks, fortify, objectiveHoldS, snow };
      case "axis-defends": return { era, player: "axis", usRole: "attack", axisRole: "defend", usTanks, axisTanks, fortify, objectiveHoldS, snow };
      case "meeting-axis": return { era, player: "axis", usRole: "attack", axisRole: "attack", usTanks, axisTanks, fortify, objectiveHoldS, snow };
      case "meeting-us":   return { era, player: "us",   usRole: "attack", axisRole: "attack", usTanks, axisTanks, fortify, objectiveHoldS, snow };
      default:             return { era, player: "axis", usRole: "defend", axisRole: "attack", usTanks, axisTanks, fortify, objectiveHoldS, snow }; // "axis-attacks"
    }
  };

  // Relabel the mode/support dropdowns to match the chosen era (Union/Confederate &
  // guns in the Civil War, US/Axis & tanks in WW2). Option values are unchanged.
  const relabel = () => {
    const era = (document.getElementById("era") as HTMLSelectElement)?.value;
    const blue = era === "medieval" ? "Aldmere" : era === "acw" ? "Union" : "US";
    const red = era === "medieval" ? "Corvath" : era === "acw" ? "Confederate" : "Axis";
    const noun = era === "medieval" ? "siege engine" : era === "acw" ? "gun" : "tank";
    const unit = (n: number) => `${n} ${noun}${n > 1 ? "s" : ""}`;
    const opt = (sel: string, vals: Record<string, string>) => {
      const el = document.getElementById(sel) as HTMLSelectElement | null;
      if (el) for (const o of Array.from(el.options)) if (vals[o.value]) o.textContent = vals[o.value];
    };
    opt("gameMode", {
      "axis-attacks": `${red} attacks · ${blue} defends`,
      "us-attacks": `${blue} attacks · ${red} defends`,
      "us-defends": `${red} attacks · ${blue} defends (play ${blue})`,
      "axis-defends": `${blue} attacks · ${red} defends (play ${red})`,
      "meeting-axis": `Meeting — both attack (play ${red})`,
      "meeting-us": `Meeting — both attack (play ${blue})`,
    });
    opt("usTanks", { "1": `${blue}: ${unit(1)}`, "2": `${blue}: ${unit(2)}`, "3": `${blue}: ${unit(3)}` });
    opt("axisTanks", { "1": `${red}: ${unit(1)}`, "2": `${red}: ${unit(2)}`, "3": `${red}: ${unit(3)}` });
    const coverOn = era === "medieval" ? "+ earthworks & palisades"
      : era === "acw" ? "+ ditches & fences"
      : "+ hedgerows, trenches & bunkers";
    opt("cover", { "0": "No field cover", "1": coverOn });
  };
  document.getElementById("era")?.addEventListener("change", relabel);
  relabel();

  // fadeAnimation off: the tile fade runs on rAF, so in a backgrounded tab it freezes
  // mid-fade and the map sits half-washed-out; instant tiles are also snappier anyway.
  const map = L.map("map", { zoomControl: true, attributionControl: false, fadeAnimation: false }).setView([49.3033, -1.2456], 16); // Carentan
  // Basemap tiles just for framing your battlefield. We use CARTO's OSM-based Voyager
  // tiles rather than tile.openstreetmap.org directly: the OSM tile CDN blocks/rate-limits
  // app usage (which left the framing map blank in production), whereas CARTO's basemaps
  // are a CORS-enabled, app-friendly CDN. (The actual battlefield data comes from Overpass.)
  L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    subdomains: "abcd",
    maxZoom: 20,
  }).addTo(map);

  // Size the reticle box to the real 280 × 220 m capture footprint at the current view.
  const sizeReticle = () => {
    const c = map.getCenter();
    const mPerDegLon = 111320 * Math.cos((c.lat * Math.PI) / 180);
    const halfLon = BATTLEFIELD_W_M / 2 / mPerDegLon;
    const halfLat = BATTLEFIELD_H_M / 2 / 111320;
    const a = map.latLngToContainerPoint([c.lat + halfLat, c.lng - halfLon]);
    const b = map.latLngToContainerPoint([c.lat - halfLat, c.lng + halfLon]);
    reticle.style.width = Math.abs(b.x - a.x) + "px";
    reticle.style.height = Math.abs(b.y - a.y) + "px";
  };
  map.on("move zoom resize", sizeReticle);
  // Re-measure whenever the map pane's size actually settles/changes — a one-shot
  // setTimeout(0) raced the flex layout (Leaflet kept a stale size and only drew tiles
  // in a small offset square of the pane).
  const mapEl = document.getElementById("map")!;
  const remeasure = () => {
    map.invalidateSize();
    sizeReticle();
  };
  setTimeout(remeasure, 0);
  // A second pass after the flex layout (fonts, scrollbars) has fully settled — the
  // frame-0 pass can still catch Leaflet mid-layout and leave a stale tile origin.
  setTimeout(remeasure, 300);
  new ResizeObserver(remeasure).observe(mapEl);

  const deploy = async (lat: number, lon: number, label: string) => {
    loading.style.display = "flex";
    loadingMsg.textContent = `Reconnoitering ${label}…`;
    try {
      const gm = await generateMap(lat, lon, label, setup().era);
      menu.style.display = "none";
      loading.style.display = "none";
      map.remove();
      onStart(gm, objCount(), setup());
    } catch (err) {
      loadingMsg.textContent = `Couldn't reach the map service. ${err instanceof Error ? err.message : ""}\nTry again, or use the test map.`;
      setTimeout(() => (loading.style.display = "none"), 2600);
    }
  };

  document.getElementById("deployBtn")!.addEventListener("click", () => {
    const c = map.getCenter();
    deploy(c.lat, c.lng, labelFor(c.lat, c.lng));
  });

  // Pre-created historic battles: each drops you onto the real ground (via OSM) with the
  // era, sides and force mix of that engagement already set. Selecting one configures the
  // dropdowns (so you can tweak before/after) and deploys straight there.
  const setSel = (id: string, v: string) => {
    const el = document.getElementById(id) as HTMLSelectElement | null;
    if (el) el.value = v;
  };
  const applyScenario = (s: Scenario) => {
    setSel("era", s.era);
    setSel("gameMode", s.mode);
    setSel("objCount", String(s.obj));
    setSel("usTanks", String(s.us));
    setSel("axisTanks", String(s.axis));
    setSel("cover", s.fortify ? "1" : "0");
    setSel("terrain", s.snow ? "1" : "0");
    relabel();
    map.setView([s.lat, s.lon], 16);
    deploy(s.lat, s.lon, s.name);
  };
  const scenSel = document.getElementById("scenario") as HTMLSelectElement | null;
  if (scenSel) {
    SCENARIOS.forEach((s, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = `${s.name} — ${s.blurb}`;
      scenSel.appendChild(opt);
    });
    scenSel.addEventListener("change", () => {
      const s = SCENARIOS[Number(scenSel.value)];
      if (s) applyScenario(s);
      scenSel.value = ""; // snap back to the placeholder so it can be re-picked
    });
  }

  document.getElementById("testBtn")!.addEventListener("click", () => {
    menu.style.display = "none";
    map.remove();
    onStart(buildTestMap(), objCount(), setup());
  });

  // Geocoding search via OSM Nominatim.
  const search = document.getElementById("search") as HTMLInputElement;
  const doSearch = async () => {
    const q = search.value.trim();
    if (!q) return;
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`,
        { headers: { Accept: "application/json" } },
      );
      const hits = (await res.json()) as { lat: string; lon: string }[];
      if (hits.length) map.setView([parseFloat(hits[0].lat), parseFloat(hits[0].lon)], 16);
    } catch {
      /* ignore — user can pan manually */
    }
  };
  document.getElementById("searchBtn")!.addEventListener("click", doSearch);
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSearch();
  });

  return {
    dispose: () => {
      menu.style.display = "none";
      map.remove();
    },
  };
}

function labelFor(lat: number, lon: number): string {
  return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

// A pre-created battle: real coordinates plus the era, sides and force mix of the fight.
// `mode` uses the same values as the #gameMode dropdown (the human plays the attacker in
// axis-attacks / us-attacks). `us`/`axis` are the 1–3 support counts (tanks / guns / siege
// engines, per era).
interface Scenario {
  name: string;
  blurb: string;
  lat: number;
  lon: number;
  era: "ww2" | "acw" | "medieval";
  mode: string;
  obj: number;
  us: number;
  axis: number;
  fortify?: boolean; // prepared positions (foxholes, walls, earthworks) for this fight
  snow?: boolean; // winter dress
}

const SCENARIOS: Scenario[] = [
  {
    name: "Brécourt Manor",
    blurb: "Normandy 1944 · Easy Co. takes the guns",
    lat: 49.3897, lon: -1.2431, era: "ww2", mode: "us-attacks", obj: 1, us: 1, axis: 1,
  },
  {
    name: "Carentan",
    blurb: "Normandy 1944 · storming the crossroads",
    lat: 49.3033, lon: -1.2456, era: "ww2", mode: "us-attacks", obj: 2, us: 2, axis: 1,
  },
  // The Ardennes, Dec 1944: the 101st held Bastogne through the coldest winter in
  // memory, snow on the ground the whole siege — the defining image of the Bulge. You
  // command the American defenders (the Germans still historically attack); "us-defends"
  // keeps that attack direction but hands the player the Allied side being attacked.
  {
    name: "Bastogne",
    blurb: "Ardennes 1944 · hold against the panzers in the snow",
    lat: 50.0000, lon: 5.7220, era: "ww2", mode: "us-defends", obj: 1, us: 1, axis: 3, fortify: true, snow: true,
  },
  // Pickett's Charge, July 3 1863: Confederate infantry cross ~3/4 mile of open farmland,
  // climbing roadside post-and-rail fences under fire, to storm the stone wall at The
  // Angle on Cemetery Ridge. You command the Union line holding the wall; Union guns
  // fire canister to the last, and the charging division brought almost no artillery
  // forward — hence 3 Union batteries to 1 Confederate.
  {
    name: "Gettysburg",
    blurb: "1863 · Hold The Angle against Pickett's Charge",
    lat: 39.8128, lon: -77.2360, era: "acw", mode: "us-defends", obj: 1, us: 3, axis: 1, fortify: true,
  },
  {
    name: "Château Gaillard",
    blurb: "Normandy 1204 · storming the castle",
    lat: 49.2375, lon: 1.4040, era: "medieval", mode: "axis-attacks", obj: 1, us: 1, axis: 3, fortify: true,
  },
];
