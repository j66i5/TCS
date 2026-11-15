/** D4b: the ambush and defend-arc orders (SPEC 6.6). */
import { describe, expect, it } from "vitest";
import { createSim, deserializeState, hashState, loadSim, saveSim, secondsToTicks, serializeState, step, submitOrder, PI, type BattleInput, type Sim, type SimEvent } from "../src/index";
import { armedInput, vehicleInput } from "./helpers";

const unitOf = (sim: Sim, side: string) => [...sim.state.unit.entries()].find(([, u]) => u.side === side)!;
function run(sim: Sim, seconds: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < secondsToTicks(seconds); i++) out.push(...step(sim));
  return out;
}
/** Blue (three men at x = 10) and red (two men at `redX`), on a flat open field: they see each other. */
function setup(redX = 120): BattleInput {
  const input = armedInput(1, 900);
  input.rules.physiologyModel = "simple";
  input.forces[1]!.placements = input.forces[1]!.placements.map((p) => ({ ...p, x: redX }));
  return input;
}
const shotsOf = (sim: Sim, ev: SimEvent[], side: string) => ev.filter((e) => e.kind === "shot.fired" && sim.state.identity.get(e.shooter)?.side === side).length;
const rejected = (ev: SimEvent[]) => ev.filter((e) => e.kind === "order.rejected").map((e) => (e.kind === "order.rejected" ? e.reason : ""));
/** Red holds its fire (it must not spring the ambush by firing first, unless a test says so). */
function redHolds(sim: Sim): void {
  submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: unitOf(sim, "red")[0], kind: "rules", fire: "hold" });
}

describe("ambush and defend arc: validation (D4b)", () => {
  it("rejects bad ranges and widths, a single man as target, and an arc for a vehicle crew", () => {
    const sim = createSim(setup());
    const [bid, blue] = unitOf(sim, "blue");
    submitOrder(sim, { tick: 0, issuer: "blue", target: bid, kind: "ambush", rangeM: 5 });
    submitOrder(sim, { tick: 0, issuer: "blue", target: bid, kind: "ambush", rangeM: Number.NaN });
    submitOrder(sim, { tick: 0, issuer: "blue", target: blue.members[0]!, kind: "ambush", rangeM: 100 });
    submitOrder(sim, { tick: 0, issuer: "blue", target: bid, kind: "defendArc", facing: 0, widthRad: 0 });
    submitOrder(sim, { tick: 0, issuer: "blue", target: bid, kind: "defendArc", facing: 0, widthRad: 7 });
    submitOrder(sim, { tick: 0, issuer: "blue", target: bid, kind: "defendArc", facing: Number.POSITIVE_INFINITY, widthRad: 1 });
    expect(rejected(step(sim))).toEqual(["invalid-params", "invalid-params", "invalid-params", "invalid-params", "invalid-params", "invalid-params"]);
    const vs = createSim(vehicleInput());
    const [cid] = unitOf(vs, "blue");
    submitOrder(vs, { tick: 0, issuer: "blue", target: cid, kind: "defendArc", facing: 0, widthRad: 2 });
    submitOrder(vs, { tick: 0, issuer: "blue", target: cid, kind: "ambush", rangeM: 300 });
    expect(rejected(step(vs))).toEqual(["not-applicable"]);
  });

  it("an ambush laid on a crew holds its gun's reach; a fire rule ends it", () => {
    const vs = createSim(vehicleInput());
    const [cid, crew] = unitOf(vs, "blue");
    submitOrder(vs, { tick: 0, issuer: "blue", target: cid, kind: "ambush", rangeM: 300 });
    run(vs, 2);
    expect(crew.ambush).toMatchObject({ rangeM: 300, root: cid });
    expect(crew.fireRule).toBe("free");
    submitOrder(vs, { tick: vs.state.tick, issuer: "blue", target: cid, kind: "rules", fire: "return" });
    run(vs, 2);
    expect(crew.ambush).toBeUndefined();
    expect(crew.fireRule).toBe("return");
  });
});

