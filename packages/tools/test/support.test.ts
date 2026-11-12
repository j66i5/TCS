/** M6.5c: mortar fire and smoke (pulled forward from M8 by the owner). */
import { describe, expect, it } from "vitest";
import { demoBattle } from "@tcs/scenario";
import { createSim, hashState, loadSim, saveSim, step, submitOrder, supportLeft, type BattleInput, type Sim, type SimEvent } from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData();
function battle(prep?: (i: BattleInput) => void): BattleInput {
  const input = demoBattle(data, { seed: 3, factions: ["de", "ru"], mapWidthM: 800, mapHeightM: 400, frontM: 300, timeLimitSeconds: 900 });
  input.rules.support = [{ side: "blue", he: 6, smoke: 4 }, { side: "red", he: 6, smoke: 4 }];
  prep?.(input);
  return input;
}
const top = (sim: Sim, side: string) => [...sim.state.unit.entries()].find(([, u]) => u.side === side && u.parent === null)![0];
function run(sim: Sim, seconds: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let k = 0; k < seconds * 60; k++) out.push(...step(sim));
  return out;
}

describe("fire support (M6.5c)", () => {
  it("high explosive lands after the faction's delay, round by round, scattered about the point; the allotment pays", () => {
    const input = battle();
    const sim = createSim(input);
    const fs = input.catalog.factions["de"]!.fireSupport!;
    const tx = 600, ty = 300;
    submitOrder(sim, { tick: 0, issuer: "blue", target: top(sim, "blue"), kind: "callFire", x: tx, y: ty, ammo: "he", rounds: 4 });
    const ev = run(sim, fs.delaySeconds + 4 * fs.intervalSeconds + 10);
    const bursts = ev.filter((e): e is Extract<SimEvent, { kind: "explosion" }> => e.kind === "explosion" && e.ammo === fs.heAmmo);
    expect(bursts).toHaveLength(4);
    expect(bursts[0]!.tick / 60).toBeGreaterThanOrEqual(fs.delaySeconds);
    for (const b of bursts) expect(Math.hypot(b.x - tx, b.y - ty)).toBeLessThan(4 * fs.dispersionM);
    expect(supportLeft(sim.state, "blue", "he")).toBe(2);
    // The rounds are counted items in the mortar section's container (rule 9).
    const sec = sim.state.support.find((s) => s.side === "blue")!;
    const c = sim.state.container.req(sec.battery);
    expect(c.stacks.find((s) => s.type === fs.heAmmo)?.count).toBe(2);
    expect(c.stacks.find((s) => s.type === fs.smokeAmmo)?.count).toBe(4);
    // Asking for more than is left gets what is left; nothing left: unable.
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: top(sim, "blue"), kind: "callFire", x: tx, y: ty, ammo: "he", rounds: 10 });
    run(sim, 3);
    expect(supportLeft(sim.state, "blue", "he")).toBe(0);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: top(sim, "blue"), kind: "callFire", x: tx, y: ty, ammo: "he", rounds: 1 });
    expect(run(sim, 3).some((e) => e.kind === "radio" && e.key === "radio.unable")).toBe(true);
  });

  it("smoke between them hides men from each other; without it they are seen", () => {
    const seen = (smoke: boolean) => {
      const sim = createSim(battle());
      if (smoke) {
        // A screen laid in the middle, long enough across the line of sight.
        for (const y of [140, 170, 200, 230, 260]) sim.state.smoke.push({ x: 400, y, radiusM: 30, startTick: -10000, untilTick: 100000 });
      }
      return run(sim, 40).filter((e) => e.kind === "spotted").length;
    };
    expect(seen(false)).toBeGreaterThan(0);
    expect(seen(true)).toBe(0);
  });

  it("a smoke mission lays clouds that clear after their time; missions survive save and load", () => {
    const input = battle();
    const sim = createSim(input);
    const fs = input.catalog.factions["ru"]!.fireSupport!;
    submitOrder(sim, { tick: 0, issuer: "red", target: top(sim, "red"), kind: "callFire", x: 300, y: 200, ammo: "smoke", rounds: 2 });
    run(sim, fs.delaySeconds - 10);
    const copy = loadSim({ ...input, orders: [] }, saveSim(sim));
    const ev = run(sim, 20); run(copy, 20);
    expect(hashState(copy.state)).toBe(hashState(sim.state));
    expect(ev.filter((e) => e.kind === "support.smoke")).toHaveLength(2);
    expect(sim.state.smoke).toHaveLength(2);
    run(sim, fs.smokeSeconds + 5);
    expect(sim.state.smoke).toHaveLength(0);
  });
});
