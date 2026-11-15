/** M9.6: hiding from drones — a man on his way freezes when he sees an enemy drone near, a halted man in the open goes
 *  under a canopy close by and lies down; nothing changes without drones; save and load while hiding. */
import { describe, expect, it } from "vitest";
import { buildCatalog } from "@tcs/data";
import { createSim, hashState, loadSim, saveSim, step, submitOrder, type BattleInput, type Catalog, type Sim } from "@tcs/sim";
import { droneLabBattle, noDroneHide } from "../src/labs/drone";
import { loadData } from "../src/scenarios";

const data = loadData();
const cat = buildCatalog(data, ["de", "ru"]);
const H = cat.behaviour.soldier.droneHide!;

function run(sim: Sim, seconds: number): void {
  for (let k = 0; k < seconds * 60; k++) step(sim);
}
function setup(c: Catalog, seed: number, wood: "none" | "near" = "none"): { input: BattleInput; sim: Sim; op: number; tgt: number } {
  const input = droneLabBattle(c, { name: "hide", altM: 80, posture: "standing" }, seed, 900);
  if (wood === "near") {
    // A woodland strip 25 m south of the man at (400, 200): y 225-260.
    const map = input.map;
    map.vegetationPalette.push("woodland");
    const v = map.vegetationPalette.length;
    for (let r = Math.ceil(225 / map.cellSizeM); r < Math.floor(260 / map.cellSizeM); r++) for (let col = 0; col < map.cols; col++) map.vegetation[r * map.cols + col] = v;
  }
  const sim = createSim(input);
  const ids = [...sim.state.identity.entries()];
  const op = ids.find(([, i]) => i.side === "blue")![0], tgt = ids.find(([, i]) => i.side === "red")![0];
  // (Both hold their fire: only the drone is in this.)
  for (const [u, un] of sim.state.unit.entries()) submitOrder(sim, { tick: 0, issuer: un.side, target: u, kind: "rules", fire: "hold" });
  return { input, sim, op, tgt };
}
const seesDrone = (sim: Sim, id: number) => sim.state.soldier.req(id).seen.some((e) => sim.state.drone.has(e.target) && sim.state.tick - e.lastTick <= 6 * 60);

