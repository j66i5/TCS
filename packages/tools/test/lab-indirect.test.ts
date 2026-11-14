/** M8.2b: observers and adjustment — the indirect fire lab's bands. */
import { describe, expect, it } from "vitest";
import { indirectLab, indirectLabMarkdown } from "../src/labs/indirect";
import { loadData } from "../src/scenarios";

const lab = indirectLab(loadData(), 6, 2000);

describe("indirect fire lab (M8.2b)", () => {
  it("prints its tables", () => { console.log(indirectLabMarkdown(lab)); });

  it("adjustment converges, closer and faster with a more skilled observer, within the bands", () => {
    // Bands (mean miss after two seen ranging rounds, m): by eye at 600 m, skill 0.2 / 0.5 / 0.8 at most 25 / 18 /
    // 12; with a laser at most 6 at any skill and range.
    const band: Record<number, number> = { 0.2: 25, 0.5: 18, 0.8: 12 };
    for (const r of lab.adjust) {
      expect(r.miss[1]!).toBeLessThan(r.miss[0]!);
      expect(r.miss[2]!).toBeLessThan(r.miss[1]!);
      if (r.observer === "eye" && r.distM === 600) expect(r.miss[2]!).toBeLessThanOrEqual(band[r.skill]!);
      if (r.observer === "laser") expect(r.miss[2]!).toBeLessThanOrEqual(6);
    }
    for (const f of ["de", "ru"]) for (const d of [300, 600]) {
      const m = (s: number) => lab.adjust.find((r) => r.faction === f && r.observer === "eye" && r.distM === d && r.skill === s)!.miss[2]!;
      expect(m(0.8)).toBeLessThan(m(0.5)); expect(m(0.5)).toBeLessThan(m(0.2));
    }
  });

  it("real missions: the ranging rounds are seen on open ground and the effect lands far closer than the first round", () => {
    for (const r of lab.missions) {
      expect(r.seeds).toBeGreaterThan(0);
      expect(r.seenShare).toBeGreaterThan(0.8);
      expect(r.effectMiss).toBeLessThan(r.firstMiss / 2);
    }
  });
});

describe("observers (M8.2b)", () => {
  it("a crewman observes through his seat's sight, from its height, with its laser; a man on foot by eye; drones are a reserved kind", async () => {
    const { createSim, observerOf, observersFor, heightAt } = await import("@tcs/sim");
    const { getScenario } = await import("../src/scenarios");
    const sim = createSim(getScenario("vehicles").build(loadData(), 1, 60));
    let crew = -1, foot = -1;
    for (const [id, s] of sim.state.soldier.entries()) {
      const v = s.mount !== undefined ? sim.state.vehicle.get(s.mount.vehicle) : undefined;
      const seat = v ? sim.ctx.catalog.vehicles[v.def]!.seats[s.mount!.seat] : undefined;
      if (crew < 0 && seat?.sensors?.some((x) => x.lrf === true)) crew = id;
      if (foot < 0 && s.mount === undefined) foot = id;
    }
    expect(crew).toBeGreaterThan(0);
    const o = observerOf(sim.ctx, sim.state, crew)!;
    expect(o.kind).toBe("vehicle");
    expect(o.laser).toBe(true);
    expect(o.z - heightAt(sim.ctx.map, o.x, o.y)).toBeGreaterThan(1.8);
    if (foot > 0) { const f = observerOf(sim.ctx, sim.state, foot)!; expect(f.kind).toBe("man"); expect(f.laser).toBe(false); }
    // The caller comes first among his platoon's observers.
    const obs = observersFor(sim.ctx, sim.state, crew);
    expect(obs[0]!.who).toBe(crew);
    expect(obs.length).toBeGreaterThan(1);
  });
});
