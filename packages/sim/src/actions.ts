/**
 * ACTIONS WITH DURATION THAT CAN BE INTERRUPTED (SPEC 9.1 foundation requirement).
 *
 * Reloading, handing over a magazine, applying a tourniquet, setting up a machine gun: each is an action
 * that takes time, is visible to other systems while it runs, and can be interrupted (suppression, the
 * actor being hit, a new order). Handlers are registered by kind; the kinds are generic, not per faction.
 */
import type { Action } from "./components";
import type { EventSink } from "./events";
import type { EntityId } from "./ids";
import { addItems, removeItems, transferItems } from "./items";
import type { SimContext } from "./context";
import type { SimState } from "./state";

export interface ActionHandler {
  /** Return a reason string to interrupt, or null to continue. Called every tick. */
  check(ctx: SimContext, state: SimState, actor: EntityId, action: Action): string | null;
  /** Apply the effect when the duration has elapsed. */
  complete(ctx: SimContext, state: SimState, actor: EntityId, action: Action, events: EventSink): void;
}

/** Hand items to another container within reach. params: { to, item, count } */
const transferHandler: ActionHandler = {
  check(_ctx, state, actor, a) {
    const to = Number(a.params["to"]);
    const pa = state.transform.get(actor);
    const pb = state.transform.get(to);
    if (!state.container.has(to)) return "no-container";
    if (pa && pb) {
      const dx = pa.x - pb.x, dy = pa.y - pb.y;
      if (dx * dx + dy * dy > 2.5 * 2.5) return "out-of-reach";
    }
    return null;
  },
  complete(ctx, state, actor, a, events) {
    const to = Number(a.params["to"]);
    const item = String(a.params["item"]);
    const r = transferItems(ctx.catalog, state.container, { from: actor, to, type: item, count: Number(a.params["count"]) });
    if (r.moved > 0) events.emit({ kind: "items.transferred", tick: state.tick, from: actor, to, item, count: r.moved });
  },
};

/** Change magazine: the one in the weapon goes back into the load (even empty), the fullest one goes in. */
const reloadHandler: ActionHandler = {
  check(_ctx, state, actor) {
    return state.weapon.has(actor) ? null : "no-weapon";
  },
  complete(ctx, state, actor, _a, events) {
    const w = state.weapon.req(actor);
    const wd = ctx.catalog.weapons[w.weapon];
    const c = state.container.get(actor);
    if (!wd || !c) return;
    const best = c.stacks.filter((s) => s.type === wd.feed.magazine).reduce((m, s) => Math.max(m, s.charge ?? 0), 0);
    if (best <= (w.magazine?.rounds ?? 0)) return; // nothing better to load
    const taken = removeItems(c, wd.feed.magazine, 1, best)[0];
    if (!taken) return;
    if (w.magazine) addItems(c, w.magazine.item, 1, w.magazine.rounds);
    w.magazine = { item: taken.type, rounds: taken.charge ?? 0 };
    w.burstLeft = 0; w.burstIndex = 0;
    w.lowAmmoReported = false;
    w.lowAmmoRadioed = false;
    events.emit({ kind: "weapon.reloaded", tick: state.tick, soldier: actor, rounds: w.magazine.rounds });
  },
};

/** Clear a stoppage. */
const clearStoppageHandler: ActionHandler = {
  check(_ctx, state, actor) {
    return state.weapon.has(actor) ? null : "no-weapon";
  },
  complete(_ctx, state, actor) {
    state.weapon.req(actor).jammed = false;
  },
};

export const ACTION_HANDLERS: Record<string, ActionHandler> = {
  transferItems: transferHandler,
  reload: reloadHandler,
  clearStoppage: clearStoppageHandler,
};

/** Start an action, interrupting any current one. */
export function startAction(
  state: SimState,
  events: EventSink,
  actor: EntityId,
  kind: string,
  durationTicks: number,
  params: Action["params"],
): void {
  if (!ACTION_HANDLERS[kind]) throw new Error(`unknown action kind '${kind}'`);
  interruptAction(state, events, actor, "replaced");
  state.action.set(actor, { kind, startTick: state.tick, durationTicks, params });
  events.emit({ kind: "action.started", tick: state.tick, actor, action: kind, durationTicks });
}

export function interruptAction(state: SimState, events: EventSink, actor: EntityId, reason: string): void {
  const cur = state.action.get(actor);
  if (!cur) return;
  state.action.delete(actor);
  events.emit({ kind: "action.interrupted", tick: state.tick, actor, action: cur.kind, reason });
}

export function actionSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  for (const [actor, a] of state.action.toEntries()) {
    const h = ACTION_HANDLERS[a.kind];
    if (!h) throw new Error(`unknown action kind '${a.kind}'`);
    const why = h.check(ctx, state, actor, a);
    if (why !== null) {
      interruptAction(state, events, actor, why);
      continue;
    }
    if (state.tick >= a.startTick + a.durationTicks) {
      state.action.delete(actor);
      h.complete(ctx, state, actor, a, events);
      events.emit({ kind: "action.completed", tick: state.tick, actor, action: a.kind });
    }
  }
}
