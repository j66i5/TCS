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
/** Does he see an enemy drone within `m` metres horizontally? */
const seesDroneWithin = (sim: Sim, id: number, m: number) => {
  const me = sim.state.transform.req(id);
  return sim.state.soldier.req(id).seen.some((e) => {
    const t = sim.state.transform.get(e.target);
    return sim.state.drone.has(e.target) && sim.state.tick - e.lastTick <= 6 * 60 && t !== undefined && Math.hypot(t.x - me.x, t.y - me.y) <= m;
  });
};
/** Walks him (from 400, 200) toward 120, 200 under the drone flown to 300, 200 until he freezes. */
function frozenWalker(): { sim: Sim; op: number; tgt: number; seenAt: number | null; frozeAt: number | null } {
  const { sim, op, tgt } = setup(cat, 2);
  submitOrder(sim, { tick: 0, issuer: "red", target: tgt, kind: "move", waypoints: [{ x: 120, y: 200, mode: "walk" }] });
  submitOrder(sim, { tick: 0, issuer: "blue", target: op, kind: "drone", op: "fly", x: 300, y: 200, altM: 80 });
  let seenAt: number | null = null, frozeAt: number | null = null;
  for (let k = 0; k < 300 * 60 && frozeAt === null; k++) {
    step(sim);
    // (He freezes only with it nearly overhead: within freezeTriggerM.)
    if (seenAt === null && seesDroneWithin(sim, tgt, H.freezeTriggerM)) seenAt = sim.state.tick;
    const m = sim.state.mover.req(tgt);
    if (sim.state.soldier.req(tgt).droneHide?.kind === "freeze" && m.holdUntilTick !== undefined && m.speedMps === 0) frozeAt = sim.state.tick;
  }
  return { sim, op, tgt, seenAt, frozeAt };
}

