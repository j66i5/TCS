/**
 * THE CAMPAIGN'S STATE MACHINE (M12.2, plan m12-roster 4.5): every step between two battles as a pure function of the
 * record (each returns a new record; the phase is kept in `record.flow`, so a saved campaign resumes where it stood
 * and the M12.3 screens only show it):
 *
 *   briefing --chooseForces--> choose --confirmForces--> battle --finishBattle (played) / autoResolve--> after-battle
 *   after-battle --proceed--> briefing (the next node) | replenishment (endless: every `replenishEvery` nodes, or no
 *   able platoon left) | operation-end (operations mode)
 *   replenishment --proceed--> briefing;  operation-end --proceed--> replenishment applied, a new operation, briefing
 *
 * - The player's choice (`setChoice`, validated by `validateCommit`) defaults to `proposeChoice` (the fittest company
 *   within the cap). The enemy commits by the node's ratio (`enemyChoice`) when the battle is built.
 * - A FLANK battle (the node has one, the player has a second able company) is always auto-resolved through the
 *   injected runner (AI both sides, the real sim); the player's own battle is played (its result handed to
 *   `finishBattle`) or auto-resolved on request. A side with nothing to commit never goes into a battle: the enemy
 *   without an able platoon loses the node without a battle (a walkover), a battle with a side of 0 men throws.
 * - Replenishment only at an operation's end (operations mode) or every `endless.replenishEvery` nodes (endless).
 */
import type { DataSet } from "@tcs/data";
import { hashString32, type BattleInput, type BattleResult } from "@tcs/sim";
import { buildScenario, type ScenarioDef, type ScenarioHooks } from "@tcs/scenario";
import { applyResult, passHours, replenish } from "./between";
import { menOf } from "./carry";
import { commitOf, enemyChoice, proposeChoice, validateCommit } from "./commit";
import { advance, generateOperation, nodeBattleDef, operationRules, rememberSector, sectorOf } from "./operation";
import { clone, type CampaignRecord, type CampaignSide, type FlowPhase, type NodeResult, type OperationStep } from "./record";
import { campaignRules } from "./rules";
import type { BattleRunner } from "./runner";

/** What drives the flow's battles (the campaign never imports the AI: the caller injects it). */
export interface FlowEnv {
  runner: BattleRunner;
  hooks?: ScenarioHooks;
  /** Auto-resolve progress (battle seconds so far) of the main or flank battle. */
  onProgress?(which: "main" | "flank", seconds: number): void;
}

export class FlowError extends Error {
  constructor(message: string, readonly problems: string[] = []) { super(message); this.name = "FlowError"; }
}

export function phaseOf(record: CampaignRecord): FlowPhase | null {
  return record.flow?.phase ?? null;
}

function expect(record: CampaignRecord, ...phases: FlowPhase[]): void {
  const p = phaseOf(record);
  if (p === null || !phases.includes(p)) throw new FlowError(`flow is in phase '${p ?? "none"}', not ${phases.join(" / ")}`);
}

/** The campaign's first step: an operation (or the endless run) generated, phase "briefing". A record already in the
 *  flow is returned as it is. */
export function startFlow(data: DataSet, record: CampaignRecord): CampaignRecord {
  if (record.flow && record.op) return record;
  const r = generateOperation(data, record);
  r.flow = { phase: "briefing" };
  return r;
}

/** briefing -> choose, with the proposed choice. */
export function chooseForces(data: DataSet, record0: CampaignRecord): CampaignRecord {
  expect(record0, "briefing");
  const record = clone(record0);
  record.flow = { phase: "choose", choice: proposeChoice(data, record.sides.player) };
  return record;
}

/** In "choose": the player's choice (unit keys from `selectables`); its problems (empty: valid). The choice is kept
 *  even when it has problems (the screen shows them); `confirmForces` refuses it then. */
