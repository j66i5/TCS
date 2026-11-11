/**
 * DETERMINISM (SPEC 4.3 rule 1, SPEC 5.2): same initial state + same seed + same order stream
 * => bit-identical state, checked by hash at intervals; also from a mid-battle save.
 */
import { describe, expect, it } from "vitest";
import {
  continueBattle, createSim, loadSim, runBattle, saveSim, secondsToTicks, simHash, step, submitOrder,
} from "@tcs/sim";
import { getScenario, loadData } from "../src/scenarios";

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
});
