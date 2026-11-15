/**
 * Men down, identity tags, crawling, prisoners' care (owner requests 2026-11-15). A man who goes down is "down, state
 * unknown" to his comrades until one of them checks him; until then they come to him and drag him into cover even if
 * he is dead. Found dead, his identity tag is taken (transferItems) when it is quiet. A conscious casualty who cannot
 * walk crawls to cover; a surrendered man under fire crawls out of the line of fire. Prisoners are cared for by the
 * side holding them by medical urgency alone. Save/load mid-check and mid-crawl.
 */
import { describe, expect, it } from "vitest";
import { buildCatalog } from "@tcs/data";
import {
  countItems, createSim, sideKnowledge, DEFAULT_COMMS, EventSink, flatMap, hashState, healthyPhysiology, loadSim, newBattleRecord, recordEvents, refreshStatus, saveSim, step, surrender,
  type BattleInput, type Catalog, type EntityId, type MapDef, type SerializedState, type SimEvent, type SoldierRecord, type Wound,
} from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData();
const catalog: Catalog = buildCatalog(data, ["de", "ru"]);

const wound = (extra: Partial<Wound>): Wound => ({
  id: 1, zone: "chest", mechanism: "bullet", severity: 0.4, bleedingLps: 0, compressible: false, airway: false, breathing: false,
  consciousness: false, tickInflicted: 0, treatments: [], ...extra,
});
const KIT = (f: string) => f === "de"
  ? [{ type: "de-tourniquet-cat", count: 1 }, { type: "de-pressure-dressing", count: 2 }, { type: "de-hemostatic-gauze", count: 1 }, { type: "de-rescue-blanket", count: 1 }, { type: "de-chest-seal", count: 1 }]
  : [{ type: "ru-tourniquet-rubber", count: 1 }];

interface Man { id: string; side?: "blue" | "red"; role?: string; x: number; y: number; wounds?: Wound[]; conscious?: boolean }

function battle(men: Man[], opts: { map?: (m: MapDef) => void; red?: "de" | "ru"; blue?: "de" | "ru" } = {}) {
  const fac = { blue: opts.blue ?? "de", red: opts.red ?? "ru" };
  const rec = (m: Man): SoldierRecord => ({
    personId: m.id, given: "T", family: m.id, rank: "r", role: m.role ?? "rifleman", skills: { marksmanship: 0.5, medical: 0.2 },
    fatigue: 0, stress: 0,
    wounds: [...(m.wounds ?? []), ...(m.conscious === false ? [wound({ id: 9, zone: "head", severity: 0.2, consciousness: true })] : [])].map((w) => ({ ...w, treatments: [] })),
    load: KIT(fac[m.side ?? "blue"]).map((x) => ({ ...x })),
    status: (m.wounds ?? []).length > 0 ? "wounded" : "fit",
    ...(m.conscious === false ? { physiology: { ...healthyPhysiology(), consciousness: 0 } } : {}),
  });
  const map = flatMap("down-test", 300, 300, 4, "grass");
  opts.map?.(map);
  const force = (side: "blue" | "red") => {
    const ms = men.filter((m) => (m.side ?? "blue") === side);
    return { side, faction: fac[side], units: [{ key: `${side}0`, callsign: side, echelon: "team" as const, leaderIndex: 0, subunits: [], members: ms.map(rec) }],
      placements: ms.map((m) => ({ personId: m.id, x: m.x, y: m.y, heading: 0 })) };
  };
  const forces = [force("blue"), ...(men.some((m) => m.side === "red") ? [force("red")] : [])];
  const input: BattleInput = {
    map, catalog, seed: 7, orders: [],
    rules: { timeLimitSeconds: 36000, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "medical", physiologyParams: {}, objectives: [] },
    forces,
  };
  const sim = createSim(input);
  const id = (p: string): EntityId => [...sim.state.identity.entries()].find(([, i]) => i.personId === p)![0];
  const events: SimEvent[] = [];
  let fire: string | null = null;
  const run = (seconds: number) => {
    for (let t = 0; t < seconds * 60; t++) {
      // Under fire from the east: the blue unit is fired on, rounds come from there (no suppression: care goes on).
      if (fire) {
        const st = sim.state;
        for (const [uid, u] of st.unit.entries()) if (u.side === fire) st.unit.req(uid).ownFireTick = st.tick;
        for (const [sid, s] of st.soldier.entries()) if (st.identity.req(sid).side === fire) s.fireFrom = { dx: 1, dy: 0, tick: st.tick };
      }
      events.push(...step(sim));
    }
  };
  /** Kill him now (the sim's own status path). */
  const kill = (p: string) => {
    const s = sim.state.soldier.req(id(p));
    s.wounds.push(wound({ id: 5, zone: "head", severity: 1 }));
    s.physiology.alive = false; s.physiology.consciousness = 0;
    refreshStatus(sim.ctx, sim.state, new EventSink(), id(p));
  };
  return { sim, input, id, events, run, kill, underFire: (side: string | null) => { fire = side; } };
}

