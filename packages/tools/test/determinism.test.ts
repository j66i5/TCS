/**
 * DETERMINISM (SPEC 4.3 rule 1, SPEC 5.2): same initial state + same seed + same order stream
 * => bit-identical state, checked by hash at intervals; also from a mid-battle save.
 */
import { describe, expect, it } from "vitest";
import {
  continueBattle, createSim, hashState, loadGame, loadSim, runBattle, saveGame, saveSim, secondsToTicks, simHash, step,
  submitOrder, type Order,
} from "@tcs/sim";
import { getScenario, loadData } from "../src/scenarios";
import { driveBattle } from "../src/labs/drive";

const data = loadData();
const sc = getScenario("demo");

function hashesEvery(seed: number, seconds: number, everyS: number) {
  const input = sc.build(data, seed, seconds);
  const hashes: string[] = [];
  const result = runBattle(input, {
    controllers: sc.controllers!(input),
    onTick: (sim) => { if (sim.state.tick % secondsToTicks(everyS) === 0) hashes.push(simHash(sim)); },
  });
  return { hashes, result };
}

describe("determinism", () => {
  it("two runs with the same seed and orders give identical hashes at every checkpoint", () => {
    const a = hashesEvery(11, 180, 5);
    const b = hashesEvery(11, 180, 5);
    expect(a.hashes.length).toBe(36);
    expect(b.hashes).toEqual(a.hashes);
    expect(b.result.finalStateHash).toBe(a.result.finalStateHash);
  });

  it("different seeds give different outcomes", () => {
    expect(hashesEvery(1, 60, 60).result.finalStateHash).not.toBe(hashesEvery(2, 60, 60).result.finalStateHash);
  });

  it("a recorded order stream replays identically without the controllers", () => {
    const live = hashesEvery(5, 120, 10);
    const input = sc.build(data, 5, 120);
    input.orders = live.result.orders;
    const hashes: string[] = [];
    const replay = runBattle(input, { onTick: (sim) => { if (sim.state.tick % secondsToTicks(10) === 0) hashes.push(simHash(sim)); } });
    expect(hashes).toEqual(live.hashes);
    expect(replay.finalStateHash).toBe(live.result.finalStateHash);
  });

  it("continuing from a mid-battle save (through a JSON string) reaches the same end state", () => {
    const full = hashesEvery(3, 150, 150).result;
    const input = sc.build(data, 3, 150);
    input.orders = full.orders;

    // Run to 70 s, save, throw the sim away, load, continue.
    const sim = createSim({ ...input, orders: [] });
    const stream = [...input.orders].sort((x, y) => x.tick - y.tick);
    let next = 0;
    while (sim.state.tick < secondsToTicks(70)) {
      while (next < stream.length && stream[next]!.tick <= sim.state.tick) submitOrder(sim, stream[next++]!);
      step(sim);
    }
    const saveText = JSON.stringify(saveSim(sim));
    const loaded = loadSim(input, JSON.parse(saveText));
    expect(simHash(loaded)).toBe(simHash(sim));
    const end = continueBattle(loaded, input);
    expect(end.finalStateHash).toBe(full.finalStateHash);
  });

  it("a save taken while the order stream still holds future orders continues identically (review finding 1)", () => {
    const input = sc.build(data, 21, 30);
    const target = [...createSim(input).state.unit.entries()].find(([, u]) => u.side === "blue")![0];
    const orders: Order[] = [
      { tick: 600, issuer: "blue", target, kind: "move", waypoints: [{ x: 300, y: 200, mode: "walk" }] },
      { tick: 900, issuer: "blue", target, kind: "halt" },
    ];
    input.orders = orders;
    const straight = runBattle(input);
    const sim = createSim(input);
    const first = continueBattle(sim, input, { maxTicks: 300 });
    expect(first.endTick).toBe(300);
    const loaded = loadSim(input, JSON.parse(JSON.stringify(saveSim(sim))));
    const end = continueBattle(loaded, input);
    expect(end.eventCounts["order.delivered"]).toBe(2);
    expect(end.finalStateHash).toBe(straight.finalStateHash);
  });

  it("an AI-vs-AI battle saved halfway (with the AIs' memory) resumes identically", () => {
    const input = sc.build(data, 8, 150);
    const straight = runBattle(input, { controllers: sc.controllers!(input) });

    const ctrls = sc.controllers!(input);
    const sim = createSim(input);
    continueBattle(sim, input, { controllers: ctrls, maxTicks: secondsToTicks(70) });
    const save = JSON.parse(JSON.stringify(saveGame(sim, ctrls)));

    const fresh = sc.controllers!(input); // new AI objects, memory restored from the save
    const loaded = loadGame(input, save, fresh);
    const end = continueBattle(loaded, input, { controllers: fresh });
    expect(end.finalStateHash).toBe(straight.finalStateHash);
  });

  it("controllers do not change simulation state (they only return orders)", () => {
    const input = sc.build(data, 4, 30);
    const ctrls = sc.controllers!(input);
    const sim = createSim(input);
    for (let t = 0; t < secondsToTicks(30); t++) {
      for (const c of ctrls) {
        const before = hashState(sim.state);
        const orders = c.think(sim.state, sim.state.tick);
        expect(hashState(sim.state)).toBe(before);
        orders.forEach((o) => submitOrder(sim, o));
      }
      step(sim);
    }
  });

  it("a vehicle-only run driven by move orders is identical twice and through a JSON save mid-pivot", () => {
    const vdata = loadData(true);
    const orders = (unit: number): Order[] => [
      { tick: 0, issuer: "blue", target: unit, kind: "move", waypoints: [{ x: 600, y: 200, mode: "drive" }, { x: 600, y: 380, mode: "run" }, { x: 300, y: 380, mode: "drive-fast" }] },
      { tick: 1800, issuer: "blue", target: unit, kind: "move", waypoints: [{ x: 700, y: 50, mode: "walk", reverse: true }] },
    ];
    const run = (saveAt: number | null) => {
      const b = driveBattle(vdata, "de-puma", { surface: "grass", rain: 0.5 });
      const { unit, input } = b;
      let sim = b.sim;
      const os = orders(unit);
      const hashes: string[] = [];
      let pivotSaved = false;
      for (let t = 0; t < 3600; t++) {
        for (const o of os) if (o.tick === sim.state.tick) submitOrder(sim, o);
        step(sim);
        if (sim.state.tick % 300 === 0) hashes.push(simHash(sim));
        const d = [...sim.state.vehicle.values()][0]!.drive;
        // Save while turning on the spot (or at the given tick), reload through JSON, carry on.
        if (saveAt !== null && !pivotSaved && sim.state.tick >= saveAt && Math.abs(d.yawRate) > 0.2 && Math.abs(d.speed) < 0.5) {
          pivotSaved = true;
          sim = loadSim(input, JSON.parse(JSON.stringify(saveSim(sim))));
        }
      }
      if (saveAt !== null) expect(pivotSaved).toBe(true);
      return hashes;
    };
    const a = run(null), b = run(null), c = run(600);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });
});
