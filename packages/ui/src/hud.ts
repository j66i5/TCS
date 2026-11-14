/**
 * HTML heads-up display over the map (M5):
 *   top bar     time, pause and speeds (orders work while paused), map, Debug
 *   order bar   for the selected unit (only what it can do, M7.5a), slimmed to the core verbs (S4): Move and Fire
 *               (split buttons with trays of their variants), Halt, Mount / Dismount. Always shown, greyed while
 *               nothing is selected; docked to any edge (drag its grip), one row (one column at a side).
 *   unit card   the selected unit: pace and fire rows, compact or with one row per man; a man's box (S3, S6)
 *   sidebar     one tile per own unit; a tap selects it (M7.5a)
 *   plan bar    while planning a move / assault / withdraw: formation, undo, Go, cancel (the pace: on the card)
 *   rules panel the unit's standing rules (fire, range, on contact, ammunition) and its state
 *   radio log   the last radio messages
 *   help card   every key and mouse / touch gesture ("?" in the top bar or the ? key, S13); the contour toggle
 *               (S14) and the "following" badge of the follow camera (S5)
 * All text comes from the string table.
 */
import type { Strings } from "@tcs/data";
import type { EntityId } from "@tcs/sim";
import type { Insets } from "@tcs/render";
import { noOrders, type Nature, type OrderSet } from "./orders-for";
import { defaultEdge, isVertical, loadEdge, nearestEdge, saveEdge, sidebarSide, type Edge } from "./dock";
import { createSidebar, type UnitTile } from "./sidebar";
import { DOUBLE_TAP_MS, isDoubleTap } from "./gestures";
import { icon } from "./icons";
import { createManBox, createUnitCard, fireChoice, fireChoiceRules, type ManDetail, type UnitCardModel } from "./card";
import { HELP_SECTIONS } from "./mapfeel";
import { createSupportPopup, type SupportOffer } from "./support";

/** (Step fire-support, S11: one "support" mode for mortar fire; HE or smoke is picked in a pop-up at the point.) */
export type OrderMode = "move" | "assault" | "withdraw" | "occupy" | "clear" | "fire" | "antitank" | "grenade" | "grenades" | "support";
/** The two order groups of the slim bar (S4): Move and its variants, Fire and the weapons. */
export type OrderGroup = "move" | "fire";
export const GROUP_OF: Readonly<Record<OrderMode, OrderGroup>> = { move: "move", assault: "move", withdraw: "move", occupy: "move", clear: "move", fire: "fire", antitank: "fire", grenade: "fire", grenades: "fire", support: "fire" };
const MODE_ICON: Readonly<Record<OrderMode, string>> = { move: "move", assault: "assault", withdraw: "withdraw", occupy: "occupy", clear: "clear", fire: "fire", antitank: "antitank", grenade: "grenade", grenades: "grenades", support: "support" };
const MODE_KEY: Readonly<Record<OrderMode, string>> = { move: "order.move", assault: "order.assault", withdraw: "order.withdraw", occupy: "order.occupy", clear: "order.clear", fire: "order.fire", antitank: "order.antitank", grenade: "order.grenade", grenades: "order.grenades", support: "order.support" };
export interface UnitRules { fire: "free" | "return" | "hold"; maxEngageM: number; onContact: "ground" | "push" | "back"; ammo: "conserve" | "normal" | "max"; /** Anti-tank weapons on their own (M7.4a). */ at: "vehicles" | "vehiclesAndPositions" | "hold" }

export interface HudCallbacks {
  /** Formation IDs available (from data) and the faction default shown first. */
  formations: string[];
  defaultFormation: string;
  /** Short label of the current map, shown in the bar; tapping the map button calls onNextMap. */
  mapLabel: string;
  onNextMap(): void;
  onSpeed(speed: number): void; // 0 = paused
  /** What the next taps on the map plan or order. */
  onOrderMode(mode: OrderMode): void;
  onHalt(): void;
  onCeaseFire(): void;
  /** Get in / get out (M7.2). */
  onMount(): void;
  onDismount(): void;
  /** Vehicles (M7.3): fire the smoke dischargers; the gun and round of the next fire order (null = crew's choice). */
  onDischarge(): void;
  onNature(nature: "ap" | "he" | "mg" | null): void;
  onPosture(posture: "standing" | "crouching" | "prone"): void;
  /** Pace of the next leg of the route being planned. */
  onPace(mode: string): void;
  onFormation(formation: string): void;
  onUndo(): void;
  onGo(): void;
  onCancel(): void;
  onRules(r: Partial<UnitRules>): void;
  onDebug(on: boolean): void;
  /** Save the battle / load the last save (M6). */
  onSave(): void;
  onLoad(): void;
  /** A tap on a unit's tile in the sidebar (M7.5a). */
  onSelectUnit(unit: EntityId): void;
  /** S5: a press held on a unit's tile (the camera follows it); the "following" badge tapped (stop). */
  onFollowUnit?(unit: EntityId): void;
  onStopFollow?(): void;
  /** S14: the contour toggle (contour lines at every zoom). */
  onContours?(on: boolean): void;
  /** S3: a pace chip pressed on the card (after onPace): the app may send the move under way again at it. */
  onPaceChosen?(pace: string): void;
  /** S6: a man's row on the card tapped (his detail box), or the box closed (null). */
  onInspect?(man: EntityId | null): void;
  /** The card changed its size (compact / detailed). */
  onCardResize?(): void;
  /** The colour of the player's side (the sidebar's symbols), as a CSS colour. */
  sideColour: string;
  /** The order bar moved or the sidebar opened: the free map area changed. */
  onLayout?(): void;
}

