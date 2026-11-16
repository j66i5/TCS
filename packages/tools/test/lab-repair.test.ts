/** The repair lab (M11.7a): measured repair times match the man-minutes over the work rates; a hit half-way keeps the
 *  progress and adds the quiet period; the parts used are the hull's; the fixture's tug and cart work too. */
import { describe, expect, it } from "vitest";
import { repairLab } from "../src/labs/repair";
import { loadData } from "../src/scenarios";

describe("repair lab (M11.7a)", () => {
  it("Puma, GTK and the fixture tug: every row within one drill step of the expected time", () => {
    const rows = repairLab(loadData(true), 2, ["de-puma", "de-boxer-gtk", "xf-tug"]);
    expect(rows.length).toBeGreaterThanOrEqual(12);
    for (const r of rows) expect(r.ok, `${r.vehicle} ${r.task} ${r.quality}`).toBe(true);
    const track = rows.find((r) => r.vehicle === "de-puma" && r.task === "track" && r.quality === "regular")!;
    expect(track.men).toBe(2);
    expect(track.parts).toBe("2 de-kettenglied-puma");
    // Two men at 90 man-minutes: 40-50 min (core/repair.json), a veteran crew quicker than a conscript one.
    expect(track.expectedMin).toBeGreaterThan(40);
    expect(track.expectedMin).toBeLessThan(50);
    const con = rows.find((r) => r.vehicle === "de-puma" && r.task === "track" && r.quality === "conscript")!, vet = rows.find((r) => r.vehicle === "de-puma" && r.task === "track" && r.quality === "veteran")!;
    expect(vet.measuredMin!).toBeLessThan(con.measuredMin!);
    // A GTK's wheel side takes its driver alone (two crew seats: the commander stays).
    expect(rows.find((r) => r.vehicle === "de-boxer-gtk" && r.task === "wheels" && r.quality === "regular")!.men).toBe(1);
    // The interruption row: stopped by the hit, resumed after the quiet period, total = expected + wait.
    const hit = rows.filter((r) => r.quality.startsWith("regular, hit"));
    expect(hit.length).toBe(2);
    for (const h of hit) expect(h.note).toContain("stopped (hit)");
  }, 300000);
});
