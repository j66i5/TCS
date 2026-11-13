/**
 * The selected unit's card (the "bar-card" step, owner choices S3 and S6, 2026-11-13).
 *
 *   compact   the unit's name, men fit and state; two segmented rows always in view: how it moves (Run, Walk,
 *             Sneak, Crawl; a vehicle's own paces) and when it fires (Fire at will, Return fire, Hold, Ambush).
 *   detailed  also one row per man: state mark, role, weapon, an ammunition bar (one cell per magazine or belt).
 *   man box   a tap on a row (or on one of the unit's men on the map): his name, rank, weapon and rounds, what he
 *             is doing, fatigue, stress, suppression and morale, his wounds.
 *
 * The data comes from read-only snapshots of the state (`unitMenRows`, `manDetail`; pure, tested without a DOM),
 * and every choice goes out as an existing order (pace: the next move, or the move under way sent again; fire: the
 * `rules` order — Ambush is fire at will with the existing "no fire beyond" range at `AMBUSH_M`).
 */
import type { Strings } from "@tcs/data";
import { isAble, isOut, type Catalog, type EntityId, type Order, type SimView } from "@tcs/sim";
import type { UnitRules } from "./hud";
import { icon, paceIcon, stateMark } from "./icons";
import { unitSoldierIds } from "./orders-for";

/** A man's state as the card shows it (worst first: captive, down, wounded, pinned, shaken, steady). */
export type ManState = "steady" | "shaken" | "pinned" | "wounded" | "down" | "captive";

/** Rounds he has for his own weapon: in it, its capacity, and the spare magazines (or belts) with rounds in them. */
export interface AmmoState { loaded: number; capacity: number; spareMags: number; spareRounds: number }

export interface ManRow {
  id: EntityId;
  faction: string;
  role: string;
  rank: string;
  family: string;
  weapon: string | null;
  ammo: AmmoState | null;
  state: ManState;
  leader: boolean;
}

type Man = NonNullable<ReturnType<SimView["soldier"]["get"]>>;

export function manState(s: Man): ManState {
  if (s.captive !== null) return "captive";
  if (isOut(s) || !isAble(s)) return "down";
  if (s.wounds.some((w) => w.mechanism !== "blunt")) return "wounded";
  const b = s.mental.behaviour;
  if (b === "pinned" || b === "panicked" || b === "routed") return "pinned";
  if (b === "shaken") return "shaken";
  return "steady";
}

/** His weapon's rounds (null without a weapon that takes magazines or belts). */
export function ammoOf(view: SimView, catalog: Catalog, id: EntityId): AmmoState | null {
  const w = view.weapon.get(id);
  const wd = w ? catalog.weapons[w.weapon] : undefined;
  if (!w || !wd) return null;
  const mag = wd.feed.magazine;
  const capacity = catalog.items[mag]?.chargeCapacity ?? w.magazine?.rounds ?? 0;
  let spareMags = 0, spareRounds = 0;
  for (const st of view.container.get(id)?.stacks ?? []) {
    if (st.type !== mag || (st.charge ?? 0) <= 0) continue;
    spareMags += st.count;
    spareRounds += st.count * (st.charge ?? 0);
  }
  return { loaded: w.magazine?.rounds ?? 0, capacity, spareMags, spareRounds };
}

/** The men the card lists: a vehicle's crew (its passengers are their own units), else every man of the unit. */
export function cardMen(view: SimView, catalog: Catalog, unit: EntityId): EntityId[] {
  const u = view.unit.get(unit);
  if (!u) return [];
  const veh = u.vehicle !== undefined ? view.vehicle.get(u.vehicle) : undefined;
  const def = veh ? catalog.vehicles[veh.def] : undefined;
  if (veh && def) return veh.seats.filter((o, i): o is EntityId => o !== null && def.seats[i]?.station !== "passenger");
  return unitSoldierIds(view, unit);
}

/** One row per man of the unit (S6), in the unit's order (leader of each unit first as the data lists him). */
export function unitMenRows(view: SimView, catalog: Catalog, unit: EntityId): ManRow[] {
  const out: ManRow[] = [];
  const leaders = new Set<EntityId>();
  const stack: EntityId[] = [unit];
  while (stack.length > 0) {
    const u = view.unit.get(stack.pop()!);
    if (!u) continue;
    if (u.leader !== null) leaders.add(u.leader);
    stack.push(...u.children);
  }
  for (const id of cardMen(view, catalog, unit)) {
    const s = view.soldier.get(id), i = view.identity.get(id);
    if (!s || !i) continue;
    out.push({ id, faction: i.faction, role: i.role, rank: i.rank, family: i.family, weapon: view.weapon.get(id)?.weapon ?? null, ammo: ammoOf(view, catalog, id), state: manState(s), leader: leaders.has(id) });
  }
  return out;
}

