/**
 * M10.4a carrying as a movement mode (roadmap-detail slice 8). The carry lab's speeds within 10 % of the data on
 * flat ground, a slope, through a house and up stairs, the casualty never more than 1.5 m from a carrier; the method
 * chosen for the men at hand; a four-man litter (set-up, items conserved); rests after the data's endurance; a party
 * fired on takes cover with the casualty and goes on when it is quiet; carriers are out of the fight (unit orders
 * pass them by; an order to one alone takes him out, the rest carry on); save and load mid-carry.
 */
import { describe, expect, it } from "vitest";
import { buildCatalog } from "@tcs/data";
import {
  chooseCarryMethod, countItems, createSim, DEFAULT_COMMS, EventSink, flatMap, hashState, healthyPhysiology, loadSim, saveSim, startCarry, step, submitOrder,
  type BattleInput, type Catalog, type EntityId, type MapDef, type SerializedState, type SimEvent, type SoldierRecord, type Wound,
} from "@tcs/sim";
import { carryLab, carryLabMarkdown } from "../src/labs/carry";
import { loadData } from "../src/scenarios";

const data = loadData();
const catalog: Catalog = buildCatalog(data, ["de", "ru"]);

const headWound = (): Wound => ({
  id: 1, zone: "head", mechanism: "bullet", severity: 0.2, bleedingLps: 0, compressible: false, airway: false, breathing: false,
  consciousness: true, tickInflicted: 0, treatments: [],
});

interface Man { id: string; x: number; y: number; down?: boolean; litter?: boolean }
function battle(men: Man[], opts: { map?: (m: MapDef) => void } = {}) {
  const rec = (m: Man): SoldierRecord => ({
    personId: m.id, given: "T", family: m.id, rank: "gefreiter", role: "grenadier", skills: { medical: 0.2 }, fatigue: 0, stress: 0,
    wounds: m.down ? [headWound()] : [], load: [{ type: "de-basic-load", count: 3 }, ...(m.litter ? [{ type: "de-litter", count: 1 }] : [])],
    status: m.down ? "wounded" : "fit", ...(m.down ? { physiology: { ...healthyPhysiology(), consciousness: 0 } } : {}),
  });
  const map = flatMap("carry-test", 300, 200, 4, "grass");
  opts.map?.(map);
  const input: BattleInput = {
    map, catalog, seed: 7, orders: [],
    rules: { timeLimitSeconds: 36000, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "none", physiologyParams: {}, objectives: [], medicalCare: false },
    forces: [{ side: "blue", faction: "de", units: [{ key: "t0", callsign: "T0", echelon: "team" as const, leaderIndex: 0, subunits: [], members: men.map(rec) }],
      placements: men.map((m) => ({ personId: m.id, x: m.x, y: m.y, heading: 0 })) }],
  };
  const sim = createSim(input);
  const id = (p: string): EntityId => [...sim.state.identity.entries()].find(([, i]) => i.personId === p)![0];
  const events: SimEvent[] = [];
  const run = (seconds: number) => { for (let t = 0; t < seconds * 60; t++) events.push(...step(sim)); };
  const carry = (payload: string, carriers: string[], dest: { x: number; y: number }, method?: string) => {
    const sink = new EventSink();
    const c = startCarry(sim.ctx, sim.state, sink, id(payload), carriers.map(id), { ...dest, z: 0 }, method !== undefined ? { method } : {});
    events.push(...sink.events);
    return c;
  };
  return { sim, input, id, events, run, carry };
}
const of = <K extends SimEvent["kind"]>(ev: SimEvent[], k: K) => ev.filter((e): e is Extract<SimEvent, { kind: K }> => e.kind === k);

