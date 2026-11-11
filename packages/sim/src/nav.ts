/**
 * NAVIGATION (SPEC 6.2): a navigation grid derived from the map, and A* pathfinding over it.
 *
 * - Grid: `cellM` (default 2 m, half a terrain cell, so 1-4 m gates and gaps resolve) per movement class.
 *   cost[i] = time multiplier to cross the cell (surface x vegetation from the terrain data); 0 = blocked
 *   (buildings, deep water, impassable vegetation for vehicles, walls a class cannot cross).
 *   Wall cells (walls, fences, hedges, embankments) carry the crossing time as extra cost, so a route goes
 *   through a gate if that is quicker than climbing.
 * - Search: A* on 8 neighbours, no corner cutting past blocked or wall cells, octile heuristic scaled by the
 *   cheapest cell (admissible), deterministic tie-breaking by node index. Scratch buffers are reused across
 *   searches (generation stamps), so a search allocates almost nothing.
 * - Result: smoothed into few waypoints (straight segments only where the straight line crosses nothing
 *   costlier than the route it replaces).
 *
 * Derived data, built from the map at battle start; never saved. Paths found are stored in mover waypoints
 * (state), so saves and replays carry them.
 */
import type { MovementClass, TerrainCatalog } from "./catalog";
import type { MapDef } from "./map";
import { sqrt } from "./math";
import { cellMoveCost } from "./terrain";

/** Walking speed used to turn a wall's crossing time into a cell cost multiplier, m/s. */
const REF_SPEED_MPS = 1.4;

export interface NavGrid {
  cls: MovementClass;
  cellM: number;
  cols: number;
  rows: number;
  /** Time multiplier per cell; 0 = blocked. */
  cost: Float32Array;
  /** 1 where a wall, fence, hedge or embankment runs through the cell. */
  wall: Uint8Array;
  /** Cheapest cost on the grid (for an admissible heuristic). */
  minCost: number;
}

export function buildNavGrid(map: MapDef, terrain: TerrainCatalog, cls: MovementClass, cellM = 2): NavGrid {
  const cols = Math.ceil(map.widthM / cellM), rows = Math.ceil(map.heightM / cellM);
  const n = cols * rows;
  const cost = new Float32Array(n);
  const wall = new Uint8Array(n);
  for (let r = 0; r < rows; r++) {
    const y = (r + 0.5) * cellM;
    const mr = Math.min(map.rows - 1, Math.floor(y / map.cellSizeM));
    for (let c = 0; c < cols; c++) {
      const x = (c + 0.5) * cellM;
      const mc = Math.min(map.cols - 1, Math.floor(x / map.cellSizeM));
      const k = cellMoveCost(map, terrain, mr * map.cols + mc, cls);
      cost[r * cols + c] = k === null ? 0 : k;
    }
  }
  // Buildings are solid for now (interiors and doors come with close combat). Conservative: every cell the
  // footprint touches at all is blocked (centre test against the footprint grown by half a cell diagonal).
  for (const b of map.buildings) {
    forPolygonCells(grow(b.footprint, cellM * 0.71), cellM, cols, rows, (i) => { cost[i] = 0; });
    let cx = 0, cy = 0;
    const m = b.footprint.length / 2;
    for (let k = 0; k < b.footprint.length; k += 2) { cx += b.footprint[k]!; cy += b.footprint[k + 1]!; }
    const c = Math.floor(cx / m / cellM), r = Math.floor(cy / m / cellM);
    if (c >= 0 && r >= 0 && c < cols && r < rows) cost[r * cols + c] = 0;
  }
  // Linear obstacles: crossing penalty or blocked, per class.
  for (const o of map.obstacles) {
    const kind = terrain.obstacles[o.kind];
    if (!kind) continue;
    let blocked: boolean;
    let extra: number;
    if (cls === "foot") {
      blocked = kind.footCrossTimeS === null;
      extra = blocked ? 0 : (kind.footCrossTimeS! * REF_SPEED_MPS) / cellM;
    } else {
      blocked = cls === "wheeled" ? !kind.wheeledCrossable : !kind.trackedCrossable;
      extra = 1;
    }
    const step = cellM / 4;
    for (let i = 0; i + 3 < o.points.length; i += 2) {
      const ax = o.points[i]!, ay = o.points[i + 1]!, bx = o.points[i + 2]!, by = o.points[i + 3]!;
      const len = sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay));
      const steps = Math.max(1, Math.ceil(len / step));
      for (let s = 0; s <= steps; s++) {
        const x = ax + ((bx - ax) * s) / steps, y = ay + ((by - ay) * s) / steps;
        const c = Math.floor(x / cellM), r = Math.floor(y / cellM);
        if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
        const idx = r * cols + c;
        if (wall[idx] === 1 && blocked) { cost[idx] = 0; continue; }
        if (wall[idx] === 1) continue; // already marked by this or another obstacle
        wall[idx] = 1;
        if (blocked) cost[idx] = 0;
        else if (cost[idx]! > 0) cost[idx] = cost[idx]! + extra;
      }
    }
  }
  let minCost = Infinity;
  for (let i = 0; i < n; i++) if (cost[i]! > 0 && cost[i]! < minCost) minCost = cost[i]!;
  return { cls, cellM, cols, rows, cost, wall, minCost: Number.isFinite(minCost) ? minCost : 1 };
}

