import { AI_INTERVAL } from "./constants.ts";
import { Cell } from "./pathfinding.ts";
import { isPassable, vehiclePassable } from "./terrain.ts";
import { Soldier, World } from "./world.ts";

// Objective-aware enemy command, run on a throttle. The Axis garrisons the victory
// location at the start, holds it under a Defend posture, and counterattacks toward
// the flag the moment the US threatens or takes it. Per-soldier firing is still
// handled by the combat AI — this only issues squad movement/stance orders.
export function commandAxis(world: World, dt: number): void {
  world.aiAccum += dt;
  if (world.aiAccum < AI_INTERVAL) return;
  world.aiAccum = 0;

  const o = world.objective;
  const threatened = world.objOwner === "us" || world.objCapturing === "us" || world.objContested;
  const threatChanged = threatened !== world.aiThreatPrev;
  world.aiThreatPrev = threatened;

  const axisTeams = world.teams.filter((t) => t.faction === "axis");
  axisTeams.forEach((team, idx) => {
    const men = team.soldierIds.map((id) => world.soldier(id)!).filter((s) => s.status === "active");
    if (men.length === 0) return;
    if (men.every((s) => s.state === "panicked" || s.state === "routing")) return; // broken — let them run

    if (!team.post) team.post = postAround(world, o.cx, o.cy, o.radius, idx, axisTeams.length);
    const anchor = men[0];
    const goal: Cell = threatened ? { cx: o.cx, cy: o.cy } : team.post;
    const d = Math.hypot(anchor.x - goal.cx, anchor.y - goal.cy);
    const moving = men.some((s) => s.path);
    const engaged = men.some((s) => s.targetId != null);

    if (d > 4) {
      // March to the post / counterattack the flag. Push on even if engaged when the
      // objective is under threat; otherwise don't yank a squad out of a firefight.
      if (threatChanged || !moving || (threatened && !movingToward(men, goal))) {
        if (!engaged || threatened) world.orderMove(team.id, goal, "move");
      }
    } else if (!defending(men)) {
      world.orderPosture(team.id, "defend");
    }
  });

  // Axis armor: fall back onto the objective when it's threatened, else hold near it.
  for (const v of world.vehicles) {
    if (v.faction !== "axis" || v.status === "ko") continue;
    const d = Math.hypot(v.x - o.cx, v.y - o.cy);
    if (threatened && d > 6) {
      if (threatChanged || !v.path) world.orderVehicleMove(v.id, { cx: o.cx, cy: o.cy }, false);
    } else if (!threatened && d > 10 && !v.path) {
      world.orderVehicleMove(v.id, nearestVehCell(world, o.cx, o.cy), false);
    }
  }
}

function defending(men: Soldier[]): boolean {
  return men.every((s) => s.stance === "defend" && !s.path);
}

function movingToward(men: Soldier[], goal: Cell): boolean {
  // Cheap check: is the lead man's current path aimed near the goal?
  const p = men[0].path;
  if (!p || p.length === 0) return false;
  const end = p[p.length - 1];
  return Math.hypot(end.cx - goal.cx, end.cy - goal.cy) < 6;
}

// A defensive slot on a ring just outside the capture edge, spread by squad index,
// snapped to passable ground (often a building or street near the flag).
function postAround(world: World, cx: number, cy: number, radius: number, idx: number, n: number): Cell {
  const ang = (idx / Math.max(1, n)) * Math.PI * 2 - Math.PI / 2;
  const r = radius + 2;
  const tx = Math.round(cx + Math.cos(ang) * r);
  const ty = Math.round(cy + Math.sin(ang) * r);
  for (let s = 0; s < 30; s++) {
    const rr = s;
    for (let dy = -rr; dy <= rr; dy++)
      for (let dx = -rr; dx <= rr; dx++)
        if (world.grid.inBounds(tx + dx, ty + dy) && isPassable(world.grid.get(tx + dx, ty + dy)))
          return { cx: tx + dx, cy: ty + dy };
  }
  return { cx, cy };
}

function nearestVehCell(world: World, cx: number, cy: number): Cell {
  for (let s = 0; s < 30; s++)
    for (let dy = -s; dy <= s; dy++)
      for (let dx = -s; dx <= s; dx++)
        if (world.grid.inBounds(cx + dx, cy + dy) && vehiclePassable(world.grid.get(cx + dx, cy + dy)))
          return { cx: cx + dx, cy: cy + dy };
  return { cx, cy };
}
