/**
 * PROJECTILE FLIGHT AND IMPACTS (SPEC 6.3). Every projectile, every tick:
 *   1. drag (relative to the wind, air density from temperature) and gravity change its velocity;
 *   2. the straight segment it travels this tick is tested against the ground, walls, fences, hedges,
 *      embankments and building walls (swept test: a fast bullet cannot skip a thin wall);
 *   3. vegetation along the way may stop it (chance per metre from the terrain data);
 *   4. at a wall: ricochet if the angle is shallow enough for the material, otherwise penetrate if its
 *      remaining penetration exceeds the wall's steel-equivalent thickness along its path (losing energy and
 *      deviating a little), otherwise stop. Doors and windows let it through. At the ground: ricochet or stop.
 *   5. soldiers near the path are tested by body outline (systems/wounds.ts decides armour and wound; a bullet
 *      may fly on through); roofs stop or are pierced; explosive munitions rest, bounce and burst by fuse.
 *
 * Randomness comes from the "ballistics" stream. No allocation per projectile; one event per impact.
 */
import { addSuppression } from "./morale";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { DT, type EntityId } from "../ids";
import { cos, exp, pow, sin, sqrt } from "../math";
import { resolveBodyHit, ZONE_GROUPS } from "./wounds";
import { detonate } from "./explosions";
import type { AmmoRT } from "../ballistics";
import { addProjectile, ammoIndexOf, removeProjectile } from "../projectiles";
import { nextFloat, Streams } from "../rng";
import type { SimState } from "../state";
import { heightAt, pointInPolygon } from "../terrain";

const PAST_M = 0.01; // how far beyond a wall a penetrating bullet is placed
// The coarse grids already include neighbouring buckets; small margins cover rounding only.
const GROUND_MARGIN_M = 0.2;
const VEG_MARGIN_M = 0.1;

/** Put a projectile into the world. z is absolute height (heightfield datum). Internal: called by weapon systems. */
export function launchProjectile(
  ctx: SimContext, state: SimState, ammoId: string, x: number, y: number, z: number, vx: number, vy: number, vz: number, owner: EntityId,
): void {
  addProjectile(state.projectiles, ammoIndexOf(ctx.catalog, ammoId), x, y, z, vx, vy, vz, owner, state.tick);
}

/** Bursts found during this tick's pass over the projectiles: x, y, z, ammunition index, owner. */
const DET: number[] = [];
let detCount = 0;
function queueBurst(x: number, y: number, z: number, ammo: number, owner: number): void {
  const o = detCount++ * 5;
  DET[o] = x; DET[o + 1] = y; DET[o + 2] = z; DET[o + 3] = ammo; DET[o + 4] = owner;
}

/**
 * An explosive munition has struck a surface at (hx, hy, hz) whose normal (nx, ny, nz) points back toward where
 * it came from, with velocity (vx, vy, vz). Time fuse: it bounces — losing speed, more on soft ground
 * (`soft` < 1) — until it is slow enough to lie still. Impact fuse: it bursts just off the surface if it has
 * flown long enough to arm, else it is a dud. Returns true if the projectile is still in the pool.
 */
function settle(
  P: SimState["projectiles"], i: number, am: AmmoRT, tick: number, hx: number, hy: number, hz: number, nx: number, ny: number, nz: number,
  vx: number, vy: number, vz: number, soft: number, BN: { restitution: number; tangentKeep: number; stopSpeedMps: number },
  events: EventSink, material: string, surface: "ground" | "obstacle" | "building",
): boolean {
  if (am.fuseTicks > 0) {
    let vn = vx * nx + vy * ny + vz * nz;
    if (vn > 0) vn = 0;
    const e = BN.restitution * soft, k = BN.tangentKeep * soft;
    const bx = (vx - vn * nx) * k - e * vn * nx, by = (vy - vn * ny) * k - e * vn * ny, bz = (vz - vn * nz) * k - e * vn * nz;
    // (Reported just off the surface, on the side it came from: a man beyond the wall it struck is behind that wall.)
    events.emit({ kind: "grenade.landed", tick, x: hx + nx * 0.1, y: hy + ny * 0.1, z: hz + nz * 0.1, ammo: am.id, burstTick: P.bornTick[i]! + am.fuseTicks });
    if (bx * bx + by * by + bz * bz < BN.stopSpeedMps * BN.stopSpeedMps) {
      // Too slow to bounce again: on the ground it lies still; off a wall or ceiling it just drops.
      P.x[i] = hx + nx * 0.05; P.y[i] = hy + ny * 0.05; P.z[i] = hz + nz * 0.05;
      P.vx[i] = 0; P.vy[i] = 0; P.vz[i] = nz > 0.5 ? 0 : -0.01;
    } else {
      P.x[i] = hx + nx * 0.03; P.y[i] = hy + ny * 0.03; P.z[i] = hz + nz * 0.03;
      P.vx[i] = bx; P.vy[i] = by; P.vz[i] = bz;
    }
    return true;
  }
  const qx = hx + nx * 0.05, qy = hy + ny * 0.05, qz = hz + nz * 0.05;
  if (tick - P.bornTick[i]! >= am.armTicks) queueBurst(qx, qy, qz, P.ammo[i]!, P.owner[i]!);
  else events.emit({ kind: "impact", tick, x: qx, y: qy, z: qz, surface, result: "stopped", material, ammo: am.id, owner: P.owner[i]! });
  removeProjectile(P, i);
  return false;
}

