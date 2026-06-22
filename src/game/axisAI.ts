import { AI_INTERVAL } from "./constants.ts";
import { Cell } from "./pathfinding.ts";
import { isPassable, TERRAIN, vehiclePassable } from "./terrain.ts";
import { Soldier, World } from "./world.ts";

// Objective-aware defender AI, run on a throttle. Whichever faction is the defender
// garrisons the objectives, holds under a Defend posture, and counterattacks the
// moment the attacker threatens or takes one. Works for both "us-attacks" and
// "axis-attacks" modes — the faction it controls is world.defender.
export function commandDefender(world: World, dt: number): void {
  world.aiAccum += dt;
  if (world.aiAccum < AI_INTERVAL) return;
  world.aiAccum = 0;

  const atk = world.attacker;
  const def = world.defender;
  const objThreatened = (o: { owner: string; capturing: string | null; contested: boolean }) =>
    o.owner === atk || o.capturing === atk || o.contested;
  const anyThreat = world.objectives.some(objThreatened);
  const threatChanged = anyThreat !== world.aiThreatPrev;
  world.aiThreatPrev = anyThreat;

  const defTeams = world.teams.filter((t) => t.faction === def);
  defTeams.forEach((team, idx) => {
    const men = team.soldierIds.map((id) => world.soldier(id)!).filter((s) => s.status === "active");
    if (men.length === 0) return;
    if (men.every((s) => s.state === "panicked" || s.state === "routing")) return;

    const o = world.objectives[idx % world.objectives.length];
    const threatened = objThreatened(o);
    const lost = o.owner === atk;
    if (!team.post) team.post = postAround(world, o.cx, o.cy, o.radius, idx, defTeams.length);
    const anchor = men[0];
    const goal: Cell = threatened ? { cx: o.cx, cy: o.cy } : team.post;
    const d = Math.hypot(anchor.x - goal.cx, anchor.y - goal.cy);
    const moving = men.some((s) => s.path);
    const engaged = men.some((s) => s.targetId != null);

    if (d > 4) {
      if (threatChanged || !moving || (threatened && !movingToward(men, goal))) {
        if (lost) world.orderMove(team.id, goal, "fast");
        else if (!engaged || threatened) world.orderMove(team.id, goal, "move");
      }
    } else if (!defending(men)) {
      world.orderPosture(team.id, "defend");
    }
  });

  // Defender armor: fall back onto the nearest threatened objective, else hold near one.
  const vt = world.objectives.find(objThreatened) ?? world.objectives[0];
  for (const v of world.vehicles) {
    if (v.faction !== def || v.status === "ko" || !vt) continue;
    const d = Math.hypot(v.x - vt.cx, v.y - vt.cy);
    const threatened = objThreatened(vt);
    if (threatened && d > 6) {
      if (threatChanged || !v.path) world.orderVehicleMove(v.id, { cx: vt.cx, cy: vt.cy }, false);
    } else if (!threatened && d > 10 && !v.path) {
      world.orderVehicleMove(v.id, nearestVehCell(world, vt.cx, vt.cy), false);
    }
  }
}

// Legacy export name — some call sites may still use it.
export const commandAxis = commandDefender;

function defending(men: Soldier[]): boolean {
  return men.every((s) => s.stance === "defend" && !s.path);
}

function movingToward(men: Soldier[], goal: Cell): boolean {
  const p = men[0].path;
  if (!p || p.length === 0) return false;
  const end = p[p.length - 1];
  return Math.hypot(end.cx - goal.cx, end.cy - goal.cy) < 6;
}

function postAround(world: World, cx: number, cy: number, radius: number, idx: number, n: number): Cell {
  const ang = (idx / Math.max(1, n)) * Math.PI * 2 - Math.PI / 2;
  const r = radius + 2;
  const tx = Math.round(cx + Math.cos(ang) * r);
  const ty = Math.round(cy + Math.sin(ang) * r);
  let best: Cell | null = null;
  let bestScore = -Infinity;
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = tx + dx, y = ty + dy;
      if (!world.grid.inBounds(x, y)) continue;
      const t = world.grid.get(x, y);
      if (!isPassable(t)) continue;
      const score = TERRAIN[t].cover * 1.6 + TERRAIN[t].concealment * 0.6 - Math.hypot(dx, dy) * 0.05;
      if (score > bestScore) { bestScore = score; best = { cx: x, cy: y }; }
    }
  }
  return best ?? { cx, cy };
}

function nearestVehCell(world: World, cx: number, cy: number): Cell {
  for (let s = 0; s < 30; s++)
    for (let dy = -s; dy <= s; dy++)
      for (let dx = -s; dx <= s; dx++)
        if (world.grid.inBounds(cx + dx, cy + dy) && vehiclePassable(world.grid.get(cx + dx, cy + dy)))
          return { cx: cx + dx, cy: cy + dy };
  return { cx, cy };
}