export function setChoice(data: DataSet, record0: CampaignRecord, keys: readonly string[]): { record: CampaignRecord; problems: string[] } {
  expect(record0, "choose");
  const record = clone(record0);
  record.flow = { phase: "choose", choice: [...keys] };
  return { record, problems: validateCommit(data, record.sides.player, keys) };
}

/** choose -> battle: the choice validated (FlowError with its problems if not), the flank company proposed (the
 *  fittest company not chosen; none when the node has no flank battle). */
export function confirmForces(data: DataSet, record0: CampaignRecord): CampaignRecord {
  expect(record0, "choose");
  const record = clone(record0);
  const choice = record.flow!.choice ?? [];
  const problems = validateCommit(data, record.sides.player, choice);
  if (problems.length > 0) throw new FlowError("the choice cannot fight", problems);
  const flankChoice = record.op!.flank ? proposeChoice(data, record.sides.player, choice) : [];
  record.flow = { phase: "battle", choice, ...(flankChoice.length > 0 ? { flankChoice } : {}) };
  return record;
}

/** M12.3: battle -> choose (the player goes back to his choice before the battle is fought, e.g. after cancelling an
 *  auto-resolve); the choice is kept. */
export function reviseForces(record0: CampaignRecord): CampaignRecord {
  expect(record0, "battle");
  const record = clone(record0);
  record.flow = { phase: "choose", choice: record.flow!.choice ?? [] };
  return record;
}

/** One battle of a node, built. */
export interface NodeBattle { which: "main" | "flank"; def: ScenarioDef; input: BattleInput; sector: number; node: string; playerKeys: string[]; enemyKeys: string[] }
export interface NodeBattles {
  /** null: the enemy has nothing to commit (the node is won without a battle). */
  main: NodeBattle | null;
  /** null: no flank battle (none this node, no second company, or the enemy has nothing left: `flankWalkover`). */
  flank: NodeBattle | null;
  flankWalkover: boolean;
}

const seedOf = (record: CampaignRecord, which: "main" | "flank") => hashString32(`campaign/${record.seed}/${record.battles}/${which}`);

/** A faction's fighting value per man (M12.4: factions/<id>/campaign.json; 1 without it). */
export const fightingValue = (data: DataSet, faction: string): number => data.factions[faction]?.campaign?.fightingValue ?? 1;
/** The player's fighting value per man over the enemy's: the enemy's commit ratio is weighed by it (M12.4). */
export const valueRatio = (data: DataSet, record: CampaignRecord): number =>
  fightingValue(data, record.sides.player.faction) / fightingValue(data, record.sides.enemy.faction);

/** The enemy's units for the node's main or flank battle (keys), against the player's committed men. */
export function enemyFor(data: DataSet, record: CampaignRecord, which: "main" | "flank", playerMen: number, exclude: readonly string[] = []): string[] {
  const o = operationRules(data);
  const nt = o.nodes[which === "main" ? record.op!.node : record.op!.flank!.node]!;
  return enemyChoice(data, record.sides.enemy, playerMen, nt.enemyRatio * valueRatio(data, record), nt.enemySupport, exclude);
}

