/** Fire distribution and low aim at unseen enemies (D4b, owner picks (a), game values). */
import { describe, expect, it } from "vitest";
import { aimHeightAt, createSim, secondsToTicks, step, submitOrder, type BattleInput, type Sim } from "../src/index";
import type { Catalog } from "../src/catalog";
import { armedInput, testCatalog } from "./helpers";

const unitOf = (sim: Sim, side: string) => [...sim.state.unit.entries()].find(([, u]) => u.side === side)!;
const run = (sim: Sim, seconds: number) => { for (let i = 0; i < secondsToTicks(seconds); i++) step(sim); };
/** The test catalog without the fire-distribution rule (the old target choice). */
function withoutRule(input: BattleInput): void {
  const { fireDistribution: _, ...soldier } = testCatalog.behaviour.soldier;
  input.catalog = { ...testCatalog, behaviour: { ...testCatalog.behaviour, soldier } } as Catalog;
}

describe("fire distribution", () => {
  /** One blue machine gunner at (10, 20), fire free; red (holding fire): a rifleman at 100 m, a machine gunner at 140 m. */
  function gunner(prep?: (i: BattleInput) => void): { sim: Sim; me: number; rifleman: number; mg: number } {
    const input = armedInput(1, 600);
    const blue = input.forces[0]!.units[0]!;
    blue.members = blue.members.slice(0, 1);
    blue.members[0]!.weapon = "gun"; blue.members[0]!.load = [{ type: "belt", count: 2, charge: 50 }];
    input.forces[0]!.placements = [{ personId: blue.members[0]!.personId, x: 10, y: 20, heading: 0 }];
    const red = input.forces[1]!.units[0]!;
    red.members[1]!.weapon = "gun"; red.members[1]!.load = [{ type: "belt", count: 2, charge: 50 }];
    input.forces[1]!.placements = [
      { personId: red.members[0]!.personId, x: 110, y: 20, heading: Math.PI },
      { personId: red.members[1]!.personId, x: 150, y: 30, heading: Math.PI },
    ];
    prep?.(input);
    const sim = createSim(input);
    const reds = unitOf(sim, "red")[1].members, me = unitOf(sim, "blue")[1].members[0]!;
    // (His fire is freed once he sees both, so that who is seen first does not decide.)
    run(sim, 6);
    expect(sim.state.soldier.req(me).contacts.filter((c) => c.kind === "seen").length).toBe(2);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: unitOf(sim, "blue")[0], kind: "rules", fire: "free" });
    return { sim, me, rifleman: reds[0]!, mg: reds[1]! };
  }

  it("a machine gunner puts his fire on the enemy machine gun, not on the nearer rifleman", () => {
    const { sim, me, mg } = gunner();
    run(sim, 3);
    expect(sim.state.fire.get(me)?.contact).toBe(mg);
  });

  it("without the rule he fires at the nearer rifleman (the old choice)", () => {
    const { sim, me, rifleman } = gunner(withoutRule);
    run(sim, 3);
    expect(sim.state.fire.get(me)?.contact).toBe(rifleman);
  });

  /**
   * Two blue riflemen of one team; two red riflemen (holding fire) at similar ranges, one a little nearer to both.
   * Blue's fire is freed once both men see both enemies (so who is seen first does not decide); returns each blue
   * man's targets, tick by tick, until the first red man falls.
   */
  function pair(prep?: (i: BattleInput) => void): { reds: number[]; picks: (number | undefined)[][] } {
    const input = armedInput(1, 600);
    const blue = input.forces[0]!.units[0]!;
    blue.members = blue.members.slice(0, 2);
    input.forces[0]!.placements = blue.members.map((m, i) => ({ personId: m.personId, x: 10, y: 20 + i * 5, heading: 0 }));
    input.forces[1]!.placements = input.forces[1]!.placements.map((p, i) => ({ ...p, x: 110 + i * 8, y: 22 + i * 2, heading: Math.PI }));
    prep?.(input);
    const sim = createSim(input);
    const blues = unitOf(sim, "blue")[1].members, reds = unitOf(sim, "red")[1].members;
    run(sim, 4);
    for (const m of blues) expect(sim.state.soldier.req(m).contacts.filter((c) => c.kind === "seen").length).toBe(2);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: unitOf(sim, "blue")[0], kind: "rules", fire: "free" });
    const picks: (number | undefined)[][] = [];
    for (let i = 0; i < secondsToTicks(10) && reds.every((r) => sim.state.soldier.req(r).casualty === "none"); i++) {
      step(sim);
      picks.push(blues.map((m) => sim.state.fire.get(m)?.contact));
    }
    return { reds, picks };
  }

  it("two riflemen of one team spread their fire over two enemies, and keep their targets", () => {
    const { reds, picks } = pair();
    const settled = picks.findIndex((p) => p.every((t) => t !== undefined));
    expect(settled).toBeGreaterThanOrEqual(0);
    const targets = picks[settled]!;
    for (const t of targets) expect(reds).toContain(t);
    expect(targets[0]).not.toBe(targets[1]);
    expect(picks.length - settled).toBeGreaterThan(secondsToTicks(1)); // (a while of fire to look at)
    for (const p of picks.slice(settled)) expect(p).toEqual(targets); // no flip-flop
  });

  it("without the rule both fire at the nearer enemy", () => {
    const { reds, picks } = pair(withoutRule);
    const settled = picks.find((p) => p.every((t) => t !== undefined));
    expect(settled).toEqual([reds[0], reds[0]]);
  });
});

