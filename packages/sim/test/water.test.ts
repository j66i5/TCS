/** M11.6 water: loss only in long battles, drinking from the emptiest canteen, conservation, effects, roster. */
import { describe, expect, it } from "vitest";
import {
  createSim, soldierRecordFromState, step, thirstAimFactor, thirstShare, type BattleInput, type Catalog, type EntityId,
  type HydrationDef, type SimEvent, type SoldierRecord,
} from "../src/index";
import { rec, testCatalog, testInput } from "./helpers";

const HY: HydrationDef = {
  fromBattleS: 7200, lossBaseLph: 0.15, lossExertLph: 0.8, deficitMaxL: 4.8, effectFromL: 1.6,
  drinkBelow: 0.85, sipMl: 250, drinkSuppressionMax: 0.1, fatigueGainK: 1, recoveryK: 0.5, aimK: 0.3,
};
function withWater(hy: HydrationDef): Catalog {
  return {
    ...testCatalog,
    items: { ...testCatalog.items, water: { id: "water", massKg: 0, category: "kit", chargeCapacity: 2000, chargeMassKg: 0.0008, water: true } },
    body: { ...testCatalog.body, physiology: { ...testCatalog.body.physiology, hydration: hy } },
  };
}
const catalog = withWater(HY);
/** Fast loss (6 L/h at rest) so a test of a few minutes of sim time sees men drink. */
const thirsty = withWater({ ...HY, lossBaseLph: 6 });

function input(cat: Catalog, seconds: number, load: SoldierRecord["load"], patch?: Partial<SoldierRecord>): BattleInput {
  const base = testInput(1, seconds);
  base.catalog = cat;
  for (const f of base.forces) for (const u of f.units) u.members = u.members.map((m) => ({ ...rec(m.personId, load.map((x) => ({ ...x }))), ...patch }));
  return base;
}
function run(sim: ReturnType<typeof createSim>, ticks: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < ticks; i++) out.push(...step(sim));
  return out;
}
function waterMl(sim: ReturnType<typeof createSim>): number {
  let ml = 0;
  for (const [, c] of sim.state.container.entries()) for (const s of c.stacks) if (s.type === "water") ml += s.count * (s.charge ?? 0);
  return ml;
}
function men(sim: ReturnType<typeof createSim>): EntityId[] { return [...sim.state.soldier.entries()].map(([id]) => id); }

