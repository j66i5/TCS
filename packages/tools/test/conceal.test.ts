/**
 * Sight realism, step 3 (2026-11-15): hidden men stay hidden. Vegetation hides more, a still man blends into
 * vegetation around him (backdrop, conspicuity), a man seen is kept only while he is active, crawling and firing at
 * range show less, dark rooms hide a man. Open ground close in front is unchanged. Small seed counts: the full tables
 * are in `npm run lab -- spotting` and DECISIONS "Sight realism, step 3".
 */
import { describe, expect, it } from "vitest";
import { buildCatalog } from "@tcs/data";
import { createSim, DEFAULT_COMMS, flatMap, step, submitOrder, type BattleInput, type MapDef } from "@tcs/sim";
import { retainCase, sightCase } from "../src/labs/spotting";
import { loadData } from "../src/scenarios";

const cat = buildCatalog(loadData(), ["de", "ru"]);

describe("sight realism step 3: concealment", () => {
  it("a man lying still behind 4 m of crops at 100 m is rarely found within 10 s; standing in the open at 100 m he is found within 2 s", () => {
    const crops = sightCase(cat, { name: "c", rangeM: 100, posture: "prone", action: "still", veg: "crops", depthM: 4, seeds: 10 });
    expect(crops.within10).toBeLessThanOrEqual(2);
    const open = sightCase(cat, { name: "o", rangeM: 100, posture: "standing", action: "still", seeds: 6 });
    expect(open.found).toBe(6);
    expect(open.medianS!).toBeLessThanOrEqual(2);
  });

  it("standing 2 m inside a treeline at 100 m takes at least three times as long as in the open", () => {
    const tree = sightCase(cat, { name: "t", rangeM: 100, posture: "standing", action: "still", veg: "treeline", depthM: 2, seeds: 20 });
    expect(tree.medianS ?? 999).toBeGreaterThanOrEqual(6);
  });

  it("a man seen who then lies still behind scrub at 300 m is soon lost; in the open at 100 m he is kept", () => {
    const scrub = retainCase(cat, "scrub", 300, 8);
    expect(scrub.seenAtStop).toBeGreaterThan(0);
    expect(scrub.lost20).toBeGreaterThanOrEqual(Math.ceil(0.6 * scrub.seenAtStop));
    const open = retainCase(cat, null, 100, 8);
    expect(open.kept60).toBeGreaterThanOrEqual(Math.ceil(0.75 * open.seenAtStop));
  });

  it("conspicuity: drawn from its own stream once a man holds still in vegetation, again after he moves on; movedTick follows his walking", () => {
    const map: MapDef = flatMap("c", 300, 200, 2);
    map.vegetationPalette.push("crops");
    for (let i = 0; i < map.vegetation.length; i++) map.vegetation[i] = 1;
    const man = (personId: string, weapon: string, mag: string) => ({ personId, given: "L", family: personId, rank: "r", role: "rifleman", skills: { marksmanship: 0.5 }, weapon, fatigue: 0, stress: 0, wounds: [], status: "fit" as const, load: [{ type: mag, count: 2, charge: 30 }] });
    const input: BattleInput = {
      map, catalog: cat, seed: 11, orders: [],
      rules: { timeLimitSeconds: 120, commsModel: "simple", comms: { ...DEFAULT_COMMS }, physiologyModel: "none", physiologyParams: {}, objectives: [] },
      forces: [
        { side: "blue", faction: "de", units: [{ key: "o", callsign: "O", echelon: "team", leaderIndex: 0, subunits: [], members: [man("o", "de-g36", "de-g36-mag")] }], placements: [{ personId: "o", x: 20, y: 100, heading: 0 }] },
        { side: "red", faction: "ru", units: [{ key: "t", callsign: "T", echelon: "team", leaderIndex: 0, subunits: [], members: [man("t", "ru-ak74m", "ru-ak74-mag")] }], placements: [{ personId: "t", x: 220, y: 100, heading: Math.PI }] },
      ],
    };
    const sim = createSim(input);
    const ids = [...sim.state.identity.entries()];
    const tid = ids.find(([, i]) => i.side === "red")![0];
    for (const [uid, u] of sim.state.unit.entries()) if (u.parent === null) submitOrder(sim, { tick: 0, issuer: u.side, target: uid, kind: "rules", fire: "hold" });
    for (let k = 0; k < 120; k++) step(sim);
    const ts = sim.state.soldier.req(tid);
    expect(ts.consp).toBeGreaterThan(0);
    expect(sim.state.rng.streams["conspicuity"]).toBeDefined();
    const first = ts.consp, at = { x: ts.conspX, y: ts.conspY };
    expect(ts.movedTick).toBeUndefined();
    submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: tid, kind: "move", waypoints: [{ x: 220, y: 112, mode: "walk" }] });
    for (let k = 0; k < 20 * 60; k++) step(sim);
    expect(ts.movedTick).toBeGreaterThan(120);
    expect(ts.conspY).not.toBe(at.y);
    expect(ts.consp).not.toBe(first);
  });

  it("firing at 400 m by day shows a man less than firing close by (the reveal falls with range)", () => {
    const open = sightCase(cat, { name: "f", rangeM: 400, posture: "prone", action: "fire", seeds: 10 });
    expect(open.medianS ?? 999).toBeGreaterThanOrEqual(7);
  });
});
