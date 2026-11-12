/** M7.5a: label decluttering — placed labels never overlap; the selected unit's always placed. */
import { describe, expect, it } from "vitest";
import { labelWidth, placeLabels, type LabelRequest } from "../src/labels";

const req = (text: string, x: number, y: number, priority = 2, id = 0, r = 6): LabelRequest => ({ text, x, y, r, colour: 0xffffff, priority, id, block: r });
const overlap = (a: { x: number; y: number; w: number; h: number }, b: typeof a) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("placeLabels", () => {
  it("a tight column of hulls (the owner's overlapping labels): no two placed labels overlap", () => {
    const reqs = Array.from({ length: 16 }, (_, i) => req(`Puma ${i + 1} +6`, 200 + (i % 2) * 4, 300 + i * 9, 2, 100 + i));
    const placed = placeLabels(reqs, 390, 844);
    expect(placed.length).toBeGreaterThan(3);
    expect(placed.length).toBeLessThan(16); // some must be dropped
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(overlap(placed[i]!, placed[j]!)).toBe(false);
  });
  it("labels stay off other labelled symbols, but may sit beside their own", () => {
    const reqs = [req("A", 100, 100, 2, 1), req("B", 130, 100, 2, 2)];
    const placed = placeLabels(reqs, 400, 400);
    for (const p of placed) {
      const other = reqs[1 - p.index]!;
      expect(overlap(p, { x: other.x - 6, y: other.y - 6, w: 12, h: 12 })).toBe(false);
    }
  });
  it("the selected unit's label is placed first, whatever the ids", () => {
    const reqs = Array.from({ length: 30 }, (_, i) => req(`Trupp ${i}`, 150 + (i % 3), 300 + (i % 4), 2, i));
    reqs.push(req("SELECTED", 151, 301, 0, 999));
    const placed = placeLabels(reqs, 390, 844);
    expect(placed.some((p) => p.index === reqs.length - 1)).toBe(true);
  });
  it("labels avoid the HUD's areas, and off-screen anchors cost nothing", () => {
    const placed = placeLabels([req("edge", 318, 400), req("far", 5000, 400)], 390, 844, [{ x: 326, y: 0, w: 64, h: 844 }]);
    expect(placed.length).toBe(1);
    expect(placed[0]!.x + placed[0]!.w).toBeLessThanOrEqual(326);
  });
  it("forced (debug) labels keep their place; width is chars x 7", () => {
    const placed = placeLabels([{ text: "debug", x: 10, y: 20, r: 0, colour: 0, priority: -1, id: 0, force: true }], 100, 100);
    expect(placed[0]).toMatchObject({ x: 10, y: 20, w: labelWidth("debug") });
    expect(labelWidth("abc")).toBe(23);
  });
  it("is deterministic and repeatable across frames (grid stamps)", () => {
    const reqs = Array.from({ length: 40 }, (_, i) => req(`U${i}`, (i * 37) % 390, (i * 53) % 844, 2, i));
    const a = placeLabels(reqs, 390, 844).map((p) => [p.index, p.x, p.y]);
    const b = placeLabels(reqs, 390, 844).map((p) => [p.index, p.x, p.y]);
    expect(b).toEqual(a);
  });
});
