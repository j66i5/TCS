/** M2.4: grenades, bursts, fragments, blast, roofs, terrain damage (SPEC 6.3, 6.1). */
import { describe, expect, it } from "vitest";
import {
  createSim, detonate, EventSink, findPath, hashState, launchProjectile, loadSim, navFor, saveSim, secondsToTicks, step, submitOrder,
  type BattleInput, type Sim, type SimEvent,
} from "../src/index";
import { armedInput, testCatalog } from "./helpers";

const unitOf = (sim: Sim, side: string) => [...sim.state.unit.entries()].find(([, u]) => u.side === side)!;
function run(sim: Sim, seconds: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < secondsToTicks(seconds); i++) out.push(...step(sim));
  return out;
}
/** Blue team with hand grenades (and optionally a launcher); red team `gap` metres east of blue. */
function setup(gap: number, opts: { launcher?: boolean; seed?: number; bombs?: number } = {}): BattleInput {
  const input = armedInput(opts.seed ?? 1);
  input.rules.physiologyModel = "simple";
  for (const m of input.forces[0]!.units[0]!.members) {
    if ((opts.bombs ?? 2) > 0) m.load.push({ type: "bomb", count: opts.bombs ?? 2 });
    if (opts.launcher) m.load.push({ type: "tube", count: 1 }, { type: "shell", count: 4 });
  }
  input.forces[1]!.placements = input.forces[1]!.placements.map((p, i) => ({ ...p, x: 10 + gap, y: 12 + i * 3 }));
  return input;
}
const count = (sim: Sim, id: number, type: string) => sim.state.container.req(id).stacks.filter((s) => s.type === type).reduce((n, s) => n + s.count, 0);
const bomb = testCatalog.ammoIds.indexOf("bomb");

describe("throwing a hand grenade", () => {
  it("one man throws; the grenade leaves his load, lands near the point, bursts when the fuse runs out and wounds the enemy", () => {
    const sim = createSim(setup(25));
    const [uid, unit] = unitOf(sim, "blue");
    const before = unit.members.reduce((n, m) => n + count(sim, m, "bomb"), 0);
    submitOrder(sim, { tick: 0, issuer: "blue", target: uid, kind: "grenade", x: 35, y: 13 });
    const ev = run(sim, 12);
    expect(ev.find((e) => e.kind === "radio")).toMatchObject({ key: "radio.ack.grenade" });
    const thrown = ev.filter((e) => e.kind === "grenade.launched");
    expect(thrown).toHaveLength(1);
    expect(unit.members.reduce((n, m) => n + count(sim, m, "bomb"), 0)).toBe(before - 1);
    const ex = ev.filter((e) => e.kind === "explosion");
    expect(ex).toHaveLength(1);
    const e0 = ex[0]!, t0 = thrown[0]!;
    if (e0.kind !== "explosion" || t0.kind !== "grenade.launched") throw new Error("unreachable");
    expect(Math.hypot(e0.x - 35, e0.y - 13)).toBeLessThan(8); // within a few metres of the aim point
    expect((e0.tick - t0.tick) / 60).toBeCloseTo(4, 1); // the 4 s fuse, counted from release
    const red = unitOf(sim, "red")[1].members;
    expect(red.some((m) => sim.state.soldier.req(m).wounds.some((w) => w.mechanism === "fragment"))).toBe(true);
    expect(sim.state.terrain.craters).toHaveLength(1);
    // The throwers, 20+ m away and beyond the blast, are not stunned.
    for (const m of unit.members) expect(sim.state.soldier.req(m).stunnedUntilTick).toBe(0);
  });

  it("throw range depends on posture (about 30 m standing, 11 m prone): out of range is answered 'unable'", () => {
    const far = createSim(setup(25));
    const [uid] = unitOf(far, "blue");
    submitOrder(far, { tick: 0, issuer: "blue", target: uid, kind: "posture", posture: "prone" });
    run(far, 6);
    submitOrder(far, { tick: far.state.tick, issuer: "blue", target: uid, kind: "grenade", x: 35, y: 13 });
    const ev = run(far, 8);
    expect(ev.filter((e) => e.kind === "radio").map((e) => (e.kind === "radio" ? e.key : ""))).toContain("radio.unable");
    expect(ev.some((e) => e.kind === "grenade.launched")).toBe(false);
    // Too close is refused as well (his own fragments).
    const near = createSim(setup(25));
    const [nid] = unitOf(near, "blue");
    submitOrder(near, { tick: 0, issuer: "blue", target: nid, kind: "grenade", x: 14, y: 15 });
    expect(run(near, 5).some((e) => e.kind === "grenade.launched")).toBe(false);
  });

  it("a man who is hit while preparing does not throw, and keeps the grenade", () => {
    const sim = createSim(setup(25));
    const [uid, unit] = unitOf(sim, "blue");
    submitOrder(sim, { tick: 0, issuer: "blue", target: uid, kind: "grenade", x: 35, y: 13 });
    const ev = run(sim, 1.5);
    const started = ev.find((e) => e.kind === "action.started");
    if (!started || started.kind !== "action.started") throw new Error("no action");
    const s = sim.state.soldier.req(started.actor);
    s.physiology.consciousness = 0; // knocked out
    const later = run(sim, 8);
    expect(later.some((e) => e.kind === "grenade.launched")).toBe(false);
    expect(later.some((e) => e.kind === "explosion")).toBe(false);
    expect(count(sim, started.actor, "bomb")).toBe(2);
    expect(unit.members.length).toBe(3);
  });
});

