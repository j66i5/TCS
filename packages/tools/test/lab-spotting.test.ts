/**
 * Spotting lab (M3.2). Owner anchors 2026-11-11: a man standing still in the open at 300 m is spotted in about
 * 5-15 s; a man lying still in crops at 100 m is very hard to spot until he moves or fires.
 */
import { describe, expect, it } from "vitest";
import { spottingLab, spottingLabMarkdown, type SpotRow } from "../src/labs/spotting";
import { loadData } from "../src/scenarios";

const rows = spottingLab(loadData());
const r = (name: string, range: number): SpotRow => rows.find((x) => x.name === name && x.rangeM === range)!;

describe("spotting lab", () => {
  it("prints its table", () => { console.log(spottingLabMarkdown(rows)); });

  it("owner anchor: standing still in the open at 300 m, median 5-15 s", () => {
    const x = r("standing, still, open", 300);
    expect(x.medianS).not.toBeNull();
    expect(x.medianS!).toBeGreaterThanOrEqual(5);
    expect(x.medianS!).toBeLessThanOrEqual(15);
    expect(x.spotted).toBe(x.runs);
  });

  it("owner anchor: lying still in crops at 100 m is never spotted (his visibility, 0.12 %, is below the floor of 0.2 % at which anything can be seen); crawling or firing gives him away", () => {
    expect(r("prone, still, in crops", 100).spotted).toBe(0);
    const crawl = r("crawling, in crops", 100), fire = r("prone, firing, in crops", 100);
    expect(crawl.medianS).not.toBeNull(); expect(crawl.medianS!).toBeLessThan(30);
    expect(fire.medianS).not.toBeNull(); expect(fire.medianS!).toBeLessThan(5);
  });

  it("distance, posture, movement and where he looks all matter, in the expected order", () => {
    const m = (n: string, d: number) => r(n, d).medianS ?? 999;
    expect(m("standing, still, open", 100)).toBeLessThan(m("standing, still, open", 300));
    expect(m("standing, still, open", 300)).toBeLessThan(m("standing, still, open", 600));
    expect(m("walking across, open", 300)).toBeLessThan(m("standing, still, open", 300));
    expect(m("kneeling, still, open", 300)).toBeGreaterThanOrEqual(m("standing, still, open", 300));
    expect(m("prone, still, open", 300)).toBeGreaterThan(m("kneeling, still, open", 300));
    const away = r("standing, still, open, observer looking away", 300);
    expect(away.within30).toBeLessThan(0.3 * away.runs);
    expect(r("prone, still, in tall grass", 100).within10).toBeLessThan(r("prone, still, open", 100).within10);
  });

  it("sensors: a 3x optic helps at 300 m (review fix: the rows no longer share their random draws)", async () => {
    const { buildCatalog } = await import("@tcs/data");
    const { spotCase } = await import("../src/labs/spotting");
    const cat = buildCatalog(loadData(), ["de", "ru"]);
    const optic = spotCase(cat, { name: "o", rangeM: 300, posture: "standing", action: "still", seeds: 200 });
    const iron = spotCase(cat, { name: "i", rangeM: 300, posture: "standing", action: "still", ironSights: true, seeds: 200, seedBase: 5000 });
    expect(optic.within10).toBeGreaterThan(iron.within10);
  });
});
