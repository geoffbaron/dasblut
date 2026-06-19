# DasBlut — Browser-based "Close Combat" with Real-World Maps

> A real-time, pausable WW2 small-unit tactics game in the browser, in the spirit of
> Atomic Games' **Close Combat** (1996). Core hook: pick **any location on Earth**, and
> the game converts the real map (buildings, roads, woods, terrain) into a playable,
> cover-rich battlefield.

_Last updated: 2026-06-17_

---

## 1. What makes Close Combat *Close Combat* (the design pillars to replicate)

Close Combat is not a "build base, mass units" RTS. Its soul is **men under fire**.
Five pillars, in priority order:

1. **Soldier psychology is the core mechanic, not hit points.** Atomic worked with a
   psychologist (Dr. Steven Silver) to give every soldier an *anxiety/morale index*
   driven by fatigue, experience, casualties nearby, suppression, leadership, and being
   left without orders. Men get **suppressed → pinned → shaken → panicked → routed**,
   can **cower**, **refuse dangerous orders**, and **surrender**. You win by *breaking
   the enemy's will*, not by deleting their HP bars. Get this right and it feels like
   Close Combat; get it wrong and it's just another shooter-from-above.

2. **Terrain & cover are everything.** Every piece of ground has a **cover** value
   (protection from incoming fire) and a **concealment** value (how hard you are to
   spot). Buildings, walls, hedgerows (bocage), woods, foxholes, rubble, craters. Men
   hug cover automatically; moving across open ground gets them killed.

3. **Line of sight & line of fire with fog of war.** You see only what your men can see.
   Buildings and terrain block sight; elevation and dead ground matter. Firing needs a
   clear line of fire.

4. **You command teams, men act semi-autonomously.** You order ~6–15 *teams/squads/
   vehicles*, not individual riflemen. Within a team, soldiers move between cover and
   make local decisions. Orders are *requests* the men may decline if terrified.

5. **Pausable real-time, ballistic combat.** Realistic-ish weapon ranges, rates of fire,
   penetration, ammo, and suppression. Pause to assess and issue orders; unpause to watch
   it unfold.

Supporting systems (later phases): **vehicles with directional armor**, and an
**operational/campaign layer** — a strategic map split into areas, a persistent force
pool (your veterans carry experience and wounds between battles), victory locations, and
supply. Three play modes: single **Battle**, linked **Operation**, full **Campaign**.

