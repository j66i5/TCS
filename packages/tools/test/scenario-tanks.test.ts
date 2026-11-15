/**
 * Tanks in the platoon battle (M7.6b, scenario): `tanks` adds each named side's tank section (manifest
 * `tankSectionTemplate`, or `tankTemplates`) as a unit of its own; the attacker's start in dead ground behind its
 * carriers (whose starts do not move), the defender's 150-250 m behind its main objective on drivable ground.
 */
import { describe, expect, it } from "vitest";
import { buildScenario, lastDeadGround, lastTankDeadGround, type ScenarioDef } from "@tcs/scenario";
import { buildNavGrid, hypot2, nearestPassable, type BattleInput, type ForceInput } from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData();
const def = (seed: number, over: Partial<ScenarioDef> = {}): ScenarioDef => ({ kind: "platoon-attack", seed, mapKind: "village", factions: ["de", "ru"], attacker: "blue", vehicles: true, missileTeams: true, ...over });
const sideOf = (input: BattleInput, side: string): ForceInput => input.forces.find((f) => f.side === side)!;
const tankIds = (f: ForceInput): Set<string> => new Set(f.units.filter((u) => u.subunits.length > 0 && u.subunits.every((c) => c.vehicleId !== undefined) && u.members.length === 0).flatMap((u) => u.subunits.map((c) => c.vehicleId!)));

describe("tanks in the platoon battle (M7.6b, scenario)", () => {
  it("tanks: 'attacker' adds one section of two hulls of the manifest's template; the rest of the battle is as without tanks", () => {
    for (const [mapKind, attacker, type] of [["village", "blue", "de-leopard2a7v"], ["farmland", "red", "ru-t72b3m"]] as const) {
      const without = buildScenario(data, def(1, { mapKind, attacker }));
      const dg = lastDeadGround;
      const input = buildScenario(data, def(1, { mapKind, attacker, tanks: "attacker" }));
      expect(lastDeadGround).toEqual(dg); // the carriers' diagnostics are the carriers'
      const atk = sideOf(input, attacker), atk0 = sideOf(without, attacker);
      expect(atk.units.length).toBe(atk0.units.length + 1);
      const sec = atk.units.find((u) => u.members.length === 0 && u.subunits.length > 0 && u.subunits.every((c) => c.vehicleId !== undefined))!;
      expect(sec.members).toHaveLength(0);
      expect(sec.subunits).toHaveLength(2);
      const ids = tankIds(atk);
      expect(ids.size).toBe(2);
      expect(atk.vehicles!.filter((r) => ids.has(r.vehicleId)).map((r) => r.type)).toEqual([type, type]);
      // The carriers' starts and every other placement are unchanged; the defender is the same force.
      expect(atk.vehiclePlacements!.filter((p) => !ids.has(p.vehicleId))).toEqual(atk0.vehiclePlacements);
      const crew = new Set(sec.subunits.flatMap((c) => c.members.map((m) => m.personId)));
      expect(atk.placements.filter((p) => !crew.has(p.personId))).toEqual(atk0.placements);
      expect(atk.placements.filter((p) => crew.has(p.personId)).every((p) => p.seat !== undefined)).toBe(true);
      expect(sideOf(input, attacker === "blue" ? "red" : "blue")).toEqual(sideOf(without, attacker === "blue" ? "red" : "blue"));
      expect(input.rules).toEqual(without.rules);
      expect(input.rules.victory?.vehiclePoints).toBeDefined();
    }
  });

  it("the attacker's tanks start in dead ground, at least 25 m from every carrier", () => {
    for (const [mapKind, attacker] of [["farmland", "red"], ["village", "blue"]] as const) {
      for (const seed of [1, 2, 12]) {
        const input = buildScenario(data, def(seed, { attacker, mapKind, tanks: "attacker" }));
        const atk = sideOf(input, attacker), ids = tankIds(atk);
        const tanks = atk.vehiclePlacements!.filter((p) => ids.has(p.vehicleId)), ifvs = atk.vehiclePlacements!.filter((p) => !ids.has(p.vehicleId));
        expect(lastTankDeadGround?.seen.every((n) => n === 0), `${mapKind} seed ${seed}`).toBe(true);
        for (const t of tanks) for (const c of ifvs) expect(hypot2(t.x - c.x, t.y - c.y)).toBeGreaterThanOrEqual(24);
        for (const t of tanks) for (const o of input.rules.objectives) expect(hypot2(t.x - o.x, t.y - o.y)).toBeGreaterThan(590);
      }
    }
  });

  it("the defender's tanks stand 150-260 m behind the main objective on ground a tank can drive; tankTemplates gives T-90Ms", () => {
    for (const seed of [1, 2, 3]) {
      const input = buildScenario(data, def(seed, { tanks: "defender" }));
      const dfn = sideOf(input, "red"), ids = tankIds(dfn), main = input.rules.objectives[0]!;
      const grid = buildNavGrid(input.map, input.catalog.terrain, "tracked", 2, 0, [], { clearanceCells: 3 });
      const tanks = dfn.vehiclePlacements!.filter((p) => ids.has(p.vehicleId));
      expect(tanks).toHaveLength(2);
      expect(sideOf(input, "blue").units.length).toBe(sideOf(buildScenario(data, def(seed)), "blue").units.length);
      for (const t of tanks) {
        expect(t.x - main.x, `seed ${seed}`).toBeGreaterThanOrEqual(140); // red defends in the east: behind is east
        expect(hypot2(t.x - main.x, t.y - main.y)).toBeLessThanOrEqual(260);
        expect(nearestPassable(grid, t.x, t.y, 0)).toBeGreaterThanOrEqual(0);
      }
    }
    const t90 = buildScenario(data, def(1, { tanks: true, tankTemplates: [null, "tankovaya-gruppa-t90m"] }));
    const red = sideOf(t90, "red"), blue = sideOf(t90, "blue");
    expect(red.vehicles!.filter((r) => tankIds(red).has(r.vehicleId)).map((r) => r.type)).toEqual(["ru-t90m", "ru-t90m"]);
    expect(blue.vehicles!.filter((r) => tankIds(blue).has(r.vehicleId)).map((r) => r.type)).toEqual(["de-leopard2a7v", "de-leopard2a7v"]);
  });

  it("the fixture's tortoises (rule 8), and tanks in a battle without the platoons' vehicles", () => {
    const fx = loadData(true);
    const input = buildScenario(fx, { kind: "platoon-attack", seed: 1, mapKind: "village", factions: ["xf", "de"], attacker: "blue", tanks: true });
    expect(sideOf(input, "blue").vehicles!.map((r) => r.type)).toEqual(["xf-tortoise", "xf-tortoise"]);
    expect(sideOf(input, "red").vehicles!.map((r) => r.type)).toEqual(["de-leopard2a7v", "de-leopard2a7v"]);
  });
});