const of = <K extends SimEvent["kind"]>(ev: SimEvent[], k: K) => ev.filter((e): e is Extract<SimEvent, { kind: K }> => e.kind === k);
const wall = (m: MapDef) => { m.obstacles.push({ id: 1, kind: "brick-wall", points: [92, 94, 92, 106], heightM: 2, thicknessM: 0.25, material: "brick" }); };

describe("men down: the check, identity tags (owner request 2026-11-15)", () => {
  it("every man carries his faction's identity tag (data): two halves of the German, one Russian", () => {
    const b = battle([{ id: "a", x: 10, y: 10 }, { id: "r", side: "red", x: 280, y: 280 }]);
    expect(countItems(b.sim.state.container.req(b.id("a")), "de-erkennungsmarke")).toBe(2);
    expect(countItems(b.sim.state.container.req(b.id("r")), "ru-lichny-znak")).toBe(1);
  });

  it("a dead comrade is 'down, unknown' until checked; then his tag half is taken and the body stays", () => {
    const b = battle([{ id: "l", x: 20, y: 20 }, { id: "d", x: 100, y: 100 }, { id: "m", x: 115, y: 100 }]);
    const d = b.id("d"), m = b.id("m");
    b.kill("d");
    const p0 = { ...b.sim.state.transform.req(d) };
    b.run(2);
    expect(b.sim.state.soldier.req(d).checked).toBeUndefined();
    // Comrades come to him as to a casualty (he could be alive).
    expect(of(b.events, "medical.carer").some((e) => e.casualty === d && e.assigned)).toBe(true);
    b.run(90);
    const chk = of(b.events, "medical.checked").find((e) => e.casualty === d)!;
    expect(chk).toMatchObject({ dead: true });
    expect(b.sim.state.soldier.req(d).checked?.dead).toBe(true);
    const tag = of(b.events, "medical.tagTaken").find((e) => e.casualty === d)!;
    expect(tag).toMatchObject({ item: "de-erkennungsmarke", count: 1, side: "blue" });
    expect(tag.tick).toBeGreaterThan(chk.tick);
    expect(countItems(b.sim.state.container.req(d), "de-erkennungsmarke")).toBe(1); // the other half stays with him
    expect(countItems(b.sim.state.container.req(tag.by), "de-erkennungsmarke")).toBe(3);
    // The body is still an entity, where it fell.
    const p1 = b.sim.state.transform.req(d);
    expect(Math.hypot(p1.x - p0.x, p1.y - p0.y)).toBeLessThan(0.01);
    expect([m, b.id("l")]).toContain(tag.by);
    // Only once.
    b.run(60);
    expect(of(b.events, "medical.tagTaken").filter((e) => e.casualty === d)).toHaveLength(1);
  });

  it("the Russian tag is taken whole", () => {
    const b = battle([{ id: "l", x: 20, y: 20 }, { id: "d", x: 100, y: 100 }, { id: "m", x: 102, y: 100 }], { blue: "ru" });
    b.kill("d");
    b.run(60);
    expect(countItems(b.sim.state.container.req(b.id("d")), "ru-lichny-znak")).toBe(0);
    expect(of(b.events, "medical.tagTaken")[0]).toMatchObject({ item: "ru-lichny-znak", count: 1 });
  });

  it("under fire a dead man is dragged into cover before anyone knows he is dead; checked there, tag only when quiet", () => {
    const b = battle([{ id: "l", x: 20, y: 20 }, { id: "d", x: 100, y: 100 }, { id: "m", x: 112, y: 100 }], { map: wall });
    const d = b.id("d");
    b.kill("d");
    b.underFire("blue");
    b.run(90);
    const drag = of(b.events, "medical.dragged").find((e) => e.casualty === d && !e.done)!;
    expect(drag.deadNow).toBe(true);
    const chk = of(b.events, "medical.checked").find((e) => e.casualty === d)!;
    expect(chk.tick).toBeGreaterThan(drag.tick);
    expect(chk.dragged).toBe(true);
    expect(b.sim.state.transform.req(d).x).toBeLessThan(92);
    // Rounds still cracking past: no tag yet.
    expect(of(b.events, "medical.tagTaken")).toHaveLength(0);
    b.underFire(null);
    b.run(120);
    expect(of(b.events, "medical.tagTaken").some((e) => e.casualty === d)).toBe(true);
    // The battle record counts it all.
    const rec = newBattleRecord(["blue"]);
    recordEvents(rec, b.events, b.sim.state, catalog);
    expect(rec.sides["blue"]!.down).toMatchObject({ checked: 1, checkedDead: 1, deadDragged: 1, tagMen: 1, tags: 1 });
  });

  it("save and load mid-check: the battle goes on identically", () => {
    const a = battle([{ id: "l", x: 20, y: 20 }, { id: "d", x: 100, y: 100 }, { id: "m", x: 101.5, y: 100 }]);
    a.kill("d");
    for (let k = 0; k < 600 && ![...a.sim.state.action.values()].some((x) => x.kind === "checkDown"); k++) a.run(1 / 60);
    expect([...a.sim.state.action.values()].some((x) => x.kind === "checkDown")).toBe(true);
    const again = loadSim(a.input, JSON.parse(JSON.stringify(saveSim(a.sim))) as SerializedState);
    for (let t = 0; t < 40 * 60; t++) { step(a.sim); step(again); }
    expect(hashState(again.state)).toBe(hashState(a.sim.state));
    expect(a.sim.state.soldier.req(a.id("d")).checked?.dead).toBe(true);
  });
});

