/**
 * M10.6b combat vehicles' rear run, Role 1 outcome, end-of-battle settlement, roster (roadmap-detail slice 14).
 * Owner answers: combat vehicles take wounded when going back or idle, the player can order any vehicle (Q-9); those
 * still waiting at the end are settled by an end-of-battle roll (Q-1e); the side holding the ground evacuates, wounded
 * on enemy-held ground are captured and treated (Q-10); recovery days from wound severity and treatment (Q-16).
 */
import { describe, expect, it } from "vitest";
import { buildCatalog } from "@tcs/data";
import {
  createSim, DEFAULT_COMMS, diedOfWoundsChance, flatMap, hashState, healthyPhysiology, isOffMap, loadSim, newVehicleRecord, runBattle, saveSim, soldierRecordFromState, step, submitOrder,
  unitsFromState, type BattleInput, type Catalog, type EntityId, type SimEvent, type SoldierRecord, type SoldierState, type Wound,
} from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData();
const real: Catalog = buildCatalog(data, ["de", "ru"]);
/** A catalog where one casualty of any tag starts a run, and the trip off the map is two minutes (tests run minutes). */
const quick: Catalog = { ...real, medical: { ...real.medical!, rearRun: { ...real.medical!.rearRun!, startAny: 1, awayS: 120 } } };

const wound = (extra: Partial<Wound>): Wound => ({
  id: 1, zone: "legL", mechanism: "bullet", severity: 0.3, bleedingLps: 0, compressible: false, airway: false, breathing: false,
  consciousness: false, tickInflicted: 0, treatments: [], fracture: true, ...extra,
});
const KIT = [{ type: "de-tourniquet-cat", count: 1 }, { type: "de-pressure-dressing", count: 2 }, { type: "de-rescue-blanket", count: 1 }];

interface Man { id: string; x: number; y: number; hurt?: boolean; role?: string }
const rec = (m: Man): SoldierRecord => ({
  personId: m.id, given: "T", family: m.id, rank: "gefreiter", role: m.role ?? "grenadier", skills: { marksmanship: 0.5, medical: 0.2 }, fatigue: 0, stress: 0,
  wounds: m.hurt ? [wound({})] : [], load: KIT.map((x) => ({ ...x })), status: m.hurt ? "wounded" : "fit",
});

/**
 * A German platoon on a flat 1000 m map (the west edge nearest): HQ, squad "s1" (carried by Puma v1) with `hurt` men,
 * squad "s2" (Puma v2), both hulls standing at x 330.
 */
function battle(squad: Man[], opts: { catalog?: Catalog; medicalCare?: boolean; timeLimitSeconds?: number } = {}) {
  const catalog = opts.catalog ?? quick;
  const crew = (k: string) => ["d", "g", "c"].map((r) => rec({ id: `${k}${r}`, x: 0, y: 0 }));
  const s2: Man[] = Array.from({ length: 4 }, (_, i) => ({ id: `b${i}`, x: 360 + i * 4, y: 560 }));
  const hq: Man[] = [{ id: "pl", x: 330, y: 520 }, { id: "san", role: "sanitaeter", x: 332, y: 526 }];
  const input: BattleInput = {
    map: flatMap("rear-test", 1000, 1000, 4, "grass"), catalog, seed: 7, orders: [],
    rules: { timeLimitSeconds: opts.timeLimitSeconds ?? 36000, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "medical", physiologyParams: {}, objectives: [], ...(opts.medicalCare === false ? { medicalCare: false } : {}) },
    forces: [{
      side: "blue", faction: "de",
      units: [{ key: "p", callsign: "P", echelon: "platoon" as const, leaderIndex: 0, members: hq.map(rec), subunits: [
        { key: "s1", callsign: "S1", echelon: "squad" as const, leaderIndex: 0, carrierId: "v1", subunits: [], members: squad.map(rec) },
        { key: "c1", callsign: "C1", echelon: "vehicle" as const, leaderIndex: 0, vehicleId: "v1", subunits: [], members: crew("x") },
        { key: "s2", callsign: "S2", echelon: "squad" as const, leaderIndex: 0, carrierId: "v2", subunits: [], members: s2.map(rec) },
        { key: "c2", callsign: "C2", echelon: "vehicle" as const, leaderIndex: 0, vehicleId: "v2", subunits: [], members: crew("y") },
      ] }],
      placements: [...hq, ...squad, ...s2].map((m) => ({ personId: m.id, x: m.x, y: m.y, heading: 0 })),
      vehicles: [newVehicleRecord(catalog, "de-puma", "v1"), newVehicleRecord(catalog, "de-puma", "v2")],
      vehiclePlacements: [{ vehicleId: "v1", x: 330, y: 480, heading: 0 }, { vehicleId: "v2", x: 330, y: 580, heading: 0 }],
    }],
  };
  const sim = createSim(input);
  const id = (p: string): EntityId => [...sim.state.identity.entries()].find(([, i]) => i.personId === p)![0];
  const veh = (k: string): EntityId => [...sim.state.vehicle.entries()].find(([, v]) => v.vehicleId === k)![0];
  const unit = (cs: string): EntityId => [...sim.state.unit.entries()].find(([, u]) => u.callsign === cs)![0];
  const events: SimEvent[] = [];
  const run = (seconds: number) => { for (let t = 0; t < seconds * 60; t++) events.push(...step(sim)); };
  const until = (pred: () => boolean, maxS: number) => { for (let t = 0; t < maxS * 60 && !pred(); t++) events.push(...step(sim)); };
  const order = (target: EntityId, body: Record<string, unknown>) => submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target, player: true, ...body } as never);
  return { sim, input, id, veh, unit, events, run, until, order };
}

