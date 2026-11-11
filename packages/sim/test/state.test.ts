import { describe, expect, it } from "vitest";
import { createSim, deserializeState, hashState, loadSim, saveSim, serializeState, step, Store, submitOrder } from "../src/index";
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

  it("refuses to save NaN or Infinity, naming where it is", () => {
    const sim = createSim(testInput());
    sim.state.transform.req(2).x = Number.NaN;
    expect(() => serializeState(sim.state)).toThrow(/non-finite number NaN at state\.stores\.transform\[\d+\]\[1\]\.x/);
    expect(() => hashState(sim.state)).toThrow(/non-finite/);
  });

  it("normalises -0 so a save round trip is exact", () => {
    const sim = createSim(testInput());
    sim.state.transform.req(2).heading = -0;
    const back = deserializeState(JSON.parse(JSON.stringify(serializeState(sim.state))));
    expect(hashState(back)).toBe(hashState(sim.state));
    expect(Object.is(back.transform.req(2).heading, 0)).toBe(true);
  });

  it("refuses to load a save made with different data", () => {
    const input = testInput();
    const sim = createSim(input);
    const save = saveSim(sim);
    expect(save.catalogFingerprint).toBe("test");
    expect(() => loadSim({ ...input, catalog: { ...input.catalog, fingerprint: "other" } }, save)).toThrow(/made with data test/);
  });

  it("rejects saves from a different schema version", () => {
    const sim = createSim(testInput());
    const ser = serializeState(sim.state);
    expect(() => deserializeState({ ...ser, schema: 999 })).toThrow(/schema/);
  });
});
