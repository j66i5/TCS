/** M11.2: the redistribution lab's acceptance (a quiet squad evens out its ammunition, belts first, ledger exact). */
import { describe, expect, it } from "vitest";
import { redistributeLab, redistributeLabMarkdown } from "../src/labs/redistribute";
import { loadData } from "../src/scenarios";

describe("redistribution lab (M11.2)", () => {
  it("within 60 s of quiet no man is more than one magazine from the mean, the gunner gets belts first, ledger exact", () => {
    const rows = redistributeLab(loadData(), 2);
    console.log(redistributeLabMarkdown(rows));
    for (const r of rows) {
      expect(r.maxDev, `${r.faction} ${r.trial}`).toBeLessThanOrEqual(1);
      expect(r.ledgerExact).toBe(true);
      expect(r.beltFirst).not.toBe(false);
      if (r.gunnerBelts) expect(r.gunnerBelts[1]).toBeGreaterThanOrEqual(2);
    }
  });
});