/** Grow a convex polygon outward by `d` metres (each edge moved out along its normal). */
function grow(poly: readonly number[], d: number): number[] {
  const n = poly.length / 2;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += poly[i * 2]! * poly[j * 2 + 1]! - poly[j * 2]! * poly[i * 2 + 1]!;
  }
  const sgn = area >= 0 ? 1 : -1; // orientation, so "outward" is right for either winding
  const lines: [number, number, number][] = []; // nx, ny, offset of each moved edge
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ex = poly[j * 2]! - poly[i * 2]!, ey = poly[j * 2 + 1]! - poly[i * 2 + 1]!;
    const l = sqrt(ex * ex + ey * ey) || 1;
    const nx = (sgn * ey) / l, ny = (-sgn * ex) / l;
    lines.push([nx, ny, nx * poly[i * 2]! + ny * poly[i * 2 + 1]! + d]);
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const [a1, b1, c1] = lines[(i + n - 1) % n]!, [a2, b2, c2] = lines[i]!;
    const det = a1 * b2 - a2 * b1;
    if (Math.abs(det) < 1e-9) { out.push(poly[i * 2]! + a2 * d, poly[i * 2 + 1]! + b2 * d); continue; }
    out.push((c1 * b2 - c2 * b1) / det, (a1 * c2 - a2 * c1) / det);
  }
  return out;
}

function forPolygonCells(poly: readonly number[], cellM: number, cols: number, rows: number, fn: (i: number) => void): void {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let k = 0; k < poly.length; k += 2) {
    x0 = Math.min(x0, poly[k]!); x1 = Math.max(x1, poly[k]!); y0 = Math.min(y0, poly[k + 1]!); y1 = Math.max(y1, poly[k + 1]!);
  }
  const c0 = Math.max(0, Math.floor(x0 / cellM)), c1 = Math.min(cols - 1, Math.floor(x1 / cellM));
  const r0 = Math.max(0, Math.floor(y0 / cellM)), r1 = Math.min(rows - 1, Math.floor(y1 / cellM));
  const n = poly.length / 2;
  for (let r = r0; r <= r1; r++) {
    const y = (r + 0.5) * cellM;
    for (let c = c0; c <= c1; c++) {
      const x = (c + 0.5) * cellM;
      let inside = false;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = poly[i * 2]!, yi = poly[i * 2 + 1]!, xj = poly[j * 2]!, yj = poly[j * 2 + 1]!;
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) fn(r * cols + c);
    }
  }
}

/** Cost multiplier of the nav cell containing (x, y); 0 = blocked or off the grid. */
export function navCostAt(nav: NavGrid, x: number, y: number): number {
  const c = Math.floor(x / nav.cellM), r = Math.floor(y / nav.cellM);
  if (c < 0 || r < 0 || c >= nav.cols || r >= nav.rows) return 0;
  return nav.cost[r * nav.cols + c]!;
}

// ---------------------------------------------------------------- search

/** Reusable scratch memory for searches on one grid. Not state; never saved. */
export interface NavSearch {
  nav: NavGrid;
  gen: number;
  stamp: Uint32Array;
  closed: Uint32Array;
  g: Float64Array;
  parent: Int32Array;
  heap: Int32Array;
  heapF: Float64Array;
  heapSize: number;
}

export function createNavSearch(nav: NavGrid): NavSearch {
  const n = nav.cols * nav.rows;
  return {
    nav, gen: 0,
    stamp: new Uint32Array(n), closed: new Uint32Array(n),
    g: new Float64Array(n), parent: new Int32Array(n),
    heap: new Int32Array(1024), heapF: new Float64Array(1024), heapSize: 0,
  };
}

export interface PathResult {
  /** World points from start (exclusive) to goal (inclusive), smoothed. */
  points: number[];
  /** Estimated time cost in "metres at nominal speed". */
  cost: number;
  /** Nodes expanded (performance counter). */
  expanded: number;
  /** The goal actually used (snapped to the nearest passable cell if the requested one was blocked). */
  goalX: number;
  goalY: number;
}

