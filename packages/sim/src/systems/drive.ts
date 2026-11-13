/**
 * VEHICLE DRIVE (SPEC 6.7, M7.1b): a physical drive model per vehicle and a simple path follower.
 *
 * Tracked vehicles: each track has its own ground speed; the engine's power (less what turning costs) is
 * shared between them, each limited by its own traction; rolling resistance, grade and the turning resistance
 * of the tracks act on them. Body speed and yaw rate follow from the two track speeds (with a lumped slip).
 * Wheeled vehicles: one longitudinal force, a steered front axle (bicycle model) with a lateral cap.
 * Gears: constant power per band, a pause at each shift. Rain lowers traction and raises rolling resistance.
 * Fuel: litres burnt leave the tank item's charge (SPEC 4.3 rule 9).
 *
 * The dynamics core is the pure `stepDriveDynamics` (tests call it on a copy); `vehicleDriveSystem` runs it on
 * the state in ID order, driven only by `move` / `halt` orders to the crew unit (rule 3). No randomness.
 * M7.1c: routes on the class grid with clearance; hulls are checked against true building outlines, walls,
 * water and each other; a corridor ahead makes men step aside and hulls yield; stuck hulls plan again.
 */
import type { SurfaceVehicleDef, VehicleDef } from "../catalog";
import type { DriveState, VehicleState } from "../components";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { DT, secondsToTicks, type EntityId } from "../ids";
import { addItems, removeItems } from "../items";
import { atan, atan2, clamp, cos, hypot2, PI, sin, sqrt, tan, wrapAngle } from "../math";
import { compCondition, hasDriver } from "../mount";
import type { SimState } from "../state";
import type { Order, Waypoint } from "../orders";
import { findPath, type NavStamp } from "../nav";
import { navFor } from "../navctx";
import { hullObb, hullTerrain, obbOverlap, pointInObb, rebuildVehicleGrid, type HullTerrain, type Obb } from "../hulls";
import { isAble } from "../impair";
import { isCowering } from "./morale";
import { applyCrush } from "./wounds";
import { syncTerrainDamage } from "./explosions";
import { cellIndex, heightAt } from "../terrain";
import { radioFromTarget } from "./orders";
import { seatWorld } from "../setup";
import { dischargeSmoke, stationFireOrder } from "./gunnery";

const G = 9.80665;
/** Time constant of the speed controller on each track / the body, s. */
const SPEED_TAU_S = 0.3;
/** Smoothing width of the sign of a speed (rolling resistance, turn resistance), m/s and rad/s. */
const SIGN_V = 0.05, SIGN_W = 0.05;
/** Yaw rate wanted per radian of heading error when turning on the spot, 1/s. */
const PIVOT_GAIN = 4;

/** What the driver is asked for this tick: body speed (signed, m/s), yaw rate (rad/s), and for wheeled
 *  vehicles the path curvature (1/m, + = right) instead of the yaw rate. */
export interface DriveCmd { speed: number; yawRate: number; curvature?: number }

/** The ground under the hull, already corrected for rain. */
export interface DriveSurface {
  rolling: number; traction: number; lateral: number;
  /** Speed limit of the ground (and vegetation), m/s; 0 = cannot drive here. */
  capMps: number;
  /** sin and cos of the hull's pitch (+ = nose up). */
  sinPitch: number; cosPitch: number;
}

/** Condition factors (components, M7.4b): engine power, each track's pull. */
export interface DriveFactors { engine: number; trackL: number; trackR: number }
const FULL: DriveFactors = { engine: 1, trackL: 1, trackR: 1 };
const FACT: DriveFactors = { engine: 1, trackL: 1, trackR: 1 };
/**
 * Condition factors from the components (M7.4b, plan §8): an engine below half condition gives half power; each
 * track pulls with its condition (a damaged track drags the hull round). Shared scratch; FULL without components.
 */
function driveFactors(v: VehicleState, def: VehicleDef): DriveFactors {
  const comps = def.components;
  if (!comps) return FULL;
  FACT.engine = compCondition(v, def, "engine") < 0.5 ? 0.5 : 1;
  FACT.trackL = 1; FACT.trackR = 1;
  for (let k = 0; k < comps.length; k++) {
    if (comps[k]!.kind !== "track") continue;
    const c = Math.max(0.05, v.comp[k] ?? 1), right = comps[k]!.box.r[0] + comps[k]!.box.r[1] > 0;
    if (right) FACT.trackR = Math.min(FACT.trackR, c); else FACT.trackL = Math.min(FACT.trackL, c);
  }
  return FACT;
}

/** Ground under a hull at (x, y) on a level of wetness 0..1; null fields when no vehicle may drive there. */
export function driveSurface(ctx: SimContext, def: VehicleDef, x: number, y: number, heading: number, wet: number): DriveSurface {
  const map = ctx.map;
  const cell = cellIndex(map, x, y);
  const sid = cell < 0 ? undefined : map.surfacePalette[map.surface[cell]!];
  const sv: SurfaceVehicleDef | undefined = sid === undefined ? undefined : ctx.catalog.terrain.surfaces[sid]?.vehicle;
  const half = def.body.lengthM / 2;
  const c = cos(heading), s = sin(heading);
  // ground: ok (a hull on the ground)
  const hf = heightAt(map, x + c * half, y + s * half), hb = heightAt(map, x - c * half, y - s * half);
  const dh = hf - hb, len = sqrt(dh * dh + 4 * half * half);
  const sinPitch = dh / len, cosPitch = (2 * half) / len;
  if (!sv) return { rolling: 1, traction: 0.1, lateral: 0.1, capMps: 0, sinPitch, cosPitch };
  let cap = sv.capKmh !== undefined ? sv.capKmh / 3.6 : Infinity;
  const v = cell < 0 ? 0 : map.vegetation[cell]!;
  if (v !== 0) {
    const veg = ctx.catalog.terrain.vegetation[map.vegetationPalette[v - 1]!];
    const k = veg ? veg.moveCost[def.class] : 1;
    cap = k === null ? 0 : Math.min(cap, def.drive.topSpeedMps / Math.max(1, k));
  }
  return {
    rolling: sv.rolling * (1 + (sv.wetRollingFactor - 1) * wet),
    traction: sv.traction * (1 + (sv.wetTractionFactor - 1) * wet),
    lateral: sv.lateral * (1 + (sv.wetTractionFactor - 1) * wet),
    capMps: cap, sinPitch, cosPitch,
  };
}

