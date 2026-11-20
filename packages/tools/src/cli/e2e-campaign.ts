/**
 * M12.3 acceptance in the browser: `npm run e2e:campaign [-- --port 4319 --seconds 60 --seed 7 --look photo --no-build]`.
 * Builds the app, serves it, and drives the campaign with Playwright (home -> new campaign -> briefing ->
 * auto-resolve -> what changed -> save -> reload -> load -> next briefing; a played battle back to the campaign; a
 * replenishment; a cancelled auto-resolve): `campaign-e2e.ts`. Exits 1 on the first failed check. Playwright is the
 * pre-installed one (not a dependency).
 */
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../args";
import { campaignE2e, type E2ePage } from "../campaign-e2e";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const args = parseArgs(process.argv.slice(2));
const port = Number(args["port"] ?? 4319);
interface Browser { newPage(o: object): Promise<E2ePage & { on(ev: "pageerror", f: (e: Error) => void): void; close(): Promise<void> }>; close(): Promise<void> }
const { chromium } = createRequire(import.meta.url)("playwright") as { chromium: { launch(): Promise<Browser> } };

if (args["no-build"] === undefined) execFileSync("npm", ["run", "build", "-w", "@tcs/app"], { cwd: ROOT, stdio: "inherit", env: { ...process.env, TCS_BASE: "/" } });
const server = spawn(process.execPath, [`${ROOT}/node_modules/vite/bin/vite.js`, "preview", "--port", String(port), "--strictPort"], { cwd: `${ROOT}/packages/app`, stdio: "ignore" });
let code = 0;
try {
  await new Promise((r) => setTimeout(r, 1500));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const t0 = Date.now();
  try {
    const passed = await campaignE2e(page, { base: `http://localhost:${port}`, shots: null, look: args["look"] === "flat" ? "flat" : "photo", seconds: Number(args["seconds"] ?? 60), seed: Number(args["seed"] ?? 7), log: (m) => console.log(m) });
    if (errors.length > 0) throw new Error(`page errors: ${errors.join(" | ")}`);
    console.log(`campaign e2e: ${passed.length} checks passed in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    if (errors.length > 0) console.error(`page errors: ${errors.join(" | ")}`);
    code = 1;
  }
  await browser.close();
} finally {
  server.kill();
}
process.exit(code);
