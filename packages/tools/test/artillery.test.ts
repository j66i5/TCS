/** M8.4: off-map artillery (155 / 152 mm), airburst, danger close, illumination (saved, no light), counter-battery,
 *  guided rounds refused; the artillery lab's rows. */
import { describe, expect, it } from "vitest";
import { demoBattle } from "@tcs/scenario";
import { createSim, hashState, loadSim, saveSim, step, submitOrder, supportLeft, type BattleInput, type Sim, type SimEvent } from "@tcs/sim";
import { artilleryLab, artilleryLabMarkdown } from "../src/labs/artillery";
import { loadData } from "../src/scenarios";

const data = loadData();
function battle(prep?: (i: BattleInput) => void): BattleInput {
  const input = demoBattle(data, { seed: 5, factions: ["de", "ru"], mapWidthM: 2400, mapHeightM: 400, frontM: 600, timeLimitSeconds: 1800 });
  input.rules.support = [{ side: "blue", he: 24, smoke: 4, illum: 4, asset: "artillery" }, { side: "blue", he: 6, smoke: 2, illum: 2 }];
  prep?.(input);
  return input;
}
const top = (sim: Sim, side: string) => [...sim.state.unit.entries()].find(([, u]) => u.side === side && u.parent === null)![0];
function run(sim: Sim, seconds: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let k = 0; k < seconds * 60; k++) out.push(...step(sim));
  return out;
}
const radioKeys = (ev: SimEvent[]) => ev.filter((e): e is Extract<SimEvent, { kind: "radio" }> => e.kind === "radio").map((e) => e.key);

