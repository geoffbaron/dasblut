import { Application, Container, Graphics, Sprite, Texture } from "pixi.js";
import { CELL_SIZE, OBJECTIVE_HOLD_TO_WIN, SMOKE_LOS_BLOCK } from "../game/constants.ts";
import { VEHICLES } from "../game/vehicleDefs.ts";
import { factionColor, MoraleState, World } from "../game/world.ts";
import { Terrain, TERRAIN } from "../game/terrain.ts";
import { WEAPONS } from "../game/weapons.ts";
import { BuildingArt, paintBattlefield } from "./paint.ts";
import { makeCannonBody, makeCasualtyCanvas, makeCavalryBody, makeSoldierArt } from "./soldierArt.ts";
import { makeVehicleArt, VehicleArt } from "./vehicleArt.ts";
import { sound } from "./sound.ts";

// Top-down 2D renderer. Layers (back→front): painted battlefield, fog shroud,
// orders/selection overlay, unit shadows, unit bodies, combat effects. Enemy units
// are only shown while spotted; positions are interpolated for smooth motion.
export class Renderer {
  app = new Application();
  private camera = new Container();
  private damageLayer = new Graphics();
  // Fog rendered as a 1-texel-per-cell sprite upscaled with linear smoothing — soft haze
  // at any map size, unlike a blur-filtered Graphics which overflows the GPU's max
  // texture size on large OSM towns and silently renders nothing.
  private shroud = new Sprite();
  private shroudCanvas!: HTMLCanvasElement;
  private shroudCtx!: CanvasRenderingContext2D;
  private shroudTex!: Texture;
  private overlay = new Graphics();
  private vehicleLayer = new Container();
  private shadowLayer = new Container();
  private floorLayer = new Container();
  private bodyLayer = new Container();
  private roofLayer = new Container();
  private smokeScreen = new Graphics();
  private fx = new Graphics();
  // Screen-space drag-select box drawn on top of everything, outside the camera.
  private selBox = new Graphics();
  private camX = 0;
  private camY = 0;
  zoom = 1.0;
  // Client (German/spectator) views have no fog and show every unit, since the
  // authoritative fog lives on the host. Set true for those views.
  revealAll = false;
  private shroudVersion = -1;
  private damageVersion = -1;

  private shadowTex!: Texture;
  private casualtyTex!: Texture;
  private bodyTexByColor = new Map<string, Texture>();
  private sprites = new Map<number, { shadow: Sprite; body: Sprite; alive: boolean }>();
  private vehSprites = new Map<
    number,
    { shadow: Sprite; hull: Sprite; turret: Sprite; hullTex: Texture; wreckTex: Texture; wrecked: boolean }
  >();
  private vehArtByClass = new Map<string, VehicleArt>();
  // Per-building floor + roof sprites. The roof fades out (and the floor fades in) as a
  // visible unit moves inside, revealing the plan; both reverse when the building empties.
  private buildings: { floor: Sprite; roof: Sprite; alpha: number }[] = [];
  // cell index → building index (+1), built from each building's exact footprint cells so
  // overlapping bounding boxes can't reveal the wrong roof.
  private cellBuilding!: Int16Array;

  async init(mount: HTMLElement, world: World): Promise<void> {
    await this.app.init({
      background: 0x14130f,
      resizeTo: window,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
    });
    mount.appendChild(this.app.canvas);

    const painted = paintBattlefield(world.grid, world.features);
    const bg = new Sprite(Texture.from(painted.canvas));
    bg.scale.set(painted.scale);

    this.buildBuildings(world, painted.buildings);

    // Fog haze: a tiny canvas (one texel per cell) drawn into by drawShroud, scaled up to
    // map size with linear filtering so the cell edges blend into a soft haze.
    this.shroudCanvas = document.createElement("canvas");
    this.shroudCanvas.width = world.grid.width;
    this.shroudCanvas.height = world.grid.height;
    this.shroudCtx = this.shroudCanvas.getContext("2d")!;
    this.shroudTex = Texture.from(this.shroudCanvas);
    this.shroudTex.source.scaleMode = "linear";
    this.shroud.texture = this.shroudTex;
    this.shroud.scale.set(CELL_SIZE);

    // floorLayer sits just above the ground (hidden until revealed); roofLayer sits above
    // the unit bodies so an intact roof hides the men inside. The fog shroud, building
    // damage, and the order overlay (waypoints, objectives, fire lines) sit ABOVE the
    // roofs so fog still hides un-scouted buildings and your planned routes stay visible
    // where they cross rooftops.
    this.camera.addChild(bg, this.floorLayer, this.vehicleLayer, this.shadowLayer, this.bodyLayer, this.roofLayer, this.damageLayer, this.shroud, this.overlay, this.smokeScreen, this.fx);
    // selBox lives outside the camera so it stays in screen space.
    this.app.stage.addChild(this.camera, this.selBox);

    this.shadowTex = Texture.from(makeSoldierArt(0).shadow);
    this.casualtyTex = Texture.from(makeCasualtyCanvas());
    this.buildUnitSprites(world);
    this.buildVehicleSprites(world);
    this.centerOn(world);
  }