describe("crawling to cover (owner requests 2026-11-15)", () => {
  const brokenLeg = () => wound({ zone: "legR", severity: 0.5, fracture: true });

  it("a conscious casualty who cannot walk crawls behind the wall, slowed by his wounds", () => {
    const w = battle([{ id: "l", x: 20, y: 20 }, { id: "c", x: 97, y: 100, wounds: [brokenLeg()] }], { map: wall });
    const cc = w.id("c");
    expect(w.sim.state.soldier.req(cc).impair.canWalk).toBe(false);
    w.underFire("blue");
    w.run(10);
    const cr = of(w.events, "medical.crawled").find((e) => e.casualty === cc)!;
    expect(cr).toBeDefined();
    expect(cr.distanceM).toBeLessThanOrEqual(15);
    w.run(150);
    const t = w.sim.state.transform.req(cc), s = w.sim.state.soldier.req(cc);
    expect(t.x).toBeLessThan(92);
    expect(s.posture).toBe("prone");
    // Slower than an unhurt crawl (0.3 m/s): his wound impairment.
    expect(s.impair.move).toBeLessThan(1);
  });

  it("he waits when a carer is close", () => {
    const w = battle([{ id: "l", x: 20, y: 20 }, { id: "c", x: 97, y: 100, wounds: [brokenLeg()] }, { id: "m", x: 104, y: 100 }], { map: wall });
    const cc = w.id("c"), m = w.id("m");
    w.sim.state.soldier.req(m).intent = { kind: "care", tick: 0, target: cc, x: 104, y: 100 };
    w.underFire("blue");
    w.run(3);
    expect(of(w.events, "medical.crawled")).toHaveLength(0);
  });

  it("a surrendered man under fire crawls out of the line of fire, then walks over; save/load mid-crawl", () => {
    // Red surrendered at (97, 100); his captors-to-be (blue) at the east; fire comes from the east.
    const men: Man[] = [{ id: "b1", x: 150, y: 100 }, { id: "r1", side: "red", x: 97, y: 100 }, { id: "r0", side: "red", x: 280, y: 280 }];
    const w = battle(men, { map: wall });
    const r = w.id("r1");
    surrender(w.sim.ctx, w.sim.state, new EventSink(), r, "panicked");
    const rs = w.sim.state.soldier.req(r);
    w.underFire("red");
    for (let k = 0; k < 600 && of(w.events, "surrender.crawl").length === 0; k++) { rs.mental.suppression = 0.5; w.run(1 / 60); }
    const ev = of(w.events, "surrender.crawl")[0]!;
    expect(ev).toMatchObject({ soldier: r, side: "red" });
    expect(rs.crawlCover).toBeDefined();
    const again = loadSim(w.input, JSON.parse(JSON.stringify(saveSim(w.sim))) as SerializedState);
    for (let t = 0; t < 70 * 60; t++) { step(w.sim); step(again); }
    expect(hashState(again.state)).toBe(hashState(w.sim.state));
    expect(w.sim.state.transform.req(r).x).toBeLessThan(92);
  });
});

