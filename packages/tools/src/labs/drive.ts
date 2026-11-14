/**
 * DRIVE LAB (SPEC 6.7, M7.1b): one vehicle on a strip of ground, driven only by orders to its crew unit
 * (move, halt) from a scripted controller, measured from the state. Acceleration, top speed, braking, pivot,
 * reverse, ground and rain, a slope, and no driver. The test asserts the bands of docs/plans/m7-vehicles.md §4.
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import { buildForce } from "@tcs/scenario";
import {
  createSim, DEFAULT_COMMS, flatMap, idleDrive, stepDriveDynamics, newVehicleRecord, step, submitOrder, ticksToSeconds, wrapAngle,
  type BattleInput, type EntityId, type MapDef, type Sim, type Waypoint,
} from "@tcs/sim";

export interface DriveRow { vehicle: string; case: string; value: number; unit: string }

const CREW: Record<string, { faction: string; template: string }> = {
  "de-puma": { faction: "de", template: "puma-besatzung" },
  "ru-bmp2": { faction: "ru", template: "bmp2-ekipazh" },
  "xf-cart": { faction: "xf", template: "cart-crew" },
  "de-boxer-san": { faction: "de", template: "boxer-san-besatzung" },
  "ru-bmm": { faction: "ru", template: "bmm-ekipazh" },
};

interface Ground { surface?: string; grade?: number; rain?: number }

function strip(g: Ground): MapDef {
  const m = flatMap("drive-lab", 3000, 400, 4, g.surface ?? "asphalt");
  if (g.grade) for (let r = 0; r <= m.rows; r++) for (let c = 0; c <= m.cols; c++) m.heights[r * (m.cols + 1) + c] = 50 + c * m.cellSizeM * g.grade;
  return m;
}

/** One vehicle with its crew on a strip, facing east at x = 300. `noDriver`: the driver comes in killed. */
export function driveBattle(data: DataSet, type: string, g: Ground, opts: { noDriver?: boolean; x?: number } = {}): { sim: Sim; vid: EntityId; unit: EntityId; input: BattleInput } {
  const crew = CREW[type];
  if (!crew) throw new Error(`no crew template for '${type}'`);
  const catalog = buildCatalog(data, [crew.faction]);
  const u = buildForce(data, { faction: crew.faction, template: crew.template, seed: 1, keyPrefix: "lab" });
  u.vehicleId = "v1";
  if (opts.noDriver) {
    const def = catalog.vehicles[type]!;
    const tmpl = data.factions[crew.faction]!.units[crew.template]!;
    const d = tmpl.members.findIndex((m) => def.seats.find((s) => s.id === m.seat)?.station === "driver");
    if (d >= 0) u.members[d]!.status = "killed";
  }
  const input: BattleInput = {
    map: strip(g), catalog, seed: 1, orders: [],
    environment: { timeOfDaySeconds: 12 * 3600, light: 1, windX: 0, windY: 0, rain: g.rain ?? 0, visibilityM: 5000, temperatureC: 15 },
    rules: { timeLimitSeconds: 3600, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "none", physiologyParams: {}, objectives: [] },
    forces: [{
      side: "blue", faction: crew.faction, units: [u], placements: [],
      vehicles: [newVehicleRecord(catalog, type, "v1")], vehiclePlacements: [{ vehicleId: "v1", x: opts.x ?? 300, y: 200, heading: 0 }],
    }],
  };
  const sim = createSim(input);
  const vid = [...sim.state.vehicle.keys()][0]!;
  const unit = sim.state.vehicle.req(vid).unit!;
  return { sim, vid, unit, input };
}

/** The scripted controller: one order to the crew unit at the current tick. */
function order(sim: Sim, unit: EntityId, body: { kind: "move"; waypoints: Waypoint[]; facing?: number } | { kind: "halt" }): void {
  // Wheeled hulls take the wheeled paces (the same share of their own top speed).
  const wheeled = sim.ctx.catalog.vehicles[sim.state.vehicle.req([...sim.state.vehicle.keys()][0]!).def]?.class === "wheeled";
  if (wheeled && body.kind === "move") body = { ...body, waypoints: body.waypoints.map((w) => ({ ...w, mode: "w" + w.mode })) };
  submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: unit, ...body });
}

