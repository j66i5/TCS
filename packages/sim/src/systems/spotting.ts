/**
 * DETECTION (SPEC 6.5, M3.2): who sees whom.
 *
 * Every soldier who is alive and conscious scans once every `scanSeconds` (staggered by ID). For every enemy
 * within range the chance that he sees him in this scan is 1 - exp(-rate x scanSeconds), with
 *   rate = base x (reference range / range)^exponent x exposed size (posture) x movement or firing
 *          x visibility along the line of sight x where he is looking x optic x skill x stress x light.
 * A man already seen is kept at a much higher rate, and forgotten after `forgetSeconds` without a sighting.
 * Visibility comes from the line of sight (M3.1): ground, walls and roofs hide him completely; vegetation
 * thins the view — but a man moving through it shakes the plants and a man firing shows flash and dust, so
 * then at least a floor share of him shows. Every number is in core/spotting.json.
 *
 * Sight realism step 3 (spotting.conceal; absent: as before): the kept rate falls while the man seen is quiet; a man
 * still among plants or in a room blends in (his conspicuity, drawn from the "conspicuity" stream where he settles, and
 * the vegetation's backdrop; thermal sights see past both); a man lying still is hidden by the ground far off; crawling
 * shows less than walking; by day firing shows less with range; a heard or reported enemy cues the search; a room is
 * dark by day. Per target in soldierTargets; per pair only the firing-by-range, ground and cue terms.
 *
 * Exactly one random draw per observer, target and scan, always, from the "spotting" stream: the line-of-sight
 * check is skipped when the draw could not succeed even with a perfect view, which saves most of the cost.
 *
 * Vehicles (M7.3): a vehicle is a target too — its size is the area its hull and turret boxes show at the
 * observer's aspect (per 0.7 m^2 of a standing man) times its signature factor, larger moving or firing; it is
 * seen if any of its aim points is (the hull's own box does not hide it; a hull-down vehicle shows only its
 * turret's share). The crew observe through their seats' sensors (each with its own arc, following the hull or
 * the turret, its range, fog floor and rain factor); passengers do not observe. Smoke: each sensor keeps its
 * `smokeFactor` of the view through ordinary smoke (thermal half, owner Q7), none through a multispectral cloud.
 */
import { isOffMap } from "../offmap";
import { smokePhysics, smokeTransmission } from "../smoke";
import type { SoldierState } from "../components";
import type { SimContext } from "../context";
import type { EventSink, SimEvent } from "../events";
import { secondsToTicks, staggerFirst, TICK_HZ, type EntityId } from "../ids";
import { isAble } from "../impair";
import { flareLightAt } from "../flares";
import { deviceLive } from "../power";
import { eyeHeightM, sight, TARGET_POINT_M } from "../los";
import { atan2, cos, exp, PI, pow, sin, sqrt } from "../math";
import { nextFloat, nextNormal, Streams } from "../rng";
import { indoorAt } from "../interior-nav";
import type { SimState } from "../state";
import { heightAt, segmentsInRectInto, standZ } from "../terrain";
import type { SpottingConcealDef, SpottingDef, VehicleDef } from "../catalog";
import type { DroneState, VehicleState } from "../components";

import { canFight } from "./gunnery";
import { compCondition, onRoof } from "../mount";

/** How big an angle (radians, 0..PI) lies between heading `h` and bearing `b`. */
function angleBetween(h: number, b: number): number {
  let d = (b - h) % (2 * PI);
  if (d < 0) d += 2 * PI;
  return d > PI ? 2 * PI - d : d;
}

/**
 * What one sensor makes of a target behind smoke: the share of its clear view it keeps (M7.3). `conv` and `ms`
 * are the transmissions through ordinary and multispectral clouds on the line. Eyes and day sights (factor 0)
 * keep only what ordinary smoke lets through; a thermal sight (0.5) keeps half the view through dense ordinary
 * smoke; nothing sees through a multispectral cloud.
 */
export function throughSmoke(smokeFactor: number, conv: number, ms: number): number {
  return ms * (conv + (1 - conv) * smokeFactor);
}

/** Area (m^2) a box of length L, width W, height H shows to an observer at `rel` rad off its long axis. */
function boxArea(L: number, W: number, H: number, rel: number): number {
  return H * (L * Math.abs(sin(rel)) + W * Math.abs(cos(rel)));
}

/** A vehicle's apparent size for spotting: its visible area at this aspect per reference area x its factor. */
export function vehicleSize(D: SpottingDef, def: VehicleDef, rel: number, turretRel: number): { size: number; turretShare: number } {
  const h = def.body.hull;
  const hullA = boxArea(h.f[1] - h.f[0], h.r[1] - h.r[0], h.u[1] - h.u[0], rel);
  const tr = def.body.turret;
  const turA = tr ? boxArea(tr.f[1] - tr.f[0], tr.r[1] - tr.r[0], tr.u[1] - tr.u[0], turretRel) : 0;
  const total = hullA + turA;
  return { size: (total / D.vehicles.referenceAreaM2) * def.signature.sizeFactor, turretShare: total > 0 ? Math.max(turA / total, 0.15) : 1 };
}

/** Set by the sensor functions (M9.2): the best factor of a heat-seeing sensor in the last call (0: none). Through
 *  vegetation the view is the better of the best sensor x visibility and this x visibility^exponent. Read right
 *  after the call. */
let SENSOR_HEAT = 0;

/** The view through vegetation (M9.2): `vis` for the best sensor `best`, or heat through it for a thermal sensor
 *  `th` if that is better; unchanged when there is no thermal sensor or nothing in the way. */
function heatThrough(vis: number, best: number, th: number, exponent: number, heatVis = vis): number {
  if (th <= 0 || vis <= 0 || heatVis >= 1 || best <= 0) return vis;
  const v = pow(heatVis, exponent) * th;
  return v > best * vis ? v / best : vis;
}

/** Scans between two looks for vehicles by a man on foot, and between two searches by a crewman (M7.3). */
const VEHICLE_SCAN_EVERY = 4;

interface VehTarget {
  id: EntityId; side: string; x: number; y: number; gz: number; heading: number; turret: number; def: VehicleDef; motion: number; c: number; s: number;
  /** The light its gun flash gives it at night (M9.1): 0 by day or when it is not firing. */
  flash: number;
  /** The light burning flares give it (M9.6): 0 without flares. */
  lit: number;
  /** Its heat as a thermal sight sees it, relative to the eye (M9.2): cold, hot (moving or run lately), firing, burning. */
  heat: number;
}

