/**
 * AFTER-ACTION REVIEW (M6, owner decision 2026-11-12): the result and why, each side's casualty list, a
 * timeline of what happened, and a button for the heat map on the battlefield. The app builds the content
 * (all text from the string table) from the battle's events and result; this only lays it out.
 */
import type { Strings } from "@tcs/data";

export interface AarModel {
  title: string;
  /** The result in a sentence or two, then one line per side's score. */
  summary: string[];
  casualties: { heading: string; colour: string; rows: string[] }[];
  timeline: { time: string; text: string; colour: string }[];
}

export interface Aar { show(m: AarModel): void; hide(): void; visible(): boolean }

export function createAar(root: HTMLElement, s: Strings, cb: { onHeat(on: boolean): void; onClose(): void }): Aar {
  const box = document.createElement("div");
  box.className = "hud-aar";
  box.hidden = true;
  root.append(box);
  let heat = false;
  const el = (tag: string, cls: string, text = "") => { const e = document.createElement(tag); e.className = cls; if (text) e.textContent = text; return e; };
  return {
    show(m) {
      box.replaceChildren();
      box.append(el("div", "hud-aar-title", m.title));
      for (const line of m.summary) box.append(el("div", "hud-aar-line", line));
      const btns = el("div", "hud-row");
      const heatBtn = el("button", "hud-btn", s.t("aar.heat")) as HTMLButtonElement;
      heatBtn.onclick = () => { heat = !heat; heatBtn.classList.toggle("on", heat); cb.onHeat(heat); box.classList.toggle("hud-aar-small", heat); };
      const close = el("button", "hud-btn", s.t("aar.close")) as HTMLButtonElement;
      close.onclick = () => { box.hidden = true; cb.onClose(); };
      btns.append(heatBtn, close);
      box.append(btns);
      const body = el("div", "hud-aar-body");
      const cas = el("div", "hud-aar-col");
      cas.append(el("div", "hud-aar-head", s.t("aar.casualties")));
      for (const side of m.casualties) {
        const h = el("div", "hud-aar-sub", side.heading);
        h.style.color = side.colour;
        cas.append(h);
        for (const r of side.rows) cas.append(el("div", "hud-aar-row", r));
      }
      const tl = el("div", "hud-aar-col");
      tl.append(el("div", "hud-aar-head", s.t("aar.timeline")));
      for (const t of m.timeline) {
        const row = el("div", "hud-aar-row");
        const time = el("span", "hud-radio-time", `${t.time} `);
        const txt = el("span", "", t.text);
        txt.style.color = t.colour;
        row.append(time, txt);
        tl.append(row);
      }
      body.append(cas, tl);
      box.append(body);
      box.hidden = false;
    },
    hide() { box.hidden = true; },
    visible: () => !box.hidden,
  };
}
