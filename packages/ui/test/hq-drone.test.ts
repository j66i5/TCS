/**
 * Owner 2026-11-15: the platoon headquarters as its own tile (badged HQ) and its own orders (`own`: its men alone,
 * not the squads), and the drone tile under it whatever the HQ does — riding (the order makes its carrier get out
 * to launch), in the air, lost.
 */
import { describe, expect, it } from "vitest";
import { Strings } from "@tcs/data";
import { createSim, step, submitOrder, type EntityId, type Order, type Sim, type SimEvent } from "@tcs/sim";
import { getScenario, loadData } from "../../tools/src/scenarios";
import { ordersFor, unitCapabilities } from "../src/orders-for";
import { tileKey, tilePart, unitTiles, type UnitTile } from "../src/sidebar";
import { unitMenRows } from "../src/card";

const data = loadData();
const mounted = () => createSim(getScenario("platoon-vehicles").build(data, 1, 600));
const onFoot = () => createSim(getScenario("platoon").build(data, 1, 600));

function run(sim: Sim, seconds: number, until?: (e: SimEvent) => boolean): SimEvent[] {
  const all: SimEvent[] = [];
  for (let k = 0; k < seconds * 60; k++) {
    const ev = step(sim);
    all.push(...ev);
    if (until && ev.some(until)) break;
  }
  return all;
}
const platoonOf = (sim: Sim, side = "blue"): EntityId => [...sim.state.unit.entries()].find(([, u]) => u.side === side && u.parent === null && u.children.length > 0)![0];
const order = (sim: Sim, target: EntityId, body: Record<string, unknown>) => submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target, ...body } as Order);
const tiles = (sim: Sim, side = "blue"): UnitTile[] => unitTiles(sim.state, side, sim.ctx.catalog);
const droneTileOf = (sim: Sim, uid: EntityId) => tiles(sim).find((t) => t.kind === "drone" && t.unit === uid);
/** The man who carries the platoon's quadcopter. */
const carrier = (sim: Sim, uid: EntityId) => sim.state.unit.get(uid)!.members.find((m) => sim.state.container.get(m)!.stacks.some((s) => s.count > 0 && sim.ctx.catalog.items[s.type]?.drone !== undefined));
const squadMen = (sim: Sim, uid: EntityId) => sim.state.unit.get(uid)!.children.filter((c) => sim.state.unit.get(c)!.vehicle === undefined).flatMap((c) => sim.state.unit.get(c)!.members);