  // Lay out a floor + roof sprite per building and index which building owns each cell
  // (from its exact footprint mask), so the per-frame fade reveals exactly the building
  // a unit has actually stepped into — no bounding-box overlap mix-ups.
  private buildBuildings(world: World, arts: BuildingArt[]): void {
    this.cellBuilding = new Int16Array(world.grid.width * world.grid.height); // 0 = none
    this.buildings = arts.map((art, i) => {
      const floor = new Sprite(Texture.from(art.floor.canvas));
      floor.position.set(art.floor.x, art.floor.y);
      floor.scale.set(art.floor.scale);
      floor.alpha = 0;
      this.floorLayer.addChild(floor);
      const roof = new Sprite(Texture.from(art.roof.canvas));
      roof.position.set(art.roof.x, art.roof.y);
      roof.scale.set(art.roof.scale);
      this.roofLayer.addChild(roof);
      for (const idx of art.cells) this.cellBuilding[idx] = i + 1;
      return { floor, roof, alpha: 1 }; // alpha = roof opacity (1 = closed)
    });
  }

  // Fade a building's roof away (and its floor plan in) while a visible unit occupies it,
  // and reverse once it empties. Smoothed so it eases rather than snaps.
  private drawBuildings(world: World): void {
    if (this.buildings.length === 0) return;
    const occupied = new Uint8Array(this.buildings.length);
    for (const s of world.soldiers) {
      if (s.status === "dead") continue;
      if (!(this.revealAll || s.faction === world.player || s.seen)) continue;
      const cx = Math.floor(s.x), cy = Math.floor(s.y);
      if (!world.grid.inBounds(cx, cy)) continue;
      const b = this.cellBuilding[world.grid.idx(cx, cy)];
      if (b > 0) occupied[b - 1] = 1;
    }
    for (let i = 0; i < this.buildings.length; i++) {
      const b = this.buildings[i];
      const target = occupied[i] ? 0 : 1;
      b.alpha += (target - b.alpha) * 0.12;
      b.roof.alpha = b.alpha;
      b.floor.alpha = 1 - b.alpha;
    }
  }

  private buildVehicleSprites(world: World): void {
    for (const v of world.vehicles) this.ensureVehicleSprite(v);
  }

  private ensureVehicleSprite(v: { id: number; cls: string }) {
    let sp = this.vehSprites.get(v.id);
    if (sp) return sp;
    let art = this.vehArtByClass.get(v.cls);
    if (!art) {
      art = makeVehicleArt(VEHICLES[v.cls as keyof typeof VEHICLES]);
      this.vehArtByClass.set(v.cls, art);
    }
    const shadow = new Sprite(Texture.from(art.shadow));
    const hullTex = Texture.from(art.hull);
    const wreckTex = Texture.from(art.wreck);
    const hull = new Sprite(hullTex);
    const turret = new Sprite(Texture.from(art.turret));
    for (const s of [shadow, hull, turret]) {
      s.anchor.set(0.5);
      s.scale.set(art.scale);
    }
    this.vehicleLayer.addChild(shadow, hull, turret);
    sp = { shadow, hull, turret, hullTex, wreckTex, wrecked: false };
    this.vehSprites.set(v.id, sp);
    return sp;
  }

  private buildUnitSprites(world: World): void {
    for (const s of world.soldiers) this.ensureSoldierSprite(world, s);
  }

  // Create a soldier's sprites if they don't exist yet. Built lazily so client views,
  // which receive units via network snapshots after init, get sprites on demand too.
  private ensureSoldierSprite(world: World, s: { id: number; teamId: number; faction: string; weapon: string }) {
    let sp = this.sprites.get(s.id);
    if (sp) return sp;
    const color = world.team(s.teamId)?.color ?? (s.faction === "us" ? 0x4f7fd1 : 0xc4514a);
    const shadow = new Sprite(this.shadowTex);
    shadow.anchor.set(0.5);
    shadow.scale.set(1 / 3);
    const body = new Sprite(this.bodyTexture(color, s.weapon));
    body.anchor.set(0.5);
    body.scale.set(1 / 3);
    this.shadowLayer.addChild(shadow);
    this.bodyLayer.addChild(body);
    sp = { shadow, body, alive: true };
    this.sprites.set(s.id, sp);
    return sp;
  }

  // The kind of sprite a weapon implies: a cannon draws a field gun, a carbine a mounted
  // trooper, everything else a man on foot.
  private artKind(weapon: string): "cannon" | "cavalry" | "soldier" {
    return weapon === "cannon" ? "cannon" : weapon === "carbine" ? "cavalry" : "soldier";
  }

  private bodyTexture(color: number, weapon: string): Texture {
    const kind = this.artKind(weapon);
    const key = `${kind}:${color}`;
    let tex = this.bodyTexByColor.get(key);
    if (!tex) {
      const art = kind === "cannon" ? makeCannonBody(color) : kind === "cavalry" ? makeCavalryBody(color) : makeSoldierArt(color).body;
      tex = Texture.from(art);
      this.bodyTexByColor.set(key, tex);
    }
    return tex;
  }