/** What he is doing now, as a string key under `man.activity.` (and the pace when he moves). */
export interface Activity { key: string; pace?: string; posture?: string }

export function activityOf(view: SimView, id: EntityId): Activity {
  const s = view.soldier.get(id);
  if (!s) return { key: "unknown" };
  if (s.captive !== null) return { key: s.captive.state };
  if (s.casualty === "killed" || !s.physiology.alive) return { key: "killed" };
  if (s.casualty === "incapacitated" || !isAble(s)) return { key: "incapacitated" };
  if (s.mount !== undefined) return { key: "aboard" };
  if (s.evade && view.tick >= s.evade.startTick && view.tick < s.evade.untilTick) return { key: "evading" };
  const b = s.mental.behaviour;
  if (b === "panicked" || b === "routed") return { key: b };
  const intent = s.intent?.kind;
  if (intent === "cover" || intent === "bringAmmo" || intent === "fetchAmmo" || intent === "takePrisoner" || intent === "reposition") return { key: intent };
  const f = view.fire.get(id);
  if (f) return { key: f.self ? "engaging" : "firing" };
  if (b === "pinned") return { key: "pinned" };
  const m = view.mover.get(id);
  const wp = m?.waypoints;
  if (wp && wp.length > 0) return { key: "moving", pace: m?.mode ?? wp[wp.length - 1]!.mode };
  return { key: "holding", posture: s.posture };
}

export interface ManDetail {
  id: EntityId;
  given: string;
  family: string;
  rank: string;
  role: string;
  faction: string;
  callsign: string;
  weapon: string | null;
  ammo: AmmoState | null;
  state: ManState;
  behaviour: string;
  /** 0..1 each (morale: 1 = high). */
  fatigue: number;
  stress: number;
  suppression: number;
  morale: number;
  heartRateBpm: number;
  winded: boolean;
  /** Wounds that broke the skin (as in the after-action review), worst first. */
  wounds: { zone: string; severity: number }[];
  activity: Activity;
}

/** Everything the man box shows (S6): a read-only snapshot of one man. */
export function manDetail(view: SimView, catalog: Catalog, id: EntityId): ManDetail | null {
  const s = view.soldier.get(id), i = view.identity.get(id);
  if (!s || !i) return null;
  return {
    id, given: i.given, family: i.family, rank: i.rank, role: i.role, faction: i.faction,
    callsign: view.unit.get(i.unit)?.callsign ?? "",
    weapon: view.weapon.get(id)?.weapon ?? null, ammo: ammoOf(view, catalog, id), state: manState(s), behaviour: s.mental.behaviour,
    fatigue: s.physical.fatigue, stress: s.mental.stress, suppression: s.mental.suppression, morale: s.mental.morale,
    heartRateBpm: s.physical.heartRateBpm, winded: s.physical.winded,
    wounds: s.wounds.filter((w) => w.mechanism !== "blunt").map((w) => ({ zone: w.zone, severity: w.severity })).sort((a, b) => b.severity - a.severity),
    activity: activityOf(view, id),
  };
}

// ---- the fire row (S3)

export type FireChoice = "free" | "return" | "hold" | "ambush";
export const FIRE_CHOICES: readonly FireChoice[] = ["free", "return", "hold", "ambush"];
/** Ambush (owner S3: "hold until within N m"): fire at will, but never on their own beyond this range. A game value,
 *  the shortest range the Rules panel offers. */
export const AMBUSH_M = 100;

/** Which chip of the fire row is lit for these rules. */
export function fireChoice(r: Pick<UnitRules, "fire" | "maxEngageM">): FireChoice {
  if (r.fire === "free" && r.maxEngageM > 0 && r.maxEngageM <= AMBUSH_M) return "ambush";
  return r.fire;
}

/** The rules a chip of the fire row orders. Leaving an ambush lifts its range limit; any other range set in the
 *  Rules panel stays. */
export function fireChoiceRules(c: FireChoice, now: Pick<UnitRules, "fire" | "maxEngageM">): Partial<UnitRules> {
  if (c === "ambush") return { fire: "free", maxEngageM: AMBUSH_M };
  return fireChoice(now) === "ambush" ? { fire: c, maxEngageM: 0 } : { fire: c };
}

// ---- the pace row (S3)

type MoveOrder = Extract<Order, { kind: "move" }>;
type Pt = { x: number; y: number };

