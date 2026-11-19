/**
 * The campaign chain's report (M12.1a): per battle and replenishment the battalions' strength, experience, pools,
 * hulls and the consumption log; the books (start + delivered - battles' net - written off = now, per item); the
 * record hash.
 */
import type { DataSet } from "@tcs/data";
import {
  addHoldings, bookedChange, campaignCatalog, forceHoldings, hashRecord, holdingsDiff, membersOf, newCampaign,
  type CampaignForce, type CampaignRecord, type CampaignSide, type NewCampaignOptions,
} from "@tcs/campaign";

export interface ChainStepRow {
  step: string; battle: number; kind: string; map: string; winner: string; end: string; durationS: number; wallS: number;
  sides: Record<CampaignSide, { men: number; inBattle: string; recovering: number; dead: number; held: number; missing: number; unassigned: number; xpMean: number; xpMax: number; hulls: string; fired: number; underFire: number }>;
}

const sum = (r: Record<string, number> | undefined) => Object.values(r ?? {}).reduce((a, b) => a + b, 0);

export function stepRow(record: CampaignRecord, step: "battle" | "replenishment", wallS: number): ChainStepRow {
  const h = record.history.at(-1);
  const side = (s: CampaignSide) => {
    const f: CampaignForce = record.sides[s];
    const men = membersOf(f.battalion);
    const xp = men.map((m) => m.skills["experience"] ?? 0);
    const m = h?.men[s];
    const c = step === "battle" ? record.consumption.filter((x) => x.battle === h?.index && x.side === s && x.kind === "battle")[0] : undefined;
    const under = step === "battle" ? Object.values(f.service).filter((e) => e.at(-1)?.battle === h?.index && (e.at(-1)?.underFireMin ?? 0) > 0).length : 0;
    return {
      men: men.length, inBattle: m && step === "battle" ? `${m.in}: ${m.able} able, ${m.killed} k, ${m.evacuated} ev, ${m.captured} cap` : "",
      recovering: f.pools.recovering.length, dead: f.pools.dead.length, held: f.pools.heldByEnemy.length, missing: f.pools.missing.length, unassigned: f.pools.unassigned.length,
      xpMean: xp.reduce((a, b) => a + b, 0) / Math.max(1, xp.length), xpMax: Math.max(0, ...xp),
      hulls: `${f.vehicles.length}/${f.workshop.length}/${f.lostHulls.length}`, fired: sum(c?.fired), underFire: under,
    };
  };
  return {
    step, battle: record.battles, kind: step === "battle" ? h?.kind ?? "" : "replenishment", map: step === "battle" ? h?.mapKind ?? "" : "",
    winner: step === "battle" ? h?.winner ?? "draw" : "", end: step === "battle" ? h?.endReason ?? "" : "", durationS: step === "battle" ? h?.durationS ?? 0 : 0, wallS,
    sides: { player: side("player"), enemy: side("enemy") },
  };
}

export function chainReport(data: DataSet, opts: NewCampaignOptions & { battles: number; seconds: number }, record: CampaignRecord, rows: ChainStepRow[]): string {
  const start = newCampaign(data, opts);
  const cat = campaignCatalog(data, record);
  const books = (["player", "enemy"] as const).map((s) => {
    const leaks = holdingsDiff(forceHoldings(cat, record.sides[s]), addHoldings(forceHoldings(cat, start.sides[s]), bookedChange(record, s)));
    const del = record.consumption.filter((c) => c.side === s && c.kind === "replenishment").reduce((n, c) => n + sum(c.delivered?.ammo), 0);
    const net = record.consumption.filter((c) => c.side === s && c.kind === "battle").reduce((n, c) => n + sum(c.net?.ammo), 0);
    const off = record.consumption.filter((c) => c.side === s && c.kind === "battle").reduce((n, c) => n + sum(c.writtenOff?.ammo), 0);
    const fired = record.consumption.filter((c) => c.side === s && c.kind === "battle").reduce((n, c) => n + sum(c.fired), 0);
    return `| ${s} | ${sum(forceHoldings(cat, start.sides[s]).ammo)} | ${del} | ${net} | ${fired} | ${off} | ${sum(forceHoldings(cat, record.sides[s]).ammo)} | ${Object.keys(leaks).length === 0 ? "exact" : JSON.stringify(leaks)} |`;
  });
  const leaders = record.log.filter((l) => l.kind === "leader");
  const repl = record.log.filter((l) => l.kind === "replacement");
  const rejoin = record.log.filter((l) => l.kind === "rejoin");
  const p = (s: CampaignSide) => (r: ChainStepRow) => r.sides[s];
  const line = (r: ChainStepRow) => {
    const a = p("player")(r), b = p("enemy")(r);
    return `| ${r.battle} | ${r.kind} | ${r.map} | ${r.winner} | ${r.end} | ${r.durationS.toFixed(0)} | ${a.inBattle} | ${b.inBattle} | ${a.men}/${b.men} | ${a.recovering}/${b.recovering} | ${a.dead}/${b.dead} | ${a.held}/${b.held} | ${a.unassigned}/${b.unassigned} | ${a.xpMean.toFixed(3)} (${a.xpMax.toFixed(2)}) / ${b.xpMean.toFixed(3)} (${b.xpMax.toFixed(2)}) | ${a.underFire}/${b.underFire} | ${a.fired}/${b.fired} | ${a.hulls} / ${b.hulls} | ${r.wallS.toFixed(0)} |`;
  };
  return [
    `# Campaign chain: ${opts.faction} (player) against ${opts.enemy}, ${opts.battles} battles, seed ${opts.seed}`,
    "",
    `M12.1a (plan m12-roster 4.3). Battles of ${opts.seconds} s, AI on both sides, one company's worth per side, a replenishment after every ${data.campaign?.campaign.operation.battles} battles. Record hash \`${hashRecord(record)}\`.`,
    "",
    "Per step: men in the battle (player, enemy), the battalions' men with their units, pools (recovering, dead, held by the enemy, unassigned), experience mean (max) of the men with their units, men under effective fire, rounds fired, hulls in service / workshop / lost, wall time (s).",
    "",
    "| battle | kind | map | winner | end | s | player in | enemy in | men P/E | recovering | dead | held | unassigned | experience P / E | under fire | fired | hulls P / E | wall s |",
    "|---:|---|---|---|---|---:|---|---|---|---|---|---|---|---|---|---|---|---:|",
    ...rows.map(line),
    "",
    "## Books (rounds, all ammunition ids together; exact per id when the last column says so)",
    "",
    "| side | start | delivered at replenishment | battles' net | fired (events) | written off | now | start + delivered - net - written off = now |",
    "|---|---:|---:|---:|---:|---:|---:|---|",
    ...books,
    "",
    `Leaders appointed: ${leaders.length} (player ${leaders.filter((l) => l.side === "player").length}); men rejoining: ${rejoin.length}; green replacements: ${repl.length} (player ${repl.filter((l) => l.side === "player").length}).`,
    "",
  ].join("\n");
}
