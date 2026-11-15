/**
 * Main battle tanks (M7.6a): the crew's judgement of what its armour-piercing round gets through with reactive
 * tiles there or used up, a round in the breech at the start, a missile fired through a tank's gun wrecked with
 * the gun, the tank gun's rounds in the expenditure tally, the default vehicle battle never taking a tank (and a
 * tank never carrying a squad), and the fixture's tortoise (rule 8): its crew fires, a dead loader doubles the
 * load time, rounds and tiles stay counted.
 */
import { describe, expect, it } from "vitest";
import { buildCatalog } from "@tcs/data";
import { crewTemplateOf, vehicleBattle } from "@tcs/scenario";
import {
  countItems, createSim, faceNeed, removeItems, step, submitOrder, tallyExpenditure, TICK_HZ, weaponOut,
  type BattleInput, type EntityId, type Expenditure, type Sim, type SimEvent,
} from "@tcs/sim";
import { duel } from "../src/labs/gunnery";
import { loadData } from "../src/scenarios";

const data = loadData();
const fixtures = loadData(true);
function run(sim: Sim, seconds: number, on: (e: SimEvent) => void = () => undefined): void {
  for (let i = 0; i < seconds * TICK_HZ; i++) for (const e of step(sim)) on(e);
}
function holdAll(sim: Sim): void {
  for (const [uid, u] of sim.state.unit.entries()) if (u.parent === null) submitOrder(sim, { tick: sim.state.tick, issuer: u.side, target: uid, kind: "rules", fire: "hold", at: "hold" });
  step(sim);
}
const side = (sim: Sim, s: string): [EntityId, NonNullable<ReturnType<Sim["state"]["vehicle"]["get"]>>] => [...sim.state.vehicle.entries()].find(([, v]) => v.side === s)!;
/** Leopard (blue, west) and T-90M (red, `R` m east, head-on unless `heading` given). */
function leoVsT90(R = 1500, heading = Math.PI): BattleInput {
  return duel(data, ["de", "ru"], { blue: { x: 400, y: 600, heading: 0 }, red: { x: 400 + R, y: 600, heading } }, undefined, 2400, ["leopard2a7v-besatzung", "t90m-ekipazh"]);
}

