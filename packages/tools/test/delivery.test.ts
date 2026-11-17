/**
 * M11.4b (plan slice 47): supplies from off the map. The side's off-map stock is outside the ledger and every item that
 * leaves it is an `items.delivered` event (conservation exact); a supply point below `delivery.callBelow` of its fill
 * calls the side's supply vehicle (never an ambulance), which unloads into the point; one delivery at a time; the
 * mortar allotment is topped up from the stock; a player's delivery by an ambulance is carried out but recorded as a
 * breach (`law.misuse`) and the ambulance has no protection while it carries the ammunition; `rules.deliveries` false
 * switches it all off; save and load mid-delivery continue identically; an older save (schema 23) loads.
 */
import { describe, expect, it } from "vitest";
import {
  checkConservation, consumedFromEvents, createSim, deserializeState, emptyConsumption, ledgerOf, loadSim, protectionNow, removeItems, saveSim,
  serializeState, simHash, step, submitOrder, tracerMap, TICK_HZ, PROT_MARKED,
  type BattleInput, type EntityId, type SerializedState, type Sim, type SimEvent,
} from "@tcs/sim";
import { getScenario, loadData } from "../src/scenarios";
import { vehicleResupplyLab, vehicleResupplyLabMarkdown } from "../src/labs/resupply";

const data = loadData();

function hold(seed = 1, deliveries = true): { input: BattleInput; sim: Sim } {
  const input = getScenario("hold-resupply").build(data, seed, 3600);
  if (!deliveries) input.rules.deliveries = false;
  const sim = createSim(input);
  // Nobody fires (no controllers run here; the men's own fire held).
  for (const [uid, u] of sim.state.unit.entries()) if (u.parent === null) submitOrder(sim, { tick: 0, issuer: u.side, target: uid, kind: "rules", fire: "hold", at: "hold" });
  return { input, sim };
}
function run(sim: Sim, seconds: number, on: (e: SimEvent) => void = () => undefined, until: () => boolean = () => false): void {
  for (let i = 0; i < seconds * TICK_HZ && !until(); i++) for (const e of step(sim)) on(e);
}
const topBlue = (sim: Sim) => [...sim.state.unit.entries()].find(([, u]) => u.side === "blue" && u.parent === null && u.asset === undefined && u.members.length + u.children.length > 0)![0];
function pointCache(sim: Sim): EntityId {
  for (const [, p] of sim.state.rear.entries()) if (p.kind === "supply" && p.side === "blue") return p.cache!;
  throw new Error("no supply point");
}
function rounds(sim: Sim, cache: EntityId): number {
  let n = 0;
  for (const s of sim.state.container.req(cache).stacks) if (s.charge !== undefined) n += s.charge * s.count;
  return n;
}

