/** M9.4a: the reconnaissance quadcopter — an item launched into an entity, a busy operator, the battery, the feed
 *  over the radio, save and load in the air, landing and recovery, a lost operator; the drone lab's rows. */
import { describe, expect, it } from "vitest";
import { buildCatalog } from "@tcs/data";
import { buildScenario } from "@tcs/scenario";
import { commanderController } from "@tcs/ai";
import { countItems, createSim, droneHitChance, hashState, loadSim, runBattle, saveSim, step, submitOrder, type Sim, type SimEvent } from "@tcs/sim";
import { droneLab, droneLabBattle } from "../src/labs/drone";
import { loadData } from "../src/scenarios";

const data = loadData();
const cat = buildCatalog(data, ["de", "ru"]);
function run(sim: Sim, seconds: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let k = 0; k < seconds * 60; k++) out.push(...step(sim));
  return out;
}
function lab(seed = 1) {
  const input = droneLabBattle(cat, { name: "t", altM: 100, posture: "standing" }, seed, 4000);
  const sim = createSim(input);
  const ids = [...sim.state.identity.entries()];
  return { input, sim, op: ids.find(([, i]) => i.side === "blue")![0], tgt: ids.find(([, i]) => i.side === "red")![0] };
}
const charge = (sim: Sim, id: number) => sim.state.container.get(id)?.stacks.find((s) => s.type === "de-drone-battery")?.charge ?? 0;

describe("reconnaissance quadcopter (M9.4a)", () => {
  it("launch: the airframe and a battery leave his load for the drone's; he is busy flying it; it climbs and flies out", () => {
    const { sim, op } = lab();
    submitOrder(sim, { tick: 0, issuer: "red", target: [...sim.state.unit.keys()].find((u) => sim.state.unit.get(u)!.side === "red")!, kind: "rules", fire: "hold" });
    submitOrder(sim, { tick: 0, issuer: "blue", target: op, kind: "drone", op: "fly", x: 400, y: 120, altM: 100 });
    const def = cat.items["de-quadcopter"]!.drone!;
    const ev = run(sim, def.launchSeconds + 2);
    const up = ev.find((e) => e.kind === "drone.launched");
    expect(up).toBeDefined();
    const id = (up as Extract<SimEvent, { kind: "drone.launched" }>).drone;
    expect(countItems(sim.state.container.req(op), "de-quadcopter")).toBe(0);
    expect(countItems(sim.state.container.req(op), "de-drone-battery")).toBe(0);
    expect(countItems(sim.state.container.req(id), "de-quadcopter")).toBe(1);
    expect(sim.state.action.get(op)?.kind).toBe("flyDrone");
    const c0 = charge(sim, id);
    run(sim, 60);
    const t = sim.state.transform.req(id);
    expect(t.z).toBe(100);
    expect(t.x).toBeGreaterThan(300);
    expect(charge(sim, id)).toBeCloseTo(c0 - (def.powerW * 60) / 3600, 1);
    // Ordered home: it lands with him and goes back into his load, the battery with what is left.
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: op, kind: "drone", op: "home" });
    const ev2 = run(sim, 120);
    expect(ev2.some((e) => e.kind === "drone.landed")).toBe(true);
    expect(sim.state.drone.size).toBe(0);
    expect(sim.state.transform.has(id)).toBe(false);
    expect(countItems(sim.state.container.req(op), "de-quadcopter")).toBe(1);
    const b = sim.state.container.req(op).stacks.find((s) => s.type === "de-drone-battery")!;
    expect(b.charge!).toBeLessThan(c0);
    expect(sim.state.action.has(op)).toBe(false);
  });

  it("save and load with the drone in the air: the battle goes on identically", () => {
    const { input, sim, op } = lab(3);
    submitOrder(sim, { tick: 0, issuer: "blue", target: op, kind: "drone", op: "fly", x: 400, y: 200 });
    run(sim, 100);
    expect(sim.state.drone.size).toBe(1);
    const copy = loadSim({ ...input, orders: [] }, saveSim(sim));
    expect(hashState(copy.state)).toBe(hashState(sim.state));
    run(sim, 60); run(copy, 60);
    expect(hashState(copy.state)).toBe(hashState(sim.state));
  });

  it("the feed: the operator knows at once what the camera sees; his comrades by radio after the usual delay", () => {
    const input = buildScenario(data, { kind: "platoon-attack", seed: 1, mapKind: "village", factions: ["de", "ru"], attacker: "blue", timeLimitSeconds: 900 });
    const sim = createSim(input);
    const top = [...sim.state.unit.entries()].find(([, u]) => u.side === "blue" && u.parent === null)![0];
    const obj = input.rules.objectives[0]!;
    submitOrder(sim, { tick: 0, issuer: "blue", target: top, kind: "drone", op: "fly", x: obj.x, y: obj.y });
    let first: Extract<SimEvent, { kind: "spotted" }> | undefined;
    for (let k = 0; k < 600 * 60 && !first; k++) for (const e of step(sim)) if (e.kind === "spotted" && e.drone === true) first = e;
    expect(first).toBeDefined();
    const d = sim.state.drone.req(first!.observer);
    const opC = sim.state.soldier.req(d.operator!).contacts.find((c) => c.target === first!.target);
    expect(opC?.kind).toBe("reported");
    // The men near him by voice; those of the squads far away by radio, after the usual delay.
    const reps = sim.state.contactReports.filter((r) => r.contact.target === first!.target && r.from === d.operator);
    expect(reps.length).toBeGreaterThan(10);
    const latest = Math.max(...reps.map((r) => r.deliverTick)) - sim.state.tick;
    expect(latest).toBeGreaterThanOrEqual(Math.round(input.rules.comms.contactShareDelaySeconds * 60));
  });

  it("its operator hit: nobody near takes it over, so it comes home on its own and, with nobody there, is lost", () => {
    const { sim, op } = lab(5);
    submitOrder(sim, { tick: 0, issuer: "blue", target: op, kind: "drone", op: "fly", x: 300, y: 200 });
    run(sim, 90);
    const id = [...sim.state.drone.keys()][0]!;
    sim.state.soldier.req(op).physiology.alive = false;
    const ev = run(sim, 150);
    expect(sim.state.drone.has(id)).toBe(false);
    expect(ev.find((e) => e.kind === "drone.lost")).toMatchObject({ reason: "noOperator" });
  });

  it("a unit without a drone cannot be given the order", () => {
    const { sim, tgt } = lab();
    const ev = (submitOrder(sim, { tick: 0, issuer: "red", target: tgt, kind: "drone", op: "fly", x: 50, y: 50 }), run(sim, 2));
    expect(ev.some((e) => e.kind === "order.rejected")).toBe(true);
  });
});

