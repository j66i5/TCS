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
import { patchNavGrids } from "../navctx";
import { deriveWrecks } from "../hulls";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { secondsToTicks, type EntityId } from "../ids";
import { cos, hypot2, PI, pow, sin, sqrt } from "../math";
import { ammoIndexOf, reserveProjectiles } from "../projectiles";
import { rngStream, streamFloat, Streams } from "../rng";
import type { SimState } from "../state";
import { heightAt, standZ, interiorSegmentsInRectInto, segmentsInRectInto } from "../terrain";
import { applyBlast } from "./wounds";
import { markHouseDanger } from "./house";

/**
 * Re-derive everything that depends on terrain damage (after a new breach, and after loading a save).
 * With a rectangle (m), only the navigation cells there are re-derived (`patchNavGrids`, equal to a full
 * rebuild); without one every grid is dropped and rebuilt on next use. Wrecks are stamped from the vehicles.
 */
export function syncTerrainDamage(ctx: SimContext, state: SimState, rect?: readonly [number, number, number, number]): void {
  applyBreaches(ctx.ballistics, ctx.mapIndex, state.terrain.breaches);
  ctx.breaches = state.terrain.breaches;
  if (rect) { patchNavGrids(ctx, rect[0], rect[1], rect[2], rect[3]); return; }
  deriveWrecks(ctx, state);
  ctx.nav = {}; // routes are planned on grids rebuilt with the holes in them
}

/** Scratch list of inner walls near a burst (M7.5c). */
const BREACH_IN: number[] = [];
/** Scratch list of wall segments near a burst (reused: no allocation per burst). */
const BREACH_SEGS: number[] = [];

/**
 * The storey of building `id` a burst at height `rel` above the ground is on, as [bottom, top] above the ground
 * (M7.5 review fix), for a building with an interior and floors above; null otherwise (the whole wall).
 */
function storeyBand(map: SimContext["map"], id: number, rel: number): [number, number] | null {
  const b = map.buildings.find((q) => q.id === id);
  if (!b?.interior || b.storeys < 2) return null;
  const H = b.storeyHeightM;
  const f = Math.min(Math.max(Math.floor(Math.max(rel, 0) / H), 0), b.storeys - 1);
  return [f * H, (f + 1) * H];
}

