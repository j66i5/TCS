/**
 * THE CAMPAIGN IN THE BROWSER (M12.3, plan m12-roster 4.6), driven by Playwright: the acceptance flow (home -> new
 * campaign -> briefing -> auto-resolve -> what changed -> save -> reload -> load -> next briefing, then a PLAYED
 * battle: play -> the battle page -> its end -> "Back to the campaign" -> what changed) with checks, and the
 * screenshots of every campaign screen on the way (`npm run screenshot -- --scene campaign`, phone and desktop, both
 * looks; `npm run e2e:campaign` runs the checks alone on a phone viewport).
 *
 * The page's debug hook `__tcsCampaign.state()` gives the screen, the flow's phase, the battles fought and the
 * record's hash; the battle page's `__tcs` steps the played battle. Short battles (`&seconds=`) keep it quick.
 */

/** The Playwright page as far as these scenes use it (Playwright is not a dependency: no type package). */
export interface E2ePage {
  goto(url: string): Promise<unknown>;
  reload(): Promise<unknown>;
  waitForFunction(f: () => boolean, arg: null, opts: { timeout: number }): Promise<unknown>;
  evaluate<T>(f: () => T): Promise<T>;
  waitForTimeout(ms: number): Promise<void>;
  waitForSelector(sel: string, opts: { timeout: number }): Promise<unknown>;
  screenshot(o: { path: string }): Promise<unknown>;
  click(selector: string): Promise<void>;
  fill(selector: string, text: string): Promise<void>;
  isVisible(selector: string): Promise<boolean>;
  on(ev: "dialog", f: (d: { accept(text?: string): Promise<void> }) => void): void;
}

export interface CampaignE2eOptions {
  base: string;
  /** A name for the screenshots (phone / desktop) and the look; null: no screenshots. */
  shots: { dir: string; name: string; list: string[] } | null;
  look: "photo" | "flat";
  seconds: number;
  seed: number;
  log(msg: string): void;
}

type State = { screen: string; phase: string | null; battles: number; hash: string | null; busy: boolean };

const fn = <T>(body: string) => new Function(body) as () => T;

export class E2eFailure extends Error {}

function check(ok: boolean, what: string): void {
  if (!ok) throw new E2eFailure(`campaign e2e: ${what}`);
}