const of = <K extends SimEvent["kind"]>(ev: SimEvent[], k: K) => ev.filter((e): e is Extract<SimEvent, { kind: K }> => e.kind === k);
const riflemen = (n: number): Man[] => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, x: 350 + (i % 4) * 4, y: 470 + Math.floor(i / 4) * 4 }));
const hurt = (n: number): Man[] => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, x: 360 + i * 3, y: 500, hurt: true }));
const phases = (ev: SimEvent[], vid: EntityId) => of(ev, "medical.rearRun").filter((e) => e.vehicle === vid).map((e) => e.phase);

describe("combat vehicles' rear run (M10.6b)", () => {
  it("an idle hull takes the casualty at the nest off the map, hands him over and comes back to its squad", () => {
    const b = battle([{ id: "sl", x: 350, y: 460 }, ...riflemen(5), ...hurt(1)]);
    const st = b.sim.state, v1 = b.veh("v1"), v2 = b.veh("v2");
    b.until(() => st.vehicle.req(v1).rearRun?.phase === "away" || st.vehicle.req(v2).rearRun?.phase === "away", 1500);
    const runner = st.vehicle.req(v1).rearRun ? v1 : v2;
    const other = runner === v1 ? v2 : v1;
    expect(st.vehicle.req(runner).rearRun?.phase).toBe("away");
    expect(isOffMap(st.vehicle.req(runner))).toBe(true);
    // (At most one hull of the platoon at once; the other stays.)
    expect(st.vehicle.req(other).rearRun).toBeUndefined();
    const c = st.soldier.req(b.id("c0"));
    expect(c.evacuated?.via).toBe("vehicle");
    expect(c.aftercare).toBeDefined();
    expect(c.aftercare!.by).toBe("own");
    expect(c.aftercare!.role1Tick - c.evacuated!.tick).toBe(real.medical!.role1!.transferS * 60);
    expect(of(b.events, "medical.role1").map((e) => e.casualty)).toEqual([b.id("c0")]);
    expect(soldierRecordFromState(st, b.id("c0")).status).toBe(c.aftercare!.diedOfWoundsTick !== undefined ? "killed" : "evacuated");
    // The fit crew stays with the hull; it comes back after `awayS` and drives to its squad.
    const crewIn = st.vehicle.req(runner).seats.filter((s) => s !== null && s !== b.id("c0")).length;
    expect(crewIn).toBe(3);
    b.until(() => st.vehicle.req(runner).rearRun === undefined, 900);
    expect(phases(b.events, runner)).toEqual(["started", "arrived", "loaded", "departed", "away", "returned", "back"]);
    const away = of(b.events, "medical.rearRun").find((e) => e.phase === "away")!, ret = of(b.events, "medical.rearRun").find((e) => e.phase === "returned")!;
    expect((ret.tick - away.tick) / 60).toBeGreaterThanOrEqual(120);
    expect((ret.tick - away.tick) / 60).toBeLessThanOrEqual(122);
    const t = st.transform.req(runner);
    expect(t.x).toBeGreaterThan(0);
    expect(isOffMap(st.vehicle.req(runner))).toBe(false);
  });

  it("no run with the real data for one T2 casualty; none while the squad assaults", () => {
    const b = battle([{ id: "sl", x: 350, y: 460 }, ...riflemen(5), ...hurt(1)], { catalog: real });
    b.run(400);
    // (One man, not tagged T1: an ambulance is called instead, startAny is 3.)
    expect(of(b.events, "medical.rearRun").length).toBe(0);
    const a = battle([{ id: "sl", x: 350, y: 460 }, ...riflemen(5), ...hurt(1)]);
    a.order(a.unit("S1"), { kind: "assault", x: 600, y: 470 });
    a.order(a.unit("S2"), { kind: "assault", x: 600, y: 570 });
    let started = false;
    for (let i = 0; i < 300 && !started; i++) {
      a.run(1);
      for (const [vid, v] of a.sim.state.vehicle.entries()) {
        if (!v.rearRun) continue;
        // Never while the hull's own squad assaults.
        const sq = [...a.sim.state.unit.values()].find((u) => u.carrier === vid)!;
        expect(sq.drill?.kind).not.toBe("assault");
        started = true;
      }
    }
  });

  it("the player's order: refused with nobody to take, refused while the squad assaults, else the hull goes", () => {
    const b = battle([{ id: "sl", x: 350, y: 460 }, ...riflemen(5)], { catalog: real });
    b.order(b.unit("C1"), { kind: "rearRun" });
    b.run(2);
    expect(of(b.events, "radio").some((e) => e.key === "radio.rearRunNobody")).toBe(true);
    const a = battle([{ id: "sl", x: 350, y: 460 }, ...riflemen(5), ...hurt(1)], { catalog: real });
    a.until(() => [...a.sim.state.soldier.values()].some((s) => s.atNest !== undefined), 600);
    a.order(a.unit("S1"), { kind: "assault", x: 600, y: 470 });
    a.run(2);
    a.order(a.unit("C1"), { kind: "rearRun" });
    a.run(2);
    expect(of(a.events, "radio").some((e) => e.key === "radio.rearRunAssault")).toBe(true);
    a.order(a.unit("C2"), { kind: "rearRun" });
    a.run(2);
    const started = of(a.events, "medical.rearRun").find((e) => e.phase === "started")!;
    expect(started.ordered).toBe(true);
    expect(started.vehicle).toBe(a.veh("v2"));
  });

  it("an order to a hull away is refused; on the map an order ends the run", () => {
    const b = battle([{ id: "sl", x: 350, y: 460 }, ...riflemen(5), ...hurt(1)]);
    const st = b.sim.state;
    b.until(() => [...st.vehicle.values()].some((v) => v.rearRun !== undefined), 900);
    const vid = [...st.vehicle.entries()].find(([, v]) => v.rearRun)![0];
    const crew = st.vehicle.req(vid).unit!;
    b.order(crew, { kind: "move", waypoints: [{ x: 400, y: 400, mode: "walk" }] });
    b.run(2);
    expect(st.vehicle.req(vid).rearRun).toBeUndefined();
    expect(phases(b.events, vid)).toEqual(["started", "cancelled"]);
    // (It starts again on its own once idle; this time it is let go.)
    b.until(() => [...st.vehicle.values()].some((v) => v.rearRun?.phase === "away"), 1500);
    const away = [...st.vehicle.entries()].find(([, v]) => v.rearRun?.phase === "away")![0];
    b.order(st.vehicle.req(away).unit!, { kind: "move", waypoints: [{ x: 400, y: 400, mode: "walk" }] });
    b.run(2);
    expect(of(b.events, "radio").some((e) => e.key === "radio.rearRunAway")).toBe(true);
    expect(st.vehicle.req(away).rearRun?.phase).toBe("away");
  });

  it("a save mid-run continues identically (on the way, and away)", () => {
    for (const phase of ["toPoint", "away"] as const) {
      const b = battle([{ id: "sl", x: 350, y: 460 }, ...riflemen(5), ...hurt(1)]);
      b.until(() => [...b.sim.state.vehicle.values()].some((v) => v.rearRun?.phase === phase), 1500);
      const save = JSON.parse(JSON.stringify(saveSim(b.sim)));
      b.run(150);
      const l = loadSim(b.input, save);
      for (let i = 0; i < 150 * 60; i++) step(l);
      expect(hashState(l.state)).toBe(hashState(b.sim.state));
    }
  });
});