export function spottingSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  const D = ctx.catalog.spotting, map = ctx.map, tick = state.tick;
  const every = Math.max(1, secondsToTicks(D.scanSeconds));
  const scanS = every / TICK_HZ;
  const front = (D.frontHalfAngleDeg * PI) / 180, side = (D.sideHalfAngleDeg * PI) / 180;
  const light = state.environment.light;
  // Fog: nothing is seen beyond the meteorological visibility.
  const fogR2 = state.environment.visibilityM * state.environment.visibilityM;
  const forget = secondsToTicks(D.forgetSeconds);
  const maxR2 = D.maxRangeM * D.maxRangeM;
  let targets: SoldierTarget[] | null = null;
  let vtargets: VehTarget[] | null = null;

  // mounted: ok observers aboard are skipped below (seat sensors come in M7.3)
  // (Staggered: only the men whose scan falls on this tick, ascending ID.)
  for (let oid = staggerFirst(tick, every); oid < state.nextEntityId; oid += every) {
    const os = state.soldier.get(oid);
    if (os === undefined) continue;
    // Forget what has not been seen for a while, and the dead.
    if (os.seen.length > 0) os.seen = os.seen.filter((e) => tick - e.lastTick <= forget && (state.soldier.get(e.target)?.physiology.alive === true || vehicleSeeable(state.vehicle.get(e.target)) || state.drone.has(e.target)));
    if (!isAble(os)) continue;
    if (os.mount !== undefined) {
      // Aboard (M7.3): the crew look through their seats' sensors; passengers see nothing outside.
      const v = state.vehicle.get(os.mount.vehicle), def = v ? ctx.catalog.vehicles[v.def] : undefined;
      const seat = def?.seats[os.mount.seat];
      if (!v || !def || !seat?.sensors || seat.sensors.length === 0 || seat.station === "passenger" || isOffMap(v)) continue;
      targets ??= soldierTargets(ctx, state);
      vtargets ??= vehicleTargets(ctx, state);
      crewScan(ctx, state, events, oid, os, v, def, os.mount.seat, targets, vtargets, every);
      continue;
    }
    const ot = state.transform.get(oid), oi = state.identity.get(oid);
    if (!ot || !oi) continue;
    targets ??= soldierTargets(ctx, state);
    const ez = standZ(map, ot) + eyeHeightM(ctx, os.posture);
    const skill = os.skills["observation"] ?? os.skills["marksmanship"] ?? 0.5;
    const own = Math.max(0.2, 1 + D.skillSlope * (skill - 0.5)) * Math.max(0, 1 - D.stressK * Math.max(os.mental.stress, os.mental.suppression));
    // His sensors: his eyes, his weapon's sight, anything he carries that he looks through (night vision).
    const sensors = [D.sensors["eye"]];
    const sightKind = ctx.catalog.weapons[state.weapon.get(oid)?.weapon ?? ""]?.sights[0]?.kind;
    if (sightKind !== undefined) sensors.push(D.sensors[sightKind]);
    const box = state.container.get(oid);
    // (M11.6: a powered goggle or sight helps only while its battery has charge: flat, he is back to eye and weapon sight.)
    if (box) for (const st of box.stacks) { const k = ctx.catalog.items[st.type]?.sensor; if (k !== undefined && st.count > 0 && deviceLive(ctx.catalog, state, oid, st.type, tick)) sensors.push(D.sensors[k]); }
    // Sight realism step 3: a cued search — where he heard shots or was told of an enemy, he looks harder.
    const nCue = cueContacts(os, ot.x, ot.y, CC);
    // (The ground hides a man lying still at a grazing angle: from higher up — an upper floor, a roof — the view is
    // steeper, as if from nearer: the range in that term is scaled by proneGroundEyeM / his eye height, squared here.)
    const eyeUp = ez - heightAt(map, ot.x, ot.y), eyeRef = D.conceal?.proneGroundEyeM; // ground: ok (his eye above the ground)
    const eyeK = eyeRef !== undefined && eyeUp > eyeRef ? (eyeRef / eyeUp) * (eyeRef / eyeUp) : 1;
    for (const tg of targets) {
      if (tg.side === oi.side || tg.id === oid) continue;
      const dx = tg.x - ot.x, dy = tg.y - ot.y, d2 = dx * dx + dy * dy;
      if (d2 > maxR2 || d2 > fogR2) continue;
      const dist = sqrt(d2);
      const look = angleBetween(ot.heading, atan2(dy, dx));
      let sensor = 0, heat = 0;
      // (M9.1: a muzzle flash at night lights him up to `flash` for every sensor; 0 by day and when not firing.
      // M9.6: a burning flare lights him up to `lit`, 0 without flares.)
      // (M9.2: a sight or goggle helps only within its arc of where he looks; a thermal one sees his heat.)
      for (const sn of sensors) {
        if (!sn || (sn.arcDeg !== undefined && look > (sn.arcDeg * PI) / 180)) continue;
        const f = (dist >= sn.fromM ? sn.factor : 1) * Math.max(D.lightFloor, light, sn.nightLight, tg.flash, tg.lit) * (sn.thermal === true ? tg.heat * tg.unblend : 1);
        if (f > sensor) sensor = f;
        if (sn.thermal === true && f > heat) heat = f;
      }
      const idx = os.seen.findIndex((e) => e.target === tg.id);
      const view = look <= front ? 1 : look <= side ? D.sideFactor : D.rearFactor;
      let rate = D.baseRatePerS * pow(D.referenceRangeM / Math.max(D.minRangeM, dist), D.rangeExponent) * tg.size * tg.motion * view * own * sensor;
      if (tg.fireX > 0) rate *= firingAt(tg, dist);
      if (tg.groundK > 0 && sensor > 0) { const g = d2 * tg.groundK * eyeK; rate *= Math.max(1 / (1 + g * g), heat / sensor); } // (thermal: heat shows through the grass)
      // (Only while looking for him: a man already seen is kept anyway.)
      if (nCue > 0 && idx < 0 && cued(nCue, dx, dy, dist, tg.x, tg.y)) rate *= CC.factor;
      if (idx >= 0) rate *= tg.keep;
      const u = nextFloat(state.rng, Streams.spotting);
      if (u >= 1 - exp(-rate * scanS)) continue; // could not succeed even with a perfect view
      // He can only keep track of so many: a new one only if nearer than the farthest he watches (checked
      // before the costly sight line: it could not be taken on anyway).
      let far = -1;
      if (idx < 0 && menSeen(state, os.seen) >= D.maxTracked) {
        let farD = -1;
        for (let q = 0; q < os.seen.length; q++) {
          if ((state.vehicle.size > 0 && state.vehicle.has(os.seen[q]!.target)) || (state.drone.size > 0 && state.drone.has(os.seen[q]!.target))) continue; // vehicles (M7.3) and drones are tracked apart
          const xt = state.transform.get(os.seen[q]!.target);
          const dq = xt ? (xt.x - ot.x) * (xt.x - ot.x) + (xt.y - ot.y) * (xt.y - ot.y) : Infinity;
          if (dq > farD) { farD = dq; far = q; }
        }
        if (farD <= d2) continue;
      }
      const sg = sight(ctx, ot.x, ot.y, ez, tg.x, tg.y, tg.z);
      if (sg.blockedBy !== null) continue;
      let vis = sg.visibility;
      // (M9.2: heat comes through vegetation better than light does.)
      vis = heatThrough(vis, sensor, heat, D.thermal.vegetationExponent, sg.heatVisibility);
      // Moving through vegetation shakes the plants above him, firing shows flash and dust: seen if the line to
      // the top of the vegetation over him is clear (not through a wood between).
      if ((tg.firing || tg.moving) && tg.vegTopZ > tg.z) {
        const top = sight(ctx, ot.x, ot.y, ez, tg.x, tg.y, tg.vegTopZ + 0.1);
        if (top.blockedBy === null) vis = Math.max(vis, (tg.firing ? tg.fireFloor : D.movingVisibilityFloor) * top.visibility);
      }
      // Smoke (M6.5c) between them hides him.
      if (state.smoke.length > 0) vis *= smokeTransmission(state, smokePhysics(ctx.catalog), ot.x, ot.y, ez, tg.x, tg.y, tg.z);
      if (vis < D.minVisibility) vis = 0;
      if (u >= 1 - exp(-rate * vis * scanS)) continue;
      os.sawEnemyTick = tick; // (step 4: when he last saw an enemy)
      if (idx >= 0) { os.seen[idx]!.lastTick = tick; continue; }
      if (far >= 0) os.seen.splice(far, 1);
      os.seen.push({ target: tg.id, firstTick: tick, lastTick: tick });
      os.seen.sort((a, b) => a.target - b.target);
      events.emit({ kind: "spotted", tick, observer: oid, target: tg.id, side: oi.side, rangeM: dist });
    }
    // Vehicles (M7.3): a man on foot sees them with the same eyes and optics.
    // (Every fourth scan, four times the scan time: hulls are large and slow to change; cost bound with many.)
    if (state.vehicle.size > 0 && (oid + Math.floor(tick / every)) % VEHICLE_SCAN_EVERY === 0) {
      vtargets ??= vehicleTargets(ctx, state);
      const look = { x: ot.x, y: ot.y, z: ez, own: -1 };
      scanVehicles(ctx, state, events, oid, oi.side, os.seen, look, (dist, bearing, flash, heat) => {
        let sensor = 0;
        SENSOR_HEAT = 0;
        const lk = angleBetween(ot.heading, bearing);
        for (const sn of sensors) {
          if (!sn || (sn.arcDeg !== undefined && lk > (sn.arcDeg * PI) / 180)) continue;
          const f = (dist >= sn.fromM ? sn.factor : 1) * Math.max(D.lightFloor, light, sn.nightLight, flash) * (sn.thermal === true ? heat : 1);
          if (f > sensor) sensor = f;
          if (sn.thermal === true && f > SENSOR_HEAT) SENSOR_HEAT = f;
        }
        return sensor * (lk <= front ? 1 : lk <= side ? D.sideFactor : D.rearFactor);
      }, () => 1, own, vtargets, VEHICLE_SCAN_EVERY * scanS, Math.min(state.environment.visibilityM, D.maxRangeM), os); // a man's eyes reach as far for a hull as for a man
    }
    // Enemy drones overhead (M9.4b): on the same slower schedule as vehicles.
    if (state.drone.size > 0 && (oid + Math.floor(tick / every)) % VEHICLE_SCAN_EVERY === 0) {
      scanDrones(ctx, state, events, oid, oi.side, os.seen, ot.x, ot.y, ez, (dist, bearing, overhead) => {
        let sensor = 0;
        // (Overhead, steeper than 45 degrees: in view whichever way he faces.)
        const lk = overhead ? 0 : angleBetween(ot.heading, bearing);
        for (const sn of sensors) {
          if (!sn || (sn.arcDeg !== undefined && lk > (sn.arcDeg * PI) / 180)) continue;
          const f = (dist >= sn.fromM ? sn.factor : 1) * Math.max(D.lightFloor, light, sn.nightLight) * (sn.thermal === true ? D.thermal.man : 1);
          if (f > sensor) sensor = f;
        }
        return sensor * (lk <= front ? 1 : lk <= side ? D.sideFactor : D.rearFactor);
      }, own, VEHICLE_SCAN_EVERY * scanS);
    }
  }
  // Drones' cameras (M9.4a): each drone once per scan time, staggered by its ID.
  if (state.drone.size > 0) {
    for (const [did, d] of state.drone.entries()) {
      if ((tick + did) % every !== 0) continue;
      if (d.seen.length > 0) d.seen = d.seen.filter((e) => tick - e.lastTick <= forget && (state.soldier.get(e.target)?.physiology.alive === true || vehicleSeeable(state.vehicle.get(e.target))));
      if (d.operator === null) continue; // nobody watches the picture
      targets ??= soldierTargets(ctx, state);
      vtargets ??= state.vehicle.size > 0 ? vehicleTargets(ctx, state) : [];
      droneScan(ctx, state, events, did, d, targets, vtargets, scanS);
    }
  }
}

