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
 * Same rules for every side, the player's and the AI's.
 *
 * CARERS (M10.3a). A casualty nobody beside him can help gets a carer who leaves the fight and goes to him
 * (`care` intent): a first responder or medic of his platoon when he looks urgent (T1: massive bleeding, airway,
 * breathing, shock), and a willing comrade (willingness from doctrine, behaviour, morale, suppression, same squad,
 * exposure; core/medical.json `carers`). At most the first responder plus one comrade per casualty (owner Q-2a).
 * A carer does not fire, is not moved by his unit's orders or drills (an order to him alone ends the errand),
 * treats on arrival with the same treat action, hands over to the first responder when he arrives, and goes back
 * to where he stood when there is nothing more he can do.
 */
import { registerActionHandler, startAction } from "../actions";
import type { Action } from "../components";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { secondsToTicks, type EntityId } from "../ids";
import { isAble, isConscious } from "../impair";
import { removeItems } from "../items";
import { routeBetween, routeWaypoints } from "../interior-nav";
import { applyCareEffect, careNeed, isResponder, nextIntervention, type CareItem, type CarePlan } from "../medical";
import { isMounted } from "../mount";
import { navFor } from "../navctx";
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
  if (!s || !isAble(s) || !s.impair.canUseArms || isMounted(s) || state.action.has(id) || state.fire.has(id) || s.evade !== null || s.intent?.kind === "care") return false;
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

/** A carer's errand ends: he goes back to where he stood (unless he cannot), with a `medical.carer` event. */
function releaseCarer(ctx: SimContext, state: SimState, events: EventSink, id: EntityId, reason: string, walkBack: boolean): void {
  const s = state.soldier.req(id), it = s.intent;
  if (it?.kind !== "care") return;
  s.intent = null;
  events.emit({ kind: "medical.carer", tick: state.tick, casualty: it.target ?? -1, by: id, responder: it.responder === true, assigned: false, reason });
  if (!walkBack || it.x === undefined || it.y === undefined || state.action.has(id)) return;
  const t = state.transform.req(id), m = state.mover.get(id);
  if (!m || Math.abs(t.x - it.x) + Math.abs(t.y - it.y) < 2) return;
  const leg = routeBetween(ctx, navFor(ctx, "foot").search, t.x, t.y, it.x, it.y, { maxExpansions: 6000, snapCells: 3 }, { sz: t.z, gz: it.z ?? 0 });
  if (!leg) return;
  m.waypoints = routeWaypoints(leg, { x: 0, y: 0, mode: "walk" });
  m.formation = null; m.endPosture = "prone"; m.endHeading = null;
}

/** Send a carer to (beside) the casualty: running, down on arrival. False if there is no way. */
function routeCarer(ctx: SimContext, state: SimState, id: EntityId, casualty: EntityId): boolean {
  const a = state.transform.req(id), b = state.transform.req(casualty), m = state.mover.get(id);
  if (!m) return false;
  // A step short of him, on the carer's side.
  const dx = a.x - b.x, dy = a.y - b.y, L = Math.max(1e-6, Math.abs(dx) + Math.abs(dy));
  const gx = b.x + (dx / L) * 1.2, gy = b.y + (dy / L) * 1.2;
  const last = m.waypoints[m.waypoints.length - 1];
  if (last && Math.abs(last.x - gx) + Math.abs(last.y - gy) < 2.5) return true; // already on his way
  const leg = routeBetween(ctx, navFor(ctx, "foot").search, a.x, a.y, gx, gy, { maxExpansions: 6000, snapCells: 3 }, { sz: a.z, gz: b.z });
  if (!leg) return false;
  m.waypoints = routeWaypoints(leg, { x: 0, y: 0, mode: "run" });
  m.formation = null; m.endPosture = "prone"; m.endHeading = null;
  return true;
}

