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
import { onRoof } from "../mount";
import { addSmoke } from "../smoke";
import { suppressByBurst } from "./morale";
import { applyBreaches, lineBlocked } from "../ballistics";
import { patchNavGrids } from "../navctx";
import { deriveWrecks } from "../hulls";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import type { EntityId } from "../ids";
import { cos, hypot2, PI, pow, sin, sqrt } from "../math";
import { ammoIndexOf, reserveProjectiles } from "../projectiles";
import { rngStream, streamFloat, Streams } from "../rng";
import type { SimState } from "../state";
import { heightAt, standZ, interiorSegmentsInRectInto, segmentsInRectInto } from "../terrain";
import { applyBlast } from "./wounds";
import { markHouseDanger } from "./house";
import { floorAtZ, indoorAt, roomOfPoint } from "../interior-nav";
import { roomAt } from "../interior";
import { rimHeight, rimStops } from "../positions";
import { cacheBurst } from "./supply";

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

/** M7.6d: a thermobaric round bursting this close outside a building's wall fills the room just inside (m). */
const THERMOBARIC_WALL_M = 0.6;

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

/** M11.9c: a burst within `prisoners.pcp.fireM` of a prisoner collection point is noted on it (systems/prisoners.ts
 *  moves the point and counts the seconds it was under fire). */
export function notePointFire(ctx: SimContext, state: SimState, x: number, y: number): void {
  const r = ctx.catalog.prisoners?.pcp.fireM;
  if (r === undefined || r <= 0 || state.rear.size === 0) return;
  for (const [, p] of state.rear.entries()) {
    if (p.kind !== "prisoners" || (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y) > r * r) continue;
    p.fire = { tick: state.tick, x, y };
  }
}

/**
 * A round goes off at (x, y, z). `dir` (balance pass 5, area fire): set off in flight by its programmed (air-burst)
 * fuze, flying with this velocity: a round with an air-burst cone (`airburst.cone`, KETF) ejects its payload forward
 * along it instead of bursting; one without bursts as usual, in the air.
 */
