/** M9.5: drone-observed fire — the platoon's drone locates the target and reads the falls; the off-map fixed-wing
 *  reconnaissance drone (rules.airRecon); the indirect lab's rows by location method. */
import { describe, expect, it } from "vitest";
import { buildScenario } from "@tcs/scenario";
import { createSim, step, submitOrder, type BattleInput, type Sim, type SimEvent } from "@tcs/sim";
import { indirectLab } from "../src/labs/indirect";
import { loadData } from "../src/scenarios";

const data = loadData();
function battle(airRecon?: string[]): { input: BattleInput; sim: Sim; top: number; px: number; py: number } {
  const input = buildScenario(data, { kind: "platoon-attack", seed: 1, mapKind: "village", factions: ["de", "ru"], attacker: "blue", timeLimitSeconds: 900, ...(airRecon ? { airRecon } : {}) });
  const sim = createSim(input);
  const top = [...sim.state.unit.entries()].find(([, u]) => u.side === "blue" && u.parent === null)![0];
  const obj = input.rules.objectives[0]!;
  return { input, sim, top, px: obj.x, py: obj.y };
}
function run(sim: Sim, seconds: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let k = 0; k < seconds * 60; k++) out.push(...step(sim));
  return out;
}
type Call = Extract<SimEvent, { kind: "support.call" }>;
type Ranging = Extract<SimEvent, { kind: "support.ranging" }>;

describe("drone-observed fire (M9.5)", () => {
  it("with the platoon's drone over the point the call is located by the drone (a smaller first-round error) and its camera reads the falls", () => {
    const plain = battle();
    submitOrder(plain.sim, { tick: 0, issuer: "blue", target: plain.top, kind: "callFire", x: plain.px, y: plain.py, ammo: "he", rounds: 2 });
    const c0 = run(plain.sim, 5).find((e): e is Call => e.kind === "support.call")!;
    expect(c0.method).toBe("estimate");

    const b = battle();
    submitOrder(b.sim, { tick: 0, issuer: "blue", target: b.top, kind: "drone", op: "fly", x: b.px - 60, y: b.py, altM: 100 });
    for (let k = 0; k < 400 * 60 && ![...b.sim.state.drone.values()].some((d) => d.mode === "hover"); k++) step(b.sim);
    submitOrder(b.sim, { tick: b.sim.state.tick, issuer: "blue", target: b.top, kind: "callFire", x: b.px, y: b.py, ammo: "he", rounds: 2 });
    const ev = run(b.sim, 240);
    const c = ev.find((e): e is Call => e.kind === "support.call")!;
    expect(c.method).toBe("drone");
    expect(c.errorM).toBeLessThan(c0.errorM);
    expect(ev.some((e) => e.kind === "radio" && e.key === "radio.fireCallDrone")).toBe(true);
    const r = ev.filter((e): e is Ranging => e.kind === "support.ranging");
    expect(r.length).toBeGreaterThan(0);
    expect(r.some((x) => x.seen && x.observerKind === "drone")).toBe(true);
  });

  it("the off-map reconnaissance drone locates a point nobody of the platoon sees and watches its falls", () => {
    const b = battle(["blue"]);
    expect(b.input.rules.airRecon).toEqual(["blue"]);
    submitOrder(b.sim, { tick: 0, issuer: "blue", target: b.top, kind: "callFire", x: b.px, y: b.py, ammo: "he", rounds: 2 });
    const ev = run(b.sim, 240);
    const c = ev.find((e): e is Call => e.kind === "support.call")!;
    expect(c.method).toBe("air");
    expect(ev.filter((e): e is Ranging => e.kind === "support.ranging").some((x) => x.seen && x.observerKind === "air")).toBe(true);
  });

  it("lab: the drone fixes a target far better than an estimate at range, about as well as a laser", () => {
    const rows = indirectLab(data, 1, 2000).methods;
    const row = (method: string, d: number) => rows.find((x) => x.faction === "de" && x.method === method && x.distM === d)!;
    expect(row("drone", 1000).miss[0]!).toBeLessThan(row("estimate", 1000).miss[0]! / 2);
    expect(row("drone", 600).miss[0]!).toBeLessThan(row("laser", 600).miss[0]! * 1.3);
    expect(row("air", 600).miss[2]!).toBeLessThan(row("estimate", 600).miss[2]!);
  });
});
