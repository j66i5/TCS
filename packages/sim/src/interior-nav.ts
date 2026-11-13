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
  /** Room (index into `interior.rooms`; any floor). */
  room: number;
  /** Floor (0 = ground) and height above the ground, m (M7.5d). */
  floor: number; z: number;
  /** An exit: the point just outside the wall (-1: not an exit). */
  ox: number; oy: number;
  exit: boolean;
}

export interface InteriorGraph {
  bi: number;
  nodes: InteriorNode[];
  /** Per room: its nodes (ascending). */
  roomNodes: number[][];
  /** Edges through doorways and up/down stairs (pairs of node indices, either side). */
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

/** The floor a height above the ground stands on in building b (0 = ground), clamped to its storeys (M7.5d). */
export function floorAtZ(b: Building, z: number): number {
  if (!(z > 0)) return 0;
  const f = Math.floor(z / b.storeyHeightM + 0.5);
  return f < 0 ? 0 : f >= b.storeys ? b.storeys - 1 : f;
}

/** The floor a man stands on (M7.5d, derived from his position and height): 0 outdoors and on the ground floor. */
export function floorOf(ctx: SimContext, x: number, y: number, z: number): number {
  if (!(z > 0)) return 0;
  const bi = indoorAt(ctx, x, y);
  return bi < 0 ? 0 : floorAtZ(ctx.map.buildings[bi]!, z);
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

type BreachRec = { owner: "obstacle" | "building"; id: number; part: number; offsetM: number; widthM: number; sillM?: number };

/** Is (x, y) on the flight of stairs `st` as seen from `floor` (its foot floor or the floor above)? */
export function onStair(st: { floor: number; x0: number; y0: number; x1: number; y1: number; widthM: number }, floor: number, x: number, y: number): boolean {
  if (floor !== st.floor && floor !== st.floor + 1) return false;
  const ex = st.x1 - st.x0, ey = st.y1 - st.y0, l2 = ex * ex + ey * ey || 1;
  const u = ((x - st.x0) * ex + (y - st.y0) * ey) / l2;
  if (u < -0.1 || u > 1.1) return false;
  const l = hypot2(ex, ey) || 1;
  const v = Math.abs((x - st.x0) * ey - (y - st.y0) * ex) / l;
  return v <= st.widthM / 2 + 0.3;
}

/**
 * The graph of a building: ground floor first (doorways, exterior doors, breaches: the M7.5c graph, node for node),
 * then the upper floors' doorways and breaches, then the stairs (M7.5d: a node at the foot of each flight and one
 * at its head on the floor above, joined like a doorway). Appending keeps every ground-floor route as before.
 */
export function buildInteriorGraph(b: Building, bi: number, breaches: readonly BreachRec[]): InteriorGraph {
  const it = b.interior!;
  const nodes: InteriorNode[] = [];
  const through: number[] = [];
  const nf = b.footprint.length / 2;
  const add = (x: number, y: number, exit: boolean, ox = -1, oy = -1, floor = 0): number => {
    const room = roomAt(b, floor, x, y);
    if (room < 0) return -1;
    nodes.push({ x, y, room, floor, z: floor * b.storeyHeightM, ox, oy, exit });
    return nodes.length - 1;
  };
  const doorway = (w: { ax: number; ay: number; bx: number; by: number; floor: number }, offsetM: number) => {
    const f = wallFrame(w);
    const cx = w.ax + f.ux * offsetM, cy = w.ay + f.uy * offsetM;
    const a = add(cx + f.nx * DOOR_NODE_M, cy + f.ny * DOOR_NODE_M, false, -1, -1, w.floor);
    const c = add(cx - f.nx * DOOR_NODE_M, cy - f.ny * DOOR_NODE_M, false, -1, -1, w.floor);
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
      // A hole in the outer wall of a floor above (M7.5 review fix) is no way in or out.
      if ((br.sillM ?? 0) > 0) continue;
      const d = wallPoint(b.footprint, br.part, br.offsetM, br.widthM, 0.45, 0.6);
      add(d.ix, d.iy, true, d.ox, d.oy);
    } else {
      const w = it.walls[br.part - nf];
      if (w && w.floor === 0) doorway(w, br.offsetM);
    }
  }
  // Upper floors (M7.5d).
  for (const w of it.walls) {
    if (w.floor === 0) continue;
    for (const d of w.doors) doorway(w, d.offsetM);
  }
  for (const br of breaches) {
    if (br.owner !== "building" || br.id !== b.id || br.widthM < MIN_BREACH_M || br.part < nf) continue;
    const w = it.walls[br.part - nf];
    if (w && w.floor !== 0) doorway(w, br.offsetM);
  }
  for (const st of it.stairs) {
    const a = add(st.x0, st.y0, false, -1, -1, st.floor);
    const c = a >= 0 ? add(st.x1, st.y1, false, -1, -1, st.floor + 1) : -1;
    if (a >= 0 && c >= 0) through.push(a, c);
    else if (a >= 0 && c < 0) nodes.pop();
  }
  const roomNodes: number[][] = it.rooms.map(() => []);
  nodes.forEach((n, i) => roomNodes[n.room]!.push(i));
  return { bi, nodes, roomNodes, through, breaches: 0 };
}

/** The room on `floor` of a point inside building b; a point on a wall goes to the nearest room centre. */
function roomOf(b: Building, floor: number, x: number, y: number): number {
  const r = roomAt(b, floor, x, y);
  if (r >= 0) return r;
  let best = -1, bd = Infinity;
  b.interior!.rooms.forEach((rm, i) => {
    if (rm.floor !== floor) return;
    let mx = 0, my = 0;
    const n = rm.poly.length / 2;
    for (let k = 0; k < n; k++) { mx += rm.poly[k * 2]!; my += rm.poly[k * 2 + 1]!; }
    const d = hypot2(mx / n - x, my / n - y);
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

/** Route cost of a flight of stairs per metre run, relative to level floor (M7.5d; slower than walking). */
const STAIR_COST = 2.5;

interface Inner { points: number[]; zs: number[]; cost: number }

/**
 * Shortest route inside one building from (sx, sy) on floor sf to (gx, gy) on floor gf: points (start exclusive,
 * goal inclusive), their heights and its length; the goal may instead be a node (`goalNode`: an exit).
 */
function innerRoute(g: InteriorGraph, b: Building, sx: number, sy: number, sf: number, gx: number, gy: number, gf: number, goalNode = -1): Inner | null {
  const rs = roomOf(b, sf, sx, sy);
  if (rs < 0) return null;
  const nodes = g.nodes, N = nodes.length;
  const rg = goalNode >= 0 ? -1 : roomOf(b, gf, gx, gy);
  const gz = gf * b.storeyHeightM;
  if (goalNode < 0 && rs === rg) return { points: [gx, gy], zs: [gz], cost: hypot2(gx - sx, gy - sy) };
  if (goalNode >= 0 && nodes[goalNode]!.room === rs) return { points: [nodes[goalNode]!.x, nodes[goalNode]!.y], zs: [nodes[goalNode]!.z], cost: hypot2(nodes[goalNode]!.x - sx, nodes[goalNode]!.y - sy) };
  const dist = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), done = new Uint8Array(N);
  for (const i of g.roomNodes[rs]!) dist[i] = hypot2(nodes[i]!.x - sx, nodes[i]!.y - sy);
  // Doorway and stair partners, for quick lookup.
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
    if (p >= 0) relax(p, du + hypot2(nodes[p]!.x - nu.x, nodes[p]!.y - nu.y) * (nodes[p]!.floor !== nu.floor ? STAIR_COST : 1));
  }
  if (bestEnd < 0) return null;
  const chain: number[] = [];
  for (let v = bestEnd; v >= 0; v = prev[v]!) chain.push(v);
  chain.reverse();
  const points: number[] = [], zs: number[] = [];
  for (const v of chain) { points.push(nodes[v]!.x, nodes[v]!.y); zs.push(nodes[v]!.z); }
  if (goalNode < 0) { points.push(gx, gy); zs.push(gz); }
  return { points, zs, cost: bestCost };
}

/** The exits of a building's graph (node indices, ascending). */
function exits(g: InteriorGraph): number[] {
  const out: number[] = [];
  g.nodes.forEach((n, i) => { if (n.exit) out.push(i); });
  return out;
}

/** A route with the height above the ground of each point (`zs`, M7.5d: only when a floor above is involved). */
export type RouteResult = PathResult & { zs?: number[] };

/** Heights of a route's two ends above the ground (M7.5d): a man upstairs, a place on an upper floor. */
export interface RouteHeights { sz?: number; gz?: number }

/**
 * A route for a man on foot between two points, either of which may be inside a building with an interior.
 * Outdoor to outdoor: exactly `findPath`. Otherwise through the cheapest door (or breach): inside along the
 * interior graph (stairs included, M7.5d), outside along the outdoor grid (`search`). Same shape as `findPath`'s
 * result; an indoor goal is kept (never snapped to an outdoor cell). `h`: the start's and goal's heights above
 * the ground (their floors); when either is above the ground floor the result carries every point's height.
 */
export function routeBetween(ctx: SimContext, search: NavSearch, sx: number, sy: number, gx: number, gy: number, o: PathOptions = {}, h?: RouteHeights): RouteResult | null {
  if (search.nav.cls !== "foot") return findPath(search, sx, sy, gx, gy, o);
  const bs = indoorAt(ctx, sx, sy), bg = indoorAt(ctx, gx, gy);
  if (bs < 0 && bg < 0) return findPath(search, sx, sy, gx, gy, o);
  const map = ctx.map;
  const sf = bs >= 0 ? floorAtZ(map.buildings[bs]!, h?.sz ?? 0) : 0, gf = bg >= 0 ? floorAtZ(map.buildings[bg]!, h?.gz ?? 0) : 0;
  // Part way up a flight of stairs (review fix M7.5): first along the stairs to the floor he is nearer (the foot
  // or the head), then on from there; the route carries heights so the first leg brings him onto that floor.
  const sz = h?.sz ?? 0;
  if (bs >= 0 && sz > 0 && sz !== sf * map.buildings[bs]!.storeyHeightM) {
    const b = map.buildings[bs]!, H = b.storeyHeightM;
    const st = b.interior!.stairs.find((s) => sz > s.floor * H && sz < (s.floor + 1) * H && onStair(s, s.floor, sx, sy));
    if (st) {
      const head = sf > st.floor;
      const px = head ? st.x1 : st.x0, py = head ? st.y1 : st.y0, pz = sf * H;
      const rest = routeBetween(ctx, search, px, py, gx, gy, o, { sz: pz, gz: h?.gz });
      if (!rest) return null;
      const zs = rest.zs ?? rest.points.map(() => 0).slice(0, rest.points.length / 2);
      return { ...rest, points: [px, py, ...rest.points], zs: [pz, ...zs], cost: rest.cost + hypot2(px - sx, py - sy) * STAIR_COST };
    }
  }
  const withZ = sf > 0 || gf > 0 || (bs >= 0 && sz > 0);
  const fin = (r: { points: number[]; zs: number[]; cost: number; expanded: number; goalX: number; goalY: number }): RouteResult =>
    (withZ ? r : { points: r.points, cost: r.cost, expanded: r.expanded, goalX: r.goalX, goalY: r.goalY });
  if (bs >= 0 && bs === bg) {
    const g = interiorGraph(ctx, bs)!;
    const r = innerRoute(g, map.buildings[bs]!, sx, sy, sf, gx, gy, gf);
    if (r) return fin({ points: r.points, zs: r.zs, cost: r.cost, expanded: 0, goalX: gx, goalY: gy });
    // Rooms not joined (should not happen: validated): out by one door and in by another below.
  }
  const gs = bs >= 0 ? interiorGraph(ctx, bs) : null, gg = bg >= 0 ? interiorGraph(ctx, bg) : null;
  const outs = gs ? exits(gs) : [-1], ins = gg ? exits(gg) : [-1];
  const outdoorOpts: PathOptions = { ...o, snapCells: Math.max(o.snapCells ?? 12, 3) };
  let best: { points: number[]; zs: number[]; cost: number; expanded: number; goalX: number; goalY: number } | null = null;
  for (const e of outs) {
    let pre: Inner | null = null, fx = sx, fy = sy;
    if (gs) {
      pre = innerRoute(gs, map.buildings[bs]!, sx, sy, sf, 0, 0, 0, e);
      if (!pre) continue;
      const n = gs.nodes[e]!;
      pre = { points: [...pre.points, n.ox, n.oy], zs: [...pre.zs, 0], cost: pre.cost + hypot2(n.ox - n.x, n.oy - n.y) };
      fx = n.ox; fy = n.oy;
    }
    for (const en of ins) {
      let tx = gx, ty = gy;
      if (gg) { const n = gg.nodes[en]!; tx = n.ox; ty = n.oy; }
      const mid = findPath(search, fx, fy, tx, ty, outdoorOpts);
      if (!mid) continue;
      let cost = (pre?.cost ?? 0) + mid.cost;
      const points = [...(pre?.points ?? []), ...mid.points];
      const zs = [...(pre?.zs ?? [])];
      for (let k = 0; k < mid.points.length; k += 2) zs.push(0);
      let goalX = mid.goalX, goalY = mid.goalY;
      if (gg) {
        const n = gg.nodes[en]!;
        points.push(n.ox, n.oy, n.x, n.y);
        zs.push(0, 0);
        cost += hypot2(mid.goalX - n.ox, mid.goalY - n.oy) + hypot2(n.ox - n.x, n.oy - n.y);
        const post = innerRoute(gg, map.buildings[bg]!, n.x, n.y, 0, gx, gy, gf);
        if (!post) continue;
        points.push(...post.points);
        zs.push(...post.zs);
        cost += post.cost;
        goalX = gx; goalY = gy;
      }
      if (!best || cost < best.cost) best = { points, zs, cost, expanded: mid.expanded, goalX, goalY };
    }
  }
  return best ? fin(best) : null;
}

/**
 * Waypoints along a route (M7.5d): `base` for each point (its mode, posture), with the point's height above the
 * ground when the route has heights (none otherwise: outdoors and on ground floors nothing changes).
 */
export function routeWaypoints<W extends { x: number; y: number; z?: number }>(r: RouteResult, base: W, from = 0, skipLast = 0): W[] {
  const out: W[] = [];
  for (let i = from; i + skipLast * 2 < r.points.length; i += 2) {
    const w = { ...base, x: r.points[i]!, y: r.points[i + 1]! };
    if (r.zs) w.z = r.zs[i / 2]!;
    else if (w.z !== undefined) delete w.z;
    out.push(w);
  }
  return out;
}

/** About one man per this many square metres of a room's floor (M7.5d: a squad spreads over the rooms). */
const M2_PER_MAN = 4.5;
/** Places in one room are at least this far apart where the room allows it, m. */
const SPOT_SPACING_M = 1.2;

/** An indoor place: where a man stands, the heading he faces, and his height above the ground (his floor). */
export interface IndoorSpot { x: number; y: number; heading: number; z: number }

/**
 * Places for `n` men inside building `bi`, starting in the room containing (x, y) on `floor`, then the other rooms
 * of that floor nearest to it, then the other floors nearest to it (M7.5d; indoors: no formation, plan §5). Each
 * room takes about one man per 4.5 m2 (M7.5d: was 2.5, which crowded a squad into one corner): first by its
 * windows ("indoor cover": a man takes post at a window), then on a grid kept 0.45 m off the walls and clear of
 * doorways, each new place as far as possible from those already taken. With more men than places, places
 * repeat. Each place carries the heading the man faces (out of the window, or away from the room's centre).
 */
export function indoorSpots(ctx: SimContext, bi: number, x: number, y: number, n: number, floor = 0): IndoorSpot[] {
  const b = ctx.map.buildings[bi]!;
  const g = interiorGraph(ctx, bi)!;
  const it = b.interior!;
  const fl0 = Math.min(Math.max(floor, 0), b.storeys - 1);
  const r0 = roomOf(b, fl0, x, y);
  const rooms: number[] = [];
  it.rooms.forEach((_, i) => rooms.push(i));
  const cen = (i: number) => {
    const p = it.rooms[i]!.poly, k = p.length / 2;
    let mx = 0, my = 0;
    for (let q = 0; q < k; q++) { mx += p[q * 2]!; my += p[q * 2 + 1]!; }
    return [mx / k, my / k] as const;
  };
  const fd = (i: number) => Math.abs(it.rooms[i]!.floor - fl0) * 2 + (it.rooms[i]!.floor < fl0 ? 1 : 0);
  rooms.sort((i, j) => fd(i) - fd(j) || (i === r0 ? -1 : j === r0 ? 1 : hypot2(cen(i)[0] - x, cen(i)[1] - y) - hypot2(cen(j)[0] - x, cen(j)[1] - y) || i - j));
  const windows: { ix: number; iy: number; x: number; y: number; floor: number }[] = [];
  for (const o of b.openings) {
    if (o.kind !== "window") continue;
    const d = wallPoint(b.footprint, o.wall, o.offsetM, o.widthM, 0.5, 0);
    windows.push({ ix: d.ix, iy: d.iy, x: d.x, y: d.y, floor: o.floor ?? 0 });
  }
  const out: IndoorSpot[] = [];
  for (const ri of rooms) {
    if (out.length >= n) break;
    const rm = it.rooms[ri]!;
    const poly = rm.poly, k = poly.length / 2;
    const z = rm.floor * b.storeyHeightM;
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
    const clearOfDoors = (px: number, py: number) => g.nodes.every((nd) => nd.floor !== rm.floor || hypot2(nd.x - px, nd.y - py) > 0.6)
      && it.stairs.every((st) => !onStair(st, rm.floor, px, py));
    const ux0 = poly[2]! - poly[0]!, uy0 = poly[3]! - poly[1]!, ul = hypot2(ux0, uy0) || 1;
    const ux = ux0 / ul, uy = uy0 / ul, vx = -uy, vy = ux;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (let q = 0; q < k; q++) {
      const pa = (poly[q * 2]! - cx) * ux + (poly[q * 2 + 1]! - cy) * uy, pb = (poly[q * 2]! - cx) * vx + (poly[q * 2 + 1]! - cy) * vy;
      if (pa < a0) a0 = pa; if (pa > a1) a1 = pa; if (pb < b0) b0 = pb; if (pb > b1) b1 = pb;
    }
    const area = (a1 - a0) * (b1 - b0);
    const cap = Math.max(1, Math.floor(area / M2_PER_MAN));
    const win: IndoorSpot[] = [], grid: IndoorSpot[] = [];
    for (const w of windows) {
      if (w.floor !== rm.floor || !pointInPolygon(poly, w.ix, w.iy) || edgeDist(w.ix, w.iy) < 0.3 || !clearOfDoors(w.ix, w.iy)) continue;
      win.push({ x: w.ix, y: w.iy, heading: atan2(w.y - w.iy, w.x - w.ix), z });
    }
    for (let a = a0 + 0.45; a <= a1 - 0.45 + 1e-9; a += 0.6) for (let bb = b0 + 0.45; bb <= b1 - 0.45 + 1e-9; bb += 0.6) {
      const px = cx + ux * a + vx * bb, py = cy + uy * a + vy * bb;
      if (!pointInPolygon(poly, px, py) || edgeDist(px, py) < 0.44 || !clearOfDoors(px, py)) continue;
      grid.push({ x: px, y: py, heading: atan2(py - cy, px - cx), z });
    }
    // Windows first (nearest the tapped point first), then grid places, each as far as possible from the taken.
    const taken: IndoorSpot[] = [];
    const far = (p: IndoorSpot) => { let m = Infinity; for (const q of taken) m = Math.min(m, hypot2(p.x - q.x, p.y - q.y)); return m; };
    win.sort((p, q) => hypot2(p.x - x, p.y - y) - hypot2(q.x - x, q.y - y));
    for (const w of win) if (taken.length < cap && far(w) >= SPOT_SPACING_M) taken.push(w);
    while (taken.length < cap) {
      let best = -1, bd = -Infinity;
      for (let q = 0; q < grid.length; q++) {
        const d = taken.length === 0 ? -hypot2(grid[q]!.x - x, grid[q]!.y - y) : far(grid[q]!);
        if (d > bd + 1e-9) { bd = d; best = q; }
      }
      if (best < 0 || (taken.length > 0 && bd < 0.8)) break;
      taken.push(grid[best]!);
      grid.splice(best, 1);
    }
    for (const p of taken) if (out.length < n) out.push(p);
  }
  if (out.length === 0) out.push({ x, y, heading: 0, z: fl0 * b.storeyHeightM });
  for (let i = 0; out.length < n; i++) out.push(out[i]!);
  return out;
}
