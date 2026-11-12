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
  /**
   * Connected-area label per cell (0 = blocked); two cells are mutually reachable iff their labels match.
   * Lets an unreachable goal be rejected at once instead of searching the whole map.
   */
  region: Int32Array;
  /**
   * Exposure per cell, 0 (good cover/concealment: woods, scrub, beside walls, hedges or houses) .. 1 (open
   * ground). Static terrain only; exposure to known enemies (dead ground) comes with spotting (M3/M4).
   */
  exposure: Float32Array;
  /** Cover preference this grid's costs include (0 = plain movement costs). */
  coverWeight: number;
}

export function buildNavGrid(
  map: MapDef, terrain: TerrainCatalog, cls: MovementClass, cellM = 2, coverWeight = 0,
  breaches: readonly { owner: "obstacle" | "building"; id: number; part: number; offsetM: number; widthM: number }[] = [],
): NavGrid {
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
  const building = new Uint8Array(n);
  for (const b of map.buildings) {
    forPolygonCells(grow(b.footprint, cellM * 0.71), cellM, cols, rows, (i) => { cost[i] = 0; building[i] = 1; });
    let cx = 0, cy = 0;
    const m = b.footprint.length / 2;
    for (let k = 0; k < b.footprint.length; k += 2) { cx += b.footprint[k]!; cy += b.footprint[k + 1]!; }
    const c = Math.floor(cx / m / cellM), r = Math.floor(cy / m / cellM);
    if (c >= 0 && r >= 0 && c < cols && r < rows) { cost[r * cols + c] = 0; building[r * cols + c] = 1; }
  }
  // Holes blown in walls: the cell at the middle of each hole is not marked by the breached stretch of wall
  // (a man gets through a metre-wide gap even though the grid is coarser; vehicles need a hole 3 m wide).
  // Another obstacle running through the same cell still blocks it.
  const holeCells = new Set<string>();
  for (const b of breaches) {
    if (b.owner !== "obstacle" || (cls !== "foot" && b.widthM < 3)) continue;
    const o = map.obstacles.find((q) => q.id === b.id);
    const i = b.part * 2;
    if (!o || i + 3 >= o.points.length) continue;
    const ax = o.points[i]!, ay = o.points[i + 1]!, bx = o.points[i + 2]!, by = o.points[i + 3]!;
    const len = sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay)) || 1;
    const c = Math.floor((ax + ((bx - ax) * b.offsetM) / len) / cellM), r = Math.floor((ay + ((by - ay) * b.offsetM) / len) / cellM);
    holeCells.add(`${r * cols + c}:${b.id}:${b.part}`);
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
      blocked = kind.vehicle[cls] === null;
      extra = 1;
    }
    const step = cellM / 4;
    for (let i = 0; i + 3 < o.points.length; i += 2) {
      const ax = o.points[i]!, ay = o.points[i + 1]!, bx = o.points[i + 2]!, by = o.points[i + 3]!;
      const len = sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay));
      const steps = Math.max(1, Math.ceil(len / step));
      const holes = breaches.filter((b) => b.owner === "obstacle" && b.id === o.id && b.part === i / 2);
      for (let s = 0; s <= steps; s++) {
        if (holes.length > 0) { const off = (len * s) / steps; if (holes.some((b) => off >= b.offsetM - b.widthM / 2 && off <= b.offsetM + b.widthM / 2)) continue; }
        const x = ax + ((bx - ax) * s) / steps, y = ay + ((by - ay) * s) / steps;
        const c = Math.floor(x / cellM), r = Math.floor(y / cellM);
        if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
        const idx = r * cols + c;
        if (holeCells.size > 0 && holeCells.has(`${idx}:${o.id}:${i / 2}`)) continue;
        if (wall[idx] === 1 && blocked) { cost[idx] = 0; continue; }
        if (wall[idx] === 1) continue; // already marked by this or another obstacle
        wall[idx] = 1;
        if (blocked) cost[idx] = 0;
        else if (cost[idx]! > 0) cost[idx] = cost[idx]! + extra;
      }
    }
  }
  const exposure = exposureMap(map, terrain, cellM, cols, rows, wall, building);

  // Cover-seeking routes: open ground costs up to (1 + coverWeight) times more, so a route may be up to that
  // much longer to stay in cover (owner decision: balanced, 0.3).
  if (coverWeight > 0) for (let i = 0; i < n; i++) if (cost[i]! > 0) cost[i] = cost[i]! * (1 + coverWeight * exposure[i]!);
  let minCost = Infinity;
  for (let i = 0; i < n; i++) if (cost[i]! > 0 && cost[i]! < minCost) minCost = cost[i]!;
  return {
    cls, cellM, cols, rows, cost, wall, minCost: Number.isFinite(minCost) ? minCost : 1,
    region: labelRegions(cols, rows, cost, wall), exposure, coverWeight,
  };
}

