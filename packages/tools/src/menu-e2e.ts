/**
 * THE START MENU IN THE BROWSER (owner 2026-11-20), driven by Playwright: the menu on the bare URL, a quick battle
 * chosen and started (the URL it opens), the battle's Menu button back (asked first), the remembered choices and the
 * "Play again" row, every mode's screen, the phone's back button, the campaign handed over (its saves page, a new
 * campaign started from the menu, "Continue the campaign") and the campaign home's way back. The screenshots of every
 * menu screen on the way (`npm run screenshot -- --scene menu`); `npm run e2e:menu` runs the checks alone.
 * Review step 5: the battle type and size rows and the forces line, the URL they write, and the briefing the battle
 * opens on (paused; the role's fire rule; again from the battle's menu). `briefingShots`: the briefing's pictures
 * (`npm run screenshot -- --scene briefing`).
 *
 * Debug hooks: the menu's `__tcsMenu.state()`, the battle's `__tcs`, the campaign page's `__tcsCampaign.state()`.
 */

export interface MenuPage {
  goto(url: string): Promise<unknown>;
  waitForFunction(f: () => boolean, arg: null, opts: { timeout: number }): Promise<unknown>;
  evaluate<T>(f: () => T): Promise<T>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(o: { path: string }): Promise<unknown>;
  click(selector: string): Promise<void>;
  isVisible(selector: string): Promise<boolean>;
  on(ev: "dialog", f: (d: { accept(text?: string): Promise<void> }) => void): void;
}

export interface MenuE2eOptions {
  base: string;
  /** Where the screenshots go (null: none); `name` the viewport's. */
  shots: { dir: string; name: string; list: string[] } | null;
  look: "photo" | "flat";
  /** false: only the screens' pictures (another viewport or look), not the whole flow. */
  flow: boolean;
  log(msg: string): void;
}

type MenuState = { screen: string; choices: { seed: number; quick: { kind: string; role: string; size: string; forces: string; time: string } }; continues: string[]; look: string };
type BriefState = { open: boolean; mode: string | null; model: { role: string | null; fire: { key: string }[]; own: { men: number; units: string[] } } | null };

const fn = <T>(body: string) => new Function(body) as () => T;

export class MenuE2eFailure extends Error {}
function check(ok: boolean, what: string): void {
  if (!ok) throw new MenuE2eFailure(`menu e2e: ${what}`);
}