describe("the headquarters tile (owner 2026-11-15)", () => {
  it("each platoon: its tile (the whole platoon), then its HQ tile (its own men), then its drone tile", () => {
    for (const side of ["blue", "red"]) {
      const sim = mounted(), uid = platoonOf(sim, side), all = tiles(sim, side);
      const i = all.findIndex((t) => t.unit === uid && t.kind === "hq");
      expect(all[i + 1]).toMatchObject({ unit: uid, kind: "hqGroup", depth: all[i]!.depth + 1, total: sim.state.unit.get(uid)!.members.length });
      if (side === "blue") expect(all[i + 1]!.state).toBe("aboard"); // (the attacker starts mounted)
      expect(all[i + 2]).toMatchObject({ unit: uid, kind: "drone", depth: all[i]!.depth + 2 });
      expect(tilePart(all[i]!)).toBeUndefined();
      expect(tilePart(all[i + 1]!)).toBe("hq");
      expect(tilePart(all[i + 2]!)).toBe("drone");
      expect(new Set(all.map(tileKey)).size).toBe(all.length);
      // The hull that carries the HQ says so.
      if (side === "blue") expect(all.filter((t) => t.kind === "vehicle" && t.hqAboard === true).length).toBe([...sim.state.unit.values()].filter((u) => u.side === "blue" && u.parent === null && u.children.length > 0).length); // (one hull per platoon)
      // Its card lists its own men alone.
      expect(unitMenRows(sim.state, sim.ctx.catalog, uid, true).map((r) => r.id).sort()).toEqual([...sim.state.unit.get(uid)!.members].sort());
    }
  });
  it("the HQ label is in the string table for both factions", () => {
    const st = new Strings(data, "en");
    for (const f of ["de", "ru"]) expect(st.t("side.hq", {}, f)).toBe("HQ");
    expect(st.t("side.droneAboard", { pct: 80 })).not.toMatch(/^\[\[/);
    expect(st.t("side.platoonAll")).not.toMatch(/^\[\[/);
    expect(st.t("side.hqAboard")).not.toMatch(/^\[\[/);
  });
  it("its order bar: getting out (riding) or in, moves and fire, no drills", () => {
    const sim = mounted(), uid = platoonOf(sim);
    const cap = unitCapabilities(sim.state, sim.ctx.catalog, uid, true);
    expect(cap.own).toBe(true);
    expect(cap.ableMen).toBe(sim.state.unit.get(uid)!.members.length);
    expect(cap.canDismount).toBe(true);
    const set = ordersFor(cap, sim.ctx.catalog.movementModes);
    expect(set.dismount).toBe(true);
    expect(set.modes).toContain("move");
    for (const m of ["assault", "withdraw", "occupy", "clear"] as const) expect(set.modes).not.toContain(m);
  });
});

describe("orders to the headquarters alone (`own`)", () => {
  it("HQ only: dismount and mount move its own men; the squads stay aboard", () => {
    const sim = mounted(), uid = platoonOf(sim), hq = sim.state.unit.get(uid)!.members, sq = squadMen(sim, uid);
    order(sim, uid, { kind: "dismount", own: true });
    run(sim, 40);
    expect(hq.every((m) => sim.state.soldier.get(m)!.mount === undefined)).toBe(true);
    expect(sq.every((m) => sim.state.soldier.get(m)!.mount !== undefined)).toBe(true);
    expect(unitCapabilities(sim.state, sim.ctx.catalog, uid, true).canMount).toBe(true);
    order(sim, uid, { kind: "mount", own: true });
    run(sim, 60);
    expect(hq.every((m) => sim.state.soldier.get(m)!.mount !== undefined)).toBe(true);
    expect(sq.every((m) => sim.state.soldier.get(m)!.mount !== undefined)).toBe(true);
  });
  it("HQ only: a move moves its men; the squads stand still", () => {
    const sim = onFoot(), uid = platoonOf(sim), hq = sim.state.unit.get(uid)!.members, sq = squadMen(sim, uid);
    const t = sim.state.transform.get(hq[0]!)!;
    order(sim, uid, { kind: "move", own: true, waypoints: [{ x: t.x + 40, y: t.y, mode: "walk" }] });
    run(sim, 5);
    expect(hq.some((m) => (sim.state.mover.get(m)?.waypoints.length ?? 0) > 0)).toBe(true);
    expect(sq.every((m) => (sim.state.mover.get(m)?.waypoints.length ?? 0) === 0)).toBe(true);
  });
  it("the platoon's tile: a move moves everyone", () => {
    const sim = onFoot(), uid = platoonOf(sim), sq = squadMen(sim, uid);
    const t = sim.state.transform.get(sim.state.unit.get(uid)!.members[0]!)!;
    order(sim, uid, { kind: "move", waypoints: [{ x: t.x + 40, y: t.y, mode: "walk" }] });
    run(sim, 5);
    expect(sq.filter((m) => (sim.state.mover.get(m)?.waypoints.length ?? 0) > 0).length).toBeGreaterThan(sq.length / 2);
  });
  it("`own` is refused for a drill and for a unit with no men of its own", () => {
    const sim = onFoot(), uid = platoonOf(sim);
    const squad = sim.state.unit.get(uid)!.children[0]!;
    order(sim, uid, { kind: "assault", own: true, x: 300, y: 300 });
    order(sim, squad, { kind: "halt", own: true });
    const ev = run(sim, 1);
    expect(ev.filter((e) => e.kind === "order.rejected" && e.reason === "invalid-params").length).toBe(1);
  });
});

describe("the drone tile whatever the HQ does (owner 2026-11-15)", () => {
  it("mounted HQ: the tile is there (aboard: he gets out to launch); the order makes him dismount, then launch", () => {
    const sim = mounted(), uid = platoonOf(sim), op = carrier(sim, uid)!;
    expect(droneTileOf(sim, uid)).toMatchObject({ droneUp: false, droneAboard: true, state: "aboard", dronePct: 100 });
    const hq = sim.state.unit.get(uid)!.members, sq = squadMen(sim, uid);
    // Without `dismount` (the AI's orders) nobody gets out and nothing goes up.
    order(sim, uid, { kind: "drone", op: "fly", x: 300, y: 300 });
    run(sim, 30);
    expect(sim.state.drone.size).toBe(0);
    expect(sim.state.soldier.get(op)!.mount).toBeDefined();
    // The player's order: he gets out by himself and launches it.
    order(sim, uid, { kind: "drone", op: "fly", x: 300, y: 300, dismount: true });
    const ev = run(sim, 120, (e) => e.kind === "drone.launched");
    expect(ev.some((e) => e.kind === "drone.launched")).toBe(true);
    expect(sim.state.soldier.get(op)!.mount).toBeUndefined();
    expect(hq.filter((m) => m !== op).every((m) => sim.state.soldier.get(m)!.mount !== undefined)).toBe(true);
    expect(sq.every((m) => sim.state.soldier.get(m)!.mount !== undefined)).toBe(true);
    // In the air (the rest of the HQ riding): its tile, with its battery, under the HQ's tile.
    run(sim, 5);
    const all = tiles(sim), k = all.findIndex((t) => t.kind === "drone" && t.unit === uid);
    expect(all[k]).toMatchObject({ droneUp: true, state: "ok" });
    expect(all[k]!.dronePct).toBeGreaterThan(90);
    expect(all[k - 1]).toMatchObject({ kind: "hqGroup", unit: uid });
  });
  it("drone lost: no tile any more", () => {
    const sim = onFoot(), uid = platoonOf(sim);
    expect(droneTileOf(sim, uid)).toMatchObject({ droneUp: false, state: "ok" });
    order(sim, uid, { kind: "drone", op: "fly", x: 300, y: 300 });
    run(sim, 90, (e) => e.kind === "drone.launched");
    const [id, d] = [...sim.state.drone.entries()].find(([, x]) => x.unit === uid)!;
    expect(droneTileOf(sim, uid)?.droneUp).toBe(true);
    d.hitTick = sim.state.tick + 1;
    const ev = run(sim, 2);
    expect(ev.some((e) => e.kind === "drone.lost" && e.drone === id)).toBe(true);
    expect(droneTileOf(sim, uid)).toBeUndefined();
  });
});
