/**
 * The campaign batch (M12.2, plan m12-roster 4.5): campaigns played by the AI on both sides through the flow
 * (`autoPlay`), operations or endless mode, with the slice's acceptance checks counted per node:
 *
 * - no battle with a side of 0 men (the flow throws; counted here from the inputs as well);
 * - every operation 3-5 nodes (a "no-force" end may be shorter: listed);
 * - every step's next node (or end) is what the transition table gives (`nextNode` recomputed);
 * - a sector fought again gets the craters, holes and wrecks its last battle left (counted against the sector's memory);
 * - the enemy's roster at a node is its roster after its last battle (every enemy man in the node's input equal to his
 *   record then; the battalion's men unchanged) except across a replenishment;
 * - replenishments only at an operation's end (operations) or every `replenishEvery` nodes / no able platoon (endless).
 *
 * One campaign per call (`runCampaignPart`), so the CLI can run several in child processes; `batchReport` merges them.
 */
import type { DataSet } from "@tcs/data";
import {
  ableShare, autoPlay, membersOf, newCampaign, proposeChoice, nextNode, operationRules, hashRecord, menOf, type BattleRunner, type CampaignMode, type CampaignRecord, type CampaignSide,
  type OperationStep, type OperationSummary,
} from "@tcs/campaign";
import type { CarrierClass } from "@tcs/scenario";
import { aiRunner } from "./campaign";
import { ON_POSTS } from "./scenarios";

export interface PartOptions {
  faction: string;
  enemy: string;
  carriers: CarrierClass;
  seed: number;
  mode: CampaignMode;
  /** Operations to finish (operations mode) or nodes to fight (endless). */
  count: number;
  seconds: number;
}

export interface NodeRow {
  op: number; node: number; type: string; kind: string; pos: number; sector: number; result: string; walkover: boolean;
  flank: string | null; next: string; men: Record<CampaignSide, number>; flankMen: Record<CampaignSide, number> | null;
  durationS: number; wallS: number; flankWallS: number; endReason: string;
  /** Losses of the node's battles (killed, evacuated, captured, missing) per side. */
  lost: Record<CampaignSide, { killed: number; evacuated: number; captured: number; missing: number }>;
  fired: Record<CampaignSide, number>;
  craters: number; holes: number; wrecks: number;
}

export interface PartResult {
  opts: PartOptions;
  hash: string;
  rows: NodeRow[];
  operations: OperationSummary[];
  replenishments: { afterNode: number; reason: string }[];
  checks: {
    zeroMen: number; badOpLength: string[]; tableMismatch: string[]; revisits: number; revisitsWithCraters: number; revisitsWithWrecks: number; revisitMismatch: string[];
    enemyMismatch: string[]; replenishmentMisplaced: string[];
    /** A person id held by two men (units and pools of a side) after a node or replenishment. */
    duplicateIds: string[];
  };
  /** Per side at the end and after every replenishment / operation: men with units, recovering, dead, experience. */
  snapshots: { afterNode: number; side: CampaignSide; men: number; recovering: number; dead: number; held: number; xp: number[] }[];
  wallS: number;
  /** M12.4 tuning: per finished operation, the player's survivors' experience gain (men in the battalion at its start
   *  and at its end), the able share and losses in a row at its end, men back from recovery inside it. */
  opStats?: OpStat[];
  /** M12.4: settled recovery days of every player man evacuated (or incapacitated) in a battle. */
  recoveryDays?: number[];
  /** M12.4: endless mode, the player's able share just before each replenishment. */
  ableBeforeReplenish?: number[];
}

export interface OpStat {
  index: number; end: string; nodes: number; able: number; lossesInRow: number; rejoined: number;
  /** Survivors: experience gained over the operation, minutes under effective fire, battles fought (main and flank). */
  survivors: { gain: number; fireMin: number; battles: number; xp: number }[];
}

const sum = (r: Record<string, number> | undefined) => Object.values(r ?? {}).reduce((a, b) => a + b, 0);

function enemyMen(r: CampaignRecord): Map<string, string> {
  return new Map(membersOf(r.sides.enemy.battalion).map((m) => [m.personId, JSON.stringify(m)]));
}

