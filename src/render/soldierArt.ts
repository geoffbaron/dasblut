// Procedurally drawn soldier sprites — a top-down figure with helmet, shoulders,
// a rifle, and a team-color band. Drawn pointing EAST (+x) so the renderer can set
// sprite.rotation = facing directly. Rendered to small canvases used as textures.

const LS = 22; // logical sprite size
const SS = 3; // supersample for crisp helmets on hi-dpi

export interface SoldierArt {
  size: number; // logical size (anchor at center)
  body: HTMLCanvasElement;
  shadow: HTMLCanvasElement;
}

export function makeSoldierArt(teamColor: number): SoldierArt {
  return {
    size: LS,
    body: drawBody(teamColor),
    shadow: drawShadow(),
  };
}

// A fallen man — slumped, no raised weapon, drawn dark. Shared across factions.
export function makeCasualtyCanvas(): HTMLCanvasElement {
  const { c, ctx } = newCanvas();
  ctx.fillStyle = "rgba(10,12,8,0.3)";
  ctx.beginPath();
  ctx.ellipse(1, 1.5, 6.5, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#403a26";
  ctx.beginPath();
  ctx.ellipse(0, 0, 6, 3.6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#2c3120";
  ctx.beginPath();
  ctx.arc(-4, 0, 2.8, 0, Math.PI * 2); // helmet rolled to the side
  ctx.fill();
  return c;
}

function newCanvas(): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const c = document.createElement("canvas");
  c.width = LS * SS;
  c.height = LS * SS;
  const ctx = c.getContext("2d")!;
  ctx.scale(SS, SS);
  ctx.translate(LS / 2, LS / 2); // origin at center
  return { c, ctx };
}

function drawShadow(): HTMLCanvasElement {
  const { c, ctx } = newCanvas();
  ctx.fillStyle = "rgba(10,12,8,0.38)";
  ctx.beginPath();
  ctx.ellipse(0.5, 1, 6.2, 4.2, 0, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

function drawBody(teamColor: number): HTMLCanvasElement {
  const { c, ctx } = newCanvas();
  const hex = `#${teamColor.toString(16).padStart(6, "0")}`;

  // Rifle held forward (east), slightly to one side.
  ctx.strokeStyle = "#1c1d16";
  ctx.lineWidth = 1.5;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-2, 2);
  ctx.lineTo(9.5, 1.2);
  ctx.stroke();

  // Torso / shoulders — olive drab uniform, oval across the facing axis.
  const torso = ctx.createLinearGradient(0, -6, 0, 6);
  torso.addColorStop(0, "#5b6038");
  torso.addColorStop(1, "#3f4427");
  ctx.fillStyle = torso;
  ctx.beginPath();
  ctx.ellipse(0, 0, 5, 6.2, 0, 0, Math.PI * 2);
  ctx.fill();

  // Team-color identifier band around the shoulders.
  ctx.strokeStyle = hex;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.ellipse(0, 0, 5, 6.2, 0, 0, Math.PI * 2);
  ctx.stroke();

  // Helmet — sits slightly forward, rounded, with a top-left highlight.
  const helm = ctx.createRadialGradient(-1.2, -1.2, 0.5, 0.8, 0, 4.2);
  helm.addColorStop(0, "#5a6038");
  helm.addColorStop(1, "#2f3420");
  ctx.fillStyle = helm;
  ctx.beginPath();
  ctx.arc(1, 0, 3.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.4)";
  ctx.lineWidth = 0.7;
  ctx.stroke();

  return c;
}
