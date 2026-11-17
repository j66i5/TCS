/**
 * PRISONERS ON THE CARD AND THE MAP (M11.9a). Pure functions of the read-only view: `prisonerSummary` counts a unit's
 * prisoners (those its men took, by group: waiting, on the way, held) and its men on prisoner duty; `prisonerCardText`
 * is the card's line ("Prisoners 4 (1 NCO) · guard 1"); `prisonerMarkers` lists the side's collection points.
 */
import { mpServing, TICK_HZ, type EntityId, type SimView } from "@tcs/sim";
import type { Strings } from "@tcs/data";

export interface PrisonerSummary {
  /** Prisoners its men took who are still in its hands (alive, on the map): all, and by group. */
  total: number; officer: number; nco: number; man: number;
  /** Waiting for an escort (not on the way, not at the point or the nest). */
  waiting: number;
  /** Its men on prisoner duty: searching or escorting, and guarding at a point. */
  escorts: number; guards: number;
  /** M11.9b: those the military police took away; and the military police for its platoon's point: called (due in
   *  `dueS`), on its way, or at the point. */
  evacuated: number;
  mp?: { phase: "due" | "coming" | "here"; dueS: number };
}

function tree(view: SimView, uid: EntityId): Set<EntityId> {
  const out = new Set<EntityId>();
  const walk = (u: EntityId) => { const x = view.unit.get(u); if (!x || out.has(u)) return; out.add(u); for (const c of x.children) walk(c); };
  walk(uid);
  return out;
}

function inHand(s: { readonly captive: { readonly state: string; readonly unit?: EntityId; readonly evacTick?: number } | null; readonly physiology: { readonly alive: boolean }; readonly evacuated?: unknown }): boolean {
  return s.captive !== null && s.captive.state === "captured" && s.captive.unit !== undefined && s.physiology.alive && s.evacuated === undefined && s.captive.evacTick === undefined;
}

/** The unit's (and its sub-units') prisoners and men on prisoner duty. */
export function prisonerSummary(view: SimView, uid: EntityId): PrisonerSummary {
  const units = tree(view, uid);
  const out: PrisonerSummary = { total: 0, officer: 0, nco: 0, man: 0, waiting: 0, escorts: 0, guards: 0, evacuated: 0 };
  for (const [id, s] of view.soldier.entries()) {
    if (s.guard !== undefined && units.has(view.identity.get(id)?.unit ?? -1)) { if (s.guard.phase === "guard") out.guards++; else out.escorts++; }
    if (s.captive?.evacTick !== undefined && s.captive.unit !== undefined && units.has(s.captive.unit)) out.evacuated++;
    if (!inHand(s) || !units.has(s.captive!.unit!)) continue;
    out.total++;
    out[s.captive!.group ?? "man"]++;
    if (s.captive!.point === undefined && s.captive!.escort === undefined && s.atNest === undefined && s.mount === undefined && !view.carry.has(id)) out.waiting++;
  }
  // (M11.9b: the military police for the platoon's collection point.)
  let top = uid;
  for (let p = view.unit.get(top)?.parent ?? null; p !== null; p = view.unit.get(top)?.parent ?? null) top = p;
  for (const [pid, r] of view.rear.entries()) {
    if (r.kind !== "prisoners" || r.unit !== top) continue;
    const vid = mpServing(view, pid), o = vid === null ? undefined : view.vehicle.get(vid)?.offMap;
    if (o) out.mp = o.phase === "called" ? { phase: "due", dueS: Math.max(0, Math.round(((o.enterTick ?? view.tick) - view.tick) / TICK_HZ)) } : { phase: o.phase === "loading" ? "here" : "coming", dueS: 0 };
  }
  return out;
}

/** The card's line, or null with nothing to show. */
export function prisonerCardText(s: Strings, p: PrisonerSummary): string | null {
  if (p.total === 0 && p.escorts === 0 && p.guards === 0 && p.evacuated === 0) return null;
  const parts: string[] = [];
  const of: string[] = [];
  if (p.officer > 0) of.push(s.t("card.pow.officers", { n: p.officer }));
  if (p.nco > 0) of.push(s.t("card.pow.ncos", { n: p.nco }));
  parts.push(`${s.t("card.pow.prisoners", { n: p.total })}${of.length > 0 ? ` (${of.join(", ")})` : ""}`);
  if (p.waiting > 0) parts.push(s.t("card.pow.waiting", { n: p.waiting }));
  if (p.escorts > 0) parts.push(s.t("card.pow.escorts", { n: p.escorts }));
  if (p.guards > 0) parts.push(s.t("card.pow.guards", { n: p.guards }));
  if (p.mp) parts.push(p.mp.phase === "due" ? s.t("card.pow.mpDue", { min: Math.max(1, Math.round(p.mp.dueS / 60)) }) : s.t(p.mp.phase === "here" ? "card.pow.mpHere" : "card.pow.mpComing"));
  if (p.evacuated > 0) parts.push(s.t("card.pow.evacuated", { n: p.evacuated }));
  return parts.join(" · ");
}

export interface PrisonerMarker {
  point: EntityId;
  /** The top unit it serves (the `prisonerPoint` order's target). */
  unit: EntityId;
  x: number; y: number;
  side: string;
  /** Prisoners held there, and its guards. */
  held: number; guards: number;
  placed: boolean;
}

/** Side `side`'s prisoner collection points. */
export function prisonerMarkers(view: SimView, side: string): PrisonerMarker[] {
  const out: PrisonerMarker[] = [];
  for (const [id, p] of view.rear.entries()) {
    if (p.kind !== "prisoners" || p.side !== side) continue;
    let held = 0, guards = 0;
    for (const [, s] of view.soldier.entries()) {
      if (s.captive?.point === id && inHand(s) && s.atNest === undefined && s.mount === undefined) held++;
      if (s.guard?.point === id && s.guard.phase === "guard") guards++;
    }
    out.push({ point: id, unit: p.unit, x: p.x, y: p.y, side: p.side, held, guards, placed: p.placed === true });
  }
  return out;
}
