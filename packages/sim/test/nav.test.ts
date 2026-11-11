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

  it("reports no route to a fully enclosed goal, and snaps a blocked goal to the nearest open cell", () => {
    const m = flatMap("w", 100, 60, 4);
    m.obstacles.push({ id: 1, kind: "concrete", points: [60, 20, 80, 20, 80, 40, 60, 40, 60, 20], heightM: 2, thicknessM: 0.2, material: "brick" });
    const s = createNavSearch(buildNavGrid(m, T, "foot"));
    expect(findPath(s, 10, 10, 70, 30)).toBeNull();
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
