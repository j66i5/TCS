/** M6.3: the AI commander — both postures, deterministic, saved and loaded with the game. */
import { describe, expect, it } from "vitest";
import { commanderController } from "@tcs/ai";
import { buildScenario } from "@tcs/scenario";
import { continueBattle, createSim, loadGame, runBattle, saveGame, secondsToEffect, step, submitOrder, type BattleInput } from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData();
const scenario = (seed: number, seconds: number): BattleInput => buildScenario(data, { kind: "platoon-attack", seed, mapKind: "village", factions: ["de", "ru"], attacker: "blue", timeLimitSeconds: seconds });
const ctrls = (input: BattleInput) => [commanderController("blue", input), commanderController("red", input)];

describe("AI commander (M6.3)", () => {
  const input = scenario(1, 900);
  // (Assault tempo, overnight pick 2026-11-14: the men's fatigue as each assault drill starts; when the attacker
  // calls its first high explosive and when it starts its reconnaissance.)
  const cs0 = ctrls(input), atk = cs0[0]!;
  const fatigueAtDrill: number[] = [], inDrill = new Set<number>();
  let heTick = -1, reconTick = -1;
  const watched = cs0.map((c) => ({ ...c, think: (v: Parameters<typeof c.think>[0], t: number) => {
    const o = c.think(v, t);
    if (c === atk) {
      if (heTick < 0 && o.some((x) => x.kind === "callFire" && x.ammo === "he")) heTick = t;
      if (reconTick < 0 && (atk.saveState?.() as { phase: string }).phase === "recon") reconTick = t;
    }
    return o;
  } }));
  const r = runBattle(input, { controllers: watched, onTick: (sim) => {
    if (sim.state.tick % 30 !== 0) return;
    for (const [uid, u] of sim.state.unit.entries()) {
      if (u.drill?.kind !== "assault") { inDrill.delete(uid); continue; }
      if (inDrill.has(uid)) continue;
      inDrill.add(uid);
      const f = u.drill.groups.flat().map((m) => sim.state.soldier.get(m)).filter((x) => x !== undefined && x.physiology.alive && x.casualty === "none").map((x) => x!.physical.fatigue);
      if (f.length > 0) fatigueAtDrill.push(f.reduce((x, y) => x + y, 0) / f.length);
    }
  } });

  it("the attacker moves up, fires on the objective and assaults it; the defender goes down and fires at will", () => {
    const by = (side: string, kind: string) => r.orders.filter((o) => o.issuer === side && o.kind === kind).length;
    expect(by("blue", "move")).toBeGreaterThan(0);
    expect(by("blue", "fire")).toBeGreaterThan(0);
    expect(by("blue", "assault")).toBeGreaterThan(0);
    expect(r.orders.some((o) => o.issuer === "red" && o.kind === "rules" && o.fire === "free")).toBe(true);
    expect(by("red", "posture")).toBeGreaterThan(0);
    // A real fight: both sides fire and both lose men.
    expect(r.eventCounts["shot.fired"] ?? 0).toBeGreaterThan(200);
    expect(r.sides.every((s) => s.soldiersStart - s.soldiersFit > 0)).toBe(true);
    expect(r.winner === "blue" || r.winner === "red").toBe(true);
  });

  it("the attacker calls mortar fire before its first assault, and smoke while it goes in (M6.5)", () => {
    const blue = r.orders.filter((o) => o.issuer === "blue");
    const firstFire = blue.findIndex((o) => o.kind === "callFire" && o.ammo === "he");
    const firstAssault = blue.findIndex((o) => o.kind === "assault");
    expect(firstFire).toBeGreaterThanOrEqual(0);
    expect(firstAssault).toBeGreaterThan(firstFire);
    expect(blue.some((o) => o.kind === "callFire" && o.ammo === "smoke")).toBe(true);
  });

  it("the assault element walks up and goes in rested; the fires before it are called to land as it arrives (assault-tempo)", () => {
    expect(fatigueAtDrill.length).toBeGreaterThan(0);
    expect(fatigueAtDrill.reduce((x, y) => x + y, 0) / fatigueAtDrill.length).toBeLessThan(0.35);
    // (Called no earlier than the fire's delay and a minute and a half before the squads are in place: since the
    // defence picks its own fire positions (overnight pick "defence-siting") it sees the advance and halts it more
    // often, which the call's walking-time estimate does not foresee; it was a minute before.)
    const fs = input.catalog.factions["de"]!.fireSupport!;
    expect(heTick).toBeGreaterThanOrEqual(0);
    expect(reconTick).toBeGreaterThan(0);
    expect((reconTick - heTick) / 60).toBeLessThanOrEqual(secondsToEffect(fs) + 90);
  });

  it("the same battle twice is the same battle", () => {
    const again = runBattle(input, { controllers: ctrls(input) });
    expect(again.finalStateHash).toBe(r.finalStateHash);
  });

  it("saved halfway with the commanders' memory and loaded, it ends exactly as the battle played through", () => {
    const sim = createSim(input);
    const cs = ctrls(input);
    for (let k = 0; k < 400 * 60; k++) { for (const c of cs) for (const o of c.think(sim.state, sim.state.tick)) submitOrder(sim, o); step(sim); }
    const save = JSON.parse(JSON.stringify(saveGame(sim, cs))) as ReturnType<typeof saveGame>;
    const cs2 = ctrls(input);
    const loaded = loadGame(input, save, cs2);
    const end = continueBattle(loaded, input, { controllers: cs2 });
    expect(end.finalStateHash).toBe(r.finalStateHash);
  });

  it("with the defence gone (one man left, far off, holding fire) the attacker takes the main objective, and the second, and holds them", () => {
    // (Its whole sequence of phases, not the balance: against a real defence the AI attack fails, see DECISIONS.md.)
    const weak = scenario(2, 1500);
    const sim = createSim(weak);
    const reds = [...sim.state.identity.entries()].filter(([, i]) => i.side === "red").map(([id]) => id);
    reds.slice(1).forEach((m) => { const s = sim.state.soldier.req(m); s.physiology.alive = false; s.casualty = "killed"; s.mental.behaviour = "incapacitated"; });
    const last = sim.state.transform.req(reds[0]!); last.x = weak.map.widthM - 10; last.y = 10;
    for (const [uid, u] of sim.state.unit.entries()) if (u.side === "red") sim.state.unit.req(uid).fireRule = "hold";
    const cs = ctrls(weak);
    const taken: string[] = [];
    let assaultsOnSecond = 0;
    const second = weak.rules.objectives[1]!;
    for (let k = 0; k < 1500 * 60 && !sim.state.ended; k++) {
      for (const c of cs) for (const o of c.think(sim.state, sim.state.tick)) {
        if (o.issuer === "blue" && o.kind === "assault" && Math.hypot(o.x - second.x, o.y - second.y) < 40) assaultsOnSecond++;
        submitOrder(sim, o);
      }
      for (const e of step(sim)) if (e.kind === "objective.changed" && e.holder === "blue") taken.push(e.objective);
    }
    // Both end up taken (the second on the way or by its own assault), and the attacker holds them at the end.
    expect(taken).toContain("main");
    expect(taken).toContain("second");
    expect(taken.includes("second") || assaultsOnSecond > 0).toBe(true);
    expect(sim.state.objectives.every((o) => o.holder === "blue")).toBe(true);
  });
});
