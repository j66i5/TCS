/** M7.5e polish: the `house-clear` scenario (one squad holds a house, two attack it, both under the AI commander). */
import { describe, expect, it } from "vitest";
import { buildingAt, createSim, hashState, hypot2, indoorAt, isAble, runBattle } from "@tcs/sim";
import { getScenario, loadData } from "../src/scenarios";

const data = loadData();
const sc = getScenario("house-clear");

describe("house-clear scenario (M7.5e)", () => {
  it("one blue squad by a two-storey house that is the objective, two red squads 200 m off; each side under one platoon", () => {
    const input = sc.build(data, 1, 180);
    expect(hashState(createSim(input).state)).toBe(hashState(createSim(sc.build(data, 1, 180)).state));
    const obj = input.rules.objectives;
    expect(obj).toHaveLength(1);
    expect(obj[0]!.holder).toBe("blue");
    const bi = indoorAt(createSim(input).ctx, obj[0]!.x, obj[0]!.y);
    expect(bi).toBeGreaterThanOrEqual(0);
    expect(input.map.buildings[bi]!.storeys).toBeGreaterThanOrEqual(2);
    for (const f of input.forces) {
      expect(f.units).toHaveLength(1);
      expect(f.units[0]!.members).toHaveLength(0);
      expect(f.units[0]!.subunits).toHaveLength(f.side === "blue" ? 1 : 2);
      for (const p of f.placements) {
        expect(buildingAt(input.map, p.x, p.y)).toBeNull();
        const d = hypot2(p.x - obj[0]!.x, p.y - obj[0]!.y);
        if (f.side === "blue") expect(d).toBeLessThan(40); else expect(d).toBeGreaterThan(150);
      }
    }
    expect(input.rules.support).toEqual([{ side: "red", he: 12, smoke: 4 }]);
  });

  it("the defence's commander puts some men in the house and keeps at least two outside", () => {
    const input = sc.build(data, 1, 120);
    let inside = 0, outside = 0;
    runBattle(input, {
      controllers: sc.controllers!(input),
      onTick: (sim) => {
        if (sim.state.tick !== 120 * 60 - 1) return;
        for (const [id, s] of sim.state.soldier.entries()) {
          if (sim.state.identity.get(id)?.side !== "blue" || !isAble(s)) continue;
          const t = sim.state.transform.req(id);
          if (indoorAt(sim.ctx, t.x, t.y) >= 0) inside++; else outside++;
        }
      },
    });
    expect(inside).toBeGreaterThanOrEqual(1);
    expect(outside).toBeGreaterThanOrEqual(2);
  });
});