export async function menuE2e(page: MenuPage, o: MenuE2eOptions): Promise<string[]> {
  const passed: string[] = [];
  const pass = (s: string) => { passed.push(s); o.log(`  ok  ${s}`); };
  const state = () => page.evaluate(fn<MenuState>("return globalThis.__tcsMenu.state();"));
  const menuReady = () => page.waitForFunction(fn<boolean>("return globalThis.__tcsMenu?.ready === true;"), null, { timeout: 60_000 });
  const battleReady = () => page.waitForFunction(fn<boolean>("return globalThis.__tcs?.ready === true;"), null, { timeout: 90_000 });
  const campaignReady = (screen?: string) => page.waitForFunction(fn<boolean>(`const s = globalThis.__tcsCampaign?.state?.(); return globalThis.__tcsCampaign?.ready === true && !!s && !s.busy${screen ? ` && s.screen === ${JSON.stringify(screen)}` : ""};`), null, { timeout: 120_000 });
  const search = () => page.evaluate(fn<string>("return location.search;"));
  const shot = async (label: string, bottom = false) => {
    if (!o.shots) return;
    await page.evaluate(fn(`const e = document.querySelector(".cmp-scroll"); if (e) e.scrollTop = ${bottom ? "e.scrollHeight" : "0"};`));
    await page.waitForTimeout(200);
    const p = `${o.shots.dir}/menu-${o.shots.name}-${o.look}-${label}.png`;
    await page.screenshot({ path: p });
    o.shots.list.push(p);
  };
  const open = async (mode: string) => {
    await page.click(`[data-act=mode-${mode}]`);
    check((await state()).screen === mode, `the ${mode} tile opens its screen`);
  };
  const back = async () => { await page.click("[data-act=back]"); await page.waitForTimeout(150); check((await state()).screen === "home", "back returns to the menu"); };
  page.on("dialog", (d) => { void d.accept(); });

  // 1. The bare URL: the menu (a clean browser: nothing to continue).
  await page.goto(`${o.base}/?menu=1&look=${o.look}`);
  await menuReady();
  if (o.flow) {
    await page.evaluate(fn(`localStorage.clear(); return new Promise((r) => { const q = indexedDB.deleteDatabase("tcs-campaign"); q.onsuccess = q.onerror = q.onblocked = () => r(true); });`));
    await page.evaluate(fn(`localStorage.setItem("tcs.ui.look", ${JSON.stringify(o.look)});`));
    await page.goto(`${o.base}/`);
    await menuReady();
    const s = await state();
    check(s.screen === "home" && s.continues.length === 0, `the bare URL shows the menu with nothing to continue (${JSON.stringify(s.continues)})`);
    check(s.look === o.look, `the remembered look (${s.look})`);
    pass("the bare URL opens the menu");
  }
  await shot("0-home");

  // 2. Every mode's screen.
  for (const m of ["quick", "campaign", "hold", "assault", "more"]) {
    await open(m);
    await shot(`1-${m}`);
    if (m === "quick") {
      await shot("1-quick-bottom", true);
      // Review step 5: the battle type and the size change the rows under them and the line saying what each side gets.
      const line = () => page.evaluate(fn<string>(`return document.querySelector(".menu-forces-line")?.textContent ?? "";`));
      const has = (sel: string) => page.evaluate(fn<boolean>(`return document.querySelector(${JSON.stringify(sel)}) !== null;`));
      const l0 = await line();
      check(/2 platoons/.test(l0) && /1 platoon\b/.test(l0), `the plain attack's line says two platoons against one (${l0})`);
      await page.click("[data-group=kind] [data-val=ambush]");
      const l1 = await line();
      check(l1 !== l0 && !/2 platoons/.test(l1), `the line follows the battle type (${l1})`);
      const roleText = await page.evaluate(fn<string>(`return document.querySelector("[data-group=role] [data-val=defend]")?.textContent ?? "";`));
      check(roleText !== "" && roleText !== "Defend", `the task chips are named for the battle type (${roleText})`);
      await page.click("[data-group=role] [data-val=defend]");
      await page.click("[data-group=size] [data-val=company]");
      const l2 = await line();
      check(/3 platoons/.test(l2), `the line follows the size (${l2})`);
      check(!(await has("[data-group=tanks]")), "a company has no Tanks row (its support brings them)");
      const url = await page.evaluate(fn<string>(`const m = globalThis.__tcsMenu, c = m.state().choices; return m.launchSearch({ mode: "quick", c: c.quick, seed: 5, look: "photo" });`));
      check(/kind=ambush/.test(url) && /size=company/.test(url) && /brief=1/.test(url), `the URL of a company ambush (${url})`);
      await shot("1-quick-ambush-company");
      await page.click("[data-group=kind] [data-val=meeting]");
      check(!(await has("[data-group=role]")), "a meeting has no task row");
      const wide = await page.evaluate(fn<number>("return document.documentElement.scrollWidth - innerWidth;"));
      check(wide <= 0, `the quick screen does not scroll sideways (${wide} px)`);
      await page.click("[data-group=kind] [data-val=attack]");
      await page.click("[data-group=role] [data-val=attack]");
      await page.click("[data-group=size] [data-val=platoon]");
      check((await line()) === l0, "back to the plain attack: the first line again");
    }
    await back();
  }
  pass("every mode's screen opens and goes back");
  if (!o.flow) return passed;

  // 3. The phone's back button leaves a mode's screen for the menu.
  await open("hold");
  await page.evaluate(fn("history.back();"));
  await page.waitForFunction(fn<boolean>(`return globalThis.__tcsMenu.state().screen === "home";`), null, { timeout: 5000 });
  pass("the browser's back button returns to the menu's first screen");

  // 4. A quick battle on foot at dusk: the URL the app has always taken.
  // (Review step 5: of the type "ambush", laying it: the URL carries the type and opens on the briefing.)
  await open("quick");
  await page.click("[data-group=kind] [data-val=ambush]");
  await page.click("[data-group=role] [data-val=defend]");
  await page.click("[data-group=forces] [data-val=foot]");
  await page.click("[data-group=time] [data-val=dusk]");
  const before = await state();
  check(before.choices.quick.forces === "foot" && before.choices.quick.time === "dusk" && before.choices.quick.kind === "ambush" && before.choices.quick.role === "defend", "the chips set the choices");
  await page.click("[data-act=start]");
  await battleReady();
  const q = new URLSearchParams(await search());
  check(q.get("scenario") === "platoon" && q.get("vehicles") === "0" && q.get("time") === "18:30" && q.get("seed") === String(before.choices.seed) && q.get("attacker") === "red" && q.get("side") === "blue"
    && q.get("kind") === "ambush" && q.get("size") === null && q.get("brief") === "1",
    `the quick battle's URL (${q.toString()})`);
  pass(`Start opens the battle: ?${q.toString()}`);

  // 4b. The briefing: open before the battle, the battle paused; the fire rule of the role (an ambush laid on every
  // own unit from the first tick); Start runs the battle; "Briefing" (behind "⋯" on a phone) shows it again, paused.
  const brief = () => page.evaluate(fn<BriefState>("return globalThis.__tcs.briefing();"));
  const tick = () => page.evaluate(fn<number>("return globalThis.__tcs.sim.state.tick;"));
  const b0 = await brief();
  check(b0.open && b0.mode === "start" && b0.model !== null, `the battle opens on its briefing (${JSON.stringify({ open: b0.open, mode: b0.mode })})`);
  check(b0.model!.role === "ambush" && b0.model!.fire[0]!.key === "brief.fire.ambush", `the briefing names the role's fire rule (${b0.model!.role}, ${b0.model!.fire[0]!.key})`);
  const t0 = await tick();
  await page.waitForTimeout(1000);
  check((await tick()) === t0 && t0 === 0, `the battle waits while the briefing is open (tick ${t0})`);
  const rules = await page.evaluate(fn<{ fire: string; ambushM: number | null }[]>("return globalThis.__tcs.fireRules();"));
  check(rules.length > 0 && rules.every((r) => r.ambushM === 220 && r.fire === "free"), `every own unit starts in the ambush (${JSON.stringify(rules.slice(0, 2))})`);
  const sideways = await page.evaluate(fn<number>(`const e = document.querySelector(".brief .cmp-scroll"); return e ? e.scrollWidth - e.clientWidth : 99;`));
  check(sideways <= 0, `the briefing does not scroll sideways (${sideways} px)`);
  if (o.shots) { const p = `${o.shots.dir}/menu-${o.shots.name}-${o.look}-2a-briefing.png`; await page.screenshot({ path: p }); o.shots.list.push(p); }
  await page.click(".brief [data-act=start]");
  await page.waitForFunction(fn<boolean>("return globalThis.__tcs.sim.state.tick > 30;"), null, { timeout: 30_000 });
  check(!(await brief()).open, "Start closes the briefing");
  pass("the briefing: shown first, the battle paused, the role's fire rule; Start runs the battle");
  if (!(await page.isVisible("[data-act=briefing]"))) await page.click(".hud-bar > .hud-more-btn");
  await page.click("[data-act=briefing]");
  const b1 = await brief();
  check(b1.open && b1.mode === "resume", "Briefing in the battle's menu shows it again");
  const t1 = await tick();
  await page.waitForTimeout(600);
  check((await tick()) === t1, "the battle is paused while the briefing is read again");
  await page.click(".brief [data-act=start]");
  await page.waitForFunction(fn<boolean>(`const t = globalThis.__tcs.sim.state.tick; return t > ${t1};`), null, { timeout: 30_000 });
  pass("Briefing again from the battle: paused, then back at the speed before");
  await page.evaluate(fn("globalThis.__tcs.setSpeed(0);"));
  await page.waitForFunction(fn<boolean>("return (globalThis.__tcs?.tilesPending?.() ?? 0) === 0;"), null, { timeout: 30_000 });
  if (o.shots) { const p = `${o.shots.dir}/menu-${o.shots.name}-${o.look}-2-battle.png`; await page.screenshot({ path: p }); o.shots.list.push(p); }

  // 5. The battle's Menu button (behind "⋯" on a narrow screen), asked first: the menu, the choices remembered.
  if (!(await page.isVisible("[data-act=menu]"))) await page.click(".hud-bar > .hud-more-btn");
  await page.click("[data-act=menu]");
  await menuReady();
  const after = await state();
  check(after.continues.includes("again"), `the menu offers the last battle again (${JSON.stringify(after.continues)})`);
  check(after.choices.quick.forces === "foot" && after.choices.quick.time === "dusk" && after.choices.quick.kind === "ambush" && after.choices.quick.role === "defend", "the quick battle's choices are remembered");
  const again = await page.evaluate(fn<string>(`return document.querySelector("[data-act=continue-again] .menu-tile-info")?.textContent ?? "";`));
  check(/Ambush/.test(again), `"Play the last battle again" names its type (${again})`);
  pass("Menu in the battle (confirmed) returns to the menu; choices and the last battle remembered");
  await shot("3-home-continue");

  // 6. Play again: the same URL.
  await page.click("[data-act=continue-again]");
  await battleReady();
  check(new URLSearchParams(await search()).toString() === q.toString(), "Play again opens the same battle");
  check((await brief()).open, "... on its briefing again");
  pass("Play the last battle again");

  // 7. The campaign: its saves page, and back to the menu from the campaign home.
  await page.goto(`${o.base}/`);
  await menuReady();
  await open("campaign");
  await page.click("[data-act=campaign-saves]");
  await campaignReady("home");
  check((await search()).includes("campaign=1"), "Saves opens the campaign page");
  await page.click("[data-act=single]");
  await menuReady();
  pass("campaign page from the menu, and its Main menu button back");

  // 8. A new campaign from the menu: straight to its briefing; then Continue the campaign from the menu.
  await open("campaign");
  await page.click("[data-group=mode] [data-val=endless]");
  await page.click("[data-act=campaign-new]");
  await campaignReady("briefing");
  const cs = await search();
  check(!cs.includes("new=1"), `the new campaign's page drops new=1 from its URL (${cs})`);
  pass("a new campaign started from the menu opens its briefing");
  await page.goto(`${o.base}/`);
  await menuReady();
  await page.waitForFunction(fn<boolean>(`return globalThis.__tcsMenu.state().continues.includes("campaign");`), null, { timeout: 10_000 });
  await shot("4-home-campaign");
  await page.click("[data-act=continue-campaign]");
  await campaignReady("briefing");
  pass("Continue the campaign opens it where it stands");
  return passed;
}

