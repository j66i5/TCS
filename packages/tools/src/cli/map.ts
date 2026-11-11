/**
 * Generate a map and print statistics and validity problems.
 *   npm run map -- --kind village --seed 3 [--size 2000] [--out file.json]
 *   npm run map -- --all --seeds 5        (every kind, seeds 1..5: summary table)
 */
import { writeFileSync } from "node:fs";
import { terrainCatalog } from "@tcs/data";
import { checkMap, generateMap, MAP_KINDS, mapStats, type MapKind } from "@tcs/scenario";
import { mapFingerprint, mapToFile } from "@tcs/sim";
import { parseArgs } from "../args";
import { loadData } from "../scenarios";

const args = parseArgs(process.argv.slice(2));
const terrain = terrainCatalog(loadData());
const size = Number(args["size"] ?? 2000);
const pct = (v: number | undefined) => `${((v ?? 0) * 100).toFixed(1)}%`;

function one(kind: MapKind, seed: number, verbose: boolean) {
  const t0 = performance.now();
  const m = generateMap(terrain, { kind, seed, widthM: size, heightM: size });
  const ms = performance.now() - t0;
  const st = mapStats(m);
  const problems = checkMap(m);
  if (verbose) {
    console.log(`${m.name}: ${m.cols} x ${m.rows} cells of ${m.cellSizeM} m, generated in ${ms.toFixed(0)} ms, fingerprint ${mapFingerprint(m)}`);
    console.log(`height ${st.heightMin.toFixed(1)}..${st.heightMax.toFixed(1)} m`);
    console.log("surface:    " + Object.entries(st.surface).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v)}`).join(", "));
    console.log("vegetation: " + Object.entries(st.vegetation).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v)}`).join(", "));
    console.log(`buildings (${st.buildingCount}): ` + Object.entries(st.buildings).map(([k, v]) => `${k} ${v}`).join(", "));
    console.log("obstacles:  " + Object.entries(st.obstacleM).map(([k, v]) => `${k} ${v.toFixed(0)} m`).join(", "));
    console.log("roads:      " + Object.entries(st.roadM).map(([k, v]) => `${k} ${v.toFixed(0)} m`).join(", ") + `; water bodies ${st.water}`);
    console.log(problems.length ? `PROBLEMS (${problems.length}):\n  ${problems.slice(0, 20).join("\n  ")}` : "valid: no problems");
    if (args["out"]) { writeFileSync(args["out"], JSON.stringify(mapToFile(m))); console.log(`wrote ${args["out"]}`); }
  }
  return { m, st, ms, problems };
}

if (args["all"]) {
  const seeds = Number(args["seeds"] ?? 5);
  console.log("| kind | seed | style | ms | buildings | woodland | water | problems |");
  console.log("|---|---:|---|---:|---:|---:|---:|---:|");
  for (const kind of MAP_KINDS) for (let s = 1; s <= seeds; s++) {
    const r = one(kind, s, false);
    console.log(`| ${kind} | ${s} | ${r.m.name.split("(")[1]?.replace(")", "")} | ${r.ms.toFixed(0)} | ${r.st.buildingCount} | ${pct(r.st.vegetation["woodland"])} | ${r.st.water} | ${r.problems.length} |`);
  }
} else {
  one((args["kind"] ?? "village") as MapKind, Number(args["seed"] ?? 1), true);
}
