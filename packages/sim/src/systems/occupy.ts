/**
 * OCCUPY A BUILDING (M7.5d, plan m7.5 §6): a squad takes the window places of a house, on every floor, those
 * facing the enemy first; the men left over take places inside (`indoorSpots`). Each man goes by his own route
 * (doors, rooms, stairs) and stands or kneels at his window facing out, by the window's sill.
 */
import type { SimContext } from "../context";
import type { EntityId } from "../ids";
import type { Waypoint } from "../orders";
import type { SimState } from "../state";
import { atan2, cos, hypot2, sin } from "../math";
import { indoorSpots, routeBetween, routeWaypoints, type IndoorSpot } from "../interior-nav";
import { wallPoint } from "../interior";
import { roomAt } from "../interior";
import { navFor } from "../navctx";
import type { Posture } from "../orders";

/** How far inside the wall a man stands at a window, m (plan §6: 0.5 m). */
const WINDOW_IN_M = 0.5;

/** A window place: where he stands, the way he faces, his floor's height and the posture that clears the sill. */
export interface WindowPlace extends IndoorSpot { floor: number; posture: Posture; normalX: number; normalY: number }

/** Index in `map.buildings` of the building with id `id` (with an interior), or -1. */
export function buildingIndex(ctx: SimContext, id: number): number {
  const bs = ctx.map.buildings;
  for (let i = 0; i < bs.length; i++) if (bs[i]!.id === id) return bs[i]!.interior ? i : -1;
  return -1;
}

/** Every window place of building `bi` (all floors), in opening order. */
export function windowPlaces(ctx: SimContext, bi: number): WindowPlace[] {
  const b = ctx.map.buildings[bi]!;
  const P = ctx.catalog.body.postures;
  const out: WindowPlace[] = [];
  for (const o of b.openings) {
    if (o.kind !== "window") continue;
    const floor = o.floor ?? 0;
    const d = wallPoint(b.footprint, o.wall, o.offsetM, o.widthM, WINDOW_IN_M, 0);
    if (roomAt(b, floor, d.ix, d.iy) < 0) continue;
    const nx = d.x - d.ix, ny = d.y - d.iy, nl = hypot2(nx, ny) || 1;
    // He kneels if his rifle clears the sill that way, else he stands.
    const posture: Posture = o.sillM + 0.25 <= P.crouching.muzzleHeightM ? "crouching" : "standing";
    out.push({ x: d.ix, y: d.iy, heading: atan2(ny, nx), z: floor * b.storeyHeightM, floor, posture, normalX: nx / nl, normalY: ny / nl });
  }
  return out;
}

/**
 * The places for `n` men occupying building `bi`: window places facing `facing` first (absent: spread round the
 * building, one wall after another), `floor` breaking ties (the upper floors before the ground floor otherwise:
 * they see further), never two within 1.2 m; then places inside for the rest.
 */
export function occupyPlaces(ctx: SimContext, bi: number, n: number, floor: number | undefined, facing: number | undefined): (WindowPlace | (IndoorSpot & { posture: Posture | null }))[] {
  const b = ctx.map.buildings[bi]!;
  const wins = windowPlaces(ctx, bi);
  const fx = facing === undefined ? 0 : cos(facing), fy = facing === undefined ? 0 : sin(facing);
  const score = (w: WindowPlace) => {
    const along = facing === undefined ? 0 : -(w.normalX * fx + w.normalY * fy); // -1 best (facing that way)
    const fl = floor === undefined ? -w.floor * 0.01 : (w.floor === floor ? -0.05 : 0.01 * Math.abs(w.floor - floor));
    return along + fl;
  };
  const order = wins.map((w, i) => ({ w, i, s: score(w) }));
  order.sort((p, q) => p.s - q.s || p.i - q.i);
  let picked: WindowPlace[] = [];
  if (facing === undefined) {
    // Round the walls: the best window of each wall in turn.
    const byWall = new Map<number, WindowPlace[]>();
    for (const { w } of order) {
      const key = Math.round(w.heading * 4 / Math.PI);
      const l = byWall.get(key);
      if (l) l.push(w); else byWall.set(key, [w]);
    }
    const keys = [...byWall.keys()].sort((a, c) => a - c);
    for (let r = 0; picked.length < wins.length; r++) {
      let any = false;
      for (const k of keys) { const w = byWall.get(k)![r]; if (w) { picked.push(w); any = true; } }
      if (!any) break;
    }
  } else picked = order.map((o) => o.w);
  const out: (WindowPlace | (IndoorSpot & { posture: Posture | null }))[] = [];
  for (const w of picked) {
    if (out.length >= n) break;
    if (out.some((q) => q.z === w.z && hypot2(q.x - w.x, q.y - w.y) < 1.2)) continue;
    out.push(w);
  }
  if (out.length < n) {
    const c = centre(b.footprint);
    const extra = indoorSpots(ctx, bi, c[0], c[1], n * 3, floor ?? 0);
    for (const s of extra) {
      if (out.length >= n) break;
      if (out.some((q) => q.z === s.z && hypot2(q.x - s.x, q.y - s.y) < 1.0)) continue;
      out.push({ ...s, posture: "crouching" });
    }
  }
  return out;
}

function centre(fp: readonly number[]): [number, number] {
  let x = 0, y = 0;
  const n = fp.length / 2;
  for (let i = 0; i < n; i++) { x += fp[i * 2]!; y += fp[i * 2 + 1]!; }
  return [x / n, y / n];
}

/** Send the men to their places in building `bi` (ascending id order is the caller's). Returns how many go. */
export function occupyBuilding(ctx: SimContext, state: SimState, soldiers: readonly EntityId[], bi: number, floor: number | undefined, facing: number | undefined, windowIndex?: number, mode: string = "run"): number {
  let places = occupyPlaces(ctx, bi, soldiers.length + (windowIndex === undefined ? 0 : 1), floor, facing);
  if (windowIndex !== undefined) {
    // M7.5e: the first man to exactly that window; the others to the next places not at it.
    const w = windowPlaces(ctx, bi)[windowIndex];
    if (!w) return 0;
    places = [w, ...places.filter((q) => q.z !== w.z || hypot2(q.x - w.x, q.y - w.y) >= 1.2)].slice(0, soldiers.length);
  }
  if (places.length === 0) return 0;
  const { search } = navFor(ctx, "foot");
  let sent = 0;
  soldiers.forEach((s, k) => {
    const p = places[k % places.length]!;
    const t = state.transform.get(s), m = state.mover.get(s);
    if (!t || !m) return;
    const leg = routeBetween(ctx, search, t.x, t.y, p.x, p.y, { maxExpansions: 8000, snapCells: 3 }, { sz: t.z, gz: p.z });
    if (!leg) return;
    m.waypoints = routeWaypoints<Waypoint>(leg, { x: 0, y: 0, mode });
    // A man already in his place: just turn and take the posture.
    m.formation = null;
    m.slotLagM = 0;
    m.endHeading = p.heading;
    m.endPosture = p.posture;
    sent++;
  });
  return sent;
}
