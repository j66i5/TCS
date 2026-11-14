/**
 * M10.3b triage, care under fire, "Medic!" (roadmap-detail slice 7). The man who treats a casualty tags him T1/T2/T3,
 * sometimes wrongly at the data's rates; a man of higher training tags him again. Under fire a carer with nothing he
 * may do drags a casualty who cannot move himself to the nearest hidden spot, and care goes on there. The unit calls
 * "Medic!" for an urgent casualty and "Man down, treating" when a comrade starts on him. Save/load mid-drag.
 */
import { describe, expect, it } from "vitest";
import { buildCatalog } from "@tcs/data";
import {
  createSim, DEFAULT_COMMS, flatMap, hashState, healthyPhysiology, lifeThreatNeed, loadSim, saveSim, step, triageTag, trueTriage,
  type BattleInput, type Catalog, type EntityId, type MapDef, type SerializedState, type SimEvent, type SoldierRecord, type Wound,
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
  { type: "de-rescue-blanket", count: 1 }, { type: "de-pain-tablets", count: 1 }, { type: "de-chest-seal", count: 1 },
];
const legBleed = (l = 0.005) => wound({ zone: "legL", bleedingLps: l, compressible: true });
const openChest = () => wound({ id: 2, zone: "chest", breathing: true, severity: 0.3 });

interface Man { id: string; role?: string; x: number; y: number; wounds?: Wound[]; conscious?: boolean }

function battle(men: Man[], opts: { map?: (m: MapDef) => void } = {}) {
  const rec = (m: Man): SoldierRecord => ({
    personId: m.id, given: "T", family: m.id, rank: "r", role: m.role ?? "grenadier", skills: { marksmanship: 0.5, medical: 0.2 },
    fatigue: 0, stress: 0,
    wounds: [...(m.wounds ?? []), ...(m.conscious === false ? [wound({ id: 9, zone: "head", severity: 0.2, consciousness: true })] : [])].map((w) => ({ ...w, treatments: [] })),
    load: KIT.map((x) => ({ ...x })),
    status: (m.wounds ?? []).length > 0 ? "wounded" : "fit",
    ...(m.conscious === false ? { physiology: { ...healthyPhysiology(), consciousness: 0 } } : {}),
  });
  const map = flatMap("triage-test", 300, 300, 4, "grass");
  opts.map?.(map);
  const input: BattleInput = {
    map, catalog, seed: 5, orders: [],
    rules: { timeLimitSeconds: 36000, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "medical", physiologyParams: {}, objectives: [] },
    forces: [{ side: "blue", faction: "de", units: [{ key: "t0", callsign: "T0", echelon: "team" as const, leaderIndex: 0, subunits: [], members: men.map(rec) }],
      placements: men.map((m) => ({ personId: m.id, x: m.x, y: m.y, heading: 0 })) }],
  };
  const sim = createSim(input);
  const id = (p: string): EntityId => [...sim.state.identity.entries()].find(([, i]) => i.personId === p)![0];
  const events: SimEvent[] = [];
  let fire: { from: EntityId } | null = null;
  const run = (seconds: number) => {
    for (let t = 0; t < seconds * 60; t++) {
      // Under fire from the east: the unit is fired on, and the rounds come from there.
      if (fire) {
        const st = sim.state, uid = st.identity.req(fire.from).unit;
        st.unit.req(uid).ownFireTick = st.tick;
        for (const [, s] of st.soldier.entries()) s.fireFrom = { dx: 1, dy: 0, tick: st.tick };
      }
      events.push(...step(sim));
    }
  };
  return { sim, input, id, events, run, underFire: (on: boolean) => { fire = on ? { from: sim.state.unit.entries().next().value![1].members[0]! } : null; } };
}

const of = <K extends SimEvent["kind"]>(ev: SimEvent[], k: K) => ev.filter((e): e is Extract<SimEvent, { kind: K }> => e.kind === k);

