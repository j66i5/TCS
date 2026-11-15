/**
 * The unit sidebar (M7.5a, owner answer 8): a slim strip with one small tile per own unit — its symbol, callsign,
 * men fit and a colour for its state. A tap on a tile selects the unit (and centres the camera on it, S5); a press
 * held on a tile for `HOLD_MS` makes the camera follow the unit (S5); a tap on the strip's head opens the full
 * list with details; on a wide screen (>= 1000 px) the list is always open. `unitTiles` is pure (SimView only);
 * the strip itself is plain DOM.
 */
import type { Strings } from "@tcs/data";
import { isAble, isOut, type Catalog, type EntityId, type SimView } from "@tcs/sim";
import { unitSoldierIds } from "./orders-for";
import type { AmbulanceRow, WoundedRow } from "./wounded";

export type TileState = "ok" | "moving" | "firing" | "aboard" | "pinned" | "damaged" | "broken" | "lost";

export interface UnitTile {
  unit: EntityId;
  callsign: string;
  /** The callsign of the unit above it (null for a top-level unit). */
  parent: string | null;
  /** 0 for a top-level unit, 1 for its sub-units, ... */
  depth: number;
  /** "hq": a unit with sub-units (the whole platoon); "hqGroup" (owner 2026-11-15): that unit's own men alone, its
   *  headquarters (its own tile right under it, badged HQ; `unit` is the unit's); "vehicle": a crew with its hull;
   *  "infantry": men on foot (or riding); "drone" (M9.4a): the unit's reconnaissance quadcopter (its own tile under
   *  the headquarters; `unit` is the unit's). */
  kind: "hq" | "hqGroup" | "infantry" | "vehicle" | "drone";
  fit: number;
  total: number;
  state: TileState;
  /** Infantry (morale rework 2026-11-15): its morale 0..100 and state (`Unit.morale`). */
  morale?: number;
  moraleState?: "steady" | "shaken" | "pinned" | "broken";
  /** A vehicle: its status key (ok, immobilised, ...) and the men riding in it. */
  vehicleStatus?: string;
  passengers?: number;
  /** A drone tile: in the air, and the charge left in its battery (or the fullest one carried), percent. */
  droneUp?: boolean;
  dronePct?: number;
  /** A drone on the ground whose carrier rides: he gets out to launch it (the order makes him dismount first). */
  droneAboard?: boolean;
  /** A vehicle with the platoon headquarters aboard (owner 2026-11-15: readable as the HQ's ride). */
  hqAboard?: boolean;
}

/** Which part of a unit a tile selects: the unit (undefined), its drone, or its own men (the headquarters). */
export type TilePart = "drone" | "hq" | undefined;

export function tilePart(t: UnitTile): TilePart {
  return t.kind === "drone" ? "drone" : t.kind === "hqGroup" ? "hq" : undefined;
}

/** A drone or headquarters tile's key in the strip (its unit's id is already the unit tile's). */
export function tileKey(t: UnitTile): string {
  return t.kind === "drone" ? `d${t.unit}` : t.kind === "hqGroup" ? `h${t.unit}` : String(t.unit);
}

/** The drone tile of a unit (M9.4a): one in the air (its battery), or one carried by a man of the unit's own
 *  members (the fullest battery he has; riding or on foot); null if it has none. `depth`: the tile's own. */
export function droneTile(view: SimView, catalog: Catalog, uid: EntityId, callsign: string, depth: number): UnitTile | null {
  const u = view.unit.get(uid);
  if (!u) return null;
  for (const [did, d] of view.drone.entries()) {
    if (d.unit !== uid) continue;
    const def = catalog.items[d.item]?.drone;
    const cap = def ? catalog.items[def.battery]?.chargeCapacity ?? 0 : 0;
    const ch = view.container.get(did)?.stacks.find((st) => st.type === def?.battery)?.charge ?? 0;
    return { unit: uid, callsign, parent: callsign, depth, kind: "drone", fit: 1, total: 1, state: d.mode === "home" ? "moving" : "ok", droneUp: true, dronePct: cap > 0 ? Math.round((100 * ch) / cap) : 0 };
  }
  for (const m of u.members) {
    const box = view.container.get(m), s = view.soldier.get(m);
    const st = box?.stacks.find((x) => x.count > 0 && catalog.items[x.type]?.drone !== undefined);
    if (!st || !s || isOut(s)) continue;
    const def = catalog.items[st.type]!.drone!;
    const cap = catalog.items[def.battery]?.chargeCapacity ?? 0;
    let best = 0;
    for (const b of box!.stacks) if (b.type === def.battery && b.count > 0 && (b.charge ?? 0) > best) best = b.charge ?? 0;
    const ready = isAble(s) && best > 0, aboard = ready && s.mount !== undefined;
    return { unit: uid, callsign, parent: callsign, depth, kind: "drone", fit: isAble(s) ? 1 : 0, total: 1, state: !ready ? "lost" : aboard ? "aboard" : "ok", droneUp: false, dronePct: cap > 0 ? Math.round((100 * best) / cap) : 0, ...(aboard ? { droneAboard: true } : {}) };
  }
  return null;
}