  private centerOn(world: World): void {
    // Fit the full map into the clear area between the top HUD and the bottom
    // order/deploy bars, so the southernmost squads aren't hidden behind the chrome.
    const availW = this.app.screen.width - HUD_LEFT;
    const availH = this.app.screen.height - HUD_TOP - HUD_BOTTOM;
    const fw = availW / (world.grid.width * CELL_SIZE);
    const fh = availH / (world.grid.height * CELL_SIZE);
    this.zoom = Math.min(fw, fh, 1.0);
    // applyCamera centers the map within the inset region when it's smaller than it.
    this.camX = 0;
    this.camY = 0;
    this.applyCamera(world);
  }

  panBy(dx: number, dy: number, world: World): void {
    this.camX += dx;
    this.camY += dy;
    this.applyCamera(world);
  }

  setZoom(newZoom: number, pivotX: number, pivotY: number, world: World): void {
    // Zoom around the screen pivot point (e.g. mouse position) so that point stays fixed.
    const wpx = (pivotX + this.camX) / this.zoom;
    const wpy = (pivotY + this.camY) / this.zoom;
    this.zoom = Math.max(0.15, Math.min(3.0, newZoom));
    this.camX = wpx * this.zoom - pivotX;
    this.camY = wpy * this.zoom - pivotY;
    this.applyCamera(world);
  }

  private applyCamera(world: World): void {
    const mapW = world.grid.width * CELL_SIZE * this.zoom;
    const mapH = world.grid.height * CELL_SIZE * this.zoom;
    // Keep content within the UI-clear region: left of nothing important on the
    // right, but below the top HUD and above the bottom bars / left of the roster.
    this.camX = clampAxis(this.camX, mapW, HUD_LEFT, this.app.screen.width - HUD_LEFT);
    this.camY = clampAxis(this.camY, mapH, HUD_TOP, this.app.screen.height - HUD_TOP - HUD_BOTTOM);
    this.camera.position.set(-this.camX, -this.camY);
    this.camera.scale.set(this.zoom);
  }

  // Screen coords of the centre of the UI-clear region, used to focus a target
  // without it landing behind the HUD chrome.
  private regionCenter(): { x: number; y: number } {
    return {
      x: HUD_LEFT + (this.app.screen.width - HUD_LEFT) / 2,
      y: HUD_TOP + (this.app.screen.height - HUD_TOP - HUD_BOTTOM) / 2,
    };
  }

  centerOnObjective(world: World): void {
    this.zoom = 1.0;
    const c = this.regionCenter();
    const ctr = world.objectivesCentroid();
    this.camX = ctr.cx * CELL_SIZE - c.x;
    this.camY = ctr.cy * CELL_SIZE - c.y;
    this.applyCamera(world);
  }

  /** Center the view on a vehicle (used by the roster navigator). */
  centerOnVehicle(world: World, vid: number): void {
    const v = world.vehicle(vid);
    if (!v) return;
    const c = this.regionCenter();
    this.camX = v.x * CELL_SIZE * this.zoom - c.x;
    this.camY = v.y * CELL_SIZE * this.zoom - c.y;
    this.applyCamera(world);
  }

