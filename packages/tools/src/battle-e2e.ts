/**
 * THE BATTLE SCREEN IN THE BROWSER (review 2026-11-24 step 5, part 2), driven by Playwright at one viewport:
 *
 * 1. The opening view: the mounted attack opens with every own man and every objective in the free map area, never
 *    closer than true scale; the defender on its objectives gets a closer view than the attacker.
 * 2. The unit card: on a phone held sideways it is one line beside two radio lines; a tap unfolds it (pace and fire
 *    rows, one radio line), a fire chip still orders, Rules opens, another unit folds it again. Upright and on a
 *    desktop the card has its rows at once.
 * 3. A refused order: a posture order to a vehicle crew says why in words with the crew's callsign, on the radio and
 *    at the top of the map; no raw reason key.
 * 4. The radio log under an enemy drone: "enemy drone overhead" a few times at most while the calls go on.
 * No sideways scroll anywhere. `npm run e2e:battle` runs it at 360x780, 780x360 and 1400x900;
 * `npm run screenshot -- --scene ui` takes the pictures on the way.
 */
import type { MenuPage } from "./menu-e2e";

export type BattlePage = MenuPage;
export type BattleViewport = "portrait" | "landscape" | "desktop";

export interface BattleE2eOptions {
  base: string;
  viewport: BattleViewport;
  shots: { dir: string; name: string; list: string[] } | null;
  look: "photo" | "flat";
  /** Which parts (default: all). */
  parts?: readonly ("opening" | "card" | "reject" | "drone")[];
  log(msg: string): void;
}

const fn = <T>(body: string) => new Function(body) as () => T;

export class BattleE2eFailure extends Error {}
function check(ok: boolean, what: string): void {
  if (!ok) throw new BattleE2eFailure(`battle e2e: ${what}`);
}

type View = { scale: number; x0: number; y0: number; x1: number; y1: number };
type Pt = { x: number; y: number };

export const ATTACK_BATTLE = "scenario=platoon&seed=1";
export const DEFENCE_BATTLE = "scenario=platoon&attacker=red&vehicles=0&seed=1";
export const TRANSIT_BATTLE = "scenario=platoon&kind=ambush&attacker=blue&seed=1";
export const DRONE_BATTLE = "scenario=platoon&vehicles=0&air=red&seed=1";

