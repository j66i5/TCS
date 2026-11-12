/**
 * Getting in and out of vehicles (M7.2, plan §6): mount and dismount orders, exit queues, the vehicle holding
 * while men pass, orders to a squad aboard (Q12), loading casualties (Q25), the seat check (radio.noSeats),
 * seat swaps (Q13), refilling from the carrier (rule 9), the intercom, and surrender gated for men aboard.
 */
import { describe, expect, it } from "vitest";
import {
  countItems, createSim, hashState, loadSim, saveSim, step, submitOrder, unitArrived,
  type BattleInput, type Catalog, type EntityId, type Placement, type Sim, type SimEvent, type UnitInput,
} from "../src/index";
import { rec, testCatalog, vehicleInput } from "./helpers";

/** The test tank with six passenger seats and stowed magazines. */
const CAT: Catalog = {
  ...testCatalog,
  vehicles: {
    tank: {
      ...testCatalog.vehicles["tank"]!,
      seats: [
        ...testCatalog.vehicles["tank"]!.seats.filter((s) => s.station !== "passenger"),
        ...[0, 1, 2, 3, 4, 5].map((i) => ({ id: `p${i + 1}`, station: "passenger" as const, pos: [-1 - 0.8 * Math.floor(i / 2), i % 2 === 0 ? 0.8 : -0.8, 1.2] as [number, number, number], part: "hull" as const, hatch: false })),
      ],
    },
  },
};

interface RideOpts { men?: number; aboard?: boolean; casualties?: { x: number; y: number }[]; mags?: number; stowedMags?: number }

/** The tank at (50, 100) facing east, its crew, and a squad "sq" carried by it (aboard, or 30 m west of it). */
function rideInput(o: RideOpts = {}): BattleInput {
  const input = vehicleInput(1, 600);
  input.catalog = CAT;
  const n = o.men ?? 4;
  const sq: UnitInput = {
    key: "sq", callsign: "Sq", echelon: "squad", leaderIndex: 0, subunits: [], carrierId: "v1",
    members: [
      ...Array.from({ length: n }, (_, i) => ({ ...rec(`sq.${i}`, [{ type: "mag", count: o.mags ?? 3, charge: 30 }]), weapon: "rifle" })),
      ...(o.casualties ?? []).map((_, i) => ({ ...rec(`sq.c${i}`, [{ type: "mag", count: 1, charge: 30 }]), status: "incapacitated" as const })),
    ],
  };
  const blue = input.forces[0]!;
  blue.units.push(sq);
  const places: Placement[] = sq.members.slice(0, n).map((m, i) => (o.aboard ? { personId: m.personId, x: 50, y: 100, heading: 0, mountedIn: "v1" } : { personId: m.personId, x: 20, y: 94 + i * 4, heading: 0 }));
  (o.casualties ?? []).forEach((c, i) => places.push({ personId: `sq.c${i}`, x: c.x, y: c.y, heading: 0 }));
  blue.placements.push(...places);
  blue.vehicles![0]!.load.push({ type: "mag", count: o.stowedMags ?? 0, charge: 30 });
  if ((o.stowedMags ?? 0) === 0) blue.vehicles![0]!.load.pop();
  return input;
}

const unitBy = (sim: Sim, callsign: string): EntityId => [...sim.state.unit.entries()].find(([, u]) => u.callsign === callsign)![0];
const vid = (sim: Sim): EntityId => [...sim.state.vehicle.keys()][0]!;
const order = (sim: Sim, target: EntityId, body: Record<string, unknown>) => submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target, ...body } as never);

function run(sim: Sim, seconds: number, until?: (e: SimEvent[], all: SimEvent[]) => boolean): SimEvent[] {
  const all: SimEvent[] = [];
  for (let i = 0; i < seconds * 60; i++) {
    const ev = step(sim);
    all.push(...ev);
    if (until?.(ev, all)) break;
  }
  return all;
}
const radios = (ev: SimEvent[]) => ev.filter((e): e is Extract<SimEvent, { kind: "radio" }> => e.kind === "radio").map((e) => e.key);

