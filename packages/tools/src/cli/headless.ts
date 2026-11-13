/**
 * Headless runner: runs one battle as fast as possible and prints the result.
 *   npm run headless -- --scenario demo --seed 1 --seconds 120 [--orders file.json] [--no-ai] [--events]
 */
import { readFileSync } from "node:fs";
import { runBattle, stripInteriors, type Order, type SimEvent } from "@tcs/sim";
import { parseArgs } from "../args";
import { getScenario, loadData } from "../scenarios";

const args = parseArgs(process.argv.slice(2));
const name = args["scenario"] ?? "demo";
const seed = Number(args["seed"] ?? 1);
const seconds = Number(args["seconds"] ?? 120);
const sc = getScenario(name);
const data = loadData(sc.fixtures ?? false);
const input = sc.build(data, seed, seconds);
if (args["no-interiors"] !== undefined) input.map = stripInteriors(input.map); // M7.5c: the map as before interiors
if (args["orders"]) input.orders = JSON.parse(readFileSync(args["orders"], "utf8")) as Order[];
const controllers = args["no-ai"] ? [] : (sc.controllers?.(input) ?? []);
const printEvents = args["events"] === "true";

const t0 = performance.now();
const result = runBattle(input, {
  controllers,
  onEvents: printEvents ? (ev: SimEvent[]) => { for (const e of ev) console.log(JSON.stringify(e)); } : undefined,
});
const ms = performance.now() - t0;

console.log(`Scenario   ${name}: ${sc.description}`);
console.log(`Seed       ${seed}`);
console.log(`Duration   ${result.durationSeconds.toFixed(1)} s game time (${result.endTick} ticks), end: ${result.endReason}`);
console.log(`Wall time  ${ms.toFixed(0)} ms  ->  ${(result.durationSeconds / (ms / 1000)).toFixed(0)}x real time`);
console.log(`State hash ${result.finalStateHash}`);
console.log(`Orders     ${result.orders.length}`);
console.log("Sides:");
for (const s of result.sides) console.log(`  ${s.side.padEnd(5)} ${s.faction.padEnd(3)} start ${s.soldiersStart}  fit ${s.soldiersFit}  wounded ${s.wounded}  killed ${s.killed}`);
console.log("Events:");
for (const [k, v] of Object.entries(result.eventCounts).sort()) console.log(`  ${k.padEnd(20)} ${v}`);
