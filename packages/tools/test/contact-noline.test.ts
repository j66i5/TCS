/**
 * Review 2026-11-24 problem 2, verification: area or return fire a man has no line of fire to is given up (and not
 * taken up again in its place), so whole squads do not sit silent behind a building with fire tasks they can never
 * fire. Regression case of the verifier: the ambush on foot, industrial, seed 5, the ambushed side with the player's
 * rules (the AI's moves only).
 */
import { describe, expect, it } from "vitest";
import { planControllers } from "@tcs/ai";
import { buildScenario } from "@tcs/scenario";
import { runBattle, TICK_HZ, type Controller, type SimEvent } from "@tcs/sim";
import { kindScenario } from "../src/labs/kinds";
import { loadData, ON_POSTS } from "../src/scenarios";

const data = loadData(true);

describe("area fire with no line of fire (ambush, industrial, seed 5)", () => {
  it("no man keeps an area or return task without a line for longer than noLineS and a decision", () => {
    const input = buildScenario(data, kindScenario("ambush", "industrial", 5, 420), ON_POSTS);
    const amb = input.forces.find((f) => f.plan?.posture === "transit")!.side;
    const RF = input.catalog.behaviour.soldier.returnFire!;
    const limit = (RF.noLineS! + input.catalog.behaviour.decisions.stepSeconds + 1) * TICK_HZ;
    const controllers: Controller[] = planControllers(input).map((c) => (c.side === amb ? { ...c, think: (v, t) => c.think(v, t).filter((o) => o.kind !== "rules") } : c));
    let worst = 0;
    const calls = new Map<string, { tick: number; bearing: number }[]>();
    runBattle(input, {
      controllers,
      onEvents: (ev: SimEvent[]) => {
        for (const e of ev) if (e.kind === "radio" && e.side === amb && e.key === "radio.contactFire") {
          const k = String(e.params.callsign);
          calls.set(k, [...(calls.get(k) ?? []), { tick: e.tick, bearing: Number(e.params.bearing) }]);
        }
      },
      onTick: (sim) => {
        const st = sim.state;
        if (st.tick % TICK_HZ !== 0) return;
        for (const [id, ft] of st.fire.entries()) {
          if (st.identity.get(id)?.side !== amb || (ft.suppress !== "area" && ft.suppress !== "return")) continue;
          if (ft.noLineTick !== undefined) worst = Math.max(worst, st.tick - ft.noLineTick);
        }
      },
    });
    expect(worst).toBeLessThanOrEqual(limit);
    // (The contact call, once a minute per squad unless the bearing turned by radioTurnDeg.)
    const C = input.catalog.behaviour.drills.contact!;
    for (const list of calls.values()) for (let i = 1; i < list.length; i++) {
      const db = Math.abs(list[i]!.bearing - list[i - 1]!.bearing);
      if (list[i]!.tick - list[i - 1]!.tick < C.radioEveryS! * TICK_HZ) expect(Math.min(db, 360 - db)).toBeGreaterThanOrEqual(C.radioTurnDeg!);
    }
  }, 300_000);
});
