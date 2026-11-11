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
 * Geometric validity: buildings inside the map, not overlapping each other, no corner or centre on a road
 * or in water, floor painted under them; obstacles inside the map and not crossing any road; every connected
 * group of roads reaches the map edge. Returns a list of problems (empty = valid).
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
    let cx = 0, cy = 0;
    for (let k = 0; k < b.footprint.length; k += 2) { cx += b.footprint[k]!; cy += b.footprint[k + 1]!; }
    cx /= b.footprint.length / 2; cy /= b.footprint.length / 2;
    const probes: [number, number][] = [[cx, cy]];
    for (let k = 0; k < b.footprint.length; k += 2) probes.push([b.footprint[k]!, b.footprint[k + 1]!]);
    for (const r of m.roads) {
      if (probes.some(([x, y]) => distToPolyline(x, y, r.points) < r.widthM / 2)) { p.push(`building ${b.id} stands on road ${r.id}`); }
    }
    for (const w of m.water) {
      const wet = probes.some(([x, y]) => (w.kind === "pond" ? pointInPolygon(w.points, x, y) : distToPolyline(x, y, w.points) < w.widthM / 2));
      if (wet) p.push(`building ${b.id} stands in water ${w.id}`);
    }
    const ci = cellIndex(m, cx, cy);
    if (ci >= 0 && m.surfacePalette[m.surface[ci]!] !== "floor") p.push(`building ${b.id}: floor not painted under it`);
  });
  for (const o of m.obstacles) {
    for (let k = 0; k < o.points.length; k += 2) {
      const x = o.points[k]!, y = o.points[k + 1]!;
      if (x < 0 || y < 0 || x > m.widthM || y > m.heightM) { p.push(`obstacle ${o.id} leaves the map`); break; }
    }
    if (o.kind === "embankment") continue; // railway embankments cross roads on bridges
    for (const r of m.roads) {
      if (polylinesCross(o.points, r.points)) { p.push(`obstacle ${o.id} (${o.kind}) crosses road ${r.id}`); break; }
    }
  }
  // Road network: group roads that touch; every group must reach the map edge.
  const n = m.roads.length;
  const parent = m.roads.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const atEdge = m.roads.map((r) => {
    for (let k = 0; k < r.points.length; k += 2) {
      const x = r.points[k]!, y = r.points[k + 1]!;
      if (x <= EDGE_TOL || y <= EDGE_TOL || x >= m.widthM - EDGE_TOL || y >= m.heightM - EDGE_TOL) return true;
    }
    return false;
  });
  for (let i = 0; i < n; i++) {
    const r = m.roads[i]!;
    const len = polylineLength(r.points);
    for (let j = i + 1; j < n; j++) {
      const o = m.roads[j]!;
      if (find(i) === find(j)) continue;
      let touch = polylinesCross(r.points, o.points);
      for (let s = 0; s <= len && !touch; s += 5) {
        const q = alongPts(r.points, s);
        touch = distToPolyline(q.x, q.y, o.points) < o.widthM / 2 + r.widthM / 2 + 2;
      }
      if (touch) parent[find(i)] = find(j);
    }
  }
  const groupAtEdge = new Map<number, boolean>();
  for (let i = 0; i < n; i++) groupAtEdge.set(find(i), (groupAtEdge.get(find(i)) ?? false) || atEdge[i]!);
  for (let i = 0; i < n; i++) if (!groupAtEdge.get(find(i))) p.push(`road ${m.roads[i]!.id} is not connected to the network or the map edge`);
  void hypot2;
  return p;
}

/** How close to the map edge a road end must be to count as leaving the map (generator uses the same). */
export const EDGE_TOL = 2.5;

function segCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Do two polylines properly intersect anywhere? */
export function polylinesCross(a: readonly number[], b: readonly number[]): boolean {
  const ab = bbox(a), bb = bbox(b);
  if (ab.x1 < bb.x0 || ab.x0 > bb.x1 || ab.y1 < bb.y0 || ab.y0 > bb.y1) return false;
  for (let i = 0; i + 3 < a.length; i += 2) {
    for (let j = 0; j + 3 < b.length; j += 2) {
      if (segCross(a[i]!, a[i + 1]!, a[i + 2]!, a[i + 3]!, b[j]!, b[j + 1]!, b[j + 2]!, b[j + 3]!)) return true;
    }
  }
  return false;
}
