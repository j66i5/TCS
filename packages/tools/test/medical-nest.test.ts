/**
 * M10.5 the Verwundetennest and the platoon medic (roadmap-detail slice 11). A platoon's nest is sited behind it,
 * away from the enemy its men know (else toward the nearest edge), on ground wheeled vehicles reach; the platoon
 * leader tasks two riflemen to carry a man who cannot walk there, a walking wounded man walks there himself, and the
 * platoon medic sees to the men there and triages them again. The player moves the nest (`casualtyPoint`) and sends a
 * man back (`evacuate`). A known enemy close to it moves it. Save/load mid-carry.
 */
import { describe, expect, it } from "vitest";
import { buildCatalog } from "@tcs/data";
import {
  createSim, DEFAULT_COMMS, flatMap, hashState, loadSim, needsEvacuation, saveSim, step, submitOrder,
  type BattleInput, type Catalog, type EntityId, type SerializedState, type SimEvent, type SoldierRecord, type Wound,
} from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData();
const catalog: Catalog = buildCatalog(data, ["de", "ru"]);

const wound = (extra: Partial<Wound>): Wound => ({
  id: 1, zone: "chest", mechanism: "bullet", severity: 0.2, bleedingLps: 0, compressible: false, airway: false, breathing: false,
  consciousness: false, tickInflicted: 0, treatments: [], ...extra,
});
const KIT = [
  { type: "de-tourniquet-cat", count: 1 }, { type: "de-pressure-dressing", count: 2 }, { type: "de-rescue-blanket", count: 1 }, { type: "de-pain-tablets", count: 1 },
];
const brokenLeg = () => wound({ zone: "legL", severity: 0.3, fracture: true });

interface Man { id: string; role?: string; x: number; y: number; wounds?: Wound[] }

/** A platoon on a flat 1000 m map: its HQ (leader, medic) and one squad of `squad` men; the west edge is nearest. */
function battle(squad: Man[], opts: { hq?: Man[] } = {}) {
  const rec = (m: Man): SoldierRecord => ({
    personId: m.id, given: "T", family: m.id, rank: "r", role: m.role ?? "grenadier", skills: { marksmanship: 0.5, medical: 0.2 },
    fatigue: 0, stress: 0, wounds: (m.wounds ?? []).map((w) => ({ ...w, treatments: [] })), load: KIT.map((x) => ({ ...x })),
    status: (m.wounds ?? []).length > 0 ? "wounded" : "fit",
  });
  const hq = opts.hq ?? [{ id: "pl", x: 330, y: 500 }, { id: "san", role: "sanitaeter", x: 332, y: 506 }];
  const map = flatMap("nest-test", 1000, 1000, 4, "grass");
  const input: BattleInput = {
    map, catalog, seed: 7, orders: [],
    rules: { timeLimitSeconds: 36000, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "medical", physiologyParams: {}, objectives: [] },
    forces: [{
      side: "blue", faction: "de",
      units: [{ key: "p", callsign: "P", echelon: "platoon" as const, leaderIndex: 0, members: hq.map(rec),
        subunits: [{ key: "s1", callsign: "S1", echelon: "squad" as const, leaderIndex: 0, subunits: [], members: squad.map(rec) }] }],
      placements: [...hq, ...squad].map((m) => ({ personId: m.id, x: m.x, y: m.y, heading: 0 })),
    }],
  };
  const sim = createSim(input);
  const id = (p: string): EntityId => [...sim.state.identity.entries()].find(([, i]) => i.personId === p)![0];
  const events: SimEvent[] = [];
  const run = (seconds: number) => { for (let t = 0; t < seconds * 60; t++) events.push(...step(sim)); };
  return { sim, input, id, events, run };
}

const of = <K extends SimEvent["kind"]>(ev: SimEvent[], k: K) => ev.filter((e): e is Extract<SimEvent, { kind: K }> => e.kind === k);
const riflemen = (n: number, x0 = 350): Man[] => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, x: x0 + (i % 4) * 4, y: 480 + Math.floor(i / 4) * 4 }));

