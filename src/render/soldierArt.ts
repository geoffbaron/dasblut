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

// A mounted trooper: a horse drawn along the facing axis with a rider and a team-color
// saddle blanket. Bigger than a man on foot. (No drawn weapon — top-down it just read
// as a stray lance/sword sticking out.)
export function makeCavalryBody(teamColor: number): HTMLCanvasElement {
  const { c, ctx } = newCanvas();
  const hex = `#${teamColor.toString(16).padStart(6, "0")}`;

  // Horse body — a long oval along the facing (east), brown.
  const hide = ctx.createLinearGradient(0, -4, 0, 4);
  hide.addColorStop(0, "#5b4630");
  hide.addColorStop(1, "#3d2e1d");
  ctx.fillStyle = hide;
  ctx.beginPath();
  ctx.ellipse(-0.5, 1.2, 8.5, 3.6, 0, 0, Math.PI * 2);
  ctx.fill();
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

  // Axle across the carriage, with a wheel at each end. Seen from straight above, the
  // wheels are upright discs viewed edge-on, so they read as thin rims running along the
  // line of travel (the barrel axis) — NOT round balls.
  ctx.strokeStyle = "#241a10";
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(-1.5, -3.6);
  ctx.lineTo(-1.5, 3.6); // axle
  ctx.stroke();
  for (const wy of [-3.6, 3.6]) {
    // tyre: a long thin ellipse aligned with the barrel (the wheel's rolling direction)
    ctx.fillStyle = "#2a2014";
    ctx.beginPath();
    ctx.ellipse(-1.5, wy, 3.2, 1.0, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#5a4a2c";
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.ellipse(-1.5, wy, 3.2, 1.0, 0, 0, Math.PI * 2);
    ctx.stroke();
    // a couple of spoke ticks for read
    ctx.beginPath();
    ctx.moveTo(-3.2, wy); ctx.lineTo(0.2, wy);
    ctx.stroke();
  }
  return c;
}

// A catapult: a timber base frame with a stout throwing arm swung forward (east), a stone
// loaded in the sling at its head, and a team-color band on the rear beam. Reads clearly
// apart from the sleeker field gun.
export function makeCatapultBody(teamColor: number): HTMLCanvasElement {
  const { c, ctx } = newCanvas();
  const hex = `#${teamColor.toString(16).padStart(6, "0")}`;

  // Timber base frame — two side beams running along the facing, with cross braces.
  ctx.strokeStyle = "#4a3a22";
  ctx.lineWidth = 1.8;
  ctx.lineCap = "round";
  for (const oy of [-3, 3]) {
    ctx.beginPath();
    ctx.moveTo(-7, oy);
    ctx.lineTo(6, oy);
    ctx.stroke();
  }
  ctx.lineWidth = 1.2;
  for (const ox of [-6, 0, 5]) {
    ctx.beginPath();
    ctx.moveTo(ox, -3.2);
    ctx.lineTo(ox, 3.2);
    ctx.stroke();
  }

  // The throwing arm — a stout beam pivoting mid-frame, thrown forward, bucket at its head.
  const arm = ctx.createLinearGradient(-6, 0, 8, 0);
  arm.addColorStop(0, "#6b5228");
  arm.addColorStop(1, "#8a6a34");
  ctx.strokeStyle = arm;
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.moveTo(-4, 0);
  ctx.lineTo(8, -0.5);
  ctx.stroke();
  ctx.fillStyle = "#3a2c18"; // sling cup
  ctx.beginPath();
  ctx.arc(8.2, -0.5, 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#7d7b74"; // the stone
  ctx.beginPath();
  ctx.arc(8.2, -0.5, 1.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#3a2c18"; // pivot post
  ctx.beginPath();
  ctx.arc(-4, 0, 1.6, 0, Math.PI * 2);
  ctx.fill();

  // Team-color band on the rear beam.
  ctx.strokeStyle = hex;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(-7, 0);
  ctx.lineTo(-4.8, 0);
  ctx.stroke();
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
