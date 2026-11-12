/**
 * Vehicle gunnery (M7.3): turret and station fire from orders, counted ammunition, cease-fire routing
 * (plan C19), the vehicle-aware incoming-fire refresh (C34), smoke dischargers, cannon HE on a man (owner Q18),
 * the order table ("not-applicable"), and the fixture's single-feed sling with and without a loader (C10).
 */
import { describe, expect, it } from "vitest";
import { buildBallistics, buildMapIndex, createSim, step, submitOrder, TICK_HZ, type EntityId, type Order, type Sim, type SimEvent } from "@tcs/sim";
import { vehicleBattle } from "@tcs/scenario";
import { vehicleIncomingSystem } from "../../sim/src/systems/gunnery";
import { duel } from "../src/labs/gunnery";
import { loadData } from "../src/scenarios";

const data = loadData(true);

function crew(sim: Sim, side: string): { vid: EntityId; crew: EntityId } {
  const [vid, v] = [...sim.state.vehicle.entries()].find(([, x]) => x.side === side)!;
  return { vid, crew: v.unit! };
}
function order(sim: Sim, side: string, target: EntityId, body: Record<string, unknown>): void {
  submitOrder(sim, { tick: sim.state.tick, issuer: side, target, ...body } as Order);
}
function run(sim: Sim, seconds: number, on: (e: SimEvent) => void = () => undefined): void {
  for (let i = 0; i < seconds * TICK_HZ; i++) for (const e of step(sim)) on(e);
}
function holdAll(sim: Sim): void {
  for (const [uid, u] of sim.state.unit.entries()) if (u.parent === null) order(sim, u.side, uid, { kind: "rules", fire: "hold" });
  step(sim);
}

