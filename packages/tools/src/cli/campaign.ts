/**
 * Campaign tools (M12).
 *   npm run campaign -- chain --faction de|ru|xf [--enemy f] [--battles 10] [--seed 1] [--seconds 600] [--carriers tracked|wheeled]
 *     M12.1a: a campaign of `--battles` battles (attack, defence with counter-attack, meeting, ambush, withdrawal in turn,
 *     each on a new map), one company's worth per side, AI on both sides, the rules between battles and a replenishment
 *     after every operation (core/campaign.json `operation.battles`, 5). Writes reports/campaign-<faction>-<stamp>.md
 *     and the final record as a campaign save (.json, M12.1b: `CampaignSave`, slot "chain"); prints the record hash.
 *     `--from <save.json>` (M12.1b): go on from a save (this command's .json, an exported slot, or a version-1 record:
 *     migrated and ids repaired, with what was changed printed) until `--battles` battles in all; faction, enemy and
 *     seed come from the save.
 *   npm run campaign -- sector --faction de [--enemy ru] [--battles 2] [--seed 1] [--map village] [--seconds 900]
 *     [--attacker blue|red] [--on-foot]
 *     M12.0a: battles on one map, each with both sides as the last left them (roster records out -> in) and the map's
 *     damage and wrecks; AI on both sides.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { continueCampaignChain, exportSave, hashRecord, makeSave, newCampaign, readSave, runChain, type CampaignRecord } from "@tcs/campaign";
import type { CarrierClass, MapKind } from "@tcs/scenario";
import { parseArgs } from "../args";
import { aiRunner, enemyOf } from "../campaign";
import { chainReport, stepRow, type ChainStepRow } from "../campaign-report";
import { loadData, ON_POSTS } from "../scenarios";
import { batchReport, runCampaignPart, type PartOptions, type PartResult } from "../campaign-batch";

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
if (cmd === "batch" || cmd === "batch-part") {
  await runBatch(cmd, args);
  process.exit(0);
}
if (cmd !== "chain" && cmd !== "sector") {
  console.error("usage: npm run campaign -- batch [--faction de,ru] [--operations 50] [--mode operations|endless] [--battles 30] [--seed n] [--seconds 600] [--campaigns 1] [--jobs 1]\n" +
    "       npm run campaign -- chain --faction de|ru|xf [--enemy f] [--battles 10] [--seed n] [--seconds 600] [--carriers tracked|wheeled] [--from save.json]\n" +
    "       npm run campaign -- sector --faction de|ru|xf [--enemy f] [--battles n] [--seed n] [--map kind] [--seconds s] [--attacker blue|red] [--on-foot]");
  process.exit(1);
}
// --from: the save's text (its factions decide whether the fixture faction is loaded).
const fromText = args["from"] !== undefined ? readFileSync(args["from"], "utf8") : null;
const fromSides = fromText !== null ? (JSON.parse(fromText) as { record?: CampaignRecord } & Partial<CampaignRecord>) : null;
const fromRec = fromSides ? (fromSides.record ?? fromSides as CampaignRecord) : null;
const faction = fromRec?.sides.player.faction ?? args["faction"] ?? "de";
const data = loadData(faction === "xf" || (fromRec?.sides.enemy.faction ?? args["enemy"]) === "xf");
if (!data.factions[faction]) throw new Error(`unknown faction '${faction}'`);
const enemy = fromRec?.sides.enemy.faction ?? args["enemy"] ?? enemyOf(data, faction);
const seed = fromRec?.seed ?? Number(args["seed"] ?? 1);

if (cmd === "chain") {
  const battles = Number(args["battles"] ?? 10), seconds = Number(args["seconds"] ?? 600);
  const carriers = fromRec?.sides.player.carriers ?? (args["carriers"] === "wheeled" ? "wheeled" : "tracked") as CarrierClass;
  const opts = { seed, faction, enemy, carriers, ...(fromRec ? { enemyCarriers: fromRec.sides.enemy.carriers } : {}), battles, seconds };
  let start: CampaignRecord;
  if (fromText !== null) {
    const loaded = readSave(data, fromText);
    start = loaded.save.record;
    console.log(`From ${args["from"]}: version ${loaded.fromVersion}, slot '${loaded.save.slotName}', ${start.battles} battles fought; record hash ${hashRecord(start)}`);
    for (const w of loaded.warnings) console.log(`  warning: ${w}`);
    for (const r of loaded.repairs) console.log(`  repaired: ${r.side} ${r.kind} ${r.where}${r.from !== undefined ? ` ${r.from}` : ""}${r.to !== undefined ? ` -> ${r.to}` : ""}`);
  } else start = newCampaign(data, opts);
  console.log(`Campaign chain: ${battles} battles, ${faction} (player, blue) against ${enemy}, ${carriers}, seed ${seed}, ${seconds} s each`);
  const rows: ChainStepRow[] = [];
  let t = performance.now();
  const out = continueCampaignChain(data, start, {
    ...opts, timeLimitSeconds: seconds, hooks: ON_POSTS,
    onStep: (record, step) => {
      const now = performance.now();
      const row = stepRow(record, step.kind, (now - t) / 1000);
      t = now;
      rows.push(row);
      const a = row.sides.player, b = row.sides.enemy;
      console.log(step.kind === "battle"
        ? `battle ${row.battle} ${row.kind} (${row.map}): ${row.winner}, ${row.end}, ${row.durationS.toFixed(0)} s; player ${a.inBattle}; enemy ${b.inBattle}; battalions ${a.men}/${b.men} men; ${row.wallS.toFixed(0)} s wall`
        : `replenishment after battle ${row.battle}: battalions ${a.men}/${b.men} men, recovering ${a.recovering}/${b.recovering}, unassigned ${a.unassigned}/${b.unassigned}`);
    },
  }, aiRunner);
  const hash = hashRecord(out.record);
  console.log(`End: ${out.end}; record hash ${hash}`);
  const dir = fileURLToPath(new URL("../../../../reports", import.meta.url));
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = join(dir, `campaign-${faction}-s${seed}-${stamp}`);
  writeFileSync(`${base}.md`, chainReport(data, opts, out.record, rows));
  writeFileSync(`${base}.json`, exportSave(makeSave(data, out.record, "chain", new Date().toISOString())));
  console.log(`Wrote ${base}.md and .json`);
} else {
  const battles = Number(args["battles"] ?? 2), seconds = Number(args["seconds"] ?? 900);
  const attacker = args["attacker"] === "red" ? "red" : "blue";
  console.log(`Sector chain: ${battles} battles, ${faction} (blue) against ${enemy} (red), ${attacker} attacking, map ${args["map"] ?? "village"} seed ${seed}, ${seconds} s each`);
  const wall: number[] = [];
  const chain = runChain(data, {
    factions: [faction, enemy], battles, seed, attacker, timeLimitSeconds: seconds, vehicles: args["on-foot"] === undefined,
    ...(args["map"] ? { mapKind: args["map"] as MapKind } : {}), hooks: ON_POSTS,
  }, (input, opts) => { const t0 = performance.now(); const r = aiRunner(input, opts); wall.push(performance.now() - t0); return r; });
  for (const b of chain.battles) {
    const ms = wall[b.index] ?? 0;
    const r = b.result, d = b.input.damage, w = b.input.wrecksIn ?? [];
    console.log(`\nBattle ${b.index + 1}: ${r.durationSeconds.toFixed(0)} s, end ${r.endReason}, winner ${r.winner ?? "none"}  (in: ${d?.craters.length ?? 0} craters, ${d?.breaches.length ?? 0} holes, ${d?.positions?.length ?? 0} positions, ${w.length} wrecks)`);
    for (const s of r.sides) {
      const v = s.vehicles;
      console.log(`  ${s.side.padEnd(5)} ${s.faction.padEnd(3)} men ${s.soldiersStart}: fit ${s.soldiersFit}, wounded ${s.wounded} (evacuated ${s.evacuated ?? 0}), killed ${s.killed}, captured ${s.captured}` + (v ? `; hulls ${v.start}: ok ${v.ok}, destroyed ${v.destroyed}, immobilised ${v.immobilised}` : ""));
    }
    const sv = Object.values(r.service ?? {});
    const under = sv.filter((x) => x.underFireS > 0).length;
    console.log(`  service: ${sv.length} men, ${under} under effective fire, ${sv.reduce((n, x) => n + x.roundsFired, 0)} rounds fired; out: ${r.damageOut?.craters.length ?? 0} craters, ${r.damageOut?.breaches.length ?? 0} holes, ${r.wrecks?.length ?? 0} wrecks`);
    if (b.next) console.log(`  next: blue fields ${b.next.forces[0].units.length} units / ${b.next.forces[0].vehicles?.length ?? 0} hulls, red ${b.next.forces[1].units.length} / ${b.next.forces[1].vehicles?.length ?? 0}`);
    console.log(`  wall time ${(ms / 1000).toFixed(1)} s (${(r.durationSeconds / Math.max(ms / 1000, 1e-3)).toFixed(0)}x real time)`);
  }
  console.log(`\nEnd: ${chain.end}`);
}

/**
 * `batch` (M12.2): per faction (`--faction`, a list) `--campaigns` campaigns (seeds `seed * 100 + c`) sharing the
 * `--operations` (operations mode) or each fighting `--battles` nodes (endless), AI on both sides, `--jobs` campaigns
 * at a time in child processes (`batch-part`, one campaign, its result as JSON to `--out`). Writes
 * reports/campaign-batch-<mode>-<stamp>.md and prints each campaign's record hash (the batch is reproducible from
 * `--seed`: the same hashes again).
 */