describe("off-map artillery (M8.4)", () => {
  it("an artillery mission fires the battery's heavy rounds from its own allotment; the mortars' stay", () => {
    const input = battle();
    const sim = createSim(input);
    const art = input.catalog.factions["de"]!.artillery!;
    expect(supportLeft(sim.state, "blue", "he", sim.ctx.catalog, "artillery")).toBe(24);
    expect(supportLeft(sim.state, "blue", "he", sim.ctx.catalog)).toBe(6);
    submitOrder(sim, { tick: 0, issuer: "blue", target: top(sim, "blue"), kind: "callFire", x: 2200, y: 200, ammo: "he", rounds: 4, asset: "artillery" });
    const ev = run(sim, art.delaySeconds + art.rangingRounds * art.rangingSeconds + 30);
    const bursts = ev.filter((e) => e.kind === "explosion" && e.ammo === art.heAmmo);
    expect(bursts).toHaveLength(4 + art.rangingRounds);
    expect(supportLeft(sim.state, "blue", "he", sim.ctx.catalog, "artillery")).toBe(24 - 4 - art.rangingRounds);
    expect(supportLeft(sim.state, "blue", "he", sim.ctx.catalog)).toBe(6);
    expect(ev.find((e) => e.kind === "support.call")).toMatchObject({ asset: "artillery" });
  });

  it("danger close: a call within 600 m of own men is refused unless called danger close", () => {
    const sim = createSim(battle());
    // Blue's squad stands about x 900: a point 300 m beyond it.
    submitOrder(sim, { tick: 0, issuer: "blue", target: top(sim, "blue"), kind: "callFire", x: 1300, y: 200, ammo: "he", rounds: 2, asset: "artillery" });
    const ev = run(sim, 5);
    expect(radioKeys(ev)).toContain("radio.fireDangerClose");
    expect(sim.state.fireMissions).toHaveLength(0);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: top(sim, "blue"), kind: "callFire", x: 1300, y: 200, ammo: "he", rounds: 2, asset: "artillery", dangerClose: true });
    const ev2 = run(sim, 5);
    expect(ev2.find((e) => e.kind === "support.call")).toMatchObject({ dangerClose: true });
    // The mortars have no danger-close distance in the data (owner to review): the same call goes.
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: top(sim, "blue"), kind: "callFire", x: 1300, y: 200, ammo: "he", rounds: 2 });
    expect(radioKeys(run(sim, 5))).not.toContain("radio.fireDangerClose");
  });

  it("airburst: the shells burst the fuse's height over the ground; mortars without the fuse refuse it", () => {
    const input = battle();
    const sim = createSim(input);
    const art = input.catalog.factions["de"]!.artillery!;
    submitOrder(sim, { tick: 0, issuer: "blue", target: top(sim, "blue"), kind: "callFire", x: 2200, y: 200, ammo: "he", rounds: 2, asset: "artillery", fuse: "airburst" });
    const ev = run(sim, art.delaySeconds + art.rangingRounds * art.rangingSeconds + 30);
    const bursts = ev.filter((e): e is Extract<SimEvent, { kind: "explosion" }> => e.kind === "explosion" && e.ammo === art.heAmmo);
    expect(bursts.length).toBeGreaterThan(0);
    for (const b of bursts) expect(b.z).toBeGreaterThan(art.airburstHeightM! - 1);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: top(sim, "blue"), kind: "callFire", x: 2200, y: 200, ammo: "he", rounds: 2, fuse: "airburst" });
    expect(radioKeys(run(sim, 5))).toContain("radio.noAirburst");
  });

  it("illumination: a flare is saved in the state while it burns and leaves the light unchanged; save and load", () => {
    const input = battle();
    const sim = createSim(input);
    const art = input.catalog.factions["de"]!.artillery!;
    const light0 = sim.state.environment.light;
    submitOrder(sim, { tick: 0, issuer: "blue", target: top(sim, "blue"), kind: "callFire", x: 2000, y: 200, ammo: "illum", rounds: 1, asset: "artillery" });
    const ev = run(sim, art.delaySeconds + 10);
    expect(ev.filter((e) => e.kind === "support.ranging")).toHaveLength(0); // no ranging for illumination
    expect(ev.some((e) => e.kind === "support.illum")).toBe(true);
    expect(sim.state.flares).toHaveLength(1);
    expect(sim.state.flares![0]!.z).toBeGreaterThan(300);
    expect(sim.state.environment.light).toBe(light0);
    const copy = loadSim({ ...input, orders: [] }, saveSim(sim));
    run(sim, 30); run(copy, 30);
    expect(hashState(copy.state)).toBe(hashState(sim.state));
    run(sim, 130);
    expect(sim.state.flares).toHaveLength(0);
    expect(supportLeft(sim.state, "blue", "illum", sim.ctx.catalog, "artillery")).toBe(3);
  });

  it("counter-battery (abstract): after three missions the battery displaces and takes no call until it is set up again", () => {
    const input = battle();
    const sim = createSim(input);
    const art = input.catalog.factions["de"]!.artillery!;
    for (let k = 0; k < art.counterBattery!.missionsBeforeMove; k++) {
      submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: top(sim, "blue"), kind: "callFire", x: 2000 + k * 60, y: 200, ammo: "he", rounds: 1, asset: "artillery" });
      run(sim, 3);
    }
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: top(sim, "blue"), kind: "callFire", x: 2200, y: 100, ammo: "he", rounds: 1, asset: "artillery" });
    expect(radioKeys(run(sim, 3))).toContain("radio.batteryMoving");
    const sec = sim.state.support.find((s) => s.asset === "artillery")!;
    run(sim, (sec.movingUntil! - sim.state.tick) / 60 + 2);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: top(sim, "blue"), kind: "callFire", x: 2200, y: 100, ammo: "he", rounds: 1, asset: "artillery" });
    const ev = run(sim, 3);
    expect(radioKeys(ev)).not.toContain("radio.batteryMoving");
    expect(ev.some((e) => e.kind === "support.call")).toBe(true);
  });

  it("a guided round is refused (reserved until M9)", () => {
    const input = battle((i) => { const a = i.catalog.factions["de"]!.artillery!.heAmmo; i.catalog.ammo[a] = { ...i.catalog.ammo[a]!, guidance: "laser" } as never; });
    const sim = createSim(input);
    submitOrder(sim, { tick: 0, issuer: "blue", target: top(sim, "blue"), kind: "callFire", x: 2200, y: 200, ammo: "he", rounds: 1, asset: "artillery" });
    expect(radioKeys(run(sim, 5))).toContain("radio.guidedNotYet");
  });
});

describe("artillery lab (M8.4)", () => {
  const rows = artilleryLab(data, 6);
  const row = (label: string, burst: string, where: string, posture: string, d: number) => rows.find((r) => r.label === label && r.burst === burst && r.where === where && r.posture === posture && r.distanceM === d)!;
  it("prints its table", () => { console.log(artilleryLabMarkdown(rows)); });
  it("a heavy shell hurts more than a mortar bomb; airburst hurts prone men in the open much more, men under a roof no more", () => {
    for (const [heavy, light] of [["de-155-he", "de-120-he"], ["ru-152-he", "ru-82-he"]] as const) {
      expect(row(heavy, "impact", "open", "standing", 25).woundsPerMan).toBeGreaterThan(row(light, "impact", "open", "standing", 25).woundsPerMan);
      const open = row(heavy, "airburst", "open", "prone", 10).woundsPerMan / Math.max(0.01, row(heavy, "impact", "open", "prone", 10).woundsPerMan);
      expect(open).toBeGreaterThan(2);
      const house = row(heavy, "airburst", "house", "prone", 10).woundsPerMan / Math.max(0.01, row(heavy, "impact", "house", "prone", 10).woundsPerMan);
      expect(house).toBeLessThan(1.3);
    }
  });
});
