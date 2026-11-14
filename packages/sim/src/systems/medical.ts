/**
 * SELF-AID AND BUDDY AID (SPEC 9.1, M10.2).
 *
 * Every `care.stepS` each living wounded man on foot is looked at. If he is awake and can use his arms he treats
 * himself (self-aid) with the next intervention he needs and can do; otherwise the nearest comrade of his side
 * within `care.buddyReachM` who is free (no action, not on the move, able, hands free) treats him. A treatment is
 * the generic interruptible action "treat": it takes the data's time, uses up items (the casualty's own kit
 * first), works with the data's chance (drawn from the "medical" stream), and is recorded on the wound
 * (`TreatmentRecord`) with a `medical.treated` event. Under fire only what is allowed under fire (the tourniquet).
 * A man stopping his own massive bleeding stays where he is until it is done; other care waits until he halts.
 * Same rules for every side, the player's and the AI's. Who goes to a casualty further away (carers, first
 * responders, medics) comes in M10.3a.
 */
import { registerActionHandler, startAction } from "../actions";
import type { Action } from "../components";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { secondsToTicks, type EntityId } from "../ids";
import { isAble, isConscious } from "../impair";
import { removeItems } from "../items";
import { applyCareEffect, nextIntervention, type CareItem, type CarePlan } from "../medical";
import { isMounted } from "../mount";
import { nextFloat, Streams } from "../rng";
import type { SimState } from "../state";
import { refreshStatus } from "./wounds";

/** Is care to be given by the rules (medical data present, not switched off)? */
export function careEnabled(ctx: SimContext): boolean {
  return ctx.catalog.medical !== undefined && ctx.rules.medicalCare !== false;
}

/** Under fire for care (TCCC care under fire): his own suppression, or his unit fired on just now. */
export function underFireForCare(ctx: SimContext, state: SimState, id: EntityId): boolean {
  const C = ctx.catalog.medical!.care;
  const s = state.soldier.get(id);
  if (!s) return false;
  if (s.mental.suppression >= C.underFireSuppression) return true;
  const uid = state.identity.get(id)?.unit;
  const own = uid !== undefined ? state.unit.get(uid)?.ownFireTick : undefined;
  return own !== undefined && state.tick - own <= secondsToTicks(C.underFireSeconds);
}

/** Is this man free to treat a comrade now (not firing, busy, on the move, pinned down by panic)? */
function freeHelper(state: SimState, id: EntityId): boolean {
  const s = state.soldier.get(id);
  if (!s || !isAble(s) || !s.impair.canUseArms || isMounted(s) || state.action.has(id) || state.fire.has(id) || s.evade !== null) return false;
  if (state.tick < s.stunnedUntilTick || s.mental.behaviour === "panicked" || s.mental.behaviour === "routed") return false;
  return (state.mover.get(id)?.waypoints.length ?? 0) === 0;
}

/** Can he treat himself now (awake, hands free, not busy)? */
function canSelfAid(state: SimState, id: EntityId): boolean {
  const s = state.soldier.get(id);
  return s !== undefined && isConscious(s) && s.impair.canUseArms && !isMounted(s) && !state.action.has(id) && s.evade === null && state.tick >= s.stunnedUntilTick;
}

/** Start a treatment as worked out by `nextIntervention`. */
export function startTreatment(ctx: SimContext, state: SimState, events: EventSink, performer: EntityId, casualty: EntityId, plan: CarePlan, underFire: boolean): void {
  const params: Action["params"] = {
    casualty, intervention: plan.intervention, wound: plan.wound, skill: plan.skill, p: plan.p, items: plan.items.length,
    // Stopping his own massive bleeding, he stays put (his way is kept for afterwards).
    hold: performer === casualty && ctx.catalog.medical!.interventions[plan.intervention]!.underFire ? 1 : 0,
    fire: underFire ? 1 : 0,
  };
  plan.items.forEach((it, i) => { params[`item${i}`] = it.type; params[`count${i}`] = it.count; params[`from${i}`] = it.from; });
  startAction(state, events, performer, "treat", plan.durationTicks, params);
}

function itemsOf(a: Action): CareItem[] {
  const n = Number(a.params["items"] ?? 0), out: CareItem[] = [];
  for (let i = 0; i < n; i++) out.push({ type: String(a.params[`item${i}`]), count: Number(a.params[`count${i}`]), from: Number(a.params[`from${i}`]) });
  return out;
}

/** Does the container still hold the items (someone else may have used them)? */
function haveItems(state: SimState, items: readonly CareItem[]): boolean {
  for (const it of items) {
    const c = state.container.get(it.from);
    let n = 0;
    if (c) for (const st of c.stacks) if (st.type === it.type) n += st.count;
    if (n < it.count) return false;
  }
  return true;
}

/** Who is treating whom right now (casualty -> performer), from the running actions. */
export function treatedNow(state: SimState): Map<EntityId, EntityId> {
  const out = new Map<EntityId, EntityId>();
  for (const [actor, a] of state.action.entries()) if (a.kind === "treat") out.set(Number(a.params["casualty"]), actor);
  return out;
}

