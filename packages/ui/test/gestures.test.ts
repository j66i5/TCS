/** The "controls" step (owner choices S1, S2, S9, S10, S12): gesture helpers, and the orders they send work. */
import { describe, expect, it } from "vitest";
import { demoBattle, vehicleBattle } from "@tcs/scenario";
import { createSim, step, submitOrder, type Order } from "@tcs/sim";
import { loadData } from "../../tools/src/scenarios";
import { addPoint, newPlan, planToOrder } from "../src/planner";
import { markerGeometry } from "../src/planner";
import { centreOf, facingHandleAt, inPlacePoint, isDoubleTap, losPreview, modeAfterOrder, onUnitAt, retargetMove } from "../src/gestures";
import { ordersFor } from "../src/orders-for";

const angDiff = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

describe("gesture helpers", () => {
  it("S12: a one-tap order returns to Move unless locked; a double-tap is two clicks on one button in time", () => {
    expect(modeAfterOrder("fire", false)).toBe("move");
    expect(modeAfterOrder("fire", true)).toBe("fire");
    expect(isDoubleTap({ mode: "fire", at: 1000 }, "fire", 1300)).toBe(true);
    expect(isDoubleTap({ mode: "fire", at: 1000 }, "fire", 1500)).toBe(false);
    expect(isDoubleTap({ mode: "grenade", at: 1000 }, "fire", 1100)).toBe(false);
    expect(isDoubleTap(null, "fire", 1100)).toBe(false);
  });
  it("on the unit, its centre, the facing handle ahead of the man farthest forward", () => {
    const men = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 4 }];
    expect(onUnitAt(men, 10.5, 0.5, 1)).toBe(true);
    expect(onUnitAt(men, 20, 0, 1)).toBe(false);
    const c = centreOf(men)!;
    expect(c.x).toBeCloseTo(5); expect(c.y).toBeCloseTo(4 / 3);
    const h = facingHandleAt(c, men, Math.PI / 2, 3); // facing south (+y): the man at y 4 is farthest forward
    expect(h.x).toBeCloseTo(5); expect(h.y).toBeCloseTo(4 + 3);
    const v = facingHandleAt({ x: 0, y: 0 }, [], 0, 3, 4); // a hull: half its length, then the gap
    expect(v.x).toBeCloseTo(7);
  });
  it("S10: re-targeting keeps pace, formation and frontage and faces along the new way", () => {
    const prev: Extract<Order, { kind: "move" }> = { tick: 5, issuer: "blue", target: 9, kind: "move", waypoints: [{ x: 10, y: 0, mode: "walk" }, { x: 50, y: 0, mode: "run" }], formation: "wedge", facing: 0, frontageM: 30 };
    const o = retargetMove(prev, { x: 0, y: 60 }, { x: 0, y: 0 }, 99);
    expect(o.tick).toBe(99);
    expect(o.waypoints).toEqual([{ x: 0, y: 60, mode: "run" }]);
    expect(o.formation).toBe("wedge"); expect(o.frontageM).toBe(30);
    expect(o.facing).toBeCloseTo(Math.PI / 2);
  });
});

describe("S2 line-of-sight preview", () => {
  it("clear over open ground; a hull the side does not know is looked through, a known one blocks", () => {
    const data = loadData();
    const input = vehicleBattle(data, { seed: 1, factions: ["de", "ru"], timeLimitSeconds: 600 });
    const sim = createSim(input);
    step(sim); // the vehicle grid is built in the first tick
    const [vid] = [...sim.state.vehicle.entries()][0]!;
    const t = sim.state.transform.req(vid);
    const ground = 0; // the flat map
    const eye = { x: t.x - 30, y: t.y, z: ground + 1.6, ignore: -1 };
    const open = losPreview(sim.ctx, [{ ...eye, y: t.y + 60 }], t.x + 30, t.y + 60, ground + 0.75, () => -1);
    expect(open[0]!.clear).toBe(true);
    expect(open[0]!.stopAt).toBe(1);
    const known = losPreview(sim.ctx, [eye], t.x + 30, t.y, ground + 0.75, () => -1);
    expect(known[0]!.clear).toBe(false);
    expect(known[0]!.stopAt).toBeGreaterThan(0.3);
    expect(known[0]!.stopAt).toBeLessThan(0.7);
    const unknown = losPreview(sim.ctx, [eye], t.x + 30, t.y, ground + 0.75, () => vid);
    expect(unknown[0]!.clear).toBe(true);
  });
});

describe("S9 turn in place: the existing move with a facing, to where the unit stands", () => {
  it("a squad on foot ends facing the way the handle was dragged", () => {
    const data = loadData();
    const input = demoBattle(data, { seed: 3, factions: ["de", "ru"], mapWidthM: 600, mapHeightM: 400, timeLimitSeconds: 600 });
    input.forces[1]!.placements = input.forces[1]!.placements.map((p) => ({ ...p, x: 590, y: 390 }));
    const sim = createSim(input);
    const [uid, unit] = [...sim.state.unit.entries()].find(([, u]) => u.side === "blue" && u.parent === null)!;
    const men = [...sim.state.identity.entries()].filter(([, i]) => i.side === "blue").map(([id]) => sim.state.transform.req(id));
    const c = centreOf(men)!;
    const face = Math.PI / 2 + 0.4;
    const formation = input.catalog.factions["de"]!.defaultFormation;
    const at = (p: { x: number; y: number }) => ({ ...addPoint(newPlan("move", c, formation, 30), p.x, p.y, "walk"), facing: face });
    const slots = input.catalog.formations[formation]!.slots;
    const plan = at(inPlacePoint(c, markerGeometry(at(c), slots, men.length, 10)!.men));
    submitOrder(sim, planToOrder(plan, "blue", uid, 0)!);
    for (let k = 0; k < 60 * 60; k++) step(sim);
    expect(unit.moving).toBe(false);
    expect(angDiff(sim.state.transform.req(unit.leader!).heading, face)).toBeLessThan(0.3);
    const after = centreOf([...sim.state.identity.entries()].filter(([, i]) => i.side === "blue").map(([id]) => sim.state.transform.req(id)))!;
    expect(Math.hypot(after.x - c.x, after.y - c.y)).toBeLessThan(4); // turned where it stood
  });
  it("a vehicle turns on the spot", () => {
    const data = loadData();
    const input = vehicleBattle(data, { seed: 1, factions: ["de", "ru"], timeLimitSeconds: 600 });
    const sim = createSim(input);
    const [vid, v] = [...sim.state.vehicle.entries()].find(([, x]) => x.side === "blue")!;
    const t = sim.state.transform.req(vid);
    const x0 = t.x, y0 = t.y, face = t.heading + Math.PI / 2;
    const cls = input.catalog.vehicles[v.def]!.class as "tracked" | "wheeled";
    const set = ordersFor(cls, input.catalog.movementModes);
    submitOrder(sim, { tick: 0, issuer: "blue", target: v.unit!, kind: "move", waypoints: [{ x: x0, y: y0, mode: set.paces[0]! }], facing: face });
    for (let k = 0; k < 60 * 40; k++) step(sim);
    const t1 = sim.state.transform.req(vid);
    expect(angDiff(t1.heading, face)).toBeLessThan(0.2);
    expect(Math.hypot(t1.x - x0, t1.y - y0)).toBeLessThan(6);
  });
});
