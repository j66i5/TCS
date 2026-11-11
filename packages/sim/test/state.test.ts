import { describe, expect, it } from "vitest";
import { createSim, deserializeState, hashState, serializeState, step, Store, submitOrder } from "../src/index";
import { testInput } from "./helpers";

describe("serialisable state", () => {
  it("round-trips through JSON with an identical hash", () => {
    const sim = createSim(testInput());
    submitOrder(sim, { tick: 0, issuer: "blue", target: 1, kind: "move", waypoints: [{ x: 100, y: 100, mode: "run" }] });
    for (let i = 0; i < 300; i++) step(sim);
    const text = JSON.stringify(serializeState(sim.state));
    const back = deserializeState(JSON.parse(text));
    expect(hashState(back)).toBe(hashState(sim.state));
    expect(JSON.stringify(serializeState(back))).toBe(text);
  });

  it("hash changes when anything changes", () => {
    const sim = createSim(testInput());
    const h = hashState(sim.state);
    sim.state.transform.req(2).x += 1e-9;
    expect(hashState(sim.state)).not.toBe(h);
  });

  it("stores iterate in entity-ID order even after remove/re-add", () => {
    const s = new Store<string>();
    s.set(1, "a"); s.set(2, "b"); s.set(3, "c");
    s.delete(1); s.set(1, "a2");
    expect([...s.keys()]).toEqual([1, 2, 3]);
  });

  it("rejects saves from a different schema version", () => {
    const sim = createSim(testInput());
    const ser = serializeState(sim.state);
    expect(() => deserializeState({ ...ser, schema: 999 })).toThrow(/schema/);
  });
});