describe("the grenade launcher", () => {
  it("beyond throwing range the man with the launcher fires; the round bursts on impact near the point", () => {
    const sim = createSim(setup(120, { launcher: true }));
    const [uid] = unitOf(sim, "blue");
    submitOrder(sim, { tick: 0, issuer: "blue", target: uid, kind: "grenade", x: 130, y: 14 });
    const ev = run(sim, 14);
    const l = ev.find((e) => e.kind === "grenade.launched");
    expect(l).toMatchObject({ method: "launched", ammo: "shell" });
    const ex = ev.find((e) => e.kind === "explosion");
    if (!ex || ex.kind !== "explosion") throw new Error("no burst");
    expect(Math.hypot(ex.x - 130, ex.y - 14)).toBeLessThan(25);
  });

  it("a round that strikes before it has armed is a dud", () => {
    const sim = createSim(setup(120));
    const shell = "shell";
    // Fired straight into the ground 3 m ahead: 0.04 s of flight, arming needs 0.25 s.
    launchProjectile(sim.ctx, sim.state, shell, 50, 50, 1.4, 70, 0, -35, 0);
    const ev = run(sim, 2);
    expect(ev.some((e) => e.kind === "explosion")).toBe(false);
    expect(ev.find((e) => e.kind === "impact")).toMatchObject({ result: "stopped", ammo: "shell" });
  });
});