/** One campaign of the batch (see the file comment). `runner`: aiRunner (tests may pass another). */
export function runCampaignPart(data: DataSet, o: PartOptions, runner: BattleRunner = aiRunner, log?: (line: string) => void): PartResult {
  const rules = operationRules(data);
  const t0 = performance.now();
  // Wall time of each battle run in the node (a flank battle runs first).
  let walls: number[] = [];
  const timed: BattleRunner = (input, ro) => { const t = performance.now(); const r = runner(input, ro); walls.push((performance.now() - t) / 1000); return r; };
  const res: PartResult = {
    opts: o, hash: "", rows: [], operations: [], replenishments: [],
    checks: { zeroMen: 0, badOpLength: [], tableMismatch: [], revisits: 0, revisitsWithCraters: 0, revisitsWithWrecks: 0, revisitMismatch: [], enemyMismatch: [], replenishmentMisplaced: [], duplicateIds: [] },
    snapshots: [], wallS: 0,
  };
  let record = newCampaign(data, { seed: o.seed, faction: o.faction, enemy: o.enemy, carriers: o.carriers, mode: o.mode, battleSeconds: o.seconds });
  // The enemy's roster as the last step left it (null right after a replenishment: not compared).
  let enemyAfter: Map<string, string> | null = null;
  let nodes = 0;
  const snap = (r: CampaignRecord) => {
    for (const side of ["player", "enemy"] as const) {
      const f = r.sides[side];
      res.snapshots.push({ afterNode: nodes, side, men: membersOf(f.battalion).length, recovering: f.pools.recovering.length, dead: f.pools.dead.length, held: f.pools.heldByEnemy.length, xp: membersOf(f.battalion).map((m) => m.skills["experience"] ?? 0) });
    }
  };
  const dupCheck = (r: CampaignRecord) => {
    for (const side of ["player", "enemy"] as const) {
      const f = r.sides[side];
      const ids = [...membersOf(f.battalion), ...(["recovering", "dead", "missing", "heldByEnemy", "unassigned", "replacements"] as const).flatMap((k) => f.pools[k].map((p) => p.record))].map((m) => m.personId);
      const seen = new Set<string>();
      for (const id of ids) { if (seen.has(id)) res.checks.duplicateIds.push(`after node ${nodes}: ${side} ${id}`); seen.add(id); }
    }
  };
  const stop = (r: CampaignRecord) => (o.mode === "endless" ? nodes >= o.count : (r.operations?.length ?? 0) >= o.count);
  let sinceRepl = 0;
  let lastNode: CampaignRecord | null = null;
  // M12.4 tuning: the operation's start (experience by person, battles and log length then).
  res.opStats = []; res.recoveryDays = []; res.ableBeforeReplenish = [];
  let opStart = { xp: new Map<string, number>(), battles: 0, log: 0 };
  const markStart = (r: CampaignRecord) => { opStart = { xp: new Map(membersOf(r.sides.player.battalion).map((m) => [m.personId, m.skills["experience"] ?? 0])), battles: r.battles, log: r.log.length }; };
  markStart(record);
  record = autoPlay(data, record, { runner: timed, hooks: ON_POSTS }, stop, (e) => {
    if (e.kind === "node") {
      nodes++;
      sinceRepl++;
      const r = e.record, op = r.op!, st = op.steps[op.steps.length - 1]!;
      const before = e.before;
      lastNode = r;
      const flankWall = e.battles.flank ? walls[0] ?? 0 : 0, wall = (e.battles.flank ? walls[1] : walls[0]) ?? 0;
      walls = [];
      const opBefore = before.op!;
      // Zero men (the flow throws before; counted from the inputs for the report).
      for (const b of [e.battles.main, e.battles.flank]) if (b) for (const f of b.input.forces) if (menOf(f.units) === 0) res.checks.zeroMen++;
      // Sector memory: a sector fought before hands on what it holds.
      for (const b of [e.battles.main, e.battles.flank]) {
        if (!b) continue;
        const s = opBefore.sectors.find((x) => x.id === b.sector)!;
        if (s.battles === 0) continue;
        res.checks.revisits++;
        const c = s.damage?.craters.length ?? 0, w = s.wrecks?.length ?? 0, h = s.damage?.breaches.length ?? 0;
        if (c > 0) res.checks.revisitsWithCraters++;
        if (w > 0) res.checks.revisitsWithWrecks++;
        const ci = b.input.damage?.craters.length ?? 0, wi = b.input.wrecksIn?.length ?? 0, hi = b.input.damage?.breaches.length ?? 0;
        if (ci !== c || wi !== w || hi !== h) res.checks.revisitMismatch.push(`node ${nodes} sector ${s.id}: memory ${c}c/${h}h/${w}w, input ${ci}c/${hi}h/${wi}w`);
      }
      // The enemy's roster: each man in the node's input as the last step left him; the battalion's men unchanged.
      if (enemyAfter) {
        const now = enemyMen(before);
        if (now.size !== enemyAfter.size || [...now].some(([k, v]) => enemyAfter!.get(k) !== v)) res.checks.enemyMismatch.push(`node ${nodes}: enemy battalion changed between battles`);
        for (const b of [e.battles.main, e.battles.flank]) {
          if (!b) continue;
          const ef = b.def.forces![1]!;
          const walk = (u: (typeof ef.units)[number]): void => {
            for (const m of u.members) if (enemyAfter!.get(m.personId) !== JSON.stringify(m)) res.checks.enemyMismatch.push(`node ${nodes}: enemy ${m.personId} not as his last battle left him`);
            u.subunits.forEach(walk);
          };
          ef.units.forEach(walk);
        }
      }
      enemyAfter = enemyMen(r);
      dupCheck(r);
      // The table.
      const planned = (p: number) => opBefore.planned[p]!;
      if (!op.endless) {
        const t = nextNode(rules.transitions, st.node, st.result, st.pos, opBefore.line.length, planned);
        if (st.end === undefined && (st.next?.node !== t.node || st.next?.pos !== t.pos)) res.checks.tableMismatch.push(`op ${op.index} node ${op.steps.length}: ${st.node} ${st.result} -> ${JSON.stringify(st.next)}, table ${t.node}@${t.pos}`);
        if (st.end === "success" && !t.success) res.checks.tableMismatch.push(`op ${op.index} node ${op.steps.length}: success not by the table`);
        if (st.end !== "success" && st.end !== undefined && t.success) res.checks.tableMismatch.push(`op ${op.index} node ${op.steps.length}: table success, end ${st.end}`);
      } else {
        const t = nextNode(rules.transitions, st.node, st.result, 0, null, () => "planned");
        if (t.node !== "planned" && st.next?.node !== t.node) res.checks.tableMismatch.push(`endless node ${op.steps.length}: ${st.node} ${st.result} -> ${st.next?.node}, table ${t.node}`);
      }
      // The row.
      const hist = r.history.slice(before.history.length);
      const lost = { player: { killed: 0, evacuated: 0, captured: 0, missing: 0 }, enemy: { killed: 0, evacuated: 0, captured: 0, missing: 0 } };
      for (const h of hist) for (const s of ["player", "enemy"] as const) { const m = h.men[s]; lost[s].killed += m.killed; lost[s].evacuated += m.evacuated; lost[s].captured += m.captured; lost[s].missing += m.missing; }
      const fired = { player: 0, enemy: 0 };
      for (const c of r.consumption.slice(before.consumption.length)) if (c.kind === "battle") fired[c.side] += sum(c.fired);
      const main = hist.find((h) => !h.flank);
      const sec = r.op!.sectors.find((x) => x.id === st.sector);
      const mf = e.battles.main?.def.forces, ff = e.battles.flank?.def.forces;
      res.rows.push({
        op: opBefore.index, node: opBefore.steps.length + 1, type: st.node, kind: rules.nodes[st.node]!.kind, pos: st.pos, sector: st.sector, result: st.result, walkover: st.walkover === true,
        flank: st.flank ? `${st.flank.node} ${st.flank.result}${st.flank.walkover ? " (walkover)" : ""}` : null,
        next: st.end ? `end ${st.end}` : `${st.next!.node}@${st.next!.pos}`,
        men: { player: mf ? menOf(mf[0]!.units) : 0, enemy: mf ? menOf(mf[1]!.units) : 0 }, flankMen: ff ? { player: menOf(ff[0]!.units), enemy: menOf(ff[1]!.units) } : null,
        durationS: main?.durationS ?? 0, wallS: wall, flankWallS: flankWall, endReason: main?.endReason ?? "walkover", lost, fired,
        craters: sec?.damage?.craters.length ?? 0, holes: sec?.damage?.breaches.length ?? 0, wrecks: sec?.wrecks?.length ?? 0,
      });
      log?.(`${o.faction} s${o.seed} op ${opBefore.index} node ${opBefore.steps.length + 1} ${st.node}@${st.pos} ${st.result}${st.walkover ? " walkover" : ""}${st.flank ? ` [flank ${st.flank.node} ${st.flank.result}]` : ""} -> ${st.end ? `END ${st.end}` : `${st.next!.node}@${st.next!.pos}`}; men ${res.rows.at(-1)!.men.player}/${res.rows.at(-1)!.men.enemy}; ${(main?.durationS ?? 0).toFixed(0)} s, wall ${wall.toFixed(0)}+${flankWall.toFixed(0)} s`);
      {
        const known = new Set(before.sides.player.pools.recovering.map((p) => p.record.personId));
        for (const p of r.sides.player.pools.recovering) if (!known.has(p.record.personId)) res.recoveryDays!.push(p.days ?? 0);
      }
      if (st.end) {
        snap(r);
        const P = r.sides.player;
        let row = 0;
        for (let i = op.steps.length - 1; i >= 0 && op.steps[i]!.result === "loss"; i--) row++;
        const survivors = membersOf(P.battalion).filter((m) => opStart.xp.has(m.personId)).map((m) => {
          const ent = (P.service[m.personId] ?? []).filter((x) => x.battle >= opStart.battles);
          return { gain: (m.skills["experience"] ?? 0) - opStart.xp.get(m.personId)!, fireMin: ent.reduce((n, x) => n + x.underFireMin, 0), battles: ent.length, xp: m.skills["experience"] ?? 0 };
        });
        res.opStats!.push({ index: opBefore.index, end: st.end, nodes: op.steps.length, able: ableShare(data, P), lossesInRow: row, rejoined: r.log.slice(opStart.log).filter((x) => x.kind === "rejoin" && x.side === "player").length, survivors });
      }
    } else {
      // A replenishment (endless) or an operation's end (replenished and the next operation).
      enemyAfter = null;
      const r = e.record;
      if (e.kind !== "operation-end" && lastNode) res.ableBeforeReplenish!.push(ableShare(data, (lastNode as CampaignRecord).sides.player));
      markStart(r);
      if (e.kind === "operation-end") {
        const s = r.operations!.at(-1)!;
        res.operations.push(s);
        res.replenishments.push({ afterNode: nodes, reason: `operation ${s.index} ${s.end}` });
        if (o.mode !== "operations") res.checks.replenishmentMisplaced.push(`after node ${nodes}: operation end in endless mode`);
        if (s.nodes < rules.minBattles || s.nodes > rules.maxBattles) res.checks.badOpLength.push(`operation ${s.index}: ${s.nodes} nodes, ${s.end}`);
      } else {
        const since = sinceRepl;
        res.replenishments.push({ afterNode: nodes, reason: `endless after ${since} nodes` });
        if (o.mode !== "endless") res.checks.replenishmentMisplaced.push(`after node ${nodes}: replenishment inside an operation`);
        else if (since !== rules.replenishEvery && (lastNode === null || proposeChoice(data, lastNode.sides.player).length > 0)) res.checks.replenishmentMisplaced.push(`after node ${nodes}: replenishment after ${since} nodes with an able platoon`);
        else if (since !== rules.replenishEvery) res.replenishments.at(-1)!.reason += " (early: no able platoon)";
      }
      sinceRepl = 0;
      dupCheck(r);
      log?.(`${o.faction} s${o.seed} replenishment after node ${nodes}: ${res.replenishments.at(-1)!.reason}; battalions ${membersOf(r.sides.player.battalion).length}/${membersOf(r.sides.enemy.battalion).length} men`);
    }
  });
  // Replenishments by the consumption log: only those the flow made.
  const repl = new Set(record.consumption.filter((c) => c.kind === "replenishment").map((c) => c.battle)).size;
  if (repl !== res.replenishments.length) res.checks.replenishmentMisplaced.push(`consumption log has ${repl} replenishments, the flow ${res.replenishments.length}`);
  snap(record);
  res.hash = hashRecord(record);
  res.wallS = (performance.now() - t0) / 1000;
  return res;
}

