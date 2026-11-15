/**
 * D2 (roadmap-detail slice 10): the battle record, folded from the event stream alone, is what the app's review and
 * the batch report both read. The app folds each tick's events after `step` (its own loop); the batch folds them
 * through `runBattle`'s callbacks. Both must give the same record, deterministic per seed, and folding must not touch
 * the battle.
 */
import { describe, expect, it } from "vitest";
import { createSim, finishRecord, newBattleRecord, readRecord, recordEvents, runBattle, simHash, step, submitOrder, battleScore, type BattleRecord } from "@tcs/sim";
import { getScenario, loadData } from "../src/scenarios";

const data = loadData();
const sc = getScenario("shootout");
const SECONDS = 240;

/** The batch tool's way: `runBattle` with the events of each tick folded after it. */
function viaBatch(seed: number): { rec: BattleRecord; hash: string } {
  const input = sc.build(data, seed, SECONDS);
  const rec = newBattleRecord([...new Set(input.forces.map((f) => f.side))]);
  let pending: Parameters<typeof recordEvents>[1] = [];
  const r = runBattle(input, {
    controllers: sc.controllers?.(input) ?? [],
    onEvents: (ev) => { pending = ev; },
    onTick: (sim) => { recordEvents(rec, pending, sim.state, input.catalog); pending = []; },
  });
  return { rec: finishRecord(rec, r), hash: r.finalStateHash };
}

/** The app's way: its own loop (controllers think, orders submitted, step, events folded), ended from the score. */
function viaApp(seed: number): { rec: BattleRecord; hash: string } {
  const input = sc.build(data, seed, SECONDS);
  const sim = createSim(input);
  const ai = sc.controllers?.(input) ?? [];
  const rec = newBattleRecord(sim.state.sides.map((x) => x.id));
  const maxTicks = SECONDS * 60 + 1;
  while (!sim.state.ended && sim.state.tick < maxTicks) {
    for (const c of ai) for (const o of c.think(sim.state, sim.state.tick)) submitOrder(sim, o);
    recordEvents(rec, step(sim), sim.state, input.catalog);
  }
  const sc0 = battleScore(sim.ctx, sim.state);
  finishRecord(rec, { endTick: sim.state.tick, endReason: sim.state.ended?.reason ?? "time-limit", winner: sc0.winner, loser: sim.state.endLoser });
  return { rec, hash: simHash(sim) };
}

describe("battle record (D2)", () => {
  it("the app's loop and the batch tool give the same record on 5 seeds; folding changes nothing in the battle", () => {
    for (let seed = 1; seed <= 5; seed++) {
      const b = viaBatch(seed), a = viaApp(seed);
      expect(a.rec.timeline).toEqual(b.rec.timeline);
      expect(a.rec.sides).toEqual(b.rec.sides);
      expect(a.rec.exp).toEqual(b.rec.exp);
      expect(a.rec.heatShots).toEqual(b.rec.heatShots);
      expect(a.rec.heatFalls).toEqual(b.rec.heatFalls);
      expect(a.rec.firstTreated).toEqual(b.rec.firstTreated);
      expect(a.rec.end?.tick).toBe(b.rec.end?.tick);
      expect(a.rec.end?.reason).toBe(b.rec.end?.reason);
      // The record only reads: the battle ends where it ends without one.
      const input = sc.build(data, seed, SECONDS);
      const plain = runBattle(input, { controllers: sc.controllers?.(input) ?? [] });
      expect(b.hash).toBe(plain.finalStateHash);
    }
  }, 120_000);

  it("is plain JSON, deterministic per seed, and read back only at its own version", () => {
    const one = viaBatch(1).rec, two = viaBatch(1).rec;
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
    const back = readRecord(JSON.parse(JSON.stringify(one)));
    expect(back).toEqual(one);
    expect(one.heatShots.length).toBeGreaterThan(0);
    expect(one.heatFalls.length).toBeGreaterThan(0);
    expect(one.sides["blue"]!.care.self + one.sides["red"]!.care.self + one.sides["blue"]!.care.buddy + one.sides["red"]!.care.buddy).toBeGreaterThan(0);
    expect(one.timeline.every((e) => typeof e.key === "string" && e.key.length > 0)).toBe(true);
    expect(readRecord({ ...one, v: one.v + 1 })).toBeNull();
    expect(readRecord({ timeline: [], heatShots: [] })).toBeNull(); // a record saved before D2
    expect(readRecord(null)).toBeNull();
  }, 60_000);
});