export async function battleE2e(page: BattlePage, o: BattleE2eOptions): Promise<string[]> {
  const parts = o.parts ?? ["opening", "card", "reject", "drone"];
  const passed: string[] = [];
  const pass = (s: string) => { passed.push(s); o.log(`  ok  ${s}`); };
  const battleReady = () => page.waitForFunction(fn<boolean>("return globalThis.__tcs?.ready === true;"), null, { timeout: 120_000 });
  const open = async (query: string) => { await page.goto(`${o.base}/?${query}&look=${o.look}`); await battleReady(); await page.evaluate(fn("globalThis.__tcs.setSpeed(0);")); };
  const noScroll = async (where: string) => {
    const s = await page.evaluate(fn<{ sw: number; iw: number }>("return { sw: document.documentElement.scrollWidth, iw: innerWidth };"));
    check(s.sw <= s.iw + 1, `${where}: no sideways scroll (${s.sw} > ${s.iw})`);
  };
  const shot = async (label: string) => {
    if (!o.shots) return;
    await page.waitForFunction(fn<boolean>("return globalThis.__tcs.tilesPending() === 0;"), null, { timeout: 60_000 }).catch(() => undefined);
    await page.waitForTimeout(400);
    const p = `${o.shots.dir}/battle-${o.shots.name}-${o.look}-${label}.png`;
    await page.screenshot({ path: p });
    o.shots.list.push(p);
  };
  const view = () => page.evaluate(fn<{ v: View; men: Pt[]; objectives: (Pt & { radiusM: number })[] }>(
    "const t = globalThis.__tcs; return { v: t.view(), men: t.ownMen(), objectives: t.sim.ctx.rules.objectives.map((o) => ({ x: o.x, y: o.y, radiusM: o.radiusM })) };"));
  const inView = (v: View, p: Pt) => p.x >= v.x0 && p.x <= v.x1 && p.y >= v.y0 && p.y <= v.y1;
  /** The card and the radio log as laid out now (CSS px). */
  const bottom = () => page.evaluate(fn<{ card: number; cardShown: boolean; line: boolean; total: number; radio: number; paceRow: boolean; fireRow: boolean; rulesBtn: boolean }>(`
    const vis = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== "none";
    const c = document.querySelector(".hud-card"), b = document.querySelector(".hud-bottom");
    return { card: c ? c.getBoundingClientRect().height : 0, cardShown: vis(c), line: !!c && c.classList.contains("line"), total: b ? b.getBoundingClientRect().height : 0,
      radio: [...document.querySelectorAll(".hud-radio-line")].filter(vis).length,
      paceRow: vis(document.querySelector(".hud-card [data-row=pace]")), fireRow: vis(document.querySelector(".hud-card [data-row=fire]")), rulesBtn: vis(document.querySelector(".hud-card [data-card=rules]")) };`));
  const selectKind = (kind: string, nth = 0) => page.evaluate(fn<{ unit: number; callsign: string }>(`const t = globalThis.__tcs; const u = t.units().filter((x) => x.kind === ${JSON.stringify(kind)})[${nth}]; t.select(u.unit); return u;`));
  /** Four radio lines in the log (the card's worst case). */
  const fillRadio = () => page.evaluate(fn(`const t = globalThis.__tcs; for (const u of t.units().filter((x) => x.kind === "infantry").slice(0, 4)) { t.moveUnit(u.unit, t.ownMen()[0].x + 5, t.ownMen()[0].y + 5); } t.stepTicks(600); t.halt();`));

  if (parts.includes("opening")) {
    await open(ATTACK_BATTLE);
    const a = await view();
    check(a.men.length > 20 && a.objectives.length > 0, `the attack has men and objectives (${a.men.length}, ${a.objectives.length})`);
    const out = a.men.filter((p) => !inView(a.v, p)).length, outO = a.objectives.filter((p) => !inView(a.v, p)).length;
    check(out === 0, `the opening view shows every own man (${out} of ${a.men.length} outside ${JSON.stringify(a.v)})`);
    // (Verification fix: where the force and the objectives do not fit at 0.6 px/m, an upright phone, the view shows
    // the force and the ground toward them, and every objective outside it is pointed at from the edge.)
    await page.waitForTimeout(300);
    const marks = await page.evaluate(fn<{ label: string; shown: boolean }[]>("return globalThis.__tcs.edgeMarks();"));
    const pointed = marks.filter((m) => m.shown).length;
    check(a.v.scale >= 0.6 - 1e-6, `the opening view is at a readable scale (${a.v.scale.toFixed(2)} px/m)`);
    check(pointed === outO, `every objective is in view or pointed at from the edge (${outO} outside, ${pointed} pointed at)`);
    check(a.v.scale <= 8 + 1e-6, `never closer than true scale (${a.v.scale})`);
    pass(`attack: all ${a.men.length} own men in view at ${a.v.scale.toFixed(2)} px/m; ${a.objectives.length - outO} of ${a.objectives.length} objectives in view, ${pointed} pointed at`);
    await noScroll("attack");
    await shot("0-opening-attack");
    await open(DEFENCE_BATTLE);
    const d = await view();
    check(d.men.every((p) => inView(d.v, p)) && d.objectives.every((p) => inView(d.v, p)), "the defender's opening view shows its men and the objectives");
    check(d.v.scale >= a.v.scale, `the defender on its objectives is at least as close as the attacker (${d.v.scale} against ${a.v.scale})`);
    pass(`defence: men and objectives in view at ${d.v.scale.toFixed(2)} px/m`);
    await shot("1-opening-defence");
    // The side moving through an ambush has no objectives: the view looks along its way, its exit pointed at.
    await open(TRANSIT_BATTLE);
    const t = await view();
    await page.waitForTimeout(300);
    const tm = await page.evaluate(fn<{ label: string; shown: boolean }[]>("return globalThis.__tcs.edgeMarks();"));
    check(t.men.every((p) => inView(t.v, p)), "moving through an ambush: every own man in view");
    check(Math.max(t.v.x1 - t.v.x0, t.v.y1 - t.v.y0) >= 400, `moving through an ambush: the view shows the way ahead (${Math.round(t.v.x1 - t.v.x0)} x ${Math.round(t.v.y1 - t.v.y0)} m)`);
    // (A wide screen holds the whole way: the far map edge in view, nothing to point at.)
    const W = await page.evaluate(fn<number>("return globalThis.__tcs.sim.ctx.map.widthM;"));
    const exitSeen = t.v.x1 >= W - 20;
    check(tm.length === 1 && tm[0]!.shown === !exitSeen, `the exit is in view or pointed at from the edge (${JSON.stringify(tm)}, in view ${exitSeen})`);
    pass(`moving through an ambush: ${Math.round(t.v.x1 - t.v.x0)} x ${Math.round(t.v.y1 - t.v.y0)} m in view, the exit ${exitSeen ? "in view" : "pointed at"}`);
    await shot("1b-opening-transit");
  }

  if (parts.includes("card")) {
    await open(ATTACK_BATTLE);
    await fillRadio();
    const u = await selectKind("infantry");
    await page.waitForTimeout(700);
    const b0 = await bottom();
    check(b0.cardShown, "a unit selected: the card shows");
    if (o.viewport === "landscape") {
      check(b0.line && b0.card <= 44, `sideways the card is one line (${b0.card} px, line ${b0.line})`);
      check(!b0.paceRow && !b0.fireRow, "folded: no pace and fire rows");
      check(b0.radio <= 2 && b0.total <= 110, `folded: the card and the radio log take at most 110 px (${b0.total} px, ${b0.radio} lines)`);
      pass(`sideways: ${u.callsign}'s card is one line of ${Math.round(b0.card)} px; card and radio ${Math.round(b0.total)} px`);
      await shot("2-card-line");
      await page.click(".hud-card-head .hud-card-name");
      await page.waitForTimeout(300);
      const b1 = await bottom();
      check(!b1.line && b1.paceRow && b1.fireRow && b1.rulesBtn, `a tap on the line shows the pace and fire rows (${JSON.stringify(b1)})`);
      check(b1.radio <= 1, `unfolded: one radio line (${b1.radio})`);
      await shot("3-card-open");
      const n0 = await page.evaluate(fn<number>("return globalThis.__tcs.orderLog.filter((o) => o.kind === 'rules').length;"));
      await page.click('.hud-card [data-fire="hold"]');
      const n1 = await page.evaluate(fn<number>("return globalThis.__tcs.orderLog.filter((o) => o.kind === 'rules').length;"));
      check(n1 === n0 + 1, "a fire chip on the unfolded card still orders");
      await page.click('.hud-card [data-card="rules"]');
      check(await page.isVisible(".hud-panel"), "Rules opens from the unfolded card");
      await shot("3b-card-rules");
      const fits = await page.evaluate(fn<boolean>(`const r = document.querySelector(".hud-panel").getBoundingClientRect(); return r.bottom <= innerHeight + 1 && r.top >= 0;`));
      check(fits, "the rules panel fits the screen (it scrolls inside)");
      await page.click('.hud-panel [data-act="rules-close"]');
      check(!(await page.isVisible(".hud-panel")), "the panel's own close button closes it (it lies over the card's Rules button)");
      pass("a tap unfolds it: pace and fire rows, a fire chip orders, Rules opens; one radio line");
      await page.click(".hud-card-head .hud-card-name");
      await page.waitForTimeout(200);
      check((await bottom()).line, "a tap on the head folds it again");
      await page.click(".hud-card-head .hud-card-name");
      await selectKind("infantry", 1);
      await page.waitForTimeout(700);
      check((await bottom()).line, "another unit selected: folded again");
      pass("a tap on the head folds it; another unit selected folds it");
    } else {
      check(!b0.line && b0.paceRow && b0.fireRow, `${o.viewport}: the card has its rows at once (${JSON.stringify(b0)})`);
      check(!(await page.isVisible(".hud-card-fold")), `${o.viewport}: no fold button`);
      pass(`${o.viewport}: the card has its pace and fire rows at once (${Math.round(b0.card)} px)`);
      await shot("2-card");
    }
    await noScroll("card");
  }

  if (parts.includes("reject")) {
    await open(ATTACK_BATTLE);
    const crew = await selectKind("vehicle");
    await page.evaluate(fn("const t = globalThis.__tcs; t.posture('prone'); t.stepTicks(3);"));
    await page.waitForTimeout(300);
    const r = await page.evaluate(fn<{ log: string[]; flash: string | null; shown: string }>(
      `const t = globalThis.__tcs; return { log: t.radioLog().map((x) => x.text), flash: t.flash(), shown: [...document.querySelectorAll(".hud-radio-line")].map((e) => e.textContent).join("\\n") };`));
    const line = r.log.at(-1) ?? "";
    check(line.includes(crew.callsign) && line.includes("vehicle crew"), `the refusal names the unit and says why ("${line}")`);
    check(!/not-applicable|invalid-params|\(|\{/.test(line), `no raw reason in "${line}"`);
    check(r.flash === line, `the same sentence at the top of the map ("${r.flash}")`);
    check(r.shown.includes(line), "the sentence is in the radio log on screen");
    check(await page.isVisible(".hud-flash"), "the message at the top of the map is visible");
    pass(`a refused order: "${line}" on the radio and at the top of the map`);
    await noScroll("reject");
    await shot("4-rejected");
  }

  if (parts.includes("drone")) {
    await open(DRONE_BATTLE);
    // Up to ten minutes, until the enemy's drone has been called a good many times.
    let st = { dropped: 0, lines: [] as { text: string; simSeconds: number }[] };
    for (let k = 0; k < 20; k++) {
      st = await page.evaluate(fn<typeof st>("const t = globalThis.__tcs; t.stepTicks(1800); return { dropped: t.radioDropped(), lines: t.radioLog() };"));
      if (st.dropped >= 10) break;
    }
    const seconds = await page.evaluate(fn<number>("return globalThis.__tcs.sim.state.tick / 60;"));
    const drone = st.lines.filter((l) => l.text.includes("drone overhead"));
    check(st.dropped >= 10, `the enemy's drone was called often enough to check (${st.dropped} calls kept out in ${seconds} s)`);
    check(drone.length >= 1, "the drone is reported");
    // (One line per unit and sighting; a sighting closes after a quiet minute.)
    check(drone.length <= 1 + Math.ceil(seconds / 60), `at most one drone line a minute (${drone.length} in ${seconds} s)`);
    check(drone.length * 3 <= drone.length + st.dropped, `most repeats are kept out (${drone.length} shown, ${st.dropped} not)`);
    pass(`enemy drone overhead: ${drone.length} line(s) in the log, ${st.dropped} repeats kept out, in ${seconds} s`);
    await shot("5-drone");
  }
  return passed;
}