describe("mount and dismount (M7.2)", () => {
  it("a squad on foot walks to the exit, gets in one at a time, and rides with the hull", () => {
    const sim = createSim(rideInput());
    const sq = unitBy(sim, "Sq"), v = vid(sim);
    expect(sim.state.unit.req(sq).carrier).toBe(v);
    order(sim, sq, { kind: "mount" });
    const ev = run(sim, 90, (e) => e.some((x) => x.kind === "unit.mounted"));
    const mounted = ev.filter((e) => e.kind === "soldier.mounted");
    expect(mounted.length).toBe(4);
    // One exit: never two men passing at once (each takes mountSecondsPerMan = 2 s).
    const ticks = mounted.map((e) => e.tick);
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]! - ticks[i - 1]!).toBeGreaterThanOrEqual(120);
    expect(radios(ev)).toContain("radio.mounted");
    for (const m of sim.state.unit.req(sq).members) expect(sim.state.soldier.req(m).mount?.vehicle).toBe(v);
    expect(sim.state.unit.req(sq).boarding).toBeUndefined();
    expect(sim.state.vehicle.req(v).drive.holdForDismount).toBe(false);
    // The men ride: drive 100 m east; their positions follow their seats.
    order(sim, sim.state.vehicle.req(v).unit!, { kind: "move", waypoints: [{ x: 200, y: 100, mode: "run" }] });
    run(sim, 60, (e) => e.some((x) => x.kind === "unit.arrived"));
    const t = sim.state.transform.req(v);
    for (const m of sim.state.unit.req(sq).members) expect(Math.hypot(sim.state.transform.req(m).x - t.x, sim.state.transform.req(m).y - t.y)).toBeLessThan(4);
    expect(t.x).toBeGreaterThan(180);
  });

  it("dismount: the hull holds, the men land 3-8 m behind the exit crouching, then it drives on", () => {
    const sim = createSim(rideInput({ aboard: true }));
    const sq = unitBy(sim, "Sq"), v = vid(sim), crew = sim.state.vehicle.req(v).unit!;
    order(sim, crew, { kind: "move", waypoints: [{ x: 400, y: 100, mode: "run" }] });
    run(sim, 8);
    expect(Math.abs(sim.state.vehicle.req(v).drive.speed)).toBeGreaterThan(2);
    order(sim, sq, { kind: "dismount" });
    const ev = run(sim, 40, (e) => e.some((x) => x.kind === "unit.dismounted"));
    expect(ev.filter((e) => e.kind === "soldier.dismounted").length).toBe(4);
    // Nobody got out while it was still moving.
    const firstOut = ev.find((e) => e.kind === "soldier.dismounted")!.tick;
    expect(firstOut).toBeGreaterThan(ev.find((e) => e.kind === "order.delivered")!.tick);
    const t = sim.state.transform.req(v);
    const exitX = t.x - 3.8 * Math.cos(t.heading), exitY = t.y - 3.8 * Math.sin(t.heading);
    for (const m of sim.state.unit.req(sq).members) {
      const s = sim.state.soldier.req(m), mt = sim.state.transform.req(m);
      expect(s.mount).toBeUndefined();
      expect(s.posture).toBe("crouching");
      const d = Math.hypot(mt.x - exitX, mt.y - exitY);
      expect(d).toBeGreaterThanOrEqual(2);
      expect(d).toBeLessThanOrEqual(9.5);
    }
    expect(radios(ev)).toContain("radio.dismounted");
    // Released: it drives on to its goal.
    expect(sim.state.vehicle.req(v).drive.holdForDismount).toBe(false);
    const x0 = t.x;
    run(sim, 10);
    expect(sim.state.transform.req(v).x).toBeGreaterThan(x0 + 10);
  });

  it("an order to a squad aboard: it gets out first, then carries it out (Q12)", () => {
    const sim = createSim(rideInput({ aboard: true }));
    const sq = unitBy(sim, "Sq");
    order(sim, sq, { kind: "move", waypoints: [{ x: 20, y: 160, mode: "walk" }] });
    const ev = run(sim, 120, (_e, all) => all.some((x) => x.kind === "unit.arrived" && x.unit === sq));
    expect(radios(ev)).toContain("radio.dismountFirst");
    const out = ev.findIndex((e) => e.kind === "unit.dismounted");
    const arrived = ev.findIndex((e) => e.kind === "unit.arrived" && e.unit === sq);
    expect(out).toBeGreaterThanOrEqual(0);
    expect(arrived).toBeGreaterThan(out);
    for (const m of sim.state.unit.req(sq).members) expect(Math.hypot(sim.state.transform.req(m).x - 20, sim.state.transform.req(m).y - 160)).toBeLessThan(25);
  });

  it("while the squad gets out before an order, the unit has not arrived", () => {
    const sim = createSim(rideInput({ aboard: true }));
    const sq = unitBy(sim, "Sq");
    order(sim, sq, { kind: "move", waypoints: [{ x: 20, y: 160, mode: "walk" }] });
    run(sim, 1);
    expect(sim.state.unit.req(sq).boarding?.then?.kind).toBe("move");
    expect(unitArrived(sim.state, sq)).not.toBe(true);
  });

  it("fewer free seats than men: unable, radio.noSeats", () => {
    const sim = createSim(rideInput({ men: 7 }));
    const sq = unitBy(sim, "Sq");
    order(sim, sq, { kind: "mount" });
    const ev = run(sim, 2);
    expect(radios(ev)).toContain("radio.noSeats");
    expect(sim.state.unit.req(sq).boarding).toBeUndefined();
  });

  it("a mount order to a squad with no vehicle: radio.noVehicle; to a crew: unable", () => {
    const input = rideInput();
    delete input.forces[0]!.units[1]!.carrierId;
    const sim = createSim(input);
    order(sim, unitBy(sim, "Sq"), { kind: "mount" });
    order(sim, sim.state.vehicle.req(vid(sim)).unit!, { kind: "mount" });
    const ev = run(sim, 2);
    expect(radios(ev)).toContain("radio.noVehicle");
    expect(radios(ev)).toContain("radio.unable");
  });

  it("a casualty within 5 m of the exit is loaded by two men; one beyond stays and does not block completion (Q25)", () => {
    // Exit at (46.2, 100): one wounded man 3 m from it, one 40 m away.
    const sim = createSim(rideInput({ men: 3, casualties: [{ x: 43.5, y: 101 }, { x: 10, y: 160 }] }));
    const sq = unitBy(sim, "Sq"), v = vid(sim);
    const [near, far] = sim.state.unit.req(sq).members.slice(3);
    order(sim, sq, { kind: "mount" });
    const ev = run(sim, 120, (e) => e.some((x) => x.kind === "unit.mounted"));
    expect(ev.some((e) => e.kind === "unit.mounted")).toBe(true);
    expect(sim.state.soldier.req(near!).mount?.vehicle).toBe(v);
    expect(sim.state.soldier.req(far!).mount).toBeUndefined();
    const loads = ev.filter((e) => e.kind === "action.started" && e.action === "loadCasualty");
    expect(loads.length).toBe(2); // two men carry him
    for (const m of sim.state.unit.req(sq).members.slice(0, 3)) expect(sim.state.soldier.req(m).mount?.vehicle).toBe(v);
    // Completion came before the 60 s timeout after the first man got in.
    const first = ev.find((e) => e.kind === "soldier.mounted")!.tick;
    expect(ev.find((e) => e.kind === "unit.mounted")!.tick - first).toBeLessThan(60 * 60);
  });

  it("a man out of spare magazines refills from the halted carrier; items are conserved", () => {
    const sim = createSim(rideInput({ men: 1, mags: 1, stowedMags: 5 }));
    const sq = unitBy(sim, "Sq"), v = vid(sim), m = sim.state.unit.req(sq).members[0]!;
    const rounds = (id: EntityId) => (sim.state.container.get(id)?.stacks ?? []).filter((s) => s.type === "mag").reduce((n, s) => n + s.count * (s.charge ?? 0), 0) + (sim.state.weapon.get(id)?.magazine?.rounds ?? 0);
    const mags = (id: EntityId) => countItems(sim.state.container.req(id), "mag") + (sim.state.weapon.get(id)?.magazine ? 1 : 0);
    const before = { r: rounds(m) + rounds(v), n: mags(m) + mags(v) };
    expect(countItems(sim.state.container.req(m), "mag")).toBe(0);
    sim.state.weapon.req(m).lowAmmoReported = true; // down to the magazine in his rifle
    const ev = run(sim, 60, (e) => e.some((x) => x.kind === "items.transferred"));
    const tr = ev.find((e) => e.kind === "items.transferred");
    expect(tr).toMatchObject({ from: v, to: m, item: "mag", count: 3 });
    expect(countItems(sim.state.container.req(m), "mag")).toBe(3);
    expect(countItems(sim.state.container.req(v), "mag")).toBe(2);
    expect(rounds(m) + rounds(v)).toBe(before.r);
    expect(mags(m) + mags(v)).toBe(before.n);
  });

  it("a fallen driver is replaced by the commander after the seat-swap time; the casualty stays aboard (Q13 default)", () => {
    const sim = createSim(rideInput({ men: 0 }));
    const v = vid(sim), veh = sim.state.vehicle.req(v);
    const def = CAT.vehicles["tank"]!;
    const drvSeat = def.seats.findIndex((s) => s.station === "driver"), cmdSeat = def.seats.findIndex((s) => s.station === "commander");
    const driver = veh.seats[drvSeat]!, commander = veh.seats[cmdSeat]!;
    const ds = sim.state.soldier.req(driver);
    ds.physiology.alive = false; ds.physiology.consciousness = 0; ds.casualty = "killed";
    order(sim, veh.unit!, { kind: "move", waypoints: [{ x: 300, y: 100, mode: "run" }] });
    const ev = run(sim, 30, (e) => e.some((x) => x.kind === "vehicle.seatSwap"));
    expect(radios(ev)).toContain("radio.noDriver");
    const sw = ev.find((e) => e.kind === "vehicle.seatSwap");
    expect(sw).toMatchObject({ vehicle: v, seat: drvSeat, soldier: commander, casualty: driver });
    expect(sw!.tick - ev.find((e) => e.kind === "action.started" && e.action === "seatSwap")!.tick).toBe(20 * 60);
    expect(veh.seats[drvSeat]).toBe(commander);
    expect(veh.seats[cmdSeat]).toBe(driver);
    expect(sim.state.soldier.req(driver).mount).toEqual({ vehicle: v, seat: cmdSeat });
    // Now it can drive.
    order(sim, veh.unit!, { kind: "move", waypoints: [{ x: 300, y: 100, mode: "run" }] });
    run(sim, 20);
    expect(sim.state.transform.req(v).x).toBeGreaterThan(100);
  });

  it("intercom inside, radio between inside and outside", () => {
    const sim = createSim(rideInput({ men: 2, aboard: true }));
    const sq = unitBy(sim, "Sq");
    const [a, b] = sim.state.unit.req(sq).members;
    const crewman = sim.state.unit.req(sim.state.vehicle.req(vid(sim)).unit!).members[0]!;
    expect(sim.ctx.comms.contactShareDelayTicks(sim.state, sim.ctx.rules.comms, a!, crewman)).toBe(0);
    order(sim, b!, { kind: "dismount" });
    run(sim, 10);
    expect(sim.state.soldier.req(b!).mount).toBeUndefined();
    expect(sim.state.soldier.req(a!).mount).toBeDefined();
    // Two metres apart, but one is behind armour: radio delay, not voice.
    expect(sim.ctx.comms.contactShareDelayTicks(sim.state, sim.ctx.rules.comms, a!, b!)).toBe(sim.ctx.rules.comms.contactShareDelaySeconds * 60);
  });

  it("a man aboard does not give up; the same man on foot does", () => {
    for (const aboard of [true, false]) {
      const sim = createSim(rideInput({ men: 1, aboard }));
      const m = sim.state.unit.req(unitBy(sim, "Sq")).members[0]!;
      const s = sim.state.soldier.req(m), t = sim.state.transform.req(m);
      const enemy = [...sim.state.identity.entries()].find(([, i]) => i.side === "red")![0];
      s.mental.behaviour = "panicked"; s.mental.stress = 1;
      s.contacts = [{ target: enemy, x: t.x + 10, y: t.y, errM: 2, kind: "seen", tick: 0, reportedTick: 0 }];
      for (let i = 0; i < 60; i++) { s.contacts[0]!.tick = sim.state.tick; step(sim); }
      expect(s.captive !== null).toBe(!aboard);
    }
  });
});

