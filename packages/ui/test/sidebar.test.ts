/** M7.5a: the unit sidebar's tiles (pure). */
import { describe, expect, it } from "vitest";
import { createSim, simHash } from "@tcs/sim";
import { getScenario, loadData } from "../../tools/src/scenarios";
import { unitTiles } from "../src/sidebar";

describe("unitTiles", () => {
  const sim = createSim(getScenario("platoon-vehicles").build(loadData(), 1, 600));
  const cat = sim.ctx.catalog;
  it("one tile per own unit: each platoon then its squads and vehicles, with men fit and a state", () => {
    const h = simHash(sim);
    const tiles = unitTiles(sim.state, "blue", cat);
    expect(simHash(sim)).toBe(h);
    const own = [...sim.state.unit.values()].filter((u) => u.side === "blue");
    expect(tiles.length).toBe(own.length);
    expect(tiles.every((t) => sim.state.unit.get(t.unit)!.side === "blue")).toBe(true);
    expect(tiles[0]!.depth).toBe(0);
    expect(tiles[0]!.kind).toBe("hq");
    expect(tiles[1]!.parent).toBe(tiles[0]!.callsign);
    const squad = tiles.find((t) => t.kind === "infantry")!;
    expect(squad.fit).toBe(squad.total);
    expect(squad.state).toBe("aboard"); // the platoon starts mounted
    const veh = tiles.find((t) => t.kind === "vehicle")!;
    expect(veh.total).toBe(3); // its crew, not its passengers
    expect(veh.passengers).toBe(6);
    expect(veh.vehicleStatus).toBe("ok");
    // The platoon's tile counts every man of the platoon.
    const all = tiles.filter((t) => t.depth === 1 && t.parent === tiles[0]!.callsign && t.kind !== "vehicle").reduce((n, t) => n + t.total, 0);
    expect(tiles[0]!.total).toBeGreaterThanOrEqual(all);
  });
  it("men out of the fight count against the fit; a unit with nobody fit is lost", () => {
    const tiles = unitTiles(sim.state, "red", cat);
    const sq = tiles.find((t) => t.kind === "infantry")!;
    const u = sim.state.unit.get(sq.unit)!;
    for (const m of u.members) sim.state.soldier.req(m).physiology.consciousness = 0;
    const after = unitTiles(sim.state, "red", cat).find((t) => t.unit === sq.unit)!;
    expect(after.fit).toBe(0);
    expect(after.state).toBe("lost");
  });
});
