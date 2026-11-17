/**
 * M11.8 (plan slice 52): the commander's logistics (a threatened supply point moved back, men near it filling up first;
 * a low, quiet squad's shortest men, at most half, sent to an own cache in reach; never with the enemy close), the
 * battle record's Logistics fields (fired by weapon type, taken, lost, request waits, dry men at the end) and
 * `BattleResult.logistics` (per side, from the events; its sums equal the conservation guard's tally).
 */
import { describe, expect, it } from "vitest";
import { logisticsOrders, LOGISTICS_AI } from "@tcs/ai";
import {
  createSim, dryMen, emptyConsumption, consumedFromEvents, hypot2, newBattleRecord, recordEvents, roundsOfMan, runBattle, secondsToTicks, step, submitOrder, tracerMap,
  type Contact, type EntityId, type Order, type Sim, type SimEvent,
} from "@tcs/sim";
import { getScenario, loadData } from "../src/scenarios";

const data = loadData();

/** The hold battle, blue holding with fire held, nobody commanding: run `seconds` so the men settle. */
function hold(seconds = 20): Sim {
  const input = getScenario("hold-resupply").build(data, 1, 3600);
  const sim = createSim(input);
  for (const [uid, u] of sim.state.unit.entries()) if (u.parent === null) submitOrder(sim, { tick: 0, issuer: u.side, target: uid, kind: "rules", fire: "hold", at: "hold" });
  for (let i = 0; i < secondsToTicks(seconds); i++) step(sim);
  return sim;
}
function point(sim: Sim): { pid: EntityId; cache: EntityId } {
  for (const [pid, p] of sim.state.rear.entries()) if (p.kind === "supply" && p.side === "blue") return { pid, cache: p.cache! };
  throw new Error("no supply point");
}
const contact = (x: number, y: number, target = 1): Contact => ({ target, x, y, errM: 5, kind: "seen", tick: 0, reportedTick: 0 });
const squads = (sim: Sim) => [...sim.state.unit.entries()].filter(([, u]) => u.side === "blue" && u.parent !== null && u.vehicle === undefined && u.members.length >= 4).map(([id]) => id);
/** Empty every round of the squad's men (spare magazines, belts, packages and the one in the weapon) but `keep` rounds in the weapon. */
function drain(sim: Sim, uid: EntityId, keep = 5): void {
  for (const m of sim.state.unit.req(uid).members) {
    for (const s of sim.state.container.get(m)?.stacks ?? []) if (s.charge !== undefined && sim.ctx.catalog.items[s.type]?.chargeItem !== undefined) s.charge = 0;
    const w = sim.state.weapon.get(m);
    if (w?.magazine) w.magazine.rounds = Math.min(w.magazine.rounds, keep);
  }
}

