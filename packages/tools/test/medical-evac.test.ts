/**
 * M10.6a off-map vehicles and ambulance runs (roadmap-detail slice 13). A side's ambulances are off-map assets: in the
 * battle from tick 0 with their crews, parked off the map, skipped by every system, counted in no side's strength. A
 * platoon with casualties at its Verwundetennest calls one (automatic; the player's `callAmbulance`); it comes onto the
 * map after the delay, drives to the nest, takes the men aboard T1 first within its layouts, leaves the map and its
 * wounded are evacuated (roster status "evacuated"). Save/load mid-run; men and items conserved.
 */
import { describe, expect, it } from "vitest";
import { buildCatalog } from "@tcs/data";
import { buildForce } from "@tcs/scenario";
import {
  createSim, DEFAULT_COMMS, flatMap, hashState, isOffMap, loadSim, newVehicleRecord, OFF_MAP_PARK, placesUsed, runBattle, saveSim, soldierRecordFromState, step, submitOrder, unitsFromState,
  type BattleInput, type Catalog, type EntityId, type SerializedState, type SimEvent, type SoldierRecord, type Wound,
} from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData();
const real: Catalog = buildCatalog(data, ["de", "ru"]);
/** The same catalog with a short delay (tests run minutes, not a quarter of an hour). */
const quick: Catalog = { ...real, medical: { ...real.medical!, evacuation: { ...real.medical!.evacuation!, delayMinS: 60, delayMaxS: 90 } } };

const wound = (extra: Partial<Wound>): Wound => ({
  id: 1, zone: "chest", mechanism: "bullet", severity: 0.2, bleedingLps: 0, compressible: false, airway: false, breathing: false,
  consciousness: false, tickInflicted: 0, treatments: [], ...extra,
});
const KIT = [{ type: "de-tourniquet-cat", count: 1 }, { type: "de-pressure-dressing", count: 2 }, { type: "de-rescue-blanket", count: 1 }];
const brokenLeg = () => wound({ zone: "legL", severity: 0.3, fracture: true });

interface Man { id: string; role?: string; x: number; y: number; wounds?: Wound[] }

/** A platoon on a flat 1000 m map (west edge nearest) with `ambulances` Boxer ambulances off the map. */
function battle(squad: Man[], opts: { catalog?: Catalog; ambulances?: number; medicalCare?: boolean } = {}) {
  const catalog = opts.catalog ?? quick;
  const rec = (m: Man): SoldierRecord => ({
    personId: m.id, given: "T", family: m.id, rank: "r", role: m.role ?? "grenadier", skills: { marksmanship: 0.5, medical: 0.2 },
    fatigue: 0, stress: 0, wounds: (m.wounds ?? []).map((w) => ({ ...w, treatments: [] })), load: KIT.map((x) => ({ ...x })),
    status: (m.wounds ?? []).length > 0 ? "wounded" : "fit",
  });
  const hq: Man[] = [{ id: "pl", x: 330, y: 500 }, { id: "san", role: "sanitaeter", x: 332, y: 506 }];
  const crews = Array.from({ length: opts.ambulances ?? 1 }, (_, k) => { const u = buildForce(data, { faction: "de", template: "boxer-san-besatzung", seed: 5 + k, keyPrefix: `amb${k + 1}`, number: k + 1 }); u.vehicleId = u.key; return u; });
  const input: BattleInput = {
    map: flatMap("evac-test", 1000, 1000, 4, "grass"), catalog, seed: 7, orders: [],
    rules: { timeLimitSeconds: 36000, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "medical", physiologyParams: {}, objectives: [], ...(opts.medicalCare === false ? { medicalCare: false } : {}) },
    forces: [{
      side: "blue", faction: "de",
      units: [{ key: "p", callsign: "P", echelon: "platoon" as const, leaderIndex: 0, members: hq.map(rec),
        subunits: [{ key: "s1", callsign: "S1", echelon: "squad" as const, leaderIndex: 0, subunits: [], members: squad.map(rec) }] }, ...crews],
      placements: [...hq, ...squad].map((m) => ({ personId: m.id, x: m.x, y: m.y, heading: 0 })),
      vehicles: crews.map((c) => newVehicleRecord(catalog, "de-boxer-san", c.key)),
      offMap: crews.map((c) => ({ vehicleId: c.key, kind: "ambulance" as const })),
    }],
  };
  const sim = createSim(input);
  const id = (p: string): EntityId => [...sim.state.identity.entries()].find(([, i]) => i.personId === p)![0];
  const amb = (k = 1): EntityId => [...sim.state.vehicle.entries()].find(([, v]) => v.vehicleId === `amb${k}`)![0];
  const events: SimEvent[] = [];
  const run = (seconds: number) => { for (let t = 0; t < seconds * 60; t++) events.push(...step(sim)); };
  const until = (pred: () => boolean, maxS: number) => { for (let t = 0; t < maxS * 60 && !pred(); t++) events.push(...step(sim)); };
  return { sim, input, id, amb, events, run, until };
}

