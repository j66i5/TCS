/**
 * Damage outcome (M7.4a, owner Q8, Q9, Q11, Q14, Q15): penetrating hits wound men inside and damage parts along
 * the path and in the fragment cone; immobilised; the crew fights on while hits bounce off and bails out when
 * penetrated again; a burning vehicle is left and burns out; wrecks are known to both sides, stamped in the
 * navigation grids and listed in the result; vehicle points.
 */
import { describe, expect, it } from "vitest";
import { battleScore, componentIndex, createSim, isMounted, resolveVehicleHit, step, submitOrder, TICK_HZ, vehicleRow, type EntityId, type Sim, type SimEvent } from "@tcs/sim";
import { duel } from "../src/labs/gunnery";
import { loadData } from "../src/scenarios";

const data = loadData();
function run(sim: Sim, seconds: number, on: (e: SimEvent) => void = () => undefined): void {
  for (let i = 0; i < seconds * TICK_HZ; i++) for (const e of step(sim)) on(e);
}
/** A halted BMP-2 (red, side-on to the west) with its crew, and a Puma far off; everyone holds fire. */
function target(): { sim: Sim; vid: EntityId; shooter: EntityId } {
  const sim = createSim(duel(data, ["de", "ru"], { blue: { x: 100, y: 1100, heading: 0 }, red: { x: 1200, y: 600, heading: Math.PI / 2 } }));
  for (const [uid, u] of sim.state.unit.entries()) if (u.parent === null) submitOrder(sim, { tick: 0, issuer: u.side, target: uid, kind: "rules", fire: "hold", at: "hold" });
  step(sim);
  const vid = [...sim.state.vehicle.entries()].find(([, v]) => v.side === "red")![0];
  const shooter = [...sim.state.identity.entries()].find(([, i]) => i.side === "blue")![0];
  return { sim, vid, shooter };
}
/** A round of `ammo` at `speed` striking the BMP-2's left side square on at hull middle height (resolved as after the loop). */
function hitSide(sim: Sim, vid: EntityId, shooter: EntityId, ammo: string, speed: number, events: SimEvent[]): void {
  const G = sim.ctx.ballistics.vehicles, row = vehicleRow(G, vid);
  const t = sim.state.transform.req(vid), def = sim.ctx.catalog.vehicles["ru-bmp2"]!;
  // Heading south: the left side faces east... the hull's +r is to its right (west); strike from the west going east.
  const x = t.x - def.body.hull.r[1] + 0.0, y = t.y + 0.5, z = G.gz[row]! + 1.0;
  const sink = { events, emit(e: SimEvent) { events.push(e); } };
  resolveVehicleHit(sim.ctx, sim.state, sink as never, row, x, y, z, speed, 0, 0, speed, sim.ctx.catalog.ammoIds.indexOf(ammo), shooter, 0, 1, 100, () => undefined);
}

