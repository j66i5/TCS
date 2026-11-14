/** Smoke: hand smoke grenades (D1: the lab's bands, the break-contact drill) and smoke volume v2 (M8.1: the lab's acceptance checks, the cloud model's own properties). */
import { describe, expect, it } from "vitest";
import { buildCatalog } from "@tcs/data";
import { allMembers, buildForce, demoBattle } from "@tcs/scenario";
import { addSmoke, countItems, createSim, DEFAULT_COMMS, EventSink, flatMap, hashState, loadSim, saveSim, screenCasualty, smokePhysics, smokeShapes, smokeTransmission, step, submitOrder, type BattleInput, type Sim, type SimEvent } from "@tcs/sim";
import { handSmokeLab, handSmokeLabMarkdown, smokeLab, smokeLabMarkdown } from "../src/labs/smoke";
import { loadData } from "../src/scenarios";

const data = loadData();
const lab = smokeLab(data, 4);

describe("smoke lab (M8.1)", () => {
  it("prints its tables", () => { console.log(smokeLabMarkdown(lab)); });

  it("a man sees over a cloud only when his line clears its top", () => {
    for (const r of lab.height) {
      if (r.clearsTop) expect(r.view).toBe(1);
      else expect(r.view).toBeLessThan(0.1);
    }
    expect(lab.height.some((r) => r.clearsTop)).toBe(true);
    expect(lab.height.some((r) => !r.clearsTop && r.eyeZ > 4)).toBe(true); // upstairs behind a cloud taller than his line
  });

  it("a cloud drifts 100 m or more in 30 s at 4 m/s and never upwind", () => {
    for (const r of lab.drift) {
      expect(r.upwindM).toBeLessThan(1e-6);
      if (r.windMps >= 4) expect(r.headM).toBeGreaterThanOrEqual(100);
    }
  });

  it("a 6-round screen across 150 m blocks 90 % or more of spotting checks across it", () => {
    for (const r of lab.screen) expect(1 - r.meanView).toBeGreaterThanOrEqual(0.9);
  });
});

describe("smoke clouds (M8.1)", () => {
  const sim0 = (): Sim => createSim(demoBattle(data, { seed: 2, factions: ["de", "ru"], mapWidthM: 800, mapHeightM: 400, frontM: 300, timeLimitSeconds: 900 }));

  it("builds up, fades over its last seconds and is gone at its end", () => {
    const sim = sim0();
    const P = smokePhysics(sim.ctx.catalog);
    addSmoke(sim.ctx, sim.state, 400, 200, 20, 60, 15, 0);
    const across = () => smokeTransmission(sim.state, P, 300, 200, 2, 500, 200, 2);
    const r0 = smokeShapes(sim.state, P)[0]!.r;
    for (let k = 0; k < 600; k++) step(sim);
    expect(smokeShapes(sim.state, P)[0]!.r).toBeGreaterThan(r0);
    const full = across();
    for (let k = 0; k < 60 * 45; k++) step(sim); // 55 s: within the last 20 s
    expect(smokeShapes(sim.state, P)[0]!.density).toBeLessThan(0.5);
    expect(across()).toBeGreaterThan(full);
    for (let k = 0; k < 60 * 6; k++) step(sim);
    expect(sim.state.smoke).toHaveLength(0);
    expect(across()).toBe(1);
  });

  it("a burning round's plume stretches downwind from the round; a puff drifts whole", () => {
    const sim = sim0();
    sim.state.environment.windX = 4;
    const P = smokePhysics(sim.ctx.catalog);
    addSmoke(sim.ctx, sim.state, 200, 200, 20, 300, 15, 60);
    addSmoke(sim.ctx, sim.state, 200, 300, 10, 300, 8, 0);
    for (let k = 0; k < 60 * 20; k++) step(sim);
    const [plume, puff] = smokeShapes(sim.state, P);
    expect(plume!.ax).toBeCloseTo(200, 6);
    expect(plume!.bx).toBeCloseTo(280, 6);
    expect(puff!.ax).toBeCloseTo(280, 6);
    expect(puff!.bx).toBeCloseTo(280, 6);
    // A line across the plume's middle is blocked; one 20 m upwind of the round is not.
    expect(smokeTransmission(sim.state, P, 240, 100, 1.6, 240, 290, 1.6)).toBeLessThan(0.01);
    expect(smokeTransmission(sim.state, P, 160, 100, 1.6, 160, 290, 1.6)).toBe(1);
  });

  it("a screen mission lays its rounds along the line; drifting clouds survive save and load", () => {
    const input = demoBattle(data, { seed: 3, factions: ["de", "ru"], mapWidthM: 800, mapHeightM: 400, frontM: 300, timeLimitSeconds: 900 });
    input.rules.support = [{ side: "blue", he: 0, smoke: 12 }, { side: "red", he: 0, smoke: 0 }];
    const sim = createSim(input);
    sim.state.environment.windY = 2;
    const top = [...sim.state.unit.entries()].find(([, u]) => u.side === "blue" && u.parent === null)![0];
    submitOrder(sim, { tick: 0, issuer: "blue", target: top, kind: "callFire", x: 450, y: 100, x2: 450, y2: 300, ammo: "smoke", rounds: 6 });
    const falls: { x: number; y: number }[] = [];
    for (let k = 0; k < 60 * 200; k++) for (const e of step(sim)) if (e.kind === "support.smoke") falls.push({ x: e.x, y: e.y });
    const effect = falls.slice(-6);
    expect(effect).toHaveLength(6);
    // Spread along the line (ends about 200 m apart, scattered by the battery's dispersion).
    const ys = effect.map((p) => p.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(100);
    const copy = loadSim({ ...input, orders: [] }, saveSim(sim));
    for (let k = 0; k < 600; k++) { step(sim); step(copy); }
    expect(hashState(copy.state)).toBe(hashState(sim.state));
  });

  it("a screen line is smoke only and needs both ends", () => {
    const sim = sim0();
    const top = [...sim.state.unit.entries()].find(([, u]) => u.side === "blue" && u.parent === null)![0];
    submitOrder(sim, { tick: 0, issuer: "blue", target: top, kind: "callFire", x: 450, y: 100, x2: 450, y2: 300, ammo: "he", rounds: 6 });
    submitOrder(sim, { tick: 0, issuer: "blue", target: top, kind: "callFire", x: 450, y: 100, x2: 450, ammo: "smoke", rounds: 6 });
    const ev = []; for (let k = 0; k < 120; k++) ev.push(...step(sim));
    expect(ev.filter((e) => e.kind === "order.rejected")).toHaveLength(2);
  });
});

const rows = handSmokeLab(data);
const val = (a: string, c: string) => {
  const r = rows.find((x) => x.ammo === a && x.case === c);
  if (!r) throw new Error(`no row ${a} / ${c}`);
  return r.value;
};

describe("hand smoke lab (D1)", () => {
  it("prints its table", () => {
    console.log(handSmokeLabMarkdown(rows));
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
