import { describe, expect, it } from "vitest";
import { buildNavGrid, createNavSearch, findPath, flatMap, navCostAt, type MapDef } from "../src/index";
import { testCatalog } from "./helpers";

const T = {
  ...testCatalog.terrain,
  obstacles: {
    ...testCatalog.terrain.obstacles,
    concrete: { ...testCatalog.terrain.obstacles["wall"]!, id: "concrete", footCrossTimeS: null },
  },
};

/** 100 x 60 m field with a north-south wall at x = 50 from y = 0 to y = `wallTo`, gap below it. */
function walled(kind: string, wallTo: number): MapDef {
  const m = flatMap("w", 100, 60, 4);
  m.obstacles.push({ id: 1, kind, points: [50, 0, 50, wallTo], heightM: 2, thicknessM: 0.25, material: "brick" });
  return m;
}

function crossesX(points: number[], sx: number, x: number): number[] {
  // y values where the path crosses the line x = const
  const ys: number[] = [];
  let px = sx, py = 10;
  for (let i = 0; i < points.length; i += 2) {
    const qx = points[i]!, qy = points[i + 1]!;
    if ((px - x) * (qx - x) <= 0 && px !== qx) ys.push(py + ((x - px) * (qy - py)) / (qx - px));
    px = qx; py = qy;
  }
  return ys;
}

describe("navigation", () => {
  it("goes through a nearby gate rather than climbing the wall", () => {
    // Gap from y = 40 to 60. From (10,30) to (90,30): via the gate ~84 m, straight over ~80 m + 8 m climbing.
    const nav = buildNavGrid(walled("wall", 40), T, "foot");
    const p = findPath(createNavSearch(nav), 10, 30, 90, 30)!;
    expect(p).not.toBeNull();
    const ys = crossesX(p.points, 10, 50).map((y) => y + 20); // crossesX assumes start y = 10
    expect(ys.length).toBeGreaterThan(0);
    for (const y of ys) expect(y).toBeGreaterThan(40);
  });

  it("climbs the wall when the gate is a long detour", () => {
    const m = flatMap("w", 100, 400, 4);
    m.obstacles.push({ id: 1, kind: "wall", points: [50, 0, 50, 380], heightM: 2, thicknessM: 0.25, material: "brick" });
    const p = findPath(createNavSearch(buildNavGrid(m, T, "foot")), 10, 10, 90, 10)!;
    const ys = crossesX(p.points, 10, 50);
    expect(ys.length).toBeGreaterThan(0);
    for (const y of ys) expect(y).toBeLessThan(40);
  });

  it("cannot climb a wall without a crossing time; goes round it", () => {
    const p = findPath(createNavSearch(buildNavGrid(walled("concrete", 40), T, "foot")), 10, 10, 90, 10)!;
    for (const y of crossesX(p.points, 10, 50)) expect(y).toBeGreaterThan(40);
  });

  it("goes as close as it can to an enclosed goal, and snaps a blocked goal to the nearest open cell", () => {
    const m = flatMap("w", 100, 60, 4);
    m.obstacles.push({ id: 1, kind: "concrete", points: [60, 20, 80, 20, 80, 40, 60, 40, 60, 20], heightM: 2, thicknessM: 0.2, material: "brick" });
    const s = createNavSearch(buildNavGrid(m, T, "foot"));
    const near = findPath(s, 10, 10, 70, 30)!;
    expect(near).not.toBeNull();
    const inside = near.goalX > 60 && near.goalX < 80 && near.goalY > 20 && near.goalY < 40;
    expect(inside).toBe(false);
    expect(findPath(s, 10, 10, 70, 30, { snapCells: 2 })).toBeNull();
    const m2 = flatMap("p", 100, 60, 4);
    m2.surfacePalette = ["grass", "water"];
    for (let c = 15; c < 20; c++) for (let r = 5; r < 10; r++) m2.surface[r * m2.cols + c] = 1; // pond 60..80 x 20..40
    const p = findPath(createNavSearch(buildNavGrid(m2, T, "foot")), 10, 10, 70, 30)!;
    expect(p).not.toBeNull();
    expect(navCostAt(buildNavGrid(m2, T, "foot"), p.goalX, p.goalY)).toBeGreaterThan(0);
  });

  it("is deterministic and reuses its scratch memory across searches", () => {
    const s = createNavSearch(buildNavGrid(walled("wall", 40), T, "foot"));
    const a = findPath(s, 10, 10, 90, 10)!;
    findPath(s, 90, 50, 5, 5);
    const b = findPath(s, 10, 10, 90, 10)!;
    expect(b.points).toEqual(a.points);
    expect(b.cost).toBe(a.cost);
  });
});

import { buildSpatialHash, createSim, queryRadius } from "../src/index";
import { testInput } from "./helpers";