/** Pick the gear for body speed v and the wanted direction; starts a shift pause when it changes. */
function shiftGears(def: VehicleDef, d: DriveState, want: number, tick: number): void {
  const v = d.speed, D = def.drive;
  const pause = secondsToTicks(D.shiftSeconds);
  if (want > 0 && d.gear <= 0 && v > -0.3) { d.gear = 1; d.shiftUntilTick = tick + pause; return; }
  if (want < 0 && d.gear >= 0 && v < 0.3) { d.gear = -1; d.shiftUntilTick = tick + pause; return; }
  if (d.gear === 0) return;
  const bands = d.gear > 0 ? D.gearsMps : D.reverseGearsMps;
  const g = Math.abs(d.gear), sp = Math.abs(v);
  if (tick < d.shiftUntilTick) return; // one shift at a time
  // (Wide hysteresis: the speed lost during an up-shift's pause must not bring the next down-shift.)
  if (g < bands.length && sp > 0.95 * bands[g - 1]!) { d.gear += Math.sign(d.gear); d.shiftUntilTick = tick + pause; }
  else if (g > 1 && sp < 0.5 * bands[g - 2]!) { d.gear -= Math.sign(d.gear); d.shiftUntilTick = tick + pause; }
}

/** Lower end of the current gear band, m/s. */
function gearLower(def: VehicleDef, gear: number): number {
  const g = Math.abs(gear);
  if (g <= 1) return 0;
  return (gear > 0 ? def.drive.gearsMps : def.drive.reverseGearsMps)[g - 2]!;
}

const sgn = (x: number, w: number) => clamp(x / w, -1, 1);

/**
 * One ground element (a track, or the whole wheeled body) of mass `mass` driven toward speed `target`:
 * engine force up to `fEng`, brakes up to `fBrake`, both within `traction`; `ext` = grade and turning forces,
 * `roll` = rolling resistance (opposes motion; holds the element still if nothing beats it).
 * Returns the new speed; writes the force used to OUT[0] and whether it was braking to OUT[1].
 */
const OUT = [0, 0];
function element(v: number, target: number, mass: number, fEng: number, fBrake: number, traction: number, ext: number, roll: number, dt: number): number {
  const want = (mass * (target - v)) / SPEED_TAU_S - ext + roll * sgn(v, SIGN_V);
  let f: number, braking = 0;
  const propel = v * want >= 0 || Math.abs(v) < SIGN_V;
  if (propel) { const lim = Math.min(fEng, traction); f = clamp(want, -lim, lim); }
  else { const lim = Math.min(fBrake, traction); f = clamp(want, -lim, lim); braking = 1; }
  OUT[0] = f; OUT[1] = braking;
  const net = f + ext;
  let nv: number;
  if (v === 0) {
    // Standing: rolling resistance holds it unless the net force beats it.
    nv = Math.abs(net) <= roll ? 0 : v + ((net - Math.sign(net) * roll) / mass) * dt;
  } else {
    nv = v + ((net - roll * Math.sign(v)) / mass) * dt;
    // Resistance and brakes stop it; they do not drive it backwards.
    if (nv * v < 0 && target * v >= 0) nv = 0;
  }
  return nv;
}

/**
 * The dynamics core, in place on `d` (no allocation). Returns the mechanical power at the tracks or wheels,
 * W (for fuel). `tick` times the gear shifts.
 */
export function driveDynamicsInPlace(def: VehicleDef, d: DriveState, cmd: DriveCmd, surf: DriveSurface, dt: number, tick: number, f: DriveFactors = FULL): number {
  const D = def.drive, m = def.massKg;
  const top = Math.min(D.topSpeedMps, surf.capMps), rtop = Math.min(D.reverseTopSpeedMps, surf.capMps);
  let vT = clamp(cmd.speed, -rtop, top);
  shiftGears(def, d, vT > 0.05 ? 1 : vT < -0.05 ? -1 : 0, tick);
  const shifting = tick < d.shiftUntilTick;
  // A gear in the other direction (just changed, not yet engaged): hold still until it is.
  if (shifting && d.gear * vT < 0) vT = 0;
  const P0 = D.powerW * D.efficiency * f.engine;
  const normal = m * G * surf.cosPitch, grade = -m * G * surf.sinPitch;
  const lower = gearLower(def, d.gear);
  let power: number;
  if (D.steering.kind === "tracked") {
    const st = D.steering, B = def.body.trackGaugeM ?? def.body.widthM * 0.75, L = def.body.trackContactM ?? def.body.lengthM * 0.65;
    const k = 1 + st.slipCoeff;
    let wT = clamp(cmd.yawRate, -st.pivotRateRadS, st.pivotRateRadS);
    const latCap = st.maxLatAccelMps2 / Math.max(Math.abs(d.speed), 0.5);
    wT = clamp(wT, -latCap, latCap);
    if (!st.pivot && Math.abs(vT) < 0.5) wT = 0;
    const tL = vT + (wT * B * k) / 2, tR = vT - (wT * B * k) / 2;
    const Mr = st.turnResistance * surf.lateral * normal * L / 4;
    const pTurn = Mr * Math.abs(d.yawRate);
    const P = Math.max(P0 - pTurn, 0.2 * P0);
    const half = m / 2, trac = (surf.traction * normal) / 2, roll = (surf.rolling * normal) / 2;
    const fb = D.brakeMps2 * half;
    const turn = (Mr / B) * sgn(d.yawRate, SIGN_W);
    const engL = shifting ? 0 : (P / 2) / Math.max(Math.abs(d.trackL), lower, 1);
    const engR = shifting ? 0 : (P / 2) / Math.max(Math.abs(d.trackR), lower, 1);
    const vL0 = d.trackL, vR0 = d.trackR;
    // (Turning resistance holds back the faster track and pushes the slower one: it resists the yaw.)
    d.trackL = element(vL0, tL, half, engL * f.trackL, fb, trac * f.trackL, grade / 2 - turn, roll, dt);
    const fL = OUT[0]!, bL = OUT[1]!;
    d.trackR = element(vR0, tR, half, engR * f.trackR, fb, trac * f.trackR, grade / 2 + turn, roll, dt);
    const fR = OUT[0]!, bR = OUT[1]!;
    if (f.trackL <= 0) d.trackL = 0;
    if (f.trackR <= 0) d.trackR = 0;
    d.speed = (d.trackL + d.trackR) / 2;
    d.yawRate = (d.trackL - d.trackR) / (B * k);
    d.steer = 0;
    power = (bL ? 0 : Math.abs(fL * vL0)) + (bR ? 0 : Math.abs(fR * vR0)) + pTurn;
    d.throttle = clamp(((bL ? 0 : Math.abs(fL)) + (bR ? 0 : Math.abs(fR))) / Math.max(1, engL + engR), 0, 1);
    d.brake = clamp(((bL ? Math.abs(fL) : 0) + (bR ? Math.abs(fR) : 0)) / (2 * fb), 0, 1);
  } else {
    const st = D.steering, wb = def.body.wheelbaseM ?? def.body.lengthM * 0.6;
    // Steer toward the wheel angle that gives the wanted curvature, at the steering rate.
    const kappa = cmd.curvature ?? (Math.abs(vT) > 0.1 ? cmd.yawRate / vT : 0);
    const want = clamp(atan(wb * kappa), -st.maxSteerRad, st.maxSteerRad);
    d.steer += clamp(want - d.steer, -st.steerRateRadS * dt, st.steerRateRadS * dt);
    const v0 = d.speed;
    const eng = shifting ? 0 : P0 / Math.max(Math.abs(v0), lower, 1);
    d.speed = element(v0, vT, m, eng, D.brakeMps2 * m, surf.traction * normal, grade, surf.rolling * normal, dt);
    const fF = OUT[0]!, b = OUT[1]!;
    let w = (d.speed * tan(d.steer)) / wb;
    const latCap = st.maxLatAccelMps2 / Math.max(Math.abs(d.speed), 0.5);
    w = clamp(w, -latCap, latCap);
    d.yawRate = w;
    d.trackL = d.speed; d.trackR = d.speed;
    power = b ? 0 : Math.abs(fF * v0);
    d.throttle = b ? 0 : clamp(Math.abs(fF) / Math.max(1, eng), 0, 1);
    d.brake = b ? clamp(Math.abs(fF) / (D.brakeMps2 * m), 0, 1) : 0;
  }
  return power;
}

