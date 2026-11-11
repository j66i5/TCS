/**
 * BURSTS (SPEC 6.3): what happens where an explosive munition goes off.
 *
 * 1. Blast: by distance, scaled with the cube root of the filling — severe injury very close, injury a little
 *    further, stunned beyond that; a wall between the burst and a man shields him.
 * 2. Fragments: real projectiles with a spread of speeds, sent out evenly in all directions inside the
 *    elevation band where they can meet anything (the rest go into the ground or the sky and are not simulated).
 * 3. Terrain damage: a crater, and a hole in any nearby wall thin enough to be blown through. Both are stored
 *    in the battle state (they save, replay and can be carried into a campaign).
 */
import { suppressByBurst } from "./morale";
import { applyBreaches, lineBlocked } from "../ballistics";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import type { EntityId } from "../ids";
import { cos, hypot2, PI, pow, sin, sqrt } from "../math";
import { ammoIndexOf, reserveProjectiles } from "../projectiles";
import { rngStream, streamFloat, Streams } from "../rng";
import type { SimState } from "../state";
import { heightAt, segmentsInRect } from "../terrain";
import { applyBlast } from "./wounds";

/** Re-derive everything that depends on terrain damage (after a new breach, and after loading a save). */
export function syncTerrainDamage(ctx: SimContext, state: SimState): void {
  applyBreaches(ctx.ballistics, ctx.mapIndex, state.terrain.breaches);
  ctx.breaches = state.terrain.breaches;
  ctx.nav = {}; // routes are planned on grids rebuilt with the holes in them
}

export function detonate(ctx: SimContext, state: SimState, events: EventSink, x: number, y: number, z: number, ammoIdx: number, owner: EntityId): void {
  const ammoId = ctx.catalog.ammoIds[ammoIdx]!;
  const ex = ctx.catalog.ammo[ammoId]?.explosive;
  if (!ex) return;
  const bal = ctx.catalog.ballistics, BL = bal.blast, map = ctx.map;
  const cube = pow(ex.fillingKg, 1 / 3);
  const severeR = BL.severeScaledM * cube, injuryR = BL.injuryScaledM * cube, stunR = BL.stunScaledM * cube;
  events.emit({ kind: "explosion", tick: state.tick, x, y, z, ammo: ammoId, owner, stunRadiusM: stunR });
  suppressByBurst(ctx, state, x, y, stunR);

  // ---- blast
  for (const [id, s] of state.soldier.entries()) {
    if (!s.physiology.alive) continue;
    const t = state.transform.get(id);
    if (!t) continue;
    const dx = t.x - x, dy = t.y - y;
    if (dx > stunR || dx < -stunR || dy > stunR || dy < -stunR) continue;
    const cz = heightAt(map, t.x, t.y) + t.z + ctx.catalog.body.postures[s.posture].heightM * 0.5;
    const d = sqrt(dx * dx + dy * dy + (cz - z) * (cz - z));
    if (d > stunR) continue;
    if (d > 0.3 && lineBlocked(ctx.ballistics, map, ctx.mapIndex, x, y, z, t.x, t.y, cz, BL.shieldSteelMm)) continue;
    applyBlast(ctx, state, events, id, d, severeR, injuryR, stunR, owner);
  }

  // ---- fragments
  const fragIdx = ammoIndexOf(ctx.catalog, ex.fragmentAmmo);
  // On the ground the lower half goes into the earth; a burst in the air (fuse ran out in flight, a round
  // striking a wall or a ceiling) throws fragments downward too.
  const airborne = z - heightAt(map, x, y) > bal.fragments.airburstAboveM;
  const lo = airborne ? -1 : sin((bal.fragments.bandDeg[0] * PI) / 180), hi = sin((bal.fragments.bandDeg[1] * PI) / 180);
  const n = Math.min(bal.fragments.maxPerBurst, Math.round((ex.fragmentCount * (hi - lo)) / 2));
  const P = state.projectiles;
  const v0 = ex.fragmentVelocityMps[0], dv = ex.fragmentVelocityMps[1] - v0;
  // Thousands of fragments per burst: write straight into the pool with local aliases (see CLAUDE.md, hot loops).
  reserveProjectiles(P, n);
  const st = rngStream(state.rng, Streams.fragments), rnd = streamFloat, C = cos, S = sin, Q = sqrt, TWO_PI = 2 * PI;
  const X = P.x, Y = P.y, Z = P.z, VX = P.vx, VY = P.vy, VZ = P.vz, AM = P.ammo, OW = P.owner, BT = P.bornTick, tick = state.tick, span = hi - lo;
  let i = P.count;
  for (let k = 0; k < n; k++, i++) {
    const az = TWO_PI * rnd(st);
    const se = lo + span * rnd(st); // even over the sphere: uniform in sin(elevation)
    const vh = (v0 + dv * rnd(st));
    const ce = Q(1 - se * se) * vh;
    X[i] = x; Y[i] = y; Z[i] = z; VX[i] = ce * C(az); VY[i] = ce * S(az); VZ[i] = vh * se;
    AM[i] = fragIdx; OW[i] = owner; BT[i] = tick;
  }
  P.count = i;

  // ---- terrain damage
  const ground = heightAt(map, x, y);
  if (z - ground < 0.5 && BL.craterScaledM > 0) {
    const r = BL.craterScaledM * cube;
    state.terrain.craters.push({ x, y, radiusM: r, depthM: r * 0.4, tick: state.tick });
  }
  const reach = BL.breachReachScaledM * cube, strength = BL.breachSteelMmScaled * cube, width = BL.breachWidthScaledM * cube;
  let breached = false;
  for (const si of segmentsInRect(ctx.mapIndex, x - reach, y - reach, x + reach, y + reach)) {
    const s = ctx.mapIndex.segments[si]!, info = ctx.ballistics.seg[si]!;
    const exx = s.bx - s.ax, eyy = s.by - s.ay;
    let u = ((x - s.ax) * exx + (y - s.ay) * eyy) / (info.len * info.len);
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const px = s.ax + u * exx, py = s.ay + u * eyy;
    if (hypot2(px - x, py - y) > reach) continue;
    const rel = z - heightAt(map, px, py);
    if (rel > info.heightM + reach) continue;
    const mat = ctx.ballistics.materials[info.material]!;
    if (mat.resistance * info.thicknessM * 1000 >= strength) continue;
    const off = u * info.len;
    // Not where the wall is already open.
    if (info.openings && info.openings.some((o) => off >= o.offsetM - o.widthM / 2 && off <= o.offsetM + o.widthM / 2 && o.sillM <= 0.01)) continue;
    state.terrain.breaches.push({ owner: s.owner, id: s.id, part: s.part, offsetM: off, widthM: width, tick: state.tick });
    events.emit({ kind: "terrain.breached", tick: state.tick, x: px, y: py, owner: s.owner, id: s.id });
    breached = true;
  }
  if (breached) syncTerrainDamage(ctx, state);
}
