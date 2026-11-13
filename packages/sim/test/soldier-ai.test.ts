/** Individual soldier AI (owner 2026-11-13, packages A-D). */
import { describe, expect, it } from "vitest";
import { aimHeightAt, createSim, secondsToTicks, step, submitOrder, type BattleInput, type Sim, type SimEvent } from "../src/index";
import { reserveTargetOk } from "../src/systems/fire";
import { armedInput } from "./helpers";

const unitOf = (sim: Sim, side: string) => [...sim.state.unit.entries()].find(([, u]) => u.side === side)!;
function run(sim: Sim, seconds: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < secondsToTicks(seconds); i++) out.push(...step(sim));
  return out;
}
const shotsBy = (sim: Sim, ev: SimEvent[], side: string) => ev.filter((e) => e.kind === "shot.fired" && sim.state.identity.get(e.shooter)?.side === side).length;
/** Blue at x = 10 (y 10, 15, 20) with fire rule "free"; red (holding fire) at `redX`. */
function setup(redX: number, prep?: (i: BattleInput) => void): Sim {
  const input = armedInput(1, 600);
  input.forces[1]!.placements = input.forces[1]!.placements.map((p) => ({ ...p, x: redX }));
  prep?.(input);
  const sim = createSim(input);
  submitOrder(sim, { tick: 0, issuer: "blue", target: unitOf(sim, "blue")[0], kind: "rules", fire: "free" });
  return sim;
}

describe("package A: shoot straight", () => {
  it("a contact records the posture the man was seen in; men aim at the middle of what they see", () => {
    const sim = setup(120);
    const red = unitOf(sim, "red")[1].members[0]!;
    submitOrder(sim, { tick: 0, issuer: "red", target: red, kind: "posture", posture: "prone" });
    run(sim, 10);
    const blue = unitOf(sim, "blue")[1].members[0]!;
    const c = sim.state.soldier.req(blue).contacts.find((k) => k.target === red)!;
    expect(c.kind).toBe("seen");
    expect(c.posture).toBe("prone");
    const H = sim.ctx.catalog.shooting.fire.aimHeightByPostureM;
    expect(aimHeightAt(sim.ctx, c)).toBe(H.prone);
    expect(aimHeightAt(sim.ctx, { posture: "standing" })).toBe(H.standing);
    expect(aimHeightAt(sim.ctx, { posture: "crouching", z: 2.8 })).toBeCloseTo(H.crouching + 2.8, 9);
    // Firing on his own at a man he sees lying down: his aim point is low.
    const task = [...unitOf(sim, "blue")[1].members].map((m) => sim.state.fire.get(m)).find((t) => t?.contact === red);
    expect(task?.heightM).toBe(H.prone);
  });

  it("the last magazine is a close-defence reserve: not fired at 110 m, fired at 50 m", () => {
    const noSpare = (i: BattleInput) => { for (const m of i.forces[0]!.units[0]!.members) m.load = [{ type: "mag", count: 1, charge: 30 }]; };
    const far = setup(120, noSpare);
    expect(shotsBy(far, run(far, 20), "blue")).toBe(0);
    const near = setup(60, noSpare);
    expect(shotsBy(near, run(near, 20), "blue")).toBeGreaterThan(0);
  });

  it("a man seen to go down is known to be down: fire at him stops and nobody picks him again", () => {
    const sim = setup(120);
    const red = unitOf(sim, "red")[1].members[0]!;
    run(sim, 6);
    const shooters = unitOf(sim, "blue")[1].members.filter((m) => sim.state.fire.get(m)?.contact === red);
    expect(shooters.length).toBeGreaterThan(0);
    // He falls (as a hit would leave him): the men who had him in sight see it within half a second.
    const rs = sim.state.soldier.req(red);
    rs.physiology.consciousness = 0; rs.casualty = "incapacitated"; rs.mental.behaviour = "incapacitated"; rs.posture = "prone";
    run(sim, 3);
    for (const m of shooters) {
      expect(sim.state.soldier.req(m).contacts.find((k) => k.target === red)?.down).toBe(true);
      expect(sim.state.fire.get(m)?.contact).not.toBe(red);
    }
  });

  it("an assaulting enemy within reserveAssaultM may be fired at with the reserve", () => {
    const sim = setup(160);
    const red = unitOf(sim, "red");
    const me = sim.state.transform.req(unitOf(sim, "blue")[1].members[0]!);
    const c = { target: red[1].members[0]!, x: me.x + 150, y: me.y };
    expect(reserveTargetOk(sim.ctx, sim.state, c, me)).toBe(false);
    red[1].drill = { kind: "assault", x: 0, y: 0, groups: [], mover: 0, phaseTick: 0, final: false };
    expect(reserveTargetOk(sim.ctx, sim.state, c, me)).toBe(true);
    expect(reserveTargetOk(sim.ctx, sim.state, { ...c, x: me.x + 250 }, me)).toBe(false);
  });
});