describe("the commander's logistics (M11.8)", () => {
  it("a threatened supply point moves back away from the enemy, once; men near it who are short fill up there", () => {
    const sim = hold();
    const { cache } = point(sim);
    const t = sim.state.transform.req(cache);
    // A man of the side beside the crate, short of rounds.
    const sq = squads(sim)[0]!;
    const near = sim.state.unit.req(sq).members[2]!;
    const nt = sim.state.transform.req(near);
    nt.x = t.x + 10; nt.y = t.y;
    drain(sim, sq);
    const enemyX = t.x + 60;
    const mem = {};
    const out = logisticsOrders(sim.state, sim.ctx, "blue", sim.state.tick, mem, () => [contact(enemyX, t.y)]);
    const sp = out.find((o) => o.kind === "supplyPoint") as Extract<Order, { kind: "supplyPoint" }> | undefined;
    expect(sp).toBeDefined();
    // Back by `site.backM`, away from the enemy.
    expect(hypot2(sp!.x - t.x, sp!.y - t.y)).toBeGreaterThan(sim.ctx.catalog.supply!.site.backM * 0.9);
    expect(hypot2(sp!.x - enemyX, sp!.y - t.y)).toBeGreaterThan(hypot2(t.x - enemyX, 0));
    const fill = out.filter((o) => o.kind === "resupplyAt") as Extract<Order, { kind: "resupplyAt" }>[];
    expect(fill.map((o) => o.target)).toContain(near);
    expect(fill.every((o) => o.cache === cache)).toBe(true);
    expect(fill.length).toBeLessThanOrEqual(LOGISTICS_AI.fillUpMax);
    // Carried out: a new (empty) point; the old crates lie there as a plain cache.
    for (const o of out) submitOrder(sim, o);
    for (let i = 0; i < 120; i++) step(sim);
    const now = point(sim);
    expect(now.cache).not.toBe(cache);
    expect(sim.state.cache.req(cache).kind).toBe("cache");
    expect((sim.state.container.get(cache)?.stacks.length ?? 0)).toBeGreaterThan(0);
    // Only once per point (the old one is no longer the point; the new one is empty).
    const again = logisticsOrders(sim.state, sim.ctx, "blue", sim.state.tick + 60 * 60, mem, () => [contact(enemyX, t.y)]);
    expect(again.filter((o) => o.kind === "supplyPoint")).toEqual([]);
  }, 60_000);

  it("a low, quiet squad sends its shortest men, at most half, to an own cache in reach; not with the enemy close; not again within squadEveryS", () => {
    const sim = hold();
    const { cache } = point(sim);
    const ct = sim.state.transform.req(cache);
    // A squad far enough from the crate that the sim's own "crate beside them" rule does not apply.
    const sq = squads(sim).find((u) => {
      const ms = sim.state.unit.req(u).members.map((m) => sim.state.transform.req(m));
      const cx = ms.reduce((a, b) => a + b.x, 0) / ms.length, cy = ms.reduce((a, b) => a + b.y, 0) / ms.length;
      const d = hypot2(cx - ct.x, cy - ct.y);
      return d > sim.ctx.catalog.supply!.request!.useM && d < sim.ctx.catalog.supply!.take.reachM;
    })!;
    expect(sq).toBeDefined();
    drain(sim, sq);
    const u = sim.state.unit.req(sq);
    u.moving = false;
    const able = u.members.filter((m) => sim.state.soldier.req(m).physiology.alive);
    // The enemy close: nothing.
    const mt = sim.state.transform.req(u.members[0]!);
    expect(logisticsOrders(sim.state, sim.ctx, "blue", sim.state.tick, {}, () => [contact(mt.x + 100, mt.y)]).filter((o) => o.kind === "resupplyAt")).toEqual([]);
    // Quiet: half of it (the shortest) to the crate.
    const mem = {};
    const out = logisticsOrders(sim.state, sim.ctx, "blue", sim.state.tick, mem, () => []).filter((o) => o.kind === "resupplyAt") as Extract<Order, { kind: "resupplyAt" }>[];
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(Math.floor(able.length / 2));
    expect(out.every((o) => o.cache === cache && u.members.includes(o.target))).toBe(true);
    // Not again for this squad within `squadEveryS`.
    const again = logisticsOrders(sim.state, sim.ctx, "blue", sim.state.tick + LOGISTICS_AI.lookSeconds * 60, mem, () => []).filter((o) => o.kind === "resupplyAt" && u.members.includes(o.target));
    expect(again).toEqual([]);
    // Carried out: the men go, take and their rounds rise.
    const before = out.map((o) => roundsOfMan(sim.ctx, sim.state, o.target).rounds);
    for (const o of out) submitOrder(sim, o);
    for (let i = 0; i < secondsToTicks(400); i++) step(sim);
    const after = out.map((o) => roundsOfMan(sim.ctx, sim.state, o.target).rounds);
    expect(after.some((r, i) => r > before[i]!)).toBe(true);
  }, 120_000);
});

