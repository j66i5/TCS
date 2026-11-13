/**
 * Map gestures for orders (the "controls" step, owner choices S1, S2, S9, S10, S12 of 2026-11-13): pure helpers
 * the app uses to turn a press, a drag and a release into the existing ORDERS. Nothing here changes the
 * simulation; the line-of-sight preview is a read-only query on the map (terrain, walls, roofs, vegetation and the
 * hulls the player's side knows of), never on enemies the side has not found.
 */
import { sight, type Order, type SimContext } from "@tcs/sim";

type Pt = { x: number; y: number };
type MoveOrder = Extract<Order, { kind: "move" }>;

/** Order modes that end after one order unless locked (S12). Move plans, so it never "ends". */
export function modeAfterOrder<M extends string>(mode: M, locked: boolean): M | "move" {
  return locked ? mode : "move";
}

/** Two clicks on the same mode button within `windowMs`: a double-tap (S12: it locks the mode on). */
export const DOUBLE_TAP_MS = 400;
export function isDoubleTap(prev: { mode: string; at: number } | null, mode: string, at: number, windowMs = DOUBLE_TAP_MS): boolean {
  return prev !== null && prev.mode === mode && at - prev.at >= 0 && at - prev.at <= windowMs;
}

/** Is the point on the unit: within `tolM` of one of its places (men on foot, hulls)? */
export function onUnitAt(places: readonly Pt[], x: number, y: number, tolM: number): boolean {
  for (const p of places) if ((p.x - x) ** 2 + (p.y - y) ** 2 <= tolM * tolM) return true;
  return false;
}

export function centreOf(places: readonly Pt[]): Pt | null {
  if (places.length === 0) return null;
  let x = 0, y = 0;
  for (const p of places) { x += p.x; y += p.y; }
  return { x: x / places.length, y: y / places.length };
}

/**
 * Where the facing handle (S9) of a halted unit sits: ahead of the unit along its facing, `gapM` beyond the man
 * farthest forward (`bodyM` beyond the centre at least: a hull's half length).
 */
export function facingHandleAt(centre: Pt, places: readonly Pt[], facing: number, gapM: number, bodyM = 0): Pt {
  const fx = Math.cos(facing), fy = Math.sin(facing);
  let ahead = bodyM;
  for (const p of places) ahead = Math.max(ahead, (p.x - centre.x) * fx + (p.y - centre.y) * fy);
  const d = ahead + gapM;
  return { x: centre.x + fx * d, y: centre.y + fy * d };
}

/**
 * S9: turning in place is a move with a facing to where the unit stands. A formation is laid out round its marker
 * point (the leader ahead, the others behind), so the point is shifted by the slots' mean: the men's middle stays.
 * `slotsAt` = where the men would stand with the marker at `centre`.
 */
export function inPlacePoint(centre: Pt, slotsAt: readonly Pt[]): Pt {
  const m = centreOf(slotsAt);
  return m ? { x: 2 * centre.x - m.x, y: 2 * centre.y - m.y } : { ...centre };
}

/**
 * S10: an active move's marker dragged elsewhere: the same move (pace of its last leg, formation, frontage) straight
 * to the new point, facing along the way there from where the unit is now. Earlier route points are dropped.
 */
export function retargetMove(prev: MoveOrder, to: Pt, from: Pt, tick: number): MoveOrder {
  const last = prev.waypoints[prev.waypoints.length - 1];
  const wp = { x: to.x, y: to.y, mode: last?.mode ?? "walk", ...(last?.reverse ? { reverse: true as const } : {}) };
  return {
    tick, issuer: prev.issuer, target: prev.target, kind: "move", waypoints: [wp],
    ...(prev.formation !== undefined ? { formation: prev.formation } : {}),
    ...(prev.frontageM !== undefined ? { frontageM: prev.frontageM } : {}),
    ...(prev.facing !== undefined && Math.hypot(to.x - from.x, to.y - from.y) > 0.5 ? { facing: Math.atan2(to.y - from.y, to.x - from.x) } : prev.facing !== undefined ? { facing: prev.facing } : {}),
  };
}

/** One sight line of the preview (S2): from a man's eyes to the point; solid up to `stopAt` (0..1), broken after. */
export interface LosLine { x0: number; y0: number; x1: number; y1: number; stopAt: number; clear: boolean }
/** An eye of the selected unit: a man on foot, or a hull's sights (`ignore` = its own hull, else -1). */
export interface Eye { x: number; y: number; z: number; ignore: number }

/** Below this share of the view getting through (vegetation, see-through fences) a line counts as blocked. */
export const LOS_CLEAR_MIN = 0.2;

/**
 * The preview lines from each eye to (tx, ty, tz). `unknownHull(x, y)` names a hull at the point where a line was
 * stopped by a vehicle that the player's side does not know (its id, else -1): the line is tried again through it,
 * so the preview never gives away an enemy vehicle the side has not seen.
 */
export function losPreview(ctx: SimContext, eyes: readonly Eye[], tx: number, ty: number, tz: number, unknownHull: (x: number, y: number) => number): LosLine[] {
  const out: LosLine[] = [];
  for (const e of eyes) {
    let a = e.ignore, b = -1;
    let s = sight(ctx, e.x, e.y, e.z, tx, ty, tz, a, b);
    for (let k = 0; k < 2 && s.blockedBy === "vehicle"; k++) {
      const hx = e.x + (tx - e.x) * s.blockedAt, hy = e.y + (ty - e.y) * s.blockedAt;
      const vid = unknownHull(hx, hy);
      if (vid < 0) break;
      if (a < 0) a = vid; else b = vid;
      s = sight(ctx, e.x, e.y, e.z, tx, ty, tz, a, b);
    }
    const clear = s.blockedBy === null && s.visibility >= LOS_CLEAR_MIN;
    out.push({ x0: e.x, y0: e.y, x1: tx, y1: ty, clear, stopAt: clear ? 1 : s.blockedBy !== null ? Math.max(0, Math.min(1, s.blockedAt)) : 0 });
  }
  return out;
}
