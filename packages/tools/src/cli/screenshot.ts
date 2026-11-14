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
  addInitScript(f: () => void): Promise<void>;
  mouse: { move(x: number, y: number, o?: { steps?: number }): Promise<void>; down(o?: { button?: "left" | "right" }): Promise<void>; up(o?: { button?: "left" | "right" }): Promise<void> };
  keyboard: { press(key: string): Promise<void>; down(key: string): Promise<void>; up(key: string): Promise<void> };
  click(selector: string, o?: { clickCount?: number; delay?: number }): Promise<void>;
  dblclick(selector: string): Promise<void>;
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

/**
 * M7.1c vehicles (`--scene vehicles`; with the M7.2 mounted start after it): the vehicles scenario at the start (hulls at true size, facing east), a
 * Puma selected and ordered forward then back in reverse, 30 s on; the same in Debug (both sides, the tracked
 * grid with its clearance).
 */
async function vehicleScenes(page: Page, name: string, errors: string[], shots: string[]): Promise<void> {
  const map = args["map"] ?? "farmland";
  await page.goto(`http://localhost:${port}/?scenario=vehicles&seed=${seed}&map=${map}`);
  await page.waitForFunction(new Function("return globalThis.__tcs?.ready === true") as () => boolean, null, { timeout: 20000 });
  await page.evaluate(new Function(`const t = globalThis.__tcs; t.setSpeed(0); const s = t.sim.state;
    const [vid, unit] = t.vehicles()[0]; t.select(unit); const p = s.transform.get(vid); t.focus(p.x + 20, p.y, 90); t.stepTicks(1);`) as () => void);
  await page.waitForTimeout(400);
  const p0 = `${outDir}/vehicles-${seed}-${name}-0-start.png`;
  await page.screenshot({ path: p0 }); shots.push(p0);
  await page.evaluate(new Function(`const t = globalThis.__tcs; const s = t.sim.state; const [vid, unit] = t.vehicles()[0]; const p = s.transform.get(vid);
    t.planMove([{ x: p.x + 120, y: p.y - 40, mode: "drive" }, { x: p.x + 60, y: p.y - 40, mode: "reverse" }], 0); t.go(); t.stepTicks(60 * 30);
    const q = s.transform.get(vid); t.focus(q.x + 10, q.y, 120); t.stepTicks(1);`) as () => void);
  await page.waitForTimeout(400);
  const p1 = `${outDir}/vehicles-${seed}-${name}-1-after-30s.png`;
  await page.screenshot({ path: p1 }); shots.push(p1);
  await page.evaluate(new Function(`const t = globalThis.__tcs; t.setDebug(true); const s = t.sim.state; t.stepTicks(60 * 20);
    let x = 0, y = 0, n = 0; for (const [id] of s.vehicle.entries()) { const p = s.transform.get(id); x += p.x; y += p.y; n++; }
    t.focus(x / n, y / n, Math.max(300, t.sim.ctx.map.widthM * 0.6)); t.stepTicks(1);`) as () => void);
  await page.waitForTimeout(400);
  const p2 = `${outDir}/vehicles-${seed}-${name}-2-debug-overview.png`;
  await page.screenshot({ path: p2 }); shots.push(p2);
  const info = await page.evaluate(new Function("const t = globalThis.__tcs, s = t.sim.state; return { tick: s.tick, vehicles: s.vehicle.size, hash: t.hash(), orders: t.orderLog.length };") as () => object);
  console.log(`${name}: vehicles scene ${JSON.stringify(info)}, page errors: ${errors.length ? errors.join(" | ") : "none"}`);
  await mountedScenes(page, name, errors, shots);
  await gunneryScenes(page, name, errors, shots);
  await armourScenes(page, name, errors, shots);
  await antitankScenes(page, name, errors, shots);
  await missileScenes(page, name, errors, shots);
}

/**
 * M7.5a UI shell (`--scene ui`): the mounted platoon battle as it opens (nothing selected, the order bar greyed);
 * a squad got out and selected (only its relevant orders); a vehicle selected; the order bar docked left, top and
 * right; the unit list opened; the battle zoomed out to the middle distance and to the overview (labels never
 * overlap, vehicle symbols).
 */
async function uiScenes(page: Page, name: string, errors: string[], shots: string[]): Promise<void> {
  const shot = async (label: string) => { await page.waitForTimeout(350); const p = `${outDir}/ui-${seed}-${name}-${label}.png`; await page.screenshot({ path: p }); shots.push(p); };
  await page.goto(`http://localhost:${port}/?seed=${seed}&map=${args["map"] ?? "village"}`);
  await page.waitForFunction(new Function("return globalThis.__tcs?.ready === true") as () => boolean, null, { timeout: 20000 });
  await page.evaluate(new Function("const t = globalThis.__tcs; t.setSpeed(0); t.stepTicks(1);") as () => void);
  await shot("0-nothing-selected");
  // A squad: the first squad of the first platoon gets out, 20 s on; then selected, the view on it.
  const sq = await page.evaluate(new Function(`const t = globalThis.__tcs, s = t.sim.state;
    const sq = t.units().find((u) => u.kind === "infantry" && u.depth === 1); t.select(sq.unit); t.dismount(); t.stepTicks(60 * 20);
    t.select(null); t.select(sq.unit); const u = s.unit.get(sq.unit); let x = 0, y = 0, n = 0;
    for (const m of u.members) { const p = s.transform.get(m); x += p.x; y += p.y; n++; } t.focus(x / n, y / n, 140); t.stepTicks(1);
    return { unit: sq.unit, set: t.orderSet() };`) as () => object);
  await shot("1-squad-selected");
  await page.evaluate(new Function(`const t = globalThis.__tcs, s = t.sim.state; const [vid, unit] = t.vehicles()[0]; t.select(unit); const p = s.transform.get(vid); t.focus(p.x, p.y, 140); t.stepTicks(1);`) as () => void);
  await shot("2-vehicle-selected");
  const veh = await page.evaluate(new Function("return globalThis.__tcs.orderSet();") as () => object);
  for (const e of ["left", "top", "right"]) {
    await page.evaluate(new Function(`const t = globalThis.__tcs; t.dock("${e}"); t.select(${JSON.stringify((sq as { unit: number }).unit)}); t.stepTicks(1);`) as () => void);
    await shot(`3-dock-${e}`);
  }
  await page.evaluate(new Function(`const t = globalThis.__tcs; t.dock(innerWidth > innerHeight ? "right" : "bottom"); t.expandSidebar(true); t.stepTicks(1);`) as () => void);
  await shot("4-sidebar-expanded");
  // Zoomed out over the whole own force: the middle distance (hulls and leaders, labels placed without overlaps)
  // and the overview (symbols).
  const ins = await page.evaluate(new Function(`const t = globalThis.__tcs, s = t.sim.state; t.expandSidebar(false);
    // The first platoon gets out (its squads beside their Pumas), the second stays aboard.
    t.select(t.units()[0].unit); t.dismount(); t.select(null); t.stepTicks(60 * 40);
    let x = 0, y = 0, n = 0; for (const [id, v] of s.vehicle.entries()) if (v.side === "blue") { const p = s.transform.get(id); x += p.x; y += p.y; n++; }
    globalThis.__c = { x: x / n, y: y / n }; t.focus(x / n, y / n, 450); t.stepTicks(1); return t.insets();`) as () => object);
  await shot("5-mid-distance");
  await page.evaluate(new Function(`const t = globalThis.__tcs; t.focus(globalThis.__c.x, globalThis.__c.y, 2600); t.stepTicks(1);`) as () => void);
  await shot("6-overview");
  console.log(`${name}: ui scene squad ${JSON.stringify(sq)}; vehicle ${JSON.stringify(veh)}; insets ${JSON.stringify(ins)}; page errors: ${errors.length ? errors.join(" | ") : "none"}`);
}

/**
 * The photo map (`--scene photo`, plan "photo" step "ground"): photo against flat at four zooms — far (the whole
 * map), middle (dots), the figure zoom and close up — on the village, farmland, woodland, industrial and flat maps
 * (`--map` picks one). Each shot waits until the terrain tiles are painted and uploaded (`__tcs.tilesPending()`).
 */
async function photoScenes(page: Page, name: string, errors: string[], shots: string[]): Promise<void> {
  const maps = args["map"] ? [mapKind] : ["village", "farmland", "woodland", "industrial", "flat"];
  // The container has 4 cores; the desktop shots stand for a desktop with more (the 8 px/m level, step "vegetation").
  if (name === "desktop") await page.addInitScript(new Function("Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });") as () => void);
  const settle = async () => {
    await page.waitForFunction(new Function("const t = globalThis.__tcs; return t.tilesPending() === 0") as () => boolean, null, { timeout: 30000 });
    await page.waitForTimeout(400); // the fade-in
  };
  const info: string[] = [];
  for (const map of maps) for (const lk of ["photo", "flat"]) {
    await page.goto(`http://localhost:${port}/?seed=${seed}&map=${map}&look=${lk}`);
    await page.waitForFunction(new Function("return globalThis.__tcs?.ready === true") as () => boolean, null, { timeout: 30000 });
    await page.evaluate(new Function("const t = globalThis.__tcs; t.setSpeed(0); t.stepTicks(1);") as () => void);
    const t0 = Date.now();
    await settle();
    info.push(`${map}/${lk} opening settled ${Date.now() - t0} ms, level ${await page.evaluate(new Function("return globalThis.__tcs.terrainLevel()") as () => number)}`);
    for (const [label, sc] of [["far", 0.01], ["mid", 2.2], ["figure", name === "phone" ? 7 : 9], ["close", 18]] as const) {
      await page.evaluate(new Function(`const t = globalThis.__tcs, s = t.sim.state; let x = 0, y = 0, n = 0;
        for (const [id, i] of s.identity.entries()) if (i.side === "blue") { const p = s.transform.get(id); x += p.x; y += p.y; n++; }
        const m = t.sim.ctx.map; x /= n; y /= n; x = (x * 2 + m.widthM / 2) / 3; y = (y * 2 + m.heightM / 2) / 3;
        t.focusScale(x, y, ${sc}); t.stepTicks(1);`) as () => void);
      await settle();
      const p = `${outDir}/photo-${seed}-${name}-${map}-${label}-${lk}.png`;
      await page.screenshot({ path: p }); shots.push(p);
    }
    // Vegetation at the figure zoom (step "vegetation"): a hedge and a wood's east edge near the middle of the map.
    // Step "built": a road junction, a bridge (road over a stream) and a wall corner near the middle of the map.
    // And the buildings nearest the middle with their roofs (figure zoom) and with the roofs faded (close zoom).
    for (const what of ["hedge", "woodedge", "junction", "bridge", "wall", "houses", "houses-close"] as const) {
      const ok = await page.evaluate(new Function(`const t = globalThis.__tcs, m = t.sim.ctx.map, cx = m.widthM / 2, cy = m.heightM / 2;
        let bx = -1, by = -1, bd = Infinity;
        if (${JSON.stringify(what)} === "hedge") {
          for (const o of m.obstacles) if (o.kind === "hedge") for (let k = 0; k + 3 < o.points.length; k += 2) {
            const x = (o.points[k] + o.points[k + 2]) / 2, y = (o.points[k + 1] + o.points[k + 3]) / 2, d = Math.hypot(x - cx, y - cy);
            if (d < bd) { bd = d; bx = x; by = y; }
          }
        } else if (${JSON.stringify(what)}.startsWith("houses")) {
          for (const b of m.buildings) { const f = b.footprint; let x = 0, y = 0; for (let k = 0; k < f.length; k += 2) { x += f[k] / (f.length / 2); y += f[k + 1] / (f.length / 2); }
            const d = Math.hypot(x - cx, y - cy) + (b.interior ? 0 : 30); if (d < bd) { bd = d; bx = x; by = y; } }
        } else if (${JSON.stringify(what)} === "junction" || ${JSON.stringify(what)} === "bridge" || ${JSON.stringify(what)} === "wall") {
          const pd = (p, x, y) => { let b = Infinity; for (let k = 0; k + 3 < p.length; k += 2) { const ax = p[k], ay = p[k + 1], ex = p[k + 2] - ax, ey = p[k + 3] - ay, L2 = ex * ex + ey * ey || 1e-9;
            const u = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / L2)); b = Math.min(b, Math.hypot(x - ax - u * ex, y - ay - u * ey)); } return b; };
          const cand = [];
          if (${JSON.stringify(what)} === "junction") { for (const r of m.roads) for (const e of [0, r.points.length - 2]) if (m.roads.some((q) => q !== r && pd(q.points, r.points[e], r.points[e + 1]) < 1)) cand.push([r.points[e], r.points[e + 1]]); }
          else if (${JSON.stringify(what)} === "bridge") { for (const r of m.roads) for (const w of m.water) if (w.kind === "stream") for (let k = 0; k < r.points.length; k += 2) if (pd(w.points, r.points[k], r.points[k + 1]) < 0.6) cand.push([r.points[k], r.points[k + 1]]);
            for (const r of m.roads) for (const w of m.water) if (w.kind === "stream") for (let k = 0; k + 3 < r.points.length; k += 2) for (let f = 0; f <= 1; f += 0.02) { const x = r.points[k] + (r.points[k + 2] - r.points[k]) * f, y = r.points[k + 1] + (r.points[k + 3] - r.points[k + 1]) * f; if (pd(w.points, x, y) < 0.8) cand.push([x, y]); } }
          else for (const o of m.obstacles) if (o.kind.endsWith("-wall")) for (let k = 2; k + 3 < o.points.length; k += 2) cand.push([o.points[k], o.points[k + 1]]);
          for (const [x, y] of cand) { const d = Math.hypot(x - cx, y - cy); if (d < bd) { bd = d; bx = x; by = y; } }
        } else {
          const w = m.vegetationPalette.indexOf("woodland") + 1;
          for (let k = 0; k < m.cols * m.rows - 1; k++) if (w > 0 && m.vegetation[k] === w && m.vegetation[k + 1] === 0 && m.vegetation[k + 2] === 0 && m.vegetation[k + 3] === 0 && m.surface[k + 2] === m.surface[k + 3]) {
            const x = (k % m.cols + 1) * m.cellSizeM, y = (Math.floor(k / m.cols) + 0.5) * m.cellSizeM, d = Math.hypot(x - cx, y - cy);
            if (d < bd) { bd = d; bx = x; by = y; }
          }
        }
        if (bx < 0) return false;
        t.focusScale(bx, by, ${JSON.stringify(what)} === "houses-close" ? 18 : ${name === "phone" ? 7 : 9}); t.stepTicks(1); return true;`) as () => boolean);
      if (!ok) continue;
      await settle();
      const p = `${outDir}/photo-${seed}-${name}-${map}-${what}-${lk}.png`;
      await page.screenshot({ path: p }); shots.push(p);
    }
  }
  // Step "polish": men on foot on each map in the photo look — the lead squad selected and ordered 80 m on (its route
  // line), at the dots zoom and close up (contact shadows, rims, labels, overlays), and the far view (symbols, veil).
  for (const map of maps) {
    await page.goto(`http://localhost:${port}/?seed=${seed}&map=${map}&vehicles=0&look=photo`);
    await page.waitForFunction(new Function("return globalThis.__tcs?.ready === true") as () => boolean, null, { timeout: 30000 });
    await page.evaluate(new Function(`const t = globalThis.__tcs, s = t.sim.state; t.setSpeed(0); t.stepTicks(1);
      const sq = t.units().find((u) => u.kind === "infantry"); t.select(sq.unit);
      let x = 0, y = 0, n = 0; for (const m of s.unit.get(sq.unit).members) { const p = s.transform.get(m); x += p.x; y += p.y; n++; } x /= n; y /= n;
      const m = t.sim.ctx.map; const dx = x < m.widthM / 2 ? 80 : -80; t.tap(x + dx, y + 20); t.stepTicks(60 * 20);
      const lead = s.unit.get(sq.unit).leader, p = s.transform.get(lead ?? s.unit.get(sq.unit).members[0]);
      globalThis.__sq = { x: p.x, y: p.y };`) as () => void);
    for (const [label, sc, sel] of [["dots", 3, true], ["close", name === "phone" ? 16 : 20, true], ["close-unselected", name === "phone" ? 16 : 20, false], ["far", 0.01, true]] as const) {
      await page.evaluate(new Function(`const t = globalThis.__tcs, q = globalThis.__sq; ${sel ? "" : "t.select(null);"} t.focusScale(q.x, q.y, ${sc}); t.stepTicks(1);`) as () => void);
      await settle();
      const p = `${outDir}/photo-${seed}-${name}-${map}-units-${label}.png`;
      await page.screenshot({ path: p }); shots.push(p);
    }
  }
  console.log(`${name}: photo scene ${info.join("; ")}; page errors: ${errors.length ? errors.join(" | ") : "none"}`);
}

