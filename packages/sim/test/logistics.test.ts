/** M11.1: moveCharge, the ledger, refilling magazines from loose rounds, late arrival. */
import { describe, expect, it } from "vitest";
import {
  addItems, checkConservation, consumedFromEvents, createSim, emptyConsumption, emptyContainer, hashState, ledgerOf, loadSim, moveCharge,
  flatMap, REFILL_ACTION, saveSim, secondsToTicks, step, Store, submitOrder, tracerMap, unitsFromState, type BattleInput, type Catalog, type Container, type Sim, type SimEvent,
} from "../src/index";
import { armedInput, testCatalog } from "./helpers";

const catalog: Catalog = {
  ...testCatalog,
  items: {
    ...testCatalog.items,
    bandolier: { id: "bandolier", massKg: 0.15, category: "ammo-package", chargeCapacity: 140, chargeMassKg: 0.012, chargeItem: "ball", stripperClips: true },
    pack: { id: "pack", massKg: 0.01, category: "ammo-package", chargeCapacity: 30, chargeMassKg: 0.012, chargeItem: "ball" },
    "jerrycan": { id: "jerrycan", massKg: 4, category: "fuel", chargeCapacity: 20, chargeMassKg: 0.84, chargeKind: "diesel" },
    "tank-diesel": { id: "tank-diesel", massKg: 0, category: "fuel", chargeCapacity: 500, chargeMassKg: 0.84, chargeKind: "diesel" },
  },
  behaviour: { ...testCatalog.behaviour, refill: { belowFraction: 0.5, quietS: 20, underFireBelow: 0.1, secondsPerRound: 1.2, secondsPerRoundClips: 0.4 } },
};

const box = () => { const s = new Store<Container>(); s.set(1, emptyContainer()); s.set(2, emptyContainer()); return s; };
const charge = (c: Container, t: string) => c.stacks.filter((s) => s.type === t).reduce((n, s) => n + (s.charge ?? 0) * s.count, 0);

describe("moveCharge (M11.1)", () => {
  it("moves rounds from a bandolier into one magazine, splitting stacks, conserving the rounds", () => {
    const s = box();
    addItems(s.req(1), "bandolier", 2, 140);
    addItems(s.req(1), "mag", 3, 5);
    const r = moveCharge(catalog, s, { from: 1, fromType: "bandolier", fromCharge: 140, to: 1, toType: "mag", toCharge: 5, amount: 100 });
    expect(r).toEqual({ moved: 25 }); // (up to the magazine's 30)
    const c = s.req(1);
    expect(c.stacks.filter((x) => x.type === "mag").map((x) => [x.count, x.charge])).toEqual([[2, 5], [1, 30]]);
    expect(c.stacks.filter((x) => x.type === "bandolier").map((x) => [x.count, x.charge])).toEqual([[1, 115], [1, 140]]);
    expect(charge(c, "mag") + charge(c, "bandolier")).toBe(3 * 5 + 280);
  });

  it("works between two containers and for litres of the same kind", () => {
    const s = box();
    addItems(s.req(1), "jerrycan", 1, 20);
    addItems(s.req(2), "tank-diesel", 1, 300);
    expect(moveCharge(catalog, s, { from: 1, fromType: "jerrycan", fromCharge: 20, to: 2, toType: "tank-diesel", toCharge: 300, amount: 20 })).toEqual({ moved: 20 });
    expect(charge(s.req(2), "tank-diesel")).toBe(320);
    expect(charge(s.req(1), "jerrycan")).toBe(0);
    expect(s.req(1).stacks).toEqual([{ type: "jerrycan", count: 1, charge: 0 }]); // (the empty can stays)
  });

  it("refuses a mismatch of kinds and an item that is not there", () => {
    const s = box();
    addItems(s.req(1), "jerrycan", 1, 20);
    addItems(s.req(1), "mag", 1, 0);
    expect(moveCharge(catalog, s, { from: 1, fromType: "jerrycan", fromCharge: 20, to: 1, toType: "mag", toCharge: 0, amount: 5 }).refused).toBe("kind-mismatch");
    expect(moveCharge(catalog, s, { from: 1, fromType: "bandolier", fromCharge: 140, to: 1, toType: "mag", toCharge: 0, amount: 5 }).refused).toBe("no-item");
    expect(s.req(1).stacks).toEqual([{ type: "jerrycan", count: 1, charge: 20 }, { type: "mag", count: 1, charge: 0 }]);
  });
});

