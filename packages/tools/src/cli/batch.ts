/**
 * Batch runner: runs a scenario with many seeds and writes a report to reports/.
 *   npm run batch -- --scenario demo --runs 200 --seconds 120
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBattle } from "@tcs/sim";
import { parseArgs } from "../args";
import { getScenario, loadData } from "../scenarios";

const args = parseArgs(process.argv.slice(2));
const name = args["scenario"] ?? "demo";
const runs = Number(args["runs"] ?? 100);
const seconds = Number(args["seconds"] ?? 120);
const firstSeed = Number(args["seed"] ?? 1);
const sc = getScenario(name);
const data = loadData(sc.fixtures ?? false);

interface Row { seed: number; durationS: number; endReason: string; orders: number; hash: string; casualties: Record<string, number>; wallMs: number; winner: string | null; scores: Record<string, number> }
const rows: Row[] = [];
const t0 = performance.now();
for (let i = 0; i < runs; i++) {
  const seed = firstSeed + i;
  const input = sc.build(data, seed, seconds);
  const s0 = performance.now();
  const r = runBattle(input, { controllers: sc.controllers?.(input) ?? [] });
  rows.push({
    seed, durationS: r.durationSeconds, endReason: r.endReason, orders: r.orders.length, hash: r.finalStateHash,
    casualties: Object.fromEntries(r.sides.map((s) => [s.side, s.wounded + s.killed])),
    wallMs: performance.now() - s0,
    winner: r.winner, scores: Object.fromEntries(r.scores.map((s) => [s.side, s.score])),
  });
}
const totalMs = performance.now() - t0;
const uniqueHashes = new Set(rows.map((r) => r.hash)).size;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const ends: Record<string, number> = {};
for (const r of rows) ends[r.endReason] = (ends[r.endReason] ?? 0) + 1;

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = fileURLToPath(new URL("../../../../reports", import.meta.url));
mkdirSync(dir, { recursive: true });
const md = [
  `# Batch report: ${name}`,
  "",
  `${sc.description}`,
  "",
  `- Runs: ${runs} (seeds ${firstSeed}..${firstSeed + runs - 1}), ${seconds} s game time each`,
  `- Wall time: ${(totalMs / 1000).toFixed(1)} s total, mean ${mean(rows.map((r) => r.wallMs)).toFixed(1)} ms per battle`,
  `- Speed: ${((runs * seconds) / (totalMs / 1000)).toFixed(0)}x real time`,
  `- Distinct final states: ${uniqueHashes} of ${runs}`,
  `- End reasons: ${Object.entries(ends).map(([k, v]) => `${k} ${v}`).join(", ")}`,
  `- Mean orders per battle: ${mean(rows.map((r) => r.orders)).toFixed(1)}`,
  `- Mean casualties per side: ${["blue", "red"].map((s) => `${s} ${mean(rows.map((r) => r.casualties[s] ?? 0)).toFixed(2)}`).join(", ")}`,
  "",
  `- Winners: ${["blue", "red"].map((w) => `${w} ${rows.filter((r) => r.winner === w).length}`).join(", ")}, draw ${rows.filter((r) => r.winner === null).length}; mean score ${["blue", "red"].map((s) => `${s} ${mean(rows.map((r) => r.scores[s] ?? 0)).toFixed(1)}`).join(", ")}`,
  "(Winner and score: objectives held at the end minus men down, M6; without objectives every battle is a draw.)",
  "",
  "| seed | duration s | end | winner | score blue/red | orders | casualties blue/red | hash |",
  "|---:|---:|---|---|---|---:|---|---|",
  ...rows.slice(0, 20).map((r) => `| ${r.seed} | ${r.durationS.toFixed(0)} | ${r.endReason} | ${r.winner ?? "draw"} | ${r.scores["blue"] ?? 0}/${r.scores["red"] ?? 0} | ${r.orders} | ${r.casualties["blue"] ?? 0}/${r.casualties["red"] ?? 0} | \`${r.hash}\` |`),
  rows.length > 20 ? `\n(first 20 of ${rows.length} rows; all rows in the JSON file)` : "",
].join("\n");
const base = join(dir, `batch-${name}-${stamp}`);
writeFileSync(`${base}.md`, md + "\n");
writeFileSync(`${base}.json`, JSON.stringify({ name, runs, seconds, rows }, null, 2));
console.log(md.split("\n").slice(0, 12).join("\n"));
console.log(`\nWrote ${base}.md and .json`);
