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
    // Order the blue team toward the map centre (through the village on village maps), advance 40 s of game
    // time, and switch the debug view on so the navigation grid and the planned route are visible.
    await page.evaluate(new Function(`const t = globalThis.__tcs; const m = t.sim.ctx.map;
      t.tap(m.widthM > 600 ? m.widthM * 0.55 : 200, m.widthM > 600 ? m.heightM * 0.5 : 90); t.stepTicks(60 * 40); t.setDebug(true);`) as () => void);
    await page.waitForTimeout(300);
    const p1 = `${outDir}/${mapKind}-${seed}-${name}-1-after-40s-debug.png`;
    await page.screenshot({ path: p1 }); shots.push(p1);
    // Shooting: the blue team goes prone and fires (a real fire order) at a point 250 m to the east; the picture
    // is taken about 12 s into the firing, in the normal view (tracers clear, other bullets very faint).
    await page.evaluate(new Function(`const t = globalThis.__tcs; t.setDebug(false); t.posture("prone"); t.stepTicks(240);
      const s = t.sim.state; let x = 0, y = 0, n = 0;
      for (const [id, i] of s.identity.entries()) if (i.side === "blue") { const p = s.transform.req(id); x += p.x; y += p.y; n++; }
      t.fireAt(x / n + 250, y / n + 20); t.stepTicks(60 * 12);
      // stop on a tick just after a shot, with at least two rounds in the air
      const justFired = () => { for (const [, w] of s.weapon.entries()) if (w.lastShotTick >= s.tick - 2) return true; return false; };
      for (let k = 0; k < 900 && !(s.projectiles.count >= 2 && justFired()); k++) t.stepTicks(1);`) as () => void);
    await page.waitForTimeout(300);
    const p2 = `${outDir}/${mapKind}-${seed}-${name}-2-firing.png`;
    await page.screenshot({ path: p2 }); shots.push(p2);
    const info = await page.evaluate(new Function("const t = globalThis.__tcs, s = t.sim.state; let rounds = 0, prone = 0; for (const [, w] of s.weapon.entries()) rounds += w.magazine ? w.magazine.rounds : 0; for (const [, m] of s.soldier.entries()) if (m.posture === 'prone') prone++; return { tick: s.tick, hash: t.hash(), orders: t.orderLog.length, inFlight: s.projectiles.count, loaded: rounds, prone, tasks: s.fire.size };") as () => { tick: number; hash: string; orders: number; inFlight: number; loaded: number; prone: number; tasks: number });
    console.log(`${name}: tick ${info.tick}, orders ${info.orders}, hash ${info.hash}, bullets in flight ${info.inFlight}, rounds in weapons ${info.loaded}, men prone ${info.prone}, fire tasks ${info.tasks}, page errors: ${errors.length ? errors.join(" | ") : "none"}`);
    // Casualties (M2.3): on the open flat map the blue team fires at the red team for 4 minutes (re-aimed every 10 s); the picture looks
    // at the red team so the wounded, unconscious and dead symbols can be checked.
    await page.goto(`http://localhost:${port}/?seed=${seed}&map=flat`);
    await page.waitForFunction(new Function("return globalThis.__tcs?.ready === true") as () => boolean, null, { timeout: 20000 });
    const cas = await page.evaluate(new Function(`const t = globalThis.__tcs; t.setSpeed(0); const s = t.sim.state; t.posture("prone"); t.stepTicks(240);
      let x = 0, y = 0, n = 0;
      const find = () => { x = 0; y = 0; n = 0; for (const [id, i] of s.identity.entries()) if (i.side !== "blue") { const p = s.transform.req(id); x += p.x; y += p.y; n++; } };
      for (let k = 0; k < 24; k++) { find(); t.fireAt(x / n, y / n); t.stepTicks(60 * 10); }
      find(); t.focus(x / n, y / n, 60); t.setDebug(true); t.stepTicks(1); // Debug: the enemy as he is (casualty symbols)
      let wounded = 0, down = 0, dead = 0;
      for (const [, m] of s.soldier.entries()) { if (m.casualty === "killed") dead++; else if (m.casualty === "incapacitated") down++; else if (m.wounds.length > 0) wounded++; }
      return { wounded, down, dead };`) as () => { wounded: number; down: number; dead: number });
    await page.waitForTimeout(300);
    const p3 = `${outDir}/${mapKind}-${seed}-${name}-3-casualties.png`;
    await page.screenshot({ path: p3 }); shots.push(p3);
    // The same moment as the player sees it (fog of war: only what his men know of the enemy).
    await page.evaluate(new Function("const t = globalThis.__tcs; t.setDebug(false); t.stepTicks(1);") as () => void);
    await page.waitForTimeout(300);
    const p3b = `${outDir}/${mapKind}-${seed}-${name}-3b-fog-of-war.png`;
    await page.screenshot({ path: p3b }); shots.push(p3b);
    console.log(`${name}: after 4 minutes of fire on the flat map: ${cas.wounded} wounded and carrying on, ${cas.down} unconscious, ${cas.dead} dead`);
    // Grenade (M2.4): on the flat map one man throws a hand grenade 25 m; pictures in flight, at the burst
    // and two seconds later (cloud gone, crater left).
    await page.goto(`http://localhost:${port}/?seed=${seed}&map=flat`);
    await page.waitForFunction(new Function("return globalThis.__tcs?.ready === true") as () => boolean, null, { timeout: 20000 });
    const gr = await page.evaluate(new Function(`const t = globalThis.__tcs; t.setSpeed(0); const s = t.sim.state;
      let x = 0, y = 0, n = 0;
      for (const [id, i] of s.identity.entries()) if (i.side === "blue") { const p = s.transform.req(id); x += p.x; y += p.y; n++; }
      x /= n; y /= n; t.grenadeAt(x + 25, y); t.focus(x + 14, y, 50);
      let k = 0; for (; k < 600 && s.projectiles.count === 0; k++) t.stepTicks(1);
      t.stepTicks(50);
      return { thrownAfterTicks: k, inFlight: s.projectiles.count };`) as () => { thrownAfterTicks: number; inFlight: number });
    await page.waitForTimeout(300);
    const p4 = `${outDir}/${mapKind}-${seed}-${name}-4-grenade-flight.png`;
    await page.screenshot({ path: p4 }); shots.push(p4);
    const burst = await page.evaluate(new Function(`const t = globalThis.__tcs, s = t.sim.state;
      let k = 0; for (; k < 600 && s.terrain.craters.length === 0; k++) t.stepTicks(1);
      t.stepTicks(3);
      return { fragments: s.projectiles.count, craters: s.terrain.craters.length };`) as () => { fragments: number; craters: number });
    await page.waitForTimeout(300);
    const p5 = `${outDir}/${mapKind}-${seed}-${name}-5-grenade-burst.png`;
    await page.screenshot({ path: p5 }); shots.push(p5);
    await page.evaluate(new Function("globalThis.__tcs.stepTicks(120)") as () => void);
    await page.waitForTimeout(300);
    const p6 = `${outDir}/${mapKind}-${seed}-${name}-6-grenade-after.png`;
    await page.screenshot({ path: p6 }); shots.push(p6);
    console.log(`${name}: grenade thrown after ${gr.thrownAfterTicks} ticks (${gr.inFlight} in flight); at the burst ${burst.fragments} fragments in the air, ${burst.craters} crater(s), page errors: ${errors.length ? errors.join(" | ") : "none"}`);
    await page.close();
  }
  await browser.close();
  console.log(`Screenshots:\n${shots.join("\n")}`);
} finally {
  server.kill();
}
process.exit(0);
