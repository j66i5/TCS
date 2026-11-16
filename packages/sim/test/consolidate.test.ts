/** M11.2: consolidation, own casualties' ammunition after treatment, the take-enemy-kit order. */
import { describe, expect, it } from "vitest";
import {
  createSim, hashState, ledgerOf, loadSim, saveSim, secondsToTicks, step, submitOrder, type BattleInput, type Catalog, type Sim, type SimEvent, type Wound,
} from "../src/index";
import { armedInput, rec, testCatalog } from "./helpers";
import { ammoStacks } from "../src/systems/consolidate";

const catalog: Catalog = {
  ...testCatalog,
  items: {
    ...testCatalog.items,
    bandolier: { id: "bandolier", massKg: 0.15, category: "ammo-package", chargeCapacity: 140, chargeMassKg: 0.012, chargeItem: "ball", stripperClips: true },
    mag2: { id: "mag2", massKg: 0.1, category: "magazine", chargeCapacity: 30, chargeMassKg: 0.012, chargeItem: "ball" },
    "rifle-item": { id: "rifle-item", massKg: 3.6, category: "weapon" },
    "rifle2-item": { id: "rifle2-item", massKg: 3.3, category: "weapon" },
  },
  weapons: {
    ...testCatalog.weapons,
    rifle: { ...testCatalog.weapons["rifle"]!, weaponItem: "rifle-item" },
    rifle2: { ...testCatalog.weapons["rifle"]!, id: "rifle2", massKg: 3.3, feed: { magazine: "mag2" }, weaponItem: "rifle2-item" },
  },
  behaviour: {
    ...testCatalog.behaviour,
    consolidate: { quietS: 60, stepS: 2, maxParallel: 2, rangeM: 50, beltsMin: 2, magGap: 2, packageGap: 2, casualtyM: 30, lowMags: 3, takeS: 8, leaveMags: 1, nestHandM: 30, nestCacheM: 30, kitM: 150, kitS: 10 },
  },
};

function run(sim: Sim, seconds: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < secondsToTicks(seconds); i++) out.push(...step(sim));
  return out;
}
const spare = (sim: Sim, id: number, t: string) => sim.state.container.req(id).stacks.filter((s) => s.type === t && (s.charge ?? 1) > 0).reduce((n, s) => n + s.count, 0);
const blues = (sim: Sim) => [...sim.state.identity.entries()].filter(([, i]) => i.side === "blue").map(([id]) => id);
const reds = (sim: Sim) => [...sim.state.identity.entries()].filter(([, i]) => i.side === "red").map(([id]) => id);

/** A blue squad of six with 0..6 spare magazines (and one machine gunner without belts, one rifleman carrying three). */
function squadInput(): BattleInput {
  const input = armedInput(1, 600);
  input.catalog = catalog;
  const loads = [0, 1, 2, 4, 6, 6];
  const u = input.forces[0]!.units[0]!;
  u.members = loads.map((n, i) => rec(`a.${i}`, [{ type: "mag", count: n + 1, charge: 30 }]));
  for (const m of u.members) m.weapon = "rifle";
  // The gunner, and the man who carries his belts.
  u.members.push({ ...rec("a.6", [{ type: "belt", count: 1, charge: 50 }]), weapon: "gun" });
  u.members[5]!.load.push({ type: "belt", count: 3, charge: 50 });
  input.forces[0]!.placements = u.members.map((m, i) => ({ personId: m.personId, x: 20 + (i % 4) * 6, y: 40 + Math.floor(i / 4) * 6, heading: 0 }));
  return input;
}

describe("consolidation (M11.2)", () => {
  it("after 60 s of quiet the squad evens out: belts to the gunner first, no man more than one magazine from the mean, ledger unchanged", () => {
    const sim = createSim(squadInput());
    const men = blues(sim);
    const gunner = men[6]!;
    const before = ledgerOf(catalog, sim.state);
    const ev = run(sim, 59);
    // (Not before 60 s of quiet: only the old rule, a man out of spare magazines gets one brought.)
    expect(ev.filter((e) => e.kind === "items.transferred" && e.to !== men[0]).length).toBe(0);
    const ev2 = run(sim, 61);
    const tr = ev2.filter((e) => e.kind === "items.transferred" && e.to !== men[0]);
    expect(tr.length).toBeGreaterThan(0);
    // Belts first: the first hand-over is a belt to the gunner.
    expect(tr[0]).toMatchObject({ to: gunner, item: "belt" });
    expect(spare(sim, gunner, "belt")).toBeGreaterThanOrEqual(2);
    const mags = men.slice(0, 6).map((m) => spare(sim, m, "mag"));
    const mean = mags.reduce((a, b) => a + b, 0) / mags.length;
    for (const n of mags) expect(Math.abs(n - mean)).toBeLessThanOrEqual(1);
    const after = ledgerOf(catalog, sim.state);
    expect(after.ammo).toEqual(before.ammo);
    expect(after.items).toEqual(before.items);
  });

  it("not while the squad is fired on", () => {
    const sim = createSim(squadInput());
    const uid = sim.state.identity.req(blues(sim)[0]!).unit;
    const ev: SimEvent[] = [];
    for (let k = 0; k < 90; k++) { sim.state.unit.req(uid).ownFireTick = sim.state.tick; ev.push(...run(sim, 1)); }
    expect(ev.some((e) => e.kind === "items.transferred")).toBe(false);
  });

  it("save and load mid-hand-over replay the same", () => {
    const input = squadInput();
    const sim = createSim(input);
    run(sim, 61);
    for (let k = 0; k < 120 && ![...sim.state.action.values()].some((a) => a.kind === "transferItems"); k++) run(sim, 0.5);
    expect([...sim.state.action.values()].some((a) => a.kind === "transferItems")).toBe(true);
    const copy = loadSim(squadInput(), saveSim(sim));
    run(sim, 10); run(copy, 10);
    expect(hashState(copy.state)).toBe(hashState(sim.state));
  });
});