Sources studied:
[Close Combat (video game) — Wikipedia](https://en.wikipedia.org/wiki/Close_Combat_(video_game)),
[Close Combat (series) — Wikipedia](https://en.wikipedia.org/wiki/Close_Combat_(series)),
[Close Combat — TV Tropes](https://tvtropes.org/pmwiki/pmwiki.php/VideoGame/CloseCombat),
[Close Combat (1996) — MobyGames](https://www.mobygames.com/game/1964/close-combat/).

---

## 2. The headline feature: any map on Earth → a battlefield

### Data sources
- **OpenStreetMap via the Overpass API** — vector features as GeoJSON
  ([Overpass API wiki](https://wiki.openstreetmap.org/wiki/Overpass_API),
  [overpass turbo](https://overpass-turbo.eu/)). We pull:
  - `building=*` → **structures** (footprint polygons; `building:levels` → floors).
  - `highway=*` → **roads/paths** (fast movement, but exposed).
  - `landuse=forest` / `natural=wood` → **woods** (concealment + light cover, slow).
  - `natural=water`, `waterway=*` → **water** (impassable / slow).
  - `barrier=hedge|wall|fence` → **cover lines** (bocage, garden walls).
  - `landuse=grass|farmland|meadow` → **open ground**.
- **Elevation (DEM)** — OSM lacks good elevation, so pull a heightfield from a terrain
  tile service (AWS/Mapzen Terrain Tiles or Mapbox terrain-RGB) → ridgelines, dead
  ground, overwatch positions.

### Ingestion pipeline (vector world → game substrate)
1. **Pick a battlefield** on a slippy map (MapLibre GL / Leaflet). Constrain to a sane
   bbox (~300–600 m square) so battles stay tactical.
2. **Fetch** OSM (Overpass) + DEM for that bbox.
3. **Project** lat/lon → local meters (local Web-Mercator / equirectangular), so 1 game
   meter ≈ 1 real meter.
4. **Rasterize** vector features into a **terrain grid** (1–2 m cells). Each cell stores:
   `moveCost, cover, concealment, elevation, occupancy, type`.
5. **Keep building outlines as vector wall segments** for precise LOS occlusion (don't
   only rely on the raster).
6. **Fallbacks for sparse data.** Rural OSM is patchy — procedurally fill empty areas
   (scatter woods/fields) and offer a quick **editor** to fix/add cover before battle.

The grid is the single substrate that pathfinding, line-of-sight, and combat all read
from. Building outlines + DEM layer on top for occlusion and elevation.

---

## 3. Technical architecture (all browser, TypeScript)

| Concern | Choice | Why |
|---|---|---|
| Language / build | **TypeScript + Vite** | Fast iteration, types matter for a sim |
| Rendering | **PixiJS (WebGL)**, top-down 2D | Batches thousands of sprites + tilemap at 60 fps; isometric later |
| Sim loop | **Fixed-timestep (~20–30 Hz)**, decoupled from render, pausable + time controls | Deterministic-ish → enables replays/MP later |
| Entities | **ECS** (bitECS or miniplex) | Soldiers, vehicles, projectiles as entities with Position/Morale/Weapon/Vision/Order components |
| Pathfinding | **A\*** on nav grid + **flow fields** for groups; local steering for cover-hugging | Standard, scales with hierarchy if needed |
| Visibility | Raycast vs. building wall segments + shadowcasting; per-faction **fog-of-war grid**; spatial hash for broad-phase | The performance-critical system |
| Map picker | **MapLibre GL / Leaflet** | Familiar "choose your battlefield" UX |
| Map ingestion | Thin **Node backend** proxy that fetches Overpass + DEM, normalizes, **caches by tile**, returns compact battlefield JSON | Protects against Overpass rate limits; MVP can call Overpass directly from the client |
| Persistence | **IndexedDB** (local saves) for MVP; backend later | Campaign/force-pool state |
| Multiplayer | Out of MVP. Later: lockstep-deterministic or server-authoritative | Keep sim deterministic now to keep the door open |

---

## 4. Core systems to build (the engine)

- **Terrain model** — grid of cells with cover/concealment/move-cost/elevation; building
  interiors as occupiable multi-floor positions.
- **Movement** — order types change behavior: **Move** (balanced), **Move Fast/Run**
  (quick, loud, exposed), **Sneak** (slow, low profile, high concealment). Waypoint paths
  you draw. Men auto-route cover-to-cover.
- **Line of sight / fire** — fog of war, spotting rolls based on concealment + movement +
  range; firing requires LOF; elevation & buildings occlude.
- **Combat resolution** — per-weapon range/RoF/accuracy/penetration/ammo; **suppression
  vs. lethality** split (most fire pins, doesn't kill); area fire vs. targeted; grenades,
  smoke.
- **Psychology / morale state machine** — `Fine → Cautious → Nervous → Shaken → Panicked
  → Routed/Berserk`, plus Pinned/Cowering and Surrender. Inputs: incoming fire, casualties
  in view, leader proximity, unit cohesion, fatigue, time without orders. **Output feeds
  back into whether orders are obeyed.** This system needs the most iteration and tuning
  knobs.
- **Order/command UI** — team selection, order palette (Move/Fast/Sneak/Fire/Smoke/
  Defend/**Ambush**/Hide), drag-to-draw paths, target picking, the soldier-status HUD,
  pause/speed controls, fog rendering.
- **Vehicles & armor** (Phase 5) — directional armor (front/side/rear/top), penetration,
  immobilization, crew bail-out, main gun vs. MG, infantry AT (Panzerfaust/bazooka).
- **Operational layer** (Phase 6) — strategic map, requisition/force pool, persistent
  veterans, victory locations, supply.

---

## 5. Phasing (recommended build order)

> **Key recommendation:** build the combat feel on **one hand-authored test map first**,
> *then* bolt on the real-world map pipeline. The map ingestion is the wow factor, but the
> morale/suppression "feel" is the make-or-break — isolate it from the data-quality
> variable while you tune it.

- **Phase 0 — Skeleton.** Vite + Pixi + ECS, fixed-timestep loop, pause, render a hand-made
  grid, select a team, click-to-move with A\*. No combat.
- **Phase 1 — Terrain & sight.** Cover/concealment model, line-of-sight, fog of war on the
  test map.
- **Phase 2 — Combat core (the heart).** Weapons/ballistics, suppression, the morale state
  machine, soldier AI, cover-hugging. Tune until it *feels* like men under fire.
- **Phase 3 — Orders & UI.** Full order palette, path drawing, HUD, pause/speed, a basic
  enemy AI so it's playable end-to-end.
- **Phase 4 — Map ingestion (the hook).** Overpass + DEM pipeline, map picker, rasterizer,
  sparse-data fallbacks, pre-battle editor. **Now you can play anywhere.**
- **Phase 5 — Vehicles & armor.**
- **Phase 6 — Operational/campaign layer + persistence.**
- **Phase 7 — Polish:** audio (soldier chatter, weapon SFX), art pass, smarter AI,
  balancing; later, multiplayer.

A playable vertical slice (one map, one firefight that *feels right*) lands at the end of
Phase 3; the "play anywhere" demo lands at Phase 4.

---

## 6. Known hard parts & risks

- **Morale feel** is the project's whole identity and the easiest thing to get wrong —
  budget heavy iteration and expose tuning constants.
- **LOS performance** with many units + complex building geometry — needs spatial
  partitioning and possibly precomputed visibility.
- **OSM data quality varies wildly** — dense cities are great, rural areas sparse;
  fallback generation + an editor are not optional.
- **Scale & projection** — lock cell size and bbox so battles stay tactical and 1 cell ≈
  real meters.
- **Building-interior pathing** — doorways, floors, garrisoning.
- **Determinism** — keep it now (seeded RNG, fixed timestep) to keep multiplayer/replays
  possible later.

---

## 7. Open questions / next steps

- [ ] Confirm MVP ambition: single skirmish vs. full campaign for v1.
- [ ] Top-down 2D (recommended) vs. isometric look.
- [ ] Client-only Overpass calls vs. cached Node proxy for the map pipeline.
- [ ] Scaffold Phase 0 (Vite + Pixi + ECS + fixed-timestep loop + hand-made test map).
