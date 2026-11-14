/**
 * M7.5e step "leave": a defending squad whose men left a house on their own takes fire positions outdoors around
 * where they went (the commander, as after a rally), once per leaving.
 */
import { describe, expect, it } from "vitest";
import { COMMANDER, commanderController } from "@tcs/ai";
import { buildScenario } from "@tcs/scenario";
import { createSim, hypot2, indoorAt, type EntityId, type SimState } from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData();

function menOf(st: SimState, uid: EntityId): EntityId[] {
  const u = st.unit.req(uid);
  return [...u.members, ...u.children.flatMap((c) => menOf(st, c))];
}

describe("commander: re-siting after a house was left", () => {
  const input = buildScenario(data, { kind: "platoon-attack", seed: 1, mapKind: "village", factions: ["de", "ru"], attacker: "blue", timeLimitSeconds: 600 });
  const sim = createSim(input), st = sim.state;
  const def = input.rules.objectives[0]!.holder!;
  const ctrl = commanderController(def, input);
  const step = COMMANDER.stepSeconds * 60;
  ctrl.think(st, 0);
  const top = [...st.unit.entries()].find(([, u]) => u.side === def && u.parent === null)![1];
  const sq = [...top.children].sort((a, b) => a - b)[0]!;
  const men = menOf(st, sq).sort((a, b) => a - b);
  const house = input.map.buildings.find((b) => b.interior)!;

  it("orders nothing while its men are still on their way out", () => {
    st.unit.req(sq).leftHouse = { building: house.id, tick: step, reason: "trap" };
    st.mover.req(men[0]!).waypoints = [{ x: 10, y: 10, mode: "run", bolt: true }];
    const os = ctrl.think(st, 2 * step).filter((o) => men.includes(o.target as EntityId));
    expect(os.filter((o) => o.kind === "move")).toEqual([]);
  });

  it("once they are out and halted, each takes a fire position outdoors near where they went; only once", () => {
    st.mover.req(men[0]!).waypoints = [];
    const cx = men.reduce((a, m) => a + st.transform.req(m).x, 0) / men.length, cy = men.reduce((a, m) => a + st.transform.req(m).y, 0) / men.length;
    const os = ctrl.think(st, 3 * step).filter((o) => men.includes(o.target as EntityId) && o.kind === "move");
    expect(os.length).toBeGreaterThan(0);
    for (const o of os) {
      if (o.kind !== "move") continue;
      const p = o.waypoints[0]!;
      expect(indoorAt(sim.ctx, p.x, p.y)).toBe(-1);
      expect(hypot2(p.x - cx, p.y - cy)).toBeLessThanOrEqual(COMMANDER.fallback.rallySiteM + 40);
    }
    expect(ctrl.think(st, 4 * step).filter((o) => men.includes(o.target as EntityId) && o.kind === "move")).toEqual([]);
  });
});
