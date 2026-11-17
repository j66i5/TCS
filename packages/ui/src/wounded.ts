/**
 * THE WOUNDED LIST AND THE NEST MARKER (M10.5, owner Q-2c: a sidebar tab; owner answer 4: the player may order a
 * casualty's evacuation and move the Verwundetennest). Pure functions of the read-only view: `woundedRows` lists the
 * player's own wounded (enemy casualties never, owner Q-2d), T1 first; `nestMarkers` the side's Verwundetennester
 * with how many men lie at each. The sidebar draws the rows; the renderer draws the markers; the app turns a tap on
 * "Back" into an `evacuate` order and a dragged marker into a `casualtyPoint` order.
 */
import { shownCallsigns } from "@tcs/render";
import { TICK_HZ, type EntityId, type SimView } from "@tcs/sim";

export type WoundedStatus = "nest" | "carried" | "walking" | "treated" | "aboard" | "waiting" | "fighting" | "evacuated";

export interface WoundedRow {
  id: EntityId;
  /** His family name and his unit's callsign. */
  name: string;
  callsign: string;
  /** His triage tag (1-3), or null if nobody has tagged him yet. */
  tag: 1 | 2 | 3 | null;
  status: WoundedStatus;
  /** The player ordered him back (on his way or waiting for bearers). */
  ordered: boolean;
  /** "Back" can be offered: alive, not at the nest, not aboard, not on his way already. */
  canEvacuate: boolean;
}

/** The order the rows come in: T1, T2, T3, untagged; then by id. */
const tagRank = (t: WoundedRow["tag"]) => (t === null ? 4 : t);

/** The player's own living, uncaptured wounded men (owner Q-2c), T1 first. */
export function woundedRows(view: SimView, side: string): WoundedRow[] {
  const treated = new Set<EntityId>();
  for (const [, a] of view.action.entries()) if (a.kind === "treat") treated.add(Number(a.params["casualty"]));
  const out: WoundedRow[] = [];
  // (Review fix: "2/Trupp 1", as on the card, where two platoons have a "Trupp 1".)
  const names = shownCallsigns(view.unit.entries());
  for (const [id, s] of view.soldier.entries()) {
    if (s.wounds.length === 0 || !s.physiology.alive || s.captive !== null) continue;
    if (s.wounds.every((w) => w.mechanism === "blunt")) continue; // (a bruise under the vest is no wound to list)
    const ident = view.identity.get(id);
    if (!ident || ident.side !== side) continue;
    const party = view.carry.get(id);
    const status: WoundedStatus = s.evacuated !== undefined ? "evacuated"
      : s.atNest !== undefined ? "nest"
      : s.mount !== undefined ? "aboard"
      : party ? (party.carriers.length === 0 ? "walking" : "carried")
      : treated.has(id) ? "treated"
      : s.casualty === "incapacitated" || !s.impair.canWalk || !s.impair.canFight ? "waiting" : "fighting";
    out.push({
      id, name: ident.family, callsign: names.get(ident.unit) ?? view.unit.get(ident.unit)?.callsign ?? "", tag: s.triage?.cat ?? null, status,
      ordered: s.evacOrdered === true,
      canEvacuate: status !== "nest" && status !== "aboard" && status !== "carried" && status !== "walking" && status !== "evacuated" && s.evacOrdered !== true,
    });
  }
  return out.sort((a, b) => tagRank(a.tag) - tagRank(b.tag) || a.id - b.id);
}

/** One of the player's ambulances on a run (M10.6a): called (comes onto the map in about `dueS`), on its way to the
 *  nest, there, leaving, or gone off the map with `aboard` men. */
export interface AmbulanceRow {
  id: EntityId;
  callsign: string;
  phase: "called" | "inbound" | "loading" | "outbound" | "away" | "lost" | "toPoint" | "return" | "unloading" | "waiting";
  dueS: number;
  aboard: number;
  /** A combat vehicle on a rear run (M10.6b; phases toPoint, loading, outbound, away — back in about `dueS` —, return;
   *  M11.4b unloading); a supply run (M11.4b, "supplyRun"); a delivery from off the map (M11.4b, "delivery": called,
   *  inbound, loading = unloading at the supply point, outbound). */
  kind?: "rearRun" | "supplyRun" | "delivery" | "mp";
}

