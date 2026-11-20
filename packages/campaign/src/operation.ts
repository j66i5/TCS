/**
 * OPERATIONS AND ENDLESS MODE (M12.2, plan m12-roster 4.5; owner 2026-11-19: operations of 3-5 linked battles on
 * connected maps, the result picks the next battle, plus an endless mode with periodic replenishments).
 *
 * - An operation is a LINE of 3-5 sectors (`operation.sectors`): sector maps, each with its kind, seed and size (the
 *   size of its first node's kind at company size), so a sector fought again is the same map. The player is blue
 *   (west); the east edge of a sector leads to the west edge of the next one. Each position on the line has a PLANNED
 *   node (the first from `operation.start`, the others from `operation.planned`).
 * - A NODE is a node type of `core/campaign.json` `nodes` (a scenario kind, who attacks, the enemy's commit ratio and
 *   whether it brings its headquarters and support) on a sector, and maybe a FLANK battle for a second company
 *   (chance `flankChance`, its type from `flankNodes`, on a flank sector beside the line sector; auto-resolved).
 * - THE RESULT PICKS THE NEXT NODE (`transitions`): per node type and the player's result (win, loss, draw) the next
 *   node ("planned": the planned node of the position it moves to) and the move on the line ("next", "same", "back";
 *   never before the first sector). A win that moves on past the last sector is SUCCESS. The operation fails on two
 *   losses in a row or when the player's battalion is below the combat-ineffective line, both only from `minBattles`
 *   nodes on (an operation always has 3-5 battles); it ends with no force when the player has no able platoon; and
 *   it stops after `battles` nodes (5: "limit"). Then the replenishment and the next operation (flow.ts).
 * - ENDLESS MODE has no line: the next node by the same table ("planned": drawn from `operation.planned`), a new
 *   sector every `endless.sectorEvery` nodes (else the same, with its damage), a replenishment every
 *   `endless.replenishEvery` nodes (flow.ts).
 * - SECTOR MEMORY: each sector keeps the map's damage and the wrecks its last battle left (`sectorTerrain`), handed to
 *   its next battle as `ScenarioDef.terrain`.
 *
 * Every draw comes from the campaign's own dice (`record.rng`, stream "campaign/op").
 */
import type { DataSet } from "@tcs/data";
import { nextU32, nextInt, nextFloat, pick, type BattleResult } from "@tcs/sim";
import { scenarioMapSize, type MapKind, type ScenarioDef, type ScenarioForces, type ScenarioTerrain } from "@tcs/scenario";
import { sectorTerrain } from "./carry";
import { deployableMen } from "./commit";
import { clone, unitsOf, type CampaignForce, type CampaignRecord, type NodeResult, type OperationEnd, type OperationState, type Sector } from "./record";
import { campaignRules, type CampaignRules } from "./rules";

const STREAM = "campaign/op";

export type NodeType = NonNullable<CampaignRules["nodes"]>[string];
export type Transitions = NonNullable<CampaignRules["transitions"]>;

/** The operation rules with their defaults (a data set without the M12.2 fields still runs). */
export interface OperationRules {
  maxBattles: number;
  minBattles: number;
  sectors: readonly [number, number];
  start: readonly string[];
  planned: readonly string[];
  flankNodes: readonly string[];
  flankChance: number;
  mapKinds: readonly MapKind[];
  replenishEvery: number;
  sectorEvery: number;
  nodes: Readonly<Record<string, NodeType>>;
  transitions: Transitions;
  seconds: number;
  combatIneffective: number;
}

export function operationRules(data: DataSet): OperationRules {
  const r = campaignRules(data);
  const o = r.operation;
  if (!r.nodes || !r.transitions) throw new Error("core/campaign.json has no `nodes` / `transitions` (M12.2)");
  return {
    maxBattles: o.battles, minBattles: Math.min(o.minBattles ?? 3, o.battles), sectors: o.sectors ?? [3, 5],
    start: o.start ?? ["attack"], planned: o.planned ?? ["attack"], flankNodes: o.flankNodes ?? ["attack"], flankChance: o.flankChance ?? 0,
    mapKinds: o.mapKinds ?? ["village", "farmland", "woodland", "industrial"],
    replenishEvery: r.endless.replenishEvery, sectorEvery: r.endless.sectorEvery ?? 2,
    nodes: r.nodes, transitions: r.transitions, seconds: r.battle.seconds ?? 1200, combatIneffective: r.combatIneffective,
  };
}

/** Problems with the operation data (empty: fine): node types the lists or the table name that do not exist, a node
 *  type without a row in the table. */
