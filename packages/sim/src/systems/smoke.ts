/**
 * HAND SMOKE SCREENS (D1, M10; SPEC 6.6 foundation). A hand smoke grenade is a counted item (an ammunition entry
 * with a `smoke` block and `delivery: thrown`). Thrown with the ordinary grenade action (systems/grenades.ts); when
 * its fuse has run it smokes where it lies: a cloud in `state.smoke`, the same concealment as mortar and discharger
 * smoke (spotting, fire-support observation).
 *
 * Who throws one on his own (behaviour.smoke, the same for every side):
 *   - the break-contact drill: a unit ordered to withdraw (player or AI) screens itself from the nearest enemy it
 *     knows;
 *   - moving off under fire: a unit fired on moments ago that is ordered to move (a crossing under fire);
 *   - a casualty drag: `screenCasualty` — a hook for the medical line (M10.3b's one-man drag to cover); nothing in
 *     the sim calls it yet.
 * The screen goes `screenM` from the thrower toward the enemy, at most once per `cooldownS` per unit.
 */
import { startAction } from "../actions";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { secondsToTicks, type EntityId } from "../ids";
import { canReport, isAble } from "../impair";
import { atan2, hypot2 } from "../math";
import type { SimState } from "../state";
import { grenadeOption, throwArcExists } from "./grenades";

/** All soldiers of a unit and its sub-units, ascending id. */
function menOf(state: SimState, uid: EntityId): EntityId[] {
  const out: EntityId[] = [];
  const walk = (u: EntityId) => {
    const unit = state.unit.get(u);
    if (!unit) return;
    out.push(...unit.members);
    for (const c of unit.children) walk(c);
  };
  walk(uid);
  return out.sort((a, b) => a - b);
}

/** Does this man carry a hand smoke grenade? */
export function hasSmokeGrenade(ctx: SimContext, state: SimState, id: EntityId): boolean {
  const c = state.container.get(id);
  if (!c) return false;
  for (const st of c.stacks) if (st.count > 0 && ctx.catalog.ammo[st.type]?.smoke !== undefined && ctx.catalog.ammo[st.type]?.delivery?.method === "thrown") return true;
  return false;
}

/**
 * The nearest enemy the men of `men` know (not down, not given up), `enemyMinM`-`enemyMaxM` from (x, y) and known
 * within `knownWithinS`; null if none.
 */
function nearestThreat(ctx: SimContext, state: SimState, men: readonly EntityId[], x: number, y: number): { x: number; y: number } | null {
  const S = ctx.catalog.behaviour.smoke;
  const since = state.tick - secondsToTicks(S.knownWithinS);
  let best: { x: number; y: number } | null = null, bestD = Infinity;
  for (const m of men) {
    const s = state.soldier.get(m);
    if (!s) continue;
    for (const k of s.contacts) {
      if (k.tick < since || k.surrendered || k.down) continue;
      const d = hypot2(k.x - x, k.y - y);
      if (d < S.enemyMinM || d > S.enemyMaxM || d >= bestD) continue;
      best = { x: k.x, y: k.y }; bestD = d;
    }
  }
  return best;
}

/**
 * One man of unit `uid` throws a smoke grenade to screen (fromX, fromY) — default: the unit's able men's middle —
 * from the nearest enemy the unit knows (or from `threat`). Returns true if a throw was started. Same for every
 * side; player and AI units alike.
 */
