/**
 * PROJECTILE FLIGHT AND IMPACTS (SPEC 6.3). Every projectile, every tick:
 *   1. drag (relative to the wind, air density from temperature) and gravity change its velocity;
 *   2. the straight segment it travels this tick is tested against the ground, walls, fences, hedges,
 *      embankments and building walls (swept test: a fast bullet cannot skip a thin wall);
 *   3. vegetation along the way may stop it (chance per metre from the terrain data);
 *   4. at a wall: ricochet if the angle is shallow enough for the material, otherwise penetrate if its
 *      remaining penetration exceeds the wall's steel-equivalent thickness along its path (losing energy and
 *      deviating a little), otherwise stop. Doors and windows let it through. At the ground: ricochet or stop.
 * Nobody is hurt yet (M2.3). Roofs are not modelled yet (M2.4, with plunging fire and fragments).
 *
 * Randomness comes from the "ballistics" stream. No allocation per projectile; one event per impact.
 */
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { DT, type EntityId } from "../ids";
import { pow, sqrt } from "../math";
import { addProjectile, ammoIndexOf, removeProjectile } from "../projectiles";
import { nextFloat, Streams } from "../rng";
import type { SimState } from "../state";
import { heightAt } from "../terrain";

const PAST_M = 0.01; // how far beyond a wall a penetrating bullet is placed
const GROUND_MARGIN_M = 1.0;
const VEG_MARGIN_M = 0.3;

/** Put a projectile into the world. z is absolute height (heightfield datum). Internal: called by weapon systems. */
export function launchProjectile(
  ctx: SimContext, state: SimState, ammoId: string, x: number, y: number, z: number, vx: number, vy: number, vz: number, owner: EntityId,
): void {
  addProjectile(state.projectiles, ammoIndexOf(ctx.catalog, ammoId), x, y, z, vx, vy, vz, owner, state.tick);
}

