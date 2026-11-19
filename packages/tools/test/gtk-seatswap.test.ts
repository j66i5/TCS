/**
 * M7.6c review fixes: a GTK Boxer's FLW 200 is worked from the commander's seat; a fallen commander is replaced (a
 * passenger takes his seat, the crew of two having nobody else) and the station fires again. Gunner-operated hulls
 * keep their rules. `vehicleBattle` takes a carrier class per side, and the first responder's role name is neutral.
 */
import { describe, expect, it } from "vitest";
import { buildScenario, vehicleBattle } from "@tcs/scenario";
import { commanderController } from "@tcs/ai";
import { createSim, stationOperator, step, submitOrder, type EntityId, type SimEvent } from "@tcs/sim";
import { getScenario, loadData } from "../src/scenarios";

const data = loadData();

describe("M7.6c review fixes", () => {
  it("vehicleBattle: carriers per side ([wheeled, tracked] gives GTK Boxers against BMP-2s); one class for both as before", () => {
    const types = (input: ReturnType<typeof vehicleBattle>) => input.forces.map((f) => [...new Set((f.vehicles ?? []).map((v) => v.type))]);
    expect(types(vehicleBattle(data, { seed: 1, factions: ["de", "ru"], carriers: ["wheeled", "tracked"] }))).toEqual([["de-boxer-gtk"], ["ru-bmp2"]]);
    expect(types(vehicleBattle(data, { seed: 1, factions: ["de", "ru"], carriers: ["tracked", "wheeled"] }))).toEqual([["de-puma"], ["ru-btr82a"]]);
    expect(types(vehicleBattle(data, { seed: 1, factions: ["de", "ru"], carriers: "wheeled" }))).toEqual([["de-boxer-gtk"], ["ru-btr82a"]]);
    expect(types(vehicleBattle(data, { seed: 1, factions: ["de", "ru"] }))).toEqual([["de-puma"], ["ru-bmp2"]]);
  });

  it("the named scenarios that take --carriers say so (headless warns for the others)", () => {
    for (const n of ["vehicles", "platoon-vehicles", "platoon-vehicles-wheeled", "platoon-vehicles-mixed", "platoon-vehicles-tanks"]) expect(getScenario(n).takesCarriers).toBe(true);
    for (const n of ["platoon", "demo", "bench-vehicles", "bench-tanks"]) expect(getScenario(n).takesCarriers).toBeFalsy();
    const types = getScenario("vehicles").build(data, 1, 60, { carriers: ["wheeled", "tracked"] }).forces.map((f) => (f.vehicles ?? [])[0]!.type);
    expect(types).toEqual(["de-boxer-gtk", "ru-bmp2"]);
  });

  it("the Einsatzersthelfer is not named after the Panzergrenadier (a Jaegergruppe has one too)", () => {
    const t = data.factions["de"]!.strings["en"]!["role.de.einsatzersthelfer"]!;
    expect(t).toBe("Einsatzersthelfer B (first responder)");
  });

  // (Balance pass 4: the gunner now sees his own men on foot in his line; in seed 1 the GTK's platoon stands 60-130 m
  // ahead in it all battle long, so the FLW 200 holds its fire: the test asks for the station working again, a target
  // taken or the crew saying why it holds for its own men (review fix: chooseTarget skips targets it cannot fire at),
  // not for a shot.)
  it("a GTK Boxer whose commander falls: a passenger takes his seat and the FLW 200 takes targets again", () => {
    const input = buildScenario(data, { kind: "platoon-attack", seed: 1, mapKind: "village", factions: ["de", "ru"], attacker: "blue", vehicles: true, carriers: "wheeled", missileTeams: false });
    const sim = createSim(input);
    const st = sim.state, cat = input.catalog;
    const [vid, v] = [...st.vehicle.entries()].find(([, x]) => x.side === "blue" && x.offMap === undefined && x.def === "de-boxer-gtk")!;
    const def = cat.vehicles[v.def]!;
    expect(def.stations.map((s) => s.operator)).toEqual(["commander"]);
    const cmdSeat = def.seats.findIndex((s) => s.station === "commander");
    const commander = v.seats[cmdSeat]!;
    const crew = st.unit.req(v.unit!).members;
    expect(crew).toContain(commander);
    const cs = st.soldier.req(commander);
    cs.physiology.alive = false; cs.physiology.consciousness = 0; cs.casualty = "killed";
    expect(stationOperator(st, v, def, 0)).toBeNull();
    const ctrls = [commanderController("blue", input), commanderController("red", input)];
    let swap: Extract<SimEvent, { kind: "vehicle.seatSwap" }> | undefined, tookTarget = false;
    for (let i = 0; i < 400 * 60 && !tookTarget; i++) {
      for (const c of ctrls) for (const o of c.think(st, st.tick)) submitOrder(sim, o);
      for (const e of step(sim)) {
        if (e.kind === "vehicle.seatSwap" && e.vehicle === vid && swap === undefined) swap = e;
        if (e.kind === "vehicle.decision" && e.vehicle === vid && swap !== undefined && (e.target !== null || e.keys[0] === "why.hold.friends" || e.keys[0] === "why.hold.dangerClose")) tookTarget = true;
      }
    }
    expect(swap).toBeDefined();
    expect(swap!.seat).toBe(cmdSeat);
    expect(swap!.casualty).toBe(commander);
    const man: EntityId = swap!.soldier;
    expect(crew).not.toContain(man);
    expect(def.seats[st.soldier.req(commander).mount!.seat]!.station).toBe("passenger");
    expect(tookTarget).toBe(true);
    expect(stationOperator(st, v, def, 0)).toBe(man);
  }, 120_000);
});