/** In "battle": the node's battles, built (pure: the same record gives the same inputs). */
export function battleInputs(data: DataSet, record: CampaignRecord, hooks: ScenarioHooks = {}): NodeBattles {
  expect(record, "battle");
  const op = record.op!;
  const p = record.sides.player, e = record.sides.enemy;
  const build = (which: "main" | "flank", playerKeys: string[], enemyKeys: string[]): NodeBattle => {
    const pf = commitOf(data, p, playerKeys), ef = commitOf(data, e, enemyKeys);
    if (menOf(pf.units) === 0 || menOf(ef.units) === 0) throw new FlowError(`a ${which} battle with a side of 0 men (player ${menOf(pf.units)}, enemy ${menOf(ef.units)})`);
    const def = nodeBattleDef(data, record, which, [pf, ef]);
    const input = buildScenario(data, def, hooks);
    input.seed = seedOf(record, which);
    for (const f of input.forces) if (menOf(f.units) === 0) throw new FlowError(`a ${which} battle input with side ${f.side} of 0 men`);
    return { which, def, input, sector: sectorOf(op, which).id, node: which === "main" ? op.node : op.flank!.node, playerKeys, enemyKeys };
  };
  const choice = record.flow!.choice ?? [];
  const pMen = menOf(commitOf(data, p, choice).units);
  const ek = enemyFor(data, record, "main", pMen);
  if (ek.length === 0) return { main: null, flank: null, flankWalkover: false };
  const main = build("main", choice, ek);
  const fc = record.flow!.flankChoice ?? [];
  if (!op.flank || fc.length === 0) return { main, flank: null, flankWalkover: false };
  const fek = enemyFor(data, record, "flank", menOf(commitOf(data, p, fc).units), ek);
  if (fek.length === 0) return { main, flank: null, flankWalkover: true };
  return { main, flank: build("flank", fc, fek), flankWalkover: false };
}

const resultOf = (r: BattleResult, playerSide: "blue" | "red"): NodeResult => (r.winner === null ? "draw" : r.winner === playerSide ? "win" : "loss");

/** Apply one battle of a node (and remember its sector). */
function applyNodeBattle(data: DataSet, record: CampaignRecord, b: NodeBattle, result: BattleResult): CampaignRecord {
  const r = applyResult(data, record, {
    input: b.input, result, playerSide: "blue", kind: b.def.kind, mapKind: b.def.mapKind, mapSeed: b.def.seed,
    attacker: b.def.attacker === "blue" ? "player" : "enemy", node: b.node, sector: b.sector, ...(b.which === "flank" ? { flank: true } : {}),
  });
  rememberSector(r.op!, b.sector, result);
  return r;
}

/**
 * battle -> after-battle: the node's flank battle auto-resolved (through `env.runner`), the main battle's result (the
 * played battle's, or "auto": run through `env.runner`), both applied (the flank first, without the clock), the
 * sectors remembered, the step recorded and the next node (or the operation's end) chosen by the table.
 */
export function finishBattle(data: DataSet, record0: CampaignRecord, env: FlowEnv, main: BattleResult | "auto", built?: NodeBattles): CampaignRecord {
  expect(record0, "battle");
  const nb = built ?? battleInputs(data, record0, env.hooks ?? {});
  let record = record0;
  const op0 = record0.op!;
  const step: OperationStep = { node: op0.node, sector: op0.line[op0.pos]!, pos: op0.pos, result: "win" };
  if (nb.main === null) {
    // The enemy has nothing to commit: the node is won without a battle (the clock runs as between two battles).
    record = passHours(data, record, campaignRules(data).clock.hoursBetweenBattles);
    step.walkover = true;
    record.log.push({ battle: record.battles, side: "enemy", kind: "walkover" });
  } else {
    if (nb.flank) {
      const fr = env.runner(nb.flank.input, { onProgress: (s) => env.onProgress?.("flank", s) });
      step.flank = { node: nb.flank.node, sector: nb.flank.sector, battle: record.battles, result: resultOf(fr, "blue") };
      record = applyNodeBattle(data, record, nb.flank, fr);
    } else if (nb.flankWalkover && op0.flank) {
      step.flank = { node: op0.flank.node, sector: op0.flank.sector, result: "win", walkover: true };
    }
    const mr = main === "auto" ? env.runner(nb.main.input, { onProgress: (s) => env.onProgress?.("main", s) }) : main;
    step.battle = record.battles;
    step.result = resultOf(mr, "blue");
    record = applyNodeBattle(data, record, nb.main, mr);
  }
  record = clone(record);
  record.op!.steps.push(step);
  advance(data, record, step.result, proposeChoice(data, record.sides.player).length > 0);
  record.flow = { phase: "after-battle" };
  return record;
}

