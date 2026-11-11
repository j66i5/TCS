/** 2D geometry helpers for the map generator. Transcendental maths via @tcs/sim's math module. */
import { cos, hypot2, sin, type Coords } from "@tcs/sim";

export interface Pt { x: number; y: number }

/** Corners of a rectangle centred at (cx, cy), `w` along `angle`, `d` across it. Wall 0 is the "front" (+normal side). */
export function rect(cx: number, cy: number, w: number, d: number, angle: number): Coords {
  const ux = cos(angle), uy = sin(angle); // along
  const nx = -uy, ny = ux; // across
  const hw = w / 2, hd = d / 2;
  return [
    cx - ux * hw + nx * hd, cy - uy * hw + ny * hd,
    cx + ux * hw + nx * hd, cy + uy * hw + ny * hd,
    cx + ux * hw - nx * hd, cy + uy * hw - ny * hd,
    cx - ux * hw - nx * hd, cy - uy * hw - ny * hd,
  ];
}

export function bbox(c: readonly number[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < c.length; i += 2) {
    const x = c[i]!, y = c[i + 1]!;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

/** Separating-axis overlap test for two convex polygons. */
export function convexOverlap(a: readonly number[], b: readonly number[]): boolean {
  for (const poly of [a, b]) {
    const n = poly.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = -(poly[j * 2 + 1]! - poly[i * 2 + 1]!), ay = poly[j * 2]! - poly[i * 2]!;
      let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
      for (let k = 0; k < a.length; k += 2) { const p = a[k]! * ax + a[k + 1]! * ay; if (p < amin) amin = p; if (p > amax) amax = p; }
      for (let k = 0; k < b.length; k += 2) { const p = b[k]! * ax + b[k + 1]! * ay; if (p < bmin) bmin = p; if (p > bmax) bmax = p; }
      if (amax <= bmin || bmax <= amin) return false;
    }
  }
  return true;
}

/** Grow a convex polygon outward by `m` metres (approximate, about its centroid). */
export function inflate(poly: readonly number[], m: number): Coords {
  let cx = 0, cy = 0;
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) { cx += poly[i * 2]!; cy += poly[i * 2 + 1]!; }
  cx /= n; cy /= n;
  const out: Coords = [];
  for (let i = 0; i < n; i++) {
    const dx = poly[i * 2]! - cx, dy = poly[i * 2 + 1]! - cy;
    const l = hypot2(dx, dy) || 1;
    out.push(poly[i * 2]! + (dx / l) * m * 1.42, poly[i * 2 + 1]! + (dy / l) * m * 1.42);
  }
  return out;
}

export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return hypot2(px - (ax + t * dx), py - (ay + t * dy));
}

export function distToPolyline(px: number, py: number, pts: readonly number[]): number {
  let d = Infinity;
  for (let i = 0; i + 3 < pts.length; i += 2) d = Math.min(d, distToSegment(px, py, pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!));
  return d;
}

export function polylineLength(pts: readonly number[]): number {
  let l = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) l += hypot2(pts[i + 2]! - pts[i]!, pts[i + 3]! - pts[i + 1]!);
  return l;
}

/** Point and unit tangent at arc length `s` along a polyline. */
export function along(pts: readonly number[], s: number): { x: number; y: number; tx: number; ty: number } {
  let acc = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i]!, ay = pts[i + 1]!, bx = pts[i + 2]!, by = pts[i + 3]!;
    const l = hypot2(bx - ax, by - ay);
    if (acc + l >= s || i + 4 >= pts.length) {
      const t = l > 0 ? Math.min(1, Math.max(0, (s - acc) / l)) : 0;
      return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t, tx: l > 0 ? (bx - ax) / l : 1, ty: l > 0 ? (by - ay) / l : 0 };
    }
    acc += l;
  }
  return { x: pts[0] ?? 0, y: pts[1] ?? 0, tx: 1, ty: 0 };
}

/** Polygon approximating a circle with noisy radius (ponds, clearings). */
export function blob(cx: number, cy: number, r: number, n: number, jitter: (i: number) => number): Coords {
  const out: Coords = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 6.283185307179586;
    const rr = r * (1 + jitter(i));
    out.push(cx + cos(a) * rr, cy + sin(a) * rr);
  }
  return out;
}

/** Clip a polyline to the rectangle [0,w] x [0,h] by clamping points (generator lines start/end at edges). */
export function clampPts(pts: Coords, w: number, h: number): Coords {
  return pts.map((v, i) => (i % 2 === 0 ? Math.min(w, Math.max(0, v)) : Math.min(h, Math.max(0, v))));
}
