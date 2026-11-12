/**
 * The unit sidebar (M7.5a, owner answer 8): a slim strip with one small tile per own unit — its symbol, callsign,
 * men fit and a colour for its state. A tap on a tile selects the unit; a tap on the strip's head opens the full
 * list with details; on a wide screen (>= 1000 px) the list is always open. `unitTiles` is pure (SimView only);
 * the strip itself is plain DOM.
 */
import type { Strings } from "@tcs/data";
import { isAble, isOut, type Catalog, type EntityId, type SimView } from "@tcs/sim";
import { unitSoldierIds } from "./orders-for";

export type TileState = "ok" | "moving" | "firing" | "aboard" | "pinned" | "damaged" | "broken" | "lost";

export interface UnitTile {
  unit: EntityId;
  callsign: string;
  /** The callsign of the unit above it (null for a top-level unit). */
  parent: string | null;
  /** 0 for a top-level unit, 1 for its sub-units, ... */
  depth: number;
  /** "hq": a unit with sub-units; "vehicle": a crew with its hull; "infantry": men on foot (or riding). */
  kind: "hq" | "infantry" | "vehicle";
  fit: number;
  total: number;
  state: TileState;
  /** A vehicle: its status key (ok, immobilised, ...) and the men riding in it. */
  vehicleStatus?: string;
  passengers?: number;
}

/** The side's units as tiles: each top-level unit followed by its sub-units (ID order, depth first). */
export function unitTiles(view: SimView, side: string, catalog: Catalog): UnitTile[] {
  const out: UnitTile[] = [];
  const visit = (uid: EntityId, depth: number, parent: string | null) => {
    const u = view.unit.get(uid);
    if (!u) return;
    const veh = u.vehicle !== undefined ? view.vehicle.get(u.vehicle) : undefined;
    const def = veh ? catalog.vehicles[veh.def] : undefined;
    let fit = 0, total = 0, pinned = 0, aboard = 0;
    // A vehicle: its crew (the passengers are their own units); otherwise every man of the unit and below.
    const men = veh && def ? veh.seats.filter((o, i): o is EntityId => o !== null && def.seats[i]?.station !== "passenger") : unitSoldierIds(view, uid);
    for (const m of men) {
      const s = view.soldier.get(m);
      if (!s) continue;
      total++;
      if (isOut(s) || !isAble(s)) continue;
      fit++;
      if (s.mental.behaviour === "pinned" || s.mental.behaviour === "panicked") pinned++;
      if (s.mount !== undefined) aboard++;
    }
    const wreck = veh !== undefined && (veh.status === "destroyed" || veh.status === "abandoned");
    const state: TileState = fit === 0 || wreck ? "lost"
      : u.broken ? "broken"
      : veh && veh.status !== "ok" ? "damaged"
      : pinned > 0 ? "pinned"
      : u.firing ? "firing"
      : !veh && aboard === fit ? "aboard"
      : u.moving ? "moving" : "ok";
    const tile: UnitTile = { unit: uid, callsign: u.callsign, parent, depth, kind: veh ? "vehicle" : u.children.length > 0 ? "hq" : "infantry", fit, total, state };
    if (veh && def) { tile.vehicleStatus = veh.status; tile.passengers = veh.seats.filter((o, i) => o !== null && def.seats[i]?.station === "passenger").length; }
    out.push(tile);
    for (const c of u.children) visit(c, depth + 1, u.callsign);
  };
  for (const [uid, u] of view.unit.entries()) if (u.side === side && u.parent === null) visit(uid, 0, null);
  return out;
}

/** The small map symbol of a tile as SVG (original design, like the map's overview symbols). */
export function tileSymbol(kind: UnitTile["kind"], colour: string): string {
  const frame = `<rect x="2" y="3" width="24" height="16" rx="1.5" fill="#10140f" stroke="${colour}" stroke-width="2"/>`;
  if (kind === "vehicle") return `<svg viewBox="0 0 28 22" width="28" height="22" aria-hidden="true">${frame}<rect x="7" y="7.5" width="14" height="7" rx="3.5" fill="none" stroke="${colour}" stroke-width="1.8"/></svg>`;
  const cross = `<path d="M2 3 L26 19 M26 3 L2 19" stroke="${colour}" stroke-width="1.6"/>`;
  if (kind === "hq") return `<svg viewBox="0 0 28 22" width="28" height="22" aria-hidden="true">${frame}${cross}<path d="M2 3 V1 M26 3 V1 M10 1 H18" stroke="${colour}" stroke-width="1.6"/></svg>`;
  return `<svg viewBox="0 0 28 22" width="28" height="22" aria-hidden="true">${frame}${cross}</svg>`;
}

