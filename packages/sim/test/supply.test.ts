/** M11.3: supply points and caches — siting apart from the nest, no ammunition at the nest, cook-off, capture, orders. */
import { describe, expect, it } from "vitest";
import {
  casualtyPointOrder, checkConservation, consumedFromEvents, createSim, deserializeState, emptyConsumption, hashState, ledgerOf, loadSim, saveSim, secondsToTicks, serializeState, setNest, step, submitOrder, tracerMap,
  type BattleInput, type Catalog, type Sim, type SimEvent, type SupplyDef,
} from "../src/index";
import { EventSink } from "../src/events";
import { armedInput, rec, testCatalog, testInput } from "./helpers";
import { cacheBurst, cookoffChance, ensureSupplyPoint, ignite, newCache, putInCache, siteSupply } from "../src/systems/supply";
import { detonate } from "../src/systems/explosions";
import { ammoIndexOf } from "../src/projectiles";

const SUPPLY: SupplyDef = {
  stepS: 1, nestApartM: 50, nestClearM: 15,
  site: { backM: 100, searchM: 40, minBackM: 50, maxBackM: 250, threatM: 100, driftM: 300, checkS: 10 },
  seeM: 250, heightM: 0.5,
  capture: { holdM: 50, enemyM: 10, seconds: 10 },
  blast: { reachScaledM: 5, hpKg: 4, chancePerKg: 0.3, maxChance: 0.9 },
  cookoff: { minS: 30, maxS: 120, stepS: 5, maxBurstsPerStep: 1, fireM: 8, fireChancePerS: 0.02, smokeRadiusM: 4, smokeTopM: 8 },
  take: { baseS: 10, bulkSecondsPerRound: 0.02, magSecondsPerRound: 0.4, reachM: 400, underFireS: 15 },
  ai: { heRounds: 3, everyS: 300, ownClearM: 100 },
};

const catalog: Catalog = {
  ...testCatalog,
  supply: SUPPLY,
  items: {
    ...testCatalog.items,
    can: { id: "can", massKg: 2.4, category: "ammo-package", chargeCapacity: 840, chargeMassKg: 0.012, chargeItem: "ball" },
    bandolier: { id: "bandolier", massKg: 0.15, category: "ammo-package", chargeCapacity: 140, chargeMassKg: 0.012, chargeItem: "ball", stripperClips: true },
    "bomb-crate": { id: "bomb-crate", massKg: 3, category: "ammo-package", chargeCapacity: 20, chargeMassKg: 0.4, chargeItem: "bomb" },
  },
};

function run(sim: Sim, seconds: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < secondsToTicks(seconds); i++) out.push(...step(sim));
  return out;
}
const blues = (sim: Sim) => [...sim.state.identity.entries()].filter(([, i]) => i.side === "blue").map(([id]) => id);
const reds = (sim: Sim) => [...sim.state.identity.entries()].filter(([, i]) => i.side === "red").map(([id]) => id);
const topOfSide = (sim: Sim, side: string) => [...sim.state.unit.entries()].find(([, u]) => u.side === side && u.parent === null)![0];

/** Unarmed men (nobody fires): blue team of three at x 10, red pair at x 190. */
function quietInput(): BattleInput {
  const input = testInput(1, 600);
  input.catalog = catalog;
  return input;
}