/** Three blue riflemen close together; the first is made a casualty (dead or incapacitated). The others are low. */
function casualtyInput(): BattleInput {
  const input = armedInput(1, 600);
  input.catalog = catalog;
  const u = input.forces[0]!.units[0]!;
  u.members[0]!.load = [{ type: "mag", count: 5, charge: 30 }, { type: "bandolier", count: 1, charge: 140 }];
  u.members[1]!.load = [{ type: "mag", count: 2, charge: 30 }];
  u.members[2]!.load = [{ type: "mag", count: 2, charge: 30 }];
  input.forces[0]!.placements = u.members.map((m, i) => ({ personId: m.personId, x: 20 + i * 8, y: 40, heading: 0 }));
  return input;
}
function downIt(sim: Sim, id: number, dead: boolean): void {
  const s = sim.state.soldier.req(id);
  s.casualty = dead ? "killed" : "incapacitated";
  if (dead) s.physiology.alive = false;
  s.physiology.consciousness = 0;
  s.impair.canWalk = false; s.impair.canUseArms = false;
}
const wound = (by: number | null): Wound => ({
  id: 1, zone: "thigh", mechanism: "gunshot", severity: 0.5, bleedingLps: 0, compressible: true, airway: false, breathing: false, consciousness: false, tickInflicted: 0,
  treatments: by === null ? [] : [{ tick: 1, by, intervention: "tourniquet", itemsUsed: {}, success: true }],
} as unknown as Wound);

describe("own casualties' ammunition (M11.2)", () => {
  it("never before his treatment; after it the nearest low man takes it; ledger unchanged", () => {
    const sim = createSim(casualtyInput());
    const [c, a, b] = blues(sim);
    downIt(sim, c!, false);
    sim.state.soldier.req(c!).wounds = [wound(null)];
    const before = ledgerOf(catalog, sim.state);
    expect(run(sim, 40).some((e) => e.kind === "items.taken")).toBe(false);
    // Treated by b: the nearest low man (a, 8 m away) comes and takes it.
    sim.state.soldier.req(c!).wounds = [wound(b!)];
    const ev = run(sim, 30);
    const taken = ev.filter((e) => e.kind === "items.taken");
    expect(taken.length).toBeGreaterThan(0);
    expect(taken.every((e) => e.kind === "items.taken" && e.to === a && e.source === "casualty" && e.treated === true)).toBe(true);
    expect(spare(sim, c!, "mag")).toBe(0); // (he cannot use his arms: nothing kept)
    expect(spare(sim, a!, "mag") + spare(sim, b!, "mag")).toBe(6); // (1 + 1 + his 4 spare)
    expect(ledgerOf(catalog, sim.state).ammo).toEqual(before.ammo);
  });

  it("a man who can still use his arms keeps one magazine (the fullest); a dead man is stripped", () => {
    const sim = createSim(casualtyInput());
    const [c] = blues(sim);
    // (What is taken from a man who keeps one magazine: the fullest stays.)
    const box = sim.state.container.req(c!);
    const st = ammoStacks(sim.ctx, box, 1, "mag");
    expect(st.find((x) => x.type === "mag")?.count).toBe(spare(sim, c!, "mag") - 1);
    expect(st.find((x) => x.type === "bandolier")?.count).toBe(1);
    const sim2 = createSim(casualtyInput());
    const [d] = blues(sim2);
    downIt(sim2, d!, true);
    const ev = run(sim2, 30);
    expect(ev.some((e) => e.kind === "items.taken" && e.dead === true)).toBe(true);
    expect(spare(sim2, d!, "mag") + spare(sim2, d!, "bandolier")).toBe(0);
  });

  it("not with rules.resupply false", () => {
    const input = casualtyInput();
    input.rules.resupply = false;
    const sim = createSim(input);
    downIt(sim, blues(sim)[0]!, true);
    expect(run(sim, 30).some((e) => e.kind === "items.taken")).toBe(false);
  });
});

