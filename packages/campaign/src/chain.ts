/**
 * A CHAIN OF BATTLES ON ONE SECTOR (M12.0a): the smallest consumer of the campaign contract. Battle 1 is the platoon
 * battle of the scenario generator (both sides from their templates); each next battle is fought on the same map
 * with both sides' forces as the last one left them (`fieldForce`) and the sector's damage and wrecks
 * (`sectorTerrain`). The battles run through the injected `BattleRunner` (tools: AI on both sides). The chain stops
 * early when a side has nobody left to field.
 */
import type { DataSet } from "@tcs/data";
import type { BattleInput, BattleResult } from "@tcs/sim";
import { buildScenario, type MapKind, type ScenarioDef, type ScenarioForces, type ScenarioHooks, type ScenarioTerrain } from "@tcs/scenario";
import { fieldForce, menOf, sectorTerrain } from "./carry";
import type { BattleRunner } from "./runner";

export interface ChainOptions {
  /** Factions of blue (the player's side) and red. */
  factions: [string, string];
  battles: number;
  seed: number;
  mapKind?: MapKind;
  attacker?: "blue" | "red";
  /** Mounted (the platoons' carriers, as the mounted platoon battles). Default true. */
  vehicles?: boolean;
  timeLimitSeconds?: number;
  hooks?: ScenarioHooks;
}

export interface ChainBattle {
  index: number;
  input: BattleInput;
  result: BattleResult;
  /** What the next battle gets (absent after the last). */
  next?: { forces: [ScenarioForces, ScenarioForces]; terrain: ScenarioTerrain };
}

export interface ChainResult {
  battles: ChainBattle[];
  /** Why it ended: all battles fought, or a side had nobody left to field. */
  end: "done" | "side-empty";
}

/** The scenario of a battle of a chain: the same map every time; forces and terrain carried. */
export function chainScenario(opts: ChainOptions, carried?: { forces: [ScenarioForces, ScenarioForces]; terrain: ScenarioTerrain }): ScenarioDef {
  return {
    kind: "platoon-attack", seed: opts.seed, mapKind: opts.mapKind ?? "village", factions: opts.factions, attacker: opts.attacker ?? "blue",
    attackerPlatoons: 1, vehicles: opts.vehicles !== false, timeLimitSeconds: opts.timeLimitSeconds ?? 900, campaignOut: true,
    ...(carried ? { forces: carried.forces, terrain: carried.terrain } : {}),
  };
}

export function runChain(data: DataSet, opts: ChainOptions, runner: BattleRunner): ChainResult {
  const battles: ChainBattle[] = [];
  let carried: { forces: [ScenarioForces, ScenarioForces]; terrain: ScenarioTerrain } | undefined;
  for (let k = 0; k < opts.battles; k++) {
    const input = buildScenario(data, chainScenario(opts, carried), opts.hooks ?? {});
    // (Each battle its own run of the dice on the same map.)
    input.seed = opts.seed * 1000 + k;
    const result = runner(input, {});
    const b: ChainBattle = { index: k, input, result };
    battles.push(b);
    if (k + 1 >= opts.battles) break;
    const forces = (["blue", "red"] as const).map((side) => {
      const out = result.forcesOut.find((f) => f.side === side)!, inp = input.forces.find((f) => f.side === side)!;
      return fieldForce(out, inp);
    }) as [ScenarioForces, ScenarioForces];
    carried = { forces, terrain: sectorTerrain(result) };
    b.next = carried;
    if (forces.some((f) => menOf(f.units) === 0)) return { battles, end: "side-empty" };
  }
  return { battles, end: "done" };
}
