/**
 * LINE OF SIGHT (SPEC 6.5): can a point see another, and how much of the view survives on the way?
 *
 * In 3D over the heightfield: the ground (hills, crests, banks) blocks; walls block unless the line passes a
 * door, window or breach, see-through obstacles (a wire fence, a wooden fence, a hedge) let a share through;
 * a roof blocks a line that crosses it; vegetation lower than the line is no hindrance, vegetation the line
 * passes through thins the view by its concealment per metre. Smoke (M8) will thin it the same way.
 *
 * Pure query on the map and the derived ballistics tables: no state, no randomness. Heights are absolute.
 */
import type { SimContext } from "./context";
import { exp, sqrt } from "./math";
import { vehicleOnLine } from "./ballistics";
import { heightAt, pointInPolygon, segmentsInRectInto } from "./terrain";

export interface Sight {
  /** 0 (nothing gets through) .. 1 (a clear view). Product of see-through obstacles and vegetation. */
  visibility: number;
  /** What stopped the line completely, if anything. */
  blockedBy: "ground" | "wall" | "roof" | "vehicle" | null;
  /** Metres of vegetation the line passed through below its top. */
  vegetationM: number;
  /** Where along the line (0 start .. 1 end) it was stopped; 1 if it was not. */
  blockedAt: number;
}

/** Ends of the line closer than this to the ground at their own point are not tested against it. */
const END_CLEARANCE_M = 0.3;
/** Height margin: a line skimming the ground by less than this counts as blocked. */
const GRAZE_M = 0.05;
/** Scratch list of sample parameters (reused: no allocation per call). */
const LOS_TS: number[] = [];
/** Scratch: grid-line crossings in x and in y, each ascending (reused). */
const LOS_TX: number[] = [];
const LOS_TY: number[] = [];
/** Scratch: wall segments near the line, and a roof's footprint crossings (reused: no allocation per call). */
const LOS_SEGS: number[] = [];
const ROOF_TS: number[] = [];

/**
 * `ignoreA` / `ignoreB`: vehicles whose own hull does not block (the observer's or the target's, M7).
 */
