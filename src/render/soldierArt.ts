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

// A mounted trooper: a horse drawn along the facing axis with a rider, a team-color
// saddle blanket, and a raised sabre. Bigger than a man on foot.
export function makeCavalryBody(teamColor: number): HTMLCanvasElement {
  const { c, ctx } = newCanvas();
  const hex = `#${teamColor.toString(16).padStart(6, "0")}`;

  // Sabre, raised and angled forward.
  ctx.strokeStyle = "#d8d8de";
  ctx.lineWidth = 1.1;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(2, -3);
  ctx.lineTo(8, -8);
  ctx.stroke();

  // Horse body — a long oval along the facing (east), brown.
  const hide = ctx.createLinearGradient(0, -4, 0, 4);
  hide.addColorStop(0, "#5b4630");
  hide.addColorStop(1, "#3d2e1d");
  ctx.fillStyle = hide;
  ctx.beginPath();
  ctx.ellipse(-0.5, 1.2, 8.5, 3.6, 0, 0, Math.PI * 2);
  ctx.fill();
  // Legs (simple darker stubs).
  ctx.strokeStyle = "#2c2114";
  ctx.lineWidth = 1.2;
  for (const lx of [-6, -3, 3, 6]) { ctx.beginPath(); ctx.moveTo(lx, 3); ctx.lineTo(lx, 6); ctx.stroke(); }
  // Head and neck forward.
  ctx.fillStyle = "#43331f";
  ctx.beginPath();
  ctx.ellipse(8.5, -0.5, 2.6, 1.8, -0.4, 0, Math.PI * 2);
  ctx.fill();

  // Rider torso with team-color blanket, sat over the withers.
  ctx.fillStyle = hex;
  ctx.beginPath();
  ctx.ellipse(-1, 0, 3, 3.4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#2f3420";
  ctx.beginPath();
  ctx.arc(0.4, -0.3, 2, 0, Math.PI * 2); // head/kepi
  ctx.fill();
  return c;
}

// A field gun: a long dark barrel along the facing, a wooden carriage, and two spoked
// wheels. A small team-color touch on the trail so you can tell whose battery it is.
export function makeCannonBody(teamColor: number): HTMLCanvasElement {
  const { c, ctx } = newCanvas();
  const hex = `#${teamColor.toString(16).padStart(6, "0")}`;

  // Trail / carriage stretching behind the muzzle.
  ctx.strokeStyle = "#5a4326";
  ctx.lineWidth = 2.4;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-7, 1.5);
  ctx.lineTo(2, 0);
  ctx.stroke();
  ctx.strokeStyle = hex; // team band at the trail spade
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(-7.5, 1.5);
  ctx.lineTo(-5.5, 1.5);
  ctx.stroke();

  // The barrel — a tapering dark bronze tube pointing east.
  const barrel = ctx.createLinearGradient(0, -1.5, 0, 1.5);
  barrel.addColorStop(0, "#8a8d6a");
  barrel.addColorStop(1, "#3f4032");
  ctx.fillStyle = barrel;
  ctx.beginPath();
  ctx.moveTo(-1, -1.8);
  ctx.lineTo(9, -1.1);
  ctx.lineTo(9, 1.1);
  ctx.lineTo(-1, 1.8);
  ctx.closePath();
  ctx.fill();

  // Wheels — two dark discs flanking the carriage axle.
  ctx.fillStyle = "#2a2014";
  for (const wy of [-3.4, 3.4]) {
    ctx.beginPath();
    ctx.arc(-1.5, wy, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#4a3a22";
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.arc(-1.5, wy, 3.2, 0, Math.PI * 2);
    ctx.stroke();
  }
  return c;
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
