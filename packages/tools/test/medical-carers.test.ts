/**
 * M10.3a who helps (roadmap-detail slice 6): carers and first responders. A casualty nobody beside him can help gets
 * a willing comrade, and when he looks urgent the first responder of his platoon; at most the first responder plus
 * one comrade per casualty (owner Q-2a); leaders stay with their men; a frightened man does not go; unit orders pass
 * a carer by, an order to him alone ends the errand; a downed man with a carer does not give up; save/load mid-errand.
 */
import { describe, expect, it } from "vitest";
import { buildCatalog } from "@tcs/data";
import {
  careNeed, createSim, DEFAULT_COMMS, flatMap, hashState, healthyPhysiology, loadSim, saveSim, step, submitOrder,
  type BattleInput, type Catalog, type EntityId, type SerializedState, type SimEvent, type SoldierRecord, type Wound,
} from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData();
const catalog: Catalog = buildCatalog(data, ["de", "ru"]);

const wound = (extra: Partial<Wound>): Wound => ({
  id: 1, zone: "chest", mechanism: "bullet", severity: 0.4, bleedingLps: 0, compressible: false, airway: false, breathing: false,
  consciousness: false, tickInflicted: 0, treatments: [], ...extra,
});
const KIT = [
  { type: "de-tourniquet-cat", count: 1 }, { type: "de-pressure-dressing", count: 2 }, { type: "de-hemostatic-gauze", count: 1 },
  { type: "de-rescue-blanket", count: 1 }, { type: "de-pain-tablets", count: 1 },
];
const legBleed = (l = 0.005) => wound({ zone: "legL", bleedingLps: l, compressible: true });

interface Man { id: string; role?: string; x: number; y: number; wounds?: Wound[]; conscious?: boolean; team?: number }

/** Blue men in one or two teams (team 0's first man leads it; team 1 is a second team, led by its first man). */
function battle(men: Man[], opts: { care?: boolean } = {}) {
  const rec = (m: Man): SoldierRecord => ({
    personId: m.id, given: "T", family: m.id, rank: "r", role: m.role ?? "grenadier", skills: { marksmanship: 0.5, medical: 0.2 },
    fatigue: 0, stress: 0,
    wounds: [...(m.wounds ?? []), ...(m.conscious === false ? [wound({ id: 9, zone: "head", severity: 0.2, consciousness: true })] : [])].map((w) => ({ ...w, treatments: [] })),
    load: KIT.map((x) => ({ ...x })),
    status: (m.wounds ?? []).length > 0 ? "wounded" : "fit",
    ...(m.conscious === false ? { physiology: { ...healthyPhysiology(), consciousness: 0 } } : {}),
  });
  const teams = [0, 1].map((k) => men.filter((m) => (m.team ?? 0) === k)).filter((t) => t.length > 0);
  const input: BattleInput = {
    map: flatMap("carer-test", 300, 300, 4, "grass"), catalog, seed: 5, orders: [],
    rules: { timeLimitSeconds: 36000, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "medical", physiologyParams: {}, objectives: [], ...(opts.care === false ? { medicalCare: false } : {}) },
    forces: [{ side: "blue", faction: "de", units: teams.map((t, k) => ({ key: `t${k}`, callsign: `T${k}`, echelon: "team" as const, leaderIndex: 0, subunits: [], members: t.map(rec) })),
      placements: men.map((m) => ({ personId: m.id, x: m.x, y: m.y, heading: 0 })) }],
  };
  const sim = createSim(input);
  const id = (p: string): EntityId => [...sim.state.identity.entries()].find(([, i]) => i.personId === p)![0];
  const events: SimEvent[] = [];
  const run = (seconds: number) => { for (let t = 0; t < seconds * 60; t++) events.push(...step(sim)); };
  return { sim, input, id, events, run };
}

const assigned = (ev: SimEvent[]) => ev.filter((e): e is Extract<SimEvent, { kind: "medical.carer" }> => e.kind === "medical.carer" && e.assigned);

