/** The recovery lab (M11.7b): every recovery vehicle tows its own hulls (drive in as alone, hook-up as in its data, the
 *  tow at its cap); the BREM-1 refuses a Leopard 2 (too heavy); the fixture tug tows the tortoise. */
import { describe, expect, it } from "vitest";
import { towLab } from "../src/labs/repair";
import { loadData } from "../src/scenarios";

describe("recovery lab (M11.7b)", () => {
  it("Büffel tows a Leopard 2A7V, BREM-1 a T-90M and refuses the Leopard, the xf tug the tortoise", () => {
    const rows = towLab(loadData(true), ["de-leopard2a7v", "ru-t90m", "xf-tortoise"]);
    expect(rows.length).toBe(7);
    for (const r of rows) expect(r.ok, `${r.recovery} ${r.target} ${r.distM}`).toBe(true);
    const leo = rows.find((r) => r.recovery === "de-bergepanzer3" && r.target === "de-leopard2a7v" && r.distM === 300)!;
    expect(leo.outcome).toBe("towed");
    expect(leo.delayS!).toBeGreaterThanOrEqual(600);
    expect(leo.delayS!).toBeLessThanOrEqual(1200);
    expect(rows.find((r) => r.recovery === "ru-brem1" && r.target === "de-leopard2a7v")!.outcome).toBe("refused (recoveryTooHeavy)");
    // Twice as far: about twice the tow.
    const far = rows.find((r) => r.recovery === "de-bergepanzer3" && r.distM === 600)!;
    expect(far.towS! / leo.towS!).toBeGreaterThan(1.8);
  }, 300000);
});
