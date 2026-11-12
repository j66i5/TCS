/**
 * Vehicles as obstacles and drivers on the map (M7.1c): routes on the class grid with clearance, collisions with
 * buildings, walls, other hulls and men, flattening fences, stuck re-plans, unit arrival with vehicles,
 * the parent split of orders, hulls against bullets and sight.
 */
import { describe, expect, it } from "vitest";
import {
  buildBallistics, buildMapIndex, buildNavGrid, createSim, followRoute, hullObb, idleDrive, launchProjectile, navFor, obbOverlap, patchNavGrid, pointInObb,
  sight, step, stepDriveDynamics, submitOrder, syncTerrainDamage, type BattleInput, type Catalog, type DriveSurface, type MapDef, type NavGrid, type Sim, type SimEvent, type UnitInput,
} from "../src/index";
import { rec, team, testCatalog, vehicleInput } from "./helpers";

const T: Catalog["terrain"] = {
  ...testCatalog.terrain,
  obstacles: {
    ...testCatalog.terrain.obstacles,
    fence: { ...testCatalog.terrain.obstacles["wall"]!, id: "fence", heightM: 1.2, thicknessM: 0.05, material: "wood", seeThrough: 0.3, footCrossTimeS: 3, vehicle: { tracked: { crossCostCells: 2, capKmh: 10, flattens: true }, wheeled: null } },
    brick: { ...testCatalog.terrain.obstacles["wall"]!, id: "brick", vehicle: { tracked: null, wheeled: null } },
  },
};
const CAT: Catalog = { ...testCatalog, terrain: T };

function house(m: MapDef, id: number, x0: number, y0: number, x1: number, y1: number): void {
  m.buildings.push({ id, kind: "house", footprint: [x0, y0, x1, y0, x1, y1, x0, y1], storeys: 1, storeyHeightM: 2.8, wallMaterial: "brick", wallThicknessM: 0.3, openings: [], roofColour: "#8c4a3b" });
}

function run(sim: Sim, seconds: number, until?: (e: SimEvent[]) => boolean, each?: () => void): SimEvent[] {
  const all: SimEvent[] = [];
  for (let i = 0; i < seconds * 60; i++) {
    const ev = step(sim);
    all.push(...ev);
    each?.();
    if (until?.(ev)) break;
  }
  return all;
}

const crewOf = (sim: Sim) => [...sim.state.vehicle.values()][0]!.unit!;
const vidOf = (sim: Sim) => [...sim.state.vehicle.keys()][0]!;

