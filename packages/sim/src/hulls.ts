/**
 * HULLS AS OBSTACLES (M7.1c): the vehicle grid (derived, rebuilt after the drive and on creation/load), wrecks
 * stamped into the navigation grids, and the geometric tests the drive, the men and the planner share
 * (an oriented hull rectangle against buildings, walls, water, other hulls and men).
 *
 * Derived data only: everything here is recomputed from the state at fixed points of the tick (rule 1).
 */
import type { VehicleDef } from "./catalog";
import type { SimContext } from "./context";
import { NEAR_VEHICLE, type VehicleGrid } from "./ballistics";
import { atan, cos, sin, sqrt } from "./math";
import type { NavStamp } from "./nav";
import { patchNavGrids } from "./navctx";
import type { SimState } from "./state";
import { cellIndex, cellMoveCost, heightAt, pointInPolygon, segmentsInRectInto } from "./terrain";
import type { EntityId } from "./ids";
import type { VehicleState } from "./components";

/** A hull's footprint rectangle: centre, heading (cos, sin), half length and half width. */
export interface Obb { x: number; y: number; c: number; s: number; hl: number; hw: number }

/** The hull rectangle of a vehicle type at a pose (the hull box's centre may sit off the vehicle's origin). */
export function hullObb(def: VehicleDef, x: number, y: number, heading: number, grow = 0, out?: Obb): Obb {
  const h = def.body.hull, c = cos(heading), s = sin(heading);
  const fc = (h.f[0] + h.f[1]) / 2, rc = (h.r[0] + h.r[1]) / 2;
  const o = out ?? { x: 0, y: 0, c: 0, s: 0, hl: 0, hw: 0 };
  o.x = x + c * fc - s * rc; o.y = y + s * fc + c * rc; o.c = c; o.s = s;
  o.hl = (h.f[1] - h.f[0]) / 2 + grow; o.hw = (h.r[1] - h.r[0]) / 2 + grow;
  return o;
}

/** Separating-axis test of two rectangles. */
export function obbOverlap(a: Obb, b: Obb): boolean {
  const dx = b.x - a.x, dy = b.y - a.y;
  // Axes: a forward, a right, b forward, b right.
  const axes = [a.c, a.s, -a.s, a.c, b.c, b.s, -b.s, b.c];
  for (let k = 0; k < 8; k += 2) {
    const ux = axes[k]!, uy = axes[k + 1]!;
    const ra = a.hl * Math.abs(a.c * ux + a.s * uy) + a.hw * Math.abs(-a.s * ux + a.c * uy);
    const rb = b.hl * Math.abs(b.c * ux + b.s * uy) + b.hw * Math.abs(-b.s * ux + b.c * uy);
    if (Math.abs(dx * ux + dy * uy) > ra + rb) return false;
  }
  return true;
}

/** Is the point inside the rectangle grown by `grow`? Writes the push-out (to the nearest side) into PUSH. */
export const PUSH = { x: 0, y: 0 };
export function pointInObb(o: Obb, x: number, y: number, grow = 0): boolean {
  const rx = x - o.x, ry = y - o.y;
  const f = rx * o.c + ry * o.s, r = -rx * o.s + ry * o.c;
  const hl = o.hl + grow, hw = o.hw + grow;
  if (f < -hl || f > hl || r < -hw || r > hw) return false;
  const pf = hl - Math.abs(f), pr = hw - Math.abs(r);
  if (pf < pr) { const d = (f >= 0 ? 1 : -1) * (pf + 0.01); PUSH.x = o.c * d; PUSH.y = o.s * d; }
  else { const d = (r >= 0 ? 1 : -1) * (pr + 0.01); PUSH.x = -o.s * d; PUSH.y = o.c * d; }
  return true;
}

/** Does the segment (ax, ay)-(bx, by) cross the rectangle? */
export function segmentHitsObb(o: Obb, ax: number, ay: number, bx: number, by: number): boolean {
  const rx = ax - o.x, ry = ay - o.y, dx = bx - ax, dy = by - ay;
  const pf = rx * o.c + ry * o.s, pr = -rx * o.s + ry * o.c;
  const df = dx * o.c + dy * o.s, dr = -dx * o.s + dy * o.c;
  let t0 = 0, t1 = 1;
  const clip = (p: number, d: number, lo: number, hi: number): boolean => {
    if (Math.abs(d) < 1e-12) return p >= lo && p <= hi;
    let a = (lo - p) / d, b = (hi - p) / d;
    if (a > b) { const q = a; a = b; b = q; }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    return t0 <= t1;
  };
  return clip(pf, df, -o.hl, o.hl) && clip(pr, dr, -o.hw, o.hw);
}