/** The side's ambulances (M10.6a): those on a run or done (rows), and how many still wait to be called. */
export function ambulanceRows(view: SimView, side: string): { rows: AmbulanceRow[]; ready: number } {
  const rows: AmbulanceRow[] = [];
  let ready = 0;
  for (const [id, v] of view.vehicle.entries()) {
    const o = v.offMap;
    if (o === undefined || v.side !== side) continue;
    // (M11.4b: a delivery run, by the supply vehicle or an ambulance sent with supplies.)
    if (o.cargo === "supplies") {
      if (o.phase === "called" || o.phase === "inbound" || o.phase === "loading" || o.phase === "outbound") {
        const due = o.phase === "called" ? Math.max(0, Math.round(((o.enterTick ?? view.tick) - view.tick) / TICK_HZ)) : 0;
        rows.push({ id, callsign: v.unit !== null ? view.unit.get(v.unit)?.callsign ?? "" : "", phase: o.phase, dueS: due, aboard: 0, kind: "delivery" });
      }
      continue;
    }
    // (M11.9b: the military police on a run, `aboard` its prisoners.)
    if (o.kind === "mp") {
      if (o.phase === "called" || o.phase === "inbound" || o.phase === "waiting" || o.phase === "loading" || o.phase === "outbound") {
        let n = 0;
        for (const sid of v.seats) { const c = sid === null ? undefined : view.soldier.get(sid)?.captive; if (c?.vehicle !== undefined && c.evacTick === undefined) n++; }
        const due = o.phase === "called" ? Math.max(0, Math.round(((o.enterTick ?? view.tick) - view.tick) / TICK_HZ)) : 0;
        rows.push({ id, callsign: v.unit !== null ? view.unit.get(v.unit)?.callsign ?? "" : "", phase: o.phase, dueS: due, aboard: n, kind: "mp" });
      }
      continue;
    }
    if (o.kind !== "ambulance") continue;
    if (o.phase === "ready") { ready++; continue; }
    let aboard = 0;
    for (const sid of v.seats) { const s = sid === null ? undefined : view.soldier.get(sid); if (s && s.wounds.length > 0 && view.unit.get(view.identity.get(sid!)?.unit ?? -1)?.asset === undefined) aboard++; }
    const dueS = o.phase === "called" ? Math.max(0, Math.round(((o.enterTick ?? view.tick) - view.tick) / TICK_HZ)) : 0;
    rows.push({ id, callsign: v.unit !== null ? view.unit.get(v.unit)?.callsign ?? "" : "", phase: o.phase as AmbulanceRow["phase"], dueS, aboard });
  }
  // Combat vehicles on a rear run (M10.6b).
  for (const [id, v] of view.vehicle.entries()) {
    const r = v.rearRun;
    if (!r || v.side !== side) continue;
    let aboard = 0;
    for (const sid of v.seats) { const s = sid === null ? undefined : view.soldier.get(sid); if (s && s.wounds.length > 0 && s.physiology.alive && (s.casualty !== "none" || !s.impair.canWalk || !s.impair.canFight)) aboard++; }
    const dueS = r.phase === "away" ? Math.max(0, Math.round(((r.backTick ?? view.tick) - view.tick) / TICK_HZ)) : 0;
    rows.push({ id, callsign: v.unit !== null ? view.unit.get(v.unit)?.callsign ?? "" : "", phase: r.phase, dueS, aboard, kind: r.cargo === "supplies" ? "supplyRun" : "rearRun" });
  }
  return { rows, ready };
}

export interface NestMarker {
  point: EntityId;
  /** The top unit it serves (the `casualtyPoint` order's target). */
  unit: EntityId;
  x: number;
  y: number;
  /** Living men lying at it. */
  count: number;
  /** Put there by the player (it stays). */
  placed: boolean;
}

/** The side's Verwundetennester (M10.5). */
export function nestMarkers(view: SimView, side: string): NestMarker[] {
  const out: NestMarker[] = [];
  for (const [id, p] of view.rear.entries()) {
    if (p.kind !== "medical" || p.side !== side) continue;
    let n = 0;
    for (const [, s] of view.soldier.entries()) if (s.atNest === id && s.physiology.alive) n++;
    out.push({ point: id, unit: p.unit, x: p.x, y: p.y, count: n, placed: p.placed === true });
  }
  return out;
}

/** The marker under a point (within `tolM`), or null. */
export function nestAt(markers: readonly NestMarker[], x: number, y: number, tolM: number): NestMarker | null {
  let best: NestMarker | null = null, bestD = tolM;
  for (const m of markers) { const d = Math.hypot(m.x - x, m.y - y); if (d <= bestD) { best = m; bestD = d; } }
  return best;
}
