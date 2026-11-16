/** M11.6 batteries and water in the faction data: every powered device is issued with batteries, fitted at setup. */
import { describe, expect, it } from "vitest";
import { buildScenario } from "@tcs/scenario";
import { createSim, powerOf, slotLive } from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData();

describe("batteries and water in the faction data (M11.6)", () => {
  for (const [blue, red] of [["de", "ru"], ["ru", "de"]] as const) {
    it(`${blue}: each man's powered devices have a fitted battery, his spares are full, his water is 2000 ml`, () => {
      const input = buildScenario(data, { kind: "platoon-attack", seed: 1, mapKind: "farmland", factions: [blue, red], attacker: "blue", timeLimitSeconds: 60 });
      const sim = createSim(input);
      const cat = sim.ctx.catalog;
      let devices = 0, water = 0;
      for (const [id, s] of sim.state.soldier.entries()) {
        const c = sim.state.container.req(id);
        for (const slot of s.power ?? []) {
          const pw = powerOf(cat, slot.device)!;
          expect(slot.battery).toBe(pw.def.battery);
          // (By day a night device is off and gives nothing; every other device is on with charge.)
          expect(slotLive(slot, 0)).toBe(pw.def.onBelowLight === undefined || sim.state.environment.light < pw.def.onBelowLight);
          expect(slot.wh0).toBeGreaterThanOrEqual(pw.capWh * cat.behaviour.soldier.power!.installedMin - 0.01);
          expect(slot.wh0).toBeLessThanOrEqual(pw.capWh);
          devices++;
        }
        for (const st of c.stacks) {
          const d = cat.items[st.type]!;
          if (d.power) expect(s.power?.some((x) => x.device === st.type)).toBe(true);
          if (d.category === "battery" && !Object.values(cat.items).some((x) => x.drone?.battery === st.type)) expect(st.charge).toBe(d.chargeCapacity);
          if (d.water) { expect(st.charge).toBe(2000); water += st.count; }
        }
      }
      expect(devices).toBeGreaterThan(0);
      expect(water).toBeGreaterThan(0);
    });
  }

  it("the water model is loaded (only for battles of 2 h or more), without provenance keys", () => {
    const input = buildScenario(data, { kind: "platoon-attack", seed: 1, mapKind: "farmland", factions: ["de", "ru"], attacker: "blue", timeLimitSeconds: 60 });
    const hy = input.catalog.body.physiology.hydration!;
    expect(hy.fromBattleS).toBe(7200);
    expect(hy.effectFromL).toBeLessThan(hy.deficitMaxL);
    expect(Object.keys(hy)).not.toContain("sources");
    expect(Object.keys(input.catalog.body.physiology)).not.toContain("note");
  });
});
