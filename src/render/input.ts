import { Renderer } from "./renderer.ts";
import { World } from "../game/world.ts";

// Pointer & keyboard handling: click a squad to select, click ground to issue a
// Move order, WASD/arrows to pan. Keyboard pan state is polled each frame.
export class Input {
  private keys = new Set<string>();
  // Drag-to-pan state (right or middle mouse). We only treat it as a pan once the
  // pointer has moved past a small threshold, so a stationary right-click still
  // clears the selection.
  private dragBtn: number | null = null;
  private dragLastX = 0;
  private dragLastY = 0;
  private dragMoved = 0;

  constructor(
    private readonly renderer: Renderer,
    private readonly world: World,
    private readonly onSelectionChange: () => void,
    private readonly onOrder: (x: number, y: number) => void,
  ) {
    const canvas = renderer.app.canvas;
    canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    canvas.addEventListener("pointermove", (e) => this.onPointerMove(e));
    canvas.addEventListener("pointerup", (e) => this.onPointerUp(e));
    canvas.addEventListener("pointerleave", () => { this.dragBtn = null; });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      // Gentle, exponential step keyed to scroll delta so it feels smooth on both
      // wheels and trackpads instead of snapping a fixed amount per tick.
      const factor = Math.exp(-e.deltaY * 0.0015);
      renderer.setZoom(renderer.zoom * factor, px, py, world);
    }, { passive: false });
    window.addEventListener("keydown", (e) => this.keys.add(e.key.toLowerCase()));
    window.addEventListener("keyup", (e) => this.keys.delete(e.key.toLowerCase()));
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.dragBtn === null) return;
    const dx = e.clientX - this.dragLastX;
    const dy = e.clientY - this.dragLastY;
    this.dragLastX = e.clientX;
    this.dragLastY = e.clientY;
    this.dragMoved += Math.abs(dx) + Math.abs(dy);
    // Drag content with the cursor: moving the mouse right slides the map right,
    // i.e. the camera origin moves left.
    this.renderer.panBy(-dx, -dy, this.world);
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.dragBtn === null || e.button !== this.dragBtn) return;
    const wasDrag = this.dragMoved > 6;
    this.dragBtn = null;
    // A right/middle button that barely moved is a click: clear the selection.
    if (!wasDrag && e.button === 2) {
      this.world.selectedTeamId = null;
      this.world.selectedVehicleId = null;
      this.onSelectionChange();
    }
  }

  private onPointerDown(e: PointerEvent): void {
    const rect = this.renderer.app.canvas.getBoundingClientRect();
    const { x, y } = this.renderer.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);

    // Right or middle button begins a potential drag-pan (resolved on pointerup).
    if (e.button === 2 || e.button === 1) {
      this.dragBtn = e.button;
      this.dragLastX = e.clientX;
      this.dragLastY = e.clientY;
      this.dragMoved = 0;
      return;
    }

    // Left-click: select a tank, then a squad, otherwise issue the armed order.
    const vid = this.world.pickVehicleAt(x, y, 1.8);
    if (vid != null) {
      this.world.selectedVehicleId = vid;
      this.world.selectedTeamId = null;
      this.onSelectionChange();
      return;
    }
    const teamId = this.world.pickTeamAt(x, y, 1.2);
    if (teamId != null) {
      this.world.selectedTeamId = teamId;
      this.world.selectedVehicleId = null;
      this.onSelectionChange();
      return;
    }
    if (this.world.selectedTeamId != null || this.world.selectedVehicleId != null) this.onOrder(x, y);
  }

  /** Called once per rendered frame to apply smooth keyboard panning. */
  update(dtMs: number): void {
    const speed = 0.6 * dtMs; // pixels per ms (arrow keys; WASD are order hotkeys)
    let dx = 0;
    let dy = 0;
    if (this.keys.has("arrowleft")) dx -= speed;
    if (this.keys.has("arrowright")) dx += speed;
    if (this.keys.has("arrowup")) dy -= speed;
    if (this.keys.has("arrowdown")) dy += speed;
    if (dx !== 0 || dy !== 0) this.renderer.panBy(dx, dy, this.world);
  }
}
