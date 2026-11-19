/**
 * Campaign tools (M12).
 *   npm run campaign -- chain --faction de [--enemy ru] [--battles 2] [--seed 1] [--map village] [--seconds 900]
 *     [--attacker blue|red] [--on-foot]
 *   M12.0a: battles on one map, each with both sides as the last left them (roster records out -> in) and the map's
 *   damage and wrecks; AI on both sides. Prints per battle the sides, what was carried and the time taken.
 */
import { runChain } from "@tcs/campaign";
import type { MapKind } from "@tcs/scenario";
import { parseArgs } from "../args";
import { aiRunner, enemyOf } from "../campaign";
import { loadData, ON_POSTS } from "../scenarios";

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
if (cmd !== "chain") {
  console.error("usage: npm run campaign -- chain --faction de|ru|xf [--enemy f] [--battles n] [--seed n] [--map kind] [--seconds s] [--attacker blue|red] [--on-foot]");
  process.exit(1);
}
const faction = args["faction"] ?? "de";
const data = loadData(faction === "xf" || args["enemy"] === "xf");
if (!data.factions[faction]) throw new Error(`unknown faction '${faction}'`);
const enemy = args["enemy"] ?? enemyOf(data, faction);
const battles = Number(args["battles"] ?? 2), seed = Number(args["seed"] ?? 1), seconds = Number(args["seconds"] ?? 900);
const attacker = args["attacker"] === "red" ? "red" : "blue";
console.log(`Chain: ${battles} battles, ${faction} (blue) against ${enemy} (red), ${attacker} attacking, map ${args["map"] ?? "village"} seed ${seed}, ${seconds} s each`);
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
