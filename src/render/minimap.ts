import { factionColor, World } from "../game/world.ts";
import { Renderer } from "./renderer.ts";

// A small tactical radar docked in the corner: objectives, friendly units, and any
// spotted enemy (fog-of-war respected — an unseen enemy simply never appears), plus a
// rectangle for the camera's current viewport. Deliberately terrain-free — it's a radar
// reading, not a scaled-down map — so it stays cheap to redraw every frame regardless
// of map size.
export function drawMinimap(canvas: HTMLCanvasElement, world: World, renderer: Renderer): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const { ox, oy, scale } = mapTransform(canvas, world);
  const gw = world.grid.width * scale, gh = world.grid.height * scale;
  const toX = (cx: number) => ox + cx * scale;
  const toY = (cy: number) => oy + cy * scale;

  ctx.fillStyle = "#1c1a14";
  ctx.fillRect(ox, oy, gw, gh);

  for (const o of world.objectives) {
    const x = toX(o.cx), y = toY(o.cy);
    const col = o.owner === "neutral" ? "#bfb38a" : colorHex(factionColor(world.era, o.owner));
    ctx.beginPath();
    ctx.arc(x, y, Math.max(2.5, o.radius * scale * 0.4), 0, Math.PI * 2);
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(x, y, 1.3, 0, Math.PI * 2);
    ctx.fill();
  }

  const showEnemy = (seen: boolean) => renderer.revealAll || seen;
  for (const v of world.vehicles) {
    if (v.status === "ko") continue;
    if (v.faction !== world.player && !showEnemy(v.seen)) continue;
    ctx.fillStyle = colorHex(factionColor(world.era, v.faction));
    const x = toX(v.x), y = toY(v.y);
    ctx.fillRect(x - 1.6, y - 1.6, 3.2, 3.2);
  }
  for (const s of world.soldiers) {
    if (s.status === "dead") continue;
    if (s.faction !== world.player && !showEnemy(s.seen)) continue;
    ctx.fillStyle = colorHex(factionColor(world.era, s.faction));
    ctx.beginPath();
    ctx.arc(toX(s.x), toY(s.y), 1.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // The camera's current viewport, so the minimap doubles as a "you are here" frame.
  const tl = renderer.screenToWorld(0, 0);
  const br = renderer.screenToWorld(renderer.app.screen.width, renderer.app.screen.height);
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineWidth = 1;
  ctx.strokeRect(toX(tl.x), toY(tl.y), (br.x - tl.x) * scale, (br.y - tl.y) * scale);
}

// Convert a click on the minimap canvas into a world-cell point, for click-to-pan.
export function minimapClickToWorld(canvas: HTMLCanvasElement, world: World, clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const px = (clientX - rect.left) * (canvas.width / rect.width);
  const py = (clientY - rect.top) * (canvas.height / rect.height);
  const { ox, oy, scale } = mapTransform(canvas, world);
  return { x: (px - ox) / scale, y: (py - oy) / scale };
}

// Uniform scale + letterbox offset fitting the grid into the canvas, shared by drawing
// and click handling so a click always lands exactly where it visually appears.
function mapTransform(canvas: HTMLCanvasElement, world: World): { ox: number; oy: number; scale: number } {
  const gw = world.grid.width, gh = world.grid.height;
  const scale = Math.min(canvas.width / gw, canvas.height / gh);
  return { ox: (canvas.width - gw * scale) / 2, oy: (canvas.height - gh * scale) / 2, scale };
}

function colorHex(n: number): string {
  return "#" + n.toString(16).padStart(6, "0");
}
