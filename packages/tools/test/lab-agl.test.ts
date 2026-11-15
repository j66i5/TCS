/** Automatic grenade launcher lab (M7.6d): set-up times and men down among six in the open within 60 s. */
import { describe, expect, it } from "vitest";
import { aglLab, aglLabMarkdown } from "../src/labs/agl";
import { loadData } from "../src/scenarios";

const rows = aglLab(loadData(), 20);
const row = (team: "ru" | "de", rangeM: number, posture: "standing" | "prone") => rows.find((r) => r.team === team && r.rangeM === rangeM && r.posture === posture)!;

describe("automatic grenade launcher lab", () => {
  it("prints its table", () => { console.log(aglLabMarkdown(rows)); });
  it("set-up: the AGS-30 in 40 +- 5 s, the GMW in 45 +- 5 s", () => {
    expect(Math.abs(row("ru", 800, "standing").setupS - 40)).toBeLessThanOrEqual(5);
    expect(Math.abs(row("de", 800, "standing").setupS - 45)).toBeLessThanOrEqual(5);
  });
  it("six standing men in the open: at least 3 down at 400 m, 2 at 800 m, 1 at 1200 m (mean of the trials); at most 3 boxes a minute", () => {
    for (const t of ["ru", "de"] as const) {
      expect(row(t, 400, "standing").down).toBeGreaterThanOrEqual(3);
      expect(row(t, 800, "standing").down).toBeGreaterThanOrEqual(2);
      expect(row(t, 1200, "standing").down).toBeGreaterThanOrEqual(1);
      for (const r of rows.filter((x) => x.team === t)) expect(r.boxes).toBeLessThanOrEqual(3);
    }
  });
});