export function projectileSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  const P = state.projectiles;
  if (P.count === 0) return;
  // Local aliases: imported bindings are slower to reach in some module runtimes (tests, tools); this loop
  // runs 20,000 times per tick.
  const dt = DT, sq = sqrt, hAt = heightAt, rnd = nextFloat, BAL = Streams.ballistics, remove = removeProjectile;
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
  const ammoRT = B.ammo, minSpeed2 = B.minSpeed2, maxAge = B.maxAgeTicks;

  for (let i = 0; i < P.count; ) {
    const am = ammoRT[AMMO[i]!]!;
    let vx = VX[i]!, vy = VY[i]!, vz = VZ[i]!;
    const rvx = vx - wx, rvy = vy - wy;
    // Drag: Cd(v) x v = min(dragMax x v, dragA x v + dragB), no powers needed.
    const rs = sq(rvx * rvx + rvy * rvy + vz * vz);
    const cdv = am.dragA * rs + am.dragB, cap = am.dragMax * rs;
    const a = am.kDrag * rho * (cdv < cap ? cdv : cap) * dt;
    vx -= a * rvx; vy -= a * rvy; vz -= a * vz + gdt;
    const x0 = X[i]!, y0 = Y[i]!, z0 = Z[i]!;
    const x1 = x0 + vx * dt, y1 = y0 + vy * dt, z1 = z0 + vz * dt;
    const speed2 = vx * vx + vy * vy + vz * vz;
    if (speed2 < minSpeed2 || tick - BORN[i]! > maxAge || x1 < 0 || y1 < 0 || x1 >= W || y1 >= H) {
      remove(P, i); // spent, or left the map
      continue;
    }
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    const minX = x0 < x1 ? x0 : x1, maxX = x0 < x1 ? x1 : x0, minY = y0 < y1 ? y0 : y1, maxY = y0 < y1 ? y1 : y0;

    // ---- coarse rejection: sample the path every bucket (8 m) and compare its height there with the highest
    // ground / vegetation top of that bucket. Margins cover slopes between samples; a bullet that slips past
    // is caught on the next tick (it would then start below ground).
    let nearGround = false, nearVeg = false, nearWall = false;
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
        if (wallNear[kk] === 1) nearWall = true;
      }
    }

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
    const tEnd = tGround < tHit ? tGround : tHit < 2 ? tHit : 1;

    // ---- vegetation: chance of being stopped along the free part of the path
    if (nearVeg) {
      const len2 = sq(dx * dx + dy * dy) * tEnd;
      const n = len2 <= map.cellSizeM ? 1 : Math.ceil(len2 / map.cellSizeM);
      const stepLen = (sq(dx * dx + dy * dy + dz * dz) * tEnd) / n;
      let pass = 1;
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
      }
      if (pass < 1 && rnd(rng, BAL) > pass) {
        const t = tEnd * rnd(rng, BAL);
        events.emit({ kind: "impact", tick, x: x0 + t * dx, y: y0 + t * dy, z: z0 + t * dz, surface: "vegetation", result: "stopped", material: "vegetation", ammo: am.id, owner: P.owner[i]! });
        remove(P, i);
        continue;
      }
    }

    if (tGround > 1 && hitSeg < 0) {
      // free flight
      X[i] = x1; Y[i] = y1; Z[i] = z1; VX[i] = vx; VY[i] = vy; VZ[i] = vz;
      i++;
      continue;
    }

    const speed = sq(speed2);
    const ux = vx / speed, uy = vy / speed, uz = vz / speed;
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
      if (cosInc < mat.sinCrit && rnd(rng, BAL) < 1 - cosInc / mat.sinCrit) {
        const keep = bal.ricochetSpeedRetention[0] + (bal.ricochetSpeedRetention[1] - bal.ricochetSpeedRetention[0]) * rnd(rng, BAL);
        const sc = B.scatterRad;
        let rx = ux - 2 * dot * nx + sc * (rnd(rng, BAL) * 2 - 1);
        let ry = uy - 2 * dot * ny + sc * (rnd(rng, BAL) * 2 - 1);
        let rz = uz - 2 * dot * nz + sc * rnd(rng, BAL); // scatter upward only: never back into the ground
        const rl = sq(rx * rx + ry * ry + rz * rz);
        rx /= rl; ry /= rl; rz /= rl;
        const ns = speed * keep;
        X[i] = hx + nx * 0.02; Y[i] = hy + ny * 0.02; Z[i] = hz + nz * 0.02;
        VX[i] = rx * ns; VY[i] = ry * ns; VZ[i] = rz * ns;
        events.emit({ kind: "impact", tick, x: hx, y: hy, z: hz, surface: "ground", result: "ricochet", material: mat.id, ammo: am.id, owner: P.owner[i]! });
        i++;
        continue;
      }
      events.emit({ kind: "impact", tick, x: hx, y: hy, z: hz, surface: "ground", result: "stopped", material: mat.id, ammo: am.id, owner: P.owner[i]! });
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
    if (cosInc < mat.sinCrit && rnd(rng, BAL) < 1 - cosInc / mat.sinCrit) {
      const keep = bal.ricochetSpeedRetention[0] + (bal.ricochetSpeedRetention[1] - bal.ricochetSpeedRetention[0]) * rnd(rng, BAL);
      const sc = B.scatterRad;
      let rx = ux - 2 * dot * info.nx + sc * (rnd(rng, BAL) * 2 - 1);
      let ry = uy - 2 * dot * info.ny + sc * (rnd(rng, BAL) * 2 - 1);
      let rz = uz + sc * (rnd(rng, BAL) * 2 - 1);
      const rl = sq(rx * rx + ry * ry + rz * rz);
      rx /= rl; ry /= rl; rz /= rl;
      const ns = speed * keep;
      X[i] = hx - ux * PAST_M; Y[i] = hy - uy * PAST_M; Z[i] = hz - uz * PAST_M;
      VX[i] = rx * ns; VY[i] = ry * ns; VZ[i] = rz * ns;
      events.emit({ kind: "impact", tick, x: hx, y: hy, z: hz, surface, result: "ricochet", material: mat.id, ammo: am.id, owner: P.owner[i]! });
      i++;
      continue;
    }
    const need = (mat.resistance * info.thicknessM * 1000) / (cosInc < 0.05 ? 0.05 : cosInc);
    const can = am.penSteelMm * pow(speed / am.penV, bal.penetrationVelocityExponent);
    if (can > need) {
      const frac = need / can;
      const d = B.deflectionRad * frac;
      let rx = ux + d * (rnd(rng, BAL) * 2 - 1);
      let ry = uy + d * (rnd(rng, BAL) * 2 - 1);
      let rz = uz + d * (rnd(rng, BAL) * 2 - 1);
      const rl = sq(rx * rx + ry * ry + rz * rz);
      rx /= rl; ry /= rl; rz /= rl;
      const ns = speed * sq(1 - frac);
      X[i] = hx + ux * PAST_M; Y[i] = hy + uy * PAST_M; Z[i] = hz + uz * PAST_M;
      VX[i] = rx * ns; VY[i] = ry * ns; VZ[i] = rz * ns;
      events.emit({ kind: "impact", tick, x: hx, y: hy, z: hz, surface, result: "penetrated", material: mat.id, ammo: am.id, owner: P.owner[i]! });
      i++;
      continue;
    }
    events.emit({ kind: "impact", tick, x: hx, y: hy, z: hz, surface, result: "stopped", material: mat.id, ammo: am.id, owner: P.owner[i]! });
    remove(P, i);
  }
}
