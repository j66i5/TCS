/**
 * INTERIOR NAVIGATION (M7.5c, plan §5): a small graph per building interior (ground floor), joined to the outdoor
 * grid at the doors (and holes blown in the walls), and `routeBetween`, which plans a route for a man between any
 * two points, indoors or out.
 *
 * - Nodes: each doorway of an inner wall gives two nodes 0.4 m either side of it (joined through the doorway);
 *   each exterior door or breach a node just inside it, with the point just outside where the outdoor route
 *   starts or ends. Rooms are convex, so every two nodes of one room are joined by a straight edge.
 * - Search: Dijkstra over the few nodes, ties broken by node index (deterministic).
 * - The outdoor grid is untouched (buildings stay blocked cells): a route between two outdoor points is exactly
 *   `findPath` as before (outdoor routes byte-identical, plan §1.4).
 * Derived data (from the map and the breaches), rebuilt when a breach is added; never saved.
 */
import type { SimContext } from "./context";
import type { Building } from "./map";
import { atan2, hypot2 } from "./math";
import { pointInPolygon } from "./terrain";
import { findPath, type NavSearch, type PathOptions, type PathResult } from "./nav";
import { roofAt } from "./ballistics";
import { exteriorDoors, roomAt, wallFrame, wallPoint } from "./interior";

/** How far either side of a doorway its two nodes lie, m. */
const DOOR_NODE_M = 0.4;
/** A hole narrower than this is no way in or out, m. */
const MIN_BREACH_M = 0.5;

export interface InteriorNode {
  x: number; y: number;
  /** Room (index into `interior.rooms`, ground floor). */
  room: number;
  /** An exit: the point just outside the wall (-1: not an exit). */
  ox: number; oy: number;
  exit: boolean;
}

export interface InteriorGraph {
  bi: number;
  nodes: InteriorNode[];
  /** Per room: its nodes (ascending). */
  roomNodes: number[][];
  /** Edges through doorways (pairs of node indices, either side). */
  through: number[];
  /** Number of breaches the graph was built with. */
  breaches: number;
}

/** Index (in `map.buildings`) of the building with an interior that (x, y) is inside, or -1. */
export function indoorAt(ctx: SimContext, x: number, y: number): number {
  if (!(ctx.hasInteriors ??= anyInterior(ctx))) return -1;
  const ri = roofAt(ctx.ballistics, ctx.mapIndex, x, y);
  if (ri < 0) return -1;
  return ctx.map.buildings[ri]?.interior ? ri : -1;
}

function anyInterior(ctx: SimContext): boolean {
  for (const b of ctx.map.buildings) if (b.interior) return true;
  return false;
}

/** The interior graph of building `bi` (built lazily, rebuilt after a breach). */
export function interiorGraph(ctx: SimContext, bi: number): InteriorGraph | null {
  const b = ctx.map.buildings[bi];
  if (!b?.interior) return null;
  const nb = ctx.breaches?.length ?? 0;
  const cache = (ctx.interiorNav ??= {});
  const g = cache[bi];
  if (g && g.breaches === nb) return g;
  const built = buildInteriorGraph(b, bi, ctx.breaches ?? []);
  built.breaches = nb;
  cache[bi] = built;
  return built;
}

type BreachRec = { owner: "obstacle" | "building"; id: number; part: number; offsetM: number; widthM: number };

export function buildInteriorGraph(b: Building, bi: number, breaches: readonly BreachRec[]): InteriorGraph {
  const it = b.interior!;
  const nodes: InteriorNode[] = [];
  const through: number[] = [];
  const nf = b.footprint.length / 2;
  const add = (x: number, y: number, exit: boolean, ox = -1, oy = -1): number => {
    const room = roomAt(b, 0, x, y);
    if (room < 0) return -1;
    nodes.push({ x, y, room, ox, oy, exit });
    return nodes.length - 1;
  };
  const doorway = (w: { ax: number; ay: number; bx: number; by: number }, offsetM: number) => {
    const f = wallFrame(w);
    const cx = w.ax + f.ux * offsetM, cy = w.ay + f.uy * offsetM;
    const a = add(cx + f.nx * DOOR_NODE_M, cy + f.ny * DOOR_NODE_M, false);
    const c = add(cx - f.nx * DOOR_NODE_M, cy - f.ny * DOOR_NODE_M, false);
    if (a >= 0 && c >= 0) through.push(a, c);
  };
  for (const w of it.walls) {
    if (w.floor !== 0) continue;
    for (const d of w.doors) doorway(w, d.offsetM);
  }
  for (const d of exteriorDoors(b)) add(d.ix, d.iy, true, d.ox, d.oy);
  for (const br of breaches) {
    if (br.owner !== "building" || br.id !== b.id || br.widthM < MIN_BREACH_M) continue;
    if (br.part < nf) {
      const d = wallPoint(b.footprint, br.part, br.offsetM, br.widthM, 0.45, 0.6);
      add(d.ix, d.iy, true, d.ox, d.oy);
    } else {
      const w = it.walls[br.part - nf];
      if (w && w.floor === 0) doorway(w, br.offsetM);
    }
  }
  const roomNodes: number[][] = it.rooms.map(() => []);
  nodes.forEach((n, i) => roomNodes[n.room]!.push(i));
  return { bi, nodes, roomNodes, through, breaches: 0 };
}