describe("the Logistics record and BattleResult.logistics (M11.8)", () => {
  it("the record counts fired by weapon type, taken, lost, request waits and dry men at the end", () => {
    const sim = hold(2);
    const v = sim.state, cat = sim.ctx.catalog;
    const rec = newBattleRecord(["blue", "red"]);
    const sq = squads(sim)[0]!;
    const [a, b] = sim.state.unit.req(sq).members;
    const w = v.weapon.req(a!);
    const t = (n: number) => sim.state.tick + n;
    const red = [...v.identity.entries()].find(([, i]) => i.side === "red")![0];
    const { cache } = point(sim);
    const ev: SimEvent[] = [
      { kind: "shot.fired", tick: t(0), shooter: a!, x: 0, y: 0, z: 0, dirX: 1, dirY: 0, weapon: w.weapon, ammo: "x" },
      { kind: "shot.fired", tick: t(0), shooter: a!, x: 0, y: 0, z: 0, dirX: 1, dirY: 0, weapon: w.weapon, ammo: "x" },
      { kind: "grenade.launched", tick: t(0), soldier: b!, ammo: "g", method: "thrown", x: 0, y: 0 },
      { kind: "supply.request", tick: t(0), side: "blue", unit: sq, percent: 20 },
      { kind: "supply.request", tick: t(60), side: "blue", unit: sq, percent: 20 }, // (a repeat: the wait runs from the first)
      { kind: "items.taken", tick: t(10), from: red, to: a!, item: "m", count: 1, rounds: 30, source: "casualty", treated: true },
      { kind: "items.taken", tick: t(10), from: red, to: a!, item: "m", count: 1, rounds: 20, source: "enemy" },
      { kind: "cache.captured", tick: t(20), cache, side: "red", from: "blue", rounds: 500 },
    ];
    recordEvents(rec, ev, v, cat);
    recordEvents(rec, [{ kind: "supply.delivered", tick: t(1800), side: "blue", unit: sq, load: cache, rounds: 300 }], v, cat);
    const s = rec.sides["blue"]!.supply!;
    expect(s.fired![cat.weapons[w.weapon]!.type]).toBe(2);
    expect(s.fired!["hand-grenade"]).toBe(1);
    expect(s.takenCasualty).toBe(30);
    expect(s.takenEnemy).toBe(20);
    expect(s.roundsLost).toBe(500);
    expect(s.waitS).toEqual([30]);
    // Dry men at the end: one man emptied.
    const m = sim.state.unit.req(sq).members[3]!;
    for (const st of sim.state.container.get(m)?.stacks ?? []) if (st.charge !== undefined) st.charge = 0;
    const wm = sim.state.weapon.get(m);
    if (wm?.magazine) wm.magazine.rounds = 0;
    recordEvents(rec, [{ kind: "supply.request", tick: t(1900), side: "blue", unit: sq, percent: 0 }, { kind: "battle.ended", tick: t(1900), reason: "time-limit" }], v, cat);
    const d = dryMen(cat, v, "blue");
    expect(d.dry).toBe(1);
    expect(s.dryEnd).toBe(1);
    expect(s.armedEnd).toBe(d.armed);
    expect(s.open).toBe(1);
    expect(JSON.parse(JSON.stringify(rec))).toEqual(rec);
  }, 60_000);

  it("BattleResult.logistics: per side from the events; its sums equal the conservation tally", () => {
    const sc = getScenario("hold-resupply");
    const input = sc.build(data, 1, 300);
    const c = emptyConsumption(), tr = tracerMap(input.catalog);
    const r = runBattle(input, { controllers: sc.controllers?.(input) ?? [], onEvents: (ev) => consumedFromEvents(c, ev, tr) });
    const L = r.logistics!;
    expect(L.map((l) => l.side)).toEqual(["blue", "red"]);
    const sum = (k: "consumed" | "delivered" | "destroyed") => {
      const o: Record<string, number> = {};
      for (const l of L) for (const [id, n] of Object.entries(l[k])) o[id] = (o[id] ?? 0) + n;
      return o;
    };
    expect(sum("consumed")).toEqual(c.used);
    expect(sum("delivered")).toEqual(c.delivered);
    expect(sum("destroyed")).toEqual(c.destroyed);
    // Both sides fired; each side's consumption is its own cartridges.
    for (const l of L) expect(Object.values(l.consumed).reduce((x, y) => x + y, 0)).toBeGreaterThan(0);
    const fac = (side: string) => input.forces.find((f) => f.side === side)!.faction;
    for (const l of L) expect(Object.keys(l.consumed).every((k) => k.startsWith(`${fac(l.side)}-`))).toBe(true);
  }, 120_000);
});