describe("hiding from drones (M9.6)", () => {
  it("a man walking under an order freezes when he sees an enemy drone overhead, and moves on after maxFreezeSeconds", () => {
    const { sim, tgt, seenAt, frozeAt } = frozenWalker();
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

  it("after a freeze run he does not freeze again within freezeCooldownSeconds, though the drone stays over him", () => {
    const { sim, tgt, frozeAt } = frozenWalker();
    expect(frozeAt).not.toBeNull();
    // Through the run (maxFreezeSeconds) and on: once spent he walks on, never frozen again within the cooldown.
    for (let k = 0; k < (H.maxFreezeSeconds + 2) * 60; k++) step(sim);
    const dh = sim.state.soldier.req(tgt).droneHide;
    expect(dh?.kind).toBe("spent");
    expect((dh!.until - sim.state.tick) / 60).toBeGreaterThan(H.freezeCooldownSeconds - 5);
    let froze = false, near = false;
    for (let k = 0; k < 60 * 60; k++) {
      step(sim);
      if (seesDroneWithin(sim, tgt, H.freezeTriggerM)) near = true;
      if (sim.state.soldier.req(tgt).droneHide?.kind === "freeze") froze = true;
    }
    expect(near).toBe(true);
    expect(froze).toBe(false);
    expect(sim.state.mover.req(tgt).speedMps).toBeGreaterThan(0.3);
  });

  it("walking with the drone 200 m off he does not freeze; halted he still lies down", () => {
    const { sim, op, tgt } = setup(cat, 3);
    submitOrder(sim, { tick: 0, issuer: "red", target: tgt, kind: "move", waypoints: [{ x: 400, y: 380, mode: "walk" }, { x: 400, y: 240, mode: "walk" }] });
    submitOrder(sim, { tick: 0, issuer: "blue", target: op, kind: "drone", op: "fly", x: 200, y: 200, altM: 80 });
    step(sim); step(sim);
    let saw = false, froze = false;
    for (let k = 0; k < 400 * 60 && sim.state.mover.req(tgt).waypoints.length > 0; k++) {
      step(sim);
      if (seesDroneWithin(sim, tgt, H.triggerM)) saw = true;
      if (sim.state.soldier.req(tgt).droneHide?.kind === "freeze") froze = true;
    }
    expect(saw).toBe(true);
    expect(froze).toBe(false);
    expect(sim.state.mover.req(tgt).waypoints.length).toBe(0);
    run(sim, 10);
    expect(sim.state.soldier.req(tgt).droneHide?.kind).toBe("hide");
    expect(sim.state.soldier.req(tgt).posture).toBe("prone");
  });

  it("a man bolting (a bolt leg, as out of a house) is not frozen by a drone overhead", () => {
    const { sim, op, tgt } = setup(cat, 2);
    submitOrder(sim, { tick: 0, issuer: "red", target: tgt, kind: "move", waypoints: [{ x: 120, y: 200, mode: "walk" }] });
    submitOrder(sim, { tick: 0, issuer: "blue", target: op, kind: "drone", op: "fly", x: 300, y: 200, altM: 80 });
    step(sim); step(sim);
    // (A bolt leg as house.ts sets it: the order's move, marked bolt.)
    const m = sim.state.mover.req(tgt);
    expect(m.waypoints.length).toBeGreaterThan(0);
    for (const w of m.waypoints) w.bolt = true;
    let near = false, froze = false;
    for (let k = 0; k < 150 * 60 && m.waypoints.length > 0; k++) {
      step(sim);
      if (seesDroneWithin(sim, tgt, H.freezeTriggerM)) near = true;
      if (sim.state.soldier.req(tgt).droneHide?.kind === "freeze" || m.holdUntilTick !== undefined) froze = true;
    }
    expect(near).toBe(true);
    expect(froze).toBe(false);
  });

  it("a mortar crew man with the tube deployed is not sent to a canopy: he lies down where he is", () => {
    const { sim, op, tgt } = setup(cat, 4, "near");
    const u = sim.state.unit.req(sim.state.identity.req(tgt).unit);
    u.mortar = { state: "ready", readyTick: 0, stillTick: 0 };
    submitOrder(sim, { tick: 0, issuer: "blue", target: op, kind: "drone", op: "fly", x: 380, y: 200, altM: 80 });
    let hid = false, moved = false;
    for (let k = 0; k < 120 * 60; k++) {
      step(sim);
      const dh = sim.state.soldier.req(tgt).droneHide;
      if (dh?.kind === "hide") hid = true;
      if (dh?.gx !== undefined || sim.state.mover.req(tgt).waypoints.length > 0) moved = true;
    }
    expect(hid).toBe(true);
    expect(moved).toBe(false);
    expect(sim.state.soldier.req(tgt).posture).toBe("prone");
    expect(sim.state.transform.req(tgt).y).toBeLessThan(205);
  });

  it("a man who ran to a canopy walks back to his place, in his fire position's posture, once the drone is gone", () => {
    const { sim, op, tgt } = setup(cat, 4, "near");
    submitOrder(sim, { tick: 0, issuer: "red", target: sim.state.identity.req(tgt).unit, kind: "posture", posture: "crouching" });
    run(sim, 2);
    const home = sim.state.soldier.req(tgt).homePosture;
    const t0 = { ...sim.state.transform.req(tgt) };
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: op, kind: "drone", op: "fly", x: 380, y: 200, altM: 80 });
    for (let k = 0; k < 200 * 60; k++) {
      step(sim);
      const t = sim.state.transform.req(tgt);
      if (t.y >= 226 && sim.state.soldier.req(tgt).posture === "prone" && sim.state.mover.req(tgt).waypoints.length === 0) break;
    }
    expect(sim.state.transform.req(tgt).y).toBeGreaterThanOrEqual(226);
    expect(sim.state.soldier.req(tgt).droneHide?.gx).toBeDefined();
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: op, kind: "drone", op: "home" });
    let back = false;
    for (let k = 0; k < (H.hideSeconds + 90) * 60 && !back; k++) {
      step(sim);
      const t = sim.state.transform.req(tgt);
      back = Math.hypot(t.x - t0.x, t.y - t0.y) < 3 && sim.state.mover.req(tgt).waypoints.length === 0;
    }
    expect(home).toBe("crouching");
    expect(back).toBe(true);
    expect(sim.state.soldier.req(tgt).droneHide).toBeUndefined();
    expect(sim.state.soldier.req(tgt).homePosture).toBe(home);
    run(sim, 3);
    expect(sim.state.soldier.req(tgt).posture).toBe(home);
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
