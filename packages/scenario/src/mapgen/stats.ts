/** Map statistics and validity checks, used by tests, the `npm run map` tool and generator tuning. */
import { cellIndex, hypot2, pointInPolygon, type MapDef } from "@tcs/sim";
import { along as alongPts, bbox, convexOverlap, distToPolyline, polylineLength } from "./geom";

export interface MapStats {
  cells: number;
  /** Share of cells per surface / vegetation, 0..1. */
  surface: Record<string, number>;
  vegetation: Record<string, number>;
  buildings: Record<string, number>;
  buildingCount: number;
  /** Total length per obstacle kind, m. */
  obstacleM: Record<string, number>;
  roadM: Record<string, number>;
  water: number;
  heightMin: number;
  heightMax: number;
}

export function mapStats(m: MapDef): MapStats {
  const n = m.cols * m.rows;
  const surface: Record<string, number> = {}, vegetation: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const s = m.surfacePalette[m.surface[i]!]!;
    surface[s] = (surface[s] ?? 0) + 1 / n;
    const v = m.vegetation[i]!;
    if (v > 0) { const id = m.vegetationPalette[v - 1]!; vegetation[id] = (vegetation[id] ?? 0) + 1 / n; }
  }
  const buildings: Record<string, number> = {};
  for (const b of m.buildings) buildings[b.kind] = (buildings[b.kind] ?? 0) + 1;
  const obstacleM: Record<string, number> = {};
  for (const o of m.obstacles) obstacleM[o.kind] = (obstacleM[o.kind] ?? 0) + polylineLength(o.points);
  const roadM: Record<string, number> = {};
  for (const r of m.roads) roadM[r.surface] = (roadM[r.surface] ?? 0) + polylineLength(r.points);
  let hmin = Infinity, hmax = -Infinity;
  for (const h of m.heights) { if (h < hmin) hmin = h; if (h > hmax) hmax = h; }
  return { cells: n, surface, vegetation, buildings, buildingCount: m.buildings.length, obstacleM, roadM, water: m.water.length, heightMin: hmin, heightMax: hmax };
}

/**
 * Geometric validity: buildings inside the map, not overlapping each other, not on roads or in water;
 * obstacles inside the map; heights finite. Returns a list of problems (empty = valid).
 */
export function checkMap(m: MapDef): string[] {
  const p: string[] = [];
  for (const h of m.heights) if (!Number.isFinite(h)) { p.push("non-finite height"); break; }
  const bbs = m.buildings.map((b) => bbox(b.footprint));
  m.buildings.forEach((b, i) => {
    const bb = bbs[i]!;
    if (bb.x0 < 0 || bb.y0 < 0 || bb.x1 > m.widthM || bb.y1 > m.heightM) p.push(`building ${b.id} outside the map`);
    for (let j = i + 1; j < m.buildings.length; j++) {
      const ob = bbs[j]!;
      if (ob.x1 < bb.x0 || ob.x0 > bb.x1 || ob.y1 < bb.y0 || ob.y0 > bb.y1) continue;
      if (convexOverlap(b.footprint, m.buildings[j]!.footprint)) p.push(`buildings ${b.id} and ${m.buildings[j]!.id} overlap`);
    }
    // centre of the building must not be on a road or in water
    let cx = 0, cy = 0;
    for (let k = 0; k < b.footprint.length; k += 2) { cx += b.footprint[k]!; cy += b.footprint[k + 1]!; }
    cx /= b.footprint.length / 2; cy /= b.footprint.length / 2;
    for (const r of m.roads) {
      if (distToPolyline(cx, cy, r.points) < r.widthM / 2) p.push(`building ${b.id} stands on road ${r.id}`);
    }
    for (const w of m.water) {
      if (w.kind === "pond" ? pointInPolygon(w.points, cx, cy) : distToPolyline(cx, cy, w.points) < w.widthM / 2) p.push(`building ${b.id} stands in water ${w.id}`);
    }
    const ci = cellIndex(m, cx, cy);
    if (ci >= 0 && m.surfacePalette[m.surface[ci]!] !== "floor") p.push(`building ${b.id}: floor not painted under it`);
  });
  for (const o of m.obstacles) {
    for (let k = 0; k < o.points.length; k += 2) {
      const x = o.points[k]!, y = o.points[k + 1]!;
      if (x < 0 || y < 0 || x > m.widthM || y > m.heightM) { p.push(`obstacle ${o.id} leaves the map`); break; }
    }
  }
  // Roads must connect: every road reaches the map edge or touches/crosses another road somewhere.
  for (const r of m.roads) {
    const n = r.points.length;
    const atEdge = [[r.points[0]!, r.points[1]!], [r.points[n - 2]!, r.points[n - 1]!]].some(([x, y]) => x! <= 1 || y! <= 1 || x! >= m.widthM - 1 || y! >= m.heightM - 1);
    let touches = false;
    const len = polylineLength(r.points);
    for (let s = 0; s <= len && !touches; s += 5) {
      const q = alongPts(r.points, s);
      touches = m.roads.some((o) => o !== r && distToPolyline(q.x, q.y, o.points) < o.widthM / 2 + r.widthM / 2 + 2);
    }
    if (!atEdge && !touches) p.push(`road ${r.id} is not connected to the network or the map edge`);
  }
  void hypot2;
  return p;
}
