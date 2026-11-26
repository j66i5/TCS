/** Review 2026-11-24 step 5, item 4: the battle opens on the player's force and the objectives. */
import { describe, expect, it } from "vitest";
import { edgeMarker, OPENING_MARGIN, OPENING_MAX_SCALE, OPENING_MIN_SCALE, OPENING_MIN_SPAN_M, openingView } from "../src/opening";

/** The free map areas of a phone upright, a phone sideways and a desktop (px). */
const FREE = { portrait: { w: 300, h: 600 }, landscape: { w: 640, h: 250 }, desktop: { w: 1100, h: 760 } };

function inside(v: { x: number; y: number; scale: number }, free: { w: number; h: number }, x: number, y: number, r = 0): boolean {
  const hw = free.w / v.scale / 2, hh = free.h / v.scale / 2;
  return x - r >= v.x - hw - 1e-6 && x + r <= v.x + hw + 1e-6 && y - r >= v.y - hh - 1e-6 && y + r <= v.y + hh + 1e-6;
}

describe("the opening view", () => {
  const force = [{ x: 150, y: 420 }, { x: 180, y: 460 }, { x: 140, y: 520 }, { x: 210, y: 380 }];
  const objectives = [{ x: 900, y: 430, radiusM: 40 }, { x: 960, y: 520, radiusM: 40 }];
  it("shows every own man and every objective where they fit at a readable scale, never closer than true scale", () => {
    for (const [name, free] of Object.entries(FREE)) {
      if (name === "portrait") continue; // (too far apart for an upright phone: the next test)
      const v = openingView(force, objectives, free)!;
      expect(v.whole, name).toBe(true);
      expect(v.scale, name).toBeGreaterThanOrEqual(OPENING_MIN_SCALE);
      expect(v.scale, name).toBeLessThanOrEqual(OPENING_MAX_SCALE);
      for (const p of force) expect(inside(v, free, p.x, p.y), name).toBe(true);
      for (const o of objectives) expect(inside(v, free, o.x, o.y, o.radiusM), name).toBe(true);
      // ... and not looser than needed: the box with its margin fills one of the two directions.
      const w = (1000 - 140) * (1 + 2 * OPENING_MARGIN), h = (560 - 380) * (1 + 2 * OPENING_MARGIN);
      expect(Math.max((w * v.scale) / free.w, (h * v.scale) / free.h), name).toBeCloseTo(1, 5);
    }
  });
  it("an upright phone, the objectives 800 m off: not the whole map as a band, but the force and the ground toward them", () => {
    const free = FREE.portrait;
    const v = openingView(force, objectives, free)!;
    expect(v.whole).toBe(false);
    expect(v.scale).toBeCloseTo(OPENING_MIN_SCALE, 9);
    for (const p of force) expect(inside(v, free, p.x, p.y)).toBe(true);
    // The force stands at the near edge (its margin kept), the rest of the width looks toward the objectives.
    const left = v.x - free.w / v.scale / 2, right = v.x + free.w / v.scale / 2;
    expect(140 - left).toBeCloseTo((210 - 140) * OPENING_MARGIN, 6);
    expect(right - 210).toBeGreaterThan(350);
    for (const o of objectives) expect(inside(v, free, o.x, o.y)).toBe(false);
    // The same from the other side (the objectives to the west).
    const w = openingView(force.map((p) => ({ x: 2000 - p.x, y: p.y })), objectives, free)!;
    expect(w.x).toBeLessThan(2000 - 175);
    // A force too wide for the minimum scale is still shown whole (a company along its edge).
    const wide = [{ x: 100, y: 100 }, { x: 110, y: 1300 }];
    const c = openingView(wide, [{ x: 1900, y: 700, radiusM: 40 }], FREE.landscape)!;
    expect(c.whole).toBe(false);
    for (const p of wide) expect(inside(c, FREE.landscape, p.x, p.y)).toBe(true);
    // The side moving through an ambush: its exit 1 km away stands for the objective.
    const t = openingView(force, [{ x: 1190, y: 445, radiusM: 0 }], FREE.landscape)!;
    expect(t.whole).toBe(false);
    expect(FREE.landscape.w / t.scale).toBeGreaterThan(1000);
  });
  it("a place outside the view is pointed at from the edge of the free area", () => {
    const rect = { x: 0, y: 44, w: 300, h: 600 };
    expect(edgeMarker({ x: 150, y: 300 }, rect)).toBeNull();
    const e = edgeMarker({ x: 900, y: 344 }, rect, 20)!;
    expect(e.x).toBeCloseTo(280, 6);
    expect(e.y).toBeCloseTo(344, 6);
    expect(e.angle).toBeCloseTo(0, 6);
    const n = edgeMarker({ x: 150, y: -500 }, rect, 20)!;
    expect(n.y).toBeCloseTo(64, 6);
    expect(n.angle).toBeCloseTo(-Math.PI / 2, 6);
    const d = edgeMarker({ x: 1000, y: 2000 }, rect, 20)!;
    expect(d.x).toBeLessThanOrEqual(280 + 1e-6);
    expect(d.y).toBeLessThanOrEqual(624 + 1e-6);
  });
  it("a defender on its objective: a close view, at least 150 m across the shorter side", () => {
    const squad = [{ x: 500, y: 500 }, { x: 505, y: 503 }];
    for (const [name, free] of Object.entries(FREE)) {
      const v = openingView(squad, [{ x: 502, y: 501, radiusM: 10 }], free)!;
      expect(Math.min(free.w, free.h) / v.scale, name).toBeGreaterThanOrEqual(OPENING_MIN_SPAN_M - 1e-6);
      expect(v.scale, name).toBeLessThanOrEqual(OPENING_MAX_SCALE);
      expect(v.x).toBeCloseTo(502, 0);
    }
    // A big screen is capped by the true scale, not by the minimum span.
    expect(openingView(squad, [], { w: 2400, h: 1400 })!.scale).toBe(OPENING_MAX_SCALE);
  });
  it("no objectives: the force and what stands for them (an ambush's range)", () => {
    const v = openingView(force, [{ x: 170, y: 445, radiusM: 220 }], FREE.portrait)!;
    expect(inside(v, FREE.portrait, 170, 445, 220)).toBe(true);
  });
  it("no own men: null (the caller fits the map)", () => {
    expect(openingView([], objectives, FREE.portrait)).toBeNull();
  });
});
