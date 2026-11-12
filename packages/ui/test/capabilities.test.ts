/** M7.5a: the order bar offers only what the selected unit can do now (plan m7.5 §3). */
import { describe, expect, it } from "vitest";
import { createSim, type EntityId, type Sim } from "@tcs/sim";
import { getScenario, loadData } from "../../tools/src/scenarios";
import { boardingOf, noOrders, ordersFor, unitCapabilities, unitSoldierIds } from "../src/orders-for";

const data = loadData();
const fresh = (): Sim => createSim(getScenario("platoon-vehicles").build(data, 1, 600));
const blueSquad = (sim: Sim) => [...sim.state.unit.entries()].find(([, u]) => u.side === "blue" && u.echelon === "squad")![0];
const blueCrew = (sim: Sim) => [...sim.state.unit.entries()].find(([, u]) => u.side === "blue" && u.vehicle !== undefined)![0];
const dropItems = (sim: Sim, men: EntityId[], test: (type: string) => boolean) => {
  for (const m of men) { const c = sim.state.container.get(m); if (c) c.stacks = c.stacks.filter((st) => !test(st.type)); }
};

describe("unitCapabilities and ordersFor (M7.5a)", () => {
  const sim = fresh();
  const cat = sim.ctx.catalog;
  const modes = cat.movementModes;

  it("nothing selected: kind none, the greyed bar", () => {
    const cap = unitCapabilities(sim.state, cat, null);
    expect(cap.kind).toBe("none");
    expect(ordersFor(cap, modes)).toEqual(noOrders());
    expect(noOrders().none).toBe(true);
  });

  it("a squad aboard its Puma: launcher, grenades, fire support; it can get out, not in", () => {
    const uid = blueSquad(sim);
    const cap = unitCapabilities(sim.state, cat, uid);
    expect(cap.kind).toBe("group");
    expect(cap.hasLauncherRounds).toBe(true);
    expect(cap.handGrenades).toBeGreaterThan(0);
    expect(cap.rifleGrenades).toBeGreaterThan(0);
    expect(cap.supportHe).toBeGreaterThan(0);
    expect(cap.canDismount).toBe(true);
    expect(cap.canMount).toBe(false);
    const o = ordersFor(cap, modes);
    expect(o.modes).toEqual(["move", "assault", "withdraw", "fire", "antitank", "grenade", "grenades", "mortar", "smoke"]);
    expect(o.dismount && !o.mount && o.posture && o.rules).toBe(true);
    expect(boardingOf(sim.state, cat, uid)).toEqual({ mount: false, dismount: true });
  });

  it("no launcher rounds: no Anti-tank; no grenades: no Grenade buttons; no mortar rounds: no Mortar / Smoke", () => {
    const s2 = fresh();
    const uid = blueSquad(s2);
    const men = unitSoldierIds(s2.state, uid);
    const isRocket = (t: string) => s2.ctx.catalog.ammo[t]?.delivery?.method === "direct";
    dropItems(s2, men, isRocket);
    expect(ordersFor(unitCapabilities(s2.state, cat, uid), modes).modes).not.toContain("antitank");
    dropItems(s2, men, (t) => s2.ctx.catalog.ammo[t]?.delivery !== undefined);
    const o = ordersFor(unitCapabilities(s2.state, cat, uid), modes);
    expect(o.modes).not.toContain("grenade");
    expect(o.modes).not.toContain("grenades");
    for (const sp of s2.state.support) { const c = s2.state.container.get(sp.battery); if (c) c.stacks = []; }
    expect(ordersFor(unitCapabilities(s2.state, cat, uid), modes).modes).toEqual(["move", "assault", "withdraw", "fire"]);
  });

  it("a launcher without rounds does not count (the simulation's own test)", () => {
    const s2 = fresh();
    const uid = blueSquad(s2);
    const men = unitSoldierIds(s2.state, uid);
    dropItems(s2, men, (t) => s2.ctx.catalog.ammo[t]?.delivery?.method === "direct" && s2.ctx.catalog.ammo[t]?.explosive !== undefined);
    expect(unitCapabilities(s2.state, cat, uid).hasLauncherRounds).toBe(false);
  });

  it("a vehicle: its guns' natures, its smoke dischargers, its passengers; it can let them out", () => {
    const uid = blueCrew(sim);
    const cap = unitCapabilities(sim.state, cat, uid);
    expect(cap.kind).toBe("vehicle");
    expect(cap.natures).toEqual(["ap", "he", "mg"]);
    expect(cap.hasSmokeDischargers).toBe(true);
    expect(cap.passengers).toBe(6);
    const o = ordersFor(cap, modes);
    expect(o.modes).toEqual(["move", "fire"]);
    expect(o.discharge && o.nature && o.dismount && !o.mount).toBe(true);
    expect(o.natures).toEqual(["ap", "he", "mg"]);
    expect(o.paces.at(-1)).toBe("reverse");
    // Dischargers empty: no smoke screen button.
    const s2 = fresh();
    const vid = s2.state.unit.get(uid)!.vehicle!;
    const item = cat.vehicles[s2.state.vehicle.get(vid)!.def]!.dischargers!.item;
    const c = s2.state.container.get(vid)!;
    c.stacks = c.stacks.filter((st) => st.type !== item);
    expect(ordersFor(unitCapabilities(s2.state, cat, uid), modes).discharge).toBe(false);
  });

  it("one able man left: move, fire, grenade, posture, halt, cease fire", () => {
    const s2 = fresh();
    const uid = blueSquad(s2);
    const men = unitSoldierIds(s2.state, uid);
    for (const m of men.slice(1)) s2.state.soldier.req(m).physiology.consciousness = 0;
    const cap = unitCapabilities(s2.state, cat, uid);
    expect(cap.kind).toBe("man");
    const o = ordersFor(cap, modes);
    expect(o.modes.filter((m) => m !== "grenade")).toEqual(["move", "fire"]);
    expect(o.posture && o.halt && o.ceaseFire && !o.rules).toBe(true);
    for (const m of men) s2.state.soldier.req(m).physiology.consciousness = 0;
    expect(unitCapabilities(s2.state, cat, uid).kind).toBe("none");
  });

  it("is pure: reading capabilities does not change the state hash", async () => {
    const { simHash } = await import("@tcs/sim");
    const s2 = fresh();
    const h = simHash(s2);
    for (const [uid] of s2.state.unit.entries()) unitCapabilities(s2.state, cat, uid);
    expect(simHash(s2)).toBe(h);
  });
});
