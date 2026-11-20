/**
 * THE START MENU IN THE BROWSER (owner 2026-11-20), driven by Playwright: the menu on the bare URL, a quick battle
 * chosen and started (the URL it opens), the battle's Menu button back (asked first), the remembered choices and the
 * "Play again" row, every mode's screen, the phone's back button, the campaign handed over (its saves page, a new
 * campaign started from the menu, "Continue the campaign") and the campaign home's way back. The screenshots of every
 * menu screen on the way (`npm run screenshot -- --scene menu`); `npm run e2e:menu` runs the checks alone.
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

type MenuState = { screen: string; choices: { seed: number; quick: { forces: string; time: string } }; continues: string[]; look: string };

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
    if (m === "quick") await shot("1-quick-bottom", true);
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
  await open("quick");
  await page.click("[data-group=forces] [data-val=foot]");
  await page.click("[data-group=time] [data-val=dusk]");
  await page.click("[data-group=role] [data-val=defend]");
  const before = await state();
  check(before.choices.quick.forces === "foot" && before.choices.quick.time === "dusk", "the chips set the choices");
  await page.click("[data-act=start]");
  await battleReady();
  const q = new URLSearchParams(await search());
  check(q.get("scenario") === "platoon" && q.get("vehicles") === "0" && q.get("time") === "18:30" && q.get("seed") === String(before.choices.seed) && q.get("attacker") === "red" && q.get("side") === "blue",
    `the quick battle's URL (${q.toString()})`);
  pass(`Start opens the battle: ?${q.toString()}`);
  await page.evaluate(fn("globalThis.__tcs.setSpeed(0);"));
  await page.waitForFunction(fn<boolean>("return (globalThis.__tcs?.tilesPending?.() ?? 0) === 0;"), null, { timeout: 30_000 });
  if (o.shots) { const p = `${o.shots.dir}/menu-${o.shots.name}-${o.look}-2-battle.png`; await page.screenshot({ path: p }); o.shots.list.push(p); }

  // 5. The battle's Menu button (behind "⋯" on a narrow screen), asked first: the menu, the choices remembered.
  if (!(await page.isVisible("[data-act=menu]"))) await page.click(".hud-bar > .hud-more-btn");
  await page.click("[data-act=menu]");
  await menuReady();
  const after = await state();
  check(after.continues.includes("again"), `the menu offers the last battle again (${JSON.stringify(after.continues)})`);
  check(after.choices.quick.forces === "foot" && after.choices.quick.time === "dusk", "the quick battle's choices are remembered");
  pass("Menu in the battle (confirmed) returns to the menu; choices and the last battle remembered");
  await shot("3-home-continue");

  // 6. Play again: the same URL.
  await page.click("[data-act=continue-again]");
  await battleReady();
  check(new URLSearchParams(await search()).toString() === q.toString(), "Play again opens the same battle");
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
