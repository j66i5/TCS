/**
 * Contour lines as vectors for the photo look (review fix): the old layer was a 1 px/m raster stretched up, so at
 * 2-7 px/m every map pixel became a stair step. Here the lines are found once per map by marching squares over the
 * terrain heights (sampled every `step` metres, bilinear between the map's height nodes) and drawn as one-pixel lines,
 * sharp at every zoom. Pure (no Pixi, no DOM): segments as flat arrays (ax, ay, bx, by), minor and major apart.
 */
import { heightAt, type MapDef } from "@tcs/sim";

export const CONTOUR_INTERVAL_M = 2.5;
/** Every fourth line (10 m) is a major one. */
export const CONTOUR_MAJOR_EVERY = 4;

export interface ContourSegments { minor: Float32Array; major: Float32Array }

/** The contour segments of a map, sampled every `step` metres (default: half a height cell, 1-4 m). */
export function contourSegments(map: MapDef, step = Math.min(4, Math.max(1, map.cellSizeM / 2)), interval = CONTOUR_INTERVAL_M): ContourSegments {
  const nx = Math.max(1, Math.ceil(map.widthM / step)), ny = Math.max(1, Math.ceil(map.heightM / step));
  const W = nx + 1, hts = new Float64Array(W * (ny + 1));
  const height = heightAt;
  for (let j = 0; j <= ny; j++) {
    const y = Math.min(map.heightM, j * step);
    // ground: ok (presentation: contour lines of the terrain picture)
    for (let i = 0; i <= nx; i++) hts[j * W + i] = height(map, Math.min(map.widthM, i * step), y);
  }
  const minor: number[] = [], major: number[] = [];
  const xs = (i: number) => Math.min(map.widthM, i * step), ys = (j: number) => Math.min(map.heightM, j * step);
  // Crossing point on an edge between two samples (linear).
  const cross = (h0: number, h1: number, L: number) => { const t = (L - h0) / (h1 - h0); return t < 0 ? 0 : t > 1 ? 1 : t; };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const h00 = hts[j * W + i]!, h10 = hts[j * W + i + 1]!, h01 = hts[(j + 1) * W + i]!, h11 = hts[(j + 1) * W + i + 1]!;
    const lo = Math.min(h00, h10, h01, h11), hi = Math.max(h00, h10, h01, h11);
    // Levels strictly inside (lo, hi]: a level exactly at a corner belongs to one side only (no double lines).
    let k = Math.floor(lo / interval) + 1;
    const kEnd = Math.floor(hi / interval);
    if (k > kEnd) continue;
    const x0 = xs(i), x1 = xs(i + 1), y0 = ys(j), y1 = ys(j + 1);
    for (; k <= kEnd; k++) {
      const L = k * interval;
      // Corner states (1: at or above the level); the crossing on each edge where the state changes.
      const s00 = h00 >= L, s10 = h10 >= L, s01 = h01 >= L, s11 = h11 >= L;
      const pts: number[] = [];
      if (s00 !== s10) pts.push(x0 + (x1 - x0) * cross(h00, h10, L), y0); // top
      if (s10 !== s11) pts.push(x1, y0 + (y1 - y0) * cross(h10, h11, L)); // right
      if (s01 !== s11) pts.push(x0 + (x1 - x0) * cross(h01, h11, L), y1); // bottom
      if (s00 !== s01) pts.push(x0, y0 + (y1 - y0) * cross(h00, h01, L)); // left
      const out = Math.round(L / interval) % CONTOUR_MAJOR_EVERY === 0 ? major : minor;
      if (pts.length === 4) out.push(pts[0]!, pts[1]!, pts[2]!, pts[3]!);
      else if (pts.length === 8) {
        // Saddle: join by the centre's side (top-right with right-bottom or top-left).
        const centreUp = (h00 + h10 + h01 + h11) / 4 >= L;
        if (centreUp === s00) out.push(pts[0]!, pts[1]!, pts[2]!, pts[3]!, pts[4]!, pts[5]!, pts[6]!, pts[7]!);
        else out.push(pts[0]!, pts[1]!, pts[6]!, pts[7]!, pts[2]!, pts[3]!, pts[4]!, pts[5]!);
      }
    }
  }
  return { minor: Float32Array.from(minor), major: Float32Array.from(major) };
}