/** Corners and edge midpoints of a rectangle (8 points, x/y interleaved) into `out`. */
const OUTLINE_F = [1, 1, -1, -1, 1, 0, -1, 0], OUTLINE_R = [1, -1, -1, 1, 0, 1, 0, -1];
export function obbOutline(o: Obb, out: number[]): void {
  for (let k = 0; k < 8; k++) {
    const f = OUTLINE_F[k]! * o.hl, r = OUTLINE_R[k]! * o.hw;
    out[k * 2] = o.x + o.c * f - o.s * r; out[k * 2 + 1] = o.y + o.s * f + o.c * r;
  }
}

/** What the ground and the map let a hull do at a pose. */
export interface HullTerrain {
  /** A building, deep water, ground the class cannot drive on, an uncrossable wall, or the map edge. */
  blocked: boolean;
  /** A wall the hull may cross (index of the obstacle and of its segment), or -1. */
  crossObstacle: number; crossPart: number;
}

const OUT8: number[] = new Array(16).fill(0);
const SEGS: number[] = [];
const OBB_A: Obb = { x: 0, y: 0, c: 1, s: 0, hl: 0, hw: 0 };

/**
 * The hull rectangle against the true building outlines and walls under it (not the grown navigation cells,
 * which would stall turns beside houses), the ground under its outline points (deep water) and under its centre
 * (woods and anything else the class cannot drive through).
 */
export function hullTerrain(ctx: SimContext, def: VehicleDef, x: number, y: number, heading: number, out: HullTerrain): HullTerrain {
  out.blocked = false; out.crossObstacle = -1; out.crossPart = -1;
  const o = hullObb(def, x, y, heading, 0, OBB_A);
  obbOutline(o, OUT8);
  const map = ctx.map;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let k = 0; k < 8; k++) {
    const px = OUT8[k * 2]!, py = OUT8[k * 2 + 1]!;
    if (px < 0 || py < 0 || px >= map.widthM || py >= map.heightM) { out.blocked = true; return out; }
    // (Deep water and ground no vehicle can drive under any part of the hull; woods only under its centre, below.)
    const cell = cellIndex(map, px, py);
    // (Deep water: nobody can cross it. A house's floor cells reach past its walls: the walls decide there.)
    if (cell < 0 || ctx.catalog.terrain.surfaces[map.surfacePalette[map.surface[cell]!]!]?.moveCost.foot === null) { out.blocked = true; return out; }
    x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
  }
  { const c = cellIndex(map, o.x, o.y); if (c < 0 || cellMoveCost(map, ctx.catalog.terrain, c, def.class) === null) { out.blocked = true; return out; } }
  const n = segmentsInRectInto(ctx.mapIndex, x0, y0, x1, y1, SEGS);
  const B = ctx.ballistics;
  for (let q = 0; q < n; q++) {
    const si = SEGS[q]!;
    const sg = ctx.mapIndex.segments[si]!;
    if (!segmentHitsObb(o, sg.ax, sg.ay, sg.bx, sg.by)) continue;
    if (sg.owner === "building") {
      // A breach in a house wall does not make a way through the house.
      out.blocked = true; return out;
    }
    const ob = map.obstacles.find((p) => p.id === sg.id);
    const kind = ob ? ctx.catalog.terrain.obstacles[ob.kind] : undefined;
    const vx = kind?.vehicle[def.class] ?? null;
    if (vx === null) {
      // Not where the wall is already open over the hull's width (a hole wide enough, or a gap flattened).
      if (openOver(B.seg[si]!.openings, sg, o)) continue;
      out.blocked = true; return out;
    }
    if (out.crossObstacle < 0) { out.crossObstacle = sg.id; out.crossPart = sg.part; }
  }
  // The hull inside a building (e.g. a pose far from the last one): the centre against the footprints near it.
  for (const b of map.buildings) {
    const fp = b.footprint;
    if (fp[0]! < x0 - 60 || fp[0]! > x1 + 60 || fp[1]! < y0 - 60 || fp[1]! > y1 + 60) continue;
    if (pointInPolygon(fp, o.x, o.y)) { out.blocked = true; return out; }
  }
  return out;
}

