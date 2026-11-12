/** M5.2: the order planner — formation marker geometry, handles, dragging, the order it makes. */
import { describe, expect, it } from "vitest";
import { addPoint, dragTo, hitHandle, markerGeometry, newPlan, planToOrder, undoPoint } from "../src/planner";

const LINE = [[0, 0], [-1, 0], [1, 0], [-2, 0], [2, 0]] as const;
const WEDGE = [[0, 0], [-0.71, 0.71], [0.71, 0.71], [-1.42, 1.42], [1.42, 1.42]] as const;

describe("order planner", () => {
  it("a line marker facing east, 40 m wide, stands its men across the facing, 40 m end to end", () => {
    let p = newPlan("move", { x: 0, y: 100 }, "line", 40);
    p = addPoint(p, 100, 100, "walk");
    const g = markerGeometry(p, LINE, 5, 10)!;
    expect(g.facing).toBeCloseTo(0);
    const ys = g.men.map((m) => m.y).sort((a, b) => a - b);
    expect(ys[4]! - ys[0]!).toBeCloseTo(40);
    for (const m of g.men) expect(m.x).toBeCloseTo(100);
  });

  it("a wedge marker: the leader in front, the others behind on both sides", () => {
    const p = addPoint(newPlan("move", { x: 0, y: 0 }, "wedge", 30), 50, 0, "run");
    const g = markerGeometry(p, WEDGE, 5, 10)!;
    expect(g.men[0]!.x).toBeCloseTo(50);
    for (const m of g.men.slice(1)) expect(m.x).toBeLessThan(50);
  });

  it("dragging: the body moves the point, the arrow turns the facing, the edge sets the width", () => {
    let p = addPoint(newPlan("move", { x: 0, y: 0 }, "line", 20), 50, 50, "walk");
    const g = markerGeometry(p, LINE, 5, 10)!;
    expect(hitHandle(p, g, g.rotate.x, g.rotate.y, 3)).toBe("rotate");
    expect(hitHandle(p, g, g.resize.x, g.resize.y, 3)).toBe("resize");
    expect(hitHandle(p, g, 50, 50, 3)).toBe("body");
    p = dragTo(p, "body", 60, 40);
    expect(p.points[0]).toMatchObject({ x: 60, y: 40 });
    p = dragTo(p, "rotate", 60, 0); // straight north of the point
    expect(p.facing).toBeCloseTo(-Math.PI / 2);
    p = dragTo(p, "resize", 60 + 23, 40); // 23 m across the facing (east): half width 20
    expect(p.frontageM).toBeCloseTo(40);
  });

  it("a route of several legs, each with its own pace, becomes one move order with facing and frontage; undo drops the last point", () => {
    let p = newPlan("move", { x: 0, y: 0 }, "wedge", 30);
    p = addPoint(p, 10, 0, "crawl");
    p = addPoint(p, 50, 0, "run");
    p = addPoint(p, 50, 30, "walk");
    p = undoPoint(p);
    const o = planToOrder(p, "blue", 7, 100)!;
    expect(o).toMatchObject({ kind: "move", tick: 100, issuer: "blue", target: 7, formation: "wedge", frontageM: 30 });
    if (o.kind !== "move") throw new Error("move");
    expect(o.waypoints.map((w) => w.mode)).toEqual(["crawl", "run"]);
    expect(o.facing).toBeCloseTo(0);
  });

  it("assault and withdraw keep one point and make their own orders", () => {
    let p = addPoint(newPlan("assault", { x: 0, y: 0 }, "line", 20), 10, 10, "run");
    p = addPoint(p, 80, 20, "run");
    expect(p.points).toHaveLength(1);
    expect(planToOrder(p, "blue", 3, 5)).toEqual({ tick: 5, issuer: "blue", target: 3, kind: "assault", x: 80, y: 20 });
  });
});
