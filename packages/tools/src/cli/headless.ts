/**
 * Headless runner: runs one battle as fast as possible and prints the result.
 *   npm run headless -- --scenario demo --seed 1 --seconds 120 [--orders file.json] [--no-ai] [--events] [--no-interiors] [--no-medical] [--no-repair] [--no-recovery] [--no-resupply]
 *     [--carriers tracked|wheeled[,tracked|wheeled]] (M7.6c: the mounted platoon scenarios' and `vehicles`' carrier class per side; ignored with a warning elsewhere)
 */
import { readFileSync } from "node:fs";
import { environmentAt, parseTimeOfDay, runBattle, stripInteriors, type Order, type SimEvent } from "@tcs/sim";
import { parseArgs } from "../args";
import { getScenario, loadData, parseCarriers } from "../scenarios";
import { withoutRecovery } from "@tcs/scenario";

const args = parseArgs(process.argv.slice(2));
const timeOfDay = parseTimeOfDay(args["time"]);
const name = args["scenario"] ?? "demo";
const seed = Number(args["seed"] ?? 1);
const seconds = Number(args["seconds"] ?? 120);
const sc = getScenario(name);
const data = loadData(sc.fixtures ?? false);
const carriers = parseCarriers(args["carriers"]);
if (args["carriers"] !== undefined && carriers === null) throw new Error(`--carriers: '${args["carriers"]}' is not tracked|wheeled[,tracked|wheeled]`);
if (carriers && !sc.takesCarriers) process.stderr.write(`warning: --carriers is ignored: scenario '${name}' does not take a carrier class\n`);
const input = sc.build(data, seed, seconds, carriers ? { carriers } : undefined);
// `--time HH:MM [--moon 0..1]` (M9.1): the battle at that local time, the light following the clock.
if (timeOfDay !== null) input.environment = environmentAt(input.catalog, timeOfDay, Number(args["moon"] ?? 0.5));
if (args["no-interiors"] !== undefined) input.map = stripInteriors(input.map); // M7.5c: the map as before interiors
if (args["no-medical"] !== undefined) input.rules.medicalCare = false; // M10.2: no care of the wounded
if (args["no-repair"] !== undefined) input.rules.repair = false; // M11.7a: no field repair by the crews
if (args["no-recovery"] !== undefined) withoutRecovery(input); // M11.7b: no recovery vehicles (none built)
if (args["no-resupply"] !== undefined) input.rules.resupply = false; // M11.1: no refilling, no resupply
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
