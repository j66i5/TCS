/**
 * ORDER PLANNER (M5, owner decision 2026-11-12): the move target is a marker in the shape of the unit's
 * formation that the player drags about — a bar for a line, a wedge for a wedge — with an arrow for the facing
 * and a handle to make it wider or narrower. A route can have several points, each leg with its own pace.
 * Pure logic (no DOM, no simulation state changes): the app draws the geometry and sends `planToOrder`.
 */
import type { Order } from "@tcs/sim";

export type PlanKind = "move" | "assault" | "withdraw";
export interface PlanPoint { x: number; y: number; mode: string }
export interface Plan {
  kind: PlanKind;
  /** Where the unit is now (the route starts here; used for the default facing). */
  from: { x: number; y: number };
  points: PlanPoint[];
  formation: string;
  /** null = along the last leg. */
  facing: number | null;
  frontageM: number;
}
export type Handle = "body" | "rotate" | "resize" | { point: number };

export interface MarkerGeometry {
  centre: { x: number; y: number };
  facing: number;
  /** Where each man will stand. */
  men: { x: number; y: number }[];
  arrowTip: { x: number; y: number };
  /** Handle positions (world, m). No width handle for a formation without width (a file). */
  rotate: { x: number; y: number };
  resize: { x: number; y: number } | null;
  /** How far the width handle sits beyond the outermost man, m (kept while dragging it). */
  resizeGapM: number;
}

export function newPlan(kind: PlanKind, from: { x: number; y: number }, formation: string, frontageM: number): Plan {
  return { kind, from: { ...from }, points: [], formation, facing: null, frontageM };
}

/** Add a route point (a move has as many as wanted; assault and withdraw one). */
export function addPoint(plan: Plan, x: number, y: number, mode: string): Plan {
  const p = { x, y, mode };
  return { ...plan, points: plan.kind === "move" ? [...plan.points, p] : [p] };
}

export function undoPoint(plan: Plan): Plan {
  return { ...plan, points: plan.points.slice(0, -1) };
}

/** Width of a formation's slot pattern in slot units (0 for a file). */
export function slotSpan(slots: readonly (readonly [number, number])[], n: number): number {
  const rs = slotsFor(slots, n).map((s) => s[0]);
  return rs.length ? Math.max(...rs) - Math.min(...rs) : 0;
}

function slotsFor(slots: readonly (readonly [number, number])[], n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    if (i < slots.length) out.push([slots[i]![0], slots[i]![1]]);
    else { const last = slots[slots.length - 1]!; out.push([last[0], last[1] + (i - slots.length + 1)]); }
  }
  return out;
}

export function planFacing(plan: Plan): number {
  if (plan.facing !== null) return plan.facing;
  const end = plan.points[plan.points.length - 1];
  if (!end) return 0;
  const prev = plan.points.length >= 2 ? plan.points[plan.points.length - 2]! : plan.from;
  return Math.atan2(end.y - prev.y, end.x - prev.x);
}

/**
 * The marker at the last point: the men laid out as the simulation will lay them out (slot turned to the
 * facing, spaced to the frontage; a file keeps the doctrine spacing `defaultSpacingM`).
 */
export function markerGeometry(plan: Plan, slots: readonly (readonly [number, number])[], men: number, defaultSpacingM: number, minHandleM = 0): MarkerGeometry | null {
  const end = plan.points[plan.points.length - 1];
  if (!end) return null;
  const face = planFacing(plan);
  const fx = Math.cos(face), fy = Math.sin(face);
  const ss = slotsFor(slots, Math.max(1, men));
  const span = slotSpan(slots, Math.max(1, men));
  const sp = span > 1e-6 ? plan.frontageM / span : defaultSpacingM;
  const pos = ss.map(([r, b]) => ({ x: end.x - fy * r * sp - fx * b * sp, y: end.y + fx * r * sp - fy * b * sp }));
  const half = span > 1e-6 ? plan.frontageM / 2 : 0;
  // Handles stay at least `minHandleM` from the centre (the app passes a fixed distance on screen), so a finger
  // on the marker does not grab a handle when zoomed out; the turn handle ahead, the width handle to the side.
  const arrowLen = Math.max(10, half * 0.8, minHandleM);
  const gap = Math.max(3, minHandleM - half);
  return {
    centre: { x: end.x, y: end.y }, facing: face, men: pos,
    arrowTip: { x: end.x + fx * arrowLen, y: end.y + fy * arrowLen },
    rotate: { x: end.x + fx * (arrowLen + 4), y: end.y + fy * (arrowLen + 4) },
    resize: span > 1e-6 ? { x: end.x - fy * (half + gap), y: end.y + fx * (half + gap) } : null,
    resizeGapM: gap,
  };
}

/** Which part of the plan is under the finger: the nearest one within `tolM` metres. */
export function hitHandle(plan: Plan, g: MarkerGeometry | null, x: number, y: number, tolM: number): Handle | null {
  const d = (p: { x: number; y: number }) => Math.hypot(p.x - x, p.y - y);
  const cands: [Handle, number][] = [];
  if (g && plan.kind === "move") {
    cands.push(["rotate", d(g.rotate)]);
    if (g.resize) cands.push(["resize", d(g.resize)]);
  }
  if (g) cands.push(["body", Math.min(d(g.centre), ...g.men.map(d))]);
  else if (plan.points.length > 0) cands.push(["body", d(plan.points[plan.points.length - 1]!)]);
  for (let i = plan.points.length - 2; i >= 0; i--) cands.push([{ point: i }, d(plan.points[i]!)]);
  let best: Handle | null = null, bestD = tolM;
  for (const [h, dd] of cands) if (dd <= bestD) { best = h; bestD = dd; }
  return best;
}

/** Drag a handle to a world point. */
export function dragTo(plan: Plan, h: Handle, x: number, y: number, limits = { minFrontageM: 2, maxFrontageM: 200, resizeGapM: 3 }): Plan {
  const pts = plan.points.map((p) => ({ ...p }));
  const end = pts[pts.length - 1];
  if (!end) return plan;
  if (h === "body") { end.x = x; end.y = y; return { ...plan, points: pts }; }
  if (h === "rotate") return { ...plan, facing: Math.atan2(y - end.y, x - end.x) };
  if (h === "resize") {
    // Half the frontage = distance from the centre across the facing.
    const face = planFacing(plan), fx = Math.cos(face), fy = Math.sin(face);
    const across = Math.abs((x - end.x) * -fy + (y - end.y) * fx);
    return { ...plan, frontageM: Math.min(limits.maxFrontageM, Math.max(limits.minFrontageM, 2 * (across - limits.resizeGapM))) };
  }
  const p = pts[h.point];
  if (p) { p.x = x; p.y = y; }
  return { ...plan, points: pts };
}

/** The order for the plan (null if it has no point). Facing and frontage go with a move. */
export function planToOrder(plan: Plan, issuer: string, target: number, tick: number): Order | null {
  const end = plan.points[plan.points.length - 1];
  if (!end) return null;
  if (plan.kind === "assault" || plan.kind === "withdraw") return { tick, issuer, target, kind: plan.kind, x: end.x, y: end.y };
  return {
    tick, issuer, target, kind: "move", waypoints: plan.points.map((p) => ({ x: p.x, y: p.y, mode: p.mode })),
    formation: plan.formation, facing: planFacing(plan), frontageM: plan.frontageM,
  };
}