export function checkOperationRules(data: DataSet): string[] {
  const o = operationRules(data);
  const p: string[] = [];
  const known = (n: string, where: string) => { if (!o.nodes[n]) p.push(`${where}: unknown node '${n}'`); };
  for (const n of o.start) known(n, "operation.start");
  for (const n of o.planned) known(n, "operation.planned");
  for (const n of o.flankNodes) known(n, "operation.flankNodes");
  for (const n of Object.keys(o.nodes).sort()) if (!o.transitions[n]) p.push(`transitions: no row for '${n}'`);
  for (const [n, row] of Object.entries(o.transitions).sort()) {
    known(n, "transitions");
    for (const res of ["win", "loss", "draw"] as const) if (row[res].node !== "planned") known(row[res].node, `transitions.${n}.${res}`);
  }
  if (o.sectors[0] > o.sectors[1]) p.push("operation.sectors: min > max");
  if (o.sectors[0] < o.minBattles) p.push("operation.sectors: fewer sectors than minBattles (success could come too early)");
  return p;
}

/** The node a result leads to (pure; the table only): its type ("planned" resolved by `plannedAt`), its position, and
 *  whether the operation succeeded (a win moving on past the last sector; never in endless mode). A move before the
 *  first sector stays on it; a move past the last without a win stays on the last. */
export function nextNode(t: Transitions, node: string, result: NodeResult, pos: number, lineLength: number | null, plannedAt: (pos: number) => string): { node: string; pos: number; success: boolean } {
  const row = t[node];
  if (!row) throw new Error(`no transitions for node '${node}'`);
  const e = row[result];
  let p = e.sector === "next" ? pos + 1 : e.sector === "back" ? Math.max(0, pos - 1) : pos;
  if (lineLength !== null && p >= lineLength) {
    if (result === "win") return { node: e.node === "planned" ? plannedAt(lineLength - 1) : e.node, pos: lineLength - 1, success: true };
    p = lineLength - 1;
  }
  return { node: e.node === "planned" ? plannedAt(p) : e.node, pos: p, success: false };
}

/** A new sector (its map from the campaign's dice; its size from the node kind it is made for, at company size). */
function newSector(data: DataSet, record: CampaignRecord, op: OperationState, node: string, flankOf?: number): Sector {
  const o = operationRules(data);
  const mapKind = pick(record.rng, STREAM, o.mapKinds);
  const mapSeed = nextU32(record.rng, STREAM) % 1_000_000;
  const nt = o.nodes[node]!;
  const { W, H } = scenarioMapSize({
    kind: nt.kind, seed: mapSeed, mapKind, factions: [record.sides.player.faction, record.sides.enemy.faction], attacker: nt.attacker === "player" ? "blue" : "red",
    size: "company", vehicles: true,
  });
  const s: Sector = { id: op.nextSectorId++, mapKind, mapSeed, widthM: W, heightM: H, battles: 0, ...(flankOf !== undefined ? { flankOf } : {}) };
  op.sectors.push(s);
  return s;
}

/** The flank battle of a node (with chance `flankChance`): its type and its flank sector (the one beside this line
 *  sector, made the first time). */
function rollFlank(data: DataSet, record: CampaignRecord, op: OperationState): OperationState["flank"] {
  const o = operationRules(data);
  if (o.flankChance <= 0 || nextFloat(record.rng, STREAM) >= o.flankChance) return undefined;
  const node = pick(record.rng, STREAM, o.flankNodes);
  const main = op.line[op.pos]!;
  const s = op.sectors.find((x) => x.flankOf === main) ?? newSector(data, record, op, node, main);
  return { node, sector: s.id };
}

/** A new operation (operations mode) or the endless run's start: the record with `op` set and the start logged. */
export function generateOperation(data: DataSet, record0: CampaignRecord): CampaignRecord {
  const o = operationRules(data);
  const record = clone(record0);
  const endless = record.mode === "endless";
  const op: OperationState = { index: record.operation.index, endless, line: [], planned: [], sectors: [], nextSectorId: 0, node: "", pos: 0, steps: [], sinceReplenishment: 0, end: null };
  const length = endless ? 1 : o.sectors[0] + nextInt(record.rng, STREAM, o.sectors[1] - o.sectors[0] + 1);
  for (let i = 0; i < length; i++) {
    const node = i === 0 ? pick(record.rng, STREAM, o.start) : pick(record.rng, STREAM, o.planned);
    op.planned.push(node);
    op.line.push(newSector(data, record, op, node).id);
  }
  op.node = op.planned[0]!;
  const flank = rollFlank(data, record, op);
  if (flank) op.flank = flank;
  record.op = op;
  record.log.push({ battle: record.battles, side: "player", kind: "operation-start", count: length });
  return record;
}

/** The sector a node is fought on (the line's at `op.pos`, or the flank's). */
export function sectorOf(op: OperationState, which: "main" | "flank"): Sector {
  const id = which === "main" ? op.line[op.pos]! : op.flank!.sector;
  const s = op.sectors.find((x) => x.id === id);
  if (!s) throw new Error(`sector ${id} not in the operation`);
  return s;
}

/** What a sector hands its next battle. */
export function sectorTerrainIn(s: Sector): ScenarioTerrain | undefined {
  if (!s.damage && !(s.wrecks && s.wrecks.length > 0)) return undefined;
  return { ...(s.damage ? { damage: clone(s.damage) } : {}), ...(s.wrecks && s.wrecks.length > 0 ? { wrecks: clone(s.wrecks) } : {}) };
}