const speed = (sim: Sim, vid: EntityId) => sim.state.vehicle.req(vid).drive.speed;

/** Seconds from the order to reaching `kmh`, or Infinity. */
function accelTime(data: DataSet, type: string, kmh: number, g: Ground = {}): number {
  const { sim, vid, unit } = driveBattle(data, type, g);
  order(sim, unit, { kind: "move", waypoints: [{ x: 2900, y: 200, mode: "drive-fast" }] });
  const t0 = sim.state.tick;
  for (let i = 0; i < 60 * 120; i++) { step(sim); if (speed(sim, vid) >= kmh / 3.6) return ticksToSeconds(sim.state.tick - t0); }
  return Infinity;
}

/** Highest speed over a long run, km/h (signed waypoints for reverse). */
function topSpeed(data: DataSet, type: string, reverse: boolean, g: Ground = {}): number {
  const { sim, vid, unit } = driveBattle(data, type, g, { x: reverse ? 2700 : 300 });
  const wp: Waypoint = reverse ? { x: 300, y: 200, mode: "drive-fast", reverse: true } : { x: 2900, y: 200, mode: "drive-fast" };
  order(sim, unit, { kind: "move", waypoints: [wp] });
  let best = 0;
  for (let i = 0; i < 60 * 150; i++) { step(sim); best = Math.max(best, Math.abs(speed(sim, vid))); }
  return best * 3.6;
}

/** Braking distance from `kmh` after a halt order, m. */
function braking(data: DataSet, type: string, kmh: number): number {
  const { sim, vid, unit } = driveBattle(data, type, {});
  order(sim, unit, { kind: "move", waypoints: [{ x: 2900, y: 200, mode: "drive-fast" }] });
  for (let i = 0; i < 60 * 120 && speed(sim, vid) < kmh / 3.6; i++) step(sim);
  const x0 = sim.state.transform.req(vid).x;
  order(sim, unit, { kind: "halt" });
  for (let i = 0; i < 60 * 30 && speed(sim, vid) > 0.05; i++) step(sim);
  return sim.state.transform.req(vid).x - x0;
}

/** Seconds to turn 90 degrees on the spot (to within 3 degrees). */
function pivot90(data: DataSet, type: string): number {
  const { sim, vid, unit } = driveBattle(data, type, {});
  order(sim, unit, { kind: "move", waypoints: [{ x: 300, y: 380, mode: "drive-slow" }] });
  const t0 = sim.state.tick;
  for (let i = 0; i < 60 * 20; i++) {
    step(sim);
    if (Math.abs(wrapAngle(sim.state.transform.req(vid).heading - Math.PI / 2)) < (3 * Math.PI) / 180) return ticksToSeconds(sim.state.tick - t0);
  }
  return Infinity;
}

/** Seconds to cover 300 m from a standstill. */
function run300(data: DataSet, type: string, g: Ground): number {
  const { sim, vid, unit } = driveBattle(data, type, g);
  order(sim, unit, { kind: "move", waypoints: [{ x: 2900, y: 200, mode: "drive-fast" }] });
  const t0 = sim.state.tick;
  for (let i = 0; i < 60 * 300; i++) { step(sim); if (sim.state.transform.req(vid).x >= 600) return ticksToSeconds(sim.state.tick - t0); }
  return Infinity;
}

/** Metres moved in 30 s after a move order with the driver dead. */
function noDriver(data: DataSet, type: string): number {
  const { sim, vid, unit } = driveBattle(data, type, {}, { noDriver: true });
  order(sim, unit, { kind: "move", waypoints: [{ x: 2900, y: 200, mode: "drive-fast" }] });
  for (let i = 0; i < 60 * 30; i++) step(sim);
  return Math.abs(sim.state.transform.req(vid).x - 300);
}