describe("drone lab (M9.4a)", () => {
  const r = droneLab(data, 10);
  const row = (name: string, alt: number, night = false) => r.rows.find((x) => x.name === name && x.altM === alt && (x.night === true) === night)!;
  it("a man still in the open is picked out within a minute; under woodland by day rarely; the thermal camera finds him there at night", () => {
    expect(row("standing, still, open", 100).within60).toBeGreaterThanOrEqual(8);
    expect(row("prone, still, in woodland", 100).within60).toBeLessThanOrEqual(4);
    expect(row("prone, still, in woodland", 100, true).within60).toBeGreaterThan(row("prone, still, in woodland", 100).within60);
    expect(r.endurance.recovered).toBe(true);
    expect(r.endurance.upMinutes).toBeGreaterThan(15);
  });
});

describe("counter-drone and AI use (M9.4b)", () => {
  it("a man free to fire sees a drone overhead, fires at it, and never takes it for a contact", () => {
    const input = droneLabBattle(cat, { name: "c", altM: 80, posture: "standing" }, 7, 900);
    const sim = createSim(input);
    const ids = [...sim.state.identity.entries()];
    const op = ids.find(([, i]) => i.side === "blue")![0], tid = ids.find(([, i]) => i.side === "red")![0];
    const ru = [...sim.state.unit.keys()].find((u) => sim.state.unit.get(u)!.side === "red")!;
    submitOrder(sim, { tick: 0, issuer: "red", target: ru, kind: "rules", fire: "free", maxEngageM: 200 });
    submitOrder(sim, { tick: 0, issuer: "blue", target: op, kind: "drone", op: "fly", x: 400, y: 200, altM: 80 });
    let fired = false, overhead = false;
    for (let k = 0; k < 300 * 60 && !fired; k++) for (const e of step(sim)) {
      if (e.kind === "radio" && e.key === "radio.droneOverhead") overhead = true;
      if (e.kind === "shot.fired" && e.shooter === tid) { const ft = sim.state.fire.get(tid); if (ft?.contact !== undefined && sim.state.drone.has(ft.contact)) fired = true; }
    }
    expect(fired).toBe(true);
    expect(overhead).toBe(true);
    const s = sim.state.soldier.req(tid);
    expect(s.contacts.some((c) => sim.state.drone.has(c.target))).toBe(false);
  });

  it("the hit chance falls with range and with the drone moving", () => {
    const { sim, op } = lab(9);
    submitOrder(sim, { tick: 0, issuer: "blue", target: op, kind: "drone", op: "fly", x: 400, y: 200, altM: 100 });
    run(sim, 150);
    const id = [...sim.state.drone.keys()][0]!;
    const t = sim.state.transform.req(id);
    const at = (dx: number) => droneHitChance(sim.ctx, sim.state, id, t.x + dx, t.y, 1.5, t.x, t.y, t.z, 0.002, 900);
    expect(at(0)).toBeGreaterThan(at(150));
    expect(at(0)).toBeLessThanOrEqual(cat.spotting.drone!.maxHitChance);
    const still = at(50);
    sim.state.drone.req(id).mode = "fly";
    expect(at(50)).toBeLessThan(still);
  });

  it("the AI commander keeps its platoons' drones up", () => {
    const input = buildScenario(data, { kind: "platoon-attack", seed: 2, mapKind: "village", factions: ["de", "ru"], attacker: "blue", timeLimitSeconds: 300 });
    const ups = new Set<string>();
    runBattle(input, { controllers: [commanderController("blue", input), commanderController("red", input)], onEvents: (es) => { for (const e of es) if (e.kind === "drone.launched") ups.add(e.side); } });
    expect([...ups].sort()).toEqual(["blue", "red"]);
  });

  it("lab: low and close drones come down, one that keeps its standoff does not", () => {
    const rows = droneLab(data, 8).counter;
    const row = (name: string, alt: number, off: number) => rows.find((x) => x.name === name && x.altM === alt && x.offsetM === off)!;
    expect(row("one rifleman", 50, 0).down).toBeGreaterThan(row("one rifleman", 150, 0).down);
    expect(row("four riflemen", 120, 220).down).toBe(0);
    expect(row("four riflemen", 100, 0).seen60).toBeGreaterThanOrEqual(6);
  });
});
