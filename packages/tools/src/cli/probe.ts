/**
 * F2 cross-browser hash probe (D3; SPEC 9.6): replays the shoot-out golden (golden/shootout-s1.json) in Node and in
 * every installed Playwright engine (Chromium, Firefox, WebKit) and writes a table to reports/probe-<stamp>.md:
 * engine and version, catalog fingerprint, checkpoints matching the golden, first differing tick, final hash, time.
 *   npm run probe [-- --diff] [--engines chromium,firefox]
 * `--diff`: for every engine that differs, the first differing state paths at its first differing checkpoint
 * (against the same bundle in Node) and the raw `Math` results that differ in the last bit.
 *
 * Report only: a mismatch is a finding (sizes MP1, deterministic maths), not a failure; the exit code is 0
 * unless the bundle cannot be built. Playwright is not a project dependency (pre-installed here, installed by
 * the CI "probe" job); an engine that is missing is reported as "not installed".
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { runInThisContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "vite";
import type { ProbeDump, ProbeRun } from "../../probe/entry";
import { parseArgs } from "../args";
import { readDataFiles } from "../data-files";
import { GOLDEN_DIR, replayGolden, type GoldenFile } from "../golden";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const ENTRY = fileURLToPath(new URL("../../probe/entry.ts", import.meta.url));
const args = parseArgs(process.argv.slice(2));
const ENGINES = (args["engines"] ?? "chromium,firefox,webkit").split(",").filter(Boolean);
const DIFF_PATHS = 12;

// Minimal structural types: Playwright is not a dependency, so no type package.
interface Page {
  setContent(html: string): Promise<void>;
  addScriptTag(o: { content: string }): Promise<unknown>;
  evaluate<T>(expression: string): Promise<T>;
}
interface Browser { version(): string; newPage(): Promise<Page>; close(): Promise<void> }
type BrowserType = { launch(): Promise<Browser> };

interface Row {
  engine: string;
  version: string;
  run?: ProbeRun;
  note?: string;
  diff?: string[];
}

const golden = JSON.parse(readFileSync(join(GOLDEN_DIR, "shootout-s1.json"), "utf8")) as GoldenFile;
const goldenKeys = Object.keys(golden.checkpoints).sort((a, b) => Number(a) - Number(b));
const lastKey = goldenKeys[goldenKeys.length - 1]!;

/** Bundle probe/entry.ts and the data set into one IIFE script (Vite lib mode, nothing written to disk). */
async function bundle(): Promise<{ code: string; ms: number }> {
  const t0 = performance.now();
  const files = readDataFiles();
  const data: Plugin = {
    name: "tcs-probe-data",
    resolveId: (id) => (id === "virtual:tcs-probe-data" ? "\0virtual:tcs-probe-data" : undefined),
    load: (id) => (id === "\0virtual:tcs-probe-data" ? `export default ${JSON.stringify(files)};` : undefined),
  };
  const out = await build({
    configFile: false, root: ROOT, logLevel: "warn", publicDir: false, plugins: [data],
    build: {
      write: false, minify: false, reportCompressedSize: false, emptyOutDir: false,
      lib: { entry: ENTRY, formats: ["iife"], name: "TcsProbeBundle", fileName: () => "probe.js" },
    },
  });
  const outputs = (Array.isArray(out) ? out : [out]) as { output: { type: string; code?: string }[] }[];
  const chunk = outputs.flatMap((o) => o.output).find((o) => o.type === "chunk" && o.code);
  if (!chunk?.code) throw new Error("probe bundle: no output chunk");
  return { code: chunk.code, ms: Math.round(performance.now() - t0) };
}

type ProbeApi = { run(): ProbeRun; dump(tick: number): ProbeDump };

