/**
 * Sight with building interiors (M7.5c, plan §5): lines of sight across the village cost at most ~10 % more with
 * interiors (inner walls and floor slabs are tested only for buildings a line crosses).
 */
import { describe, expect, it } from "vitest";
import { createSim, heightAt, sight, stripInteriors, type Sim } from "@tcs/sim";
import { getScenario, loadData } from "../src/scenarios";

describe("village sight with interiors", () => {
  it("costs at most about 10 % more than without", () => {
    const data = loadData();
    const input = getScenario("demo").build(data, 1, 60);
    const on = createSim(input), off = createSim({ ...input, map: stripInteriors(input.map) });
    // Pairs of points among the houses: around the buildings' centres, 20-300 m apart (a fixed LCG).
    const bs = input.map.buildings;
    let cx = 0, cy = 0;
    for (const b of bs) { cx += b.footprint[0]! / bs.length; cy += b.footprint[1]! / bs.length; }
    let s = 12345;
    const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
    const pts: number[] = [];
    for (let k = 0; k < 6000; k++) {
      const x0 = cx + (rnd() - 0.5) * 400, y0 = cy + (rnd() - 0.5) * 400;
      const a = rnd() * 6.283, d = 20 + rnd() * 280;
      pts.push(x0, y0, x0 + Math.cos(a) * d, y0 + Math.sin(a) * d);
    }
    const run = (sim: Sim) => {
      const map = sim.ctx.map;
      let n = 0;
      const t0 = performance.now();
      for (let k = 0; k < pts.length; k += 4) {
        const r = sight(sim.ctx, pts[k]!, pts[k + 1]!, heightAt(map, pts[k]!, pts[k + 1]!) + 1.6, pts[k + 2]!, pts[k + 3]!, heightAt(map, pts[k + 2]!, pts[k + 3]!) + 1.2);
        if (r.blockedBy === null) n++;
      }
      return { ms: performance.now() - t0, n };
    };
    run(on); run(off);
    let bestOn = Infinity, bestOff = Infinity, clearOn = 0, clearOff = 0;
    for (let rep = 0; rep < 7; rep++) {
      const a = run(off), b = run(on);
      bestOff = Math.min(bestOff, a.ms); bestOn = Math.min(bestOn, b.ms); clearOff = a.n; clearOn = b.n;
    }
    const ratio = bestOn / bestOff;
    console.log(`village sight: ${(pts.length / 4)} lines, without interiors ${bestOff.toFixed(1)} ms, with ${bestOn.toFixed(1)} ms (x${ratio.toFixed(3)}); clear ${clearOff} -> ${clearOn}`);
    expect(clearOn).toBeLessThanOrEqual(clearOff);
    expect(ratio).toBeLessThan(1.2); // target 1.10; a margin for timing noise
  });
});