/**
 * The briefing's pictures (review step 5): the mounted attack and a laid ambush, each before the battle (top and
 * bottom of the card) and the attack's again from the battle ("resume"), in one viewport and look. With checks: the
 * card is open, nothing scrolls sideways, its main button is on the screen.
 */
export async function briefingShots(page: MenuPage, o: { base: string; shots: { dir: string; name: string; list: string[] }; look: "photo" | "flat" }): Promise<string[]> {
  const passed: string[] = [];
  const battleReady = () => page.waitForFunction(fn<boolean>("return globalThis.__tcs?.ready === true;"), null, { timeout: 120_000 });
  const shot = async (label: string) => { const p = `${o.shots.dir}/briefing-${o.shots.name}-${o.look}-${label}.png`; await page.screenshot({ path: p }); o.shots.list.push(p); };
  const scroll = (bottom: boolean) => page.evaluate(fn(`const e = document.querySelector(".brief .cmp-scroll"); if (e) e.scrollTop = ${bottom ? "e.scrollHeight" : "0"};`));
  const checks = async (what: string) => {
    const r = await page.evaluate(fn<{ open: boolean; wide: number; btn: { top: number; bottom: number; left: number; right: number } | null; w: number; h: number }>(
      `const e = document.querySelector(".brief .cmp-scroll"), b = document.querySelector(".brief [data-act=start]")?.getBoundingClientRect();
       return { open: globalThis.__tcs.briefing().open, wide: e ? e.scrollWidth - e.clientWidth : 99, btn: b ? { top: b.top, bottom: b.bottom, left: b.left, right: b.right } : null, w: innerWidth, h: innerHeight };`));
    check(r.open, `${what}: the briefing is open`);
    check(r.wide <= 0, `${what}: no sideways scroll (${r.wide} px)`);
    check(r.btn !== null && r.btn.top >= 0 && r.btn.bottom <= r.h + 0.5 && r.btn.left >= 0 && r.btn.right <= r.w + 0.5, `${what}: the main button is on the screen (${JSON.stringify(r.btn)} in ${r.w} x ${r.h})`);
    passed.push(what);
  };
  for (const [label, query] of [["attack", "scenario=platoon&side=blue&attacker=blue&map=village&seed=3"], ["ambush", "scenario=platoon&kind=ambush&side=blue&attacker=red&vehicles=0&map=village&time=18:30&seed=3"],
    ["company", "scenario=platoon&kind=defence-counterattack&size=company&side=blue&attacker=red&tanks=1&map=village&seed=3"]] as const) {
    await page.goto(`${o.base}/?${query}&look=${o.look}&brief=1`);
    await battleReady();
    await page.waitForFunction(fn<boolean>("return (globalThis.__tcs?.tilesPending?.() ?? 0) === 0;"), null, { timeout: 60_000 });
    await checks(`${label} briefing`);
    await shot(`${label}-top`);
    await scroll(true);
    await page.waitForTimeout(150);
    await checks(`${label} briefing, scrolled down`);
    await shot(`${label}-bottom`);
    if (label !== "attack") continue;
    // Again from the battle: closed, the battle seen behind it; then the button (behind "⋯" on a phone).
    await page.click(".brief [data-act=start]");
    await page.waitForFunction(fn<boolean>("return globalThis.__tcs.sim.state.tick > 5;"), null, { timeout: 30_000 });
    if (!(await page.isVisible("[data-act=briefing]"))) { await page.click(".hud-bar > .hud-more-btn"); await page.waitForTimeout(150); await shot("attack-menu"); }
    await page.click("[data-act=briefing]");
    await page.waitForTimeout(150);
    await checks("attack briefing, again from the battle");
    await shot("attack-resume");
  }
  return passed;
}
