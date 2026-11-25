/**
 * THE END OF A DECIDED BATTLE IN THE BROWSER (review 2026-11-24 problem 3, owner Q3), driven by Playwright:
 *
 * 1. Claim victory: the platoon battle on foot with the player defending and the enemy commander off. The button is
 *    greyed at the start ("no fighting yet"; a tap says why on the radio); the player's men fire, the field stays quiet
 *    for a minute: still greyed while the enemy is at full strength (the defender's lull); most of the enemy gives up:
 *    the button is offered (the radio says so; on a phone "⋯" is marked); a tap asks first, then the
 *    battle ends at once and the review says "Victory claimed: ...".
 * 2. The automatic end: the same battle, most enemy men give up: the side is spent, the end is announced (the score
 *    line's notice, a radio line) and a minute later the battle ends by itself, the review says how.
 * 3. Campaign: a campaign's first battle (the player defends) claimed the same way; "Back to the campaign" brings the
 *    result to the campaign's what-changed card.
 *
 * `npm run e2e:claim` runs the checks on a phone viewport; `npm run screenshot -- --scene ui` takes the pictures on
 * the way (phone portrait and landscape, desktop; both looks). Debug hooks: the battle's `__tcs` (claim, ended,
 * ending, aiOff, stepTicks, giveUp), the campaign page's `__tcsCampaign.state()`.
 */
import type { MenuPage } from "./menu-e2e";

/** The Playwright page as far as these checks use it. */
export type ClaimPage = MenuPage & { waitForSelector(sel: string, opts: { timeout: number }): Promise<unknown> };

export interface ClaimE2eOptions {
  base: string;
  /** Where the screenshots go (null: none); `name` the viewport's. */
  shots: { dir: string; name: string; list: string[] } | null;
  look: "photo" | "flat";
  /** Which parts: the claim, the automatic end, the campaign (default: all). */
  parts?: readonly ("claim" | "auto" | "campaign")[];
  log(msg: string): void;
}

type Claim = { ok: boolean; reason?: string; secondsLeft?: number };
type Ended = { reason: string; loser: string | null; tick: number } | null;

const fn = <T>(body: string) => new Function(body) as () => T;

export class ClaimE2eFailure extends Error {}
function check(ok: boolean, what: string): void {
  if (!ok) throw new ClaimE2eFailure(`claim e2e: ${what}`);
}

/** The platoon battle on foot, the player (blue) defending its objectives, the enemy commander off. */
export const CLAIM_BATTLE = "scenario=platoon&attacker=red&vehicles=0&ai=0&seed=1";

