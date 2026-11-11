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
    expect(ev.find((e) => e.kind === "radio" && !e.key.startsWith("radio.contact"))).toMatchObject({ key: "radio.ack.grenade" });
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

  it("throw range depends on posture (about 30 m standing, 15 m prone): out of range is answered 'unable'; a prone man can throw 13 m, and 9 m is not too close (owner decisions)", () => {
    const far = createSim(setup(25));
    const [uid] = unitOf(far, "blue");
    submitOrder(far, { tick: 0, issuer: "blue", target: uid, kind: "posture", posture: "prone" });
    run(far, 6);
    submitOrder(far, { tick: far.state.tick, issuer: "blue", target: uid, kind: "grenade", x: 35, y: 13 });
    const ev = run(far, 8);
    expect(ev.filter((e) => e.kind === "radio").map((e) => (e.kind === "radio" ? e.key : ""))).toContain("radio.unable");
    expect(ev.some((e) => e.kind === "grenade.launched")).toBe(false);
    // Prone, 13 m: inside the 15 m prone range and beyond the 8 m safety distance.
    const prone = createSim(setup(100));
    const [pid] = unitOf(prone, "blue");
    submitOrder(prone, { tick: 0, issuer: "blue", target: pid, kind: "posture", posture: "prone" });
    run(prone, 6);
    submitOrder(prone, { tick: prone.state.tick, issuer: "blue", target: pid, kind: "grenade", x: 23, y: 15 });
    expect(run(prone, 8).some((e) => e.kind === "grenade.launched")).toBe(true);
    const close = createSim(setup(100));
    const [cid] = unitOf(close, "blue");
    submitOrder(close, { tick: 0, issuer: "blue", target: cid, kind: "grenade", x: 19, y: 15 });
    expect(run(close, 6).some((e) => e.kind === "grenade.launched")).toBe(true);
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

describe("M2.4b: bounce, chosen arcs, several grenades, reaction (owner requests 2026-11-11)", () => {
  const withCatalog = (input: BattleInput, f: (c: BattleInput["catalog"]) => void): BattleInput => { input.catalog = JSON.parse(JSON.stringify(input.catalog)) as BattleInput["catalog"]; f(input.catalog); return input; };

  it("a grenade bounces and rolls on before it lies still, further on hard ground than on soft; off a wall it comes back", () => {
    const roll = (soft: boolean) => {
      const input = withCatalog(setup(100), (c) => { c.terrain.materials["soil"]!.densityKgM3 = soft ? 1600 : 2400; });
      const sim = createSim(input);
      launchProjectile(sim.ctx, sim.state, "bomb", 50, 50, 1.5, 12, 0, 6, 0);
      const ev = run(sim, 3.5);
      const landed = ev.filter((e) => e.kind === "grenade.landed");
      const first = landed[0]!;
      if (first.kind !== "grenade.landed") throw new Error("unreachable");
      expect(sim.state.projectiles.count).toBe(1);
      expect(sim.state.projectiles.vx[0]).toBe(0); // it has come to rest
      return { contacts: landed.length, carry: sim.state.projectiles.x[0]! - first.x };
    };
    const hard = roll(false), soft = roll(true);
    expect(hard.contacts).toBeGreaterThan(1);
    expect(soft.carry).toBeGreaterThan(0.2);
    expect(hard.carry).toBeGreaterThan(soft.carry * 1.5);
    expect(hard.carry).toBeLessThan(15);

    const input = setup(100);
    input.map.obstacles.push({ id: 1, kind: "wall", points: [60, 40, 60, 60], heightM: 2, thicknessM: 0.25, material: "brick" });
    const sim = createSim(input);
    launchProjectile(sim.ctx, sim.state, "bomb", 50, 50, 1.5, 12, 0, 4, 0); // into the wall
    run(sim, 3.5);
    expect(sim.state.projectiles.x[0]).toBeLessThan(59.5); // back on the thrower's side, clear of the wall
    expect(sim.state.projectiles.x[0]).toBeGreaterThan(50);
  });

  it("thrown grenades land on the point on average although they roll on (the thrower allows for it)", () => {
    let along = 0, n = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const sim = createSim(setup(100, { seed }));
      const [uid] = unitOf(sim, "blue");
      submitOrder(sim, { tick: 0, issuer: "blue", target: uid, kind: "grenade", x: 35, y: 15 });
      for (const e of run(sim, 9)) if (e.kind === "explosion") { along += e.x - 35; n++; }
    }
    expect(n).toBe(30);
    expect(Math.abs(along / n)).toBeLessThan(1.5);
  });

  it("indoors the thrower takes a flat throw under the ceiling: the grenade reaches the far end of the room", () => {
    let near = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const input = setup(100, { seed });
      input.map.buildings.push({ id: 1, kind: "house", footprint: [5, 5, 65, 5, 65, 35, 5, 35], storeys: 1, storeyHeightM: 2.8, wallMaterial: "brick", wallThicknessM: 0.3, openings: [], roofColour: "#8c4a3b" });
      const sim = createSim(input);
      const [uid] = unitOf(sim, "blue");
      submitOrder(sim, { tick: 0, issuer: "blue", target: uid, kind: "grenade", x: 24, y: 15 });
      const ex = run(sim, 10).find((e) => e.kind === "explosion");
      if (!ex || ex.kind !== "explosion") throw new Error("no burst");
      expect(ex.z).toBeLessThan(0.5);
      if (Math.hypot(ex.x - 24, ex.y - 15) < 5) near++;
    }
    expect(near).toBeGreaterThanOrEqual(8); // before: it struck the ceiling 2 m from the thrower every time
  });

  it("an order for several grenades: that many men throw, a moment apart, each using one of his own", () => {
    const sim = createSim(setup(25));
    const [uid, unit] = unitOf(sim, "blue");
    submitOrder(sim, { tick: 0, issuer: "blue", target: uid, kind: "grenade", x: 35, y: 15, count: 3 });
    const ev = run(sim, 12);
    const thrown = ev.filter((e) => e.kind === "grenade.launched");
    expect(thrown).toHaveLength(3);
    expect(new Set(thrown.map((e) => (e.kind === "grenade.launched" ? e.soldier : 0))).size).toBe(3);
    const ticks = thrown.map((e) => e.tick).sort((a, b) => a - b);
    expect(ticks[1]! - ticks[0]!).toBeGreaterThanOrEqual(30);
    expect(ticks[2]! - ticks[1]!).toBeGreaterThanOrEqual(30);
    expect(ev.filter((e) => e.kind === "explosion")).toHaveLength(3);
    for (const m of unit.members) expect(count(sim, m, "bomb")).toBe(1);
    // More asked for than men who can: all who can, no error.
    const sim2 = createSim(setup(25));
    const [uid2] = unitOf(sim2, "blue");
    submitOrder(sim2, { tick: 0, issuer: "blue", target: uid2, kind: "grenade", x: 35, y: 15, count: 20 });
    expect(run(sim2, 14).filter((e) => e.kind === "grenade.launched")).toHaveLength(3);
  });

  it("a man with a grenade landing 6 m away drops flat before it bursts; one within 3 m runs from it first; behind a wall nobody stirs", () => {
    const input = setup(100);
    input.map.obstacles.push({ id: 1, kind: "wall", points: [90, 104, 110, 104], heightM: 2, thicknessM: 0.25, material: "brick" });
    input.forces[1]!.placements = [{ personId: "b.0", x: 106, y: 100, heading: 0 }, { personId: "b.1", x: 101.5, y: 100.5, heading: 0 }];
    input.forces[0]!.placements = input.forces[0]!.placements.map((p, i) => ({ ...p, x: 98 + i * 2, y: 106 })); // behind the wall
    const sim = createSim(input);
    const [far, close] = unitOf(sim, "red")[1].members as [number, number];
    const behind = unitOf(sim, "blue")[1].members;
    const d0 = Math.hypot(1.5, 0.5);
    launchProjectile(sim.ctx, sim.state, "bomb", 100, 100, 0.3, 0, 0, -1, 0); // dropped at (100, 100): 4 s fuse
    let burst = false, dAtBurst = 0, proneAtBurst = false, closeProne = false;
    for (let i = 0; i < 60 * 6 && !burst; i++) {
      const ev = step(sim);
      if (ev.some((e) => e.kind === "explosion")) {
        burst = true;
        const c = sim.state.transform.req(close);
        dAtBurst = Math.hypot(c.x - 100, c.y - 100);
        proneAtBurst = sim.state.soldier.req(far).posture === "prone";
        closeProne = sim.state.soldier.req(close).posture === "prone";
      }
    }
    expect(burst).toBe(true);
    expect(proneAtBurst).toBe(true);
    expect(dAtBurst).toBeGreaterThan(d0 + 4); // he ran several metres in the seconds he had
    expect(closeProne).toBe(true); // and threw himself down before the burst
    for (const m of behind) { expect(sim.state.soldier.req(m).posture).toBe("standing"); expect(sim.state.soldier.req(m).evade).toBeNull(); }
    run(sim, 2);
    expect(sim.state.soldier.req(far).evade).toBeNull(); // over: he is free to act again
  });

  it("the reaction is state: a save taken while men are diving away replays identically", () => {
    const mk = () => { const i = setup(100); i.forces[1]!.placements = [{ personId: "b.0", x: 104, y: 100, heading: 0 }, { personId: "b.1", x: 101.5, y: 100.5, heading: 0 }]; return i; };
    const sim = createSim(mk());
    launchProjectile(sim.ctx, sim.state, "bomb", 100, 100, 0.3, 0, 0, -1, 0);
    run(sim, 1.5);
    expect([...sim.state.soldier.entries()].some(([, s]) => s.evade !== null)).toBe(true);
    const copy = loadSim(mk(), JSON.parse(JSON.stringify(saveSim(sim))));
    run(sim, 6); run(copy, 6);
    expect(hashState(copy.state)).toBe(hashState(sim.state));
  });

  it("rough ground: fragments skimming the ground are thinned out, so a prone man 10 m away is hit less than on a billiard table", () => {
    const hits = (clutter: number) => {
      let n = 0;
      for (let seed = 1; seed <= 12; seed++) {
        const input = withCatalog(setup(100, { seed }), (c) => { c.ballistics.fragments.clutterStopPerM = clutter; });
        input.forces[1]!.placements = [{ personId: "b.0", x: 110, y: 100, heading: Math.PI }, { personId: "b.1", x: 90, y: 100, heading: 0 }];
        const sim = createSim(input);
        for (const m of unitOf(sim, "red")[1].members) sim.state.soldier.req(m).posture = "prone";
        detonate(sim.ctx, sim.state, new EventSink(), 100, 100, 0.05, bomb, 0);
        n += run(sim, 1).filter((e) => e.kind === "hit").length;
      }
      return n;
    };
    const smooth = hits(0), rough = hits(0.15);
    expect(smooth).toBeGreaterThan(10);
    expect(rough).toBeLessThan(smooth * 0.8);
  });
});

