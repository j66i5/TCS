/** Ambush lab (D4b): a defender in ambush opens fire inside its range; one firing at will opens farther out. */
import { describe, expect, it } from "vitest";
import { AMBUSH_LAB_M, ambushLab, ambushLabMarkdown } from "../src/labs/attack";
import { loadData } from "../src/scenarios";

const rows = ambushLab(loadData(), 4);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

describe("ambush lab", () => {
  it("prints the table", () => { console.log(ambushLabMarkdown(rows)); });

  it("in ambush, the defender's first volley (when he fires first) is inside the set range", () => {
    const first = rows.filter((r) => r.ambush && r.firstFire === "defender");
    expect(first.length).toBeGreaterThan(0);
    for (const r of first) expect(r.firstVolleyM!).toBeLessThanOrEqual(AMBUSH_LAB_M + 2);
  });

  it("firing at will, the first volley is farther out on average", () => {
    const vol = (amb: boolean) => mean(rows.filter((r) => r.ambush === amb && r.firstVolleyM !== null).map((r) => r.firstVolleyM!));
    expect(vol(false)).toBeGreaterThan(vol(true));
  });
});
