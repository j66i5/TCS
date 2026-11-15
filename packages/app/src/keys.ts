/** S13: the keyboard (desktop; touch is unchanged), from the `main.ts` split (D2). Keys send what the buttons send;
 *  Esc never leaves the battle. */
import { cycleUnit, isPanKey, keyAction, panVector, PAN_PX_PER_S, unitTiles, type KeyAction } from "@tcs/ui";
import type { App } from "./app";
import { startFollow, stopFollow } from "./camera";
import { endPlan, goPlan, undoPlanPoint } from "./orders";
import { select, selectAndCentre, showCard } from "./panels";

const SPEEDS = [0, 1, 2, 4, 8];

/** Listens for keys; returns the per-frame pan (held pan keys move the map at a steady speed on screen). */
export function attachKeys(a: App): (now: number) => void {
  const hud = a.hud;
  const panKeys = new Set<string>();
  let speedBefore = 1;
  /** Esc: the innermost thing first — a menu or card, a drag, the plan, the mode, the man's box, following, the unit. */
  const escape = () => {
    if (hud.dismiss()) return;
    if (a.gesture) { a.gesture = null; return; }
    if (a.plan) { endPlan(a); a.orderMode = "move"; hud.setOrderMode("move"); return; }
    if (a.orderMode !== "move") { a.orderMode = "move"; hud.setOrderMode("move"); return; }
    if (a.inspected !== null) { a.inspected = null; showCard(a); return; }
    if (a.following !== null) { stopFollow(a); return; }
    if (a.overlay.selectedUnit !== null) select(a, null);
  };
  const doKey = (k: KeyAction) => {
    switch (k.kind) {
      case "pause": if (hud.speed() > 0) { speedBefore = hud.speed(); hud.setSpeed(0); } else hud.setSpeed(speedBefore || 1); return;
      case "speed": hud.setSpeed(SPEEDS[k.index] ?? 1); return;
      case "cancel": escape(); return;
      case "cycle": {
        const order = unitTiles(a.sim.state, a.playerSide, a.input.catalog).filter((t) => t.state !== "lost" && t.kind !== "drone" && t.kind !== "hqGroup").map((t) => t.unit);
        const next = cycleUnit(order, a.overlay.selectedUnit, k.dir);
        if (next !== null) selectAndCentre(a, next);
        return;
      }
      case "follow": { const u = a.overlay.selectedUnit; if (u !== null) { if (a.following === u) stopFollow(a); else startFollow(a, u); } return; }
      case "order": if (a.overlay.selectedUnit !== null) hud.press(k.order); return;
      case "go": if (a.plan) goPlan(a); return;
      case "undo": undoPlanPoint(a); return;
      case "contours": hud.setContours(!a.contoursOn); return;
      case "help": hud.toggleHelp(); return;
    }
  };
  const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
  window.addEventListener("keydown", (e) => {
    if (typing(e.target)) return;
    const mods = { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey };
    if (isPanKey(e.code) && !mods.ctrl && !mods.alt && !mods.meta) { panKeys.add(e.code); stopFollow(a); e.preventDefault(); return; }
    const k = keyAction(e.code, e.key, mods);
    if (!k) return;
    e.preventDefault();
    // (A button keeps the focus after a click: Space or Enter would press it again.)
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
    if (e.repeat && k.kind !== "cycle" && k.kind !== "undo") return;
    doKey(k);
  });
  window.addEventListener("keyup", (e) => { panKeys.delete(e.code); if (e.code === "Space" || e.code === "Enter") e.preventDefault(); });
  window.addEventListener("blur", () => panKeys.clear());
  let panAt = performance.now();
  return (now: number) => {
    const dt = Math.min(0.1, (now - panAt) / 1000);
    panAt = now;
    if (panKeys.size === 0) return;
    const v = panVector(panKeys);
    if (v.x === 0 && v.y === 0) return;
    stopFollow(a); // (a pan key held from before F was pressed pans too: the follow ends)
    const r = a.renderer, c = r.camera, d = (PAN_PX_PER_S * dt) / c.scale;
    r.camera = r.clampCamera({ ...c, x: c.x + v.x * d, y: c.y + v.y * d }, hud.insets());
  };
}
