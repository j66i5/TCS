/**
 * HTML heads-up display over the map: top bar (time, pause/speed, walk/run, debug), radio log,
 * debug counters. All text comes from the string table.
 */
import type { Strings } from "@tcs/data";

export interface HudCallbacks {
  onSpeed(speed: number): void; // 0 = paused
  onMoveMode(mode: string): void;
  onDebug(on: boolean): void;
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
  const bar = el("div", "hud-bar");
  const title = el("div", "hud-title", s.t("app.title"));
  const clock = el("div", "hud-clock", "00:00");
  const speeds: [string, number][] = [["❚❚", 0], ["1×", 1], ["4×", 4]];
  const speedBtns = speeds.map(([label, v]) => {
    const b = el("button", "hud-btn", label);
    b.setAttribute("aria-label", v === 0 ? s.t("app.pause") : `${s.t("app.speed")} ${v}`);
    b.onclick = () => { cb.onSpeed(v); speedBtns.forEach((x) => x.classList.toggle("on", x === b)); };
    return b;
  });
  speedBtns[1]!.classList.add("on");
  let mode = "walk";
  const modeBtn = el("button", "hud-btn", s.t("move.walk"));
  modeBtn.onclick = () => {
    mode = mode === "walk" ? "run" : "walk";
    modeBtn.textContent = s.t(`move.${mode}`);
    modeBtn.classList.toggle("on", mode === "run");
    cb.onMoveMode(mode);
  };
  let debug = false;
  const dbgBtn = el("button", "hud-btn", s.t("app.debug"));
  bar.append(title, clock, ...speedBtns, modeBtn, dbgBtn);

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
  root.append(bar, hint, log, dbg, err);

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
      while (log.childElementCount > 5) log.lastElementChild?.remove();
      hint.hidden = true;
    },
    showError(text) {
      err.hidden = false;
      err.textContent = text;
    },
  };
}
