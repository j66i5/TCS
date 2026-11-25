/** Review 2026-11-24 problem 3 (owner Q3): a decided battle ends; Claim victory. */
import { describe, expect, it } from "vitest";
import { battleScore, claimStatus, createSim, hashState, loadSim, runBattle, saveSim, secondsToTicks, step, submitOrder, TICK_HZ, type BattleInput, type Sim, type SimEvent } from "../src/index";
import { team, testCatalog, testInput } from "./helpers";

const BE = { quietS: 180, noticeS: 60, spentShare: 0.25, spentForS: 60, spentCancelShare: 0.3, defenderEnemyShare: 0.5, claimQuietS: 60, claimClearM: 50 };

function run(sim: Sim, seconds: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < secondsToTicks(seconds) && !sim.state.ended; i++) out.push(...step(sim));
  return out;
}

/** Unarmed (no fire at all: contact is set by hand), blue 3 men at the west edge, red 8 at the east. */
function setup(holder: "blue" | null = null, prep?: (i: BattleInput) => void): BattleInput {
  const input = testInput(1, 900);
  input.catalog = { ...testCatalog, behaviour: { ...testCatalog.behaviour, battleEnd: BE } };
  const b = team("b", 8);
  input.forces[1]!.units = [b];
  input.forces[1]!.placements = b.members.map((m, i) => ({ personId: m.personId, x: 190, y: 10 + i * 5, heading: Math.PI }));
  input.rules.objectives = [{ id: "farm", nameKey: "objective.farm", x: 15, y: 20, radiusM: 30, points: 100, holder }];
  input.rules.victory = { casualtyPoints: 10, endOnDefeat: true, decided: true };
  prep?.(input);
  return input;
}

const top = (sim: Sim, side: string) => [...sim.state.unit.entries()].find(([, u]) => u.side === side && u.parent === null)!;
const redMen = (sim: Sim) => top(sim, "red")[1].members;
function downMen(sim: Sim, men: readonly number[]): void {
  for (const m of men) { const s = sim.state.soldier.req(m); s.casualty = "incapacitated"; s.mental.behaviour = "incapacitated"; s.physiology.consciousness = 0; }
}
function contact(sim: Sim): void { top(sim, "blue")[1].underFireTick = sim.state.tick; }

describe("the end of a decided battle (review 2026-11-24 problem 3)", () => {
  it("a side below a quarter of its men standing for a minute is spent: notice, then it loses ('side-spent')", () => {
    const sim = createSim(setup());
    run(sim, 2);
    downMen(sim, redMen(sim).slice(1));
    const ev = run(sim, 200);
    const ending = ev.find((e) => e.kind === "battle.ending");
    expect(ending).toMatchObject({ reason: "side-spent", loser: "red", winner: "blue" });
    expect(ev.some((e) => e.kind === "radio" && e.key === "radio.battleEnding")).toBe(true);
    const end = ev.find((e) => e.kind === "battle.ended");
    expect(end).toMatchObject({ reason: "side-spent", loser: "red" });
    // (Announced after spentForS, ended noticeS later.)
    expect(ending!.tick).toBeGreaterThanOrEqual(secondsToTicks(2 + 60));
    expect(end!.tick).toBe((ending as { endTick: number }).endTick);
    expect(battleScore(sim.ctx, sim.state).winner).toBe("blue");
    expect(sim.state.ending).toBeUndefined();
  });

  it("the spent end is called off when the side climbs back over a quarter", () => {
    const sim = createSim(setup());
    run(sim, 2);
    const down = redMen(sim).slice(1);
    downMen(sim, down);
    const ev = run(sim, 70);
    expect(ev.some((e) => e.kind === "battle.ending" && !e.cancelled)).toBe(true);
    for (const m of down.slice(0, 3)) { const s = sim.state.soldier.req(m); s.casualty = "none"; s.mental.behaviour = "steady"; s.physiology.consciousness = 1; }
    const ev2 = run(sim, 120);
    expect(ev2.find((e) => e.kind === "battle.ending")).toMatchObject({ reason: "side-spent", cancelled: true });
    expect(ev2.some((e) => e.kind === "radio" && e.key === "radio.battleEndingCancelled")).toBe(true);
    expect(sim.state.ended).toBeNull();
    expect(sim.state.ending).toBeUndefined();
  });

  it("the field held, contact and then quiet: notice, then the scores decide ('battle-decided')", () => {
    const sim = createSim(setup());
    run(sim, 1);
    contact(sim);
    const ev = run(sim, 300);
    const ending = ev.find((e) => e.kind === "battle.ending");
    expect(ending).toMatchObject({ reason: "battle-decided", winner: "blue" });
    expect(ending!.tick).toBeGreaterThanOrEqual(secondsToTicks(1 + 180));
    const end = ev.find((e) => e.kind === "battle.ended");
    expect(end).toMatchObject({ reason: "battle-decided" });
    expect(end && "loser" in end ? end.loser : undefined).toBeUndefined();
    expect(sim.state.endLoser).toBeNull();
    expect(battleScore(sim.ctx, sim.state).winner).toBe("blue"); // the farm's 100 points
  });

  it("no end without contact, and none when the decided ends are off", () => {
    const sim = createSim(setup());
    expect(run(sim, 400).some((e) => e.kind === "battle.ending")).toBe(false);
    const off = createSim(setup(null, (i) => { i.rules.victory!.decided = false; }));
    run(off, 1); contact(off);
    expect(run(off, 400).some((e) => e.kind === "battle.ending")).toBe(false);
  });

  it("the defender holding from the start does not end the battle in the lull before the attack, only with the enemy beaten down", () => {
    const sim = createSim(setup("blue"));
    run(sim, 1);
    contact(sim);
    expect(run(sim, 300).some((e) => e.kind === "battle.ending")).toBe(false);
    // 3 of 8 left: not spent (2 is a quarter), but under half: the defender has the field.
    downMen(sim, redMen(sim).slice(3));
    const ev = run(sim, 5);
    expect(ev.find((e) => e.kind === "battle.ending")).toMatchObject({ reason: "battle-decided", winner: "blue" });
  });

  it("renewed contact calls the decided end off", () => {
    const sim = createSim(setup());
    run(sim, 1);
    contact(sim);
    run(sim, 185);
    expect(sim.state.ending?.reason).toBe("battle-decided");
    contact(sim);
    const ev = run(sim, 2);
    expect(ev.find((e) => e.kind === "battle.ending")).toMatchObject({ reason: "battle-decided", cancelled: true });
    expect(sim.state.ending).toBeUndefined();
    expect(sim.state.ended).toBeNull();
  });

  it("a battle saved during the notice goes on identically after a load (the countdown is saved)", () => {
    const input = setup();
    const sim = createSim(input);
    run(sim, 1);
    contact(sim);
    run(sim, 200);
    expect(sim.state.ending).toBeDefined();
    const saved = saveSim(sim);
    expect((saved as { ending?: unknown }).ending).toBeDefined();
    const copy = loadSim({ ...input, orders: [] }, saved);
    expect(hashState(copy.state)).toBe(hashState(sim.state));
    run(sim, 100); run(copy, 100);
    expect(sim.state.ended?.reason).toBe("battle-decided");
    expect(hashState(copy.state)).toBe(hashState(sim.state));
  });

  it("a state without a countdown serialises without the field (old saves and goldens hash as before)", () => {
    const sim = createSim(setup());
    run(sim, 2);
    expect("ending" in saveSim(sim)).toBe(false);
  });
});