/**
 * M7.5b look (`--scene look`): the photo look (`&look=photo`, step "polish"), the flat pixel look (`&look=flat`) and the classic one (`&look=classic`) where a set helps —
 * the opening view (zoomed in on the lead squad), the middle distance (dots), the far view (symbols, the map
 * fitted to the free area), a squad firing close up; wounded, down, dead and surrendered men close up; a roof shown,
 * faded when zoomed in close, and faded beside the men; the village and the farmland at the middle distance.
 */
async function lookScenes(page: Page, name: string, errors: string[], shots: string[]): Promise<void> {
  const shot = async (label: string) => { await page.waitForTimeout(450); const p = `${outDir}/look-${seed}-${name}-${label}.png`; await page.screenshot({ path: p }); shots.push(p); };
  const open = async (q: string) => {
    await page.goto(`http://localhost:${port}/?seed=${seed}${q}`);
    await page.waitForFunction(new Function("return globalThis.__tcs?.ready === true") as () => boolean, null, { timeout: 30000 });
    await page.evaluate(new Function("const t = globalThis.__tcs; t.setSpeed(0); t.stepTicks(1);") as () => void);
  };
  const centre = `const own = (side) => { let x = 0, y = 0, n = 0; for (const [id, i] of s.identity.entries()) if (i.side === side) { const p = s.transform.get(id); x += p.x; y += p.y; n++; } return { x: x / n, y: y / n }; };`;
  for (const lk of ["classic", "flat", "photo"]) {
    const q = `&map=village&look=${lk}`;
    await open(q);
    await shot(`0-opening-${lk}`);
    await page.evaluate(new Function(`const t = globalThis.__tcs, s = t.sim.state; ${centre} const c = own("blue"); t.focusScale(c.x, c.y, 2.5); t.stepTicks(1);`) as () => void);
    await shot(`1-mid-${lk}`);
    await page.evaluate(new Function(`const t = globalThis.__tcs, s = t.sim.state; ${centre} const c = own("blue"); t.focusScale(c.x, c.y, 0.01); t.stepTicks(1);`) as () => void);
    await shot(`2-far-${lk}`);
    // A squad on foot firing, close up: the platoon battle on foot, the first squad fires east.
    await open(`&map=village&vehicles=0&look=${lk}`);
    await page.evaluate(new Function(`const t = globalThis.__tcs, s = t.sim.state;
      const sq = t.units().find((u) => u.kind === "infantry"); t.select(sq.unit);
      let x = 0, y = 0, n = 0; for (const m of s.unit.get(sq.unit).members) { const p = s.transform.get(m); x += p.x; y += p.y; n++; } x /= n; y /= n;
      t.fireAt(x + 250, y + 30); t.stepTicks(60 * 8);
      const justFired = () => { for (const [id, w] of s.weapon.entries()) if (s.identity.get(id)?.unit === sq.unit && w.lastShotTick >= s.tick - 2) return true; return false; };
      for (let k = 0; k < 900 && !justFired(); k++) t.stepTicks(1);
      x = 0; y = 0; n = 0; for (const m of s.unit.get(sq.unit).members) { const p = s.transform.get(m); x += p.x; y += p.y; n++; }
      t.focusScale(x / n, y / n, ${name === "phone" ? 9 : 12.8}); t.stepTicks(1);`) as () => void);
    await shot(`3-firing-close-${lk}`);
  }
  // Casualties close up: the platoon battle on foot, Russia attacking, until the player's own side has a man
  // wounded but fighting, a man down, a dead man and (if it comes to it) one who surrendered.
  await open("&map=village&vehicles=0&attacker=red&limit=1200");
  const cas = await page.evaluate(new Function(`const t = globalThis.__tcs, s = t.sim.state;
    const find = () => { const r = { wounded: null, down: null, dead: null, surrendered: null };
      for (const [id, x] of s.soldier.entries()) {
        if (x.mount !== undefined || s.identity.get(id).side !== "blue") continue;
        if (x.captive && !r.surrendered) r.surrendered = id;
        else if (x.casualty === "killed" && !r.dead) r.dead = id;
        else if (x.casualty === "incapacitated" && !r.down) r.down = id;
        else if (x.casualty === "none" && !x.captive && x.wounds.some((w) => w.mechanism !== "blunt") && !r.wounded) r.wounded = id;
      } return r; };
    let r = find();
    for (let k = 0; k < 80 && !(r.surrendered && r.down && r.dead && r.wounded); k++) { t.stepTicks(60 * 10); r = find(); }
    globalThis.__cas = r; return { tick: s.tick, ...r };`) as () => object);
  for (const k of ["surrendered", "down", "wounded", "dead"]) {
    const ok = await page.evaluate(new Function(`const t = globalThis.__tcs, s = t.sim.state, id = globalThis.__cas["${k}"]; if (id === null) return false;
      const p = s.transform.get(id); t.focusScale(p.x, p.y, 16); t.stepTicks(1); return true;`) as () => boolean);
    if (ok) await shot(`4-casualty-${k}`);
  }
  // Roofs: the building nearest the lead squad at the figure zoom (roof shown), zoomed in close (faded), then the
  // squad walked up to it (faded beside the men, shown elsewhere).
  await open("&map=village&vehicles=0");
  const roof = await page.evaluate(new Function(`const t = globalThis.__tcs, s = t.sim.state, map = t.sim.ctx.map;
    const sq = t.units().find((u) => u.kind === "infantry"); t.select(sq.unit);
    let x = 0, y = 0, n = 0; for (const m of s.unit.get(sq.unit).members) { const p = s.transform.get(m); x += p.x; y += p.y; n++; } x /= n; y /= n;
    let best = 0, bd = Infinity; map.buildings.forEach((b, i) => { const bx = b.footprint[0], by = b.footprint[1]; const d = (bx - x) ** 2 + (by - y) ** 2; if (d < bd && b.footprint.length === 8 && (b.kind === "house" || b.kind === "farmhouse")) { bd = d; best = i; } });
    const b = map.buildings[best]; let cx = 0, cy = 0; for (let k = 0; k < 8; k += 2) { cx += b.footprint[k] / 4; cy += b.footprint[k + 1] / 4; }
    globalThis.__b = { i: best, cx, cy, door: b.openings.find((o) => o.kind === "door"), fp: b.footprint };
    t.focusScale(cx, cy, 7); t.stepTicks(20); return { building: best, dist: Math.sqrt(bd), alpha: t.roofAlpha(best) };`) as () => object);
  await shot("5-roof-shown");
  await page.evaluate(new Function(`const t = globalThis.__tcs, b = globalThis.__b; t.focusScale(b.cx, b.cy, 18); t.stepTicks(20);`) as () => void);
  await shot("6-roof-faded-close");
  const near = await page.evaluate(new Function(`const t = globalThis.__tcs, s = t.sim.state, b = globalThis.__b;
    // Walk the squad to a point 4 m outside the middle of the building's front wall.
    const ax = b.fp[0], ay = b.fp[1], bx = b.fp[2], by = b.fp[3], L = Math.hypot(bx - ax, by - ay);
    let nx = -(by - ay) / L, ny = (bx - ax) / L; if ((b.cx - ax) * nx + (b.cy - ay) * ny > 0) { nx = -nx; ny = -ny; }
    t.tap((ax + bx) / 2 + nx * 4, (ay + by) / 2 + ny * 4); t.stepTicks(60 * 5);
    const sq = t.units().find((u) => u.kind === "infantry"), men = s.unit.get(sq.unit).members;
    for (let k = 0; k < 60 && men.some((m) => (s.mover.get(m)?.waypoints.length ?? 0) > 0); k++) t.stepTicks(60 * 5);
    t.focusScale(b.cx, b.cy, 7); t.stepTicks(20); return { alpha: t.roofAlpha(b.i) };`) as () => object);
  await shot("7-roof-faded-men-beside");
  // The village and the farmland at the middle distance (the flat pixel map, contour lines).
  for (const map of ["village", "farmland"]) {
    await open(`&map=${map}`);
    await page.evaluate(new Function(`const t = globalThis.__tcs, s = t.sim.state; ${centre} const c = own("blue"); const m = t.sim.ctx.map; t.focusScale((c.x + m.widthM / 2) / 2, (c.y + m.heightM / 2) / 2, 1.6); t.stepTicks(1);`) as () => void);
    await shot(`8-${map}-mid`);
    await page.evaluate(new Function(`const t = globalThis.__tcs, s = t.sim.state; ${centre} const c = own("blue"); const m = t.sim.ctx.map; t.focusScale((c.x + m.widthM / 2) / 2, (c.y + m.heightM / 2) / 2, 5.5); t.stepTicks(30);`) as () => void);
    await shot(`9-${map}-figure`);
  }
  // The sprite sheet: every frame of both sides, the weapon variants and the 16 facings.
  await page.evaluate(new Function("globalThis.__tcs.showSprites(true);") as () => void);
  await shot("10-sprite-sheet");
  console.log(`${name}: look scene casualties ${JSON.stringify(cas)}; roof ${JSON.stringify(roof)} -> ${JSON.stringify(near)}; page errors: ${errors.length ? errors.join(" | ") : "none"}`);
}

/**
 * M7.5c interiors (`--scene interiors`): the platoon battle on foot on the village; the lead squad is ordered into
 * the nearest house with two or more rooms (a tap in its back room): the men in the rooms, the roof faded, inner
 * walls, doorways and stairs; the same with Debug (the interior graph); then ordered out to a point in front of the
 * door: leaving through the door, and outside.
 */
async function interiorScenes(page: Page, name: string, errors: string[], shots: string[]): Promise<void> {
  const shot = async (label: string) => { await page.waitForTimeout(450); const p = `${outDir}/interiors-${seed}-${name}-${label}.png`; await page.screenshot({ path: p }); shots.push(p); };
  await page.goto(`http://localhost:${port}/?seed=${seed}&map=village&vehicles=0`);
  await page.waitForFunction(new Function("return globalThis.__tcs?.ready === true") as () => boolean, null, { timeout: 30000 });
  const zoom = name === "phone" ? 20 : 26;
  const into = await page.evaluate(new Function(`const t = globalThis.__tcs, s = t.sim.state, map = t.sim.ctx.map; t.setSpeed(0);
    const sq = t.units().find((u) => u.kind === "infantry"); t.select(sq.unit);
    const men = s.unit.get(sq.unit).members;
    let x = 0, y = 0; for (const m of men) { const p = s.transform.get(m); x += p.x / men.length; y += p.y / men.length; }
    let best = -1, bd = Infinity;
    map.buildings.forEach((b, i) => { if (!b.interior || (b.kind !== "house" && b.kind !== "farmhouse") || b.interior.rooms.filter((r) => r.floor === 0).length < 3) return; const d = Math.hypot(b.footprint[0] - x, b.footprint[1] - y); if (d < bd) { bd = d; best = i; } });
    const b = map.buildings[best]; let cx = 0, cy = 0; for (let k = 0; k < 8; k += 2) { cx += b.footprint[k] / 4; cy += b.footprint[k + 1] / 4; }
    // The ground-floor room farthest from the front door.
    const door = b.openings.find((o) => o.kind === "door"); const fx = b.footprint[0] + (b.footprint[2] - b.footprint[0]) * door.offsetM / Math.hypot(b.footprint[2] - b.footprint[0], b.footprint[3] - b.footprint[1]);
    const fy = b.footprint[1] + (b.footprint[3] - b.footprint[1]) * door.offsetM / Math.hypot(b.footprint[2] - b.footprint[0], b.footprint[3] - b.footprint[1]);
    let tx = cx, ty = cy, far = -1;
    for (const r of b.interior.rooms) { if (r.floor !== 0) continue; let rx = 0, ry = 0; for (let k = 0; k < 8; k += 2) { rx += r.poly[k] / 4; ry += r.poly[k + 1] / 4; } const d = Math.hypot(rx - fx, ry - fy); if (d > far) { far = d; tx = rx; ty = ry; } }
    globalThis.__h = { i: best, cx, cy, fx, fy, nx: cx - fx, ny: cy - fy };
    t.tap(tx, ty);
    for (let k = 0; k < 90 && (k < 2 || men.some((m) => (s.mover.get(m)?.waypoints.length ?? 0) > 0)); k++) t.stepTicks(60 * 5);
    t.stepTicks(60 * 3);
    t.focusScale(cx, cy, ${zoom}); t.stepTicks(20);
    const inside = men.filter((m) => { const p = s.transform.get(m); return b.footprint && t.sim.ctx.map.buildings[best] && (function () { let c = false; const f = b.footprint; for (let a = 0, e = 3; a < 4; e = a++) { const ax = f[2*a], ay = f[2*a+1], ex = f[2*e], ey = f[2*e+1]; if ((ay > p.y) !== (ey > p.y) && p.x < ((ex - ax) * (p.y - ay)) / (ey - ay) + ax) c = !c; } return c; })(); }).length;
    return { building: best, kind: b.kind, rooms: b.interior.rooms.length, dist: Math.round(bd), inside, men: men.length, roof: t.roofAlpha(best), tick: s.tick };`) as () => object);
  await shot("0-squad-in-house");
  await page.evaluate(new Function(`const t = globalThis.__tcs, h = globalThis.__h; t.setDebug(true); t.focusScale(h.cx, h.cy, ${zoom}); t.stepTicks(2);`) as () => void);
  await shot("1-debug-graph");
  await page.evaluate(new Function(`const t = globalThis.__tcs, h = globalThis.__h; t.setDebug(false); const L = Math.hypot(h.nx, h.ny) || 1;
    t.tap(h.fx - h.nx / L * 20, h.fy - h.ny / L * 20); t.stepTicks(60 * 6); t.focusScale(h.cx, h.cy, ${zoom}); t.stepTicks(1);`) as () => void);
  await shot("2-leaving-by-the-door");
  const out = await page.evaluate(new Function(`const t = globalThis.__tcs, s = t.sim.state, h = globalThis.__h; const sq = t.units().find((u) => u.kind === "infantry"), men = s.unit.get(sq.unit).members;
    for (let k = 0; k < 30 && men.some((m) => (s.mover.get(m)?.waypoints.length ?? 0) > 0); k++) t.stepTicks(60 * 5);
    t.focusScale(h.fx, h.fy, ${zoom * 0.6}); t.stepTicks(20); return { tick: s.tick, roof: t.roofAlpha(h.i) };`) as () => object);
  await shot("3-outside");
  console.log(`${name}: interiors scene ${JSON.stringify(into)} -> ${JSON.stringify(out)}; page errors: ${errors.length ? errors.join(" | ") : "none"}`);
}

