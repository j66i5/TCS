/**
 * Review 2026-11-24 problem 3: a battle ended early (claimed, or a side spent) gives a valid campaign result: the
 * node's result follows the winner, the books balance. Real battles with the fixture faction (xf against xf).
 */
import { describe, expect, it } from "vitest";
import { planControllers } from "@tcs/ai";
import { addHoldings, battleInputs, bookedChange, campaignCatalog, chooseForces, clone, confirmForces, finishBattle, forceHoldings, holdingsDiff, newCampaign, phaseOf, startFlow, type FlowEnv } from "@tcs/campaign";
import { claimStatus, isAble, isAssetUnit, isOffMapMan, runBattle, type BattleInput, type Controller, type Sim } from "@tcs/sim";
import { aiRunner } from "../src/campaign";
import { loadData, ON_POSTS } from "../src/scenarios";

const data = loadData(true);
const ENV: FlowEnv = { runner: aiRunner, hooks: ON_POSTS };
const XF = { seed: 11, faction: "xf", enemy: "xf", battleSeconds: 900 } as const;

/** At 10 s: every enemy man down but a fifth (at least two), those farthest from the objectives, the objectives the player's, contact now. */
function beatEnemy(sim: Sim, input: BattleInput): void {
  const st = sim.state, objs = input.rules.objectives;
  const far = (id: number) => { const t = st.transform.req(id); return Math.min(...objs.map((o) => Math.hypot(t.x - o.x, t.y - o.y))); };
  // mounted: ok (every red man)
  const red = [...st.identity.entries()].filter(([id, i]) => i.side === "red" && !isAssetUnit(st, i.unit) && isAble(st.soldier.get(id)) && !isOffMapMan(st, st.soldier.get(id))).map(([id]) => id).sort((a, b) => far(b) - far(a));
  for (const m of red.slice(Math.max(2, Math.floor(red.length * 0.2)))) { const s = st.soldier.req(m); s.casualty = "incapacitated"; s.mental.behaviour = "incapacitated"; s.physiology.consciousness = 0; }
  for (const o of st.objectives) { o.holder = "blue"; o.contested = false; }
  for (const [, u] of st.unit.entries()) if (u.side === "blue" && u.parent === null) u.underFireTick = st.tick;
  // (The defender's last men stand by their objectives: the claim's "enemy near" check is narrowed for this test, on
  // this battle's own copy of the catalog.)
  const be = sim.ctx.catalog.behaviour.battleEnd!;
  sim.ctx.catalog = { ...sim.ctx.catalog, behaviour: { ...sim.ctx.catalog.behaviour, battleEnd: { ...be, claimClearM: 1 } } };
}

describe("a battle ended early in the campaign (review 2026-11-24 problem 3)", () => {
  it("a claimed battle: the player wins the node, the books balance", { timeout: 600_000 }, () => {
    let r = startFlow(data, newCampaign(data, XF));
    r = confirmForces(data, chooseForces(data, r));
    const start = clone(r);
    const nb = battleInputs(data, r, ON_POSTS);
    const input = nb.main!.input;
    let sim: Sim | null = null, claimed = false;
    const claimer: Controller = {
      side: "blue",
      think: (state, tick) => {
        if (claimed || sim === null || !claimStatus(sim.ctx, state, "blue").ok) return [];
        claimed = true;
        const top = [...state.unit.entries()].find(([, u]) => u.side === "blue" && u.parent === null)![0];
        return [{ tick, issuer: "blue", target: top, kind: "claimVictory", player: true }];
      },
    };
    const result = runBattle(input, {
      controllers: [...planControllers(input).filter((c) => c.side === "red"), claimer],
      onTick: (s) => { sim = s; if (s.state.tick === 600) beatEnemy(s, input); },
    });
    expect(result.endReason).toBe("victory-claimed");
    expect(result.winner).toBe("blue");
    expect(result.durationSeconds).toBeLessThan(200);
    const after = finishBattle(data, r, ENV, result, nb);
    expect(phaseOf(after)).toBe("after-battle");
    expect(after.op!.steps.at(-1)!.result).toBe("win");
    const cat = campaignCatalog(data, after);
    for (const side of ["player", "enemy"] as const) {
      expect(holdingsDiff(forceHoldings(cat, after.sides[side]), addHoldings(forceHoldings(cat, start.sides[side]), bookedChange(after, side)))).toEqual({});
    }
  });

  it("an auto-resolved battle whose enemy is spent ends early ('side-spent'), the player winning the node", { timeout: 600_000 }, () => {
    let r = startFlow(data, newCampaign(data, XF));
    r = confirmForces(data, chooseForces(data, r));
    const nb = battleInputs(data, r, ON_POSTS);
    const input = nb.main!.input;
    const result = runBattle(input, { controllers: planControllers(input), onTick: (s) => { if (s.state.tick === 600) beatEnemy(s, input); } });
    expect(result.endReason).toBe("side-spent");
    expect(result.winner).toBe("blue");
    expect(result.durationSeconds).toBeLessThan(200);
    const after = finishBattle(data, r, ENV, result, nb);
    expect(after.op!.steps.at(-1)!.result).toBe("win");
  });
});