export function detonate(ctx: SimContext, state: SimState, events: EventSink, x: number, y: number, z: number, ammoIdx: number, owner: EntityId): void {
  const ammoId = ctx.catalog.ammoIds[ammoIdx]!;
  const def = ctx.catalog.ammo[ammoId];
  // A hand smoke grenade (D1): its fuse has run, it smokes where it lies (no blast, no fragments).
  if (def?.smoke) {
    state.smoke.push({ x, y, radiusM: def.smoke.radiusM, startTick: state.tick, untilTick: state.tick + secondsToTicks(def.smoke.seconds) });
    events.emit({ kind: "smoke.grenade", tick: state.tick, x, y, radiusM: def.smoke.radiusM, ammo: ammoId, owner });
    return;
  }
  const ex = def?.explosive;
  if (!ex) return;
  const bal = ctx.catalog.ballistics, BL = bal.blast, map = ctx.map;
  const cube = pow(ex.fillingKg, 1 / 3);
  const severeR = BL.severeScaledM * cube, injuryR = BL.injuryScaledM * cube, stunR = BL.stunScaledM * cube;
  events.emit({ kind: "explosion", tick: state.tick, x, y, z, ammo: ammoId, owner, stunRadiusM: stunR });
  suppressByBurst(ctx, state, x, y, stunR, state.identity.get(owner)?.side);

  // ---- blast
  for (const [id, s] of state.soldier.entries()) {
    if (!s.physiology.alive || s.mount !== undefined) continue; // men aboard are behind armour (M7)
    const t = state.transform.get(id);
    if (!t) continue;
    const dx = t.x - x, dy = t.y - y;
    if (dx > stunR || dx < -stunR || dy > stunR || dy < -stunR) continue;
    const cz = standZ(map, t) + ctx.catalog.body.postures[s.posture].heightM * 0.5;
    const d = sqrt(dx * dx + dy * dy + (cz - z) * (cz - z));
    if (d > stunR) continue;
    if (d > 0.3 && lineBlocked(ctx.ballistics, map, ctx.mapIndex, x, y, z, t.x, t.y, cz, BL.shieldSteelMm)) continue;
    applyBlast(ctx, state, events, id, d, severeR, injuryR, stunR, owner);
  }

  // ---- the men in the house it bursts in or on remember it (M7.5e: a house that has become a trap)
  markHouseDanger(ctx, state, x, y, ex.fillingKg, owner);

  // ---- fragments
  const fragIdx = ammoIndexOf(ctx.catalog, ex.fragmentAmmo);
  // On the ground the lower half goes into the earth; a burst in the air (fuse ran out in flight, a round
  // striking a wall or a ceiling) throws fragments downward too.
  // ground: ok (a burst above the ground; one on an upper floor counts as in the air: fragments both ways)
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
  const ground = heightAt(map, x, y); // ground: ok (craters)
  if (z - ground < 0.5 && BL.craterScaledM > 0) {
    const r = BL.craterScaledM * cube;
    state.terrain.craters.push({ x, y, radiusM: r, depthM: r * 0.4, tick: state.tick });
  }
  const reach = BL.breachReachScaledM * cube, strength = BL.breachSteelMmScaled * cube, width = BL.breachWidthScaledM * cube;
  let breached = false;
  let bx0 = x, by0 = y, bx1 = x, by1 = y;
  let nSeg = segmentsInRectInto(ctx.mapIndex, x - reach, y - reach, x + reach, y + reach, BREACH_SEGS);
  // Inner walls of building interiors too (M7.5c), after the outer walls.
  if (ctx.mapIndex.segments.length > ctx.mapIndex.nOuter) {
    const nIn = interiorSegmentsInRectInto(ctx.mapIndex, x - reach, y - reach, x + reach, y + reach, BREACH_IN);
    for (let q = 0; q < nIn; q++) BREACH_SEGS[nSeg++] = BREACH_IN[q]!;
  }
  for (let q = 0; q < nSeg; q++) {
    const si = BREACH_SEGS[q]!;
    const s = ctx.mapIndex.segments[si]!, info = ctx.ballistics.seg[si]!;
    const exx = s.bx - s.ax, eyy = s.by - s.ay;
    let u = ((x - s.ax) * exx + (y - s.ay) * eyy) / (info.len * info.len);
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const px = s.ax + u * exx, py = s.ay + u * eyy;
    if (hypot2(px - x, py - y) > reach) continue;
    const rel = z - heightAt(map, px, py); // ground: ok (walls stand on the ground)
    if (rel > info.heightM + reach || (info.baseM > 0 && rel < info.baseM - reach)) continue;
    const mat = ctx.ballistics.materials[info.material]!;
    if (mat.resistance * info.thicknessM * 1000 >= strength) continue;
    const off = u * info.len;
    // The outer wall of a building with floors (M7.5 review fix): the hole is in the storey the burst is on.
    const band = s.owner === "building" && info.baseM === 0 ? storeyBand(map, s.id, rel) : null;
    const lo = band ? band[0] : info.baseM;
    // Not where the wall is already open (from the bottom of that storey).
    if (info.openings && info.openings.some((o) => off >= o.offsetM - o.widthM / 2 && off <= o.offsetM + o.widthM / 2 && o.sillM <= lo + 0.01 && (!band || o.headM > lo + 1))) continue;
    state.terrain.breaches.push({ owner: s.owner, id: s.id, part: s.part, offsetM: off, widthM: width, ...(band ? { sillM: band[0], headM: band[1] } : {}), tick: state.tick });
    events.emit({ kind: "terrain.breached", tick: state.tick, x: px, y: py, owner: s.owner, id: s.id });
    breached = true;
    bx0 = Math.min(bx0, px - width); by0 = Math.min(by0, py - width); bx1 = Math.max(bx1, px + width); by1 = Math.max(by1, py + width);
  }
  if (breached) syncTerrainDamage(ctx, state, [bx0, by0, bx1, by1]);
}