describe("main battle tanks (M7.6a)", () => {
  it("the crew's judgement: DM63A1 (850 mm) cannot expect to get through the T-90M's hull front with Relikt there (600 + 0.75 x 344), can without", () => {
    const sim = createSim(leoVsT90());
    const [rid] = side(sim, "red");
    const need = () => faceNeed(sim.ctx, sim.state, rid, 400, 600, "kinetic")!;
    expect(need()).toBeCloseTo(600 + 0.75 * 344, 6);
    expect(sim.ctx.catalog.ammo["de-120-dm63a1"]!.penetration.steelMm >= need()).toBe(false);
    // Half the tiles gone: half the expected add; none left: the plate alone.
    const c = sim.state.container.req(rid);
    removeItems(c, "ru-relikt-hull-front", 10);
    expect(need()).toBeCloseTo(600 + 0.75 * 0.5 * 344, 6);
    removeItems(c, "ru-relikt-hull-front", 10);
    expect(need()).toBeCloseTo(600, 6);
    expect(sim.ctx.catalog.ammo["de-120-dm63a1"]!.penetration.steelMm >= need()).toBe(true);
    // Against a jet: the plate's shaped resistance plus the tile's tandem or single figure.
    removeItems(c, "ru-relikt-hull-front", 100);
    expect(faceNeed(sim.ctx, sim.state, rid, 400, 600, "tandem")).toBeCloseTo(480 * 1.48, 6);
  });

  it("a vehicle without tiles is judged by its plate alone (the Puma, as before)", () => {
    const sim = createSim(duel(data, ["ru", "de"], { blue: { x: 400, y: 600, heading: 0 }, red: { x: 1400, y: 600, heading: Math.PI } }));
    const [pid] = side(sim, "red");
    const p = sim.ctx.ballistics.vehicleRT["de-puma"]!.plates[0]!;
    expect(faceNeed(sim.ctx, sim.state, pid, 400, 600, "kinetic")).toBeCloseTo((p.thicknessMm * p.kPerMm) / Math.max(p.cosS, sim.ctx.catalog.ballistics.armour.losFloorCos), 9);
  });

  it("a single-round gun with startLoaded has a round in the breech at the start; a belt-fed one does not", () => {
    const sim = createSim(leoVsT90());
    const [, leo] = side(sim, "blue");
    expect(leo.stations[0]!.weapons[0]!.loadedRound).toBe(true);
    const [, t90] = side(sim, "red");
    expect(t90.stations[0]!.weapons[0]!.loadedRound).toBe(true);
    expect(t90.stations[0]!.weapons[1]!.loadedRound).toBe(false); // the missile channel (no startLoaded)
    const puma = createSim(duel(data, ["de", "ru"], { blue: { x: 400, y: 600, heading: 0 }, red: { x: 1400, y: 600, heading: Math.PI } }));
    expect(side(puma, "blue")[1].stations[0]!.weapons.every((w) => !w.loadedRound)).toBe(true);
  });

  it("the Refleks missile is out when the gun it is fired through is wrecked (and when the sights are)", () => {
    const sim = createSim(leoVsT90());
    const [, t90] = side(sim, "red");
    const def = sim.ctx.catalog.vehicles["ru-t90m"]!;
    const set = (kind: string, c: number) => def.components!.forEach((x, k) => { if (x.kind === kind) t90.comp[k] = c; });
    expect(weaponOut(sim.ctx, t90, def, 0, 1)).toBe(false);
    set("gun", 0);
    expect(weaponOut(sim.ctx, t90, def, 0, 1)).toBe(true);
    expect(weaponOut(sim.ctx, t90, def, 0, 0)).toBe(true);
    set("gun", 1); set("sights", 0);
    expect(weaponOut(sim.ctx, t90, def, 0, 1)).toBe(true);
    expect(weaponOut(sim.ctx, t90, def, 0, 0)).toBe(false);
  });

  it("the tank gun's rounds are credited to the vehicle as cannon rounds; its missile as a missile", () => {
    const sim = createSim(leoVsT90(2000, Math.PI / 2));
    holdAll(sim);
    const [rid, t90] = side(sim, "red");
    const [bid] = side(sim, "blue");
    const t = sim.state.transform.req(bid);
    submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: t90.unit!, kind: "fire", x: t.x, y: t.y, heightM: 1.2, nature: "ap" });
    const exp: Expenditure = {};
    let fired = 0;
    for (let i = 0; i < 20 * TICK_HZ; i++) { const ev = step(sim); fired += ev.filter((e) => e.kind === "shot.fired" && e.vehicle === rid).length; tallyExpenditure(exp, ev, sim.state, sim.ctx.catalog); }
    expect(fired).toBeGreaterThan(0);
    const mine = exp["red"]!.vehicles[t90.vehicleId]!;
    expect(Object.keys(mine.cannon)).toEqual(["ru-125-3bm60"]);
    expect(mine.cannon["ru-125-3bm60"]).toBe(fired);
    expect(mine.coax).toBe(0);
    // The missile, ordered "at".
    const sim2 = createSim(leoVsT90(2000, Math.PI / 2));
    holdAll(sim2);
    const [rid2, v2] = side(sim2, "red");
    const t2 = sim2.state.transform.req(side(sim2, "blue")[0]);
    submitOrder(sim2, { tick: sim2.state.tick, issuer: "red", target: v2.unit!, kind: "fire", x: t2.x, y: t2.y, contact: side(sim2, "blue")[0], nature: "at" });
    const exp2: Expenditure = {};
    for (let i = 0; i < 15 * TICK_HZ; i++) tallyExpenditure(exp2, step(sim2), sim2.state, sim2.ctx.catalog);
    expect(exp2["red"]!.vehicles[v2.vehicleId]!.missiles).toEqual({ "ru-9m119m": 1 });
    expect(rid2).toBeGreaterThan(0);
  });

  it("the vehicle battles' default crews stay the carriers (never a tank); a tank crew's squad has no carrier", () => {
    expect(crewTemplateOf(data, "de")).toBe("puma-besatzung");
    expect(crewTemplateOf(data, "ru")).toBe("bmp2-ekipazh");
    expect(crewTemplateOf(fixtures, "xf")).toBe("cart-crew");
    const input = vehicleBattle(data, { seed: 1, factions: ["de", "ru"], crewTemplates: ["leopard2a7v-besatzung", "t90m-ekipazh"] });
    const squads = input.forces.flatMap((f) => f.units.flatMap((u) => u.subunits)).filter((u) => u.vehicleId === undefined);
    expect(squads.length).toBe(4);
    expect(squads.every((u) => u.carrierId === undefined)).toBe(true);
    const ifv = vehicleBattle(data, { seed: 1, factions: ["de", "ru"] });
    expect(ifv.forces.flatMap((f) => f.units.flatMap((u) => u.subunits)).filter((u) => u.vehicleId === undefined).every((u) => u.carrierId !== undefined)).toBe(true);
    const sim = createSim(input);
    run(sim, 2);
    expect([...sim.state.vehicle.values()].map((v) => v.def).sort()).toEqual(["de-leopard2a7v", "de-leopard2a7v", "ru-t90m", "ru-t90m"]);
  });

  it("the T-90M's 43 rounds and 68 Relikt tiles are counted items of its container", () => {
    const sim = createSim(leoVsT90());
    const [rid, t90] = side(sim, "red");
    const c = sim.state.container.req(rid);
    const ready = t90.stations[0]!.weapons.slice(0, 2).flatMap((w) => w.feeds).reduce((n, f) => n + f.rounds, 0);
    const stowed = ["ru-125-3bm60-round", "ru-125-3of26-round", "ru-9m119m-round"].reduce((n, it) => n + countItems(c, it), 0);
    expect(ready + stowed).toBe(43);
    expect(["ru-relikt-turret-front", "ru-relikt-turret-side", "ru-relikt-hull-front", "ru-relikt-hull-side"].map((it) => countItems(c, it))).toEqual([26, 10, 20, 12]);
    const leo = side(sim, "blue");
    const lc = sim.state.container.req(leo[0]);
    expect(leo[1].stations[0]!.weapons[0]!.feeds.reduce((n, f) => n + f.rounds, 0) + countItems(lc, "de-120-dm63a1-round") + countItems(lc, "de-120-dm11-round")).toBe(42);
  });
});

