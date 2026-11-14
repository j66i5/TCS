/**
 * SMOKE VOLUME v2 (M8.1). A smoke cloud is a volume standing on the ground: a capsule (two circles joined) in plan
 * from its tail to its head, of radius `r`, up to a height `top` above the ground where it rose.
 *
 * - **Build-up:** radius and height grow from 30 % to full over `spotting.smokeBuildSeconds`.
 * - **Drift and stretch:** the wind carries the cloud (`smokeDriftFactor` x the wind, `environment.windX/windY`,
 *   m/s toward x east, y south — the map's y grows southward): the head moves downwind with the air; the tail stays
 *   on the burning round while it emits (`burnS`), then follows. The capsule never reaches upwind of the round. A
 *   long plume is cut at `smokeStretchMaxM` behind the head (beyond, too thin to count).
 * - **Fade:** over the last `smokeFadeSeconds` of its life the cloud thins to nothing (density x remaining share).
 * - **Height:** a line of sight passes through only where it is below the cloud's top: a man upstairs sees over a
 *   low cloud when his line to the target clears its top.
 *
 * The cloud's shapes at a tick are derived (never stored): `smokeShapes` caches them per tick for the sight
 * queries (spatial culling by bounding box), the renderer draws the same shapes (rule 5: shapes, not internals).
 */
import type { Catalog } from "./catalog";
import type { SimView } from "./state";
import { exp, sqrt } from "./math";

/** A smoke cloud as stored in the state (plain data). `gz`, `topM`, `burnS` absent: an old cloud (before M8.1),
 *  standing at every height and drifting whole. */
export interface SmokeCloud {
  x: number; y: number; radiusM: number; startTick: number; untilTick: number;
  /** M7.3: also blinds thermal sights; absent = ordinary smoke. */
  multispectral?: true;
  /** Ground height where it rose (m) and its top above that at full size (m). */
  gz?: number; topM?: number;
  /** Seconds the source keeps emitting at its place (the tail stays there that long); 0 = a puff. */
  burnS?: number;
}

/** The smoke model's constants (from `catalog.spotting`), in ticks where the sim counts ticks. */
export interface SmokePhysics {
  k: number; buildTicks: number; fadeTicks: number; drift: number; stretchMaxM: number;
}

const PHYS = new WeakMap<object, SmokePhysics>();
export function smokePhysics(catalog: Pick<Catalog, "spotting">): SmokePhysics {
  const D = catalog.spotting;
  let p = PHYS.get(D);
  if (!p) {
    p = {
      k: D.smokeExtinctionPerM, buildTicks: Math.round(D.smokeBuildSeconds * 60), fadeTicks: Math.round((D.smokeFadeSeconds ?? 0) * 60),
      drift: D.smokeDriftFactor ?? 1, stretchMaxM: D.smokeStretchMaxM ?? 200,
    };
    PHYS.set(D, p);
  }
  return p;
}

/** One cloud's shape now: capsule from (ax, ay) to (bx, by), radius r, top (absolute z), density 0..1. */
export interface SmokeShape { ax: number; ay: number; bx: number; by: number; r: number; top: number; density: number; multispectral: boolean }

/** Stride of the packed shape array: ax ay bx by r top density ms minx miny maxx maxy. */
const S = 12;
interface Cache { tick: number; n: number; wx: number; wy: number; p: SmokePhysics; a: Float64Array }
const CACHE = new WeakMap<object, Cache>();

function pack(state: SimView, P: SmokePhysics): Float64Array {
  const list = state.smoke, n = list.length, tick = state.tick;
  const c = CACHE.get(list);
  const wx = state.environment.windX * P.drift, wy = state.environment.windY * P.drift;
  if (c && c.tick === tick && c.n === n && c.wx === wx && c.wy === wy && c.p === P) return c.a;
  const a = c && c.a.length >= n * S ? c.a : new Float64Array(Math.max(8, n) * S);
  for (let i = 0; i < n; i++) {
    const cl = list[i]!;
    const age = Math.max(0, tick - cl.startTick) / 60;
    const grow = P.buildTicks > 0 ? Math.min(1, (tick - cl.startTick) / P.buildTicks) : 1;
    const g = 0.3 + 0.7 * Math.max(0, grow);
    const r = cl.radiusM * g;
    const top = cl.topM === undefined || cl.gz === undefined ? Infinity : cl.gz + cl.topM * g;
    const density = P.fadeTicks > 0 ? Math.max(0, Math.min(1, (cl.untilTick - tick) / P.fadeTicks)) : 1;
    const bx = cl.x + wx * age, by = cl.y + wy * age;
    const tail = Math.max(0, age - (cl.burnS ?? 0));
    let ax = cl.x + wx * tail, ay = cl.y + wy * tail;
    const lx = bx - ax, ly = by - ay, L = sqrt(lx * lx + ly * ly);
    if (L > P.stretchMaxM && L > 0) { ax = bx - (lx / L) * P.stretchMaxM; ay = by - (ly / L) * P.stretchMaxM; }
    const o = i * S;
    a[o] = ax; a[o + 1] = ay; a[o + 2] = bx; a[o + 3] = by; a[o + 4] = r; a[o + 5] = top; a[o + 6] = density;
    a[o + 7] = cl.multispectral === true ? 1 : 0;
    a[o + 8] = Math.min(ax, bx) - r; a[o + 9] = Math.min(ay, by) - r; a[o + 10] = Math.max(ax, bx) + r; a[o + 11] = Math.max(ay, by) + r;
  }
  CACHE.set(list, { tick, n, wx, wy, p: P, a });
  return a;
}

