/**
 * Guard tests the M7 plan asked for (M7 review finding 7): no projectile is added inside the projectile loop
 * [C45]; a man routes round a wreck without looping [C54]; a hull-down hull is hit only on the turret; rockets
 * are never thrown or lobbed as grenades; squad loads stay 22-45 kg with the anti-tank weapons split among the men.
 */
import { describe, expect, it } from "vitest";
import {
  createSim, grenadeOption, hullObb, launcherRound, loadKg, removeItems, step, submitOrder, TICK_HZ, type EntityId, type Sim, type SimEvent,
} from "@tcs/sim";
import { duel } from "../src/labs/gunnery";
import { getScenario, loadData } from "../src/scenarios";

const data = loadData();
const fixtures = loadData(true);

function run(sim: Sim, seconds: number, on: (e: SimEvent) => void = () => undefined): void {
  for (let i = 0; i < seconds * TICK_HZ; i++) for (const e of step(sim)) on(e);
}
function holdAll(sim: Sim): void {
  for (const [uid, u] of sim.state.unit.entries()) if (u.parent === null) submitOrder(sim, { tick: sim.state.tick, issuer: u.side, target: uid, kind: "rules", fire: "hold", at: "hold" });
  step(sim);
}
const crewOf = (sim: Sim, side: string): EntityId => [...sim.state.unit.entries()].find(([, u]) => u.side === side && u.vehicle !== undefined)![0];

describe("projectile loop guard [C45]", () => {
  it("no projectile is added during the loop: hull hits, over-penetrations and rifle rounds on a hull", () => {
    const sim = createSim(duel(data, ["de", "ru"], { blue: { x: 600, y: 600, heading: 0 }, red: { x: 1000, y: 600, heading: Math.PI / 2 } }));
    holdAll(sim);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: crewOf(sim, "blue"), kind: "fire", x: 1000, y: 600, heightM: 1.2, nature: "ap" });
    const results = new Set<string>();
    run(sim, 30, (e) => { if (e.kind === "vehicle.hit") results.add(e.result); });
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: crewOf(sim, "blue"), kind: "fire", x: 1000, y: 600, heightM: 1.2, nature: "mg" });
    run(sim, 10, (e) => { if (e.kind === "vehicle.hit") results.add(e.result); });
    expect(results.has("penetrated")).toBe(true);
    expect(results.has("stopped")).toBe(true);
    expect(sim.ctx.ballistics.loopAdds).toBe(0);
  });

  it("no projectile is added during the loop: a rocket intercepted by active protection (fixture)", () => {
    // A German Panzerfaust gunner 80 m off the fixture wagon's side (it carries two charms); a few seeds, so that
    // one rocket reaches the hull and is engaged.
    const results: string[] = [];
    let adds = 0;
    for (let seed = 1; seed <= 6 && !results.includes("intercepted"); seed++) {
      const input = duel(fixtures, ["de", "xf"], { blue: { x: 60, y: 1100, heading: 0 }, red: { x: 1400, y: 600, heading: Math.PI / 2 } }, ["pzgren-schuetzentrupp", "porter-band"]);
      input.seed = seed;
      const xf = input.forces[1]!;
      xf.vehicles![0]!.type = "xf-wagon";
      xf.vehicles![0]!.load.push({ type: "xf-charm", count: 2 });
      const probe = createSim(input);
      const person = [...probe.state.identity.entries()].find(([id, i]) => i.side === "blue" && probe.state.soldier.req(id).mount === undefined && launcherRound(probe.ctx, probe.state, id))![1].personId;
      Object.assign(input.forces[0]!.placements.find((p) => p.personId === person)!, { x: 1320, y: 600, heading: 0 });
      const sim = createSim(input);
      holdAll(sim);
      const gunner = [...sim.state.identity.entries()].find(([, i]) => i.personId === person)![0];
      const target = [...sim.state.vehicle.entries()].find(([, v]) => v.side === "red")![0];
      const t = sim.state.transform.req(target);
      submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: gunner, kind: "fire", x: t.x, y: t.y, contact: target, nature: "at" });
      run(sim, 15, (e) => { if (e.kind === "vehicle.hit") results.push(e.result); });
      adds += sim.ctx.ballistics.loopAdds;
    }
    expect(results).toContain("intercepted");
    expect(adds).toBe(0);
  });
});