const of = <K extends SimEvent["kind"]>(ev: SimEvent[], k: K) => ev.filter((e): e is Extract<SimEvent, { kind: K }> => e.kind === k);
const riflemen = (n: number, x0 = 350): Man[] => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, x: x0 + (i % 4) * 4, y: 480 + Math.floor(i / 4) * 4 }));
/** Men down with a broken leg (they cannot walk: bearers carry them to the nest). */
const legs = (n: number): Man[] => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, x: 360 + i * 3, y: 500, wounds: [brokenLeg()] }));
const phases = (ev: SimEvent[]) => of(ev, "medical.ambulance").map((e) => e.phase);
/** Every item in every container, by type. */
const items = (b: ReturnType<typeof battle>) => { const n: Record<string, number> = {}; for (const [, c] of b.sim.state.container.entries()) for (const s of c.stacks) n[s.type] = (n[s.type] ?? 0) + s.count; return n; };

describe("off-map assets (M10.6a)", () => {
  it("an ambulance and its crew wait off the map from tick 0: parked, skipped, counted in no side's strength", () => {
    const b = battle([{ id: "sl", x: 350, y: 470 }, ...riflemen(3)]);
    const st = b.sim.state, v = st.vehicle.req(b.amb());
    expect(v.offMap?.phase).toBe("ready");
    expect(isOffMap(v)).toBe(true);
    const t = st.transform.req(b.amb());
    expect([t.x, t.y]).toEqual([OFF_MAP_PARK.x, OFF_MAP_PARK.y]);
    expect(v.unit).not.toBeNull();
    expect(st.unit.req(v.unit!).asset).toBe("ambulance");
    expect(v.seats.filter((s) => s !== null).length).toBe(3); // its crew aboard
    b.run(30);
    expect(st.transform.req(b.amb()).x).toBe(OFF_MAP_PARK.x); // nothing moved it
    // The result: the crew is not of the force, the hull not among its vehicles.
    const r = runBattle({ ...b.input, rules: { ...b.input.rules, timeLimitSeconds: 5 } });
    expect(r.sides[0]!.soldiersStart).toBe(6);
    expect(r.sides[0]!.vehicles).toBeUndefined();
    expect(r.wrecks).toBeUndefined();
    // Records out: the hull and its crew are in the roster.
    expect(r.forcesOut[0]!.vehicles?.map((x) => x.vehicleId)).toEqual(["amb1"]);
  });

  it("a casualty at the nest brings an ambulance after the delay; it loads him, leaves the map and he is evacuated", () => {
    const b = battle([{ id: "sl", x: 350, y: 470 }, ...riflemen(7), ...legs(1)], { catalog: real });
    const st = b.sim.state, vid = b.amb();
    b.until(() => st.vehicle.req(vid).offMap!.phase === "called", 900);
    const called = of(b.events, "medical.ambulance").find((e) => e.phase === "called")!;
    expect(called).toBeDefined();
    expect(called.dueS).toBeGreaterThanOrEqual(600);
    expect(called.dueS).toBeLessThanOrEqual(900);
    expect(of(b.events, "radio").some((e) => e.key === "radio.ambulanceCalled")).toBe(true);
    const o = st.vehicle.req(vid).offMap!;
    expect(Math.abs((o.enterTick! - o.callTick!) / 60 - called.dueS!)).toBeLessThanOrEqual(0.5);
    b.until(() => st.vehicle.req(vid).offMap!.phase === "inbound", 1000);
    expect(st.tick - o.enterTick!).toBeLessThanOrEqual(60); // (the run is looked at once a second)
    // On the map at its entry point on the west edge (behind the nest), heading in.
    const t = st.transform.req(vid);
    expect(t.x).toBeLessThan(20);
    b.until(() => st.vehicle.req(vid).offMap!.phase === "away", 1200);
    expect(phases(b.events)).toEqual(["called", "entered", "arrived", "loaded", "departed", "away"]);
    const c = st.soldier.req(b.id("c0"));
    expect(c.evacuated?.vehicle).toBe(vid);
    expect(c.mount?.vehicle).toBe(vid);
    expect(of(b.events, "medical.evacuated").map((e) => e.casualty)).toEqual([b.id("c0")]);
    expect(st.transform.req(vid).x).toBe(OFF_MAP_PARK.x);
    // His roster record says so, and survives a round trip; his wounds are kept.
    const recd = soldierRecordFromState(st, b.id("c0"));
    expect(recd.status).toBe("evacuated");
    const back = JSON.parse(JSON.stringify(unitsFromState(st, "blue", b.input.forces[0]!.units))) as typeof b.input.forces[0]["units"];
    const m = back[0]!.subunits[0]!.members.find((x) => x.personId === "c0")!;
    expect(m.status).toBe("evacuated");
    expect(m.wounds.length).toBe(1);
    expect(m.wounds[0]!.fracture).toBe(true);
    // Off the map his condition no longer changes.
    const phys = JSON.stringify(c.physiology);
    b.run(60);
    expect(JSON.stringify(c.physiology)).toBe(phys);
  });

  it("capacity is never exceeded: T1 first, the rest wait for the next ambulance", () => {
    // (Everyone travels lying here: lyingShock 0. The Boxer takes 3 lying at most.)
    const lying: Catalog = { ...quick, medical: { ...quick.medical!, vehicleLoading: { ...quick.medical!.vehicleLoading!, lyingShock: 0 } } };
    const b = battle([{ id: "sl", x: 350, y: 470 }, ...riflemen(8), ...legs(5)], { ambulances: 2, catalog: lying });
    const st = b.sim.state;
    // Lay them all at the nest at once.
    b.run(2);
    const pid = [...st.rear.keys()][0]!;
    const p = st.rear.req(pid);
    for (let i = 0; i < 5; i++) {
      const id = b.id(`c${i}`), s = st.soldier.req(id), tt = st.transform.req(id);
      st.carry.delete(id);
      s.atNest = pid; tt.x = p.x + i; tt.y = p.y;
      s.triage = { cat: i === 3 ? 1 : 2, skill: "medic", tick: st.tick, by: b.id("san") };
    }
    for (const [pl, c] of [...st.carry.entries()]) { void c; st.carry.delete(pl); }
    let maxLying = 0;
    const def = real.vehicles["de-boxer-san"]!;
    for (let t = 0; t < 1800 && st.vehicle.req(b.amb()).offMap!.phase !== "away"; t++) {
      b.run(1);
      const u = placesUsed(st, st.vehicle.req(b.amb()), def);
      maxLying = Math.max(maxLying, u.lying);
    }
    expect(st.vehicle.req(b.amb()).offMap!.phase).toBe("away");
    expect(maxLying).toBe(3);
    const first = of(b.events, "medical.ambulance").filter((e) => e.phase === "loaded" && e.vehicle === b.amb());
    expect(first.length).toBe(3);
    expect(first[0]!.casualty).toBe(b.id("c3")); // T1 first
    // The other two: the second ambulance was called for them.
    expect(of(b.events, "medical.ambulance").some((e) => e.phase === "called" && e.vehicle === b.amb(2))).toBe(true);
  });

  it("men and items are conserved; nobody aboard is lost or doubled", () => {
    const b = battle([{ id: "sl", x: 350, y: 470 }, ...riflemen(7), ...legs(2)]);
    const st = b.sim.state;
    const men0 = [...st.identity.keys()].sort((x, y) => x - y);
    b.until(() => st.vehicle.req(b.amb()).offMap!.phase === "loading", 1200);
    const before = items(b);
    b.until(() => st.vehicle.req(b.amb()).offMap!.phase === "away", 1200);
    expect([...st.identity.keys()].sort((x, y) => x - y)).toEqual(men0);
    // (Care at the nest may use dressings meanwhile: nothing appears, nothing but medical items goes.)
    const after = items(b);
    for (const [k, n] of Object.entries(after)) expect(n).toBeLessThanOrEqual(before[k] ?? 0);
    for (const [k, n] of Object.entries(before)) if (!real.items[k]?.medical) expect(after[k]).toBe(n);
    const v = st.vehicle.req(b.amb());
    const seated = v.seats.filter((s) => s !== null);
    expect(new Set(seated).size).toBe(seated.length);
    for (const [i, s] of v.seats.entries()) if (s !== null) expect(st.soldier.req(s).mount).toEqual(expect.objectContaining({ vehicle: b.amb(), seat: i }));
  });

  it("the player calls one: acknowledged; a second call while it comes, or with none left, is refused with a reason", () => {
    const b = battle([{ id: "sl", x: 350, y: 470 }, ...riflemen(5)]);
    const st = b.sim.state;
    submitOrder(b.sim, { tick: st.tick, issuer: "blue", target: b.id("sl"), kind: "callAmbulance", player: true });
    b.run(1);
    // No nest yet: one is sited for the call.
    expect(of(b.events, "medical.nest").length).toBe(1);
    const called = of(b.events, "medical.ambulance").filter((e) => e.phase === "called");
    expect(called.length).toBe(1);
    expect(called[0]!.ordered).toBe(true);
    expect(of(b.events, "radio").some((e) => e.key === "radio.ack.callAmbulance")).toBe(true);
    submitOrder(b.sim, { tick: st.tick, issuer: "blue", target: b.id("r0"), kind: "callAmbulance", player: true });
    b.run(1);
    expect(of(b.events, "radio").some((e) => e.key === "radio.ambulanceComing")).toBe(true);
    // Nobody to take when it is due: the call is stood down, and it waits off the map for the next.
    b.until(() => st.vehicle.req(b.amb()).offMap!.phase === "ready", 1200);
    expect(phases(b.events)).toEqual(["called", "cancelled"]);
    expect(st.transform.req(b.amb()).x).toBe(OFF_MAP_PARK.x);
    // With none left (this one gone with a load), a call is refused.
    st.vehicle.req(b.amb()).offMap!.phase = "away";
    submitOrder(b.sim, { tick: st.tick, issuer: "blue", target: b.id("r0"), kind: "callAmbulance", player: true });
    b.run(1);
    expect(of(b.events, "radio").some((e) => e.key === "radio.noAmbulance")).toBe(true);
    // Its crew is nobody's to order.
    submitOrder(b.sim, { tick: st.tick, issuer: "blue", target: st.vehicle.req(b.amb()).unit!, kind: "callAmbulance", player: true });
    b.run(1);
  });

  it("with care off nobody calls an ambulance", () => {
    const b = battle([{ id: "sl", x: 350, y: 470 }, ...riflemen(7), ...legs(1)], { medicalCare: false });
    b.run(400);
    expect(of(b.events, "medical.ambulance").length).toBe(0);
    expect(b.sim.state.vehicle.req(b.amb()).offMap!.phase).toBe("ready");
  });

  it("save and load mid-run (on its way to the edge, and loading) continue identically", () => {
    for (const phase of ["called", "loading"] as const) {
      const b = battle([{ id: "sl", x: 350, y: 470 }, ...riflemen(7), ...legs(2)]);
      const st = b.sim.state;
      b.until(() => st.vehicle.req(b.amb()).offMap!.phase === phase, 1200);
      expect(st.vehicle.req(b.amb()).offMap!.phase).toBe(phase);
      b.run(3);
      const saved = JSON.parse(JSON.stringify(saveSim(b.sim))) as SerializedState;
      const loaded = loadSim(b.input, saved);
      expect(hashState(loaded.state)).toBe(hashState(st));
      for (let t = 0; t < 120 * 60; t++) { step(b.sim); step(loaded); }
      expect(hashState(loaded.state)).toBe(hashState(st));
    }
  });
});