/** A blue rifleman beside a red casualty (or prisoner) with another rifle and three magazines for it. */
function kitInput(redWeapon = "rifle2"): BattleInput {
  const input = armedInput(1, 600);
  input.catalog = catalog;
  input.rules.comms = { ...input.rules.comms, orderDelaySeconds: 0 };
  const b = input.forces[1]!.units[0]!;
  b.members[0]!.weapon = redWeapon;
  b.members[0]!.load = redWeapon === "rifle2" ? [{ type: "mag2", count: 4, charge: 30 }] : [{ type: "belt", count: 2, charge: 50 }];
  input.forces[1]!.placements = [{ personId: b.members[0]!.personId, x: 30, y: 10, heading: 0 }, { personId: b.members[1]!.personId, x: 120, y: 150, heading: 0 }];
  return input;
}

describe("takeKit (M11.2)", () => {
  it("nothing fits: he swaps his rifle for the enemy's with its magazines, fires them; ledger exact", () => {
    const sim = createSim(kitInput());
    const [m] = blues(sim);
    const [r, r2] = reds(sim);
    downIt(sim, r!, true);
    const uid = sim.state.identity.req(m!).unit;
    const before = ledgerOf(catalog, sim.state);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: uid, kind: "takeKit", source: r! });
    const ev = run(sim, 30);
    expect(ev.some((e) => e.kind === "radio" && e.key === "radio.ack.takeKit")).toBe(true);
    const sw = ev.find((e) => e.kind === "weapon.swapped");
    expect(sw).toMatchObject({ soldier: m, from: r, weapon: "rifle2", put: "rifle-item" });
    expect(sim.state.weapon.req(m!).weapon).toBe("rifle2");
    expect(sim.state.weapon.has(r!)).toBe(false);
    // 3 spare magazines taken (the fourth is in the rifle he took up).
    expect(spare(sim, m!, "mag2")).toBe(3);
    expect(spare(sim, m!, "rifle-item")).toBe(1);
    const mid = ledgerOf(catalog, sim.state);
    expect(mid.ammo).toEqual(before.ammo);
    expect(mid.items).toEqual(before.items);
    // He fires them at the other red man.
    sim.state.soldier.req(r2!).physiology.alive = true;
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: m!, kind: "fire", x: 120, y: 150, heightM: 1 });
    const ev2 = run(sim, 20);
    const shots = ev2.filter((e) => e.kind === "shot.fired" && e.shooter === m);
    expect(shots.length).toBeGreaterThan(0);
    expect(shots.every((e) => e.kind === "shot.fired" && e.weapon === "rifle2")).toBe(true);
    const end = ledgerOf(catalog, sim.state);
    expect((before.ammo["ball"] ?? 0) - (end.ammo["ball"] ?? 0)).toBe(ev2.filter((e) => e.kind === "shot.fired").length);
  });

  it("save and load in the middle of taking kit replay the same", () => {
    const sim = createSim(kitInput());
    const [m] = blues(sim);
    const [r] = reds(sim);
    downIt(sim, r!, true);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: m!, kind: "takeKit", source: r! });
    for (let k = 0; k < 60 && sim.state.action.get(m!)?.kind !== "takeKit"; k++) run(sim, 0.5);
    expect(sim.state.action.get(m!)?.kind).toBe("takeKit");
    const copy = loadSim(kitInput(), saveSim(sim));
    run(sim, 15); run(copy, 15);
    expect(hashState(copy.state)).toBe(hashState(sim.state));
    expect(sim.state.weapon.req(m!).weapon).toBe("rifle2");
  });

  it("ammunition that fits his rifle: he takes only that", () => {
    const sim = createSim(kitInput("rifle"));
    const [m] = blues(sim);
    const [r] = reds(sim);
    downIt(sim, r!, true);
    const uid = sim.state.identity.req(m!).unit;
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: uid, kind: "takeKit", source: r! });
    const ev = run(sim, 30);
    expect(ev.some((e) => e.kind === "weapon.swapped")).toBe(false);
    expect(ev.filter((e) => e.kind === "items.taken").every((e) => e.kind === "items.taken" && e.source === "enemy")).toBe(true);
    expect(sim.state.weapon.req(m!).weapon).toBe("rifle");
  });

  it("refused with a radio reason when nothing fits (a machine gunner's belts), and an able enemy is no source", () => {
    const sim = createSim(kitInput("gun"));
    const [m] = blues(sim);
    const [r] = reds(sim);
    const uid = sim.state.identity.req(m!).unit;
    // An able enemy: invalid.
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: uid, kind: "takeKit", source: r! });
    expect(run(sim, 1).some((e) => e.kind === "order.rejected" && e.reason === "invalid-params")).toBe(true);
    downIt(sim, r!, true);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: uid, kind: "takeKit", source: r! });
    const ev = run(sim, 5);
    expect(ev.some((e) => e.kind === "radio" && e.key === "radio.kitNothing")).toBe(true);
    expect(ev.some((e) => e.kind === "items.taken")).toBe(false);
  });
});
