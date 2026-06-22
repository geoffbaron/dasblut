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
    const mode = (document.getElementById("gameMode") as HTMLSelectElement)?.value || "axis-attacks";
    const usTanks = tanks("usTanks"), axisTanks = tanks("axisTanks");
    switch (mode) {
      case "us-attacks":   return { player: "us",   usRole: "attack", axisRole: "defend", usTanks, axisTanks };
      case "meeting-axis": return { player: "axis", usRole: "attack", axisRole: "attack", usTanks, axisTanks };
      case "meeting-us":   return { player: "us",   usRole: "attack", axisRole: "attack", usTanks, axisTanks };
      default:             return { player: "axis", usRole: "defend", axisRole: "attack", usTanks, axisTanks };
    }
  };

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
