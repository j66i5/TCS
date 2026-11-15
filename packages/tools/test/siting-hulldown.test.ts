/** Hull-down posts for tanks (M7.6b, `siteHullDown`): turret over a crest, hull hidden, standoff from threats. */
import { describe, expect, it } from "vitest";
import { HULL_DOWN, siteHullDown, type HullDownOpts } from "@tcs/ai";
import { vehicleBattle } from "@tcs/scenario";
import { createSim, heightAt, hypot2, sight, type SimContext } from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData();

/** A flat 2400 x 1200 m field with a 2 m bank from x 1000 to 1012 m across it. */
function ridgeCtx(): SimContext {
  const input = vehicleBattle(data, { seed: 3, factions: ["de", "ru"], vehiclesPerPlatoon: 1, mapWidthM: 2400, mapHeightM: 1200, timeLimitSeconds: 60 });
  const m = input.map, w = m.cols + 1;
  for (let r = 0; r <= m.rows; r++) for (let c = 0; c <= m.cols; c++) { const x = c * m.cellSizeM; if (x >= 1000 && x <= 1012) m.heights[r * w + c] = 2; }
  return createSim(input).ctx;
}

describe("siteHullDown (M7.6b)", () => {
  const ctx = ridgeCtx();
  const leo = ctx.catalog.vehicles["de-leopard2a7v"]!;
  let turretZ = 0;
  for (const s of leo.seats) for (const k of s.sensors ?? []) turretZ = Math.max(turretZ, k.pos?.[2] ?? 0);
  const hullZ = leo.signature!.aimPoints[0]![2];
  const targets: { x: number; y: number }[] = [];
  for (let k = 0; k < 16; k++) targets.push({ x: 1800 + (k % 4) * 60, y: 450 + Math.floor(k / 4) * 100 });
  const opts = (over: Partial<HullDownOpts> = {}): HullDownOpts => ({ cls: leo.class, turretZ, hullZ, rangeM: [300, 2000], threats: [], standoffM: 250, ...over });
  const anchor = { x: 900, y: 600 };

  it("picks a post whose turret sees most targets while its hull is hidden from them", () => {
    const posts = siteHullDown(ctx, anchor, targets, opts());
    expect(posts.length).toBeGreaterThan(0);
    const p = posts[0]!;
    expect(p.exposed).toBeUndefined();
    expect(p.x).toBeLessThan(1000); // behind the bank
    const g = heightAt(ctx.map, p.x, p.y);
    let seen = 0, hidden = 0;
    for (const t of targets) {
      const tg = heightAt(ctx.map, t.x, t.y);
      if (sight(ctx, p.x, p.y, g + turretZ, t.x, t.y, tg + HULL_DOWN.targetHullZ).visibility < HULL_DOWN.seenVisibility) continue;
      seen++;
      const b = sight(ctx, t.x, t.y, tg + HULL_DOWN.enemyEyeZ, p.x, p.y, g + hullZ);
      if (b.blockedBy !== null || b.visibility < HULL_DOWN.seenVisibility) hidden++;
    }
    expect(seen / targets.length).toBeGreaterThanOrEqual(0.6);
    expect(hidden / Math.max(1, seen)).toBeGreaterThanOrEqual(0.5);
    // Alternates 30-150 m from it and from each other, all facing the targets.
    expect(posts.length).toBeGreaterThan(1);
    for (const q of posts.slice(1)) {
      const d = hypot2(q.x - p.x, q.y - p.y);
      expect(d).toBeGreaterThanOrEqual(30);
      expect(d).toBeLessThanOrEqual(150);
      expect(Math.cos(q.facing)).toBeGreaterThan(0.9); // east
    }
    // Deterministic.
    expect(siteHullDown(ctx, anchor, targets, opts())).toEqual(posts);
  });

  it("never within the standoff of a threat; flagged exposed when every candidate is", () => {
    const threats = [{ x: 1000, y: 600 }];
    const posts = siteHullDown(ctx, anchor, targets, opts({ threats }));
    expect(posts.length).toBeGreaterThan(0);
    for (const p of posts) { expect(hypot2(p.x - 1000, p.y - 600)).toBeGreaterThanOrEqual(250); expect(p.exposed).toBeUndefined(); }
    const all = siteHullDown(ctx, anchor, targets, opts({ threats: [anchor], standoffM: 1000 }));
    expect(all.length).toBeGreaterThanOrEqual(1);
    for (const p of all) expect(p.exposed).toBe(true);
    expect(hypot2(all[0]!.x - anchor.x, all[0]!.y - anchor.y)).toBeGreaterThan(200); // the farthest ring
  });

  it("stays on its own side of a line when told to", () => {
    const posts = siteHullDown(ctx, anchor, targets, opts({ behind: { x: 950, y: 600, ux: -1, uy: 0, minM: 50 } }));
    for (const p of posts) expect(p.x).toBeLessThanOrEqual(900 + 1e-6);
  });
});