describe("damage inside and the outcome (M7.4a)", () => {
  it("a rifle round stops at the side; 30 mm APFSDS goes through and damages men and parts along its path or in the cone (Q11)", () => {
    const { sim, vid, shooter } = target();
    const ev: SimEvent[] = [];
    hitSide(sim, vid, shooter, "de-762-dm111", 800, ev);
    expect(ev.filter((e) => e.kind === "vehicle.hit").length).toBe(0); // aggregated per tick by the loop
    expect(sim.state.vehicle.req(vid).lastPenTick).toBeLessThan(0);
    let damaged = 0;
    for (let k = 0; k < 5; k++) {
      const e2: SimEvent[] = [];
      hitSide(sim, vid, shooter, "de-30x173-pmc287", 1300, e2);
      const vh = e2.find((e) => e.kind === "vehicle.hit")!;
      expect(vh.kind === "vehicle.hit" && vh.result).toBe("penetrated");
      damaged += e2.filter((e) => e.kind === "vehicle.component" || e.kind === "hit").length;
    }
    expect(damaged).toBeGreaterThan(0);
    expect(sim.state.vehicle.req(vid).lastPenTick).toBe(sim.state.tick);
  });

  it("Q15/Q14: immobilised, it fights on while hits bounce off; penetrated again, crew and passengers bail out", () => {
    const { sim, vid, shooter } = target();
    const v = sim.state.vehicle.req(vid), def = sim.ctx.catalog.vehicles[v.def]!;
    // Its engine is wrecked (as a hit would): immobilised.
    v.comp[componentIndex(def, "engine")] = 0;
    const ev: SimEvent[] = [];
    hitSide(sim, vid, shooter, "de-762-dm111", 800, ev);
    v.status = "immobilised"; // (what the outcome sets after the hit that wrecked the engine)
    hitSide(sim, vid, shooter, "de-30x173-he", 0, ev); // HE on the side: no hole in 18 mm
    expect(v.crewReaction).not.toBe("bailOut");
    run(sim, 5);
    expect(v.status).toBe("immobilised");
    // Penetrated again: out they get.
    const aboard0 = v.seats.filter((m) => m !== null).length;
    hitSide(sim, vid, shooter, "de-30x173-pmc287", 1300, ev);
    expect(v.crewReaction).toBe("bailOut");
    expect(v.reactionWhy).toContain("reaction.immobilisedPenetrated");
    run(sim, 10);
    expect(["abandoned", "destroyed"]).toContain(v.status as string);
    const still = v.seats.filter((m) => m !== null && sim.state.soldier.get(m)!.impair.canWalk && sim.state.soldier.get(m)!.physiology.alive);
    expect(still.length).toBe(0);
    expect(aboard0).toBeGreaterThan(0);
  });

  it("a burning vehicle is left at once and burns out: destroyed; a man left inside is burnt; both sides know the wreck (Q8)", () => {
    const { sim, vid } = target();
    const v = sim.state.vehicle.req(vid);
    // One crewman cannot move (unconscious): he stays inside.
    const stuck = v.seats.find((m) => m !== null)!;
    sim.state.soldier.req(stuck!).physiology.consciousness = 0;
    sim.state.soldier.req(stuck!).impair.canWalk = false;
    v.fire = { startTick: sim.state.tick, nextCheckTick: sim.state.tick + 1e9, intensity: 1 };
    const events: SimEvent[] = [];
    run(sim, 5, (e) => events.push(e));
    expect(events.some((e) => e.kind === "vehicle.abandoned")).toBe(true);
    expect(isMounted(sim.state.soldier.get(stuck!))).toBe(true);
    // Somebody of the blue side knows the vehicle: mark a contact, then let it burn out.
    const blueMan = [...sim.state.identity.entries()].find(([, i]) => i.side === "blue")![0];
    sim.state.soldier.req(blueMan).contacts.push({ target: vid, x: 0, y: 0, errM: 0, kind: "reported", tick: sim.state.tick, reportedTick: sim.state.tick, cls: "vehicle" });
    run(sim, sim.ctx.catalog.behaviour.crew.burnSeconds, (e) => events.push(e));
    expect(v.status).toBe("destroyed");
    expect(events.some((e) => e.kind === "vehicle.destroyed")).toBe(true);
    expect(sim.state.soldier.req(stuck!).wounds.some((w) => w.mechanism === "burn")).toBe(true);
    expect(sim.state.soldier.req(blueMan).contacts.find((c) => c.target === vid)?.wreck).toBe(true);
    // A wreck: stamped in the navigation grids.
    run(sim, 1);
    expect(sim.ctx.navStamps.length).toBe(1);
  });

  it("Q9: a lost vehicle costs its side 20 points, an immobilised one 10", () => {
    const { sim, vid } = target();
    sim.ctx.rules.victory = { casualtyPoints: 5, endOnDefeat: false, vehiclePoints: { lost: 20, immobilised: 10 } };
    const red = () => battleScore(sim.ctx, sim.state).scores.find((s) => s.side === "red")!;
    const s0 = red().score;
    sim.state.vehicle.req(vid).status = "immobilised";
    expect(red().score).toBe(s0 - 10);
    sim.state.vehicle.req(vid).status = "destroyed";
    expect(red().score).toBe(s0 - 20);
    expect(red().vehiclesLost).toBe(1);
  });
});