/** Litres burnt in a 1000 m run at full pace. */
function fuelRun(data: DataSet, type: string): number {
  const { sim, vid, unit, input } = driveBattle(data, type, {});
  const def = input.catalog.vehicles[type]!;
  const litres = () => sim.state.container.req(vid).stacks.filter((s) => s.type === def.fuel.item).reduce((n, s) => n + (s.charge ?? 0) * s.count, 0);
  const l0 = litres();
  order(sim, unit, { kind: "move", waypoints: [{ x: 1300, y: 200, mode: "drive-fast" }] });
  step(sim);
  for (let i = 0; i < 60 * 120 && !sim.state.vehicle.req(vid).drive.arrived; i++) step(sim);
  return l0 - litres() + sim.state.vehicle.req(vid).drive.fuelAccL;
}

/** Turning circle (diameter, m) at full lock and 3 m/s on dry asphalt-like ground (wheeled hulls; pure dynamics). */
function turningCircle(data: DataSet, type: string): number {
  const def = buildCatalog(data, [CREW[type]!.faction]).vehicles[type]!;
  const surf = { rolling: 0.03, traction: 0.8, lateral: 0.7, capMps: Infinity, sinPitch: 0, cosPitch: 1 };
  let d = idleDrive(0, 0), x = 0, h = 0, minX = 0, maxX = 0;
  for (let i = 0; i < 60 * 60; i++) {
    d = stepDriveDynamics(def, d, { speed: 3, yawRate: 0, curvature: 10 }, surf, 1 / 60, i).drive;
    h += d.yawRate / 60; x += (Math.cos(h) * d.speed) / 60;
    if (i > 60 * 15) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
  }
  return maxX - minX;
}

export const WHEELED = ["de-boxer-san", "ru-bmm"] as const;

export const SURFACES = ["asphalt", "grass", "ploughed", "mud"] as const;

export function driveLab(data: DataSet): DriveRow[] {
  const rows: DriveRow[] = [];
  const add = (vehicle: string, c: string, value: number, unit: string) => rows.push({ vehicle, case: c, value, unit });
  for (const type of ["de-puma", "ru-bmp2", ...WHEELED]) {
    const wheeled = (WHEELED as readonly string[]).includes(type);
    add(type, "0-50 km/h on asphalt", accelTime(data, type, 50), "s");
    add(type, "top speed", topSpeed(data, type, false), "km/h");
    add(type, "reverse top speed", topSpeed(data, type, true), "km/h");
    add(type, "braking from 50 km/h", braking(data, type, 50), "m");
    add(type, "braking from 70 km/h", type === "de-puma" ? braking(data, type, 70) : NaN, "m");
    if (wheeled) {
      add(type, "turn 90 deg from a standstill", pivot90(data, type), "s");
      add(type, "turning circle (diameter)", turningCircle(data, type), "m");
    } else add(type, "pivot 90 deg", pivot90(data, type), "s");
    for (const s of SURFACES) {
      add(type, `300 m on ${s}, dry`, run300(data, type, { surface: s }), "s");
      add(type, `300 m on ${s}, rain`, run300(data, type, { surface: s, rain: 1 }), "s");
    }
    add(type, "top speed up a 20 % slope", topSpeed(data, type, false, { surface: "grass", grade: 0.2 }), "km/h");
    add(type, "fuel for 1000 m at full pace", fuelRun(data, type), "L");
    add(type, "moved in 30 s with the driver dead", noDriver(data, type), "m");
  }
  return rows;
}

export function driveLabMarkdown(rows: DriveRow[]): string {
  const f = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : "-");
  return ["| vehicle | case | value |", "|---|---|---|", ...rows.map((r) => `| ${r.vehicle} | ${r.case} | ${f(r.value)} ${r.unit} |`)].join("\n");
}