describe("boarding is saved and continues identically (determinism)", () => {
  const cases: [string, RideOpts, (sim: Sim) => void, number][] = [
    ["mid-mount", {}, (sim) => order(sim, unitBy(sim, "Sq"), { kind: "mount" }), 14],
    ["mid-dismount", { aboard: true }, (sim) => order(sim, unitBy(sim, "Sq"), { kind: "dismount" }), 3.5],
    ["mid-loadCasualty", { men: 3, casualties: [{ x: 43.5, y: 101 }] }, (sim) => order(sim, unitBy(sim, "Sq"), { kind: "mount" }), 0],
  ];
  for (const [name, opts, give, at] of cases) {
    it(`a save ${name} continues as the original`, () => {
      const input = rideInput(opts);
      const a = createSim(input);
      give(a);
      if (name === "mid-loadCasualty") run(a, 60, (e) => e.some((x) => x.kind === "action.started" && x.action === "loadCasualty"));
      else run(a, at);
      if (name === "mid-loadCasualty") { run(a, 3); expect([...a.state.action.values()].some((x) => x.kind === "loadCasualty")).toBe(true); }
      else expect([...a.state.unit.values()].some((u) => u.boarding !== undefined)).toBe(true);
      const b = loadSim(input, JSON.parse(JSON.stringify(saveSim(a))));
      for (let i = 0; i < 40 * 60; i++) { step(a); step(b); }
      expect(hashState(b.state)).toBe(hashState(a.state));
    });
  }
});