describe("spatial hash", () => {
  it("finds exactly the soldiers within a radius, in ID order, matching a brute-force scan", () => {
    const sim = createSim(testInput());
    const h = buildSpatialHash(sim.state, 8);
    for (const [x, y, r] of [[10, 10, 6], [10, 15, 100], [190, 12, 4], [100, 100, 5]] as const) {
      const brute = [...sim.state.transform.entries()].filter(([, t]) => (t.x - x) ** 2 + (t.y - y) ** 2 <= r * r).map(([id]) => id);
      expect(queryRadius(h, sim.state, x, y, r)).toEqual(brute);
    }
  });
});

import { clearLine, lineCost, step, submitOrder } from "../src/index";

describe("navigation review fixes", () => {
  it("a straight line never slips through a diagonal wall (every crossed cell and corner is checked)", () => {
    const m = flatMap("d", 100, 100, 4);
    m.obstacles.push({ id: 1, kind: "concrete", points: [0, 0, 100, 100], heightM: 2, thicknessM: 0.2, material: "brick" });
    const nav = buildNavGrid(m, T, "foot");
    let through = 0;
    for (let k = 0; k < 2000; k++) {
      const s = 8 + (k * 84) / 2000; // points along the wall; each line crosses it from one side to the other
      const j1 = (k % 13) * 0.071, j2 = (k % 7) * 0.113;
      if (clearLine(nav, s - 6 + j1, s + 6, s + 6, s - 6 - j2)) through++;
    }
    expect(through).toBe(0);
  });

  it("rejects an unreachable goal at once instead of searching the whole map", () => {
    const m = flatMap("e", 2000, 2000, 4);
    m.obstacles.push({ id: 1, kind: "concrete", points: [1000, 1000, 1040, 1000, 1040, 1040, 1000, 1040, 1000, 1000], heightM: 2, thicknessM: 0.2, material: "brick" });
    const s = createNavSearch(buildNavGrid(m, T, "foot"));
    const t0 = performance.now();
    const p = findPath(s, 10, 10, 1020, 1020, { snapCells: 4 });
    expect(p).toBeNull();
    expect(performance.now() - t0).toBeLessThan(20);
  });

  it("smoothed routes never cost more than the planned route (within 2 %)", () => {
    const m = flatMap("c", 200, 200, 4);
    m.surfacePalette = ["grass", "water"];
    const slow = { ...T, surfaces: { ...T.surfaces, mud: { ...T.surfaces["grass"]!, id: "mud", moveCost: { foot: 3, wheeled: null, tracked: 3 } } } };
    m.surfacePalette = ["grass", "mud"];
    for (let r = 0; r < m.rows; r++) for (let c = 10; c < 40; c++) if (r % 7 !== 0) m.surface[r * m.cols + c] = 1; // mud with firm lanes
    const nav = buildNavGrid(m, slow, "foot");
    const s = createNavSearch(nav);
    for (const [ax, ay, bx, by] of [[5, 5, 195, 190], [5, 100, 195, 20], [190, 5, 10, 195]] as const) {
      const p = findPath(s, ax, ay, bx, by)!;
      let px = ax, py = ay, total = 0;
      for (let i = 0; i < p.points.length; i += 2) { total += lineCost(nav, px, py, p.points[i]!, p.points[i + 1]!); px = p.points[i]!; py = p.points[i + 1]!; }
      expect(total).toBeLessThanOrEqual(p.cost * 1.02 + 2 * nav.cellM * p.points.length);
    }
  });

  it("an order with no route: the team stays, says so on the radio, and a move.noRoute event is emitted", () => {
    const input = testInput();
    input.map = flatMap("enclosed", 200, 200, 4);
    // A walled compound far bigger than the goal-snapping radius (24 m): its centre cannot be reached.
    input.map.obstacles.push({ id: 1, kind: "wall", points: [60, 60, 180, 60, 180, 180, 60, 180, 60, 60], heightM: 2, thicknessM: 0.2, material: "brick" });
    input.catalog = { ...input.catalog, terrain: { ...T } };
    input.map.obstacles[0]!.kind = "concrete";
    const sim = createSim(input);
    const unit = [...sim.state.unit.entries()].find(([, u]) => u.side === "blue")![0];
    const before = sim.state.unit.req(unit).members.map((id) => ({ ...sim.state.transform.req(id) }));
    submitOrder(sim, { tick: 0, issuer: "blue", target: unit, kind: "move", waypoints: [{ x: 120, y: 120, mode: "walk" }] });
    const ev = [];
    for (let i = 0; i < 200; i++) ev.push(...step(sim));
    expect(ev.some((e) => e.kind === "move.noRoute")).toBe(true);
    expect(ev.find((e) => e.kind === "radio")).toMatchObject({ key: "radio.noRoute" });
    sim.state.unit.req(unit).members.forEach((id, i) => expect(sim.state.transform.req(id)).toEqual(before[i]));
  });
});