/** First differing paths of two JSON values (depth first, in key order). */
function diffPaths(a: unknown, b: unknown, path: string, out: string[]): void {
  if (out.length >= DIFF_PATHS) return;
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null && Array.isArray(a) === Array.isArray(b)) {
    const ka = Object.keys(a as object), kb = Object.keys(b as object);
    const keys = [...new Set([...ka, ...kb])];
    for (const k of keys) diffPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k, out);
    return;
  }
  if (!Object.is(a, b)) out.push(`\`${path}\`: Node ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
}

function describeDiff(ref: ProbeDump, other: ProbeDump, tick: string): string[] {
  const lines: string[] = [];
  const math = Object.keys(ref.math).filter((k) => !Object.is(ref.math[k], other.math[k]));
  lines.push(math.length ? `Math last-bit differences: ${math.map((k) => `\`${k}\` ${ref.math[k]} vs ${other.math[k]}`).join("; ")}` : "Math: all probed results equal");
  if (ref.state === other.state) { lines.push(`state at tick ${tick}: equal (the hash differs elsewhere)`); return lines; }
  const paths: string[] = [];
  diffPaths(JSON.parse(ref.state || "null"), JSON.parse(other.state || "null"), "", paths);
  lines.push(`state at tick ${tick}: first ${paths.length} differing paths:`, ...paths.map((p) => `  - ${p}`));
  return lines;
}

/** Load Playwright from wherever it is installed (project node_modules or NODE_PATH); null if it is not. */
function playwright(): Record<string, BrowserType> | null {
  try { return createRequire(import.meta.url)("playwright") as Record<string, BrowserType>; } catch { return null; }
}

async function main(): Promise<void> {
  const b = await bundle();
  console.log(`probe bundle: ${(b.code.length / 1048576).toFixed(1)} MB in ${b.ms} ms`);
  const rows: Row[] = [];

  // Node: the real tools replay (tsx) and the same bundle the browsers run.
  const t0 = performance.now();
  const ref = replayGolden(golden);
  rows.push({ engine: "Node (replayGolden)", version: process.version, run: { userAgent: "node", fingerprint: ref.catalogFingerprint, checkpoints: ref.checkpoints, ms: Math.round(performance.now() - t0) } });
  runInThisContext(b.code, { filename: "probe.js" });
  const nodeProbe = (globalThis as unknown as { tcsProbe: ProbeApi }).tcsProbe;
  rows.push({ engine: "Node (probe bundle)", version: process.version, run: nodeProbe.run() });

  const pw = playwright();
  for (const name of ENGINES) {
    const type = pw?.[name];
    if (!pw || !type) { rows.push({ engine: name, version: "-", note: pw ? "unknown engine" : "not installed (no Playwright)" }); continue; }
    let browser: Browser;
    try { browser = await type.launch(); } catch (e) {
      const msg = String((e as Error).message ?? e);
      rows.push({ engine: name, version: "-", note: /Executable doesn't exist|install/i.test(msg) ? "not installed" : `launch failed: ${msg.split("\n")[0]}` });
      continue;
    }
    try {
      const page = await browser.newPage();
      await page.setContent("<!doctype html><meta charset=utf-8><title>TCS probe</title>");
      await page.addScriptTag({ content: b.code });
      const run = await page.evaluate<ProbeRun>("globalThis.tcsProbe.run()");
      const row: Row = { engine: name, version: browser.version(), run };
      const first = goldenKeys.find((k) => run.checkpoints[k] !== golden.checkpoints[k]);
      if (args["diff"] && first) {
        const other = await page.evaluate<ProbeDump>(`globalThis.tcsProbe.dump(${Number(first)})`);
        row.diff = describeDiff(nodeProbe.dump(Number(first)), other, first);
      }
      rows.push(row);
    } catch (e) {
      rows.push({ engine: name, version: browser.version(), note: `failed: ${String((e as Error).message ?? e).split("\n")[0]}` });
    } finally { await browser.close(); }
    console.log(`${name}: done`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const lines = [
    `# Cross-engine hash probe (${stamp})`, "",
    `Golden \`shootout-s1\` (seed ${golden.seed}, ${golden.seconds} s, ${goldenKeys.length} checkpoints every ${golden.checkpointEverySeconds} s), catalog ${golden.catalogFingerprint}; bundle ${(b.code.length / 1048576).toFixed(1)} MB, built in ${b.ms} ms.`, "",
    "| engine | version | catalog fp | checkpoints matching golden | first differing tick | final hash | time |",
    "|---|---|---|---|---|---|---:|",
  ];
  for (const r of rows) {
    if (!r.run) { lines.push(`| ${r.engine} | ${r.version} | | ${r.note ?? ""} | | | |`); continue; }
    const cp = r.run.checkpoints;
    const ok = goldenKeys.filter((k) => cp[k] === golden.checkpoints[k]).length;
    const first = goldenKeys.find((k) => cp[k] !== golden.checkpoints[k]);
    const fp = r.run.fingerprint === golden.catalogFingerprint ? `${r.run.fingerprint} (=)` : `${r.run.fingerprint} (golden ${golden.catalogFingerprint})`;
    const fin = cp[lastKey] ?? "-";
    lines.push(`| ${r.engine} | ${r.version} | ${fp} | ${ok}/${goldenKeys.length} | ${first ?? "-"} | ${fin}${fin === golden.checkpoints[lastKey] ? " (=)" : ""} | ${(r.run.ms / 1000).toFixed(2)} s |`);
  }
  for (const r of rows) if (r.diff) lines.push("", `## ${r.engine}: first difference`, "", ...r.diff);
  lines.push("", "Report only: differences are the expected finding until the sim's maths is engine-independent (MP1).");
  const text = lines.join("\n") + "\n";
  mkdirSync(join(ROOT, "reports"), { recursive: true });
  const file = join(ROOT, "reports", `probe-${stamp}.md`);
  writeFileSync(file, text);
  console.log(text);
  console.log(`wrote ${file}`);
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
