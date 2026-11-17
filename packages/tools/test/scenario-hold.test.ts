/** M11.1: the hold-resupply scenario: waves arriving late, the supply point, save and load across an arrival. */
import { describe, expect, it } from "vitest";
import { buildScenario, HOLD, holdBattle } from "@tcs/scenario";
import { commanderController, waveCommanders } from "@tcs/ai";
import { createSim, rimHeight, hashState, loadGame, saveGame, secondsToTicks, step, submitOrder, type Sim } from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData();
const input0 = () => holdBattle(data, { factions: ["de", "ru"], seed: 1 });
const blueCommander = (input: ReturnType<typeof input0>) => commanderController("blue", input);

describe("hold-resupply (M11.1)", () => {
  it("one defending platoon, three attacking platoons of which two arrive at 15 and 30 min; a supply point of cans", () => {
    const input = holdBattle(data, { factions: ["de", "ru"], seed: 2 });
    const red = input.forces.find((f) => f.side === "red")!, blue = input.forces.find((f) => f.side === "blue")!;
    const plats = red.units.filter((u) => u.echelon === "platoon");
    expect(plats.map((u) => u.arriveS ?? 0)).toEqual([0, 900, 1800]);
    expect(new Set(plats.map((u) => u.callsign)).size).toBe(3);
    expect(blue.units.filter((u) => u.echelon === "platoon")).toHaveLength(1);
    expect(input.rules.timeLimitSeconds).toBe(3600);
    // The cans: one per squad for each cartridge the squad's weapons fire.
    const cache = blue.caches![0]!;
    expect(cache.load.every((s) => input.catalog.items[s.type]?.category === "ammo-package")).toBe(true);
    expect(cache.load.reduce((n, s) => n + s.count, 0)).toBeGreaterThanOrEqual(3);
    const main = input.rules.objectives[0]!;
    expect(Math.hypot(cache.x - main.x, cache.y - main.y)).toBeGreaterThan(100);
    expect(cache.x).toBeLessThan(main.x); // (behind the village, away from the attack from the east)
  });

  it("a stronger defence: the defender's positions are prepared, the attacker has a sixth of the platoon battle's mortar rounds", () => {
    for (const defender of ["blue", "red"] as const) {
      const input = holdBattle(data, { factions: ["de", "ru"], seed: 3, defender });
      const attacker = defender === "blue" ? "red" : "blue";
      expect(input.rules.prepared).toEqual([{ side: defender, fromS: HOLD.preparedS[0], untilS: HOLD.preparedS[1] }]);
      const plain = buildScenario(data, { kind: "platoon-attack", seed: 3, mapKind: "village", factions: ["de", "ru"], attacker, attackerPlatoons: 3, hold: true });
      const he = (i: typeof input) => i.rules.support!.find((sp) => sp.side === attacker && sp.asset === undefined)!.he;
      expect(he(input)).toBe(Math.round(he(plain) * HOLD.attackerMortarShare));
      expect(he(input)).toBeLessThan(he(plain) / 4);
    }
    expect(input0().catalog.ballistics.fightingPosition).toBeDefined();
  });

  it("the defenders dig in where they are sited in the first minutes and fight from there", () => {
    const input = holdBattle(data, { factions: ["de", "ru"], seed: 1, timeLimitSeconds: 150 });
    const sim: Sim = createSim(input);
    const ctl = waveCommanders("red", input), def = blueCommander(input);
    for (let i = 0; i < secondsToTicks(HOLD.preparedS[1] + 1); i++) { for (const c of [ctl, def]) for (const o of c.think(sim.state, sim.state.tick)) submitOrder(sim, o); step(sim); }
    const ps = sim.state.terrain.positions ?? [];
    expect(ps.length).toBeGreaterThanOrEqual(6);
    expect(ps.every((p) => p.side === "blue")).toBe(true);
    // (Men in them now: a rim above their feet.)
    const inHole = [...sim.state.soldier.keys()].filter((m) => rimHeight(sim.ctx, sim.state, m) > 0);
    expect(inHole.length).toBeGreaterThanOrEqual(6);
  }, 120_000);

  it("a wave enters at its time and not before; save and load across the arrival replays the same", () => {
    const mk = () => holdBattle(data, { factions: ["de", "ru"], seed: 1, waveS: [0, 30] });
    const input = mk();
    const sim: Sim = createSim(input);
    const ctl = waveCommanders("red", input);
    const redPlatoons = (s: Sim) => [...s.state.unit.values()].filter((u) => u.side === "red" && u.echelon === "platoon").length;
    const advance = (s: Sim, c: typeof ctl, n: number) => { for (let i = 0; i < n; i++) { for (const o of c.think(s.state, s.state.tick)) submitOrder(s, o); step(s); } };
    advance(sim, ctl, secondsToTicks(20));
    expect(redPlatoons(sim)).toBe(1);
    const save = saveGame(sim, [ctl]);
    const ctl2 = waveCommanders("red", mk());
    const copy = loadGame(mk(), JSON.parse(JSON.stringify(save)), [ctl2]);
    advance(sim, ctl, secondsToTicks(15));
    advance(copy, ctl2, secondsToTicks(15));
    expect(redPlatoons(sim)).toBe(2);
    expect(hashState(copy.state)).toBe(hashState(sim.state));
  }, 120_000);
});

describe("hold-resupply balance (M11.8)", () => {
  it("defenderLoadShare 0.5: the defenders start with half their spare magazines loaded (the rest empty) and half their loose rounds; the attackers in full; off by default", () => {
    expect(HOLD.defenderLoadShare).toBe(1);
    const full = holdBattle(data, { factions: ["de", "ru"], seed: 4, defenderLoadShare: 1 });
    const part = holdBattle(data, { factions: ["de", "ru"], seed: 4, defenderLoadShare: 0.5 });
    const cat = part.catalog;
    const rounds = (i: typeof part, side: string, cats: string[]) => {
      let n = 0, mags = 0;
      for (const u of i.forces.find((f) => f.side === side)!.units) {
        const walk = (x: typeof u): void => { for (const m of x.members) for (const l of m.load) { const d = cat.items[l.type]; if (d?.chargeItem !== undefined && cats.includes(d.category)) { n += (l.charge ?? 0) * l.count; mags += l.count; } } x.subunits.forEach(walk); };
        walk(u);
      }
      return { n, mags };
    };
    const fm = rounds(full, "blue", ["magazine"]), pm = rounds(part, "blue", ["magazine"]);
    expect(pm.mags).toBe(fm.mags); // (no magazine lost: the empty ones are still carried)
    expect(pm.n).toBeLessThan(fm.n * 0.65);
    expect(pm.n).toBeGreaterThan(fm.n * 0.35);
    expect(rounds(part, "red", ["magazine", "ammo-package"])).toEqual(rounds(full, "red", ["magazine", "ammo-package"]));
    // Every defender still has a loaded magazine for his weapon.
    const sim = createSim(part);
    for (const [id, i] of sim.state.identity.entries()) if (i.side === "blue" && sim.state.weapon.get(id)?.magazine === null) throw new Error(`defender ${id} has no loaded magazine`);
  });
});
