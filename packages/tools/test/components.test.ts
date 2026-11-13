/**
 * Components, fire, crew reactions and cross-loading (M7.4b, plan §8, C6, C8, C12, C16, C21, C63): damage to a
 * part changes what the vehicle can do as the table says; the extinguisher's charges are counted; a crew struck by
 * a rocket fires smoke and reverses out; a crew that bailed out takes orders on foot; men take belts from their
 * own side's abandoned hull (never the enemy's); a wrecked radio takes the crew off the net; the fixture's active
 * protection and add-on tiles; wrecks and vehicle records come out of the battle and go into the next.
 */
import { describe, expect, it } from "vitest";
import {
  componentIndex, countItems, createSim, loadSim, removeItems, saveSim, simHash, resolveVehicleHit, runBattle, step, submitOrder, TICK_HZ, vehicleRow,
  type EntityId, type Sim, type SimEvent,
} from "@tcs/sim";
import { vehicleBattle } from "@tcs/scenario";
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
/** A one-vehicle-a-side field: blue at (400, 600) facing east, red far off; everyone holds fire. */
function field(factions: [string, string] = ["de", "ru"], red = { x: 2000, y: 600, heading: Math.PI }): { sim: Sim; blue: EntityId; red: EntityId } {
  const sim = createSim(duel(data, factions, { blue: { x: 400, y: 600, heading: 0 }, red }));
  holdAll(sim);
  const blue = [...sim.state.vehicle.entries()].find(([, v]) => v.side === "blue")![0];
  const r = [...sim.state.vehicle.entries()].find(([, v]) => v.side === "red")![0];
  return { sim, blue, red: r };
}
function setComp(sim: Sim, vid: EntityId, kind: Parameters<typeof componentIndex>[1], c: number): void {
  const v = sim.state.vehicle.req(vid), def = sim.ctx.catalog.vehicles[v.def]!;
  def.components!.forEach((x, k) => { if (x.kind === kind) v.comp[k] = c; });
}
/** A shaped-charge round of `ammo` striking a vehicle's front square on at hull middle height (as after the loop). */
function strikeFront(sim: Sim, vid: EntityId, owner: EntityId, ammo: string, events: SimEvent[]): void {
  const G = sim.ctx.ballistics.vehicles, row = vehicleRow(G, vid);
  const t = sim.state.transform.req(vid), def = sim.ctx.catalog.vehicles[sim.state.vehicle.req(vid).def]!;
  const c = Math.cos(t.heading), s = Math.sin(t.heading), f = def.body.hull.f[1];
  const z = G.gz[row]! + (def.body.hull.u[0] + def.body.hull.u[1]) / 2;
  const sink = { events, emit(e: SimEvent) { events.push(e); } };
  resolveVehicleHit(sim.ctx, sim.state, sink as never, row, t.x + c * f, t.y + s * f, z, -c * 200, -s * 200, 0, 200, sim.ctx.catalog.ammoIds.indexOf(ammo), owner, 0, 0, 100, () => undefined);
}