/**
 * A move under way sent again at another pace (S3: a pace chip pressed while the unit moves). The legs it has
 * already walked are dropped: it goes on from where it is (`at`) through the rest of the route. The unit is on the
 * leg between two route points nearest to it (within 15 m), else still on its first leg.
 */
export function repaceMove(prev: MoveOrder, at: Pt, pace: string, tick: number): MoveOrder {
  const w = prev.waypoints;
  let k = 0, best = 15;
  for (let i = 1; i < w.length; i++) {
    const ax = w[i - 1]!.x, ay = w[i - 1]!.y, dx = w[i]!.x - ax, dy = w[i]!.y - ay;
    const len2 = dx * dx + dy * dy;
    const u = len2 > 0 ? Math.max(0, Math.min(1, ((at.x - ax) * dx + (at.y - ay) * dy) / len2)) : 0;
    const d = Math.hypot(ax + u * dx - at.x, ay + u * dy - at.y);
    if (d <= best) { best = d; k = u > 0.02 ? i : i - 1; }
  }
  const rest = w.slice(k);
  return {
    tick, issuer: prev.issuer, target: prev.target, kind: "move",
    waypoints: rest.map((p) => ({ x: p.x, y: p.y, mode: pace })),
    ...(prev.formation !== undefined ? { formation: prev.formation } : {}),
    ...(prev.frontageM !== undefined ? { frontageM: prev.frontageM } : {}),
    ...(prev.facing !== undefined ? { facing: prev.facing } : {}),
    ...(prev.floor !== undefined ? { floor: prev.floor } : {}),
  };
}

// ---- DOM

export interface UnitCardModel {
  callsign: string;
  fit: number;
  total: number;
  /** The unit's state line ("ready", "pinned", ...), already translated. */
  state: string;
  men: readonly ManRow[];
}

export interface UnitCardCallbacks {
  onPace(pace: string): void;
  onFire(choice: FireChoice): void;
  onRules(): void;
  onMan(id: EntityId): void;
  /** The card grew or shrank (detailed / compact). */
  onResize?(): void;
}

