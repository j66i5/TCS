/** M11.6 batteries: lazy drain, flat events, battery swaps, on/off by light, save/load, roster, mass. */
import { describe, expect, it } from "vitest";
import {
  chargeAt, createSim, defaultEnvironment, deviceLive, hashState, loadKg, loadSim, NEVER_TICK, saveSim, soldierRecordFromState, stampSlot, step,
  TICK_HZ, type BattleInput, type Catalog, type EntityId, type SimEvent, type SoldierRecord,
} from "../src/index";
import { rec, testCatalog, testInput } from "./helpers";

const WH = 10; // rbat capacity
const catalog: Catalog = {
  ...testCatalog,
  items: {
    ...testCatalog.items,
    radio: { id: "radio", massKg: 0.6, category: "kit", power: { battery: "rbat", hours: 1, swapSeconds: 2 } },
    nvg: { id: "nvg", massKg: 0.5, category: "kit", sensor: "night", power: { battery: "cell", hours: 2, swapSeconds: 3, onBelowLight: 0.3 } },
    rbat: { id: "rbat", massKg: 0.3, category: "battery", chargeCapacity: WH, chargeMassKg: 0 },
    cell: { id: "cell", massKg: 0.015, category: "battery", chargeCapacity: 4, chargeMassKg: 0 },
  },
  behaviour: { ...testCatalog.behaviour, soldier: { ...testCatalog.behaviour.soldier, power: { installedMin: 0.5, swapBelowShare: 0.1, lullSpareShare: 0.5 } } },
};
/** No changes in a lull: only a flat battery is changed. */
const flatOnly: Catalog = { ...catalog, behaviour: { ...catalog.behaviour, soldier: { ...catalog.behaviour.soldier, power: { installedMin: 0.5, swapBelowShare: 0, lullSpareShare: 0.5 } } } };
const DRAW = WH / 1; // W
const TICKS_PER_WH = 3600 * TICK_HZ;

function input(load: SoldierRecord["load"], seed = 1, seconds = 600, cat = catalog): BattleInput {
  const base = testInput(seed, seconds);
  base.catalog = cat;
  base.forces[0]!.units[0]!.members[0] = rec("a.0", load);
  return base;
}
const MAN: EntityId = (() => { const s = createSim(input([])); for (const [id, i] of s.state.identity.entries()) if (i.personId === "a.0") return id; throw new Error("no man"); })();

function run(sim: ReturnType<typeof createSim>, ticks: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < ticks; i++) out.push(...step(sim));
  return out;
}
function whIn(sim: ReturnType<typeof createSim>, type: string): number {
  const c = sim.state.container.req(MAN);
  return c.stacks.filter((s) => s.type === type).reduce((a, s) => a + s.count * (s.charge ?? 0), 0);
}