describe("bursts", () => {
  const burstAt = (sim: Sim, x: number, y: number, z = 0.05) => { const sink = new EventSink(); detonate(sim.ctx, sim.state, sink, x, y, z, bomb, 0); return sink.events; };

  it("blast by distance: wounded and knocked flat very close, stunned out to about 10 m, untouched beyond (owner decision)", () => {
    const input = setup(100);
    input.forces[1]!.placements = [{ personId: "b.0", x: 101.5, y: 100, heading: 0 }, { personId: "b.1", x: 107, y: 100, heading: 0 }];
    input.forces[0]!.placements = input.forces[0]!.placements.map((p, i) => ({ ...p, x: 100 + 14 + i * 4, y: 100 }));
    const sim = createSim(input);
    sim.ctx.catalog.ballistics.fragments.maxPerBurst = 4000;
    const [near, mid] = unitOf(sim, "red")[1].members as [number, number];
    const farMen = unitOf(sim, "blue")[1].members;
    burstAt(sim, 100, 100);
    const sn = sim.state.soldier.req(near), smid = sim.state.soldier.req(mid);
    expect(sn.wounds.some((w) => w.mechanism === "blast")).toBe(true);
    expect(sn.stunnedUntilTick).toBeGreaterThan(sim.state.tick + 60);
    expect(smid.wounds.some((w) => w.mechanism === "blast")).toBe(false);
    expect(smid.stunnedUntilTick).toBeGreaterThan(sim.state.tick);
    for (const m of farMen) expect(sim.state.soldier.req(m).stunnedUntilTick).toBe(0);
  });

  it("a brick wall between the burst and a man shields him from blast and fragments; a man on the open side is hit", () => {
    const input = setup(100);
    input.map.obstacles.push({ id: 1, kind: "wall", points: [103, 90, 103, 110], heightM: 2, thicknessM: 0.25, material: "brick" });
    input.forces[1]!.placements = [{ personId: "b.0", x: 105, y: 100, heading: Math.PI }, { personId: "b.1", x: 95, y: 100, heading: 0 }];
    const sim = createSim(input);
    const [behind, open] = unitOf(sim, "red")[1].members as [number, number];
    burstAt(sim, 100, 100);
    run(sim, 2);
    expect(sim.state.soldier.req(behind).wounds).toHaveLength(0);
    expect(sim.state.soldier.req(behind).stunnedUntilTick).toBe(0);
    expect(sim.state.soldier.req(open).wounds.length).toBeGreaterThan(0);
  });

  it("the thrower is not immune to his own grenade's fragments", () => {
    const sim = createSim(setup(100));
    const me = unitOf(sim, "blue")[1].members[0]!;
    const t = sim.state.transform.req(me);
    const sink = new EventSink();
    detonate(sim.ctx, sim.state, sink, t.x + 4, t.y, 0.05, bomb, me);
    run(sim, 1);
    expect(sim.state.soldier.req(me).wounds.some((w) => w.mechanism === "fragment")).toBe(true);
  });

  it("fragments fly as projectiles, slow quickly and are gone within seconds; the fight replays identically after a save", () => {
    const sim = createSim(setup(25));
    const [uid] = unitOf(sim, "blue");
    submitOrder(sim, { tick: 0, issuer: "blue", target: uid, kind: "grenade", x: 35, y: 13 });
    let peak = 0, saved: ReturnType<typeof saveSim> | null = null;
    for (let i = 0; i < secondsToTicks(10); i++) {
      const ev = step(sim);
      if (sim.state.projectiles.count > peak) peak = sim.state.projectiles.count;
      if (ev.some((e) => e.kind === "explosion")) saved = JSON.parse(JSON.stringify(saveSim(sim)));
    }
    expect(peak).toBeGreaterThan(500);
    expect(sim.state.projectiles.count).toBe(0);
    expect(saved).not.toBeNull();
    const copy = loadSim(setup(25), saved!);
    while (copy.state.tick < sim.state.tick) step(copy);
    expect(hashState(copy.state)).toBe(hashState(sim.state));
  });
});