/**
 * PURE: one step of the drive dynamics on a copy of `drive` (the input is not changed). For tests and labs that
 * study the model in isolation; never wired into `step()`.
 */
export function stepDriveDynamics(def: VehicleDef, drive: DriveState, cmd: DriveCmd, surface: DriveSurface, dt: number, tick = 0, factors: DriveFactors = FULL): { drive: DriveState; powerW: number } {
  const d: DriveState = JSON.parse(JSON.stringify(drive)) as DriveState;
  const powerW = driveDynamicsInPlace(def, d, cmd, surface, dt, tick, factors);
  return { drive: d, powerW };
}

/** Litres in the vehicle's tank (the tank item's charge). */
export function fuelLitres(state: SimState, vid: EntityId, def: VehicleDef): number {
  const c = state.container.get(vid);
  if (!c) return 0;
  let l = 0;
  for (const s of c.stacks) if (s.type === def.fuel.item) l += (s.charge ?? 0) * s.count;
  return l;
}

/** Take whole litres from the tank item (the only count of the fuel). */
function drawFuel(state: SimState, vid: EntityId, def: VehicleDef, litres: number): void {
  const c = state.container.get(vid);
  if (!c || litres <= 0) return;
  let best = -1;
  c.stacks.forEach((s, i) => { if (s.type === def.fuel.item && (s.charge ?? 0) > 0 && (best < 0 || (s.charge ?? 0) > (c.stacks[best]!.charge ?? 0))) best = i; });
  if (best < 0) return;
  const charge = c.stacks[best]!.charge ?? 0;
  removeItems(c, def.fuel.item, 1, charge);
  addItems(c, def.fuel.item, 1, Math.max(0, charge - litres));
}

/** Remaining route length from (x, y): to the current waypoint, then along the rest. */
function routeLeft(d: DriveState, x: number, y: number): number {
  let px = x, py = y, s = 0;
  for (let i = d.routeIdx; i < d.route.length; i++) { const w = d.route[i]!; s += hypot2(w.x - px, w.y - py); px = w.x; py = w.y; }
  return s;
}

/** The pace of a waypoint as a speed for this vehicle, m/s (signed: negative on a reverse leg). */
function paceSpeed(ctx: SimContext, def: VehicleDef, mode: string, reverse: boolean): number {
  const m = ctx.catalog.movementModes[mode];
  let frac = 1;
  if (m && m.class === "foot") { const p = ctx.catalog.movementModes[m.vehiclePace[def.class]]; frac = p && p.class !== "foot" ? p.speedFraction : 0.3; }
  else if (m) frac = m.speedFraction;
  return reverse ? -frac * def.drive.reverseTopSpeedMps : frac * def.drive.topSpeedMps;
}

