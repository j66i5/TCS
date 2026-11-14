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
 *
 * TRIAGE, CARE UNDER FIRE, "MEDIC!" (M10.3b). The man who treats a casualty (a comrade, first responder or medic) tags
 * him T1/T2/T3 at his first treatment, sometimes wrongly (core/medical.json `triage`); a man of higher training, or
 * anyone once the tag is old, tags him again. A carer beside a casualty who cannot move himself and lies in the
 * enemy's view, with nothing he may do under fire (a tourniquet first), drags him to the nearest hidden spot (the
 * "drag" action: the carry data's drag speed; a comrade throws smoke to screen it); lying there, care is judged under
 * fire on the helper's own suppression only. The casualty's unit calls "Medic!" on the radio for an urgent casualty,
 * and "Man down, treating" when a comrade starts on him (each at most once per `care.radioCooldownS` per unit).
 */
import { registerActionHandler, startAction } from "../actions";
import type { Action, SoldierState } from "../components";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { secondsToTicks, type EntityId } from "../ids";
import { canReport, isAble, isConscious } from "../impair";
import { removeItems } from "../items";
import { indoorAt, routeBetween, routeWaypoints } from "../interior-nav";
import { applyCareEffect, careNeed, isResponder, nextIntervention, SKILL_RANK, triageTag, trueTriage, type CareItem, type CarePlan } from "../medical";
import type { CareSkill } from "../catalog";
import { atan2, cos, hypot2, PI, sin } from "../math";
import { isMounted } from "../mount";
import { navFor } from "../navctx";
import { nextFloat, Streams } from "../rng";
import type { SimState } from "../state";
import { requestPosture } from "./body";
import { coveredFrom, threatOf, unitThreat } from "./decisions";
import { screenCasualty } from "./smoke";
import { refreshStatus } from "./wounds";

/** Is care to be given by the rules (medical data present, not switched off)? */
export function careEnabled(ctx: SimContext): boolean {
  return ctx.catalog.medical !== undefined && ctx.rules.medicalCare !== false;
}

/**
 * Under fire for care (TCCC care under fire): his own suppression, or his unit fired on just now. With `casualty`
 * lying in cover he was dragged to (M10.3b), only his own suppression counts.
 */
export function underFireForCare(ctx: SimContext, state: SimState, id: EntityId, casualty?: EntityId): boolean {
  const C = ctx.catalog.medical!.care;
  const s = state.soldier.get(id);
  if (!s) return false;
  if (s.mental.suppression >= C.underFireSuppression) return true;
  if (casualty !== undefined && isSheltered(state, casualty)) return false;
  const uid = state.identity.get(id)?.unit;
  const own = uid !== undefined ? state.unit.get(uid)?.ownFireTick : undefined;
  return own !== undefined && state.tick - own <= secondsToTicks(C.underFireSeconds);
}

/** Does he lie where he was dragged into cover (M10.3b)? */
export function isSheltered(state: SimState, id: EntityId): boolean {
  const h = state.soldier.get(id)?.sheltered;
  if (!h) return false;
  const t = state.transform.req(id);
  return Math.abs(t.x - h.x) + Math.abs(t.y - h.y) <= 1.5;
}

/** A medical radio call by `from` for his unit (M10.3b): at most one of each kind per `care.radioCooldownS` per unit. */
function medRadio(ctx: SimContext, state: SimState, events: EventSink, from: EntityId, key: string): boolean {
  const uid = state.identity.get(from)?.unit, u = uid !== undefined ? state.unit.get(uid) : undefined;
  if (!u || !canReport(state.soldier.get(from))) return false;
  const last = u.medRadio?.[key];
  if (last !== undefined && state.tick - last < secondsToTicks(ctx.catalog.medical!.care.radioCooldownS)) return false;
  (u.medRadio ??= {})[key] = state.tick;
  events.emit({ kind: "radio", tick: state.tick, side: u.side, from, key, params: { callsign: u.callsign } });
  return true;
}

