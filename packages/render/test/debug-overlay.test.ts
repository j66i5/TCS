/** Vehicle debug overlay (M7.3, plan C2): the station's reasons come from `vehicle.decision` events, translated. */
import { describe, expect, it } from "vitest";
import { Strings } from "@tcs/data";
import { createSim, step, submitOrder, TICK_HZ, type SimEvent } from "@tcs/sim";
import { VehicleDebug } from "../src/vehicle-debug";
import { duel } from "../../tools/src/labs/gunnery";
import { loadData } from "../../tools/src/scenarios";

describe("vehicle debug overlay", () => {
  it("draws the station's why (from events), its lay and its target line", () => {
    const data = loadData();
    const strings = new Strings(data);
    const sim = createSim(duel(data, ["de", "ru"], { blue: { x: 400, y: 600, heading: 0 }, red: { x: 1100, y: 600, heading: Math.PI / 2 } }));
    // Blue fires HE at the BMP-2 (it does not get through, M7.4a); red is struck and returns fire: its crew
    // chooses the Puma (a vehicle first), whose front it cannot get through either.
    const [bid, bv] = [...sim.state.vehicle.entries()].find(([, v]) => v.side === "blue")!;
    const [rid] = [...sim.state.vehicle.entries()].find(([, v]) => v.side === "red")!;
    submitOrder(sim, { tick: 0, issuer: "blue", target: bv.unit!, kind: "fire", x: 1100, y: 600, heightM: 1.2, nature: "he" });
    const dbg = new VehicleDebug();
    const seen: SimEvent[] = [];
    for (let i = 0; i < 40 * TICK_HZ; i++) { const ev = step(sim); dbg.onEvents(ev); seen.push(...ev.filter((e) => e.kind === "vehicle.decision")); }
    expect(seen.some((e) => e.kind === "vehicle.decision" && e.vehicle === rid)).toBe(true);
    const view = dbg.view(sim.state, rid, strings);
    const text = view.lines.join("\n");
    expect(text).toContain(strings.t("why.target.vehicle"));
    expect(text).toContain(strings.t("why.nature.vehicle"));
    expect(text).toMatch(/turret -?\d+ deg/);
    expect(view.targets.length).toBe(1);
    // The ordered station shows "target ordered".
    expect(dbg.view(sim.state, bid, strings).lines.join("\n")).toContain(strings.t("why.target.ordered"));
  });
});

describe("vehicle debug overlay: crew reaction (M7.4b, plan C2)", () => {
  it("draws the crew's reaction and its reasons from the vehicle.reaction event", () => {
    const data = loadData();
    const strings = new Strings(data);
    const sim = createSim(duel(data, ["de", "ru"], { blue: { x: 400, y: 600, heading: 0 }, red: { x: 1100, y: 600, heading: Math.PI / 2 } }));
    const [rid] = [...sim.state.vehicle.entries()].find(([, v]) => v.side === "red")!;
    const dbg = new VehicleDebug();
    dbg.onEvents([{ kind: "vehicle.reaction", tick: 10, vehicle: rid, reaction: "reverseOut", keys: ["reaction.rocketHit", "reaction.penetrated"] }]);
    const text = dbg.view(sim.state, rid, strings).lines.join("\n");
    expect(text).toContain(strings.t("reaction.reverseOut"));
    expect(text).toContain(strings.t("reaction.rocketHit"));
    expect(text).toContain(strings.t("reaction.penetrated"));
  });
});