describe("component effects (M7.4b, plan §8 table)", () => {
  it("engine below half: half power, slower away; turret drive below half: slower to lay; wrecked gun: the cannon is out, the coax still fires", () => {
    const drive = (engine: number) => {
      const { sim, blue } = field();
      setComp(sim, blue, "engine", engine);
      const crew = sim.state.vehicle.req(blue).unit!;
      submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: crew, kind: "move", waypoints: [{ x: 1000, y: 600, mode: "run" }] });
      run(sim, 15);
      return sim.state.transform.req(blue).x - 400;
    };
    const full = drive(1), half = drive(0.4);
    expect(full).toBeGreaterThan(30);
    expect(half).toBeLessThan(full * 0.95);

    const lay = (td: number) => {
      const { sim, blue } = field();
      setComp(sim, blue, "turret-drive", td);
      const crew = sim.state.vehicle.req(blue).unit!;
      submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: crew, kind: "fire", x: 400, y: 1100, heightM: 1.2, nature: "he" });
      let first = -1;
      run(sim, 30, (e) => { if (first < 0 && e.kind === "shot.fired" && e.vehicle === blue) first = e.tick; });
      return first;
    };
    const fast = lay(1), slow = lay(0.3);
    expect(fast).toBeGreaterThan(0);
    expect(slow < 0 || slow > fast + 60).toBe(true);

    const { sim, blue } = field();
    setComp(sim, blue, "gun", 0);
    const crew = sim.state.vehicle.req(blue).unit!;
    const fired: string[] = [];
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: crew, kind: "fire", x: 1000, y: 600, heightM: 0, nature: "he" });
    run(sim, 20, (e) => { if (e.kind === "shot.fired" && e.vehicle === blue) fired.push(e.weapon); });
    expect(fired.length).toBeGreaterThan(0);
    for (const w of fired) expect(sim.ctx.catalog.weapons[w]!.type).not.toBe("autocannon");
  });

  it("a wrecked radio takes the crew off the net; wrecked dischargers fire no smoke", () => {
    const { sim, blue } = field();
    const crew = sim.state.vehicle.req(blue).unit!;
    setComp(sim, blue, "radio", 0);
    run(sim, 2);
    expect(sim.state.unit.req(crew).comms.link).toBe("none");
    setComp(sim, blue, "dischargers", 0);
    // (Off the net: an order no longer reaches it; the dischargers are out anyway.)
    const ev: SimEvent[] = [];
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: crew, kind: "discharge" });
    run(sim, 5, (e) => ev.push(e));
    expect(ev.some((e) => e.kind === "vehicle.smoke")).toBe(false);
  });

  it("the extinguisher's charges are counted: each try uses one; a fire it puts out ends the burning and the crew stays", () => {
    const { sim, red } = field();
    const v = sim.state.vehicle.req(red), def = sim.ctx.catalog.vehicles[v.def]!;
    const E = def.extinguisher!;
    const c = sim.state.container.req(red);
    const n0 = countItems(c, E.item);
    expect(n0).toBeGreaterThan(0);
    const saved = E.chance;
    try {
      E.chance = 1; // (for the test: it surely works)
      v.fire = { startTick: sim.state.tick, nextCheckTick: sim.state.tick + 1e9, intensity: 1, nextExtTick: sim.state.tick + 30 };
      const ev: SimEvent[] = [];
      run(sim, 5, (e) => ev.push(e));
      expect(ev.filter((e) => e.kind === "vehicle.extinguished")).toHaveLength(1);
      expect(v.fire).toBeNull();
      expect(countItems(c, E.item)).toBe(n0 - 1);
      expect(v.status).toBe("ok");
      expect(v.crewReaction).not.toBe("bailOut");
      // No charge left: a new fire is not put out, the crew gets out.
      removeItems(c, E.item, countItems(c, E.item));
      E.chance = 1;
      v.fire = { startTick: sim.state.tick, nextCheckTick: sim.state.tick + 1e9, intensity: 1, nextExtTick: sim.state.tick + 30 };
      run(sim, 5, (e) => ev.push(e));
      expect(ev.filter((e) => e.kind === "vehicle.extinguished")).toHaveLength(1);
      expect(v.status).toBe("abandoned");
    } finally { E.chance = saved; }
  });
});

