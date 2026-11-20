/**
 * D3 phone proxy: frame times of the app on an emulated phone, split by part (`__tcs.perf()`), as a table.
 *   npm run phoneperf [-- --look photo,flat] [--dpr 2.625] [--throttle 4] [--seconds 10] [--map village] [--seed 1]
 *                     [--port 4319] [--no-build] [--url http://localhost:5173/] [--query "kind=attack&size=company"]
 *
 * Builds the app and serves it with `vite preview` (as `npm run screenshot` does; `--no-build` serves the existing
 * dist, `--url` measures a running server instead), opens it in Playwright Chromium as a Pixel 7 (412x915, touch),
 * waits for the opening tiles, turns on a CDP CPU throttle and measures four runs per look:
 *   idle (4 s, battle at 1x) · pan at 1x (touch swipes) · pan paused · pan with no throttle (5 s).
 *
 * M12.4 `--campaign N [--battle-seconds 1200]`: the campaign's auto-resolve instead: a new campaign (Germany against
 * Russia, the proposed choice) and N nodes auto-resolved under the throttle, then one without it; wall time per node
 * with its battles (main and flank, battle seconds, men). The page loses its Web Worker (an init script), so the
 * battles run on the main thread, where the CDP throttle applies (it does not reach workers); the work is the same.
 * Writes reports/phoneperf-campaign-<stamp>.md.
 * Each run gives the rAF intervals measured in the page and `__tcs.perf()`'s split (sim, know, ui, draw, gpu).
 * Prints a markdown table and writes it to reports/phoneperf-<stamp>.md with the load average.
 *
 * A report, never a pass/fail check: the container's WebGL is software (SwiftShader, no GPU), so absolute frame
 * times are far above a real phone's; the split (how much is the sim) is what it is good for. The shared container
 * is noisy: the report warns when the load average is above the core count.
 * Uses the pre-installed Playwright (not a project dependency).
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { cpus, loadavg } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../args";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const args = parseArgs(process.argv.slice(2));
const looks = (args["look"] ?? "photo,flat").split(",").filter((l) => l === "photo" || l === "flat");
const throttle = Number(args["throttle"] ?? 4);
const seconds = Number(args["seconds"] ?? 10);
const seed = Number(args["seed"] ?? 1);
const map = args["map"] ?? "village";
const port = Number(args["port"] ?? 4319);
// M12.0b: `--query "kind=attack&size=company"`: more URL parameters for the battle (the company benchmark).
const query = args["query"] ?? "";

// Minimal structural types: Playwright is pre-installed globally, not a dependency, so no type package.
interface Cdp { send(method: string, params?: object): Promise<unknown> }
interface Page {
  on(ev: "pageerror", f: (e: Error) => void): void;
  on(ev: "console", f: (m: { type(): string; text(): string }) => void): void;
  goto(url: string, o?: object): Promise<unknown>;
  waitForFunction(f: () => boolean, arg: null, opts: { timeout: number }): Promise<unknown>;
  evaluate<T>(f: () => T): Promise<T>;
  waitForTimeout(ms: number): Promise<void>;
  click(sel: string): Promise<void>;
  reload(): Promise<unknown>;
  addInitScript(script: string): Promise<void>;
}
interface Context { newPage(): Promise<Page>; newCDPSession(p: Page): Promise<Cdp>; close(): Promise<void> }
interface Browser { newContext(o: object): Promise<Context>; close(): Promise<void> }
interface Device { viewport: { width: number; height: number }; deviceScaleFactor: number }
const { chromium, devices } = createRequire(import.meta.url)("playwright") as { chromium: { launch(): Promise<Browser> }; devices: Record<string, Device> };
const phone = devices["Pixel 7"]!;
const dpr = Number(args["dpr"] ?? phone.deviceScaleFactor);
const W = phone.viewport.width, H = phone.viewport.height;

type Spread = { p50: number; p95: number; max: number; avg: number };
type Stats = { frames: number; frame: Spread; sim: Spread; know: Spread; ui: Spread; draw: Spread; gpu: Spread; steps: Spread; over33: number; droppedMs: number };
type Report = { all: Stats; dpr: number; resolution: number; look: string; tier: { phone: boolean; strong: boolean; workers: number }; gl: string };
interface Run { look: string; run: string; raf: { n: number; p50: number; p95: number; max: number; over33: number }; perf: Report }

const fn = <T>(body: string) => new Function(body) as () => T;

async function measure(page: Page, cdp: Cdp, look: string, run: string, pan: boolean, ms: number): Promise<Run> {
  await page.evaluate(fn<void>(`const g = globalThis; g.__ft = []; let last = 0; const gen = (g.__ftGen = (g.__ftGen || 0) + 1); g.__tcs.perf(true);
    const f = (t) => { if (g.__ftGen !== gen) return; if (last) g.__ft.push(t - last); last = t; requestAnimationFrame(f); }; requestAnimationFrame(f);`));
  const end = Date.now() + ms;
  const cx = W / 2, cy = H / 2;
  let dir = 1;
  while (Date.now() < end) {
    if (!pan) { await page.waitForTimeout(200); continue; }
    // A 240x120 px swipe in 12 moves, alternating direction (real touch events: the app's own gesture code runs).
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx - 120 * dir, y: cy - 60 * dir }] });
    for (let i = 1; i <= 12; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: cx - 120 * dir + 20 * i * dir, y: cy - 60 * dir + 10 * i * dir }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    dir = -dir;
  }
  const out = await page.evaluate(fn<{ ft: number[]; perf: Report }>(`const g = globalThis; g.__ftGen = (g.__ftGen || 0) + 1; return { ft: g.__ft, perf: g.__tcs.perf() };`));
  const s = [...out.ft].sort((x, y) => x - y);
  const q = (p: number) => s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]! : 0;
  return { look, run, raf: { n: s.length, p50: q(0.5), p95: q(0.95), max: s[s.length - 1] ?? 0, over33: s.length ? s.filter((x) => x > 33.4).length / s.length : 0 }, perf: out.perf };
}

async function measureLook(browser: Browser, base: string, look: string): Promise<{ runs: Run[]; errors: string[]; loadMs: number }> {
  const ctx = await browser.newContext({ ...phone, deviceScaleFactor: dpr });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  const t0 = Date.now();
  await page.goto(`${base}?seed=${seed}&map=${map}&look=${look}${query ? `&${query}` : ""}`, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(fn<boolean>("return globalThis.__tcs?.ready === true && globalThis.__tcs.tilesPending() === 0"), null, { timeout: 120000 });
  const loadMs = Date.now() - t0;
  await page.waitForTimeout(1000);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  const runs: Run[] = [];
  runs.push(await measure(page, cdp, look, "idle 1x", false, 4000));
  runs.push(await measure(page, cdp, look, "pan 1x", true, seconds * 1000));
  await page.evaluate(fn<void>("globalThis.__tcs.setSpeed(0)"));
  runs.push(await measure(page, cdp, look, "pan paused", true, seconds * 1000));
  await page.evaluate(fn<void>("globalThis.__tcs.setSpeed(1)"));
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  runs.push(await measure(page, cdp, look, "pan 1x, no throttle", true, 5000));
  await ctx.close();
  return { runs, errors, loadMs };
}

type CampaignState = { screen: string; phase: string | null; battles: number; busy: boolean; history: { flank: boolean; durationS: number; men: number }[] };
interface NodeRun { node: number; throttle: number; wallS: number; battles: { flank: boolean; durationS: number; men: number }[] }

/** M12.4: auto-resolve times of campaign nodes on the phone proxy (see the file comment). */
async function measureCampaign(browser: Browser, base: string, nodes: number, battleSeconds: number): Promise<{ runs: NodeRun[]; errors: string[] }> {
  const ctx = await browser.newContext({ ...phone, deviceScaleFactor: dpr });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript("delete globalThis.Worker;");
  const cdp = await ctx.newCDPSession(page);
  const state = () => page.evaluate(fn<CampaignState>("return globalThis.__tcsCampaign.state();"));
  const wait = async (screen: string, timeout: number) => {
    await page.waitForFunction(fn<boolean>(`const s = globalThis.__tcsCampaign?.state?.(); return !!s && s.screen === ${JSON.stringify(screen)} && !s.busy;`), null, { timeout });
  };
  const url = `${base}?campaign=1&seconds=${battleSeconds}&seed=${seed}&look=photo`;
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(fn<boolean>("return globalThis.__tcsCampaign?.ready === true;"), null, { timeout: 60000 });
  await page.evaluate(fn(`return new Promise((r) => { const q = indexedDB.deleteDatabase("tcs-campaign"); q.onsuccess = q.onerror = q.onblocked = () => r(true); });`));
  await page.reload();
  await page.waitForFunction(fn<boolean>("return globalThis.__tcsCampaign?.ready === true;"), null, { timeout: 60000 });
  await wait("home", 60000);
  await page.click("[data-act=new]");
  const runs: NodeRun[] = [];
  for (let n = 0; n <= nodes; n++) {
    const rate = n < nodes ? throttle : 1;
    await wait("briefing", 600000);
    const before = (await state()).history.length;
    await cdp.send("Emulation.setCPUThrottlingRate", { rate });
    const t = Date.now();
    await page.click("[data-act=auto]");
    await wait("after", 3600000);
    const wallS = (Date.now() - t) / 1000;
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    const st = await state();
    runs.push({ node: n + 1, throttle: rate, wallS, battles: st.history.slice(before) });
    console.log(`node ${n + 1} at ${rate}x: ${wallS.toFixed(0)} s wall, ${st.history.slice(before).map((b) => `${b.flank ? "flank" : "main"} ${b.durationS.toFixed(0)} s ${b.men} men`).join(", ")}`);
    await page.click("[data-act=proceed]");
    await page.waitForTimeout(500);
    if ((await state()).screen === "replenishment") await page.click("[data-act=proceed]");
  }
  await ctx.close();
  return { runs, errors };
}