export interface Sidebar {
  readonly el: HTMLElement;
  update(tiles: readonly UnitTile[], selected: EntityId | null): void;
  setSide(side: "left" | "right"): void;
  /** Open or close the full list (a wide screen keeps it open). */
  setExpanded(on: boolean): void;
  isExpanded(): boolean;
  /** Width the strip takes from the map (px): the slim strip, or the open list on a wide screen. */
  width(): number;
}

export const WIDE_SCREEN_PX = 1000;
/** The slim strip's width (56 px tiles and a margin; matches style.css). */
export const SLIM_PX = 64;

export function createSidebar(s: Strings, colour: string, onSelect: (unit: EntityId) => void, onResize: () => void): Sidebar {
  const root = document.createElement("div");
  root.className = "hud-side side-left";
  const head = document.createElement("button");
  head.className = "hud-side-head";
  head.setAttribute("aria-label", s.t("side.units"));
  const list = document.createElement("div");
  list.className = "hud-side-list";
  root.append(head, list);
  let expanded = false;
  const wide = () => globalThis.innerWidth >= WIDE_SCREEN_PX;
  const applyExpanded = () => {
    const on = expanded || wide();
    root.classList.toggle("expanded", on);
    head.textContent = on ? s.t("side.unitsOpen") : s.t("side.unitsShort");
  };
  head.onclick = () => { if (!wide()) { expanded = !expanded; applyExpanded(); onResize(); } };
  applyExpanded();
  globalThis.addEventListener("resize", applyExpanded);
  const els = new Map<EntityId, { b: HTMLButtonElement; key: string }>();
  return {
    el: root,
    update(tiles, selected) {
      const keep = new Set<EntityId>();
      tiles.forEach((t, i) => {
        keep.add(t.unit);
        let e = els.get(t.unit);
        if (!e) {
          const b = document.createElement("button");
          b.className = "hud-tile";
          b.dataset["unit"] = String(t.unit);
          b.onclick = () => onSelect(t.unit);
          e = { b, key: "" };
          els.set(t.unit, e);
        }
        const detail = t.kind === "vehicle"
          ? `${s.t(`vehicle.status.${t.vehicleStatus ?? "ok"}`)}${(t.passengers ?? 0) > 0 ? ` · ${s.t("side.riding", { n: t.passengers ?? 0 })}` : ""}`
          : s.t(`side.state.${t.state}`);
        const key = `${t.callsign}|${t.fit}|${t.total}|${t.state}|${detail}|${t.parent}`;
        if (e.key !== key) {
          e.key = key;
          e.b.className = `hud-tile st-${t.state} depth-${Math.min(2, t.depth)} kind-${t.kind}`;
          e.b.innerHTML = "";
          const sym = document.createElement("span");
          sym.className = "hud-tile-sym";
          sym.innerHTML = tileSymbol(t.kind, colour);
          const name = document.createElement("span");
          name.className = "hud-tile-name";
          name.textContent = t.callsign;
          const men = document.createElement("span");
          men.className = "hud-tile-men";
          men.textContent = s.t("side.men", { fit: t.fit, total: t.total });
          const det = document.createElement("span");
          det.className = "hud-tile-detail";
          det.textContent = detail;
          e.b.append(sym, name, men, det);
          e.b.title = `${t.parent ? `${t.parent} · ` : ""}${t.callsign}: ${detail}`;
        }
        e.b.classList.toggle("selected", selected === t.unit);
        if (list.children[i] !== e.b) list.insertBefore(e.b, list.children[i] ?? null);
      });
      for (const [u, e] of els) if (!keep.has(u)) { e.b.remove(); els.delete(u); }
    },
    setSide(side) { root.classList.toggle("side-left", side === "left"); root.classList.toggle("side-right", side === "right"); },
    setExpanded(on) { expanded = on; applyExpanded(); onResize(); },
    isExpanded: () => expanded || wide(),
    width: () => (wide() ? root.offsetWidth : Math.min(root.offsetWidth, SLIM_PX)),
  };
}