registerActionHandler("treat", {
  check(ctx, state, actor, a) {
    const casualty = Number(a.params["casualty"]);
    const cs = state.soldier.get(casualty), ps = state.soldier.get(actor);
    if (!cs || !cs.physiology.alive) return "casualty-dead";
    if (!ps || !isConscious(ps) || !ps.impair.canUseArms) return "unable";
    if (isMounted(ps) || isMounted(cs)) return "mounted";
    if (actor !== casualty) {
      const pa = state.transform.req(actor), pb = state.transform.req(casualty);
      const r = ctx.catalog.medical!.care.buddyReachM + 1;
      const dx = pa.x - pb.x, dy = pa.y - pb.y;
      if (dx * dx + dy * dy > r * r) return "out-of-reach";
    }
    // A man on the move stops treating (an order, a drill) — except one stopping his own massive bleeding, unless he
    // has to run for it (out of a house that has become a trap: a bolt leg).
    const way = state.mover.get(actor)?.waypoints;
    if (way && way.length > 0 && (a.params["hold"] !== 1 || way[0]!.bolt === true)) return "moving";
    // Fire came down: only care allowed under fire goes on (checked twice a second).
    if ((state.tick + actor) % 30 === 0 && !ctx.catalog.medical!.interventions[String(a.params["intervention"])]?.underFire && underFireForCare(ctx, state, actor)) return "under-fire";
    if (!haveItems(state, itemsOf(a))) return "no-kit";
    return null;
  },
  complete(ctx, state, actor, a, events) {
    const casualty = Number(a.params["casualty"]);
    const M = ctx.catalog.medical!;
    const id = String(a.params["intervention"]);
    const def = M.interventions[id];
    const s = state.soldier.get(casualty);
    const w = s?.wounds.find((x) => x.id === Number(a.params["wound"]));
    if (!def || !s || !w) return;
    const items = itemsOf(a);
    const used: Record<string, number> = {};
    for (const it of items) {
      const c = state.container.get(it.from);
      const n = c ? removeItems(c, it.type, it.count).reduce((k, st) => k + st.count, 0) : 0;
      if (n > 0) used[it.type] = (used[it.type] ?? 0) + n;
    }
    const success = nextFloat(state.rng, Streams.medical) < Number(a.params["p"]);
    if (success) applyCareEffect(def, w, s.physiology);
    w.treatments.push({ tick: state.tick, by: actor, intervention: id, itemsUsed: used, success });
    events.emit({ kind: "medical.treated", tick: state.tick, casualty, by: actor, intervention: id, wound: w.id, success, skill: String(a.params["skill"]) });
    refreshStatus(ctx, state, events, casualty);
  },
});

/** Self-aid and buddy aid, every `care.stepS`. */
export function medicalSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  if (!careEnabled(ctx)) return;
  const C = ctx.catalog.medical!.care;
  const every = Math.max(1, secondsToTicks(C.stepS));
  if (state.tick % every !== 0) return;
  const params = ctx.physiologyParams;
  let busy: Map<EntityId, EntityId> | null = null;
  const reach2 = C.buddyReachM * C.buddyReachM;
  for (const [id, s] of state.soldier.entries()) {
    if (s.wounds.length === 0 || !s.physiology.alive || isMounted(s)) continue;
    busy ??= treatedNow(state);
    if (busy.has(id)) continue;
    // Self-aid first: a massive bleed at once, wherever he is; anything else once he has halted.
    if (canSelfAid(state, id)) {
      const fire = underFireForCare(ctx, state, id);
      const plan = nextIntervention(ctx.catalog, state, id, id, fire, params);
      if (plan) {
        const urgent = ctx.catalog.medical!.interventions[plan.intervention]!.underFire;
        const way = state.mover.get(id)?.waypoints ?? [];
        if ((urgent && way[0]?.bolt !== true) || way.length === 0) {
          startTreatment(ctx, state, events, id, id, plan, fire);
          busy.set(id, id);
          continue;
        }
      }
      // (He is awake and could treat himself, but nothing he can do: a comrade beside him may do what he cannot.)
    }
    if (s.captive !== null) continue; // a prisoner's care is his captors' (M10.8)
    // (A man awake and on the move is not treated by a comrade standing by: he walks on.)
    if (isConscious(s) && (state.mover.get(id)?.waypoints.length ?? 0) > 0) continue;
    // Buddy aid: the nearest free comrade of his side within reach (ties: the lower id).
    const side = state.identity.req(id).side;
    const t = state.transform.req(id);
    let best: EntityId | null = null, bestD = Infinity;
    // mounted: ok men aboard are never free helpers (freeHelper)
    for (const [m, ident] of state.identity.entries()) {
      if (m === id || ident.side !== side) continue;
      const o = state.transform.req(m);
      const dx = o.x - t.x, dy = o.y - t.y, d = dx * dx + dy * dy;
      if (d > reach2 || d >= bestD || Math.abs(o.z - t.z) > 1.5) continue;
      if (!freeHelper(state, m) || busy.has(m)) continue;
      best = m; bestD = d;
    }
    if (best === null) continue;
    const fire = underFireForCare(ctx, state, best);
    const plan = nextIntervention(ctx.catalog, state, best, id, fire, params);
    if (!plan) continue;
    startTreatment(ctx, state, events, best, id, plan, fire);
    busy.set(id, best);
  }
}