describe("vehicle navigation grid (tracked:c1)", () => {
  it("grows houses by the clearance; a hull-width breach in a brick wall stays open, a narrow one does not", () => {
    const m: MapDef = vehicleInput().map;
    house(m, 1, 200, 80, 220, 120);
    m.obstacles.push({ id: 7, kind: "brick", points: [400, 0, 400, 200], heightM: 2, thicknessM: 0.25, material: "brick" });
    const wide = [{ owner: "obstacle" as const, id: 7, part: 0, offsetM: 100, widthM: 5, tick: 0 }];
    const narrow = [{ owner: "obstacle" as const, id: 7, part: 0, offsetM: 100, widthM: 1.5, tick: 0 }];
    const g = buildNavGrid(m, T, "tracked", 2, 0, wide, { clearanceCells: 1, minBreachM: 4 });
    const at = (n: NavGrid, x: number, y: number) => n.cost[Math.floor(y / 2) * n.cols + Math.floor(x / 2)]!;
    expect(at(g, 223, 100)).toBe(0); // beside the house: within the clearance
    expect(at(g, 230, 100)).toBeGreaterThan(0);
    expect(at(g, 401, 100)).toBeGreaterThan(0); // the hole
    expect(at(g, 401, 60)).toBe(0); // the wall elsewhere
    const n = buildNavGrid(m, T, "tracked", 2, 0, narrow, { clearanceCells: 1, minBreachM: 4 });
    expect(at(n, 401, 100)).toBe(0);
    // And the regions say so: the east side is reachable only through the wide hole.
    const ri = (gr: NavGrid, x: number, y: number) => gr.region[Math.floor(y / 2) * gr.cols + Math.floor(x / 2)];
    expect(ri(g, 380, 100)).toBe(ri(g, 420, 100));
    expect(ri(n, 380, 100)).not.toBe(ri(n, 420, 100));
  });

  it("patchNavGrid equals a full rebuild (cost, wall, exposure, region) after a breach, a flattening and a wreck stamp", () => {
    const m: MapDef = vehicleInput().map;
    house(m, 1, 200, 80, 220, 120);
    m.obstacles.push({ id: 7, kind: "brick", points: [400, 0, 400, 200], heightM: 2, thicknessM: 0.25, material: "brick" });
    m.obstacles.push({ id: 8, kind: "fence", points: [300, 0, 300, 90, 330, 200], heightM: 1.2, thicknessM: 0.05, material: "wood" });
    for (const [cls, cover, opts] of [["foot", 0.3, {}], ["foot", 0, {}], ["tracked", 0, { clearanceCells: 1, minBreachM: 4 }]] as const) {
      const g = buildNavGrid(m, T, cls, 2, cover, [], opts);
      const breaches = [
        { owner: "obstacle" as const, id: 7, part: 0, offsetM: 100, widthM: 5, tick: 1 },
        { owner: "obstacle" as const, id: 8, part: 1, offsetM: 40, widthM: 6, tick: 2 },
      ];
      const stamps = [{ x: 150, y: 50, heading: 0.7, halfL: 3.5, halfW: 1.75 }];
      patchNavGrid(g, m, T, breaches.slice(0, 1), [], 395, 95, 405, 105);
      patchNavGrid(g, m, T, breaches, [], 310, 120, 325, 140);
      patchNavGrid(g, m, T, breaches, stamps, 140, 40, 160, 60);
      const full = buildNavGrid(m, T, cls, 2, cover, breaches, { ...opts, stamps });
      expect(Array.from(g.cost)).toEqual(Array.from(full.cost));
      expect(Array.from(g.wall)).toEqual(Array.from(full.wall));
      expect(Array.from(g.exposure)).toEqual(Array.from(full.exposure));
      expect(Array.from(g.region)).toEqual(Array.from(full.region));
      expect(g.minCost).toBe(full.minCost);
    }
  });
});

