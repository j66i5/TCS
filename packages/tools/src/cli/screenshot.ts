/**
 * Visual self-check: builds the app, serves it, opens it in headless Chromium (phone and desktop
 * viewports), issues an order, advances the simulation and saves screenshots to screenshots/.
 *   npm run screenshot [-- --scale 2]
 *
 * Uses the pre-installed Playwright (not a project dependency).
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../args";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const args = parseArgs(process.argv.slice(2));
const scale = Number(args["scale"] ?? 1);
const seed = Number(args["seed"] ?? 1);
const mapKind = args["map"] ?? "village";
const port = 4317;

// Minimal structural types: Playwright is pre-installed globally, not a dependency, so no type package.
interface Page {
  on(ev: "pageerror", f: (e: Error) => void): void;
  on(ev: "console", f: (m: { type(): string; text(): string }) => void): void;
  goto(url: string): Promise<unknown>;
  waitForFunction(f: () => boolean, arg: null, opts: { timeout: number }): Promise<unknown>;
  evaluate<T>(f: () => T): Promise<T>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(o: { path: string }): Promise<unknown>;
  close(): Promise<void>;
}
interface Browser { newPage(o: object): Promise<Page>; close(): Promise<void> }
const { chromium } = createRequire(import.meta.url)("playwright") as { chromium: { launch(): Promise<Browser> } };
// Inside page.evaluate the code runs in the browser; reach the app's debug hook through globalThis.
type Hook = { ready: boolean; setSpeed(v: number): void; tap(x: number, y: number): void; stepTicks(n: number): void; sim: { state: { tick: number } }; hash(): string; orderLog: unknown[] };
export type { Hook };

execFileSync("npm", ["run", "build", "-w", "@tcs/app"], { cwd: ROOT, stdio: "inherit", env: { ...process.env, TCS_BASE: "/" } });
const server = spawn(process.execPath, [`${ROOT}/node_modules/vite/bin/vite.js`, "preview", "--port", String(port), "--strictPort"], { cwd: `${ROOT}/packages/app`, stdio: "ignore" });
const outDir = `${ROOT}/screenshots`;
mkdirSync(outDir, { recursive: true });

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://localhost:${port}/`); if (r.ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("preview server did not start");
}

try {
  await waitForServer();
  const browser = await chromium.launch();
  const shots: string[] = [];
  for (const [name, vp] of [["phone", { width: 390, height: 844 }], ["desktop", { width: 1280, height: 800 }]] as const) {
    const page = await browser.newPage({ viewport: vp, deviceScaleFactor: scale, hasTouch: name === "phone" });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto(`http://localhost:${port}/?seed=${seed}&map=${mapKind}`);
    try {
      await page.waitForFunction(new Function("return globalThis.__tcs?.ready === true") as () => boolean, null, { timeout: 20000 });
    } catch (e) {
      await page.screenshot({ path: `${outDir}/${name}-FAILED.png` });
      throw new Error(`app did not start (${(e as Error).message.split("\n")[0]}); page errors: ${errors.join(" | ") || "none"}`, { cause: e });
    }
    // Freeze real time; drive the simulation deterministically from here.
    await page.evaluate(new Function("globalThis.__tcs.setSpeed(0)") as () => void);
    await page.waitForTimeout(300);
    const p0 = `${outDir}/${mapKind}-${seed}-${name}-0-start.png`;
    await page.screenshot({ path: p0 }); shots.push(p0);
    // Order the blue team to (200 m, 90 m), then advance 20 s of game time.
    await page.evaluate(new Function("globalThis.__tcs.tap(200, 90); globalThis.__tcs.stepTicks(60 * 20);") as () => void);
    await page.waitForTimeout(300);
    const p1 = `${outDir}/${mapKind}-${seed}-${name}-1-after-20s.png`;
    await page.screenshot({ path: p1 }); shots.push(p1);
    const info = await page.evaluate(new Function("const t = globalThis.__tcs; return { tick: t.sim.state.tick, hash: t.hash(), orders: t.orderLog.length };") as () => { tick: number; hash: string; orders: number });
    console.log(`${name}: tick ${info.tick}, orders ${info.orders}, hash ${info.hash}, page errors: ${errors.length ? errors.join(" | ") : "none"}`);
    await page.close();
  }
  await browser.close();
  console.log(`Screenshots:\n${shots.join("\n")}`);
} finally {
  server.kill();
}
process.exit(0);
