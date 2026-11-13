/** Building interiors (M7.5c): sight, projectiles, blast, breaches and routes with inner walls and floor slabs. */
import { describe, expect, it } from "vitest";
import {
  buildNavGrid, createSim, hashState, indoorAt, launchProjectile, lineBlocked, mapFromFile, mapToFile, mapFingerprint, routeBetween, sight, step, submitOrder,
  syncTerrainDamage, validateMap, buildInteriorGraph, navFor, stripInteriors, type Building, type MapDef, type Sim, type SimEvent,
} from "../src/index";
import { testCatalog, testInput } from "./helpers";

/** A two-storey house 12 x 10 m, two rooms split by an inner wall at x = 106 with a doorway at y = 85. */
function house(): Building {
  const fp = [100, 80, 112, 80, 112, 90, 100, 90];
  const west = [100, 80, 106, 80, 106, 90, 100, 90], east = [106, 80, 112, 80, 112, 90, 106, 90];
  return {
    id: 1, kind: "house", footprint: fp, storeys: 2, storeyHeightM: 2.8, wallMaterial: "brick", wallThicknessM: 0.3, roofColour: "#8c4a3b",
    openings: [
      { wall: 3, offsetM: 3, widthM: 1.0, kind: "door", sillM: 0, headM: 2.1 }, // west wall (100,90)->(100,80): y = 87
      { wall: 1, offsetM: 5, widthM: 1.2, kind: "window", sillM: 0.9, headM: 2.1, floor: 1 }, // east wall upstairs: y = 85
    ],
    interior: {
      rooms: [0, 1].flatMap((fl) => [{ id: fl * 2, floor: fl, poly: west, kind: "hall" as const }, { id: fl * 2 + 1, floor: fl, poly: east, kind: "room" as const }]),
      walls: [0, 1].map((fl) => ({ id: fl, floor: fl, ax: 106, ay: 80, bx: 106, by: 90, thicknessM: 0.12, material: "brick", doors: [{ offsetM: 5, widthM: 0.9, headM: 2 }] })),
      stairs: [{ id: 0, floor: 0, room: 0, x0: 101, y0: 81, x1: 104.5, y1: 81, widthM: 1 }],
    },
  };
}

function houseMap(withInterior = true): MapDef {
  const m: MapDef = { ...testInput().map };
  m.buildings = [house()];
  return withInterior ? m : stripInteriors(m);
}

function simWith(m: MapDef): Sim {
  const input = testInput(1, 600);
  input.map = m;
  return createSim(input);
}

function run(sim: Sim, ticks: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < ticks; i++) out.push(...step(sim));
  return out;
}

describe("interiors: map", () => {
  it("validates, round-trips as format 2, and strips back to format 1", () => {
    const m = houseMap();
    expect(validateMap(m, testCatalog.terrain)).toEqual([]);
    const f = mapToFile(m);
    expect(f.formatVersion).toBe(2);
    expect(mapFingerprint(mapFromFile(f))).toBe(mapFingerprint(m));
    expect(mapToFile(houseMap(false)).formatVersion).toBe(1);
    expect(houseMap(false).buildings[0]!.openings).toHaveLength(1);
  });

  it("reports an unreachable room and a room outside the footprint", () => {
    const m = houseMap();
    m.buildings[0]!.interior!.walls[0]!.doors = [];
    expect(validateMap(m, testCatalog.terrain).some((p) => p.includes("cannot be reached"))).toBe(true);
    const m2 = houseMap();
    m2.buildings[0]!.interior!.rooms[1]!.poly = [106, 80, 115, 80, 115, 90, 106, 90];
    expect(validateMap(m2, testCatalog.terrain).some((p) => p.includes("not convex inside"))).toBe(true);
  });

  it("the outdoor navigation grid is the same with and without interiors", () => {
    const a = buildNavGrid(houseMap(), testCatalog.terrain, "foot"), b = buildNavGrid(houseMap(false), testCatalog.terrain, "foot");
    expect(Array.from(a.cost)).toEqual(Array.from(b.cost));
    expect(Array.from(a.wall)).toEqual(Array.from(b.wall));
  });
});