describe("M2.4b review fixes", () => {
  it("launcher: with a high wall in front the round goes over on the high arc and bursts near the point — it is never lost", () => {
    let near = 0, kept = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const input = setup(120, { launcher: true, bombs: 0, seed });
      input.map.obstacles.push({ id: 1, kind: "wall", points: [22, 0, 22, 60], heightM: 4, thicknessM: 0.25, material: "brick" });
      const sim = createSim(input);
      const [uid, unit] = unitOf(sim, "blue");
      const before = unit.members.reduce((n, m) => n + count(sim, m, "shell"), 0);
      submitOrder(sim, { tick: 0, issuer: "blue", target: uid, kind: "grenade", x: 130, y: 14 });
      const ev = run(sim, 20);
      const used = before - unit.members.reduce((n, m) => n + count(sim, m, "shell"), 0);
      const ex = ev.filter((e) => e.kind === "explosion");
      expect(ex.length).toBe(used); // every round that left the load burst somewhere
      expect(sim.state.projectiles.count).toBe(0);
      if (used === 0) { kept++; expect(ev.some((e) => e.kind === "radio" && e.key === "radio.grenadeBlocked")).toBe(true); }
      for (const e of ex) if (e.kind === "explosion" && e.x > 22 && Math.hypot(e.x - 130, e.y - 14) < 25) near++;
    }
    expect(near + kept).toBe(8);
    expect(near).toBeGreaterThanOrEqual(6);
  });

  it("a throw over a wall just in front of the point lands beyond the wall, or is not made at all", () => {
    let beyond = 0, kept = 0, short = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const input = setup(100, { seed });
      input.map.obstacles.push({ id: 1, kind: "wall", points: [28.5, 0, 28.5, 60], heightM: 2, thicknessM: 0.25, material: "brick" });
      const sim = createSim(input);
      const [uid] = unitOf(sim, "blue");
      submitOrder(sim, { tick: 0, issuer: "blue", target: uid, kind: "grenade", x: 30, y: 15 });
      const ex = run(sim, 10).find((e) => e.kind === "explosion");
      if (!ex || ex.kind !== "explosion") kept++; else if (ex.x > 28.5) beyond++; else short++;
    }
    expect(beyond).toBeGreaterThanOrEqual(14); // before the fix: about 3 in 20
    expect(short).toBeLessThanOrEqual(4); // bounced back off the top of the wall after a wide throw
    expect(beyond + kept + short).toBe(20);
  });

  it("from inside a room with no clear way out the man does not throw into his own ceiling: he keeps the grenade and says so", () => {
    const input = setup(100);
    // A closed house around the team: no door, no window.
    input.map.buildings.push({ id: 1, kind: "house", footprint: [5, 5, 20, 5, 20, 30, 5, 30], storeys: 1, storeyHeightM: 2.8, wallMaterial: "brick", wallThicknessM: 0.3, openings: [], roofColour: "#8c4a3b" });
    const sim = createSim(input);
    const [uid, unit] = unitOf(sim, "blue");
    submitOrder(sim, { tick: 0, issuer: "blue", target: uid, kind: "grenade", x: 34, y: 15 });
    const ev = run(sim, 10);
    expect(ev.some((e) => e.kind === "explosion")).toBe(false);
    expect(ev.some((e) => e.kind === "radio" && e.key === "radio.grenadeBlocked")).toBe(true);
    expect(unit.members.reduce((n, m) => n + count(sim, m, "bomb"), 0)).toBe(6);
    for (const m of unit.members) expect(sim.state.soldier.req(m).wounds).toHaveLength(0);
  });

  it("a second grenade landing nearer than the first makes a man react again; he is not left lying beside it", () => {
    const input = setup(100);
    input.forces[1]!.placements = [{ personId: "b.0", x: 106, y: 100, heading: 0 }, { personId: "b.1", x: 150, y: 150, heading: 0 }];
    const sim = createSim(input);
    const man = unitOf(sim, "red")[1].members[0]!;
    launchProjectile(sim.ctx, sim.state, "bomb", 100, 100, 0.3, 0, 0, -1, 0);
    run(sim, 1.5);
    expect(sim.state.soldier.req(man).evade).toMatchObject({ run: false });
    launchProjectile(sim.ctx, sim.state, "bomb", 105, 100, 0.3, 0, 0, -1, 0); // 1 m from him
    run(sim, 0.5);
    expect(sim.state.soldier.req(man).evade).toMatchObject({ x: 105, run: true });
    const until = sim.state.soldier.req(man).evade!.untilTick;
    expect(until).toBeGreaterThan(secondsToTicks(5.4)); // until after the SECOND burst
  });

  it("a grenade striking a brick wall does not stir the men behind that wall", () => {
    const input = setup(100);
    input.map.obstacles.push({ id: 1, kind: "wall", points: [100, 80, 100, 120], heightM: 2, thicknessM: 0.25, material: "brick" });
    input.forces[1]!.placements = [{ personId: "b.0", x: 102, y: 100, heading: 0 }, { personId: "b.1", x: 150, y: 150, heading: 0 }];
    const sim = createSim(input);
    const man = unitOf(sim, "red")[1].members[0]!;
    launchProjectile(sim.ctx, sim.state, "bomb", 90, 100, 1.5, 12, 0, 4, 0); // into the wall from the west
    const ev = run(sim, 3);
    expect(ev.some((e) => e.kind === "grenade.landed" && Math.abs(e.x - 100) < 0.5)).toBe(true);
    expect(sim.state.soldier.req(man).evade).toBeNull();
    expect(sim.state.transform.req(man).x).toBe(102);
  });

  it("after running from a grenade a man finds his way back to his route instead of walking through a house", () => {
    const input = setup(150);
    input.map.buildings.push({ id: 1, kind: "house", footprint: [60, 95, 100, 95, 100, 105, 60, 105], storeys: 1, storeyHeightM: 2.8, wallMaterial: "brick", wallThicknessM: 0.3, openings: [], roofColour: "#8c4a3b" });
    input.forces[0]!.placements = [{ personId: "a.0", x: 103, y: 80, heading: 0 }, { personId: "a.1", x: 20, y: 20, heading: 0 }, { personId: "a.2", x: 20, y: 25, heading: 0 }];
    const sim = createSim(input);
    const man = unitOf(sim, "blue")[1].members[0]!;
    submitOrder(sim, { tick: 0, issuer: "blue", target: man, kind: "move", waypoints: [{ x: 80, y: 115, mode: "walk" }] });
    let inside = 0, dropped = false;
    for (let i = 0; i < 60 * 90; i++) {
      step(sim);
      const t = sim.state.transform.req(man);
      if (!dropped && t.y > 92) { dropped = true; launchProjectile(sim.ctx, sim.state, "bomb", t.x + 2.5, t.y + 0.5, 0.3, 0, 0, -1, 0); }
      if (t.x > 60.5 && t.x < 99.5 && t.y > 95.5 && t.y < 104.5) inside++;
    }
    expect(dropped).toBe(true);
    expect(inside).toBe(0);
    const t = sim.state.transform.req(man);
    if (sim.state.soldier.req(man).casualty === "none") expect(Math.hypot(t.x - 80, t.y - 115)).toBeLessThan(20);
  });
});