describe("supply points and caches (M11.3)", () => {
  it("a supply point is sited at least nestApartM from the platoon's nest, and the nest never within it of the point", () => {
    const sim = createSim(quietInput());
    const top = topOfSide(sim, "blue");
    const free = siteSupply(sim.ctx, sim.state, top)!;
    // A nest exactly where the point would have gone: the point goes elsewhere, 50 m or more away.
    setNest(sim.ctx, sim.state, new EventSink(), top, free.x, free.y, "ordered");
    const ev = new EventSink();
    const pid = ensureSupplyPoint(sim.ctx, sim.state, ev, top)!;
    const p = sim.state.rear.req(pid);
    expect(p.kind).toBe("supply");
    expect(Math.hypot(p.x - free.x, p.y - free.y)).toBeGreaterThanOrEqual(50);
    const cache = sim.state.cache.req(p.cache!);
    expect(cache).toMatchObject({ kind: "point", side: "blue", top });
    expect(ev.events.some((e) => e.kind === "supply.point" && e.reason === "sited")).toBe(true);
    // The player cannot put the nest on the point.
    // (The test catalog has no medical data, so the order itself is not applicable here: the order's function.)
    expect(casualtyPointOrder(sim.ctx, sim.state, new EventSink(), top, p.x + 10, p.y)).toEqual({ unable: "radio.nestNearSupply" });
  });

  it("ammunition is never put at the Verwundetennest: putInCache refuses it there, and the supplyPoint order too", () => {
    const sim = createSim(quietInput());
    const top = topOfSide(sim, "blue");
    const man = blues(sim)[0]!;
    setNest(sim.ctx, sim.state, new EventSink(), top, 60, 100, "ordered");
    const atNest = newCache(sim.state, "blue", 65, 100, []);
    expect(putInCache(sim.ctx, sim.state, man, atNest, { type: "mag", count: 1, charge: 30 })).toBe(0);
    expect(sim.state.container.req(atNest).stacks.length).toBe(0);
    const away = newCache(sim.state, "blue", 100, 100, []);
    expect(putInCache(sim.ctx, sim.state, man, away, { type: "mag", count: 1, charge: 30 })).toBe(1);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: top, kind: "supplyPoint", x: 80, y: 100 });
    const ev = run(sim, 2);
    expect(ev.some((e) => e.kind === "radio" && e.key === "radio.supplyNearNest")).toBe(true);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: top, kind: "supplyPoint", x: 150, y: 40 });
    const ev2 = run(sim, 2);
    expect(ev2.some((e) => e.kind === "supply.point" && e.reason === "ordered")).toBe(true);
  });

  it("a cook-off destroys exactly the contents (ledger), its explosive rounds go off, and it burns out", () => {
    const sim = createSim(quietInput());
    const id = newCache(sim.state, "blue", 100, 150, [{ type: "can", count: 2, charge: 840 }, { type: "bomb-crate", count: 1, charge: 20 }, { type: "mag", count: 4, charge: 30 }]);
    const start = ledgerOf(catalog, sim.state);
    const used = emptyConsumption();
    const sink = new EventSink();
    ignite(sim.ctx, sim.state, sink, SUPPLY, id, sim.state.cache.req(id), "fire");
    consumedFromEvents(used, sink.events, tracerMap(catalog));
    const ev = run(sim, 125);
    consumedFromEvents(used, ev, tracerMap(catalog));
    const end = ledgerOf(catalog, sim.state);
    expect(sim.state.container.req(id).stacks.length).toBe(0);
    expect(sim.state.cache.req(id)).toMatchObject({ burnt: true, hp: 0 });
    expect(used.destroyed["ball"]).toBe(2 * 840 + 4 * 30);
    expect(used.destroyed["bomb"]).toBe(20);
    expect(checkConservation(start, end, used)).toEqual({});
    expect(ev.filter((e) => e.kind === "explosion" && e.owner === id).length).toBeGreaterThan(0);
    expect(ev.some((e) => e.kind === "cache.burnt")).toBe(true);
  });

  it("rifle rounds alone burn without bursts; a big burst on a crate sets it off; the chance table falls with distance", () => {
    const sim = createSim(quietInput());
    const id = newCache(sim.state, "blue", 100, 150, [{ type: "can", count: 1, charge: 840 }]);
    const sink = new EventSink();
    // A 10 kg filling on it: hp gone, set off for certain.
    cacheBurst(sim.ctx, sim.state, sink, 100, 150, 10);
    expect(sim.state.cache.req(id).cookoff).toBeDefined();
    expect(sim.state.cache.req(id).cookoff!.bursts).toBe(false);
    const ev = run(sim, 125);
    expect(ev.some((e) => e.kind === "explosion" && e.owner === id)).toBe(false);
    expect(cookoffChance(SUPPLY, 10, 0)).toBe(1);
    expect(cookoffChance(SUPPLY, 2, 0)).toBeCloseTo(0.6, 5);
    expect(cookoffChance(SUPPLY, 2, 5)).toBeLessThan(cookoffChance(SUPPLY, 2, 0));
    expect(cookoffChance(SUPPLY, 2, 20)).toBe(0);
    // A real burst beside another crate (the detonate hook).
    const id2 = newCache(sim.state, "blue", 40, 40, [{ type: "can", count: 1, charge: 840 }]);
    const hp0 = sim.state.cache.req(id2).hp;
    detonate(sim.ctx, sim.state, sink, 40.5, 40, 0.3, ammoIndexOf(catalog, "bomb"), id2);
    expect(sim.state.cache.req(id2).hp).toBeLessThan(hp0);
  });

  it("an enemy at a cache with none of its side near captures it after 10 s; not with a defender within 50 m", () => {
    const sim = createSim(quietInput());
    const r = reds(sim)[0]!;
    const t = sim.state.transform.req(r);
    const id = newCache(sim.state, "blue", t.x - 5, t.y, [{ type: "can", count: 1, charge: 840 }]);
    const ev = run(sim, 8);
    expect(sim.state.cache.req(id).side).toBe("blue");
    expect(ev.some((e) => e.kind === "cache.captured")).toBe(false);
    const ev2 = run(sim, 4);
    expect(sim.state.cache.req(id)).toMatchObject({ side: "red", capturedBy: "red", from: "blue" });
    expect(ev2.some((e) => e.kind === "cache.captured" && e.side === "red" && e.from === "blue" && e.rounds === 840)).toBe(true);

    // A blue man within 50 m: no capture.
    const sim2 = createSim(quietInput());
    const r2 = reds(sim2)[0]!, b2 = blues(sim2)[0]!;
    const t2 = sim2.state.transform.req(r2);
    const id2 = newCache(sim2.state, "blue", t2.x - 5, t2.y, [{ type: "can", count: 1, charge: 840 }]);
    sim2.state.transform.req(b2).x = t2.x - 40; sim2.state.transform.req(b2).y = t2.y;
    run(sim2, 20);
    expect(sim2.state.cache.req(id2).side).toBe("blue");
  });

  it("resupplyAt: the men walk to the crate, fill their magazines and bandolier, walk back; the ledger is unchanged", () => {
    const input = armedInput(1, 600);
    input.catalog = catalog;
    // Blue only, far from red; empty magazines and a part-empty bandolier.
    const u = input.forces[0]!.units[0]!;
    u.members = [0, 1, 2].map((i) => ({ ...rec(`a.${i}`, [{ type: "mag", count: 3, charge: 0 }, { type: "mag", count: 1, charge: 30 }, { type: "bandolier", count: 1, charge: 40 }]), weapon: "rifle" }));
    input.forces[0]!.placements = u.members.map((m, i) => ({ personId: m.personId, x: 20, y: 40 + i * 5, heading: 0 }));
    input.forces[0]!.caches = [{ x: 60, y: 45, load: [{ type: "can", count: 2, charge: 840 }] }];
    const sim = createSim(input);
    const cache = [...sim.state.cache.entries()][0]![0];
    const men = blues(sim);
    const where = men.map((m) => ({ ...sim.state.transform.req(m) }));
    const before = ledgerOf(catalog, sim.state);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: sim.state.identity.req(men[0]!).unit, kind: "resupplyAt" });
    const ev = run(sim, 150);
    expect(ev.some((e) => e.kind === "supply.resupply" && e.cache === cache && e.men === 3)).toBe(true);
    for (const m of men) {
      const c = sim.state.container.req(m);
      for (const s of c.stacks) if (s.type === "mag") expect(s.charge).toBe(30);
      expect(c.stacks.find((s) => s.type === "bandolier")?.charge).toBe(140);
    }
    // Each man took 3 x 30 + 100 rounds.
    const took = ev.filter((e) => e.kind === "items.taken" && e.source === "cache").reduce((n, e) => n + (e.kind === "items.taken" ? e.rounds : 0), 0);
    expect(took).toBe(3 * (90 + 100));
    const after = ledgerOf(catalog, sim.state);
    expect(after.ammo).toEqual(before.ammo);
    // ... and they are back where they stood.
    men.forEach((m, i) => { const t = sim.state.transform.req(m); expect(Math.hypot(t.x - where[i]!.x, t.y - where[i]!.y)).toBeLessThan(2); });
  });

  it("resupplyAt refusals: nothing in reach, nothing that fits, already full, under fire", () => {
    const sim = createSim(quietInput());
    const team = sim.state.identity.req(blues(sim)[0]!).unit;
    const radio = (ev: SimEvent[]) => ev.filter((e) => e.kind === "radio").map((e) => (e.kind === "radio" ? e.key : ""));
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: team, kind: "resupplyAt" });
    expect(radio(run(sim, 2))).toContain("radio.supplyNone");
    // Their magazines are full (3 x 30): a crate of rounds is of no use.
    newCache(sim.state, "blue", 30, 20, [{ type: "can", count: 1, charge: 840 }]);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: team, kind: "resupplyAt" });
    expect(radio(run(sim, 2))).toContain("radio.supplyFull");
    // Empty magazines but only bombs in the crate.
    for (const m of blues(sim)) sim.state.container.req(m).stacks.forEach((s) => { if (s.type === "mag") s.charge = 0; });
    const ids = [...sim.state.cache.entries()].map(([id]) => id);
    for (const id of ids) sim.state.container.req(id).stacks = [{ type: "bomb-crate", count: 1, charge: 20 }];
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: team, kind: "resupplyAt" });
    expect(radio(run(sim, 2))).toContain("radio.supplyEmpty");
    // Under fire.
    sim.state.unit.req(team).ownFireTick = sim.state.tick;
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: team, kind: "resupplyAt" });
    expect(radio(run(sim, 2))).toContain("radio.supplyUnderFire");
  });

  it("the scenario's crate marked as a point is the nearest platoon's supply point", () => {
    const input = quietInput();
    input.forces[0]!.caches = [{ x: 30, y: 30, load: [{ type: "can", count: 1, charge: 840 }], point: true }];
    const sim = createSim(input);
    const [cid, c] = [...sim.state.cache.entries()][0]!;
    expect(c).toMatchObject({ kind: "point", side: "blue", placed: true, top: topOfSide(sim, "blue") });
    expect([...sim.state.rear.values()].some((p) => p.kind === "supply" && p.cache === cid)).toBe(true);
  });

  it("save and load in the middle of a cook-off continue identically; a schema-22 save loads", () => {
    const sim = createSim(quietInput());
    const id = newCache(sim.state, "blue", 100, 150, [{ type: "bomb-crate", count: 2, charge: 20 }, { type: "can", count: 1, charge: 840 }]);
    ignite(sim.ctx, sim.state, new EventSink(), SUPPLY, id, sim.state.cache.req(id), "blast");
    run(sim, 20);
    const saved = saveSim(sim);
    const input = quietInput();
    const other = loadSim(input, saved);
    run(sim, 60); run(other, 60);
    expect(hashState(other.state)).toBe(hashState(sim.state));
    // An older save (schema 22, no cache store) still loads, with no caches.
    const old = serializeState(createSim(quietInput()).state);
    old.schema = 22; delete (old.stores as Record<string, unknown>)["cache"];
    expect(deserializeState(old).cache.size).toBe(0);
  });
});