/**
 * A man's look for enemy drones (M9.4b): a small airframe against the sky (its area x targetContrast), larger when
 * it moves; within its noise range he hears it and looks for it `heardLookFactor` times as hard. Seen to seenMaxM
 * (slant), through the line of sight and smoke as anything else; it goes into his `seen` (not his contacts: a drone
 * is no position to fight; his comrades hear about it on the radio).
 */
function scanDrones(
  ctx: SimContext, state: SimState, events: EventSink, oid: EntityId, side: string, seen: { target: EntityId; firstTick: number; lastTick: number }[],
  ex: number, ey: number, ez: number, sensorAt: (dist: number, bearing: number, overhead: boolean) => number, own: number, scanS: number,
): void {
  const D = ctx.catalog.spotting, DR = D.drone, tick = state.tick;
  if (!DR) return;
  for (const [did, d] of state.drone.entries()) {
    if (d.side === side) continue;
    const t = state.transform.get(did), def = ctx.catalog.items[d.item]?.drone;
    if (!t || !def || t.z <= 0) continue;
    const tz = heightAt(ctx.map, t.x, t.y) + t.z; // ground: ok (a drone flies its height over the ground)
    const dx = t.x - ex, dy = t.y - ey, dz = tz - ez, slant = sqrt(dx * dx + dy * dy + dz * dz);
    if (slant > DR.seenMaxM || slant > state.environment.visibilityM) continue;
    const sensor = sensorAt(slant, atan2(dy, dx), dx * dx + dy * dy < dz * dz);
    if (sensor <= 0) continue;
    const idx = seen.findIndex((e) => e.target === did);
    const size = (def.areaM2 / D.vehicles.referenceAreaM2) * DR.targetContrast;
    const motion = d.mode === "fly" || d.mode === "home" ? D.movingFactor : 1;
    const heard = slant <= def.noiseM ? DR.heardLookFactor : 1;
    let rate = D.baseRatePerS * pow(D.referenceRangeM / Math.max(D.minRangeM, slant), D.rangeExponent) * size * motion * heard * own * sensor;
    if (idx >= 0) rate *= D.keepRateFactor;
    const u = nextFloat(state.rng, Streams.spotting);
    if (u >= 1 - exp(-rate * scanS)) continue;
    const sg = sight(ctx, ex, ey, ez, t.x, t.y, tz);
    if (sg.blockedBy !== null) continue;
    let vis = sg.visibility;
    if (state.smoke.length > 0) vis *= smokeTransmission(state, smokePhysics(ctx.catalog), ex, ey, ez, t.x, t.y, tz);
    if (vis < D.minVisibility) vis = 0;
    if (u >= 1 - exp(-rate * vis * scanS)) continue;
    if (idx >= 0) { seen[idx]!.lastTick = tick; continue; }
    seen.push({ target: did, firstTick: tick, lastTick: tick });
    seen.sort((a, b) => a.target - b.target);
    events.emit({ kind: "spotted", tick, observer: oid, target: did, side, rangeM: slant });
  }
}

/** New men a drone's operator picks out of the picture per scan, at most (a cost bound). */
const DRONE_LOOKS = 3;

/**
 * A drone's scan (M9.4a): its cameras look down on the ground within `footprintM` around the point below it; the
 * operator's skill and stress stand for the observer's. A man shows his size from above (any posture about the same);
 * light, heat, vegetation, roofs and smoke as for any sensor. What it sees goes into the drone's own `seen`.
 */
