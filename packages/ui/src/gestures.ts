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
 * Review fix (S9): the shape the men stand in, measured along `facing`: how deep (front to back) and how wide
 * (left to right), m. A turn in place keeps it (a column stays a column) instead of re-forming into the default.
 */
export function shapeOf(places: readonly Pt[], facing: number): { depthM: number; widthM: number } {
  if (places.length === 0) return { depthM: 0, widthM: 0 };
  const fx = Math.cos(facing), fy = Math.sin(facing);
  let a0 = Infinity, a1 = -Infinity, r0 = Infinity, r1 = -Infinity;
  for (const p of places) {
    const a = p.x * fx + p.y * fy, r = -p.x * fy + p.y * fx;
    a0 = Math.min(a0, a); a1 = Math.max(a1, a); r0 = Math.min(r0, r); r1 = Math.max(r1, r);
  }
  return { depthM: a1 - a0, widthM: r1 - r0 };
}

/** The formation a turn in place keeps: deep and narrow a file, wide and shallow a line, else the default. */
export function turnFormation(shape: { depthM: number; widthM: number }, has: (id: string) => boolean, fallback: string): string {
  if (shape.depthM > 1.5 * shape.widthM + 1 && has("file")) return "file";
  if (shape.widthM > 1.5 * shape.depthM + 1 && has("line")) return "line";
  return fallback;
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

/** The most unknown hulls one preview line looks through (more: the line counts as blocked there). */
export const LOS_MAX_UNKNOWN = 8;

/**
 * The preview lines from each eye to (tx, ty, tz). `unknownHull(x, y)` names a hull at the point where a line was
 * stopped by a vehicle that the player's side does not know (its id, else -1): the line goes on from that point
 * with the hull ignored (and the view so far kept), as often as it meets such hulls, so the preview never gives
 * away an enemy vehicle the side has not seen.
 */
export function losPreview(ctx: SimContext, eyes: readonly Eye[], tx: number, ty: number, tz: number, unknownHull: (x: number, y: number) => number): LosLine[] {
  const out: LosLine[] = [];
  for (const e of eyes) {
    // The line in pieces: from (sx, sy, sz) at share t0 of the whole, ignoring the eye's own hull and the unknown
    // hull the piece starts at; the view through each piece multiplies.
    let sx = e.x, sy = e.y, sz = e.z, t0 = 0, vis = 1, skip = -1;
    let s = sight(ctx, sx, sy, sz, tx, ty, tz, e.ignore, skip);
    for (let k = 0; k < LOS_MAX_UNKNOWN && s.blockedBy === "vehicle"; k++) {
      const hx = sx + (tx - sx) * s.blockedAt, hy = sy + (ty - sy) * s.blockedAt;
      const vid = unknownHull(hx, hy);
      if (vid < 0) break;
      // The view through the piece up to the hull (a blocked sight reports none): the same line, stopped 5 cm short.
      const len = Math.hypot(tx - sx, ty - sy, tz - sz), back = len > 0 ? Math.max(0, s.blockedAt - 0.05 / len) : 0;
      const piece = sight(ctx, sx, sy, sz, sx + (tx - sx) * back, sy + (ty - sy) * back, sz + (tz - sz) * back, e.ignore, skip);
      vis *= piece.visibility;
      t0 = t0 + (1 - t0) * s.blockedAt;
      sx = hx; sy = hy; sz = sz + (tz - sz) * s.blockedAt; skip = vid;
      s = sight(ctx, sx, sy, sz, tx, ty, tz, e.ignore, skip);
    }
    const visibility = vis * s.visibility;
    const clear = s.blockedBy === null && visibility >= LOS_CLEAR_MIN;
    const at = s.blockedBy !== null ? t0 + (1 - t0) * Math.max(0, Math.min(1, s.blockedAt)) : 0;
    out.push({ x0: e.x, y0: e.y, x1: tx, y1: ty, clear, stopAt: clear ? 1 : at });
  }
  return out;
}
