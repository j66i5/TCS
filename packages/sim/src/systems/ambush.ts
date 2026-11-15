/**
 * Ambushes (D4b, SPEC 6.6 "ambush"): a unit given an `ambush` order holds its fire (decisions.ts, gunnery.ts and
 * missile-team.ts cap their reach at the ambush range and keep launchers and grenades back) until it is sprung.
 * It is sprung for the whole unit tree it was laid on when
 *   - an enemy is seen within `rangeM` of one of its men,
 *   - one of its men or vehicles fires (an order to fire, a man defending himself), or
 *   - one of its units comes under fire after it was laid.
 * Then the ambush is gone and the men fire at will (their fire rule was set to "free" when it was laid).
 * Runs right before the decisions, so the men open fire in the same tick.
 */
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { secondsToTicks, type EntityId } from "../ids";
import { isAble } from "../impair";
import { hypot2 } from "../math";
import type { SimState } from "../state";
import { radioFromTarget, unitSoldiers } from "./orders";

export function ambushSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  let roots: EntityId[] | null = null;
  // (Each ambush once, by the unit it was laid on: ascending id.)
  for (const [uid, u] of state.unit.entries()) if (u.ambush !== undefined && u.ambush.root === uid) (roots ??= []).push(uid);
  if (roots === null) return;
  for (const root of roots) {
    const a = state.unit.req(root).ambush!;
    if (sprung(ctx, state, events, root, a.rangeM, a.tick)) {
      clearAmbush(state, root);
      radioFromTarget(state, root, "radio.ambushSprung", events);
    }
  }
}

/** The units of the tree (the root and every unit under it that still holds this ambush), ascending id. */
function treeUnits(state: SimState, root: EntityId): EntityId[] {
  const out: EntityId[] = [];
  const walk = (uid: EntityId): void => {
    const u = state.unit.get(uid);
    if (!u || u.ambush?.root !== root) return;
    out.push(uid);
    for (const c of u.children) walk(c);
  };
  walk(root);
  return out.sort((p, q) => p - q);
}

function sprung(ctx: SimContext, state: SimState, events: EventSink, root: EntityId, rangeM: number, tick: number): boolean {
  const units = treeUnits(state, root);
  const unitSet = new Set(units);
  // Under fire since it was laid (each unit remembers fire on its own men, decisions.ts; a platoon and a crew
  // remember fire on any of theirs, hits on a hull too).
  for (const uid of units) { const u = state.unit.req(uid); if ((u.ownFireTick ?? -1e9) > tick || u.underFireTick > tick) return true; }
  // mounted: ok the crews and men aboard are part of the ambush too
  const men = unitSoldiers(state, root).filter((m) => unitSet.has(state.identity.get(m)?.unit ?? -1));
  const menSet = new Set(men);
  // One of them fired: his weapon, a vehicle's station, or this tick a launcher or a grenade.
  for (const m of men) if ((state.weapon.get(m)?.lastShotTick ?? -1e9) >= tick) return true;
  const vehicles = new Set<EntityId>();
  for (const uid of units) {
    const vid = state.unit.req(uid).vehicle;
    if (vid === undefined) continue;
    vehicles.add(vid);
    const v = state.vehicle.get(vid);
    if (v && v.stations.some((st) => st.weapons.some((w) => w.lastShotTick >= tick))) return true;
  }
  for (const e of events.events) {
    if (e.kind === "shot.fired" && (menSet.has(e.shooter) || (e.vehicle !== undefined && vehicles.has(e.vehicle)))) return true;
    if (e.kind === "grenade.launched" && menSet.has(e.soldier)) return true;
  }
  // An enemy seen within the range of one of the men.
  const within = secondsToTicks(ctx.catalog.behaviour.decisions.seenWithinSeconds);
  for (const m of men) {
    const s = state.soldier.get(m), t = state.transform.get(m);
    if (!isAble(s) || !t) continue;
    for (const c of s!.contacts) {
      if (c.kind !== "seen" || c.down === true || c.surrendered === true || state.tick - c.tick > within) continue;
      if (hypot2(c.x - t.x, c.y - t.y) <= rangeM) return true;
    }
  }
  return false;
}

/** The ambush is over for the whole tree (sprung). */
function clearAmbush(state: SimState, root: EntityId): void {
  for (const uid of treeUnits(state, root)) delete state.unit.req(uid).ambush;
}