describe("vehicle gunnery (M7.3)", () => {
  it("a fire order lays the turret and fires the cannon; every round leaves the ready feed (rule 9)", () => {
    const sim = createSim(duel(data, ["de", "ru"], { blue: { x: 400, y: 600, heading: 0 }, red: { x: 1200, y: 600, heading: Math.PI / 2 } }));
    holdAll(sim);
    const b = crew(sim, "blue");
    const v = sim.state.vehicle.req(b.vid);
    const ready0 = v.stations[0]!.weapons[0]!.feeds[0]!.rounds;
    order(sim, "blue", b.crew, { kind: "fire", x: 1200, y: 600, heightM: 1.2, nature: "ap" });
    let shots = 0, hits = 0;
    const gunners = new Set(sim.state.unit.req(b.crew).members);
    run(sim, 20, (e) => {
      if (e.kind === "shot.fired" && e.vehicle === b.vid) { shots++; expect(gunners.has(e.shooter)).toBe(true); }
      if (e.kind === "vehicle.hit" && gunners.has(e.owner)) hits += e.rounds;
    });
    expect(shots).toBeGreaterThan(5);
    expect(hits).toBeGreaterThan(shots / 2);
    expect(v.stations[0]!.weapons[0]!.feeds[0]!.rounds).toBe(ready0 - shots);
    // M7.4a: 30 mm APFSDS goes through a BMP-2's side: it is knocked out.
    expect(sim.state.vehicle.req(crew(sim, "red").vid).status).not.toBe("ok");
  });

  it("station fire is kept up by incoming fire with no infantry fire task (incomingFire early return, C34)", () => {
    const sim = createSim(duel(data, ["de", "ru"], { blue: { x: 400, y: 600, heading: 0 }, red: { x: 1200, y: 600, heading: Math.PI / 2 } }));
    holdAll(sim);
    const b = crew(sim, "blue");
    order(sim, "blue", b.crew, { kind: "fire", x: 1200, y: 600, heightM: 1.2 });
    run(sim, 5);
    const task = sim.state.vehicle.req(b.vid).stations[0]!.task!;
    expect(task).not.toBeNull();
    expect(sim.state.fire.size).toBe(0);
    const before = task.reasonTick;
    run(sim, 2);
    const redMan = sim.state.unit.req(crew(sim, "red").crew).members[0]!;
    // An enemy round passes close to the vehicle.
    const t = sim.state.transform.req(b.vid);
    vehicleIncomingSystem(sim.ctx, sim.state, [{ kind: "shot.fired", tick: sim.state.tick, shooter: redMan, x: t.x + 200, y: t.y, z: 1, dirX: -1, dirY: 0, weapon: "ru-ak74m", ammo: "ru-545-7n10" }]);
    expect(task.reasonTick).toBe(sim.state.tick);
    expect(task.reasonTick).toBeGreaterThan(before);
  });

  it("a hit on the hull puts the crew and its platoon under fire (return-fire rule, AI polling)", () => {
    const sim = createSim(duel(data, ["de", "ru"], { blue: { x: 400, y: 600, heading: 0 }, red: { x: 1200, y: 600, heading: Math.PI / 2 } }));
    holdAll(sim);
    const b = crew(sim, "blue"), r = crew(sim, "red");
    order(sim, "blue", b.crew, { kind: "fire", x: 1200, y: 600, heightM: 1.2, nature: "ap" });
    run(sim, 15);
    const rv = sim.state.vehicle.req(r.vid);
    expect(rv.lastHitTick).toBeGreaterThan(0);
    const ru = sim.state.unit.req(r.crew);
    expect(ru.underFireTick).toBeGreaterThan(0);
    expect(sim.state.unit.req(ru.parent!).underFireTick).toBeGreaterThan(0);
  });

  it("a cease-fire to a squad does not stop its platoon's IFV; to the platoon it does (C19)", () => {
    const sim = createSim(duel(data, ["de", "ru"], { blue: { x: 400, y: 600, heading: 0 }, red: { x: 1200, y: 600, heading: Math.PI / 2 } }));
    holdAll(sim);
    const b = crew(sim, "blue");
    const platoon = sim.state.unit.req(b.crew).parent!;
    const squad = sim.state.unit.req(platoon).children.find((c) => sim.state.unit.req(c).vehicle === undefined)!;
    order(sim, "blue", b.crew, { kind: "fire", x: 1200, y: 600, heightM: 1.2 });
    run(sim, 4);
    order(sim, "blue", squad, { kind: "ceaseFire" });
    run(sim, 4);
    expect(sim.state.vehicle.req(b.vid).stations[0]!.task).not.toBeNull();
    order(sim, "blue", platoon, { kind: "ceaseFire" });
    run(sim, 4);
    expect(sim.state.vehicle.req(b.vid).stations[0]!.task).toBeNull();
    expect(sim.state.unit.req(b.crew).ceaseFireTick).toBeGreaterThan(0);
  });

  it("orders that mean nothing to a crew are rejected as not-applicable; smoke to men on foot too", () => {
    const sim = createSim(duel(data, ["de", "ru"], { blue: { x: 400, y: 600, heading: 0 }, red: { x: 1200, y: 600, heading: Math.PI / 2 } }));
    const b = crew(sim, "blue");
    const squad = sim.state.unit.req(sim.state.unit.req(b.crew).parent!).children.find((c) => sim.state.unit.req(c).vehicle === undefined)!;
    const rejected: string[] = [];
    order(sim, "blue", b.crew, { kind: "grenade", x: 500, y: 600 });
    order(sim, "blue", b.crew, { kind: "posture", posture: "prone" });
    order(sim, "blue", squad, { kind: "discharge" });
    for (const e of step(sim)) if (e.kind === "order.rejected") rejected.push(e.reason);
    expect(rejected).toEqual(["not-applicable", "not-applicable", "not-applicable"]);
  });

  it("smoke dischargers: a salvo of counted grenades, clouds ahead of the turret; none left: radio.noSmoke", () => {
    const sim = createSim(duel(data, ["ru", "de"], { blue: { x: 400, y: 600, heading: 0 }, red: { x: 1200, y: 600, heading: Math.PI / 2 } }));
    const b = crew(sim, "blue");
    const def = sim.ctx.catalog.vehicles[sim.state.vehicle.req(b.vid).def]!;
    const D = def.dischargers!;
    const count = () => sim.state.container.req(b.vid).stacks.filter((s) => s.type === D.item).reduce((n, s) => n + s.count, 0);
    const n0 = count();
    const radios: string[] = [];
    let smoke: SimEvent | null = null;
    order(sim, "blue", b.crew, { kind: "discharge" });
    run(sim, 5, (e) => { if (e.kind === "vehicle.smoke") smoke = e; if (e.kind === "radio") radios.push(e.key); });
    expect(count()).toBe(n0 - D.perSalvo);
    expect(smoke).not.toBeNull();
    expect(sim.state.smoke.length).toBe(D.perSalvo);
    for (const c of sim.state.smoke) expect(c.x).toBeGreaterThan(400); // ahead (east) of the vehicle
    // Fire salvos until none are left.
    for (let k = 0; k < D.salvos + 1; k++) { order(sim, "blue", b.crew, { kind: "discharge" }); run(sim, 3, (e) => { if (e.kind === "radio") radios.push(e.key); }); }
    expect(count()).toBe(n0 % D.perSalvo);
    expect(radios).toContain("radio.noSmoke");
  });

  it("a 30 mm HE round striking a man bursts on him (Q18); VOG-25 and mortar bombs keep their old rule (C53)", () => {
    const sim = createSim(duel(data, ["de", "ru"], { blue: { x: 400, y: 600, heading: 0 }, red: { x: 2300, y: 1100, heading: 0 }, redSquadAt: { x: 700, y: 600, spacing: 6 } }));
    const B = buildBallistics(sim.ctx.map, sim.ctx.catalog, buildMapIndex(sim.ctx.map), TICK_HZ);
    const rt = (id: string) => B.ammo[sim.ctx.catalog.ammoIds.indexOf(id)]!;
    expect(rt("de-30x173-he").burstOnBody).toBe(true);
    expect(rt("ru-30x165-3uof8").burstOnBody).toBe(true);
    expect(rt("ru-vog25").burstOnBody).toBe(false);
    expect(rt("ru-82-he").burstOnBody).toBe(false);
    holdAll(sim);
    const b = crew(sim, "blue");
    // Fire HE straight at a standing man's chest: some rounds strike men and burst there.
    const target = [...sim.state.identity.entries()].find(([id, i]) => i.side === "red" && sim.state.soldier.req(id).mount === undefined)!;
    const tt = sim.state.transform.req(target[0]);
    order(sim, "blue", b.crew, { kind: "fire", x: tt.x, y: tt.y, heightM: 1.2, nature: "he" });
    let onBody = 0;
    const hits: { x: number; y: number; tick: number }[] = [];
    run(sim, 30, (e) => {
      if (e.kind === "hit" && e.ammo === "de-30x173-he") { const t = sim.state.transform.req(e.target); hits.push({ x: t.x, y: t.y, tick: e.tick }); }
      if (e.kind === "explosion" && e.ammo === "de-30x173-he" && hits.some((h) => h.tick === e.tick && Math.hypot(h.x - e.x, h.y - e.y) < 1.5)) onBody++;
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(onBody).toBe(hits.length);
  });

  it("the crew of a vehicle sees through its seat sensors and the vehicle is a target with a type (Q6)", () => {
    const input = vehicleBattle(data, { seed: 2, factions: ["de", "ru"], vehiclesPerPlatoon: 1, mapWidthM: 1600, mapHeightM: 600, timeLimitSeconds: 600 });
    const sim = createSim(input);
    run(sim, 30);
    const b = crew(sim, "blue"), r = crew(sim, "red");
    const crewmen = sim.state.unit.req(b.crew).members;
    const sees = crewmen.some((m) => sim.state.soldier.req(m).seen.some((e) => e.target === r.vid));
    expect(sees).toBe(true);
    const c = crewmen.flatMap((m) => sim.state.soldier.req(m).contacts).find((k) => k.target === r.vid)!;
    expect(c.cls).toBe("vehicle");
    // About 1280 m apart: within the 1.5 km at which its type is told.
    expect(c.vtype).toBe(sim.state.vehicle.req(r.vid).def);
  });
});

describe("fixture sling: one bolt per load, slower without a loader (C10)", () => {
  it("fires one bolt per load, about 3x faster with a passenger to load it", () => {
    const sim = createSim(duel(data, ["xf", "de"], { blue: { x: 400, y: 600, heading: 0 }, red: { x: 650, y: 600, heading: Math.PI / 2 } }, ["porter-gang", "demo-team"]));
    holdAll(sim);
    const b = crew(sim, "blue");
    let shots = 0;
    const times = (secs: number) => {
      const ts: number[] = [];
      order(sim, "blue", b.crew, { kind: "fire", x: 650, y: 600, heightM: 1 });
      run(sim, secs, (e) => { if (e.kind === "shot.fired" && e.vehicle === b.vid) ts.push(e.tick / TICK_HZ); });
      order(sim, "blue", b.crew, { kind: "ceaseFire" });
      shots += ts.length;
      return ts.slice(1).map((t, i) => t - ts[i]!);
    };
    const def = sim.ctx.catalog.vehicles[sim.state.vehicle.req(b.vid).def]!;
    const w = def.stations[0]!.weapons[0]!;
    const slow = times(40); // three bolts of the rack's six
    expect(slow.length).toBeGreaterThan(1);
    for (const g of slow) expect(g).toBeCloseTo(w.roundLoadSeconds! * w.noLoaderFactor!, 0);
    // Its squad gets in: a passenger loads.
    const platoon = sim.state.unit.req(b.crew).parent!;
    const squad = sim.state.unit.req(platoon).children.find((c) => sim.state.unit.req(c).vehicle === undefined)!;
    // (The squad stands far away in this layout: bring it to the cart first.)
    const t = sim.state.transform.req(b.vid);
    order(sim, "blue", squad, { kind: "move", waypoints: [{ x: t.x - 8, y: t.y, mode: "run" }] });
    run(sim, 200);
    order(sim, "blue", squad, { kind: "mount" });
    run(sim, 40);
    // mounted: ok the test counts the men aboard
    expect(sim.state.unit.req(squad).members.some((m) => sim.state.soldier.req(m).mount !== undefined)).toBe(true);
    const fast = times(30);
    expect(fast.length).toBeGreaterThanOrEqual(1);
    for (const g of fast) expect(g).toBeCloseTo(w.roundLoadSeconds!, 0);
    // One bolt per load: every shot took one off the rack.
    expect(sim.state.vehicle.req(b.vid).stations[0]!.weapons[0]!.feeds[0]!.rounds).toBe(def.stations[0]!.weapons[0]!.feeds[0]!.ready.count * def.stations[0]!.weapons[0]!.feeds[0]!.ready.charge - shots);
  });
});