describe("wrecks and hull-down", () => {
  it("a man routes round a wreck without looping [C54]", () => {
    // A burnt-out BMP-2 lies side-on across a man's way west; he is sent alone to a point just beyond it.
    const input = duel(data, ["de", "ru"], { blue: { x: 400, y: 200, heading: 0 }, red: { x: 1000, y: 600, heading: Math.PI / 2 }, redSquadAt: { x: 1012, y: 607.5, spacing: 3 } });
    for (const rec of input.forces[1]!.vehicles ?? []) rec.status = "destroyed";
    const sim = createSim(input);
    holdAll(sim);
    const vid = [...sim.state.vehicle.entries()].find(([, v]) => v.side === "red")![0];
    const vt = sim.state.transform.req(vid), def = sim.ctx.catalog.vehicles[sim.state.vehicle.req(vid).def]!;
    const o = hullObb(def, vt.x, vt.y, vt.heading);
    // The man of the squad standing nearest the line through the hull's middle.
    const man = [...sim.state.identity.entries()].filter(([id, i]) => i.side === "red" && sim.state.soldier.req(id).mount === undefined)
      .sort((a, b) => Math.abs(sim.state.transform.req(a[0]).y - 600) - Math.abs(sim.state.transform.req(b[0]).y - 600))[0]![0];
    const p0 = { ...sim.state.transform.req(man) };
    expect(Math.abs(p0.y - 600)).toBeLessThan(2);
    submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: man, kind: "move", waypoints: [{ x: 985, y: 600, mode: "walk" }] });
    let walked = 0, inside = 0, turns = 0, lastDx = 0, arrived = false;
    const p = { x: p0.x, y: p0.y };
    // Until he gets there (afterwards he may step into the cover of the wreck).
    for (let i = 0; i < 60 * TICK_HZ && !arrived; i++) {
      step(sim);
      const t = sim.state.transform.req(man);
      const dx = t.x - p.x;
      walked += Math.hypot(dx, t.y - p.y);
      // Turning back east once heading west (a loop) counts.
      if (Math.abs(dx) > 1e-3) { if (lastDx < 0 && dx > 0.01) turns++; lastDx = dx; }
      p.x = t.x; p.y = t.y;
      const rx = t.x - o.x, ry = t.y - o.y;
      if (Math.abs(rx * o.c + ry * o.s) < o.hl - 0.05 && Math.abs(-rx * o.s + ry * o.c) < o.hw - 0.05) inside++;
      arrived = Math.hypot(t.x - 985, t.y - 600) < 1;
    }
    expect(arrived).toBe(true);
    expect(inside).toBe(0);
    expect(turns).toBe(0);
    // Round the hull's end, not back and forth: the straight way is 27 m, round the end about 30 m.
    expect(walked).toBeLessThan(40);
  });

  it("a hull-down hull (a wall up to its hull top in front) is hit only on the turret", () => {
    const input = duel(data, ["de", "ru"], { blue: { x: 700, y: 600, heading: 0 }, red: { x: 1000, y: 600, heading: Math.PI / 2 } });
    input.map.obstacles.push({ id: 9001, kind: "concrete-wall", points: [996, 585, 996, 615], heightM: 1.97, thicknessM: 0.3, material: "reinforced-concrete" });
    const sim = createSim(input);
    holdAll(sim);
    const red = [...sim.state.vehicle.entries()].find(([, v]) => v.side === "red")![0];
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: crewOf(sim, "blue"), kind: "fire", x: 1000, y: 600, heightM: 2.15, nature: "mg" });
    const zones: string[] = [];
    run(sim, 20, (e) => { if (e.kind === "vehicle.hit" && e.vehicle === red) zones.push(e.zone); });
    expect(zones.length).toBeGreaterThan(0);
    expect(zones.every((z) => z === "turret")).toBe(true);
  });
});

describe("rockets and loads", () => {
  it("rockets are never thrown or lobbed as grenades, whatever else the man carries", () => {
    const sim = createSim(duel(data, ["ru", "de"], { blue: { x: 1000, y: 600, heading: 0 }, red: { x: 2000, y: 1000, heading: 0 }, redSquadAt: { x: 1100, y: 600, spacing: 3 } }));
    holdAll(sim);
    const cat = sim.ctx.catalog;
    const rocket = (ammo: string) => cat.ammo[ammo]?.delivery?.method === "direct";
    const carriers = [...sim.state.identity.keys()].filter((id) => sim.state.container.get(id)?.stacks.some((s) => rocket(s.type)));
    expect(carriers.length).toBeGreaterThan(0);
    for (const id of carriers) {
      const t = sim.state.transform.req(id);
      for (const d of [8, 20, 35, 80, 150, 300]) expect(rocket(grenadeOption(sim.ctx, sim.state, id, t.x + d, t.y)?.ammo ?? "")).toBe(false);
      // Without any grenade left he has nothing to send, though he still carries rockets.
      const c = sim.state.container.req(id);
      for (const s of [...c.stacks]) if (!rocket(s.type) && cat.ammo[s.type]?.delivery !== undefined) removeItems(c, s.type, s.count);
      for (const d of [20, 80, 150]) expect(grenadeOption(sim.ctx, sim.state, id, t.x + d, t.y)).toBeNull();
    }
    // Ordered to throw, the men with rockets only throw nothing.
    const gunner = carriers[0]!;
    const t = sim.state.transform.req(gunner);
    let launched = 0;
    submitOrder(sim, { tick: sim.state.tick, issuer: sim.state.identity.req(gunner).side, target: gunner, kind: "grenade", x: t.x + 25, y: t.y });
    run(sim, 10, (e) => { if (e.kind === "grenade.launched" && rocket(e.ammo)) launched++; });
    expect(launched).toBe(0);
  });

  it("with the anti-tank weapons split among the men, every man of the platoons on foot carries 22-45 kg", () => {
    for (const name of ["platoon", "platoon-ru"]) {
      const sc = getScenario(name);
      const sim = createSim(sc.build(data, 1, 60));
      let men = 0;
      for (const [id, s] of sim.state.soldier.entries()) {
        if (s.mount !== undefined) continue;
        const kg = loadKg(sim.ctx, sim.state, id);
        expect(kg, `${name} ${sim.state.identity.req(id).role}`).toBeGreaterThan(22);
        expect(kg, `${name} ${sim.state.identity.req(id).role}`).toBeLessThan(45);
        men++;
      }
      expect(men).toBeGreaterThan(20);
    }
  });
});