describe("triage, care under fire, Medic! (M10.3b)", () => {
  it("the true category: T1 for massive bleeding or the unconscious, T2 for a broken leg, T3 for a light wound", () => {
    const b = battle([
      { id: "l", x: 10, y: 10 }, { id: "a", x: 50, y: 50, wounds: [legBleed()] }, { id: "u", x: 60, y: 50, wounds: [wound({ severity: 0.1 })], conscious: false },
      { id: "f", x: 70, y: 50, wounds: [wound({ zone: "legR", severity: 0.3, fracture: true })] }, { id: "g", x: 80, y: 50, wounds: [wound({ zone: "armL", severity: 0.05 })] },
    ]);
    const K = b.sim.ctx.physiologyParams, st = b.sim.state;
    expect(trueTriage(catalog, st, b.id("a"), K)).toBe(1);
    expect(trueTriage(catalog, st, b.id("u"), K)).toBe(1);
    expect(trueTriage(catalog, st, b.id("f"), K)).toBe(2);
    expect(trueTriage(catalog, st, b.id("g"), K)).toBe(3);
    expect(lifeThreatNeed(catalog, st, b.id("a"), K)).toBe(true);
    expect(lifeThreatNeed(catalog, st, b.id("f"), K)).toBe(false);
  });

  it("wrong tags at the data's rates by training, more under fire; one category off", () => {
    const T = catalog.medical!.triage, N = 2000;
    for (const skill of ["buddy", "firstResponder", "medic"] as const) {
      for (const fire of [false, true]) {
        let wrong = 0;
        for (let i = 0; i < N; i++) {
          const actual = ((i % 3) + 1) as 1 | 2 | 3;
          const tag = triageTag(catalog, actual, skill, fire, (i + 0.5) / N, ((i * 7919) % N) / N);
          expect(Math.abs(tag - actual)).toBeLessThanOrEqual(1);
          if (tag !== actual) wrong++;
        }
        expect(wrong / N).toBeCloseTo((T.errorChance[skill] ?? 0) + (fire ? T.underFireAdd : 0), 2);
      }
    }
  });

  it("a comrade tags the casualty when he starts on him, says so on the radio; the first responder tags him again", () => {
    const b = battle([
      { id: "l", x: 10, y: 10 }, { id: "c", x: 50, y: 50, wounds: [legBleed(), openChest()], conscious: false }, { id: "m", x: 60, y: 50 },
      { id: "e", role: "einsatzersthelfer", x: 170, y: 50 },
    ]);
    const c = b.id("c");
    b.run(60);
    const tags = of(b.events, "medical.triaged").filter((e) => e.casualty === c);
    expect(tags.length).toBeGreaterThanOrEqual(1);
    expect(tags[0]).toMatchObject({ by: b.id("m"), skill: "buddy", actual: 1 });
    const radio = of(b.events, "radio");
    expect(radio.filter((e) => e.key === "radio.medic")).toHaveLength(1);
    expect(radio.some((e) => e.key === "radio.treating")).toBe(true);
    b.run(240);
    const again = of(b.events, "medical.triaged").filter((e) => e.casualty === c && e.by === b.id("e"));
    expect(again[0]).toMatchObject({ skill: "firstResponder" });
    expect(b.sim.state.soldier.req(c).triage).toMatchObject({ by: b.id("e"), skill: "firstResponder" });
    // "Medic!" once for him, however long he waits.
    expect(of(b.events, "radio").filter((e) => e.key === "radio.medic")).toHaveLength(1);
  });

  it("under fire a carer drags a man who cannot move to the nearest hidden spot; care goes on there", () => {
    // A short wall west of the casualty; the fire comes from the east.
    const wall = (m: MapDef) => { m.obstacles.push({ id: 1, kind: "brick-wall", points: [92, 96, 92, 104], heightM: 2, thicknessM: 0.25, material: "brick" }); };
    const b = battle([{ id: "l", x: 20, y: 20 }, { id: "c", x: 100, y: 100, wounds: [openChest()], conscious: false }, { id: "m", x: 112, y: 100 }], { map: wall });
    const c = b.id("c"), m = b.id("m");
    b.underFire(true);
    b.run(40);
    const started = of(b.events, "medical.dragged").find((e) => !e.done);
    expect(started).toMatchObject({ casualty: c, by: m });
    expect(started!.distanceM).toBeLessThanOrEqual(30);
    // Nothing but the drag under fire (no chest seal yet).
    expect(of(b.events, "medical.treated")).toHaveLength(0);
    // He is never more than a step and a half from the man dragging him.
    for (let k = 0; k < 60 * 60; k++) {
      b.run(1 / 60);
      if (b.sim.state.carry.size === 0) break;
      const p = b.sim.state.transform.req(c), q = b.sim.state.transform.req(m);
      expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeLessThanOrEqual(1.5);
    }
    const done = of(b.events, "medical.dragged").find((e) => e.done);
    expect(done).toMatchObject({ casualty: c, by: m });
    const t = b.sim.state.transform.req(c), s = b.sim.state.soldier.req(c);
    expect(t.x).toBeLessThan(92);
    expect(s.sheltered).toBeDefined();
    b.run(120);
    expect(of(b.events, "medical.treated").some((e) => e.casualty === c && e.intervention === "chest-seal")).toBe(true);
  });

  it("save and load mid-drag: the battle goes on identically", () => {
    const wall = (m: MapDef) => { m.obstacles.push({ id: 1, kind: "brick-wall", points: [92, 96, 92, 104], heightM: 2, thicknessM: 0.25, material: "brick" }); };
    const a = battle([{ id: "l", x: 20, y: 20 }, { id: "c", x: 100, y: 100, wounds: [openChest()], conscious: false }, { id: "m", x: 112, y: 100 }], { map: wall });
    a.underFire(true);
    for (let k = 0; k < 120; k++) {
      a.run(1);
      if (a.sim.state.carry.size > 0) break;
    }
    expect(a.sim.state.carry.size > 0).toBe(true);
    a.underFire(false);
    const saved = JSON.parse(JSON.stringify(saveSim(a.sim))) as SerializedState;
    const again = loadSim(a.input, saved);
    for (let t = 0; t < 90 * 60; t++) { step(a.sim); step(again); }
    expect(hashState(again.state)).toBe(hashState(a.sim.state));
  });
});