/**
 * M7.4b anti-tank and crew reactions (`--scene vehicles`, fifth part): the platoon battle, Russia attacking mounted
 * against the German Pumas, Debug on (both sides shown): the rocket of the first man firing a Panzerfaust or an
 * RPG at a vehicle, in flight; then, in the vehicles scenario with every vehicle firing at the nearest enemy hull,
 * the first crew that reverses out under fire, its smoke screen in front of it.
 */
async function antitankScenes(page: Page, name: string, errors: string[], shots: string[]): Promise<void> {
  await page.goto(`http://localhost:${port}/?scenario=platoon&seed=${seed}&map=${args["map"] ?? "farmland"}&attacker=red&side=blue`);
  await page.waitForFunction(new Function("return globalThis.__tcs?.ready === true") as () => boolean, null, { timeout: 20000 });
  const found = await page.evaluate(new Function(`const t = globalThis.__tcs; t.setSpeed(0); t.setDebug(true); const s = t.sim.state;
    for (let k = 0; k < 1800; k++) { t.stepTicks(30); for (const [id, a] of s.action.entries()) if (a.kind === "fireLauncher") {
      const p = s.transform.get(id), x = Number(a.params.x), y = Number(a.params.y);
      // (A shot at a vehicle that is really there, both in the picture.)
      let v = null, vd = 1e9; for (const [vid, w] of s.vehicle.entries()) { const q = s.transform.get(vid); const d = Math.hypot(q.x - x, q.y - y); if (w.status !== "destroyed" && d < vd) { vd = d; v = q; } }
      if (!v || vd > 40) continue;
      t.stepTicks(Math.max(1, a.startTick + a.durationTicks - s.tick + 40)); t.focus((p.x + v.x) / 2, (p.y + v.y) / 2, Math.max(140, Math.hypot(v.x - p.x, v.y - p.y) + 80)); t.stepTicks(1);
      return { man: id, x, y, tick: s.tick, vehicleOff: vd }; } }
    return null;`) as () => object | null);
  await page.waitForTimeout(400);
  const t0 = `${outDir}/antitank-${seed}-${name}-0-rocket.png`;
  await page.screenshot({ path: t0 }); shots.push(t0);
  // Reversing out: the vehicles scenario, every own vehicle firing at the nearest enemy hull until a crew backs off.
  await page.goto(`http://localhost:${port}/?scenario=vehicles&seed=${seed}&map=${args["map"] ?? "farmland"}`);
  await page.waitForFunction(new Function("return globalThis.__tcs?.ready === true") as () => boolean, null, { timeout: 20000 });
  const rev = await page.evaluate(new Function(`const t = globalThis.__tcs; const s = t.sim.state; t.setSpeed(0); t.setDebug(true); t.stepTicks(60 * 20);
    const fire = () => { for (const [vid, unit] of t.vehicles()) { const me = s.transform.get(vid); let best = null, bd = 1e9;
      for (const [id, v] of s.vehicle.entries()) { if (v.side === s.vehicle.get(vid).side || v.status !== "ok") continue; const q = s.transform.get(id); const d = Math.hypot(q.x - me.x, q.y - me.y); if (d < bd) { bd = d; best = q; } }
      if (best) { t.select(unit); t.fireNature(best.x, best.y, "ap"); } }
      // ... and the squads on foot fire their Panzerfausts at it ("Anti-tank").
      for (const [uid, u] of s.unit.entries()) { if (u.side !== "blue" || u.vehicle !== undefined || u.parent === null) continue; const m = s.transform.get(u.members[0]); if (!m) continue;
        let best = null, bd = 1e9; for (const [id, v] of s.vehicle.entries()) { if (v.side === "blue" || v.status !== "ok") continue; const q = s.transform.get(id); const d = Math.hypot(q.x - m.x, q.y - m.y); if (d < bd) { bd = d; best = q; } }
        if (best) { t.select(uid); t.fireNature(best.x, best.y, "at"); } } };
    for (let k = 0; k < 1500; k++) { if (k % 10 === 0) fire(); t.stepTicks(30); for (const [id, v] of s.vehicle.entries()) if (v.crewReaction === "reverseOut" && s.tick - v.reactionTick < 240) {
      t.stepTicks(60 * 3); const p = s.transform.get(id); t.focus(p.x, p.y, 140); t.stepTicks(1); return { vehicle: id, why: v.reactionWhy, smoke: s.smoke.length, tick: s.tick }; } }
    return { none: [...s.vehicle.values()].map((v) => [v.side, v.status, v.crewReaction, v.lastPenTick]), tick: s.tick };`) as () => object | null);
  await page.waitForTimeout(400);
  const t1 = `${outDir}/antitank-${seed}-${name}-1-reversing-out.png`;
  await page.screenshot({ path: t1 }); shots.push(t1);
  console.log(`${name}: anti-tank scene ${JSON.stringify(found)}; reversing out ${JSON.stringify(rev)}, page errors: ${errors.length ? errors.join(" | ") : "none"}`);
}

/**
 * Guided missile (`--scene vehicles`, sixth part, or `--scene missile` alone; owner 2026-11-13): the mounted
 * platoon battle with Russia attacking; the first 9M113M a BMP-2 fires on its own, halfway (the wire back to the
 * launcher, the motor's flare, its smoke trail), then the hit.
 */
async function missileScenes(page: Page, name: string, errors: string[], shots: string[]): Promise<void> {
  // The mounted platoon battle, Russia attacking on farmland, both sides AI-driven, Debug on (both sides shown):
  // the first missile a BMP-2 fires on its own.
  await page.goto(`http://localhost:${port}/?scenario=platoon&seed=${seed}&map=${args["map"] ?? "farmland"}&attacker=red&side=blue`);
  await page.waitForFunction(new Function("return globalThis.__tcs?.ready === true") as () => boolean, null, { timeout: 20000 });
  const found = await page.evaluate(new Function(`const t = globalThis.__tcs; t.setSpeed(0); t.setDebug(true); const s = t.sim.state;
    for (let i = 0; i < 60 * 900; i++) { t.stepTicks(1);
      for (const [vid, v] of s.vehicle.entries()) { const g = v.stations[0] && v.stations[0].guide; if (!g || s.tick - g.launchTick < 30 || g.target < 0) continue;
        const tg = s.transform.get(g.target), me = s.transform.get(vid); const d = Math.hypot(tg.x - me.x, tg.y - me.y);
        t.stepTicks(Math.max(1, Math.round((d / 2 / 180) * 60) - 30)); t.focus((tg.x + me.x) / 2, (tg.y + me.y) / 2, d + 120); t.stepTicks(1);
        return { vehicle: vid, target: g.target, rangeM: Math.round(d), tick: s.tick }; } }
    return null;`) as () => object | null);
  await page.waitForTimeout(400);
  const m0 = `${outDir}/missile-${seed}-${name}-0-in-flight.png`;
  await page.screenshot({ path: m0 }); shots.push(m0);
  const end = await page.evaluate(new Function(`const t = globalThis.__tcs; const s = t.sim.state; let r = null;
    for (let i = 0; i < 900 && r === null; i++) { t.stepTicks(1); for (const [vid, v] of s.vehicle.entries()) if (v.side === "blue" && v.lastHitTick >= s.tick - 1) { r = vid; break; } }
    if (r !== null) { t.stepTicks(6); const p = s.transform.get(r); t.focus(p.x, p.y, 60); t.stepTicks(1); }
    return r === null ? null : { vehicle: r, status: s.vehicle.get(r).status, tick: s.tick };`) as () => object | null);
  await page.waitForTimeout(400);
  const m1 = `${outDir}/missile-${seed}-${name}-1-hit.png`;
  await page.screenshot({ path: m1 }); shots.push(m1);
  console.log(`${name}: missile scene ${JSON.stringify(found)} -> ${JSON.stringify(end)}, page errors: ${errors.length ? errors.join(" | ") : "none"}`);
}

/**
 * M7.2 mounted start (`--scene vehicles`, second part): the platoon battle with `&vehicles=1` — the attacking
 * platoons aboard their Pumas at the map edge ("+n" by each hull, the first Puma selected); that Puma driven
 * 150 m forward; its squad selected by tapping the hull again (the order bar offers Dismount) and ordered out.
 */
async function mountedScenes(page: Page, name: string, errors: string[], shots: string[]): Promise<void> {
  await page.goto(`http://localhost:${port}/?scenario=platoon&seed=${seed}&map=${args["map"] ?? "village"}`);
  await page.waitForFunction(new Function("return globalThis.__tcs?.ready === true") as () => boolean, null, { timeout: 20000 });
  await page.evaluate(new Function(`const t = globalThis.__tcs; t.setSpeed(0); const s = t.sim.state;
    const [vid, unit] = t.vehicles()[0]; t.select(unit); const p = s.transform.get(vid); t.focus(p.x + 30, p.y, 160); t.stepTicks(1);`) as () => void);
  await page.waitForTimeout(400);
  const m0 = `${outDir}/mounted-${seed}-${name}-0-start.png`;
  await page.screenshot({ path: m0 }); shots.push(m0);
  await page.evaluate(new Function(`const t = globalThis.__tcs; const s = t.sim.state; const [vid] = t.vehicles()[0]; const p = s.transform.get(vid);
    t.planMove([{ x: p.x + 150, y: p.y, mode: "drive" }], 0); t.go(); t.stepTicks(60 * 25);
    const q = s.transform.get(vid); t.focus(q.x, q.y, 90); t.stepTicks(1);`) as () => void);
  await page.waitForTimeout(400);
  const m1 = `${outDir}/mounted-${seed}-${name}-1-driven.png`;
  await page.screenshot({ path: m1 }); shots.push(m1);
  await page.evaluate(new Function(`const t = globalThis.__tcs; const s = t.sim.state; const [vid, unit] = t.vehicles()[0];
    const r = t.riders(unit); if (r.length > 0) t.select(r[0]); t.stepTicks(1);`) as () => void);
  await page.waitForTimeout(300);
  const m2 = `${outDir}/mounted-${seed}-${name}-2-squad-selected.png`;
  await page.screenshot({ path: m2 }); shots.push(m2);
  await page.evaluate(new Function(`const t = globalThis.__tcs; t.dismount(); t.stepTicks(60 * 16); t.stepTicks(1);`) as () => void);
  await page.waitForTimeout(400);
  const m3 = `${outDir}/mounted-${seed}-${name}-3-dismounted.png`;
  await page.screenshot({ path: m3 }); shots.push(m3);
  const info = await page.evaluate(new Function("const t = globalThis.__tcs, s = t.sim.state; let aboard = 0; for (const [, x] of s.soldier.entries()) if (x.mount) aboard++; return { tick: s.tick, vehicles: s.vehicle.size, aboard, hash: t.hash(), orders: t.orderLog.length };") as () => object);
  console.log(`${name}: mounted scene ${JSON.stringify(info)}, page errors: ${errors.length ? errors.join(" | ") : "none"}`);
}

/**
 * M7.3 gunnery (`--scene vehicles`, third part): the vehicles scenario; the first Puma ordered to fire
 * armour-piercing at the nearest enemy vehicle (its turret turns, tracers fly, sparks on the hull); the enemy
 * vehicles under fog of war as hull outlines; the same with Debug (the station's target line and reasons); then a
 * smoke screen.
 */
/**
 * M7.4a armour (`--scene vehicles`, fourth part): the vehicles scenario with Debug (everything shown); every own
 * vehicle ordered to fire armour-piercing at the nearest enemy vehicle until one is knocked out: the hit vehicle
 * (penetration flash, burning); then two and a half minutes later the burnt-out wreck.
 */