export type { OperationStep };

const pct = (a: number, b: number) => (b === 0 ? "-" : `${((100 * a) / b).toFixed(0)} %`);
function quant(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}

/** The batch report (markdown) of campaign parts (one or more factions). */
export function batchReport(parts: PartResult[], header: string): string {
  const out: string[] = [header, ""];
  const byFaction = new Map<string, PartResult[]>();
  for (const p of parts) { const k = `${p.opts.faction} vs ${p.opts.enemy} (${p.opts.mode})`; byFaction.set(k, [...(byFaction.get(k) ?? []), p]); }
  out.push("## Acceptance checks", "", "| campaigns | campaigns' record hashes | nodes | battles | zero-men battles | operations outside 3-5 nodes | table mismatches | sectors fought again (with craters / wrecks) | memory mismatches | enemy roster mismatches | misplaced replenishments | person ids twice |", "|---|---|---:|---:|---:|---|---:|---|---:|---:|---|---:|");
  for (const [k, ps] of byFaction) {
    const c = (f: (p: PartResult) => number) => ps.reduce((n, p) => n + f(p), 0);
    const battles = c((p) => p.rows.reduce((n, r) => n + (r.walkover ? 0 : 1) + (r.flankMen ? 1 : 0), 0));
    out.push(`| ${k} | ${ps.map((p) => `s${p.opts.seed} \`${p.hash}\``).join(", ")} | ${c((p) => p.rows.length)} | ${battles} | ${c((p) => p.checks.zeroMen)} | ${ps.flatMap((p) => p.checks.badOpLength).join("; ") || "0"} | ${c((p) => p.checks.tableMismatch.length)} | ${c((p) => p.checks.revisits)} (${c((p) => p.checks.revisitsWithCraters)} / ${c((p) => p.checks.revisitsWithWrecks)}) | ${c((p) => p.checks.revisitMismatch.length)} | ${c((p) => p.checks.enemyMismatch.length)} | ${ps.flatMap((p) => p.checks.replenishmentMisplaced).join("; ") || "0"} | ${c((p) => p.checks.duplicateIds.length)} |`);
  }
  const problems = parts.flatMap((p) => [...p.checks.tableMismatch, ...p.checks.revisitMismatch, ...p.checks.enemyMismatch.slice(0, 10), ...p.checks.duplicateIds.slice(0, 10)]);
  if (problems.length > 0) out.push("", "Problems:", "", ...problems.slice(0, 40).map((x) => `- ${x}`));
  for (const [k, ps] of byFaction) {
    const rows = ps.flatMap((p) => p.rows);
    const ops = ps.flatMap((p) => p.operations);
    out.push("", `## ${k}`, "");
    if (ops.length > 0) {
      const ends = new Map<string, number>();
      for (const o of ops) ends.set(o.end, (ends.get(o.end) ?? 0) + 1);
      const len = new Map<number, number>();
      for (const o of ops) len.set(o.nodes, (len.get(o.nodes) ?? 0) + 1);
      out.push(`Operations: ${ops.length}; success ${pct(ends.get("success") ?? 0, ops.length)} (${[...ends].sort().map(([e, n]) => `${e} ${n}`).join(", ")}); nodes per operation ${[...len].sort((a, b) => a[0] - b[0]).map(([l, n]) => `${l}: ${n}`).join(", ")}; battles per operation (with flank battles) mean ${(ops.reduce((n, o) => n + o.battles, 0) / ops.length).toFixed(2)}, ${Math.min(...ops.map((o) => o.battles))}-${Math.max(...ops.map((o) => o.battles))}.`, "");
    }
    const res = new Map<string, Record<string, number>>();
    for (const r of rows) { const m = (res.get(r.type) ?? {}); m[r.result] = (m[r.result] ?? 0) + 1; res.set(r.type, m); }
    out.push("Results by node type (the player's): " + [...res].sort().map(([t, m]) => `${t} ${m["win"] ?? 0}-${m["draw"] ?? 0}-${m["loss"] ?? 0}`).join(", ") + " (win-draw-loss).", "");
    const walk = rows.filter((r) => r.walkover).length, flanks = rows.filter((r) => r.flankMen).length;
    const lost = (s: CampaignSide, k: "killed" | "evacuated" | "captured" | "missing") => rows.reduce((n, r) => n + r.lost[s][k], 0);
    const fought = rows.filter((r) => !r.walkover);
    out.push(`Nodes ${rows.length} (walkovers ${walk}), flank battles ${flanks}. Men per main battle: player mean ${(fought.reduce((n, r) => n + r.men.player, 0) / Math.max(1, fought.length)).toFixed(0)}, enemy ${(fought.reduce((n, r) => n + r.men.enemy, 0) / Math.max(1, fought.length)).toFixed(0)} (min ${Math.min(...fought.map((r) => Math.min(r.men.player, r.men.enemy)))}).`, "");
    out.push("| side | killed | evacuated | captured | missing | rounds fired per battle |", "|---|---:|---:|---:|---:|---:|");
    const nb = Math.max(1, fought.length + flanks);
    for (const s of ["player", "enemy"] as const) out.push(`| ${s} | ${lost(s, "killed")} | ${lost(s, "evacuated")} | ${lost(s, "captured")} | ${lost(s, "missing")} | ${(rows.reduce((n, r) => n + r.fired[s], 0) / nb).toFixed(0)} |`);
    const ends = ps.map((p) => p.snapshots.filter((x) => x.side === "player").at(-1)!);
    const xp = ends.flatMap((x) => x.xp);
    const allSnaps = ps.flatMap((p) => p.snapshots.filter((x) => x.side === "player"));
    out.push("", `Player battalion at the end (per campaign): men ${ends.map((x) => x.men).join(", ")}; recovering ${ends.map((x) => x.recovering).join(", ")} (mean at operation ends ${(allSnaps.reduce((n, x) => n + x.recovering, 0) / Math.max(1, allSnaps.length)).toFixed(1)}); dead ${ends.map((x) => x.dead).join(", ")}; held by the enemy ${ends.map((x) => x.held).join(", ")}.`);
    out.push(`Experience of the player's men at the end: p10 ${quant(xp, 0.1).toFixed(3)}, median ${quant(xp, 0.5).toFixed(3)}, p90 ${quant(xp, 0.9).toFixed(3)}, max ${Math.max(0, ...xp).toFixed(3)}.`);
    // M12.4 tuning lines.
    const st = ps.flatMap((p) => p.opStats ?? []);
    if (st.length > 0) {
      const gq = (xs: { gain: number }[]) => { const g = xs.map((x) => x.gain); return `(${g.length}): gain p10 ${quant(g, 0.1).toFixed(3)}, median ${quant(g, 0.5).toFixed(3)}, p90 ${quant(g, 0.9).toFixed(3)}, max ${Math.max(0, ...g).toFixed(3)}`; };
      // A full operation: every node (the fittest company fights, so few men fight all of them); also 3 battles or more.
      const full = st.flatMap((o) => o.survivors.filter((x) => x.battles >= o.nodes && x.fireMin >= 1));
      const three = st.flatMap((o) => o.survivors.filter((x) => x.battles >= 3 && x.fireMin >= 1));
      out.push(`Experience over an operation: survivors under fire who fought every node ${gq(full)}; 3 battles or more ${gq(three)}; every survivor ${gq(st.flatMap((o) => o.survivors))}; highest experience ${Math.max(0, ...st.flatMap((o) => o.survivors.map((x) => x.xp))).toFixed(3)}.`);
      const fails = st.filter((o) => o.end === "failure");
      const able = st.map((o) => o.able);
      out.push(`Able share at operation ends: min ${Math.min(...able).toFixed(2)}, p10 ${quant(able, 0.1).toFixed(2)}, median ${quant(able, 0.5).toFixed(2)}; failures ${fails.length}: two losses in a row ${fails.filter((o) => o.lossesInRow >= 2).length}, below the combat-ineffective line only ${fails.filter((o) => o.lossesInRow < 2).length}. Men back from recovery inside operations: ${st.reduce((n, o) => n + o.rejoined, 0)}.`);
    }
    const rd = ps.flatMap((p) => p.recoveryDays ?? []);
    if (rd.length > 0) out.push(`Recovery days of the player's evacuated (${rd.length}): p10 ${quant(rd, 0.1).toFixed(1)}, median ${quant(rd, 0.5).toFixed(1)}, p90 ${quant(rd, 0.9).toFixed(1)}; within 2.5 days ${pct(rd.filter((d) => d <= 2.5).length, rd.length)}, within 7 days ${pct(rd.filter((d) => d <= 7).length, rd.length)}, within 30 days ${pct(rd.filter((d) => d <= 30).length, rd.length)}.`);
    const ab = ps.flatMap((p) => p.ableBeforeReplenish ?? []);
    if (ab.length > 0) out.push(`Able share before endless replenishments (${ab.length}): min ${Math.min(...ab).toFixed(2)}, median ${quant(ab, 0.5).toFixed(2)}.`);
    const wall = rows.filter((r) => !r.walkover).map((r) => r.wallS), fw = rows.filter((r) => r.flankMen).map((r) => r.flankWallS);
    const dur = fought.map((r) => r.durationS);
    out.push(`Time per battle: main battles ${dur.length > 0 ? `${quant(dur, 0.5).toFixed(0)} s median battle time, ` : ""}wall median ${quant(wall, 0.5).toFixed(0)} s (max ${Math.max(0, ...wall).toFixed(0)}); flank battles wall median ${quant(fw, 0.5).toFixed(0)} s; whole campaigns ${ps.map((p) => `${(p.wallS / 60).toFixed(0)} min`).join(", ")}.`);
    const reasons = new Map<string, number>();
    for (const r of fought) reasons.set(r.endReason, (reasons.get(r.endReason) ?? 0) + 1);
    out.push(`Main battles ended by: ${[...reasons].sort().map(([e, n]) => `${e} ${n}`).join(", ")}.`, "");
    out.push("<details><summary>Every node</summary>", "", "| op | node | type | pos | sector | result | flank | next | men P/E | flank men | s | wall s | lost P (k/ev/cap) | lost E | sector c/h/w after |", "|---:|---:|---|---:|---:|---|---|---|---|---|---:|---:|---|---|---|");
    for (const p of ps) for (const r of p.rows) out.push(`| ${p.opts.seed}/${r.op} | ${r.node} | ${r.type} | ${r.pos} | ${r.sector} | ${r.result}${r.walkover ? " (walkover)" : ""} | ${r.flank ?? ""} | ${r.next} | ${r.men.player}/${r.men.enemy} | ${r.flankMen ? `${r.flankMen.player}/${r.flankMen.enemy}` : ""} | ${r.durationS.toFixed(0)} | ${r.wallS.toFixed(0)}${r.flankMen ? `+${r.flankWallS.toFixed(0)}` : ""} | ${r.lost.player.killed}/${r.lost.player.evacuated}/${r.lost.player.captured} | ${r.lost.enemy.killed}/${r.lost.enemy.evacuated}/${r.lost.enemy.captured} | ${r.craters}/${r.holes}/${r.wrecks} |`);
    out.push("", "</details>");
  }
  return out.join("\n") + "\n";
}