async function runBatch(which: string, a: Record<string, string>): Promise<void> {
  if (which === "batch-part") {
    const o = JSON.parse(a["opts"]!) as PartOptions;
    const d = loadData(o.faction === "xf" || o.enemy === "xf");
    const r = runCampaignPart(d, o, aiRunner, (line) => console.log(line));
    writeFileSync(a["out"]!, JSON.stringify(r));
    return;
  }
  if (a["merge"] !== undefined) {
    // Merge part results written by `batch-part --out` (parts run apart, e.g. detached in the background).
    const results = a["merge"].split(",").map((f) => JSON.parse(readFileSync(f, "utf8")) as PartResult);
    const m = results[0]!.opts;
    const dir = fileURLToPath(new URL("../../../../reports", import.meta.url));
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const factionsM = [...new Set(results.map((r) => r.opts.faction))];
    const total = m.mode === "endless" ? m.count : results.reduce((n, r) => n + r.opts.count, 0) / factionsM.length;
    const header = `# Campaign batch: ${m.mode}, ${m.mode === "endless" ? `${m.count} nodes per campaign` : `${total} operations per faction`}\n\nM12.2 (plan m12-roster 4.5). AI on both sides (the player's side auto-resolved with the proposed choice), ${m.seconds} s battles; parts ${results.map((r) => `${r.opts.faction} s${r.opts.seed} x${r.opts.count}`).join(", ")} run as \`npm run campaign -- batch-part --opts <json> --out <file>\` and merged with \`batch --merge\`.`;
    const file = join(dir, `campaign-batch-${m.mode}-${stamp}.md`);
    writeFileSync(file, batchReport(results, header));
    console.log(`Wrote ${file}`);
    for (const r of results) console.log(`${r.opts.faction} s${r.opts.seed}: record hash ${r.hash}`);
    return;
  }
  const factions = (a["faction"] ?? "de,ru").split(",");
  const mode = a["mode"] === "endless" ? "endless" : "operations";
  const total = mode === "endless" ? Number(a["battles"] ?? 30) : Number(a["operations"] ?? 50);
  const campaigns = Number(a["campaigns"] ?? 1), jobs = Number(a["jobs"] ?? 1), seed0 = Number(a["seed"] ?? 1), seconds = Number(a["seconds"] ?? 600);
  const d = loadData(factions.includes("xf"));
  const parts: PartOptions[] = [];
  for (const f of factions) {
    const enemy = a["enemy"] ?? enemyOf(d, f);
    for (let c = 0; c < campaigns; c++) {
      const count = mode === "endless" ? total : Math.floor(total / campaigns) + (c < total % campaigns ? 1 : 0);
      if (count > 0) parts.push({ faction: f, enemy, carriers: a["carriers"] === "wheeled" ? "wheeled" : "tracked", seed: seed0 * 100 + c, mode, count, seconds });
    }
  }
  const dir = fileURLToPath(new URL("../../../../reports", import.meta.url));
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  console.log(`Campaign batch (${mode}): ${parts.map((p) => `${p.faction} vs ${p.enemy} s${p.seed} x${p.count}`).join(", ")}; ${seconds} s battles; ${jobs} at a time`);
  const results: PartResult[] = new Array(parts.length);
  const t0 = performance.now();
  if (jobs <= 1) {
    parts.forEach((p, i) => { results[i] = runCampaignPart(d, p, aiRunner, (line) => console.log(line)); console.log(`${p.faction} s${p.seed}: record hash ${results[i]!.hash}`); });
  } else {
    let next = 0;
    const runOne = async (): Promise<void> => {
      while (next < parts.length) {
        const i = next++;
        const p = parts[i]!;
        const out = join(dir, `.campaign-part-${stamp}-${i}.json`);
        await new Promise<void>((res, rej) => {
          const ch = spawn(process.execPath, [...process.execArgv, process.argv[1]!, "batch-part", "--opts", JSON.stringify(p), "--out", out], { stdio: ["ignore", "inherit", "inherit"] });
          ch.on("exit", (code) => (code === 0 ? res() : rej(new Error(`part ${i} (${p.faction} s${p.seed}) exited ${code}`))));
        });
        results[i] = JSON.parse(readFileSync(out, "utf8")) as PartResult;
        console.log(`${p.faction} s${p.seed}: record hash ${results[i]!.hash}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(jobs, parts.length) }, runOne));
  }
  const header = `# Campaign batch: ${mode}, ${mode === "endless" ? `${total} nodes per campaign` : `${total} operations per faction`}, seed ${seed0}\n\nM12.2 (plan m12-roster 4.5). AI on both sides (the player's side auto-resolved with the proposed choice), ${seconds} s battles, ${campaigns} campaign(s) per faction, ${((performance.now() - t0) / 60000).toFixed(0)} min wall with ${jobs} at a time. \`npm run campaign -- batch ${process.argv.slice(3).join(" ")}\`.`;
  const file = join(dir, `campaign-batch-${mode}-s${seed0}-${stamp}.md`);
  writeFileSync(file, batchReport(results, header));
  writeFileSync(file.replace(/\.md$/, ".json"), JSON.stringify(results.map((r) => ({ opts: r.opts, hash: r.hash, checks: r.checks, operations: r.operations, replenishments: r.replenishments }))));
  console.log(`Wrote ${file}`);
  const bad = results.reduce((n, r) => n + r.checks.zeroMen + r.checks.tableMismatch.length + r.checks.revisitMismatch.length + r.checks.enemyMismatch.length + r.checks.replenishmentMisplaced.length + r.checks.badOpLength.length + r.checks.duplicateIds.length, 0);
  console.log(bad === 0 ? "All checks passed." : `CHECKS FAILED: ${bad}`);
}