describe("carry lab (M10.4a)", () => {
  const lab = carryLab(data);
  it("prints its table", () => { console.log(carryLabMarkdown(lab)); });
  it("every method within 10 % of the data's speed on flat ground, a slope, a house and stairs; the casualty never more than 1.5 m from a carrier", () => {
    expect(lab.rows.length).toBe(Object.keys(catalog.medical!.carry).length * 4);
    for (const r of lab.rows) {
      expect(r.arrived, `${r.method} ${r.course}`).toBe(true);
      expect(Math.abs(r.errPct), `${r.method} ${r.course}`).toBeLessThanOrEqual(10);
      if (r.carriers > 0) expect(r.maxGapM, `${r.method} ${r.course}`).toBeLessThanOrEqual(1.5);
    }
    // A litter takes its set-up time; rests come after the data's endurance.
    expect(lab.rows.find((r) => r.method === "stretcher" && r.course === "flat")!.setupS).toBeCloseTo(catalog.medical!.carry["stretcher"]!.setupS, 0);
    expect(lab.endurance.find((e) => e.method === "drag")!.rests).toBe(3);
    expect(lab.endurance.find((e) => e.method === "stretcher")!.rests).toBe(0);
  });
});

describe("carrying (M10.4a)", () => {
  it("the method for the men at hand: walking or supported, a drag under fire, a litter for four with one", () => {
    expect(chooseCarryMethod(catalog, 0, true, 1, false, false)).toBe("walking");
    expect(chooseCarryMethod(catalog, 1, true, 1, false, false)).toBe("walking");
    expect(chooseCarryMethod(catalog, 1, true, 0.4, false, false)).toBe("supported");
    expect(chooseCarryMethod(catalog, 0, false, 1, false, false)).toBeNull();
    expect(chooseCarryMethod(catalog, 1, false, 1, false, false)).toBe("fireman");
    expect(chooseCarryMethod(catalog, 1, false, 1, true, false)).toBe("drag");
    expect(chooseCarryMethod(catalog, 2, false, 1, false, false)).toBe("two-man");
    expect(chooseCarryMethod(catalog, 2, false, 1, true, false)).toBe("two-man-drag");
    expect(chooseCarryMethod(catalog, 4, false, 1, false, false)).toBe("two-man");
    expect(chooseCarryMethod(catalog, 4, false, 1, false, true)).toBe("stretcher");
  });

  it("four men with a litter: they gather, set it up, carry him; the litter stays with its man", () => {
    const b = battle([
      { id: "l", x: 20, y: 20 }, { id: "c", x: 100, y: 100, down: true },
      { id: "a", x: 110, y: 100, litter: true }, { id: "b", x: 112, y: 104 }, { id: "d", x: 108, y: 96 }, { id: "e", x: 95, y: 105 },
    ]);
    const c = b.carry("c", ["a", "b", "d", "e"], { x: 160, y: 100 });
    expect(c).toMatchObject({ method: "stretcher", phase: "gather", litter: { type: "de-litter", from: b.id("a") } });
    b.run(5);
    b.run(60);
    expect(b.sim.state.carry.get(b.id("c"))?.phase).toBe("move");
    b.run(120);
    const done = of(b.events, "medical.carried").find((e) => e.phase === "done");
    expect(done).toMatchObject({ payload: b.id("c"), method: "stretcher", reason: "arrived", carriers: 4 });
    const t = b.sim.state.transform.req(b.id("c"));
    expect(Math.hypot(t.x - 160, t.y - 100)).toBeLessThan(3);
    expect(countItems(b.sim.state.container.req(b.id("a")), "de-litter")).toBe(1);
    for (const m of ["a", "b", "d", "e"]) expect(b.sim.state.soldier.req(b.id(m)).carrying).toBeUndefined();
  });

  it("a party fired on takes cover with the casualty behind a wall, lies there and goes on when it is quiet", () => {
    // A wall north of the way; the fire comes from the north.
    const wall = (m: MapDef) => { m.obstacles.push({ id: 1, kind: "brick-wall", points: [96, 92, 104, 92], heightM: 2, thicknessM: 0.25, material: "brick" }); };
    const b = battle([{ id: "l", x: 20, y: 20 }, { id: "c", x: 90, y: 96, down: true }, { id: "a", x: 89, y: 97 }, { id: "b", x: 91, y: 97 }], { map: wall });
    b.carry("c", ["a", "b"], { x: 200, y: 96 }, "two-man");
    b.run(12);
    const st = b.sim.state, men = [b.id("a"), b.id("b")];
    // Fire from the north: both carriers suppressed, the rounds coming from there.
    for (let k = 0; k < 30 * 60; k++) {
      for (const m of men) { const s = st.soldier.req(m); s.mental.suppression = 0.6; s.fireFrom = { dx: 0, dy: -1, tick: st.tick }; }
      b.events.push(...step(b.sim));
    }
    const hold = of(b.events, "medical.carried").find((e) => e.phase === "hold");
    expect(hold).toBeDefined();
    // Lying behind the wall (its far side from the fire), the casualty beside his carriers.
    const p = st.carry.get(b.id("c"))!;
    expect(p.phase).toBe("hold");
    const ct = st.transform.req(b.id("c"));
    expect(ct.y).toBeGreaterThan(92);
    expect(ct.x).toBeGreaterThan(95);
    expect(ct.x).toBeLessThan(105);
    for (const m of men) expect(st.soldier.req(m).posture).toBe("prone");
    // Quiet: they go on.
    for (const m of men) st.soldier.req(m).mental.suppression = 0;
    b.run(60);
    expect(of(b.events, "medical.carried").some((e) => e.phase === "resume")).toBe(true);
    b.run(200);
    expect(of(b.events, "medical.carried").find((e) => e.phase === "done")).toMatchObject({ reason: "arrived" });
  });

  it("carriers are out of the fight: unit orders pass them by; an order to one alone takes him out and the other drags on", () => {
    const b = battle([{ id: "l", x: 20, y: 20 }, { id: "c", x: 100, y: 100, down: true }, { id: "a", x: 101, y: 101 }, { id: "b", x: 99, y: 101 }]);
    b.carry("c", ["a", "b"], { x: 180, y: 100 }, "two-man");
    b.run(10);
    const st = b.sim.state, uid = st.identity.req(b.id("a")).unit;
    submitOrder(b.sim, { tick: st.tick, issuer: "blue", target: uid, kind: "move", waypoints: [{ x: 20, y: 150, mode: "walk" }] });
    b.run(5);
    expect(st.soldier.req(b.id("a")).carrying).toBe(b.id("c"));
    expect(st.carry.get(b.id("c"))?.method).toBe("two-man");
    submitOrder(b.sim, { tick: st.tick, issuer: "blue", target: b.id("b"), kind: "move", waypoints: [{ x: 20, y: 150, mode: "walk" }] });
    b.run(3);
    expect(st.soldier.req(b.id("b")).carrying).toBeUndefined();
    const p = st.carry.get(b.id("c"))!;
    expect(p.carriers).toEqual([b.id("a")]);
    expect(p.method).toBe("fireman");
    b.run(200);
    expect(of(b.events, "medical.carried").find((e) => e.phase === "done")).toMatchObject({ reason: "arrived", carriers: 1 });
  });

  it("save and load mid-carry: the battle goes on identically", () => {
    const b = battle([{ id: "l", x: 20, y: 20 }, { id: "c", x: 100, y: 100, down: true }, { id: "a", x: 101, y: 101, litter: true }, { id: "b", x: 99, y: 101 }, { id: "d", x: 99, y: 99 }, { id: "e", x: 101, y: 99 }]);
    b.carry("c", ["a", "b", "d", "e"], { x: 180, y: 140 });
    b.run(60);
    expect(b.sim.state.carry.get(b.id("c"))?.phase).toBe("move");
    const saved = JSON.parse(JSON.stringify(saveSim(b.sim))) as SerializedState;
    const again = loadSim(b.input, saved);
    expect(hashState(again.state)).toBe(hashState(b.sim.state));
    for (let t = 0; t < 120 * 60; t++) { step(b.sim); step(again); }
    expect(hashState(again.state)).toBe(hashState(b.sim.state));
  });

  it("a schema-18 save (no carrying store) loads", () => {
    const b = battle([{ id: "l", x: 20, y: 20 }, { id: "c", x: 100, y: 100, down: true }]);
    const saved = JSON.parse(JSON.stringify(saveSim(b.sim))) as SerializedState;
    const stores: Partial<SerializedState["stores"]> = { ...saved.stores };
    delete stores.carry;
    const old = { ...saved, schema: 18, stores } as SerializedState;
    const again = loadSim(b.input, old);
    expect(again.state.carry.size).toBe(0);
    expect(hashState(again.state)).toBe(hashState(b.sim.state));
  });
});