/** Distance (m) within which a wall, hedge or building gives a man cover. */
const COVER_NEAR_M = 4;

/**
 * Static exposure: tall vegetation conceals (cover = concealment per metre x height, capped at 1); the strip
 * next to walls, hedges, embankments and buildings gives cover (0.8). Exposure = 1 - best cover.
 */
function exposureMap(map: MapDef, terrain: TerrainCatalog, cellM: number, cols: number, rows: number, wall: Uint8Array, building: Uint8Array): Float32Array {
  const n = cols * rows;
  const cover = new Float32Array(n);
  const vegCover = map.vegetationPalette.map((id) => {
    const v = terrain.vegetation[id];
    if (!v) return 0;
    return Math.min(1, v.concealmentPerM * v.heightM * 1.5);
  });
  for (let r = 0; r < rows; r++) {
    const mr = Math.min(map.rows - 1, Math.floor(((r + 0.5) * cellM) / map.cellSizeM));
    for (let c = 0; c < cols; c++) {
      const mc = Math.min(map.cols - 1, Math.floor(((c + 0.5) * cellM) / map.cellSizeM));
      const v = map.vegetation[mr * map.cols + mc]!;
      if (v > 0) cover[r * cols + c] = vegCover[v - 1] ?? 0;
    }
  }
  const rad = Math.max(1, Math.round(COVER_NEAR_M / cellM));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (wall[i] !== 1 && building[i] !== 1) continue; // walls, hedges and buildings give cover; water does not
      for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
        const j = rr * cols + cc;
        if (cover[j]! < 0.8) cover[j] = 0.8;
      }
    }
  }
  const exposure = new Float32Array(n);
  for (let i = 0; i < n; i++) exposure[i] = 1 - cover[i]!;
  return exposure;
}

/** Exposure of the nav cell containing (x, y); 1 off the grid. */
/**
 * Is there something to rest a weapon on within arm's reach (this cell or one next to it): a wall, fence or
 * hedge, the wall of a building, or trees (a cell of full vegetation cover)?
 */
export function restWithinReach(nav: NavGrid, x: number, y: number): boolean {
  const c = Math.floor(x / nav.cellM), r = Math.floor(y / nav.cellM);
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    const cc = c + dc, rr = r + dr;
    if (cc < 0 || rr < 0 || cc >= nav.cols || rr >= nav.rows) continue;
    const i = rr * nav.cols + cc;
    if (nav.wall[i] === 1 || nav.exposure[i]! <= 0.01 || (nav.cost[i] === 0 && nav.exposure[i]! <= 0.25)) return true;
  }
  return false;
}

export function exposureAt(nav: NavGrid, x: number, y: number): number {
  const c = Math.floor(x / nav.cellM), r = Math.floor(y / nav.cellM);
  if (c < 0 || r < 0 || c >= nav.cols || r >= nav.rows) return 1;
  return nav.exposure[r * nav.cols + c]!;
}

/**
 * Best cover within `radiusM` of (x, y): the reachable open (non-wall, passable) cell minimising
 * exposure + 0.3 x distance/radius, in the same connected area. Deterministic (ties by cell index).
 */
