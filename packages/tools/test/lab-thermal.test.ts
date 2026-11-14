/** Sensor physics (M9.2, roadmap-detail slice 31): the thermal lab's bands. */
import { describe, expect, it } from "vitest";
import { thermalLab, thermalLabMarkdown } from "../src/labs/thermal";
import { loadData } from "../src/scenarios";

const r = thermalLab(loadData(), 20);
const row = (time: string, sensor: string, name: string, range: number) => {
  const x = r.rows.find((q) => q.time === time && q.sensor === sensor && q.name === name && q.rangeM === range);
  if (!x) throw new Error(`no row ${time} / ${sensor} / ${name} / ${range}`);
  return x;
};
const T = "optic + thermal sight", O = "optic", N = "night, no moon";

describe("thermal lab", () => {
  it("prints its table", () => { console.log(thermalLabMarkdown(r)); });
  it("a thermal sight sees a man at night about as by day; without one he is mostly lost", () => {
    expect(row(N, T, "standing, still, open", 300).within30).toBeGreaterThanOrEqual(row(N, O, "standing, still, open", 300).within30 + 10);
    expect(row(N, T, "standing, still, open", 300).spotted).toBeGreaterThanOrEqual(18);
  });
  it("heat comes through crops: a man lying in crops is found by thermal, not by the optic", () => {
    expect(row(N, O, "prone, still, in crops", 100).spotted).toBe(0);
    expect(row(N, T, "prone, still, in crops", 100).spotted).toBeGreaterThan(row(N, O, "prone, still, in crops", 100).spotted);
  });
  it("a thermal blanket hides most of a still man's heat; the sight only helps within its arc", () => {
    expect(row(N, T, "prone, still, open, under a thermal blanket", 300).spotted).toBeLessThan(row(N, T, "prone, still, open, no blanket", 300).spotted);
    expect(row(N, T, "standing, still, open, 40 degrees off where he looks", 300).within30).toBeLessThan(row(N, T, "standing, still, open", 300).within30);
  });
  it("a hull just driven is hot and found at 1000 m at night; one halted for a while has cooled and is found later", () => {
    const [hot, cold] = r.hulls;
    expect(hot!.medianS!).toBeLessThan(cold!.medianS ?? 1e9);
    expect(hot!.spotted).toBe(hot!.runs);
  });
});