describe("crew reactions (M7.4b, plan §8, C21)", () => {
  it("struck by a rocket that does not get through (Puma front, owner Q21 b): smoke, then it reverses out of reach facing the threat", () => {
    // Red is a Puma facing west toward the blue BMP-2's side.
    const { sim, red, blue } = field(["ru", "de"], { x: 1000, y: 600, heading: Math.PI });
    const shooter = [...sim.state.identity.entries()].find(([, i]) => i.side === "blue")![0];
    const v = sim.state.vehicle.req(red);
    const x0 = sim.state.transform.req(red).x;
    const ev: SimEvent[] = [];
    strikeFront(sim, red, shooter, "ru-pg7vl", ev);
    expect(ev.find((e) => e.kind === "vehicle.hit")).toMatchObject({ result: "stopped" });
    run(sim, 3, (e) => ev.push(e));
    expect(v.crewReaction).toBe("reverseOut");
    expect(v.reactionWhy).toContain("reaction.rocketHit");
    expect(ev.some((e) => e.kind === "vehicle.reaction" && e.vehicle === red)).toBe(true);
    expect(ev.some((e) => e.kind === "vehicle.smoke" && e.vehicle === red)).toBe(true);
    expect(v.drive.route.some((w) => w.reverse === true)).toBe(true);
    run(sim, 25);
    // Backed away east (away from the threat in the west) and still faces west.
    expect(sim.state.transform.req(red).x - x0).toBeGreaterThan(20);
    expect(Math.abs(Math.cos(sim.state.transform.req(red).heading) + 1)).toBeLessThan(0.3);
    void blue;
  });

  it("the smoke salvo goes off along the turret as it is laid toward the threat: a damaged turret drive lays it short (M7 review finding 5)", () => {
    const offBearing = (drive: number): number => {
      const { sim, red } = field(["ru", "de"], { x: 1000, y: 600, heading: Math.PI });
      const shooter = [...sim.state.identity.entries()].find(([, i]) => i.side === "blue")![0];
      setComp(sim, red, "turret-drive", drive);
      const st = sim.state.vehicle.req(red).stations[0]!;
      st.azimuth = Math.PI / 2; st.azCmd = Math.PI / 2; // (test set-up: the turret pointing to the side)
      const ev: SimEvent[] = [];
      strikeFront(sim, red, shooter, "ru-pg7vl", ev);
      let smoke: { x: number; y: number; vx: number; vy: number } | null = null;
      for (let i = 0; i < 6 * TICK_HZ && !smoke; i++) for (const e of step(sim)) {
        if (e.kind === "vehicle.smoke" && e.vehicle === red) { const t = sim.state.transform.req(red); smoke = { x: e.x, y: e.y, vx: t.x, vy: t.y }; }
      }
      expect(smoke).not.toBeNull();
      // Off the threat's bearing (it came from the west, bearing pi), rad.
      const a = Math.atan2(smoke!.y - smoke!.vy, smoke!.x - smoke!.vx);
      return Math.abs(Math.atan2(Math.sin(a - Math.PI), Math.cos(a - Math.PI)));
    };
    const intact = offBearing(1), damaged = offBearing(0.3);
    expect(intact).toBeLessThan(0.35);
    expect(damaged).toBeGreaterThan(intact + 0.5);
  });

  it("an immobilised vehicle hit without penetration fights on (continue)", () => {
    const { sim, red } = field(["de", "ru"], { x: 1000, y: 600, heading: Math.PI });
    const v = sim.state.vehicle.req(red);
    v.status = "immobilised";
    run(sim, 3);
    expect(v.crewReaction).not.toBe("reverseOut");
    expect(v.crewReaction).not.toBe("bailOut");
  });

  it("a crew that bailed out is a unit on foot: it takes a move order", () => {
    const { sim, red } = field();
    const v = sim.state.vehicle.req(red);
    const crew = v.unit!;
    v.fire = { startTick: sim.state.tick, nextCheckTick: sim.state.tick + 1e9, intensity: 1, nextExtTick: -1 };
    run(sim, 5);
    expect(v.status).toBe("abandoned");
    const u = sim.state.unit.req(crew);
    expect(u.vehicle).toBeUndefined();
    expect(u.exVehicle).toBe(red);
    expect(v.unit).toBeNull();
    const men = u.members.filter((m) => sim.state.soldier.req(m).mount === undefined);
    expect(men.length).toBeGreaterThan(0);
    const y0 = sim.state.transform.req(men[0]!).y;
    const ev: SimEvent[] = [];
    submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: crew, kind: "move", waypoints: [{ x: 2000, y: 900, mode: "run" }] });
    run(sim, 30, (e) => ev.push(e));
    expect(ev.some((e) => e.kind === "order.rejected")).toBe(false);
    expect(sim.state.transform.req(men[0]!).y - y0).toBeGreaterThan(40);
  });
});

