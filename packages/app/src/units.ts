/** Read-only questions about the player's units, men and hulls (from the `main.ts` split, D2). */
import { airborneDroneOf, buildSpatialHash, hullObb, isOut, pointInObb, queryRadius, type EntityId, type Sim } from "@tcs/sim";
import { SIDE_COLOURS } from "@tcs/render";
import { markerGeometry, onUnitAt, type Plan } from "@tcs/ui";
import type { App, MoveOrder, Pt } from "./app";

/** Handles stay this far (on screen) from the marker's centre, so a finger can grab the marker itself. */
export const HANDLE_PX = 46;

/** All soldiers of a unit and its sub-units. */
export function unitSoldierIds(sim: Sim, unit: EntityId): EntityId[] {
  const u = sim.state.unit.get(unit);
  if (!u) return [];
  return [...u.members, ...u.children.flatMap((c) => unitSoldierIds(sim, c))];
}

/** Able men of the selected unit. */
export function unitMen(a: App): EntityId[] {
  const uid = a.overlay.selectedUnit;
  return uid === null ? [] : unitSoldierIds(a.sim, uid).filter((m) => { const s = a.sim.state.soldier.get(m); return s !== undefined && !isOut(s); });
}

/** Where the selected unit's able men are on average. */
export function unitCentre(a: App): Pt {
  const men = unitMen(a);
  if (men.length === 0) return { x: 0, y: 0 };
  let x = 0, y = 0;
  for (const m of men) { const p = a.sim.state.transform.req(m); x += p.x; y += p.y; }
  return { x: x / men.length, y: y / men.length };
}

export const slotsOf = (a: App, f: string) => a.input.catalog.formations[f]?.slots ?? [[0, 0]];

/** The vehicle class of the hull a unit crews (null: not a crew). */
export function vehicleClassOf(a: App, uid: EntityId | null): "tracked" | "wheeled" | null {
  const vid = uid === null ? undefined : a.sim.state.unit.get(uid)?.vehicle;
  const v = vid === undefined ? undefined : a.sim.state.vehicle.get(vid);
  return v ? a.input.catalog.vehicles[v.def]?.class ?? null : null;
}

/** The formation marker (a move only: an assault or withdrawal ends spread round its point). */
export function markerFor(a: App, p: Plan | null) {
  return p && p.kind === "move" ? markerGeometry(p, slotsOf(a, p.formation), Math.max(1, unitMen(a).length), a.doctrineSpacing, HANDLE_PX / a.renderer.camera.scale) : null;
}

/** A unit's men on foot and the hulls it is in or crews (alive men only). */
export function unitPlaces(a: App, uid: EntityId | null): { men: Pt[]; hulls: EntityId[] } {
  const men: Pt[] = [], hulls: EntityId[] = [];
  if (uid === null) return { men, hulls };
  const st = a.sim.state;
  const own = st.unit.get(uid)?.vehicle;
  if (own !== undefined && st.vehicle.has(own)) hulls.push(own);
  for (const m of unitSoldierIds(a.sim, uid)) {
    const s = st.soldier.get(m);
    if (!s || isOut(s)) continue;
    if (s.mount !== undefined) { if (!hulls.includes(s.mount.vehicle)) hulls.push(s.mount.vehicle); continue; }
    const t = st.transform.get(m);
    if (t) men.push({ x: t.x, y: t.y });
  }
  return { men, hulls };
}

export function placesOf(a: App, uid: EntityId | null): Pt[] {
  const { men, hulls } = unitPlaces(a, uid);
  return [...men, ...hulls.map((h) => a.sim.state.transform.get(h)).filter((t) => t !== undefined).map((t) => ({ x: t.x, y: t.y }))];
}

/** Is the world point on the selected unit (one of its men, or a hull it is in)? */
export function onSelected(a: App, w: Pt): boolean {
  const { men, hulls } = unitPlaces(a, a.overlay.selectedUnit);
  const tol = 16 / a.renderer.camera.scale + 0.8;
  if (onUnitAt(men, w.x, w.y, tol)) return true;
  for (const h of hulls) {
    const v = a.sim.state.vehicle.get(h), t = a.sim.state.transform.get(h), def = v ? a.input.catalog.vehicles[v.def] : undefined;
    if (def && t && pointInObb(hullObb(def, t.x, t.y, t.heading), w.x, w.y, tol)) return true;
  }
  return false;
}

