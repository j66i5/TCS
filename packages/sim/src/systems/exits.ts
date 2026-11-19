/**
 * EXIT ZONES (M12.0b; SPEC 6.9 withdrawal and ambush, plan m12-roster 4.2): a side may have exit zones
 * (`rules.exits`). Once a second, every able man of that side on foot inside one of its zones, and every hull of that
 * side inside one that can still drive (ok or disarmed, crewed, not towed or being recovered), leaves the map there
 * for good: a hull is `exited` (off the map like a towed one, `isOffMap`; everyone aboard goes with it), a man on
 * foot is parked at `OFF_MAP_PARK`. Every man who leaves is `evacuated` with `via: "exit"`: not able, out of the
 * fight (every system that passes the evacuated by passes him by), but saved: his roster status stays "fit" (or
 * "wounded"), he is no man down in the score and his side scores the zone's `pointsPerMan` for him.
 *
 * A man carrying a casualty, or carried, does not leave by himself (he goes once he has put the casualty down, or
 * aboard a hull). Prisoners are not led out. Called only when the battle has exit zones.
 */
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { TICK_HZ, type EntityId, type SideId } from "../ids";
import { isAble } from "../impair";
import { isAssetUnit, isOffMap, OFF_MAP_PARK, parkOffMap } from "../offmap";
import type { SimState, SimView } from "../state";

/** A hull counts as in a zone when its centre is within this much of it (m): a hull cannot drive its centre to the very
 *  edge of the map (game value). */
export const EXIT_HULL_SLACK_M = 10;

/** Is (x, y) inside one of this side's exit zones (`slack`: the zone grown by that much, m)? */
export function inExit(ctx: SimContext, side: SideId, x: number, y: number, slack = 0): boolean {
  for (const z of ctx.rules.exits ?? []) {
    if (z.side !== side) continue;
    if (x >= Math.min(z.x0, z.x1) - slack && x <= Math.max(z.x0, z.x1) + slack && y >= Math.min(z.y0, z.y1) - slack && y <= Math.max(z.y0, z.y1) + slack) return true;
  }
  return false;
}

/** Did this man leave the map by an exit zone (saved)? */
export function hasExited(s: { readonly evacuated?: { readonly via?: string } | undefined } | undefined): boolean {
  return s?.evacuated?.via === "exit";
}

export function exitSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  if (state.tick % TICK_HZ !== 0 || state.ended) return;
  const tick = state.tick;
  // Hulls first (everyone aboard leaves with one).
  for (const [vid, v] of state.vehicle.entries()) {
    if (isOffMap(v) || v.offMap !== undefined || v.wreckIn !== undefined) continue;
    if ((v.status !== "ok" && v.status !== "disarmed") || v.unit === null || v.towedBy !== undefined || v.recoveryBy !== undefined) continue;
    const t = state.transform.get(vid);
    if (!t || !inExit(ctx, v.side, t.x, t.y, EXIT_HULL_SLACK_M)) continue;
    let men = 0;
    for (const sid of v.seats) {
      if (sid === null) continue;
      const s = state.soldier.get(sid);
      if (!s || !s.physiology.alive || s.captive !== null || s.evacuated !== undefined) continue;
      s.evacuated = { tick, vehicle: vid, via: "exit" };
      s.intent = null;
      men++;
    }
    v.exited = tick;
    parkOffMap(state, vid);
    events.emit({ kind: "unit.exited", tick, side: v.side, vehicle: vid, men });
  }
  // Men on foot.
  const carried = new Set<EntityId>();
  for (const [cid, c] of state.carry.entries()) { carried.add(cid); for (const m of c.carriers) carried.add(m); }
  // mounted: ok (only men on foot leave by themselves; those aboard leave with their hull)
  for (const [id, ident] of state.identity.entries()) {
    const s = state.soldier.get(id);
    if (!s || s.mount !== undefined || !isAble(s) || s.carrying !== undefined || carried.has(id) || isAssetUnit(state, ident.unit)) continue;
    const t = state.transform.get(id);
    if (!t || !inExit(ctx, ident.side, t.x, t.y)) continue;
    s.evacuated = { tick, via: "exit" };
    s.intent = null;
    t.x = OFF_MAP_PARK.x; t.y = OFF_MAP_PARK.y; t.z = 0;
    const m = state.mover.get(id);
    if (m) { m.waypoints = []; m.speedMps = 0; m.mode = null; m.formation = null; m.slotLagM = 0; m.endPosture = null; m.endHeading = null; }
    events.emit({ kind: "unit.exited", tick, side: ident.side, soldier: id, men: 1 });
  }
}

/** Men and hulls of a side out by its exit zones so far (score, result). */
export function exitedOf(state: SimView, side: SideId): { men: number; vehicles: number } {
  let men = 0, vehicles = 0;
  // mounted: ok (a man aboard a hull that left counts too)
  for (const [id, ident] of state.identity.entries()) {
    if (ident.side !== side || isAssetUnit(state, ident.unit)) continue;
    const s = state.soldier.get(id);
    if (s && s.physiology.alive && hasExited(s)) men++;
  }
  // off-map: ok (the hulls that left are off the map: they are what is counted)
  for (const [, v] of state.vehicle.entries()) if (v.side === side && v.exited !== undefined) vehicles++;
  return { men, vehicles };
}