describe("low aim at unseen enemies", () => {
  it("a heard or reported enemy is aimed at aimUnseenHeightM; a seen one at the middle of what is seen", () => {
    const ctx = createSim(armedInput()).ctx;
    const F = ctx.catalog.shooting.fire, low = F.aimUnseenHeightM!;
    expect(low).toBe(0.3);
    expect(aimHeightAt(ctx, { kind: "heard" })).toBe(low);
    expect(aimHeightAt(ctx, { kind: "reported", posture: "standing" })).toBe(low);
    expect(aimHeightAt(ctx, { kind: "reported", posture: "prone" })).toBe(F.aimHeightByPostureM.prone); // lower already
    expect(aimHeightAt(ctx, { kind: "heard", z: 2.8 })).toBeCloseTo(low + 2.8, 9); // on his floor
    expect(aimHeightAt(ctx, { kind: "seen", posture: "prone" })).toBe(0.2);
    expect(aimHeightAt(ctx, { kind: "seen", posture: "standing" })).toBe(1.0);
    expect(aimHeightAt(ctx, { kind: "seen" })).toBe(F.aimPointHeightM);
  });

  it("a fire order at a reported enemy behind a wall aims low", () => {
    const input = armedInput(1, 600);
    input.forces[1]!.placements = input.forces[1]!.placements.map((p, i) => ({ ...p, x: 100, y: 13 + i * 3 }));
    input.map.obstacles.push({ id: 1, kind: "wall", points: [96, 0, 96, 40], heightM: 2.5, thicknessM: 0.25, material: "brick" } as never);
    const sim = createSim(input);
    const red = unitOf(sim, "red")[1].members[0]!;
    const blues = unitOf(sim, "blue")[1].members;
    const t = sim.state.transform.req(red);
    for (const m of blues) sim.state.soldier.req(m).contacts.push({ target: red, x: t.x, y: t.y, errM: 2, kind: "reported", tick: 0, reportedTick: 0 });
    submitOrder(sim, { tick: 0, issuer: "blue", target: unitOf(sim, "blue")[0], kind: "fire", x: t.x, y: t.y, contact: red });
    run(sim, 3);
    const tasks = blues.map((m) => sim.state.fire.get(m)).filter((f) => f?.contact === red);
    expect(tasks.length).toBeGreaterThan(0);
    for (const f of tasks) expect(f!.heightM).toBe(0.3);
  });
});