export interface PathOptions {
  /** Give up after this many expansions (null result). Default: the whole grid. */
  maxExpansions?: number;
  /** Search radius in cells for a passable cell near a blocked goal. Default 12. */
  snapCells?: number;
}

/** Nearest passable cell to (x, y) within `radius` cells (ring search, deterministic order), or -1. */
export function nearestPassable(nav: NavGrid, x: number, y: number, radius: number): number {
  const c0 = Math.floor(x / nav.cellM), r0 = Math.floor(y / nav.cellM);
  for (let d = 0; d <= radius; d++) {
    let best = -1, bestD = Infinity;
    for (let dr = -d; dr <= d; dr++) {
      for (let dc = -d; dc <= d; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== d) continue;
        const c = c0 + dc, r = r0 + dr;
        if (c < 0 || r < 0 || c >= nav.cols || r >= nav.rows) continue;
        const i = r * nav.cols + c;
        if (nav.cost[i]! <= 0 || nav.wall[i] === 1) continue;
        const dd = dr * dr + dc * dc;
        if (dd < bestD || (dd === bestD && i < best)) { bestD = dd; best = i; }
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}

function heapPush(s: NavSearch, node: number, f: number): void {
  if (s.heapSize >= s.heap.length) {
    const h = new Int32Array(s.heap.length * 2); h.set(s.heap); s.heap = h;
    const hf = new Float64Array(s.heapF.length * 2); hf.set(s.heapF); s.heapF = hf;
  }
  let i = s.heapSize++;
  while (i > 0) {
    const p = (i - 1) >> 1;
    const pf = s.heapF[p]!, pn = s.heap[p]!;
    if (pf < f || (pf === f && pn < node)) break;
    s.heap[i] = pn; s.heapF[i] = pf;
    i = p;
  }
  s.heap[i] = node; s.heapF[i] = f;
}

function heapPop(s: NavSearch): number {
  const top = s.heap[0]!;
  const n = --s.heapSize;
  if (n > 0) {
    const node = s.heap[n]!, f = s.heapF[n]!;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      if (l >= n) break;
      let m = l;
      if (r < n && (s.heapF[r]! < s.heapF[l]! || (s.heapF[r] === s.heapF[l] && s.heap[r]! < s.heap[l]!))) m = r;
      if (s.heapF[m]! > f || (s.heapF[m] === f && s.heap[m]! > node)) break;
      s.heap[i] = s.heap[m]!; s.heapF[i] = s.heapF[m]!;
      i = m;
    }
    s.heap[i] = node; s.heapF[i] = f;
  }
  return top;
}

const SQRT2 = 1.4142135623730951;
/** Decision 2026-11-11 (DECISIONS.md): speed over strict optimality. */
export const HEURISTIC_WEIGHT = 1.1;
const DC = [1, -1, 0, 0, 1, 1, -1, -1];
const DR = [0, 0, 1, -1, 1, -1, 1, -1];

/** A* from (sx, sy) to (gx, gy). Returns null if no route exists (or the expansion budget ran out). */
export function findPath(s: NavSearch, sx: number, sy: number, gx: number, gy: number, o: PathOptions = {}): PathResult | null {
  const nav = s.nav;
  const C = nav.cols;
  const startRaw = Math.floor(sy / nav.cellM) * C + Math.floor(sx / nav.cellM);
  const start = nav.cost[startRaw]! > 0 ? startRaw : nearestPassable(nav, sx, sy, 6);
  let goal = Math.floor(gy / nav.cellM) * C + Math.floor(gx / nav.cellM);
  let goalX = gx, goalY = gy;
  if (gx < 0 || gy < 0 || gx >= nav.cols * nav.cellM || gy >= nav.rows * nav.cellM || nav.cost[goal]! <= 0 || nav.wall[goal] === 1) {
    goal = nearestPassable(nav, gx, gy, o.snapCells ?? 12);
    if (goal >= 0) { goalX = ((goal % C) + 0.5) * nav.cellM; goalY = (Math.floor(goal / C) + 0.5) * nav.cellM; }
  }
  if (start < 0 || goal < 0) return null;
  const gc = goal % C, gr = (goal - gc) / C;
  // Weighted A*: the heuristic is scaled above the admissible minimum (HEURISTIC_WEIGHT x a 1.0-cost cell),
  // which cuts the search on 2 km maps several-fold; routes are at most ~10 % costlier than optimal.
  const hk = HEURISTIC_WEIGHT;
  const h = (i: number) => {
    const c = i % C, r = (i - c) / C;
    const dx = Math.abs(c - gc), dy = Math.abs(r - gr);
    return hk * (Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy));
  };
  s.gen = (s.gen + 1) >>> 0;
  if (s.gen === 0) { s.stamp.fill(0); s.closed.fill(0); s.gen = 1; }
  const gen = s.gen;
  s.heapSize = 0;
  s.stamp[start] = gen; s.g[start] = 0; s.parent[start] = -1;
  heapPush(s, start, h(start));
  const max = o.maxExpansions ?? nav.cols * nav.rows;
  let expanded = 0;
  let found = false;
  while (s.heapSize > 0) {
    const cur = heapPop(s);
    if (s.closed[cur] === gen) continue;
    s.closed[cur] = gen;
    if (cur === goal) { found = true; break; }
    if (++expanded > max) return null;
    const cc = cur % C, cr = (cur - cc) / C;
    const ccost = nav.cost[cur]!;
    const gcur = s.g[cur]!;
    for (let k = 0; k < 8; k++) {
      const nc = cc + DC[k]!, nr = cr + DR[k]!;
      if (nc < 0 || nr < 0 || nc >= C || nr >= nav.rows) continue;
      const ni = nr * C + nc;
      const ncost = nav.cost[ni]!;
      if (ncost <= 0 || s.closed[ni] === gen) continue;
      let step = 1;
      if (k >= 4) {
        // No corner cutting past blocked or wall cells.
        const a = cr * C + nc, b = nr * C + cc;
        if (nav.cost[a]! <= 0 || nav.cost[b]! <= 0 || nav.wall[a] === 1 || nav.wall[b] === 1) continue;
        step = SQRT2;
      }
      const ng = gcur + step * 0.5 * (ccost + ncost);
      if (s.stamp[ni] !== gen || ng < s.g[ni]!) {
        s.stamp[ni] = gen; s.g[ni] = ng; s.parent[ni] = cur;
        heapPush(s, ni, ng + h(ni));
      }
    }
  }
  if (!found) return null;
  const cells: number[] = [];
  for (let i = goal; i !== -1; i = s.parent[i]!) cells.push(i);
  cells.reverse();
  const points = smooth(nav, cells, sx, sy, goalX, goalY);
  return { points, cost: s.g[goal]! * nav.cellM, expanded, goalX, goalY };
}