describe("interiors: sight, projectiles, blast", () => {
  it("sees through the doorway, not through the inner wall beside it", () => {
    const sim = simWith(houseMap());
    expect(sight(sim.ctx, 103, 85, 1.6, 109, 85, 1.2).blockedBy).toBe(null);
    expect(sight(sim.ctx, 103, 82, 1.6, 109, 82, 1.2).blockedBy).toBe("wall");
    // Without the interior, one hollow shell: the same line is clear.
    expect(sight(simWith(houseMap(false)).ctx, 103, 82, 1.6, 109, 82, 1.2).blockedBy).toBe(null);
  });

  it("the floor between the storeys blocks sight; the upstairs window lets it through", () => {
    const sim = simWith(houseMap());
    expect(sight(sim.ctx, 103, 82, 1.6, 103, 88, 4.4).blockedBy).toBe("roof");
    expect(sight(sim.ctx, 130, 85, 4.2, 110, 85, 4.2).blockedBy).toBe(null); // in through the upstairs window
    expect(sight(sim.ctx, 130, 83, 4.2, 110, 83, 4.2).blockedBy).toBe("wall"); // beside it
    expect(sight(sim.ctx, 130, 85, 1.5, 110, 85, 1.5).blockedBy).toBe("wall"); // no window downstairs
  });

  it("a bullet is stopped by the inner wall, and passes the doorway to the outer wall", () => {
    const sim = simWith(houseMap());
    launchProjectile(sim.ctx, sim.state, "ball", 101, 82, 1.5, 900, 0, 0, 1);
    launchProjectile(sim.ctx, sim.state, "ball", 101, 85, 1.5, 900, 0, 0, 2);
    const hits = run(sim, 10).filter((e): e is Extract<SimEvent, { kind: "impact" }> => e.kind === "impact" && e.surface === "building");
    expect(hits.filter((h) => h.owner === 1)[0]!.x).toBeCloseTo(106, 3);
    expect(hits.filter((h) => h.owner === 2)[0]!.x).toBeCloseTo(112, 3);
  });

  it("a bullet fired up into the floor above strikes the slab", () => {
    const sim = simWith(houseMap());
    launchProjectile(sim.ctx, sim.state, "ball", 103, 84, 1.5, 0, 0, 900, 1);
    const hits = run(sim, 5).filter((e): e is Extract<SimEvent, { kind: "impact" }> => e.kind === "impact" && e.surface === "building");
    expect(hits[0]!.z).toBeCloseTo(2.8, 3);
  });

  it("lineBlocked: inner walls and slabs shield a blast", () => {
    const sim = simWith(houseMap());
    const B = sim.ctx.ballistics, m = sim.ctx.map, ix = sim.ctx.mapIndex;
    expect(lineBlocked(B, m, ix, 103, 82, 1, 109, 82, 1)).toBe(true);
    expect(lineBlocked(B, m, ix, 103, 85, 1, 109, 85, 1)).toBe(false);
    expect(lineBlocked(B, m, ix, 103, 82, 1, 103, 83, 4)).toBe(true);
  });
});

describe("interiors: routes", () => {
  it("routes from outside to the far room through the front door and the doorway, never through a wall", () => {
    const sim = simWith(houseMap());
    expect(indoorAt(sim.ctx, 109, 85)).toBe(0);
    expect(indoorAt(sim.ctx, 90, 85)).toBe(-1);
    const r = routeBetween(sim.ctx, navFor(sim.ctx, "foot").search, 90, 87, 109, 82)!;
    expect(r).not.toBeNull();
    expect(r.goalX).toBe(109);
    const pts = [90, 87, ...r.points];
    for (let k = 0; k + 3 < pts.length; k += 2) {
      expect(lineBlocked(sim.ctx.ballistics, sim.ctx.map, sim.ctx.mapIndex, pts[k]!, pts[k + 1]!, 1, pts[k + 2]!, pts[k + 3]!, 1), `leg ${k / 2}`).toBe(false);
    }
    // And back out again, symmetric.
    const back = routeBetween(sim.ctx, navFor(sim.ctx, "foot").search, 109, 82, 90, 87)!;
    expect(back.goalX).toBe(90);
  });

  it("outdoor routes are exactly findPath's", () => {
    const sim = simWith(houseMap()), sim0 = simWith(houseMap(false));
    const a = routeBetween(sim.ctx, navFor(sim.ctx, "foot").search, 90, 70, 125, 95)!;
    const b = routeBetween(sim0.ctx, navFor(sim0.ctx, "foot").search, 90, 70, 125, 95)!;
    expect(a.points).toEqual(b.points);
  });

  it("a breach in the inner wall opens a new way; the graph is rebuilt", () => {
    const sim = simWith(houseMap());
    const before = buildInteriorGraph(sim.ctx.map.buildings[0]!, 0, []);
    sim.state.terrain.breaches.push({ owner: "building", id: 1, part: 4, offsetM: 1.5, widthM: 1.2, tick: 0 });
    syncTerrainDamage(sim.ctx, sim.state);
    const after = buildInteriorGraph(sim.ctx.map.buildings[0]!, 0, sim.state.terrain.breaches);
    expect(after.nodes.length).toBe(before.nodes.length + 2);
    // Sight now passes the hole too.
    expect(sight(sim.ctx, 103, 81.5, 1.6, 109, 81.5, 1.2).blockedBy).toBe(null);
  });

  it("a squad ordered into the house walks in by the door and ends in the rooms; out again by the door", () => {
    const sim = simWith(houseMap());
    const unit = [...sim.state.unit.entries()].find(([, u]) => u.side === "blue")![0];
    submitOrder(sim, { tick: 0, issuer: "blue", target: unit, kind: "move", waypoints: [{ x: 109, y: 85, mode: "walk" }] });
    run(sim, 60 * 120);
    const men = [...sim.state.soldier.keys()].filter((id) => sim.state.identity.get(id)?.side === "blue");
    for (const id of men) {
      const t = sim.state.transform.req(id);
      expect(indoorAt(sim.ctx, t.x, t.y), `man ${id} at ${t.x.toFixed(1)}, ${t.y.toFixed(1)}`).toBe(0);
    }
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: unit, kind: "move", waypoints: [{ x: 80, y: 87, mode: "walk" }] });
    run(sim, 60 * 90);
    for (const id of men) {
      const t = sim.state.transform.req(id);
      expect(indoorAt(sim.ctx, t.x, t.y)).toBe(-1);
      expect(t.x).toBeLessThan(100);
    }
  });

  it("is deterministic (same hash twice)", () => {
    const go = () => {
      const sim = simWith(houseMap());
      const unit = [...sim.state.unit.entries()].find(([, u]) => u.side === "blue")![0];
      submitOrder(sim, { tick: 0, issuer: "blue", target: unit, kind: "move", waypoints: [{ x: 109, y: 85, mode: "walk" }] });
      run(sim, 60 * 40);
      return hashState(sim.state);
    };
    expect(go()).toBe(go());
  });
});