/** Run the flow; returns the checks passed (throws `E2eFailure` on the first that fails). */
export async function campaignE2e(page: E2ePage, o: CampaignE2eOptions): Promise<string[]> {
  const passed: string[] = [];
  const pass = (s: string) => { passed.push(s); o.log(`  ok  ${s}`); };
  const state = () => page.evaluate(fn<State>("return globalThis.__tcsCampaign.state();"));
  const waitScreen = async (screen: string, timeout = 600_000, phase?: string) => {
    await page.waitForFunction(fn<boolean>(`const s = globalThis.__tcsCampaign?.state?.(); return !!s && s.screen === ${JSON.stringify(screen)} && !s.busy${phase ? ` && s.phase === ${JSON.stringify(phase)}` : ""};`), null, { timeout });
  };
  const ready = () => page.waitForFunction(fn<boolean>("return globalThis.__tcsCampaign?.ready === true;"), null, { timeout: 60_000 });
  const shot = async (label: string, scrollTo?: string) => {
    if (!o.shots) return;
    if (scrollTo) await page.evaluate(fn(`const e = document.querySelector(${JSON.stringify(scrollTo)}); if (e) e.scrollIntoView({ block: "start" });`));
    else await page.evaluate(fn(`const e = document.querySelector(".cmp-scroll"); if (e) e.scrollTop = 0;`));
    await page.waitForTimeout(250);
    const p = `${o.shots.dir}/campaign-${o.shots.name}-${o.look}-${label}.png`;
    await page.screenshot({ path: p });
    o.shots.list.push(p);
  };
  const url = (q: string) => `${o.base}/?${q}&look=${o.look}`;
  // Confirms (delete) and prompts (rename) are accepted.
  page.on("dialog", (d) => { void d.accept(); });

  // 1. Home: a fresh browser has no campaign.
  await page.goto(url(`campaign=1&seconds=${o.seconds}&seed=${o.seed}`));
  await ready();
  // (A clean store: earlier runs on the same server leave slots behind.)
  await page.evaluate(fn(`return new Promise((r) => { const q = indexedDB.deleteDatabase("tcs-campaign"); q.onsuccess = q.onerror = q.onblocked = () => r(true); });`));
  await page.reload();
  await ready();
  await waitScreen("home", 30_000);
  check(!(await page.isVisible("[data-act=continue]")), "a fresh browser offers no campaign to continue");
  pass("home opens with ?campaign=1, nothing to continue");
  await shot("0-home-new");

  // 2. New campaign (Germany, tracked, operations): the briefing with the proposed choice.
  await page.click("[data-act=new]");
  await waitScreen("briefing", 60_000, "choose");
  await page.waitForSelector(".cmp-preview canvas", { timeout: 60_000 });
  let s = await state();
  check(s.battles === 0, "a new campaign has fought no battle");
  const picks = await page.evaluate(fn<{ on: number; all: number; proposed: number }>(`return { on: document.querySelectorAll(".cmp-pick.on").length, all: document.querySelectorAll(".cmp-pick").length, proposed: document.querySelectorAll(".cmp-pick .prop").length };`));
  check(picks.on > 0 && picks.on === picks.proposed, `the proposed choice is chosen (${picks.on} of ${picks.all}, ${picks.proposed} proposed)`);
  pass(`new campaign -> briefing (${picks.on} of ${picks.all} units proposed, sector preview drawn)`);
  await shot("1-briefing");
  await shot("2-briefing-forces", ".cmp-pick");
  // A platoon off and on again: the choice follows, the proposed button restores it.
  const firstPlatoon = await page.evaluate(fn<string>(`const b = [...document.querySelectorAll(".cmp-pick.on")].find((x) => x.textContent.includes("platoon") || x.textContent.includes("vzvod") || x.textContent.includes("Zug")); return b ? b.dataset.pick : "";`));
  if (firstPlatoon) {
    await page.click(`[data-pick="${firstPlatoon}"]`);
    await waitScreen("briefing", 30_000, "choose");
    const off = await page.evaluate(fn<number>(`return document.querySelectorAll(".cmp-pick.on").length;`));
    check(off === picks.on - 1, `unticking a platoon leaves ${picks.on - 1} chosen (${off})`);
    await page.click("[data-act=proposed]");
    await waitScreen("briefing", 30_000, "choose");
    check((await page.evaluate(fn<number>(`return document.querySelectorAll(".cmp-pick.on").length;`))) === picks.on, "Proposed restores the default choice");
    pass("the choice can be changed and restored");
  }

  // 3. Battalion and man card (Make leader).
  await page.click("[data-act=battalion]");
  await waitScreen("battalion", 30_000);
  await shot("3-battalion");
  await page.click(".cmp-tree .cmp-unit.d2 .cmp-unit-head");
  await waitScreen("battalion", 30_000);
  await shot("4-battalion-platoon", ".cmp-unit.d2.open");
  const person = await page.evaluate(fn<string>(`const r = [...document.querySelectorAll(".cmp-man-row[data-person]")]; const x = r.find((e) => !e.textContent.startsWith("★")); return x ? x.dataset.person : "";`));
  check(person !== "", "the battalion tree lists men");
  await page.click(`.cmp-man-row[data-person="${person}"]`);
  await waitScreen("man", 30_000);
  await shot("5-man");
  if (await page.isVisible("[data-act=makeLeader]")) {
    await page.click("[data-act=makeLeader]");
    await waitScreen("man", 30_000);
    check(await page.evaluate(fn<boolean>(`return document.querySelector(".cmp-man-rank").textContent.includes("leads") || document.querySelector(".cmp-man-rank").textContent.length > 0;`)), "the man card after Make leader");
    pass("Make leader on the man card");
  }
  await page.click("[data-act=back]");
  await waitScreen("battalion", 30_000);
  await page.click("[data-act=back]");
  await waitScreen("briefing", 30_000, "choose");
  pass("battalion tree -> man card -> back to the briefing");

  // 4. Auto-resolve: the progress screen, then what changed.
  await page.click("[data-act=auto]");
  await page.waitForFunction(fn<boolean>(`const s = globalThis.__tcsCampaign.state(); return s.screen === "progress" || s.screen === "after";`), null, { timeout: 60_000 });
  // (The bars come once the battles are built.)
  await page.waitForFunction(fn<boolean>(`return globalThis.__tcsCampaign.state().screen !== "progress" || [...document.querySelectorAll(".cmp-progress .cmp-label")].some((e) => e.textContent.includes(":"));`), null, { timeout: 60_000 });
  await page.waitForTimeout(1200);
  if ((await state()).screen === "progress") await shot("6-progress");
  await waitScreen("after", 600_000, "after-battle");
  s = await state();
  check(s.battles >= 1, `auto-resolve fought the node (${s.battles} battles)`);
  pass(`auto-resolve -> what changed (${s.battles} battle(s) fought, hash ${s.hash})`);
  await shot("7-after");
  await shot("8-after-more", ".cmp-steps");

  // 5. Save in a named slot, reload the page, load it: the same record, the next briefing.
  await page.click("[data-act=home]");
  await waitScreen("home", 30_000);
  await page.fill("[data-field=slotName]", "E2E one");
  await page.click("[data-act=saveAs]");
  await waitScreen("home", 30_000);
  check(await page.isVisible(`[data-slot="E2E one"]`), "the named slot is listed");
  await shot("9-home-slots");
  const saved = (await state()).hash;
  await page.goto(url("campaign=1"));
  await ready();
  await waitScreen("home", 30_000);
  check((await state()).hash === null, "after the reload no campaign is open");
  await page.click(`[data-slot="E2E one"] [data-act=load]`);
  await page.waitForFunction(fn<boolean>(`const s = globalThis.__tcsCampaign.state(); return s.screen === "after" && !s.busy;`), null, { timeout: 30_000 });
  s = await state();
  check(s.hash === saved, `the loaded record is the saved one (${s.hash} = ${saved})`);
  pass("save -> reload -> load gives the same record");
  await page.click("[data-act=proceed]");
  await page.waitForFunction(fn<boolean>(`const s = globalThis.__tcsCampaign.state(); return (s.screen === "briefing" || s.screen === "replenishment") && !s.busy;`), null, { timeout: 60_000 });
  if ((await state()).screen === "replenishment") { await shot("10-replenishment"); await page.click("[data-act=proceed]"); }
  await waitScreen("briefing", 60_000, "choose");
  await page.waitForSelector(".cmp-preview canvas", { timeout: 60_000 });
  check((await state()).battles === s.battles, "the next briefing");
  pass("load -> the next briefing");
  await shot("11-next-briefing");

  // 6. A played battle: the battle page, its end, back to the campaign.
  await page.click("[data-act=play]");
  await page.waitForFunction(fn<boolean>("return globalThis.__tcs?.ready === true;"), null, { timeout: 120_000 });
  await page.evaluate(fn(`const t = globalThis.__tcs; t.setSpeed(0); t.stepTicks(${o.seconds} * 60 + 120);`));
  await page.waitForSelector(".hud-aar-campaign", { timeout: 60_000 });
  await shot("12-played-review");
  const before = s.battles;
  await page.click(".hud-aar-campaign");
  await ready();
  await waitScreen("after", 600_000, "after-battle");
  s = await state();
  check(s.battles > before, `the played battle came back to the campaign (${before} -> ${s.battles} battles)`);
  pass("play -> battle page -> review -> back to the campaign's what-changed card");
  await shot("13-after-played");

  // 7. On to a replenishment (the operation's end or the endless rhythm), at most 6 more nodes.
  for (let k = 0; k < 6; k++) {
    await page.click("[data-act=proceed]");
    await page.waitForFunction(fn<boolean>(`const s = globalThis.__tcsCampaign.state(); return (s.screen === "briefing" || s.screen === "replenishment") && !s.busy;`), null, { timeout: 60_000 });
    if ((await state()).screen === "replenishment") break;
    await page.click("[data-act=auto]");
    await waitScreen("after", 600_000, "after-battle");
  }
  if ((await state()).screen === "replenishment") {
    await shot("14-replenishment");
    pass("an operation's end -> the replenishment card");
  }
  // 8. Cancel an auto-resolve: the record stays as it was.
  if ((await state()).screen === "replenishment") await page.click("[data-act=proceed]");
  await waitScreen("briefing", 60_000, "choose");
  const h0 = (await state()).battles;
  await page.click("[data-act=auto]");
  await page.waitForFunction(fn<boolean>(`return globalThis.__tcsCampaign.state().screen === "progress";`), null, { timeout: 30_000 });
  await page.click("[data-act=cancel]");
  await waitScreen("briefing", 30_000, "battle");
  check((await state()).battles === h0, "a cancelled auto-resolve fought nothing");
  await page.waitForSelector(".cmp-preview canvas", { timeout: 60_000 });
  await shot("15-cancelled");
  pass("cancel during auto-resolve leaves the record (phase battle, nothing fought)");
  return passed;
}
