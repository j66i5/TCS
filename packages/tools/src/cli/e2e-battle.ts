/**
 * The battle screen in the browser (review 2026-11-24 step 5, part 2):
 * `npm run e2e:battle [-- --port 4322 --look photo --parts opening,card,reject,drone --views portrait,landscape,desktop --no-build]`.
 * Builds the app, serves it and runs battle-e2e.ts with Playwright at 360x780 (phone upright), 780x360 (phone
 * sideways) and 1400x900 (desktop). Exits 1 on the first failed check. Playwright is the pre-installed one.
 */
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../args";
import { battleE2e, type BattlePage, type BattleViewport } from "../battle-e2e";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const args = parseArgs(process.argv.slice(2));
const port = Number(args["port"] ?? 4322);
interface Browser { newPage(o: object): Promise<BattlePage & { on(ev: "pageerror", f: (e: Error) => void): void; close(): Promise<void> }>; close(): Promise<void> }
const { chromium } = createRequire(import.meta.url)("playwright") as { chromium: { launch(): Promise<Browser> } };

export const BATTLE_VIEWPORTS: Record<BattleViewport, { width: number; height: number; touch: boolean }> = {
  portrait: { width: 360, height: 780, touch: true },
  landscape: { width: 780, height: 360, touch: true },
  desktop: { width: 1400, height: 900, touch: false },
};

if (args["no-build"] === undefined) execFileSync("npm", ["run", "build", "-w", "@tcs/app"], { cwd: ROOT, stdio: "inherit", env: { ...process.env, TCS_BASE: "/" } });
const server = spawn(process.execPath, [`${ROOT}/node_modules/vite/bin/vite.js`, "preview", "--port", String(port), "--strictPort"], { cwd: `${ROOT}/packages/app`, stdio: "ignore" });
let code = 0;
try {
  await new Promise((r) => setTimeout(r, 1500));
  const browser = await chromium.launch();
  const t0 = Date.now();
  const views = (typeof args["views"] === "string" ? args["views"].split(",") : ["portrait", "landscape", "desktop"]) as BattleViewport[];
  const parts = typeof args["parts"] === "string" ? (args["parts"].split(",") as ("opening" | "card" | "reject" | "drone")[]) : undefined;
  let n = 0;
  for (const vn of views) {
    const vp = BATTLE_VIEWPORTS[vn];
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    console.log(`${vn} ${vp.width}x${vp.height}`);
    try {
      // (The drone part is the same at every size: once, on the phone upright, unless asked for.)
      const p = parts ?? (vn === views[0] ? undefined : (["opening", "card", "reject"] as const));
      const passed = await battleE2e(page, { base: `http://localhost:${port}`, viewport: vn, shots: null, look: args["look"] === "flat" ? "flat" : "photo", ...(p ? { parts: p } : {}), log: (m) => console.log(m) });
      if (errors.length > 0) throw new Error(`page errors: ${errors.join(" | ")}`);
      n += passed.length;
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      if (errors.length > 0) console.error(`page errors: ${errors.join(" | ")}`);
      code = 1;
    }
    await page.close();
    if (code !== 0) break;
  }
  if (code === 0) console.log(`battle e2e: ${n} checks passed in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  await browser.close();
} finally {
  server.kill();
}
process.exit(code);