export function bestCoverNear(nav: NavGrid, x: number, y: number, radiusM: number): { x: number; y: number } | null {
  const c0 = Math.floor(x / nav.cellM), r0 = Math.floor(y / nav.cellM);
  if (c0 < 0 || r0 < 0 || c0 >= nav.cols || r0 >= nav.rows) return null;
  const home = nav.region[r0 * nav.cols + c0]!;
  const rad = Math.ceil(radiusM / nav.cellM);
  let best = -1, bestScore = Infinity;
  for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) {
    const d = sqrt(dr * dr + dc * dc) * nav.cellM;
    if (d > radiusM) continue;
    const c = c0 + dc, r = r0 + dr;
    if (c < 0 || r < 0 || c >= nav.cols || r >= nav.rows) continue;
    const i = r * nav.cols + c;
    if (nav.cost[i]! <= 0 || nav.wall[i] === 1 || (home !== 0 && nav.region[i] !== home)) continue;
    const score = nav.exposure[i]! + (0.3 * d) / radiusM;
    if (score < bestScore || (score === bestScore && i < best)) { bestScore = score; best = i; }
  }
  if (best < 0) return null;
  return { x: ((best % nav.cols) + 0.5) * nav.cellM, y: (Math.floor(best / nav.cols) + 0.5) * nav.cellM };
}