function droneScan(ctx: SimContext, state: SimState, events: EventSink, did: EntityId, d: DroneState, targets: readonly SoldierTarget[], vts: readonly VehTarget[], scanS: number): void {
  const D = ctx.catalog.spotting, tick = state.tick, t = state.transform.get(did), def = ctx.catalog.items[d.item]?.drone;
  if (!t || !def || d.operator === null || t.z <= 0) return;
  const os = state.soldier.get(d.operator);
  if (!os) return;
  const ex = t.x, ey = t.y, ez = heightAt(ctx.map, t.x, t.y) + t.z; // ground: ok (a drone flies its height over the ground)
  const skill = os.skills["observation"] ?? os.skills["marksmanship"] ?? 0.5;
  const own = Math.max(0.2, 1 + D.skillSlope * (skill - 0.5)) * Math.max(0, 1 - D.stressK * Math.max(os.mental.stress, os.mental.suppression));
  const light = state.environment.light, rain = state.environment.rain, fog = state.environment.visibilityM;
  const kinds = def.sensors.map((k) => D.sensors[k]).filter((k) => k !== undefined);
  const fp2 = def.footprintM * def.footprintM, DR = D.drone, search = DR?.searchFactor ?? 1;
  // Best camera at a slant range, without smoke (conv = ms = 1) or through it.
  const sensorAt = (slant: number, conv = 1, ms = 1, flash = 0, heat = 1): number => {
    let best = 0;
    SENSOR_HEAT = 0;
    for (const k of kinds) {
      if (slant > Math.min(k.maxRangeM ?? D.maxRangeM, Math.max(fog, k.fogFloorM ?? 0))) continue;
      const f = (slant >= k.fromM ? k.factor : 1) * Math.max(D.lightFloor, light, k.nightLight, flash) * (1 - (1 - (k.rainFactor ?? 1)) * rain) * throughSmoke(k.smokeFactor ?? 0, conv, ms) * (k.thermal === true ? heat : 1);
      if (f > best) best = f;
      if (k.thermal === true && f > SENSOR_HEAT) SENSOR_HEAT = f;
    }
    return best;
  };
  let looks = 0;
  for (const tg of targets) {
    if (tg.side === d.side) continue;
    const dx = tg.x - ex, dy = tg.y - ey, d2 = dx * dx + dy * dy;
    if (d2 > fp2) continue;
    const dz = ez - tg.z, slant = sqrt(d2 + dz * dz);
    const sensor = sensorAt(slant, 1, 1, Math.max(tg.flash, tg.lit), tg.heat);
    const heat = SENSOR_HEAT;
    if (sensor <= 0) continue;
    const idx = d.seen.findIndex((e) => e.target === tg.id);
    let rate = D.baseRatePerS * pow(D.referenceRangeM / Math.max(D.minRangeM, slant), D.rangeExponent) * tg.top * tg.motion * own * sensor * search;
    if (tg.fireX > 0) rate *= firingAt(tg, slant);
    if (idx >= 0) rate *= tg.keep;
    const u = nextFloat(state.rng, Streams.spotting);
    if (u >= 1 - exp(-rate * scanS)) continue;
    if (idx < 0) { if (looks >= DRONE_LOOKS) continue; looks++; }
    // Under a tree canopy: the crowns hide most of him from above (heat comes through better).
    const under = DR !== undefined && tg.vegTopZ - tg.z > DR.canopyAboveM;
    const sg = sight(ctx, ex, ey, ez, tg.x, tg.y, tg.z);
    if (sg.blockedBy !== null) continue;
    let vis = heatThrough(sg.visibility, sensor, heat, D.thermal.vegetationExponent, sg.heatVisibility);
    if (under) vis *= heat >= sensor ? DR.canopyThermal : DR.canopyDay;
    if ((tg.firing || tg.moving) && tg.vegTopZ > tg.z && !under) {
      const top = sight(ctx, ex, ey, ez, tg.x, tg.y, tg.vegTopZ + 0.1);
      if (top.blockedBy === null) vis = Math.max(vis, (tg.firing ? tg.fireFloor : D.movingVisibilityFloor) * top.visibility);
    }
    if (state.smoke.length > 0) {
      const SP = smokePhysics(ctx.catalog);
      const conv = smokeTransmission(state, SP, ex, ey, ez, tg.x, tg.y, tg.z, "conventional");
      const ms = smokeTransmission(state, SP, ex, ey, ez, tg.x, tg.y, tg.z, "multispectral");
      vis *= sensorAt(slant, conv, ms, Math.max(tg.flash, tg.lit), tg.heat) / sensor;
    }
    if (vis < D.minVisibility) vis = 0;
    if (u >= 1 - exp(-rate * vis * scanS)) continue;
    if (idx >= 0) { d.seen[idx]!.lastTick = tick; continue; }
    d.seen.push({ target: tg.id, firstTick: tick, lastTick: tick });
    d.seen.sort((a, b) => a.target - b.target);
    events.emit({ kind: "spotted", tick, observer: did, target: tg.id, side: d.side, rangeM: slant, drone: true });
  }
  if (vts.length === 0) return;
  // Vehicles: the same cameras (a hull from above shows at least its side area; the geometry is the side view's).
  const slantOf = (dist: number) => sqrt(dist * dist + t.z * t.z);
  scanVehicles(ctx, state, events, did, d.side, d.seen, { x: ex, y: ey, z: ez, own: -1 },
    (dist, _b, flash, heat) => sensorAt(slantOf(dist), 1, 1, flash, heat),
    (dist, _b, conv, ms, flash, heat) => { const b = sensorAt(slantOf(dist), 1, 1, flash, heat); return b > 0 ? sensorAt(slantOf(dist), conv, ms, flash, heat) / b : 0; },
    own * search, vts, scanS, def.footprintM);
  // (scanVehicles emits plain "spotted" events: those of this drone, this tick, are flagged as a camera's.)
  for (const e of events.events as SimEvent[]) if (e.kind === "spotted" && e.observer === did && e.tick === tick) e.drone = true;
}

/** Men (not vehicles) in a `seen` list. */
function menSeen(state: SimState, seen: readonly { target: EntityId }[]): number {
  if (state.vehicle.size === 0 && state.drone.size === 0) return seen.length;
  let n = 0;
  for (const e of seen) if (!state.vehicle.has(e.target) && !state.drone.has(e.target)) n++;
  return n;
}

interface SoldierTarget {
  id: EntityId; side: string; x: number; y: number; z: number; size: number; motion: number; firing: boolean; moving: boolean; vegTopZ: number;
  /** The light his muzzle flash gives him at night (M9.1): 0 by day or when he is not firing. */
  flash: number;
  /** The light burning flares give him (M9.6): 0 without flares. */
  lit: number;
  /** His heat as a thermal sight sees it, relative to what the eye sees (M9.2; a blanket hides most of it). */
  heat: number;
  /** His size seen from above (M9.4a: a drone's camera), as `size`. */
  top: number;
  /** Sight realism step 3: the factor on the kept rate once seen (falls while he is quiet). */
  keep: number;
  /** Firing (step 3): his firing factor - 1 (0: not firing; not in `motion`), how dark it is (the firing reveal
   *  falls with range by day only), 1 / firingHalfM (0: no fall), and the share of him the flash shows through vegetation. */
  fireX: number; fireDark: number; fireInvHalf: number; fireFloor: number;
  /** 1 / the blending factors in `size` (conspicuity and backdrop): a thermal sight sees his heat, not how well he
   *  blends in, so its factor is multiplied by this (step 3). */
  unblend: number;
  /** 1 / proneGroundM^2 for a man lying still (0 otherwise): at range 1 / (1 + (range / proneGroundM)^4) of him shows
   *  to an observer on the ground (step 3; from higher up the range is scaled down, `proneGroundEyeM`); 0 also for a
   *  man not on the ground (a roof, an upper floor). */
  groundK: number;
}

