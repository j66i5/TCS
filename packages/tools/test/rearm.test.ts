/**
 * M11.5 (plan slice 48): re-arming and refuelling vehicles, rounds to on-map mortars. A halted hull beside an own
 * cache takes its stowage back and fills its tank from fuel cans (within 10 % of the hand calculation, rounds and
 * litres conserved exactly); from a supply truck it gets litres by pump but not the truck's own kit; the roster out
 * keeps fuel and stowage; an order stops the work; save and load mid-work continue identically; an idle hull short
 * of ammunition drives to an own cache near by on its own; a mortar team short of rounds fetches them from a cache
 * beside its tubes without packing up; the off-map top-up puts rounds beside on-map tubes.
 */
import { describe, expect, it } from "vitest";
import { allMembers, buildForce, demoBattle } from "@tcs/scenario";
import {
  checkChargeConservation, checkConservation, consumedFromEvents, createSim, emptyConsumption, fuelKinds, fuelLitres, ledgerOf, loadSim, saveSim, simHash, step,
  submitOrder, teamRounds, tracerMap, tubeOf, vehicleRecordFromState, TICK_HZ,
  type BattleInput, type EntityId, type Sim, type SimEvent,
} from "@tcs/sim";
import { loadData } from "../src/scenarios";
import { rearmRig } from "../src/labs/rearm";

const data = loadData();

function run(sim: Sim, seconds: number, on: (e: SimEvent) => void = () => undefined, until: () => boolean = () => false): void {
  for (let i = 0; i < seconds * TICK_HZ && !until(); i++) for (const e of step(sim)) on(e);
}
function stowedRounds(sim: Sim, vid: EntityId): number {
  const cat = sim.ctx.catalog;
  let n = 0;
  for (const s of sim.state.container.req(vid).stacks) {
    const d = cat.items[s.type];
    if (s.charge !== undefined && d?.chargeItem !== undefined && cat.ammo[d.chargeItem] !== undefined) n += s.charge * s.count;
    else if (s.charge === undefined && cat.ammo[s.type] !== undefined) n += s.count;
  }
  return n;
}

describe("re-arming and refuelling (M11.5)", () => {
  it("a BMP-2 re-arms and refuels at a cache: stowage and tank full, conserved exactly, roster out keeps both", () => {
    const { sim, vid, def, input } = rearmRig(data, "ru", undefined, "cache");
    const cat = input.catalog;
    const start = ledgerOf(cat, sim.state), used = emptyConsumption(), tracer = tracerMap(cat);
    const before = stowedRounds(sim, vid);
    const ev: SimEvent[] = [];
    run(sim, 2400, (e) => { ev.push(e); consumedFromEvents(used, [e], tracer); }, () => ev.some((e) => e.kind === "vehicle.resupply" && e.what === "refuel" && e.phase === "done"));
    const phases = ev.filter((e) => e.kind === "vehicle.resupply" && e.vehicle === vid).map((e) => (e as Extract<SimEvent, { kind: "vehicle.resupply" }>).what + ":" + (e as Extract<SimEvent, { kind: "vehicle.resupply" }>).phase);
    expect(phases).toEqual(["rearm:started", "rearm:done", "refuel:done"]);
    expect(stowedRounds(sim, vid)).toBeGreaterThan(before + 4000);
    expect(fuelLitres(sim.state, vid, def)).toBeGreaterThanOrEqual(def.fuel.capacityL - 20);
    const end = ledgerOf(cat, sim.state);
    expect(checkConservation(start, end, used)).toEqual({});
    expect(checkChargeConservation(start, end, used, fuelKinds(cat))).toEqual({});
    // Roster round trip: the record out carries the litres and the stowage now in the hull.
    const rec = vehicleRecordFromState(sim.state, vid);
    const tank = rec.load.filter((l) => l.type === def.fuel.item).reduce((n, l) => n + (l.charge ?? 0) * l.count, 0);
    expect(tank).toBe(fuelLitres(sim.state, vid, def));
    const recRounds = rec.load.reduce((n, l) => { const d = cat.items[l.type]; return n + (l.charge !== undefined && d?.chargeItem !== undefined ? l.charge * l.count : 0); }, 0);
    expect(recRounds).toBeGreaterThan(4000);
  }, 240_000);

  it("from a supply truck: litres by pump above its reserve, never the truck's own kit", () => {
    const { sim, vid, def, input, truckL } = rearmRig(data, "de", undefined, "truck");
    const F = input.catalog.supply!.refuel!;
    const l0 = fuelLitres(sim.state, vid, def), r0 = stowedRounds(sim, vid);
    const ev: SimEvent[] = [];
    run(sim, 600, (e) => ev.push(e), () => ev.some((e) => e.kind === "vehicle.resupply" && e.phase === "done"));
    expect(fuelLitres(sim.state, vid, def) - l0).toBe(Math.floor(truckL - F.keepL));
    expect(stowedRounds(sim, vid)).toBe(r0);
  }, 120_000);

  it("an order to the crew stops it (what was moved stays); save and load mid-work continue identically", () => {
    const a = rearmRig(data, "ru", undefined, "cache");
    run(a.sim, 200);
    expect(a.sim.state.vehicle.req(a.vid).resupply?.phase).toBe("work");
    const saved = saveSim(a.sim);
    const other = loadSim(a.input, saved);
    run(a.sim, 120); run(other, 120);
    expect(simHash(other)).toBe(simHash(a.sim));
    const crew = a.sim.state.vehicle.req(a.vid).unit!;
    submitOrder(a.sim, { tick: a.sim.state.tick, issuer: "blue", target: crew, kind: "halt", player: true });
    const ev: SimEvent[] = [];
    run(a.sim, 5, (e) => ev.push(e));
    expect(ev.some((e) => e.kind === "vehicle.resupply" && e.phase === "stopped" && e.why === "order")).toBe(true);
    // (Nothing more moves, and it does not start again on its own at once.)
    const r = stowedRounds(a.sim, a.vid);
    run(a.sim, 60);
    expect(a.sim.state.vehicle.req(a.vid).resupply).toBeUndefined();
    expect(stowedRounds(a.sim, a.vid)).toBe(r);
  }, 240_000);

  it("an idle hull short of ammunition drives to an own cache near by and re-arms there", () => {
    const { sim, vid, input } = rearmRig(data, "ru", undefined, "cache");
    // The cache 120 m off instead of beside it.
    const cache = [...sim.state.cache.entries()][0]![0];
    const ct = sim.state.transform.req(cache), vt = sim.state.transform.req(vid);
    ct.x = vt.x + 120; ct.y = vt.y;
    void input;
    const ev: SimEvent[] = [];
    run(sim, 600, (e) => ev.push(e), () => ev.some((e) => e.kind === "vehicle.resupply" && e.phase === "started"));
    expect(ev.some((e) => e.kind === "vehicle.resupply" && e.vehicle === vid && e.phase === "heading")).toBe(true);
    expect(ev.some((e) => e.kind === "vehicle.resupply" && e.vehicle === vid && e.phase === "started")).toBe(true);
    const t = sim.state.transform.req(vid);
    expect(Math.hypot(t.x - ct.x, t.y - ct.y)).toBeLessThanOrEqual(input.catalog.supply!.rearm!.standM + 0.5);
  }, 240_000);
});