export async function claimE2e(page: ClaimPage, o: ClaimE2eOptions): Promise<string[]> {
  const parts = o.parts ?? ["claim", "auto", "campaign"];
  const passed: string[] = [];
  const pass = (s: string) => { passed.push(s); o.log(`  ok  ${s}`); };
  const battleReady = () => page.waitForFunction(fn<boolean>("return globalThis.__tcs?.ready === true;"), null, { timeout: 120_000 });
  const claim = () => page.evaluate(fn<Claim>("return globalThis.__tcs.claim();"));
  const ended = () => page.evaluate(fn<Ended>("return globalThis.__tcs.ended();"));
  const step = (s: number) => page.evaluate(fn(`globalThis.__tcs.stepTicks(${Math.round(s * 60)});`));
  /** The button's state as drawn (the app refreshes it twice a second of real time). */
  const button = () => page.evaluate(fn<{ shown: boolean; off: boolean; label: string; inMenu: boolean; marked: boolean }>(`const b = document.querySelector("[data-act=claim]");
    if (!b) return { shown: false, off: true, label: "", inMenu: false, marked: false };
    return { shown: !b.hidden, off: b.classList.contains("off"), label: b.getAttribute("aria-label") || "",
      inMenu: b.parentElement?.classList.contains("hud-bar-menu") === true, marked: document.querySelector(".hud-bar > .hud-more-btn.attn") !== null };`));
  const waitButton = (off: boolean) => page.waitForFunction(fn<boolean>(`const b = document.querySelector("[data-act=claim]"); return !!b && !b.hidden && b.classList.contains("off") === ${off};`), null, { timeout: 10_000 });
  const radio = () => page.evaluate(fn<string>(`return [...document.querySelectorAll(".hud-radio-line")].map((e) => e.textContent).join("\\n");`));
  const review = () => page.evaluate(fn<string>(`return [...document.querySelectorAll(".hud-aar-line")].map((e) => e.textContent).join("\\n");`));
  const shot = async (label: string) => {
    if (!o.shots) return;
    await page.waitForTimeout(350);
    const p = `${o.shots.dir}/claim-${o.shots.name}-${o.look}-${label}.png`;
    await page.screenshot({ path: p });
    o.shots.list.push(p);
  };
  /** Press the button where it is: on a narrow screen behind "⋯" (opened first). */
  const pressClaim = async () => {
    if ((await button()).inMenu && !(await page.isVisible(".hud-bar-menu"))) await page.click(".hud-bar > .hud-more-btn");
    await page.click("[data-act=claim]");
  };
  /** The player's men fire at the middle of the map (contact), then a quiet field. */
  const fireOnce = () => page.evaluate(fn(`const t = globalThis.__tcs, m = t.sim.ctx.map; t.fireAt(m.widthM / 2, m.heightM / 2); t.select(null);`));
  /** The enemy beaten down (a debug shortcut): `share` of its men are out, those on foot giving up, those aboard a hull
   *  knocked out (a defender's claim needs the enemy below half its men, review 2026-11-25; a quarter or less is spent). */
  const beatDown = (share: number) => page.evaluate(fn<number>(`const t = globalThis.__tcs, s = t.sim.state, me = t.playerSide();
    const foe = [...s.identity.entries()].filter(([id, i]) => i.side !== me && s.soldier.has(id) && s.weapon.has(id)).map(([id]) => id);
    const n = Math.ceil(foe.length * ${share});
    for (const id of foe.slice(0, n)) { if (s.soldier.get(id).mount === undefined) t.giveUp(id); else t.hurt(id, {}, true); }
    return n;`));
  // The claim's confirm is accepted.
  page.on("dialog", (d) => { void d.accept(); });

  if (parts.includes("claim")) {
    await page.goto(`${o.base}/?${CLAIM_BATTLE}&look=${o.look}`);
    await battleReady();
    await page.evaluate(fn("globalThis.__tcs.setSpeed(0); globalThis.__tcs.stepTicks(1);"));
    await waitButton(true);
    const c0 = await claim(), b0 = await button();
    check(!c0.ok && c0.reason === "no-contact-yet", `at the start no claim (${JSON.stringify(c0)})`);
    check(b0.shown && b0.off && b0.label.includes("no fighting"), `the button greyed with its reason (${JSON.stringify(b0)})`);
    pass(`claim button greyed at the start: "${b0.label}"`);
    if (b0.inMenu) await page.click(".hud-bar > .hud-more-btn");
    await shot("0-greyed");
    await pressClaim();
    check((await radio()).includes("not possible yet"), "a tap on the greyed button says why on the radio");
    check((await ended()) === null, "a tap on the greyed button ends nothing");
    pass("a tap on the greyed button: the reason on the radio, the battle goes on");
    await shot("0b-greyed-tapped");
    await fireOnce();
    await step(20);
    await waitButton(true);
    const c1 = await claim();
    check(!c1.ok && c1.reason === "contact", `in contact: no claim (${JSON.stringify(c1)})`);
    pass(`in contact: greyed ("${(await button()).label}")`);
    // A quiet field: the fire stops within ~100 s; a minute of quiet after it. The player has held the objectives from
    // the start: its shots at empty ground win nothing, the enemy at full strength refuses the claim (review 2026-11-25).
    let cq = await claim();
    for (let k = 0; k < 30 && !cq.ok && cq.reason === "contact"; k++) { await step(10); cq = await claim(); }
    check(!cq.ok && cq.reason === "enemy-strong", `quiet, the enemy at full strength: no claim (${JSON.stringify(cq)})`);
    pass(`quiet but the enemy at full strength: greyed ("${(await button()).label}")`);
    const beaten = await beatDown(0.6);
    let c2 = await claim();
    for (let k = 0; k < 30 && !c2.ok; k++) { await step(10); c2 = await claim(); }
    check(c2.ok, `the quiet field held: the claim is offered (${JSON.stringify(c2)})`);
    await waitButton(false);
    const b2 = await button();
    check(b2.label === "Claim victory", `offered: "${b2.label}"`);
    check(!b2.inMenu || b2.marked, "on a narrow screen the ⋯ button is marked while the claim is behind it");
    check((await radio()).includes("you can claim victory"), "the radio says the claim is offered");
    check((await radio()).includes(b2.inMenu ? "under ⋯" : "in the top bar"), "the radio line names where the button is");
    pass(`claim offered after the quiet minute and ${beaten} enemy men out${b2.inMenu ? " (behind ⋯, marked)" : ""}`);
    await shot("1-offered");
    if (b2.inMenu) { await page.click(".hud-bar > .hud-more-btn"); await shot("2-offered-menu"); }
    await pressClaim();
    await page.waitForSelector(".hud-aar", { timeout: 10_000 });
    const e = await ended();
    check(e !== null && e.reason === "victory-claimed" && e.loser === "red", `the claim ended the battle (${JSON.stringify(e)})`);
    const r = await review();
    check(r.includes("Victory claimed") && r.includes("wins"), `the review says how it ended (${r.split("\n")[0]})`);
    pass(`claim -> battle over at ${Math.round((e?.tick ?? 0) / 60)} s, review: "${r.split("\n")[0]}"`);
    await shot("3-review");
  }

  if (parts.includes("auto")) {
    await page.goto(`${o.base}/?${CLAIM_BATTLE}&look=${o.look}`);
    await battleReady();
    await page.evaluate(fn("globalThis.__tcs.setSpeed(0); globalThis.__tcs.stepTicks(1);"));
    await fireOnce();
    // Most of the enemy gives up (a debug shortcut): a spent side.
    const gave = await page.evaluate(fn<number>(`const t = globalThis.__tcs, s = t.sim.state; const red = [...s.identity.entries()].filter(([id, i]) => i.side === "red" && s.soldier.get(id)?.mount === undefined && s.weapon.has(id)).map(([id]) => id);
      const n = Math.ceil(red.length * 0.85); for (const id of red.slice(0, n)) t.giveUp(id); return n;`));
    // (A spent side first stays spent for a minute, then the end is announced: `noticeTick`.)
    let ending = null as { reason: string; endTick: number; noticeTick?: number } | null;
    for (let k = 0; k < 40 && ending?.noticeTick === undefined && (await ended()) === null; k++) { await step(5); ending = await page.evaluate(fn<{ reason: string; endTick: number; noticeTick?: number } | null>("return globalThis.__tcs.ending();")); }
    check(ending?.noticeTick !== undefined, `the end is announced (${gave} enemy gave up; ended ${JSON.stringify(await ended())})`);
    await page.waitForFunction(fn<boolean>(`return document.querySelector(".hud-score-ending") !== null;`), null, { timeout: 10_000 });
    const notice = await page.evaluate(fn<string>(`return document.querySelector(".hud-score-ending").textContent;`));
    check(/ends in \d+ s/.test(notice), `the score line shows the countdown ("${notice}")`);
    const said = await radio();
    check(said.includes("The battle ends in"), `the radio announces the end (${JSON.stringify(ending)}; radio: ${said.split("\n").slice(-4).join(" / ")})`);
    pass(`end announced (${ending?.reason}): "${notice}"`);
    await shot("4-ending");
    await step(65);
    await page.waitForSelector(".hud-aar", { timeout: 10_000 });
    const e = await ended();
    check(e !== null && e.reason === ending?.reason, `the battle ended by itself (${JSON.stringify(e)})`);
    const r = await review();
    pass(`automatic end ${e?.reason} at ${Math.round((e?.tick ?? 0) / 60)} s, review: "${r.split("\n")[0]}"`);
    await shot("5-review-auto");
  }

  if (parts.includes("campaign")) {
    // A fresh store (earlier runs leave slots behind), then a new campaign straight from the menu's URL.
    await page.goto(`${o.base}/?campaign=1&look=${o.look}`);
    await page.waitForFunction(fn<boolean>("return globalThis.__tcsCampaign?.ready === true;"), null, { timeout: 60_000 });
    await page.evaluate(fn(`return new Promise((r) => { const q = indexedDB.deleteDatabase("tcs-campaign"); q.onsuccess = q.onerror = q.onblocked = () => r(true); });`));
    await page.goto(`${o.base}/?campaign=1&new=1&faction=de&carriers=tracked&mode=operations&seconds=600&seed=7&look=${o.look}`);
    await page.waitForFunction(fn<boolean>(`const s = globalThis.__tcsCampaign?.state?.(); return !!s && !s.busy && s.screen === "briefing";`), null, { timeout: 120_000 });
    await page.click("[data-act=play]");
    await battleReady();
    const side = await page.evaluate(fn<{ side: string; objectives: { holder: string | null }[] }>("const t = globalThis.__tcs; return { side: t.playerSide(), objectives: t.objectives() };"));
    check(side.objectives.length > 0 && side.objectives.every((x) => x.holder === side.side), `the campaign's first battle: the player holds the objectives (${JSON.stringify(side)})`);
    await page.evaluate(fn("const t = globalThis.__tcs; t.setSpeed(0); t.aiOff(); t.stepTicks(1);"));
    await fireOnce();
    // (A quiet field first; the player defends: the enemy beaten down then, as in the first part.)
    let c = await claim();
    for (let k = 0; k < 40 && !c.ok && c.reason !== "enemy-strong"; k++) { await step(10); c = await claim(); }
    check(!c.ok && c.reason === "enemy-strong", `the campaign defence: no claim against the enemy at full strength (${JSON.stringify(c)})`);
    await beatDown(0.6);
    // (Claimed at once: a minute later the automatic "battle decided" end would come first.)
    c = await claim();
    for (let k = 0; k < 10 && !c.ok; k++) { await step(2); c = await claim(); }
    check(c.ok, `the campaign battle can be claimed (${JSON.stringify(c)})`);
    await waitButton(false);
    await pressClaim();
    await page.waitForSelector(".hud-aar-campaign", { timeout: 10_000 });
    const e = await ended();
    check(e !== null && e.reason === "victory-claimed", `the campaign battle claimed (${JSON.stringify(e)})`);
    await shot("6-campaign-review");
    await page.click(".hud-aar-campaign");
    await page.waitForFunction(fn<boolean>(`const s = globalThis.__tcsCampaign?.state?.(); return globalThis.__tcsCampaign?.ready === true && !!s && !s.busy && s.screen === "after";`), null, { timeout: 600_000 });
    const st = await page.evaluate(fn<{ battles: number; history: { flank: boolean; durationS: number }[] }>("return globalThis.__tcsCampaign.state();"));
    const main = st.history.find((h) => !h.flank);
    check(st.battles >= 1 && main !== undefined && Math.abs(main.durationS - (e?.tick ?? 0) / 60) <= 2, `the claimed battle came back to the campaign (${JSON.stringify(st.history)}, ended at ${Math.round((e?.tick ?? 0) / 60)} s)`);
    pass(`campaign: claimed at ${Math.round((e?.tick ?? 0) / 60)} s -> "Back to the campaign" -> what changed (${st.battles} battle(s))`);
    await shot("7-campaign-after");
  }
  return passed;
}