/** The move a unit is carrying out (or that is on its way to it), if the player sent it. */
export function activeMoveOf(a: App, uid: EntityId | null): MoveOrder | null {
  if (uid === null) return null;
  const o = a.activeMoves.get(uid);
  if (!o) return null;
  const st = a.sim.state, u = st.unit.get(uid);
  const waiting = st.inbox.some((p) => p.order.target === uid && p.order.kind === "move") || st.pendingOrders.some((p) => p.order.target === uid && p.order.kind === "move");
  if (!u || (!u.moving && !waiting)) { a.activeMoves.delete(uid); return null; }
  return o;
}

/** M9.4a: the selected unit's drone is selected (its tile), not the unit. */
export function droneMode(a: App): boolean {
  const d = a.overlay.selectedDrone;
  return d !== undefined && d !== null && d === a.overlay.selectedUnit;
}

/** Where the unit's airborne drone is, or null. */
export function droneAt(a: App, uid: EntityId): Pt | null {
  const id = airborneDroneOf(a.sim.state, uid);
  return id === null ? null : a.sim.state.transform.get(id) ?? null;
}

export const inMap = (a: App, w: Pt) => w.x >= 0 && w.y >= 0 && w.x <= a.input.map.widthM && w.y <= a.input.map.heightM;

/** The crew unit of the side's vehicle whose hull (grown by `tolM`) holds the point, or null. */
export function vehicleAt(sim: Sim, x: number, y: number, tolM: number, side: string): EntityId | null {
  for (const [vid, v] of sim.state.vehicle.entries()) {
    if (v.side !== side || v.unit === null) continue;
    const def = sim.ctx.catalog.vehicles[v.def], t = sim.state.transform.get(vid);
    if (def && t && pointInObb(hullObb(def, t.x, t.y, t.heading), x, y, tolM)) return v.unit;
  }
  return null;
}

/** The units (not the crew) with men riding in the vehicle crewed by `crew`, ID order (M7.2). */
export function ridersIn(sim: Sim, crew: EntityId): EntityId[] {
  const vid = sim.state.unit.get(crew)?.vehicle;
  const v = vid === undefined ? undefined : sim.state.vehicle.get(vid);
  if (!v) return [];
  const out = new Set<EntityId>();
  for (const o of v.seats) { const u = o === null ? undefined : sim.state.identity.get(o)?.unit; if (u !== undefined && u !== crew) out.add(u); }
  return [...out].sort((a, b) => a - b);
}

export function nearestSoldier(sim: Sim, x: number, y: number, radius: number, side: string | null): EntityId | null {
  const ids = queryRadius(buildSpatialHash(sim.state), sim.state, x, y, radius);
  let best: EntityId | null = null;
  let bestD = Infinity;
  for (const id of ids) {
    if (side !== null && sim.state.identity.get(id)?.side !== side) continue;
    // Men aboard are not tapped (the hull is; tapping it again selects the units riding in it).
    if (sim.state.soldier.get(id)?.mount !== undefined) continue;
    const t = sim.state.transform.req(id);
    const d = (t.x - x) ** 2 + (t.y - y) ** 2;
    if (d < bestD) { bestD = d; best = id; }
  }
  return best;
}

/** mm:ss of game time. */
export function fmtClock(s: number): string {
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

/** Local time of day as "HH:MM" (M9.1). */
export function localClock(sec: number): string {
  const m = Math.floor((((sec % 86400) + 86400) % 86400) / 60);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** The side's colour as CSS. */
export function sideColour(a: App, side: string): string {
  const i = a.sim.state.sides.findIndex((s) => s.id === side);
  return `#${(SIDE_COLOURS[i] ?? 0xffffff).toString(16).padStart(6, "0")}`;
}

/** The side's faction name from the string table. */
export function sideName(a: App, side: string): string {
  const f = a.sim.state.sides.find((x) => x.id === side)?.faction ?? "";
  return a.strings.t(`faction.${f}`, {}, f);
}