export function throwScreen(ctx: SimContext, state: SimState, events: EventSink, uid: EntityId, opts: { fromX?: number; fromY?: number; threat?: { x: number; y: number }; thrower?: EntityId } = {}): boolean {
  const S = ctx.catalog.behaviour.smoke;
  const u = state.unit.get(uid);
  if (!u) return false;
  if (u.smokeTick !== undefined && state.tick - u.smokeTick < secondsToTicks(S.cooldownS)) return false;
  const men = menOf(state, uid).filter((m) => {
    const s = state.soldier.get(m);
    return isAble(s) && s!.mount === undefined && s!.mental.behaviour !== "routed" && state.transform.has(m);
  });
  if (men.length === 0) return false;
  let fx = opts.fromX, fy = opts.fromY;
  if (fx === undefined || fy === undefined) {
    let sx = 0, sy = 0;
    for (const m of men) { const t = state.transform.req(m); sx += t.x; sy += t.y; }
    fx = sx / men.length; fy = sy / men.length;
  }
  const threat = opts.threat ?? nearestThreat(ctx, state, men, fx, fy);
  if (!threat) return false;
  const d = hypot2(threat.x - fx, threat.y - fy);
  if (d < 1) return false;
  const px = fx + ((threat.x - fx) / d) * Math.min(S.screenM, d * 0.5), py = fy + ((threat.y - fy) / d) * Math.min(S.screenM, d * 0.5);
  if (px < 0 || py < 0 || px > ctx.map.widthM || py > ctx.map.heightM) return false;
  // The thrower: the one named, else the able man with a smoke grenade nearest the screen point.
  const cands = (opts.thrower !== undefined ? [opts.thrower] : men).filter((m) => !state.action.has(m) && hasSmokeGrenade(ctx, state, m));
  cands.sort((a, b) => {
    const ta = state.transform.req(a), tb = state.transform.req(b);
    return hypot2(ta.x - px, ta.y - py) - hypot2(tb.x - px, tb.y - py) || a - b;
  });
  for (const m of cands) {
    const opt = grenadeOption(ctx, state, m, px, py, true);
    if (!opt || !throwArcExists(ctx, state, m, opt.ammo, px, py)) continue;
    const t = state.transform.req(m);
    t.heading = atan2(py - t.y, px - t.x);
    startAction(state, events, m, "grenade", secondsToTicks(ctx.catalog.shooting.grenades.throwSeconds), { ammo: opt.ammo, x: px, y: py });
    u.smokeTick = state.tick;
    if (canReport(state.soldier.get(m))) events.emit({ kind: "radio", tick: state.tick, side: u.side, from: m, key: "radio.smokeOut", params: { callsign: u.callsign } });
    return true;
  }
  return false;
}

/**
 * HOOK for the medical line (M10.3b, one-man drag under fire): screen a drag of `casualty` by `helper` — a man of
 * the helper's unit (the helper himself first) throws smoke between the casualty and the nearest enemy his unit
 * knows (or from `threat`, e.g. the man who shot him). Not called by the sim yet; the medical line calls it when a
 * drag starts. Returns true if a throw started.
 */
export function screenCasualty(ctx: SimContext, state: SimState, events: EventSink, helper: EntityId, casualty: EntityId, threat?: { x: number; y: number }): boolean {
  const uid = state.identity.get(helper)?.unit, ct = state.transform.get(casualty);
  if (uid === undefined || !ct) return false;
  const o = { fromX: ct.x, fromY: ct.y, ...(threat ? { threat } : {}) };
  if (hasSmokeGrenade(ctx, state, helper) && !state.action.has(helper) && throwScreen(ctx, state, events, uid, { ...o, thrower: helper })) return true;
  return throwScreen(ctx, state, events, uid, o);
}

/**
 * An order has just been applied to unit `uid` (orders.ts): the break-contact drill throws smoke on a withdrawal,
 * and a unit fired on moments ago screens its move off.
 */
export function screenOnOrder(ctx: SimContext, state: SimState, events: EventSink, uid: EntityId, kind: "withdraw" | "move"): void {
  const S = ctx.catalog.behaviour.smoke;
  const u = state.unit.get(uid);
  if (!u || u.vehicle !== undefined) return;
  if (kind === "withdraw" && !S.onWithdraw) return;
  if (kind === "move") {
    if (!S.onMoveUnderFire) return;
    const fired = u.ownFireTick ?? u.underFireTick;
    if (fired < 0 || state.tick - fired > secondsToTicks(S.underFireS)) return;
  }
  throwScreen(ctx, state, events, uid);
}
