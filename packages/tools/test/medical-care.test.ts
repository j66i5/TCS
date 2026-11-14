/**
 * M10.2 interventions, self-aid and buddy aid (roadmap-detail slice 4): the MARCH order, training and kit, the
 * treat action in a running battle (self-aid, buddy aid within reach, interrupted by a move, items conserved,
 * nothing when care is off), save/load in the middle of a treatment, and the treatment lab's acceptance.
 */
import { describe, expect, it } from "vitest";
import { buildCatalog } from "@tcs/data";
import {
  createSim, DEFAULT_COMMS, flatMap, hashState, healthyPhysiology, loadSim, nextIntervention, saveSim, serializeState, step, submitOrder,
  type BattleInput, type Catalog, type EntityId, type SerializedState, type SimEvent, type SoldierRecord, type Wound,
} from "@tcs/sim";
import { oddsLab, selfAidLab } from "../src/labs/treatment";
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

interface Man { id: string; role?: string; x: number; y: number; wounds?: Wound[]; load?: { type: string; count: number }[]; conscious?: boolean }

function battle(men: Man[], opts: { care?: boolean; seed?: number } = {}) {
  const recs: SoldierRecord[] = men.map((m) => ({
    personId: m.id, given: "T", family: m.id, rank: "r", role: m.role ?? "grenadier", skills: { marksmanship: 0.5, medical: 0.2 },
    // (Knocked out: a head wound that takes his consciousness, no airway problem.)
    fatigue: 0, stress: 0, wounds: [...(m.wounds ?? []), ...(m.conscious === false ? [wound({ id: 9, zone: "head", severity: 0.2, consciousness: true })] : [])].map((w) => ({ ...w, treatments: [] })),
    load: (m.load ?? KIT).map((x) => ({ ...x })),
    status: (m.wounds ?? []).length > 0 ? "wounded" : "fit",
    ...(m.conscious === false ? { physiology: { ...healthyPhysiology(), consciousness: 0 } } : {}),
  }));
  const input: BattleInput = {
    map: flatMap("care-test", 120, 120, 4, "grass"), catalog, seed: opts.seed ?? 3, orders: [],
    rules: { timeLimitSeconds: 36000, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "medical", physiologyParams: {}, objectives: [], ...(opts.care === false ? { medicalCare: false } : {}) },
    forces: [{ side: "blue", faction: "de", units: [{ key: "t", callsign: "T", echelon: "team", leaderIndex: 0, subunits: [], members: recs }],
      placements: men.map((m) => ({ personId: m.id, x: m.x, y: m.y, heading: 0 })) }],
  };
  const sim = createSim(input);
  const id = (p: string): EntityId => [...sim.state.identity.entries()].find(([, i]) => i.personId === p)![0];
  const events: SimEvent[] = [];
  const run = (seconds: number) => { for (let t = 0; t < seconds * 60; t++) events.push(...step(sim)); };
  return { sim, input, id, events, run };
}

const legBleed = (l = 0.005) => wound({ zone: "legL", bleedingLps: l, compressible: true });
const count = (sim: ReturnType<typeof battle>["sim"], who: EntityId, type: string) =>
  sim.state.container.req(who).stacks.filter((s) => s.type === type).reduce((n, s) => n + s.count, 0);