/** How much more his firing shows him at this range (sight realism step 3): the full factor at night or close, by
 *  day 1 + (factor - 1) / (1 + range / firingHalfM). */
function firingAt(tg: SoldierTarget, dist: number): number {
  return 1 + tg.fireX * (tg.fireDark + (1 - tg.fireDark) / (1 + dist * tg.fireInvHalf));
}

/** Cue scratch (step 3): unit vector toward, position and radius^2 of an observer's heard and reported contacts; the
 *  factor and the cosine of the half-angle. */
const CC = { n: 0, ux: [] as number[], uy: [] as number[], x: [] as number[], y: [] as number[], r2: 0, factor: 1, cosHalf: 1 };

/** Fill `CC` with the observer's nearest (at most cueMax) heard or reported contacts of men (not known to be down);
 *  their number. (He turns his attention to a few directions, not to every shot on the field.) */
function cueContacts(os: SoldierState, ox: number, oy: number, cc: typeof CC): number {
  cc.n = 0;
  const C = CUE_DEF;
  if (C === null || os.contacts.length === 0) return 0;
  const max = C.cueMax, d2s = CUE_D2;
  for (const c of os.contacts) {
    if (c.kind === "seen" || c.cls !== undefined || c.down === true) continue;
    const vx = c.x - ox, vy = c.y - oy, q = vx * vx + vy * vy;
    if (q < 1e-12) continue;
    // Insert by distance (ascending, ties in contact order), keeping the nearest `max`.
    let k = cc.n;
    if (k >= max) { if (q >= d2s[max - 1]!) continue; k = max - 1; } else cc.n++;
    while (k > 0 && d2s[k - 1]! > q) { d2s[k] = d2s[k - 1]!; cc.ux[k] = cc.ux[k - 1]!; cc.uy[k] = cc.uy[k - 1]!; cc.x[k] = cc.x[k - 1]!; cc.y[k] = cc.y[k - 1]!; k--; }
    const l = sqrt(q);
    d2s[k] = q; cc.ux[k] = vx / l; cc.uy[k] = vy / l; cc.x[k] = c.x; cc.y[k] = c.y;
  }
  cc.r2 = C.cueRangeM * C.cueRangeM; cc.factor = C.cueFactor; cc.cosHalf = cos((C.cueBearingDeg * PI) / 180);
  return cc.n;
}

/** Squared distances of the cues in `CC` (scratch). */
const CUE_D2: number[] = [];

/** Is the target at (dx, dy) from the observer (dist away), at (x, y), within one of the observer's cues? */
function cued(n: number, dx: number, dy: number, dist: number, x: number, y: number): boolean {
  const cc = CC, r2 = cc.r2, lim = cc.cosHalf * dist;
  for (let k = 0; k < n; k++) {
    const ex = x - cc.x[k]!, ey = y - cc.y[k]!;
    if (ex * ex + ey * ey > r2) continue;
    if (dx * cc.ux[k]! + dy * cc.uy[k]! >= lim) return true;
  }
  return false;
}

/** The conceal block of the catalog in use this tick (set by soldierTargets; null: none, as before step 3). */
let CUE_DEF: SpottingConcealDef | null = null;

/** Scratch list for the opening query of a man indoors. */
const NEAR_SEGS: number[] = [];

/**
 * Sight realism step 3: how far (m) a man in building `bi` at (x, y), `z` above the ground, is from the nearest
 * opening (window, door, breach) in its outer walls on his floor; Infinity if there is none within `withinM` (walls
 * are looked for only that far: the caller asks "within backM?", review fix — any backM works, and the query is small).
 */
function openingDistance(ctx: SimContext, bi: number, x: number, y: number, z: number, withinM: number): number {
  const b = ctx.map.buildings[bi];
  if (!b) return Infinity;
  const r = withinM + 0.5;
  const n = segmentsInRectInto(ctx.mapIndex, x - r, y - r, x + r, y + r, NEAR_SEGS);
  const segs = ctx.mapIndex.segments, info = ctx.ballistics.seg;
  let best = Infinity;
  for (let q = 0; q < n; q++) {
    const si = NEAR_SEGS[q]!, sg = segs[si]!;
    if (sg.owner !== "building" || sg.id !== b.id) continue;
    const ops = info[si]!.openings;
    if (!ops) continue;
    const ex = sg.bx - sg.ax, ey = sg.by - sg.ay, len = info[si]!.len;
    if (len <= 0) continue;
    // Where along the wall he stands, and how far from it.
    const along = ((x - sg.ax) * ex + (y - sg.ay) * ey) / len;
    const across = Math.abs((x - sg.ax) * ey - (y - sg.ay) * ex) / len;
    for (const o of ops) {
      if (o.sillM > z + 1.6 || o.headM < z + 0.3) continue; // not on his floor
      const lo = o.offsetM - o.widthM / 2, hi = o.offsetM + o.widthM / 2;
      const off = along < lo ? lo - along : along > hi ? along - hi : 0;
      const d = sqrt(off * off + across * across);
      if (d < best) best = d;
    }
  }
  return best;
}

