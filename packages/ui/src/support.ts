/**
 * FIRE SUPPORT POP-UP (owner choice S11, step "fire-support"): in the Fire support mode, a press held on a point
 * (or a tap / click there) opens a small box beside it offering high explosive or smoke, each with the rounds the
 * side has left; picking one sends the existing `callFire` order for that point. The box closes itself after a
 * while, on its close button, or on Esc. Text from the string table; nothing here touches the simulation.
 */
import type { Strings } from "@tcs/data";
import { icon } from "./icons";

export type SupportAmmo = "he" | "smoke";

/** What the box offers: where (screen px), the rounds left of each kind, what a pick does. */
export interface SupportOffer {
  x: number; y: number;
  he: number; smoke: number;
  pick(ammo: SupportAmmo): void;
  /** The box went away without a pick (closed, timed out, replaced). */
  cancel?(): void;
  /** Screen margins taken by the bars and the sidebar (px): the box stays inside the rest where it fits. */
  insets?: { top: number; right: number; bottom: number; left: number };
}

export interface SupportPopup {
  el: HTMLElement;
  show(o: SupportOffer | null): void;
  shown(): boolean;
}

/** How long the box waits for a pick, ms. */
export const SUPPORT_POPUP_MS = 8000;

/** Where the box goes: beside the point (right, else left), kept inside the free map area (`insets`) where it fits,
 *  else inside the screen. */
export function popupPlace(x: number, y: number, w: number, h: number, boxW: number, boxH: number, insets = { top: 0, right: 0, bottom: 0, left: 0 }): { left: number; top: number } {
  const fitsX = w - insets.left - insets.right >= boxW + 16, fitsY = h - insets.top - insets.bottom >= boxH + 16;
  const x0 = (fitsX ? insets.left : 0) + 8, x1 = w - (fitsX ? insets.right : 0) - 8;
  const y0 = (fitsY ? insets.top : 0) + 8, y1 = h - (fitsY ? insets.bottom : 0) - 8;
  let left = x + 18, top = y - boxH / 2;
  if (left + boxW > x1) left = x - 18 - boxW;
  if (left < x0) {
    // Neither side has room: above the point (or below it), not over it.
    left = x - boxW / 2;
    top = y - 30 - boxH >= y0 ? y - 30 - boxH : y + 30;
  }
  left = Math.max(x0, Math.min(x1 - boxW, left));
  top = Math.max(y0, Math.min(y1 - boxH, top));
  return { left, top };
}

export function createSupportPopup(s: Strings): SupportPopup {
  const box = document.createElement("div");
  box.className = "hud-support";
  box.hidden = true;
  box.setAttribute("role", "dialog");
  const head = document.createElement("div");
  head.className = "hud-support-head";
  const title = document.createElement("span");
  title.textContent = s.t("support.title");
  const close = document.createElement("button");
  close.className = "hud-btn hud-support-close";
  close.textContent = "×";
  close.title = s.t("help.close");
  head.append(title, close);
  const mk = (ammo: SupportAmmo) => {
    const b = document.createElement("button");
    b.className = "hud-btn hud-support-pick";
    b.dataset["ammo"] = ammo;
    return b;
  };
  const heBtn = mk("he"), smokeBtn = mk("smoke");
  const row = document.createElement("div");
  row.className = "hud-support-row";
  row.append(heBtn, smokeBtn);
  box.append(head, row);
  let offer: SupportOffer | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const hide = (picked: boolean) => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    const o = offer;
    offer = null;
    box.hidden = true;
    if (o && !picked) o.cancel?.();
  };
  const label = (b: HTMLButtonElement, ammo: SupportAmmo, left: number) => {
    b.innerHTML = `${icon(ammo === "he" ? "mortar" : "smoke")}<span class="hud-lbl">${s.t(`support.${ammo}`)}</span><span class="hud-support-n">${s.t("support.left", { n: left })}</span>`;
    b.disabled = left <= 0;
  };
  for (const [b, ammo] of [[heBtn, "he"], [smokeBtn, "smoke"]] as const) {
    b.onclick = () => { const o = offer; hide(true); o?.pick(ammo); };
  }
  close.onclick = () => hide(false);
  // (Presses on the box never reach the map under it.)
  box.addEventListener("pointerdown", (e) => e.stopPropagation());
  return {
    el: box,
    show(o) {
      hide(false);
      if (!o) return;
      offer = o;
      label(heBtn, "he", o.he);
      label(smokeBtn, "smoke", o.smoke);
      box.hidden = false;
      const w = globalThis.innerWidth || 1000, h = globalThis.innerHeight || 800;
      const r = box.getBoundingClientRect();
      const p = popupPlace(o.x, o.y, w, h, r.width || 220, r.height || 90, o.insets);
      box.style.left = `${p.left}px`;
      box.style.top = `${p.top}px`;
      timer = setTimeout(() => hide(false), SUPPORT_POPUP_MS);
    },
    shown: () => !box.hidden,
  };
}