describe("batteries (M11.6)", () => {
  it("setup fits the fullest battery, partly used (stream 'power'), spares stay full", () => {
    const sim = createSim(input([{ type: "radio", count: 1 }, { type: "rbat", count: 3, charge: WH }]));
    const slots = sim.state.soldier.req(MAN).power!;
    expect(slots).toHaveLength(1);
    const s = slots[0]!;
    expect(s.device).toBe("radio");
    expect(s.battery).toBe("rbat");
    expect(s.on).toBe(true);
    expect(s.wh0).toBeGreaterThanOrEqual(WH * 0.5);
    expect(s.wh0).toBeLessThanOrEqual(WH);
    expect(s.flatTick).toBe(Math.ceil((s.wh0 * TICKS_PER_WH) / DRAW));
    expect(whIn(sim, "rbat")).toBe(2 * WH);
    // Another seed draws another charge; the draw touches no other stream.
    const other = createSim(input([{ type: "radio", count: 1 }, { type: "rbat", count: 3, charge: WH }], 2));
    expect(other.state.soldier.req(MAN).power![0]!.wh0).not.toBe(s.wh0);
    const plain = createSim({ ...input([]), catalog }), withRadio = sim;
    for (const k of Object.keys(plain.state.rng.streams)) if (k !== "power") expect(withRadio.state.rng.streams[k]).toEqual(plain.state.rng.streams[k]);
  });

  it("drains lazily: the charge falls at the draw while on, the flat tick is exact", () => {
    const sim = createSim(input([{ type: "radio", count: 1 }, { type: "rbat", count: 1, charge: WH }]));
    const s = sim.state.soldier.req(MAN).power![0]!;
    const wh0 = s.wh0;
    run(sim, 600);
    expect(s.wh0).toBe(wh0); // nothing stepped
    expect(chargeAt(s, sim.state.tick)).toBeCloseTo(wh0 - (DRAW * 600) / TICKS_PER_WH, 12);
    expect(chargeAt(s, s.flatTick)).toBe(0);
    expect(chargeAt(s, s.flatTick - 1)).toBeGreaterThan(0);
    expect(deviceLive(catalog, sim.state, MAN, "radio", s.flatTick - 1)).toBe(true);
    expect(deviceLive(catalog, sim.state, MAN, "radio", s.flatTick)).toBe(false);
    expect(deviceLive(catalog, sim.state, MAN, "mag", s.flatTick)).toBe(true); // unpowered item
  });

  it("a flat battery is reported once and changed for the fullest spare (conservation of Wh)", () => {
    const sim = createSim(input([{ type: "radio", count: 1 }, { type: "rbat", count: 2, charge: WH }, { type: "rbat", count: 1, charge: 4 }], 1, 600, flatOnly));
    const s = sim.state.soldier.req(MAN).power![0]!;
    stampSlot(s, 0.01, true, sim.state.tick); // 3.6 s left
    const total0 = 0.01 + WH + 4;
    const ev = run(sim, 10 * TICK_HZ);
    const flats = ev.filter((e) => e.kind === "power.flat");
    expect(flats).toHaveLength(1);
    expect(flats[0]).toMatchObject({ soldier: MAN, device: "radio", side: "blue" });
    expect(flats[0]!.tick).toBeGreaterThanOrEqual(Math.ceil((0.01 * TICKS_PER_WH) / DRAW));
    const sw = ev.filter((e) => e.kind === "power.swapped");
    expect(sw).toHaveLength(1);
    expect(sw[0]).toMatchObject({ soldier: MAN, device: "radio", battery: "rbat", whOut: 0, whIn: WH });
    expect(sw[0]!.tick - flats[0]!.tick).toBeGreaterThanOrEqual(2 * TICK_HZ); // swapSeconds
    expect(s.wh0).toBe(WH);
    expect(s.flatSent).toBeUndefined();
    // The empty battery is kept as a counted item; Wh: in the load + in the device + used = at the start.
    const c = sim.state.container.req(MAN);
    expect(c.stacks.filter((x) => x.type === "rbat")).toEqual([{ type: "rbat", count: 1, charge: 0 }, { type: "rbat", count: 1, charge: 4 }]);
    const used = 0.01 + (DRAW * (sim.state.tick - s.since)) / TICKS_PER_WH;
    expect(whIn(sim, "rbat") + chargeAt(s, sim.state.tick) + used).toBeCloseTo(total0, 9);
  });

  it("without a spare the device stays flat (one flat event, no swap)", () => {
    const sim = createSim(input([{ type: "radio", count: 1 }, { type: "rbat", count: 1, charge: WH }]));
    const s = sim.state.soldier.req(MAN).power![0]!;
    stampSlot(s, 0.01, true, sim.state.tick);
    const ev = run(sim, 20 * TICK_HZ);
    expect(ev.filter((e) => e.kind === "power.flat")).toHaveLength(1);
    expect(ev.some((e) => e.kind === "power.swapped" || (e.kind === "action.started" && e.action === "swapBattery"))).toBe(false);
    expect(deviceLive(catalog, sim.state, MAN, "radio", sim.state.tick)).toBe(false);
  });

  it("in a lull a battery below swapBelowShare is changed for a fuller spare", () => {
    const sim = createSim(input([{ type: "radio", count: 1 }, { type: "rbat", count: 2, charge: WH }]));
    const s = sim.state.soldier.req(MAN).power![0]!;
    stampSlot(s, 0.5, true, sim.state.tick); // 5 % of full, 3 min left
    const ev = run(sim, 4 * TICK_HZ);
    const sw = ev.find((e) => e.kind === "power.swapped");
    expect(sw).toBeDefined();
    if (sw?.kind === "power.swapped") { expect(sw.whIn).toBe(WH); expect(sw.whOut).toBeGreaterThan(0.45); expect(sw.whOut).toBeLessThanOrEqual(0.5); }
    expect(ev.some((e) => e.kind === "power.flat")).toBe(false);
  });

  it("in a lull no ping-pong between part-used batteries: no swap while every spare is under the lull threshold", () => {
    // A slow radio (0.2 W: 600 s use 0.03 Wh); fitted 0.9 Wh (under swapBelowShare 1 Wh); spares at 0.95, 0.92 and
    // 3 Wh: none holds lullSpareShare (5 Wh), so none is worth a change (before the fix: a change every few seconds).
    const slow: Catalog = { ...catalog, items: { ...catalog.items, radio: { ...catalog.items["radio"]!, power: { battery: "rbat", hours: 50, swapSeconds: 2 } } } };
    const sim = createSim(input([{ type: "radio", count: 1 }, { type: "rbat", count: 1, charge: 4 }, { type: "rbat", count: 1, charge: 0.95 }, { type: "rbat", count: 1, charge: 0.92 }, { type: "rbat", count: 1, charge: 3 }], 1, 700, slow));
    const s = sim.state.soldier.req(MAN).power![0]!;
    expect(s.wh0).toBe(4); // the fullest is fitted, then run down:
    stampSlot(s, 0.9, true, sim.state.tick);
    const c = sim.state.container.req(MAN);
    const ev = run(sim, 600 * TICK_HZ);
    expect(ev.filter((e) => e.kind === "power.swapped" || (e.kind === "action.started" && e.action === "swapBattery"))).toEqual([]);
    expect(chargeAt(s, sim.state.tick)).toBeGreaterThan(0);
    // A spare above the threshold is taken.
    c.stacks.push({ type: "rbat", count: 1, charge: 6 });
    expect(run(sim, 5 * TICK_HZ).filter((e) => e.kind === "power.swapped")).toHaveLength(1);
  });

  it("a night device is on only below its light threshold (off: no drain)", () => {
    const sim = createSim({ ...input([{ type: "nvg", count: 1 }, { type: "cell", count: 2, charge: 4 }]), environment: { ...defaultEnvironment(), light: 1 } });
    const s = sim.state.soldier.req(MAN).power![0]!;
    expect(s.on).toBe(false);
    expect(s.flatTick).toBe(NEVER_TICK);
    const wh0 = s.wh0;
    run(sim, 5 * TICK_HZ);
    expect(chargeAt(s, sim.state.tick)).toBe(wh0);
    expect(deviceLive(catalog, sim.state, MAN, "nvg", sim.state.tick)).toBe(false); // off: gives nothing (review fix)
    sim.state.environment.light = 0.1;
    run(sim, TICK_HZ);
    expect(s.on).toBe(true);
    const since = s.since;
    run(sim, 10 * TICK_HZ);
    expect(chargeAt(s, sim.state.tick)).toBeCloseTo(wh0 - (2 * (sim.state.tick - since)) / TICKS_PER_WH, 12);
    sim.state.environment.light = 0.8;
    run(sim, TICK_HZ);
    expect(s.on).toBe(false);
    const kept = s.wh0;
    run(sim, 5 * TICK_HZ);
    expect(chargeAt(s, sim.state.tick)).toBe(kept);
    expect(kept).toBeLessThan(wh0);
  });

  it("save and load mid-drain continue with the same hash", () => {
    const mk = () => input([{ type: "radio", count: 1 }, { type: "rbat", count: 2, charge: WH }, { type: "nvg", count: 1 }, { type: "cell", count: 1, charge: 4 }], 3, 120, flatOnly);
    const a = createSim(mk());
    stampSlot(a.state.soldier.req(MAN).power!.find((x) => x.device === "radio")!, 0.02, true, 0); // flat at 7.2 s
    run(a, 3 * TICK_HZ);
    const saved = JSON.parse(JSON.stringify(saveSim(a)));
    const b = loadSim(mk(), saved);
    expect(hashState(b.state)).toBe(hashState(a.state));
    const ea = run(a, 20 * TICK_HZ), eb = run(b, 20 * TICK_HZ);
    expect(hashState(b.state)).toBe(hashState(a.state));
    expect(eb).toEqual(ea);
    expect(ea.some((e) => e.kind === "power.swapped")).toBe(true);
  });

  it("roster out puts the fitted batteries back at their charge now; roster in fits them as they are", () => {
    const sim = createSim(input([{ type: "radio", count: 1 }, { type: "rbat", count: 3, charge: WH }]));
    run(sim, 30 * TICK_HZ);
    const s = sim.state.soldier.req(MAN).power![0]!;
    const out = soldierRecordFromState(sim.state, MAN);
    expect(out.powerFitted).toBe(true);
    const bats = out.load.filter((x) => x.type === "rbat");
    expect(bats.reduce((n, x) => n + x.count, 0)).toBe(3);
    const fitted = Math.floor(chargeAt(s, sim.state.tick) * 100 + 1e-9) / 100;
    expect(bats).toContainEqual({ type: "rbat", count: 1, charge: fitted });
    // Into the next battle: the fullest is fitted with no new draw; every Wh comes back.
    const nextIn = input([], 9);
    nextIn.forces[0]!.units[0]!.members[0] = out;
    const again = createSim(nextIn);
    const s2 = again.state.soldier.req(MAN).power![0]!;
    expect(s2.wh0).toBe(WH);
    const s3 = s2;
    const total = s3.wh0 + again.state.container.req(MAN).stacks.filter((x) => x.type === "rbat").reduce((a, x) => a + x.count * (x.charge ?? 0), 0);
    expect(total).toBeCloseTo(bats.reduce((a, x) => a + x.count * (x.charge ?? 0), 0), 9);
    expect(s3.wh0).toBe(WH);
  });

  it("his load mass includes the battery in his device", () => {
    const sim = createSim(input([{ type: "radio", count: 1 }, { type: "rbat", count: 2, charge: WH }]));
    // container: radio 0.6 + one spare 0.3; the fitted one 0.3 more.
    expect(loadKg(sim.ctx, sim.state, MAN)).toBeCloseTo(0.6 + 0.3 + 0.3, 9);
  });

  it("a device without a battery has an empty slot (dead) and a charged item listed without a charge comes in full", () => {
    const sim = createSim(input([{ type: "radio", count: 1 }]));
    const s = sim.state.soldier.req(MAN).power![0]!;
    expect(s.battery).toBeNull();
    expect(deviceLive(catalog, sim.state, MAN, "radio", 0)).toBe(false);
    const full = createSim(input([{ type: "radio", count: 1 }, { type: "rbat", count: 2 }]));
    expect(whIn(full, "rbat")).toBe(WH);
  });
});
