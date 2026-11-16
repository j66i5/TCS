/** M11.4a: the resupply lab's acceptance (a squad 400 m from its supply point is resupplied by bearers within 10 % of
 *  the hand calculation; ledger exact). */
import { describe, expect, it } from "vitest";
import { resupplyLab, resupplyLabMarkdown } from "../src/labs/resupply";
import { loadData } from "../src/scenarios";

describe("resupply lab (M11.4a)", () => {
  it("bearers bring a crate 400 m within 10 % of the hand calculation; never a gunner or leader; ledger exact", () => {
    const rows = resupplyLab(loadData(), [400]);
    console.log(resupplyLabMarkdown(rows));
    for (const r of rows) {
      expect(r.measuredS, r.faction).not.toBeNull();
      expect(Math.abs(r.errPct!), r.faction).toBeLessThanOrEqual(10);
      expect(r.ledgerExact).toBe(true);
      expect(r.bearers.length).toBeGreaterThan(0);
      for (const b of r.bearers) expect(b).not.toMatch(/gunner|fuehrer|leader|commander|sanit|medic|ersthelfer/);
    }
  }, 120_000);
});