describe("Verwundetennest (M10.5)", () => {
  it("who is taken back: out of the fight, or ordered back", () => {
    const b = battle([{ id: "sl", x: 350, y: 470 }, ...riflemen(5), { id: "c", x: 352, y: 500, wounds: [brokenLeg()] }, { id: "g", x: 356, y: 500, wounds: [wound({ zone: "armL", severity: 0.05 })] }]);
    const st = b.sim.state;
    expect(needsEvacuation(st.soldier.req(b.id("c")))).toBe(true); // he cannot walk
    expect(needsEvacuation(st.soldier.req(b.id("g")))).toBe(false); // a scratch: he fights on
    st.soldier.req(b.id("g")).evacOrdered = true;
    expect(needsEvacuation(st.soldier.req(b.id("g")))).toBe(true);
    expect(needsEvacuation(st.soldier.req(b.id("r0")))).toBe(false); // not wounded
  });

  it("is sited behind the platoon on open ground; two riflemen carry a man who cannot walk there; the medic sees to him", () => {
    const b = battle([{ id: "sl", x: 350, y: 470 }, ...riflemen(7), { id: "c", x: 360, y: 500, wounds: [brokenLeg()] }]);
    b.run(1);
    const sited = of(b.events, "medical.nest");
    expect(sited.length).toBe(1);
    expect(sited[0]!.reason).toBe("sited");
    // Toward the nearest edge (west), 100-200 m back from the platoon's centre.
    const p = b.sim.state.rear.req(sited[0]!.point);
    expect(p.kind).toBe("medical");
    expect(p.x).toBeLessThan(260);
    expect(p.x).toBeGreaterThan(130);
    expect(of(b.events, "radio").some((e) => e.key === "radio.nestSited")).toBe(true);
    b.run(1);
    const tasked = of(b.events, "medical.evac").filter((e) => e.phase === "tasked");
    expect(tasked.length).toBe(1);
    expect(tasked[0]!.bearers).toBe(2);
    expect(tasked[0]!.by).toBe(b.id("pl"));
    // The bearers: riflemen, not the squad leader, not the medic.
    const party = b.sim.state.carry.get(b.id("c"))!;
    expect(party.point).toBe(sited[0]!.point);
    for (const m of party.carriers) { expect(m).not.toBe(b.id("sl")); expect(m).not.toBe(b.id("san")); }
    b.run(600);
    const c = b.sim.state.soldier.req(b.id("c"));
    expect(c.atNest).toBe(sited[0]!.point);
    const ct = b.sim.state.transform.req(b.id("c"));
    expect(Math.hypot(ct.x - p.x, ct.y - p.y)).toBeLessThanOrEqual(catalog.medical!.nest!.arriveM);
    expect(of(b.events, "medical.evac").some((e) => e.phase === "arrived" && e.casualty === b.id("c"))).toBe(true);
    // The bearers went back to their squad leader.
    for (const m of party.carriers) {
      const t = b.sim.state.transform.req(m), l = b.sim.state.transform.req(b.id("sl"));
      expect(b.sim.state.soldier.req(m).carrying).toBeUndefined();
      expect(Math.hypot(t.x - l.x, t.y - l.y)).toBeLessThan(40);
    }
    // The medic went there and tagged him with a medic's training.
    expect(of(b.events, "medical.carer").some((e) => e.by === b.id("san") && e.casualty === b.id("c") && e.assigned)).toBe(true);
    expect(c.triage?.skill).toBe("medic");
  });

  it("a walking wounded man walks there himself; the player's evacuate order sends back a man who could still fight", () => {
    const b = battle([{ id: "sl", x: 350, y: 470 }, ...riflemen(6), { id: "w", x: 358, y: 500, wounds: [wound({ zone: "armR", severity: 0.9 })] }, { id: "g", x: 362, y: 500, wounds: [wound({ zone: "legR", severity: 0.05 })] }]);
    const st = b.sim.state;
    expect(st.soldier.req(b.id("w")).impair.canWalk).toBe(true);
    expect(needsEvacuation(st.soldier.req(b.id("w")))).toBe(true); // an arm he cannot fight with
    b.run(2);
    expect(of(b.events, "medical.evac").some((e) => e.phase === "walks" && e.casualty === b.id("w"))).toBe(true);
    expect(st.carry.get(b.id("w"))?.carriers.length).toBe(0);
    // An order to a unit is not an evacuation; to the man it is.
    submitOrder(b.sim, { tick: st.tick, issuer: "blue", target: st.identity.req(b.id("g")).unit, kind: "evacuate" });
    b.run(1);
    expect(of(b.events, "order.rejected").some((e) => e.reason === "invalid-params")).toBe(true);
    submitOrder(b.sim, { tick: st.tick, issuer: "blue", target: b.id("g"), kind: "evacuate", player: true });
    b.run(2);
    expect(of(b.events, "medical.evac").some((e) => e.phase === "walks" && e.casualty === b.id("g") && e.ordered === true)).toBe(true);
    b.run(400);
    expect(st.soldier.req(b.id("w")).atNest).toBeDefined();
    // Ordered back with a scratch, he is fit to fight at the nest: he goes back to his squad (returned to duty).
    expect(of(b.events, "medical.evac").some((e) => e.phase === "returned" && e.casualty === b.id("g"))).toBe(true);
    expect(st.soldier.req(b.id("g")).atNest).toBeUndefined();
    expect(st.soldier.req(b.id("g")).evacOrdered).toBeUndefined();
  });

  it("the player moves it (it stays there); a known enemy close to an automatic one moves it", () => {
    const b = battle([{ id: "sl", x: 350, y: 470 }, ...riflemen(7), { id: "c", x: 360, y: 500, wounds: [brokenLeg()] }]);
    b.run(2);
    const pid = of(b.events, "medical.nest")[0]!.point;
    const st = b.sim.state;
    submitOrder(b.sim, { tick: st.tick, issuer: "blue", target: b.id("r0"), kind: "casualtyPoint", x: 340, y: 700, player: true });
    b.run(1);
    const moved = of(b.events, "medical.nest").filter((e) => e.reason === "ordered");
    expect(moved.length).toBe(1);
    const p = st.rear.req(pid);
    expect(p.placed).toBe(true);
    expect(Math.hypot(p.x - 340, p.y - 700)).toBeLessThan(3);
    // The party on its way turns to the new place.
    expect(st.carry.get(b.id("c"))?.dest.y).toBeCloseTo(p.y, 0);
    // A known enemy beside a placed nest: it stays.
    const r0 = st.soldier.req(b.id("r0"));
    r0.contacts.push({ target: 9999, x: p.x + 20, y: p.y, errM: 5, kind: "seen", tick: st.tick, reportedTick: st.tick });
    b.run(12);
    expect(of(b.events, "medical.nest").filter((e) => e.reason === "threatened").length).toBe(0);
    // An automatic nest moves away from him.
    delete p.placed;
    p.checkTick = -1e9;
    b.run(2);
    const th = of(b.events, "medical.nest").filter((e) => e.reason === "threatened");
    expect(th.length).toBe(1);
    expect(Math.hypot(th[0]!.x - (p.x + 20), th[0]!.y - p.y)).toBeGreaterThan(0);
  });

  it("orders for the nest are validated", () => {
    const b = battle([{ id: "sl", x: 350, y: 470 }, ...riflemen(3)]);
    const st = b.sim.state;
    submitOrder(b.sim, { tick: 0, issuer: "blue", target: b.id("sl"), kind: "casualtyPoint", x: -5, y: 10 });
    b.run(1);
    expect(of(b.events, "order.rejected").filter((e) => e.reason === "invalid-params").length).toBe(1);
    // A man who is not wounded cannot be evacuated (nobody to carry back).
    submitOrder(b.sim, { tick: st.tick, issuer: "blue", target: b.id("r0"), kind: "evacuate" });
    b.run(1);
    expect(of(b.events, "radio").some((e) => e.key === "radio.unable")).toBe(true);
  });

  it("save and load mid-carry give the same battle", () => {
    const b = battle([{ id: "sl", x: 350, y: 470 }, ...riflemen(7), { id: "c", x: 360, y: 500, wounds: [brokenLeg()] }]);
    b.run(60);
    expect(b.sim.state.carry.get(b.id("c"))?.point).toBeDefined();
    const saved = JSON.parse(JSON.stringify(saveSim(b.sim))) as SerializedState;
    const again = loadSim(b.input, saved);
    for (let t = 0; t < 120 * 60; t++) { step(b.sim); step(again); }
    expect(hashState(again.state)).toBe(hashState(b.sim.state));
    // An older save (schema 19, no rear points) still loads.
    const old = JSON.parse(JSON.stringify(saved)) as SerializedState & { stores: Record<string, unknown> };
    old.schema = 19; delete (old.stores as Record<string, unknown>)["rear"];
    expect(() => loadSim(b.input, old)).not.toThrow();
  });
});