describe("supplies from off the map (M11.4b)", () => {
  it("the stock is outside the ledger; a point below callBelow calls the supply vehicle, which unloads into it; conservation exact", () => {
    const { sim } = hold();
    run(sim, 12); // (the point's fill is taken at the first look)
    const cache = pointCache(sim);
    expect(sim.state.cache.req(cache).fill).toBeGreaterThan(0);
    const fill = sim.state.cache.req(cache).fill!;
    // The stock is not counted by the ledger.
    const stock = [...sim.state.stock.keys()][0]!;
    expect(sim.state.stock.req(stock).side).toBe("blue");
    // Drain the point to a tenth (the rounds leave the battle: start the tally after it).
    const k = sim.state.container.req(cache);
    for (const s of [...k.stacks]) removeItems(k, s.type, Math.ceil(s.count * 0.9), s.charge);
    expect(rounds(sim, cache)).toBeLessThan(0.3 * fill);
    const start = ledgerOf(sim.ctx.catalog, sim.state);
    const c = emptyConsumption(), tr = tracerMap(sim.ctx.catalog);
    const evs: SimEvent[] = [];
    let unloaded: Extract<SimEvent, { kind: "supply.delivery" }> | null = null;
    run(sim, 3000, (e) => { evs.push(e); if (e.kind === "supply.delivery" && e.phase === "unloaded") unloaded = e; }, () => unloaded !== null);
    consumedFromEvents(c, evs, tr);
    expect(unloaded).not.toBeNull();
    const called = evs.find((e) => e.kind === "supply.delivery" && e.phase === "called") as Extract<SimEvent, { kind: "supply.delivery" }>;
    expect(called.ordered).toBeUndefined();
    expect(sim.state.vehicle.req(called.vehicle).offMap?.kind).toBe("supply");
    expect(unloaded!.rounds).toBeGreaterThan(0);
    expect(rounds(sim, cache)).toBeGreaterThanOrEqual(0.3 * fill);
    // Every round that left the stock is an items.delivered event; the guard balances.
    expect(Object.values(c.delivered).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(checkConservation(start, ledgerOf(sim.ctx.catalog, sim.state), c)).toEqual({});
    // The computer never puts ammunition into an ambulance.
    expect(evs.some((e) => e.kind === "law.misuse")).toBe(false);
  }, 240_000);

  it("one delivery at a time; the player's order is refused while one is under way", () => {
    const { sim } = hold();
    const top = topBlue(sim);
    const evs: SimEvent[] = [];
    submitOrder(sim, { tick: 0, issuer: "blue", target: top, kind: "callDelivery", player: true });
    run(sim, 5, (e) => evs.push(e));
    expect(evs.some((e) => e.kind === "supply.delivery" && e.phase === "called" && e.ordered === true)).toBe(true);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: top, kind: "callDelivery", player: true });
    run(sim, 5, (e) => evs.push(e));
    expect(evs.some((e) => e.kind === "radio" && e.key === "radio.deliveryComing")).toBe(true);
    expect(evs.filter((e) => e.kind === "supply.delivery" && e.phase === "called").length).toBe(1);
  }, 120_000);

  it("the mortar allotment is topped up from the stock every 10 minutes; nothing with rules.deliveries false", () => {
    const he = (sim: Sim) => { const sec = sim.state.support.find((s) => s.side === "blue" && s.asset === undefined)!; return sim.state.container.req(sec.battery).stacks.filter((s) => s.type === sec.heType).reduce((n, s) => n + s.count, 0); };
    const a = hold();
    const before = he(a.sim);
    const evs: SimEvent[] = [];
    run(a.sim, 601, (e) => evs.push(e));
    const up = evs.filter((e) => e.kind === "supply.topUp");
    expect(up.length).toBe(1);
    expect(he(a.sim)).toBeGreaterThanOrEqual(before + (up[0] as Extract<SimEvent, { kind: "supply.topUp" }>).count - 3); // (a mission may have fired a round meanwhile)
    expect(evs.some((e) => e.kind === "items.delivered" && e.holder === (up[0] as Extract<SimEvent, { kind: "supply.topUp" }>).battery)).toBe(true);
    const b = hold(1, false);
    const evs2: SimEvent[] = [];
    run(b.sim, 601, (e) => evs2.push(e));
    expect(evs2.some((e) => e.kind === "supply.topUp" || e.kind === "supply.delivery")).toBe(false);
  }, 120_000);

  it("a delivery by an ambulance on the player's order is a breach: the ambulance loses its protection while it carries ammunition", () => {
    const { sim } = hold();
    const top = topBlue(sim);
    const amb = [...sim.state.vehicle.entries()].find(([, v]) => v.side === "blue" && v.offMap?.kind === "ambulance" && v.offMap.phase === "ready")![0];
    expect(protectionNow(sim.ctx.catalog, sim.state, amb)).toBe(PROT_MARKED);
    const evs: SimEvent[] = [];
    submitOrder(sim, { tick: 0, issuer: "blue", target: top, kind: "callDelivery", vehicle: amb, player: true });
    run(sim, 5, (e) => evs.push(e));
    const mis = evs.find((e) => e.kind === "law.misuse");
    expect(mis).toMatchObject({ side: "blue", vehicle: amb, cause: "ammunitionInAmbulance", ordered: true });
    expect(sim.state.vehicle.req(amb).misuse).toBe(true);
    expect(protectionNow(sim.ctx.catalog, sim.state, amb)).toBe(0);
    let unloaded = false;
    run(sim, 3000, (e) => { if (e.kind === "supply.delivery" && e.phase === "unloaded" && e.vehicle === amb) unloaded = true; }, () => unloaded);
    expect(unloaded).toBe(true);
    expect(sim.state.vehicle.req(amb).misuse).toBeUndefined();
    expect(protectionNow(sim.ctx.catalog, sim.state, amb)).toBe(PROT_MARKED);
    // The review lists it.
    // (record.ts counts law.misuse under the side's conduct; checked through the event here.)
  }, 240_000);

  it("save and load mid-delivery continue identically", () => {
    const { sim, input } = hold();
    submitOrder(sim, { tick: 0, issuer: "blue", target: topBlue(sim), kind: "callDelivery", player: true });
    let inbound = false;
    run(sim, 2000, (e) => { if (e.kind === "supply.delivery" && e.phase === "entered") inbound = true; }, () => inbound);
    expect(inbound).toBe(true);
    run(sim, 5);
    const saved = saveSim(sim);
    const other = loadSim(input, saved);
    run(sim, 200); run(other, 200);
    expect(simHash(other)).toBe(simHash(sim));
  }, 240_000);

  it("a schema-23 save (no stock store) loads with an empty stock", () => {
    const { sim } = hold();
    const s = serializeState(sim.state) as SerializedState & { stores: Record<string, unknown> };
    const old = JSON.parse(JSON.stringify(s)) as { schema: number; stores: Record<string, unknown> };
    old.schema = 23;
    old.stores = Object.fromEntries(Object.entries(old.stores).filter(([k]) => k !== "stock"));
    const st = deserializeState(old as unknown as SerializedState);
    expect(st.stock.size).toBe(0);
  }, 60_000);

  it("lab: the delivery and the vehicle run within 10 % of the hand calculation, conservation exact", () => {
    const rows = vehicleResupplyLab(data, [400]);
    console.log(vehicleResupplyLabMarkdown(rows));
    for (const r of rows) {
      expect(r.errPct, `${r.kind} ${r.faction}`).not.toBeNull();
      expect(Math.abs(r.errPct!), `${r.kind} ${r.faction}`).toBeLessThanOrEqual(10);
      expect(r.conservation).toBe(true);
      expect(r.rounds).toBeGreaterThan(0);
    }
  }, 240_000);
});