describe("ledger (M11.1)", () => {
  it("counts rounds in containers, weapons, packages and tracer-mapped shots", () => {
    const input = armedInput(1, 60);
    input.catalog = catalog;
    for (const m of input.forces[0]!.units[0]!.members) m.load.push({ type: "bandolier", count: 1, charge: 140 });
    const sim = createSim(input);
    const l = ledgerOf(catalog, sim.state);
    // 5 men x 3 magazines of 30, the 3 blue men a bandolier each.
    expect(l.ammo["ball"]).toBe(5 * 90 + 3 * 140);
    expect(l.items["bandolier"]).toBe(3);
    // A tracer shot counts as its belt's cartridge.
    const c = emptyConsumption();
    consumedFromEvents(c, [{ kind: "shot.fired", tick: 0, shooter: 1, x: 0, y: 0, z: 0, dirX: 1, dirY: 0, weapon: "gun", ammo: "tball" }], tracerMap(catalog));
    expect(c.used).toEqual({ ball: 1 });
    expect(checkConservation(l, { ...l, ammo: { ball: l.ammo["ball"]! - 1 } }, c)).toEqual({});
    expect(checkConservation(l, { ...l, ammo: { ball: l.ammo["ball"]! - 2 } }, c)).toEqual({ ball: 1 });
  });
});

function run(sim: Sim, seconds: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < secondsToTicks(seconds); i++) out.push(...step(sim));
  return out;
}

/** One blue rifleman with a nearly empty spare magazine and a bandolier (or packs), nobody near him. */
function refillInput(pkg: "bandolier" | "pack" = "bandolier"): BattleInput {
  const input = armedInput(1, 600);
  input.catalog = catalog;
  input.rules.physiologyModel = "simple";
  const m = input.forces[0]!.units[0]!.members[0]!;
  m.load = [{ type: "mag", count: 1, charge: 30 }, { type: "mag", count: 1, charge: 4 }, pkg === "bandolier" ? { type: "bandolier", count: 1, charge: 140 } : { type: "pack", count: 2, charge: 30 }];
  input.forces[0]!.units[0]!.members = [m];
  input.forces[0]!.placements = [{ personId: m.personId, x: 20, y: 20, heading: 0 }];
  input.forces[1]!.placements = input.forces[1]!.placements.map((p, i) => ({ ...p, x: 190, y: 180 + i * 4 }));
  return input;
}
const blueMan = (sim: Sim) => [...sim.state.identity.entries()].find(([, i]) => i.side === "blue")![0];