describe("vehicle routes and collisions", () => {
  it("drives round a house to a point behind it, never overlapping it", () => {
    const input = vehicleInput(1, 120);
    input.catalog = CAT;
    house(input.map, 1, 150, 70, 190, 130);
    const sim = createSim(input);
    const vid = vidOf(sim), def = CAT.vehicles["tank"]!;
    submitOrder(sim, { tick: 0, issuer: "blue", target: crewOf(sim), kind: "move", waypoints: [{ x: 260, y: 100, mode: "drive" }] });
    const hb = { x: 170, y: 100, c: 1, s: 0, hl: 20, hw: 30 };
    let overlap = false;
    const ev = run(sim, 120, (e) => e.some((x) => x.kind === "unit.arrived"), () => {
      const t = sim.state.transform.req(vid);
      if (obbOverlap(hullObb(def, t.x, t.y, t.heading), hb)) overlap = true;
    });
    expect(overlap).toBe(false);
    expect(ev.some((e) => e.kind === "unit.arrived")).toBe(true);
    const t = sim.state.transform.req(vid);
    expect(Math.hypot(t.x - 260, t.y - 100)).toBeLessThan(4);
  });

  it("a reverse leg drives backwards (facing kept, moving the other way)", () => {
    const sim = createSim(vehicleInput());
    const vid = vidOf(sim);
    submitOrder(sim, { tick: 0, issuer: "blue", target: crewOf(sim), kind: "move", waypoints: [{ x: 200, y: 100, mode: "drive" }] });
    run(sim, 60, (e) => e.some((x) => x.kind === "unit.arrived"));
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: crewOf(sim), kind: "move", waypoints: [{ x: 150, y: 100, mode: "drive-slow", reverse: true }] });
    let minSpeed = 0;
    run(sim, 60, (e) => e.some((x) => x.kind === "unit.arrived"), () => { minSpeed = Math.min(minSpeed, sim.state.vehicle.req(vid).drive.speed); });
    const t = sim.state.transform.req(vid);
    expect(minSpeed).toBeLessThan(-1);
    expect(Math.abs(Math.cos(t.heading))).toBeGreaterThan(0.95);
    expect(Math.hypot(t.x - 150, t.y - 100)).toBeLessThan(4);
  });

  it("flattens a fence it crosses (a breach with id, part, offset and width ≈ hull / sin at 45°) and goes round a brick wall", () => {
    const input = vehicleInput(1, 120);
    input.catalog = CAT;
    // A fence across the way at 45° (from (150, 50) to (250, 150)): the hull crosses it heading east.
    input.map.obstacles.push({ id: 3, kind: "fence", points: [150, 50, 250, 150], heightM: 1.2, thicknessM: 0.05, material: "wood" });
    const sim = createSim(input);
    submitOrder(sim, { tick: 0, issuer: "blue", target: crewOf(sim), kind: "move", waypoints: [{ x: 320, y: 100, mode: "drive" }] });
    const ev = run(sim, 90, (e) => e.some((x) => x.kind === "unit.arrived"));
    expect(ev.some((e) => e.kind === "vehicle.crossed" && e.obstacle === 3)).toBe(true);
    const b = sim.state.terrain.breaches.find((x) => x.id === 3)!;
    expect(b).toBeDefined();
    expect(b.owner).toBe("obstacle");
    expect(b.part).toBe(0);
    expect(b.offsetM).toBeGreaterThan(50);
    expect(b.offsetM).toBeLessThan(91);
    expect(b.widthM).toBeGreaterThan(3.5 / Math.sin(Math.PI / 4) * 0.8);
    expect(b.widthM).toBeLessThan(3.5 / Math.sin(Math.PI / 4) * 1.25);
    expect(ev.some((e) => e.kind === "terrain.breached")).toBe(true);

    const i2 = vehicleInput(1, 200);
    i2.catalog = CAT;
    i2.map.obstacles.push({ id: 4, kind: "brick", points: [200, 0, 200, 160], heightM: 2, thicknessM: 0.25, material: "brick" });
    const s2 = createSim(i2);
    submitOrder(s2, { tick: 0, issuer: "blue", target: crewOf(s2), kind: "move", waypoints: [{ x: 300, y: 60, mode: "drive" }] });
    const e2 = run(s2, 150, (e) => e.some((x) => x.kind === "unit.arrived"));
    expect(e2.some((e) => e.kind === "unit.arrived")).toBe(true);
    expect(s2.state.terrain.breaches.length).toBe(0);
    expect(Math.hypot(s2.state.transform.req(vidOf(s2)).x - 300, s2.state.transform.req(vidOf(s2)).y - 60)).toBeLessThan(4);
  });

  it("an own man in the way steps aside and is not hurt; an enemy who cannot get away is run over", () => {
    const input = vehicleInput(1, 120);
    const own = team("own", 1);
    input.forces[0]!.units.push(own);
    input.forces[0]!.placements.push({ personId: "own.0", x: 150, y: 100, heading: 0 });
    input.forces[1]!.placements[0] = { personId: "b.0", x: 300, y: 100, heading: 0 };
    const sim = createSim(input);
    const ownId = [...sim.state.identity.entries()].find(([, i]) => i.personId === "own.0")![0];
    const foe = [...sim.state.identity.entries()].find(([, i]) => i.personId === "b.0")![0];
    // The enemy lies flat (a man on the ground cannot jump aside).
    sim.state.soldier.req(foe).posture = "prone";
    submitOrder(sim, { tick: 0, issuer: "blue", target: crewOf(sim), kind: "move", waypoints: [{ x: 400, y: 100, mode: "drive-slow" }] });
    const ev = run(sim, 120, (e) => e.some((x) => x.kind === "unit.arrived"));
    expect(sim.state.soldier.req(ownId).wounds.length).toBe(0);
    expect(Math.abs(sim.state.transform.req(foe).x - 300)).toBeLessThan(1); // run over, not shoved along
    expect(Math.abs(sim.state.transform.req(ownId).y - 100)).toBeGreaterThan(2);
    expect(ev.some((e) => e.kind === "vehicle.ranOver" && e.soldier === foe)).toBe(true);
    expect(sim.state.soldier.req(foe).wounds.some((w) => w.mechanism === "crush")).toBe(true);
    expect(ev.filter((e) => e.kind === "vehicle.ranOver").length).toBe(1);
    expect(ev.some((e) => e.kind === "unit.arrived")).toBe(true);
  });

  it("waits for an own man who cannot move, then plans round him", () => {
    const input = vehicleInput(1, 90);
    const own = team("own", 1);
    input.forces[0]!.units.push(own);
    input.forces[0]!.placements.push({ personId: "own.0", x: 150, y: 100, heading: 0 });
    const sim = createSim(input);
    const ownId = [...sim.state.identity.entries()].find(([, i]) => i.personId === "own.0")![0];
    const s = sim.state.soldier.req(ownId);
    s.posture = "prone"; s.casualty = "incapacitated"; s.physiology.consciousness = 0;
    submitOrder(sim, { tick: 0, issuer: "blue", target: crewOf(sim), kind: "move", waypoints: [{ x: 300, y: 100, mode: "drive-slow" }] });
    const ev = run(sim, 90, (e) => e.some((x) => x.kind === "unit.arrived"));
    expect(ev.some((e) => e.kind === "vehicle.ranOver")).toBe(false);
    expect(s.wounds.length).toBe(0);
    expect(ev.some((e) => e.kind === "unit.arrived")).toBe(true);
  });

  it("two hulls driving head-on never overlap; one yields and plans round the other", () => {
    const input = vehicleInput(1, 120);
    const crew2: UnitInput = { key: "crew2", callsign: "Crew2", echelon: "vehicle", leaderIndex: 0, vehicleId: "v2", subunits: [], members: [rec("c2.0"), rec("c2.1"), rec("c2.2")] };
    input.forces[0]!.units.push(crew2);
    input.forces[0]!.vehicles!.push({ vehicleId: "v2", type: "tank", load: [{ type: "tank-fuel", count: 1, charge: 400 }] });
    input.forces[0]!.vehiclePlacements!.push({ vehicleId: "v2", x: 300, y: 100, heading: Math.PI });
    const sim = createSim(input);
    const rows = [...sim.state.vehicle.entries()];
    const [v1, a] = rows[0]!, [v2, b] = rows[1]!;
    submitOrder(sim, { tick: 0, issuer: "blue", target: a.unit!, kind: "move", waypoints: [{ x: 350, y: 100, mode: "drive-slow" }] });
    submitOrder(sim, { tick: 0, issuer: "blue", target: b.unit!, kind: "move", waypoints: [{ x: 20, y: 100, mode: "drive-slow" }] });
    const def = testCatalog.vehicles["tank"]!;
    let overlap = false, arrived = 0;
    run(sim, 120, () => arrived >= 2, () => {
      const t1 = sim.state.transform.req(v1), t2 = sim.state.transform.req(v2);
      if (obbOverlap(hullObb(def, t1.x, t1.y, t1.heading), hullObb(def, t2.x, t2.y, t2.heading))) overlap = true;
      arrived = [a, b].filter((v) => v.drive.arrived).length;
    });
    expect(overlap).toBe(false);
    expect(arrived).toBe(2);
  });

  it("boxed in for good: plans again three times, then answers 'no way through'", () => {
    const input = vehicleInput(1, 120);
    input.catalog = CAT;
    const sim = createSim(input);
    submitOrder(sim, { tick: 0, issuer: "blue", target: crewOf(sim), kind: "move", waypoints: [{ x: 300, y: 100, mode: "drive-slow" }] });
    step(sim);
    // A brick wall appears across its way after the route was planned (the grid does not know it).
    sim.ctx.map.obstacles.push({ id: 9, kind: "brick", points: [90, 0, 90, 200], heightM: 2, thicknessM: 0.25, material: "brick" });
    sim.ctx.mapIndex = buildMapIndex(sim.ctx.map);
    sim.ctx.ballistics = buildBallistics(sim.ctx.map, sim.ctx.catalog, sim.ctx.mapIndex, 60);
    sim.ctx.nav = {};
    syncTerrainDamage(sim.ctx, sim.state);
    const ev = run(sim, 120, (e) => e.some((x) => x.kind === "move.noRoute"));
    expect(ev.some((e) => e.kind === "move.noRoute")).toBe(true);
    expect(ev.some((e) => e.kind === "radio" && e.key === "radio.noRoute")).toBe(true);
    expect(sim.state.transform.req(vidOf(sim)).x).toBeLessThan(90);
  });

  it("the follower holds a straight line with one weak track (within 2 m over 100 m)", () => {
    const sim = createSim(vehicleInput());
    const def = testCatalog.vehicles["tank"]!;
    const flat: DriveSurface = { rolling: 0.06, traction: 0.6, lateral: 0.55, capMps: Infinity, sinPitch: 0, cosPitch: 1 };
    let d = idleDrive(0, 0);
    d.route = [{ x: 50, y: 100, mode: "drive" }, { x: 150, y: 100, mode: "drive" }]; d.routeIdx = 0; d.arrived = false;
    let x = 50, y = 100, h = 0, worst = 0;
    for (let i = 0; i < 60 * 60 && x < 148; i++) {
      const cmd = { ...followRoute(sim.ctx, def, d, x, y, h) };
      d = stepDriveDynamics(def, d, cmd, flat, 1 / 60, i, { engine: 1, trackL: 0.3, trackR: 1 }).drive;
      h += d.yawRate / 60; x += Math.cos(h) * d.speed / 60; y += Math.sin(h) * d.speed / 60;
      worst = Math.max(worst, Math.abs(y - 100));
    }
    expect(x).toBeGreaterThan(140);
    expect(worst).toBeLessThan(2);
  });
});