describe("water (M11.6)", () => {
  it("changes nothing in a battle shorter than 2 hours: hydration stays 1, nobody drinks", () => {
    const sim = createSim(input(catalog, 1200, [{ type: "water", count: 1, charge: 2000 }]));
    const ev = run(sim, 1200 * 60);
    expect(ev.some((e) => e.kind === "water.drunk")).toBe(false);
    for (const id of men(sim)) expect(sim.state.soldier.req(id).physical.hydration).toBe(1);
    expect(waterMl(sim)).toBe(5 * 2000);
    // The same battle without a water model gives the same events.
    const plain = createSim(input(testCatalog, 1200, [{ type: "water", count: 1, charge: 2000 }]));
    const ev2 = run(plain, 1200 * 60);
    expect(JSON.stringify(ev)).toBe(JSON.stringify(ev2));
  });

  it("in a long battle men lose water and drink from the emptiest canteen; every ml is accounted for", () => {
    const load = [{ type: "water", count: 1, charge: 2000 }, { type: "water", count: 1, charge: 300 }];
    const sim = createSim(input(thirsty, 7200, load));
    const start = waterMl(sim);
    const ev = run(sim, 20 * 60 * 60);
    const drunk = ev.filter((e): e is Extract<SimEvent, { kind: "water.drunk" }> => e.kind === "water.drunk");
    expect(drunk.length).toBeGreaterThan(5);
    // Emptiest first: the first sip of each man is 250 of the 300 ml canteen, the second the 50 ml left in it.
    const first = drunk.filter((e) => e.soldier === drunk[0]!.soldier);
    expect(first[0]!.ml).toBe(250);
    expect(first[1]!.ml).toBe(50);
    const c = sim.state.container.req(drunk[0]!.soldier);
    expect(c.stacks.some((s) => s.type === "water" && s.charge === 0)).toBe(true); // the empty canteen stays a counted item
    // Conservation: left + drunk = start, exactly (integer ml).
    expect(waterMl(sim) + drunk.reduce((a, e) => a + e.ml, 0)).toBe(start);
    for (const id of men(sim)) {
      const h = sim.state.soldier.req(id).physical.hydration;
      expect(h).toBeLessThan(1);
      expect(h).toBeGreaterThan(HY.drinkBelow - 0.05); // he keeps himself above the threshold while water lasts
    }
  });

  it("without water he dries out; under fire he does not drink", () => {
    const sim = createSim(input(thirsty, 7200, []));
    const ev = run(sim, 10 * 60 * 60);
    expect(ev.some((e) => e.kind === "water.drunk")).toBe(false);
    for (const id of men(sim)) expect(sim.state.soldier.req(id).physical.hydration).toBeLessThan(HY.drinkBelow);
    const pinned = createSim(input(thirsty, 7200, [{ type: "water", count: 1, charge: 2000 }], { hydration: 0.5 }));
    const ev2: SimEvent[] = [];
    for (let i = 0; i < 120; i++) { for (const id of men(pinned)) pinned.state.soldier.req(id).mental.suppression = 0.9; ev2.push(...step(pinned)); }
    expect(ev2.some((e) => e.kind === "water.drunk")).toBe(false);
    // Once the fire stops (and his suppression is gone), he drinks.
    for (const id of men(pinned)) pinned.state.soldier.req(id).mental.suppression = 0;
    expect(run(pinned, 120).some((e) => e.kind === "water.drunk")).toBe(true);
  });

  it("a deficit past 2 % of body mass slows recovery and worsens aim; below it nothing", () => {
    expect(thirstShare(HY, 1)).toBe(0);
    expect(thirstShare(HY, 1 - 1.6 / 4.8)).toBe(0);
    expect(thirstShare(HY, 0)).toBe(1);
    expect(thirstShare(HY, 1 - 3.2 / 4.8)).toBeCloseTo(0.5, 12);
    expect(thirstAimFactor(catalog, 0)).toBeCloseTo(1.3, 12);
    expect(thirstAimFactor(catalog, 0.9)).toBe(1);
    expect(thirstAimFactor(testCatalog, 0)).toBe(1); // no water model
    // Two rested men, the same fatigue: the dry one (no water to drink) recovers more slowly.
    const fatigueAfter = (hydration: number) => {
      const sim = createSim(input(catalog, 600, [], { fatigue: 0.6, hydration }));
      run(sim, 30 * 60);
      return sim.state.soldier.req(men(sim)[0]!).physical.fatigue;
    };
    const wet = fatigueAfter(1), dry = fatigueAfter(0.1), mild = fatigueAfter(0.8);
    expect(dry).toBeGreaterThan(wet);
    expect(mild).toBe(wet);
  });

  it("roster: hydration goes out and comes back in", () => {
    const sim = createSim(input(thirsty, 7200, []));
    run(sim, 2 * 60 * 60);
    const id = men(sim)[0]!;
    const h = sim.state.soldier.req(id).physical.hydration;
    expect(h).toBeLessThan(1);
    const out = soldierRecordFromState(sim.state, id);
    expect(out.hydration).toBe(h);
    const again = createSim(input(catalog, 600, [], { hydration: out.hydration! }));
    expect(again.state.soldier.req(men(again)[0]!).physical.hydration).toBe(h);
    // A man with no deficit carries no field (old records stay as they were).
    const fresh = createSim(input(catalog, 600, []));
    expect(soldierRecordFromState(fresh.state, men(fresh)[0]!).hydration).toBeUndefined();
  });
});
