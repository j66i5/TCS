/** House lab (M7.5e): mode defend (the AI's mixed defence spreads the squad: one burst cannot catch them all) and
 *  mode leave (men leave a house that has become a trap, or that the enemy is inside). */
import { describe, expect, it } from "vitest";
import { houseDefendLab, houseDefendMarkdown, houseLeaveMarkdown, houseLeaveRun } from "../src/labs/house";
import { loadData } from "../src/scenarios";

const rows = houseDefendLab(loadData(), 3);
const mean = (d: string, f: (r: (typeof rows)[number]) => number) => { const rs = rows.filter((r) => r.defence === d); return rs.reduce((a, r) => a + f(r), 0) / rs.length; };

describe("house lab (defend)", () => {
  it("prints the table", () => { console.log(houseDefendMarkdown(rows)); });
  it("the mixed defence keeps at most a house's cap inside and fewer men within one burst's reach than all in", () => {
    for (const r of rows.filter((x) => x.defence === "mixed")) expect(r.insideAtSpread).toBeLessThanOrEqual(4);
    expect(mean("mixed", (r) => r.max10AtSpread)).toBeLessThan(mean("all in", (r) => r.max10AtSpread));
    expect(mean("mixed", (r) => r.insideAtSpread)).toBeGreaterThan(0);
  });
});

describe("house lab (leave)", () => {
  const data = loadData();
  const runs = [houseLeaveRun(data, 1, "trap", true), houseLeaveRun(data, 1, "trap", false), houseLeaveRun(data, 1, "enemy", true)];
  it("prints the table", () => { console.log(houseLeaveMarkdown(runs)); });
  it("a trap empties the house in time with the rule on, never with it off; an enemy inside does too", () => {
    const [on, off, enemy] = runs as [typeof runs[0], typeof runs[0], typeof runs[0]];
    expect(on.inside).toBeGreaterThan(0);
    expect(on.outInTime).toBe(on.inside);
    expect(on.reasons).toContain("trap");
    expect(off.reasons).toEqual([]);
    expect(off.outInTime).toBe(0);
    expect(enemy.seenInside).toBe(true);
    expect(enemy.outInTime).toBe(enemy.inside);
  });
});
