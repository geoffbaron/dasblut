# DasBlut

Browser-based **Close Combat**-style WW2 small-unit tactics, with the goal of turning
**any real-world location** into a playable, cover-rich battlefield. See [PLAN.md](PLAN.md)
for the full design and phasing.

## Status: Phases 0–6 — play anywhere, with an objective ✅

**Phase 6 — objective, battle clock & enemy AI**
- Every map has a **victory location** (town centre / hamlet crossroads), held by the
  defender at start
- A side **captures** it by being the only one with units in the zone for a few seconds;
  the attacker **wins by holding it** for ~35 s — or by owning it when the clock runs out
- A **6-minute battle clock** (HUD countdown): if it expires while the defender holds, the
  **attack is repulsed** (elimination still ends the battle too)
- **Objective-aware Axis AI** — the enemy marches to garrison the flag at the start, digs
  in (Defend), and **counterattacks toward the objective** the instant the US takes it
  (infantry and armour)
- Rendered as a flag + capture zone with a progress ring (capture, or green hold-to-win),
  plus an OBJECTIVE panel in the HUD (Axis holds / capturing % / contested / HOLD n/35 s)
- The generated battlefield is bigger — **~380 × 300 m (190 × 150 cells)** — with a third
  US squad and a fourth Axis squad

**Phase 5 — real-world maps (the headline feature)**
- A **deploy menu** with a slippy map (Leaflet + OpenStreetMap) and place search — frame
  any ~380 × 300 m spot on Earth
- On deploy, fetches **OpenStreetMap via the Overpass API** and rasterizes it into the
  terrain grid: building footprints → walls + cover-bearing interiors (with doorways),
  roads → fast lanes, woods/water/hedges → cover and obstacles
- Buildings render from their real polygon footprints (with cast shadows); the painter
  keeps pitched roofs for rectangular footprints
- Forces and tanks are auto-placed at opposite edges on passable ground
- Falls back to scattered cover on empty countryside, and to the tuned test map on error
- Verified live: real Carentan generated a 140 × 110 urban battlefield (176 buildings) with
  navigable streets



A two-sided WW2 skirmish: an attacking US force assaults an Axis garrison dug into a
hamlet, with real line-of-sight, fog of war, ballistic combat, and the Close Combat
psychology model.

**Phase 0 — engine**
- **TypeScript + Vite + PixiJS** (WebGL, top-down 2D)
- **Fixed-timestep simulation** (30 Hz) decoupled from rendering, with interpolation —
  deterministic and pause/speed-control friendly
- **Terrain grid** with per-cell move cost, cover, concealment, and sight-blocking
- **A\*** pathfinding (8-way, terrain-weighted, no corner-cutting)

**Graphics** — procedurally *painted* battlefield (no external art): noise-mottled
ground with irregular edges, tree canopies with shadows, pitched-roof buildings with
cast shadows, dirt roads, bocage. Soldiers are sprites with helmet/rifle/shadow that
face their direction of travel.

**Phase 1 — line of sight & fog of war**
- Bresenham LOS over the terrain (buildings/woods/hedges block; a window rule lets a
  man see and fire out of his own building)
- Per-faction **shared spotting** with concealment, movement and muzzle-flash modifiers,
  plus hysteresis; enemies are invisible until spotted
- A **fog shroud** dims everything outside your soldiers' current line of sight

**Phase 2 — combat & morale (the heart)**
- **Weapons/ballistics** (rifle / SMG / LMG) with range falloff, rate of fire, ammo;
  hit chance shaped by cover, concealment, movement, and the shooter's own state
- **Suppression** — most fire pins rather than kills; volume of fire matters
- **Morale state machine:** steady → shaken → pinned → panicked → routing, driven by
  incoming fire, casualties witnessed, leader proximity, veterancy, and recovery in cover
- **Order disobedience:** pinned men hold, panicked men cower, routing men flee — exactly
  as in Close Combat
- Casualties (killed/wounded) become bodies; muzzle flashes, tracers, and hit puffs;
  win/lose when one side is eliminated

