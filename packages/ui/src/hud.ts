/**
 * HTML heads-up display over the map (M5):
 *   top bar     time, pause and speeds (orders work while paused), map, Debug
 *   order bar   at the bottom, for the selected unit: move, assault, withdraw, fire, grenade, halt, cease fire,
 *               posture, rules
 *   plan bar    while planning a move / assault / withdraw: pace for the next leg, formation, undo, Go, cancel
 *   rules panel the unit's standing rules (fire, range, on contact, ammunition) and its state
 *   radio log   the last radio messages
 * All text comes from the string table.
 */
import type { Strings } from "@tcs/data";
import type { OrderSet } from "./orders-for";

export type OrderMode = "move" | "assault" | "withdraw" | "fire" | "grenade" | "grenades" | "mortar" | "smoke";
export interface UnitRules { fire: "free" | "return" | "hold"; maxEngageM: number; onContact: "ground" | "push" | "back"; ammo: "conserve" | "normal" | "max" }

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
}

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
  /** The score line under the top bar (objectives held, M6). */
  setScore(text: string): void;
  /** Which orders and paces the bars offer for the selected unit (M7.1c: a vehicle has fewer, and its paces). */
  setOrders(set: OrderSet): void;
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
  bar.append(title, clock, ...speedBtns, saveBtn, loadBtn, mapBtn, dbgBtn);
  const score = el("div", "hud-score");
  score.hidden = true;

  // ---- order bar
  const orders = el("div", "hud-orders");
  const modeBtns = new Map<OrderMode, HTMLButtonElement>();
  const mode = (m: OrderMode, key: string) => {
    const b = el("button", "hud-btn", s.t(key));
    b.onclick = () => { setMode(m); cb.onOrderMode(m); };
    modeBtns.set(m, b);
    return b;
  };
  const setMode = (m: OrderMode) => { for (const [k, b] of modeBtns) b.classList.toggle("on", k === m); hint.textContent = s.t(m === "move" ? "plan.tapPoints" : m === "assault" || m === "withdraw" ? "plan.tapPoint" : "plan.tapTarget"); };
  const haltBtn = el("button", "hud-btn", s.t("order.halt"));
  haltBtn.onclick = () => cb.onHalt();
  const ceaseBtn = el("button", "hud-btn", s.t("app.ceaseFire"));
  ceaseBtn.onclick = () => cb.onCeaseFire();
  const postures = ["standing", "crouching", "prone"] as const;
  let posture = 0;
  const postureBtn = el("button", "hud-btn", s.t("posture.standing"));
  postureBtn.setAttribute("aria-label", s.t("app.posture"));
  postureBtn.onclick = () => {
    posture = (posture + 1) % postures.length;
    postureBtn.textContent = s.t(`posture.${postures[posture]!}`);
    cb.onPosture(postures[posture]!);
  };
  const rulesBtn = el("button", "hud-btn", s.t("order.rules"));
  orders.append(mode("move", "order.move"), mode("assault", "order.assault"), mode("withdraw", "order.withdraw"), mode("fire", "order.fire"),
    mode("grenade", "order.grenade"), mode("grenades", "order.grenades"), mode("mortar", "order.mortar"), mode("smoke", "order.smoke"), haltBtn, ceaseBtn, postureBtn, rulesBtn);

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
  rulesBtn.onclick = () => { panel.hidden = !panel.hidden; rulesBtn.classList.toggle("on", !panel.hidden); hint.hidden = true; };

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
  bottom.append(log, plan, orders);
  root.append(bar, score, hint, panel, bottom, dbg, err);
  setMode("move");
  hint.textContent = s.t("app.hint");
  // Place the hint, the panel and the debug panel just below the bar, whose height depends on wrapping (phones).
  const place = () => { const h = bar.offsetHeight; score.style.top = `${h}px`; const t = h + (score.hidden ? 8 : score.offsetHeight + 8); hint.style.top = `${t}px`; dbg.style.top = `${t}px`; panel.style.top = `${t}px`; };
  place();
  globalThis.addEventListener("resize", place);

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
    setOrders(set) {
      for (const [m, b] of modeBtns) b.hidden = !set.modes.includes(m);
      haltBtn.hidden = !set.halt; ceaseBtn.hidden = !set.ceaseFire; postureBtn.hidden = !set.posture; rulesBtn.hidden = !set.rules;
      if (set.paces.join() !== paces.join()) {
        paces = [...set.paces]; pace = 0;
        paceBtn.textContent = `${s.t("order.pace")}: ${s.t(`move.${paces[0]!}`)}`;
        cb.onPace(paces[0]!);
      }
    },
    setScore(text) { const was = score.hidden; score.textContent = text; score.hidden = text === ""; if (was !== score.hidden) place(); },
    setUnit(rules, text) {
      status.textContent = text;
      if (!rules) return;
      for (const x of ruleBtns) x.b.classList.toggle("on", rules[x.key] === x.value);
    },
  };
}