/** Wanted body speed and yaw rate from the route (pure pursuit). Writes CMD; returns it. */
const CMD: DriveCmd = { speed: 0, yawRate: 0, curvature: 0 };
export function followRoute(ctx: SimContext, def: VehicleDef, d: DriveState, x: number, y: number, h: number): DriveCmd {
  CMD.speed = 0; CMD.yawRate = 0; CMD.curvature = 0;
  const steering = def.drive.steering;
  const maxW = steering.kind === "tracked" ? steering.pivotRateRadS : 1;
  if (d.arrived || d.routeIdx >= d.route.length) {
    // At the end: turn to the ordered facing (tracked: on the spot), then hold.
    if (!d.arrived && d.endHeading !== null && steering.kind === "tracked" && Math.abs(d.speed) < 0.3) {
      const e = wrapAngle(d.endHeading - h);
      if (Math.abs(e) > (3 * PI) / 180) { CMD.yawRate = clamp(PIVOT_GAIN * e, -maxW, maxW); return CMD; }
      d.arrived = true;
    }
    return CMD;
  }
  const last = d.routeIdx === d.route.length - 1;
  let wp = d.route[d.routeIdx]!;
  const L = clamp(4 + 0.8 * Math.abs(d.speed), 4, 20);
  // Next waypoint once within reach of this one (not the last): close, so a long hull does not cut a corner.
  if (!last && hypot2(wp.x - x, wp.y - y) < Math.max(2.5, L * 0.3)) { d.routeIdx++; wp = d.route[d.routeIdx]!; }
  const reverse = wp.reverse === true;
  const dist = hypot2(wp.x - x, wp.y - y);
  // Pure pursuit: aim at the point L ahead on the current leg (from the point before), so a hull pulled off
  // the line (a weak track, a shove) is steered back onto it; on the first leg, at the point itself.
  let tx = wp.x - x, ty = wp.y - y;
  if (d.routeIdx > 0) {
    const a = d.route[d.routeIdx - 1]!;
    const lx = wp.x - a.x, ly = wp.y - a.y, len = hypot2(lx, ly);
    if (len > 1e-6) {
      const along = clamp(((x - a.x) * lx + (y - a.y) * ly) / len, 0, len) + L;
      if (along < len) { tx = a.x + (lx / len) * along - x; ty = a.y + (ly / len) * along - y; }
    }
  }
  const travel = reverse ? h + PI : h;
  const e = wrapAngle(atan2(ty, tx) - travel);
  // Last leg: stop on (or once past) the point.
  const isLast = d.routeIdx === d.route.length - 1;
  const passed = isLast && ((wp.x - x) * cos(travel) + (wp.y - y) * sin(travel)) < 0 && dist < 6;
  if (isLast && (dist < 1.5 || passed)) {
    if (Math.abs(d.speed) < 0.3) { d.routeIdx = d.route.length; if (d.endHeading === null || steering.kind !== "tracked") d.arrived = true; }
    return CMD;
  }
  const pace = paceSpeed(ctx, def, wp.mode, reverse);
  const brake = def.drive.brakeMps2;
  const left = routeLeft(d, x, y);
  let v = Math.min(Math.abs(pace), sqrt(2 * 0.6 * brake * left));
  if (d.crossing) v = Math.min(v, d.crossing.capMps);
  // Slow for the corner at the next point: the sharper the turn, the slower.
  if (d.routeIdx + 1 < d.route.length) {
    const nx = d.route[d.routeIdx + 1]!;
    const prevX = d.routeIdx > 0 ? d.route[d.routeIdx - 1]!.x : x, prevY = d.routeIdx > 0 ? d.route[d.routeIdx - 1]!.y : y;
    const turn = Math.abs(wrapAngle(atan2(nx.y - wp.y, nx.x - wp.x) - atan2(wp.y - prevY, wp.x - prevX)));
    const vc = turn > PI / 3 ? 1.5 : turn > PI / 6 ? 3 : 8;
    v = Math.min(v, sqrt(vc * vc + 2 * 0.6 * brake * dist));
  }
  if (steering.kind === "tracked") {
    const pivoting = Math.abs(e) > PI / 3 || (Math.abs(e) > PI / 18 && Math.abs(d.speed) < 0.3 && Math.abs(d.yawRate) > 0.05);
    if (pivoting && steering.pivot) { CMD.speed = 0; CMD.yawRate = clamp(PIVOT_GAIN * e, -maxW, maxW); return CMD; }
    const kappa = (2 * sin(e)) / L;
    if (Math.abs(kappa) > 1e-6) v = Math.min(v, sqrt(steering.maxLatAccelMps2 / Math.abs(kappa)));
    const w = clamp(kappa * Math.max(Math.abs(d.speed), 1.5), -maxW, maxW);
    // A turn the tracks do not give (a weak track drags the hull aside): slower, until it does.
    if (Math.abs(w) > 0.15 && d.yawRate * w < 0.3 * w * w) v = Math.min(v, Math.abs(d.speed) - 0.05);
    v = Math.max(v, 0.5);
    CMD.speed = reverse ? -v : v;
    // (Closed loop on the line: a hull pulled off it is steered back.)
    CMD.yawRate = w;
  } else {
    const kappa = (2 * sin(e)) / L;
    if (Math.abs(kappa) > 1e-6) v = Math.min(v, sqrt(steering.maxLatAccelMps2 / Math.abs(kappa)));
    v = Math.max(v, 0.5);
    CMD.speed = reverse ? -v : v;
    // Reversing, the heading turns the other way for the same wheel angle.
    CMD.curvature = reverse ? -kappa : kappa;
  }
  return CMD;
}

/** Hull pose scratch (no allocation in the per-vehicle loop). */
const HT: HullTerrain = { blocked: false, crossObstacle: -1, crossPart: -1 };
const O_SELF: Obb = { x: 0, y: 0, c: 1, s: 0, hl: 0, hw: 0 };
const O_OTHER: Obb = { x: 0, y: 0, c: 1, s: 0, hl: 0, hw: 0 };
const O_CORR: Obb = { x: 0, y: 0, c: 1, s: 0, hl: 0, hw: 0 };
/** Seconds a vehicle waits for another hull or a man who cannot move before planning round them. */
const YIELD_REPLAN_S = 3;
/** Small moves tried to get a hull clear of what it struck: speed (m/s) and yaw rate (rad/s), for ESCAPE_TICKS. */
const ESCAPES: readonly [number, number][] = [[-1.2, 0], [1.2, 0], [0, 0.5], [0, -0.5], [-1.2, 0.4], [-1.2, -0.4], [1.2, 0.4], [1.2, -0.4]];
const ESCAPE_TICKS = 30;

/**
 * The free small move (tested kinematically against houses, walls, water and other hulls over its half second)
 * that leaves the hull best placed for its way on: nearest the point it heads for, facing it. Undefined if none.
 */