/** Flood-fill connected areas using exactly the moves A* may make (8 neighbours, no corner cutting). */
function labelRegions(cols: number, rows: number, cost: Float32Array, wall: Uint8Array): Int32Array {
  const region = new Int32Array(cols * rows);
  const stack = new Int32Array(cols * rows);
  let label = 0;
  for (let i0 = 0; i0 < region.length; i0++) {
    if (cost[i0]! <= 0 || region[i0] !== 0) continue;
    label++;
    let sp = 0;
    stack[sp++] = i0;
    region[i0] = label;
    while (sp > 0) {
      const cur = stack[--sp]!;
      const cc = cur % cols, cr = (cur - cc) / cols;
      for (let k = 0; k < 8; k++) {
        const nc = cc + DC[k]!, nr = cr + DR[k]!;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const ni = nr * cols + nc;
        if (cost[ni]! <= 0 || region[ni] !== 0) continue;
        if (k >= 4) {
          const a = cr * cols + nc, b = nr * cols + cc;
          if (cost[a]! <= 0 || cost[b]! <= 0 || wall[a] === 1 || wall[b] === 1) continue;
        }
        region[ni] = label;
        stack[sp++] = ni;
      }
    }
  }
  return region;
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
export function nearestPassable(nav: NavGrid, x: number, y: number, radius: number, region = 0): number {
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
        if (region !== 0 && nav.region[i] !== region) continue;
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
  const W = nav.cols * nav.cellM, H = nav.rows * nav.cellM;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H;
  const cellOf = (x: number, y: number) => Math.floor(y / nav.cellM) * C + Math.floor(x / nav.cellM);
  const startRaw = inside(sx, sy) ? cellOf(sx, sy) : -1;
  const start = startRaw >= 0 && nav.cost[startRaw]! > 0
    ? startRaw
    : nearestPassable(nav, Math.min(Math.max(sx, 0), W - 0.01), Math.min(Math.max(sy, 0), H - 0.01), 6);
  if (start < 0) return null;
  const reg = nav.region[start]!;
  let goal = inside(gx, gy) ? cellOf(gx, gy) : -1;
  let goalX = gx, goalY = gy;
  if (goal < 0 || nav.cost[goal]! <= 0 || nav.wall[goal] === 1 || nav.region[goal] !== reg) {
    // Blocked, off the map or in an area that cannot be reached: nearest reachable open cell, if close.
    goal = nearestPassable(nav, Math.min(Math.max(gx, 0), W - 0.01), Math.min(Math.max(gy, 0), H - 0.01), o.snapCells ?? 12, reg);
    if (goal >= 0) { goalX = ((goal % C) + 0.5) * nav.cellM; goalY = (Math.floor(goal / C) + 0.5) * nav.cellM; }
  }
  if (goal < 0) return null;
  const gc = goal % C, gr = (goal - gc) / C;
  // Weighted A*: the heuristic is scaled above the admissible minimum (HEURISTIC_WEIGHT x a 1.0-cost cell),
  // which cuts the search on 2 km maps several-fold; routes are at most ~10 % costlier than optimal.
  // On cover-seeking grids open ground costs up to (1 + coverWeight): scale the estimate to match, or the
  // search would explore far too much (most of a 2 km map is open).
  const hk = HEURISTIC_WEIGHT * (1 + 0.7 * nav.coverWeight);
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
 * from the anchor crosses no blocked or wall cell and costs no more than the part of the route it replaces.
 */
function smooth(nav: NavGrid, cells: number[], sx: number, sy: number, gx: number, gy: number): number[] {
  const C = nav.cols, m = nav.cellM;
  const cx = (i: number) => ((i % C) + 0.5) * m, cy = (i: number) => (Math.floor(i / C) + 0.5) * m;
  // Cumulative route cost (metres at nominal speed) up to each cell, as A* counted it.
  const cum = new Float64Array(cells.length);
  for (let j = 1; j < cells.length; j++) {
    const a = cells[j - 1]!, b = cells[j]!;
    const diag = a % C !== b % C && Math.floor(a / C) !== Math.floor(b / C);
    cum[j] = cum[j - 1]! + (diag ? SQRT2 : 1) * m * 0.5 * (nav.cost[a]! + nav.cost[b]!);
  }
  const out: number[] = [];
  let ax = sx, ay = sy, a = 0;
  while (a < cells.length - 1) {
    let best = a + 1;
    let fails = 0;
    for (let j = a + 1; j < cells.length; j++) {
      const tx = j === cells.length - 1 ? gx : cx(cells[j]!), ty = j === cells.length - 1 ? gy : cy(cells[j]!);
      const c = lineCost(nav, ax, ay, tx, ty);
      if (c >= 0 && c <= (cum[j]! - cum[a]!) * 1.02 + m) { best = j; fails = 0; }
      else if (++fails > 8) break; // far past the last good shortcut: stop looking
    }
    const tx = best === cells.length - 1 ? gx : cx(cells[best]!), ty = best === cells.length - 1 ? gy : cy(cells[best]!);
    out.push(tx, ty);
    ax = tx; ay = ty; a = best;
  }
  if (out.length === 0 || out[out.length - 2] !== gx || out[out.length - 1] !== gy) out.push(gx, gy);
  return out;
}

/**
 * Walk every cell a straight line passes through (grid traversal, including both cells beside an exact corner
 * crossing). Returns the line's cost (metres x cell cost), or -1 if it touches a blocked or wall cell or leaves
 * the grid. Corner crossings are refused if either side cell is blocked or a wall, as in A*.
 */
export function lineCost(nav: NavGrid, ax: number, ay: number, bx: number, by: number): number {
  const m = nav.cellM, C = nav.cols;
  let c = Math.floor(ax / m), r = Math.floor(ay / m);
  const ec = Math.floor(bx / m), er = Math.floor(by / m);
  const ok = (cc: number, rr: number) => cc >= 0 && rr >= 0 && cc < C && rr < nav.rows && nav.cost[rr * C + cc]! > 0 && nav.wall[rr * C + cc] !== 1;
  if (!ok(c, r)) return -1;
  const dx = bx - ax, dy = by - ay;
  const len = sqrt(dx * dx + dy * dy);
  if (len === 0) return 0;
  const stepC = dx > 0 ? 1 : -1, stepR = dy > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? Math.abs(m / dx) : Infinity, tDeltaY = dy !== 0 ? Math.abs(m / dy) : Infinity;
  let tMaxX = dx !== 0 ? ((dx > 0 ? (c + 1) * m : c * m) - ax) / dx : Infinity;
  let tMaxY = dy !== 0 ? ((dy > 0 ? (r + 1) * m : r * m) - ay) / dy : Infinity;
  let t = 0, cost = 0;
  for (let guard = 0; guard < 100000; guard++) {
    const tNext = Math.min(tMaxX, tMaxY, 1);
    cost += (tNext - t) * len * nav.cost[r * C + c]!;
    t = tNext;
    if (t >= 1 || (c === ec && r === er)) {
      if (t < 1) cost += (1 - t) * len * nav.cost[r * C + c]!;
      return cost;
    }
    if (Math.abs(tMaxX - tMaxY) < 1e-12) {
      // Exactly through a corner: both side cells must be open (no squeezing between two wall cells).
      if (!ok(c + stepC, r) || !ok(c, r + stepR)) return -1;
      c += stepC; r += stepR; tMaxX += tDeltaX; tMaxY += tDeltaY;
    } else if (tMaxX < tMaxY) { c += stepC; tMaxX += tDeltaX; }
    else { r += stepR; tMaxY += tDeltaY; }
    if (!ok(c, r)) return -1;
  }
  return -1;
}

/** Does the straight line stay on passable, wall-free cells (every cell it crosses)? */
export function clearLine(nav: NavGrid, ax: number, ay: number, bx: number, by: number): boolean {
  return lineCost(nav, ax, ay, bx, by) >= 0;
}