describe("orders to units with vehicles", () => {
  function platoon(): BattleInput {
    const input = vehicleInput(1, 300);
    const crew = input.forces[0]!.units[0]!;
    const squad = team("sq", 3);
    const plt: UnitInput = { key: "plt", callsign: "Plt", echelon: "platoon", leaderIndex: 0, members: [rec("pl.0")], subunits: [crew, squad] };
    input.forces[0]!.units = [plt];
    input.forces[0]!.placements = [
      { personId: "pl.0", x: 40, y: 60, heading: 0 },
      ...squad.members.map((m, i) => ({ personId: m.personId, x: 40, y: 140 + i * 4, heading: 0 })),
    ];
    return input;
  }

  it("a platoon move in walk gives its vehicle drive-slow; the platoon arrives only when the hull has arrived", () => {
    const sim = createSim(platoon());
    const plt = [...sim.state.unit.entries()].find(([, u]) => u.callsign === "Plt")![0];
    const vid = vidOf(sim);
    submitOrder(sim, { tick: 0, issuer: "blue", target: plt, kind: "move", waypoints: [{ x: 90, y: 100, mode: "walk" }] });
    step(sim);
    const v = sim.state.vehicle.req(vid);
    expect(v.drive.route.length).toBeGreaterThan(0);
    expect(v.drive.route.every((w) => w.mode === "walk")).toBe(true); // a foot pace, driven at its vehicle pace
    let vehicleArrivedTick = -1, platoonArrivedTick = -1;
    run(sim, 200, (e) => { for (const x of e) if (x.kind === "unit.arrived") { if (x.unit === plt) platoonArrivedTick = x.tick; if (x.unit === v.unit) vehicleArrivedTick = x.tick; } return platoonArrivedTick >= 0; });
    expect(vehicleArrivedTick).toBeGreaterThan(0);
    expect(platoonArrivedTick).toBeGreaterThanOrEqual(vehicleArrivedTick);
  });

  it("a platoon rules order with 300 m does not cap its vehicle's range; one to the vehicle does", () => {
    const sim = createSim(platoon());
    const plt = [...sim.state.unit.entries()].find(([, u]) => u.callsign === "Plt")![0];
    const crew = sim.state.vehicle.req(vidOf(sim)).unit!;
    const before = sim.state.unit.req(crew).maxEngageM;
    submitOrder(sim, { tick: 0, issuer: "blue", target: plt, kind: "rules", maxEngageM: 300, fire: "hold" });
    run(sim, 1);
    expect(sim.state.unit.req(crew).maxEngageM).toBe(before);
    expect(sim.state.unit.req(crew).fireRule).toBe("hold");
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: crew, kind: "rules", maxEngageM: 300 });
    run(sim, 1);
    expect(sim.state.unit.req(crew).maxEngageM).toBe(300);
  });
});