export function sight(ctx: SimContext, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, ignoreA = -1, ignoreB = -1): Sight {
  const map = ctx.map, B = ctx.ballistics, index = ctx.mapIndex;
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const len = sqrt(dx * dx + dy * dy);
  let visibility = 1, tWall = 2;

  // ---- walls, fences, hedges, house walls (doors, windows and breaches let it through)
  const nSeg = segmentsInRectInto(index, x0, y0, x1, y1, LOS_SEGS);
  for (let q = 0; q < nSeg; q++) {
    const si = LOS_SEGS[q]!;
    const s = index.segments[si]!;
    const ex = s.bx - s.ax, ey = s.by - s.ay;
    const denom = dx * ey - dy * ex;
    if (denom > -1e-12 && denom < 1e-12) continue;
    const t = ((s.ax - x0) * ey - (s.ay - y0) * ex) / denom;
    if (t <= 1e-9 || t >= 1 - 1e-9) continue;
    const u = ((s.ax - x0) * dy - (s.ay - y0) * dx) / denom;
    if (u < 0 || u > 1) continue;
    const info = B.seg[si]!;
    const rel = z0 + t * dz - heightAt(map, x0 + t * dx, y0 + t * dy);
    if (rel < 0 || rel > info.heightM) continue;
    if (info.openings) {
      const off = u * info.len;
      let open = false;
      for (const o of info.openings) if (off >= o.offsetM - o.widthM / 2 && off <= o.offsetM + o.widthM / 2 && rel >= o.sillM && rel <= o.headM) { open = true; break; }
      if (open) continue;
    }
    if (info.seeThrough <= 0) { if (t < tWall) tWall = t; continue; }
    visibility *= info.seeThrough;
  }
  let tBlock = tWall, blockedBy: Sight["blockedBy"] = tWall < 2 ? "wall" : null;

  // ---- roofs: blocked if the line crosses a roof's plane while over its footprint
  if (len > 1e-9) {
    const c0 = Math.max(0, Math.floor(Math.min(x0, x1) / index.bucketM)), c1 = Math.min(index.bcols - 1, Math.floor(Math.max(x0, x1) / index.bucketM));
    const r0 = Math.max(0, Math.floor(Math.min(y0, y1) / index.bucketM)), r1 = Math.min(index.brows - 1, Math.floor(Math.max(y0, y1) / index.bucketM));
    let gen = B.roofGen + 1;
    if (gen > 0xfffffff0) { B.roofStamp.fill(0); gen = 1; }
    B.roofGen = gen;
    const seen = B.roofStamp, ts = ROOF_TS;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const list = B.roofBuckets[r * index.bcols + c]!;
      for (let q = 0; q < list.length; q++) {
        const ri = list[q]!;
        if (seen[ri] === gen) continue;
        seen[ri] = gen;
        const rf = B.roofs[ri]!, fp = rf.footprint, n = fp.length / 2;
        // Where the line enters and leaves the footprint (parameters of its crossings with the outline).
        let nt = 0;
        for (let k = 0; k < n; k++) {
          const ax = fp[k * 2]!, ay = fp[k * 2 + 1]!, bx = fp[((k + 1) % n) * 2]!, by = fp[((k + 1) % n) * 2 + 1]!;
          const fx = bx - ax, fy = by - ay, de = dx * fy - dy * fx;
          if (de > -1e-12 && de < 1e-12) continue;
          const t = ((ax - x0) * fy - (ay - y0) * fx) / de, u = ((ax - x0) * dy - (ay - y0) * dx) / de;
          if (t > 0 && t < 1 && u >= 0 && u <= 1) ts[nt++] = t;
        }
        if (pointInPolygon(fp, x0, y0)) ts[nt++] = 0;
        if (pointInPolygon(fp, x1, y1)) ts[nt++] = 1;
        for (let i = 1; i < nt; i++) { // ascending (a handful of values)
          const v = ts[i]!;
          let j = i - 1;
          while (j >= 0 && ts[j]! > v) { ts[j + 1] = ts[j]!; j--; }
          ts[j + 1] = v;
        }
        // A line through a corner crosses two edges at the same point: count it once.
        if (nt > 1) {
          let w = 1, prev = ts[0]!;
          for (let k = 1; k < nt; k++) { const v = ts[k]!; if (v - prev >= 1e-9) ts[w++] = v; prev = v; }
          nt = w;
        }
        for (let k = 0; k + 1 < nt; k += 2) {
          const ta = ts[k]!, tb = ts[k + 1]!;
          const ga = z0 + ta * dz - heightAt(map, x0 + ta * dx, y0 + ta * dy), gb = z0 + tb * dz - heightAt(map, x0 + tb * dx, y0 + tb * dy);
          const za = ga - rf.heightM;
          const zb = gb - rf.heightM;
          if ((za > 0) !== (zb > 0)) {
            // Where it crosses the roof plane (linear between the two footprint crossings).
            const tc = ta + ((tb - ta) * za) / (za - zb);
            if (tc < tBlock) { tBlock = tc; blockedBy = "roof"; }
          }
          // Floors between storeys (M7.5c): the same test at each slab.
          for (let q2 = 0; q2 < rf.slabs.length; q2++) {
            const h = rf.slabs[q2]!, sa = ga - h, sb = gb - h;
            if ((sa > 0) !== (sb > 0)) {
              const tc = ta + ((tb - ta) * sa) / (sa - sb);
              if (tc < tBlock) { tBlock = tc; blockedBy = "roof"; }
            }
          }
        }
        // Inner walls (M7.5c): only of buildings the line passes through.
        if (nt > 0 && rf.innerTo > rf.innerFrom) {
          const tIn = innerWallOnLine(ctx, rf.innerFrom, rf.innerTo, x0, y0, z0, dx, dy, dz);
          if (tIn < tBlock) { tBlock = tIn; blockedBy = "wall"; }
        }
      }
    }
  }

  // ---- vehicle hulls and wrecks (M7.1c): independent of the samples below (a hull between two samples counts)
  if (B.vehicles.n > 0) {
    const tv = vehicleOnLine(B.vehicles, x0, y0, z0, x1, y1, z1, ignoreA, ignoreB, tBlock);
    if (tv < tBlock) { tBlock = tv; blockedBy = "vehicle"; }
  }

  // ---- ground and vegetation. The ground is bilinear between height points, so its highest points along the
  // line lie where the line crosses the grid lines: it is sampled at every crossing and half-way between
  // (a crest one height point wide cannot slip between samples). Whole 8 m buckets whose ground and vegetation
  // lie a metre or more below the line are skipped.
  const cs = map.cellSizeM;
  const ts = LOS_TS;
  // The crossings with the x and y grid lines, each list ascending in t, merged (M7.3: the same sorted list a
  // sort gave, without its cost).
  const tx = LOS_TX, ty = LOS_TY;
  let nx = 0, ny = 0;
  if (dx !== 0) {
    const a0 = Math.ceil(Math.min(x0, x1) / cs), a1 = Math.floor(Math.max(x0, x1) / cs);
    if (dx > 0) for (let k = a0; k <= a1; k++) tx[nx++] = (k * cs - x0) / dx;
    else for (let k = a1; k >= a0; k--) tx[nx++] = (k * cs - x0) / dx;
  }
  if (dy !== 0) {
    const a0 = Math.ceil(Math.min(y0, y1) / cs), a1 = Math.floor(Math.max(y0, y1) / cs);
    if (dy > 0) for (let k = a0; k <= a1; k++) ty[ny++] = (k * cs - y0) / dy;
    else for (let k = a1; k >= a0; k--) ty[ny++] = (k * cs - y0) / dy;
  }
  ts.length = 0;
  {
    // 0, then the merged crossings, then 1 (values tied with 0 or 1 keep their place among equals).
    let i = 0, j = 0, startDone = false, endDone = false;
    const n = nx + ny + 2;
    while (ts.length < n) {
      const vx = i < nx ? tx[i]! : Infinity, vy = j < ny ? ty[j]! : Infinity;
      const v = vx <= vy ? vx : vy;
      if (!startDone && 0 <= v) { ts.push(0); startDone = true; continue; }
      if (!endDone && 1 <= v) { ts.push(1); endDone = true; continue; }
      if (vx <= vy) { ts.push(vx); i++; } else { ts.push(vy); j++; }
    }
  }
  const bm = B.bucketM, bcols = B.bcols, brows = B.brows;
  let vegM = 0, conceal = 0;
  const tEnd0 = len > 0 ? END_CLEARANCE_M / len : 0;
  for (let k = 0; k < ts.length * 2 - 1; k++) {
    // even k: a crossing; odd k: half-way to the next one
    const t = k % 2 === 0 ? ts[k / 2]! : (ts[(k - 1) / 2]! + ts[(k + 1) / 2]!) / 2;
    if (t < 0 || t > 1) continue;
    if (t > tBlock) break;
    const px = x0 + t * dx, py = y0 + t * dy, pz = z0 + t * dz;
    let bc = (px / bm) | 0, br = (py / bm) | 0;
    if (bc < 0) bc = 0; else if (bc >= bcols) bc = bcols - 1;
    if (br < 0) br = 0; else if (br >= brows) br = brows - 1;
    const bk = br * bcols + bc;
    if (pz - 1 > B.maxGround[bk]! && pz - 1 > B.maxVegTop[bk]!) continue;
    const g = heightAt(map, px, py);
    if (t > tEnd0 && t < 1 - tEnd0 && pz < g + GRAZE_M) return { visibility: 0, blockedBy: "ground", vegetationM: vegM, blockedAt: t };
    // Vegetation: the stretch from this sample to the next is charged to the cell this sample is in.
    if (k % 2 === 0 && k / 2 + 1 < ts.length) {
      const tm = (t + ts[k / 2 + 1]!) / 2;
      const qx = x0 + tm * dx, qy = y0 + tm * dy;
      const cc = Math.floor(qx / cs), cr = Math.floor(qy / cs);
      if (cc < 0 || cr < 0 || cc >= map.cols || cr >= map.rows) continue;
      const v = map.vegetation[cr * map.cols + cc]!;
      if (v === 0) continue;
      const top = B.vegHeightM[v - 1]!;
      const za = z0 + t * dz - heightAt(map, px, py), zb = z0 + ts[k / 2 + 1]! * dz - heightAt(map, x0 + ts[k / 2 + 1]! * dx, y0 + ts[k / 2 + 1]! * dy);
      // The share of this stretch that lies below the vegetation top (linear between its two ends).
      let below: number;
      if (za <= top && zb <= top) below = 1;
      else if (za > top && zb > top) below = 0;
      else below = za <= top ? (top - za) / (zb - za) : (top - zb) / (za - zb);
      if (below <= 0) continue;
      const segLen = (ts[k / 2 + 1]! - t) * len * below;
      vegM += segLen;
      conceal += B.vegConcealPerM[v - 1]! * segLen;
    }
  }
  if (blockedBy !== null) return { visibility: 0, blockedBy, vegetationM: vegM, blockedAt: tBlock };
  if (conceal > 0) visibility *= exp(-conceal);
  return { visibility, blockedBy: null, vegetationM: vegM, blockedAt: 1 };
}