/** The room (ground floor) of a point inside building b; a point on a wall goes to the nearest room centre. */
function roomOf(b: Building, x: number, y: number): number {
  const r = roomAt(b, 0, x, y);
  if (r >= 0) return r;
  let best = -1, bd = Infinity;
  b.interior!.rooms.forEach((rm, i) => {
    if (rm.floor !== 0) return;
    let mx = 0, my = 0;
    const n = rm.poly.length / 2;
    for (let k = 0; k < n; k++) { mx += rm.poly[k * 2]!; my += rm.poly[k * 2 + 1]!; }
    const d = hypot2(mx / n - x, my / n - y);
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

/**
 * Shortest route inside one building from (sx, sy) to (gx, gy): points (start exclusive, goal inclusive) and its
 * length; the goal may instead be any exit (`toExit`: then the route ends at that exit's inside node, `exitNode`).
 */
function innerRoute(g: InteriorGraph, b: Building, sx: number, sy: number, gx: number, gy: number, goalNode = -1): { points: number[]; cost: number } | null {
  const rs = roomOf(b, sx, sy);
  if (rs < 0) return null;
  const nodes = g.nodes, N = nodes.length;
  const rg = goalNode >= 0 ? -1 : roomOf(b, gx, gy);
  if (goalNode < 0 && rs === rg) return { points: [gx, gy], cost: hypot2(gx - sx, gy - sy) };
  if (goalNode >= 0 && nodes[goalNode]!.room === rs) return { points: [nodes[goalNode]!.x, nodes[goalNode]!.y], cost: hypot2(nodes[goalNode]!.x - sx, nodes[goalNode]!.y - sy) };
  const dist = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), done = new Uint8Array(N);
  for (const i of g.roomNodes[rs]!) dist[i] = hypot2(nodes[i]!.x - sx, nodes[i]!.y - sy);
  // Doorway partners, for quick lookup.
  const partner = new Int32Array(N).fill(-1);
  for (let k = 0; k + 1 < g.through.length; k += 2) { partner[g.through[k]!] = g.through[k + 1]!; partner[g.through[k + 1]!] = g.through[k]!; }
  let bestEnd = -1, bestCost = Infinity;
  for (;;) {
    let u = -1, du = Infinity;
    for (let i = 0; i < N; i++) if (!done[i] && dist[i]! < du) { du = dist[i]!; u = i; }
    if (u < 0 || du >= bestCost) break;
    done[u] = 1;
    const nu = nodes[u]!;
    if (goalNode >= 0 ? u === goalNode : nu.room === rg) {
      const c = goalNode >= 0 ? du : du + hypot2(gx - nu.x, gy - nu.y);
      if (c < bestCost) { bestCost = c; bestEnd = u; }
    }
    const relax = (v: number, c: number) => { if (!done[v] && c < dist[v]!) { dist[v] = c; prev[v] = u; } };
    for (const v of g.roomNodes[nu.room]!) if (v !== u) relax(v, du + hypot2(nodes[v]!.x - nu.x, nodes[v]!.y - nu.y));
    const p = partner[u]!;
    if (p >= 0) relax(p, du + hypot2(nodes[p]!.x - nu.x, nodes[p]!.y - nu.y));
  }
  if (bestEnd < 0) return null;
  const chain: number[] = [];
  for (let v = bestEnd; v >= 0; v = prev[v]!) chain.push(v);
  chain.reverse();
  const points: number[] = [];
  for (const v of chain) points.push(nodes[v]!.x, nodes[v]!.y);
  if (goalNode < 0) points.push(gx, gy);
  return { points, cost: bestCost };
}

/** The exits of a building's graph (node indices, ascending). */
function exits(g: InteriorGraph): number[] {
  const out: number[] = [];
  g.nodes.forEach((n, i) => { if (n.exit) out.push(i); });
  return out;
}

/**
 * A route for a man on foot between two points, either of which may be inside a building with an interior.
 * Outdoor to outdoor: exactly `findPath`. Otherwise through the cheapest door (or breach): inside along the
 * interior graph, outside along the outdoor grid (`search`). Same shape as `findPath`'s result; an indoor goal
 * is kept (never snapped to an outdoor cell).
 */
export function routeBetween(ctx: SimContext, search: NavSearch, sx: number, sy: number, gx: number, gy: number, o: PathOptions = {}): PathResult | null {
  if (search.nav.cls !== "foot") return findPath(search, sx, sy, gx, gy, o);
  const bs = indoorAt(ctx, sx, sy), bg = indoorAt(ctx, gx, gy);
  if (bs < 0 && bg < 0) return findPath(search, sx, sy, gx, gy, o);
  const map = ctx.map;
  if (bs >= 0 && bs === bg) {
    const g = interiorGraph(ctx, bs)!;
    const r = innerRoute(g, map.buildings[bs]!, sx, sy, gx, gy);
    if (r) return { points: r.points, cost: r.cost, expanded: 0, goalX: gx, goalY: gy };
    // Rooms not joined (should not happen: validated): out by one door and in by another below.
  }
  const gs = bs >= 0 ? interiorGraph(ctx, bs) : null, gg = bg >= 0 ? interiorGraph(ctx, bg) : null;
  const outs = gs ? exits(gs) : [-1], ins = gg ? exits(gg) : [-1];
  const outdoorOpts: PathOptions = { ...o, snapCells: Math.max(o.snapCells ?? 12, 3) };
  let best: PathResult | null = null;
  for (const e of outs) {
    let pre: { points: number[]; cost: number } | null = null, fx = sx, fy = sy;
    if (gs) {
      pre = innerRoute(gs, map.buildings[bs]!, sx, sy, 0, 0, e);
      if (!pre) continue;
      const n = gs.nodes[e]!;
      pre = { points: [...pre.points, n.ox, n.oy], cost: pre.cost + hypot2(n.ox - n.x, n.oy - n.y) };
      fx = n.ox; fy = n.oy;
    }
    for (const en of ins) {
      let tx = gx, ty = gy;
      if (gg) { const n = gg.nodes[en]!; tx = n.ox; ty = n.oy; }
      const mid = findPath(search, fx, fy, tx, ty, outdoorOpts);
      if (!mid) continue;
      let cost = (pre?.cost ?? 0) + mid.cost;
      const points = [...(pre?.points ?? []), ...mid.points];
      let goalX = mid.goalX, goalY = mid.goalY;
      if (gg) {
        const n = gg.nodes[en]!;
        points.push(n.ox, n.oy, n.x, n.y);
        cost += hypot2(mid.goalX - n.ox, mid.goalY - n.oy) + hypot2(n.ox - n.x, n.oy - n.y);
        const post = innerRoute(gg, map.buildings[bg]!, n.x, n.y, gx, gy);
        if (!post) continue;
        points.push(...post.points);
        cost += post.cost;
        goalX = gx; goalY = gy;
      }
      if (!best || cost < best.cost) best = { points, cost, expanded: mid.expanded, goalX, goalY };
    }
  }
  return best;
}

/**
 * Places for `n` men inside building `bi`, starting in the room containing (x, y), then the other ground-floor
 * rooms nearest to it (indoors: no formation, plan §5). In each room, places by a window first ("indoor cover":
 * a man takes post at a window, plan §5 `seekCoverIndoor`), then the rest on a 0.9 m grid kept 0.45 m off the
 * walls and clear of doorways; a room takes about one man per 2.5 m2. With more men than places, places repeat.
 * Each place carries the heading the man faces (out of the window, or away from the room's centre).
 */
export function indoorSpots(ctx: SimContext, bi: number, x: number, y: number, n: number): { x: number; y: number; heading: number }[] {
  const b = ctx.map.buildings[bi]!;
  const g = interiorGraph(ctx, bi)!;
  const it = b.interior!;
  const r0 = roomOf(b, x, y);
  const rooms: number[] = [];
  it.rooms.forEach((rm, i) => { if (rm.floor === 0) rooms.push(i); });
  const cen = (i: number) => {
    const p = it.rooms[i]!.poly, k = p.length / 2;
    let mx = 0, my = 0;
    for (let q = 0; q < k; q++) { mx += p[q * 2]!; my += p[q * 2 + 1]!; }
    return [mx / k, my / k] as const;
  };
  rooms.sort((i, j) => (i === r0 ? -1 : j === r0 ? 1 : hypot2(cen(i)[0] - x, cen(i)[1] - y) - hypot2(cen(j)[0] - x, cen(j)[1] - y) || i - j));
  const windows: { ix: number; iy: number; x: number; y: number }[] = [];
  for (const o of b.openings) {
    if (o.kind !== "window" || (o.floor ?? 0) !== 0) continue;
    const d = wallPoint(b.footprint, o.wall, o.offsetM, o.widthM, 0.5, 0);
    windows.push({ ix: d.ix, iy: d.iy, x: d.x, y: d.y });
  }
  const out: { x: number; y: number; heading: number }[] = [];
  for (const ri of rooms) {
    if (out.length >= n) break;
    const poly = it.rooms[ri]!.poly, k = poly.length / 2;
    const [cx, cy] = cen(ri);
    const edgeDist = (px: number, py: number) => {
      let m = Infinity;
      for (let q = 0; q < k; q++) {
        const ax = poly[q * 2]!, ay = poly[q * 2 + 1]!, bx = poly[((q + 1) % k) * 2]!, by = poly[((q + 1) % k) * 2 + 1]!;
        const ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey || 1;
        let u = ((px - ax) * ex + (py - ay) * ey) / l2;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const d = hypot2(px - (ax + u * ex), py - (ay + u * ey));
        if (d < m) m = d;
      }
      return m;
    };
    const clearOfDoors = (px: number, py: number) => g.nodes.every((nd) => hypot2(nd.x - px, nd.y - py) > 0.6);
    const ux0 = poly[2]! - poly[0]!, uy0 = poly[3]! - poly[1]!, ul = hypot2(ux0, uy0) || 1;
    const ux = ux0 / ul, uy = uy0 / ul, vx = -uy, vy = ux;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (let q = 0; q < k; q++) {
      const pa = (poly[q * 2]! - cx) * ux + (poly[q * 2 + 1]! - cy) * uy, pb = (poly[q * 2]! - cx) * vx + (poly[q * 2 + 1]! - cy) * vy;
      if (pa < a0) a0 = pa; if (pa > a1) a1 = pa; if (pb < b0) b0 = pb; if (pb > b1) b1 = pb;
    }
    const area = (a1 - a0) * (b1 - b0);
    const cap = Math.max(1, Math.floor(area / 2.5));
    const cand: { x: number; y: number; heading: number; w: number }[] = [];
    for (const w of windows) {
      if (!pointInPolygon(poly, w.ix, w.iy) || edgeDist(w.ix, w.iy) < 0.3 || !clearOfDoors(w.ix, w.iy)) continue;
      cand.push({ x: w.ix, y: w.iy, heading: atan2(w.y - w.iy, w.x - w.ix), w: 0 });
    }
    for (let a = a0 + 0.45; a <= a1 - 0.45 + 1e-9; a += 0.9) for (let bb = b0 + 0.45; bb <= b1 - 0.45 + 1e-9; bb += 0.9) {
      const px = cx + ux * a + vx * bb, py = cy + uy * a + vy * bb;
      if (!pointInPolygon(poly, px, py) || edgeDist(px, py) < 0.44 || !clearOfDoors(px, py)) continue;
      if (cand.some((c) => hypot2(c.x - px, c.y - py) < 0.8)) continue;
      cand.push({ x: px, y: py, heading: atan2(py - cy, px - cx), w: 1 + hypot2(px - x, py - y) / 100 });
    }
    cand.sort((p, q) => p.w - q.w);
    for (let q = 0; q < cand.length && q < cap && out.length < n; q++) out.push({ x: cand[q]!.x, y: cand[q]!.y, heading: cand[q]!.heading });
  }
  if (out.length === 0) out.push({ x, y, heading: 0 });
  for (let i = 0; out.length < n; i++) out.push(out[i]!);
  return out;
}