async function waitForServer(base: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base); if (r.ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no server at ${base}`);
}

const f1 = (v: number) => v.toFixed(1);
const ppp = (s: Spread) => `${f1(s.p50)} / ${f1(s.p95)} / ${f1(s.max)}`;
const pp = (s: Spread) => `${f1(s.p50)} / ${f1(s.p95)}`;

let server: ChildProcess | null = null;
const base = args["url"] ?? `http://localhost:${port}/`;
const cores = cpus().length;
const loadBefore = loadavg()[0]!;
try {
  if (!args["url"]) {
    if (!args["no-build"]) execFileSync("npm", ["run", "build", "-w", "@tcs/app"], { cwd: ROOT, stdio: "inherit", env: { ...process.env, TCS_BASE: "/" } });
    server = spawn(process.execPath, [`${ROOT}/node_modules/vite/bin/vite.js`, "preview", "--port", String(port), "--strictPort"], { cwd: `${ROOT}/packages/app`, stdio: "ignore" });
  }
  await waitForServer(base);
  const browser = await chromium.launch();
  if (args["campaign"] !== undefined) {
    const nodes = Number(args["campaign"] || 2), bs = Number(args["battle-seconds"] ?? 1200);
    const r = await measureCampaign(browser, base, nodes, bs);
    await browser.close();
    const loadAfter = loadavg()[0]!;
    const lines = [
      `# Phone proxy: campaign auto-resolve (M12.4) ${new Date().toISOString()}`, "",
      `Pixel 7 emulation, CPU throttle ${throttle}x on the main thread (the page's Web Worker removed so the throttle applies), a new campaign (the default: Germany against Russia, tracked, operations), ${bs} s battles, seed ${seed}, ${base}.`,
      `Load average ${loadBefore.toFixed(1)} before, ${loadAfter.toFixed(1)} after, on ${cores} cores.`,
      ...(Math.max(loadBefore, loadAfter) > cores ? ["", `**Warning: load average above the core count (${cores}): other work shares the CPU, the numbers are noisy.**`] : []),
      "", "| node | throttle | wall s | battles (battle s, men both sides) | battle s per wall s |", "|---:|---:|---:|---|---:|",
      ...r.runs.map((x) => `| ${x.node} | ${x.throttle}x | ${x.wallS.toFixed(0)} | ${x.battles.map((b) => `${b.flank ? "flank" : "main"} ${b.durationS.toFixed(0)} s, ${b.men}`).join("; ")} | ${(x.battles.reduce((n, b) => n + b.durationS, 0) / Math.max(0.001, x.wallS)).toFixed(1)} |`),
      "", `Page errors: ${r.errors.length ? r.errors.slice(0, 3).join(" | ") : "none"}.`, "",
      "A report, no pass/fail: the throttle approximates a phone's CPU; a real phone runs the worker beside the page.",
    ];
    const md = lines.join("\n") + "\n";
    console.log(md);
    mkdirSync(`${ROOT}/reports`, { recursive: true });
    const out = `${ROOT}/reports/phoneperf-campaign-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.md`;
    writeFileSync(out, md);
    console.log(`Written: ${out}`);
    server?.kill();
    process.exit(0);
  }
  const runs: Run[] = [];
  const notes: string[] = [];
  for (const look of looks) {
    const r = await measureLook(browser, base, look);
    runs.push(...r.runs);
    notes.push(`- ${look}: load to tiles done ${(r.loadMs / 1000).toFixed(1)} s; page errors: ${r.errors.length ? r.errors.slice(0, 3).join(" | ") : "none"}`);
  }
  await browser.close();
  const loadAfter = loadavg()[0]!;
  const dev = runs[0]?.perf;
  const lines = [
    `# Phone proxy (D3) ${new Date().toISOString()}`,
    "",
    `Pixel 7 emulation ${W}x${H} at dpr ${dpr}, CPU throttle ${throttle}x (except the last run), map ${map}, seed ${seed}, ${seconds} s pans, ${base}.`,
    dev ? `Renderer resolution ${dev.resolution}, tier ${dev.tier.phone ? "phone" : dev.tier.strong ? "strong" : "desktop"} (${dev.tier.workers} worker), GL: ${dev.gl}.` : "",
    `Load average ${loadBefore.toFixed(1)} before, ${loadAfter.toFixed(1)} after, on ${cores} cores.`,
    ...(Math.max(loadBefore, loadAfter) > cores ? ["", `**Warning: load average above the core count (${cores}): other work shares the CPU, the numbers are noisy.**`] : []),
    "",
    "Times in ms. rAF: the page's frame intervals; the split is `__tcs.perf()` over the same run (p50 / p95, frame and draw with max).",
    "",
    "| look | run | frames | rAF p50 / p95 / max | > 33 ms | frame (perf) | sim | know | ui | draw | gpu | steps avg / max | lost game ms |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...runs.map((r) => {
      const s = r.perf.all;
      return `| ${r.look} | ${r.run} | ${r.raf.n} | ${f1(r.raf.p50)} / ${f1(r.raf.p95)} / ${f1(r.raf.max)} | ${Math.round(r.raf.over33 * 100)} % | ${ppp(s.frame)} | ${pp(s.sim)} | ${pp(s.know)} | ${pp(s.ui)} | ${ppp(s.draw)} | ${pp(s.gpu)} | ${f1(s.steps.avg)} / ${s.steps.max} | ${Math.round(s.droppedMs)} |`;
    }),
    "",
    ...notes,
    "",
    "Software GL here (no GPU): absolute times are not a phone's. Report only, no pass/fail.",
  ];
  const md = lines.join("\n") + "\n";
  console.log(md);
  mkdirSync(`${ROOT}/reports`, { recursive: true });
  const out = `${ROOT}/reports/phoneperf-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.md`;
  writeFileSync(out, md);
  console.log(`Written: ${out}`);
} finally {
  server?.kill();
}
process.exit(0);