describe("ambush (D4b)", () => {
  it("holds fire at an enemy beyond its range, then springs when he comes within it", () => {
    const sim = createSim(setup(120));
    const [bid, blue] = unitOf(sim, "blue");
    redHolds(sim);
    submitOrder(sim, { tick: 0, issuer: "blue", target: bid, kind: "ambush", rangeM: 50 });
    const ev = run(sim, 15);
    expect(ev.some((e) => e.kind === "radio" && e.key === "radio.ack.ambush")).toBe(true);
    expect(shotsOf(sim, ev, "blue")).toBe(0);
    expect(blue.ambush).toBeDefined();
    // Red walks in to 30 m.
    const [rid] = unitOf(sim, "red");
    submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: rid, kind: "move", waypoints: [{ x: 40, y: 15, mode: "walk" }] });
    const ev2 = run(sim, 80);
    const sprungAt = ev2.find((e) => e.kind === "radio" && e.key === "radio.ambushSprung");
    expect(sprungAt).toBeDefined();
    expect(blue.ambush).toBeUndefined();
    expect(blue.fireRule).toBe("free");
    // The first blue shot: at a red man within the range (+ a little: he walks on while they aim).
    const first = ev2.find((e) => e.kind === "shot.fired" && sim.state.identity.get(e.shooter)?.side === "blue");
    expect(first).toBeDefined();
    expect(shotsOf(sim, ev2, "blue")).toBeGreaterThan(3);
  });

  it("springs when one of its men fires (an order to fire)", () => {
    const sim = createSim(setup(120));
    const [bid, blue] = unitOf(sim, "blue");
    redHolds(sim);
    submitOrder(sim, { tick: 0, issuer: "blue", target: bid, kind: "ambush", rangeM: 50 });
    run(sim, 5);
    expect(blue.ambush).toBeDefined();
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: blue.members[0]!, kind: "fire", x: 120, y: 12, heightM: 1 });
    const ev = run(sim, 10);
    expect(ev.some((e) => e.kind === "radio" && e.key === "radio.ambushSprung")).toBe(true);
    expect(blue.ambush).toBeUndefined();
    // Once sprung, the others fire at will too (beyond the ambush range).
    const shooters = new Set(ev.filter((e) => e.kind === "shot.fired" && sim.state.identity.get(e.shooter)?.side === "blue").map((e) => (e.kind === "shot.fired" ? e.shooter : -1)));
    expect(shooters.size).toBeGreaterThan(1);
  });

  it("springs when it comes under fire", () => {
    const sim = createSim(setup(120));
    const [bid, blue] = unitOf(sim, "blue");
    const [rid] = unitOf(sim, "red");
    submitOrder(sim, { tick: 0, issuer: "red", target: rid, kind: "rules", fire: "hold" });
    submitOrder(sim, { tick: 0, issuer: "blue", target: bid, kind: "ambush", rangeM: 50 });
    run(sim, 5);
    expect(blue.ambush).toBeDefined();
    submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: rid, kind: "fire", x: 10, y: 15, heightM: 0.5 });
    const ev = run(sim, 20);
    expect(blue.ambush).toBeUndefined();
    expect(ev.some((e) => e.kind === "radio" && e.key === "radio.ambushSprung")).toBe(true);
    expect(shotsOf(sim, ev, "blue")).toBeGreaterThan(0);
  });

  it("an ambush laid survives a save and load (the state is plain data)", () => {
    const input = setup(120);
    const sim = createSim(input);
    const [bid] = unitOf(sim, "blue");
    redHolds(sim);
    submitOrder(sim, { tick: 0, issuer: "blue", target: bid, kind: "ambush", rangeM: 50 });
    submitOrder(sim, { tick: 0, issuer: "blue", target: bid, kind: "defendArc", facing: 0, widthRad: 2 });
    run(sim, 3);
    expect(sim.state.unit.req(bid).ambush).toBeDefined();
    expect(sim.state.unit.req(bid).arc).toBeDefined();
    const text = JSON.stringify(serializeState(sim.state));
    const back = deserializeState(JSON.parse(text));
    expect(hashState(back)).toBe(hashState(sim.state));
    expect(back.unit.req(bid).ambush).toEqual(sim.state.unit.req(bid).ambush);
    // And the loaded battle goes on exactly as the original.
    const other = loadSim(input, saveSim(sim));
    run(sim, 10); run(other, 10);
    expect(hashState(other.state)).toBe(hashState(sim.state));
  });
});

describe("defend arc (D4b)", () => {
  /** Blue fires at will, with an arc facing `facing`; red (east of them, holding its fire) stands still. */
  function arcShots(facing: number): { sim: Sim; shots: number } {
    const sim = createSim(setup(120));
    const [bid] = unitOf(sim, "blue");
    redHolds(sim);
    submitOrder(sim, { tick: 0, issuer: "blue", target: bid, kind: "rules", fire: "free" });
    submitOrder(sim, { tick: 0, issuer: "blue", target: bid, kind: "defendArc", facing, widthRad: (120 * PI) / 180 });
    return { sim, shots: shotsOf(sim, run(sim, 20), "blue") };
  }

  it("an enemy outside the arc is not engaged on their own; one inside is", () => {
    expect(arcShots(PI).shots).toBe(0); // (arc to the west, the enemy east)
    expect(arcShots(0).shots).toBeGreaterThan(3);
  });

  it("the men face the arc", () => {
    const { sim } = arcShots(PI);
    for (const m of unitOf(sim, "blue")[1].members) expect(Math.abs(Math.abs(sim.state.transform.req(m).heading) - PI)).toBeLessThan(1e-6);
  });

  it("a move ends the arc", () => {
    const { sim } = arcShots(PI);
    const [bid, blue] = unitOf(sim, "blue");
    expect(blue.arc).toBeDefined();
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: bid, kind: "move", waypoints: [{ x: 15, y: 40, mode: "walk" }] });
    run(sim, 2);
    expect(blue.arc).toBeUndefined();
  });
});
