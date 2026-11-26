/**
 * Review step 5 (owner Q4): `ForceInput.start`, the rules a force's units start with as battle input: the fire rule of
 * every unit of that force only (a late unit when it comes too), an ambush laid from the first tick that springs like
 * an ordered one; without `start` nothing changes (the same state hash as before); it survives save and load.
 */
import { describe, expect, it } from "vitest";
import { createSim, deserializeState, hashState, loadSim, saveSim, secondsToTicks, serializeState, step, submitOrder, type BattleInput, type Sim, type SimEvent } from "../src/index";
import { armedInput, team, vehicleInput } from "./helpers";

function run(sim: Sim, seconds: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < secondsToTicks(seconds); i++) out.push(...step(sim));
  return out;
}
const units = (sim: Sim, side: string) => [...sim.state.unit.entries()].filter(([, u]) => u.side === side);
/** Blue (three men at x = 10, a squad with a sub-team) and red (two men at `redX`) on a flat open field. */
function setup(redX = 120): BattleInput {
  const input = armedInput(1, 900);
  input.rules.physiologyModel = "simple";
  input.forces[1]!.placements = input.forces[1]!.placements.map((p) => ({ ...p, x: redX }));
  return input;
}
const shots = (sim: Sim, ev: SimEvent[], side: string) => ev.filter((e) => e.kind === "shot.fired" && sim.state.identity.get(e.shooter)?.side === side).length;

describe("ForceInput.start: the fire rule", () => {
  it("sets every unit of that force, sub-units too, and no unit of the other; absent: the catalog's default", () => {
    const input = setup();
    const sub = team("b-sub", 2);
    input.forces[0]!.units[0]!.subunits.push(sub);
    sub.members.forEach((m, i) => input.forces[0]!.placements.push({ personId: m.personId, x: 12, y: 30 + i * 3, heading: 0 }));
    const def = input.catalog.behaviour.decisions.defaultFireRule;
    expect(def).toBe("hold"); // (the sim test catalog)
    input.forces[0]!.start = { fire: "free" };
    const sim = createSim(input);
    expect(units(sim, "blue").length).toBe(2);
    for (const [, u] of units(sim, "blue")) { expect(u.fireRule).toBe("free"); expect(u.ambush).toBeUndefined(); }
    for (const [, u] of units(sim, "red")) expect(u.fireRule).toBe(def);
    // No order was given for it: nothing delivered, nothing in the events.
    const ev = run(sim, 1);
    expect(ev.some((e) => e.kind === "order.delivered" || e.kind === "order.rejected")).toBe(false);
  });

  it("a vehicle crew gets it", () => {
    const input = vehicleInput();
    input.forces[0]!.start = { fire: "return" };
    const sim = createSim(input);
    for (const [, u] of units(sim, "blue")) expect(u.fireRule).toBe("return");
  });

  it("a unit arriving late starts with it when it comes", () => {
    const input = setup();
    input.forces[1]!.units[0]!.arriveS = 5;
    input.forces[1]!.start = { fire: "return" };
    const sim = createSim(input);
    expect(units(sim, "red")).toEqual([]);
    run(sim, 7);
    expect(units(sim, "red").length).toBeGreaterThan(0);
    for (const [, u] of units(sim, "red")) expect(u.fireRule).toBe("return");
  });

  it("without start the battle is the one before: same state hash at the start and after 20 s; an empty start too", () => {
    const a = createSim(setup()), b = createSim({ ...setup(), forces: setup().forces.map((f) => ({ ...f, start: {} })) });
    expect(hashState(b.state)).toBe(hashState(a.state));
    run(a, 20); run(b, 20);
    expect(hashState(b.state)).toBe(hashState(a.state));
  });

  it("free from the first tick: the men open fire without an order (the default here holds)", () => {
    const held = createSim(setup());
    expect(shots(held, run(held, 15), "blue")).toBe(0);
    const input = setup();
    input.forces[0]!.start = { fire: "free" };
    const sim = createSim(input);
    expect(shots(sim, run(sim, 15), "blue")).toBeGreaterThan(0);
  });
});

describe("ForceInput.start: an ambush laid at the start", () => {
  const ambushInput = (redX: number, rangeM: number): BattleInput => {
    const input = setup(redX);
    input.forces[0]!.start = { ambushM: rangeM };
    return input;
  };
  it("is the record the ambush order lays: range, the top unit as root on the whole tree, fire rule free", () => {
    const input = ambushInput(400, 150);
    const sub = team("b-sub", 2);
    input.forces[0]!.units[0]!.subunits.push(sub);
    sub.members.forEach((m, i) => input.forces[0]!.placements.push({ personId: m.personId, x: 12, y: 30 + i * 3, heading: 0 }));
    const sim = createSim(input);
    const top = units(sim, "blue").find(([, u]) => u.parent === null)![0];
    for (const [, u] of units(sim, "blue")) { expect(u.ambush).toEqual({ rangeM: 150, tick: 0, root: top }); expect(u.fireRule).toBe("free"); }
    // The same as the order gives (laid at tick 0 on the top unit).
    const ordered = createSim(setup(400));
    const otop = units(ordered, "blue").find(([, u]) => u.parent === null)![0];
    submitOrder(ordered, { tick: 0, issuer: "blue", target: otop, kind: "ambush", rangeM: 150 });
    run(ordered, 3);
    expect(ordered.state.unit.req(otop).ambush).toMatchObject({ rangeM: 150, root: otop });
    expect(ordered.state.unit.req(otop).fireRule).toBe("free");
  });

  it("holds its fire at an enemy beyond the range, and springs when he is within it", () => {
    // Red holds its own fire (it must not spring the ambush by firing).
    const far = createSim(ambushInput(200, 100));
    submitOrder(far, { tick: 0, issuer: "red", target: units(far, "red")[0]![0], kind: "rules", fire: "hold" });
    const evFar = run(far, 15);
    expect(shots(far, evFar, "blue")).toBe(0);
    expect(units(far, "blue")[0]![1].ambush).toBeDefined();
    const near = createSim(ambushInput(80, 100));
    submitOrder(near, { tick: 0, issuer: "red", target: units(near, "red")[0]![0], kind: "rules", fire: "hold" });
    const evNear = run(near, 15);
    expect(evNear.some((e) => e.kind === "radio" && e.key === "radio.ambushSprung")).toBe(true);
    expect(units(near, "blue")[0]![1].ambush).toBeUndefined();
    expect(shots(near, evNear, "blue")).toBeGreaterThan(0);
  });

  it("survives serialise / deserialise and save / load", () => {
    const input = ambushInput(400, 150);
    const sim = createSim(input);
    run(sim, 2);
    const back = deserializeState(serializeState(sim.state));
    expect(hashState(back)).toBe(hashState(sim.state));
    const copy = loadSim(ambushInput(400, 150), saveSim(sim));
    expect(units(copy, "blue")[0]![1].ambush).toEqual(units(sim, "blue")[0]![1].ambush);
    run(sim, 5); run(copy, 5);
    expect(hashState(copy.state)).toBe(hashState(sim.state));
  });
});
