import { Renderer } from "./renderer.ts";
import { Faction, World } from "../game/world.ts";

// Pointer & keyboard handling.
// Left button  — click to select / issue order; drag to rubber-band select.
// Right/middle — drag to pan; stationary right-click clears selection.
export class Input {
  private keys = new Set<string>();

  // Right/middle pan drag.
  private dragBtn: number | null = null;
  private dragLastX = 0;
  private dragLastY = 0;
  private dragMoved = 0;

  // Left button state (select / box / order).
  private lbDown = false;
  private lbSX0 = 0; // screen coords where the left button went down
  private lbSY0 = 0;
  private lbMoved = 0;
  private lbBoxActive = false;

  constructor(
    private readonly renderer: Renderer,
    private readonly world: World,
    private readonly onSelectionChange: () => void,
    private readonly onOrder: (x: number, y: number) => void,
    private readonly onBoxSelect: (sx0: number, sy0: number, sx1: number, sy1: number, additive: boolean) => void,
    private readonly side: Faction = "us",
  ) {
    const canvas = renderer.app.canvas;
    canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    canvas.addEventListener("pointermove", (e) => this.onPointerMove(e));
    canvas.addEventListener("pointerup",   (e) => this.onPointerUp(e));
    canvas.addEventListener("pointerleave", () => {
      this.dragBtn = null;
      if (this.lbBoxActive) { this.renderer.clearSelectionBox(); this.lbBoxActive = false; }
      this.lbDown = false;
    });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const factor = Math.exp(-e.deltaY * 0.0015);
      renderer.setZoom(renderer.zoom * factor, px, py, world);
    }, { passive: false });
    window.addEventListener("keydown", (e) => this.keys.add(e.key.toLowerCase()));
    window.addEventListener("keyup",   (e) => this.keys.delete(e.key.toLowerCase()));
  }

  private onPointerDown(e: PointerEvent): void {
    const rect = this.renderer.app.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    if (e.button === 2 || e.button === 1) {
      this.dragBtn = e.button;
      this.dragLastX = e.clientX;
      this.dragLastY = e.clientY;
      this.dragMoved = 0;
      return;
    }

    if (e.button === 0) {
      this.lbDown = true;
      this.lbSX0 = sx;
      this.lbSY0 = sy;
      this.lbMoved = 0;
      this.lbBoxActive = false;
    }
  }

  private onPointerMove(e: PointerEvent): void {
    const rect = this.renderer.app.canvas.getBoundingClientRect();

    // Right/middle pan.
    if (this.dragBtn !== null) {
      const dx = e.clientX - this.dragLastX;
      const dy = e.clientY - this.dragLastY;
      this.dragLastX = e.clientX;
      this.dragLastY = e.clientY;
      this.dragMoved += Math.abs(dx) + Math.abs(dy);
      this.renderer.panBy(-dx, -dy, this.world);
      return;
    }

    // Left drag: once past threshold, switch into box-select mode.
    if (this.lbDown) {
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      this.lbMoved += Math.abs(sx - this.lbSX0) + Math.abs(sy - this.lbSY0);
      if (this.lbMoved > 8) this.lbBoxActive = true;
      if (this.lbBoxActive) this.renderer.setSelectionBox(this.lbSX0, this.lbSY0, sx, sy);
    }
  }

  private onPointerUp(e: PointerEvent): void {
    const rect = this.renderer.app.canvas.getBoundingClientRect();

    // Right/middle release.
    if (this.dragBtn !== null && e.button === this.dragBtn) {
      const wasDrag = this.dragMoved > 6;
      this.dragBtn = null;
      if (!wasDrag && e.button === 2) {
        this.world.selectedTeamId = null;
        this.world.selectedTeamIds.clear();
        this.world.selectedVehicleId = null;
        this.world.selectedVehicleIds.clear();
        this.onSelectionChange();
      }
      return;
    }

    if (e.button !== 0 || !this.lbDown) return;
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    this.lbDown = false;

    if (this.lbBoxActive) {
      // Finish the drag-box: let main.ts resolve which teams fall inside. Shift adds
      // them to the current group instead of replacing it.
      this.renderer.clearSelectionBox();
      this.lbBoxActive = false;
      this.onBoxSelect(this.lbSX0, this.lbSY0, sx, sy, e.shiftKey);
      return;
    }

    // Plain click: select a vehicle, then a squad, otherwise issue the armed order.
    const { x, y } = this.renderer.screenToWorld(sx, sy);
    const vid = this.world.pickVehicleAt(x, y, 1.8, this.side);
    if (vid != null) {
      // Shift-click toggles a vehicle in/out of the current vehicle group (build a group
      // by clicking each one, same as squads); a plain click selects just that vehicle.
      if (e.shiftKey && this.world.selectedTeamIds.size === 0) {
        const sel = this.world.selectedVehicleIds;
        if (sel.has(vid)) sel.delete(vid);
        else sel.add(vid);
        this.world.selectedVehicleId = sel.size ? [...sel][sel.size - 1] : null;
      } else {
        this.world.selectedVehicleId = vid;
        this.world.selectedVehicleIds = new Set([vid]);
      }
      this.world.selectedTeamId = null;
      this.world.selectedTeamIds.clear();
      this.onSelectionChange();
      return;
    }
    const teamId = this.world.pickTeamAt(x, y, 1.2, this.side);
    if (teamId != null) {
      // Shift-click toggles a squad in/out of the current group (build a group by
      // clicking each one); a plain click selects just that squad.
      if (e.shiftKey && this.world.selectedVehicleIds.size === 0) {
        const sel = this.world.selectedTeamIds;
        if (sel.has(teamId)) sel.delete(teamId);
        else sel.add(teamId);
        this.world.selectedTeamId = sel.size ? [...sel][sel.size - 1] : null;
      } else {
        this.world.selectedTeamId = teamId;
        this.world.selectedTeamIds = new Set([teamId]);
      }
      this.world.selectedVehicleId = null;
      this.world.selectedVehicleIds.clear();
      this.onSelectionChange();
      return;
    }
    if (this.world.selectedTeamId != null || this.world.selectedVehicleId != null) this.onOrder(x, y);
  }

  /** Called once per rendered frame to apply smooth keyboard panning. */
  update(dtMs: number): void {
    const speed = 0.6 * dtMs;
    let dx = 0, dy = 0;
    if (this.keys.has("arrowleft"))  dx -= speed;
    if (this.keys.has("arrowright")) dx += speed;
    if (this.keys.has("arrowup"))    dy -= speed;
    if (this.keys.has("arrowdown"))  dy += speed;
    if (dx !== 0 || dy !== 0) this.renderer.panBy(dx, dy, this.world);
  }
}