describe("who helps: carers and first responders (M10.3a)", () => {
  it("what a casualty needs, and whether he looks urgent", () => {
    const b = battle([{ id: "l", x: 10, y: 10 }, { id: "c", x: 50, y: 50, wounds: [legBleed()] }, { id: "p", x: 60, y: 50, wounds: [wound({ zone: "armL", severity: 0.1, fracture: true })] }]);
    const K = b.sim.ctx.physiologyParams;
    expect(careNeed(catalog, b.sim.state, b.id("c"), K)).toEqual({ urgent: true });
    expect(careNeed(catalog, b.sim.state, b.id("p"), K)).toEqual({ urgent: false });
    expect(careNeed(catalog, b.sim.state, b.id("l"), K)).toBeNull();
  });

  it("a comrade 15 m away runs over, treats him, and goes back when there is nothing more he can do", () => {
    const b = battle([{ id: "l", x: 10, y: 10 }, { id: "c", x: 50, y: 50, wounds: [legBleed()], conscious: false }, { id: "m", x: 65, y: 50 }]);
    const m = b.id("m"), c = b.id("c");
    b.run(2);
    expect(assigned(b.events)[0]).toMatchObject({ casualty: c, by: m, responder: false });
    expect(b.sim.state.soldier.req(m).intent).toMatchObject({ kind: "care", target: c });
    b.run(120);
    const t = b.events.find((e) => e.kind === "medical.treated");
    expect(t).toMatchObject({ casualty: c, by: m, intervention: "tourniquet", skill: "buddy" });
    b.run(600);
    expect(b.events.some((e) => e.kind === "medical.carer" && !e.assigned && e.by === m)).toBe(true);
    expect(b.sim.state.soldier.req(m).intent).toBeNull();
  });

  it("an urgent casualty: his first responder comes from 80 m, plus one comrade at most (owner Q-2a); leaders stay", () => {
    const b = battle([
      { id: "l", x: 56, y: 50 }, // the leader, closest of all (beyond buddy reach): he stays with his men
      { id: "c", x: 50, y: 50, wounds: [legBleed()], conscious: false },
      { id: "a", x: 60, y: 50 }, { id: "b2", x: 62, y: 50 }, { id: "d", x: 64, y: 50 },
      { id: "e", role: "einsatzersthelfer", x: 130, y: 50 },
    ]);
    b.run(2);
    const as = assigned(b.events);
    expect(as.map((x) => [x.by, x.responder])).toEqual([[b.id("e"), true], [b.id("a"), false]]);
    // The cap holds as long as he needs care.
    for (let k = 0; k < 60; k++) {
      b.run(2);
      const comrades = [...b.sim.state.soldier.entries()].filter(([, s]) => s.intent?.kind === "care" && s.intent.responder !== true).length;
      expect(comrades).toBeLessThanOrEqual(1);
    }
    expect(b.events.some((e) => e.kind === "medical.carer" && e.assigned && e.by === b.id("l"))).toBe(false);
  });

  it("a frightened man does not go; a calm man of another team does", () => {
    const b = battle([{ id: "l", x: 10, y: 10 }, { id: "c", x: 50, y: 50, wounds: [legBleed()], conscious: false }, { id: "m", x: 60, y: 50 }]);
    const s = b.sim.state.soldier.req(b.id("m"));
    s.mental.suppression = 0.6; s.mental.behaviour = "pinned";
    b.run(3);
    expect(assigned(b.events)).toHaveLength(0);
    // A man of another team: 0.5 x 0.6 = 0.3, still willing when calm (willingAt 0.25).
    const o = battle([{ id: "l", x: 10, y: 10 }, { id: "c", x: 50, y: 50, wounds: [legBleed()], conscious: false }, { id: "k", x: 200, y: 200, team: 1 }, { id: "m", x: 60, y: 50, team: 1 }]);
    o.run(2);
    expect(assigned(o.events)[0]).toMatchObject({ by: o.id("m") });
  });

  it("an order to his unit passes the carer by; an order to him alone ends the errand", () => {
    const b = battle([{ id: "l", x: 10, y: 10 }, { id: "c", x: 50, y: 50, wounds: [legBleed()], conscious: false }, { id: "m", x: 80, y: 50 }, { id: "n", x: 20, y: 10 }]);
    const m = b.id("m"), unit = b.sim.state.identity.req(m).unit;
    b.run(2);
    expect(b.sim.state.soldier.req(m).intent?.kind).toBe("care");
    submitOrder(b.sim, { tick: b.sim.state.tick, issuer: "blue", target: unit, kind: "move", waypoints: [{ x: 250, y: 250, mode: "walk" }] });
    b.run(3);
    expect(b.sim.state.soldier.req(m).intent?.kind).toBe("care");
    submitOrder(b.sim, { tick: b.sim.state.tick, issuer: "blue", target: m, kind: "move", waypoints: [{ x: 250, y: 250, mode: "walk" }] });
    b.run(1);
    expect(b.sim.state.soldier.req(m).intent).toBeNull();
  });

  it("care switched off: nobody goes", () => {
    const b = battle([{ id: "l", x: 10, y: 10 }, { id: "c", x: 50, y: 50, wounds: [legBleed()], conscious: false }, { id: "m", x: 60, y: 50 }], { care: false });
    b.run(30);
    expect(b.events.some((e) => e.kind === "medical.carer")).toBe(false);
  });

  it("save and load on the way: the battle goes on identically", () => {
    const men: Man[] = [{ id: "l", x: 10, y: 10 }, { id: "c", x: 50, y: 50, wounds: [legBleed()], conscious: false }, { id: "m", x: 80, y: 50 }, { id: "e", role: "einsatzersthelfer", x: 120, y: 80 }];
    const a = battle(men);
    a.run(4);
    expect([...a.sim.state.soldier.entries()].filter(([, s]) => s.intent?.kind === "care").length).toBe(2);
    const saved = JSON.parse(JSON.stringify(saveSim(a.sim))) as SerializedState;
    const again = loadSim(a.input, saved);
    for (let t = 0; t < 200 * 60; t++) { step(a.sim); step(again); }
    expect(hashState(again.state)).toBe(hashState(a.sim.state));
  });
});