describe("prisoners are cared for like one's own (owner request 2026-11-15, Geneva Convention I art. 12)", () => {
  it("a surrendered enemy with a more urgent need is treated before a less urgent own man", () => {
    const bleed = () => wound({ zone: "legL", bleedingLps: 0.01, compressible: true });
    const light = () => wound({ zone: "armL", severity: 0.1, consciousness: false });
    // One first responder (Einsatzersthelfer) of blue; the own man (light wound, unconscious so he cannot treat
    // himself) at the same distance as the surrendered red man with a massive bleed (unconscious too).
    const men: Man[] = [
      { id: "l", x: 20, y: 20 }, { id: "eh", role: "einsatzersthelfer", x: 100, y: 100 },
      { id: "own", x: 100, y: 140, wounds: [light()], conscious: false },
      { id: "foe", side: "red", x: 100, y: 60, wounds: [bleed()], conscious: false },
    ];
    const b = battle(men);
    const foe = b.id("foe"), own = b.id("own"), eh = b.id("eh");
    surrender(b.sim.ctx, b.sim.state, new EventSink(), foe, "wounded");
    b.run(120);
    const first = of(b.events, "medical.treated").find((e) => e.by === eh)!;
    expect(first.casualty).toBe(foe);
    expect(first.intervention).toBe("tourniquet");
    // The first responder went to him first (sent by urgency, not by side); the own man waits his turn.
    expect(of(b.events, "medical.carer").find((e) => e.assigned && e.by === eh)!.casualty).toBe(foe);
    expect(of(b.events, "medical.treated").some((e) => e.casualty === own && e.tick < first.tick)).toBe(false);
  });
});

describe("fog of war: a surrendered enemy is known only as the side sees him (owner bug report 2026-11-15)", () => {
  it("in sight while a man sees him; out of sight only his contact (with the white flag), never a figure", () => {
    const b = battle([{ id: "b1", x: 150, y: 100 }, { id: "r1", side: "red", x: 120, y: 100, wounds: [wound({ zone: "legR", severity: 0.5, fracture: true })] }, { id: "r0", side: "red", x: 280, y: 280 }], { map: wall });
    const r = b.id("r1");
    const known = () => sideKnowledge(b.sim.ctx, b.sim.state, "blue").find((k) => k.target === r);
    const nowInSight = () => { const k = known(); return k !== undefined && k.kind === "seen" && k.ageS < 2; };
    b.run(6);
    surrender(b.sim.ctx, b.sim.state, new EventSink(), r, "wounded");
    b.run(3);
    expect(known()?.surrendered).toBe(true);
    expect(nowInSight()).toBe(true);
    // Behind the wall (he cannot walk: he stays there), out of every blue man's sight.
    const t = b.sim.state.transform.req(r); t.x = 86; t.y = 100;
    b.run(4);
    for (let k = 0; k < 20; k++) { b.run(0.5); expect(nowInSight()).toBe(false); }
    expect(known()?.surrendered).toBe(true); // his last known place, with the white flag
  });
});