**Phase 3 — orders**
- **Stances:** Move (balanced), Fast (quick but loud and can't fire on the move), Sneak
  (slow, hard to spot, holds fire), Defend (hold & fire, steadier), Ambush (hold fire
  until an enemy is close, then a bonus opening volley)
- **Fire orders:** focus-fire a spotted enemy, or **area-fire** to suppress a window,
  treeline, or suspected position you can't see clearly
- Stances feed every system — movement speed, how easily you're spotted, when men fire,
  and morale steadiness
- **Orders bar** with hotkeys (Q/W/E/R/T/F); armed order highlighted; target/aimpoint
  reticles drawn on the map

**Phase 4 — vehicles & armor**
- **Tanks** (M4 Sherman vs Panzer IV): hull + independently-traversing turret, drawn
  top-down with tracks and gun
- **Directional armor** (front/side/rear) and a **penetration model** with range falloff —
  a frontal shot often bounces; a flank or rear shot brews the tank up
- Tanks devastate infantry with **HE** (area casualties) and a **machine gun**; they fight
  each other with **AP**
- **Infantry anti-tank** — a bazooka/Panzerfaust man per squad can kill armor, especially
  from the side or rear (so tanks need an infantry screen)
- Knocked-out tanks become **burning wrecks** with smoke; losing one shocks nearby infantry
- Tanks integrate with spotting (they see and are seen), and take **Move/Fast/Defend/Fire**
  orders; select one for a crew/ammo/status readout

HUD: pause (Space), speed (1/2/4×), force tracker, per-squad stance + morale/state readout
with color-coded state pips above each soldier; vehicle crew/ammo/status when one is selected.

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # typecheck + production build
```

## Controls

- **Click a squad** to select it · **click ground** to move there
- **Right-click** to deselect
- **Space** pause/resume · **Speed** button cycles 1×/2×/4×
- **WASD / arrow keys** pan the camera

## Layout

```
src/
  game/
    constants.ts    tunables (sim, scale, vision, morale)
    terrain.ts      terrain types + cover/concealment/sight table
    grid.ts         the cell grid + authoring helpers
    testmap.ts      hand-painted hamlet + US/Axis spawns
    pathfinding.ts  A* with a binary min-heap
    gamemap.ts      GameMap/feature/spawn types shared by both map sources
    osm.ts          Overpass fetch + rasterize real-world OSM → GameMap
    los.ts          Bresenham line of sight
    visibility.ts   fog shroud + faction spotting (infantry + vehicles)
    weapons.ts      small-arms + anti-tank weapon definitions
    casualty.ts     shared kill/wound/suppression/shock helpers
    combat.ts       infantry fire resolution (incl. AT vs armor)
    morale.ts       suppression/morale + state machine
    ai.ts           target acquisition + flee/rout behavior
    axisAI.ts       objective-aware enemy command (garrison + counterattack)
    vehicleDefs.ts  tank stats, armor, penetration, faceStruck()
    vehicleCombat.ts penetration + KO outcomes, AP hit chance
    vehicleSim.ts   tank acquire / turret / AP-HE-MG fire / move
    world.ts        ECS-flavored world: soldiers, teams, vehicles, effects
    sim.ts          one fixed sim step (see→acquire→fire→feel→act)
    loop.ts         fixed-timestep accumulator loop
  render/
    paint.ts        procedural battlefield painter
    noise.ts        seeded value noise
    soldierArt.ts   soldier + casualty sprites
    vehicleArt.ts   hull / turret / shadow / wreck sprites
    renderer.ts     Pixi camera, shroud, units, vehicles, effects
    input.ts        pointer selection / orders, keyboard pan
    menu.ts         deploy menu: Leaflet picker + Overpass deploy
  main.ts           wiring + HUD + orders bar
```

## Next (Phase 7+)

Smarter AI still (use cover/flanking, coordinate armour, react to suppression) → smoke &
withdraw orders → multiple victory locations → OSM elevation → operational/campaign layer
(force pools, persistent veterans across linked battles). See [PLAN.md](PLAN.md).
