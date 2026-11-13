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
 * M7.5b look (`--scene look`): the pixel look against the classic one (`&look=classic`) where a pair helps —
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
  for (const lk of ["classic", "pixel"]) {
    const q = `&map=village${lk === "classic" ? "&look=classic" : ""}`;
    await open(q);
    await shot(`0-opening-${lk}`);
    await page.evaluate(new Function(`const t = globalThis.__tcs, s = t.sim.state; ${centre} const c = own("blue"); t.focusScale(c.x, c.y, 2.5); t.stepTicks(1);`) as () => void);
    await shot(`1-mid-${lk}`);
    await page.evaluate(new Function(`const t = globalThis.__tcs, s = t.sim.state; ${centre} const c = own("blue"); t.focusScale(c.x, c.y, 0.01); t.stepTicks(1);`) as () => void);
    await shot(`2-far-${lk}`);
    // A squad on foot firing, close up: the platoon battle on foot, the first squad fires east.
    await open(`&map=village&vehicles=0${lk === "classic" ? "&look=classic" : ""}`);
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
    if (args["scene"] === "interiors") { await interiorScenes(page, name, errors, shots); await page.close(); continue; }
    if (args["scene"] === "floors") { await floorScenes(page, name, errors, shots); await page.close(); continue; }
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
  for (const [name, vp] of args["scene"] === "ui" || args["scene"] === "look" || args["scene"] === "interiors" || args["scene"] === "floors" || args["scene"] === "missile" ? [] : [["phone", { width: 390, height: 844 }], ["desktop", { width: 1280, height: 800 }]] as const) {
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