/** "Medic!" for an urgent casualty (M10.3b): he calls himself if he can speak, else the first man of his unit who can. */
function callMedic(ctx: SimContext, state: SimState, events: EventSink, c: EntityId, cs: SoldierState): void {
  if (cs.medicCalledTick !== undefined) return;
  let from: EntityId | null = canReport(cs) ? c : null;
  const uid = state.identity.get(c)?.unit, u = uid !== undefined ? state.unit.get(uid) : undefined;
  if (from === null && u) for (const m of u.members) if (m !== c && canReport(state.soldier.get(m)) && state.soldier.get(m)!.mount === undefined) { from = m; break; }
  if (from !== null && medRadio(ctx, state, events, from, "radio.medic")) cs.medicCalledTick = state.tick;
}

/** The training a man triages with: his medical job's (a first responder, a medic), else a comrade's. */
function triageSkill(ctx: SimContext, state: SimState, id: EntityId): Exclude<CareSkill, "self"> {
  const M = ctx.catalog.medical!, ident = state.identity.get(id);
  const role = ident ? ctx.catalog.factions[ident.faction]?.medicalRoles?.[ident.role] : undefined;
  const k = role ? M.levels[role.level].skill : "buddy";
  return k === "self" ? "buddy" : k;
}

/**
 * Triage by the man starting to treat `casualty` (M10.3b): the first tag, or a new one by a man of higher training or
 * when the tag is `triage.retriageS` old. "Man down, treating" on the radio with the first tag.
 */
