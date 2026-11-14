/** M8.5 (AI parts): screens across the line, artillery only beyond danger close (airburst on men in the open),
 *  planned fires for the defender. */
import { describe, expect, it } from "vitest";
import { commanderController } from "@tcs/ai";
import { buildScenario } from "@tcs/scenario";
import { hypot2, isOut, runBattle, type Order } from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData();

describe("AI fire support (M8.5)", () => {
  it("the defender's mortars start registered on planned targets in front of its objectives", () => {
    const input = buildScenario(data, { kind: "platoon-attack", seed: 1, mapKind: "village", factions: ["de", "ru"], attacker: "blue", timeLimitSeconds: 600 });
    const red = input.rules.support!.find((s) => s.side === "red")!;
    const blue = input.rules.support!.find((s) => s.side === "blue")!;
    expect(red.planned).toHaveLength(3);
    expect(blue.planned).toBeUndefined();
    // In front of the main objective: toward the attacker (west).
    const main = input.rules.objectives[0]!;
    for (const p of red.planned!.slice(0, 2)) expect(p.x).toBeLessThan(main.x);
  });

  it("on a wide map the attacker calls the guns, never within danger close of its own men, and its screens are lines", () => {
    const input = buildScenario(data, { kind: "platoon-attack", seed: 2, mapKind: "farmland", factions: ["de", "ru"], attacker: "blue", timeLimitSeconds: 900, mapWidthM: 2400, mapHeightM: 900, artillery: true });
    const dc = input.catalog.factions["de"]!.artillery!.dangerCloseM!;
    const cs = [commanderController("blue", input), commanderController("red", input)];
    const bad: Order[] = [];
    let artCalls = 0;
    const watched = cs.map((c) => ({ ...c, think: (v: Parameters<typeof c.think>[0], t: number) => {
      const out = c.think(v, t);
      for (const o of out) {
        if (o.kind !== "callFire" || o.asset !== "artillery") continue;
        artCalls++;
        expect(o.dangerClose).toBeUndefined();
        for (const [id, s] of v.soldier.entries()) {
          if (v.identity.get(id)?.side !== o.issuer || isOut(s)) continue;
          const tt = v.transform.get(id);
          if (tt && hypot2(tt.x - o.x, tt.y - o.y) < dc) bad.push(o);
        }
      }
      return out;
    } }));
    const r = runBattle(input, { controllers: watched });
    expect(bad).toHaveLength(0);
    expect(artCalls).toBeGreaterThan(0);
    const smoke = r.orders.filter((o) => o.issuer === "blue" && o.kind === "callFire" && o.ammo === "smoke");
    expect(smoke.some((o) => o.kind === "callFire" && o.x2 !== undefined)).toBe(true);
  });
});
