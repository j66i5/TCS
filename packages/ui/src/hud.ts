/**
 * HTML heads-up display over the map (M5):
 *   top bar     time, pause and speeds (orders work while paused), map, Debug
 *   order bar   for the selected unit (only what it can do, M7.5a): move, assault, withdraw, fire, grenade, halt,
 *               cease fire, posture, rules. Always shown, greyed while nothing is selected; docked to any edge
 *               (drag its grip), one row (one column at a side) with rare buttons behind "⋯".
 *   sidebar     one tile per own unit; a tap selects it (M7.5a)
 *   plan bar    while planning a move / assault / withdraw: pace for the next leg, formation, undo, Go, cancel
 *   rules panel the unit's standing rules (fire, range, on contact, ammunition) and its state
 *   radio log   the last radio messages
 * All text comes from the string table.
 */
import type { Strings } from "@tcs/data";
import type { EntityId } from "@tcs/sim";
import type { Insets } from "@tcs/render";
import { noOrders, type Nature, type OrderSet } from "./orders-for";
import { defaultEdge, isVertical, loadEdge, nearestEdge, saveEdge, sidebarSide, type Edge } from "./dock";
import { createSidebar, type UnitTile } from "./sidebar";

export type OrderMode = "move" | "assault" | "withdraw" | "fire" | "antitank" | "grenade" | "grenades" | "mortar" | "smoke";
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
  /** The order mode shown as active (after Go or Cancel the app returns to move). */
  setOrderMode(mode: OrderMode): void;
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
  /** The edge the order bar is docked to; dock it elsewhere (remembered on this device). */
  dock(): Edge;
  setDock(e: Edge): void;
  /** Open or close the sidebar's full list. */
  setSidebarExpanded(on: boolean): void;
  /** Open or close the rules panel (as its button does). */
  showRules(): void;
  /** The order set shown now. */
  orderSet(): OrderSet | null;
}

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
  const speedBtns = speeds.map(([label, v]) => {
    const b = el("button", "hud-btn", label);
    b.setAttribute("aria-label", v === 0 ? s.t("app.pause") : `${s.t("app.speed")} ${v}`);
    b.onclick = () => { cb.onSpeed(v); speedBtns.forEach((x) => x.classList.toggle("on", x === b)); };
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
  const rare = [saveBtn, loadBtn, mapBtn, dbgBtn];
  for (const b of rare) b.addEventListener("click", () => { if (b.parentElement === barMenu) { barMenu.hidden = true; barMoreBtn.classList.remove("on"); } });
  bar.append(title, clock, ...speedBtns, ...rare, barMoreBtn, barMenu);
  const score = el("div", "hud-score");
  score.hidden = true;

  // ---- order bar (M7.5a): its own strip docked to an edge, a grip to drag it, rare buttons behind "⋯"
  const dock = el("div", "hud-dock");
  const orders = el("div", "hud-orders");
  const grip = el("div", "hud-grip", "⠿");
  grip.setAttribute("aria-label", s.t("app.dockGrip"));
  grip.title = s.t("app.dockGrip");
  const moreBtn = el("button", "hud-btn hud-more-btn", "⋯");
  moreBtn.setAttribute("aria-label", s.t("app.more"));
  const moreMenu = el("div", "hud-more");
  moreMenu.hidden = true;
  moreBtn.onclick = () => { moreMenu.hidden = !moreMenu.hidden; moreBtn.classList.toggle("on", !moreMenu.hidden); };
  const modeBtns = new Map<OrderMode, HTMLButtonElement>();
  const mode = (m: OrderMode, key: string) => {
    const b = el("button", "hud-btn", s.t(key));
    b.dataset["order"] = m;
    b.onclick = () => { setMode(m); cb.onOrderMode(m); };
    modeBtns.set(m, b);
    return b;
  };
  const setMode = (m: OrderMode) => { for (const [k, b] of modeBtns) b.classList.toggle("on", k === m); hint.textContent = s.t(m === "move" ? "plan.tapPoints" : m === "assault" || m === "withdraw" ? "plan.tapPoint" : "plan.tapTarget"); };
  const btn = (key: string, order: string, f: () => void) => { const b = el("button", "hud-btn", s.t(key)); b.dataset["order"] = order; b.onclick = f; return b; };
  const haltBtn = btn("order.halt", "halt", () => cb.onHalt());
  const ceaseBtn = btn("order.ceaseFire", "ceaseFire", () => cb.onCeaseFire());
  const postures = ["standing", "crouching", "prone"] as const;
  let posture = 0;
  const postureBtn = btn("posture.standing", "posture", () => {
    posture = (posture + 1) % postures.length;
    postureBtn.textContent = s.t(`posture.${postures[posture]!}`);
    cb.onPosture(postures[posture]!);
  });
  postureBtn.setAttribute("aria-label", s.t("app.posture"));
  const rulesBtn = btn("order.rules", "rules", () => { panel.hidden = !panel.hidden; rulesBtn.classList.toggle("on", !panel.hidden); hint.hidden = true; });
  const mountBtn = btn("order.mount", "mount", () => cb.onMount());
  const dismountBtn = btn("order.dismount", "dismount", () => cb.onDismount());
  const dischargeBtn = btn("order.discharge", "discharge", () => cb.onDischarge());
  let natures: (Nature | null)[] = [null, "ap", "he", "mg"];
  let nature = 0;
  const natureBtn = btn("order.nature.auto", "nature", () => {
    nature = (nature + 1) % natures.length;
    natureBtn.textContent = s.t(`order.nature.${natures[nature] ?? "auto"}`);
    cb.onNature(natures[nature] ?? null);
  });
  mountBtn.hidden = true; dismountBtn.hidden = true; dischargeBtn.hidden = true; natureBtn.hidden = true;
  // Display order in the bar; and the order in which buttons move behind "⋯" when the strip is too short.
  const barButtons: HTMLButtonElement[] = [mode("move", "order.move"), mode("assault", "order.assault"), mode("withdraw", "order.withdraw"), mode("fire", "order.fire"), natureBtn, mode("antitank", "order.antitank"),
    mode("grenade", "order.grenade"), mode("grenades", "order.grenades"), mode("mortar", "order.mortar"), mode("smoke", "order.smoke"), dischargeBtn, mountBtn, dismountBtn, haltBtn, ceaseBtn, postureBtn, rulesBtn];
  const OVERFLOW_FIRST = ["smoke", "mortar", "grenades", "withdraw", "rules", "posture", "discharge", "nature", "antitank", "grenade", "ceaseFire", "assault", "halt", "mount", "dismount", "fire"];
  orders.append(grip, ...barButtons, moreBtn);
  for (const b of barButtons) b.addEventListener("click", () => { if (b.parentElement === moreMenu) { moreMenu.hidden = true; moreBtn.classList.remove("on"); } });

  // ---- plan bar
  const plan = el("div", "hud-plan");
  plan.hidden = true;
  let paces = ["walk", "run", "sneak", "crawl"];
  let pace = 0;
  const paceBtn = el("button", "hud-btn", `${s.t("order.pace")}: ${s.t("move.walk")}`);
  paceBtn.onclick = () => { pace = (pace + 1) % paces.length; paceBtn.textContent = `${s.t("order.pace")}: ${s.t(`move.${paces[pace]!}`)}`; cb.onPace(paces[pace]!); };
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
  plan.append(paceBtn, formBtn, undoBtn, cancelBtn, goBtn);

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
      b.onclick = () => { cb.onRules({ [r.key]: value } as Partial<UnitRules>); for (const x of ruleBtns) if (x.key === r.key) x.b.classList.toggle("on", x.value === value); };
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
  bottom.append(log);
  dock.append(orders, plan, moreMenu);
  // ---- unit sidebar (M7.5a)
  const sidebar = createSidebar(s, cb.sideColour, (u) => cb.onSelectUnit(u), () => layout());
  // Where the dragged bar would dock (a strip along that edge while the grip is held).
  const preview = el("div", "hud-dock-preview");
  preview.hidden = true;
  root.append(bar, score, hint, panel, bottom, sidebar.el, dock, preview, dbg, err);
  setMode("move");
  // On a phone the start hint is one short line (M7.5b: the long one covered the opening view); tapping it shows
  // the whole text.
  const narrow = () => (globalThis.innerWidth || 1000) < 700;
  hint.textContent = narrow() ? s.t("app.hintShort") : s.t("app.hint");
  hint.style.pointerEvents = "auto";
  hint.onclick = () => { hint.textContent = hint.textContent === s.t("app.hint") ? s.t("app.hintShort") : s.t("app.hint"); };

  // ---- docking and layout
  const store = (): Storage | null => { try { return globalThis.localStorage; } catch { return null; } };
  let chosen: Edge | null = loadEdge(store());
  let edge: Edge = chosen ?? defaultEdge(globalThis.innerWidth, globalThis.innerHeight);
  let current: OrderSet | null = null;
  /** Free map area (px from each edge) left by the top bar, the order bar and the sidebar. */
  let free: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  /** Rare buttons go behind "⋯" until the strip fits on one row (one column when docked at a side). */
  const fit = () => {
    for (const b of barButtons) orders.insertBefore(b, moreBtn); // all back, in display order
    moreBtn.hidden = true;
    const vertical = isVertical(edge);
    const over = () => (vertical ? orders.scrollHeight > orders.clientHeight + 1 : orders.scrollWidth > orders.clientWidth + 1);
    if (!over()) { moreMenu.hidden = true; moreBtn.classList.remove("on"); return; }
    moreBtn.hidden = false;
    for (const key of OVERFLOW_FIRST) {
      if (!over()) break;
      const b = barButtons.find((x) => x.dataset["order"] === key);
      if (b && !b.hidden) moreMenu.append(b);
    }
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
      paceBtn.hidden = kind !== "move";
      formBtn.hidden = kind !== "move";
      undoBtn.hidden = kind !== "move";
    },
    setOrderMode(m) { setMode(m); },
    setOrders(given) {
      // Nothing selected (M7.5a, owner answer 6): the bar stays, greyed out.
      const set = given ?? noOrders();
      current = set;
      const off = set.none === true;
      for (const [m, b] of modeBtns) b.hidden = !set.modes.includes(m);
      haltBtn.hidden = !set.halt; ceaseBtn.hidden = !set.ceaseFire; postureBtn.hidden = !set.posture; rulesBtn.hidden = !set.rules;
      mountBtn.hidden = !set.mount; dismountBtn.hidden = !set.dismount;
      dischargeBtn.hidden = !set.discharge; natureBtn.hidden = !set.nature;
      for (const b of barButtons) b.disabled = off;
      moreBtn.disabled = off;
      dock.classList.toggle("greyed", off);
      if (off) { panel.hidden = true; rulesBtn.classList.remove("on"); plan.hidden = true; }
      const ns: (Nature | null)[] = [null, ...(set.natures ?? ["ap", "he", "mg"])];
      if (ns.join() !== natures.join()) { natures = ns; nature = 0; natureBtn.textContent = s.t("order.nature.auto"); cb.onNature(null); }
      fit();
      if (set.paces.join() !== paces.join()) {
        paces = [...set.paces]; pace = 0;
        paceBtn.textContent = `${s.t("order.pace")}: ${s.t(`move.${paces[0]!}`)}`;
        cb.onPace(paces[0]!);
      }
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
    dock: () => edge,
    setDock: (e) => setDock(e, true),
    setSidebarExpanded: (on) => sidebar.setExpanded(on),
    showRules: () => { if (!rulesBtn.disabled) rulesBtn.click(); },
    orderSet: () => current,
    setUnit(rules, text) {
      status.textContent = text;
      if (!rules) return;
      for (const x of ruleBtns) x.b.classList.toggle("on", rules[x.key] === x.value);
    },
  };
}