describe("what comes next: MARCH order, training, kit (M10.2)", () => {
  it("a massive limb bleed first, then the airway, then the chest; under fire only the tourniquet", () => {
    const b = battle([{ id: "c", x: 50, y: 50, wounds: [
      wound({ id: 1, zone: "head", airway: true, compressible: true }), wound({ id: 2, breathing: true }), { ...legBleed(), id: 3 },
    ], load: [...KIT, { type: "de-chest-seal", count: 1 }] }]);
    const c = b.id("c"), K = b.sim.ctx.physiologyParams, st = b.sim.state;
    expect(nextIntervention(catalog, st, c, c, false, K)).toMatchObject({ intervention: "tourniquet", wound: 3, skill: "self" });
    expect(nextIntervention(catalog, st, c, c, true, K)).toMatchObject({ intervention: "tourniquet" });
    st.soldier.req(c).wounds[2]!.tourniquetS = 0; st.soldier.req(c).wounds[2]!.bleedingLps = 0;
    expect(nextIntervention(catalog, st, c, c, true, K)).toBeNull(); // nothing else is done under fire
    expect(nextIntervention(catalog, st, c, c, false, K)).toMatchObject({ intervention: "airway-positioning", wound: 1 });
    st.soldier.req(c).wounds[0]!.airwayK = 0.5;
    expect(nextIntervention(catalog, st, c, c, false, K)).toMatchObject({ intervention: "chest-seal", wound: 2 });
  });

  it("a small bleed that clots by itself is left alone; no kit, no treatment; a skill nobody has is not tried", () => {
    const b = battle([{ id: "c", x: 50, y: 50, wounds: [legBleed(0.001)] }, { id: "d", x: 60, y: 50, wounds: [legBleed()], load: [] }]);
    const K = b.sim.ctx.physiologyParams, st = b.sim.state;
    expect(nextIntervention(catalog, st, b.id("c"), b.id("c"), false, K)).toBeNull();
    expect(nextIntervention(catalog, st, b.id("d"), b.id("d"), false, K)).toBeNull();
    const t = battle([{ id: "c", x: 50, y: 50, wounds: [wound({ tension: true })], load: [{ type: "de-decompression-needle", count: 1 }] }]);
    // A rifleman cannot decompress a chest (first responders and medics only).
    expect(nextIntervention(catalog, t.sim.state, t.id("c"), t.id("c"), false, t.sim.ctx.physiologyParams)).toBeNull();
  });

  it("training per role: the Einsatzersthelfer B decompresses, but has no IO (not his training)", () => {
    const b = battle([
      { id: "c", x: 50, y: 50, wounds: [wound({ tension: true })], load: [] },
      { id: "e", role: "einsatzersthelfer", x: 51, y: 50, load: [{ type: "de-decompression-needle", count: 1 }, { type: "de-io-set", count: 1 }] },
    ]);
    const st = b.sim.state, K = b.sim.ctx.physiologyParams;
    expect(nextIntervention(catalog, st, b.id("e"), b.id("c"), false, K)).toMatchObject({ intervention: "needle-decompression", skill: "firstResponder" });
    const s = st.soldier.req(b.id("c"));
    s.wounds = [wound({})]; s.physiology.shock = 0.3;
    // Shock: IO is first in the order, but he is not trained for it; IV needs a set he has not got. A blanket is next.
    expect(nextIntervention(catalog, st, b.id("e"), b.id("c"), false, K)).toBeNull();
    st.container.req(b.id("e")).stacks.push({ type: "de-rescue-blanket", count: 1 });
    expect(nextIntervention(catalog, st, b.id("e"), b.id("c"), false, K)).toMatchObject({ intervention: "warming", skill: "firstResponder" });
  });
});