export interface UnitCard {
  readonly el: HTMLElement;
  /** null hides the card (nothing selected). */
  update(m: UnitCardModel | null): void;
  setPaces(paces: readonly string[], current: string): void;
  /** null hides the fire row. */
  setFire(c: FireChoice | null): void;
  setRulesButton(on: boolean, open: boolean): void;
  setInspected(id: EntityId | null): void;
  setDetailed(on: boolean): void;
  detailed(): boolean;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

const CARD_KEY = "tcs.ui.card";

/** The ammunition bar: one cell per magazine or belt (the one in the weapon first, filled by its rounds), at most 8. */
export function ammoCells(a: AmmoState): { fill: number[]; more: number } {
  const full = Math.max(1, a.capacity);
  const spare = a.spareMags;
  const cells = [Math.max(0, Math.min(1, a.loaded / full))];
  // The spare magazines are shown full except the average shortfall spread over them (partly used ones are rare).
  const avg = spare > 0 ? Math.max(0, Math.min(1, a.spareRounds / spare / full)) : 0;
  for (let k = 0; k < Math.min(7, spare); k++) cells.push(avg);
  return { fill: cells, more: Math.max(0, spare - 7) };
}

export function createUnitCard(s: Strings, cb: UnitCardCallbacks): UnitCard {
  const root = h("div", "hud-card");
  root.hidden = true;
  const head = h("div", "hud-card-head");
  const name = h("span", "hud-card-name");
  const men = h("span", "hud-card-men");
  const detailBtn = h("button", "hud-btn hud-card-btn");
  detailBtn.dataset["card"] = "detail";
  detailBtn.innerHTML = `${icon("men", 16)}<span>${s.t("card.men")}</span>`;
  detailBtn.title = s.t("card.menHint");
  const rulesBtn = h("button", "hud-btn hud-card-btn");
  rulesBtn.dataset["card"] = "rules";
  rulesBtn.innerHTML = `${icon("rules", 16)}<span>${s.t("order.rules")}</span>`;
  rulesBtn.onclick = () => cb.onRules();
  head.append(name, men, detailBtn, rulesBtn);
  const paceRow = h("div", "hud-seg");
  paceRow.dataset["row"] = "pace";
  const fireRow = h("div", "hud-seg");
  fireRow.dataset["row"] = "fire";
  const list = h("div", "hud-card-list");
  root.append(head, paceRow, fireRow, list);

  const store = (): Storage | null => { try { return globalThis.localStorage; } catch { return null; } };
  let detailed = false;
  try { detailed = store()?.getItem(CARD_KEY) === "detailed"; } catch { /* no storage */ }
  const applyDetailed = () => { list.hidden = !detailed; detailBtn.classList.toggle("on", detailed); root.classList.toggle("detailed", detailed); };
  detailBtn.onclick = () => { detailed = !detailed; try { store()?.setItem(CARD_KEY, detailed ? "detailed" : "compact"); } catch { /* no storage */ } applyDetailed(); cb.onResize?.(); };
  applyDetailed();

  const segLabel = (key: string) => h("span", "hud-seg-label", s.t(key));
  let paceKey = "";
  let paceBtns: { p: string; b: HTMLButtonElement }[] = [];
  const fireBtns = FIRE_CHOICES.map((c) => {
    const b = h("button", "hud-chip");
    b.dataset["fire"] = c;
    b.innerHTML = `${icon(c, 16)}<span>${s.t(`card.fire.${c}`)}</span>`;
    b.title = s.t(`card.fire.${c}.hint`, { m: AMBUSH_M });
    b.onclick = () => cb.onFire(c);
    return { c, b };
  });
  fireRow.append(segLabel("card.fireRow"), ...fireBtns.map((x) => x.b));

  let inspected: EntityId | null = null;
  const rows = new Map<EntityId, { b: HTMLButtonElement; key: string }>();
  const fmtAmmo = (a: AmmoState | null) => {
    if (!a) return "";
    const { fill, more } = ammoCells(a);
    return `<span class="hud-ammo" title="${s.t("card.ammoTitle", { loaded: a.loaded, spare: a.spareRounds, mags: a.spareMags })}">${fill.map((f) => `<i style="--f:${Math.round(f * 100)}%"></i>`).join("")}${more > 0 ? `<b>+${more}</b>` : ""}</span>`;
  };
  const text = (k: string, faction: string) => s.t(k, {}, faction);
  /** A short label if the string table has one, else the longer one. */
  const tOr = (k: string, fallback: string) => { const v = s.t(k); return v.startsWith("[[") ? s.t(fallback) : v; };

  return {
    el: root,
    update(m) {
      root.hidden = m === null;
      if (!m) return;
      name.textContent = m.callsign;
      men.textContent = `${s.t("side.men", { fit: m.fit, total: m.total })} · ${m.state}`;
      if (!detailed) return;
      const keep = new Set<EntityId>();
      m.men.forEach((r, i) => {
        keep.add(r.id);
        let e = rows.get(r.id);
        if (!e) {
          const b = h("button", "hud-man");
          b.dataset["man"] = String(r.id);
          b.onclick = () => cb.onMan(r.id);
          e = { b, key: "" };
          rows.set(r.id, e);
        }
        const a = r.ammo;
        const key = `${r.state}|${r.role}|${r.weapon}|${a ? `${a.loaded}/${a.spareMags}/${a.spareRounds}` : ""}|${r.leader}`;
        if (key !== e.key) {
          e.key = key;
          e.b.className = `hud-man st-${r.state}${r.leader ? " leader" : ""}`;
          e.b.innerHTML = `<span class="hud-man-mark">${stateMark(r.state)}</span>`
            + `<span class="hud-man-role">${text(`role.${r.faction}.${r.role}`, r.faction)}</span>`
            + `<span class="hud-man-weapon">${r.weapon ? text(`weapon.${r.weapon}`, r.faction) : ""}</span>`
            + fmtAmmo(a);
          e.b.title = `${text(`rank.${r.faction}.${r.rank}`, r.faction)} ${r.family} · ${s.t(`card.state.${r.state}`)}`;
        }
        e.b.classList.toggle("inspected", inspected === r.id);
        if (list.children[i] !== e.b) list.insertBefore(e.b, list.children[i] ?? null);
      });
      for (const [id, e] of rows) if (!keep.has(id)) { e.b.remove(); rows.delete(id); }
    },
    setPaces(paces, current) {
      const key = paces.join();
      if (key !== paceKey) {
        paceKey = key;
        // Fastest first (Run, Walk, Sneak, Crawl; a vehicle's fast, drive, slow, reverse).
        const rank = (p: string) => (p === "reverse" ? 9 : ["run", "walk", "sneak", "crawl"].indexOf(paceIcon(p)));
        paceBtns = [...paces].sort((a, b) => rank(a) - rank(b)).map((p) => {
          const b = h("button", "hud-chip");
          b.dataset["pace"] = p;
          b.innerHTML = `${icon(paceIcon(p), 16)}<span>${tOr(`card.pace.${p}`, `move.${p}`)}</span>`;
          b.onclick = () => cb.onPace(p);
          b.title = s.t(`move.${p}`);
          return { p, b };
        });
        paceRow.replaceChildren(segLabel("card.paceRow"), ...paceBtns.map((x) => x.b));
      }
      for (const x of paceBtns) x.b.classList.toggle("on", x.p === current);
      paceRow.hidden = paces.length === 0;
    },
    setFire(c) {
      fireRow.hidden = c === null;
      for (const x of fireBtns) x.b.classList.toggle("on", x.c === c);
    },
    setRulesButton(on, open) { rulesBtn.hidden = !on; rulesBtn.classList.toggle("on", open); },
    setInspected(id) { inspected = id; for (const [k, e] of rows) e.b.classList.toggle("inspected", k === id); },
    setDetailed(on) { if (on !== detailed) detailBtn.click(); },
    detailed: () => detailed,
  };
}

export interface ManBox {
  readonly el: HTMLElement;
  /** null hides it. */
  update(d: ManDetail | null): void;
}

/** A bar of 0..1 with a label (fatigue, stress, ...); `bad`: high values are bad (drawn warmer). */
function bar(label: string, v: number, bad: boolean): string {
  const x = Math.max(0, Math.min(1, v));
  const warm = bad ? x : 1 - x;
  const col = warm > 0.66 ? "#ff6b57" : warm > 0.33 ? "#ffd23d" : "#8fd36a";
  return `<div class="hud-manbox-bar"><span>${label}</span><i><b style="width:${Math.round(x * 100)}%;background:${col}"></b></i><em>${Math.round(x * 100)} %</em></div>`;
}

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The man's detail box (S6). */
export function createManBox(s: Strings, onClose: () => void): ManBox {
  const root = h("div", "hud-manbox");
  root.hidden = true;
  const body = h("div", "hud-manbox-body");
  const close = h("button", "hud-btn hud-manbox-close");
  close.innerHTML = icon("close", 16);
  close.setAttribute("aria-label", s.t("card.close"));
  close.onclick = () => onClose();
  root.append(close, body);
  let last = "";
  return {
    el: root,
    update(d) {
      root.hidden = d === null;
      if (!d) { last = ""; return; }
      const f = d.faction;
      const sev = (x: number) => s.t(x >= 0.6 ? "card.wound.critical" : x >= 0.25 ? "card.wound.serious" : "card.wound.light");
      const a = d.ammo;
      const act = d.activity;
      const doing = s.t(`man.activity.${act.key}`, {
        pace: act.pace ? s.t(`move.${act.pace}`) : "",
        posture: act.posture ? s.t(`card.posture.${act.posture}`) : "",
      });
      const html = `<div class="hud-manbox-name">${stateMark(d.state, 14)} ${esc(s.t(`rank.${f}.${d.rank}`, {}, f))} ${esc(d.given)} ${esc(d.family)}</div>`
        + `<div class="hud-manbox-line">${esc(s.t(`role.${f}.${d.role}`, {}, f))} · ${esc(d.callsign)}</div>`
        + `<div class="hud-manbox-line">${d.weapon ? esc(s.t(`weapon.${d.weapon}`, {}, f)) : esc(s.t("card.noWeapon"))}${a ? ` · ${esc(s.t("card.rounds", { loaded: a.loaded, spare: a.spareRounds, mags: a.spareMags }))}` : ""}</div>`
        + `<div class="hud-manbox-line"><b>${esc(s.t("card.doing"))}</b> ${esc(doing)}</div>`
        + `<div class="hud-manbox-line"><b>${esc(s.t("card.stateLabel"))}</b> ${esc(s.t(`behaviour.${d.behaviour}`))}${d.winded ? ` · ${esc(s.t("card.winded"))}` : ""} · ${esc(s.t("card.pulse", { bpm: Math.round(d.heartRateBpm) }))}</div>`
        + bar(s.t("card.fatigue"), d.fatigue, true) + bar(s.t("card.suppression"), d.suppression, true)
        + bar(s.t("card.stress"), d.stress, true) + bar(s.t("card.morale"), d.morale, false)
        + `<div class="hud-manbox-line"><b>${esc(s.t("card.wounds"))}</b> ${d.wounds.length === 0 ? esc(s.t("card.noWounds")) : d.wounds.map((w) => esc(`${s.t(`zone.${w.zone}`)} (${sev(w.severity)})`)).join(", ")}</div>`;
      if (html !== last) { last = html; body.innerHTML = html; }
    },
  };
}