/** Every man who can be seen this scan (not aboard a vehicle), ID order. */
function soldierTargets(ctx: SimContext, state: SimState): SoldierTarget[] {
  const D = ctx.catalog.spotting, map = ctx.map, tick = state.tick, B = ctx.ballistics;
  // Night (M9.1): how dark it is (0 in full daylight: nothing below changes then).
  const dark = 1 - Math.min(1, Math.max(0, state.environment.light));
  const N = D.night, TH = D.thermal;
  const flaring = state.flares !== undefined && state.flares.length > 0;
  // Sight realism step 3 (absent `conceal`: as before).
  const C = D.conceal ?? null;
  CUE_DEF = C;
  const keepK = D.keepRateFactor, keepFloor = C ? Math.min(C.keepFloorFactor, keepK) : keepK, keepT = C ? C.keepDecaySeconds : 1;
  const fireInvHalf = C ? 1 / C.firingHalfM : 0;
  const fireFloor = C ? C.firingVisibilityFloorDay + (D.firingVisibilityFloor - C.firingVisibilityFloorDay) * dark : D.firingVisibilityFloor;
  const firingTicks = secondsToTicks(D.firingWithinSeconds), launchTicks = secondsToTicks(D.launchFlashSeconds);
  const backdrop = B.vegBackdrop, hasInteriors = C !== null && map.buildings.length > 0;
  const BP = ctx.catalog.body.postures, postureH = { standing: BP.standing.heightM, crouching: BP.crouching.heightM, prone: BP.prone.heightM };
  // (Rows are reused from tick to tick: no allocation per man per tick, M7.3.)
  const targets = TARGETS;
  let n = 0;
  for (const [tid, ts] of state.soldier.entries()) {
    // A man aboard is never a target (M7), except one out on the roof reloading (M9.3a).
    const roof = ts.mount !== undefined && onRoof(state, tid);
    if (!ts.physiology.alive || (ts.mount !== undefined && !roof)) continue;
    const tt = state.transform.get(tid), ti = state.identity.get(tid);
    if (!tt || !ti) continue;
    const speed = state.mover.get(tid)?.speedMps ?? 0;
    const moving = speed > D.stillBelowMps;
    const lastShot = state.weapon.get(tid)?.lastShotTick ?? -1e9;
    const firing = tick - lastShot <= firingTicks;
    // Top of the vegetation he is in (where moving plants or the flash of his shots show), or -Infinity.
    const g = heightAt(map, tt.x, tt.y); // ground: ok (vegetation top; his own height below)
    const cell = Math.floor(tt.y / map.cellSizeM) * map.cols + Math.floor(tt.x / map.cellSizeM);
    const v = cell >= 0 && cell < map.vegetation.length ? map.vegetation[cell]! : 0;
    const vegTopZ = v > 0 ? g + B.vegHeightM[v - 1]! : -Infinity;
    let r = targets[n];
    if (!r) { r = { id: 0, side: "", x: 0, y: 0, z: 0, size: 0, motion: 0, firing: false, moving: false, vegTopZ: 0, flash: 0, lit: 0, heat: 1, top: 0, keep: 1, fireX: 0, fireDark: 1, fireInvHalf: 0, fireFloor: 0, unblend: 1, groundK: 0 }; targets[n] = r; }
    r.vegTopZ = vegTopZ; r.id = tid; r.side = ti.side; r.x = tt.x; r.y = tt.y; r.z = g + tt.z + TARGET_POINT_M[ts.posture];
    r.size = D.postureSize[ts.posture]; r.top = D.drone?.postureSize[ts.posture] ?? r.size; r.moving = moving; r.firing = firing;
    // (Step 3: a prone man moving slowly, crawling, shows less than one walking.)
    const crawl = C !== null && ts.posture === "prone" && speed < C.crawlBelowMps;
    r.motion = !moving ? 1 : speed > D.runningAboveMps ? D.runningFactor : crawl ? C!.crawlFactor : D.movingFactor;
    let fireF = D.firingFactor;
    r.keep = keepK; r.unblend = 1; r.groundK = 0;
    r.fireDark = dark; r.fireInvHalf = fireInvHalf; r.fireFloor = fireFloor;
    // A guided missile launched from his post moments ago (M9.3b): its flash, dust and smoke show him more.
    const launched = ts.launchTick !== undefined && tick - ts.launchTick <= launchTicks;
    if (launched) r.motion *= D.launchFlashFactor;
    if (C !== null) {
      const still = !moving && !firing && !launched;
      // A man seen stays seen while he is active: the kept rate falls once he is quiet (moved, fired, launched).
      if (keepK > keepFloor) {
        const act = Math.max(ts.movedTick ?? -1e9, lastShot, ts.launchTick ?? -1e9);
        const quietS = moving || firing ? 0 : (tick - act) / TICK_HZ;
        r.keep = keepFloor + (keepK - keepFloor) * exp(-quietS / keepT);
      }
      // A dark room (not on the roof): shade by day, less still back from the windows; his shots show less.
      let indoors = false;
      if (hasInteriors) {
        const bi = indoorAt(ctx, tt.x, tt.y);
        const bd = bi >= 0 ? map.buildings[bi] : undefined;
        if (bd && tt.z < bd.storeys * bd.storeyHeightM - 0.5) {
          indoors = true;
          const I = C.indoor, day = 1 - dark;
          let f = 1 - (1 - I.shade) * day;
          if (openingDistance(ctx, bi, tt.x, tt.y, tt.z, I.backM) > I.backM) f *= 1 - (1 - I.backFactor) * day;
          r.size *= f;
          fireF = I.firingFactor;
        }
      }
      // Lying still: grass, furrows and small folds of the ground hide more of him the flatter the view, i.e. the
      // farther off the observer (crawling or firing he shows; drones look down and are not affected; not on a roof or
      // an upper floor; an observer looking down from higher up sees him as if nearer, proneGroundEyeM).
      if (still && ts.posture === "prone" && !indoors && tt.z < 0.5) r.groundK = 1 / (C.proneGroundM * C.proneGroundM);
      if (still && (v > 0 || indoors)) {
        // His conspicuity where he lies, among plants or in a room (clutter he can blend into; drawn once there for
        // each posture he takes — review fix: kneeling to look and lying down again on the spot keeps both values —
        // the same for every observer). On open ground his outline shows against it whatever he does.
        const cx = ts.conspX ?? 0, cy = ts.conspY ?? 0, rm = C.conspicuityResetM;
        if (ts.conspX === undefined || (tt.x - cx) * (tt.x - cx) + (tt.y - cy) * (tt.y - cy) > rm * rm) { ts.conspBy = {}; ts.conspX = tt.x; ts.conspY = tt.y; }
        // (A save from before the fix: its one value, for the posture it was drawn in.)
        else if (ts.conspBy === undefined) ts.conspBy = ts.consp !== undefined && ts.conspPosture !== undefined ? { [ts.conspPosture]: ts.consp } : {};
        const by = ts.conspBy!;
        let k = by[ts.posture];
        if (k === undefined) {
          const sg = C.conspicuitySigma;
          k = by[ts.posture] = exp(sg * nextNormal(state.rng, Streams.conspicuity) - (sg * sg) / 2);
        }
        ts.consp = k; ts.conspPosture = ts.posture;
        r.size *= k;
        r.unblend = 1 / k;
        if (v > 0) {
          // Vegetation round him: he blends into it (seen from a man's eye height, the background behind him is
          // more of it). Vegetation lower than the point an observer looks at also hides the part of him below its
          // top (the line of sight passes over it, so it does not thin the view).
          r.size *= backdrop[v - 1]!;
          r.unblend /= backdrop[v - 1]!;
          if (vegTopZ <= r.z) r.size *= Math.max(0, 1 - B.vegHeightM[v - 1]! / postureH[ts.posture]);
        }
      }
    }
    r.fireX = firing ? fireF - 1 : 0;
    r.flash = 0;
    // Flares (M9.6): the light they give him, once per target (not per observer); 0 without flares.
    r.lit = flaring ? flareLightAt(state, ctx.catalog, tt.x, tt.y, g) : 0;
    // Heat (M9.2): a man as by eye; still and not firing under a thermal blanket, its share.
    r.heat = TH.man;
    if (!moving && !firing) {
      const box = state.container.get(tid);
      if (box) for (const st of box.stacks) { const cv = st.count > 0 ? ctx.catalog.items[st.type]?.thermalCover : undefined; if (cv !== undefined && cv * TH.man < r.heat) r.heat = cv * TH.man; }
    }
    if (firing && dark > 0) {
      // At night (M9.1): the flash lights him; tracers from his belt point back to him.
      r.flash = N.flashLight;
      const mag = state.weapon.get(tid)?.magazine;
      if (mag && ctx.catalog.items[mag.item]?.tracerItem !== undefined) r.motion *= 1 + (N.tracerContrast - 1) * dark;
    }
    n++;
  }
  targets.length = n;
  return targets;
}

/** Reused rows of `soldierTargets` (rebuilt every tick in which someone scans; never kept across ticks). */
const TARGETS: SoldierTarget[] = [];

/** A vehicle that can still be seen as a target: not a wreck (owner Q8: both sides know of a wreck at once, M7.4a). */
function vehicleSeeable(v: VehicleState | undefined): boolean {
  return v !== undefined && v.status !== "destroyed" && v.status !== "abandoned" && !isOffMap(v);
}