/** Men fit, in all, pinned and aboard. */
function countMen(view: SimView, men: readonly EntityId[]): { fit: number; total: number; pinned: number; aboard: number } {
  let fit = 0, total = 0, pinned = 0, aboard = 0;
  for (const m of men) {
    const s = view.soldier.get(m);
    if (!s) continue;
    total++;
    // (Review fix: a man lying at the Verwundetennest or on his way there is not with his squad.)
    if (isOut(s) || !isAble(s) || s.atNest !== undefined || view.carry.has(m)) continue;
    fit++;
    if (s.mental.behaviour === "pinned" || s.mental.behaviour === "panicked") pinned++;
    if (s.mount !== undefined) aboard++;
  }
  return { fit, total, pinned, aboard };
}

/** A unit's morale chip after its state (morale rework 2026-11-15): " · morale 72 % shaken"; nothing for a vehicle. */
function moraleChip(s: Strings, t: UnitTile): string {
  if (t.morale === undefined || t.moraleState === undefined) return "";
  return ` · ${s.t("side.morale", { pct: t.morale })}${t.moraleState !== "steady" ? ` ${s.t(`unitMorale.${t.moraleState}`)}` : ""}`;
}

/** Is the man one of a headquarters (his unit has sub-units)? */
function isHqMan(view: SimView, m: EntityId): boolean {
  const u = view.unit.get(view.identity.get(m)?.unit ?? -1);
  return u !== undefined && u.vehicle === undefined && u.children.length > 0;
}

/** A platoon's headquarters tile (owner 2026-11-15): the unit's own men alone. */
function hqGroupTile(view: SimView, uid: EntityId, depth: number): UnitTile | null {
  const u = view.unit.get(uid);
  if (!u || u.vehicle !== undefined || u.children.length === 0 || u.members.length === 0) return null;
  const { fit, total, pinned, aboard } = countMen(view, u.members);
  const moving = u.members.some((m) => (view.mover.get(m)?.waypoints.length ?? 0) > 0 && view.soldier.get(m)?.mount === undefined);
  const firing = u.members.some((m) => view.fire.has(m));
  const state: TileState = fit === 0 ? "lost" : u.broken ? "broken" : pinned > 0 ? "pinned" : firing ? "firing" : aboard === fit ? "aboard" : moving ? "moving" : "ok";
  return { unit: uid, callsign: u.callsign, parent: u.callsign, depth: depth + 1, kind: "hqGroup", fit, total, state };
}

/** The side's units as tiles: each top-level unit followed by its sub-units (ID order, depth first); a unit with
 *  sub-units and men of its own is followed by its headquarters tile and its drone's. */