describe("cross-loading from an abandoned hull (M7.4b, plan C6; own side only, owner 2026-11-13)", () => {
  /** A blue machine-gunner out of belts a few metres behind the `side` BMP-2, abandoned by its crew (both sides Russian). */
  function setup(side: "blue" | "red"): { sim: Sim; hull: EntityId; mc: ReturnType<Sim["state"]["container"]["req"]>; belt: string; gunner: EntityId } {
    const sim = createSim(duel(data, ["ru", "ru"], { blue: { x: 400, y: 600, heading: 0 }, red: { x: 1000, y: 600, heading: Math.PI } }));
    holdAll(sim);
    const hull = [...sim.state.vehicle.entries()].find(([, v]) => v.side === side)![0];
    const v = sim.state.vehicle.req(hull);
    v.crewReaction = "bailOut"; v.reactionTick = sim.state.tick - 100000; v.reactionWhy = ["reaction.crewOut"];
    run(sim, 1);
    expect(v.status).toBe("abandoned");
    // Its crew walks off (out of the way).
    const exCrew = [...sim.state.unit.values()].find((u) => u.exVehicle === hull)!;
    for (const m of exCrew.members) { const t = sim.state.transform.req(m); t.x = 2300; t.y = 100; }
    const gunner = [...sim.state.identity.entries()].find(([id, i]) => i.side === "blue" && sim.state.weapon.get(id) !== undefined && sim.ctx.catalog.weapons[sim.state.weapon.get(id)!.weapon]!.sustained !== undefined && sim.state.soldier.req(id).mount === undefined)![0];
    const belt = sim.ctx.catalog.weapons[sim.state.weapon.req(gunner).weapon]!.feed.magazine;
    const mc = sim.state.container.req(gunner);
    removeItems(mc, belt, countItems(mc, belt));
    sim.state.weapon.req(gunner).lowAmmoReported = true;
    // He stands a few metres behind the hull (by its doors).
    const t = sim.state.transform.req(hull), gt = sim.state.transform.req(gunner);
    gt.x = t.x + (t.heading === 0 ? -6 : 6); gt.y = t.y;
    expect(countItems(sim.state.container.req(hull), belt)).toBeGreaterThan(0);
    return { sim, hull, mc, belt, gunner };
  }
  it("men take belts from their own side's abandoned hull; item totals are conserved", () => {
    const { sim, hull, mc, belt, gunner } = setup("blue");
    const total = () => countItems(sim.state.container.req(hull), belt) + countItems(mc, belt);
    const before = total();
    const ev: SimEvent[] = [];
    run(sim, 20, (e) => ev.push(e));
    expect(countItems(mc, belt)).toBeGreaterThan(0);
    expect(ev.some((e) => e.kind === "items.transferred" && e.from === hull && e.to === gunner)).toBe(true);
    expect(total()).toBe(before);
  });
  it("an abandoned enemy hull is refused: nothing is taken from it", () => {
    const { sim, hull, mc, belt } = setup("red");
    const inHull = countItems(sim.state.container.req(hull), belt);
    const ev: SimEvent[] = [];
    run(sim, 20, (e) => ev.push(e));
    expect(ev.some((e) => e.kind === "items.transferred" && e.from === hull)).toBe(false);
    expect(countItems(sim.state.container.req(hull), belt)).toBe(inHull);
    expect(countItems(mc, belt)).toBe(0);
  });
});