function escapeMove(ctx: SimContext, state: SimState, vid: EntityId, def: VehicleDef, d: DriveState, x: number, y: number, h: number): DriveState["escape"] {
  const wp = d.route[Math.min(d.routeIdx, d.route.length - 1)];
  if (!wp) return undefined;
  const tracked = def.drive.steering.kind === "tracked";
  let best: DriveState["escape"], bestScore = Infinity;
  for (const [sp, w] of ESCAPES) {
    if (!tracked && sp === 0) continue;
    let px = x, py = y, ph = h, ok = true;
    for (let k = 1; k <= 5 && ok; k++) {
      const dt = ESCAPE_TICKS * DT / 5;
      ph = wrapAngle(ph + w * dt); px += cos(ph) * sp * dt; py += sin(ph) * sp * dt;
      if (hullTerrain(ctx, def, px, py, ph, HT).blocked) { ok = false; break; }
      hullObb(def, px, py, ph, 0, O_CORR);
      for (const [oid, o] of state.vehicle.entries()) {
        if (oid === vid) continue;
        const odef = ctx.catalog.vehicles[o.def], ot = state.transform.get(oid);
        if (!odef || !ot || Math.abs(ot.x - px) > 20 || Math.abs(ot.y - py) > 20) continue;
        if (obbOverlap(O_CORR, hullObb(odef, ot.x, ot.y, ot.heading, 0, O_OTHER))) { ok = false; break; }
      }
    }
    if (!ok) continue;
    const travel = wp.reverse === true ? ph + PI : ph;
    const score = hypot2(wp.x - px, wp.y - py) + 3 * Math.abs(wrapAngle(atan2(wp.y - py, wp.x - px) - travel));
    if (score < bestScore) { bestScore = score; best = { speed: sp, yawRate: w, untilTick: state.tick + ESCAPE_TICKS }; }
  }
  return best;
}
/** Seconds without 0.5 m of progress along the route before a re-plan (a pivot onto a detour takes a while); re-plans before giving up. */
const STUCK_S = 6, MAX_REPLANS = 3;
/** Width added on each side of the hull for the corridor ahead, m. */
const CORRIDOR_SIDE_M = 0.6;

/** Men on foot this tick (alive, not aboard), for the corridor and run-over scans: ID order. */
const MEN = { n: 0, id: new Int32Array(64), x: new Float64Array(64), y: new Float64Array(64) };
function fillMen(state: SimState): void {
  if (MEN.id.length < state.soldier.size) { const c = state.soldier.size * 2; MEN.id = new Int32Array(c); MEN.x = new Float64Array(c); MEN.y = new Float64Array(c); }
  let n = 0;
  // mounted: ok men aboard are skipped here
  for (const [sid, s] of state.soldier.entries()) {
    if (s.mount !== undefined || !s.physiology.alive) continue;
    const t = state.transform.get(sid);
    if (!t) continue;
    MEN.id[n] = sid; MEN.x[n] = t.x; MEN.y[n] = t.y; n++;
  }
  MEN.n = n;
}

export function vehicleDriveSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  if (state.vehicle.size === 0) return;
  fillMen(state);
  const wet = clamp(state.environment.rain, 0, 1);
  let replanned = false; // one re-plan per tick (ID order)
  for (const [vid, v] of state.vehicle.entries()) {
    const def = ctx.catalog.vehicles[v.def];
    if (!def) continue;
    const t = state.transform.req(vid);
    const d = v.drive;
    const fuel = fuelLitres(state, vid, def);
    const can = hasDriver(state, v, def) && fuel > 0 && (v.status === "ok" || v.status === "disarmed");
    if (d.crossing && state.tick >= d.crossing.untilTick) d.crossing = null;
    followRoute(ctx, def, d, t.x, t.y, t.heading);
    // Getting clear after the hull struck something: the escape move chosen then, for its half second.
    if (d.escape && state.tick < d.escape.untilTick && d.routeIdx < d.route.length) { CMD.speed = d.escape.speed; CMD.yawRate = d.escape.yawRate; CMD.curvature = d.escape.yawRate / Math.max(0.5, Math.abs(d.escape.speed)); }
    else if (d.escape) delete d.escape;
    // Men getting in or out (M7.2): it holds where it is; its route is kept for afterwards.
    if (!can || d.holdForDismount) { CMD.speed = 0; CMD.yawRate = 0; CMD.curvature = 0; }
    // Look ahead: other hulls and own men who cannot get out of the way stop it; men who can step aside.
    const hold = can && Math.abs(CMD.speed) > 0.05 ? corridor(ctx, state, vid, v, def, t.x, t.y, t.heading, CMD.speed) : null;
    if (hold !== null) {
      CMD.speed = 0; CMD.yawRate = 0; CMD.curvature = 0;
      if (d.yieldTo !== hold) { d.yieldTo = hold; d.yieldSinceTick = state.tick; }
      else if (!replanned && state.tick - d.yieldSinceTick >= secondsToTicks(YIELD_REPLAN_S)) {
        replanned = true;
        replan(ctx, state, vid, v, def, events, hold);
        d.yieldSinceTick = state.tick;
      }
    } else if (d.yieldTo !== null) d.yieldTo = null;
    const surf = driveSurface(ctx, def, t.x, t.y, t.heading, wet);
    const power = driveDynamicsInPlace(def, d, CMD, surf, DT, state.tick, driveFactors(v, def));
    // Integrate the pose, then check it against houses, walls, water and the other hulls.
    if (d.speed !== 0 || d.yawRate !== 0) {
      const nh = wrapAngle(t.heading + d.yawRate * DT);
      const nx = t.x + cos(nh) * d.speed * DT, ny = t.y + sin(nh) * d.speed * DT;
      let blocked = hullTerrain(ctx, def, nx, ny, nh, HT).blocked;
      if (!blocked) {
        hullObb(def, nx, ny, nh, 0, O_SELF);
        for (const [oid, o] of state.vehicle.entries()) {
          if (oid === vid) continue;
          const odef = ctx.catalog.vehicles[o.def], ot = state.transform.get(oid);
          if (!odef || !ot) continue;
          if (Math.abs(ot.x - nx) > 20 || Math.abs(ot.y - ny) > 20) continue;
          if (obbOverlap(O_SELF, hullObb(odef, ot.x, ot.y, ot.heading, 0, O_OTHER))) { blocked = true; break; }
        }
      }
      if (blocked) {
        // Corner guard: a hull that strikes something (a pivot swinging a corner into a house, a wall end) stops
        // and takes the best free small move (back off, creep, turn) for half a second, then goes on.
        d.trackL = 0; d.trackR = 0; d.speed = 0; d.yawRate = 0;
        d.stuckTicks++;
        const esc = escapeMove(ctx, state, vid, def, d, t.x, t.y, t.heading);
        const wp = d.route[d.routeIdx];
        if (esc && esc.speed < 0 && wp && wp.reverse !== true && Math.abs(wrapAngle(atan2(wp.y - t.y, wp.x - t.x) - t.heading)) > (2 * PI) / 3) {
          // No room to turn, and the way on lies behind: drive this leg in reverse (out of the tight spot).
          wp.reverse = true;
          delete d.escape;
        } else if (esc) d.escape = esc;
        else delete d.escape;
      } else {
        t.heading = nh; t.x = nx; t.y = ny;
        d.stuckTicks = 0;
        if (HT.crossObstacle >= 0) crossWall(ctx, state, vid, def, d, HT.crossObstacle, HT.crossPart, events);
        runOver(ctx, state, vid, v, def, t.x, t.y, t.heading, events);
      }
    }
    // Fuel: idle plus the work at the tracks through the drive train's efficiency; whole litres leave the tank.
    if (fuel > 0 && hasDriver(state, v, def)) {
      d.fuelAccL += ((def.drive.idleW + power / def.drive.efficiency) / 1000) * def.drive.litresPerKwh * DT / 3600;
      if (d.fuelAccL >= 1) { const l = Math.floor(d.fuelAccL); d.fuelAccL -= l; drawFuel(state, vid, def, l); }
    }
    // Stuck: no 0.5 m of progress in 3 s while it should be driving: plan again; after three, give up.
    // (Progress is the way still to go getting shorter: progressX holds the shortest so far, progressY unused.)
    const driving = can && !d.holdForDismount && !d.arrived && d.routeIdx < d.route.length && d.yieldTo === null;
    const togo = driving ? routeLeft(d, t.x, t.y) : 0;
    if (!driving || togo < d.progressX - 0.5) { d.progressX = togo; d.progressY = 0; d.progressTick = state.tick; }
    else if (!replanned && state.tick - d.progressTick >= secondsToTicks(STUCK_S)) {
      replanned = true;
      replan(ctx, state, vid, v, def, events, null);
      d.progressTick = state.tick;
    }
    // Arrival of the crew unit.
    if (d.arrived && v.unit !== null) {
      const u = state.unit.get(v.unit);
      if (u?.moving) {
        u.moving = false;
        events.emit({ kind: "unit.arrived", tick: state.tick, unit: v.unit });
        radioFromTarget(state, v.unit, "radio.arrived", events);
      }
    }
  }
}