describe("hiding from drones (M9.6)", () => {
  it("a man walking under an order freezes when he sees an enemy drone overhead, and moves on after maxFreezeSeconds", () => {
    const { sim, op, tgt } = setup(cat, 2);
    submitOrder(sim, { tick: 0, issuer: "red", target: tgt, kind: "move", waypoints: [{ x: 120, y: 200, mode: "walk" }] });
    submitOrder(sim, { tick: 0, issuer: "blue", target: op, kind: "drone", op: "fly", x: 300, y: 200, altM: 80 });
    let seenAt: number | null = null, frozeAt: number | null = null;
    for (let k = 0; k < 300 * 60 && frozeAt === null; k++) {
      step(sim);
      if (seenAt === null && seesDrone(sim, tgt)) seenAt = sim.state.tick;
      const m = sim.state.mover.req(tgt);
      if (sim.state.soldier.req(tgt).droneHide?.kind === "freeze" && m.holdUntilTick !== undefined && m.speedMps === 0) frozeAt = sim.state.tick;
    }
    expect(seenAt).not.toBeNull();
    expect(frozeAt).not.toBeNull();
    expect((frozeAt! - seenAt!) / 60).toBeLessThanOrEqual(3);
    expect(sim.state.soldier.req(tgt).intent?.kind).toBe("hideDrone");
    // The drone stays over him: he moves on regardless once he has stood still for maxFreezeSeconds.
    const since = sim.state.soldier.req(tgt).droneHide!.since;
    let movedAt: number | null = null;
    for (let k = 0; k < (H.maxFreezeSeconds + 10) * 60 && movedAt === null; k++) {
      step(sim);
      if (sim.state.mover.req(tgt).speedMps > 0.3) movedAt = sim.state.tick;
    }
    expect(sim.state.drone.size).toBe(1);
    expect(movedAt).not.toBeNull();
    expect((movedAt! - since) / 60).toBeGreaterThanOrEqual(H.maxFreezeSeconds - 1);
    expect((movedAt! - since) / 60).toBeLessThanOrEqual(H.maxFreezeSeconds + 3);
  });

  it("frozen, he moves on once the drone is gone", () => {
    const { sim, op, tgt } = setup(cat, 2);
    submitOrder(sim, { tick: 0, issuer: "red", target: tgt, kind: "move", waypoints: [{ x: 120, y: 200, mode: "walk" }] });
    submitOrder(sim, { tick: 0, issuer: "blue", target: op, kind: "drone", op: "fly", x: 300, y: 200, altM: 80 });
    for (let k = 0; k < 300 * 60 && sim.state.soldier.req(tgt).droneHide?.kind !== "freeze"; k++) step(sim);
    expect(sim.state.soldier.req(tgt).droneHide?.kind).toBe("freeze");
    const x0 = sim.state.transform.req(tgt).x;
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: op, kind: "drone", op: "home" });
    run(sim, 45);
    expect(sim.state.soldier.req(tgt).droneHide).toBeUndefined();
    expect(sim.state.transform.req(tgt).x).toBeLessThan(x0 - 5);
  });

  it("a halted man in the open with woodland 25 m away goes under its canopy and lies down", () => {
    const { sim, op, tgt } = setup(cat, 4, "near");
    submitOrder(sim, { tick: 0, issuer: "blue", target: op, kind: "drone", op: "fly", x: 380, y: 200, altM: 80 });
    let went = false;
    for (let k = 0; k < 300 * 60; k++) {
      step(sim);
      if (sim.state.soldier.req(tgt).droneHide?.kind === "hide") went = true;
      const t = sim.state.transform.req(tgt);
      if (went && t.y >= 226 && sim.state.soldier.req(tgt).posture === "prone" && sim.state.mover.req(tgt).waypoints.length === 0) break;
    }
    const t = sim.state.transform.req(tgt), s = sim.state.soldier.req(tgt);
    expect(went).toBe(true);
    expect(t.y).toBeGreaterThanOrEqual(226);
    expect(t.y).toBeLessThan(260);
    expect(s.posture).toBe("prone");
    // He stays down there while the drone is about.
    run(sim, 20);
    expect(sim.state.soldier.req(tgt).posture).toBe("prone");
    expect(sim.state.transform.req(tgt).y).toBeGreaterThanOrEqual(226);
  });

  it("with no drones nothing changes: the same state as with hiding switched off, and no droneHide", () => {
    const go = (c: Catalog) => {
      const { sim, tgt } = setup(c, 5);
      submitOrder(sim, { tick: 0, issuer: "red", target: tgt, kind: "move", waypoints: [{ x: 300, y: 300, mode: "walk" }] });
      run(sim, 60);
      return sim;
    };
    const a = go(cat), b = go(noDroneHide(cat));
    expect(hashState(a.state)).toBe(hashState(b.state));
    for (const [, s] of a.state.soldier.entries()) expect(s.droneHide).toBeUndefined();
  });

  it("save and load while he hides: the battle goes on identically", () => {
    const { input, sim, op, tgt } = setup(cat, 4, "near");
    submitOrder(sim, { tick: 0, issuer: "blue", target: op, kind: "drone", op: "fly", x: 380, y: 200, altM: 80 });
    for (let k = 0; k < 300 * 60 && sim.state.soldier.req(tgt).droneHide === undefined; k++) step(sim);
    expect(sim.state.soldier.req(tgt).droneHide).toBeDefined();
    run(sim, 2);
    const copy = loadSim({ ...input, orders: [] }, saveSim(sim));
    expect(hashState(copy.state)).toBe(hashState(sim.state));
    expect(copy.state.soldier.req(tgt).droneHide).toEqual(sim.state.soldier.req(tgt).droneHide);
    run(sim, 30); run(copy, 30);
    expect(hashState(copy.state)).toBe(hashState(sim.state));
  });
});
