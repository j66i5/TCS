/** Line-of-sight lab (M3.1, SPEC 6.5) and the speed of sight checks on a real map. */
import { describe, expect, it } from "vitest";
import { createRng, createSim, heightAt, nextRange, sight } from "@tcs/sim";
import { sightLab, sightLabMarkdown } from "../src/labs/sight";
import { getScenario, loadData } from "../src/scenarios";

const rows = sightLab(loadData());
const row = (part: string) => { const r = rows.find((x) => x.situation.includes(part)); if (!r) throw new Error(part); return r; };
const rowAt = (part: string, range: number) => rows.find((x) => x.situation.includes(part) && x.rangeM === range)!;

describe("line-of-sight lab", () => {
  it("prints its table", () => { console.log(sightLabMarkdown(rows)); });

  it("open flat ground: a clear view at every range, standing or prone", () => {
    for (const r of rows.filter((x) => x.situation.startsWith("open field"))) expect(r.visibility).toBe(1);
  });

  it("crops and grass hide a man who lies down (owner: very hard to spot while still), not one who stands", () => {
    expect(row("target in crops (1 m, from 40 m in front of the observer), target standing").visibility).toBe(1);
    expect(row("target in crops (1 m, from 40 m in front of the observer), target prone").visibility).toBeLessThan(0.01);
    expect(row("target in crops (1 m, from 40 m in front of the observer), target crouching").visibility).toBeLessThan(0.1);
    expect(row("both in tall grass, both prone").visibility).toBeLessThan(0.01);
    expect(row("both in tall grass (0.7 m), observer standing, target prone").visibility).toBeLessThan(0.15);
  });

  it("woodland thins the view with depth: about half after 10 m, almost nothing after 100 m", () => {
    const w = (r: number) => rowAt("into woodland", r).visibility;
    expect(w(90)).toBeGreaterThan(0.35); expect(w(90)).toBeLessThan(0.7);
    expect(w(110)).toBeLessThan(w(90)); expect(w(130)).toBeLessThan(w(110));
    expect(w(180)).toBeLessThan(0.01);
  });

  it("obstacles: a hedge lets little through, a wire fence almost all; a 1.1 m wall hides a kneeling or prone man, not a standing one", () => {
    expect(row("a 2 m hedge").visibility).toBeLessThan(0.15);
    expect(row("a wire fence").visibility).toBeGreaterThan(0.9);
    expect(row("target standing right behind a 1.1 m wall").visibility).toBe(1);
    expect(row("target crouching right behind a 1.1 m wall").blockedBy).toBe("wall");
    expect(row("target prone right behind a 1.1 m wall").blockedBy).toBe("wall");
  });

  it("ground and houses: dead ground beyond a crest; a house blocks unless windows line up; a man inside a closed house is hidden", () => {
    expect(row("beyond a 4 m crest (crest at 150 m, target at 300 m), target standing").blockedBy).toBe("ground");
    expect(row("on the 4 m crest itself").visibility).toBe(1);
    expect(row("a house without windows").blockedBy).toBe("wall");
    expect(row("windows in line on both sides").visibility).toBe(1);
    expect(row("inside a closed house").blockedBy).toBe("wall");
  });

  it("a sight check costs microseconds: 20,000 random lines of up to 400 m on a generated village map", () => {
    const sc = getScenario("demo");
    const sim = createSim(sc.build(loadData(), 1, 60));
    const map = sim.ctx.map, rng = createRng(5);
    const lines: number[][] = [];
    for (let k = 0; k < 20000; k++) {
      const x0 = nextRange(rng, "s", 50, map.widthM - 50), y0 = nextRange(rng, "s", 50, map.heightM - 50);
      const a = nextRange(rng, "s", 0, Math.PI * 2), d = nextRange(rng, "s", 20, 400);
      const x1 = Math.min(map.widthM - 1, Math.max(1, x0 + Math.cos(a) * d)), y1 = Math.min(map.heightM - 1, Math.max(1, y0 + Math.sin(a) * d));
      lines.push([x0, y0, heightAt(map, x0, y0) + 1.6, x1, y1, heightAt(map, x1, y1) + 1.2]);
    }
    for (let k = 0; k < 2000; k++) { const l = lines[k]!; sight(sim.ctx, l[0]!, l[1]!, l[2]!, l[3]!, l[4]!, l[5]!); } // warm-up
    const t0 = performance.now();
    let seen = 0;
    for (const l of lines) if (sight(sim.ctx, l[0]!, l[1]!, l[2]!, l[3]!, l[4]!, l[5]!).visibility > 0.5) seen++;
    const us = ((performance.now() - t0) * 1000) / lines.length;
    console.log(`sight: ${us.toFixed(1)} us per line on average; ${((seen / lines.length) * 100).toFixed(0)} % of random lines see clearly`);
    expect(us).toBeLessThan(60); // generous: shared test machines; measured here in the report
    expect(seen).toBeGreaterThan(0);
    expect(seen).toBeLessThan(lines.length);
  });
});