/**
 * The corridor ahead of a moving hull (its stopping distance + 3 m, the hull's width + a margin): returns the
 * id of what it must wait for (another hull, or one of its own side's men who cannot move), else null. Able
 * men of either side in the corridor step aside (their evade); an enemy who does not is not waited for.
 */
function corridor(ctx: SimContext, state: SimState, vid: EntityId, v: VehicleState, def: VehicleDef, x: number, y: number, h: number, speed: number): EntityId | null {
  const dir = speed >= 0 ? 1 : -1;
  const o = hullObb(def, x, y, h, 0, O_SELF);
  const vAbs = Math.max(Math.abs(v.drive.speed), Math.abs(speed));
  const len = (vAbs * vAbs) / (2 * 0.6 * def.drive.brakeMps2) + 3;
  O_CORR.c = o.c; O_CORR.s = o.s; O_CORR.hl = len / 2; O_CORR.hw = o.hw + CORRIDOR_SIDE_M;
  O_CORR.x = o.x + o.c * dir * (o.hl + len / 2); O_CORR.y = o.y + o.s * dir * (o.hl + len / 2);
  const R = len + o.hl + o.hw + 2;
  // Other hulls: the one whose hull is in the other's corridor waits; if both are in each other's, the higher ID.
  for (const [oid, ov] of state.vehicle.entries()) {
    if (oid === vid) continue;
    const odef = ctx.catalog.vehicles[ov.def], ot = state.transform.get(oid);
    if (!odef || !ot || Math.abs(ot.x - x) > R + 10 || Math.abs(ot.y - y) > R + 10) continue;
    if (!obbOverlap(O_CORR, hullObb(odef, ot.x, ot.y, ot.heading, 0, O_OTHER))) continue;
    const otherWaits = ov.drive.yieldTo === vid && ov.drive.speed === 0;
    if (otherWaits && vid < oid) continue; // it waits for me
    return oid;
  }
  // Men on foot.
  let holdFor: EntityId | null = null;
  for (let q = 0; q < MEN.n; q++) {
    if (Math.abs(MEN.x[q]! - x) > R || Math.abs(MEN.y[q]! - y) > R) continue;
    const sid = MEN.id[q]!, s = state.soldier.req(sid), st = state.transform.req(sid);
    if (!pointInObb(O_CORR, st.x, st.y, 0.5) && !pointInObb(o, st.x, st.y, 0.5)) continue;
    const own = state.identity.get(sid)?.side === v.side;
    const canMove = isAble(s) && s.impair.canWalk && s.posture !== "prone" && !isCowering(s) && state.tick >= s.stunnedUntilTick && s.captive === null;
    if (canMove) {
      if (s.evade === null) {
        // Away from the hull's centre line, far enough to clear its side.
        const rx = st.x - o.x, ry = st.y - o.y;
        const lat = -rx * o.s + ry * o.c;
        const need = Math.max(0.5, o.hw + 1.2 - Math.abs(lat));
        const runMps = 3;
        const start = state.tick + 18;
        // He runs away from a point a metre beyond him on the hull's side (on its centre line: to its right).
        const side = lat >= 0 ? 1 : -1;
        s.evade = { x: st.x + o.s * side, y: st.y - o.c * side, startTick: start, untilTick: start + Math.ceil((need / runMps) * 60) + 1, run: true, ran: false, aside: true };
      }
      continue;
    }
    if (own && holdFor === null) holdFor = sid;
  }
  return holdFor;
}

