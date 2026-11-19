/**
 * Campaign tools (M12).
 *   npm run campaign -- chain --faction de|ru|xf [--enemy f] [--battles 10] [--seed 1] [--seconds 600] [--carriers tracked|wheeled]
 *     M12.1a: a campaign of `--battles` battles (attack, defence with counter-attack, meeting, ambush, withdrawal in turn,
 *     each on a new map), one company's worth per side, AI on both sides, the rules between battles and a replenishment
 *     after every operation (core/campaign.json `operation.battles`, 5). Writes reports/campaign-<faction>-<stamp>.md
 *     and the final record (.json); prints the record hash.
 *   npm run campaign -- sector --faction de [--enemy ru] [--battles 2] [--seed 1] [--map village] [--seconds 900]
 *     [--attacker blue|red] [--on-foot]
 *     M12.0a: battles on one map, each with both sides as the last left them (roster records out -> in) and the map's
 *     damage and wrecks; AI on both sides.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashRecord, runCampaignChain, runChain } from "@tcs/campaign";
import type { CarrierClass, MapKind } from "@tcs/scenario";
import { parseArgs } from "../args";
import { aiRunner, enemyOf } from "../campaign";
import { chainReport, stepRow, type ChainStepRow } from "../campaign-report";
import { loadData, ON_POSTS } from "../scenarios";

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
if (cmd !== "chain" && cmd !== "sector") {
  console.error("usage: npm run campaign -- chain --faction de|ru|xf [--enemy f] [--battles 10] [--seed n] [--seconds 600] [--carriers tracked|wheeled]\n" +
    "       npm run campaign -- sector --faction de|ru|xf [--enemy f] [--battles n] [--seed n] [--map kind] [--seconds s] [--attacker blue|red] [--on-foot]");
  process.exit(1);
}
const faction = args["faction"] ?? "de";
const data = loadData(faction === "xf" || args["enemy"] === "xf");
if (!data.factions[faction]) throw new Error(`unknown faction '${faction}'`);
const enemy = args["enemy"] ?? enemyOf(data, faction);
const seed = Number(args["seed"] ?? 1);

if (cmd === "chain") {
  const battles = Number(args["battles"] ?? 10), seconds = Number(args["seconds"] ?? 600);
  const carriers = (args["carriers"] === "wheeled" ? "wheeled" : "tracked") as CarrierClass;
  const opts = { seed, faction, enemy, carriers, battles, seconds };
  console.log(`Campaign chain: ${battles} battles, ${faction} (player, blue) against ${enemy}, ${carriers}, seed ${seed}, ${seconds} s each`);
  const rows: ChainStepRow[] = [];
  let t = performance.now();
  const out = runCampaignChain(data, {
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
  writeFileSync(`${base}.json`, JSON.stringify(out.record));
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
