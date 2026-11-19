/**
 * REFILLING MAGAZINES FROM LOOSE ROUNDS (M11.1, owner answer "loose rounds").
 *
 * A man carries loose rounds (a bandolier, paper packs: items of category "ammo-package" whose charge is the
 * cartridge of his weapon). In a quiet moment — he has not fired for `refill.quietS`, is not under fire, stands still,
 * is not caring for or carrying anyone and has no other action — he refills his emptiest spare magazine that is below
 * `refill.belowFraction` full, one magazine at a time (action `refillMagazines`). The rounds go in one by one
 * (`moveCharge`: conserved exactly), so a man interrupted (any shot of his, fire on him, a move, an order, another
 * action) keeps what he has loaded. Machine guns are never refilled in battle: belts come linked.
 *
 * The decision runs inside the staggered decision step (decisions.ts), never as a per-tick loop of its own.
 */
import type { Action } from "../components";
import { registerActionHandler, startAction } from "../actions";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import type { EntityId } from "../ids";
import { secondsToTicks } from "../ids";
import { moveCharge, type Container } from "../items";
import type { SimState } from "../state";
import type { SoldierState } from "../components";

export const REFILL_ACTION = "refillMagazines";

/** The loose rounds and magazine a man would refill now, or null. */
export function refillChoice(ctx: SimContext, state: SimState, id: EntityId): { mag: string; magCharge: number; pkg: string; pkgCharge: number; need: number; clips: boolean } | null {
  const R = ctx.catalog.behaviour.refill;
  const w = state.weapon.get(id), c = state.container.get(id);
  const wd = w ? ctx.catalog.weapons[w.weapon] : undefined;
  if (!R || !wd || !c || wd.sustained !== undefined) return null;
  const md = ctx.catalog.items[wd.feed.magazine];
  const cart = md?.chargeItem, cap = md?.chargeCapacity ?? 0;
  if (cart === undefined || cap <= 0) return null;
  let magCharge = Infinity;
  for (const s of c.stacks) if (s.type === wd.feed.magazine && (s.charge ?? 0) < R.belowFraction * cap && (s.charge ?? 0) < magCharge) magCharge = s.charge ?? 0;
  if (magCharge === Infinity) return null;
  const p = loosePackage(ctx, c, cart);
  if (!p) return null;
  return { mag: wd.feed.magazine, magCharge, pkg: p.type, pkgCharge: p.charge, need: cap - magCharge, clips: ctx.catalog.items[p.type]?.stripperClips === true };
}

/** The package of loose rounds of a cartridge to take from first: the emptiest one that still has rounds. */
function loosePackage(ctx: SimContext, c: Container, cart: string): { type: string; charge: number } | null {
  let best: { type: string; charge: number } | null = null;
  for (const s of c.stacks) {
    const d = ctx.catalog.items[s.type];
    if (d?.category !== "ammo-package" || d.chargeItem !== cart || (s.charge ?? 0) <= 0) continue;
    if (!best || (s.charge ?? 0) < best.charge) best = { type: s.type, charge: s.charge ?? 0 };
  }
  return best;
}

/** Decision (staggered step): start refilling if the moment is quiet. True if he started. The caller has checked
 *  that he is able, halted, not pinned, has no action and no posture change. */
export function refillDecision(ctx: SimContext, state: SimState, events: EventSink, id: EntityId, s: SoldierState): boolean {
  const R = ctx.catalog.behaviour.refill;
  if (!R || ctx.rules.refill === false) return false; // (balance pass 3: not the supply chain's `resupply`)
  // (Not a man of a mortar, missile or AGL team that is set up: he is at his post.)
  const u = state.unit.get(state.identity.get(id)?.unit ?? -1);
  if ((u?.mortar !== undefined && u.mortar.state !== "packed") || (u?.missileTeam !== undefined && u.missileTeam.state !== "packed")) return false;
  if (s.mental.suppression >= R.underFireBelow || (s.intent !== null && s.intent.kind !== "engage")) return false;
  const w = state.weapon.get(id);
  if (!w || state.tick - w.lastShotTick < secondsToTicks(R.quietS)) return false;
  const ft = state.fire.get(id);
  if (ft && ft.self !== true) return false; // (an ordered fire task: he is to fire, not to refill)
  const ch = refillChoice(ctx, state, id);
  if (!ch) return false;
  const per = secondsToTicks(ch.clips ? R.secondsPerRoundClips : R.secondsPerRound);
  const n = Math.min(ch.need, ch.pkgCharge);
  startAction(state, events, id, REFILL_ACTION, Math.max(1, n * per), { mag: ch.mag, magCharge: ch.magCharge, pkg: ch.pkg, pkgCharge: ch.pkgCharge, per, loaded: 0 });
  return true;
}

/** Load the rounds due by now (one per `per` ticks since the start). False if it cannot go on. */
function loadDue(ctx: SimContext, state: SimState, actor: EntityId, a: Action, upTo: number): boolean {
  const per = Number(a.params["per"]);
  const due = Math.min(upTo, Math.floor((state.tick - a.startTick) / per));
  let loaded = Number(a.params["loaded"]);
  if (due <= loaded) return true;
  const mag = String(a.params["mag"]), pkg = String(a.params["pkg"]);
  const magCharge = Number(a.params["magCharge"]), pkgCharge = Number(a.params["pkgCharge"]);
  const r = moveCharge(ctx.catalog, state.container, { from: actor, fromType: pkg, fromCharge: pkgCharge, to: actor, toType: mag, toCharge: magCharge, amount: due - loaded });
  if (r.moved <= 0) return false;
  loaded += r.moved;
  a.params["loaded"] = loaded;
  a.params["magCharge"] = magCharge + r.moved;
  a.params["pkgCharge"] = pkgCharge - r.moved;
  return true;
}

registerActionHandler(REFILL_ACTION, {
  check(ctx, state, actor, a) {
    const R = ctx.catalog.behaviour.refill;
    const s = state.soldier.get(actor), w = state.weapon.get(actor);
    if (!R || !s || !w) return "unable";
    if (s.mental.suppression >= R.underFireBelow) return "under-fire";
    if (w.lastShotTick > a.startTick) return "fired";
    // (A new reason to fire — an order, fire on his unit, an enemy he sees — ends it: the fire system waits for no
    // action of his.)
    const ft = state.fire.get(actor);
    if (ft && (ft.reasonTick > a.startTick || ft.startTick > a.startTick)) return "fire";
    if ((state.mover.get(actor)?.waypoints.length ?? 0) > 0) return "moved";
    if (s.mount !== undefined || s.carrying !== undefined || (s.intent !== null && s.intent.kind !== "engage")) return "busy";
    if (!loadDue(ctx, state, actor, a, Infinity)) return "no-rounds";
    return null;
  },
  complete(ctx, state, actor, a, events) {
    const per = Number(a.params["per"]);
    loadDue(ctx, state, actor, a, Math.ceil(a.durationTicks / per));
    const loaded = Number(a.params["loaded"]);
    if (loaded > 0) events.emit({ kind: "items.refilled", tick: state.tick, soldier: actor, item: String(a.params["mag"]), rounds: loaded });
  },
});