async function armourScenes(page: Page, name: string, errors: string[], shots: string[]): Promise<void> {
  await page.goto(`http://localhost:${port}/?scenario=vehicles&seed=${seed}&map=${args["map"] ?? "farmland"}`);
  await page.waitForFunction(new Function("return globalThis.__tcs?.ready === true") as () => boolean, null, { timeout: 20000 });
  const found = await page.evaluate(new Function(`const t = globalThis.__tcs; t.setSpeed(0); t.setDebug(true); const s = t.sim.state;
    t.stepTicks(60 * 20);
    const fire = () => { for (const [vid, unit] of t.vehicles()) { const me = s.transform.get(vid); let best = null, bd = 1e9;
      for (const [id, v] of s.vehicle.entries()) { if (v.side === s.vehicle.get(vid).side || v.status !== "ok") continue; const q = s.transform.get(id); const d = Math.hypot(q.x - me.x, q.y - me.y); if (d < bd) { bd = d; best = q; } }
      if (best) { t.select(unit); t.fireNature(best.x, best.y, "ap"); } } };
    let hit = null;
    for (let k = 0; k < 120 && hit === null; k++) { if (k % 10 === 0) fire(); for (let i = 0; i < 30 && hit === null; i++) { t.stepTicks(1); for (const [id, v] of s.vehicle.entries()) if (v.status !== "ok" || v.fire !== null) { hit = id; break; } } }
    if (hit === null) return null;
    t.stepTicks(20); const p = s.transform.get(hit); t.focus(p.x, p.y, 70); t.stepTicks(1);
    return { vehicle: hit, status: s.vehicle.get(hit).status, fire: s.vehicle.get(hit).fire !== null, tick: s.tick };`) as () => object | null);
  await page.waitForTimeout(400);
  const a0 = `${outDir}/armour-${seed}-${name}-0-hit.png`;
  await page.screenshot({ path: a0 }); shots.push(a0);
  await page.evaluate(new Function(`const t = globalThis.__tcs; const s = t.sim.state; t.stepTicks(60 * 6); const id = [...s.vehicle.entries()].find(([, v]) => v.status !== "ok")?.[0]; if (id !== undefined) { const p = s.transform.get(id); t.focus(p.x, p.y, 90); } t.stepTicks(1);`) as () => void);
  await page.waitForTimeout(400);
  const a1 = `${outDir}/armour-${seed}-${name}-1-bailed-out.png`;
  await page.screenshot({ path: a1 }); shots.push(a1);
  const end = await page.evaluate(new Function(`const t = globalThis.__tcs; const s = t.sim.state; t.setDebug(false); t.stepTicks(60 * 150); const id = [...s.vehicle.entries()].find(([, v]) => v.status === "destroyed" || v.status === "abandoned")?.[0]; if (id !== undefined) { const p = s.transform.get(id); t.focus(p.x, p.y, 120); } t.stepTicks(1);
    return [...s.vehicle.values()].map((v) => v.status);`) as () => string[]);
  await page.waitForTimeout(400);
  const a2 = `${outDir}/armour-${seed}-${name}-2-wreck.png`;
  await page.screenshot({ path: a2 }); shots.push(a2);
  console.log(`${name}: armour scene ${JSON.stringify(found)} -> ${JSON.stringify(end)}, page errors: ${errors.length ? errors.join(" | ") : "none"}`);
}

async function gunneryScenes(page: Page, name: string, errors: string[], shots: string[]): Promise<void> {
  await page.goto(`http://localhost:${port}/?scenario=vehicles&seed=${seed}&map=${args["map"] ?? "farmland"}`);
  await page.waitForFunction(new Function("return globalThis.__tcs?.ready === true") as () => boolean, null, { timeout: 20000 });
  // Close the range first (both sides wander toward each other), then fire.
  await page.evaluate(new Function(`const t = globalThis.__tcs; t.setSpeed(0); const s = t.sim.state;
    const [vid, unit] = t.vehicles()[0]; t.select(unit); t.stepTicks(60 * 20);
    const me = s.transform.get(vid); let best = null, bd = 1e9;
    for (const [id, v] of s.vehicle.entries()) { if (v.side === s.vehicle.get(vid).side) continue; const q = s.transform.get(id); const d = Math.hypot(q.x - me.x, q.y - me.y); if (d < bd) { bd = d; best = q; } }
    t.fireNature(best.x, best.y, "ap"); t.stepTicks(60 * 6);
    const p = s.transform.get(vid); t.focus((p.x + best.x) / 2, (p.y + best.y) / 2, Math.min(1100, bd + 150)); t.stepTicks(1);`) as () => void);
  await page.waitForTimeout(400);
  const g0 = `${outDir}/gunnery-${seed}-${name}-0-firing.png`;
  await page.screenshot({ path: g0 }); shots.push(g0);
  await page.evaluate(new Function(`const t = globalThis.__tcs; const s = t.sim.state; const [vid] = t.vehicles()[0]; const p = s.transform.get(vid);
    t.focus(p.x + 80, p.y, 240);
    // Just after a burst: the tracers leave the barrel.
    const w = s.vehicle.get(vid).stations[0].weapons;
    for (let i = 0; i < 300; i++) { t.stepTicks(1); if (w.some((x) => s.tick - x.lastShotTick === 4)) break; }`) as () => void);
  await page.waitForTimeout(400);
  const g1 = `${outDir}/gunnery-${seed}-${name}-1-turret-close.png`;
  await page.screenshot({ path: g1 }); shots.push(g1);
  await page.evaluate(new Function(`const t = globalThis.__tcs; t.setDebug(true); t.stepTicks(60 * 2); const s = t.sim.state; const [vid] = t.vehicles()[0]; const p = s.transform.get(vid); t.focus(p.x + 90, p.y, 320); t.stepTicks(1);`) as () => void);
  await page.waitForTimeout(400);
  const g2 = `${outDir}/gunnery-${seed}-${name}-2-debug-why.png`;
  await page.screenshot({ path: g2 }); shots.push(g2);
  await page.evaluate(new Function(`const t = globalThis.__tcs; t.setDebug(false); t.discharge(); t.stepTicks(60 * 6); const s = t.sim.state; const [vid] = t.vehicles()[0]; const p = s.transform.get(vid); t.focus(p.x + 30, p.y, 160); t.stepTicks(1);`) as () => void);
  await page.waitForTimeout(400);
  const g3 = `${outDir}/gunnery-${seed}-${name}-3-smoke.png`;
  await page.screenshot({ path: g3 }); shots.push(g3);
  const info = await page.evaluate(new Function("const t = globalThis.__tcs, s = t.sim.state; let shots = 0; for (const [, v] of s.vehicle.entries()) for (const st of v.stations) for (const w of st.weapons) if (w.lastShotTick > 0) shots++; return { tick: s.tick, smoke: s.smoke.length, weaponsFired: shots, hash: t.hash() };") as () => object);
  console.log(`${name}: gunnery scene ${JSON.stringify(info)}, page errors: ${errors.length ? errors.join(" | ") : "none"}`);
}

/**
 * M7.5d floors (`--scene floors`): the platoon battle on foot on the village; the lead squad occupies the nearest
 * house of two or more storeys (Occupy, facing the enemy's side): men upstairs at the windows with the floor
 * switch on 1 and firing out; the same house on G (the men upstairs faint with their floor badge).
 */
async function floorScenes(page: Page, name: string, errors: string[], shots: string[]): Promise<void> {
  const shot = async (label: string) => { await page.waitForTimeout(450); const p = `${outDir}/floors-${seed}-${name}-${label}.png`; await page.screenshot({ path: p }); shots.push(p); };
  await page.goto(`http://localhost:${port}/?seed=${seed}&map=village&vehicles=0`);
  await page.waitForFunction(new Function("return globalThis.__tcs?.ready === true") as () => boolean, null, { timeout: 30000 });
  const zoom = name === "phone" ? 20 : 26;
  const info = await page.evaluate(new Function(`const t = globalThis.__tcs, s = t.sim.state, map = t.sim.ctx.map; t.setSpeed(0);
    const sq = t.units().find((u) => u.kind === "infantry"); t.select(sq.unit);
    const men = s.unit.get(sq.unit).members;
    let x = 0, y = 0; for (const m of men) { const p = s.transform.get(m); x += p.x / men.length; y += p.y / men.length; }
    let best = -1, bd = Infinity;
    map.buildings.forEach((b, i) => { if (!b.interior || b.storeys < 2 || (b.kind !== "house" && b.kind !== "farmhouse")) return; const d = Math.hypot(b.footprint[0] - x, b.footprint[1] - y); if (d < bd) { bd = d; best = i; } });
    const b = map.buildings[best]; let cx = 0, cy = 0; for (let k = 0; k < 8; k += 2) { cx += b.footprint[k] / 4; cy += b.footprint[k + 1] / 4; }
    // The enemy's side: away from the squad's start, through the house.
    const fx = cx - x, fy = cy - y, fl = Math.hypot(fx, fy) || 1;
    globalThis.__f = { i: best, cx, cy, ux: fx / fl, uy: fy / fl };
    t.occupyAt(cx, cy);
    for (let k = 0; k < 90 && (k < 2 || men.some((m) => (s.mover.get(m)?.waypoints.length ?? 0) > 0)); k++) t.stepTicks(60 * 5);
    t.fireAt(Math.min(Math.max(cx + fx / fl * 120, 5), map.widthM - 5), Math.min(Math.max(cy + fy / fl * 120, 5), map.heightM - 5));
    t.stepTicks(60 * 4);
    t.setFloor(1); t.focusScale(cx, cy, ${zoom}); t.stepTicks(8);
    const zs = men.map((m) => Math.round(s.transform.get(m).z * 10) / 10);
    return { building: best, kind: b.kind, storeys: b.storeys, dist: Math.round(bd), zs, floor: t.floorShown(), tick: s.tick };`) as () => object);
  await shot("0-occupy-upstairs-floor-1");
  await page.evaluate(new Function(`const t = globalThis.__tcs, h = globalThis.__f; t.setFloor(0); t.focusScale(h.cx, h.cy, ${zoom}); t.stepTicks(4);`) as () => void);
  await shot("1-floor-G-ghosts");
  console.log(`${name}: floors scene ${JSON.stringify(info)}; page errors: ${errors.length ? errors.join(" | ") : "none"}`);
}

/**
 * The "controls" step (`--scene controls`; owner choices S1, S2, S9, S10, S12): real pointer gestures on the platoon
 * battle on foot (village). The lead squad selected and halted with its facing handle; dragged out from the squad
 * (the ghost marker), let go (the move is sent, its marker stays); the marker dragged elsewhere (re-targeted) and
 * onto the squad (the cancel mark: Halt); the facing handle turned; Fire held behind a house (sight lines, solid
 * clear, broken blocked), dragged back onto the squad (cancel), a quick tap fires and the bar is back on Move;
 * Fire double-tapped (locked) stays on after a tap. Every step checks the order the app sent.
 */
async function controlScenes(page: Page, name: string, errors: string[], shots: string[]): Promise<void> {
  const shot = async (label: string) => { await page.waitForTimeout(250); const p = `${outDir}/controls-${seed}-${name}-${label}.png`; await page.screenshot({ path: p }); shots.push(p); };
  await page.goto(`http://localhost:${port}/?seed=${seed}&map=${args["map"] ?? "village"}&vehicles=0`);
  await page.waitForFunction(new Function("return globalThis.__tcs?.ready === true") as () => boolean, null, { timeout: 30000 });
  const zoom = name === "phone" ? 7 : 9;
  type P = { x: number; y: number };
  const ev = <T>(code: string) => page.evaluate(new Function(`const t = globalThis.__tcs, s = t.sim.state; ${code}`) as () => T);
  const lastOrder = () => ev<{ kind: string; [k: string]: unknown } | null>("const o = t.orderLog.filter((x) => x.issuer === 'blue').at(-1); return o ? JSON.parse(JSON.stringify(o)) : null;");
  const drag = async (from: P, to: P, hold?: () => Promise<void>) => {
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 12 });
    if (hold) await hold();
    await page.mouse.up();
  };
  const log: Record<string, unknown> = {};
  // The lead squad, selected, the view on it.
  log["start"] = await ev(`t.setSpeed(0); const sq = t.units().find((u) => u.kind === "infantry" && u.depth >= 1) ?? t.units().find((u) => u.kind === "infantry");
    t.select(sq.unit); const c = t.controls().centre; t.focusScale(c.x, c.y + ${name === "phone" ? 12 : 0}, ${zoom}); t.stepTicks(2);
    globalThis.__sq = sq.unit; return { unit: sq.unit, callsign: sq.callsign, ...t.controls() };`);
  await shot("0-selected-facing-handle");
  // S1: press on a man of the squad, drag out (the ghost follows), let go: the move goes at once.
  const man = await ev<P>(`const u = s.unit.get(globalThis.__sq); const m = u.leader ?? u.members[0]; const p = s.transform.get(m); return t.toScreen(p.x, p.y);`);
  const c0 = await ev<P>(`const c = t.controls().centre; return t.toScreen(c.x, c.y);`);
  const dest = { x: c0.x + (name === "phone" ? 110 : 260), y: c0.y - (name === "phone" ? 140 : 170) };
  await drag(man, dest, () => shot("1-drag-from-squad-ghost"));
  log["s1"] = await lastOrder();
  await ev(`t.stepTicks(60 * 4);`);
  await shot("2-move-sent-marker");
  // S10: the marker dragged elsewhere (re-targeted)...
  const mk = await ev<P | null>(`const m = t.controls().marker; return m ? t.toScreen(m.x, m.y) : null;`);
  if (mk) {
    const to = { x: mk.x - (name === "phone" ? 150 : 300), y: mk.y + 20 };
    await drag(mk, to, () => shot("3-marker-dragged"));
    log["s10retarget"] = await lastOrder();
    await ev(`t.stepTicks(60 * 3);`);
    // ... and onto the squad: the cancel mark; let go = Halt.
    const mk2 = await ev<P | null>(`const m = t.controls().marker; return m ? t.toScreen(m.x, m.y) : null;`);
    const on = await ev<P>(`const u = s.unit.get(globalThis.__sq); const p = s.transform.get(u.leader ?? u.members[0]); return t.toScreen(p.x, p.y);`);
    if (mk2) { await drag(mk2, on, () => shot("4-marker-on-squad-halts")); log["s10halt"] = await lastOrder(); }
  }
  // S9: the squad halted; its facing handle turned about a quarter round.
  await ev(`t.stepTicks(60 * 3);`);
  const fh = await ev<{ h: P; c: P } | null>(`const f = t.controls().facing; return f ? { h: t.toScreen(f.handle.x, f.handle.y), c: t.toScreen(f.centre.x, f.centre.y) } : null;`);
  if (fh) {
    const dx = fh.h.x - fh.c.x, dy = fh.h.y - fh.c.y;
    await drag(fh.h, { x: fh.c.x - dy, y: fh.c.y + dx }, () => shot("5-facing-handle-turned"));
    log["s9"] = await lastOrder();
    await ev(`t.stepTicks(60 * 30);`);
    await shot("6-turned-in-place");
  } else log["s9"] = "no facing handle";
  // S2: Fire, held at a point behind the nearest house (some lines blocked by it), then back onto the squad.
  await page.click('.hud-orders [data-order="fire"], .hud-more [data-order="fire"]');
  // (The view moved to show the squad and the house: the target 25 m behind the house's far wall.)
  const tgt = await ev<P>(`const map = t.sim.ctx.map, c = t.controls().centre; let best = null, bd = Infinity;
    for (const b of map.buildings) { let x = 0, y = 0; const n = b.footprint.length / 2; for (let k = 0; k < n; k++) { x += b.footprint[2 * k] / n; y += b.footprint[2 * k + 1] / n; }
      const d = Math.hypot(x - c.x, y - c.y); if (d > 25 && d < bd) { bd = d; best = { x, y }; } }
    const ux = best ? (best.x - c.x) / bd : 1, uy = best ? (best.y - c.y) / bd : 0;
    const w = best ? { x: best.x + ux * 25, y: best.y + uy * 25 } : { x: c.x + 80, y: c.y - 40 };
    const d = Math.hypot(w.x - c.x, w.y - c.y), ins = t.insets();
    const span = Math.min(innerWidth - ins.left - ins.right, innerHeight - ins.top - ins.bottom) * 0.6;
    t.focusScale((w.x + c.x) / 2, (w.y + c.y) / 2, Math.min(${zoom}, span / Math.max(1, d))); t.stepTicks(1);
    return t.toScreen(w.x, w.y);`);
  // Held first in the open short of the house (every line clear), then slid on to behind the house.
  const c1 = await ev<P>(`const c = t.controls().centre; return t.toScreen(c.x, c.y);`);
  const open = { x: (c1.x + tgt.x) / 2, y: (c1.y + tgt.y) / 2 };
  await page.mouse.move(open.x, open.y); await page.mouse.down();
  await page.mouse.move(open.x + 4, open.y + 3, { steps: 2 });
  log["s2open"] = (await ev<{ los: string[] | null }>("return t.controls();")).los;
  await shot("7a-fire-held-clear");
  await page.mouse.move(tgt.x, tgt.y, { steps: 8 });
  await shot("7-fire-held-sight-lines");
  log["s2los"] = (await ev<{ los: string[] | null }>("return t.controls();")).los;
  const back = await ev<P>(`const u = s.unit.get(globalThis.__sq); const p = s.transform.get(u.leader ?? u.members[0]); return t.toScreen(p.x, p.y);`);
  await page.mouse.move(back.x, back.y, { steps: 10 });
  await shot("8-fire-dragged-back-cancel");
  const before = await ev<number>("return t.orderLog.length;");
  await page.mouse.up();
  log["s2cancelSentNothing"] = (await ev<number>("return t.orderLog.length;")) === before;
  // A quick tap fires, and the bar goes back to Move (S12).
  await page.mouse.move(tgt.x, tgt.y); await page.mouse.down(); await page.mouse.up();
  log["s2tap"] = await lastOrder();
  log["afterTap"] = await ev("const c = t.controls(); return { mode: c.mode, locked: c.locked };");
  await ev(`t.stepTicks(60 * 2);`);
  await shot("9-fired-back-to-move");
  // S12: Fire double-tapped: locked on; a tap fires and it stays on.
  await page.dblclick('.hud-orders [data-order="fire"], .hud-more [data-order="fire"]');
  await page.mouse.move(tgt.x, tgt.y); await page.mouse.down(); await page.mouse.up();
  log["locked"] = await ev("const c = t.controls(); return { mode: c.mode, locked: c.locked, orders: t.orderLog.length };");
  await ev(`t.stepTicks(30);`);
  await shot("10-fire-locked");
  console.log(`${name}: controls scene ${JSON.stringify(log)}; page errors: ${errors.length ? errors.join(" | ") : "none"}`);
}