export interface ScorePart { text: string; colour?: string; title?: string }

export interface HudStats {
  simSeconds: number;
  tick: number;
  fps: number;
  simRate: number; // multiples of real time achieved
  hash: string;
  entities: number;
}

export interface Hud {
  update(s: HudStats): void;
  radio(text: string, simSeconds: number, colour: string): void;
  showError(text: string): void;
  /** Show the plan bar (move / assault / withdraw being planned) or hide it (null). */
  setPlanning(kind: "move" | "assault" | "withdraw" | null): void;
  /** The order mode shown as active (after Go or Cancel the app returns to move). Another mode than the locked
   *  one unlocks it. */
  setOrderMode(mode: OrderMode): void;
  /** S12: the mode shown was locked on by a double-tap on its button (it stays on after each order). */
  modeLocked(): boolean;
  /** The selected unit's rules and a status line, shown in the rules panel. */
  setUnit(rules: UnitRules | null, status: string): void;
  /** The score line under the top bar (objectives held, M6): text parts, a part with a colour shows a marker
   *  square in it (the holder's side colour, M7.5b) and its title as a tooltip. Empty: hidden. */
  setScore(parts: readonly ScorePart[]): void;
  /** Which orders and paces the bars offer for the selected unit (M7.1c: a vehicle has fewer, and its paces).
   *  null or a set with `none`: nothing selected, every button greyed (M7.5a). */
  setOrders(set: OrderSet | null): void;
  /** The unit sidebar's tiles and the selected unit (M7.5a; the app refreshes them a few times a second). */
  setTiles(tiles: readonly UnitTile[], selected: EntityId | null): void;
  /** The map area left free by the bars and the sidebar (px from each screen edge). */
  insets(): Insets;
  /** Review fix: how far up from the screen's bottom edge the radio log and the unit card reach (px; 0: none). */
  bottomCover(): number;
  /** The edge the order bar is docked to; dock it elsewhere (remembered on this device). */
  dock(): Edge;
  setDock(e: Edge): void;
  /** Open or close the sidebar's full list. */
  setSidebarExpanded(on: boolean): void;
  /** Open or close the rules panel (as its button does). */
  showRules(): void;
  /** The order set shown now. */
  orderSet(): OrderSet | null;
  /** The selected unit's card (S3, S6); null hides it. */
  setCard(m: UnitCardModel | null): void;
  /** The man's detail box (S6); null hides it. Which man's row is marked on the card. */
  showMan(d: ManDetail | null): void;
  setInspected(id: EntityId | null): void;
  /** Compact or detailed card (remembered on this device). */
  setCardDetailed(on: boolean): void;
  /** The pace lit on the card (the next move's). */
  pace(): string | null;
  /** S4: a context action offered at a screen point (Occupy after a move dragged onto a house) for a few seconds;
   *  null takes it away. */
  offerContext(c: ContextAction | null): void;
  /** S11: the fire support pop-up (HE or smoke at a point) or none; is it shown. */
  offerSupport(o: SupportOffer | null): void;
  supportShown(): boolean;
  /** S13: the speed buttons (0 = pause, 1, 2, 4) as if pressed; the speed shown. */
  setSpeed(v: number): void;
  speed(): number;
  /** S13: press an order's button as a tap would (a mode, halt, mount / dismount): false if not offered now. */
  press(order: string): boolean;
  /** S13 (Esc): close what is open over the map — a tray, a menu, the help card, the rules panel. False: nothing was. */
  dismiss(): boolean;
  /** S13: show or hide the help card (`on` absent: toggle); is it shown. */
  toggleHelp(on?: boolean): void;
  helpShown(): boolean;
  /** S5: the "following" badge with its text, or none. */
  setFollowing(text: string | null): void;
  /** S14: the contour toggle as on or off (and tell the app). */
  setContours(on: boolean): void;
}

export interface ContextAction { icon: string; key: string; x: number; y: number; run(): void }