describe("hulls against bullets and sight", () => {
  it("rifle rounds stop at the hull and come out as one aggregated vehicle.hit per tick", () => {
    const sim = createSim(vehicleInput());
    const vid = vidOf(sim);
    const shooter = [...sim.state.identity.keys()].find((id) => sim.state.soldier.req(id).mount === undefined)!;
    for (let k = 0; k < 5; k++) launchProjectile(sim.ctx, sim.state, "ball", 30, 99 + k * 0.4, 1.5, 900, 0, 0, shooter);
    const ev = run(sim, 0.2);
    const hits = ev.filter((e) => e.kind === "vehicle.hit");
    expect(hits.length).toBe(1);
    expect(hits[0]!.kind === "vehicle.hit" && hits[0]!.rounds).toBe(5);
    expect(hits[0]!.kind === "vehicle.hit" && hits[0]!.vehicle).toBe(vid);
    expect(hits[0]!.kind === "vehicle.hit" && hits[0]!.face).toBe("rear");
    expect(sim.state.projectiles.count).toBe(0);
  });

  it("a fast round never passes through a moving hull", () => {
    const sim = createSim(vehicleInput());
    submitOrder(sim, { tick: 0, issuer: "blue", target: crewOf(sim), kind: "move", waypoints: [{ x: 500, y: 100, mode: "drive" }] });
    run(sim, 8);
    const shooter = [...sim.state.identity.keys()].find((id) => sim.state.soldier.req(id).mount === undefined)!;
    const t = sim.state.transform.req(vidOf(sim));
    // From the side, across the hull's path, 1400 m/s.
    launchProjectile(sim.ctx, sim.state, "ball", t.x + 3, 10, 1.5, 0, 1400, 0, shooter);
    const ev = run(sim, 0.3);
    expect(ev.some((e) => e.kind === "vehicle.hit")).toBe(true);
  });

  it("a man behind a hull is unseen (blocked by the vehicle), and seen when it has gone", () => {
    const sim = createSim(vehicleInput());
    const s = sight(sim.ctx, 20, 100, 1.6, 120, 100, 1.2);
    expect(s.blockedBy).toBe("vehicle");
    expect(sight(sim.ctx, 20, 100, 1.6, 120, 100, 1.2, vidOf(sim)).blockedBy).toBe(null);
    expect(sight(sim.ctx, 20, 30, 1.6, 120, 30, 1.2).blockedBy).toBe(null);
  });

  it("a grenade landing on the hull's roof ends on the ground beside it", () => {
    const sim = createSim(vehicleInput());
    const shooter = [...sim.state.identity.keys()].find((id) => sim.state.soldier.req(id).mount === undefined)!;
    launchProjectile(sim.ctx, sim.state, "bomb", 50, 100, 6, 0, 0, -1, shooter);
    run(sim, 1);
    const P = sim.state.projectiles;
    expect(P.count).toBeGreaterThan(0);
    const t = sim.state.transform.req(vidOf(sim));
    const o = hullObb(testCatalog.vehicles["tank"]!, t.x, t.y, t.heading);
    expect(pointInObb(o, P.x[0]!, P.y[0]!)).toBe(false);
    expect(P.z[0]!).toBeLessThan(0.5);
  });

  it("men are moved out of a hull they walk into", () => {
    const input = vehicleInput(1, 30);
    const own = team("own", 1);
    input.forces[0]!.units.push(own);
    input.forces[0]!.placements.push({ personId: "own.0", x: 30, y: 100, heading: 0 });
    const sim = createSim(input);
    const ownId = [...sim.state.identity.entries()].find(([, i]) => i.personId === "own.0")![0];
    submitOrder(sim, { tick: 0, issuer: "blue", target: ownId, kind: "move", waypoints: [{ x: 70, y: 100, mode: "walk" }] });
    const o = hullObb(testCatalog.vehicles["tank"]!, 50, 100, 0);
    let inside = false;
    run(sim, 30, undefined, () => { const t = sim.state.transform.req(ownId); if (pointInObb(o, t.x, t.y, 0.2)) inside = true; });
    expect(inside).toBe(false);
  });
});