/**
 * The "bar-card" step (`--scene card`; owner choices S3, S4, S6): the platoon battle on foot (village), the lead
 * squad selected — the slim order bar (Move, Fire, Halt) and the compact card (pace and fire rows); the Fire tray
 * and the Move tray opened; Run and Ambush chosen on the card (the rules order arrives); a pace chip while moving
 * (the move goes on at the new pace); the detailed card (one row per man); a man's box from his row and from a tap
 * on the map; a move dragged onto a house (Occupy offered, then sent); the squad after a spell under fire; the
 * mounted battle with a vehicle selected (its paces, the gun and smoke screen in the Fire tray); the bar docked left.
 * Every step checks what the app sent.
 */
async function cardScenes(page: Page, name: string, errors: string[], shots: string[]): Promise<void> {
  const shot = async (label: string) => { await page.waitForTimeout(250); const p = `${outDir}/card-${seed}-${name}-${label}.png`; await page.screenshot({ path: p }); shots.push(p); };
  await page.goto(`http://localhost:${port}/?seed=${seed}&map=${args["map"] ?? "village"}&vehicles=0`);
  await page.waitForFunction(new Function("return globalThis.__tcs?.ready === true") as () => boolean, null, { timeout: 30000 });
  type P = { x: number; y: number };
  const ev = <T>(code: string) => page.evaluate(new Function(`const t = globalThis.__tcs, s = t.sim.state; ${code}`) as () => T);
  const lastOrder = () => ev<{ kind: string; [k: string]: unknown } | null>("const o = t.orderLog.filter((x) => x.issuer === 'blue').at(-1); return o ? JSON.parse(JSON.stringify(o)) : null;");
  const zoom = name === "phone" ? 6 : 8;
  const log: Record<string, unknown> = {};
  log["start"] = await ev(`t.setSpeed(0); t.dock(innerWidth > innerHeight ? "right" : "bottom"); const sq = t.units().find((u) => u.kind === "infantry" && u.depth >= 1) ?? t.units().find((u) => u.kind === "infantry");
    t.select(sq.unit); const c = t.controls().centre; t.focusScale(c.x, c.y, ${zoom}); t.stepTicks(2); globalThis.__sq = sq.unit;
    return { unit: sq.unit, callsign: sq.callsign, card: t.card() };`);
  // Compact card first (the choice is remembered on the device).
  if (await ev<boolean>("return t.card().detailed;")) await page.click('[data-card="detail"]');
  await shot("0-compact-card-slim-bar");
  await page.click('.hud-group[data-group="fire"] .hud-caret');
  await shot("1-fire-tray");
  await page.click('.hud-tray[data-tray="fire"] [data-order="grenade"]');
  await page.waitForTimeout(500);
  log["grenadeMode"] = await ev("return { mode: t.controls().mode, shown: document.querySelector('.hud-group[data-group=fire] .hud-verb').dataset.order };");
  await page.click('.hud-group[data-group="move"] .hud-caret');
  await shot("2-move-tray-grenade-on");
  await page.click('.hud-tray[data-tray="move"] [data-order="move"]');
  await page.waitForTimeout(500);
  // S3: Run and Ambush on the card.
  await page.click('.hud-seg [data-pace="run"]');
  await page.click('.hud-seg [data-fire="ambush"]');
  log["ambushOrder"] = await lastOrder();
  await ev("t.stepTicks(60 * 5);");
  log["afterAmbush"] = await ev("return t.card();");
  await shot("3-run-ambush");
  // A pace chip while the squad moves: the rest of the move at the new pace.
  await ev(`const c = t.controls().centre; t.tap(c.x + 60, c.y - 30); t.stepTicks(60 * 3);`);
  await page.click('.hud-seg [data-pace="sneak"]');
  log["repaced"] = await lastOrder();
  await ev("t.halt(); t.stepTicks(60 * 3);");
  // S6: the detailed card; a man's box from his row, then from a tap on another man on the map.
  await page.click('[data-card="detail"]');
  await shot("4-detailed-card");
  await page.click('.hud-card-list .hud-man:nth-child(2)');
  log["rowBox"] = await ev("return t.card().inspected;");
  await shot("5-man-box-from-row");
  // (The squad in the upper part of the free area, clear of the card.)
  await ev(`const c = t.controls().centre, ins = t.insets(); const box = document.querySelector('.hud-manbox').getBoundingClientRect(), card = document.querySelector('.hud-card').getBoundingClientRect();
    const want = (box.bottom + Math.min(card.top, document.querySelector('.hud-radio').getBoundingClientRect().top || card.top)) / 2, mid = ins.top + (innerHeight - ins.top - ins.bottom) / 2;
    t.focusScale(c.x, c.y - (want - mid) / ${zoom}, ${zoom}); t.stepTicks(1);`);
  const other = await ev<P & { id: number }>(`const u = s.unit.get(globalThis.__sq); const men = [...u.members]; const id = men.find((m) => m !== t.card().inspected && m !== u.leader) ?? men[0];
    const p = s.transform.get(id); return { ...t.toScreen(p.x, p.y), id };`);
  await page.mouse.move(other.x, other.y); await page.mouse.down(); await page.mouse.up();
  log["mapBox"] = { wanted: other.id, got: await ev("return t.card().inspected;") };
  await shot("6-man-box-from-map");
  await page.click(".hud-manbox-close");
  log["closed"] = await ev("return t.card().inspected;");
  // S4: a move dragged onto the nearest house: Occupy is offered at the drop point.
  const house = await ev<P | null>(`const map = t.sim.ctx.map, c = t.controls().centre; let best = null, bd = Infinity;
    for (const b of map.buildings) { let x = 0, y = 0; const n = b.footprint.length / 2; for (let k = 0; k < n; k++) { x += b.footprint[2 * k] / n; y += b.footprint[2 * k + 1] / n; }
      const d = Math.hypot(x - c.x, y - c.y); if (d > 15 && d < bd) { bd = d; best = { x, y }; } }
    if (!best) return null; const ins = t.insets(); const span = Math.min(innerWidth - ins.left - ins.right, innerHeight - ins.top - ins.bottom) * 0.7;
    t.focusScale((best.x + c.x) / 2, (best.y + c.y) / 2, Math.min(${zoom}, span / Math.max(1, bd))); t.stepTicks(1); globalThis.__house = best; return t.toScreen(best.x, best.y);`);
  if (house) {
    const lead = await ev<P>(`const u = s.unit.get(globalThis.__sq); const p = s.transform.get(u.leader ?? u.members[0]); return t.toScreen(p.x, p.y);`);
    await page.mouse.move(lead.x, lead.y); await page.mouse.down();
    await page.mouse.move(house.x, house.y, { steps: 12 }); await page.mouse.up();
    log["dragOntoHouse"] = (await lastOrder())?.kind;
    await shot("7-occupy-offered");
    const offered = await ev<boolean>("const b = document.querySelector('.hud-context'); return !!b && !b.hidden;");
    if (offered) { await page.click(".hud-context"); log["occupy"] = (await lastOrder())?.kind; } else log["occupy"] = "not offered";
  }
  // Under fire: the squad runs at the enemy's side of the map for a while; the card and a man's box then.
  await page.click('.hud-seg [data-pace="run"]');
  await ev(`const map = t.sim.ctx.map; const c = t.controls().centre; let x = 0, y = 0, n = 0;
    for (const [id, i] of s.identity.entries()) if (i.side === "red") { const p = s.transform.get(id); x += p.x; y += p.y; n++; }
    const dx = x / n - c.x, dy = y / n - c.y, d = Math.hypot(dx, dy); const go = Math.max(50, Math.min(d - 60, 500)); t.tap(c.x + dx / d * go, c.y + dy / d * go);
    for (let k = 0; k < 60; k++) { t.stepTicks(60 * 5); if ([...s.unit.get(globalThis.__sq).members].some((m) => s.soldier.get(m).mental.suppression > 0.3 || s.soldier.get(m).wounds.length > 0)) break; }
    t.stepTicks(60 * 4); const q = t.controls().centre; t.focusScale(q.x, q.y, ${zoom}); const u = s.unit.get(globalThis.__sq);
    const worst = [...u.members].sort((a, b) => s.soldier.get(b).mental.suppression + s.soldier.get(b).wounds.length - s.soldier.get(a).mental.suppression - s.soldier.get(a).wounds.length)[0];
    t.inspect(worst); t.stepTicks(1);`);
  log["underFire"] = await ev(`const u = s.unit.get(globalThis.__sq); return { tick: s.tick, states: [...document.querySelectorAll('.hud-card-list .hud-man')].map((b) => b.className.split(' ')[1]) };`);
  await shot("8-under-fire-detailed");
  // A vehicle (the mounted battle): its paces on the card, the gun and smoke screen in the Fire tray.
  await page.goto(`http://localhost:${port}/?seed=${seed}&map=${args["map"] ?? "village"}`);
  await page.waitForFunction(new Function("return globalThis.__tcs?.ready === true") as () => boolean, null, { timeout: 30000 });
  log["vehicle"] = await ev(`t.setSpeed(0); const [vid, unit] = t.vehicles()[0]; t.select(unit); const p = s.transform.get(vid); t.focusScale(p.x, p.y, ${zoom}); t.stepTicks(2);
    return { paces: [...document.querySelectorAll('.hud-seg [data-pace]')].map((b) => b.dataset.pace), set: t.orderSet().modes };`);
  await page.click('.hud-group[data-group="fire"] .hud-caret');
  await shot("9-vehicle-card-fire-tray");
  await page.click('.hud-group[data-group="fire"] .hud-caret');
  // The bar docked left, a squad aboard selected (Dismount on the bar), the Move tray open.
  await ev(`t.dock("left"); const sq = t.units().find((u) => u.kind === "infantry" && u.depth >= 1); t.select(sq.unit); t.stepTicks(1);`);
  await page.click('.hud-group[data-group="move"] .hud-caret');
  await shot("10-dock-left-move-tray");
  await ev(`t.dock(innerWidth > innerHeight ? "right" : "bottom");`);
  console.log(`${name}: card scene ${JSON.stringify(log)}; page errors: ${errors.length ? errors.join(" | ") : "none"}`);
}

/**
 * The "map-feel" step (`--scene mapfeel`; owner choices S5, S7, S8, S13, S14): the platoon battle on foot (village).
 * Every own squad sent forward and a mortar mission called: one faint line per unit, the selected one bright along its
 * route, the mission's amber line (figure zoom, then zoomed out to the symbols); a tile tapped (selected and centred),
 * a tile held (the camera follows, the badge), a pan by hand (following stops); the contour toggle close up; the
 * help card (the ? key); Tab, T, Esc, Space and 3 on the keyboard; a right-click move (desktop); then the squads
 * pushed at the enemy until contacts are lost: the "last seen" pins with their age. Every step checks the app.
 */
