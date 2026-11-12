/** M7.5a: the order bar docks to the nearest edge; the choice is remembered per device, safely. */
import { describe, expect, it } from "vitest";
import { DOCK_KEY, defaultEdge, loadEdge, nearestEdge, saveEdge, sidebarSide } from "../src/dock";

describe("dock", () => {
  it("nearest edge of the point where the grip is let go", () => {
    expect(nearestEdge(200, 830, 390, 844)).toBe("bottom");
    expect(nearestEdge(200, 10, 390, 844)).toBe("top");
    expect(nearestEdge(5, 400, 390, 844)).toBe("left");
    expect(nearestEdge(385, 400, 390, 844)).toBe("right");
    expect(nearestEdge(195, 422, 390, 844)).toBe("right"); // the middle of a phone: nearer the sides (ties: bottom, right)
    expect(nearestEdge(640, 400, 1280, 800)).toBe("bottom");
  });
  it("default: bottom upright, right sideways", () => {
    expect(defaultEdge(390, 844)).toBe("bottom");
    expect(defaultEdge(844, 390)).toBe("right");
    expect(defaultEdge(800, 800)).toBe("bottom");
  });
  it("remembered in storage; unavailable or throwing storage is harmless", () => {
    const m = new Map<string, string>();
    const st = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
    expect(loadEdge(st)).toBeNull();
    saveEdge(st, "left");
    expect(m.get(DOCK_KEY)).toBe("left");
    expect(loadEdge(st)).toBe("left");
    m.set(DOCK_KEY, "diagonal");
    expect(loadEdge(st)).toBeNull();
    const bad = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(loadEdge(bad)).toBeNull();
    expect(() => saveEdge(bad, "top")).not.toThrow();
    expect(loadEdge(null)).toBeNull();
  });
  it("the sidebar moves right when the bar docks left", () => {
    expect(sidebarSide("left")).toBe("right");
    for (const e of ["bottom", "top", "right"] as const) expect(sidebarSide(e)).toBe("left");
  });
});
