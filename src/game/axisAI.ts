import { AI_INTERVAL } from "./constants.ts";
import { Cell } from "./pathfinding.ts";
import { isPassable, TERRAIN, vehiclePassable } from "./terrain.ts";
import { Soldier, World } from "./world.ts";

// The computer commander, run on a throttle. It controls world.aiFaction and simply
// tries to own and hold every objective: it advances on (or counterattacks toward) any
// objective it doesn't control or that's being contested, and holds the rest from good
// cover. This single behaviour covers all three roles — a defender garrisons and
// retakes lost ground; an attacker (or a meeting-engagement AI over a neutral flag)
// pushes forward. Per-soldier firing is still handled by the combat AI.
export function commandAI(world: World, dt: number): void {
  world.aiAccum += dt;
  if (world.aiAccum < AI_INTERVAL) return;
  world.aiAccum = 0;

  const ai = world.aiFaction;
  const foe = ai === "us" ? "axis" : "us";
  // An objective needs attention if the AI doesn't hold it, or the enemy is on/taking it.
  const needs = (o: { owner: string; capturing: string | null; contested: boolean }) =>
    o.owner !== ai || o.capturing === foe || o.contested;
  const anyNeed = world.objectives.some(needs);
  const changed = anyNeed !== world.aiThreatPrev;
  world.aiThreatPrev = anyNeed;

  const aiTeams = world.teams.filter((t) => t.faction === ai);
  aiTeams.forEach((team, idx) => {
    const men = team.soldierIds.map((id) => world.soldier(id)!).filter((s) => s.status === "active");
    if (men.length === 0) return;
    if (men.every((s) => s.state === "panicked" || s.state === "routing")) return;

    const o = world.objectives[idx % world.objectives.length];
    const wants = needs(o);
    const lost = o.owner === foe; // enemy actually holds it — rush to retake
    if (!team.post) team.post = postAround(world, o.cx, o.cy, o.radius, idx, aiTeams.length);
    const anchor = men[0];
    const goal: Cell = wants ? { cx: o.cx, cy: o.cy } : team.post;
    const d = Math.hypot(anchor.x - goal.cx, anchor.y - goal.cy);
    const moving = men.some((s) => s.path);
    const engaged = men.some((s) => s.targetId != null);

    if (d > 4) {
      if (changed || !moving || (wants && !movingToward(men, goal))) {
        if (lost) world.orderMove(team.id, goal, "fast");
        else if (!engaged || wants) world.orderMove(team.id, goal, "move");
      }
    } else if (!defending(men)) {
      world.orderPosture(team.id, "defend");
    }
  });

  // AI armor: push onto the nearest objective that needs taking, else hold near one.
  const vt = world.objectives.find(needs) ?? world.objectives[0];
  for (const v of world.vehicles) {
    if (v.faction !== ai || v.status === "ko" || !vt) continue;
    const d = Math.hypot(v.x - vt.cx, v.y - vt.cy);
    const wants = needs(vt);
    if (wants && d > 6) {
      if (changed || !v.path) world.orderVehicleMove(v.id, { cx: vt.cx, cy: vt.cy }, false);
    } else if (!wants && d > 10 && !v.path) {
      world.orderVehicleMove(v.id, nearestVehCell(world, vt.cx, vt.cy), false);
    }
  }
}

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
