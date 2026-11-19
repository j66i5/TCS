/**
 * A CAMPAIGN CHAIN (M12.1a, plan 4.3): the smallest driver of the campaign record. A fixed sequence of scenario kinds
 * (attack, defence with counter-attack, meeting, ambush, withdrawal; the player blue), each on a new map, one company's
 * worth per side (`proposeCommit`), the battles run through the injected `BattleRunner`; `applyResult` after every
 * battle and `replenish` after every `operation.battles` battles (not after the last). M12.2 replaces the fixed
 * sequence by operations whose result picks the next battle.
 */
import type { DataSet } from "@tcs/data";
import type { BattleInput } from "@tcs/sim";
import { buildScenario, type MapKind, type ScenarioDef, type ScenarioHooks, type ScenarioKind } from "@tcs/scenario";
import { applyResult, replenish } from "./between";
import { proposeCommit } from "./commit";
import { newCampaign, type CampaignRecord, type CampaignSide, type NewCampaignOptions } from "./record";
import { campaignRules } from "./rules";
import type { BattleRunner } from "./runner";

/** The chain's battles in turn: the kind and who attacks (ambush: the side on the move; withdrawal: the follower). */
export const CHAIN_NODES: readonly { kind: ScenarioKind; attacker: CampaignSide }[] = [
  { kind: "attack", attacker: "player" },
  { kind: "defence-counterattack", attacker: "enemy" },
  { kind: "meeting", attacker: "player" },
  { kind: "ambush", attacker: "enemy" },
  { kind: "withdrawal", attacker: "player" },
];
export const CHAIN_MAPS: readonly MapKind[] = ["village", "farmland", "woodland", "industrial"];

export interface CampaignChainOptions extends NewCampaignOptions {
  battles: number;
  timeLimitSeconds?: number;
  hooks?: ScenarioHooks;
  /** Called after each battle and replenishment with the record (reports, tests). */
  onStep?(record: CampaignRecord, step: { kind: "battle"; input: BattleInput } | { kind: "replenishment" }): void;
}

export interface CampaignChainResult {
  record: CampaignRecord;
  end: "done" | "side-empty";
}

/** The scenario of battle k of a chain. */
export function chainBattleDef(data: DataSet, record: CampaignRecord, k: number, seconds: number): ScenarioDef | null {
  const node = CHAIN_NODES[k % CHAIN_NODES.length]!;
  const p = record.sides.player, e = record.sides.enemy;
  const pc = proposeCommit(data, p), ec = proposeCommit(data, e);
  if (pc.units.length === 0 || ec.units.length === 0) return null;
  return {
    kind: node.kind, seed: record.seed * 100 + k, mapKind: CHAIN_MAPS[k % CHAIN_MAPS.length]!, factions: [p.faction, e.faction],
    attacker: node.attacker === "player" ? "blue" : "red", carriers: [p.carriers, e.carriers], vehicles: true,
    timeLimitSeconds: seconds, campaignOut: true, forces: [pc, ec],
  };
}

export function runCampaignChain(data: DataSet, opts: CampaignChainOptions, runner: BattleRunner): CampaignChainResult {
  const rules = campaignRules(data);
  let record = newCampaign(data, opts);
  for (let k = 0; k < opts.battles; k++) {
    const def = chainBattleDef(data, record, k, opts.timeLimitSeconds ?? 900);
    if (!def) return { record, end: "side-empty" };
    const input = buildScenario(data, def, opts.hooks ?? {});
    input.seed = record.seed * 1000 + k;
    const result = runner(input, {});
    record = applyResult(data, record, { input, result, playerSide: "blue", kind: def.kind, mapKind: def.mapKind, mapSeed: def.seed, attacker: def.attacker === "blue" ? "player" : "enemy" });
    opts.onStep?.(record, { kind: "battle", input });
    if (record.operation.battles >= rules.operation.battles && k + 1 < opts.battles) {
      record = replenish(data, record);
      opts.onStep?.(record, { kind: "replenishment" });
    }
  }
  return { record, end: "done" };
}
