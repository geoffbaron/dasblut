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

export function runMenu(onStart: (map: GameMap, objectiveCount: number, setup: GameSetup) => void): void {
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
    switch (mode) {
      case "us-attacks":   return { era, player: "us",   usRole: "attack", axisRole: "defend", usTanks, axisTanks };
      case "meeting-axis": return { era, player: "axis", usRole: "attack", axisRole: "attack", usTanks, axisTanks };
      case "meeting-us":   return { era, player: "us",   usRole: "attack", axisRole: "attack", usTanks, axisTanks };
      default:             return { era, player: "axis", usRole: "defend", axisRole: "attack", usTanks, axisTanks };
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
      "meeting-axis": `Meeting — both attack (play ${red})`,
      "meeting-us": `Meeting — both attack (play ${blue})`,
    });
    opt("usTanks", { "1": `${blue}: ${unit(1)}`, "2": `${blue}: ${unit(2)}`, "3": `${blue}: ${unit(3)}` });
    opt("axisTanks", { "1": `${red}: ${unit(1)}`, "2": `${red}: ${unit(2)}`, "3": `${red}: ${unit(3)}` });
  };
  document.getElementById("era")?.addEventListener("change", relabel);
  relabel();

  const map = L.map("map", { zoomControl: true, attributionControl: false }).setView([49.3033, -1.2456], 16); // Carentan
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);

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
  setTimeout(() => {
    map.invalidateSize();
    sizeReticle();
  }, 0);

  const deploy = async (lat: number, lon: number, label: string) => {
    loading.style.display = "flex";
    loadingMsg.textContent = `Reconnoitering ${label}…`;
    try {
      const gm = await generateMap(lat, lon, label);
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
    relabel();
    map.setView([s.lat, s.lon], 16);
    deploy(s.lat, s.lon, s.name);
  };
  const scenBox = document.getElementById("scenarioBtns");
  if (scenBox) {
    for (const s of SCENARIOS) {
      const btn = document.createElement("button");
      btn.className = "scenBtn";
      btn.innerHTML = `<b>${s.name}</b><span>${s.blurb}</span>`;
      btn.title = `${s.name} — ${s.blurb}`;
      btn.addEventListener("click", () => applyScenario(s));
      scenBox.appendChild(btn);
    }
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
  {
    name: "Bastogne",
    blurb: "Ardennes 1944 · panzers hit the 101st",
    lat: 50.0000, lon: 5.7220, era: "ww2", mode: "axis-attacks", obj: 1, us: 1, axis: 3,
  },
  {
    name: "Gettysburg",
    blurb: "1863 · Pickett's charge on the ridge",
    lat: 39.8121, lon: -77.2353, era: "acw", mode: "axis-attacks", obj: 1, us: 3, axis: 3,
  },
  {
    name: "Château Gaillard",
    blurb: "Normandy 1204 · storming the castle",
    lat: 49.2375, lon: 1.4040, era: "medieval", mode: "axis-attacks", obj: 1, us: 1, axis: 3,
  },
];