/** battle -> after-battle with the player's battle auto-resolved. `built`: `battleInputs` of this record (saves building
 *  the maps again). */
export function autoResolve(data: DataSet, record: CampaignRecord, env: FlowEnv, built?: NodeBattles): CampaignRecord {
  return finishBattle(data, record, env, "auto", built);
}

/** Is a replenishment due (endless: every `replenishEvery` nodes, or the player has no able platoon)? */
function replenishmentDue(data: DataSet, record: CampaignRecord): boolean {
  const op = record.op!;
  return op.endless && (op.sinceReplenishment >= operationRules(data).replenishEvery || proposeChoice(data, record.sides.player).length === 0);
}

/** after-battle -> briefing / replenishment / operation-end; replenishment -> briefing; operation-end -> a new
 *  operation (replenished first) -> briefing. */
export function proceed(data: DataSet, record0: CampaignRecord): CampaignRecord {
  expect(record0, "after-battle", "replenishment", "operation-end");
  const phase = phaseOf(record0)!;
  if (phase === "after-battle") {
    const record = clone(record0);
    const op = record.op!;
    record.flow = { phase: op.end ? "operation-end" : replenishmentDue(data, record) ? "replenishment" : "briefing" };
    return record;
  }
  if (phase === "replenishment") {
    const record = replenish(data, record0);
    record.op!.sinceReplenishment = 0;
    record.flow = { phase: "briefing" };
    return record;
  }
  // operation-end: the operation archived, the replenishment, the next operation.
  let record = clone(record0);
  const op = record.op!;
  (record.operations ??= []).push({
    index: op.index, sectors: op.line.length, steps: op.steps, end: op.end!,
    battles: op.steps.reduce((n, s) => n + (s.battle !== undefined ? 1 : 0) + (s.flank?.battle !== undefined ? 1 : 0), 0), nodes: op.steps.length,
  });
  record.log.push({ battle: record.battles, side: "player", kind: "operation-end", how: op.end!, count: op.steps.length });
  delete record.op;
  record = replenish(data, record);
  record = generateOperation(data, record);
  record.flow = { phase: "briefing" };
  return record;
}

/** Who attacks in the node about to be fought (the briefing). */
export function attackerOf(data: DataSet, record: CampaignRecord): CampaignSide {
  return operationRules(data).nodes[record.op!.node]!.attacker;
}

/** What `autoPlay` reports after every step. */
export type AutoPlayEvent =
  | { kind: "node"; before: CampaignRecord; record: CampaignRecord; battles: NodeBattles }
  | { kind: "replenishment"; record: CampaignRecord }
  | { kind: "operation-end"; record: CampaignRecord };

/**
 * The AI plays the player's side: every node with the proposed choice, auto-resolved, until `stop` says so (checked
 * before every node). `onStep` sees each node (with the battles as built: the batch's checks) and each replenishment.
 */
export function autoPlay(data: DataSet, record0: CampaignRecord, env: FlowEnv, stop: (r: CampaignRecord) => boolean, onStep?: (e: AutoPlayEvent) => void): CampaignRecord {
  let record = startFlow(data, record0);
  for (;;) {
    const phase = phaseOf(record)!;
    if (phase === "briefing" && stop(record)) return record;
    if (phase === "briefing") { record = chooseForces(data, record); continue; }
    if (phase === "choose") { record = confirmForces(data, record); continue; }
    if (phase === "battle") {
      const battles = battleInputs(data, record, env.hooks ?? {});
      const before = record;
      record = autoResolve(data, record, env, battles);
      onStep?.({ kind: "node", before, record, battles });
      continue;
    }
    if (phase === "after-battle") { record = proceed(data, record); continue; }
    const was = phase;
    record = proceed(data, record);
    onStep?.({ kind: was === "replenishment" ? "replenishment" : "operation-end", record });
  }
}