function triage(ctx: SimContext, state: SimState, events: EventSink, by: EntityId, casualty: EntityId, underFire: boolean): void {
  const T = ctx.catalog.medical!.triage, cs = state.soldier.get(casualty);
  if (!cs || by === casualty) return;
  const skill = triageSkill(ctx, state, by), old = cs.triage;
  if (old && SKILL_RANK[skill] <= SKILL_RANK[old.skill] && state.tick - old.tick < secondsToTicks(T.retriageS)) return;
  const actual = trueTriage(ctx.catalog, state, casualty, ctx.physiologyParams);
  const u1 = nextFloat(state.rng, Streams.medical), u2 = nextFloat(state.rng, Streams.medical);
  const cat = triageTag(ctx.catalog, actual, skill, underFire, u1, u2);
  cs.triage = { cat, by, tick: state.tick, skill };
  events.emit({ kind: "medical.triaged", tick: state.tick, casualty, by, cat, actual, skill, underFire });
  if (!old) medRadio(ctx, state, events, by, "radio.treating");
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
  triage(ctx, state, events, performer, casualty, underFire);
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
    if ((state.tick + actor) % 30 === 0 && !ctx.catalog.medical!.interventions[String(a.params["intervention"])]?.underFire && underFireForCare(ctx, state, actor, casualty)) return "under-fire";
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

/** How often a carer under fire looks for a spot to drag his casualty to (s). */
const DRAG_LOOK_S = 4;

/** Behind the dragging man: where the casualty lies while he is dragged (m behind the helper's back). */
const DRAG_BEHIND_M = 0.9;

/**
 * The one-man drag (M10.3b): the helper backs to (gx, gy), crouched, at the carry data's drag speed (movement.ts caps
 * him), the casualty at his heels. Ends when he is there (the casualty then lies sheltered); interrupted when either
 * dies or is taken aboard or prisoner, or the helper can no longer drag or is sent elsewhere.
 */
registerActionHandler("drag", {
  check(_ctx, state, actor, a) {
    const c = Number(a.params["casualty"]);
    const cs = state.soldier.get(c), ps = state.soldier.get(actor);
    if (!cs || !cs.physiology.alive) return "casualty-dead";
    if (!ps || !isAble(ps) || !ps.impair.canWalk || !ps.impair.canUseArms) return "unable";
    if (isMounted(ps) || isMounted(cs) || cs.captive !== null) return "gone";
    const m = state.mover.get(actor), t = state.transform.req(actor);
    const gx = Number(a.params["gx"]), gy = Number(a.params["gy"]);
    if (!m || (m.waypoints.length === 0 && Math.abs(t.x - gx) + Math.abs(t.y - gy) > 2)) return "stopped";
    // The casualty at his heels.
    const ct = state.transform.req(c);
    ct.x = t.x - cos(t.heading) * DRAG_BEHIND_M; ct.y = t.y - sin(t.heading) * DRAG_BEHIND_M; ct.z = t.z; ct.heading = t.heading;
    const cm = state.mover.get(c);
    if (cm && cm.waypoints.length > 0) { cm.waypoints = []; cm.speedMps = 0; }
    return null;
  },
  done(_ctx, state, actor, a) {
    const t = state.transform.req(actor);
    return (state.mover.get(actor)?.waypoints.length ?? 0) === 0 && Math.abs(t.x - Number(a.params["gx"])) + Math.abs(t.y - Number(a.params["gy"])) <= 2;
  },
  complete(ctx, state, actor, a, events) {
    const c = Number(a.params["casualty"]);
    const cs = state.soldier.get(c), ct = state.transform.get(c), t = state.transform.req(actor);
    // (Out of time short of the spot: no shelter; the carer looks again.)
    if (!cs || !ct || Math.abs(t.x - Number(a.params["gx"])) + Math.abs(t.y - Number(a.params["gy"])) > 2) return;
    cs.sheltered = { x: ct.x, y: ct.y };
    requestPosture(ctx, state, actor, "prone");
    events.emit({ kind: "medical.dragged", tick: state.tick, casualty: c, by: actor, done: true, distanceM: Number(a.params["m"]) });
  },
});

/** The enemy a helper hides a casualty from: the nearest he knows, else where the rounds came from, else his unit's. */
function dragThreat(state: SimState, helper: EntityId, c: EntityId): { x: number; y: number; z: number } | null {
  const hs = state.soldier.req(helper);
  const t = threatOf(state, helper, hs);
  if (t) return t;
  const ff = state.soldier.get(c)?.fireFrom ?? hs.fireFrom, ct = state.transform.req(c);
  if (ff && state.tick - ff.tick <= secondsToTicks(30)) return { x: ct.x + ff.dx * 150, y: ct.y + ff.dy * 150, z: 0 };
  const uid = state.identity.get(helper)?.unit;
  return uid !== undefined ? unitThreat(state, helper, uid) : null;
}

/**
 * Care under fire (M10.3b; TCCC: move the casualty to cover). `helper` is beside casualty `c`; the nearest spot within
 * `care.dragSearchM` hidden (lying) from the enemy, not toward him, by a way at most `care.dragMaxM` long: a casualty
 * who can still walk goes there himself (the helper follows him), one who cannot is dragged there by the helper. A
 * casualty already hidden where he lies is marked sheltered. True if he is sheltered now or on his way to cover.
 */
function tryDrag(ctx: SimContext, state: SimState, events: EventSink, helper: EntityId, c: EntityId): boolean {
  const M = ctx.catalog.medical!, C = M.care, drag = M.carry["drag"];
  const cs = state.soldier.req(c), ct = state.transform.req(c), cm = state.mover.get(c);
  if (!drag || isSheltered(state, c) || ct.z !== 0 || indoorAt(ctx, ct.x, ct.y) >= 0) return false;
  const walks = isConscious(cs) && cs.impair.canWalk && state.tick >= cs.stunnedUntilTick;
  // Already on his way to the cover he was sent to.
  const end = cm?.waypoints[cm.waypoints.length - 1];
  if (walks && end && cs.sheltered && Math.abs(end.x - cs.sheltered.x) + Math.abs(end.y - cs.sheltered.y) < 1) return true;
  const threat = dragThreat(state, helper, c);
  if (!threat) return false;
  const lie = ctx.catalog.body.postures.prone.heightM * 0.6;
  if (coveredFrom(ctx, ct.x, ct.y, threat.x, threat.y, lie, 0, threat.z)) { cs.sheltered = { x: ct.x, y: ct.y }; return true; }
  const tl = hypot2(threat.x - ct.x, threat.y - ct.y) || 1, tx = (threat.x - ct.x) / tl, ty = (threat.y - ct.y) / tl;
  const { grid, search } = navFor(ctx, "foot");
  const cands: { x: number; y: number; r: number }[] = [];
  for (let ring = 1; ring <= 3 && cands.length === 0; ring++) {
    const r = (C.dragSearchM * ring) / 3;
    for (let k = 0; k < 12; k++) {
      const ang = (k * PI) / 6 + (ring % 2) * (PI / 12);
      const ux = cos(ang), uy = sin(ang);
      if (ux * tx + uy * ty > 0.3) continue; // not toward the enemy
      const x = ct.x + ux * r, y = ct.y + uy * r;
      if (x < 1 || y < 1 || x > ctx.map.widthM - 1 || y > ctx.map.heightM - 1) continue;
      const i = Math.floor(y / grid.cellM) * grid.cols + Math.floor(x / grid.cellM);
      if (grid.cost[i]! <= 0 || grid.wall[i] === 1 || indoorAt(ctx, x, y) >= 0) continue;
      if (!coveredFrom(ctx, x, y, threat.x, threat.y, lie, 0, threat.z)) continue;
      cands.push({ x, y, r });
    }
  }
  cands.sort((p, q) => p.r - q.r || p.x - q.x || p.y - q.y);
  for (const cnd of cands.slice(0, 3)) {
    // (Outdoors only: he is not dragged into or out of a house.)
    const leg = routeBetween(ctx, search, ct.x, ct.y, cnd.x, cnd.y, { maxExpansions: 1500, snapCells: 1 });
    if (!leg || leg.cost > C.dragMaxM) continue;
    const face = atan2(threat.y - cnd.y, threat.x - cnd.x);
    if (walks) {
      if (!cm) return false;
      // He goes himself, crouched; the helper follows him (his errand's way goes after the casualty).
      // (A flight pinning does not hold, like men leaving a house that has become a trap: he is told to go now.)
      cm.waypoints = routeWaypoints(leg, { x: 0, y: 0, mode: "run" }).map((w) => ({ ...w, posture: "crouching" as const, bolt: true as const }));
      cm.formation = null; cm.endPosture = "prone"; cm.endHeading = face;
      cs.sheltered = { x: cnd.x, y: cnd.y };
      return true;
    }
    const m = state.mover.get(helper);
    if (!m) return false;
    // He takes the casualty by the vest and pulls him along the way, the casualty at his heels.
    m.waypoints = routeWaypoints(leg, { x: 0, y: 0, mode: "walk" }).map((w) => ({ ...w, posture: "crouching" as const, bolt: true as const }));
    m.formation = null; m.endPosture = "prone"; m.endHeading = face;
    const ticks = secondsToTicks((leg.cost / Math.max(0.1, drag.speedMps)) * 3 + 20);
    startAction(state, events, helper, "drag", ticks, { casualty: c, gx: cnd.x, gy: cnd.y, m: Math.round(leg.cost) });
    events.emit({ kind: "medical.dragged", tick: state.tick, casualty: c, by: helper, done: false, distanceM: Math.round(leg.cost) });
    // A comrade of his unit screens the drag with smoke if he has a grenade (D1 hook; the helper's hands are full).
    screenCasualty(ctx, state, events, helper, c, { x: threat.x, y: threat.y });
    return true;
  }
  return false;
}

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
    const act = state.action.get(id)?.kind, treating = act === "treat" || act === "drag";
    if (!isAble(s) || !s.impair.canWalk || !s.impair.canUseArms || isMounted(s) || s.mental.behaviour === "panicked" || s.mental.behaviour === "routed") { releaseCarer(ctx, state, events, id, "unable", false); continue; }
    if (!cs || !cs.physiology.alive || isMounted(cs) || cs.captive !== null) { releaseCarer(ctx, state, events, id, "gone", true); continue; }
    if (state.tick - it.tick > secondsToTicks(K.timeoutS) && !treating) { releaseCarer(ctx, state, events, id, "gave-up", true); continue; }
    // A first responder or medic beside him triages him (again, if a comrade tagged him), whether or not he treats.
    if (it.responder === true && !treating && near(id, c)) triage(ctx, state, events, id, c, underFireForCare(ctx, state, id, c));
    if (!treating && careNeed(ctx.catalog, state, c, params) === null) { releaseCarer(ctx, state, events, id, "done", true); continue; }
    const r = responder.get(c);
    if (it.responder !== true && r !== undefined && !treating && near(r, c)) { releaseCarer(ctx, state, events, id, "handed-over", true); continue; }
    if (it.responder === true) responder.set(c, id); else comrades.set(c, (comrades.get(c) ?? 0) + 1);
    if (treating) continue;
    if (near(id, c)) {
      const m = state.mover.get(id);
      if (m && m.waypoints.length > 0) { m.waypoints = []; m.speedMps = 0; }
      if (busy.has(c) || state.action.has(id)) continue;
      const fire = underFireForCare(ctx, state, id, c);
      const plan = nextIntervention(ctx.catalog, state, id, c, fire, params);
      if (plan) { startTreatment(ctx, state, events, id, c, plan, fire); busy.set(c, id); continue; }
      // Care under fire (M10.3b): nothing he may do here; drag him into cover (looked at every few seconds).
      if (fire && (state.tick + id) % secondsToTicks(DRAG_LOOK_S) < secondsToTicks(C.stepS) && tryDrag(ctx, state, events, id, c)) { busy.set(c, id); continue; }
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
function pickCarer(ctx: SimContext, state: SimState, c: EntityId, responders: boolean, exposed: boolean, why?: { unwilling: number }): EntityId | null {
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
    if (w < K.willingAt) { if (why) why.unwilling++; continue; }
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
      const fire = underFireForCare(ctx, state, id, id);
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
    const fire = underFireForCare(ctx, state, best, id);
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
    if (!need) { if (cs.careWait !== undefined) delete cs.careWait; continue; }
    const treater = busy!.get(c);
    const exposed = underFireForCare(ctx, state, c, c);
    let r = slots.responder.get(c), n = slots.comrades.get(c) ?? 0;
    if (need.urgent) callMedic(ctx, state, events, c, cs);
    // Why nobody comes (debug overlay, M10.3b): men in reach but none willing, or the one willing cannot do anything.
    const why = { unwilling: 0 };
    let noKit = false;
    // An urgent casualty: his first responder (or the platoon's medic).
    if (need.urgent && r === undefined) {
      const m = pickCarer(ctx, state, c, true, exposed, why);
      if (m !== null && nextIntervention(ctx.catalog, state, m, c, false, params) === null) noKit = true;
      else if (m !== null && assignCarer(ctx, state, events, m, c, true)) { r = m; slots.responder.set(c, m); }
    }
    // A comrade: for an urgent casualty as well as the first responder; for any other when nobody is coming yet.
    // (Not while a man beside him is treating him already.)
    if (n < K.comradesPerCasualty && treater === undefined && (need.urgent || r === undefined)) {
      const m = pickCarer(ctx, state, c, false, exposed, why);
      const can = m !== null && nextIntervention(ctx.catalog, state, m, c, false, params) !== null;
      if (m !== null && !can) noKit = true;
      if (can && assignCarer(ctx, state, events, m, c, false)) { n++; slots.comrades.set(c, n); }
      else if (!need.urgent && r === undefined && n === 0) {
        // Nobody else willing: a free first responder comes for him too.
        const f = pickCarer(ctx, state, c, true, exposed, why);
        if (f !== null && nextIntervention(ctx.catalog, state, f, c, false, params) === null) noKit = true;
        else if (f !== null && assignCarer(ctx, state, events, f, c, true)) { r = f; slots.responder.set(c, f); }
      }
    }
    if (treater !== undefined || r !== undefined || n > 0) { if (cs.careWait !== undefined) delete cs.careWait; }
    else cs.careWait = noKit ? "no-kit" : why.unwilling > 0 ? (exposed ? "too-exposed" : "unwilling") : "nobody";
  }
}