const fmtTime = (s: number) => {
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export function createHud(root: HTMLElement, s: Strings, cb: HudCallbacks): Hud {
  // ---- top bar
  const bar = el("div", "hud-bar");
  const title = el("div", "hud-title", s.t("app.title"));
  const clock = el("div", "hud-clock", "00:00");
  const speeds: [string, number][] = [["❚❚", 0], ["1×", 1], ["2×", 2], ["4×", 4]];
  let speedNow = 1;
  const speedBtns = speeds.map(([label, v]) => {
    const b = el("button", "hud-btn", label);
    b.setAttribute("aria-label", v === 0 ? s.t("app.pause") : `${s.t("app.speed")} ${v}`);
    b.title = s.t(v === 0 ? "app.pauseKey" : "app.speedKey", { key: speeds.findIndex((x) => x[1] === v) + 1 });
    b.onclick = () => { speedNow = v; cb.onSpeed(v); speedBtns.forEach((x) => x.classList.toggle("on", x === b)); };
    return b;
  });
  speedBtns[1]!.classList.add("on");
  let debug = false;
  const dbgBtn = el("button", "hud-btn", s.t("app.debug"));
  const mapBtn = el("button", "hud-btn", cb.mapLabel);
  mapBtn.setAttribute("aria-label", s.t("app.map"));
  mapBtn.onclick = () => cb.onNextMap();
  const saveBtn = el("button", "hud-btn", s.t("app.save"));
  saveBtn.onclick = () => cb.onSave();
  const loadBtn = el("button", "hud-btn", s.t("app.load"));
  loadBtn.onclick = () => cb.onLoad();
  // M7.5b (parent review): on a narrow screen the bar is one row; Save, Load, the map and Debug go behind "⋯".
  const barMoreBtn = el("button", "hud-btn hud-more-btn", "⋯");
  barMoreBtn.setAttribute("aria-label", s.t("app.menu"));
  const barMenu = el("div", "hud-bar-menu");
  barMenu.hidden = true;
  barMoreBtn.onclick = () => { barMenu.hidden = !barMenu.hidden; barMoreBtn.classList.toggle("on", !barMenu.hidden); };
  // S14: contour lines at every zoom (remembered on the device by the app); S13: the help card.
  let contoursOn = false;
  const contourBtn = el("button", "hud-btn hud-contours", s.t("app.contours"));
  contourBtn.title = s.t("app.contoursHint");
  contourBtn.setAttribute("aria-pressed", "false");
  const setContours = (on: boolean) => { contoursOn = on; contourBtn.classList.toggle("on", on); contourBtn.setAttribute("aria-pressed", String(on)); cb.onContours?.(on); };
  contourBtn.onclick = () => setContours(!contoursOn);
  const helpBtn = el("button", "hud-btn hud-help-btn", "?");
  helpBtn.setAttribute("aria-label", s.t("help.title"));
  helpBtn.title = s.t("help.title");
  helpBtn.onclick = () => toggleHelp();
  const rare = [contourBtn, helpBtn, saveBtn, loadBtn, mapBtn, dbgBtn];
  for (const b of rare) b.addEventListener("click", () => { if (b.parentElement === barMenu) { barMenu.hidden = true; barMoreBtn.classList.remove("on"); } });
  bar.append(title, clock, ...speedBtns, ...rare, barMoreBtn, barMenu);
  const score = el("div", "hud-score");
  score.hidden = true;

  // ---- order bar (M7.5a; slimmed in the "bar-card" step, owner choice S4): a few core verbs as icon and short
  // label — Move, Fire, Halt, Mount / Dismount. Move and Fire are split buttons: the caret opens a tray of their
  // variants (Move: Assault, Withdraw, Occupy, Clear and the posture; Fire: Anti-tank, Grenade, All grenades, Mortar,
  // Smoke, the vehicle's gun and smoke screen, Cease fire). The group's button shows the variant that is on.
  const dock = el("div", "hud-dock");
  const orders = el("div", "hud-orders");
  const grip = el("div", "hud-grip", "⠿");
  grip.setAttribute("aria-label", s.t("app.dockGrip"));
  grip.title = s.t("app.dockGrip");
  const moreBtn = el("button", "hud-btn hud-more-btn", "⋯");
  moreBtn.setAttribute("aria-label", s.t("app.more"));
  const moreMenu = el("div", "hud-more");
  moreMenu.hidden = true;
  moreBtn.onclick = () => { closeTrays(); moreMenu.hidden = !moreMenu.hidden; moreBtn.classList.toggle("on", !moreMenu.hidden); };
  /** A button with an icon over (bar) or beside (tray) its label. */
  const iconBtn = (cls: string, ico: string, key: string): HTMLButtonElement => {
    const b = el("button", cls);
    b.innerHTML = `${icon(ico)}<span class="hud-lbl">${s.t(key)}</span>`;
    b.setAttribute("aria-label", s.t(key));
    return b;
  };
  const setLabel = (b: HTMLButtonElement, ico: string, key: string) => { b.innerHTML = `${icon(ico)}<span class="hud-lbl">${s.t(key)}</span>`; b.setAttribute("aria-label", s.t(key)); };
  // The tray items for the modes (one per mode), and the group's own button.
  const modeBtns = new Map<OrderMode, HTMLButtonElement>();
  // S12 (owner 2026-11-13): after a one-tap order the app returns to Move; a double-tap on a mode's button locks
  // it on (shown by a bold frame and a small mark), a double-tap again or another mode unlocks it. Move never locks.
  let locked: OrderMode | null = null;
  let lastClick: { mode: string; at: number } | null = null;
  const pick = (m: OrderMode) => {
    const now = globalThis.performance?.now() ?? Date.now();
    const dbl = m !== "move" && isDoubleTap(lastClick, m, now);
    if (dbl) { locked = locked === m ? null : m; lastClick = null; }
    else { lastClick = { mode: m, at: now }; if (locked !== m) locked = null; }
    setMode(m); cb.onOrderMode(m);
    return dbl;
  };
  interface Group { id: OrderGroup; base: OrderMode; wrap: HTMLDivElement; main: HTMLButtonElement; caret: HTMLButtonElement; tray: HTMLDivElement; shown: OrderMode }
  const groups: Group[] = [];
  const group = (id: OrderGroup, base: OrderMode): Group => {
    const wrap = el("div", "hud-group");
    wrap.dataset["group"] = id;
    const main = iconBtn("hud-btn hud-verb", MODE_ICON[base], MODE_KEY[base]);
    main.dataset["order"] = base;
    main.dataset["lock"] = s.t("order.lockedMark");
    const caret = el("button", "hud-btn hud-caret");
    caret.innerHTML = icon("caret", 16);
    caret.setAttribute("aria-label", s.t(`order.group.${id}`));
    caret.title = s.t(`order.group.${id}`);
    const tray = el("div", "hud-tray");
    tray.dataset["tray"] = id;
    tray.hidden = true;
    wrap.append(main, caret);
    const g: Group = { id, base, wrap, main, caret, tray, shown: base };
    main.onclick = () => { closeTrays(); pick(g.shown); };
    caret.onclick = () => { const open = tray.hidden; closeTrays(); if (open) openTray(g); };
    groups.push(g);
    return g;
  };
  let trayTimer: ReturnType<typeof setTimeout> | null = null;
  const closeTrays = () => {
    if (trayTimer !== null) { clearTimeout(trayTimer); trayTimer = null; }
    for (const g of groups) { g.tray.hidden = true; g.caret.classList.remove("on"); }
  };
  /** The tray opens beside its group's button, away from the edge the bar is docked to. */
  const openTray = (g: Group) => {
    moreMenu.hidden = true; moreBtn.classList.remove("on");
    g.tray.hidden = false;
    g.caret.classList.add("on");
    const r = g.wrap.getBoundingClientRect(), d = dock.getBoundingClientRect();
    g.tray.style.left = g.tray.style.right = g.tray.style.top = g.tray.style.bottom = "";
    if (isVertical(edge)) g.tray.style.top = `${Math.max(0, Math.min(r.top - d.top, d.height - g.tray.offsetHeight))}px`;
    else g.tray.style.left = `${Math.max(0, Math.min(r.left - d.left, d.width - g.tray.offsetWidth))}px`;
  };
  const trayMode = (g: Group, m: OrderMode) => {
    const b = iconBtn("hud-btn hud-tray-item", MODE_ICON[m], MODE_KEY[m]);
    b.dataset["order"] = m;
    b.dataset["lock"] = s.t("order.lockedMark");
    // The tray stays open a moment after a pick, so a double-tap can lock the mode on (S12).
    b.onclick = () => {
      const dbl = pick(m);
      if (trayTimer !== null) clearTimeout(trayTimer);
      trayTimer = dbl ? null : setTimeout(closeTrays, DOUBLE_TAP_MS + 50);
      if (dbl) closeTrays();
    };
    modeBtns.set(m, b);
    g.tray.append(b);
    return b;
  };
  const trayAction = (g: Group, ico: string, key: string, order: string, f: () => void) => {
    const b = iconBtn("hud-btn hud-tray-item", ico, key);
    b.dataset["order"] = order;
    b.onclick = () => { closeTrays(); f(); };
    g.tray.append(b);
    return b;
  };
  const setMode = (m: OrderMode) => {
    if (locked !== m) locked = null;
    for (const [k, b] of modeBtns) {
      b.classList.toggle("on", k === m);
      b.classList.toggle("locked", k === locked);
      b.title = k === locked ? s.t("order.lockedHint") : k !== "move" ? s.t("order.lockHint") : "";
    }
    // The group's button shows the variant that is on (else its first mode), lit while one of its modes is on.
    for (const g of groups) {
      const mine = GROUP_OF[m] === g.id;
      const shown = mine ? m : g.base;
      // (Review fix: the label stays the group's own — "Move", "Fire" — so the bar keeps its width; the icon and
      // the button's name show the variant that is on.)
      if (shown !== g.shown || g.main.dataset["order"] !== shown) {
        g.shown = shown; g.main.dataset["order"] = shown;
        setLabel(g.main, MODE_ICON[shown], MODE_KEY[g.base]);
        g.main.setAttribute("aria-label", s.t(MODE_KEY[shown]));
      }
      g.main.classList.toggle("on", mine);
      g.main.classList.toggle("locked", mine && locked === m);
      g.main.title = `${s.t(MODE_KEY[shown])}${mine && locked === m ? ` · ${s.t("order.lockedHint")}` : shown !== "move" ? ` · ${s.t("order.lockHint")}` : ""}`;
    }
    hint.textContent = s.t(m === "move" ? "plan.tapPoints" : m === "assault" || m === "withdraw" ? "plan.tapPoint" : m === "occupy" ? "plan.tapBuilding" : m === "clear" ? "plan.tapClear" : m === "support" ? "plan.support" : "plan.tapTarget");
  };
  const moveG = group("move", "move"), fireG = group("fire", "fire");
  for (const m of ["move", "assault", "withdraw", "occupy", "clear"] as const) trayMode(moveG, m);
  const postureBtns = (["standing", "crouching", "prone"] as const).map((p) => trayAction(moveG, p, `order.posture.${p}`, "posture", () => cb.onPosture(p)));
  for (const m of ["fire", "antitank", "grenade", "grenades", "support"] as const) trayMode(fireG, m);
  let natures: (Nature | null)[] = [null, "ap", "he", "mg"];
  let nature = 0;
  const natureBtn = trayAction(fireG, "nature", "order.nature.auto", "nature", () => undefined);
  // (The gun choice is cycled in place: the tray stays open to show it.)
  natureBtn.onclick = () => {
    nature = (nature + 1) % natures.length;
    setLabel(natureBtn, "nature", `order.nature.${natures[nature] ?? "auto"}`);
    cb.onNature(natures[nature] ?? null);
  };
  const dischargeBtn = trayAction(fireG, "discharge", "order.discharge", "discharge", () => cb.onDischarge());
  const ceaseBtn = trayAction(fireG, "ceaseFire", "order.ceaseFire", "ceaseFire", () => cb.onCeaseFire());
  const verb = (ico: string, key: string, order: string, f: () => void) => { const b = iconBtn("hud-btn hud-verb", ico, key); b.dataset["order"] = order; b.onclick = () => { closeTrays(); f(); }; return b; };
  const haltBtn = verb("halt", "order.halt", "halt", () => cb.onHalt());
  const mountBtn = verb("mount", "order.mount", "mount", () => cb.onMount());
  const dismountBtn = verb("dismount", "order.dismount", "dismount", () => cb.onDismount());
  mountBtn.hidden = true; dismountBtn.hidden = true; dischargeBtn.hidden = true; natureBtn.hidden = true;
  // Display order in the bar; and the order in which items move behind "⋯" when the strip is too short.
  const barItems: HTMLElement[] = [moveG.wrap, fireG.wrap, haltBtn, mountBtn, dismountBtn];
  const OVERFLOW_FIRST = ["mount", "dismount", "halt"];
  const allButtons = (): HTMLButtonElement[] => [...dock.querySelectorAll("button")];
  orders.append(grip, ...barItems, moreBtn);
  for (const b of [haltBtn, mountBtn, dismountBtn]) b.addEventListener("click", () => { if (b.parentElement === moreMenu) { moreMenu.hidden = true; moreBtn.classList.remove("on"); } });

  // ---- plan bar (S3: the pace of the next leg is chosen on the unit card)
  const plan = el("div", "hud-plan");
  plan.hidden = true;
  let paces = ["walk", "run", "sneak", "crawl"];
  let pace = 0;
  const formations = [cb.defaultFormation, ...cb.formations.filter((f) => f !== cb.defaultFormation)];
  let formation = 0;
  const formBtn = el("button", "hud-btn", s.t(`formation.${formations[0]}`));
  formBtn.setAttribute("aria-label", s.t("app.formation"));
  formBtn.onclick = () => { formation = (formation + 1) % formations.length; formBtn.textContent = s.t(`formation.${formations[formation]!}`); cb.onFormation(formations[formation]!); };
  const undoBtn = el("button", "hud-btn", s.t("order.undo"));
  undoBtn.onclick = () => cb.onUndo();
  const goBtn = el("button", "hud-btn hud-go", s.t("order.go"));
  goBtn.onclick = () => cb.onGo();
  const cancelBtn = el("button", "hud-btn", s.t("order.cancel"));
  cancelBtn.onclick = () => cb.onCancel();
  plan.append(formBtn, undoBtn, cancelBtn, goBtn);

  // ---- unit card (S3, S6) and the man's box
  let rules: UnitRules | null = null;
  const card = createUnitCard(s, {
    onPace: (p) => { const k = paces.indexOf(p); if (k < 0) return; pace = k; card.setPaces(paces, p); cb.onPace(p); cb.onPaceChosen?.(p); },
    onFire: (c) => { if (!rules) return; const r = fireChoiceRules(c, rules); rules = { ...rules, ...r }; card.setFire(fireChoice(rules)); cb.onRules(r); },
    onRules: () => toggleRules(),
    onMan: (id) => cb.onInspect?.(id),
    onResize: () => cb.onCardResize?.(),
  });
  const manBox = createManBox(s, () => cb.onInspect?.(null));
  // S4: the context button (Occupy at the end of a drag onto a house).
  const ctx = el("button", "hud-btn hud-context");
  ctx.hidden = true;
  let ctxTimer: ReturnType<typeof setTimeout> | null = null;
  const offerContext = (c: ContextAction | null) => {
    if (ctxTimer !== null) { clearTimeout(ctxTimer); ctxTimer = null; }
    ctx.hidden = c === null;
    if (!c) return;
    ctx.innerHTML = `${icon(c.icon)}<span class="hud-lbl">${s.t(c.key)}</span>`;
    ctx.dataset["context"] = c.key;
    // Beside the point, kept on the screen.
    const w = globalThis.innerWidth || 1000, hgt = globalThis.innerHeight || 800;
    ctx.style.left = `${Math.max(8, Math.min(w - 150, c.x + 18))}px`;
    // (Never over the radio log and the card: above them, review fix.)
    const floor = Math.min(hgt - 60, (bottom.getBoundingClientRect?.().top ?? hgt) - 48);
    ctx.style.top = `${Math.max(free.top + 8, Math.min(floor, c.y - 22))}px`;
    ctx.onclick = () => { offerContext(null); c.run(); };
    ctxTimer = setTimeout(() => offerContext(null), 6000);
  };
  card.setPaces(paces, paces[0]!);

  // ---- rules panel
  const panel = el("div", "hud-panel");
  panel.hidden = true;
  const status = el("div", "hud-status");
  const rows: { key: keyof UnitRules; label: string; options: [UnitRules[keyof UnitRules], string][] }[] = [
    { key: "fire", label: "rules.fire", options: [["free", "rules.fire.free"], ["return", "rules.fire.return"], ["hold", "rules.fire.hold"]] },
    { key: "maxEngageM", label: "rules.range", options: [[0, "rules.range.none"], [400, "400"], [200, "200"], [100, "100"]] },
    { key: "onContact", label: "rules.contact", options: [["ground", "rules.contact.ground"], ["push", "rules.contact.push"], ["back", "rules.contact.back"]] },
    { key: "ammo", label: "rules.ammo", options: [["conserve", "rules.ammo.conserve"], ["normal", "rules.ammo.normal"], ["max", "rules.ammo.max"]] },
    { key: "at", label: "rules.at", options: [["vehicles", "rules.at.vehicles"], ["vehiclesAndPositions", "rules.at.vehiclesAndPositions"], ["hold", "rules.at.hold"]] },
  ];
  const ruleBtns: { key: keyof UnitRules; value: UnitRules[keyof UnitRules]; b: HTMLButtonElement }[] = [];
  panel.append(el("div", "hud-panel-title", s.t("rules.title")), status);
  for (const r of rows) {
    const row = el("div", "hud-row");
    row.append(el("span", "hud-row-label", s.t(r.label)));
    for (const [value, key] of r.options) {
      const b = el("button", "hud-btn hud-small", typeof value === "number" && value > 0 ? s.t("rules.range.m", { m: value }) : s.t(key));
      b.onclick = () => {
        cb.onRules({ [r.key]: value } as Partial<UnitRules>);
        for (const x of ruleBtns) if (x.key === r.key) x.b.classList.toggle("on", x.value === value);
        if (rules) { rules = { ...rules, [r.key]: value }; card.setFire(fireChoice(rules)); }
      };
      ruleBtns.push({ key: r.key, value, b });
      row.append(b);
    }
    panel.append(row);
  }

  const hint = el("div", "hud-hint", s.t("app.hint"));
  const log = el("div", "hud-radio");
  const dbg = el("pre", "hud-debug");
  dbg.hidden = true;
  dbgBtn.onclick = () => {
    debug = !debug;
    dbg.hidden = !debug;
    dbgBtn.classList.toggle("on", debug);
    cb.onDebug(debug);
  };
  const err = el("pre", "hud-error");
  err.hidden = true;
  const bottom = el("div", "hud-bottom");
  // (The card nearest the order bar, the radio log above it.)
  bottom.append(log, card.el);
  /** Open or close the rules panel (the card's Rules button). */
  const toggleRules = () => { if (current?.none || !current?.rules) return; panel.hidden = !panel.hidden; card.setRulesButton(true, !panel.hidden); hint.hidden = true; };
  dock.append(orders, plan, moreMenu);
  // ---- unit sidebar (M7.5a)
  const sidebar = createSidebar(s, cb.sideColour, (u) => cb.onSelectUnit(u), () => layout(), (u) => cb.onFollowUnit?.(u));
  // Where the dragged bar would dock (a strip along that edge while the grip is held).
  const preview = el("div", "hud-dock-preview");
  preview.hidden = true;
  dock.append(moveG.tray, fireG.tray);
  // ---- help card (S13): every key and gesture, from the string table.
  const help = el("div", "hud-help");
  help.hidden = true;
  help.setAttribute("role", "dialog");
  const helpHead = el("div", "hud-help-head");
  const helpClose = el("button", "hud-btn hud-help-close", "✕");
  helpClose.setAttribute("aria-label", s.t("help.close"));
  helpClose.onclick = () => toggleHelp(false);
  helpHead.append(el("span", "hud-panel-title", s.t("help.title")), helpClose);
  help.append(helpHead);
  // (A touch screen lists the touch gestures first and leaves out the mouse; a mouse screen leaves out touch.)
  const coarse = globalThis.matchMedia?.("(pointer: coarse)").matches === true;
  for (const sec of (coarse ? [...HELP_SECTIONS].reverse() : HELP_SECTIONS).filter((x) => x.title !== (coarse ? "help.mouse" : "help.touch"))) {
    help.append(el("div", "hud-help-sec", s.t(sec.title)));
    const tbl = el("div", "hud-help-rows");
    const kbd = sec.title === "help.keys";
    for (const [k, what] of sec.rows) tbl.append(el("span", kbd ? "hud-help-key kbd" : "hud-help-key", s.t(k)), el("span", "hud-help-what", s.t(what)));
    help.append(tbl);
  }
  const toggleHelp = (on?: boolean) => {
    help.hidden = !(on ?? help.hidden);
    helpBtn.classList.toggle("on", !help.hidden);
    if (!help.hidden) { help.style.top = `${free.top + 8}px`; hint.hidden = true; barMenu.hidden = true; barMoreBtn.classList.remove("on"); helpMore(); }
  };
  /** Review fix: the card fades out at the bottom while more of it is below (it scrolls). */
  const helpMore = () => { help.classList.toggle("more", help.scrollHeight - help.scrollTop - help.clientHeight > 4); };
  help.addEventListener("scroll", helpMore, { passive: true });
  // ---- the follow camera's badge (S5): tap it to stop following.
  const follow = el("button", "hud-btn hud-follow");
  follow.hidden = true;
  follow.onclick = () => cb.onStopFollow?.();
  const support = createSupportPopup(s);
  root.append(bar, score, hint, panel, manBox.el, bottom, sidebar.el, dock, ctx, support.el, follow, preview, help, dbg, err);
  setMode("move");
  // The start hint is one short line on every screen (M7.5b on the phone; review fix on the desktop, where the
  // long one was a wall of text over the map); tapping it shows the whole text, again: short. It goes once a unit
  // is picked.
  const shortHint = () => s.t(coarse ? "app.hintShort" : "app.hintShortMouse");
  hint.textContent = shortHint();
  hint.style.pointerEvents = "auto";
  hint.onclick = () => { hint.textContent = hint.textContent === s.t("app.hint") ? shortHint() : s.t("app.hint"); };

  // ---- docking and layout
  const store = (): Storage | null => { try { return globalThis.localStorage; } catch { return null; } };
  let chosen: Edge | null = loadEdge(store());
  let edge: Edge = chosen ?? defaultEdge(globalThis.innerWidth, globalThis.innerHeight);
  let current: OrderSet | null = null;
  /** Free map area (px from each edge) left by the top bar, the order bar and the sidebar. */
  let free: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  /** Rare buttons go behind "⋯" until the strip fits on one row (one column when docked at a side). */
  const fit = () => {
    for (const b of barItems) orders.insertBefore(b, moreBtn); // all back, in display order
    moreBtn.hidden = true;
    const vertical = isVertical(edge);
    const over = () => (vertical ? orders.scrollHeight > orders.clientHeight + 1 : orders.scrollWidth > orders.clientWidth + 1);
    if (!over()) { moreMenu.hidden = true; moreBtn.classList.remove("on"); return; }
    moreBtn.hidden = false;
    for (const key of OVERFLOW_FIRST) {
      if (!over()) break;
      const b = barItems.find((x) => x.dataset["order"] === key);
      if (b && !b.hidden) moreMenu.append(b);
    }
  };
  /** The card and the radio log sit just above the order bar (also while the plan bar is open over it). */
  const placeBottom = () => {
    bottom.style.bottom = `${(edge === "bottom" ? dock.offsetHeight : 0) + 6}px`;
    manBox.el.style.top = `${free.top + 8}px`;
  };
  /** The top bar on one row: the rare buttons behind "⋯" when they do not fit (narrow screens). */
  const fitBar = () => {
    for (const b of rare) bar.insertBefore(b, barMoreBtn);
    barMoreBtn.hidden = true;
    title.hidden = false;
    const over = () => bar.scrollWidth > bar.clientWidth + 1 || bar.offsetHeight > 60;
    if (!over()) { barMenu.hidden = true; barMoreBtn.classList.remove("on"); return; }
    barMoreBtn.hidden = false;
    barMenu.append(...rare);
    if (over()) title.hidden = true;
  };
  const layout = () => {
    fitBar();
    const vertical = isVertical(edge);
    dock.className = `hud-dock dock-${edge}`;
    orders.classList.toggle("vertical", vertical);
    plan.classList.toggle("vertical", vertical);
    sidebar.setSide(sidebarSide(edge));
    const h = bar.offsetHeight;
    score.style.top = `${h}px`;
    const below = h + (score.hidden ? 0 : score.offsetHeight);
    // The dock: full width under the bars (top) or at the bottom; full height below the bars at a side.
    dock.style.top = edge === "bottom" ? "" : `${below}px`;
    const side = sidebarSide(edge);
    // The sidebar hangs from the bars, as long as its tiles (a short list makes a short strip).
    const sTop = below + (edge === "top" ? dock.offsetHeight : 0);
    sidebar.el.style.top = `${sTop}px`;
    sidebar.el.style.maxHeight = `${Math.max(80, (root.clientHeight || globalThis.innerHeight) - sTop - (edge === "bottom" ? dock.offsetHeight : 0))}px`;
    fit();
    const dw = dock.offsetWidth, dh = dock.offsetHeight, sw = sidebar.width();
    free = {
      top: below + (edge === "top" ? dh : 0),
      bottom: edge === "bottom" ? dh : 0,
      left: (edge === "left" ? dw : 0) + (side === "left" ? sw : 0),
      right: (edge === "right" ? dw : 0) + (side === "right" ? sw : 0),
    };
    for (const [k, v] of Object.entries(free)) root.style.setProperty(`--free-${k}`, `${v}px`);
    hint.style.top = `${free.top + 8}px`; dbg.style.top = `${free.top + 8}px`; panel.style.top = `${free.top + 8}px`;
    help.style.top = `${free.top + 8}px`;
    follow.style.top = `${free.top + 8}px`;
    follow.style.left = `${free.left + (Math.max(0, (root.clientWidth || globalThis.innerWidth) - free.left - free.right)) / 2}px`;
    closeTrays();
    placeBottom();
  };
  const setDock = (e: Edge, remember: boolean) => {
    edge = e;
    if (remember) { chosen = e; saveEdge(store(), e); }
    layout();
    cb.onLayout?.();
  };
  // Drag the grip; on release the bar docks to the nearest edge (owner answer 7).
  let dragging = false;
  grip.addEventListener("pointerdown", (ev) => { dragging = true; grip.setPointerCapture(ev.pointerId); ev.preventDefault(); });
  grip.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    const e = nearestEdge(ev.clientX, ev.clientY, globalThis.innerWidth, globalThis.innerHeight);
    preview.hidden = false;
    preview.className = `hud-dock-preview preview-${e}`;
  });
  const drop = (ev: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    const moved = !preview.hidden;
    preview.hidden = true;
    if (moved) setDock(nearestEdge(ev.clientX, ev.clientY, globalThis.innerWidth, globalThis.innerHeight), true);
  };
  grip.addEventListener("pointerup", drop);
  grip.addEventListener("pointercancel", () => { dragging = false; preview.hidden = true; });
  globalThis.addEventListener("resize", () => {
    // Not chosen yet: follow the screen's orientation.
    if (chosen === null) edge = defaultEdge(globalThis.innerWidth, globalThis.innerHeight);
    layout();
  });
  layout();

  return {
    update(st) {
      clock.textContent = fmtTime(st.simSeconds);
      if (!dbg.hidden) {
        dbg.textContent = [
          `${s.t("app.fps")}      ${st.fps.toFixed(0)}`,
          `${s.t("app.simRate")} ${st.simRate.toFixed(2)}×`,
          `${s.t("app.tick")}     ${st.tick}`,
          `entities ${st.entities}`,
          `${s.t("app.hash")}`,
          `${st.hash}`,
        ].join("\n");
      }
    },
    radio(text, simSeconds, colour) {
      const line = el("div", "hud-radio-line");
      const time = el("span", "hud-radio-time", fmtTime(simSeconds) + " ");
      const msg = el("span", "", text);
      msg.style.color = colour;
      line.append(time, msg);
      log.prepend(line);
      while (log.childElementCount > 4) log.lastElementChild?.remove();
      hint.hidden = true;
    },
    showError(text) {
      err.hidden = false;
      err.textContent = text;
    },
    setPlanning(kind) {
      plan.hidden = kind === null;
      if (kind !== null) hint.hidden = true;
      formBtn.hidden = kind !== "move";
      undoBtn.hidden = kind !== "move";
      closeTrays();
      placeBottom();
    },
    setOrderMode(m) { setMode(m); },
    modeLocked: () => locked !== null,
    setOrders(given) {
      // Nothing selected (M7.5a, owner answer 6): the bar stays, greyed out.
      const set = given ?? noOrders();
      current = set;
      const off = set.none === true;
      // The start hint ("Pick a unit") has done its job once a unit is picked (review fix).
      if (!off) hint.hidden = true;
      for (const [m, b] of modeBtns) b.hidden = !set.modes.includes(m);
      haltBtn.hidden = !set.halt; ceaseBtn.hidden = !set.ceaseFire;
      for (const b of postureBtns) b.hidden = !set.posture;
      mountBtn.hidden = !set.mount; dismountBtn.hidden = !set.dismount;
      dischargeBtn.hidden = !set.discharge; natureBtn.hidden = !set.nature;
      // A group shows while one of its modes is offered; its caret while its tray has more than the button itself.
      for (const g of groups) {
        const items = [...g.tray.children] as HTMLElement[];
        g.wrap.hidden = !items.some((b) => !b.hidden && modeBtns.has(b.dataset["order"] as OrderMode));
        g.caret.hidden = items.filter((b) => !b.hidden).length < 2;
      }
      for (const b of allButtons()) b.disabled = off;
      moreBtn.disabled = off;
      dock.classList.toggle("greyed", off);
      closeTrays();
      if (off) { panel.hidden = true; plan.hidden = true; }
      card.setRulesButton(set.rules && !off, !panel.hidden);
      const ns: (Nature | null)[] = [null, ...(set.natures ?? ["ap", "he", "mg"])];
      if (ns.join() !== natures.join()) { natures = ns; nature = 0; setLabel(natureBtn, "nature", "order.nature.auto"); cb.onNature(null); }
      fit();
      if (set.paces.join() !== paces.join()) {
        paces = [...set.paces]; pace = 0;
        cb.onPace(paces[0]!);
      }
      card.setPaces(paces, paces[pace]!);
      placeBottom();
    },
    setScore(parts) {
      const key = JSON.stringify(parts);
      if (key === score.dataset["key"]) return;
      score.dataset["key"] = key;
      const was = score.hidden;
      score.replaceChildren(...parts.map((p, i) => {
        const sp = el("span", "hud-score-part");
        if (p.colour) { const m = el("span", "hud-score-mark"); m.style.background = p.colour; sp.append(m); }
        sp.append(document.createTextNode(p.text));
        if (p.title) sp.title = p.title;
        if (i > 0) sp.prepend(document.createTextNode(" · "));
        return sp;
      }));
      score.hidden = parts.length === 0;
      if (was !== score.hidden) layout();
    },
    setTiles(tiles, selected) { sidebar.update(tiles, selected); },
    insets: () => ({ ...free }),
    bottomCover: () => {
      if (bottom.hidden || bottom.childElementCount === 0) return 0;
      const r = bottom.getBoundingClientRect?.();
      const H = root.clientHeight || globalThis.innerHeight || 0;
      return r && r.height > 0 ? Math.max(0, H - r.top) : 0;
    },
    dock: () => edge,
    setDock: (e) => setDock(e, true),
    setSidebarExpanded: (on) => sidebar.setExpanded(on),
    showRules: () => toggleRules(),
    orderSet: () => current,
    setUnit(r, text) {
      status.textContent = text;
      rules = r;
      card.setFire(r ? fireChoice(r) : null);
      if (!r) return;
      for (const x of ruleBtns) x.b.classList.toggle("on", r[x.key] === x.value);
    },
    setCard(m) { card.update(m); bottom.classList.toggle("with-card", m !== null); if (m === null) { panel.hidden = true; card.setRulesButton(false, false); } },
    showMan(d) { manBox.update(d); },
    setInspected(id) { card.setInspected(id); },
    setCardDetailed(on) { card.setDetailed(on); },
    pace: () => paces[pace] ?? null,
    offerContext,
    offerSupport: (o) => support.show(o ? { ...o, insets: o.insets ?? free } : null),
    supportShown: () => support.shown(),
    setSpeed(v) { const b = speedBtns[speeds.findIndex((x) => x[1] === v)]; if (b) b.click(); },
    speed: () => speedNow,
    press(order) {
      if (current?.none) return false;
      const b = modeBtns.get(order as OrderMode) ?? (order === "halt" ? haltBtn : order === "mount" ? (mountBtn.hidden ? dismountBtn : mountBtn) : order === "dismount" ? dismountBtn : undefined);
      if (!b || b.hidden || b.disabled) return false;
      // A key pressed twice is not a double-tap (review fix: T T locked Fire on unseen); only taps and clicks lock.
      lastClick = null;
      b.click();
      lastClick = null;
      if (modeBtns.has(order as OrderMode)) closeTrays();
      return true;
    },
    dismiss() {
      let any = false;
      if (!help.hidden) { toggleHelp(false); any = true; }
      if (groups.some((g) => !g.tray.hidden)) { closeTrays(); any = true; }
      if (!moreMenu.hidden) { moreMenu.hidden = true; moreBtn.classList.remove("on"); any = true; }
      if (!barMenu.hidden) { barMenu.hidden = true; barMoreBtn.classList.remove("on"); any = true; }
      if (!panel.hidden) { toggleRules(); any = true; }
      if (!ctx.hidden) { offerContext(null); any = true; }
      if (support.shown()) { support.show(null); any = true; }
      return any;
    },
    toggleHelp,
    helpShown: () => !help.hidden,
    setFollowing(text) {
      follow.hidden = text === null;
      if (text !== null && follow.textContent !== text) { follow.textContent = text; follow.title = s.t("follow.stop"); }
    },
    setContours,
  };
}