/** Carers on their way or beside their casualty: carry the errand on, or end it. Returns who goes to whom. */
function stepCarers(ctx: SimContext, state: SimState, events: EventSink, busy: Map<EntityId, EntityId>): { responder: Map<EntityId, EntityId>; comrades: Map<EntityId, number> } {
  const M = ctx.catalog.medical!, C = M.care, K = M.carers!, params = ctx.physiologyParams;
  const responder = new Map<EntityId, EntityId>(), comrades = new Map<EntityId, number>();
  const carers: EntityId[] = [];
  // mounted: ok a carer who gets aboard is released below
  for (const [id, s] of state.soldier.entries()) if (s.intent?.kind === "care") carers.push(id);
  if (carers.length === 0) return { responder, comrades };
  const reach2 = C.buddyReachM * C.buddyReachM;
  const near = (a: EntityId, b: EntityId) => {
    const p = state.transform.req(a), q = state.transform.req(b);
    return (p.x - q.x) * (p.x - q.x) + (p.y - q.y) * (p.y - q.y) <= reach2 && Math.abs(p.z - q.z) <= 1.5;
  };
  // Responders first (a comrade hands over to one beside the casualty).
  carers.sort((a, b) => Number(state.soldier.req(b).intent!.responder === true) - Number(state.soldier.req(a).intent!.responder === true) || a - b);
  for (const id of carers) {
    const s = state.soldier.req(id), it = s.intent!, c = it.target ?? -1, cs = state.soldier.get(c);
    const treating = state.action.get(id)?.kind === "treat";
    if (!isAble(s) || !s.impair.canWalk || !s.impair.canUseArms || isMounted(s) || s.mental.behaviour === "panicked" || s.mental.behaviour === "routed") { releaseCarer(ctx, state, events, id, "unable", false); continue; }
    if (!cs || !cs.physiology.alive || isMounted(cs) || cs.captive !== null) { releaseCarer(ctx, state, events, id, "gone", true); continue; }
    if (state.tick - it.tick > secondsToTicks(K.timeoutS) && !treating) { releaseCarer(ctx, state, events, id, "gave-up", true); continue; }
    if (!treating && careNeed(ctx.catalog, state, c, params) === null) { releaseCarer(ctx, state, events, id, "done", true); continue; }
    const r = responder.get(c);
    if (it.responder !== true && r !== undefined && !treating && near(r, c)) { releaseCarer(ctx, state, events, id, "handed-over", true); continue; }
    if (it.responder === true) responder.set(c, id); else comrades.set(c, (comrades.get(c) ?? 0) + 1);
    if (treating) continue;
    if (near(id, c)) {
      const m = state.mover.get(id);
      if (m && m.waypoints.length > 0) { m.waypoints = []; m.speedMps = 0; }
      if (busy.has(c) || state.action.has(id)) continue;
      const fire = underFireForCare(ctx, state, id);
      const plan = nextIntervention(ctx.catalog, state, id, c, fire, params);
      if (plan) { startTreatment(ctx, state, events, id, c, plan, fire); busy.set(c, id); continue; }
      // Nothing he can do, even once the fire eases: he goes back (under fire he waits beside him).
      if (!fire || nextIntervention(ctx.catalog, state, id, c, false, params) === null) {
        if (it.responder === true) responder.delete(c); else comrades.set(c, (comrades.get(c) ?? 1) - 1);
        releaseCarer(ctx, state, events, id, "nothing-to-do", true);
      }
      continue;
    }
    if (!routeCarer(ctx, state, id, c)) {
      if (it.responder === true) responder.delete(c); else comrades.set(c, (comrades.get(c) ?? 1) - 1);
      releaseCarer(ctx, state, events, id, "no-way", true);
    }
  }
  return { responder, comrades };
}

/** Is he leading a unit (squad or platoon leaders do not leave their men)? */
function leads(state: SimState, id: EntityId): boolean {
  const u = state.identity.get(id)?.unit;
  return u !== undefined && state.unit.get(u)?.leader === id;
}

/**
 * The carer for `c`: the nearest willing free man of his side within reach (`responders`: first responders and
 * medics only, preferring his own squad's; else comrades who are not). Null if there is none.
 */
function pickCarer(ctx: SimContext, state: SimState, c: EntityId, responders: boolean, exposed: boolean): EntityId | null {
  const K = ctx.catalog.medical!.carers!;
  const ci = state.identity.req(c), ct = state.transform.req(c);
  const reach = responders ? K.responderReachM : K.comradeReachM, r2 = reach * reach;
  let best: EntityId | null = null, bestD = Infinity;
  // mounted: ok a man aboard is never a carer (checked below)
  for (const [m, ident] of state.identity.entries()) {
    if (m === c || ident.side !== ci.side) continue;
    const s = state.soldier.get(m);
    if (!s || !isAble(s) || !s.impair.canWalk || !s.impair.canUseArms || isMounted(s) || s.evade !== null || state.action.has(m)) continue;
    if (s.intent !== null && s.intent.kind !== "engage" && s.intent.kind !== "cover") continue;
    if (state.tick < s.stunnedUntilTick || (state.mover.get(m)?.waypoints.length ?? 0) > 0) continue;
    if (isResponder(ctx.catalog, state, m) !== responders || leads(state, m)) continue;
    const t = state.transform.req(m);
    const dx = t.x - ct.x, dy = t.y - ct.y;
    let d = dx * dx + dy * dy;
    if (d > r2) continue;
    const same = ident.unit === ci.unit;
    if (responders && same) d *= 0.25; // his own squad's first responder first
    if (d >= bestD) continue;
    // Willingness: doctrine, his state of mind, his own squad or not, the casualty under fire, his job.
    const prio = ctx.catalog.factions[ident.faction]?.doctrine["casualtyCarePriority"] ?? 0.5;
    const w = prio * (K.behaviourK[s.mental.behaviour] ?? 0) * s.mental.morale * Math.max(0, 1 - K.suppressionK * s.mental.suppression)
      * (same ? 1 : K.otherUnitK) * (exposed ? K.exposedK : 1) * (responders ? K.responderK : 1);
    if (w < K.willingAt) continue;
    best = m; bestD = d;
  }
  return best;
}

