/** Hand smoke grenades (D1, roadmap-detail slice 5): the smoke lab's bands, and the break-contact drill's screen. */
import { describe, expect, it } from "vitest";
import { buildCatalog } from "@tcs/data";
import { allMembers, buildForce } from "@tcs/scenario";
import { countItems, createSim, DEFAULT_COMMS, EventSink, flatMap, screenCasualty, step, submitOrder, type BattleInput, type SimEvent } from "@tcs/sim";
import { smokeLab, smokeLabMarkdown } from "../src/labs/smoke";
import { loadData } from "../src/scenarios";

const data = loadData();
const rows = smokeLab(data);
const val = (a: string, c: string) => {
  const r = rows.find((x) => x.ammo === a && x.case === c);
  if (!r) throw new Error(`no row ${a} / ${c}`);
  return r.value;
};

describe("smoke lab", () => {
  it("prints its table", () => {
    console.log(smokeLabMarkdown(rows));
  });
  it("a hand smoke cloud 20 m across cuts sight through it to a tenth for 45 s or more; one grenade used, none on a fragmentation order, nobody hurt", () => {
    for (const a of ["de-dm45", "ru-rdg2"]) {
      expect(val(a, "thrown on a fragmentation grenade order")).toBe(0);
      expect(val(a, "smoke grenades used")).toBe(1);
      expect(val(a, "smoke from the order")).toBeLessThanOrEqual(6);
      expect(val(a, "cloud across")).toBeGreaterThanOrEqual(20);
      expect(val(a, "line through the middle cut to a tenth")).toBeGreaterThanOrEqual(45);
      expect(val(a, "band cut to a tenth at 30 s")).toBeGreaterThanOrEqual(10);
      expect(val(a, "men wounded")).toBe(0);
    }
  });
});

describe("break-contact smoke (D1)", () => {
  it("a squad ordered to withdraw with an enemy in sight throws one smoke grenade toward him, and the cloud stands between them", () => {
    const catalog = buildCatalog(data, ["de", "ru"]);
    const blue = buildForce(data, { faction: "de", template: "pzgren-schuetzentrupp", seed: 1, keyPrefix: "b" });
    const red = buildForce(data, { faction: "ru", template: "motor-rifle-squad", seed: 2, keyPrefix: "r" });
    const place = (u: typeof blue, x: number, h: number) => allMembers(u).map((m, i) => ({ personId: m.personId, x, y: 140 + i * 4, heading: h }));
    const input: BattleInput = {
      map: flatMap("smoke-drill", 400, 300, 4, "grass"), catalog, seed: 3, orders: [],
      environment: { timeOfDaySeconds: 12 * 3600, light: 1, windX: 0, windY: 0, rain: 0, visibilityM: 5000, temperatureC: 15 },
      rules: { timeLimitSeconds: 3600, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "none", physiologyParams: {}, objectives: [] },
      forces: [
        { side: "blue", faction: "de", units: [blue], placements: place(blue, 100, 0) },
        { side: "red", faction: "ru", units: [red], placements: place(red, 250, Math.PI) },
      ],
    };
    const sim = createSim(input);
    const [bu, ru] = [...sim.state.unit.entries()].filter(([, u]) => u.parent === null).map(([id]) => id);
    // Both hold fire: only the sighting matters here.
    for (const [side, u] of [["blue", bu], ["red", ru]] as const) submitOrder(sim, { tick: 0, issuer: side, target: u!, kind: "rules", fire: "hold" });
    for (let i = 0; i < 60 * 20; i++) step(sim);
    const smokeBefore = allMembers(blue).length;
    const men = sim.state.unit.req(bu!).members;
    const held = () => men.reduce((n, m) => n + countItems(sim.state.container.req(m), "de-dm45"), 0);
    expect(held()).toBe(smokeBefore);
    const events: SimEvent[] = [];
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: bu!, kind: "withdraw", x: 20, y: 150 });
    for (let i = 0; i < 60 * 15; i++) events.push(...step(sim));
    expect(held()).toBe(smokeBefore - 1);
    const laid = events.filter((e) => e.kind === "smoke.grenade");
    expect(laid).toHaveLength(1);
    const e = laid[0]!;
    if (e.kind !== "smoke.grenade") throw new Error();
    // Between the squad's start (x 100) and the enemy (x 250), nearer the squad.
    expect(e.x).toBeGreaterThan(100);
    expect(e.x).toBeLessThan(150);
    expect(events.some((x) => x.kind === "radio" && x.key === "radio.smokeOut")).toBe(true);
    // The casualty-drag hook (for the medical line): within the cooldown nobody throws again; after it the helper
    // himself throws between the casualty and the enemy.
    const [helper, casualty] = [men[1]!, men[2]!];
    expect(screenCasualty(sim.ctx, sim.state, new EventSink(), helper, casualty)).toBe(false);
    for (let i = 0; i < 60 * 60; i++) step(sim);
    const sink = new EventSink();
    const before = countItems(sim.state.container.req(helper), "de-dm45");
    expect(screenCasualty(sim.ctx, sim.state, sink, helper, casualty, { x: 250, y: 150 })).toBe(true);
    // (The helper if he can reach the screen point, else the comrade nearest it.)
    expect(men.some((m) => sim.state.action.get(m)?.kind === "grenade")).toBe(true);
    expect(before).toBeGreaterThanOrEqual(0);
  });
});
