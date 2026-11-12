/** Vehicles as roster assets (M7.1b): records in at force level, out at force level, fuel = in - burnt. */
import { describe, expect, it } from "vitest";
import { createSim, runBattle, type Controller } from "../src/index";
import { vehicleInput } from "./helpers";

describe("vehicle records in and out", () => {
  it("forcesOut returns the vehicle record with fuel = in - burnt", () => {
    const input = vehicleInput(1, 60);
    let sent = false;
    const ctrl: Controller = {
      side: "blue",
      think: (view, tick) => {
        if (sent) return [];
        sent = true;
        const uid = [...view.vehicle.values()][0]!.unit!;
        return [{ tick, issuer: "blue", target: uid, kind: "move", waypoints: [{ x: 500, y: 100, mode: "run" }] }];
      },
    };
    let burnt = 0;
    const r = runBattle(input, { controllers: [ctrl], onTick: (sim) => {
      const [, v] = [...sim.state.vehicle.entries()][0]!;
      burnt = 400 - (sim.state.container.req([...sim.state.vehicle.keys()][0]!).stacks.find((s) => s.type === "tank-fuel")!.charge ?? 0) + v.drive.fuelAccL;
    } });
    const out = r.forcesOut.find((f) => f.side === "blue")!.vehicles!;
    expect(out).toHaveLength(1);
    expect(out[0]!.vehicleId).toBe("v1");
    expect(out[0]!.type).toBe("tank");
    const fuel = out[0]!.load.find((s) => s.type === "tank-fuel")!;
    expect(burnt).toBeGreaterThan(1);
    expect(fuel.charge).toBe(400 - Math.floor(burnt));
    expect(out[0]!.status).toBe("ok");
    expect(r.sides.find((s) => s.side === "blue")!.vehicles).toEqual({ start: 1, ok: 1, immobilised: 0, disarmed: 0, abandoned: 0, destroyed: 0, captured: 0 });
    expect(r.sides.find((s) => s.side === "red")!.vehicles).toBeUndefined();
    expect(r.wrecks).toEqual([]);
    // The record goes into the next battle as it came out.
    const again = vehicleInput(2, 1);
    again.forces[0]!.vehicles = out;
    const sim = createSim(again);
    expect(sim.state.container.req([...sim.state.vehicle.keys()][0]!).stacks).toEqual(out[0]!.load);
  });

  it("a vehicle whose crew unit is gone (a parked hull) still comes out", () => {
    const input = vehicleInput(1, 2);
    input.forces[0]!.units = [];
    input.forces[0]!.placements = [];
    // (The blue side has no men: give it one on foot so the battle runs its course.)
    input.forces[0]!.units.push({ key: "x", callsign: "X", echelon: "team", leaderIndex: 0, subunits: [], members: [{ personId: "x.0", given: "A", family: "B", rank: "r", role: "x", skills: {}, fatigue: 0, stress: 0, wounds: [], load: [], status: "fit" }] });
    input.forces[0]!.placements.push({ personId: "x.0", x: 10, y: 10, heading: 0 });
    const r = runBattle(input);
    const out = r.forcesOut.find((f) => f.side === "blue")!.vehicles!;
    expect(out.map((v) => v.vehicleId)).toEqual(["v1"]);
    expect(out[0]!.load).toEqual([{ type: "tank-fuel", count: 1, charge: 400 }]); // no driver: nothing burnt
  });
});
