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
import { smokeTransmission } from "./support";
import type { SoldierState } from "../components";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { secondsToTicks, TICK_HZ, type EntityId } from "../ids";
import { isAble } from "../impair";
import { eyeHeightM, sight, TARGET_POINT_M } from "../los";
import { atan2, cos, exp, PI, pow, sin, sqrt } from "../math";
import { nextFloat, Streams } from "../rng";
import type { SimState } from "../state";
import { heightAt, standZ } from "../terrain";
import type { SpottingDef, VehicleDef } from "../catalog";
import type { VehicleState } from "../components";

import { canFight } from "./gunnery";
import { compCondition } from "../mount";

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

/** Scans between two looks for vehicles by a man on foot, and between two searches by a crewman (M7.3). */
const VEHICLE_SCAN_EVERY = 4;

interface VehTarget {
  id: EntityId; side: string; x: number; y: number; gz: number; heading: number; turret: number; def: VehicleDef; motion: number; c: number; s: number;
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
  for (const [oid, os] of state.soldier.entries()) {
    if ((oid + tick) % every !== 0) continue;
    // Forget what has not been seen for a while, and the dead.
    if (os.seen.length > 0) os.seen = os.seen.filter((e) => tick - e.lastTick <= forget && (state.soldier.get(e.target)?.physiology.alive === true || vehicleSeeable(state.vehicle.get(e.target))));
    if (!isAble(os)) continue;
    if (os.mount !== undefined) {
      // Aboard (M7.3): the crew look through their seats' sensors; passengers see nothing outside.
      const v = state.vehicle.get(os.mount.vehicle), def = v ? ctx.catalog.vehicles[v.def] : undefined;
      const seat = def?.seats[os.mount.seat];
      if (!v || !def || !seat?.sensors || seat.sensors.length === 0 || seat.station === "passenger") continue;
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
    if (box) for (const st of box.stacks) { const k = ctx.catalog.items[st.type]?.sensor; if (k !== undefined && st.count > 0) sensors.push(D.sensors[k]); }
    for (const tg of targets) {
      if (tg.side === oi.side || tg.id === oid) continue;
      const dx = tg.x - ot.x, dy = tg.y - ot.y, d2 = dx * dx + dy * dy;
      if (d2 > maxR2 || d2 > fogR2) continue;
      const dist = sqrt(d2);
      let sensor = 0;
      for (const sn of sensors) if (sn) { const f = (dist >= sn.fromM ? sn.factor : 1) * Math.max(D.lightFloor, light, sn.nightLight); if (f > sensor) sensor = f; }
      const idx = os.seen.findIndex((e) => e.target === tg.id);
      const look = angleBetween(ot.heading, atan2(dy, dx));
      const view = look <= front ? 1 : look <= side ? D.sideFactor : D.rearFactor;
      let rate = D.baseRatePerS * pow(D.referenceRangeM / Math.max(D.minRangeM, dist), D.rangeExponent) * tg.size * tg.motion * view * own * sensor;
      if (idx >= 0) rate *= D.keepRateFactor;
      const u = nextFloat(state.rng, Streams.spotting);
      if (u >= 1 - exp(-rate * scanS)) continue; // could not succeed even with a perfect view
      // He can only keep track of so many: a new one only if nearer than the farthest he watches (checked
      // before the costly sight line: it could not be taken on anyway).
      let far = -1;
      if (idx < 0 && menSeen(state, os.seen) >= D.maxTracked) {
        let farD = -1;
        for (let q = 0; q < os.seen.length; q++) {
          if (state.vehicle.size > 0 && state.vehicle.has(os.seen[q]!.target)) continue; // vehicles are tracked apart (M7.3)
          const xt = state.transform.get(os.seen[q]!.target);
          const dq = xt ? (xt.x - ot.x) * (xt.x - ot.x) + (xt.y - ot.y) * (xt.y - ot.y) : Infinity;
          if (dq > farD) { farD = dq; far = q; }
        }
        if (farD <= d2) continue;
      }
      const sg = sight(ctx, ot.x, ot.y, ez, tg.x, tg.y, tg.z);
      if (sg.blockedBy !== null) continue;
      let vis = sg.visibility;
      // Moving through vegetation shakes the plants above him, firing shows flash and dust: seen if the line to
      // the top of the vegetation over him is clear (not through a wood between).
      if ((tg.firing || tg.moving) && tg.vegTopZ > tg.z) {
        const top = sight(ctx, ot.x, ot.y, ez, tg.x, tg.y, tg.vegTopZ + 0.1);
        if (top.blockedBy === null) vis = Math.max(vis, (tg.firing ? D.firingVisibilityFloor : D.movingVisibilityFloor) * top.visibility);
      }
      // Smoke (M6.5c) between them hides him.
      if (state.smoke.length > 0) vis *= smokeTransmission(state, D.smokeExtinctionPerM, ot.x, ot.y, tg.x, tg.y, secondsToTicks(D.smokeBuildSeconds));
      if (vis < D.minVisibility) vis = 0;
      if (u >= 1 - exp(-rate * vis * scanS)) continue;
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
      scanVehicles(ctx, state, events, oid, oi.side, os.seen, look, (dist, bearing) => {
        let sensor = 0;
        for (const sn of sensors) if (sn) { const f = (dist >= sn.fromM ? sn.factor : 1) * Math.max(D.lightFloor, light, sn.nightLight); if (f > sensor) sensor = f; }
        const lk = angleBetween(ot.heading, bearing);
        return sensor * (lk <= front ? 1 : lk <= side ? D.sideFactor : D.rearFactor);
      }, () => 1, own, vtargets, VEHICLE_SCAN_EVERY * scanS, Math.min(state.environment.visibilityM, D.maxRangeM)); // a man's eyes reach as far for a hull as for a man
    }
  }
}

/** Men (not vehicles) in a `seen` list. */
function menSeen(state: SimState, seen: readonly { target: EntityId }[]): number {
  if (state.vehicle.size === 0) return seen.length;
  let n = 0;
  for (const e of seen) if (!state.vehicle.has(e.target)) n++;
  return n;
}

interface SoldierTarget { id: EntityId; side: string; x: number; y: number; z: number; size: number; motion: number; firing: boolean; moving: boolean; vegTopZ: number }

/** Every man who can be seen this scan (not aboard a vehicle), ID order. */
function soldierTargets(ctx: SimContext, state: SimState): SoldierTarget[] {
  const D = ctx.catalog.spotting, map = ctx.map, tick = state.tick, B = ctx.ballistics;
  // (Rows are reused from tick to tick: no allocation per man per tick, M7.3.)
  const targets = TARGETS;
  let n = 0;
  for (const [tid, ts] of state.soldier.entries()) {
    if (!ts.physiology.alive || ts.mount !== undefined) continue; // a man aboard is never a target (M7)
    const tt = state.transform.get(tid), ti = state.identity.get(tid);
    if (!tt || !ti) continue;
    const speed = state.mover.get(tid)?.speedMps ?? 0;
    const moving = speed > D.stillBelowMps;
    const firing = tick - (state.weapon.get(tid)?.lastShotTick ?? -1e9) <= secondsToTicks(D.firingWithinSeconds);
    // Top of the vegetation he is in (where moving plants or the flash of his shots show), or -Infinity.
    const g = heightAt(map, tt.x, tt.y); // ground: ok (vegetation top; his own height below)
    const cell = Math.floor(tt.y / map.cellSizeM) * map.cols + Math.floor(tt.x / map.cellSizeM);
    const v = cell >= 0 && cell < map.vegetation.length ? map.vegetation[cell]! : 0;
    const vegTopZ = v > 0 ? g + B.vegHeightM[v - 1]! : -Infinity;
    let r = targets[n];
    if (!r) { r = { id: 0, side: "", x: 0, y: 0, z: 0, size: 0, motion: 0, firing: false, moving: false, vegTopZ: 0 }; targets[n] = r; }
    r.vegTopZ = vegTopZ; r.id = tid; r.side = ti.side; r.x = tt.x; r.y = tt.y; r.z = g + tt.z + TARGET_POINT_M[ts.posture];
    r.size = D.postureSize[ts.posture]; r.moving = moving; r.firing = firing;
    r.motion = (firing ? D.firingFactor : 1) * (!moving ? 1 : speed > D.runningAboveMps ? D.runningFactor : D.movingFactor);
    n++;
  }
  targets.length = n;
  return targets;
}

/** Reused rows of `soldierTargets` (rebuilt every tick in which someone scans; never kept across ticks). */
const TARGETS: SoldierTarget[] = [];

/** A vehicle that can still be seen as a target: not a wreck (owner Q8: both sides know of a wreck at once, M7.4a). */
function vehicleSeeable(v: VehicleState | undefined): boolean {
  return v !== undefined && v.status !== "destroyed" && v.status !== "abandoned";
}

/** Every vehicle that can be seen this scan, ID order. */
function vehicleTargets(ctx: SimContext, state: SimState): VehTarget[] {
  const D = ctx.catalog.spotting, tick = state.tick;
  const out: VehTarget[] = [];
  for (const [vid, v] of state.vehicle.entries()) {
    if (!vehicleSeeable(v)) continue;
    const def = ctx.catalog.vehicles[v.def], t = state.transform.get(vid);
    if (!def || !t) continue;
    const firing = canFight(v) && v.stations.some((st) => st.weapons.some((w) => tick - w.lastShotTick <= secondsToTicks(D.firingWithinSeconds)));
    const moving = Math.abs(v.drive.speed) > D.vehicles.movingAboveMps;
    out.push({
      id: vid, side: v.side, x: t.x, y: t.y, gz: heightAt(ctx.map, t.x, t.y), heading: t.heading, turret: t.heading + (v.stations[0]?.azimuth ?? 0), def, // ground: ok (a vehicle)
      motion: (firing ? def.signature.firingFactor : 1) * (moving ? def.signature.movingFactor : 1), c: cos(t.heading), s: sin(t.heading),
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
  sensorAt: (dist: number, bearing: number) => number, smokeAt: (dist: number, bearing: number, conv: number, ms: number) => number,
  own: number, vts: readonly VehTarget[], scanS: number, rangeCap = Infinity,
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
    const sensor = sensorAt(dist, bearing);
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
    let vis = 0;
    const aps = tg.def.signature.aimPoints;
    for (let k = 0; k < aps.length; k++) {
      const share = k === 0 ? 1 : turretShare;
      if (vis >= share) break;
      const ap = aps[k]!;
      const ax = tg.x + tg.c * ap[0] - tg.s * ap[1], ay = tg.y + tg.s * ap[0] + tg.c * ap[1], az = tg.gz + ap[2];
      const sg = sight(ctx, eye.x, eye.y, eye.z, ax, ay, az, eye.own, tg.id);
      if (sg.blockedBy !== null) continue;
      if (sg.visibility * share > vis) vis = sg.visibility * share;
    }
    if (vis <= 0) continue;
    if (state.smoke.length > 0) {
      const build = secondsToTicks(D.smokeBuildSeconds);
      const conv = smokeTransmission(state, D.smokeExtinctionPerM, eye.x, eye.y, tg.x, tg.y, build, "conventional");
      const ms = smokeTransmission(state, D.smokeExtinctionPerM, eye.x, eye.y, tg.x, tg.y, build, "multispectral");
      vis *= smokeAt(dist, bearing, conv, ms);
    }
    if (vis < D.minVisibility) vis = 0;
    if (u >= 1 - exp(-rate * vis * scanS)) continue;
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
  const sensorAt = (dist: number, bearing: number, conv = 1, ms = 1): number => {
    let best = 0;
    for (const k of kinds) {
      if (dist > k.range) continue;
      const lookDir = k.sn.follows === "station" ? turretAz : t.heading;
      const off = angleBetween(lookDir, bearing);
      const view = off <= k.sn.arcRad / 2 ? 1 : off <= PI / 2 ? k.sn.sideFactor : k.sn.rearFactor;
      const f = (dist >= k.def.fromM ? k.def.factor : 1) * Math.max(D.lightFloor, light, k.def.nightLight) * k.rainK * view * throughSmoke(k.def.smokeFactor ?? 0, conv, ms);
      if (f > best) best = f;
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
    const sensor = sensorAt(dist, bearing);
    if (sensor <= 0) continue;
    const idx = os.seen.findIndex((e) => e.target === tg.id);
    let rate = D.baseRatePerS * pow(D.referenceRangeM / Math.max(D.minRangeM, dist), D.rangeExponent) * tg.size * tg.motion * own * sensor;
    if (idx >= 0) rate *= D.keepRateFactor;
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
    if ((tg.firing || tg.moving) && tg.vegTopZ > tg.z) {
      const top = sight(ctx, ex, ey, ez, tg.x, tg.y, tg.vegTopZ + 0.1, os.mount!.vehicle);
      if (top.blockedBy === null) vv = Math.max(vv, (tg.firing ? D.firingVisibilityFloor : D.movingVisibilityFloor) * top.visibility);
    }
    if (state.smoke.length > 0) {
      const build = secondsToTicks(D.smokeBuildSeconds);
      const conv = smokeTransmission(state, D.smokeExtinctionPerM, ex, ey, tg.x, tg.y, build, "conventional");
      const ms = smokeTransmission(state, D.smokeExtinctionPerM, ex, ey, tg.x, tg.y, build, "multispectral");
      vv *= sensorAt(dist, bearing, conv, ms) / sensor;
    }
    if (vv < D.minVisibility) vv = 0;
    if (u >= 1 - exp(-rate * vv * scanS)) continue;
    if (idx >= 0) { os.seen[idx]!.lastTick = tick; continue; }
    if (far >= 0) os.seen.splice(far, 1);
    os.seen.push({ target: tg.id, firstTick: tick, lastTick: tick });
    os.seen.sort((a, b) => a.target - b.target);
    events.emit({ kind: "spotted", tick, observer: oid, target: tg.id, side, rangeM: dist });
  }
  // Vehicles.
  scanVehicles(ctx, state, events, oid, side, os.seen, { x: ex, y: ey, z: ez, own: os.mount!.vehicle },
    (dist, bearing) => sensorAt(dist, bearing),
    (dist, bearing, conv, ms) => { const b = sensorAt(dist, bearing); return b > 0 ? sensorAt(dist, bearing, conv, ms) / b : 0; },
    own, vts, scanS, maxR);
}
