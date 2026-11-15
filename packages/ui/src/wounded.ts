/**
 * THE WOUNDED LIST AND THE NEST MARKER (M10.5, owner Q-2c: a sidebar tab; owner answer 4: the player may order a
 * casualty's evacuation and move the Verwundetennest). Pure functions of the read-only view: `woundedRows` lists the
 * player's own wounded (enemy casualties never, owner Q-2d), T1 first; `nestMarkers` the side's Verwundetennester
 * with how many men lie at each. The sidebar draws the rows; the renderer draws the markers; the app turns a tap on
 * "Back" into an `evacuate` order and a dragged marker into a `casualtyPoint` order.
 */
import type { EntityId, SimView } from "@tcs/sim";

export type WoundedStatus = "nest" | "carried" | "walking" | "treated" | "aboard" | "waiting" | "fighting";

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
  for (const [id, s] of view.soldier.entries()) {
    if (s.wounds.length === 0 || !s.physiology.alive || s.captive !== null) continue;
    const ident = view.identity.get(id);
    if (!ident || ident.side !== side) continue;
    const party = view.carry.get(id);
    const status: WoundedStatus = s.atNest !== undefined ? "nest"
      : s.mount !== undefined ? "aboard"
      : party ? (party.carriers.length === 0 ? "walking" : "carried")
      : treated.has(id) ? "treated"
      : s.casualty === "incapacitated" || !s.impair.canWalk || !s.impair.canFight ? "waiting" : "fighting";
    out.push({
      id, name: ident.family, callsign: view.unit.get(ident.unit)?.callsign ?? "", tag: s.triage?.cat ?? null, status,
      ordered: s.evacOrdered === true,
      canEvacuate: status !== "nest" && status !== "aboard" && status !== "carried" && status !== "walking" && s.evacOrdered !== true,
    });
  }
  return out.sort((a, b) => tagRank(a.tag) - tagRank(b.tag) || a.id - b.id);
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