describe("care in a running battle (M10.2)", () => {
  it("self-aid: a man with a massive leg bleed puts on his own tourniquet; items are conserved", () => {
    const b = battle([{ id: "c", x: 50, y: 50, wounds: [legBleed()] }]);
    const c = b.id("c");
    b.run(120);
    const w = b.sim.state.soldier.req(c).wounds[0]!;
    const treated = b.events.filter((e) => e.kind === "medical.treated");
    expect(treated.length).toBeGreaterThan(0);
    expect(treated[0]).toMatchObject({ casualty: c, by: c, intervention: "tourniquet", skill: "self" });
    // Every record names what it used; what is gone from his kit is exactly what the records say.
    const used: Record<string, number> = {};
    for (const t of w.treatments) for (const [k, n] of Object.entries(t.itemsUsed)) used[k] = (used[k] ?? 0) + n;
    for (const it of KIT) expect(count(b.sim, c, it.type) + (used[it.type] ?? 0)).toBe(it.count);
    expect(used["de-tourniquet-cat"]).toBe(1);
    if (w.treatments[0]!.success) { expect(w.tourniquetS).toBeGreaterThan(0); expect(w.bleedingLps).toBe(0); }
  });

  it("buddy aid: an unconscious man is treated by a comrade within 3 m, with his own kit first; not by one 5 m away", () => {
    const near = battle([{ id: "c", x: 50, y: 50, wounds: [legBleed()], conscious: false }, { id: "b", x: 52, y: 50 }]);
    near.run(60);
    const t = near.events.find((e) => e.kind === "medical.treated");
    expect(t).toMatchObject({ casualty: near.id("c"), by: near.id("b"), intervention: "tourniquet", skill: "buddy" });
    expect(count(near.sim, near.id("c"), "de-tourniquet-cat")).toBe(0);
    expect(count(near.sim, near.id("b"), "de-tourniquet-cat")).toBe(1);
    const far = battle([{ id: "c", x: 50, y: 50, wounds: [legBleed()], conscious: false }, { id: "b", x: 55, y: 50 }]);
    far.run(60);
    expect(far.events.some((e) => e.kind === "medical.treated" || (e.kind === "action.started" && e.action === "treat"))).toBe(false);
  });

  it("a comrade ordered to move breaks off; care switched off does nothing", () => {
    const b = battle([{ id: "c", x: 50, y: 50, wounds: [legBleed()], conscious: false }, { id: "b", x: 52, y: 50 }]);
    b.run(5);
    expect(b.sim.state.action.get(b.id("b"))?.kind).toBe("treat");
    submitOrder(b.sim, { tick: b.sim.state.tick, issuer: "blue", target: b.id("b"), kind: "move", waypoints: [{ x: 90, y: 90, mode: "walk" }] });
    b.run(3);
    expect(b.events.some((e) => e.kind === "action.interrupted" && e.actor === b.id("b") && e.action === "treat")).toBe(true);
    expect(b.sim.state.soldier.req(b.id("c")).wounds[0]!.treatments.length).toBe(0);
    const off = battle([{ id: "c", x: 50, y: 50, wounds: [legBleed()] }], { care: false });
    off.run(60);
    expect(off.events.some((e) => e.kind === "medical.treated")).toBe(false);
  });

  it("save and load in the middle of a treatment: the battle goes on identically", () => {
    const men: Man[] = [
      { id: "c", x: 50, y: 50, wounds: [legBleed(), { ...wound({ zone: "head", airway: true, compressible: true }), id: 2 }], conscious: false },
      { id: "b", x: 52, y: 50 }, { id: "s", x: 80, y: 80, wounds: [legBleed(0.004)] },
    ];
    const a = battle(men);
    a.run(10);
    expect([...a.sim.state.action.entries()].filter(([, x]) => x.kind === "treat").length).toBe(2);
    const saved = JSON.parse(JSON.stringify(saveSim(a.sim))) as SerializedState;
    const again = loadSim(a.input, saved);
    for (let t = 0; t < 300 * 60; t++) { step(a.sim); step(again); }
    expect(hashState(again.state)).toBe(hashState(a.sim.state));
    // And the same battle from the start gives the same result (determinism).
    const b = battle(men);
    b.run(310);
    expect(JSON.stringify(serializeState(b.sim.state))).toBe(JSON.stringify(serializeState(a.sim.state)));
    expect(a.sim.state.soldier.req(a.id("c")).wounds.flatMap((w) => w.treatments).length).toBeGreaterThan(1);
  });
});

describe("treatment lab (acceptance, M10.2)", () => {
  it("each cell's success and time match the data (within 3 standard errors)", () => {
    const rows = oddsLab(data, 300);
    expect(rows.length).toBeGreaterThan(30);
    for (const r of rows) {
      const se = Math.sqrt((r.expectedP * (1 - r.expectedP)) / r.trials);
      expect(Math.abs(r.measuredP - r.expectedP), `${r.intervention} ${r.skill} ${r.item}`).toBeLessThanOrEqual(3 * se + 0.005);
      expect(r.measuredS).toBeCloseTo(r.expectedS, 1);
    }
  }, 60_000);

  it("self-applied tourniquets cut limb-bleed deaths at 10 minutes to a third or less", () => {
    const r = selfAidLab(data, 300);
    expect(r.deadNoCare10).toBeGreaterThan(20);
    expect(r.deadCare10).toBeLessThanOrEqual(r.deadNoCare10 / 3);
  }, 120_000);
});
