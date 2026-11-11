import { describe, expect, it } from "vitest";
import { fitCamera, screenToWorld, worldToScreen, zoomAt } from "../src/camera";

describe("camera", () => {
  it("world <-> screen round trip", () => {
    const c = { x: 10, y: -5, scale: 2.5 };
    const s = worldToScreen(c, 123, 45);
    const w = screenToWorld(c, s.x, s.y);
    expect(w.x).toBeCloseTo(123, 9);
    expect(w.y).toBeCloseTo(45, 9);
  });
  it("fits the map inside the area left free by the HUD", () => {
    const c = fitCamera(400, 300, 1280, 800, { top: 50, right: 0, bottom: 64, left: 0 });
    const tl = worldToScreen(c, 0, 0), br = worldToScreen(c, 400, 300);
    expect(tl.y).toBeGreaterThanOrEqual(50);
    expect(br.y).toBeLessThanOrEqual(800 - 64);
    expect(tl.x).toBeGreaterThanOrEqual(0);
    expect(br.x).toBeLessThanOrEqual(1280);
  });
  it("zoom keeps the point under the finger fixed", () => {
    const c = { x: 0, y: 0, scale: 1 };
    const before = screenToWorld(c, 200, 100);
    const z = zoomAt(c, 200, 100, 2);
    const after = screenToWorld(z, 200, 100);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    expect(z.scale).toBe(2);
  });
});
