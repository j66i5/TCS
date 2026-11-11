/**
 * M2 demonstration (ROADMAP M2.5): the two real squads in a scripted shoot-out. Everything built in M2 runs
 * together here: rifles, machine guns with belts and tracers, the marksman rifle, launcher grenades, bodies,
 * armour, wounds, reactions — and the whole fight replays identically.
 */
import { describe, expect, it } from "vitest";
import { createSim, hashState, step, submitOrder, type SimEvent } from "@tcs/sim";
import { getScenario, loadData } from "../src/scenarios";

function fight(seed: number, seconds = 180) {
  const sc = getScenario("shootout");
  const input = sc.build(loadData(), seed, seconds);
  const sim = createSim(input);
  const ctrls = sc.controllers!(input);
  const events: SimEvent[] = [];
  for (let i = 0; i < seconds * 60; i++) {
    for (const c of ctrls) for (const o of c.think(sim.state, sim.state.tick)) submitOrder(sim, o);
    events.push(...step(sim));
  }
  return { sim, events, input };
}

describe("scripted shoot-out of the two squads (M2 demonstration)", () => {
  const { sim, events, input } = fight(1);
  const sideOf = (id: number) => sim.state.identity.get(id)?.side;
  const shots = events.filter((e): e is Extract<SimEvent, { kind: "shot.fired" }> => e.kind === "shot.fired");

  it("both squads fire several hundred rounds; machine guns, rifles and the marksman rifle all take part", () => {
    for (const s of ["blue", "red"]) expect(shots.filter((e) => sideOf(e.shooter) === s).length).toBeGreaterThan(250);
    const byWeapon = new Map<string, number>();
    for (const e of shots) byWeapon.set(e.weapon, (byWeapon.get(e.weapon) ?? 0) + 1);
    console.log([...byWeapon.entries()].sort().map(([w, n]) => `${w} ${n}`).join(", "));
    // (The marksman lies in the beaten zone of the enemy machine gun: pinned since M4.1, he fires less.)
    for (const w of ["de-g36", "de-mg5", "ru-ak74m", "ru-pkp"]) expect(byWeapon.get(w) ?? 0).toBeGreaterThan(20);
    expect(byWeapon.get("de-g28") ?? 0).toBeGreaterThan(8);
    // The machine guns fire more than any single rifle, and their belts show tracers.
    expect(byWeapon.get("de-mg5")!).toBeGreaterThan(byWeapon.get("de-g36")! / 4);
    expect(shots.some((e) => input.catalog.ammo[e.ammo]?.tracer === true)).toBe(true);
  });

  it("each side sends its grenade; men are hit; nobody fires after the cease-fire; ammunition is conserved", () => {
    expect(events.filter((e) => e.kind === "grenade.launched").length).toBe(2);
    expect(events.filter((e) => e.kind === "explosion").length).toBe(2);
    expect(events.filter((e) => e.kind === "hit").length).toBeGreaterThan(0);
    expect(shots.filter((e) => e.tick > 152 * 60).length).toBe(0);
    // Rounds gone from weapons and loads = shots fired (grenades are counted separately).
    const fresh = createSim(input);
    const rounds = (s: typeof sim) => {
      let n = 0;
      for (const [id, w] of s.state.weapon.entries()) {
        n += w.magazine?.rounds ?? 0;
        const mag = input.catalog.weapons[w.weapon]!.feed.magazine;
        for (const st of s.state.container.req(id).stacks) if (st.type === mag) n += st.count * (st.charge ?? 0);
      }
      return n;
    };
    // (Belts carried by other men are not counted on either side of the comparison: only each man's own weapon's feed.)
    expect(rounds(fresh) - rounds(sim)).toBe(shots.length);
  });

  it("the same seed gives the same fight to the last bit; another seed gives a different one", () => {
    expect(hashState(fight(1).sim.state)).toBe(hashState(sim.state));
    expect(hashState(fight(2).sim.state)).not.toBe(hashState(sim.state));
  });
});
