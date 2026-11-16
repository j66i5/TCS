/**
 * REVIEW ROWS FOR M9 (M9.6): drones flown and lost, enemies found (and how many first by a drone), fire missions
 * by how the target was located, guided missiles, and the light, from the event stream alone (rule 5: the
 * after-action review and the batch report read events, never internals). The tally is plain JSON data: the app
 * saves it with its after-action record.
 */
import type { Catalog } from "./catalog";
import type { SimEvent } from "./events";
import { TICK_HZ, type DefId, type EntityId } from "./ids";
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
  /** Batteries and water (M11.6). Optional: absent until the first such event, and in tallies saved before it. */
  supply?: SupplyReview;
}

/** The kinds of powered device a man carries, for the review (M11.6): radios, sights and goggles, anything else. */
export type DeviceClass = "radio" | "sight" | "other";

export interface SupplyReview {
  /** Batteries changed in men's devices (`power.swapped`), and drones relaunched by a man who had brought one back on
   *  a battery fuller than the one he brought back (by more than RELAUNCH_FRESH_WH). */
  swaps: Record<DeviceClass | "drone", number>;
  /** Device batteries that went flat (`power.flat`); a drone's flat battery is `drones.lostBattery`. */
  flat: Record<DeviceClass, number>;
  /** Unit-seconds off the net of units on foot (none of their men aboard a hull): flat radios (comms.ts). */
  offNetS: number;
  /** Water drunk (`water.drunk`), ml. */
  waterMl: number;
  /** Men who brought a drone back since their last launch (id as a key) and the charge of the battery it came back
   *  with, Wh: their next launch counts as a battery change when its battery is fuller. */
  recovered: Record<string, number>;
}

export function newSupplyReview(): SupplyReview {
  return { swaps: { radio: 0, sight: 0, other: 0, drone: 0 }, flat: { radio: 0, sight: 0, other: 0 }, offNetS: 0, waterMl: 0, recovered: {} };
}

/** A drone relaunch counts as a battery change only on a battery fuller than the one brought back by more than this, Wh. */
export const RELAUNCH_FRESH_WH = 0.5;

/** Whether a unit has a man alive and not a prisoner (a unit wiped out or taken is not "off the net"). */
function hasLiving(view: SimView, members: readonly EntityId[]): boolean {
  for (const m of members) { const s = view.soldier.get(m); if (s && s.physiology.alive && s.captive === null) return true; }
  return false;
}

/** Which kind of device an item is (a radio item, an item with a sensor, else other; unknown without a catalog). */
export function deviceClass(catalog: Catalog | undefined, device: DefId): DeviceClass {
  const d = catalog?.items[device];
  return d?.radio === true ? "radio" : d?.sensor !== undefined ? "sight" : "other";
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

/** Add one tick's events to the tally (`view`: the state after that tick; `catalog` sorts powered devices by kind,
 *  M11.6). */
export function tallyReview(t: ReviewTally, events: readonly SimEvent[], view: SimView, catalog?: Catalog): void {
  const side = (s: string) => (t.sides[s] ??= newSide());
  const supply = (s: string) => (side(s).supply ??= newSupplyReview());
  // M11.6: once a second, units on foot that are off the net (a few units: one pass, no allocation).
  if (view.tick % TICK_HZ === 0) {
    for (const [, u] of view.unit.entries()) {
      if (u.vehicle !== undefined || u.comms.link !== "none" || u.members.length === 0) continue;
      let aboard = false;
      for (const m of u.members) if (view.soldier.get(m)?.mount !== undefined) { aboard = true; break; }
      if (!aboard && hasLiving(view, u.members)) supply(u.side).offNetS++;
    }
  }
  if (view.environment.sky !== undefined) {
    const l = view.environment.light;
    if (t.light === null) t.light = { start: l, min: l };
    else if (l < t.light.min) t.light.min = l;
  }
  for (const e of events) {
    switch (e.kind) {
      case "drone.launched": {
        side(e.side).drones.launched++;
        // A relaunch on a fuller battery than the one he brought back is a battery change (review fix 2026-11-16).
        const r = t.sides[e.side]!.supply?.recovered, key = String(e.operator), back = r?.[key];
        if (r !== undefined && back !== undefined) {
          if (e.wh !== undefined && e.wh > back + RELAUNCH_FRESH_WH) supply(e.side).swaps.drone++;
          delete r[key];
        }
        break;
      }
      case "drone.landed": side(e.side).drones.landed++; supply(e.side).recovered[String(e.by)] = e.wh ?? 0; break;
      case "power.swapped": { const sd = view.identity.get(e.soldier)?.side; if (sd !== undefined) supply(sd).swaps[deviceClass(catalog, e.device)]++; break; }
      case "power.flat": supply(e.side).flat[deviceClass(catalog, e.device)]++; break;
      case "water.drunk": supply(e.side).waterMl += e.ml; break;
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