export function detonate(ctx: SimContext, state: SimState, events: EventSink, x: number, y: number, z: number, ammoIdx: number, owner: EntityId, dir?: readonly [number, number, number]): void {
  const ammoId = ctx.catalog.ammoIds[ammoIdx]!;
  const def = ctx.catalog.ammo[ammoId];
  // A hand smoke grenade (D1): its fuse has run, it smokes where it lies (no blast, no fragments).
  if (def?.smoke) {
    // M8.1 volume: a low plume fed while it burns (`seconds`), lingering over the fade after it burns out.
    addSmoke(ctx, state, x, y, def.smoke.radiusM, def.smoke.seconds + (ctx.catalog.spotting.smokeFadeSeconds ?? 0), def.smoke.topM ?? 4, def.smoke.seconds);
    events.emit({ kind: "smoke.grenade", tick: state.tick, x, y, radiusM: def.smoke.radiusM, ammo: ammoId, owner });
    return;
  }
  const ex = def?.explosive;
  if (!ex) return;
  const cone = dir !== undefined ? def!.airburst?.cone : undefined;
  if (cone !== undefined) { ejectCone(ctx, state, events, x, y, z, ammoId, owner, dir!, cone); return; }
  const bal = ctx.catalog.ballistics, BL = bal.blast, map = ctx.map;
  const cube = pow(ex.fillingKg, 1 / 3);
  const severeR = BL.severeScaledM * cube, injuryR = BL.injuryScaledM * cube, stunR = BL.stunScaledM * cube;
  events.emit({ kind: "explosion", tick: state.tick, x, y, z, ammo: ammoId, owner, stunRadiusM: stunR });
  suppressByBurst(ctx, state, x, y, stunR, state.identity.get(owner)?.side);
  notePointFire(ctx, state, x, y);

  // ---- blast
  // M7.6d (SPEC 3, an abstract effect): a thermobaric filling bursting in a room (or on its outer wall) fills it:
  // every man in that room takes the blast at the radii x `enclosedFactor`, no wall shielding him.
  const room = ex.thermobaric ? roomOfPoint(ctx, x, y, z - heightAt(map, x, y), THERMOBARIC_WALL_M) : null; // ground: ok (the burst's floor)
  const holeHalf = (state.terrain.positions?.length ?? 0) > 0 ? ctx.catalog.ballistics.fightingPosition?.halfWidthM ?? 0 : 0;
  const rb = room ? map.buildings[room.bi]! : null, k = room ? ex.thermobaric!.enclosedFactor : 1, reachR = stunR * k;
  for (const [id, s] of state.soldier.entries()) {
    if (!s.physiology.alive || (s.mount !== undefined && !onRoof(state, id))) continue; // men aboard are behind armour (M7; not one out on the roof, M9.3a)
    const t = state.transform.get(id);
    if (!t) continue;
    const dx = t.x - x, dy = t.y - y;
    if (dx > reachR || dx < -reachR || dy > reachR || dy < -reachR) continue;
    const cz = standZ(map, t) + ctx.catalog.body.postures[s.posture].heightM * 0.5;
    const d = sqrt(dx * dx + dy * dy + (cz - z) * (cz - z));
    if (rb && indoorAt(ctx, t.x, t.y) === room!.bi && floorAtZ(rb, t.z) === room!.floor && roomAt(rb, room!.floor, t.x, t.y) === room!.room) {
      if (d <= reachR) applyBlast(ctx, state, events, id, d, severeR * k, injuryR * k, reachR, owner);
      continue;
    }
    if (d > stunR) continue;
    if (d > 0.3 && lineBlocked(ctx.ballistics, map, ctx.mapIndex, x, y, z, t.x, t.y, cz, BL.shieldSteelMm)) continue;
    // (M11: in a fighting position, a burst whose line to his middle comes in under the rim does not reach him.)
    if (holeHalf > 0 && rimStops(holeHalf, rimHeight(ctx, state, id), t.x, t.y, cz - ctx.catalog.body.postures[s.posture].heightM * 0.5, x, y, z, cz)) continue;
    applyBlast(ctx, state, events, id, d, severeR, injuryR, stunR, owner);
  }

  // ---- the men in the house it bursts in or on remember it (M7.5e: a house that has become a trap)
  markHouseDanger(ctx, state, x, y, ex.fillingKg, owner);
  // ---- caches nearby lose hp and may be set off (M11.3)
  if (state.cache.size > 0) cacheBurst(ctx, state, events, x, y, ex.fillingKg);

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
  const X = P.x, Y = P.y, Z = P.z, VX = P.vx, VY = P.vy, VZ = P.vz, AM = P.ammo, OW = P.owner, BT = P.bornTick, BU = P.burstTick, tick = state.tick, span = hi - lo;
  let i = P.count;
  for (let k = 0; k < n; k++, i++) {
    const az = TWO_PI * rnd(st);
    const se = lo + span * rnd(st); // even over the sphere: uniform in sin(elevation)
    const vh = (v0 + dv * rnd(st));
    const ce = Q(1 - se * se) * vh;
    X[i] = x; Y[i] = y; Z[i] = z; VX[i] = ce * C(az); VY[i] = ce * S(az); VZ[i] = vh * se;
    AM[i] = fragIdx; OW[i] = owner; BT[i] = tick; BU[i] = 0;
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

/**
 * Balance pass 5 (area fire): a KETF-type round's payload ejected by its timed fuze: `cone.count` sub-projectiles fly
 * on along `dir` within `cone.halfAngleDeg` of it (even over the cone's solid angle) at `cone.velocityFraction` of
 * the round's speed; the small ejection charge (`cone.fillingKg`) only adds its blast and a burst's suppression.
 */
function ejectCone(
  ctx: SimContext, state: SimState, events: EventSink, x: number, y: number, z: number, ammoId: string, owner: EntityId,
  dir: readonly [number, number, number], cone: NonNullable<NonNullable<SimContext["catalog"]["ammo"][string]["airburst"]>["cone"]>,
): void {
  const BL = ctx.catalog.ballistics.blast;
  const cube = pow(Math.max(cone.fillingKg, 1e-6), 1 / 3);
  const stunR = BL.stunScaledM * cube;
  events.emit({ kind: "explosion", tick: state.tick, x, y, z, ammo: ammoId, owner, stunRadiusM: stunR });
  suppressByBurst(ctx, state, x, y, Math.max(stunR, ctx.catalog.ballistics.fragments.airburstAboveM), state.identity.get(owner)?.side);
  notePointFire(ctx, state, x, y);
  const sp = sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]);
  if (!(sp > 1e-6)) return;
  // An orthonormal frame round the flight path: u along it, a and b across.
  const ux = dir[0] / sp, uy = dir[1] / sp, uz = dir[2] / sp;
  let ax: number, ay: number, az: number;
  if (Math.abs(uz) < 0.9) { ax = -uy; ay = ux; az = 0; } else { ax = 0; ay = -uz; az = uy; }
  const al = sqrt(ax * ax + ay * ay + az * az); ax /= al; ay /= al; az /= al;
  const bx = uy * az - uz * ay, by = uz * ax - ux * az, bz = ux * ay - uy * ax;
  const cMin = cos((cone.halfAngleDeg * PI) / 180);
  const n = Math.min(ctx.catalog.ballistics.fragments.maxPerBurst, cone.count);
  const P = state.projectiles;
  reserveProjectiles(P, n);
  const fragIdx = ammoIndexOf(ctx.catalog, cone.fragmentAmmo);
  const st = rngStream(state.rng, Streams.fragments), rnd = streamFloat, C = cos, S = sin, Q = sqrt, TWO_PI = 2 * PI;
  const f0 = cone.velocityFraction[0], df = cone.velocityFraction[1] - f0;
  const X = P.x, Y = P.y, Z = P.z, VX = P.vx, VY = P.vy, VZ = P.vz, AM = P.ammo, OW = P.owner, BT = P.bornTick, BU = P.burstTick, tick = state.tick;
  let i = P.count;
  for (let k = 0; k < n; k++, i++) {
    const ct = 1 - (1 - cMin) * rnd(st), stt = Q(Math.max(0, 1 - ct * ct)), ph = TWO_PI * rnd(st);
    const v = sp * (f0 + df * rnd(st));
    const ca = stt * C(ph), cb = stt * S(ph);
    X[i] = x; Y[i] = y; Z[i] = z;
    VX[i] = v * (ct * ux + ca * ax + cb * bx); VY[i] = v * (ct * uy + ca * ay + cb * by); VZ[i] = v * (ct * uz + ca * az + cb * bz);
    AM[i] = fragIdx; OW[i] = owner; BT[i] = tick; BU[i] = 0;
  }
  P.count = i;
}