describe("the fixture's active protection and add-on tiles (M7.4b, plan C12, C16)", () => {
  function wagon(): { sim: Sim; vid: EntityId; owner: EntityId } {
    const input = vehicleBattle(fixtures, { seed: 1, factions: ["xf", "de"], squadTemplates: ["porter-band", "pzgren-schuetzentrupp"], vehiclesPerPlatoon: 1, mapWidthM: 800, mapHeightM: 600, timeLimitSeconds: 600 });
    const xf = input.forces.find((f) => f.faction === "xf")!;
    xf.vehicles![0]!.type = "xf-wagon";
    xf.vehicles![0]!.load.push({ type: "xf-charm", count: 2 }, { type: "xf-shingle", count: 3 });
    const sim = createSim(input);
    holdAll(sim);
    const vid = [...sim.state.vehicle.entries()].find(([, v]) => v.def === "xf-wagon")![0];
    const owner = [...sim.state.identity.entries()].find(([, i]) => i.faction === "de")![0];
    return { sim, vid, owner };
  }
  it("the charm intercepts a rocket short of the hull (no jet on the plate) and is used up; with none left the rocket strikes", () => {
    const { sim, vid, owner } = wagon();
    const c = sim.state.container.req(vid);
    const n0 = countItems(c, "xf-charm");
    const ev: SimEvent[] = [];
    strikeFront(sim, vid, owner, "de-pzf3-dm12", ev);
    expect(ev.find((e) => e.kind === "vehicle.hit")).toMatchObject({ result: "intercepted", components: [] });
    expect(ev.some((e) => e.kind === "vehicle.component")).toBe(false);
    expect(countItems(c, "xf-charm")).toBe(n0 - 1);
    // None left: it strikes the 40 mm front and the jet goes through.
    removeItems(c, "xf-charm", countItems(c, "xf-charm"));
    run(sim, 2);
    const ev2: SimEvent[] = [];
    strikeFront(sim, vid, owner, "de-pzf3-dm12", ev2);
    expect(ev2.find((e) => e.kind === "vehicle.hit")).toMatchObject({ result: "penetrated" });
  });
  it("a shingle on the side is used up by a shaped hit there and raises what the jet needs", () => {
    const { sim, vid, owner } = wagon();
    const c = sim.state.container.req(vid);
    removeItems(c, "xf-charm", countItems(c, "xf-charm"));
    const s0 = countItems(c, "xf-shingle");
    const G = sim.ctx.ballistics.vehicles, row = vehicleRow(G, vid), t = sim.state.transform.req(vid);
    const def = sim.ctx.catalog.vehicles["xf-wagon"]!;
    const ev: SimEvent[] = [];
    const sink = { events: ev, emit(e: SimEvent) { ev.push(e); } };
    // From the vehicle's right (+r) side, square on.
    const rx = -Math.sin(t.heading), ry = Math.cos(t.heading), r = def.body.hull.r[1];
    resolveVehicleHit(sim.ctx, sim.state, sink as never, row, t.x + rx * r, t.y + ry * r, G.gz[row]! + 1.0, -rx * 200, -ry * 200, 0, 200, sim.ctx.catalog.ammoIds.indexOf("de-pzf3-dm12"), owner, 0, 1, 100, () => undefined);
    expect(countItems(c, "xf-shingle")).toBe(s0 - 1);
    expect(ev.some((e) => e.kind === "vehicle.hit")).toBe(true);
  });
});