async function mapfeelScenes(page: Page, name: string, errors: string[], shots: string[]): Promise<void> {
  const shot = async (label: string) => { await page.waitForTimeout(250); const p = `${outDir}/mapfeel-${seed}-${name}-${label}.png`; await page.screenshot({ path: p }); shots.push(p); };
  await page.goto(`http://localhost:${port}/?seed=${seed}&map=${args["map"] ?? "village"}&vehicles=0`);
  await page.waitForFunction(new Function("return globalThis.__tcs?.ready === true") as () => boolean, null, { timeout: 30000 });
  type P = { x: number; y: number };
  const ev = <T>(code: string) => page.evaluate(new Function(`const t = globalThis.__tcs, s = t.sim.state; ${code}`) as () => T);
  const lastOrder = () => ev<{ kind: string; [k: string]: unknown } | null>("const o = t.orderLog.filter((x) => x.issuer === 'blue').at(-1); return o ? JSON.parse(JSON.stringify(o)) : null;");
  const mf = () => ev<Record<string, unknown>>("return t.mapfeel();");
  const phone = name === "phone";
  const log: Record<string, unknown> = {};
  try { await page.evaluate(new Function("localStorage.removeItem('tcs.ui.contours')") as () => void); } catch { /* none */ }
  // S7: every squad of the platoon forward 120 m toward the enemy; a mortar mission called by the lead squad.
  log["sent"] = await ev(`t.setSpeed(0); t.dock(innerWidth > innerHeight ? "right" : "bottom");
    let ex = 0, ey = 0, n = 0; for (const [id, i] of s.identity.entries()) if (i.side === "red") { const p = s.transform.get(id); ex += p.x; ey += p.y; n++; }
    ex /= n; ey /= n; globalThis.__enemy = { x: ex, y: ey };
    const sqs = t.units().filter((u) => u.kind === "infantry" && u.depth >= 1);
    const mid = (uid) => { const u = s.unit.get(uid); let x = 0, y = 0, k = 0; for (const m of u.members) { const p = s.transform.get(m); x += p.x; y += p.y; k++; } return { x: x / k, y: y / k }; };
    for (const q of sqs) { const c = mid(q.unit); const dx = ex - c.x, dy = ey - c.y, d = Math.hypot(dx, dy); t.moveUnit(q.unit, c.x + dx / d * 120, c.y + dy / d * 120); }
    const lead = sqs[0].unit; t.select(lead); const c = mid(lead); const dx = ex - c.x, dy = ey - c.y, d = Math.hypot(dx, dy);
    t.callFire(c.x + dx / d * 260, c.y + dy / d * 260, "he");
    t.stepTicks(60 * 6); globalThis.__sq = lead;
    const all = sqs.map((q) => mid(q.unit)); const bx = all.reduce((a, p) => a + p.x, 0) / all.length, by = all.reduce((a, p) => a + p.y, 0) / all.length;
    t.focusScale(bx + dx / d * 90, by + dy / d * 90, ${phone ? 1.7 : 2.6}); t.stepTicks(1);
    return { squads: sqs.length, mf: t.mapfeel().intents };`);
  await shot("0-lines-dots");
  await ev(`const c = t.controls().centre; t.focusScale(c.x, c.y, ${phone ? 6 : 8}); t.stepTicks(1);`);
  await shot("1-lines-figures-selected");
  await ev(`t.focusScale(globalThis.__enemy.x, globalThis.__enemy.y, 0.5); t.stepTicks(1);`);
  log["symbols"] = (await mf())["intents"];
  await shot("2-lines-symbols");
  // S5: a tile tapped: selected and centred; held: followed (badge); a pan by hand stops it.
  await ev(`t.select(null); t.focusScale(globalThis.__enemy.x, globalThis.__enemy.y, ${phone ? 4 : 6}); t.stepTicks(1);`);
  const sq2 = await ev<number>(`return t.units().filter((u) => u.kind === "infantry" && u.depth >= 1)[1].unit;`);
  await page.click(`.hud-tile[data-unit="${sq2}"]`);
  log["tileTap"] = await mf();
  await shot("3-tile-tap-centred");
  const tile = `.hud-tile[data-unit="${sq2}"]`;
  const box = await ev<P>(`const r = document.querySelector('${tile}').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`);
  await page.mouse.move(box.x, box.y); await page.mouse.down(); await page.waitForTimeout(700); await page.mouse.up();
  await ev(`t.stepTicks(60 * 8);`);
  await page.waitForTimeout(400);
  log["held"] = (await mf())["following"];
  await shot("4-following-badge");
  const mid = await ev<P>(`const i = t.insets(); return { x: i.left + (innerWidth - i.left - i.right) / 2, y: i.top + (innerHeight - i.top - i.bottom) / 2 };`);
  await page.mouse.move(mid.x + 30, mid.y + 40); await page.mouse.down(); await page.mouse.move(mid.x - 60, mid.y - 20, { steps: 8 }); await page.mouse.up();
  log["afterPan"] = (await mf())["following"];
  // S14: contours close up (the toggle: in the top bar, behind the menu on a phone).
  await ev(`const c = t.controls().centre; t.focusScale(c.x, c.y, ${phone ? 7 : 9}); t.renderer.primeDetail(); t.stepTicks(1);`);
  await shot("5-contours-off-close");
  if (await ev<boolean>("const b = document.querySelector('.hud-contours'); return b.parentElement.classList.contains('hud-bar-menu');")) await page.click(".hud-bar .hud-more-btn");
  await page.click(".hud-contours");
  for (let k = 0; k < 40; k++) await ev("t.stepTicks(1);");
  await page.waitForTimeout(600);
  log["contours"] = (await mf())["contours"];
  await shot("6-contours-on-close");
  await ev(`t.focusScale(globalThis.__enemy.x, globalThis.__enemy.y, ${phone ? 2 : 3}); t.stepTicks(1);`);
  await shot("7-contours-on-dots");
  await page.keyboard.press("c");
  log["cKey"] = (await mf())["contours"];
  // S13: the help card (?), Esc closes it; Tab selects the next unit, T picks Fire, Esc back to Move; Space, 3.
  await page.keyboard.press("?");
  log["help"] = (await mf())["help"];
  await shot("8-help-card");
  await page.keyboard.press("Escape");
  log["helpAfterEsc"] = (await mf())["help"];
  const before = (await mf())["selected"];
  await page.keyboard.press("Tab");
  const afterTab = await mf();
  await page.keyboard.press("t");
  const afterT = (await mf())["mode"];
  await page.keyboard.press("Escape");
  const afterEsc = (await mf())["mode"];
  await page.keyboard.press("Space");
  const sp1 = (await mf())["speed"];
  await page.keyboard.press("3");
  const sp2 = (await mf())["speed"];
  await page.keyboard.press("Space");
  const sp3 = (await mf())["speed"];
  await page.keyboard.press("Space");
  log["keys"] = { before, afterTab: afterTab["selected"], centred: afterTab["centred"], afterT, afterEsc, speeds: [sp1, sp2, sp3, (await mf())["speed"]] };
  await ev("t.setSpeed(0);");
  // Right-click (desktop): the selected unit moves to the point at once.
  if (!phone) {
    const c = await ev<P>(`const c = t.controls().centre; return t.toScreen(c.x + 25, c.y - 15);`);
    await page.mouse.move(c.x, c.y); await page.mouse.down({ button: "right" }); await page.mouse.up({ button: "right" });
    log["rightClick"] = (await lastOrder())?.kind;
    const from = await ev<P>(`const c = t.controls().centre; return t.toScreen(c.x - 40, c.y + 40);`);
    await page.mouse.move(from.x, from.y); await page.mouse.down({ button: "right" }); await page.mouse.move(from.x + 140, from.y - 60, { steps: 10 });
    await shot("9-right-drag-ghost");
    await page.mouse.up({ button: "right" });
    log["rightDrag"] = await lastOrder();
  }
  // S8: the platoon pushed at the enemy; when contacts are lost they leave "last seen" pins with their age.
  // (Stepped a few seconds per frame: the app reads what the side knows once per frame.)
  await ev(`const sqs = t.units().filter((u) => u.kind === "infantry" && u.depth >= 1); const e = globalThis.__enemy; for (const q of sqs) t.moveUnit(q.unit, e.x, e.y);`);
  let pins: unknown[] = [];
  for (let k = 0; k < 200 && pins.length < 2; k++) { await ev("t.stepTicks(60 * 3);"); await page.waitForTimeout(40); pins = (await mf())["pins"] as unknown[]; }
  for (let k = 0; k < 5; k++) { await ev("t.stepTicks(60 * 2);"); await page.waitForTimeout(40); }
  log["pins"] = { tick: await ev<number>("return s.tick;"), pins: (await mf())["pins"] };
  // (Centred on the pins as the app shows them: their last known places, not where the enemy is.)
  await ev(`t.select(null); const ps = t.mapfeel().pins; if (ps.length) { const x = ps.reduce((a, p) => a + p.x, 0) / ps.length, y = ps.reduce((a, p) => a + p.y, 0) / ps.length; t.focusScale(x, y, ${phone ? 3 : 4}); } t.stepTicks(1);`);
  await shot("10-last-seen-pins");
  console.log(`${name}: mapfeel scene ${JSON.stringify(log)}; page errors: ${errors.length ? errors.join(" | ") : "none"}`);
}

/**
 * The "fire-support" step (`--scene firesupport`; owner choice S11 with ranging shots): the platoon battle on foot
 * (village). The lead squad selected; the Fire tray open with its one Fire support item; a point 250 m toward the
 * enemy held (the amber crosshair joined to the leader), let go: the pop-up offers HE and smoke with the rounds
 * left; HE picked (the order sent, the bar back on Move); the mission line while called, the first ranging round
 * down (its cross, the radio), the second, the battery's volley for effect (the second ring); a second pop-up
 * dismissed with Esc sends nothing. Every step checks the app.
 */
async function fireSupportScenes(page: Page, name: string, errors: string[], shots: string[]): Promise<void> {
  const shot = async (label: string) => { await page.waitForTimeout(250); const p = `${outDir}/firesupport-${seed}-${name}-${label}.png`; await page.screenshot({ path: p }); shots.push(p); };
  await page.goto(`http://localhost:${port}/?seed=${seed}&map=${args["map"] ?? "village"}&vehicles=0`);
  await page.waitForFunction(new Function("return globalThis.__tcs?.ready === true") as () => boolean, null, { timeout: 30000 });
  type P = { x: number; y: number };
  const ev = <T>(code: string) => page.evaluate(new Function(`const t = globalThis.__tcs, s = t.sim.state; ${code}`) as () => T);
  const lastOrder = () => ev<{ kind: string; [k: string]: unknown } | null>("const o = t.orderLog.filter((x) => x.issuer === 'blue').at(-1); return o ? JSON.parse(JSON.stringify(o)) : null;");
  const sup = () => ev<{ popup: boolean; at: P | null; mode: string; he: number; smoke: number; missions: { phase: string | null; falls: number }[] }>("return t.support();");
  const phone = name === "phone";
  const log: Record<string, unknown> = {};
  // The lead squad selected; the view on it and on a point 250 m toward the enemy.
  log["start"] = await ev(`t.setSpeed(0);
    let ex = 0, ey = 0, n = 0; for (const [id, i] of s.identity.entries()) if (i.side === "red") { const p = s.transform.get(id); ex += p.x; ey += p.y; n++; }
    ex /= n; ey /= n;
    const sq = t.units().filter((u) => u.kind === "infantry" && u.depth >= 1)[0]; t.select(sq.unit); globalThis.__sq = sq.unit;
    const c = t.controls().centre; const dx = ex - c.x, dy = ey - c.y, d = Math.hypot(dx, dy);
    const p = { x: c.x + dx / d * 250, y: c.y + dy / d * 250 }; globalThis.__pt = p;
    const ins = t.insets(); const span = Math.min(innerWidth - ins.left - ins.right, innerHeight - ins.top - ins.bottom) * 0.75;
    globalThis.__fit = () => t.focusScale((p.x + c.x) / 2, (p.y + c.y) / 2, Math.min(4, span / 280));
    globalThis.__fit(); t.stepTicks(1);
    return { squad: sq.callsign, point: p, ...t.support() };`);
  // The Fire tray with its one Fire support item.
  await page.click('.hud-group[data-group="fire"] .hud-caret');
  log["trayItems"] = await ev<string[]>(`return [...document.querySelectorAll('.hud-tray[data-tray="fire"] [data-order]')].filter((b) => !b.hidden).map((b) => b.dataset.order);`);
  await shot("0-fire-tray");
  await page.click('.hud-tray[data-tray="fire"] [data-order="support"]');
  log["mode"] = (await sup()).mode;
  // Hold the point (slid a little to adjust it), let go: the pop-up.
  const pt = await ev<P>("return t.toScreen(globalThis.__pt.x, globalThis.__pt.y);");
  await page.mouse.move(pt.x - 20, pt.y + 14); await page.mouse.down();
  await page.mouse.move(pt.x, pt.y, { steps: 6 });
  await page.waitForTimeout(600);
  log["held"] = await sup();
  await shot("1-point-held");
  await page.mouse.up();
  log["popup"] = await sup();
  await shot("2-popup-he-smoke");
  const n0 = await ev<number>("return t.orderLog.length;");
  await page.click('.hud-support [data-ammo="he"]');
  log["order"] = await lastOrder();
  log["sent"] = (await ev<number>("return t.orderLog.length;")) - n0;
  log["after"] = await sup();
  await ev("t.stepTicks(60 * 5);");
  await shot("3-mission-called");
  // The ranging rounds: step until the first falls, then the second; then the volley for effect.
  const until = async (phase: string, falls: number, maxS: number) => {
    for (let k = 0; k < maxS; k++) {
      const m = (await sup()).missions[0];
      if (m && m.phase === phase && m.falls >= falls) return true;
      await ev("t.stepTicks(60);");
    }
    return false;
  };
  log["ranging1"] = await until("ranging", 1, 150);
  await ev("t.stepTicks(20); globalThis.__fit(); t.stepTicks(1);");
  await shot("4-first-ranging-round");
  log["ranging2"] = await until("ranging", 2, 60);
  await ev("t.stepTicks(20);");
  await shot("5-second-ranging-round");
  log["effect"] = await until("effect", 0, 60);
  await ev("t.stepTicks(40);");
  log["effectState"] = await sup();
  await shot("6-fire-for-effect");
  await ev("t.stepTicks(60 * 3);");
  await shot("7-after-volley");
  // A second pop-up (tapped this time) closed with Esc: nothing sent; Smoke offered with what is left.
  await page.click('.hud-group[data-group="fire"] .hud-caret');
  await page.click('.hud-tray[data-tray="fire"] [data-order="support"]');
  const p2 = await ev<P>("const c = t.controls().centre, p = globalThis.__pt; return t.toScreen((c.x + p.x) / 2 + 30, (c.y + p.y) / 2 - 20);");
  await page.mouse.move(p2.x, p2.y); await page.mouse.down(); await page.mouse.up();
  log["tapPopup"] = await sup();
  await shot("8-tap-popup");
  const n1 = await ev<number>("return t.orderLog.length;");
  await page.keyboard.press("Escape");
  log["escClosed"] = { popup: (await sup()).popup, sentNothing: (await ev<number>("return t.orderLog.length;")) === n1 };
  if (phone) log["phone"] = true;
  console.log(`${name}: firesupport scene ${JSON.stringify(log)}; page errors: ${errors.length ? errors.join(" | ") : "none"}`);
}