/** Plan the rest of the route again from where the hull is (round `avoid`, a hull or a man, if given). */
function replan(ctx: SimContext, state: SimState, vid: EntityId, v: VehicleState, def: VehicleDef, events: EventSink, avoid: EntityId | null): void {
  const d = v.drive, t = state.transform.req(vid);
  const goal = d.route[d.route.length - 1];
  d.replans++;
  if (!goal || d.replans > MAX_REPLANS) { giveUp(state, v, events); return; }
  // The obstacle as a temporary blocked stamp on the class grid while searching.
  const extra: NavStamp[] = [];
  if (avoid !== null) {
    const ov = state.vehicle.get(avoid), at = state.transform.get(avoid);
    const odef = ov ? ctx.catalog.vehicles[ov.def] : undefined;
    if (ov && odef && at) { const o = hullObb(odef, at.x, at.y, at.heading); extra.push({ x: o.x, y: o.y, heading: at.heading, halfL: o.hl, halfW: o.hw }); }
    // (A man: a square wide enough that the hull's way round clears him by its corridor's margin.)
    else if (at) { const r = def.body.widthM / 2 + 1.5; extra.push({ x: at.x, y: at.y, heading: 0, halfL: r, halfW: r }); }
  }
  const route = planVehicleRoute(ctx, def.class, t.x, t.y, [goal], extra);
  if (!route) { giveUp(state, v, events); return; }
  d.route = route; d.routeIdx = 0; d.arrived = false;
  d.progressX = routeLeft(d, t.x, t.y); d.progressY = 0; d.progressTick = state.tick;
}

function giveUp(state: SimState, v: VehicleState, events: EventSink): void {
  const d = v.drive;
  d.route = []; d.routeIdx = 0; d.arrived = true; d.endHeading = null;
  if (v.unit === null) return;
  const u = state.unit.get(v.unit);
  if (u) u.moving = false;
  events.emit({ kind: "move.noRoute", tick: state.tick, target: v.unit });
  radioFromTarget(state, v.unit, "radio.noRoute", events);
}

/**
 * A route for a vehicle class through the given points (each leg keeps its point's pace and reverse flag),
 * on the class grid with clearance; `extra` hulls are blocked for this search only. null: no route.
 */
export function planVehicleRoute(ctx: SimContext, cls: "tracked" | "wheeled", x: number, y: number, wps: readonly Waypoint[], extra: readonly NavStamp[] = []): Waypoint[] | null {
  const { grid, search } = navFor(ctx, cls);
  // Hulls or men in the way: their cells, grown by the grid's clearance, are closed for this search only.
  let blocked: Set<number> | undefined;
  if (extra.length > 0) {
    blocked = new Set<number>();
    const m = grid.cellM, grow = (grid.clearanceCells + 0.5) * m;
    for (const st of extra) {
      const c = cos(st.heading), sn = sin(st.heading), R = st.halfL + st.halfW + grow;
      for (let r = Math.max(0, Math.floor((st.y - R) / m)); r <= Math.min(grid.rows - 1, Math.floor((st.y + R) / m)); r++) {
        for (let cc = Math.max(0, Math.floor((st.x - R) / m)); cc <= Math.min(grid.cols - 1, Math.floor((st.x + R) / m)); cc++) {
          const px = (cc + 0.5) * m - st.x, py = (r + 0.5) * m - st.y;
          if (Math.abs(px * c + py * sn) <= st.halfL + grow && Math.abs(-px * sn + py * c) <= st.halfW + grow) blocked.add(r * grid.cols + cc);
        }
      }
    }
    // (Not the cell the hull itself stands in: it must be able to start.)
    blocked.delete(Math.floor(y / m) * grid.cols + Math.floor(x / m));
  }
  // (It starts with where the hull is: the first leg has a line to follow too.)
  const out: Waypoint[] = wps.length > 0 ? [{ ...wps[0]!, x, y }] : [];
  let px = x, py = y;
  for (const w of wps) {
    // outdoor: ok (vehicles never enter buildings)
    const p = findPath(search, px, py, w.x, w.y, blocked ? { snapCells: 6, blocked, maxExpansions: 200000 } : { snapCells: 6 });
    if (!p) return null;
    for (let i = 0; i < p.points.length; i += 2) out.push({ ...w, x: p.points[i]!, y: p.points[i + 1]! });
    px = p.goalX; py = p.goalY;
  }
  return out.length > 1 ? out : null;
}

/**
 * The hull is on a wall it may cross: slow to the crossing speed; one that flattens (a fence, a hedge, wire)
 * leaves a gap as wide as the hull's track across it (a breach in the terrain damage: see-through and
 * shoot-through there, and open to every route).
 */
function crossWall(ctx: SimContext, state: SimState, vid: EntityId, def: VehicleDef, d: DriveState, obstacle: number, part: number, events: EventSink): void {
  const ob = ctx.map.obstacles.find((o) => o.id === obstacle);
  const kind = ob ? ctx.catalog.terrain.obstacles[ob.kind] : undefined;
  const vx = kind?.vehicle[def.class];
  if (!ob || !vx) return;
  const first = d.crossing === null || d.crossing.obstacle !== obstacle || d.crossing.part !== part;
  d.crossing = { obstacle, part, untilTick: state.tick + 30, capMps: vx.capKmh / 3.6 };
  if (!first) return;
  events.emit({ kind: "vehicle.crossed", tick: state.tick, vehicle: vid, obstacle });
  if (!vx.flattens) return;
  const i = part * 2;
  const ax = ob.points[i]!, ay = ob.points[i + 1]!, bx = ob.points[i + 2]!, by = ob.points[i + 3]!;
  const t = state.transform.req(vid);
  const ex = bx - ax, ey = by - ay, len = hypot2(ex, ey);
  if (len < 1e-6) return;
  // Where the hull's centre line crosses the segment, and the angle between them.
  const c = cos(t.heading), s = sin(t.heading);
  const denom = c * ey - s * ex;
  let u: number;
  if (Math.abs(denom) < 1e-9) u = clamp(((t.x - ax) * ex + (t.y - ay) * ey) / (len * len), 0, 1);
  else u = clamp(((t.y - ay) * c - (t.x - ax) * s) / denom, 0, 1);
  const off = u * len;
  const sinT = Math.abs(denom) / len;
  const widthM = Math.min(def.body.widthM / Math.max(sinT, 0.3), 3 * def.body.widthM);
  if (state.terrain.breaches.some((b) => b.owner === "obstacle" && b.id === obstacle && b.part === part && Math.abs(b.offsetM - off) < b.widthM / 2)) return;
  state.terrain.breaches.push({ owner: "obstacle", id: obstacle, part, offsetM: off, widthM, tick: state.tick });
  const px = ax + ex * u, py = ay + ey * u;
  events.emit({ kind: "terrain.breached", tick: state.tick, x: px, y: py, owner: "obstacle", id: obstacle });
  syncTerrainDamage(ctx, state, [px - widthM, py - widthM, px + widthM, py + widthM]);
}