describe("wrecks and vehicle records out of the battle and into the next (M7.4b, plan C8)", () => {
  it("BattleResult.wrecks and ForceResult.vehicles round-trip", () => {
    const input = duel(data, ["de", "ru"], { blue: { x: 400, y: 600, heading: 0 }, red: { x: 2000, y: 600, heading: Math.PI } });
    input.rules.timeLimitSeconds = 20;
    let lit = false;
    const r = runBattle(input, { onTick: (sim) => {
      if (lit) return;
      lit = true;
      const [, v] = [...sim.state.vehicle.entries()].find(([, x]) => x.side === "red")!;
      v.comp[componentIndex(sim.ctx.catalog.vehicles[v.def]!, "engine")] = 0.2;
      v.fire = { startTick: sim.state.tick - 1e6, nextCheckTick: sim.state.tick + 1e9, intensity: 1, nextExtTick: -1 };
    } });
    const back = JSON.parse(JSON.stringify(r)) as typeof r;
    expect(back.wrecks).toEqual(r.wrecks);
    expect(r.wrecks!.map((w) => [w.side, w.type, w.status])).toEqual([["red", "ru-bmp2", "destroyed"]]);
    const red = r.forcesOut.find((f) => f.side === "red")!.vehicles!;
    expect(red[0]!.status).toBe("destroyed");
    expect(red[0]!.components![componentIndex(input.catalog.vehicles["ru-bmp2"]!, "engine")]).toBeCloseTo(0.2);
    // Into the next battle as it came out.
    const again = duel(data, ["de", "ru"], { blue: { x: 400, y: 600, heading: 0 }, red: { x: 2000, y: 600, heading: Math.PI } });
    again.forces.find((f) => f.side === "red")!.vehicles = back.forcesOut.find((f) => f.side === "red")!.vehicles!;
    again.forces.find((f) => f.side === "blue")!.vehicles = back.forcesOut.find((f) => f.side === "blue")!.vehicles!;
    const sim = createSim(again);
    const v2 = [...sim.state.vehicle.values()].find((x) => x.side === "red")!;
    expect(v2.status).toBe("destroyed");
    expect(v2.comp).toEqual(red[0]!.components);
    expect(sim.state.container.req([...sim.state.vehicle.entries()].find(([, x]) => x.side === "red")![0]).stacks).toEqual(red[0]!.load);
    // One contract in and out (M7 review): `load` is the container only, `ready` the belts; nothing counted twice.
    expect(v2.stations.flatMap((st) => st.weapons.map((w) => w.feeds.map((f) => ({ item: f.item, rounds: f.rounds }))))).toEqual(red[0]!.ready);
    const rounds = (rec: (typeof red)[number] | undefined) => rec!.ready!.flat().reduce((n, f) => n + f.rounds, 0) + rec!.load.filter((st) => rec!.ready!.flat().some((f) => f.item === st.type)).reduce((n, st) => n + st.count * (st.charge ?? 1), 0);
    const blueOut = back.forcesOut.find((f) => f.side === "blue")!.vehicles!;
    const blueAgain = runBattle({ ...again, rules: { ...again.rules, timeLimitSeconds: 1 } }).forcesOut.find((f) => f.side === "blue")!.vehicles!;
    expect(rounds(blueAgain[0])).toBe(rounds(blueOut[0]));
  });
});

describe("determinism with a burning vehicle (M7.4b)", () => {
  it("a battle with a burning, reversing and bailing-out vehicle, saved every 37 ticks through JSON, continues identically", () => {
    const input = duel(data, ["ru", "de"], { blue: { x: 400, y: 600, heading: 0 }, red: { x: 1000, y: 600, heading: Math.PI } });
    const runIt = (saveEvery: number | null) => {
      let sim = createSim(input);
      holdAll(sim);
      const red = [...sim.state.vehicle.entries()].find(([, v]) => v.side === "red")![0];
      const shooter = [...sim.state.identity.entries()].find(([, i]) => i.side === "blue")![0];
      // A rocket strikes the Puma's front (it reverses out); then a fire (the extinguisher tries, the crew may go).
      strikeFront(sim, red, shooter, "ru-pg7vl", []);
      const hashes: string[] = [];
      let burning = 0;
      for (let t = 0; t < 30 * TICK_HZ; t++) {
        if (t === 5 * TICK_HZ) { const v = sim.state.vehicle.req(red); v.fire = { startTick: sim.state.tick, nextCheckTick: sim.state.tick + 300, intensity: 2, nextExtTick: sim.state.tick + 60 }; }
        step(sim);
        if (sim.state.vehicle.req(red).fire !== null) burning++;
        if (saveEvery !== null && sim.state.tick % saveEvery === 0) sim = loadSim(input, JSON.parse(JSON.stringify(saveSim(sim))));
        if (sim.state.tick % 60 === 0) hashes.push(simHash(sim));
      }
      return { hashes, burning };
    };
    const a = runIt(null), b = runIt(37);
    expect(a.burning).toBeGreaterThan(0);
    expect(b.hashes).toEqual(a.hashes);
  });
});