describe("the fixture's tortoise (M7.6a, rule 8)", () => {
  /** The tortoise (blue) and a Puma side-on `R` m east; `noLoader`: its loader comes in killed. */
  function tortoise(noLoader = false, R = 800): { sim: Sim; vid: EntityId; crew: EntityId; tx: number } {
    const input = duel(fixtures, ["xf", "de"], { blue: { x: 400, y: 600, heading: 0 }, red: { x: 400 + R, y: 600, heading: Math.PI / 2 } }, ["porter-band", "pzgren-schuetzentrupp"], 2400, ["tortoise-crew", "puma-besatzung"]);
    for (const rec of input.forces[1]!.vehicles ?? []) rec.status = "immobilised";
    if (noLoader) {
      const tmpl = fixtures.factions["xf"]!.units["tortoise-crew"]!;
      const k = tmpl.members.findIndex((m) => m.seat === "ldr");
      for (const u of input.forces[0]!.units.flatMap((x) => x.subunits)) if (u.vehicleId !== undefined) u.members[k]!.status = "killed";
    }
    const sim = createSim(input);
    holdAll(sim);
    const [vid, v] = side(sim, "blue");
    return { sim, vid, crew: v.unit!, tx: 400 + R };
  }
  /** Seconds between the first rounds of an armour-piercing order. */
  function cycle(noLoader: boolean): { cycle: number; shots: number } {
    const { sim, vid, crew, tx } = tortoise(noLoader);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: crew, kind: "fire", x: tx, y: 600, heightM: 1.2, nature: "ap" });
    const ticks: number[] = [];
    run(sim, 30, (e) => { if (e.kind === "shot.fired" && e.vehicle === vid) ticks.push(e.tick); });
    return { cycle: ticks.length > 1 ? (ticks[ticks.length - 1]! - ticks[0]!) / TICK_HZ / (ticks.length - 1) : -1, shots: ticks.length };
  }

  it("its crew fires the bombard at the Puma; with the loader dead each round takes twice as long to load", () => {
    const full = cycle(false), slow = cycle(true);
    expect(full.shots).toBeGreaterThanOrEqual(3);
    expect(full.cycle).toBeGreaterThanOrEqual(5);
    expect(full.cycle).toBeLessThan(6.5);
    expect(slow.shots).toBeGreaterThanOrEqual(2);
    expect(slow.cycle / full.cycle).toBeGreaterThan(1.7);
    expect(slow.cycle / full.cycle).toBeLessThan(2.3);
  });

  it("rounds and tiles stay counted: fired + left = ready + stowed at the start; tiles only leave the container when used", () => {
    const { sim, vid, crew, tx } = tortoise();
    const v = sim.state.vehicle.req(vid), c = sim.state.container.req(vid);
    const rounds = () => v.stations[0]!.weapons[0]!.feeds.reduce((n, f) => n + f.rounds, 0) + countItems(c, "xf-ram-round") + countItems(c, "xf-pot-round");
    const tiles = () => countItems(c, "xf-scale") + countItems(c, "xf-scale-hull");
    const r0 = rounds(), t0 = tiles();
    expect(r0).toBe(14);
    expect(t0).toBe(12);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: crew, kind: "fire", x: tx, y: 600, heightM: 1.2, nature: "ap" });
    let fired = 0, used = 0;
    run(sim, 60, (e) => { if (e.kind === "shot.fired" && e.vehicle === vid) fired++; if (e.kind === "vehicle.hit" && e.vehicle === vid && e.era !== undefined) used++; });
    expect(fired).toBeGreaterThan(0);
    expect(rounds()).toBe(r0 - fired);
    expect(tiles()).toBe(t0 - used);
    expect(buildCatalog(fixtures, ["xf"]).vehicles["xf-tortoise"]!.armour!.tiles!.map((t) => t.fitted)).toEqual([6, 6]);
  });
});
