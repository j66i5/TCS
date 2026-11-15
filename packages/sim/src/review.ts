/**
 * REVIEW ROWS FOR M9 (M9.6): drones flown and lost, enemies found (and how many first by a drone), fire missions
 * by how the target was located, guided missiles, and the light, from the event stream alone (rule 5: the
 * after-action review and the batch report read events, never internals). The tally is plain JSON data: the app
 * saves it with its after-action record.
 */
import type { SimEvent } from "./events";
import type { EntityId } from "./ids";
import type { LocationMethod, SimView } from "./state";

export interface SideReview {
  /** Own drones: launched, recovered (landed), lost to a flat battery, lost with no one to fly them, shot down;
   *  enemy drones this side shot down. */
  drones: { launched: number; landed: number; lostBattery: number; lostNoOperator: number; shotDown: number; downedEnemy: number };
  /** Enemy men and vehicles found in the battle (the first `spotted` per target, drones not counted), and of them
   *  found first by a drone. */
  found: { total: number; byDrone: number };
  /** Fire missions called, by how the target was located. */
  calls: Partial<Record<LocationMethod, number>>;
  /** Fire support rounds landed, by how the mission's target was located. */
  rounds: Partial<Record<LocationMethod, number>>;
  /** Guided missiles whose flight ended in the battle, and of them hits on the target. */
  missiles: { fired: number; hit: number };
  /** The targets this side has found so far (ascending ids; the "first seen" set). */
  seen: EntityId[];
  /** Morale (rework 2026-11-15): times a man of this side panicked, units of it that broke, rallies by its leaders.
   *  Optional: tallies saved before the rework have none. */
  morale?: { panicked: number; broken: number; rallies: number };
}

export interface ReviewTally {
  sides: Record<string, SideReview>;
  /** Ambient light (0..1) at the first tally and the lowest since; null when the battle has no sky (M9.1). */
  light: { start: number; min: number } | null;
}

export function newReviewTally(): ReviewTally {
  return { sides: {}, light: null };
}

function newSide(): SideReview {
  return { drones: { launched: 0, landed: 0, lostBattery: 0, lostNoOperator: 0, shotDown: 0, downedEnemy: 0 }, found: { total: 0, byDrone: 0 }, calls: {}, rounds: {}, missiles: { fired: 0, hit: 0 }, seen: [], morale: { panicked: 0, broken: 0, rallies: 0 } };
}

/** Insert `id` into ascending `xs` unless present; whether it was new. */
function addSorted(xs: EntityId[], id: EntityId): boolean {
  let lo = 0, hi = xs.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[mid]! < id) lo = mid + 1; else hi = mid; }
  if (xs[lo] === id) return false;
  xs.splice(lo, 0, id);
  return true;
}

/** Add one tick's events to the tally (`view`: the state after that tick). */
export function tallyReview(t: ReviewTally, events: readonly SimEvent[], view: SimView): void {
  const side = (s: string) => (t.sides[s] ??= newSide());
  if (view.environment.sky !== undefined) {
    const l = view.environment.light;
    if (t.light === null) t.light = { start: l, min: l };
    else if (l < t.light.min) t.light.min = l;
  }
  for (const e of events) {
    switch (e.kind) {
      case "drone.launched": side(e.side).drones.launched++; break;
      case "drone.landed": side(e.side).drones.landed++; break;
      case "drone.lost": {
        const d = side(e.side).drones;
        if (e.reason === "battery") d.lostBattery++;
        else if (e.reason === "noOperator") d.lostNoOperator++;
        else {
          d.shotDown++;
          const by = e.by !== undefined ? view.identity.get(e.by)?.side : undefined;
          const shooter = by ?? opposing(view, e.side);
          if (shooter !== undefined && shooter !== e.side) side(shooter).drones.downedEnemy++;
        }
        break;
      }
      case "spotted": {
        // Men and vehicles only: a drone seen in the sky is not an enemy found.
        if (view.drone.has(e.target) || (!view.soldier.has(e.target) && !view.vehicle.has(e.target))) break;
        const s = side(e.side);
        if (!addSorted(s.seen, e.target)) break;
        s.found.total++;
        if (e.drone === true) s.found.byDrone++;
        break;
      }
      case "support.call": { const c = side(e.side).calls; c[e.method] = (c[e.method] ?? 0) + 1; break; }
      case "behaviour.changed": {
        if (e.to !== "panicked") break;
        const sd = view.identity.get(e.soldier)?.side;
        if (sd !== undefined) (side(sd).morale ??= { panicked: 0, broken: 0, rallies: 0 }).panicked++;
        break;
      }
      case "radio": if (e.key === "radio.broken") (side(e.side).morale ??= { panicked: 0, broken: 0, rallies: 0 }).broken++; break;
      case "morale.rally": {
        const sd = view.identity.get(e.leader)?.side;
        if (sd !== undefined) (side(sd).morale ??= { panicked: 0, broken: 0, rallies: 0 }).rallies++;
        break;
      }
      case "support.round": if (e.method !== undefined) { const c = side(e.side).rounds; c[e.method] = (c[e.method] ?? 0) + 1; } break;
      case "missile.ended": {
        const sd = e.vehicle !== undefined ? view.vehicle.get(e.vehicle)?.side : view.identity.get(e.gunner)?.side;
        if (sd === undefined) break;
        const m = side(sd).missiles;
        m.fired++;
        if (e.result === "hit") m.hit++;
        break;
      }
      default: break;
    }
  }
}

/** The first side other than `s` with units (ascending unit ids). */
function opposing(view: SimView, s: string): string | undefined {
  for (const [, u] of view.unit.entries()) if (u.side !== s) return u.side;
  return undefined;
}
