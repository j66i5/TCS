/** M11.6 review fix (2026-11-16): a squad aboard a hull whose radio works stays on the net with its handheld flat. */
import { describe, expect, it } from "vitest";
import { buildScenario } from "@tcs/scenario";
import { createSim, stampSlot, step, TICK_HZ, type EntityId, type Sim } from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData();

function run(sim: Sim, seconds: number): void {
  for (let i = 0; i < seconds * TICK_HZ; i++) step(sim);
}

describe("flat handheld radio aboard a hull (M11.6)", () => {
  it("stays on the net while the hull radio works; off the net once it is wrecked", () => {
    const input = buildScenario(data, { kind: "platoon-attack", seed: 1, mapKind: "farmland", factions: ["de", "ru"], attacker: "blue", timeLimitSeconds: 600, vehicles: true });
    const sim = createSim(input);
    const cat = sim.ctx.catalog;
    // A blue squad (or team) on foot, no sub-units, whose men are all aboard one hull and carry a radio of their own.
    let squad: EntityId | undefined, hull: EntityId | undefined;
    for (const [uid, u] of sim.state.unit.entries()) {
      if (u.side !== "blue" || u.vehicle !== undefined || u.members.length === 0 || u.children.length > 0) continue;
      const mounts = new Set(u.members.map((m) => sim.state.soldier.req(m).mount?.vehicle));
      const radio = u.members.some((m) => sim.state.soldier.req(m).power?.some((x) => cat.items[x.device]?.radio === true));
      if (mounts.size === 1 && !mounts.has(undefined) && radio) { squad = uid; hull = [...mounts][0]!; break; }
    }
    expect(squad).toBeDefined();
    const u = sim.state.unit.req(squad!);
    // Every radio of the squad flat, no spare to change it for.
    for (const m of u.members) {
      const s = sim.state.soldier.req(m);
      for (const slot of s.power ?? []) {
        if (cat.items[slot.device]?.radio !== true) continue;
        stampSlot(slot, 0, true, sim.state.tick);
        const c = sim.state.container.req(m);
        c.stacks = c.stacks.filter((x) => x.type !== slot.battery);
      }
    }
    run(sim, 3);
    expect(sim.state.unit.req(squad!).comms.link).toBe("radio");
    // The hull's radio wrecked: the squad aboard is off the net.
    const v = sim.state.vehicle.req(hull!), def = cat.vehicles[v.def]!;
    expect(def.components?.some((x) => x.kind === "radio")).toBe(true);
    def.components!.forEach((x, k) => { if (x.kind === "radio") v.comp[k] = 0; });
    run(sim, 2);
    expect(sim.state.unit.req(squad!).comms.link).toBe("none");
  });
});