let clipT0 = 0, clipT1 = 1;
/** Narrow the path interval [clipT0, clipT1] to where coordinate p + t*d lies in [lo, hi]; false if empty. */
function clip(p: number, d: number, lo: number, hi: number): boolean {
  if (d > -1e-12 && d < 1e-12) return p >= lo && p <= hi;
  let a = (lo - p) / d, b = (hi - p) / d;
  if (a > b) { const s = a; a = b; b = s; }
  if (a > clipT0) clipT0 = a;
  if (b < clipT1) clipT1 = b;
  return clipT0 <= clipT1;
}

export function projectileSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  const P = state.projectiles;
  if (P.count === 0) return;
  // Local aliases: imported bindings are slower to reach in some module runtimes (tests, tools); this loop
  // runs 20,000 times per tick.
  const dt = DT, sq = sqrt, hAt = heightAt, rnd = nextFloat, BAL = Streams.ballistics, remove = removeProjectile;
  const cosine = cos, sine = sin, bodyHit = resolveBodyHit, burst = detonate;
  const B = ctx.ballistics, bal = ctx.catalog.ballistics, map = ctx.map, index = ctx.mapIndex;
  const env = state.environment;
  const rho = (bal.airDensityKgM3 * (273.15 + bal.referenceTempC)) / (273.15 + env.temperatureC);
  const wx = env.windX, wy = env.windY;
  const gdt = bal.gravityMps2 * dt;
  const W = map.widthM, H = map.heightM;
  const bm = B.bucketM, bcols = B.bcols, brows = B.brows, maxGround = B.maxGround, maxVegTop = B.maxVegTop;
  const invBm = 1 / bm, wallNear = B.nearWall;
  const sm = index.bucketM, scols = index.bcols, srows = index.brows, sbuckets = index.buckets, segs = index.segments, segInfo = B.seg;
  const tick = state.tick, rng = state.rng;
  const X = P.x, Y = P.y, Z = P.z, VX = P.vx, VY = P.vy, VZ = P.vz, AMMO = P.ammo, BORN = P.bornTick;
  const ammoRT = B.ammo, maxAge = B.maxAgeTicks;

  // ---- soldiers this tick, bucketed, so only bullets passing close to someone test against bodies
  const SG = B.soldiers, hitboxes = B.hitboxes;
  {
    for (let q = 0; q < SG.touchedCount; q++) { const kk = SG.touched[q]!; SG.near[kk] = 0; SG.head[kk] = -1; }
    SG.touchedCount = 0;
    const count = state.soldier.size;
    if (count > SG.id.length) {
      const cap = Math.max(count, SG.id.length * 2);
      SG.id = new Int32Array(cap); SG.x = new Float64Array(cap); SG.y = new Float64Array(cap); SG.gz = new Float64Array(cap);
      SG.cf = new Float64Array(cap); SG.sf = new Float64Array(cap); SG.posture = new Uint8Array(cap); SG.next = new Int32Array(cap);
      SG.side = new Int32Array(cap); SG.sup = new Float64Array(cap);
      SG.touched = new Int32Array(cap * 10);
    }
    let n = 0;
    SG.sideOf.clear();
    for (const [id, s] of state.soldier.entries()) {
      const t = state.transform.get(id);
      if (!t) continue;
      const sd = state.identity.get(id)?.side ?? "";
      let sc = SG.sides.indexOf(sd);
      if (sc < 0) { sc = SG.sides.length; SG.sides.push(sd); }
      SG.side[n] = sc; SG.sup[n] = 0; SG.sideOf.set(id, sc);
      SG.id[n] = id; SG.x[n] = t.x; SG.y[n] = t.y; SG.gz[n] = hAt(map, t.x, t.y) + t.z;
      SG.cf[n] = cosine(t.heading); SG.sf[n] = sine(t.heading);
      SG.posture[n] = s.posture === "standing" ? 0 : s.posture === "crouching" ? 1 : 2;
      let c = (t.x * invBm) | 0, r = (t.y * invBm) | 0;
      if (c < 0) c = 0; if (r < 0) r = 0; if (c >= bcols) c = bcols - 1; if (r >= brows) r = brows - 1;
      const home = r * bcols + c;
      SG.next[n] = SG.head[home]!; SG.head[home] = n;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= brows || cc >= bcols) continue;
        const kk = rr * bcols + cc;
        if (SG.near[kk] === 0) { SG.touched[SG.touchedCount++] = kk; SG.near[kk] = 1; }
      }
      n++;
    }
    SG.n = n;
  }
  const reach = B.bodyReachM;
  const SUP = ctx.catalog.behaviour.suppression;
  const supR = SUP.nearMissRadiusM, supR2 = supR * supR, supPer = SUP.perRound, supERef = SUP.energyRefJ;
  const supCentreZ = [0, 1, 2].map((p) => hitboxes[p]!.height * (hitboxes[p]!.alongLength ? 0.5 : 0.6));
  const SX = SG.x, SY = SG.y, SGZ = SG.gz, SCF = SG.cf, SSF = SG.sf, solNear = SG.near;

  // NOTE (M2.4): never add projectiles inside this loop: the pool may reallocate its arrays, and the local
  // aliases above would then write to the old ones. Queue new projectiles (fragments) and add them afterwards.
  detCount = 0;
  const BN = bal.bounce, clutterH = bal.fragments.clutterHeightM, clutterK = bal.fragments.clutterStopPerM, ex = exp;
  const roofs = B.roofs, roofLow = B.roofLow, roofBuckets = B.roofBuckets, inPoly = pointInPolygon;
  for (let i = 0; i < P.count; ) {
    const am = ammoRT[AMMO[i]!]!;
    let vx = VX[i]!, vy = VY[i]!, vz = VZ[i]!;
    if (am.explosive) {
      // A time fuse runs out wherever the grenade is: in the air or lying on the ground.
      if (am.fuseTicks > 0 && tick - BORN[i]! >= am.fuseTicks) { queueBurst(X[i]!, Y[i]!, Z[i]!, AMMO[i]!, P.owner[i]!); remove(P, i); continue; }
      if (vx === 0 && vy === 0 && vz === 0) { i++; continue; } // lying where it landed
    }
    const rvx = vx - wx, rvy = vy - wy;
    // Drag: Cd(v) x v = min(dragMax x v, dragA x v + dragB), no powers needed.
    const rs = sq(rvx * rvx + rvy * rvy + vz * vz);
    const cdv = am.dragA * rs + am.dragB, cap = am.dragMax * rs;
    const a = am.kDrag * rho * (cdv < cap ? cdv : cap) * dt;
    // Quadratic drag integrated exactly for the speed (v / (1 + a)), so that even a tiny fragment that loses
    // most of its speed within one tick behaves; the distance flown uses the mean speed over the tick.
    // (For bullets a is a few thousandths: the series is exact to 1e-7 and saves two divisions per bullet.)
    let f: number, g: number;
    if (a < 0.02) { f = 1 - a + a * a; g = 1 - 0.5 * a; } else { f = 1 / (1 + a); g = 1 / (1 + 0.5 * a); }
    const x0 = X[i]!, y0 = Y[i]!, z0 = Z[i]!;
    let x1 = x0 + (wx + rvx * g) * dt, y1 = y0 + (wy + rvy * g) * dt, z1 = z0 + (vz * g - 0.5 * gdt) * dt;
    vx = wx + rvx * f; vy = wy + rvy * f; vz = vz * f - gdt;
    const speed2 = vx * vx + vy * vy + vz * vz;
    // Spent: too slow at the START of the tick (a light fragment may still wound early in its last tick).
    if ((rs * rs < am.minSpeed2 && !am.explosive) || tick - BORN[i]! > maxAge) {
      // Spent. An impact-fuse round still in the air after that long destroys itself (it never just vanishes).
      if (am.explosive && am.fuseTicks === 0) queueBurst(X[i]!, Y[i]!, Z[i]!, AMMO[i]!, P.owner[i]!);
      remove(P, i);
      continue;
    }
    // Leaving the map this tick: fly only as far as the edge (it may still strike something on the way),
    // then it is gone.
    let leaving = false;
    if (x1 < 0 || y1 < 0 || x1 >= W || y1 >= H) {
      leaving = true;
      let f = 1;
      if (x1 < 0) f = x0 / (x0 - x1); else if (x1 >= W) f = (W - x0) / (x1 - x0);
      if (y1 < 0) { const g = y0 / (y0 - y1); if (g < f) f = g; } else if (y1 >= H) { const g = (H - y0) / (y1 - y0); if (g < f) f = g; }
      f *= 0.999;
      if (!(f > 1e-6)) { remove(P, i); continue; }
      x1 = x0 + (x1 - x0) * f; y1 = y0 + (y1 - y0) * f; z1 = z0 + (z1 - z0) * f;
    }
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    const minX = x0 < x1 ? x0 : x1, maxX = x0 < x1 ? x1 : x0, minY = y0 < y1 ? y0 : y1, maxY = y0 < y1 ? y1 : y0;

    // ---- coarse rejection: sample the path every bucket (8 m) and compare its height there with the highest
    // ground / vegetation top of that bucket. Margins cover slopes between samples; a bullet that slips past
    // is caught on the next tick (it would then start below ground).
    let nearGround = false, nearVeg = false, nearWall = false, nearSoldier = false, nearRoof = false;
    const zTop = z0 > z1 ? z0 : z1;
    {
      const adx = dx < 0 ? -dx : dx, ady = dy < 0 ? -dy : dy;
      const ns = (((adx > ady ? adx : ady) * invBm) | 0) + 1;
      const inv = 1 / ns;
      for (let k = 0; k <= ns; k++) {
        const t = k * inv;
        let c = ((x0 + t * dx) * invBm) | 0, r = ((y0 + t * dy) * invBm) | 0;
        if (c >= bcols) c = bcols - 1; if (r >= brows) r = brows - 1;
        const kk = r * bcols + c, pz = z0 + t * dz;
        if (pz <= maxGround[kk]! + GROUND_MARGIN_M) nearGround = true;
        if (pz <= maxVegTop[kk]! + VEG_MARGIN_M) nearVeg = true;
        if (wallNear[kk] === 1) { nearWall = true; if (zTop >= roofLow[kk]!) nearRoof = true; } // roofs sit on walls
        if (solNear[kk] === 1) nearSoldier = true;
      }
    }

    if (am.explosive) { nearSoldier = false; nearVeg = false; } // a grenade does not wound by striking, and is not stopped by leaves

    // ---- walls (obstacles and building walls), nearest hit
    let tHit = 2, hitSeg = -1;
    if (nearWall) {
      let c0 = (minX / sm) | 0, c1 = (maxX / sm) | 0, r0 = (minY / sm) | 0, r1 = (maxY / sm) | 0;
      if (c0 < 0) c0 = 0; if (r0 < 0) r0 = 0; if (c1 >= scols) c1 = scols - 1; if (r1 >= srows) r1 = srows - 1;
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        const list = sbuckets[r * scols + c]!;
        for (let q = 0; q < list.length; q++) {
          const si = list[q]!;
          const s = segs[si]!;
          const ex = s.bx - s.ax, ey = s.by - s.ay;
          const denom = dx * ey - dy * ex;
          if (denom > -1e-12 && denom < 1e-12) continue;
          const t = ((s.ax - x0) * ey - (s.ay - y0) * ex) / denom;
          if (t <= 1e-9 || t > 1 || t >= tHit) continue;
          const u = ((s.ax - x0) * dy - (s.ay - y0) * dx) / denom;
          if (u < 0 || u > 1) continue;
          const info = segInfo[si]!;
          const rel = z0 + t * dz - hAt(map, x0 + t * dx, y0 + t * dy);
          if (rel < 0 || rel > info.heightM) continue;
          if (info.openings) {
            const off = u * info.len;
            let open = false;
            for (const o of info.openings) {
              if (off >= o.offsetM - o.widthM / 2 && off <= o.offsetM + o.widthM / 2 && rel >= o.sillM && rel <= o.headM) { open = true; break; }
            }
            if (open) continue;
          }
          tHit = t; hitSeg = si;
        }
      }
    }

    // ---- roofs: a flat lid at wall height over each building's footprint
    let tRoof = 2, roofIdx = -1;
    if (nearRoof && (dz > 1e-9 || dz < -1e-9)) {
      // Every roof whose bucket the path touches (not only those over its two ends: a steep round can enter
      // and leave a small house within one tick).
      const g0 = z0 - hAt(map, x0, y0), g1 = z1 - hAt(map, x1, y1);
      let c0 = (minX / sm) | 0, c1 = (maxX / sm) | 0, r0 = (minY / sm) | 0, r1 = (maxY / sm) | 0;
      if (c0 < 0) c0 = 0; if (r0 < 0) r0 = 0; if (c1 >= scols) c1 = scols - 1; if (r1 >= srows) r1 = srows - 1;
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        const list = roofBuckets[r * scols + c]!;
        for (let q = 0; q < list.length; q++) {
          const rf = roofs[list[q]!]!;
          const a0 = g0 - rf.heightM, a1 = g1 - rf.heightM;
          if ((a0 > 0) === (a1 > 0)) continue;
          const t = a0 / (a0 - a1);
          if (t >= tRoof || t > tHit || !inPoly(rf.footprint, x0 + t * dx, y0 + t * dy)) continue;
          tRoof = t; roofIdx = list[q]!;
        }
      }
    }

    // ---- soldiers: the path against each nearby man's body box (in his own frame: forward, left, up)
    let tBody = 2, bodyIdx = -1, bodyGroup = 0, bodyBand = 0, bodyLeft = false, bodyFrontal = true;
    if (nearSoldier) {
      const owner = P.owner[i]!;
      let c0 = ((minX - reach) * invBm) | 0, c1 = ((maxX + reach) * invBm) | 0, r0 = ((minY - reach) * invBm) | 0, r1 = ((maxY + reach) * invBm) | 0;
      if (c0 < 0) c0 = 0; if (r0 < 0) r0 = 0; if (c1 >= bcols) c1 = bcols - 1; if (r1 >= brows) r1 = brows - 1;
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        for (let j = SG.head[r * bcols + c]!; j !== -1; j = SG.next[j]!) {
          if (SG.id[j] === owner && !am.fragment) continue; // a man is not hit by the round leaving his own muzzle (his own fragments can)
          const hb = hitboxes[SG.posture[j]!]!;
          const rx = x0 - SX[j]!, ry = y0 - SY[j]!, cf = SCF[j]!, sf = SSF[j]!;
          const pf = rx * cf + ry * sf, pl = -rx * sf + ry * cf, pz = z0 - SGZ[j]!;
          const df = dx * cf + dy * sf, dl = -dx * sf + dy * cf;
          // Each band of the body is its own small box (trunk with the arms beside it, the head narrower...):
          // the round strikes the band it enters first. Space beside the head or between the legs is a miss.
          const L = hb.alongLength ? 2 * hb.halfF : hb.height;
          let best = 2, group = -1, bestEl = 0, band = 0;
          for (let q = 0; q < hb.bands.length; q++) {
            const bd = hb.bands[q]!;
            const w = bd.armsTo > bd.halfWidth ? bd.armsTo : bd.halfWidth;
            clipT0 = 0; clipT1 = 1;
            if (!clip(pl, dl, -w, w)) continue;
            if (hb.alongLength) {
              if (!clip(pf, df, hb.halfF - bd.to * L, hb.halfF - bd.from * L) || !clip(pz, dz, 0, hb.height)) continue;
            } else {
              if (!clip(pz, dz, bd.from * L, bd.to * L) || !clip(pf, df, -hb.halfF, hb.halfF)) continue;
            }
            if (clipT0 >= best) continue;
            best = clipT0;
            bestEl = pl + clipT0 * dl;
            const lat = bestEl < 0 ? -bestEl : bestEl;
            group = lat <= bd.halfWidth + 1e-9 ? bd.group : 5; // beside the trunk: an arm
            band = bd.group;
          }
          if (group < 0 || best >= tBody) continue;
          const tmin = best, el = bestEl;
          tBody = tmin; bodyIdx = j; bodyGroup = group; bodyBand = band; bodyLeft = el < 0; // +l is his right (y grows south)
          const adf = df < 0 ? -df : df, adl = dl < 0 ? -dl : dl;
          // Plates sit on the chest and back: a prone man struck along his length is not behind his plate.
          bodyFrontal = !hb.alongLength && adf >= adl;
        }
      }
    }

    // ---- ground: sample every terrain cell (the surface is smooth within a cell), then bisect
    let tGround = 2;
    if (nearGround) {
      const len = sq(dx * dx + dy * dy + dz * dz);
      const n = len <= map.cellSizeM ? 1 : Math.ceil(len / map.cellSizeM);
      let tPrev = 0;
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        if (t > tHit) break;
        if (z0 + t * dz <= hAt(map, x0 + t * dx, y0 + t * dy)) {
          let lo = tPrev, hi = t;
          for (let it = 0; it < 6; it++) {
            const mid = (lo + hi) / 2;
            if (z0 + mid * dz <= hAt(map, x0 + mid * dx, y0 + mid * dy)) hi = mid; else lo = mid;
          }
          tGround = hi;
          break;
        }
        tPrev = t;
      }
    }
    let tEnd = tGround < tHit ? tGround : tHit < 2 ? tHit : 1;
    if (tRoof < tEnd) tEnd = tRoof;
    if (tBody < tEnd) tEnd = tBody;

    // ---- suppression (M4.1): an enemy round passing within a few metres of a man, or striking near him,
    // cracks past him. Each round counts once per man: at the point of its flight closest to him (on this
    // tick's path only if that point lies on it, or at the impact if it ends here).
    if (nearSoldier && supR > 0 && !am.fragment) {
      const os = SG.sideOf.get(P.owner[i]!);
      const len2 = dx * dx + dy * dy + dz * dz;
      if (os !== undefined && len2 > 1e-12) {
        let c0 = ((minX - supR) * invBm) | 0, c1 = ((maxX + supR) * invBm) | 0, r0 = ((minY - supR) * invBm) | 0, r1 = ((maxY + supR) * invBm) | 0;
        if (c0 < 0) c0 = 0; if (r0 < 0) r0 = 0; if (c1 >= bcols) c1 = bcols - 1; if (r1 >= brows) r1 = brows - 1;
        let eK = -1;
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
          for (let j = SG.head[r * bcols + c]!; j !== -1; j = SG.next[j]!) {
            if (SG.side[j] === os) continue;
            const cz = SGZ[j]! + supCentreZ[SG.posture[j]!]!;
            const rx = SX[j]! - x0, ry = SY[j]! - y0, rz = cz - z0;
            let t = (rx * dx + ry * dy + rz * dz) / len2;
            if (t < 0 || (t >= 1 && tEnd >= 1)) continue; // closest before this path (counted earlier) or after it
            if (t > tEnd) t = tEnd;
            const ex2 = rx - t * dx, ey2 = ry - t * dy, ez2 = rz - t * dz;
            const d2 = ex2 * ex2 + ey2 * ey2 + ez2 * ez2;
            if (d2 > supR2) continue;
            if (eK < 0) { const e = 0.5 * am.massKg * speed2; eK = sq(e / supERef); if (eK > 2) eK = 2; if (eK < 0.25) eK = 0.25; }
            SG.sup[j] = SG.sup[j]! + supPer * eK * (1 - 0.5 * sq(d2) / supR);
          }
        }
      }
    }

    // ---- ground clutter: small folds and grass stop fragments that skim the ground (this is what makes
    // lying down worth it at a distance; the heightfield itself is smooth). Two samples along the free path.
    if (am.fragment && nearGround && clutterK > 0) {
      const half = sq(dx * dx + dy * dy) * tEnd * 0.5;
      let keep = 1;
      for (let q = 0; q < 2; q++) {
        const t = tEnd * (q === 0 ? 0.25 : 0.75);
        const hgt = z0 + t * dz - hAt(map, x0 + t * dx, y0 + t * dy);
        if (hgt < clutterH) keep *= ex(-clutterK * (1 - (hgt < 0 ? 0 : hgt) / clutterH) * half);
      }
      if (keep < 1 && rnd(rng, BAL) > keep) { remove(P, i); continue; }
    }

    // ---- vegetation: chance of being stopped along the free part of the path
    if (nearVeg) {
      const len2 = sq(dx * dx + dy * dy) * tEnd;
      const n = len2 <= map.cellSizeM ? 1 : Math.ceil(len2 / map.cellSizeM);
      const stepLen = (sq(dx * dx + dy * dy + dz * dz) * tEnd) / n;
      let pass = 1, vegIdx = 0, tFirst = 2, tLast = 0;
      for (let k = 0; k < n; k++) {
        const t = ((k + 0.5) / n) * tEnd;
        const px = x0 + t * dx, py = y0 + t * dy;
        const cc = (px / map.cellSizeM) | 0, cr = (py / map.cellSizeM) | 0;
        if (cc < 0 || cr < 0 || cc >= map.cols || cr >= map.rows) continue;
        const v = map.vegetation[cr * map.cols + cc]!;
        if (v === 0) continue;
        const stop = B.vegStopPerM[v - 1]!;
        if (stop <= 0 || z0 + t * dz - hAt(map, px, py) > B.vegHeightM[v - 1]!) continue;
        pass *= 1 - stop * stepLen;
        vegIdx = v;
        if (tFirst > 1) tFirst = (k / n) * tEnd;
        tLast = ((k + 1) / n) * tEnd;
      }
      if (pass < 1 && rnd(rng, BAL) > pass) {
        const t = tFirst + (tLast - tFirst) * rnd(rng, BAL); // somewhere in the vegetated stretch
        if (!am.fragment) events.emit({ kind: "impact", tick, x: x0 + t * dx, y: y0 + t * dy, z: z0 + t * dz, surface: "vegetation", result: "stopped", material: map.vegetationPalette[vegIdx - 1] ?? "", ammo: am.id, owner: P.owner[i]! });
        remove(P, i);
        continue;
      }
    }

    if (tBody <= 1 && tBody < tGround && tBody < tHit && tBody < tRoof) {
      // ---- a man is hit: armour, wound; a bullet may go through him
      const speedB = rs / (1 + a * tBody); // its speed where it strikes, not at the end of the tick
      const can = am.penSteelMm * pow(speedB / am.penV, bal.penetrationVelocityExponent);
      const energy = 0.5 * am.massKg * speedB * speedB;
      let through = bodyHit(ctx, state, events, SG.id[bodyIdx]!, ZONE_GROUPS[bodyGroup]!, bodyLeft, bodyFrontal, can, energy, am.id, P.owner[i]!, am.fragment);
      // Through the arm from the side and on into the trunk behind it.
      const WG = ctx.catalog.wounds.wounding;
      let trunk = bodyGroup !== 5 && bodyGroup !== 6;
      if (bodyGroup === 5 && !bodyFrontal && bodyBand !== 5 && rnd(state.rng, Streams.wounds) < WG.throughArmChance) {
        through *= bodyHit(ctx, state, events, SG.id[bodyIdx]!, ZONE_GROUPS[bodyBand]!, bodyLeft, false, can * WG.throughArmEnergy, energy * WG.throughArmEnergy, am.id, P.owner[i]!, am.fragment);
        trunk = true;
      }
      // A bullet that was not stopped flies on, much slowed (fragments stay in the body): the man behind is
      // not safe. It leaves the body outline where its path does.
      if (!am.fragment && through > 0) {
        const j = bodyIdx, hb = hitboxes[SG.posture[j]!]!;
        const rx = x0 - SX[j]!, ry = y0 - SY[j]!, cf = SCF[j]!, sf = SSF[j]!;
        clipT0 = 0; clipT1 = 1;
        const inside = clip(rx * cf + ry * sf, dx * cf + dy * sf, -hb.halfF, hb.halfF) && clip(-rx * sf + ry * cf, -dx * sf + dy * cf, -hb.halfL, hb.halfL) && clip(z0 - SGZ[j]!, dz, 0, hb.height);
        const out = speedB * (trunk ? WG.exit.trunk : WG.exit.limb) * sq(through);
        // It restarts just beyond the outline — further if he is moving, so that it cannot meet him again next
        // tick. If the tick's path ends inside the outline (along a prone man), or a wall, a roof or the ground
        // lies between where it struck and where it would come out, the round stays in him.
        const beyond = 0.05 + (state.mover.get(SG.id[j]!)?.speedMps ?? 0) * dt * 2;
        const tOut = clipT1 + beyond / (sq(dx * dx + dy * dy + dz * dz) + 1e-9);
        if (inside && tOut < 1 && tOut < tHit && tOut < tRoof && tOut < tGround && out * out > am.minSpeed2) {
          const end = sq(speed2), k = out / end;
          X[i] = x0 + tOut * dx; Y[i] = y0 + tOut * dy; Z[i] = z0 + tOut * dz;
          VX[i] = vx * k; VY[i] = vy * k; VZ[i] = vz * k;
          i++;
          continue;
        }
      }
      remove(P, i);
      continue;
    }

    if (tRoof <= 1 && tRoof < tGround && tRoof < tHit) {
      // ---- roof: stops, or is pierced with loss of speed (no ricochet off roofs)
      const rf = roofs[roofIdx]!, matR = B.materials[rf.material]!;
      const hx = x0 + tRoof * dx, hy = y0 + tRoof * dy, hz = z0 + tRoof * dz;
      if (am.explosive) {
        // It bounces off the roof (from below: off the ceiling, back down into the room). A burst is set just off
        // the surface on the side it came from, so its fragments are not swallowed by the roof it struck.
        if (settle(P, i, am, tick, hx, hy, hz, 0, 0, dz < 0 ? 1 : -1, vx, vy, vz, matR.bounce, BN, events, matR.id, "building")) i++;
        continue;
      }
      const endR = sq(speed2), speedR = rs / (1 + a * tRoof);
      const cosR = (vz < 0 ? -vz : vz) / endR;
      const needR = (matR.resistance * rf.thicknessM * 1000) / (cosR < 0.05 ? 0.05 : cosR);
      const vEffR = matR.breaks && speedR > am.penCapV ? am.penCapV : speedR;
      const canR = am.penSteelMm * pow(vEffR / am.penV, bal.penetrationVelocityExponent);
      if (canR > needR) {
        const k = (sq(1 - needR / canR) * speedR) / endR;
        X[i] = hx + (vx / endR) * PAST_M; Y[i] = hy + (vy / endR) * PAST_M; Z[i] = hz + (vz / endR) * PAST_M;
        VX[i] = vx * k; VY[i] = vy * k; VZ[i] = vz * k;
        if (!am.fragment) events.emit({ kind: "impact", tick, x: hx, y: hy, z: hz, surface: "building", result: "penetrated", material: matR.id, ammo: am.id, owner: P.owner[i]! });
        i++;
        continue;
      }
      if (!am.fragment) events.emit({ kind: "impact", tick, x: hx, y: hy, z: hz, surface: "building", result: "stopped", material: matR.id, ammo: am.id, owner: P.owner[i]! });
      remove(P, i);
      continue;
    }

    if (tGround > 1 && hitSeg < 0) {
      if (leaving) {
        // A grenade does not vanish at the map edge: it comes down there.
        if (am.explosive) { if (settle(P, i, am, tick, x1, y1, hAt(map, x1, y1), 0, 0, 1, 0, 0, 0, 1, BN, events, "", "ground")) i++; }
        else remove(P, i);
        continue;
      }
      // free flight
      X[i] = x1; Y[i] = y1; Z[i] = z1; VX[i] = vx; VY[i] = vy; VZ[i] = vz;
      i++;
      continue;
    }

    const speed = sq(speed2);
    const ux = vx / speed, uy = vy / speed, uz = vz / speed;
    const speedH = rs / (1 + a * (tGround < tHit ? tGround : tHit)); // speed where it strikes
    if (tGround < tHit) {
      // ---- ground impact
      const hx = x0 + tGround * dx, hy = y0 + tGround * dy;
      const hz = hAt(map, hx, hy);
      const e = 1;
      const sx = (hAt(map, hx + e, hy) - hAt(map, hx - e, hy)) / (2 * e), sy = (hAt(map, hx, hy + e) - hAt(map, hx, hy - e)) / (2 * e);
      const nl = sq(sx * sx + sy * sy + 1);
      const nx = -sx / nl, ny = -sy / nl, nz = 1 / nl;
      const dot = ux * nx + uy * ny + uz * nz; // negative when flying into the ground
      const cosInc = dot < 0 ? -dot : dot;
      let cell = ((hy / map.cellSizeM) | 0) * map.cols + ((hx / map.cellSizeM) | 0);
      if (cell < 0 || cell >= map.surface.length) cell = 0;
      const mat = B.materials[B.surfaceMaterial[map.surface[cell]!]!]!;
      if (am.explosive) {
        if (settle(P, i, am, tick, hx, hy, hz, nx, ny, nz, vx, vy, vz, map.vegetation[cell]! > 0 ? mat.bounce * BN.vegetationFactor : mat.bounce, BN, events, mat.id, "ground")) i++;
        continue;
      }
      if (cosInc < mat.sinCrit && rnd(rng, BAL) < 1 - cosInc / mat.sinCrit) {
        const keep = bal.ricochetSpeedRetention[0] + (bal.ricochetSpeedRetention[1] - bal.ricochetSpeedRetention[0]) * rnd(rng, BAL);
        const sc = B.scatterRad;
        let rx = ux - 2 * dot * nx + sc * (rnd(rng, BAL) * 2 - 1);
        let ry = uy - 2 * dot * ny + sc * (rnd(rng, BAL) * 2 - 1);
        let rz = uz - 2 * dot * nz + sc * rnd(rng, BAL); // scatter upward only: never back into the ground
        const rl = sq(rx * rx + ry * ry + rz * rz);
        rx /= rl; ry /= rl; rz /= rl;
        const ns = speedH * keep;
        X[i] = hx + nx * 0.02; Y[i] = hy + ny * 0.02; Z[i] = hz + nz * 0.02;
        VX[i] = rx * ns; VY[i] = ry * ns; VZ[i] = rz * ns;
        if (!am.fragment) events.emit({ kind: "impact", tick, x: hx, y: hy, z: hz, surface: "ground", result: "ricochet", material: mat.id, ammo: am.id, owner: P.owner[i]! });
        i++;
        continue;
      }
      if (!am.fragment) events.emit({ kind: "impact", tick, x: hx, y: hy, z: hz, surface: "ground", result: "stopped", material: mat.id, ammo: am.id, owner: P.owner[i]! });
      remove(P, i);
      continue;
    }

    // ---- wall impact
    const info = segInfo[hitSeg]!;
    const mat = B.materials[info.material]!;
    const hx = x0 + tHit * dx, hy = y0 + tHit * dy, hz = z0 + tHit * dz;
    const dot = ux * info.nx + uy * info.ny;
    const cosInc = dot < 0 ? -dot : dot;
    const surface = segs[hitSeg]!.owner;
    if (am.explosive) {
      // It bounces back off the wall (or bursts on it, with an impact fuse).
      const sgn = dot > 0 ? -1 : 1;
      if (settle(P, i, am, tick, hx, hy, hz, info.nx * sgn, info.ny * sgn, 0, vx, vy, vz, mat.bounce, BN, events, mat.id, surface)) i++;
      continue;
    }
    if (cosInc < mat.sinCrit && rnd(rng, BAL) < 1 - cosInc / mat.sinCrit) {
      const keep = bal.ricochetSpeedRetention[0] + (bal.ricochetSpeedRetention[1] - bal.ricochetSpeedRetention[0]) * rnd(rng, BAL);
      const sc = B.scatterRad;
      let rx = ux - 2 * dot * info.nx + sc * (rnd(rng, BAL) * 2 - 1);
      let ry = uy - 2 * dot * info.ny + sc * (rnd(rng, BAL) * 2 - 1);
      let rz = uz + sc * (rnd(rng, BAL) * 2 - 1);
      const rl = sq(rx * rx + ry * ry + rz * rz);
      rx /= rl; ry /= rl; rz /= rl;
      const ns = speedH * keep;
      X[i] = hx - ux * PAST_M; Y[i] = hy - uy * PAST_M; Z[i] = hz - uz * PAST_M;
      VX[i] = rx * ns; VY[i] = ry * ns; VZ[i] = rz * ns;
      if (!am.fragment) events.emit({ kind: "impact", tick, x: hx, y: hy, z: hz, surface, result: "ricochet", material: mat.id, ammo: am.id, owner: P.owner[i]! });
      i++;
      continue;
    }
    const need = (mat.resistance * info.thicknessM * 1000) / (cosInc < 0.05 ? 0.05 : cosInc);
    // Soft-core bullets break up on masonry, concrete, soil and wood: no gain above their break-up speed.
    const vEff = mat.breaks && speedH > am.penCapV ? am.penCapV : speedH;
    const can = am.penSteelMm * pow(vEff / am.penV, bal.penetrationVelocityExponent);
    if (can > need) {
      const frac = need / can;
      const d = B.deflectionRad * frac;
      let rx = ux + d * (rnd(rng, BAL) * 2 - 1);
      let ry = uy + d * (rnd(rng, BAL) * 2 - 1);
      let rz = uz + d * (rnd(rng, BAL) * 2 - 1);
      const rl = sq(rx * rx + ry * ry + rz * rz);
      rx /= rl; ry /= rl; rz /= rl;
      const ns = speedH * sq(1 - frac);
      X[i] = hx + ux * PAST_M; Y[i] = hy + uy * PAST_M; Z[i] = hz + uz * PAST_M;
      VX[i] = rx * ns; VY[i] = ry * ns; VZ[i] = rz * ns;
      if (!am.fragment) events.emit({ kind: "impact", tick, x: hx, y: hy, z: hz, surface, result: "penetrated", material: mat.id, ammo: am.id, owner: P.owner[i]! });
      i++;
      continue;
    }
    if (!am.fragment) events.emit({ kind: "impact", tick, x: hx, y: hy, z: hz, surface, result: "stopped", material: mat.id, ammo: am.id, owner: P.owner[i]! });
    remove(P, i);
  }
  // Suppression gathered from rounds passing close (M4.1).
  for (let j = 0; j < SG.n; j++) {
    if (SG.sup[j]! > 0) { const s = state.soldier.get(SG.id[j]!); if (s) addSuppression(ctx, s, SG.sup[j]!); }
  }
  // Bursts happen after the loop: they add fragments to the pool (never add projectiles inside the loop).
  for (let q = 0; q < detCount; q++) {
    const o = q * 5;
    burst(ctx, state, events, DET[o]!, DET[o + 1]!, DET[o + 2]!, DET[o + 3]!, DET[o + 4]!);
  }
  detCount = 0;
}
