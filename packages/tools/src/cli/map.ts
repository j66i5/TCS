/**
 * Generate a map and print statistics and validity problems.
 *   npm run map -- --kind village --seed 3 [--size 2000] [--out file.json]
 *   npm run map -- --all --seeds 5        (every kind, seeds 1..5: summary table)
 *   npm run map -- --kind village --size 4000 --nav [--seeds 3]
 *       (D3 F3 map-size check: also builds the nav grids the sim builds lazily (foot, foot with cover weight,
 *        tracked and wheeled with clearance), routes a man corner to corner, and prints times and memory;
 *        with --seeds N, seeds 1..N and the median. NODE_OPTIONS=--expose-gc gives steadier memory figures.)
 */
import { writeFileSync } from "node:fs";
import { serialize } from "node:v8";
import { buildCatalog, terrainCatalog } from "@tcs/data";
import { checkMap, generateMap, MAP_KINDS, mapStats, type MapKind } from "@tcs/scenario";
import { buildNavGrid, coverGridFrom, createNavSearch, findPath, mapFingerprint, mapToFile, VEHICLE_CLEARANCE_CELLS, type MapDef, type MovementClass } from "@tcs/sim";
import { parseArgs } from "../args";
import { loadData } from "../scenarios";

const args = parseArgs(process.argv.slice(2));
const data = loadData();
const terrain = terrainCatalog(data);
const size = Number(args["size"] ?? 2000);
const pct = (v: number | undefined) => `${((v ?? 0) * 100).toFixed(1)}%`;

function one(kind: MapKind, seed: number, verbose: boolean) {
  const t0 = performance.now();
  const m = generateMap(terrain, { kind, seed, widthM: size, heightM: size, interiors: !args["no-interiors"] });
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
    console.log(`interiors:  ${st.rooms} rooms, ${st.innerWalls} inner walls, ${st.innerDoors} doorways, ${st.stairs} stairs`);
    console.log("roads:      " + Object.entries(st.roadM).map(([k, v]) => `${k} ${v.toFixed(0)} m`).join(", ") + `; water bodies ${st.water}`);
    console.log(problems.length ? `PROBLEMS (${problems.length}):\n  ${problems.slice(0, 20).join("\n  ")}` : "valid: no problems");
    if (args["out"]) { writeFileSync(args["out"], JSON.stringify(mapToFile(m))); console.log(`wrote ${args["out"]}`); }
  }
  return { m, st, ms, problems };
}

/** Widest hull of a vehicle class, m (as sim/navctx.ts `widestHull`: the grid's minimum breach is that + 0.5 m). */
function widestHull(cls: MovementClass): number {
  const vehicles = buildCatalog(data, Object.keys(data.factions).sort()).vehicles;
  let w = 0;
  for (const id of Object.keys(vehicles).sort()) { const v = vehicles[id]!; if (v.class === cls) w = Math.max(w, v.body.widthM); }
  return w > 0 ? w : 2.5;
}

interface NavRow { genMs: number; foot: number; cover: number; tracked: number; wheeled: number; routeMs: number; routeFound: boolean; mapMB: number; navMB: number; rssMB: number }

const MB = 1048576;
const gc = (globalThis as { gc?: () => void }).gc ?? (() => {});
const heap = () => { gc(); gc(); const m = process.memoryUsage(); return m.heapUsed + m.arrayBuffers; };

/**
 * The nav grids the sim builds for a battle (`navFor`: foot, foot:cover:0.3, tracked:c1, wheeled:c1) and one
 * cross-map foot route (corner to corner, the worst case of a single `findPath`). Memory: the map's v8-serialised
 * size, and heap + array buffers after GC before and after the nav build (four grids and two searches held).
 */
function navCheck(m: MapDef, genMs: number): NavRow {
  const trackedBreachM = widestHull("tracked") + 0.5, wheeledBreachM = widestHull("wheeled") + 0.5;
  const h1 = heap();
  const time = <T>(f: () => T): [T, number] => { const t = performance.now(); const r = f(); return [r, performance.now() - t]; };
  const [foot, tFoot] = time(() => buildNavGrid(m, terrain, "foot", 2, 0, [], {}));
  const [cover, tCover] = time(() => coverGridFrom(foot, 0.3));
  const [tracked, tTracked] = time(() => buildNavGrid(m, terrain, "tracked", 2, 0, [], { clearanceCells: VEHICLE_CLEARANCE_CELLS, minBreachM: trackedBreachM }));
  const [wheeled, tWheeled] = time(() => buildNavGrid(m, terrain, "wheeled", 2, 0, [], { clearanceCells: VEHICLE_CLEARANCE_CELLS, minBreachM: wheeledBreachM }));
  const searches = [createNavSearch(foot), createNavSearch(tracked)];
  const [route, tRoute] = time(() => findPath(searches[0]!, 20, 20, m.widthM - 20, m.heightM - 20));
  const h2 = heap();
  void cover; void wheeled;
  return {
    genMs, foot: tFoot, cover: tCover, tracked: tTracked, wheeled: tWheeled, routeMs: tRoute, routeFound: route !== null,
    mapMB: serialize(m).length / MB, navMB: (h2 - h1) / MB, rssMB: process.memoryUsage().rss / MB,
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b), n = s.length;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

if (args["nav"]) {
  const kind = (args["kind"] ?? "village") as MapKind;
  const seeds = args["seeds"] ? Array.from({ length: Number(args["seeds"]) }, (_, i) => i + 1) : [Number(args["seed"] ?? 1)];
  const rows: NavRow[] = [];
  console.log(`${kind} ${size} x ${size} m${(globalThis as { gc?: unknown }).gc ? "" : " (no --expose-gc: memory figures are rough)"}`);
  console.log("| seed | cells | buildings | problems | gen ms | foot ms | cover ms | tracked ms | wheeled ms | diagonal route ms | map MB (serialised) | nav MB (4 grids + 2 searches) | RSS MB |");
  console.log("|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const seed of seeds) {
    const r = one(kind, seed, false);
    const n = navCheck(r.m, r.ms);
    rows.push(n);
    console.log(`| ${seed} | ${r.m.cols} x ${r.m.rows} | ${r.st.buildingCount} | ${r.problems.length} | ${n.genMs.toFixed(0)} | ${n.foot.toFixed(0)} | ${n.cover.toFixed(0)} | ${n.tracked.toFixed(0)} | ${n.wheeled.toFixed(0)} | ${n.routeMs.toFixed(0)}${n.routeFound ? "" : " (no route)"} | ${n.mapMB.toFixed(0)} | ${n.navMB.toFixed(0)} | ${n.rssMB.toFixed(0)} |`);
  }
  if (rows.length > 1) {
    const md = (k: "genMs" | "foot" | "cover" | "tracked" | "wheeled" | "routeMs" | "mapMB" | "navMB" | "rssMB") => median(rows.map((r) => r[k])).toFixed(0);
    console.log(`| median | | | | ${md("genMs")} | ${md("foot")} | ${md("cover")} | ${md("tracked")} | ${md("wheeled")} | ${md("routeMs")} | ${md("mapMB")} | ${md("navMB")} | ${md("rssMB")} |`);
  }
} else if (args["all"]) {
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
