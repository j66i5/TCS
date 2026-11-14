/**
 * Guided missiles on vehicles (M9.3a, roadmap-detail slice 32): the Puma's MELLS Spike LR (fire-and-forget, top
 * attack; flies on to the last point seen through smoke; owner M9 round), the xf wagon's beam-riding dart (fixture),
 * the launch warning (the target's crew fires its smoke), and MELLS reloaded from outside with a man exposed.
 */
import { describe, expect, it } from "vitest";
import { createSim, step, submitOrder, TICK_HZ, type SimEvent } from "@tcs/sim";
import { missileSetup, missileTrial } from "../src/labs/missile";
import { loadData } from "../src/scenarios";

const data = loadData(true);

describe("guided missiles on vehicles (M9.3a)", () => {
  it("MELLS: a Spike LR fired from the Puma hits a BMP-2 at 1000 and 3500 m from above (top attack) and gets through", () => {
    for (const range of [1000, 3500]) {
      const { input, shooter, target } = missileSetup(data, range, "front", 2100, "f&f");
      const sim = createSim(input);
      for (const [uid, u] of sim.state.unit.entries()) if (u.parent === null) submitOrder(sim, { tick: 0, issuer: u.side, target: uid, kind: "rules", fire: "hold", at: "hold" });
      step(sim);
      const sv = sim.state.vehicle.req(shooter), t = sim.state.transform.req(target);
      submitOrder(sim, { tick: sim.state.tick, issuer: sv.side, target: sv.unit!, kind: "fire", x: t.x, y: t.y, contact: target, nature: "at" });
      let face = "";
      for (let i = 0; i < 40 * TICK_HZ && face === ""; i++) for (const e of step(sim)) if (e.kind === "vehicle.hit" && e.vehicle === target && e.ammo === "de-spike-lr") { face = e.face; expect(e.result).toBe("penetrated"); }
      expect(face).toBe("top");
    }
  });
  it("fire-and-forget flies on to the last point seen: the target's smoke does not save a halted BMP-2; a wire or beam missile is lost in it", () => {
    const ff = missileTrial(data, 3500, "front", 2000, true, "f&f");
    expect(ff.hit).toBe(true);
    const wire = missileTrial(data, 3000, "front", 2000, true, "wire");
    expect(wire.hit).toBe(false);
    expect(wire.lost).toBe(true);
    const beam = missileTrial(data, 2500, "front", 2000, true, "beam");
    expect(beam.hit).toBe(false);
    expect(beam.lost).toBe(true);
  });
  it("beam riding (xf fixture): the wagon's dart hits a Puma at 2500 m; the Puma's laser warner makes its crew fire smoke", () => {
    const r = missileTrial(data, 2500, "side", 2003, false, "beam");
    expect(r.fired).toBe(true);
    expect(r.warned).toBe(true);
  });
  it("MELLS holds two: after both are fired a crewman goes out on the roof, is a target while there, and puts on one at a time from stowage", () => {
    const { input, shooter, target } = missileSetup(data, 600, "side", 2200, "f&f");
    const sim = createSim(input);
    for (const [uid, u] of sim.state.unit.entries()) if (u.parent === null) submitOrder(sim, { tick: 0, issuer: u.side, target: uid, kind: "rules", fire: "hold", at: "hold" });
    step(sim);
    const v = sim.state.vehicle.req(shooter);
    const st = v.stations[0]!;
    const wi = st.weapons.findIndex((w) => w.feeds[0]?.item === "de-mells-round");
    expect(st.weapons[wi]!.feeds[0]!.rounds).toBe(2);
    const t = sim.state.transform.req(target);
    // (At a point 80 m beside the BMP-2: its crew stays to watch the man on the roof.)
    const fire = () => submitOrder(sim, { tick: sim.state.tick, issuer: v.side, target: v.unit!, kind: "fire", x: t.x, y: t.y + 80, nature: "at" });
    let fired = 0, roofStart = -1, roofMan = -1, seen = false;
    const on = (e: SimEvent) => {
      if (e.kind === "spotted" && roofMan >= 0 && e.target === roofMan) seen = true;
      if (e.kind === "shot.fired" && e.vehicle === shooter && e.ammo === "de-spike-lr") fired++;
      if (e.kind === "action.started" && e.action === "reloadOutside" && roofStart < 0) { roofStart = e.tick; roofMan = e.actor; }
    };
    fire();
    for (let i = 0; i < 20 * TICK_HZ; i++) for (const e of step(sim)) on(e);
    fire();
    for (let i = 0; i < 20 * TICK_HZ; i++) for (const e of step(sim)) on(e);
    expect(fired).toBe(2);
    expect(roofStart).toBeGreaterThan(0);
    // On the roof: standing on the hull top, and a man the enemy can see (a spotting target).
    const mt = sim.state.transform.req(roofMan);
    expect(mt.z).toBeGreaterThan(2);
    for (let i = 0; i < 200 * TICK_HZ; i++) for (const e of step(sim)) on(e);
    expect(seen).toBe(true);
    expect(st.weapons[wi]!.feeds[0]!.rounds).toBe(2);
    expect(sim.state.container.req(shooter).stacks.filter((s) => s.type === "de-mells-round").reduce((n, s) => n + s.count, 0)).toBe(0);
  });
});