/** The demo squads on a flat map plus a German mortar section for blue at (300, 200); no off-map allotment. */
function mortarBattle(prep?: (i: BattleInput) => void): BattleInput {
  const input = demoBattle(data, { seed: 4, factions: ["de", "ru"], mapWidthM: 2000, mapHeightM: 400, frontM: 600, timeLimitSeconds: 1200 });
  input.rules.support = [];
  const sec = buildForce(data, { faction: "de", template: "moerser-gruppe", seed: 9, keyPrefix: "blue-m", number: 1 });
  const f = input.forces.find((x) => x.side === "blue")!;
  f.units.push(sec);
  allMembers(sec).forEach((m, i) => f.placements.push({ personId: m.personId, x: 300 + (i % 4) * 3, y: 190 + Math.floor(i / 4) * 20, heading: 0 }));
  prep?.(input);
  return input;
}

describe("rounds to on-map mortars (M11.5)", () => {
  it("a team short of rounds sends a man to a cache beside its tubes; the tube stays set up", () => {
    let he = "";
    const input = mortarBattle((i) => {
      const f = i.forces.find((x) => x.side === "blue")!;
      // Each team keeps 4 rounds; the rest lies in a cache 30 m behind the tubes.
      const mortar = Object.values(i.catalog.items).find((d) => d.mortar !== undefined && d.id.startsWith("de-"))!.mortar!;
      he = mortar.he;
      let spare = 0;
      for (const u of f.units) for (const m of allMembers(u)) {
        for (const l of m.load) if (l.type === mortar.he || l.type === mortar.smoke) { spare += l.count; l.count = 0; }
      }
      f.units.forEach((u) => { for (const m of allMembers(u)) if (m.load.some((l) => i.catalog.items[l.type]?.mortar !== undefined)) m.load.push({ type: mortar.he, count: 4 }); });
      f.caches = [{ x: 270, y: 200, load: [{ type: mortar.he, count: Math.max(20, spare) }] }];
    });
    const sim = createSim(input);
    for (const [uid] of sim.state.unit.entries()) sim.state.unit.req(uid).fireRule = "hold";
    const teams = [...sim.state.unit.entries()].filter(([, u]) => u.side === "blue" && u.mortar !== undefined).map(([id]) => id);
    expect(teams.length).toBeGreaterThan(0);
    const before = teams.map((t) => teamRounds(sim.state, t, he));
    const ev: SimEvent[] = [];
    run(sim, 180, (e) => ev.push(e));
    const after = teams.map((t) => teamRounds(sim.state, t, he));
    for (let k = 0; k < teams.length; k++) expect(after[k]!).toBeGreaterThan(before[k]!);
    expect(ev.some((e) => e.kind === "mortar.packed")).toBe(false);
    for (const t of teams) { expect(sim.state.unit.req(t).mortar!.state).toBe("ready"); expect(tubeOf(sim.ctx, sim.state, t)).not.toBeNull(); }
  }, 120_000);

  it("the off-map top-up puts rounds into a cache beside the on-map tubes", () => {
    const input = mortarBattle((i) => {
      const f = i.forces.find((x) => x.side === "blue")!;
      const mortar = Object.values(i.catalog.items).find((d) => d.mortar !== undefined && d.id.startsWith("de-"))!.mortar!;
      f.stock = { load: [{ type: mortar.he, count: 30 }], supportTopUp: { rounds: 6, everyS: 60 } };
    });
    const sim = createSim(input);
    for (const [uid] of sim.state.unit.entries()) sim.state.unit.req(uid).fireRule = "hold";
    const ev: SimEvent[] = [];
    run(sim, 130, (e) => ev.push(e));
    const tops = ev.filter((e): e is Extract<SimEvent, { kind: "supply.topUp" }> => e.kind === "supply.topUp");
    expect(tops.length).toBeGreaterThan(0);
    const cache = tops[0]!.battery;
    expect(sim.state.cache.get(cache)?.tubes).toBeDefined();
    const ct = sim.state.transform.req(cache);
    expect(Math.hypot(ct.x - 305, ct.y - 200)).toBeLessThan(40);
  }, 120_000);
});