/**
 * The "review fixes" step (`--scene review`): at device pixel ratio 2 (as on nearly every phone and Retina screen;
 * the other scenes run at 1 and never saw the halved screen size). The mounted platoon battle as it opens (the short
 * hint, the score line with the time and mortar rounds first, both platoons' vehicles told apart as "1/Puma 2" and
 * "2/Puma 2"); a tile tapped (the squad in the middle of the free area, the hint gone); held (the follow camera
 * keeps the squad in the middle while it drives); on foot: the detailed card (the squad kept clear of it); the bar
 * docked at the side on a phone (the pace and fire chips keep their labels); Fire held behind a house (sight lines
 * with dark edges); contours close up (dark brown); the help card (touch or mouse rows only). Every step is checked.
 */
async function reviewScenes(page: Page, name: string, errors: string[], shots: string[]): Promise<void> {
  const shot = async (label: string) => { await page.waitForTimeout(250); const p = `${outDir}/review-${seed}-${name}-${label}.png`; await page.screenshot({ path: p }); shots.push(p); };
  const phone = name === "phone";
  type P = { x: number; y: number };
  const ev = <T>(code: string) => page.evaluate(new Function(`const t = globalThis.__tcs, s = t.sim.state; ${code}`) as () => T);
  const log: Record<string, unknown> = { dpr: await page.evaluate(new Function("return globalThis.devicePixelRatio") as () => number) };
  const ready = () => page.waitForFunction(new Function("return globalThis.__tcs?.ready === true") as () => boolean, null, { timeout: 30000 });
  // Where a unit's middle sits on screen against the middle of the free area (less log and card), px.
  const offCentre = (uid: string) => ev<{ dx: number; dy: number }>(`const u = s.unit.get(${uid}); let x = 0, y = 0, n = 0;
    const ids = u.vehicle !== undefined ? [u.vehicle] : u.members; for (const m of ids) { const p = s.transform.get(m); if (p) { x += p.x; y += p.y; n++; } }
    const a = t.toScreen(x / n, y / n), i = t.viewInsets(); const W = t.renderer.app.screen.width, H = t.renderer.app.screen.height;
    return { dx: Math.round(a.x - (i.left + (W - i.left - i.right) / 2)), dy: Math.round(a.y - (i.top + (H - i.top - i.bottom) / 2)) };`);
  await page.goto(`http://localhost:${port}/?seed=${seed}&map=${args["map"] ?? "village"}`);
  await ready();
  await ev("t.setSpeed(0);");
  log["open"] = await ev(`const h = document.querySelector('.hud-hint'); return { hint: h && !h.hidden ? h.textContent : null, score: document.querySelector('.hud-score')?.textContent,
    screen: [t.renderer.width, t.renderer.height], inner: [innerWidth, innerHeight] };`);
  await shot("0-opening-dpr2");
  // A tile tapped: selected and centred.
  const veh = await ev<number>(`return t.units().find((u) => u.kind === "vehicle").unit;`);
  await page.click(`.hud-tile[data-unit="${veh}"]`);
  log["tileTap"] = { off: await offCentre(String(veh)), centred: (await ev<Record<string, unknown>>("return t.mapfeel();"))["centred"],
    hint: await ev("const h = document.querySelector('.hud-hint'); return h.hidden;") };
  await shot("1-tile-tap-centred");
  // Held: the follow camera; the hull drives forward 150 m.
  const box = await ev<P>(`const r = document.querySelector('.hud-tile[data-unit="${veh}"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`);
  // (Held well past the 450 ms: at pixel ratio 2 the headless browser draws slowly and the timer runs late.)
  await page.mouse.move(box.x, box.y); await page.mouse.down(); await page.waitForTimeout(1500); await page.mouse.up();
  await ev(`const e = (() => { let x = 0, y = 0, n = 0; for (const [id, i] of s.identity.entries()) if (i.side === "red") { const p = s.transform.get(id); x += p.x; y += p.y; n++; } return { x: x / n, y: y / n }; })();
    const v = s.unit.get(${veh}).vehicle, p = s.transform.get(v), d = Math.hypot(e.x - p.x, e.y - p.y); t.moveUnit(${veh}, p.x + (e.x - p.x) / d * 150, p.y + (e.y - p.y) / d * 150);`);
  const track: { dx: number; dy: number }[] = [];
  // (Each 2 s step jumps the hull at once; the camera eases after it over a few frames: a second to settle.)
  for (let k = 0; k < 6; k++) { await ev("t.stepTicks(60 * 2);"); await page.waitForTimeout(1000); track.push(await offCentre(String(veh))); }
  log["follow"] = { following: (await ev<Record<string, unknown>>("return t.mapfeel();"))["following"], track };
  await shot("2-following-dpr2");
  await ev("t.follow(null);");
  // On foot: the lead squad, its detailed card; the squad kept clear of the card.
  await page.goto(`http://localhost:${port}/?seed=${seed}&map=${args["map"] ?? "village"}&vehicles=0`);
  await ready();
  const sq = await ev<number>(`t.setSpeed(0); return t.units().find((u) => u.kind === "infantry" && u.depth >= 1).unit;`);
  await page.click(`.hud-tile[data-unit="${sq}"]`);
  await ev(`const c = t.controls().centre; t.focusScale(c.x, c.y - ${phone ? 35 : 25}, ${phone ? 7 : 9}); t.stepTicks(1);`);
  const menBtn = await ev<boolean>("const b = [...document.querySelectorAll('.hud-card-btn')][0]; if (b) b.click(); return !!b;");
  await page.waitForTimeout(300);
  const under = await ev<{ y: number; cardTop: number }>(`const u = s.unit.get(${sq}); let x = 0, y = 0; for (const m of u.members) { const p = s.transform.get(m); x += p.x; y += p.y; }
    const a = t.toScreen(x / u.members.length, y / u.members.length); return { y: Math.round(a.y), cardTop: Math.round(document.querySelector('.hud-bottom').getBoundingClientRect().top) };`);
  log["detailedCard"] = { menBtn, ...under, clear: under.y < under.cardTop };
  await shot("3-detailed-card-squad-clear");
  await ev("const b = [...document.querySelectorAll('.hud-card-btn')][0]; if (b) b.click();");
  // A phone with the bar docked at the side: the chips keep their labels.
  if (phone) {
    await ev(`t.dock("left");`);
    await page.waitForTimeout(200);
    log["dockLeft"] = await ev("return [...document.querySelectorAll('.hud-chip span')].filter((x) => x.offsetWidth > 0).length;");
    await shot("4-dock-left-chips-labelled");
    await ev(`t.dock("bottom");`);
  }
  // Fire held behind the nearest house: sight lines with dark edges, the blocked part red and dashed.
  await page.click('.hud-orders [data-order="fire"], .hud-more [data-order="fire"]');
  const tgt = await ev<P>(`const map = t.sim.ctx.map, c = t.controls().centre; let best = null, bd = Infinity;
    for (const b of map.buildings) { let x = 0, y = 0; const n = b.footprint.length / 2; for (let k = 0; k < n; k++) { x += b.footprint[2 * k] / n; y += b.footprint[2 * k + 1] / n; }
      const d = Math.hypot(x - c.x, y - c.y); if (d > 25 && d < bd) { bd = d; best = { x, y }; } }
    const ux = best ? (best.x - c.x) / bd : 1, uy = best ? (best.y - c.y) / bd : 0;
    const w = best ? { x: best.x + ux * 25, y: best.y + uy * 25 } : { x: c.x + 80, y: c.y - 40 };
    const d = Math.hypot(w.x - c.x, w.y - c.y), ins = t.viewInsets();
    const span = Math.min(innerWidth - ins.left - ins.right, innerHeight - ins.top - ins.bottom) * 0.6;
    t.focusScale((w.x + c.x) / 2, (w.y + c.y) / 2, Math.min(${phone ? 7 : 9}, span / Math.max(1, d))); t.stepTicks(1);
    return t.toScreen(w.x, w.y);`);
  await page.mouse.move(tgt.x, tgt.y); await page.mouse.down(); await page.mouse.move(tgt.x + 3, tgt.y + 2, { steps: 3 });
  log["los"] = (await ev<{ los: string[] | null }>("return t.controls();")).los;
  await shot("5-fire-held-sight-lines");
  // Dragged back onto the squad: nothing is sent.
  const back = await ev<P>(`const u = s.unit.get(${sq}); const p = s.transform.get(u.leader ?? u.members[0]); return t.toScreen(p.x, p.y);`);
  await page.mouse.move(back.x, back.y, { steps: 8 }); await page.mouse.up();
  // T twice quickly: Fire, not locked (only taps and clicks lock).
  await page.keyboard.press("t"); await page.keyboard.press("t");
  log["tTwice"] = await ev("const c = t.controls(); return { mode: c.mode, locked: c.locked };");
  await page.keyboard.press("Escape");
  // Contours close up (dark brown now).
  await ev(`const c = t.controls().centre; t.focusScale(c.x, c.y, ${phone ? 7 : 9}); t.setContours?.(true); t.renderer.setContoursAlways(true); t.renderer.primeDetail(); t.stepTicks(1);`);
  for (let k = 0; k < 30; k++) await ev("t.stepTicks(1);");
  await page.waitForTimeout(500);
  await shot("6-contours-close");
  // The help card: the touch rows on a phone, mouse rows on the desktop (never both).
  await page.keyboard.press("?");
  log["help"] = await ev("return [...document.querySelectorAll('.hud-help-sec')].map((x) => x.textContent);");
  await shot("7-help-card");
  console.log(`${name}: review scene ${JSON.stringify(log)}; page errors: ${errors.length ? errors.join(" | ") : "none"}`);
}

/**
 * M7.5e buildings (`--scene buildings`): the platoon battle on foot on the village (the player attacks, the AI
 * defends), the enemy drawn as he is (`reveal`). After 150 s: the AI's defenders at windows of the house with most of
 * them in it (ground floor; the floor switch on 1 when men are upstairs), the house from further out (the men outside
 * covering the approach and its back); mortar bombs on that house until its men leave (a trap) and running out; then
 * the lead squad clears the nearest empty house with a way in (`clearAt`): closing on the door, stacked beside it,
 * the first men going in after the grenade, and the house clear. Seed 1 shows the trap (its bombs land on the
 * house; the caller cannot see the falls from 700 m, so elsewhere they may not); seed 3 men upstairs by 150 s (the
 * upper-floor shot is skipped when nobody is upstairs by 300 s).
 */