describe("Claim victory (owner Q3)", () => {
  it("is refused with a reason until the side holds the field, quiet, ahead; then it ends the battle at once", () => {
    const sim = createSim(setup());
    run(sim, 1);
    expect(claimStatus(sim.ctx, sim.state, "blue")).toEqual({ ok: false, reason: "no-contact-yet" });
    contact(sim);
    run(sim, 5);
    const st = claimStatus(sim.ctx, sim.state, "blue");
    expect(st).toMatchObject({ ok: false, reason: "contact" });
    expect((st as { secondsLeft: number }).secondsLeft).toBeGreaterThan(50);
    expect(claimStatus(sim.ctx, sim.state, "red")).toMatchObject({ ok: false, reason: "objectives" });
    // Refused as an order: "not-decided".
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: top(sim, "blue")[0], kind: "claimVictory", player: true });
    const ev = run(sim, 1);
    expect(ev.find((e) => e.kind === "order.rejected")).toMatchObject({ reason: "not-decided" });
    run(sim, 60);
    expect(claimStatus(sim.ctx, sim.state, "blue")).toEqual({ ok: true });
    const tick = sim.state.tick;
    submitOrder(sim, { tick, issuer: "blue", target: top(sim, "blue")[0], kind: "claimVictory", player: true });
    const ev2 = step(sim);
    expect(ev2.find((e) => e.kind === "battle.ended")).toMatchObject({ reason: "victory-claimed", loser: "red", tick });
    expect(sim.state.ended).toMatchObject({ reason: "victory-claimed" });
    expect(battleScore(sim.ctx, sim.state).winner).toBe("blue");
    expect(claimStatus(sim.ctx, sim.state, "blue")).toEqual({ ok: false, reason: "ended" });
  });

  it("an enemy man near the objective and an enemy behind on points refuse it", () => {
    const sim = createSim(setup(null, (i) => { i.forces[1]!.placements[0] = { ...i.forces[1]!.placements[0]!, x: 60, y: 20 }; }));
    run(sim, 1); contact(sim); run(sim, 70);
    expect(claimStatus(sim.ctx, sim.state, "blue")).toEqual({ ok: false, reason: "enemy-near" });
    const sim2 = createSim(setup());
    run(sim2, 1); contact(sim2); run(sim2, 70);
    // Blue's three men down at 40 points each: 100 - 120 against red's 0.
    sim2.ctx.rules.victory!.casualtyPoints = 40;
    downMen(sim2, top(sim2, "blue")[1].members);
    expect(claimStatus(sim2.ctx, sim2.state, "blue")).toEqual({ ok: false, reason: "score" });
  });

  it("a claimed battle gives a valid result: the claimant wins, the roster comes back", () => {
    const input = setup();
    const claimAt = secondsToTicks(80);
    const r = runBattle(input, {
      controllers: [{ side: "blue", think: (state, tick) => (tick === claimAt ? [{ tick, issuer: "blue", target: [...state.unit.entries()].find(([, u]) => u.side === "blue")![0], kind: "claimVictory", player: true }] : []) }],
      onTick: (sim) => { if (sim.state.tick === TICK_HZ) contact(sim); },
    });
    expect(r.endReason).toBe("victory-claimed");
    expect(r.winner).toBe("blue");
    expect(Math.round(r.durationSeconds)).toBe(80);
    expect(r.forcesOut.map((f) => f.side).sort()).toEqual(["blue", "red"]);
    expect(r.orders.some((o) => o.kind === "claimVictory")).toBe(true);
    // The order stream replays it.
    const again = runBattle({ ...input, orders: r.orders }, { onTick: (sim) => { if (sim.state.tick === TICK_HZ) contact(sim); } });
    expect(again.endReason).toBe("victory-claimed");
    expect(again.durationSeconds).toBe(r.durationSeconds);
  });
});