/**
 * Owner decision (M7.1c, Q4): a vehicle does not stop or steer for enemy soldiers; an enemy the hull drives
 * over is crushed (a wound record). Its own side's men step aside or it waits for them (`corridor`).
 */
function runOver(ctx: SimContext, state: SimState, vid: EntityId, v: VehicleState, def: VehicleDef, x: number, y: number, h: number, events: EventSink): void {
  if (Math.abs(v.drive.speed) < 0.2) return;
  const o = hullObb(def, x, y, h, 0, O_SELF);
  const R = o.hl + o.hw;
  for (let q = 0; q < MEN.n; q++) {
    if (Math.abs(MEN.x[q]! - o.x) > R || Math.abs(MEN.y[q]! - o.y) > R) continue;
    const sid = MEN.id[q]!, s = state.soldier.req(sid), st = state.transform.req(sid);
    if (!s.physiology.alive || state.identity.get(sid)?.side === v.side) continue;
    // Under the hull, or just ahead of (or behind) it within its tracks' width: he goes under it.
    if (!pointInObb(o, st.x, st.y, 0.5)) continue;
    const lat = -(st.x - o.x) * o.s + (st.y - o.y) * o.c;
    if (Math.abs(lat) > o.hw) continue;
    // Once per pass (not again while he is still under the same hull).
    if (s.wounds.some((w) => w.mechanism === "crush" && w.source === vid && state.tick - w.tickInflicted < 180)) continue;
    events.emit({ kind: "vehicle.ranOver", tick: state.tick, vehicle: vid, soldier: sid });
    applyCrush(ctx, state, events, sid, vid);
  }
}

/** Men aboard move with their seats (after the drive); then the vehicle grid is rebuilt. */
export function vehicleSyncSystem(ctx: SimContext, state: SimState): void {
  if (state.vehicle.size === 0) { if (ctx.ballistics.vehicles.n > 0) rebuildVehicleGrid(ctx, state); return; }
  for (const [vid, v] of state.vehicle.entries()) {
    const def = ctx.catalog.vehicles[v.def];
    if (!def) continue;
    const t = state.transform.req(vid);
    for (let i = 0; i < v.seats.length; i++) {
      const sid = v.seats[i];
      if (sid === null || sid === undefined) continue;
      const mt = state.transform.get(sid);
      if (!mt) continue;
      const [x, y, z] = seatWorld(def, i, t.x, t.y, t.heading);
      mt.x = x; mt.y = y; mt.z = z; mt.heading = t.heading;
    }
  }
  rebuildVehicleGrid(ctx, state);
}

/** Result of an order to a vehicle: done, no route, unable, or unable with a radio key of its own. */
export type OrderResult = boolean | "unable" | { unable: string };

/**
 * Route a vehicle (crew unit order or a parent's move split to it): the points at the given pace (a foot pace
 * maps to the class's vehicle pace when driving), `reverse` legs as flagged, `facing` at the end.
 */
export function vehicleMove(ctx: SimContext, state: SimState, vid: EntityId, waypoints: readonly Waypoint[], facing: number | undefined): OrderResult {
  const v = state.vehicle.get(vid);
  const def = v ? ctx.catalog.vehicles[v.def] : undefined;
  if (!v || !def) return "unable";
  if (!hasDriver(state, v, def)) return { unable: "radio.noDriver" };
  if (v.status !== "ok" && v.status !== "disarmed") return { unable: "radio.immobilised" };
  const t = state.transform.req(vid);
  const route = planVehicleRoute(ctx, def.class, t.x, t.y, waypoints);
  if (!route) return false;
  const d = v.drive;
  d.route = route;
  d.routeIdx = 0;
  d.arrived = false;
  d.endHeading = facing ?? null;
  d.stuckTicks = 0; d.replans = 0; d.yieldTo = null;
  d.progressX = routeLeft(d, t.x, t.y); d.progressY = 0; d.progressTick = state.tick;
  if (v.unit !== null) { const unit = state.unit.get(v.unit); if (unit) { unit.moving = true; unit.moveTick = state.tick; } }
  return true;
}

/** Stop a vehicle where it is (brakes on). */
export function vehicleHalt(state: SimState, vid: EntityId): void {
  const v = state.vehicle.get(vid);
  if (!v) return;
  const d = v.drive;
  d.route = []; d.routeIdx = 0; d.arrived = true; d.endHeading = null; d.yieldTo = null;
  if (v.unit !== null) { const u = state.unit.get(v.unit); if (u) u.moving = false; }
}

/**
 * An order to a vehicle crew unit: `move` routes the vehicle on its class grid (per-leg reverse, end facing),
 * `halt` stops it. Other orders (fire, smoke, mount: M7.2/M7.3) are unable for now.
 */
/**
 * A move or halt order reaches a vehicle (owner 2026-11-13): it no longer drives back to where it stood before
 * reversing out, and it holds the order against close enemy men when the player gave it.
 */
export function noteVehicleOrder(state: SimState, vid: EntityId, order: Order): void {
  if (order.kind !== "move" && order.kind !== "halt") return;
  const v = state.vehicle.get(vid);
  if (!v) return;
  delete v.returnTo;
  if (order.player === true) v.playerHold = true; else delete v.playerHold;
}

export function vehicleOrder(ctx: SimContext, state: SimState, order: Order, vid: EntityId): OrderResult {
  noteVehicleOrder(state, vid, order);
  switch (order.kind) {
    case "move": {
      // A move given in reverse for the whole route reverses every leg.
      return vehicleMove(ctx, state, vid, order.waypoints, order.facing);
    }
    case "halt":
      vehicleHalt(state, vid);
      return true;
    // Gunnery (M7.3).
    case "fire":
      return stationFireOrder(ctx, state, vid, order, order.issuer);
    case "discharge":
      return dischargeSmoke(ctx, state, vid);
    default:
      return "unable";
  }
}