/** Every cloud's shape now, in state order (for the renderer, labs and tests). */
export function smokeShapes(state: SimView, P: SmokePhysics): SmokeShape[] {
  const a = pack(state, P), out: SmokeShape[] = [];
  for (let i = 0; i < state.smoke.length; i++) {
    const o = i * S;
    out.push({ ax: a[o]!, ay: a[o + 1]!, bx: a[o + 2]!, by: a[o + 3]!, r: a[o + 4]!, top: a[o + 5]!, density: a[o + 6]!, multispectral: a[o + 7] === 1 });
  }
  return out;
}

/** t-interval of f0 + f1 t within [lo, hi] (all t: [-inf, inf]; none: lo > hi). */
function lin(f0: number, f1: number, lo: number, hi: number, out: number[]): void {
  if (f1 > -1e-12 && f1 < 1e-12) { if (f0 >= lo && f0 <= hi) { out[0] = -Infinity; out[1] = Infinity; } else { out[0] = 1; out[1] = 0; } return; }
  const t0 = (lo - f0) / f1, t1 = (hi - f0) / f1;
  if (t0 < t1) { out[0] = t0; out[1] = t1; } else { out[0] = t1; out[1] = t0; }
}
const IV = [0, 0], IW = [0, 0];

/** t-interval where p0 + t d lies within r of (cx, cy) (none: [1, 0]). */
function circ(px: number, py: number, dx: number, dy: number, L2: number, cx: number, cy: number, r: number, out: number[]): void {
  const fx = px - cx, fy = py - cy;
  const b = fx * dx + fy * dy, cc = fx * fx + fy * fy - r * r;
  if (L2 <= 1e-12) { if (cc <= 0) { out[0] = -Infinity; out[1] = Infinity; } else { out[0] = 1; out[1] = 0; } return; }
  const disc = b * b - L2 * cc;
  if (disc <= 0) { out[0] = 1; out[1] = 0; return; }
  const s = sqrt(disc);
  out[0] = (-b - s) / L2; out[1] = (-b + s) / L2;
}

/**
 * How much of the view survives the smoke along a line from (x0, y0, z0) to (x1, y1, z1) (1 = none in the way):
 * exp(-k x metres of smoke, each cloud's metres x its density). Only the part of the line below a cloud's top
 * counts. `only`: thermal sights see through ordinary smoke in part, not through a multispectral cloud (M7.3).
 */
export function smokeTransmission(state: SimView, P: SmokePhysics, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, only: "all" | "conventional" | "multispectral" = "all"): number {
  const n = state.smoke.length;
  if (n === 0 || P.k <= 0) return 1;
  const a = pack(state, P);
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0, L2 = dx * dx + dy * dy, L = sqrt(L2);
  const mnx = Math.min(x0, x1), mxx = Math.max(x0, x1), mny = Math.min(y0, y1), mxy = Math.max(y0, y1);
  const msWanted = only === "multispectral" ? 1 : 0;
  let metres = 0;
  for (let i = 0; i < n; i++) {
    const o = i * S;
    // Spatial culling: the line's box must meet the cloud's.
    if (a[o + 8]! > mxx || a[o + 10]! < mnx || a[o + 9]! > mxy || a[o + 11]! < mny) continue;
    if (only !== "all" && a[o + 7] !== msWanted) continue;
    const dens = a[o + 6]!;
    if (dens <= 0) continue;
    const top = a[o + 5]!;
    if (z0 > top && z1 > top) continue;
    const ax = a[o]!, ay = a[o + 1]!, bx = a[o + 2]!, by = a[o + 3]!, r = a[o + 4]!;
    // Union of the two end circles and the band between them (one interval: the capsule is convex).
    let lo = Infinity, hi = -Infinity;
    circ(x0, y0, dx, dy, L2, ax, ay, r, IV);
    if (IV[1]! > IV[0]!) { lo = IV[0]!; hi = IV[1]!; }
    const ux = bx - ax, uy = by - ay, ul = sqrt(ux * ux + uy * uy);
    if (ul > 1e-6) {
      circ(x0, y0, dx, dy, L2, bx, by, r, IV);
      if (IV[1]! > IV[0]!) { if (IV[0]! < lo) lo = IV[0]!; if (IV[1]! > hi) hi = IV[1]!; }
      const nx = ux / ul, ny = uy / ul, px = x0 - ax, py = y0 - ay;
      lin(px * nx + py * ny, dx * nx + dy * ny, 0, ul, IV);
      lin(-px * ny + py * nx, -dx * ny + dy * nx, -r, r, IW);
      const s0 = Math.max(IV[0]!, IW[0]!), s1 = Math.min(IV[1]!, IW[1]!);
      if (s1 > s0) { if (s0 < lo) lo = s0; if (s1 > hi) hi = s1; }
    }
    if (lo < 0) lo = 0;
    if (hi > 1) hi = 1;
    if (!(hi > lo)) continue;
    // Below the top only.
    if (top !== Infinity) {
      if (dz > -1e-9 && dz < 1e-9) { if (z0 > top) continue; }
      else {
        const tt = (top - z0) / dz;
        if (dz > 0) { if (tt < hi) hi = tt; } else if (tt > lo) lo = tt;
        if (!(hi > lo)) continue;
      }
    }
    metres += (hi - lo) * (L2 <= 1e-12 ? r : L) * dens;
  }
  return metres > 0 ? exp(-P.k * metres) : 1;
}