describe("refillMagazines (M11.1)", () => {
  it("in a quiet moment he refills his spare magazine from the bandolier, rounds conserved", () => {
    const sim = createSim(refillInput());
    const id = blueMan(sim);
    const before = ledgerOf(catalog, sim.state).ammo["ball"];
    // Nothing until he has been quiet for 20 s since his last shot (none yet: lastShotTick far back) -> soon.
    const ev = run(sim, 30);
    const refilled = ev.filter((e) => e.kind === "items.refilled");
    expect(refilled.length).toBe(1);
    expect(refilled[0]).toMatchObject({ soldier: id, item: "mag", rounds: 26 });
    const c = sim.state.container.req(id);
    expect(c.stacks.find((s) => s.type === "bandolier")?.charge).toBe(114);
    expect(ledgerOf(catalog, sim.state).ammo["ball"]).toBe(before);
    // 26 rounds from clips at 0.4 s: about 10.4 s.
    const start = ev.find((e) => e.kind === "action.started" && e.action === REFILL_ACTION)!;
    expect(start.kind === "action.started" && start.durationTicks).toBe(26 * secondsToTicks(0.4));
  });

  it("not while he has fired within 20 s, nor under fire", () => {
    const sim = createSim(refillInput());
    const id = blueMan(sim);
    sim.state.weapon.req(id).lastShotTick = 0; // he just fired
    expect(run(sim, 15).some((e) => e.kind === "action.started" && e.action === REFILL_ACTION)).toBe(false);
    sim.state.soldier.req(id).mental.suppression = 0.5;
    sim.state.weapon.req(id).lastShotTick = -1e6;
    expect(run(sim, 1).some((e) => e.kind === "action.started" && e.action === REFILL_ACTION)).toBe(false);
  });

  it("interrupted, he keeps the rounds already loaded; save and load mid-action replay the same", () => {
    const sim = createSim(refillInput("pack"));
    const id = blueMan(sim);
    while (!sim.state.action.has(id)) run(sim, 1);
    run(sim, 6); // 6 s at 1.2 s a round by hand: 5 rounds in
    // Save mid-action: the loaded sim steps exactly like the original.
    const save = saveSim(sim);
    const copy = loadSim(refillInput("pack"), save);
    run(sim, 2); run(copy, 2);
    expect(hashState(copy.state)).toBe(hashState(sim.state));
    // Fire comes in: he stops, with what he has loaded.
    sim.state.soldier.req(id).mental.suppression = 0.5;
    const ev = run(sim, 0.1);
    expect(ev.some((e) => e.kind === "action.interrupted" && e.action === REFILL_ACTION)).toBe(true);
    const c = sim.state.container.req(id);
    const mags = c.stacks.filter((s) => s.type === "mag").map((s) => s.charge);
    const loaded = mags.find((x) => x !== 30)! - 4;
    expect(loaded).toBeGreaterThanOrEqual(5);
    expect(loaded).toBeLessThanOrEqual(7);
    expect(charge(c, "pack") + charge(c, "mag")).toBe(60 + 4); // (the full one is in his weapon)
  });

  it("an order to fire ends it at once (the fire system waits for no action)", () => {
    const sim = createSim(refillInput());
    const id = blueMan(sim);
    while (!sim.state.action.has(id)) run(sim, 1);
    const uid = sim.state.identity.req(id).unit;
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: uid, kind: "fire", x: 190, y: 180, heightM: 1 });
    const ev = run(sim, 3);
    expect(ev.some((e) => e.kind === "action.interrupted" && e.action === REFILL_ACTION && e.reason === "fire")).toBe(true);
  });

  it("never refills belts (machine guns)", () => {
    const input = refillInput();
    const m = input.forces[0]!.units[0]!.members[0]!;
    m.weapon = "gun";
    m.load = [{ type: "belt", count: 1, charge: 50 }, { type: "belt", count: 1, charge: 3 }, { type: "bandolier", count: 1, charge: 140 }];
    const sim = createSim(input);
    expect(run(sim, 40).some((e) => e.kind === "action.started" && e.action === REFILL_ACTION)).toBe(false);
  });

  it("not with rules.refill false", () => {
    const input = refillInput();
    input.rules.refill = false;
    const sim = createSim(input);
    expect(run(sim, 40).some((e) => e.kind === "items.refilled")).toBe(false);
  });

  it("still with rules.resupply false (balance pass 3: only the supply chain is off)", () => {
    const input = refillInput();
    input.rules.resupply = false;
    const sim = createSim(input);
    expect(run(sim, 40).some((e) => e.kind === "items.refilled")).toBe(true);
  });
});

