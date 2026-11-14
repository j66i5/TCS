/** Night and light (M9.1, roadmap-detail slice 30): the light table, the sky following the clock, and the night lab. */
import { describe, expect, it } from "vitest";
import { buildCatalog } from "@tcs/data";
import { createSim, environmentAt, lightAt, parseTimeOfDay, step, type BattleInput } from "@tcs/sim";
import { getScenario, loadData } from "../src/scenarios";
import { nightLab, nightLabMarkdown } from "../src/labs/night";

const data = loadData();
const cat = buildCatalog(data, ["de", "ru"]);

describe("light from the clock (M9.1)", () => {
  it("full daylight from 7:00 to 17:00, dark at midnight (a full moon gives its light), twilight in between", () => {
    for (const h of [7, 10, 12, 15, 17]) expect(lightAt(cat, h * 3600, 0)).toBe(1);
    expect(lightAt(cat, 0, 0)).toBe(0);
    expect(lightAt(cat, 0, 1)).toBeCloseTo(cat.spotting.night.moonFullLight, 9);
    const dusk = lightAt(cat, 18 * 3600, 0);
    expect(dusk).toBeGreaterThan(0.05);
    expect(dusk).toBeLessThan(1);
    expect(lightAt(cat, 25 * 3600, 0)).toBe(lightAt(cat, 3600, 0)); // modulo a day
  });
  it("parses times of day", () => {
    expect(parseTimeOfDay("21:30")).toBe(21.5 * 3600);
    expect(parseTimeOfDay("6")).toBe(6 * 3600);
    expect(parseTimeOfDay("x")).toBeNull();
    expect(parseTimeOfDay("25:00")).toBeNull();
    expect(parseTimeOfDay(null)).toBeNull();
  });
  it("with a sky the light follows the clock (dusk falls); without one it stays as given", () => {
    const sc = getScenario("shootout");
    const input: BattleInput = sc.build(data, 1, 3600);
    input.environment = environmentAt(input.catalog, 17.9 * 3600, 0);
    const sim = createSim(input);
    const l0 = sim.state.environment.light;
    for (let i = 0; i < 60 * 600; i++) step(sim);
    expect(sim.state.environment.light).toBeLessThan(l0);
    expect(sim.state.environment.light).toBeCloseTo(lightAt(input.catalog, sim.state.environment.timeOfDaySeconds, 0), 2);
    const day = sc.build(data, 1, 3600);
    const s2 = createSim(day);
    for (let i = 0; i < 600; i++) step(s2);
    expect(s2.state.environment.light).toBe(1);
    expect(s2.state.environment.sky).toBeUndefined();
  });
});

describe("night lab", () => {
  const r = nightLab(data, 20);
  const row = (time: string, name: string, range: number) => {
    const x = r.rows.find((q) => q.time === time && q.name === name && q.rangeM === range);
    if (!x) throw new Error(`no row ${time} / ${name} / ${range}`);
    return x;
  };
  it("prints its table", () => { console.log(nightLabMarkdown(r)); });
  it("a man standing still is lost at night; firing, he is seen at once out to 600 m (the flash); goggles bring back much of the day", () => {
    const noonStill = row("noon", "standing, still, open", 300);
    const darkStill = row("night, no moon", "standing, still, open", 300);
    expect(darkStill.within30).toBeLessThan(noonStill.within30);
    expect(darkStill.spotted).toBeLessThanOrEqual(darkStill.runs * 0.7);
    const darkFire = row("night, no moon", "standing, firing, open", 600);
    expect(darkFire.within30).toBe(darkFire.runs);
    const goggles = row("night, no moon", "standing, still, open, observer with goggles", 300);
    expect(goggles.within30).toBeGreaterThan(darkStill.within30);
    const moon = row("night, full moon", "standing, still, open", 100), noMoon = row("night, no moon", "standing, still, open", 100);
    expect(moon.within30).toBeGreaterThanOrEqual(noMoon.within30);
  });
});
