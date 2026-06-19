import { CELL_SIZE } from "../game/constants.ts";
import { VehicleDef } from "../game/vehicleDefs.ts";

// Procedural top-down armor sprites: hull (with tracks), a separate turret with its
// gun barrel, a ground shadow, and a charred wreck. All drawn pointing EAST so the
// renderer can rotate hull and turret independently to their facings.

const SS = 2;

export interface VehicleArt {
  hull: HTMLCanvasElement;
  turret: HTMLCanvasElement;
  shadow: HTMLCanvasElement;
  wreck: HTMLCanvasElement;
  scale: number; // multiply canvas px → logical px
  hullCanvasPx: number;
  turretCanvasPx: number;
}

export function makeVehicleArt(def: VehicleDef): VehicleArt {
  const hullW = def.hullLen * CELL_SIZE;
  const hullH = def.hullWid * CELL_SIZE;
  const barrel = hullW * 0.65;
  const turretD = hullH * 0.78;

  const hullPx = Math.ceil(Math.max(hullW, hullH)) + 12;
  const turretPx = Math.ceil((turretD / 2 + barrel) * 2) + 8;

  return {
    hull: drawHull(def, hullW, hullH, hullPx),
    turret: drawTurret(def, turretD, barrel, turretPx),
    shadow: drawShadow(hullW, hullH, hullPx),
    wreck: drawWreck(hullW, hullH, hullPx),
    scale: 1 / SS,
    hullCanvasPx: hullPx,
    turretCanvasPx: turretPx,
  };
}

function ctxFor(px: number): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const c = document.createElement("canvas");
  c.width = px * SS;
  c.height = px * SS;
  const ctx = c.getContext("2d")!;
  ctx.scale(SS, SS);
  ctx.translate(px / 2, px / 2);
  return { c, ctx };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function drawHull(def: VehicleDef, w: number, h: number, px: number): HTMLCanvasElement {
  const { c, ctx } = ctxFor(px);
  const hex = `#${def.bodyColor.toString(16).padStart(6, "0")}`;
  // Tracks (darker bands along the sides, i.e. top/bottom when pointing east).
  ctx.fillStyle = "#23241d";
  roundRect(ctx, -w / 2, -h / 2, w, h, 3);
  ctx.fill();
  // Tread ticks.
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 1;
  for (let x = -w / 2 + 2; x < w / 2; x += 4) {
    ctx.beginPath();
    ctx.moveTo(x, -h / 2);
    ctx.lineTo(x, -h / 2 + 4);
    ctx.moveTo(x, h / 2);
    ctx.lineTo(x, h / 2 - 4);
    ctx.stroke();
  }
  // Hull body inset between the tracks.
  const inset = h * 0.22;
  const grad = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
  grad.addColorStop(0, lighten(hex, 18));
  grad.addColorStop(0.5, hex);
  grad.addColorStop(1, lighten(hex, -22));
  ctx.fillStyle = grad;
  roundRect(ctx, -w / 2 + 1, -h / 2 + inset, w - 2, h - inset * 2, 2);
  ctx.fill();
  // Sloped glacis at the front (east end).
  ctx.fillStyle = lighten(hex, 8);
  roundRect(ctx, w / 2 - w * 0.22, -h / 2 + inset + 2, w * 0.2, h - inset * 2 - 4, 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.4)";
  ctx.lineWidth = 1;
  roundRect(ctx, -w / 2, -h / 2, w, h, 3);
  ctx.stroke();
  return c;
}

function drawTurret(def: VehicleDef, d: number, barrel: number, px: number): HTMLCanvasElement {
  const { c, ctx } = ctxFor(px);
  const hex = `#${def.turretColor.toString(16).padStart(6, "0")}`;
  // Gun barrel forward (+x).
  ctx.strokeStyle = "#1c1d17";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(d * 0.3, 0);
  ctx.lineTo(d * 0.3 + barrel, 0);
  ctx.stroke();
  // Turret body.
  const grad = ctx.createRadialGradient(-d * 0.15, -d * 0.15, d * 0.1, 0, 0, d * 0.6);
  grad.addColorStop(0, lighten(hex, 22));
  grad.addColorStop(1, lighten(hex, -18));
  ctx.fillStyle = grad;
  roundRect(ctx, -d / 2, -d / 2, d, d, d * 0.35);
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.45)";
  ctx.lineWidth = 1;
  roundRect(ctx, -d / 2, -d / 2, d, d, d * 0.35);
  ctx.stroke();
  // Cupola.
  ctx.fillStyle = lighten(hex, -10);
  ctx.beginPath();
  ctx.arc(-d * 0.15, -d * 0.18, d * 0.14, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

function drawShadow(w: number, h: number, px: number): HTMLCanvasElement {
  const { c, ctx } = ctxFor(px);
  ctx.fillStyle = "rgba(8,10,6,0.4)";
  roundRect(ctx, -w / 2 + 2, -h / 2 + 3, w, h, 4);
  ctx.fill();
  return c;
}

function drawWreck(w: number, h: number, px: number): HTMLCanvasElement {
  const { c, ctx } = ctxFor(px);
  ctx.fillStyle = "#1b1a16";
  roundRect(ctx, -w / 2, -h / 2, w, h, 3);
  ctx.fill();
  ctx.fillStyle = "#2c281f";
  roundRect(ctx, -w / 2 + 2, -h / 2 + 3, w - 4, h - 6, 2);
  ctx.fill();
  // Scorch + a knocked-askew turret stub.
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.beginPath();
  ctx.ellipse(0, 0, w * 0.28, h * 0.3, 0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#15140f";
  roundRect(ctx, -h * 0.3, -h * 0.32, h * 0.6, h * 0.6, 3);
  ctx.fill();
  return c;
}

function lighten(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = clamp((n >> 16) + amt);
  const g = clamp(((n >> 8) & 255) + amt);
  const b = clamp((n & 255) + amt);
  return `rgb(${r},${g},${b})`;
}
function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}
