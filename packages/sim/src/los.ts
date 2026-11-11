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
import { heightAt, pointInPolygon, segmentsInRect } from "./terrain";

export interface Sight {
  /** 0 (nothing gets through) .. 1 (a clear view). Product of see-through obstacles and vegetation. */
  visibility: number;
  /** What stopped the line completely, if anything. */
  blockedBy: "ground" | "wall" | "roof" | null;
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

export function sight(ctx: SimContext, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Sight {
  const map = ctx.map, B = ctx.ballistics, index = ctx.mapIndex;
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const len = sqrt(dx * dx + dy * dy);
  let visibility = 1, tWall = 2;

  // ---- walls, fences, hedges, house walls (doors, windows and breaches let it through)
  for (const si of segmentsInRect(index, x0, y0, x1, y1)) {
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
    const seen = new Set<number>();
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      for (const ri of B.roofBuckets[r * index.bcols + c]!) {
        if (seen.has(ri)) continue;
        seen.add(ri);
        const rf = B.roofs[ri]!, fp = rf.footprint, n = fp.length / 2;
        // Where the line enters and leaves the footprint (parameters of its crossings with the outline).
        const ts: number[] = [];
        for (let k = 0; k < n; k++) {
          const ax = fp[k * 2]!, ay = fp[k * 2 + 1]!, bx = fp[((k + 1) % n) * 2]!, by = fp[((k + 1) % n) * 2 + 1]!;
          const fx = bx - ax, fy = by - ay, de = dx * fy - dy * fx;
          if (de > -1e-12 && de < 1e-12) continue;
          const t = ((ax - x0) * fy - (ay - y0) * fx) / de, u = ((ax - x0) * dy - (ay - y0) * dx) / de;
          if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
        }
        if (pointInPolygon(fp, x0, y0)) ts.push(0);
        if (pointInPolygon(fp, x1, y1)) ts.push(1);
        ts.sort((a, b) => a - b);
        // A line through a corner crosses two edges at the same point: count it once.
        for (let k = ts.length - 1; k > 0; k--) if (ts[k]! - ts[k - 1]! < 1e-9) ts.splice(k, 1);
        for (let k = 0; k + 1 < ts.length; k += 2) {
          const ta = ts[k]!, tb = ts[k + 1]!;
          const za = z0 + ta * dz - heightAt(map, x0 + ta * dx, y0 + ta * dy) - rf.heightM;
          const zb = z0 + tb * dz - heightAt(map, x0 + tb * dx, y0 + tb * dy) - rf.heightM;
          if ((za > 0) !== (zb > 0)) {
            // Where it crosses the roof plane (linear between the two footprint crossings).
            const tc = ta + ((tb - ta) * za) / (za - zb);
            if (tc < tBlock) { tBlock = tc; blockedBy = "roof"; }
          }
        }
      }
    }
  }

  // ---- ground and vegetation. The ground is bilinear between height points, so its highest points along the
  // line lie where the line crosses the grid lines: it is sampled at every crossing and half-way between
  // (a crest one height point wide cannot slip between samples). Whole 8 m buckets whose ground and vegetation
  // lie a metre or more below the line are skipped.
  const cs = map.cellSizeM;
  const ts = LOS_TS;
  ts.length = 0;
  ts.push(0, 1);
  if (dx !== 0) { const a0 = Math.ceil(Math.min(x0, x1) / cs), a1 = Math.floor(Math.max(x0, x1) / cs); for (let k = a0; k <= a1; k++) ts.push((k * cs - x0) / dx); }
  if (dy !== 0) { const a0 = Math.ceil(Math.min(y0, y1) / cs), a1 = Math.floor(Math.max(y0, y1) / cs); for (let k = a0; k <= a1; k++) ts.push((k * cs - y0) / dy); }
  ts.sort((p, q) => p - q);
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

/** Eye height above the ground for a posture (a little below the top of the head). */
export function eyeHeightM(ctx: SimContext, posture: "standing" | "crouching" | "prone"): number {
  return Math.max(0.2, ctx.catalog.body.postures[posture].heightM - 0.12);
}
