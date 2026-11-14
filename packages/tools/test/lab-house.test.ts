/** House lab, mode defend (M7.5e): the AI's mixed defence of a house spreads the squad (one burst cannot catch them all). */
import { describe, expect, it } from "vitest";
import { houseDefendLab, houseDefendMarkdown } from "../src/labs/house";
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
