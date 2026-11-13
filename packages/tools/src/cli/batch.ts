/**
 * Batch runner: runs a scenario with many seeds and writes a report to reports/.
 *   npm run batch -- --scenario demo --runs 200 --seconds 120
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBattle, stripInteriors, tallyExpenditure, type Expenditure, type Sim } from "@tcs/sim";
import { parseArgs } from "../args";
import { getScenario, loadData } from "../scenarios";

const args = parseArgs(process.argv.slice(2));
const name = args["scenario"] ?? "demo";
const runs = Number(args["runs"] ?? 100);
const seconds = Number(args["seconds"] ?? 120);
const firstSeed = Number(args["seed"] ?? 1);
/** `--no-interiors`: the maps without building interiors, exactly as before M7.5c (comparison batches). */
const noInteriors = args["no-interiors"] !== undefined;
const sc = getScenario(name);
const data = loadData(sc.fixtures ?? false);

interface Row {
  seed: number; durationS: number; endReason: string; orders: number; hash: string; casualties: Record<string, number>; prisoners: Record<string, number>; wallMs: number; winner: string | null; scores: Record<string, number>;
  /** Vehicles (M7.2): lost (destroyed or abandoned) and immobilised per side; game time of each side's first dismount, s (null = none). */
  vehiclesLost: Record<string, number>; vehiclesImmobilised: Record<string, number>; firstDismountS: Record<string, number | null>;
  /** Ammunition expenditure (M7.3, plan C4): rounds by source per side (vehicle rounds credited to the vehicle). */
  spent: Record<string, { smallArms: number; grenades: number; rockets: number; cannon: number; coax: number; smoke: number }>;
  /** Crews (M7.4b) per side: times a crew reversed out, fires started, fires its extinguisher put out. */
  crews: Record<string, { reversedOut: number; fires: number; firesOut: number }>;
  /** Guided missiles (owner 2026-11-13) per side: fired, hit their target, lost by the gunner, missed; and enemy
   *  hulls penetrated by missiles and by shoulder-fired rockets. */
  missiles: Record<string, { fired: number; hit: number; lost: number; miss: number; penetrated: number; rocketPenetrated: number }>;
  /** Mortar fire (step fire-support) per calling side: HE bursts, of them ranging rounds, enemy men wounded in a
   *  tick with one of its bursts (fragments or blast), and of them put out of action. */
  mortar: Record<string, { bursts: number; ranging: number; enemyWounded: number; enemyDown: number }>;
}
const rows: Row[] = [];
const t0 = performance.now();
for (let i = 0; i < runs; i++) {
  const seed = firstSeed + i;
  const input = sc.build(data, seed, seconds);
  if (noInteriors) input.map = stripInteriors(input.map);
  const s0 = performance.now();
  // Each side's first dismount (M7.2), from the event stream.
  const firstDismount: Record<string, number | null> = { blue: null, red: null };
  const sideOfUnit = new Map<number, string>();
  const sideOfVehicle = new Map<number, string>();
  const crews: Row["crews"] = { blue: { reversedOut: 0, fires: 0, firesOut: 0 }, red: { reversedOut: 0, fires: 0, firesOut: 0 } };
  const missiles: Row["missiles"] = { blue: { fired: 0, hit: 0, lost: 0, miss: 0, penetrated: 0, rocketPenetrated: 0 }, red: { fired: 0, hit: 0, lost: 0, miss: 0, penetrated: 0, rocketPenetrated: 0 } };
  const exp: Expenditure = {};
  const mortar: Row["mortar"] = { blue: { bursts: 0, ranging: 0, enemyWounded: 0, enemyDown: 0 }, red: { bursts: 0, ranging: 0, enemyWounded: 0, enemyDown: 0 } };
  const mortarHe = new Set(Object.values(input.catalog.factions).map((f) => f.fireSupport?.heAmmo).filter((x): x is string => x !== undefined));
  const sideOfSoldier = (sim: Sim, id: number) => sim.state.identity.get(id)?.side;
  let simRef: Sim | null = null;
  let pending: Parameters<typeof tallyExpenditure>[1] = [];
  const r = runBattle(input, {
    controllers: sc.controllers?.(input) ?? [],
    onTick: (sim) => {
      simRef = sim;
      if (sideOfUnit.size === 0) for (const [id, u] of sim.state.unit.entries()) sideOfUnit.set(id, u.side);
      if (sideOfVehicle.size === 0) for (const [id, v] of sim.state.vehicle.entries()) sideOfVehicle.set(id, v.side);
      if (pending.length > 0) { tallyExpenditure(exp, pending, sim.state, input.catalog); pending = []; }
    },
    onEvents: (ev) => {
      pending = ev;
      // Mortar bursts this tick (by the side of the man who called them), then the enemy men hurt in the same tick.
      let burstSide: string | undefined;
      for (const e of ev) {
        if (e.kind === "explosion" && mortarHe.has(e.ammo) && simRef) { burstSide = sideOfSoldier(simRef, e.owner); const m = mortar[burstSide ?? ""]; if (m) m.bursts++; }
        else if ((e as { kind: string }).kind === "support.ranging") { const m = mortar[(e as unknown as { side: string }).side]; if (m) m.ranging++; }
      }
      if (burstSide !== undefined && simRef) {
        const hurt = new Set<number>();
        for (const e of ev) {
          if (e.kind === "wound" && (e.mechanism === "fragment" || e.mechanism === "blast") && sideOfSoldier(simRef, e.soldier) !== burstSide && !hurt.has(e.soldier)) { hurt.add(e.soldier); mortar[burstSide]!.enemyWounded++; }
          else if (e.kind === "casualty" && sideOfSoldier(simRef, e.soldier) !== burstSide) mortar[burstSide]!.enemyDown++;
        }
      }
      for (const e of ev) {
        if (e.kind === "missile.ended") { const m = missiles[sideOfVehicle.get(e.vehicle) ?? ""]; if (m) m[e.result]++; continue; }
        if (e.kind === "shot.fired" && e.vehicle !== undefined && input.catalog.ammo[e.ammo]?.guided !== undefined) { const m = missiles[sideOfVehicle.get(e.vehicle) ?? ""]; if (m) m.fired++; continue; }
        if (e.kind === "vehicle.hit" && e.result === "penetrated") {
          const am = input.catalog.ammo[e.ammo];
          const vs = sideOfVehicle.get(e.vehicle);
          const m = missiles[vs === "blue" ? "red" : vs === "red" ? "blue" : ""];
          if (m && am?.guided !== undefined) m.penetrated++;
          else if (m && am?.delivery?.method === "direct") m.rocketPenetrated++;
          continue;
        }
        if (e.kind === "vehicle.reaction" || e.kind === "vehicle.fire" || e.kind === "vehicle.extinguished") {
          const c = crews[sideOfVehicle.get(e.vehicle) ?? ""];
          if (c) { if (e.kind === "vehicle.reaction" && e.reaction === "reverseOut") c.reversedOut++; else if (e.kind === "vehicle.fire") c.fires++; else if (e.kind === "vehicle.extinguished") c.firesOut++; }
          continue;
        }
        if (e.kind !== "unit.dismounted") continue;
        const side = sideOfUnit.get(e.unit);
        if (side !== undefined && firstDismount[side] === null) firstDismount[side] = e.tick / 60;
      }
    },
  });
  rows.push({
    seed, durationS: r.durationSeconds, endReason: r.endReason, orders: r.orders.length, hash: r.finalStateHash,
    casualties: Object.fromEntries(r.sides.map((s) => [s.side, s.wounded + s.killed])),
    prisoners: Object.fromEntries(r.sides.map((s) => [s.side, s.surrendered + s.captured])),
    wallMs: performance.now() - s0,
    winner: r.winner, scores: Object.fromEntries(r.scores.map((s) => [s.side, s.score])),
    vehiclesLost: Object.fromEntries(r.sides.map((s) => [s.side, (s.vehicles?.destroyed ?? 0) + (s.vehicles?.abandoned ?? 0)])),
    vehiclesImmobilised: Object.fromEntries(r.sides.map((s) => [s.side, s.vehicles?.immobilised ?? 0])),
    firstDismountS: firstDismount,
    crews, missiles, mortar,
    spent: Object.fromEntries(Object.entries(exp).map(([side, e]) => {
      const vs = Object.values(e.vehicles);
      return [side, { smallArms: e.smallArms, grenades: e.grenades, rockets: Object.values(e.rockets).reduce((a, b) => a + b, 0), cannon: vs.reduce((n, v) => n + Object.values(v.cannon).reduce((a, b) => a + b, 0), 0), coax: vs.reduce((n, v) => n + v.coax, 0), smoke: vs.reduce((n, v) => n + v.smoke, 0) }];
    })),
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
  `- Building interiors: ${noInteriors ? "off (--no-interiors)" : "on"}`,
  `- Runs: ${runs} (seeds ${firstSeed}..${firstSeed + runs - 1}), ${seconds} s game time each`,
  `- Wall time: ${(totalMs / 1000).toFixed(1)} s total, mean ${mean(rows.map((r) => r.wallMs)).toFixed(1)} ms per battle`,
  `- Speed: ${((runs * seconds) / (totalMs / 1000)).toFixed(0)}x real time`,
  `- Distinct final states: ${uniqueHashes} of ${runs}`,
  `- End reasons: ${Object.entries(ends).map(([k, v]) => `${k} ${v}`).join(", ")}`,
  `- Mean orders per battle: ${mean(rows.map((r) => r.orders)).toFixed(1)}`,
  `- Mean casualties per side: ${["blue", "red"].map((s) => `${s} ${mean(rows.map((r) => r.casualties[s] ?? 0)).toFixed(2)}`).join(", ")}`,
  `- Mean surrendered or taken prisoner per side: ${["blue", "red"].map((s) => `${s} ${mean(rows.map((r) => r.prisoners[s] ?? 0)).toFixed(2)}`).join(", ")}`,
  "",
  `- Winners: ${["blue", "red"].map((w) => `${w} ${rows.filter((r) => r.winner === w).length}`).join(", ")}, draw ${rows.filter((r) => r.winner === null).length}; mean score ${["blue", "red"].map((s) => `${s} ${mean(rows.map((r) => r.scores[s] ?? 0)).toFixed(1)}`).join(", ")}`,
  "(Winner and score: objectives held at the end minus men down, M6; without objectives every battle is a draw.)",
  `- Vehicles (M7.2): mean lost ${["blue", "red"].map((s) => `${s} ${mean(rows.map((r) => r.vehiclesLost[s] ?? 0)).toFixed(2)}`).join(", ")}; immobilised ${["blue", "red"].map((s) => `${s} ${mean(rows.map((r) => r.vehiclesImmobilised[s] ?? 0)).toFixed(2)}`).join(", ")}; first dismount at ${["blue", "red"].map((s) => { const xs = rows.map((r) => r.firstDismountS[s]).filter((x): x is number => x !== null && x !== undefined); return `${s} ${xs.length ? `${mean(xs).toFixed(0)} s (${xs.length} runs)` : "-"}`; }).join(", ")}`,
  `- Ammunition per battle (M7.3; vehicle rounds credited to the vehicle): ${["blue", "red"].map((s) => `${s} small arms ${mean(rows.map((r) => r.spent[s]?.smallArms ?? 0)).toFixed(0)}, grenades ${mean(rows.map((r) => r.spent[s]?.grenades ?? 0)).toFixed(1)}, anti-tank rounds ${mean(rows.map((r) => r.spent[s]?.rockets ?? 0)).toFixed(1)}, cannon ${mean(rows.map((r) => r.spent[s]?.cannon ?? 0)).toFixed(0)}, coax ${mean(rows.map((r) => r.spent[s]?.coax ?? 0)).toFixed(0)}, smoke salvos ${mean(rows.map((r) => r.spent[s]?.smoke ?? 0)).toFixed(1)}`).join("; ")}`,
  `- Guided missiles per battle (owner 2026-11-13): ${["blue", "red"].map((s) => `${s} fired ${mean(rows.map((r) => r.missiles[s]?.fired ?? 0)).toFixed(1)}, hit ${mean(rows.map((r) => r.missiles[s]?.hit ?? 0)).toFixed(1)}, lost ${mean(rows.map((r) => r.missiles[s]?.lost ?? 0)).toFixed(1)}, missed ${mean(rows.map((r) => r.missiles[s]?.miss ?? 0)).toFixed(1)}, enemy hulls penetrated ${mean(rows.map((r) => r.missiles[s]?.penetrated ?? 0)).toFixed(1)} (by rockets ${mean(rows.map((r) => r.missiles[s]?.rocketPenetrated ?? 0)).toFixed(1)})`).join("; ")}`,
  `- Mortar per battle (by the calling side): ${["blue", "red"].map((s) => `${s} HE bursts ${mean(rows.map((r) => r.mortar[s]?.bursts ?? 0)).toFixed(1)} (ranging rounds of any kind ${mean(rows.map((r) => r.mortar[s]?.ranging ?? 0)).toFixed(1)}), enemy wounded in a burst's tick ${mean(rows.map((r) => r.mortar[s]?.enemyWounded ?? 0)).toFixed(2)}, of them down ${mean(rows.map((r) => r.mortar[s]?.enemyDown ?? 0)).toFixed(2)}`).join("; ")}`,
  `- Crews per battle (M7.4b): ${["blue", "red"].map((s) => `${s} reversed out ${mean(rows.map((r) => r.crews[s]?.reversedOut ?? 0)).toFixed(1)}, fires ${mean(rows.map((r) => r.crews[s]?.fires ?? 0)).toFixed(1)} (put out ${mean(rows.map((r) => r.crews[s]?.firesOut ?? 0)).toFixed(1)})`).join("; ")}`,
  "",
  "| seed | duration s | end | winner | score blue/red | orders | casualties blue/red | hash |",
  "|---:|---:|---|---|---|---:|---|---|",
  ...rows.slice(0, 20).map((r) => `| ${r.seed} | ${r.durationS.toFixed(0)} | ${r.endReason} | ${r.winner ?? "draw"} | ${r.scores["blue"] ?? 0}/${r.scores["red"] ?? 0} | ${r.orders} | ${r.casualties["blue"] ?? 0}/${r.casualties["red"] ?? 0} | \`${r.hash}\` |`),
  rows.length > 20 ? `\n(first 20 of ${rows.length} rows; all rows in the JSON file)` : "",
].join("\n");
const base = join(dir, `batch-${name}${noInteriors ? "-no-interiors" : ""}-${stamp}`);
writeFileSync(`${base}.md`, md + "\n");
writeFileSync(`${base}.json`, JSON.stringify({ name, runs, seconds, rows }, null, 2));
console.log(md.split("\n").slice(0, 20).join("\n"));
console.log(`\nWrote ${base}.md and .json`);
