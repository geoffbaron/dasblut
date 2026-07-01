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

// What a foot soldier carries, drawn top-down: a firearm, a short sword, a spear, or a bow.
export type Hold = "rifle" | "sword" | "spear" | "bow";

export function makeSoldierArt(teamColor: number, hold: Hold = "rifle"): SoldierArt {
  return {
    size: LS,
    body: drawBody(teamColor, hold),
    shadow: drawShadow(),
  };
}

// A mounted man: a horse drawn along the facing axis with a rider and a team-color
// saddle blanket. A carbine trooper rides light; a knight adds a bright steel helm,
// a shield at his side, and a couched lance with a team pennant.
export function makeCavalryBody(teamColor: number, knight = false): HTMLCanvasElement {
  const { c, ctx } = newCanvas();
  const hex = `#${teamColor.toString(16).padStart(6, "0")}`;

  // The couched lance goes on first so the horse and rider overlap its grip.
  if (knight) {
    ctx.lineCap = "round";
    ctx.strokeStyle = "#7a5c34"; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(-4, 2.6); ctx.lineTo(10.6, 1.4); ctx.stroke();
    ctx.strokeStyle = "#dfe3e8"; ctx.lineWidth = 1.4; // steel tip
    ctx.beginPath(); ctx.moveTo(9.6, 1.5); ctx.lineTo(11.4, 1.35); ctx.stroke();
    ctx.fillStyle = hex; // pennant fluttering just behind the tip
    ctx.beginPath();
    ctx.moveTo(8.2, 1.5); ctx.lineTo(6.2, 0.1); ctx.lineTo(6.2, 1.7); ctx.closePath();
    ctx.fill();
  }

  // Horse body — a long chestnut oval along the facing (east), lit from above.
  const hide = ctx.createLinearGradient(0, -4, 0, 4);
  hide.addColorStop(0, "#7d5c3a");
  hide.addColorStop(1, "#4e3820");
  ctx.fillStyle = hide;
  ctx.beginPath();
  ctx.ellipse(-0.5, 1.2, 8.5, 3.6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(12,10,6,0.6)"; // outline for read against any ground
  ctx.lineWidth = 0.8;
  ctx.stroke();
  // Tail streaming behind.
  ctx.strokeStyle = "#3a2a16"; ctx.lineWidth = 1.6; ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(-8.6, 1.4); ctx.lineTo(-10.6, 2.2); ctx.stroke();
  // Head and neck forward, with a pale blaze down the nose.
  ctx.fillStyle = "#5e4526";
  ctx.beginPath();
  ctx.ellipse(8.3, -0.5, 2.7, 1.8, -0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(240,235,220,0.75)"; ctx.lineWidth = 0.7;
  ctx.beginPath(); ctx.moveTo(7.6, -0.9); ctx.lineTo(9.6, -0.4); ctx.stroke();
  // Mane along the neck.
  ctx.strokeStyle = "#33240f"; ctx.lineWidth = 1.1;
  ctx.beginPath(); ctx.moveTo(4.5, -1.8); ctx.quadraticCurveTo(6.5, -2.3, 8.2, -1.7); ctx.stroke();

  // Saddle blanket in the team color, then the rider over the withers.
  ctx.fillStyle = hex;
  ctx.beginPath();
  ctx.ellipse(-1, 0.4, 3.6, 3.0, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = knight ? "#8a8f98" : "#4a4f30"; // mail vs field tunic
  ctx.beginPath();
  ctx.ellipse(-0.8, 0, 2.6, 2.8, 0, 0, Math.PI * 2);
  ctx.fill();
  if (knight) {
    // Shield at his side and a bright steel great-helm.
    ctx.fillStyle = "#6b4c2a";
    ctx.beginPath(); ctx.ellipse(-1.4, -3.4, 2.2, 1.6, 0.2, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = hex; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.ellipse(-1.4, -3.4, 2.2, 1.6, 0.2, 0, Math.PI * 2); ctx.stroke();
    const helm = ctx.createRadialGradient(0, -0.8, 0.3, 0.4, -0.3, 2.2);
    helm.addColorStop(0, "#d9dde2");
    helm.addColorStop(1, "#767d87");
    ctx.fillStyle = helm;
    ctx.beginPath(); ctx.arc(0.4, -0.3, 2, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.fillStyle = "#2f3420"; // kepi
    ctx.beginPath(); ctx.arc(0.4, -0.3, 2, 0, Math.PI * 2); ctx.fill();
  }
  ctx.strokeStyle = "rgba(0,0,0,0.4)"; ctx.lineWidth = 0.6;
  ctx.beginPath(); ctx.arc(0.4, -0.3, 2, 0, Math.PI * 2); ctx.stroke();
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

function drawBody(teamColor: number, hold: Hold): HTMLCanvasElement {
  const { c, ctx } = newCanvas();
  const hex = `#${teamColor.toString(16).padStart(6, "0")}`;
  const medieval = hold === "sword" || hold === "spear" || hold === "bow";

  // The held weapon, drawn first so the torso sits over the grip. Pointing east (+x).
  ctx.lineCap = "round";
  if (hold === "sword") {
    // A short arming sword — bright steel blade with a dark crossguard.
    ctx.strokeStyle = "#dfe3e8"; ctx.lineWidth = 1.7;
    ctx.beginPath(); ctx.moveTo(3, 1.6); ctx.lineTo(8.5, 0.8); ctx.stroke();
    ctx.strokeStyle = "#3a2c18"; ctx.lineWidth = 1.2; // crossguard
    ctx.beginPath(); ctx.moveTo(3.1, 0); ctx.lineTo(2.9, 3.1); ctx.stroke();
  } else if (hold === "spear") {
    // A long spear — an ash shaft with a bright steel head.
    ctx.strokeStyle = "#7a5c34"; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(-3, 2.2); ctx.lineTo(10.5, 0.6); ctx.stroke();
    ctx.strokeStyle = "#dfe3e8"; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(9.2, 0.75); ctx.lineTo(11.5, 0.45); ctx.stroke();
  } else if (hold === "bow") {
    // A longbow held out front — limbs bowing forward, string, and a nocked shaft.
    ctx.strokeStyle = "#8a6534"; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(2, 0, 5.2, -1.05, 1.05); ctx.stroke();
    ctx.strokeStyle = "#e8e2d0"; ctx.lineWidth = 0.7; // string
    ctx.beginPath(); ctx.moveTo(4.8, -4.4); ctx.lineTo(4.8, 4.4); ctx.stroke();
    ctx.strokeStyle = "#3a2c18"; ctx.lineWidth = 1.0; // nocked arrow
    ctx.beginPath(); ctx.moveTo(3.2, 0); ctx.lineTo(9.2, 0); ctx.stroke();
  } else {
    // Rifle held forward — a wooden stock with a darker steel barrel toward the muzzle.
    ctx.strokeStyle = "#5e4526"; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(-2, 2); ctx.lineTo(4.5, 1.55); ctx.stroke();
    ctx.strokeStyle = "#23241d"; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(4.5, 1.55); ctx.lineTo(9.8, 1.2); ctx.stroke();
  }

  // Torso / shoulders — an oval across the facing axis, in the era's dress: olive drab
  // for firearm troops, a leather jerkin for medieval foot, a drab tunic for archers.
  // A crisp dark outline keeps every man readable against any ground (the AoE trick).
  const torsoCols: [string, string] =
    hold === "bow" ? ["#7d7742", "#565232"]
    : medieval ? ["#8a6a42", "#5e4628"]
    : ["#5b6038", "#3f4427"];
  const torso = ctx.createLinearGradient(0, -6, 0, 6);
  torso.addColorStop(0, torsoCols[0]);
  torso.addColorStop(1, torsoCols[1]);
  ctx.fillStyle = torso;
  ctx.beginPath();
  ctx.ellipse(0, 0, 5, 6.2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(12,10,6,0.65)"; // outline
  ctx.lineWidth = 0.8;
  ctx.stroke();

  // Team color as a crescent across the back and shoulders (the west side of an
  // east-facing man) — a bold identifier that never swallows the figure the way a
  // full ring did; from the front he still reads as a soldier, not a colored donut.
  ctx.strokeStyle = hex;
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.ellipse(0, 0, 4.1, 5.3, 0, Math.PI * 0.58, Math.PI * 1.42);
  ctx.stroke();

  // Melee foot carry a round shield on the off (left/north) arm: a wooden face ringed
  // in the team color with a bright steel boss — the classic top-down man-at-arms read.
  if (hold === "sword" || hold === "spear") {
    ctx.fillStyle = "rgba(12,10,6,0.3)";
    ctx.beginPath(); ctx.arc(0.6, -4.4, 3.4, 0, Math.PI * 2); ctx.fill(); // drop shadow
    const face = ctx.createRadialGradient(-0.4, -5.4, 0.6, 0.2, -4.8, 3.4);
    face.addColorStop(0, "#a37a48");
    face.addColorStop(1, "#6b4c2a");
    ctx.fillStyle = face;
    ctx.beginPath(); ctx.arc(0.2, -4.8, 3.2, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = hex; ctx.lineWidth = 1.1; // team-color rim
    ctx.beginPath(); ctx.arc(0.2, -4.8, 3.2, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "#d9dde2"; // steel boss
    ctx.beginPath(); ctx.arc(0.2, -4.8, 1.0, 0, Math.PI * 2); ctx.fill();
  }
  // Archers wear a quiver slung across the back — a small tube with shaft tips.
  if (hold === "bow") {
    ctx.save();
    ctx.translate(-3.4, -3.2);
    ctx.rotate(-0.7);
    ctx.fillStyle = "#6b4c2a";
    ctx.fillRect(-1.1, -3, 2.2, 5.6);
    ctx.strokeStyle = "#e0d8b8"; ctx.lineWidth = 0.6;
    for (const off of [-0.6, 0.2, 0.9]) {
      ctx.beginPath(); ctx.moveTo(off, -3); ctx.lineTo(off - 0.3, -4.6); ctx.stroke();
    }
    ctx.restore();
  }

  // Headgear — a steel kettle-helm with a bright crown for medieval men, an olive
  // helmet for firearm troops, a leather cap for archers.
  const helmCols: [string, string] =
    hold === "bow" ? ["#8a6a42", "#4e3a20"]
    : medieval ? ["#c9ced6", "#6d747e"]
    : ["#5a6038", "#2f3420"];
  const helm = ctx.createRadialGradient(-0.2, -1.2, 0.5, 0.8, 0, 4.2);
  helm.addColorStop(0, helmCols[0]);
  helm.addColorStop(1, helmCols[1]);
  ctx.fillStyle = helm;
  ctx.beginPath();
  ctx.arc(1, 0, 3.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.45)";
  ctx.lineWidth = 0.7;
  ctx.stroke();

  return c;
}
