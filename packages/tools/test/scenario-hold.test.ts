/** M11.1: the hold-resupply scenario: waves arriving late, the supply point, save and load across an arrival. */
import { describe, expect, it } from "vitest";
import { holdBattle } from "@tcs/scenario";
import { waveCommanders } from "@tcs/ai";
import { createSim, hashState, loadGame, saveGame, secondsToTicks, step, submitOrder, type Sim } from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData();

describe("hold-resupply (M11.1)", () => {
  it("one defending platoon, three attacking platoons of which two arrive at 15 and 30 min; a supply point of cans", () => {
    const input = holdBattle(data, { factions: ["de", "ru"], seed: 2 });
    const red = input.forces.find((f) => f.side === "red")!, blue = input.forces.find((f) => f.side === "blue")!;
    const plats = red.units.filter((u) => u.echelon === "platoon");
    expect(plats.map((u) => u.arriveS ?? 0)).toEqual([0, 900, 1800]);
    expect(new Set(plats.map((u) => u.callsign)).size).toBe(3);
    expect(blue.units.filter((u) => u.echelon === "platoon")).toHaveLength(1);
    expect(input.rules.timeLimitSeconds).toBe(3600);
    // The cans: one per squad for each cartridge the squad's weapons fire.
    const cache = blue.caches![0]!;
    expect(cache.load.every((s) => input.catalog.items[s.type]?.category === "ammo-package")).toBe(true);
    expect(cache.load.reduce((n, s) => n + s.count, 0)).toBeGreaterThanOrEqual(3);
    const main = input.rules.objectives[0]!;
    expect(Math.hypot(cache.x - main.x, cache.y - main.y)).toBeGreaterThan(100);
    expect(cache.x).toBeLessThan(main.x); // (behind the village, away from the attack from the east)
  });

  it("a wave enters at its time and not before; save and load across the arrival replays the same", () => {
    const mk = () => holdBattle(data, { factions: ["de", "ru"], seed: 1, waveS: [0, 30] });
    const input = mk();
    const sim: Sim = createSim(input);
    const ctl = waveCommanders("red", input);
    const redPlatoons = (s: Sim) => [...s.state.unit.values()].filter((u) => u.side === "red" && u.echelon === "platoon").length;
    const advance = (s: Sim, c: typeof ctl, n: number) => { for (let i = 0; i < n; i++) { for (const o of c.think(s.state, s.state.tick)) submitOrder(s, o); step(s); } };
    advance(sim, ctl, secondsToTicks(20));
    expect(redPlatoons(sim)).toBe(1);
    const save = saveGame(sim, [ctl]);
    const ctl2 = waveCommanders("red", mk());
    const copy = loadGame(mk(), JSON.parse(JSON.stringify(save)), [ctl2]);
    advance(sim, ctl, secondsToTicks(15));
    advance(copy, ctl2, secondsToTicks(15));
    expect(redPlatoons(sim)).toBe(2);
    expect(hashState(copy.state)).toBe(hashState(sim.state));
  }, 120_000);
});