/** Is a wall segment open (breached) all along where the hull meets it? */
function openOver(openings: readonly { offsetM: number; widthM: number; sillM: number }[] | null, sg: { ax: number; ay: number; bx: number; by: number }, o: Obb): boolean {
  if (!openings || openings.length === 0) return false;
  const ex = sg.bx - sg.ax, ey = sg.by - sg.ay, len = sqrt(ex * ex + ey * ey) || 1;
  // The stretch of the segment inside the rectangle, by sampling (walls are short; 0.25 m steps).
  const steps = Math.max(2, Math.ceil(len / 0.25));
  for (let k = 0; k <= steps; k++) {
    const t = k / steps, px = sg.ax + ex * t, py = sg.ay + ey * t;
    const rx = px - o.x, ry = py - o.y;
    const f = rx * o.c + ry * o.s, r = -rx * o.s + ry * o.c;
    if (Math.abs(f) > o.hl || Math.abs(r) > o.hw) continue;
    const off = t * len;
    if (!openings.some((p) => p.sillM <= 0.01 && off >= p.offsetM - p.widthM / 2 && off <= p.offsetM + p.widthM / 2)) return false;
  }
  return true;
}

// ---------------------------------------------------------------- the vehicle grid

function growGrid(G: VehicleGrid, cap: number): void {
  const keys: (keyof VehicleGrid)[] = ["id", "x", "y", "gz", "ch", "sh", "f0", "f1", "r0", "r1", "u0", "u1", "tx", "ty", "tch", "tsh", "tf0", "tf1", "tr0", "tr1", "tu0", "tu1", "minX", "maxX", "minY", "maxY", "pitch", "roll", "minNeed", "hits", "hitOwner", "hitAmmo", "hitX", "hitY", "hitZ", "hitFace"];
  const g = G as unknown as Record<string, Float64Array | Int32Array>;
  for (const k of keys) {
    const old = g[k]!;
    const nu = old instanceof Int32Array ? new Int32Array(cap) : new Float64Array(cap);
    g[k] = nu;
  }
  G.touched = new Int32Array(cap * 16);
}

/**
 * Rebuild the vehicle rows (ID order) and their bits of the near byte. Also re-derives the wreck stamps of the
 * navigation grids when the set of wrecks changed (patching only the cells round them).
 */
