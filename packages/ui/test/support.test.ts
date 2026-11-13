/** Step fire-support (owner choice S11): the pop-up's place, mission lines with their ranging falls and phase. */
import { describe, expect, it } from "vitest";
import { buildScenario } from "@tcs/scenario";
import { createSim, secondsToEffect, step, submitOrder, type SimEvent } from "@tcs/sim";
import { loadData } from "../../tools/src/scenarios";
import { intentLines, RangingBook, RANGING_KEEP_S } from "../src/mapfeel";
import { popupPlace } from "../src/support";
import { ordersFor, unitCapabilities } from "../src/orders-for";

describe("S11: fire support", () => {
  it("the pop-up sits beside the point, flips left at the right edge and stays on the screen", () => {
    expect(popupPlace(100, 300, 400, 800, 180, 90)).toEqual({ left: 118, top: 255 });
    const r = popupPlace(380, 300, 400, 800, 180, 90);
    expect(r.left + 180).toBeLessThanOrEqual(380);
    const t = popupPlace(50, 5, 400, 800, 180, 90);
    expect(t.top).toBeGreaterThanOrEqual(8);
    const b = popupPlace(50, 799, 400, 800, 180, 90);
    expect(b.top + 90).toBeLessThanOrEqual(792);
    // Kept off a 70 px sidebar and a 150 px bar at the bottom; no room on either side: above the point.
    const ins = { top: 60, right: 0, bottom: 150, left: 70 };
    const i = popupPlace(200, 400, 390, 844, 230, 90, ins);
    expect(i.left).toBeGreaterThanOrEqual(78);
    expect(i.top + 90).toBeLessThanOrEqual(400 - 20);
  });

  it("a mission's line: called, then ranging with each fall, then firing for effect; old falls are dropped", () => {
    const data = loadData();
    const input = buildScenario(data, { kind: "platoon-attack", seed: 2, mapKind: "farmland", factions: ["de", "ru"], attacker: "blue", timeLimitSeconds: 600 });
    const sim = createSim(input);
    const fs = input.catalog.factions["de"]!.fireSupport!;
    const squad = [...sim.state.unit.entries()].find(([, u]) => u.side === "blue" && u.parent !== null && u.vehicle === undefined)![0];
    // One button, whatever is left: the bar offers "support" with fire support rounds.
    expect(ordersFor(unitCapabilities(sim.state, input.catalog, squad), input.catalog.movementModes).modes).toContain("support");
    const lp = sim.state.transform.req(sim.state.unit.get(squad)!.leader!);
    submitOrder(sim, { tick: 0, issuer: "blue", target: squad, kind: "callFire", x: lp.x + 250, y: lp.y, ammo: "he", rounds: 4 });
    const book = new RangingBook();
    const fire = () => intentLines(sim.state, "blue", squad, book.falls).filter((l) => l.kind === "fire");
    expect(fire()[0]!.phase).toBe("called");
    const run = (s: number) => { for (let k = 0; k < s * 60; k++) for (const e of step(sim) as SimEvent[]) if (e.kind === "support.ranging" && e.side === "blue") book.add(e); };
    run(fs.delaySeconds + 3);
    expect(fire()[0]!.phase).toBe("ranging");
    expect(fire()[0]!.falls).toHaveLength(1);
    run(secondsToEffect(fs) - fs.delaySeconds);
    const l = fire();
    if (l.length > 0) { expect(l[0]!.phase).toBe("effect"); expect(l[0]!.falls).toHaveLength(fs.rangingRounds); }
    expect(book.falls).toHaveLength(fs.rangingRounds);
    book.prune(sim.state.tick + (RANGING_KEEP_S + 1) * 60);
    expect(book.falls).toHaveLength(0);
  });
});