/** Send `m` to `c` as his carer (he leaves the fight). */
function assignCarer(ctx: SimContext, state: SimState, events: EventSink, m: EntityId, c: EntityId, responder: boolean): boolean {
  const t = state.transform.req(m);
  if (!routeCarer(ctx, state, m, c)) return false;
  state.fire.delete(m);
  state.soldier.req(m).intent = { kind: "care", tick: state.tick, target: c, x: t.x, y: t.y, ...(t.z > 0 ? { z: t.z } : {}), ...(responder ? { responder: true as const } : {}) };
  events.emit({ kind: "medical.carer", tick: state.tick, casualty: c, by: m, responder, assigned: true });
  return true;
}

/** Has `c` a carer on his way to him or beside him, or someone treating him? (Surrender: help is at hand.) */
export function hasCarer(state: SimState, c: EntityId): boolean {
  // mounted: ok boarding clears a carer's intent
  for (const [, s] of state.soldier.entries()) if (s.intent?.kind === "care" && s.intent.target === c) return true;
  for (const [, a] of state.action.entries()) if (a.kind === "treat" && Number(a.params["casualty"]) === c) return true;
  return false;
}

/** Self-aid, buddy aid and carers, every `care.stepS`. */
export function medicalSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  if (!careEnabled(ctx)) return;
  const C = ctx.catalog.medical!.care, K = ctx.catalog.medical!.carers;
  const every = Math.max(1, secondsToTicks(C.stepS));
  if (state.tick % every !== 0) return;
  const params = ctx.physiologyParams;
  let busy: Map<EntityId, EntityId> | null = null;
  // Carers on their errand first (they may start treating now, or go back).
  let slots: ReturnType<typeof stepCarers> | null = null;
  if (K) {
    // mounted: ok only looks for carers (stepCarers releases one aboard)
    for (const [, s] of state.soldier.entries()) if (s.intent?.kind === "care") { busy = treatedNow(state); break; }
    if (busy !== null) slots = stepCarers(ctx, state, events, busy);
  }
  const reach2 = C.buddyReachM * C.buddyReachM;
  const waiting: EntityId[] = [];
  for (const [id, s] of state.soldier.entries()) {
    if (s.wounds.length === 0 || !s.physiology.alive || isMounted(s)) continue;
    busy ??= treatedNow(state);
    if (busy.has(id)) { waiting.push(id); continue; }
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
        continue; // (he will see to it himself once he halts)
      }
      // (He is awake and could treat himself, but nothing he can do: a comrade beside him may do what he cannot.)
    }
    if (s.captive !== null) continue; // a prisoner's care is his captors' (M10.8)
    // (A man awake and on the move is not treated by a comrade standing by: he walks on.)
    if (isConscious(s) && (state.mover.get(id)?.waypoints.length ?? 0) > 0) continue;
    waiting.push(id);
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
  if (!K || waiting.length === 0) return;
  slots ??= { responder: new Map(), comrades: new Map() };
  // ---- carers for those who need more than the men beside them can give (owner Q-2a: the first responder plus at
  // most `comradesPerCasualty` comrades per casualty)
  for (const c of waiting) {
    const cs = state.soldier.req(c);
    if (cs.captive !== null) continue;
    const need = careNeed(ctx.catalog, state, c, params);
    if (!need) continue;
    const treater = busy!.get(c);
    const exposed = underFireForCare(ctx, state, c);
    let r = slots.responder.get(c), n = slots.comrades.get(c) ?? 0;
    // An urgent casualty: his first responder (or the platoon's medic).
    if (need.urgent && r === undefined) {
      const m = pickCarer(ctx, state, c, true, exposed);
      if (m !== null && nextIntervention(ctx.catalog, state, m, c, false, params) !== null && assignCarer(ctx, state, events, m, c, true)) { r = m; slots.responder.set(c, m); }
    }
    // A comrade: for an urgent casualty as well as the first responder; for any other when nobody is coming yet.
    // (Not while a man beside him is treating him already.)
    if (n < K.comradesPerCasualty && treater === undefined && (need.urgent || r === undefined)) {
      const m = pickCarer(ctx, state, c, false, exposed);
      if (m !== null && nextIntervention(ctx.catalog, state, m, c, false, params) !== null && assignCarer(ctx, state, events, m, c, false)) { n++; slots.comrades.set(c, n); }
      else if (!need.urgent && r === undefined && n === 0) {
        // Nobody else willing: a free first responder comes for him too.
        const f = pickCarer(ctx, state, c, true, exposed);
        if (f !== null && nextIntervention(ctx.catalog, state, f, c, false, params) !== null && assignCarer(ctx, state, events, f, c, true)) slots.responder.set(c, f);
      }
    }
  }
}
