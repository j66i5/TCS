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
 * M7.1b: routes are straight legs; collisions with buildings, walls, hulls and men come in M7.1c.
 */
import type { SurfaceVehicleDef, VehicleDef } from "../catalog";
import type { DriveState } from "../components";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { DT, secondsToTicks, type EntityId } from "../ids";
import { addItems, removeItems } from "../items";
import { atan, atan2, clamp, cos, hypot2, PI, sin, sqrt, tan, wrapAngle } from "../math";
import { hasDriver } from "../mount";
import type { SimState } from "../state";
import type { Order } from "../orders";
import { clearLine } from "../nav";
import { navFor } from "../navctx";
import { cellIndex, heightAt } from "../terrain";
import { radioFromTarget } from "./orders";
import { seatWorld } from "../setup";

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

/** Ground under a hull at (x, y) on a level of wetness 0..1; null fields when no vehicle may drive there. */
export function driveSurface(ctx: SimContext, def: VehicleDef, x: number, y: number, heading: number, wet: number): DriveSurface {
  const map = ctx.map;
  const cell = cellIndex(map, x, y);
  const sid = cell < 0 ? undefined : map.surfacePalette[map.surface[cell]!];
  const sv: SurfaceVehicleDef | undefined = sid === undefined ? undefined : ctx.catalog.terrain.surfaces[sid]?.vehicle;
  const half = def.body.lengthM / 2;
  const c = cos(heading), s = sin(heading);
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

/** Wanted body speed and yaw rate from the route (pure pursuit). Writes CMD. */
const CMD: DriveCmd = { speed: 0, yawRate: 0, curvature: 0 };
function follow(ctx: SimContext, def: VehicleDef, d: DriveState, x: number, y: number, h: number): void {
  CMD.speed = 0; CMD.yawRate = 0; CMD.curvature = 0;
  const steering = def.drive.steering;
  const maxW = steering.kind === "tracked" ? steering.pivotRateRadS : 1;
  if (d.arrived || d.routeIdx >= d.route.length) {
    // At the end: turn to the ordered facing (tracked: on the spot), then hold.
    if (!d.arrived && d.endHeading !== null && steering.kind === "tracked" && Math.abs(d.speed) < 0.3) {
      const e = wrapAngle(d.endHeading - h);
      if (Math.abs(e) > (3 * PI) / 180) { CMD.yawRate = clamp(PIVOT_GAIN * e, -maxW, maxW); return; }
    }
    return;
  }
  const last = d.routeIdx === d.route.length - 1;
  let wp = d.route[d.routeIdx]!;
  const L = clamp(4 + 0.8 * Math.abs(d.speed), 4, 20);
  // Next waypoint once within reach of this one (not the last).
  if (!last && hypot2(wp.x - x, wp.y - y) < Math.max(3, L * 0.5)) { d.routeIdx++; wp = d.route[d.routeIdx]!; }
  const reverse = wp.reverse === true;
  const tx = wp.x - x, ty = wp.y - y;
  const dist = hypot2(tx, ty);
  const travel = reverse ? h + PI : h;
  const e = wrapAngle(atan2(ty, tx) - travel);
  // Last leg: stop on (or once past) the point.
  const isLast = d.routeIdx === d.route.length - 1;
  const passed = isLast && (tx * cos(travel) + ty * sin(travel)) < 0 && dist < 6;
  if (isLast && (dist < 1.5 || passed)) {
    if (Math.abs(d.speed) < 0.3) { d.routeIdx = d.route.length; if (d.endHeading === null || steering.kind !== "tracked") d.arrived = true; }
    return;
  }
  const pace = paceSpeed(ctx, def, wp.mode, reverse);
  const brake = def.drive.brakeMps2;
  const left = routeLeft(d, x, y);
  let v = Math.min(Math.abs(pace), sqrt(2 * 0.6 * brake * left));
  if (steering.kind === "tracked") {
    const pivoting = Math.abs(e) > PI / 3 || (Math.abs(e) > PI / 18 && Math.abs(d.speed) < 0.3 && Math.abs(d.yawRate) > 0.05);
    if (pivoting && steering.pivot) { CMD.speed = 0; CMD.yawRate = clamp(PIVOT_GAIN * e, -maxW, maxW); return; }
    const kappa = (2 * sin(e)) / L;
    if (Math.abs(kappa) > 1e-6) v = Math.min(v, sqrt(steering.maxLatAccelMps2 / Math.abs(kappa)));
    v = Math.max(v, 0.5);
    CMD.speed = reverse ? -v : v;
    CMD.yawRate = clamp(kappa * Math.max(Math.abs(d.speed), 1.5), -maxW, maxW);
  } else {
    const kappa = (2 * sin(e)) / L;
    if (Math.abs(kappa) > 1e-6) v = Math.min(v, sqrt(steering.maxLatAccelMps2 / Math.abs(kappa)));
    v = Math.max(v, 0.5);
    CMD.speed = reverse ? -v : v;
    // Reversing, the heading turns the other way for the same wheel angle.
    CMD.curvature = reverse ? -kappa : kappa;
  }
}

export function vehicleDriveSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  if (state.vehicle.size === 0) return;
  const wet = clamp(state.environment.rain, 0, 1);
  for (const [vid, v] of state.vehicle.entries()) {
    const def = ctx.catalog.vehicles[v.def];
    if (!def) continue;
    const t = state.transform.req(vid);
    const d = v.drive;
    const fuel = fuelLitres(state, vid, def);
    const can = hasDriver(state, v, def) && fuel > 0 && (v.status === "ok" || v.status === "disarmed");
    follow(ctx, def, d, t.x, t.y, t.heading);
    if (!can) { CMD.speed = 0; CMD.yawRate = 0; CMD.curvature = 0; }
    const surf = driveSurface(ctx, def, t.x, t.y, t.heading, wet);
    const power = driveDynamicsInPlace(def, d, CMD, surf, DT, state.tick);
    // Integrate the pose (collisions come in M7.1c).
    t.heading = wrapAngle(t.heading + d.yawRate * DT);
    t.x = clamp(t.x + cos(t.heading) * d.speed * DT, 0, ctx.map.widthM - 0.01);
    t.y = clamp(t.y + sin(t.heading) * d.speed * DT, 0, ctx.map.heightM - 0.01);
    // Fuel: idle plus the work at the tracks through the drive train's efficiency; whole litres leave the tank.
    if (fuel > 0 && hasDriver(state, v, def)) {
      d.fuelAccL += ((def.drive.idleW + power / def.drive.efficiency) / 1000) * def.drive.litresPerKwh * DT / 3600;
      if (d.fuelAccL >= 1) { const l = Math.floor(d.fuelAccL); d.fuelAccL -= l; drawFuel(state, vid, def, l); }
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

/** Men aboard move with their seats (after the drive). */
export function vehicleSyncSystem(ctx: SimContext, state: SimState): void {
  if (state.vehicle.size === 0) return;
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
}

/**
 * An order to a vehicle crew unit (M7.1b): `move` sets the vehicle's route (straight legs; a leg through a
 * building or deep water means no route; full navigation comes in M7.1c), `halt` clears it. Other orders: unable.
 */
export function vehicleOrder(ctx: SimContext, state: SimState, order: Order, vid: EntityId): boolean | "unable" {
  const v = state.vehicle.get(vid);
  const def = v ? ctx.catalog.vehicles[v.def] : undefined;
  if (!v || !def) return "unable";
  const unit = state.unit.req(order.target);
  const d = v.drive;
  switch (order.kind) {
    case "move": {
      if (!hasDriver(state, v, def)) return "unable";
      const t = state.transform.req(vid);
      const grid = navFor(ctx, "foot").grid;
      let px = t.x, py = t.y;
      for (const w of order.waypoints) {
        if (!clearLine(grid, px, py, w.x, w.y)) return false;
        px = w.x; py = w.y;
      }
      d.route = order.waypoints.map((w) => ({ ...w }));
      d.routeIdx = 0;
      d.arrived = false;
      d.endHeading = order.facing ?? null;
      d.stuckTicks = 0; d.replans = 0;
      d.progressX = t.x; d.progressY = t.y; d.progressTick = state.tick;
      unit.moving = true;
      unit.moveTick = state.tick;
      return true;
    }
    case "halt":
      d.route = []; d.routeIdx = 0; d.arrived = true; d.endHeading = null;
      unit.moving = false;
      return true;
    default:
      return "unable";
  }
}
