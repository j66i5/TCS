/**
 * Balance pass 6 (whole-game review 2026-11-24: "5 of 6 BMP-2 stalled short and never set support posts"): every
 * carrier of the AI commander's ride that lets its squad out has a reason on record (`rideStats`), a carrier whose
 * drive ended short of its dismount point is sent on again (the drill's `driveRetries`) before its squad gets out
 * where it stands ("stopped"), and the mounted-assault lab prints the carriers' table.
 */
import { describe, expect, it } from "vitest";
import { commanderController, rideStats } from "@tcs/ai";
import { createSim, step, submitOrder, type EntityId, type Order } from "@tcs/sim";
import { mountedAssaultBattle, mountedAssaultLabMarkdown } from "../src/labs/mounted-assault";
import { getScenario, loadData } from "../src/scenarios";

const data = loadData();

describe("carrier stall (balance pass 6)", () => {
  it("a carrier whose drive keeps ending short of its point is sent on twice, then its squad gets out with the reason 'stopped'", () => {
    const input = getScenario("platoon-vehicles").build(data, 1, 300);
    const retries = input.catalog.behaviour.mounting.mountedAssault!.driveRetries!;
    const sim = createSim(input);
    // (The defender has no commander and holds its fire: nothing but the jam gets the squad out.)
    const ctrls = [commanderController("blue", input)];
    for (const [id, u] of sim.state.unit.entries()) if (u.side === "red" && u.parent === null) submitOrder(sim, { tick: 0, issuer: "red", target: id, kind: "rules", fire: "hold" });
    let crew: EntityId | null = null, vid: EntityId | null = null, moves = 0;
    const moveOrders: Order[] = [];
    while (sim.state.tick < 200 * 60) {
      for (const c of ctrls) for (const o of c.think(sim.state, sim.state.tick)) {
        // The first carrier sent to a dismount point is the one that will keep giving up.
        if (crew === null && c.side === "blue" && o.kind === "move" && sim.state.unit.get(o.target)?.vehicle !== undefined
          && [...sim.state.unit.entries()].some(([, u]) => u.carrier === sim.state.unit.get(o.target)!.vehicle)) { crew = o.target; vid = sim.state.unit.get(o.target)!.vehicle!; }
        if (o.target === crew && o.kind === "move") { moves++; moveOrders.push(o); }
        submitOrder(sim, o);
      }
      step(sim);
      // Its drive ends where it stands, as after `move.noRoute` (while its squad is still aboard).
      if (vid !== null) {
        const v = sim.state.vehicle.req(vid);
        const aboard = [...sim.state.unit.entries()].some(([, u]) => u.carrier === vid && u.members.some((m) => sim.state.soldier.get(m)?.mount !== undefined));
        if (aboard && !v.drive.arrived) { v.drive.route = []; v.drive.routeIdx = 0; v.drive.arrived = true; }
        if (!aboard) break;
      }
    }
    expect(vid).not.toBeNull();
    const rs = rideStats(ctrls[0]!.saveState!())!;
    const mine = rs.out.find((o) => o.vehicle === vid)!;
    expect(mine).toBeDefined();
    expect(mine.why).toBe("stopped");
    expect(mine.retries).toBe(retries);
    expect(mine.pointM).toBeGreaterThan(15);
    // The first order and one for each time it was sent on; the second time to another point (half a slot aside).
    expect(moves).toBe(1 + retries);
    const wp = (o: Order) => (o.kind === "move" ? o.waypoints[0]! : { x: 0, y: 0 });
    expect(Math.hypot(wp(moveOrders[1]!).x - wp(moveOrders[0]!).x, wp(moveOrders[1]!).y - wp(moveOrders[0]!).y)).toBeLessThan(1);
    expect(Math.hypot(wp(moveOrders[2]!).x - wp(moveOrders[0]!).x, wp(moveOrders[2]!).y - wp(moveOrders[0]!).y)).toBeGreaterThan(10);
  }, 300_000);

  it("verification fix: the passengers of a halted hull whose radio is wrecked get out on their own (off the net, no order reaches them); the crew stays", () => {
    const run = (on: boolean) => {
      const input = getScenario("platoon-ru-vehicles").build(data, 1, 120);
      if (!on) input.catalog = { ...input.catalog, behaviour: { ...input.catalog.behaviour, mounting: { ...input.catalog.behaviour.mounting, radioOutDismount: false } } };
      const sim = createSim(input);
      // A carrier with a squad aboard, halted at the start; nobody commands either side.
      const vid = [...sim.state.unit.entries()].find(([, u]) => u.side === "red" && u.carrier !== undefined)![1].carrier!;
      const v = sim.state.vehicle.req(vid), def = input.catalog.vehicles[v.def]!;
      const riders = () => v.seats.filter((m, k) => m !== null && def.seats[k]!.station === "passenger").length;
      const crew = () => v.seats.filter((m, k) => m !== null && def.seats[k]!.station !== "passenger").length;
      const before = { riders: riders(), crew: crew() };
      expect(before.riders).toBeGreaterThan(0);
      v.comp[def.components!.findIndex((c) => c.kind === "radio")] = 0;
      const keys: string[] = [];
      let rejected = 0;
      for (let i = 0; i < 60 * 60; i++) {
        // (An order to its squad is lost: the squad is off the net while it is aboard.)
        if (i === 30) for (const [id, u] of sim.state.unit.entries()) if (u.carrier === vid && u.vehicle === undefined) submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: id, kind: "halt" });
        for (const e of step(sim)) {
          if (e.kind === "radio") keys.push(e.key);
          if (e.kind === "order.rejected" && e.reason === "no-comms") rejected++;
        }
      }
      return { before, riders: riders(), crew: crew(), keys, rejected, status: v.status };
    };
    const on = run(true);
    expect(on.riders).toBe(0);
    expect(on.crew).toBe(on.before.crew);
    expect(on.keys).toContain("radio.dismounted");
    expect(on.rejected).toBeGreaterThan(0);
    expect(on.status).toBe("ok");
    // (Without the rule they sit there for good, as before.)
    const off = run(false);
    expect(off.riders).toBe(off.before.riders);
    expect(off.keys).not.toContain("radio.dismounted");
  });
  it("the lab's AI rows: every carrier out has a reason, 'point' means within the arrival distance, and the table is printed", () => {
    const r = mountedAssaultBattle(data, "platoon-ru-vehicles", "ai", 1, 360);
    const arriveM = getScenario("platoon-ru-vehicles").build(data, 1, 60).catalog.behaviour.mounting.mountedAssault!.arriveM;
    expect(r.started).toBeGreaterThanOrEqual(r.carriers);
    expect(r.carriers).toBeGreaterThan(0);
    const reasons = Object.values(r.reasons).reduce((a, b) => a + b, 0);
    expect(reasons).toBe(r.pointM.length);
    expect(reasons).toBeGreaterThanOrEqual(r.carriers - 1); // (the headquarters' hull may share a carrier's line)
    expect(r.postTally).not.toBeNull();
    expect(r.postTally!.reached + r.postTally!.failed).toBeLessThanOrEqual(r.postTally!.ordered);
    // (A carrier hit or threatened as it rolls onto its point has that reason, so "point" is the lower count.)
    expect(r.pointM.filter((m) => m <= arriveM).length).toBeGreaterThanOrEqual(r.reasons["point"] ?? 0);
    expect(r.reasons["point"] ?? 0).toBeGreaterThan(0);
    const md = mountedAssaultLabMarkdown([r]);
    expect(md).toContain("Out short, with reason");
    console.log(md.split("\n").slice(-4).join("\n"));
  }, 300_000);
});
