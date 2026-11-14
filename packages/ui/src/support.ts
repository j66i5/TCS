/**
 * FIRE SUPPORT POP-UP (owner choice S11, step "fire-support"; M8.6): in the Fire support mode, a press held on a point
 * (or a tap / click there) opens a box beside it; a press dragged into a line offers a smoke screen along it. The box
 * has one row per fire support asset the side has (its mortars — on the map or off it — and its artillery): high
 * explosive, airburst (where the asset has the fuse), smoke (a screen on a line) and illumination (greyed in daylight:
 * the light comes with night, M9), each with the rounds left, and about how long until fire for effect. A point within
 * the asset's danger-close distance of own men is marked; a pick there calls it danger close. Picking sends the
 * existing `callFire` order. The box closes itself after a while, on its close button, or on Esc. Text from the string
 * table; nothing here touches the simulation.
 */
import type { Strings } from "@tcs/data";
import { icon } from "./icons";

export type SupportAmmo = "he" | "smoke" | "illum";
export type SupportAsset = "mortar" | "artillery";

/** One asset's row (from the sim's `fireOptions`). */
export interface SupportAssetOffer {
  asset: SupportAsset; onMap: boolean; he: number; smoke: number; illum: number; etaS: number;
  dangerClose: boolean; airburst: boolean; inRange: boolean; moving: boolean;
}

/** What the box offers: where (screen px), each asset's row, a line (a screen) or a point, night, what a pick does. */
export interface SupportOffer {
  x: number; y: number;
  assets: SupportAssetOffer[];
  /** A smoke screen along a dragged line: only smoke is offered. */
  line?: boolean;
  /** Dark enough for illumination to light anything (it is greyed in daylight). */
  night?: boolean;
  pick(asset: SupportAsset, ammo: SupportAmmo, opts: { airburst?: boolean; dangerClose?: boolean }): void;
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
export const SUPPORT_POPUP_MS = 10000;

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

/** The buttons of one asset's row: [ammo, airburst, icon, label key, rounds]. */
export function rowButtons(a: SupportAssetOffer, line: boolean): { ammo: SupportAmmo; airburst: boolean; icon: string; key: string; n: number }[] {
  if (line) return [{ ammo: "smoke", airburst: false, icon: "screen", key: "support.screen", n: a.smoke }];
  const out: { ammo: SupportAmmo; airburst: boolean; icon: string; key: string; n: number }[] = [{ ammo: "he", airburst: false, icon: "mortar", key: "support.he", n: a.he }];
  if (a.airburst) out.push({ ammo: "he", airburst: true, icon: "airburst", key: "support.airburst", n: a.he });
  out.push({ ammo: "smoke", airburst: false, icon: "smoke", key: "support.smoke", n: a.smoke });
  out.push({ ammo: "illum", airburst: false, icon: "flare", key: "support.illum", n: a.illum });
  return out;
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
  const rows = document.createElement("div");
  rows.className = "hud-support-rows";
  box.append(head, rows);
  let offer: SupportOffer | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const hide = (picked: boolean) => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    const o = offer;
    offer = null;
    box.hidden = true;
    if (o && !picked) o.cancel?.();
  };
  close.onclick = () => hide(false);
  // (Presses on the box never reach the map under it.)
  box.addEventListener("pointerdown", (e) => e.stopPropagation());
  const build = (o: SupportOffer) => {
    title.textContent = s.t(o.line ? "support.titleLine" : "support.title");
    rows.replaceChildren();
    if (o.assets.length === 0) {
      const none = document.createElement("div");
      none.className = "hud-support-note";
      none.textContent = s.t("support.none");
      rows.append(none);
    }
    for (const a of o.assets) {
      const row = document.createElement("div");
      row.className = "hud-support-asset";
      row.dataset["asset"] = a.asset;
      const lab = document.createElement("div");
      lab.className = "hud-support-label";
      const name = s.t(a.asset === "artillery" ? "support.artillery" : a.onMap ? "support.mortarOnMap" : "support.mortar");
      const state = !a.inRange ? s.t("support.outOfRange") : a.moving ? s.t("support.moving") : s.t("support.eta", { s: a.etaS });
      lab.innerHTML = `<span>${name}</span><span class="hud-support-eta">${state}</span>`;
      if (a.dangerClose && a.inRange) {
        const dc = document.createElement("span");
        dc.className = "hud-support-danger";
        dc.textContent = s.t("support.dangerClose");
        lab.append(dc);
      }
      const btns = document.createElement("div");
      btns.className = "hud-support-row";
      for (const b of rowButtons(a, o.line === true)) {
        const el = document.createElement("button");
        el.className = "hud-btn hud-support-pick" + (a.dangerClose ? " danger" : "");
        el.dataset["ammo"] = b.ammo;
        el.dataset["asset"] = a.asset;
        if (b.airburst) el.dataset["fuse"] = "airburst";
        const greyNight = b.ammo === "illum" && !o.night;
        el.innerHTML = `${icon(b.icon)}<span class="hud-lbl">${s.t(b.key)}</span><span class="hud-support-n">${greyNight ? s.t("support.nightOnly") : s.t("support.left", { n: b.n })}</span>`;
        el.disabled = b.n <= 0 || !a.inRange || a.moving || greyNight;
        el.onclick = () => { const of = offer; hide(true); of?.pick(a.asset, b.ammo, { ...(b.airburst ? { airburst: true } : {}), ...(a.dangerClose ? { dangerClose: true } : {}) }); };
        btns.append(el);
      }
      row.append(lab, btns);
      rows.append(row);
    }
  };
  return {
    el: box,
    show(o) {
      hide(false);
      if (!o) return;
      offer = o;
      build(o);
      box.hidden = false;
      const w = globalThis.innerWidth || 1000, h = globalThis.innerHeight || 800;
      const r = box.getBoundingClientRect();
      const p = popupPlace(o.x, o.y, w, h, r.width || 260, r.height || 120, o.insets);
      box.style.left = `${p.left}px`;
      box.style.top = `${p.top}px`;
      timer = setTimeout(() => hide(false), SUPPORT_POPUP_MS);
    },
    shown: () => !box.hidden,
  };
}