export function unitTiles(view: SimView, side: string, catalog: Catalog): UnitTile[] {
  const out: UnitTile[] = [];
  const visit = (uid: EntityId, depth: number, parent: string | null) => {
    const u = view.unit.get(uid);
    if (!u) return;
    const veh = u.vehicle !== undefined ? view.vehicle.get(u.vehicle) : undefined;
    const def = veh ? catalog.vehicles[veh.def] : undefined;
    // A vehicle: its crew (the passengers are their own units); otherwise every man of the unit and below.
    const men = veh && def ? veh.seats.filter((o, i): o is EntityId => o !== null && def.seats[i]?.station !== "passenger") : unitSoldierIds(view, uid);
    const { fit, total, pinned, aboard } = countMen(view, men);
    const wreck = veh !== undefined && (veh.status === "destroyed" || veh.status === "abandoned");
    const state: TileState = fit === 0 || wreck ? "lost"
      : u.broken ? "broken"
      : veh && veh.status !== "ok" ? "damaged"
      : pinned > 0 ? "pinned"
      : u.firing ? "firing"
      : !veh && aboard === fit ? "aboard"
      : u.moving ? "moving" : "ok";
    const tile: UnitTile = { unit: uid, callsign: u.callsign, parent, depth, kind: veh ? "vehicle" : u.children.length > 0 ? "hq" : "infantry", fit, total, state };
    if (!veh && fit > 0 && u.morale) { tile.morale = Math.round(u.morale.value * 100); tile.moraleState = u.morale.state; }
    if (veh && def) {
      tile.vehicleStatus = veh.status;
      tile.passengers = veh.seats.filter((o, i) => o !== null && def.seats[i]?.station === "passenger").length;
      if (veh.seats.some((o, i) => o !== null && def.seats[i]?.station === "passenger" && isHqMan(view, o))) tile.hqAboard = true;
    }
    out.push(tile);
    const hq = hqGroupTile(view, uid, depth);
    if (hq) out.push(hq);
    const dt = droneTile(view, catalog, uid, u.callsign, depth + (hq ? 2 : 1));
    if (dt) out.push(dt);
    for (const c of u.children) visit(c, depth + 1, u.callsign);
  };
  for (const [uid, u] of view.unit.entries()) if (u.side === side && u.parent === null && u.asset === undefined) visit(uid, 0, null); // (not an off-map asset's crew, M10.6a)
  return out;
}

/** The small map symbol of a tile as SVG (original design, like the map's overview symbols). */
export function tileSymbol(kind: UnitTile["kind"], colour: string): string {
  if (kind === "drone") {
    const arm = (x: number, y: number) => `<path d="M14 11 L${x} ${y}" stroke="${colour}" stroke-width="1.6"/><circle cx="${x}" cy="${y}" r="3.2" fill="#10140f" stroke="${colour}" stroke-width="1.4"/>`;
    return `<svg viewBox="0 0 28 22" width="28" height="22" aria-hidden="true">${arm(7, 4)}${arm(21, 4)}${arm(21, 18)}${arm(7, 18)}<rect x="11.5" y="8.5" width="5" height="5" rx="1" fill="${colour}"/></svg>`;
  }
  const frame = `<rect x="2" y="3" width="24" height="16" rx="1.5" fill="#10140f" stroke="${colour}" stroke-width="2"/>`;
  if (kind === "vehicle") return `<svg viewBox="0 0 28 22" width="28" height="22" aria-hidden="true">${frame}<rect x="7" y="7.5" width="14" height="7" rx="3.5" fill="none" stroke="${colour}" stroke-width="1.8"/></svg>`;
  const cross = `<path d="M2 3 L26 19 M26 3 L2 19" stroke="${colour}" stroke-width="1.6"/>`;
  if (kind === "hq" || kind === "hqGroup") return `<svg viewBox="0 0 28 22" width="28" height="22" aria-hidden="true">${frame}${cross}<path d="M2 3 V1 M26 3 V1 M10 1 H18" stroke="${colour}" stroke-width="1.6"/></svg>`;
  return `<svg viewBox="0 0 28 22" width="28" height="22" aria-hidden="true">${frame}${cross}</svg>`;
}

export interface Sidebar {
  readonly el: HTMLElement;
  /** `part`: the selected unit's drone tile (M9.4a) or headquarters tile (owner 2026-11-15) is selected, not the
   *  unit's. */
  update(tiles: readonly UnitTile[], selected: EntityId | null, part?: TilePart): void;
  setSide(side: "left" | "right"): void;
  /** Open or close the full list (a wide screen keeps it open). */
  setExpanded(on: boolean): void;
  isExpanded(): boolean;
  /** Width the strip takes from the map (px): the slim strip, or the open list on a wide screen. */
  width(): number;
  /** The Wounded tab (M10.5, owner Q-2c): the player's wounded, T1 first; M10.6a: his ambulances on a run, and
   *  how many still wait to be called (a "Call ambulance" button while any do). */
  setWounded(rows: readonly WoundedRow[], amb?: { rows: readonly AmbulanceRow[]; ready: number; caller?: string }): void;
  /** The tab shown in the open list. */
  tab(): "units" | "wounded";
}

/** The Wounded tab's actions (M10.5): a row tapped (his unit selected, his box opened), "Back" tapped (evacuate). */
export interface WoundedActions {
  onMan(man: EntityId): void;
  onEvacuate(man: EntityId): void;
  /** M10.6a: "Call ambulance" tapped. */
  onCallAmbulance?(): void;
}