describe("Role 1 outcome and the end-of-battle settlement (M10.6b)", () => {
  const ctx = { catalog: real } as never;
  const man = (p: Partial<SoldierState["physiology"]>, sev = 0.3, woundTick = 0): SoldierState => ({ physiology: { ...healthyPhysiology(), ...p }, wounds: [wound({ severity: sev, tickInflicted: woundTick })] } as SoldierState);
  it("the died-of-wounds chance rises with shock, blood loss, lateness and a captor's care; capped", () => {
    const light = diedOfWoundsChance(ctx, man({}), 600 * 60, "own");
    const shocked = diedOfWoundsChance(ctx, man({ shock: 0.6, bloodVolumeL: 3 }), 600 * 60, "own");
    expect(light).toBeLessThan(0.06);
    expect(shocked).toBeGreaterThan(0.2);
    expect(diedOfWoundsChance(ctx, man({ shock: 0.6, bloodVolumeL: 3 }), 3 * 3600 * 60, "own")).toBeGreaterThan(shocked);
    expect(diedOfWoundsChance(ctx, man({}), 600 * 60, "captor")).toBeCloseTo(light * real.medical!.role1!.dow.captorFactor, 6);
    expect(diedOfWoundsChance(ctx, man({ shock: 1, bloodVolumeL: 1, respiratory: 0.9, consciousness: 0 }, 1), 10 * 3600 * 60, "captor")).toBe(real.medical!.role1!.dow.max);
  });

  it("at the end: the side holding the ground evacuates; on enemy-held ground he is captured and treated; a prisoner too", () => {
    const mk = (side: "blue" | "red", faction: string, men: Man[], status?: SoldierRecord["status"]) => ({
      side, faction,
      units: [{ key: side, callsign: side.toUpperCase(), echelon: "squad" as const, leaderIndex: 0, subunits: [], members: men.map((m) => ({ ...rec(m), ...(m.hurt && status ? { status } : {}) })) }],
      placements: men.map((m) => ({ personId: m.id, x: m.x, y: m.y, heading: 0 })),
    });
    const input: BattleInput = {
      map: flatMap("settle-test", 1000, 1000, 4, "grass"), catalog: real, seed: 3, orders: [],
      rules: { timeLimitSeconds: 2, commsModel: "simple", comms: DEFAULT_COMMS, physiologyModel: "medical", physiologyParams: {}, objectives: [] },
      forces: [
        // own: one hurt man near his squad (theirs), one hurt man far out next to the enemy, one walking wounded who fights
        mk("blue", "de", [{ id: "b0", x: 200, y: 200 }, { id: "b1", x: 204, y: 200 }, { id: "bh", x: 210, y: 210, hurt: true }, { id: "bf", x: 800, y: 800, hurt: true }]),
        mk("red", "ru", [{ id: "r0", x: 820, y: 800 }, { id: "r1", x: 824, y: 804 }, { id: "rp", x: 215, y: 205, hurt: true }], "captured"),
      ],
    };
    const r = runBattle(input);
    const out = (side: number, p: string) => r.forcesOut[side]!.units[0]!.members.find((m) => m.personId === p)!;
    const bh = out(0, "bh"), bf = out(0, "bf"), rp = out(1, "rp");
    expect(bh.status === "evacuated" || bh.diedOfWoundsTick !== undefined).toBe(true);
    expect(bf.status === "captured" || bf.diedOfWoundsTick !== undefined).toBe(true);
    expect(rp.status === "captured" || rp.diedOfWoundsTick !== undefined).toBe(true);
    for (const m of [bh, bf, rp]) expect(m.recoveryDays !== undefined || m.diedOfWoundsTick !== undefined).toBe(true);
    // Same seed, same outcome.
    const again = runBattle(input);
    expect(JSON.stringify(again.forcesOut)).toBe(JSON.stringify(r.forcesOut));
    expect(r.eventCounts["medical.settled"]).toBe(3);
  });

  it("recovery days: a broken bone takes longer than a graze; the roster keeps wounds, treatments and status", () => {
    const b = battle([{ id: "sl", x: 350, y: 460 }, ...riflemen(3), ...hurt(2)], { timeLimitSeconds: 120 });
    const r = runBattle({ ...b.input });
    const men = unitsFromState(b.sim.state, "blue", b.input.forces[0]!.units); // (fresh state: nothing settled)
    expect(men[0]!.subunits[0]!.members.every((m) => m.recoveryDays === undefined)).toBe(true);
    const out = r.forcesOut[0]!.units[0]!.subunits[0]!.members;
    for (const p of ["c0", "c1"]) {
      const m = out.find((x) => x.personId === p)!;
      if (m.diedOfWoundsTick !== undefined) { expect(m.status).toBe("killed"); continue; }
      // (Severity 0.3 band 14-35 d, a fracture +30-60 d.)
      expect(m.recoveryDays!).toBeGreaterThanOrEqual(44);
      expect(m.wounds[0]!.treatments.length).toBeGreaterThanOrEqual(0);
      // Round trip: the record goes back in and comes out with the same wounds and status.
      const back = JSON.parse(JSON.stringify(m)) as SoldierRecord;
      expect(back.wounds).toEqual(m.wounds);
      expect(back.status).toBe(m.status);
    }
  });
});