/** Sector memory: what a battle left on its sector (changes `op`). */
export function rememberSector(op: OperationState, sectorId: number, result: BattleResult): void {
  const s = op.sectors.find((x) => x.id === sectorId)!;
  const t = sectorTerrain(result);
  if (t.damage) s.damage = t.damage; else delete s.damage;
  if (t.wrecks) s.wrecks = t.wrecks; else delete s.wrecks;
  s.battles++;
}

/** The scenario of a node's battle (main or flank) with both sides' forces. */
export function nodeBattleDef(data: DataSet, record: CampaignRecord, which: "main" | "flank", forces: [ScenarioForces, ScenarioForces], seconds?: number): ScenarioDef {
  const op = record.op!;
  const o = operationRules(data);
  const nt = o.nodes[which === "main" ? op.node : op.flank!.node]!;
  const s = sectorOf(op, which);
  const p = record.sides.player, e = record.sides.enemy;
  const terrain = sectorTerrainIn(s);
  return {
    kind: nt.kind, seed: s.mapSeed, mapKind: s.mapKind, mapWidthM: s.widthM, mapHeightM: s.heightM, factions: [p.faction, e.faction],
    attacker: nt.attacker === "player" ? "blue" : "red", carriers: [p.carriers, e.carriers], vehicles: true,
    timeLimitSeconds: seconds ?? record.battleSeconds ?? o.seconds, campaignOut: true, forces,
    ...(terrain ? { terrain } : {}),
  };
}

/** Able men of a force against its establishment (the places of every unit's template); able: deployable, so crews of
 *  hulls in the workshop or lost do not count (`deployableMen`). */
export function ableShare(data: DataSet, f: CampaignForce): number {
  let places = 0;
  for (const u of unitsOf(f.battalion)) places += data.factions[f.faction]?.units[f.establishment[u.key] ?? ""]?.members.length ?? 0;
  return places === 0 ? 0 : deployableMen(f, f.battalion) / places;
}

/** Steps an endless run keeps (review M12: older ones are dropped and counted in `stepsDropped`). */
export const ENDLESS_STEPS_KEPT = 30;

/** Nodes fought in this operation or endless run (its steps, with the dropped ones). */
export function nodesFought(op: OperationState): number {
  return (op.stepsDropped ?? 0) + op.steps.length;
}

/** Losses in a row at the end of the steps. */
function lossesInRow(op: OperationState): number {
  let n = 0;
  for (let i = op.steps.length - 1; i >= 0 && op.steps[i]!.result === "loss"; i--) n++;
  return n;
}

/**
 * After a node's result (the step already appended to `op.steps`): the next node by the table, or the end of the
 * operation (see the file comment). `playerCanFight`: the player has an able platoon. Changes `op` (and draws from the
 * record's dice: endless "planned" nodes, flank rolls, new sectors).
 */
export function advance(data: DataSet, record: CampaignRecord, result: NodeResult, playerCanFight: boolean): void {
  const o = operationRules(data);
  const op = record.op!;
  const step = op.steps[op.steps.length - 1]!;
  op.sinceReplenishment++;
  delete op.flank;
  if (op.endless) {
    const t = nextNode(o.transitions, op.node, result, 0, null, () => pick(record.rng, STREAM, o.planned));
    step.next = { node: t.node, pos: op.pos };
    op.node = t.node;
    const fought = nodesFought(op);
    // (Review M12: the endless run keeps only its last `ENDLESS_STEPS_KEPT` steps, so the record does not grow with
    // them; the count of the dropped ones keeps the sector rhythm.)
    if (op.steps.length > ENDLESS_STEPS_KEPT) {
      const k = op.steps.length - ENDLESS_STEPS_KEPT;
      op.steps.splice(0, k);
      op.stepsDropped = (op.stepsDropped ?? 0) + k;
    }
    if (fought % o.sectorEvery === 0) {
      // A new sector; the old ones are never fought again (dropped, with their flank sectors).
      const s = newSector(data, record, op, t.node);
      op.sectors = op.sectors.filter((x) => x.id === s.id);
      op.line = [s.id];
      op.planned = [t.node];
      op.pos = 0;
      step.next.pos = 0;
    }
    const flank = rollFlank(data, record, op);
    if (flank) op.flank = flank;
    return;
  }
  const t = nextNode(o.transitions, op.node, result, op.pos, op.line.length, (p) => op.planned[p]!);
  const nodes = op.steps.length;
  let end: OperationEnd | null = null;
  if (t.success) end = "success";
  else if (!playerCanFight) end = "no-force";
  else if (nodes >= o.minBattles && (lossesInRow(op) >= 2 || ableShare(data, record.sides.player) < o.combatIneffective)) end = "failure";
  else if (nodes >= o.maxBattles) end = "limit";
  if (end) { step.end = end; op.end = end; return; }
  step.next = { node: t.node, pos: t.pos };
  op.node = t.node;
  op.pos = t.pos;
  const flank = rollFlank(data, record, op);
  if (flank) op.flank = flank;
}