/** Every vehicle that can be seen this scan, ID order. */
function vehicleTargets(ctx: SimContext, state: SimState): VehTarget[] {
  const D = ctx.catalog.spotting, tick = state.tick, light = state.environment.light;
  const out: VehTarget[] = [];
  const flaring = state.flares !== undefined && state.flares.length > 0;
  for (const [vid, v] of state.vehicle.entries()) {
    if (!vehicleSeeable(v)) continue; // off-map: ok vehicleSeeable is false off the map
    const def = ctx.catalog.vehicles[v.def], t = state.transform.get(vid);
    if (!def || !t) continue;
    const firing = canFight(v) && v.stations.some((st) => st.weapons.some((w) => tick - w.lastShotTick <= secondsToTicks(D.firingWithinSeconds)));
    const moving = Math.abs(v.drive.speed) > D.vehicles.movingAboveMps;
    // Night (M9.1): a gun flash lights the hull for every observer up to vehicleFlashLight (a night sight or
    // thermal no better); 0 by day.
    const flash = firing && light < 1 ? D.night.vehicleFlashLight : 0;
    // Heat (M9.2): hot while it moves and for `hotSeconds` after (tracks, engine, exhaust); halted longer, it has
    // cooled (its engine idling shows less than a hull just driven).
    const TH = D.thermal;
    const hot = moving || (v.movedTick !== undefined && tick - v.movedTick <= secondsToTicks(TH.hotSeconds));
    const heat = v.fire !== null ? TH.vehicleBurning : firing ? TH.vehicleFiring : hot ? TH.vehicleHot : TH.vehicleCold;
    const gz = heightAt(ctx.map, t.x, t.y); // ground: ok (a vehicle)
    out.push({
      id: vid, side: v.side, x: t.x, y: t.y, gz, heading: t.heading, turret: t.heading + (v.stations[0]?.azimuth ?? 0), def,
      motion: (firing ? def.signature.firingFactor : 1) * (moving ? def.signature.movingFactor : 1), c: cos(t.heading), s: sin(t.heading), flash, heat,
      lit: flaring ? flareLightAt(state, ctx.catalog, t.x, t.y, gz) : 0, // (M9.6: flares; once per target)
    });
  }
  return out;
}

/**
 * One observer's scan of the vehicles: `sensorAt(dist, bearing)` is his best sensor factor toward that bearing
 * (optics x light x where he looks), `smokeAt(dist, bearing, conv, ms)` the share of it kept through smoke.
 * Vehicles he tracks are limited separately from men.
 */
function scanVehicles(
  ctx: SimContext, state: SimState, events: EventSink, oid: EntityId, side: string, seen: { target: EntityId; firstTick: number; lastTick: number }[],
  eye: { x: number; y: number; z: number; own: EntityId },
  sensorAt: (dist: number, bearing: number, flash: number, heat: number) => number, smokeAt: (dist: number, bearing: number, conv: number, ms: number, flash: number, heat: number) => number,
  own: number, vts: readonly VehTarget[], scanS: number, rangeCap = Infinity, os?: SoldierState,
): void {
  const D = ctx.catalog.spotting, V = D.vehicles, tick = state.tick;
  // A man takes a careful look at no more than one vehicle new to him per scan (cost bound with many hulls).
  let looks = 0;
  for (const tg of vts) {
    if (tg.side === side || tg.id === eye.own) continue;
    const dx = tg.x - eye.x, dy = tg.y - eye.y, d2 = dx * dx + dy * dy;
    const cap = Math.min(V.targetMaxRangeM, rangeCap);
    if (d2 > cap * cap) continue;
    const dist = sqrt(d2);
    const bearing = atan2(dy, dx);
    const sensor = sensorAt(dist, bearing, Math.max(tg.flash, tg.lit), tg.heat); // (M9.6: a flare's light as one more term)
    const heat = SENSOR_HEAT;
    if (sensor <= 0) continue;
    const { size, turretShare } = vehicleSize(D, tg.def, bearing - tg.heading, bearing - tg.turret);
    const idx = seen.findIndex((e) => e.target === tg.id);
    let rate = D.baseRatePerS * pow(D.referenceRangeM / Math.max(D.minRangeM, dist), D.rangeExponent) * size * tg.motion * own * sensor;
    if (idx >= 0) rate *= D.keepRateFactor;
    const u = nextFloat(state.rng, Streams.spotting);
    if (u >= 1 - exp(-rate * scanS)) continue;
    if (idx < 0) {
      let nv = 0;
      for (const e of seen) if (state.vehicle.has(e.target)) nv++;
      if (nv >= V.maxTracked || looks >= 1) continue;
      looks++;
    }
    // Best aim point: the hull's (full size) or a higher one (the turret's share: hull-down shows only that);
    // a hull seen well enough already is not looked at again higher up.
    let vis = 0, hvis = 0;
    const aps = tg.def.signature.aimPoints;
    for (let k = 0; k < aps.length; k++) {
      const share = k === 0 ? 1 : turretShare;
      if (vis >= share) break;
      const ap = aps[k]!;
      const ax = tg.x + tg.c * ap[0] - tg.s * ap[1], ay = tg.y + tg.s * ap[0] + tg.c * ap[1], az = tg.gz + ap[2];
      const sg = sight(ctx, eye.x, eye.y, eye.z, ax, ay, az, eye.own, tg.id);
      if (sg.blockedBy !== null) continue;
      if (sg.visibility * share > vis) { vis = sg.visibility * share; hvis = (sg.heatVisibility ?? sg.visibility) * share; }
    }
    if (vis <= 0) continue;
    vis = heatThrough(vis, sensor, heat, D.thermal.vegetationExponent, hvis); // (M9.2: heat through vegetation)
    if (state.smoke.length > 0) {
      const SP = smokePhysics(ctx.catalog), tz = tg.gz + tg.def.signature.aimPoints[0]![2];
      const conv = smokeTransmission(state, SP, eye.x, eye.y, eye.z, tg.x, tg.y, tz, "conventional");
      const ms = smokeTransmission(state, SP, eye.x, eye.y, eye.z, tg.x, tg.y, tz, "multispectral");
      vis *= smokeAt(dist, bearing, conv, ms, Math.max(tg.flash, tg.lit), tg.heat);
    }
    if (vis < D.minVisibility) vis = 0;
    if (u >= 1 - exp(-rate * vis * scanS)) continue;
    if (os) os.sawEnemyTick = tick; // (step 4: when he last saw an enemy)
    if (idx >= 0) { seen[idx]!.lastTick = tick; continue; }
    seen.push({ target: tg.id, firstTick: tick, lastTick: tick });
    seen.sort((a, b) => a.target - b.target);
    events.emit({ kind: "spotted", tick, observer: oid, target: tg.id, side, rangeM: dist });
  }
}

/**
 * A crewman's scan (M7.3): through his seat's sensors, from where they sit on the hull or turret, each looking
 * along the hull or the turret within its arc (side and rear factors outside it). Range, fog and rain per sensor.
 */