describe("roofs and terrain damage", () => {
  it("a roof stops a grenade lobbed onto a house (it bursts on the roof); a solid roof also keeps the fragments out, tiles do not", () => {
    const woundsInside = (roofThicknessM: number) => {
      const input = setup(100);
      input.catalog = { ...input.catalog, terrain: { ...input.catalog.terrain, buildings: { house: { ...input.catalog.terrain.buildings["house"]!, roofThicknessM } } } };
      input.map.buildings.push({ id: 1, kind: "house", footprint: [90, 90, 110, 90, 110, 110, 90, 110], storeys: 1, storeyHeightM: 2.8, wallMaterial: "brick", wallThicknessM: 0.3, openings: [], roofColour: "#8c4a3b" });
      input.forces[1]!.placements = [{ personId: "b.0", x: 100, y: 100, heading: 0 }, { personId: "b.1", x: 150, y: 150, heading: 0 }];
      const sim = createSim(input);
      const inside = unitOf(sim, "red")[1].members[0]!;
      launchProjectile(sim.ctx, sim.state, "bomb", 100.5, 100, 12, 0, 0, -1, 0); // dropping onto the middle of the roof
      const ex = run(sim, 6).find((e) => e.kind === "explosion");
      if (!ex || ex.kind !== "explosion") throw new Error("no burst");
      expect(ex.z).toBeGreaterThan(2.5); // on the roof, not on the floor
      return { sim, n: sim.state.soldier.req(inside).wounds.filter((w) => w.mechanism === "fragment").length };
    };
    expect(woundsInside(0.3).n).toBe(0); // 30 cm of timber-equivalent: nothing comes through
    const tiles = woundsInside(0.06);
    expect(tiles.n).toBeGreaterThan(0); // 6 cm: fragments from the burst overhead come through, slowed
    // A rifle bullet fired steeply down goes through the tiles (a "penetrated" impact).
    launchProjectile(tiles.sim.ctx, tiles.sim.state, "ball", 100.1, 100, 30, 0, 0, -900, 0);
    expect(run(tiles.sim, 1).find((e) => e.kind === "impact" && e.surface === "building")).toMatchObject({ result: "penetrated" });
  });

  it("review fixes: steep fire cannot skip the roof of a small house; an impact round on a roof keeps its fragments", () => {
    const input = setup(100);
    input.catalog = { ...input.catalog, terrain: { ...input.catalog.terrain, buildings: { house: { ...input.catalog.terrain.buildings["house"]!, roofMaterial: "steel", roofThicknessM: 0.05 } } } };
    input.map.buildings.push({ id: 1, kind: "house", footprint: [98, 90, 102, 90, 102, 110, 98, 110], storeys: 1, storeyHeightM: 2.8, wallMaterial: "brick", wallThicknessM: 0.3, openings: [], roofColour: "#8c4a3b" });
    const sim = createSim(input);
    // 45 degrees down across a house only 4 m wide: each bullet's one-tick step starts and ends outside it.
    for (let k = 0; k < 50; k++) launchProjectile(sim.ctx, sim.state, "ball", 88.5 + k * 0.05, 95 + k * 0.2, 12.8, 600, 0, -600, 0);
    const ev = run(sim, 1).filter((e) => e.kind === "impact");
    expect(ev.filter((e) => e.kind === "impact" && e.surface === "building" && e.z > 2.5).length).toBe(50);
    expect(ev.filter((e) => e.kind === "impact" && e.surface === "ground").length).toBe(0);
    // An impact-fuse round bursting on that roof: its fragments fly on (before the fix all were swallowed).
    launchProjectile(sim.ctx, sim.state, "shell", 100, 100, 30, 0, 0, -40, 0);
    let after = -1;
    for (let k = 0; k < 120 && after < 0; k++) if (step(sim).some((e) => e.kind === "explosion")) { step(sim); after = sim.state.projectiles.count; }
    expect(after).toBeGreaterThan(50);
  });

  it("review fixes: a plank fence does not shield from blast; a grenade thrown indoors falls to the floor; one aimed at the map edge still bursts", () => {
    const input = setup(100);
    input.map.obstacles.push({ id: 1, kind: "wall", points: [101, 90, 101, 110], heightM: 1.8, thicknessM: 0.02, material: "wood" });
    input.forces[1]!.placements = [{ personId: "b.0", x: 101.8, y: 100, heading: Math.PI }, { personId: "b.1", x: 150, y: 150, heading: 0 }];
    const sim = createSim(input);
    const man = unitOf(sim, "red")[1].members[0]!;
    detonate(sim.ctx, sim.state, new EventSink(), 100, 100, 0.05, bomb, 0);
    expect(sim.state.soldier.req(man).wounds.some((w) => w.mechanism === "blast")).toBe(true);

    const indoor = setup(100);
    indoor.map.buildings.push({ id: 1, kind: "house", footprint: [5, 5, 65, 5, 65, 35, 5, 35], storeys: 1, storeyHeightM: 2.8, wallMaterial: "brick", wallThicknessM: 0.3, openings: [], roofColour: "#8c4a3b" });
    const s2 = createSim(indoor);
    const [uid] = unitOf(s2, "blue");
    submitOrder(s2, { tick: 0, issuer: "blue", target: uid, kind: "grenade", x: 35, y: 15 });
    const ex = run(s2, 12).find((e) => e.kind === "explosion");
    if (!ex || ex.kind !== "explosion") throw new Error("no burst");
    expect(ex.z).toBeLessThan(0.5); // on the floor, not hanging under the ceiling

    const edge = createSim(setup(100));
    for (let k = 0; k < 10; k++) launchProjectile(edge.ctx, edge.state, "bomb", 6, 50 + k, 1.6, -12, 0, 10, 0);
    expect(run(edge, 6).filter((e) => e.kind === "explosion")).toHaveLength(10);
  });

  it("review fixes: a man ordered to move or lie down while preparing does not throw; fragment wounds are worse close in", () => {
    const sim = createSim(setup(28));
    const [uid, unit] = unitOf(sim, "blue");
    submitOrder(sim, { tick: 0, issuer: "blue", target: uid, kind: "grenade", x: 38, y: 13 });
    run(sim, 1.5);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: uid, kind: "posture", posture: "prone" });
    const ev = run(sim, 10);
    expect(ev.some((e) => e.kind === "grenade.launched")).toBe(false);
    expect(unit.members.reduce((n, m) => n + count(sim, m, "bomb"), 0)).toBe(6);

    const mean = (d: number) => {
      const input = setup(100);
      input.forces[1]!.placements = [{ personId: "b.0", x: 100 + d, y: 100, heading: Math.PI }, { personId: "b.1", x: 100 - d, y: 100, heading: 0 }];
      const s = createSim(input);
      s.ctx.catalog.ballistics.blast.injuryScaledM = 0; // fragments only
      detonate(s.ctx, s.state, new EventSink(), 100, 100, 0.05, bomb, 0);
      run(s, 1);
      const w = unitOf(s, "red")[1].members.flatMap((m) => s.state.soldier.req(m).wounds.filter((x) => x.mechanism === "fragment" && (x.zone.startsWith("leg") || x.zone.startsWith("arm"))));
      return w.reduce((n, x) => n + x.severity, 0) / Math.max(1, w.length);
    };
    expect(mean(1.5)).toBeGreaterThan(mean(8) * 1.2);
  });

  it("a burst next to a thin wooden fence blows a hole that bullets and routes then pass through; a brick wall stands", () => {
    const input = setup(100);
    input.catalog = { ...input.catalog, terrain: { ...input.catalog.terrain, obstacles: { ...input.catalog.terrain.obstacles, fence: { id: "fence", heightM: 1.8, thicknessM: 0.02, material: "wood", seeThrough: 0, footCrossTimeS: null, wheeledCrossable: false, trackedCrossable: true, colour: "#6b5a3c" }, wall: { ...input.catalog.terrain.obstacles["wall"]!, footCrossTimeS: null } } } };
    // A fence right across the map, and a brick wall further east.
    input.map.obstacles.push({ id: 1, kind: "fence", points: [100, 0, 100, 200], heightM: 1.8, thicknessM: 0.02, material: "wood" });
    input.map.obstacles.push({ id: 2, kind: "wall", points: [140, 0, 140, 200], heightM: 2, thicknessM: 0.25, material: "brick" });
    const sim = createSim(input);
    const before = navFor(sim.ctx, "foot");
    // (findPath ends at the nearest reachable point when the goal itself cannot be reached.)
    const reaches = (s: ReturnType<typeof navFor>["search"], x0: number, x1: number) => { const p = findPath(s, x0, 100, x1, 100); return p !== null && Math.abs(p.goalX - x1) < 3; };
    expect(reaches(before.search, 90, 110)).toBe(false);
    const sink = new EventSink();
    detonate(sim.ctx, sim.state, sink, 99.6, 100, 0.05, bomb, 0);
    detonate(sim.ctx, sim.state, sink, 139.6, 100, 0.05, bomb, 0);
    expect(sim.state.terrain.breaches).toHaveLength(1);
    expect(sim.state.terrain.breaches[0]).toMatchObject({ owner: "obstacle", id: 1 });
    expect(sink.events.filter((e) => e.kind === "terrain.breached")).toHaveLength(1);
    const after = navFor(sim.ctx, "foot");
    expect(reaches(after.search, 90, 110)).toBe(true);
    expect(reaches(after.search, 130, 150)).toBe(false);
    // The hole is part of the state: it survives a save, and the loaded battle has the same routes.
    const copy = loadSim(input, JSON.parse(JSON.stringify(saveSim(sim))));
    expect(reaches(navFor(copy.ctx, "foot").search, 90, 110)).toBe(true);
    expect(hashState(copy.state)).toBe(hashState(sim.state));
  });
});