/** Nearest point (0..1) where the line meets an inner wall [from, to) above its floor and outside a doorway; 2 if none. */
function innerWallOnLine(ctx: SimContext, from: number, to: number, x0: number, y0: number, z0: number, dx: number, dy: number, dz: number): number {
  const map = ctx.map, segs = ctx.mapIndex.segments, info = ctx.ballistics.seg;
  let best = 2;
  for (let si = from; si < to; si++) {
    const s = segs[si]!;
    const ex = s.bx - s.ax, ey = s.by - s.ay;
    const denom = dx * ey - dy * ex;
    if (denom > -1e-12 && denom < 1e-12) continue;
    const t = ((s.ax - x0) * ey - (s.ay - y0) * ex) / denom;
    if (t <= 1e-9 || t >= 1 - 1e-9 || t >= best) continue;
    const u = ((s.ax - x0) * dy - (s.ay - y0) * dx) / denom;
    if (u < 0 || u > 1) continue;
    const w = info[si]!;
    const rel = z0 + t * dz - heightAt(map, x0 + t * dx, y0 + t * dy);
    if (rel < w.baseM || rel > w.heightM) continue;
    if (w.openings) {
      const off = u * w.len;
      let open = false;
      for (const o of w.openings) if (off >= o.offsetM - o.widthM / 2 && off <= o.offsetM + o.widthM / 2 && rel >= o.sillM && rel <= o.headM) { open = true; break; }
      if (open) continue;
    }
    best = t;
  }
  return best;
}

/** The point an observer looks at on a man: the middle of what shows of him in this posture, m above ground. */
export const TARGET_POINT_M: Record<"standing" | "crouching" | "prone", number> = { standing: 1.2, crouching: 0.75, prone: 0.2 };

/** Eye height above the ground for a posture (a little below the top of the head). */
export function eyeHeightM(ctx: SimContext, posture: "standing" | "crouching" | "prone"): number {
  return Math.max(0.2, ctx.catalog.body.postures[posture].heightM - 0.12);
}