async function buildingScenes(page: Page, name: string, errors: string[], shots: string[]): Promise<void> {
  const shot = async (label: string) => {
    await page.waitForTimeout(300);
    await page.waitForFunction(new Function("return globalThis.__tcs.tilesPending() === 0") as () => boolean, null, { timeout: 30000 });
    const p = `${outDir}/buildings-${seed}-${name}-${label}.png`; await page.screenshot({ path: p }); shots.push(p);
  };
  await page.goto(`http://localhost:${port}/?seed=${seed}&map=village&vehicles=0`);
  await page.waitForFunction(new Function("return globalThis.__tcs?.ready === true") as () => boolean, null, { timeout: 30000 });
  const zoom = name === "phone" ? 18 : 24;
  const helpers = `const t = globalThis.__tcs, s = t.sim.state, ctx = t.sim.ctx, map = ctx.map;
    const inside = (b, x, y) => { let c = false; const f = b.footprint, n = f.length / 2; for (let a = 0, e = n - 1; a < n; e = a++) { const ax = f[2*a], ay = f[2*a+1], ex = f[2*e], ey = f[2*e+1]; if ((ay > y) !== (ey > y) && x < ((ex - ax) * (y - ay)) / (ey - ay) + ax) c = !c; } return c; };
    const centre = (b) => { const f = b.footprint, n = f.length / 2; let x = 0, y = 0; for (let k = 0; k < n; k++) { x += f[2*k] / n; y += f[2*k+1] / n; } return { x, y }; };
    const able = (id) => { const q = s.soldier.get(id); return q !== undefined && q.physiology.alive && q.physiology.consciousness >= 0.5 && q.captive === null && q.mount === undefined; };
    const mySide = s.unit.get(t.units()[0].unit).side;
    const enemy = [...s.identity.entries()].filter(([, i]) => i.side !== mySide).map(([id]) => id);
    const inHouse = (bi) => enemy.filter((m) => able(m) && inside(map.buildings[bi], s.transform.get(m).x, s.transform.get(m).y));`;
  const info: Record<string, unknown> = {};
  info["defence"] = await page.evaluate(new Function(`${helpers} t.setSpeed(0); t.reveal(true);
    for (let k = 0; k < 30; k++) t.stepTicks(60 * 5);
    // The house with men upstairs if any, else the one with most men in it.
    const upIn = (i) => inHouse(i).filter((m) => s.transform.get(m).z > 1.5).length; // (z: his height above the ground)
    let best = -1, bn = 0, bs = 0;
    map.buildings.forEach((b, i) => { if (!b.interior) return; const n = inHouse(i).length; const sc = n + 10 * (n > 0 ? upIn(i) : 0); if (sc > bs) { bs = sc; bn = n; best = i; } });
    if (best < 0) return { house: -1 };
    const c = centre(map.buildings[best]), up = upIn(best);
    globalThis.__b = { i: best, x: c.x, y: c.y, up };
    t.setFloor(0); t.focusScale(c.x, c.y, ${zoom}); t.stepTicks(2);
    return { house: best, kind: map.buildings[best].kind, storeys: map.buildings[best].storeys, inside: bn, up, tick: s.tick };`) as () => object);
  const b = await page.evaluate(new Function("return globalThis.__b ?? null") as () => { i: number; up: number } | null);
  if (b === null) { console.log(`${name}: buildings scene: no enemy in a house at 150 s`); return; }
  await shot("0-defenders-at-windows");
  // An upper floor: the house with most men upstairs (looked for every 10 s up to 300 s), the floor switch on 1.
  info["upper"] = await page.evaluate(new Function(`${helpers}
    const upIn = (i) => inHouse(i).filter((m) => s.transform.get(m).z > 1.5).length; // (z: his height above the ground)
    let ub = -1, un = 0;
    for (let k = 0; k < 16 && ub < 0; k++) {
      map.buildings.forEach((b, i) => { if (!b.interior || b.storeys < 2 || inHouse(i).length === 0) return; const n = upIn(i); if (n > un) { un = n; ub = i; } });
      if (ub < 0) t.stepTicks(60 * 10);
    }
    if (ub < 0) return null;
    const c = centre(map.buildings[ub]); globalThis.__u = { i: ub, x: c.x, y: c.y };
    t.setFloor(1); t.focusScale(c.x, c.y, ${zoom}); t.stepTicks(2);
    return { house: ub, up: un, tick: s.tick };`) as () => object | null);
  if (info["upper"] !== null) await shot("1-upper-floor");
  await page.evaluate(new Function(`const t = globalThis.__tcs, h = globalThis.__b; t.setFloor(0); t.focusScale(h.x, h.y, ${zoom * 0.4}); t.stepTicks(2);`) as () => void);
  await shot("2-inside-and-outside");
  info["trap"] = await page.evaluate(new Function(`${helpers} const h = globalThis.__b;
    t.select(t.units().find((u) => u.kind === "infantry").unit);
    const unitsIn = new Set(inHouse(h.i).map((m) => s.identity.get(m).unit));
    t.callFire(h.x, h.y, "he");
    let left = null;
    for (let k = 0; k < 80 && left === null; k++) { if (k === 40) t.callFire(h.x, h.y, "he"); t.stepTicks(60 * 3); for (const u of unitsIn) { const lh = s.unit.get(u)?.leftHouse; if (lh && lh.building === map.buildings[h.i].id) left = { unit: u, reason: lh.reason, tick: lh.tick }; } }
    if (left) t.stepTicks(60 * 4);
    t.setFloor(0); t.focusScale(h.x, h.y, ${zoom * 0.8}); t.stepTicks(2);
    return { left, stillIn: inHouse(h.i).length, tick: s.tick };`) as () => object);
  await shot("3-leaving-a-trap");
  info["clear"] = await page.evaluate(new Function(`${helpers} const own = new Set(t.units().map((u) => u.unit));
    const sq = t.units().find((u) => u.kind === "infantry" && u.depth === 1).unit; t.select(sq);
    const men = s.unit.get(sq).members.filter(able);
    let x = 0, y = 0; for (const m of men) { const p = s.transform.get(m); x += p.x / men.length; y += p.y / men.length; }
    let best = -1, bd = Infinity;
    map.buildings.forEach((b, i) => { if (!b.interior || (b.kind !== "house" && b.kind !== "farmhouse") || !b.openings.some((o) => o.kind === "door") || inHouse(i).length > 0) return; const c = centre(b); const d = Math.hypot(c.x - x, c.y - y); if (d < bd) { bd = d; best = i; } });
    const c = centre(map.buildings[best]); globalThis.__c = { i: best, x: c.x, y: c.y, sq };
    t.clearAt(c.x, c.y);
    for (let k = 0; k < 60 && s.unit.get(sq).drill?.kind !== "clear"; k++) t.stepTicks(30);
    const stage = () => s.unit.get(sq).drill?.stage;
    let k = 0; for (; k < 120 && stage() === undefined && s.unit.get(sq).drill; k++) t.stepTicks(60 * 3);
    const d = s.unit.get(sq).drill; if (d) globalThis.__c.door = { x: d.x, y: d.y };
    const f = globalThis.__c.door ?? c; t.focusScale((f.x + c.x) / 2, (f.y + c.y) / 2, ${zoom}); t.stepTicks(1);
    return { house: best, dist: Math.round(bd), stage: stage() ?? null, drill: s.unit.get(sq).drill?.kind ?? null, tick: s.tick };`) as () => object);
  await shot("4-closing-on-the-door");
  info["throw"] = await page.evaluate(new Function(`const t = globalThis.__tcs, s = t.sim.state, h = globalThis.__c;
    const stage = () => s.unit.get(h.sq).drill?.stage;
    for (let k = 0; k < 40 && stage() !== undefined && stage() !== "enter"; k++) t.stepTicks(30);
    t.stepTicks(90); const f = h.door ?? h; t.focusScale((f.x + h.x) / 2, (f.y + h.y) / 2, ${zoom}); t.stepTicks(1);
    return { stage: stage() ?? null, room: s.unit.get(h.sq).drill?.room ?? null, tick: s.tick };`) as () => object);
  await shot("5-stacked-beside-the-door");
  info["enter"] = await page.evaluate(new Function(`const t = globalThis.__tcs, s = t.sim.state, h = globalThis.__c;
    const stage = () => s.unit.get(h.sq).drill?.stage;
    for (let k = 0; k < 240 && s.unit.get(h.sq).drill?.kind === "clear" && stage() !== "enter"; k++) t.stepTicks(30);
    t.stepTicks(200); t.focusScale(h.x, h.y, ${zoom}); t.stepTicks(1);
    return { stage: stage() ?? null, room: s.unit.get(h.sq).drill?.room ?? null, tick: s.tick };`) as () => object);
  await shot("6-going-in");
  info["done"] = await page.evaluate(new Function(`const t = globalThis.__tcs, s = t.sim.state, h = globalThis.__c;
    for (let k = 0; k < 100 && s.unit.get(h.sq).drill?.kind === "clear"; k++) t.stepTicks(60 * 3);
    t.stepTicks(60 * 2); t.focusScale(h.x, h.y, ${zoom}); t.stepTicks(1);
    return { drill: s.unit.get(h.sq).drill?.kind ?? null, tick: s.tick };`) as () => object);
  await shot("7-house-clear");
  console.log(`${name}: buildings scene ${JSON.stringify(info)}; page errors: ${errors.length ? errors.join(" | ") : "none"}`);
}

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
    if (args["scene"] === "vehicles") { await vehicleScenes(page, name, errors, shots); await page.close(); continue; }
    if (args["scene"] === "missile") { await missileScenes(page, name, errors, shots); await page.close(); continue; }
    if (args["scene"] === "ui") { await uiScenes(page, name, errors, shots); await page.close(); continue; }
    if (args["scene"] === "look") { await lookScenes(page, name, errors, shots); await page.close(); continue; }
    if (args["scene"] === "photo") { await photoScenes(page, name, errors, shots); await page.close(); continue; }
    if (args["scene"] === "interiors") { await interiorScenes(page, name, errors, shots); await page.close(); continue; }
    if (args["scene"] === "buildings") { await buildingScenes(page, name, errors, shots); await page.close(); continue; }
    if (args["scene"] === "floors") { await floorScenes(page, name, errors, shots); await page.close(); continue; }
    if (args["scene"] === "controls") { await controlScenes(page, name, errors, shots); await page.close(); continue; }
    if (args["scene"] === "card") { await cardScenes(page, name, errors, shots); await page.close(); continue; }
    if (args["scene"] === "mapfeel") { await mapfeelScenes(page, name, errors, shots); await page.close(); continue; }
    if (args["scene"] === "firesupport") { await fireSupportScenes(page, name, errors, shots); await page.close(); continue; }
    if (args["scene"] === "review") {
      // (Its own page at device pixel ratio 2.)
      await page.close();
      const p2 = await browser.newPage({ viewport: vp, deviceScaleFactor: 2, hasTouch: name === "phone" });
      p2.on("pageerror", (e) => errors.push(e.message));
      p2.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
      await reviewScenes(p2, name, errors, shots); await p2.close(); continue;
    }
    await page.goto(`http://localhost:${port}/?scenario=demo&seed=${seed}&map=${mapKind}`);
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
    // M5: a route of three legs (crawl, run, walk) ending in a wedge marker turned north-east, 50 m wide, with
    // the rules panel open; then the plan is dropped (nothing is ordered: the scenes below stay as they were).
    await page.evaluate(new Function(`const t = globalThis.__tcs, s = t.sim.state; let x = 0, y = 0, n = 0;
      for (const [id, i] of s.identity.entries()) if (i.side === "blue") { const p = s.transform.get(id); x += p.x; y += p.y; n++; }
      x /= n; y /= n;
      t.planMove([{ x: x + 40, y, mode: "crawl" }, { x: x + 110, y: y - 30, mode: "run" }, { x: x + 170, y: y - 40, mode: "walk" }], -0.6, 50);
      t.showRules(); t.focus(x + 90, y - 20, 300); t.stepTicks(1);`) as () => void);
    await page.waitForTimeout(300);
    const p0b = `${outDir}/${mapKind}-${seed}-${name}-0b-plan-and-rules.png`;
    await page.screenshot({ path: p0b }); shots.push(p0b);
    await page.evaluate(new Function("const t = globalThis.__tcs; t.cancelPlan(); t.showRules(); t.stepTicks(1);") as () => void);
    // Order the blue team toward the map centre (through the village on village maps), advance 40 s of game
    // time, and switch the debug view on so the navigation grid and the planned route are visible.
    await page.evaluate(new Function(`const t = globalThis.__tcs; const m = t.sim.ctx.map;
      t.tap(m.widthM > 600 ? m.widthM * 0.55 : 200, m.widthM > 600 ? m.heightM * 0.5 : 90); t.stepTicks(60 * 40);
      let x = 0, y = 0, n = 0; for (const [id, i] of t.sim.state.identity.entries()) if (i.side === "blue") { const p = t.sim.state.transform.get(id); x += p.x; y += p.y; n++; }
      t.focus(x / n + 30, y / n, 160); t.stepTicks(1);`) as () => void);
    await page.waitForTimeout(300);
    // On the move, normal view: one route line (the leader's) for the selected unit, no trace per man.
    const p1a = `${outDir}/${mapKind}-${seed}-${name}-1a-moving.png`;
    await page.screenshot({ path: p1a }); shots.push(p1a);
    await page.evaluate(new Function("const t = globalThis.__tcs; t.setDebug(true); t.stepTicks(1);") as () => void);
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
    await page.goto(`http://localhost:${port}/?scenario=demo&seed=${seed}&map=flat`);
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
    await page.goto(`http://localhost:${port}/?scenario=demo&seed=${seed}&map=flat`);
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
    // M4: an assault by bounds, Debug on: rings, decision lines, the drill on the leader's label.
    const as = await page.evaluate(new Function(`const t = globalThis.__tcs, s = t.sim.state; t.setSpeed(0);
      let ex = 0, ey = 0, n = 0, ox = 0, oy = 0, k = 0; const me = [...s.identity.entries()].find(([id]) => s.fire.has(id) || true)[1].side;
      for (const [id, i] of s.identity.entries()) { const p = s.transform.get(id); if (!p || s.soldier.get(id).casualty !== "none" || s.soldier.get(id).captive !== null) continue; if (i.side === "blue") { ox += p.x; oy += p.y; k++; } else { ex += p.x; ey += p.y; n++; } }
      if (n === 0 || k === 0) return { ok: false };
      t.assault(ex / n, ey / n); t.stepTicks(60 * 15); t.setDebug(true); t.focus(ox / k + 0.3 * (ex / n - ox / k), oy / k + 0.3 * (ey / n - oy / k), 160); t.stepTicks(1);
      const u = [...s.unit.entries()].find(([, x]) => x.side === "blue" && x.parent === null)[1];
      return { ok: true, drill: u.drill ? u.drill.kind + (u.drill.final ? " final" : " half " + (u.drill.mover + 1)) : (u.broken ? "broken" : "none") };`) as () => { ok: boolean; drill?: string });
    await page.waitForTimeout(300);
    const p7 = `${outDir}/${mapKind}-${seed}-${name}-7-assault-debug.png`;
    await page.screenshot({ path: p7 }); shots.push(p7);
    console.log(`${name}: assault scene ${JSON.stringify(as)}`);
    console.log(`${name}: grenade thrown after ${gr.thrownAfterTicks} ticks (${gr.inFlight} in flight); at the burst ${burst.fragments} fragments in the air, ${burst.craters} crater(s), page errors: ${errors.length ? errors.join(" | ") : "none"}`);
    await page.close();
  }
  // M6: the platoon battle (first playable): objectives and the score line at the start; after a short battle
  // (5 min, the AI commands red, blue holds still) the after-action review, then the heat map.
  for (const [name, vp] of args["scene"] === "ui" || args["scene"] === "look" || args["scene"] === "photo" || args["scene"] === "interiors" || args["scene"] === "floors" || args["scene"] === "missile" || args["scene"] === "controls" || args["scene"] === "card" || args["scene"] === "mapfeel" || args["scene"] === "firesupport" || args["scene"] === "review" ? [] : [["phone", { width: 390, height: 844 }], ["desktop", { width: 1280, height: 800 }]] as const) {
    const page = await browser.newPage({ viewport: vp, deviceScaleFactor: scale, hasTouch: name === "phone" });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`http://localhost:${port}/?seed=${seed}&map=village&side=red&attacker=blue&limit=600&vehicles=0`);
    await page.waitForFunction(new Function("return globalThis.__tcs?.ready === true") as () => boolean, null, { timeout: 20000 });
    await page.evaluate(new Function("globalThis.__tcs.setSpeed(0); globalThis.__tcs.stepTicks(60);") as () => void);
    await page.waitForTimeout(700);
    const q0 = `${outDir}/platoon-${seed}-${name}-0-start.png`;
    await page.screenshot({ path: q0 }); shots.push(q0);
    await page.evaluate(new Function("globalThis.__tcs.stepTicks(600 * 60);") as () => void);
    await page.waitForTimeout(900);
    const q1 = `${outDir}/platoon-${seed}-${name}-1-after-action.png`;
    await page.screenshot({ path: q1 }); shots.push(q1);
    await page.evaluate(new Function("const b = [...document.querySelectorAll('.hud-aar button')][0]; if (b) b.click();") as () => void);
    await page.waitForTimeout(500);
    const q2 = `${outDir}/platoon-${seed}-${name}-2-heat-map.png`;
    await page.screenshot({ path: q2 }); shots.push(q2);
    console.log(`${name}: platoon battle, page errors: ${errors.length ? errors.join(" | ") : "none"}`);
    await page.close();
  }
  await browser.close();
  console.log(`Screenshots:\n${shots.join("\n")}`);
} finally {
  server.kill();
}
process.exit(0);
