/**
 * The app marks only the player's own orders as the player's (a vehicle holds a player's move against close enemy
 * men); the AI commander's orders reach the sim unchanged, as in headless runs (bug fix, 2026-11-14).
 */
import { describe, expect, it } from "vitest";
import { createSim, step, submitOrder, type Order } from "@tcs/sim";
import { getScenario, loadData } from "../../tools/src/scenarios";
import { playerOrder } from "../src/player-order";

const outdoors = () => -1;

describe("playerOrder", () => {
  it("marks the order as the player's and sends a move into a building to the floor on screen", () => {
    const mv: Order = { tick: 0, issuer: "blue", target: 1, kind: "move", waypoints: [{ x: 10, y: 10, mode: "walk" }] };
    expect(playerOrder(mv, 0, outdoors)).toEqual({ ...mv, player: true });
    expect(playerOrder(mv, 2, () => 1)).toEqual({ ...mv, player: true, floor: 1 });
    expect(playerOrder(mv, 1, () => 3)).toEqual({ ...mv, player: true, floor: 1 });
    expect(playerOrder(mv, 2, outdoors)).toEqual({ ...mv, player: true });
    expect(playerOrder({ ...mv, floor: 0 }, 2, () => 3)).toEqual({ ...mv, floor: 0, player: true });
    const halt: Order = { tick: 0, issuer: "blue", target: 1, kind: "halt" };
    expect(playerOrder(halt, 2, () => 3)).toEqual({ ...halt, player: true });
    expect(mv.player).toBeUndefined(); // (the order given is not changed)
  });

  it("AI vehicle orders sent unchanged never set playerHold; a player's move still does", () => {
    const sc = getScenario("platoon-ru-vehicles");
    const input = sc.build(loadData(), 1, 120);
    const sim = createSim(input);
    const ai = sc.controllers!(input);
    let aiVehicleOrders = 0, held = 0;
    for (let k = 0; k < 60 * 60; k++) {
      for (const c of ai) for (const o of c.think(sim.state, sim.state.tick)) {
        if ((o.kind === "move" || o.kind === "halt") && sim.state.unit.get(o.target)?.vehicle !== undefined) aiVehicleOrders++;
        submitOrder(sim, o); // the app's AI path (issueAi): the order as the controller gave it
      }
      step(sim);
      for (const [, v] of sim.state.vehicle.entries()) if (v.playerHold) held++;
    }
    expect(aiVehicleOrders).toBeGreaterThan(0);
    expect(held).toBe(0);
    // A player's gesture to a vehicle crew (through playerOrder) still makes the hull hold its order.
    const [uid, u] = [...sim.state.unit.entries()].find(([, x]) => x.vehicle !== undefined && sim.state.vehicle.get(x.vehicle) !== undefined)!;
    const v = sim.state.vehicle.req(u.vehicle!);
    submitOrder(sim, playerOrder({ tick: sim.state.tick, issuer: u.side, target: uid, kind: "halt" }, 0, outdoors));
    for (let k = 0; k < 10 * 60 && !v.playerHold; k++) step(sim); // (the order goes out over the radio)
    expect(v.playerHold).toBe(true);
  });
});
