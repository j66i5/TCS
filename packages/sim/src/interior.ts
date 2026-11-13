/**
 * BUILDING INTERIORS (M7.5c): queries over a building's rooms, inner walls and stairs, and their validity checks.
 * Pure geometry on the map; no state. Rooms are convex polygons; inner walls are segments from floor to ceiling
 * with always-open doorways (plan §7.8).
 */
import type { Building, InnerWall } from "./map";
import { hypot2 } from "./math";
import { pointInPolygon } from "./terrain";

/** Index (into `interior.rooms`) of the room on `floor` containing (x, y), or -1. */
export function roomAt(b: Building, floor: number, x: number, y: number): number {
  const rooms = b.interior?.rooms;
  if (!rooms) return -1;
  for (let i = 0; i < rooms.length; i++) {
    const r = rooms[i]!;
    if (r.floor === floor && pointInPolygon(r.poly, x, y)) return i;
  }
  return -1;
}

/** Unit normal of an inner wall (left of a -> b in screen coordinates) and its length. */
export function wallFrame(w: Pick<InnerWall, "ax" | "ay" | "bx" | "by">): { len: number; ux: number; uy: number; nx: number; ny: number } {
  const ex = w.bx - w.ax, ey = w.by - w.ay;
  const len = hypot2(ex, ey) || 1;
  return { len, ux: ex / len, uy: ey / len, nx: -ey / len, ny: ex / len };
}

/** Is a convex polygon convex (all turns one way) and are all its corners inside or on the footprint? */
function convexInside(poly: readonly number[], fp: readonly number[]): boolean {
  const n = poly.length / 2;
  if (n < 3) return false;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const ax = poly[i * 2]!, ay = poly[i * 2 + 1]!, bx = poly[((i + 1) % n) * 2]!, by = poly[((i + 1) % n) * 2 + 1]!, cx = poly[((i + 2) % n) * 2]!, cy = poly[((i + 2) % n) * 2 + 1]!;
    const cr = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (cr > 1e-6) { if (sign < 0) return false; sign = 1; } else if (cr < -1e-6) { if (sign > 0) return false; sign = -1; }
  }
  // Corners inside: tested a little towards the polygon's centre (corners lie on the outer wall).
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += poly[i * 2]!; my += poly[i * 2 + 1]!; }
  mx /= n; my /= n;
  for (let i = 0; i < n; i++) {
    const x = poly[i * 2]!, y = poly[i * 2 + 1]!, d = hypot2(mx - x, my - y) || 1;
    if (!pointInPolygon(fp, x + ((mx - x) / d) * 0.05, y + ((my - y) / d) * 0.05) && distToOutline(fp, x, y) > 0.05) return false;
  }
  return true;
}

/** Distance from a point to a polygon's outline. */
function distToOutline(poly: readonly number[], x: number, y: number): number {
  const n = poly.length / 2;
  let m = Infinity;
  for (let i = 0; i < n; i++) {
    const ax = poly[i * 2]!, ay = poly[i * 2 + 1]!, bx = poly[((i + 1) % n) * 2]!, by = poly[((i + 1) % n) * 2 + 1]!;
    const ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey || 1;
    let u = ((x - ax) * ex + (y - ay) * ey) / l2;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const d = hypot2(x - ax - u * ex, y - ay - u * ey);
    if (d < m) m = d;
  }
  return m;
}

/**
 * Validity of a building's interior: every floor has rooms, rooms convex and inside the footprint, every
 * doorway on its wall, every room reachable from an exterior door (through doorways; upper floors by the stairs).
 */
export function interiorProblems(b: Building): string[] {
  const p: string[] = [];
  const it = b.interior;
  if (!it) return p;
  const tag = `building ${b.id}`;
  for (let fl = 0; fl < b.storeys; fl++) if (!it.rooms.some((r) => r.floor === fl)) p.push(`${tag}: floor ${fl} has no rooms`);
  it.rooms.forEach((r) => { if (!convexInside(r.poly, b.footprint)) p.push(`${tag}: room ${r.id} is not convex inside the footprint`); });
  for (const w of it.walls) {
    const { len } = wallFrame(w);
    for (const d of w.doors) if (d.offsetM - d.widthM / 2 < -1e-6 || d.offsetM + d.widthM / 2 > len + 1e-6) p.push(`${tag}: a doorway of wall ${w.id} is off the wall`);
  }
  // Reachability: rooms joined through doorways (the rooms just either side of each), stairs and outer doors.
  const parent = it.rooms.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const join = (i: number, j: number) => { if (i >= 0 && j >= 0) parent[find(i)] = find(j); };
  for (const w of it.walls) {
    const f = wallFrame(w);
    for (const d of w.doors) {
      const cx = w.ax + f.ux * d.offsetM, cy = w.ay + f.uy * d.offsetM;
      join(roomAt(b, w.floor, cx + f.nx * 0.3, cy + f.ny * 0.3), roomAt(b, w.floor, cx - f.nx * 0.3, cy - f.ny * 0.3));
    }
  }
  for (const s of it.stairs) join(roomAt(b, s.floor, s.x0, s.y0), roomAt(b, s.floor + 1, s.x1, s.y1));
  const outside = new Set<number>();
  for (const e of exteriorDoors(b)) { const r = roomAt(b, 0, e.ix, e.iy); if (r >= 0) outside.add(find(r)); }
  if (outside.size === 0 && it.rooms.length > 0) p.push(`${tag}: no exterior door opens into a room`);
  else it.rooms.forEach((r, i) => { if (!outside.has(find(i))) p.push(`${tag}: room ${r.id} (floor ${r.floor}) cannot be reached from a door`); });
  return p;
}

/** An exterior door: its centre on the wall, a point just inside (ix, iy) and one just outside (ox, oy). */
export interface DoorPoint { wall: number; offsetM: number; widthM: number; x: number; y: number; ix: number; iy: number; ox: number; oy: number }

/** Exterior doors of a building (ground floor), with points `inM` inside and `outM` outside the wall. */
export function exteriorDoors(b: Building, inM = 0.45, outM = 0.6): DoorPoint[] {
  const out: DoorPoint[] = [];
  const fp = b.footprint, n = fp.length / 2;
  for (const o of b.openings) {
    if (o.kind !== "door" || (o.floor ?? 0) !== 0 || o.wall >= n) continue;
    out.push(wallPoint(fp, o.wall, o.offsetM, o.widthM, inM, outM));
  }
  return out;
}

/** A point on outer wall `wall` at `offsetM`, with points inside and outside. */
export function wallPoint(fp: readonly number[], wall: number, offsetM: number, widthM: number, inM: number, outM: number): DoorPoint {
  const n = fp.length / 2;
  const ax = fp[wall * 2]!, ay = fp[wall * 2 + 1]!, bx = fp[((wall + 1) % n) * 2]!, by = fp[((wall + 1) % n) * 2 + 1]!;
  const len = hypot2(bx - ax, by - ay) || 1;
  const ux = (bx - ax) / len, uy = (by - ay) / len;
  const x = ax + ux * offsetM, y = ay + uy * offsetM;
  // Outward normal: the side away from the footprint's centre.
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += fp[i * 2]!; my += fp[i * 2 + 1]!; }
  mx /= n; my /= n;
  let nx = -uy, ny = ux;
  if ((mx - x) * nx + (my - y) * ny > 0) { nx = -nx; ny = -ny; }
  return { wall, offsetM, widthM, x, y, ix: x - nx * inM, iy: y - ny * inM, ox: x + nx * outM, oy: y + ny * outM };
}