/** The triage tag colours of the map (render's TRIAGE_COLOURS), for the list. */
const TAG_CSS = ["#ff4a3d", "#ffd23d", "#8fd36a"] as const;

/** A small red cross on white (the Wounded tab's button). */
export function redCross(px = 18): string {
  return `<svg viewBox="0 0 20 20" width="${px}" height="${px}" aria-hidden="true"><rect x="1" y="1" width="18" height="18" rx="3" fill="#f4f1ea" stroke="#14110f" stroke-width="1.5"/><path d="M8 4h4v4h4v4h-4v4H8v-4H4V8h4z" fill="#d22a22"/></svg>`;
}

export const WIDE_SCREEN_PX = 1000;
/** The slim strip's width (56 px tiles and a margin; matches style.css). */
export const SLIM_PX = 64;

/** D3: the gap kept between the open list's foot and the unit card's top on a narrow screen. */
export const SIDE_CARD_GAP_PX = 6;

/** D3: the open list's height on a narrow screen with the card showing: from its top down to above the card. */
export function sideListMaxPx(top: number, cardTop: number): number {
  return Math.max(80, cardTop - SIDE_CARD_GAP_PX - top);
}

/** S5: a press held this long on a tile follows the unit. */
export const HOLD_MS = 450;

export function createSidebar(s: Strings, colour: string, onSelect: (unit: EntityId, part?: TilePart) => void, onResize: () => void, onHold?: (unit: EntityId) => void, wounded?: WoundedActions): Sidebar {
  const root = document.createElement("div");
  root.className = "hud-side side-left";
  const head = document.createElement("button");
  head.className = "hud-side-head";
  head.setAttribute("aria-label", s.t("side.units"));
  const list = document.createElement("div");
  list.className = "hud-side-list";
  // M10.5 (owner Q-2c): the Wounded tab. Open list: two tabs; slim strip: a red-cross button with the count.
  const tabs = document.createElement("div");
  tabs.className = "hud-side-tabs";
  const tabUnits = document.createElement("button"), tabWounded = document.createElement("button");
  tabUnits.className = "hud-side-tab"; tabWounded.className = "hud-side-tab";
  tabs.append(tabUnits, tabWounded);
  const slimWounded = document.createElement("button");
  slimWounded.className = "hud-side-wounded";
  slimWounded.setAttribute("aria-label", s.t("side.wounded"));
  const wlist = document.createElement("div");
  wlist.className = "hud-side-list hud-wounded-list";
  root.append(head, tabs, slimWounded, list, wlist);
  let expanded = false, tab: "units" | "wounded" = "units", nWounded = 0, slimShow = false, wkey = "";
  const wide = () => globalThis.innerWidth >= WIDE_SCREEN_PX;
  const applyTab = () => {
    root.classList.toggle("tab-wounded", tab === "wounded");
    tabUnits.classList.toggle("on", tab === "units"); tabWounded.classList.toggle("on", tab === "wounded");
    tabUnits.textContent = s.t("side.unitsOpen");
    tabWounded.innerHTML = `${redCross(14)} ${s.t("side.woundedN", { n: nWounded })}`;
    slimWounded.innerHTML = `${redCross(18)}<span>${nWounded}</span>`;
    // (Review fix: also while ambulances are on a run or men are listed as evacuated, so their status and the call
    // button stay one tap away.)
    slimWounded.style.display = nWounded > 0 || slimShow ? "" : "none";
  };
  const applyExpanded = () => {
    const on = expanded || wide();
    root.classList.toggle("expanded", on);
    // (Review fix: open on a phone the head closes the list, and says so.)
    head.textContent = on ? (wide() ? s.t("side.unitsOpen") : s.t("side.close")) : s.t("side.unitsShort");
    head.setAttribute("aria-label", on && !wide() ? s.t("side.closeTitle") : s.t("side.units"));
    if (!on) tab = "units";
    applyTab();
  };
  head.onclick = () => { if (!wide()) { expanded = !expanded; applyExpanded(); onResize(); } };
  tabUnits.onclick = () => { tab = "units"; applyTab(); };
  tabWounded.onclick = () => { tab = "wounded"; applyTab(); };
  slimWounded.onclick = () => { tab = "wounded"; if (!wide()) { expanded = true; } applyExpanded(); tab = "wounded"; applyTab(); onResize(); };
  applyExpanded();
  globalThis.addEventListener("resize", applyExpanded);
  const els = new Map<string, { b: HTMLButtonElement; key: string }>();
  /** Review fix: more rows below the bottom edge fade out there (the list scrolls). */
  const markMore = () => { list.classList.toggle("more", list.scrollHeight - list.scrollTop - list.clientHeight > 4); };
  list.addEventListener("scroll", markMore, { passive: true });
  return {
    el: root,
    update(tiles, selected, part) {
      const keep = new Set<string>();
      tiles.forEach((t, i) => {
        const tk = tileKey(t), isDrone = t.kind === "drone", tp = tilePart(t);
        keep.add(tk);
        let e = els.get(tk);
        if (!e) {
          const b = document.createElement("button");
          b.className = "hud-tile";
          b.dataset["unit"] = String(t.unit);
          if (isDrone) b.dataset["drone"] = "1";
          if (tp === "hq") b.dataset["hq"] = "1";
          // A press held HOLD_MS follows the unit (the click that ends it is then not a select); moving away
          // (scrolling the list) or letting go sooner leaves it a tap.
          let timer: ReturnType<typeof setTimeout> | null = null, held = false, at: { x: number; y: number } | null = null;
          const stop = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };
          b.addEventListener("pointerdown", (ev) => {
            held = false; at = { x: ev.clientX, y: ev.clientY }; stop();
            if (onHold && !isDrone) timer = setTimeout(() => { timer = null; held = true; onHold(t.unit); }, HOLD_MS);
          });
          b.addEventListener("pointermove", (ev) => { if (at && Math.hypot(ev.clientX - at.x, ev.clientY - at.y) > 10) stop(); });
          b.addEventListener("pointerup", stop);
          b.addEventListener("pointercancel", stop);
          b.addEventListener("pointerleave", stop);
          b.addEventListener("contextmenu", (ev) => ev.preventDefault());
          // (D3: on a narrow screen the open list lies over the card; picking a unit from it closes it.)
          b.onclick = () => {
            if (held) { held = false; return; }
            onSelect(t.unit, tp);
            if (expanded && !wide() && tab === "units") { expanded = false; applyExpanded(); onResize(); }
          };
          e = { b, key: "" };
          els.set(tk, e);
        }
        const detail = isDrone ? s.t(t.droneUp ? "side.droneUp" : t.droneAboard ? "side.droneAboard" : "side.droneReady", { pct: t.dronePct ?? 0 })
          : t.kind === "vehicle"
          ? `${s.t(`vehicle.status.${t.vehicleStatus ?? "ok"}`)}${(t.passengers ?? 0) > 0 ? ` · ${s.t("side.riding", { n: t.passengers ?? 0 })}` : ""}${t.hqAboard ? ` · ${s.t("side.hqAboard")}` : ""}`
          : t.kind === "hq" ? `${s.t("side.platoonAll")} · ${s.t(`side.state.${t.state}`)}${moraleChip(s, t)}`
          : `${s.t(`side.state.${t.state}`)}${moraleChip(s, t)}`;
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
          name.textContent = isDrone ? s.t("side.drone") : t.callsign;
          // (Owner 2026-11-15: the headquarters reads as HQ, on the strip and in the list.)
          // (On the slim strip the badge alone: the platoon's callsign is on the tile above.)
          if (tp === "hq") {
            const badge = document.createElement("span"), call = document.createElement("span");
            badge.className = "hud-badge hud-tile-badge"; badge.textContent = s.t("side.hq");
            call.className = "hud-tile-call"; call.textContent = t.callsign;
            name.textContent = ""; name.append(badge, call);
          }
          const men = document.createElement("span");
          men.className = "hud-tile-men";
          men.textContent = isDrone ? `${t.dronePct ?? 0} %` : s.t("side.men", { fit: t.fit, total: t.total });
          const det = document.createElement("span");
          det.className = "hud-tile-detail";
          det.textContent = detail;
          e.b.append(sym, name, men, det);
          e.b.title = `${t.parent ? `${t.parent} · ` : ""}${t.callsign}: ${detail}`;
        }
        e.b.classList.toggle("selected", selected === t.unit && part === tp);
        if (list.children[i] !== e.b) list.insertBefore(e.b, list.children[i] ?? null);
      });
      for (const [k, e] of els) if (!keep.has(k)) { e.b.remove(); els.delete(k); }
      markMore();
    },
    setWounded(rows, amb) {
      nWounded = rows.filter((r) => r.status !== "evacuated").length;
      slimShow = rows.length > 0 || (amb?.rows.length ?? 0) > 0;
      const key = rows.map((r) => `${r.id}:${r.tag}:${r.status}:${r.ordered}:${r.callsign}`).join("|") + "#" + (amb ? `${amb.ready}:${amb.caller ?? ""}:${amb.rows.map((r) => `${r.kind ?? "a"}${r.id}:${r.phase}:${Math.ceil(r.dueS / 60)}:${r.aboard}`).join(",")}` : "");
      if (key !== wkey) {
        wkey = key;
        wlist.innerHTML = "";
        // Ambulances (M10.6a): a line per run, then the call button while any wait.
        for (const r of amb?.rows ?? []) {
          const e = document.createElement("div");
          e.className = `hud-ambulance ph-${r.phase}`;
          e.textContent = s.t(r.kind === "rearRun" ? `rearRun.${r.phase}` : `ambulance.${r.phase}`, { callsign: r.callsign, min: Math.max(1, Math.ceil(r.dueS / 60)), n: r.aboard });
          wlist.append(e);
        }
        if (amb && amb.ready > 0 && wounded?.onCallAmbulance) {
          const b = document.createElement("button");
          b.className = "hud-ambulance-call";
          // (Review fix: the platoon it is called for is named.)
          b.textContent = amb.caller ? s.t("ambulance.callFor", { n: amb.ready, callsign: amb.caller }) : s.t("ambulance.call", { n: amb.ready });
          b.title = amb.caller ? s.t("ambulance.callTitleFor", { callsign: amb.caller }) : s.t("ambulance.callTitle");
          b.onclick = () => wounded.onCallAmbulance?.();
          wlist.append(b);
        }
        if (rows.length === 0) { const e = document.createElement("div"); e.className = "hud-wounded-none"; e.textContent = s.t("side.woundedNone"); wlist.append(e); }
        // (Review fix: what the tags mean, on a phone too; the evacuated men last, under their own heading.)
        if (rows.length > 0) { const e = document.createElement("div"); e.className = "hud-wounded-legend"; e.textContent = s.t("wounded.legend"); wlist.append(e); }
        const here = rows.filter((r) => r.status !== "evacuated"), gone = rows.filter((r) => r.status === "evacuated");
        for (const r of [...here, ...gone]) {
          if (r === gone[0]) { const h = document.createElement("div"); h.className = "hud-wounded-group"; h.textContent = s.t("wounded.evacuatedN", { n: gone.length }); wlist.append(h); }
          const row = document.createElement("div");
          row.className = `hud-wounded st-${r.status}`;
          row.dataset["man"] = String(r.id);
          const tag = document.createElement("span");
          tag.className = "hud-wounded-tag";
          tag.textContent = r.tag === null ? "–" : `T${r.tag}`;
          tag.title = s.t(r.tag === null ? "wounded.tagNone" : `wounded.tag${r.tag}`);
          if (r.tag !== null) tag.style.background = TAG_CSS[r.tag - 1]!;
          const who = document.createElement("button");
          who.className = "hud-wounded-who";
          const nm = document.createElement("span"); nm.className = "hud-wounded-name"; nm.textContent = `${r.name} · ${r.callsign}`;
          const st = document.createElement("span"); st.className = "hud-wounded-status"; st.textContent = s.t(r.status === "fighting" && r.tag === 1 ? "wounded.status.fightingUrgent" : `wounded.status.${r.status}`) + (r.ordered ? ` · ${s.t("wounded.ordered")}` : "");
          who.append(nm, st);
          // (Review fix: on a phone the list closes, so the man box is not drawn over it.)
          who.onclick = () => { if (!wide() && expanded) { expanded = false; applyExpanded(); onResize(); } wounded?.onMan(r.id); };
          row.append(tag, who);
          if (r.canEvacuate && wounded) {
            const back = document.createElement("button");
            back.className = "hud-wounded-back";
            back.textContent = s.t("wounded.back");
            back.title = s.t("wounded.backTitle");
            back.onclick = () => wounded.onEvacuate(r.id);
            row.append(back);
          }
          wlist.append(row);
        }
      }
      applyTab();
    },
    tab: () => tab,
    setSide(side) { root.classList.toggle("side-left", side === "left"); root.classList.toggle("side-right", side === "right"); },
    setExpanded(on) { expanded = on; applyExpanded(); onResize(); },
    isExpanded: () => expanded || wide(),
    width: () => (wide() ? root.offsetWidth : Math.min(root.offsetWidth, SLIM_PX)),
  };
}