  /** Center the view on a team's surviving men (used by the roster navigator). */
  centerOnTeam(world: World, teamId: number): void {
    const team = world.team(teamId);
    if (!team) return;
    let sx = 0, sy = 0, n = 0;
    for (const id of team.soldierIds) {
      const s = world.soldier(id);
      if (!s || s.status !== "active") continue;
      sx += s.x; sy += s.y; n++;
    }
    if (!n) return;
    const c = this.regionCenter();
    this.camX = (sx / n) * CELL_SIZE * this.zoom - c.x;
    this.camY = (sy / n) * CELL_SIZE * this.zoom - c.y;
    this.applyCamera(world);
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx + this.camX) / (CELL_SIZE * this.zoom), y: (sy + this.camY) / (CELL_SIZE * this.zoom) };
  }

  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return { x: wx * CELL_SIZE * this.zoom - this.camX, y: wy * CELL_SIZE * this.zoom - this.camY };
  }

  // Draw a rubber-band selection rectangle in screen space.
  setSelectionBox(x0: number, y0: number, x1: number, y1: number): void {
    const x = Math.min(x0, x1), y = Math.min(y0, y1);
    const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
    this.selBox.clear()
      .rect(x, y, w, h)
      .fill({ color: 0x88ddff, alpha: 0.08 })
      .stroke({ color: 0x88ddff, width: 1.5, alpha: 0.85 });
  }

  clearSelectionBox(): void { this.selBox.clear(); }

  render(world: World, alpha: number): void {
    // Keep the sound manager's spatial reference point at the screen center in world coords.
    sound.cameraX = (this.camX + this.app.screen.width / 2) / (CELL_SIZE * this.zoom);
    sound.cameraY = (this.camY + this.app.screen.height / 2) / (CELL_SIZE * this.zoom);
    sound.tick();
    this.drawDamage(world);
    this.drawShroud(world);
    this.drawOverlay(world);
    this.drawVehicles(world, alpha);
    this.drawSoldiers(world, alpha);
    this.drawBuildings(world);
    this.drawSmoke(world);
    this.drawEffects(world);
  }

  // Persistent mortar-smoke screen, drawn from the smoke density grid each frame so it
  // billows and thins as the grid decays. Overlapping soft discs read as a cloud bank.
  private drawSmoke(world: World): void {
    const g = this.smokeScreen;
    g.clear();
    const { grid } = world;
    const sm = world.smokeGrid;
    for (let cy = 0; cy < grid.height; cy++) {
      for (let cx = 0; cx < grid.width; cx++) {
        const d = sm[grid.idx(cx, cy)];
        if (d < 0.06) continue;
        const a = Math.min(0.72, d * 0.55);
        g.circle((cx + 0.5) * CELL_SIZE, (cy + 0.5) * CELL_SIZE, CELL_SIZE * 0.95)
          .fill({ color: 0xb9b6ad, alpha: a });
      }
    }
  }

  private drawVehicles(world: World, alpha: number): void {
    for (const v of world.vehicles) {
      const sp = this.ensureVehicleSprite(v);
      const shown = this.revealAll || v.faction === world.player || v.seen;
      sp.hull.visible = shown;
      sp.shadow.visible = shown && v.status !== "ko";
      sp.turret.visible = shown && v.status !== "ko";
      if (!shown) continue;

      const ix = (v.px + (v.x - v.px) * alpha) * CELL_SIZE;
      const iy = (v.py + (v.y - v.py) * alpha) * CELL_SIZE;
      if (v.status === "ko" && !sp.wrecked) {
        sp.hull.texture = sp.wreckTex;
        sp.wrecked = true;
      }
      sp.shadow.position.set(ix, iy);
      sp.shadow.rotation = v.facing;
      sp.hull.position.set(ix, iy);
      sp.hull.rotation = v.facing;
      sp.turret.position.set(ix, iy);
      sp.turret.rotation = v.turret;
    }
  }

  // Scorch, cracks and rubble drawn over buildings that have taken HE/grenade hits.
  // Sits above the painted ground but below the fog, so damage reads through the
  // static roof art without a full repaint. Rebuilt only when damage changes.
  private drawDamage(world: World): void {
    if (world.buildDmgVersion === this.damageVersion) return;
    this.damageVersion = world.buildDmgVersion;
    const g = this.damageLayer;
    g.clear();
    const grid = world.grid;
    for (let cy = 0; cy < grid.height; cy++) {
      for (let cx = 0; cx < grid.width; cx++) {
        const i = grid.idx(cx, cy);
        const dmg = world.buildDmg[i];
        if (dmg <= 0) continue;
        const x = cx * CELL_SIZE;
        const y = cy * CELL_SIZE;
        // Deterministic per-cell rng so debris doesn't jitter between redraws.
        let seed = (i * 2654435761) >>> 0;
        const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
        if (grid.get(cx, cy) === Terrain.Rubble) {
          // Collapsed: a dark breach with scattered rubble chunks.
          g.rect(x, y, CELL_SIZE, CELL_SIZE).fill({ color: 0x1a1712, alpha: 0.5 });
          for (let k = 0; k < 6; k++) {
            const px = x + rnd() * CELL_SIZE, py = y + rnd() * CELL_SIZE, s = 1.5 + rnd() * 3;
            g.rect(px + 1, py + 1, s, s).fill({ color: 0x14110d, alpha: 0.6 });
            g.rect(px, py, s, s).fill({ color: 0x6a6258, alpha: 0.85 });
          }
        } else {
          // Standing but battered: scorch plus a little debris.
          g.circle(x + CELL_SIZE / 2, y + CELL_SIZE / 2, CELL_SIZE * 0.5).fill({ color: 0x14110d, alpha: Math.min(0.5, dmg * 0.5) });
          for (let k = 0; k < 3; k++) {
            const px = x + rnd() * CELL_SIZE, py = y + rnd() * CELL_SIZE, s = 1 + rnd() * 2;
            g.rect(px, py, s, s).fill({ color: 0x3a342c, alpha: 0.6 });
          }
        }
      }
    }
  }

  // Rebuild the fog shroud only when visibility actually changed.
  private drawShroud(world: World): void {
    // Client (German/spectator) views have no fog — the host owns visibility.
    if (this.revealAll) { this.shroud.visible = false; return; }
    this.shroud.visible = true;
    if (world.visVersion === this.shroudVersion) return;
    this.shroudVersion = world.visVersion;
    const grid = world.grid;
    const n = grid.width * grid.height;
    const img = this.shroudCtx.createImageData(grid.width, grid.height);
    const d = img.data;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      if (world.visGrid[i] === 0) {
        d[o] = 10; d[o + 1] = 10; d[o + 2] = 16; d[o + 3] = 130; // 0x0a0a10 @ ~0.5
      } else {
        d[o + 3] = 0; // seen — fully clear
      }
    }
    this.shroudCtx.putImageData(img, 0, 0);
    this.shroudTex.source.update();
  }

  private drawOverlay(world: World): void {
    const g = this.overlay;
    g.clear();
    if (world.phase === "deploy") this.drawDeployZones(world);
    this.drawObjective(world);

    // Fire-direction markers for every friendly unit (always on, so you can see
    // what each squad/tank is shooting at without selecting it).
    this.drawFireDirections(world);

    // Selected vehicle: highlight ring + planned route.
    if (world.selectedVehicleId != null) {
      const v = world.vehicle(world.selectedVehicleId);
      if (v && v.status !== "ko") {
        g.circle(v.x * CELL_SIZE, v.y * CELL_SIZE, 18).stroke({ width: 2, color: 0xffe27a, alpha: 0.6 });
        if (v.path) {
          const pts = v.path.slice(v.pathIndex);
          g.moveTo(v.x * CELL_SIZE, v.y * CELL_SIZE);
          for (const p of pts) g.lineTo((p.cx + 0.5) * CELL_SIZE, (p.cy + 0.5) * CELL_SIZE);
          g.stroke({ width: 2, color: 0xf0e0a0, alpha: 0.6 });
        }
      }
    }

    if (world.selectedTeamId == null) return;
    const team = world.team(world.selectedTeamId);
    if (!team) return;

    // A holding squad (Defend/Ambush) shows the ground each man can actually cover —
    // the swept fans overlap into a brighter kill-zone where the squad's fire converges.
    for (const id of team.soldierIds) {
      const s = world.soldier(id);
      if (!s || s.status !== "active") continue;
      const w = WEAPONS[s.weapon];
      if ((s.stance === "defend" || s.stance === "ambush") && !w.indirect && !s.path) {
        this.drawSightFan(world, s.x, s.y, s.facing, w.rangeCells);
      }
    }

    for (const id of team.soldierIds) {
      const s = world.soldier(id);
      if (!s || s.status !== "active") continue;
      g.circle(s.x * CELL_SIZE, s.y * CELL_SIZE, 8).stroke({ width: 1.5, color: 0xffe27a, alpha: 0.55 });
    }

    const lead = world.soldier(team.leaderId) ?? world.soldier(team.soldierIds[0]);
    if (lead?.path) {
      const pts = lead.path.slice(lead.pathIndex);
      if (pts.length) {
        g.moveTo(lead.x * CELL_SIZE, lead.y * CELL_SIZE);
        for (const p of pts) g.lineTo((p.cx + 0.5) * CELL_SIZE, (p.cy + 0.5) * CELL_SIZE);
        g.stroke({ width: 2, color: 0xf0e0a0, alpha: 0.6 });
        const last = pts[pts.length - 1];
        const lx = (last.cx + 0.5) * CELL_SIZE;
        const ly = (last.cy + 0.5) * CELL_SIZE;
        g.circle(lx, ly, 6).stroke({ width: 2, color: 0xf0e0a0, alpha: 0.85 });
      }
    }
  }

  // Draws a thin red line from each firing friendly unit to its aimpoint plus a
  // reticle there, for both squads (focus-fire / area-fire / mortar) and tanks
  // (target lock / ground bombardment). The selected unit's marker is brighter.
  private drawFireDirections(world: World): void {
    const g = this.overlay;
    const sel = world.selectedTeamId;
    const selV = world.selectedVehicleId;

    const marker = (sx: number, sy: number, tx: number, ty: number, bright: boolean) => {
      const a = bright ? 0.9 : 0.5;
      const w = bright ? 1.6 : 1.1;
      g.moveTo(sx * CELL_SIZE, sy * CELL_SIZE).lineTo(tx * CELL_SIZE, ty * CELL_SIZE);
      g.stroke({ width: w, color: 0xff4a3a, alpha: a * 0.55 });
      const fx = tx * CELL_SIZE, fy = ty * CELL_SIZE;
      g.circle(fx, fy, 8).stroke({ width: w, color: 0xff4a3a, alpha: a });
      g.moveTo(fx - 11, fy).lineTo(fx + 11, fy).moveTo(fx, fy - 11).lineTo(fx, fy + 11);
      g.stroke({ width: w, color: 0xff4a3a, alpha: a });
    };

    for (const team of world.teams) {
      if (team.faction !== world.player) continue;
      const lead = world.soldier(team.leaderId) ?? world.soldier(team.soldierIds[0]);
      if (!lead || lead.status !== "active") continue;
      const order = team.soldierIds.map((id) => world.soldier(id)).find((s) => s?.manualTargetId != null || s?.manualVehId != null || s?.fireCell);
      if (!order) continue;
      const bright = team.id === sel;
      if (order.manualVehId != null) {
        const tv = world.vehicle(order.manualVehId);
        if (tv && tv.status !== "ko" && tv.seen) marker(lead.x, lead.y, tv.x, tv.y, bright);
      } else if (order.manualTargetId != null) {
        const t = world.soldier(order.manualTargetId);
        if (t && t.status === "active" && t.seen) marker(lead.x, lead.y, t.x, t.y, bright);
      } else if (order.fireCell) {
        marker(lead.x, lead.y, order.fireCell.cx + 0.5, order.fireCell.cy + 0.5, bright);
      }
    }

    for (const v of world.vehicles) {
      if (v.faction !== world.player || v.status === "ko") continue;
      const bright = v.id === selV;
      const tv = v.manualVeh != null ? world.vehicle(v.manualVeh) : null;
      const ti = v.manualInf != null ? world.soldier(v.manualInf) : null;
      if (tv && tv.status !== "ko" && tv.seen) marker(v.x, v.y, tv.x, tv.y, bright);
      else if (ti && ti.status === "active" && ti.seen) marker(v.x, v.y, ti.x, ti.y, bright);
      else if (v.fireCell) marker(v.x, v.y, v.fireCell.cx + 0.5, v.fireCell.cy + 0.5, bright);
    }
  }

  private drawDeployZones(world: World): void {
    const g = this.overlay;
    const mw = world.grid.width * CELL_SIZE;
    const mh = world.grid.height * CELL_SIZE;
    const northFaction = world.southFaction === "us" ? "axis" : "us";
    const southCol = factionColor(world.era, world.southFaction);
    const northCol = factionColor(world.era, northFaction);

    // South band — the faction deploying along the bottom edge.
    const sY = world.deploySouthY0 * CELL_SIZE;
    g.rect(0, sY, mw, mh - sY).fill({ color: southCol, alpha: 0.14 });
    g.moveTo(0, sY).lineTo(mw, sY).stroke({ width: 3, color: southCol, alpha: 0.7 });

    // North band — the faction deploying along the top edge.
    const nY = world.deployNorthY1 * CELL_SIZE;
    g.rect(0, 0, mw, nY).fill({ color: northCol, alpha: 0.14 });
    g.moveTo(0, nY).lineTo(mw, nY).stroke({ width: 3, color: northCol, alpha: 0.7 });
  }

  private drawObjective(world: World): void {
    const g = this.overlay;
    const holdFrac = Math.min(1, world.objHoldTimer / OBJECTIVE_HOLD_TO_WIN);
    for (const o of world.objectives) {
      const cx = (o.cx + 0.5) * CELL_SIZE;
      const cy = (o.cy + 0.5) * CELL_SIZE;
      const col = o.owner === "neutral" ? 0xbfb38a : factionColor(world.era, o.owner);

      // Capture zone — slightly more opaque so it punches through building rooftops.
      g.circle(cx, cy, o.radius * CELL_SIZE).fill({ color: col, alpha: o.contested ? 0.22 : 0.12 });
      g.circle(cx, cy, o.radius * CELL_SIZE).stroke({ width: 3, color: col, alpha: 0.65 });

      // Progress ring: capture progress while flipping, else the hold-to-win countdown
      // on US-held objectives (green, shared across all of them).
      let frac = 0;
      let arcCol = col;
      if (o.capturing) {
        frac = o.progress;
        arcCol = factionColor(world.era, o.capturing);
      } else if (o.owner === world.player) {
        frac = holdFrac;
        arcCol = 0x6fcf6f;
      }
      if (frac > 0.001) {
        // moveTo the arc's start first: without it PixiJS connects the previous path
        // point to the arc start with a stray line (the "strange line" near the flag).
        const a0 = -Math.PI / 2;
        g.moveTo(cx + Math.cos(a0) * 18, cy + Math.sin(a0) * 18);
        g.arc(cx, cy, 18, a0, a0 + frac * Math.PI * 2).stroke({ width: 4, color: arcCol, alpha: 0.95 });
      }

      // Flag — white halo on the pole so it reads against dark and light backgrounds.
      g.moveTo(cx, cy + 8).lineTo(cx, cy - 26).stroke({ width: 5, color: 0xffffff, alpha: 0.6 });
      g.moveTo(cx, cy + 8).lineTo(cx, cy - 26).stroke({ width: 2, color: 0x14140e, alpha: 0.9 });
      g.poly([cx, cy - 26, cx + 18, cy - 20, cx, cy - 14]).fill({ color: col, alpha: 1 });
      g.poly([cx, cy - 26, cx + 18, cy - 20, cx, cy - 14]).stroke({ width: 1.5, color: 0xffffff, alpha: 0.7 });
    }
  }

  private drawSoldiers(world: World, alpha: number): void {
    for (const s of world.soldiers) {
      const sp = this.ensureSoldierSprite(world, s);

      // Enemies are only drawn while spotted; corpses linger until LOS is lost.
      const shown = this.revealAll || s.faction === world.player || s.seen;
      sp.body.visible = shown;
      sp.shadow.visible = shown && s.status === "active";
      if (!shown) continue;

      const ix = (s.px + (s.x - s.px) * alpha) * CELL_SIZE;
      const iy = (s.py + (s.y - s.py) * alpha) * CELL_SIZE;

      const down = s.status === "dead" || s.status === "wounded" || s.status === "surrendered";
      if (down === sp.alive) {
        // Status changed → swap texture. A knocked-out field gun keeps its own silhouette,
        // just dimmed — it reads as a wrecked, abandoned piece, not a fallen man.
        const col = world.team(s.teamId)?.color ?? (s.faction === "us" ? 0x4f7fd1 : 0xc4514a);
        const isGun = s.weapon === "cannon";
        sp.body.texture = down && !isGun ? this.casualtyTex : this.bodyTexture(col, s.weapon);
        sp.body.alpha = down ? (isGun ? 0.4 : s.status === "dead" ? 0.85 : 0.95) : 1;
        sp.alive = !down;
      }
      sp.body.position.set(ix, iy);
      sp.body.rotation = s.facing;
      sp.shadow.position.set(ix + 1, iy + 1.5);
    }
  }

  private drawEffects(world: World): void {
    const g = this.fx;
    g.clear();

    // Tracers, muzzle flashes, hit puffs, AP rounds, sparks, fire, smoke.
    for (const e of world.effects) {
      if (e.kind === "tracer") {
        // A glowing round in flight: a hot core over a softer outer streak so it reads at
        // a glance and lingers a beat, making a stream of fire easy to follow to its source.
        const a = Math.min(1, e.ttl / 0.08);
        g.moveTo(e.x0 * CELL_SIZE, e.y0 * CELL_SIZE).lineTo(e.x1 * CELL_SIZE, e.y1 * CELL_SIZE);
        g.stroke({ width: 3.0, color: 0xffbe3a, alpha: a * 0.4 });
        g.moveTo(e.x0 * CELL_SIZE, e.y0 * CELL_SIZE).lineTo(e.x1 * CELL_SIZE, e.y1 * CELL_SIZE);
        g.stroke({ width: 1.5, color: 0xfff2b0, alpha: a * 0.95 });
      } else if (e.kind === "shotline") {
        // Black-powder discharge — no tracer glow, just a quick pale flash-lit streak from
        // muzzle to aimpoint so a firing musket line is still readable through its own smoke.
        const a = Math.max(0, e.ttl / 0.12) * 0.55;
        g.moveTo(e.x0 * CELL_SIZE, e.y0 * CELL_SIZE).lineTo(e.x1 * CELL_SIZE, e.y1 * CELL_SIZE);
        g.stroke({ width: 1.1, color: 0xfff0cf, alpha: a });
      } else if (e.kind === "flash") {
        g.circle(e.x0 * CELL_SIZE, e.y0 * CELL_SIZE, 3).fill({ color: 0xffe06a, alpha: 0.9 });
      } else if (e.kind === "hit") {
        const r = 3 + (0.3 - e.ttl) * 18;
        g.circle(e.x0 * CELL_SIZE, e.y0 * CELL_SIZE, r).fill({ color: 0x8c1d12, alpha: Math.max(0, e.ttl / 0.3) * 0.7 });
      } else if (e.kind === "ap") {
        g.moveTo(e.x0 * CELL_SIZE, e.y0 * CELL_SIZE).lineTo(e.x1 * CELL_SIZE, e.y1 * CELL_SIZE);
        g.stroke({ width: 2.6, color: 0xfff2c0, alpha: 0.95 });
      } else if (e.kind === "ricochet") {
        // A round spitting off in a random direction — quick, bright, white-hot.
        const a = Math.max(0, e.ttl / 0.14);
        g.moveTo(e.x0 * CELL_SIZE, e.y0 * CELL_SIZE).lineTo(e.x1 * CELL_SIZE, e.y1 * CELL_SIZE);
        g.stroke({ width: 1.2, color: 0xfff6d8, alpha: a });
        g.circle(e.x0 * CELL_SIZE, e.y0 * CELL_SIZE, 1.6).fill({ color: 0xffe9a0, alpha: a });
      } else if (e.kind === "blocked") {
        // "Can't move there": a red no-entry marker that pulses and fades.
        const a = Math.max(0, Math.min(1, e.ttl / 0.8));
        const cx = e.x0 * CELL_SIZE, cy = e.y0 * CELL_SIZE;
        const r = 9 + (1 - a) * 5;
        g.circle(cx, cy, r).stroke({ width: 2, color: 0xe0463a, alpha: a });
        const d = r * 0.7;
        g.moveTo(cx - d, cy - d).lineTo(cx + d, cy + d)
         .moveTo(cx + d, cy - d).lineTo(cx - d, cy + d)
         .stroke({ width: 2, color: 0xe0463a, alpha: a });
      } else if (e.kind === "spark") {
        g.circle(e.x0 * CELL_SIZE, e.y0 * CELL_SIZE, 4).fill({ color: 0xffd24a, alpha: Math.max(0, e.ttl / 0.18) });
      } else if (e.kind === "fire") {
        const r = 6 + (0.4 - e.ttl) * 26;
        g.circle(e.x0 * CELL_SIZE, e.y0 * CELL_SIZE, Math.max(3, r)).fill({ color: 0xff7a1e, alpha: Math.max(0, e.ttl) * 1.6 });
      } else if (e.kind === "smoke") {
        const age = 1 - e.ttl / (e.maxTtl ?? 2.2);
        const r = 7 + age * 30;
        const cy = e.y0 * CELL_SIZE - age * 16; // drifts upward as it billows
        g.circle(e.x0 * CELL_SIZE, cy, r).fill({ color: 0x4a453d, alpha: (1 - age) * 0.6 });
        g.circle(e.x0 * CELL_SIZE - 2, cy - 2, r * 0.6).fill({ color: 0x2c2823, alpha: (1 - age) * 0.5 });
      } else if (e.kind === "lob") {
        // A shell arcing from launcher (x0,y0) to impact (x1,y1): interpolate the
        // ground position and lift it on a parabola so it reads as a high lob.
        const t = 1 - e.ttl / (e.maxTtl ?? 0.7);
        const gx = (e.x0 + (e.x1 - e.x0) * t) * CELL_SIZE;
        const gy = (e.y0 + (e.y1 - e.y0) * t) * CELL_SIZE;
        const lift = Math.sin(t * Math.PI) * 46; // peak height mid-flight
        // Faint shadow on the ground, bright round in the air.
        g.circle(gx, gy, 2).fill({ color: 0x000000, alpha: 0.25 });
        g.circle(gx, gy - lift, 2.6).fill({ color: 0xffe9a0, alpha: 0.95 });
      }
    }

    // Per-man status badges above friendly soldiers — the heart of the CC read. A
    // legible morale icon (bar = suppressed-but-holding, triangle = broken/running)
    // sits over the head; a small cover tick sits under the feet when he's in real
    // cover. Steady men in the open get nothing, so the eye is drawn to what matters.
    for (const s of world.soldiers) {
      if (s.faction !== world.player || s.status !== "active") continue;
      const ix = s.x * CELL_SIZE;
      const iy = s.y * CELL_SIZE;
      this.drawMoraleIcon(g, ix, iy, s.state);

      const tcx = Math.floor(s.x), tcy = Math.floor(s.y);
      const cover = world.grid.inBounds(tcx, tcy) ? TERRAIN[world.grid.get(tcx, tcy)].cover : 0;
      if (cover >= 0.3) {
        // A small shield-tick under the man: brighter the harder the cover.
        const a = 0.35 + 0.4 * Math.min(1, (cover - 0.3) / 0.5);
        g.moveTo(ix - 3.5, iy + 9).quadraticCurveTo(ix, iy + 12.5, ix + 3.5, iy + 9)
          .stroke({ width: 1.4, color: 0x66c8b0, alpha: a });
      }
    }
  }

  // A morale badge above a soldier. Shaken/pinned read as a colored bar (he's pressed
  // down but in place); panicked/routing read as a red triangle (he's broken and bolting).
  // Each gets a thin dark backing so it stays legible over light roofs and snow.
  private drawMoraleIcon(g: Graphics, ix: number, iy: number, state: MoraleState): void {
    const y = iy - 12;
    if (state === "shaken" || state === "pinned") {
      const color = state === "shaken" ? 0xf0c040 : 0xe07a2a;
      const w = state === "pinned" ? 5 : 4;
      g.rect(ix - w / 2 - 0.6, y - 1.6, w + 1.2, 3.2).fill({ color: 0x14110b, alpha: 0.6 });
      g.rect(ix - w / 2, y - 1, w, 2).fill({ color, alpha: 0.97 });
    } else if (state === "panicked" || state === "routing") {
      const color = state === "routing" ? 0xff2a1a : 0xd83a2a;
      g.poly([ix, y - 3.4, ix - 3.2, y + 2.4, ix + 3.2, y + 2.4]).fill({ color: 0x14110b, alpha: 0.6 });
      g.poly([ix, y - 2.4, ix - 2.4, y + 1.8, ix + 2.4, y + 1.8]).fill({ color, alpha: 0.97 });
    }
  }

  // Effective line-of-sight fan for a defending/ambushing team's leader: march rays
  // across the firing arc until terrain or smoke blocks them, then fill the swept area.
  // Shows exactly the ground the team can cover from where it sits, CC's core planning aid.
  private drawSightFan(world: World, originX: number, originY: number, facing: number, range: number): void {
    const g = this.overlay;
    const HALF_ARC = 0.95; // ~54° to each side
    const RAYS = 30;
    const STEP = 0.45; // cells per march step
    const pts: number[] = [originX * CELL_SIZE, originY * CELL_SIZE];
    for (let i = 0; i <= RAYS; i++) {
      const ang = facing - HALF_ARC + (2 * HALF_ARC) * (i / RAYS);
      const dx = Math.cos(ang), dy = Math.sin(ang);
      let dist = range;
      for (let t = STEP; t <= range; t += STEP) {
        const cx = Math.floor(originX + dx * t), cy = Math.floor(originY + dy * t);
        if (!world.grid.inBounds(cx, cy)) { dist = t; break; }
        // The cell touching the shooter never blocks (the window/edge rule), so a man
        // in a building still projects a fan out of his own walls.
        if (t > 1.2) {
          if (TERRAIN[world.grid.get(cx, cy)].blocksSight) { dist = t; break; }
          if (world.smokeGrid[world.grid.idx(cx, cy)] >= SMOKE_LOS_BLOCK) { dist = t; break; }
        }
      }
      pts.push((originX + dx * dist) * CELL_SIZE, (originY + dy * dist) * CELL_SIZE);
    }
    g.poly(pts).fill({ color: 0xffe27a, alpha: 0.07 });
    g.poly(pts).stroke({ width: 1, color: 0xffe27a, alpha: 0.22 });
  }
}

// Reserved screen-edge insets (CSS px) for the persistent HUD chrome, so the camera
// never parks map content underneath it: top status bar, bottom order/deploy bars,
// and the left-edge unit navigator.
const HUD_TOP = 64;
const HUD_BOTTOM = 124;
const HUD_LEFT = 224;

// Clamp one camera axis so the map stays within an available region [start, start+avail]
// of the viewport. When the map is smaller than the region it's centered inside it;
// otherwise it's clamped so the region is always covered (no peeking past the edges).
function clampAxis(cam: number, mapSize: number, start: number, avail: number): number {
  if (mapSize <= avail) return -(start + (avail - mapSize) / 2);
  return Math.max(-start, Math.min(cam, mapSize - start - avail));
}