function crewScan(
  ctx: SimContext, state: SimState, events: EventSink, oid: EntityId, os: SoldierState, v: VehicleState, def: VehicleDef, seat: number,
  targets: readonly SoldierTarget[], vts: readonly VehTarget[], every: number,
): void {
  const D = ctx.catalog.spotting, tick = state.tick;
  // A crewman searches every fourth scan (four times the scan time): through his sights he sweeps a sector,
  // not the whole surroundings at once (and the cost with thirty vehicles stays bounded).
  if ((oid + Math.floor(tick / every)) % VEHICLE_SCAN_EVERY !== 0) return;
  const scanS = (VEHICLE_SCAN_EVERY * every) / TICK_HZ;
  const t = state.transform.get(os.mount!.vehicle);
  const side = v.side;
  if (!t) return;
  const sensors = def.seats[seat]!.sensors!;
  const c = cos(t.heading), s = sin(t.heading);
  const p = sensors[0]!.pos ?? def.seats[seat]!.pos;
  const ex = t.x + c * p[0] - s * p[1], ey = t.y + s * p[0] + c * p[1], ez = heightAt(ctx.map, t.x, t.y) + p[2]; // ground: ok (a vehicle sight)
  const light = state.environment.light, rain = state.environment.rain, vis = state.environment.visibilityM;
  const turretAz = t.heading + (v.stations[0]?.azimuth ?? 0);
  const skill = os.skills["observation"] ?? os.skills["marksmanship"] ?? 0.5;
  const own = Math.max(0.2, 1 + D.skillSlope * (skill - 0.5)) * Math.max(0, 1 - D.stressK * Math.max(os.mental.stress, os.mental.suppression));
  let maxR = 0;
  // Wrecked sights (M7.4b): the gunner and commander look through their vision blocks instead.
  const blind = def.components !== undefined && def.seats[seat]!.station !== "driver" && compCondition(v, def, "sights") <= 0 && D.sensors["vision-block"] !== undefined;
  const kinds = sensors.map((sn) => {
    const k = blind ? D.sensors["vision-block"]! : D.sensors[sn.kind]!;
    const range = Math.min(k.maxRangeM ?? D.maxRangeM, Math.max(vis, k.fogFloorM ?? 0));
    if (range > maxR) maxR = range;
    return { def: k, sn, range, rainK: 1 - (1 - (k.rainFactor ?? 1)) * rain };
  });
  // Best sensor toward a bearing at a distance, without smoke (ra) and through smoke (with conv/ms).
  const sensorAt = (dist: number, bearing: number, conv = 1, ms = 1, flash = 0, heat = 1): number => {
    let best = 0;
    SENSOR_HEAT = 0;
    for (const k of kinds) {
      if (dist > k.range) continue;
      const lookDir = k.sn.follows === "station" ? turretAz : t.heading;
      const off = angleBetween(lookDir, bearing);
      const view = off <= k.sn.arcRad / 2 ? 1 : off <= PI / 2 ? k.sn.sideFactor : k.sn.rearFactor;
      const f = (dist >= k.def.fromM ? k.def.factor : 1) * Math.max(D.lightFloor, light, k.def.nightLight, flash) * k.rainK * view * throughSmoke(k.def.smokeFactor ?? 0, conv, ms) * (k.def.thermal === true ? heat : 1);
      if (f > best) best = f;
      if (k.def.thermal === true && f > SENSOR_HEAT) SENSOR_HEAT = f;
    }
    return best;
  };
  // Men (a careful look at no more than two men new to him per search: a cost bound).
  let looks = 0;
  for (const tg of targets) {
    if (tg.side === side) continue;
    const dx = tg.x - ex, dy = tg.y - ey, d2 = dx * dx + dy * dy;
    if (d2 > maxR * maxR) continue;
    const dist = sqrt(d2), bearing = atan2(dy, dx);
    const sensor = sensorAt(dist, bearing, 1, 1, Math.max(tg.flash, tg.lit), tg.heat * tg.unblend);
    const heat = SENSOR_HEAT;
    if (sensor <= 0) continue;
    const idx = os.seen.findIndex((e) => e.target === tg.id);
    let rate = D.baseRatePerS * pow(D.referenceRangeM / Math.max(D.minRangeM, dist), D.rangeExponent) * tg.size * tg.motion * own * sensor;
    if (tg.fireX > 0) rate *= firingAt(tg, dist);
    if (tg.groundK > 0 && sensor > 0) { const g = d2 * tg.groundK; rate *= Math.max(1 / (1 + g * g), heat / sensor); } // (thermal: heat shows through the grass)
    if (idx >= 0) rate *= tg.keep;
    const u = nextFloat(state.rng, Streams.spotting);
    if (u >= 1 - exp(-rate * scanS)) continue;
    let far = -1;
    if (idx < 0) {
      let men = 0, farD = -1;
      for (let q = 0; q < os.seen.length; q++) {
        if (state.vehicle.has(os.seen[q]!.target)) continue;
        men++;
        const xt = state.transform.get(os.seen[q]!.target);
        const dq = xt ? (xt.x - ex) * (xt.x - ex) + (xt.y - ey) * (xt.y - ey) : Infinity;
        if (dq > farD) { farD = dq; far = q; }
      }
      if (men < D.maxTracked) far = -1;
      else if (farD <= d2) continue;
      if (looks >= 2) continue;
      looks++;
    }
    const sg = sight(ctx, ex, ey, ez, tg.x, tg.y, tg.z, os.mount!.vehicle);
    if (sg.blockedBy !== null) continue;
    let vv = sg.visibility;
    vv = heatThrough(vv, sensor, heat, D.thermal.vegetationExponent, sg.heatVisibility); // (M9.2: heat through vegetation)
    if ((tg.firing || tg.moving) && tg.vegTopZ > tg.z) {
      const top = sight(ctx, ex, ey, ez, tg.x, tg.y, tg.vegTopZ + 0.1, os.mount!.vehicle);
      if (top.blockedBy === null) vv = Math.max(vv, (tg.firing ? tg.fireFloor : D.movingVisibilityFloor) * top.visibility);
    }
    if (state.smoke.length > 0) {
      const SP = smokePhysics(ctx.catalog);
      const conv = smokeTransmission(state, SP, ex, ey, ez, tg.x, tg.y, tg.z, "conventional");
      const ms = smokeTransmission(state, SP, ex, ey, ez, tg.x, tg.y, tg.z, "multispectral");
      vv *= sensorAt(dist, bearing, conv, ms, Math.max(tg.flash, tg.lit), tg.heat * tg.unblend) / sensor;
    }
    if (vv < D.minVisibility) vv = 0;
    if (u >= 1 - exp(-rate * vv * scanS)) continue;
    os.sawEnemyTick = tick; // (step 4: when he last saw an enemy)
    if (idx >= 0) { os.seen[idx]!.lastTick = tick; continue; }
    if (far >= 0) os.seen.splice(far, 1);
    os.seen.push({ target: tg.id, firstTick: tick, lastTick: tick });
    os.seen.sort((a, b) => a.target - b.target);
    events.emit({ kind: "spotted", tick, observer: oid, target: tg.id, side, rangeM: dist });
  }
  // Vehicles.
  scanVehicles(ctx, state, events, oid, side, os.seen, { x: ex, y: ey, z: ez, own: os.mount!.vehicle },
    (dist, bearing, flash, heat) => sensorAt(dist, bearing, 1, 1, flash, heat),
    (dist, bearing, conv, ms, flash, heat) => { const b = sensorAt(dist, bearing, 1, 1, flash, heat); return b > 0 ? sensorAt(dist, bearing, conv, ms, flash, heat) / b : 0; },
    own, vts, scanS, maxR, os);
}