describe("navFor", () => {
  it("vehicle classes use the clearance grid", () => {
    const sim = createSim(vehicleInput());
    expect(navFor(sim.ctx, "tracked").grid.clearanceCells).toBe(1);
    expect(navFor(sim.ctx, "foot").grid.clearanceCells).toBe(0);
  });
});

describe("men aboard and their own weapons (gates)", () => {
  function withRiflemen(): { sim: Sim; shooter: number; crew: number[] } {
    const input = vehicleInput(1, 120);
    const crew = input.forces[0]!.units[0]!;
    for (const m of crew.members) { m.weapon = "rifle"; m.load = [{ type: "mag", count: 3, charge: 30 }]; }
    const fire = team("fire", 1);
    fire.members[0]!.weapon = "rifle";
    const plt: UnitInput = { key: "plt", callsign: "Plt", echelon: "platoon", leaderIndex: 0, members: [], subunits: [crew, fire] };
    input.forces[0]!.units = [plt];
    input.forces[0]!.placements = [{ personId: "fire.0", x: 20, y: 102.5, heading: 0 }];
    input.forces[0]!.vehiclePlacements = [{ vehicleId: "v1", x: 60, y: 100, heading: 0 }];
    const sim = createSim(input);
    const shooter = [...sim.state.identity.entries()].find(([, i]) => i.personId === "fire.0")![0];
    const crewIds = [...sim.state.identity.entries()].filter(([, i]) => i.personId.startsWith("crew.")).map(([id]) => id);
    return { sim, shooter, crew: crewIds };
  }

  it("riflemen fire past a friendly vehicle with men aboard (men behind armour never block a comrade's fire)", () => {
    const { sim, shooter } = withRiflemen();
    submitOrder(sim, { tick: 0, issuer: "blue", target: shooter, kind: "fire", x: 300, y: 102.5 });
    const ev = run(sim, 15);
    expect(ev.filter((e) => e.kind === "shot.fired" && e.shooter === shooter).length).toBeGreaterThan(2);
  });

  it("a seated crewman's rifle starts no reload in a lull, and he takes no fire task", () => {
    const { sim, crew } = withRiflemen();
    for (const id of crew) { const w = sim.state.weapon.req(id); if (w.magazine) w.magazine.rounds = 5; }
    submitOrder(sim, { tick: 0, issuer: "blue", target: crew[0]!, kind: "fire", x: 300, y: 100 });
    const ev = run(sim, 30);
    expect(ev.some((e) => e.kind === "action.started" && crew.includes(e.actor))).toBe(false);
    expect(crew.some((id) => sim.state.fire.has(id))).toBe(false);
  });
});