export function rebuildVehicleGrid(ctx: SimContext, state: SimState): void {
  const B = ctx.ballistics, G = B.vehicles, near = B.near;
  for (let q = 0; q < G.touchedCount; q++) { const kk = G.touched[q]!; near[kk] = near[kk]! & ~NEAR_VEHICLE; }
  G.touchedCount = 0;
  if (state.vehicle.size === 0) { G.n = 0; return; }
  if (state.vehicle.size > G.id.length) growGrid(G, Math.max(state.vehicle.size, G.id.length * 2));
  const map = ctx.map, bm = B.bucketM, bcols = B.bcols, brows = B.brows;
  let n = 0;
  for (const [vid, v] of state.vehicle.entries()) {
    const def = ctx.catalog.vehicles[v.def];
    const t = state.transform.get(vid);
    if (!def || !t) continue;
    const c = cos(t.heading), s = sin(t.heading);
    const h = def.body.hull;
    G.id[n] = vid; G.x[n] = t.x; G.y[n] = t.y; G.ch[n] = c; G.sh[n] = s;
    G.f0[n] = h.f[0]; G.f1[n] = h.f[1]; G.r0[n] = h.r[0]; G.r1[n] = h.r[1]; G.u0[n] = h.u[0]; G.u1[n] = h.u[1];
    // Four contact corners: height of the hull's middle, pitch and roll.
    const hl = def.body.lengthM / 2, hw = def.body.widthM / 2;
    const zfl = heightAt(map, t.x + c * hl + s * hw, t.y + s * hl - c * hw), zfr = heightAt(map, t.x + c * hl - s * hw, t.y + s * hl + c * hw);
    const zbl = heightAt(map, t.x - c * hl + s * hw, t.y - s * hl - c * hw), zbr = heightAt(map, t.x - c * hl - s * hw, t.y - s * hl + c * hw);
    G.gz[n] = (zfl + zfr + zbl + zbr) / 4;
    G.pitch[n] = atan((zfl + zfr - zbl - zbr) / (4 * hl));
    G.roll[n] = atan((zfl + zbl - zfr - zbr) / (4 * hw));
    const tr = def.body.turret;
    if (tr) {
      const az = t.heading + (v.stations[0]?.azimuth ?? 0);
      G.tx[n] = t.x + c * tr.pivotF; G.ty[n] = t.y + s * tr.pivotF; G.tch[n] = cos(az); G.tsh[n] = sin(az);
      G.tf0[n] = tr.f[0]; G.tf1[n] = tr.f[1]; G.tr0[n] = tr.r[0]; G.tr1[n] = tr.r[1]; G.tu0[n] = tr.u[0]; G.tu1[n] = tr.u[1];
    } else { G.tu0[n] = 0; G.tu1[n] = 0; G.tx[n] = t.x; G.ty[n] = t.y; G.tch[n] = 1; G.tsh[n] = 0; }
    // Bounding box: a circle round the vehicle's origin that holds hull and turret (barrel excluded).
    let R = 0;
    for (const f of [h.f[0], h.f[1]]) for (const r of [h.r[0], h.r[1]]) R = Math.max(R, sqrt(f * f + r * r));
    if (tr) for (const f of [tr.f[0], tr.f[1]]) for (const r of [tr.r[0], tr.r[1]]) R = Math.max(R, Math.abs(tr.pivotF) + sqrt(f * f + r * r));
    G.minX[n] = t.x - R; G.maxX[n] = t.x + R; G.minY[n] = t.y - R; G.maxY[n] = t.y + R;
    G.hits[n] = 0;
    G.minNeed[n] = B.vehicleRT[v.def]?.minNeedMm ?? Infinity;
    const c0 = Math.max(0, Math.floor((t.x - R) / bm) - 1), c1 = Math.min(bcols - 1, Math.floor((t.x + R) / bm) + 1);
    const r0 = Math.max(0, Math.floor((t.y - R) / bm) - 1), r1 = Math.min(brows - 1, Math.floor((t.y + R) / bm) + 1);
    for (let rr = r0; rr <= r1; rr++) for (let cc = c0; cc <= c1; cc++) {
      const kk = rr * bcols + cc;
      if ((near[kk]! & NEAR_VEHICLE) === 0) {
        if (G.touchedCount >= G.touched.length) { const nt = new Int32Array(G.touched.length * 2); nt.set(G.touched); G.touched = nt; }
        G.touched[G.touchedCount++] = kk; near[kk] = near[kk]! | NEAR_VEHICLE;
      }
    }
    n++;
  }
  G.n = n;
  // Wrecks: re-stamp the navigation grids when the set changed.
  const dirty = deriveWrecks(ctx, state);
  // (Patched round every old and new stamp.)
  if (dirty) for (const r of dirty) patchNavGrids(ctx, r[0], r[1], r[2], r[3]);
}

/** Is this vehicle a wreck for navigation (lies where it is for good)? */
export function isWreck(v: VehicleState, tick: number): boolean {
  return v.status === "destroyed" || v.status === "abandoned" || (v.status === "immobilised" && tick - v.lastPenTick > 30 * 60);
}

/**
 * Stamps of the wrecks (destroyed, abandoned, or immobilised for more than 30 s) in ID order into
 * `ctx.navStamps`. Returns the rectangles to re-derive if they changed, else null.
 */
export function deriveWrecks(ctx: SimContext, state: SimState): [number, number, number, number][] | null {
  let key = "";
  const stamps: NavStamp[] = [];
  if (state.vehicle.size > 0) {
    for (const [vid, v] of state.vehicle.entries()) {
      if (!isWreck(v, state.tick)) continue;
      const def = ctx.catalog.vehicles[v.def], t = state.transform.get(vid);
      if (!def || !t) continue;
      const o = hullObb(def, t.x, t.y, t.heading);
      stamps.push({ x: o.x, y: o.y, heading: t.heading, halfL: o.hl, halfW: o.hw });
      key += `${vid}:${o.x.toFixed(2)}:${o.y.toFixed(2)};`;
    }
  }
  if (key === ctx.navStampKey) return null;
  const dirty: [number, number, number, number][] = [];
  const box = (st: NavStamp): [number, number, number, number] => { const R = st.halfL + st.halfW; return [st.x - R, st.y - R, st.x + R, st.y + R]; };
  for (const st of ctx.navStamps) dirty.push(box(st));
  for (const st of stamps) dirty.push(box(st));
  ctx.navStamps = stamps;
  ctx.navStampKey = key;
  return dirty;
}

/** Row of a vehicle in the grid, or -1. */
export function vehicleRow(G: VehicleGrid, vid: EntityId): number {
  for (let j = 0; j < G.n; j++) if (G.id[j] === vid) return j;
  return -1;
}
