/** Vehicle drive (M7.1b): the pure dynamics core, move/halt orders to a crew unit, seats, fuel. */
import { describe, expect, it } from "vitest";
import {
  createSim, idleDrive, step, stepDriveDynamics, submitOrder, type DriveSurface, type SimEvent,
} from "../src/index";
import { testCatalog, testInput, vehicleInput } from "./helpers";

const tank = testCatalog.vehicles["tank"]!;
const flat: DriveSurface = { rolling: 0.03, traction: 0.8, lateral: 0.7, capMps: Infinity, sinPitch: 0, cosPitch: 1 };

describe("drive dynamics (pure core)", () => {
  it("stepDriveDynamics is pure: the input is unchanged and the same input gives the same output", () => {
    const d0 = idleDrive(0, 0);
    const before = JSON.stringify(d0);
    const a = stepDriveDynamics(tank, d0, { speed: 10, yawRate: 0.2 }, flat, 1 / 60, 5);
    const b = stepDriveDynamics(tank, d0, { speed: 10, yawRate: 0.2 }, flat, 1 / 60, 5);
    expect(JSON.stringify(d0)).toBe(before);
    expect(a).toEqual(b);
    expect(a.drive).not.toBe(d0);
  });

  it("accelerates, holds the commanded speed, and a weak left track pulls the hull to the left", () => {
    let d = idleDrive(0, 0);
    let heading = 0;
    for (let i = 0; i < 60 * 30; i++) {
      d = stepDriveDynamics(tank, d, { speed: 8, yawRate: 0 }, flat, 1 / 60, i, { engine: 1, trackL: 0.3, trackR: 1 }).drive;
      heading += d.yawRate / 60;
    }
    expect(d.speed).toBeGreaterThan(4);
    expect(heading).toBeLessThan(-0.05); // negative = anticlockwise on screen = to the left
  });

  it("pivots on the spot (no forward speed) when asked for a yaw rate alone", () => {
    let d = idleDrive(0, 0);
    for (let i = 0; i < 120; i++) d = stepDriveDynamics(tank, d, { speed: 0, yawRate: 0.6 }, flat, 1 / 60, i).drive;
    expect(Math.abs(d.speed)).toBeLessThan(0.05);
    expect(d.yawRate).toBeGreaterThan(0.4);
    expect(d.trackL).toBeCloseTo(-d.trackR, 6);
  });
});

describe("vehicle orders and the drive system", () => {
  it("sets up the vehicle with its crew seated in station order (commander, gunner, driver)", () => {
    const sim = createSim(vehicleInput());
    const [vid, v] = [...sim.state.vehicle.entries()][0]!;
    const unit = sim.state.unit.req(v.unit!);
    expect(unit.vehicle).toBe(vid);
    expect(v.seats.slice(0, 3)).toEqual(unit.members);
    expect(v.seats.slice(3)).toEqual([null, null]);
    unit.members.forEach((m, i) => expect(sim.state.soldier.req(m).mount).toEqual({ vehicle: vid, seat: i }));
    // (No identity, mover, soldier or weapon of its own: every soldier loop ignores the hull.)
    expect(sim.state.identity.has(vid) || sim.state.mover.has(vid) || sim.state.soldier.has(vid) || sim.state.weapon.has(vid)).toBe(false);
  });

  it("a move order to the crew unit drives the vehicle there; the crew ride along; fuel is burnt; it arrives", () => {
    const sim = createSim(vehicleInput(1, 300));
    const [vid, v] = [...sim.state.vehicle.entries()][0]!;
    const uid = v.unit!;
    submitOrder(sim, { tick: 0, issuer: "blue", target: uid, kind: "move", waypoints: [{ x: 300, y: 60, mode: "run" }, { x: 450, y: 100, mode: "drive-slow" }] });
    const events: SimEvent[] = [];
    for (let i = 0; i < 60 * 120 && !events.some((e) => e.kind === "unit.arrived"); i++) events.push(...step(sim));
    const t = sim.state.transform.req(vid);
    expect(Math.hypot(t.x - 450, t.y - 100)).toBeLessThan(6);
    expect(events.find((e) => e.kind === "radio" && e.key === "radio.ack.move")).toBeDefined();
    expect(events.find((e) => e.kind === "radio" && e.key === "radio.arrived")).toBeDefined();
    expect(sim.state.unit.req(uid).moving).toBe(false);
    const drv = sim.state.transform.req(v.seats[2]!);
    expect(Math.hypot(drv.x - t.x, drv.y - t.y)).toBeLessThan(3);
    const tankLeft = sim.state.container.req(vid).stacks.find((s) => s.type === "tank-fuel")!;
    expect(tankLeft.charge).toBeLessThan(400);
    expect(tankLeft.charge).toBeGreaterThan(395);
  });

  it("halt brings it to a stop; with the driver dead a move order is unable", () => {
    const sim = createSim(vehicleInput());
    const [vid, v] = [...sim.state.vehicle.entries()][0]!;
    submitOrder(sim, { tick: 0, issuer: "blue", target: v.unit!, kind: "move", waypoints: [{ x: 550, y: 100, mode: "run" }] });
    for (let i = 0; i < 600; i++) step(sim);
    expect(v.drive.speed).toBeGreaterThan(3);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: v.unit!, kind: "halt" });
    for (let i = 0; i < 600; i++) step(sim);
    expect(sim.state.vehicle.req(vid).drive.speed).toBe(0);

    const input = vehicleInput();
    input.forces[0]!.units[0]!.members[2]!.status = "killed"; // the third man takes the driver's seat
    const s2 = createSim(input);
    const [vid2, v2] = [...s2.state.vehicle.entries()][0]!;
    submitOrder(s2, { tick: 0, issuer: "blue", target: v2.unit!, kind: "move", waypoints: [{ x: 550, y: 100, mode: "run" }] });
    const ev: SimEvent[] = [];
    for (let i = 0; i < 600; i++) ev.push(...step(s2));
    expect(ev.find((e) => e.kind === "radio" && e.key === "radio.unable")).toBeDefined();
    expect(s2.state.transform.req(vid2).x).toBe(50);
  });

  it("vehicle paces are for vehicle crews only; reverse legs only for vehicles", () => {
    const sim = createSim(vehicleInput());
    const crew = [...sim.state.vehicle.values()][0]!.unit!;
    const foot = [...sim.state.unit.entries()].find(([, u]) => u.side === "red")![0];
    const rejected = (target: number, mode: string, reverse?: true) => {
      const ev = (() => { submitOrder(sim, { tick: sim.state.tick, issuer: sim.state.unit.req(target).side, target, kind: "move", waypoints: [{ x: 100, y: 100, mode, ...(reverse ? { reverse } : {}) }] }); return step(sim); })();
      return ev.some((e) => e.kind === "order.rejected");
    };
    expect(rejected(foot, "drive")).toBe(true);
    expect(rejected(foot, "walk", true)).toBe(true);
    expect(rejected(crew, "drive")).toBe(false);
    expect(rejected(crew, "walk", true)).toBe(false);
  });

  it("a battle without vehicles has an empty vehicle store and no vehicle results", () => {
    const sim = createSim(testInput());
    expect(sim.state.vehicle.size).toBe(0);
  });
});
