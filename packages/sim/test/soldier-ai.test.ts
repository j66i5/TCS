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

describe("package B: use the ground", () => {
  /** One blue man at (50, 52), a wall west of him (x = 48, y 30..49); red holds fire 100 m east. */
  function exposed(): Sim {
    const input = armedInput(1, 600);
    input.forces[0]!.units[0]!.members = input.forces[0]!.units[0]!.members.slice(0, 1);
    input.forces[0]!.placements = [{ personId: input.forces[0]!.units[0]!.members[0]!.personId, x: 50, y: 52, heading: 0 }];
    input.forces[1]!.placements = input.forces[1]!.placements.map((p, i) => ({ ...p, x: 150, y: 47 + i }));
    input.map.obstacles.push({ id: 1, kind: "wall", points: [48, 30, 48, 49], heightM: 2, thicknessM: 0.25, material: "brick" } as never);
    return createSim(input);
  }

  it("a pinned man in the enemy's sight low-crawls to cover close by, away from the enemy", () => {
    const sim = exposed();
    const me = unitOf(sim, "blue")[1].members[0]!;
    run(sim, 3); // he sees them
    expect(sim.state.soldier.req(me).contacts.length).toBeGreaterThan(0);
    const s = sim.state.soldier.req(me);
    s.mental.suppression = 1; s.mental.behaviour = "pinned"; s.posture = "prone";
    const ev = run(sim, 45);
    const t = sim.state.transform.req(me);
    expect(t.x).toBeLessThan(48); // behind the wall
    expect(Math.hypot(t.x - 50, t.y - 52)).toBeLessThan(10);
    expect(ev.some((e) => e.kind === "posture.changed" && e.soldier === me && e.posture !== "prone")).toBe(false); // he crawled
  });

  it("a man in the open within an enemy mortar mission's beaten zone moves out of it", () => {
    const sim = exposed();
    const me = unitOf(sim, "blue")[1].members[0]!;
    run(sim, 2);
    // (Out in the open, away from the wall: next to it he would stay down.)
    const t = sim.state.transform.req(me);
    t.x = 60; t.y = 80;
    sim.state.soldier.req(me).beaten = { x: 62, y: 82, tick: sim.state.tick, n: 2, left: false };
    run(sim, 40);
    expect(Math.hypot(t.x - 62, t.y - 82)).toBeGreaterThan(sim.ctx.catalog.behaviour.soldier.beatenRadiusM);
    expect(t.x).toBeLessThan(65); // not toward the enemy
    // Next to the wall he stays where he is.
    const sim2 = exposed();
    const me2 = unitOf(sim2, "blue")[1].members[0]!;
    run(sim2, 2);
    sim2.state.soldier.req(me2).beaten = { x: 52, y: 55, tick: sim2.state.tick, n: 2, left: false };
    run(sim2, 20);
    expect(Math.hypot(sim2.state.transform.req(me2).x - 50, sim2.state.transform.req(me2).y - 52)).toBeLessThan(3);
  });

  it("enemy mortar bursts are remembered as one mission by the men near them", async () => {
    const sim = exposed();
    const me = unitOf(sim, "blue")[1].members[0]!;
    const { noteBeatenZone } = await import("../src/systems/morale");
    noteBeatenZone(sim.ctx, sim.state, 60, 50, "red");
    noteBeatenZone(sim.ctx, sim.state, 70, 50, "red");
    expect(sim.state.soldier.req(me).beaten).toMatchObject({ x: 65, y: 50, n: 2, left: false });
    noteBeatenZone(sim.ctx, sim.state, 60, 50, "blue"); // his own side's mortars
    expect(sim.state.soldier.req(me).beaten?.n).toBe(2);
  });
});