describe("late arrival (M11.1)", () => {
  function lateInput(): BattleInput {
    const input = armedInput(1, 600);
    input.forces[1]!.units[0]!.arriveS = 20;
    return input;
  }
  it("a late unit is not in the state until its time, then enters at its placements; save and load in between", () => {
    const sim = createSim(lateInput());
    const reds = () => [...sim.state.identity.entries()].filter(([, i]) => i.side === "red").map(([id]) => id);
    expect(reds()).toEqual([]);
    expect([...sim.state.unit.values()].some((u) => u.side === "red")).toBe(false);
    run(sim, 10);
    expect(reds()).toEqual([]);
    // The side with a wave still to come is not beaten (the objective rule): the battle goes on.
    const save = saveSim(sim);
    const copy = loadSim(lateInput(), save);
    const ev = run(sim, 12);
    run(copy, 12);
    expect(ev.filter((e) => e.kind === "unit.entered").length).toBe(1);
    // What they carry enters as a delivery: 2 men x 3 magazines of 30.
    expect(ev.filter((e) => e.kind === "items.delivered").map((e) => e.kind === "items.delivered" && [e.ammo, e.rounds])).toEqual([["ball", 180]]);
    expect(reds().length).toBe(2);
    expect(sim.state.transform.req(reds()[0]!).x).toBe(190);
    expect(hashState(copy.state)).toBe(hashState(sim.state));
    // It does not come twice.
    expect(run(sim, 5).some((e) => e.kind === "unit.entered")).toBe(false);
  });

  it("a unit that never arrived comes out of the battle unchanged", () => {
    const input = lateInput();
    input.forces[1]!.units[0]!.arriveS = 9999;
    const sim = createSim(input);
    run(sim, 2);
    const out = unitsFromState(sim.state, "red", input.forces[1]!.units);
    expect(out[0]!.members).toEqual(input.forces[1]!.units[0]!.members);
  });
});

describe("fire at a known place (M11.1 point 7b)", () => {
  function sk(posture: "defend" | "attack"): Sim {
    const input = armedInput(1, 600);
    input.catalog = { ...catalog, behaviour: { ...catalog.behaviour, soldier: { ...catalog.behaviour.soldier, suppressKnown: { withinS: 30, intervalS: 4, mgIntervalS: 4.5, minM: 0, maxErrM: 40 } } } };
    input.rules.physiologyModel = "simple";
    input.forces[0]!.posture = posture;
    // Red far beyond his engage range (400 m); he is told of an enemy at 300 m he cannot see.
    input.map = flatMap("t", 1200, 200);
    input.forces[1]!.placements = input.forces[1]!.placements.map((p, i) => ({ ...p, x: 1150, y: 150 + i * 4 }));
    const sim = createSim(input);
    for (const [id, u] of sim.state.unit.entries()) if (u.side === "blue") sim.state.unit.req(id).fireRule = "free";
    return sim;
  }
  it("a defender who is told where an enemy is, but cannot see him, fires at the place at the suppressive rate", () => {
    for (const posture of ["defend", "attack"] as const) {
      const sim = sk(posture);
      const blue = [...sim.state.identity.entries()].filter(([, i]) => i.side === "blue").map(([id]) => id);
      const red = [...sim.state.identity.entries()].find(([, i]) => i.side === "red")![0];
      // (No line of sight: the red men stay where they are; the contact is refreshed as a report.)
      const ev: SimEvent[] = [];
      for (let k = 0; k < 20; k++) {
        for (const m of blue) { const s = sim.state.soldier.req(m); s.contacts = [{ target: red, x: 300, y: 20, errM: 5, kind: "reported", tick: sim.state.tick, reportedTick: sim.state.tick }]; }
        ev.push(...run(sim, 1));
      }
      const shots = ev.filter((e) => e.kind === "shot.fired" && blue.includes(e.shooter)).length;
      if (posture === "defend") {
        expect(shots).toBeGreaterThan(5);
        // One shot per 4 s at most (+-15 %), per man: 3 men x 20 s.
        expect(shots).toBeLessThanOrEqual(3 * 7);
      } else expect(shots).toBe(0);
    }
  });
});