/**
 * Turn a cell path into few waypoints: from each anchor, jump to the farthest later cell whose straight line
 * from the anchor crosses only passable, wall-free cells no costlier than the route it replaces.
 */
function smooth(nav: NavGrid, cells: number[], sx: number, sy: number, gx: number, gy: number): number[] {
  const C = nav.cols, m = nav.cellM;
  const cx = (i: number) => ((i % C) + 0.5) * m, cy = (i: number) => (Math.floor(i / C) + 0.5) * m;
  const out: number[] = [];
  let ax = sx, ay = sy, a = 0;
  while (a < cells.length - 1) {
    let maxCost = 0;
    let best = a + 1;
    for (let j = a + 1; j < cells.length; j++) {
      maxCost = Math.max(maxCost, nav.cost[cells[j]!]!);
      const tx = j === cells.length - 1 ? gx : cx(cells[j]!), ty = j === cells.length - 1 ? gy : cy(cells[j]!);
      if (clearLine(nav, ax, ay, tx, ty, maxCost)) best = j;
      else if (j > best + 8) break; // far past the last clear point: stop looking
    }
    const tx = best === cells.length - 1 ? gx : cx(cells[best]!), ty = best === cells.length - 1 ? gy : cy(cells[best]!);
    out.push(tx, ty);
    ax = tx; ay = ty; a = best;
  }
  if (out.length === 0 || out[out.length - 2] !== gx || out[out.length - 1] !== gy) out.push(gx, gy);
  return out;
}

/** Does the straight line stay on passable, wall-free cells with cost <= maxCost (+1 %)? */
export function clearLine(nav: NavGrid, ax: number, ay: number, bx: number, by: number, maxCost: number): boolean {
  const dx = bx - ax, dy = by - ay;
  const len = sqrt(dx * dx + dy * dy);
  const steps = Math.max(1, Math.ceil(len / (nav.cellM * 0.4)));
  for (let s = 0; s <= steps; s++) {
    const x = ax + (dx * s) / steps, y = ay + (dy * s) / steps;
    const c = Math.floor(x / nav.cellM), r = Math.floor(y / nav.cellM);
    if (c < 0 || r < 0 || c >= nav.cols || r >= nav.rows) return false;
    const i = r * nav.cols + c;
    const k = nav.cost[i]!;
    if (k <= 0 || nav.wall[i] === 1 || k > maxCost * 1.01) return false;
  }
  return true;
}
