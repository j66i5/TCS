/**
 * REDISTRIBUTION AND TAKING AMMUNITION (M11.2, plan slice 44; owner answers 2026-11-16 "taking kit", "no ammunition at
 * the red cross"). Values: core/behaviour.json `consolidate` (game values, low).
 *
 *   consolidation  A squad that has not been fired on for `quietS` evens out its able men's ammunition (looked at once
 *                  per squad every `stepS`): belts first (a machine gunner below `beltsMin` spare belts gets one from a
 *                  man who carries them), then magazines (no man `magGap` or more spare magazines above another of the
 *                  same weapon), then packages of loose rounds (`packageGap`). Each hand-over is a `bringAmmo` errand
 *                  ending in the generic `transferItems` action; at most `maxParallel` at a time per squad, between men
 *                  within `rangeM` of each other, both halted.
 *   own casualties A casualty (dead, unconscious, unable to fight, or at the nest) whose treatment is done — he has
 *                  been treated and nothing urgent is left — or who is dead (and known dead): the nearest able man of his squad within
 *                  `casualtyM` who is low (below `lowMags` spare magazines, a gunner below `beltsMin` belts), else the
 *                  man who treated him if the squad as a whole is low, goes and takes his magazines, belts, loose
 *                  rounds, grenades and rockets (`takeAmmo`, `takeS`), leaving a man who can still use his arms
 *                  `leaveMags` magazines. Never before the treatment (owner), never while he is cared for, carried or
 *                  checked.
 *   the nest       The Verwundetennest holds no ammunition (owner): a casualty lying there (on arrival, not only once
 *                  treated; review fix) has the magazine taken out of his weapon and hands all of it to the nearest
 *                  able man of his platoon within `nestHandM` (never a man wearing the red cross); with nobody there,
 *                  or as he is taken aboard an ambulance, it is left as a pile (an entity with a container)
 *                  `nestCacheM` from the nest, toward the platoon. Taking in the field waits for `quietS` since the
 *                  squad was last fired on, never sends a medic, and stops when the man is pinned (review fix).
 *   takeKit        On the player's order only (the AI never gives it): one man goes to an enemy casualty, prisoner or
 *                  a pile and takes the ammunition that fits a weapon he carries; if none fits, he swaps his rifle for
 *                  the enemy's rifle with its magazines (his own goes into his load as its `weaponItem`, so nothing
 *                  appears or vanishes). Disarming enemy wounded and prisoners is lawful: no conduct record.
 *
 * Every move of items is `transferItems` (rule 9); the ledger stays exact. No per-tick loop over men: squads are looked
 * at in turn, and the errands are stepped by the staggered decision step (decisions.ts).
 */
import { interruptAction, registerActionHandler, startAction } from "../actions";
import type { SoldierState, Unit } from "../components";
import type { Posture } from "../orders";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { secondsToTicks, TICK_HZ, type DefId, type EntityId } from "../ids";
import { isAble, isConscious } from "../impair";
import { isCowering } from "./morale";
import { indoorAt, routeBetween, routeWaypoints } from "../interior-nav";
import { freePlaceNear, isTaken, placesTaken } from "./occupy";
import { addItems, transferItems, type Container } from "../items";
import { atan2, hypot2 } from "../math";
import { careNeed } from "../medical";
import { isMounted } from "../mount";
import { navFor } from "../navctx";
import { wearsEmblem } from "../protection";
import type { SimState } from "../state";
import { newCache, putInCache } from "./supply";
import { stepBringAmmo } from "./decisions";
import { treatedNow } from "./medical";
import { requestPosture } from "./body";

type Consolidate = NonNullable<SimContext["catalog"]["behaviour"]["consolidate"]>;

/** Spare items of a type with something in them (a magazine with rounds; whole items count too). */
function spare(c: Container | undefined, type: DefId): number {
  let n = 0;
  if (c) for (const s of c.stacks) if (s.type === type && (s.charge === undefined || s.charge > 0)) n += s.count;
  return n;
}

/** Free for an errand of this kind: able, on foot, halted, not busy, not with a casualty, not shaken off his feet. */
function freeMan(state: SimState, id: EntityId): boolean {
  const s = state.soldier.get(id);
  if (!s || !isAble(s) || !s.impair.canWalk || !s.impair.canUseArms || isMounted(s) || s.evade !== null || state.action.has(id)) return false;
  if ((s.intent !== null && s.intent.returning !== true) || state.fire.has(id) || s.carrying !== undefined || s.atNest !== undefined || s.guard !== undefined || state.tick < s.stunnedUntilTick) return false;
  if (s.mental.behaviour === "panicked" || s.mental.behaviour === "routed" || s.mental.behaviour === "pinned") return false;
  return s.intent?.returning === true || (state.mover.get(id)?.waypoints.length ?? 0) === 0;
}

/**
 * Too shaken to go on with an errand to take ammunition (review fix): pinned or panicked, or suppressed as far as a
 * carrying party takes cover (`medical.carrying.holdSuppression`). The taking stops; he deals with the fire.
 */
export function shakenForErrand(ctx: SimContext, s: SoldierState): boolean {
  return isCowering(s) || s.mental.suppression >= (ctx.catalog.medical?.carrying?.holdSuppression ?? 0.3);
}

/** Where he stands now, kept on an errand's intent so that he walks back there afterwards. */
export function origin(state: SimState, id: EntityId): { x: number; y: number; z: number; heading: number; posture: Posture } {
  const t = state.transform.req(id), s = state.soldier.req(id), it = s.intent;
  // (Called away again on his way back: where he first stood stays his place.)
  if (it?.returning === true && it.x !== undefined && it.y !== undefined) return { x: it.x, y: it.y, z: it.z ?? 0, heading: it.heading ?? t.heading, posture: it.posture ?? s.posture };
  return { x: t.x, y: t.y, z: t.z, heading: t.heading, posture: s.posture };
}

/**
 * An errand whose hand-over or taking has begun (`intent.back`): once the action is over he walks back to where he
 * stood when he set out (his fighting position, his place in the formation). True: the intent was such an errand
 * (handled here).
 */
export function stepBack(ctx: SimContext, state: SimState, id: EntityId): boolean {
  const s = state.soldier.req(id), it = s.intent;
  if (it?.back !== true) return false;
  if (state.action.has(id)) return true;
  const t = state.transform.req(id), m = state.mover.get(id);
  const done = () => {
    s.intent = null;
    if (it.heading !== undefined && hypot2(t.x - (it.x ?? t.x), t.y - (it.y ?? t.y)) < 1.5) t.heading = it.heading;
    if (it.posture !== undefined && it.posture !== s.posture && isAble(s)) requestPosture(ctx, state, id, it.posture);
  };
  if (it.returning === true) {
    // (On his way back: the errand ends when he is there, or after two minutes whatever happens.)
    if (!m || m.waypoints.length === 0 || state.tick - it.tick > 120 * TICK_HZ) done();
    return true;
  }
  if (it.x === undefined || it.y === undefined || !isAble(s) || isMounted(s) || !m) { s.intent = null; return true; }
  if (hypot2(t.x - it.x, t.y - it.y) < 1.5) { done(); return true; }
  // (Balance pass 4 review: his place in a house taken meanwhile by another man of his side: a free one near it.)
  let to: { x: number; y: number; z: number; heading?: number; posture?: Posture | null } = { x: it.x, y: it.y, z: it.z ?? 0 };
  const bi = indoorAt(ctx, it.x, it.y);
  if (bi >= 0 && isTaken(placesTaken(state, id), to)) { const f = freePlaceNear(ctx, state, id, bi, it.x, it.y, to.z); if (f) to = f; }
  const leg = routeBetween(ctx, navFor(ctx, "foot").search, t.x, t.y, to.x, to.y, { maxExpansions: 6000, snapCells: 2 }, { sz: t.z, gz: to.z });
  if (!leg) { s.intent = null; return true; }
  m.waypoints = routeWaypoints(leg, { x: 0, y: 0, mode: it.kind === "bringAmmo" ? "walk" : "run" });
  m.formation = null; m.endPosture = to.posture ?? it.posture ?? s.homePosture ?? "crouching"; m.endHeading = to.heading ?? it.heading ?? null;
  s.intent = { ...it, returning: true, tick: state.tick };
  return true;
}

/** His weapon's feed (magazine or belt) and whether it is a machine gun's belt. */
function feedOf(ctx: SimContext, state: SimState, id: EntityId): { item: DefId; belt: boolean } | null {
  const w = state.weapon.get(id), wd = w ? ctx.catalog.weapons[w.weapon] : undefined;
  return wd ? { item: wd.feed.magazine, belt: wd.sustained !== undefined } : null;
}

/** Is he low on ammunition (below `lowMags` spare magazines; a gunner below `beltsMin` belts)? */
function isLow(ctx: SimContext, state: SimState, C: Consolidate, id: EntityId): boolean {
  const f = feedOf(ctx, state, id);
  if (!f) return false;
  return spare(state.container.get(id), f.item) < (f.belt ? C.beltsMin : C.lowMags);
}

/** Ammunition stacks of a container worth taking: magazines and belts with rounds, loose-round packages, whole rounds
 *  (grenades, rockets). `keep`: leave this many of `keepType` (the fullest stay). */
export function ammoStacks(ctx: SimContext, c: Container | undefined, keep = 0, keepType?: DefId): { type: DefId; count: number; charge?: number }[] {
  if (!c) return [];
  const out: { type: DefId; count: number; charge?: number }[] = [];
  // Fullest first, so the ones kept are the fullest.
  const stacks = [...c.stacks].sort((a, b) => (a.type !== b.type ? (a.type < b.type ? -1 : 1) : (b.charge ?? 0) - (a.charge ?? 0)));
  let left = keep;
  for (const s of stacks) {
    if (s.count <= 0) continue;
    const d = ctx.catalog.items[s.type];
    const rounds = d?.chargeItem !== undefined && ctx.catalog.ammo[d.chargeItem] !== undefined && (d.category === "magazine" || d.category === "ammo-package");
    const whole = s.charge === undefined && ctx.catalog.ammo[s.type] !== undefined;
    if (!(rounds && (s.charge ?? 0) > 0) && !whole) continue;
    let n = s.count;
    if (keepType !== undefined && s.type === keepType && left > 0) { const k = Math.min(left, n); left -= k; n -= k; }
    if (n > 0) out.push(s.charge === undefined ? { type: s.type, count: n } : { type: s.type, count: n, charge: s.charge });
  }
  return out;
}

/** The rounds in some stacks (charge, or one per whole round). */
function roundsIn(st: { count: number; charge?: number }): number { return st.charge === undefined ? st.count : st.count * st.charge; }

/** A casualty of his own side — dead, unconscious, wounded so that he can no longer fight, or lying at the
 *  Verwundetennest — not a prisoner, not aboard, not carried. */
function ownCasualty(state: SimState, c: EntityId, s: SoldierState): boolean {
  return (s.casualty !== "none" || !s.impair.canFight || s.atNest !== undefined) && s.captive === null && s.evacuated === undefined && !isMounted(s) && !state.carry.has(c) && s.carrying === undefined;
}

/**
 * Has his care been seen to (owner: only after treatment)? Dead: known dead (checked, when the battle has checks).
 * Alive: at least one treatment given, no urgent need left (massive bleeding, airway, breathing, shock), and nobody
 * treating him or on the way.
 */
function careDone(ctx: SimContext, state: SimState, c: EntityId, s: SoldierState, busy: () => Map<EntityId, EntityId>): boolean {
  if (busy().has(c)) return false;
  if (!s.physiology.alive) return ctx.catalog.medical?.down === undefined || s.checked?.dead === true;
  if (!s.wounds.some((w) => w.treatments.length > 0)) return false;
  // (Nothing urgent left: what is still open needs a medic or the aid station, not the men beside him.)
  if (ctx.catalog.medical !== undefined && careNeed(ctx.catalog, state, c, ctx.physiologyParams)?.urgent === true) return false;
  return true;
}

/** Men on errands to `c` (care, taking, a check), or an action on him. */
function busyWith(state: SimState): Map<EntityId, EntityId> {
  const out = treatedNow(state);
  for (const [actor, a] of state.action.entries()) {
    if (a.kind === "checkDown" || a.kind === "takeTag" || a.kind === "takeAmmo" || a.kind === "takeKit") out.set(Number(a.params["casualty"] ?? a.params["source"]), actor);
  }
  // mounted: ok a man aboard has no errand intent
  for (const [m, s] of state.soldier.entries()) {
    const it = s.intent;
    if (it && it.target !== undefined && (it.kind === "care" || it.kind === "takeAmmo" || it.kind === "takeKit")) out.set(it.target, m);
  }
  return out;
}

/** What a casualty keeps: `leaveMags` of his weapon's magazines while he can still use his arms. */
function keepOf(ctx: SimContext, state: SimState, C: Consolidate, c: EntityId, s: SoldierState): { keep: number; type?: DefId } {
  // (At the Verwundetennest he keeps nothing: no ammunition at the red cross, owner; review fix.)
  if (!isConscious(s) || !s.impair.canUseArms || s.atNest !== undefined) return { keep: 0 };
  const f = feedOf(ctx, state, c);
  return f ? { keep: C.leaveMags, type: f.item } : { keep: 0 };
}

export function consolidateSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  const C = ctx.catalog.behaviour.consolidate;
  if (!C || ctx.rules.refill === false) return; // (balance pass 3: not the supply chain's `resupply`)
  const every = Math.max(1, secondsToTicks(C.stepS));
  // (Who is busy with whom: worked out only if a casualty with ammunition is looked at this tick.)
  let map: Map<EntityId, EntityId> | null = null;
  const busy = () => (map ??= busyWith(state));
  for (const [uid, u] of state.unit.entries()) {
    if ((state.tick + uid) % every !== 0 || u.members.length === 0 || u.vehicle !== undefined || u.asset !== undefined) continue;
    // (Review fix: not while the squad is being fired on — `quietS` since it was last fired on.)
    if (state.tick - (u.ownFireTick ?? -1e9) >= secondsToTicks(C.quietS)) salvage(ctx, state, events, C, u, busy);
    // (Quiet since the squad was last fired on, or since the battle began; halted for `haltS`, not on the march.)
    if (!halted(state, u)) { delete u.haltedTick; continue; }
    u.haltedTick ??= state.tick;
    if (state.tick - (u.ownFireTick ?? 0) >= secondsToTicks(C.quietS) && state.tick - u.haltedTick >= secondsToTicks(C.haltS)) evenOut(ctx, state, events, C, u);
  }
  for (const [pid, p] of state.rear.entries()) {
    if (p.kind !== "medical" || (state.tick + pid) % every !== 0) continue;
    atNest(ctx, state, events, C, pid, busy);
  }
}

/** All the squad's able men on foot stand still (no route), men on a consolidation errand aside. */
function halted(state: SimState, u: Unit): boolean {
  for (const m of u.members) {
    const s = state.soldier.get(m);
    if (!s || !isAble(s) || isMounted(s)) continue;
    if ((s.intent?.kind === "bringAmmo" && s.intent.consolidate === true) || s.intent?.back === true) continue;
    if ((state.mover.get(m)?.waypoints.length ?? 0) > 0) return false;
  }
  return true;
}

/** Own casualties of squad `u`: the nearest low man (or his carer, the squad being low) goes to take his ammunition. */
function salvage(ctx: SimContext, state: SimState, events: EventSink, C: Consolidate, u: Unit, busy: () => Map<EntityId, EntityId>): void {
  let meanLow: boolean | null = null;
  for (const c of u.members) {
    const s = state.soldier.get(c);
    if (!s || !ownCasualty(state, c, s) || s.atNest !== undefined) continue;
    const k = keepOf(ctx, state, C, c, s);
    if (ammoStacks(ctx, state.container.get(c), k.keep, k.type).length === 0 || !careDone(ctx, state, c, s, busy)) continue;
    const ct = state.transform.req(c);
    let best: EntityId | null = null, bestD = C.casualtyM;
    for (const m of u.members) {
      // (Never a man wearing the red cross: he would carry the squad's munitions under it; review fix.)
      if (m === c || !freeMan(state, m) || !isLow(ctx, state, C, m) || wearsEmblem(ctx.catalog, state, m) || shakenForErrand(ctx, state.soldier.req(m))) continue;
      const t = state.transform.req(m);
      if (Math.abs(t.z - ct.z) > 1.5) continue;
      const d = hypot2(t.x - ct.x, t.y - ct.y);
      if (d < bestD) { bestD = d; best = m; }
    }
    if (best === null) {
      // Nobody low near him: the man who treated him last takes it if the squad as a whole is low.
      meanLow ??= squadLow(ctx, state, C, u);
      const by = lastCarer(s);
      if (meanLow && by !== null && u.members.includes(by) && freeMan(state, by) && !wearsEmblem(ctx.catalog, state, by) && !shakenForErrand(ctx, state.soldier.req(by))) {
        const t = state.transform.req(by);
        if (Math.abs(t.z - ct.z) <= 1.5 && hypot2(t.x - ct.x, t.y - ct.y) <= C.casualtyM) best = by;
      }
    }
    if (best === null) continue;
    state.soldier.req(best).intent = { kind: "takeAmmo", tick: state.tick, target: c, ...origin(state, best) };
    busy().set(c, best);
    stepTake(ctx, state, events, best);
  }
}

/** The mean able man of the squad holds fewer than `lowMags` spare magazines (or belts below `beltsMin`). */
function squadLow(ctx: SimContext, state: SimState, C: Consolidate, u: Unit): boolean {
  let n = 0, low = 0;
  for (const m of u.members) {
    if (!isAble(state.soldier.get(m))) continue;
    const f = feedOf(ctx, state, m);
    if (!f) continue;
    n++;
    low += spare(state.container.get(m), f.item) / (f.belt ? Math.max(1, C.beltsMin) : Math.max(1, C.lowMags));
  }
  return n > 0 && low / n < 1;
}

/** The man who treated him last (not himself), or null. */
function lastCarer(s: SoldierState): EntityId | null {
  let by: EntityId | null = null, tick = -1;
  for (const w of s.wounds) for (const t of w.treatments) if (t.by !== undefined && t.tick > tick) { tick = t.tick; by = t.by; }
  return by;
}

/**
 * A casualty at the Verwundetennest with ammunition (review fix: on arrival, not only after his treatment — no
 * ammunition at the red cross, owner): the magazine in his weapon comes out, then the nearest able man of his platoon
 * takes it all (never while someone is treating him), else it is left in a pile outside the nest.
 */
function atNest(ctx: SimContext, state: SimState, events: EventSink, C: Consolidate, pid: EntityId, busy: () => Map<EntityId, EntityId>): void {
  const p = state.rear.req(pid);
  // mounted: ok men aboard are not at a nest (ownCasualty)
  for (const [c, s] of state.soldier.entries()) {
    if (s.atNest !== pid || s.captive !== null || isMounted(s) || state.carry.has(c)) continue;
    unloadWeapon(state, c);
    const stacks = ammoStacks(ctx, state.container.get(c));
    if (stacks.length === 0 || busy().has(c)) continue;
    let best: EntityId | null = null, bestD = C.nestHandM;
    for (const m of menOfTop(state, p.unit)) {
      const ms = state.soldier.get(m);
      if (!isAble(ms) || ms!.atNest !== undefined || isMounted(ms)) continue;
      if (!freeMan(state, m) || wearsEmblem(ctx.catalog, state, m)) continue;
      const t = state.transform.req(m);
      const d = hypot2(t.x - p.x, t.y - p.y);
      if (d < bestD) { bestD = d; best = m; }
    }
    if (best !== null) {
      state.soldier.req(best).intent = { kind: "takeAmmo", tick: state.tick, target: c, ...origin(state, best) };
      busy().set(c, best);
      stepTake(ctx, state, events, best);
      continue;
    }
    pileOutsideNest(ctx, state, events, C, c, pid);
  }
}

/** The magazine in his weapon goes into his load (a counted item either way: the ledger is unchanged). */
function unloadWeapon(state: SimState, c: EntityId): void {
  const w = state.weapon.get(c), k = state.container.get(c);
  if (!w?.magazine || !k) return;
  addItems(k, w.magazine.item, 1, w.magazine.rounds);
  w.magazine = null;
}

/**
 * Casualty `c` at nest `pid`: all his ammunition is left in a pile outside the nest, `nestCacheM` from it toward his
 * platoon (a cache of his side, outside the clear zone). Also as he is taken aboard an ambulance (evacuation.ts):
 * nobody carries ammunition into it (owner). Review fix.
 */
export function pileOutsideNest(ctx: SimContext, state: SimState, events: EventSink, C: Consolidate | undefined, c: EntityId, pid: EntityId): void {
  const p = state.rear.get(pid);
  const CC = C ?? ctx.catalog.behaviour.consolidate;
  if (!p || !CC) return;
  unloadWeapon(state, c);
  const stacks = ammoStacks(ctx, state.container.get(c));
  if (stacks.length === 0) return;
  let cx = 0, cy = 0, n = 0;
  for (const m of menOfTop(state, p.unit)) {
    const ms = state.soldier.get(m);
    if (!isAble(ms) || ms!.atNest !== undefined || isMounted(ms)) continue;
    const t = state.transform.req(m);
    cx += t.x; cy += t.y; n++;
  }
  const dx = n > 0 ? cx / n - p.x : 1, dy = n > 0 ? cy / n - p.y : 0;
  const len = hypot2(dx, dy) || 1;
  const x = Math.min(Math.max(p.x + (dx / len) * CC.nestCacheM, 1), ctx.map.widthM - 1);
  const y = Math.min(Math.max(p.y + (dy / len) * CC.nestCacheM, 1), ctx.map.heightM - 1);
  // (M11.3: it is a cache of his side; outside the nest's clear zone, `nestCacheM` from it.)
  const side = state.identity.req(c).side;
  const pile = newCache(state, side, x, y, []);
  let moved = 0;
  for (const st of stacks) moved += putInCache(ctx, state, c, pile, st);
  if (moved === 0) { state.cache.delete(pile); state.container.delete(pile); state.transform.delete(pile); return; }
  events.emit({ kind: "items.dropped", tick: state.tick, from: c, cache: pile, x, y });
}

/** Every man of top unit `top` and its sub-units (ascending id). */
function menOfTop(state: SimState, top: EntityId): EntityId[] {
  const out: EntityId[] = [];
  const walk = (x: EntityId) => { const v = state.unit.get(x); if (!v) return; out.push(...v.members); for (const ch of v.children) walk(ch); };
  walk(top);
  return out.sort((a, b) => a - b);
}

/** Hand-overs of this squad under way (givers on their way or handing over now). */
function handOvers(state: SimState, u: Unit): { n: number; men: Set<EntityId> } {
  const men = new Set<EntityId>();
  let n = 0;
  for (const m of u.members) {
    const it = state.soldier.get(m)?.intent, a = state.action.get(m);
    if (it?.kind === "bringAmmo" && it.consolidate === true) {
      // (A man walking back after his hand-over no longer takes up one of the squad's hand-overs, and may be sent
      // again.)
      if (it.returning !== true) { n++; men.add(m); if (it.target !== undefined) men.add(it.target); }
    }
    else if (a?.kind === "transferItems" && a.params["c"] === 1) { n++; men.add(m); men.add(Number(a.params["to"])); }
  }
  return { n, men };
}

/** Consolidation: even out belts, then magazines, then loose rounds among the squad's able men. */
function evenOut(ctx: SimContext, state: SimState, events: EventSink, C: Consolidate, u: Unit): void {
  const h = handOvers(state, u);
  let slots = C.maxParallel - h.n;
  if (slots <= 0) return;
  // The squad's able men on foot, with their feed.
  const men: { id: EntityId; feed: DefId; belt: boolean; cart?: DefId; x: number; y: number; free: boolean }[] = [];
  for (const m of u.members) {
    const s = state.soldier.get(m);
    if (!s || !isAble(s) || !s.impair.canFight || isMounted(s) || s.carrying !== undefined || s.atNest !== undefined || h.men.has(m)) continue;
    if ((state.mover.get(m)?.waypoints.length ?? 0) > 0 && s.intent?.returning !== true) continue;
    const f = feedOf(ctx, state, m);
    if (!f) continue;
    const t = state.transform.req(m);
    const cart = ctx.catalog.items[f.item]?.chargeItem;
    men.push({ id: m, feed: f.item, belt: f.belt, ...(cart !== undefined ? { cart } : {}), x: t.x, y: t.y, free: freeMan(state, m) });
  }
  if (men.length < 2) return;
  const used = new Set<EntityId>();
  const near = (a: { x: number; y: number }, b: { x: number; y: number }) => hypot2(a.x - b.x, a.y - b.y) <= C.rangeM;
  const go = (giver: EntityId, to: EntityId, item: DefId): void => {
    used.add(giver); used.add(to); slots--;
    state.soldier.req(giver).intent = { kind: "bringAmmo", tick: state.tick, target: to, item, consolidate: true, ...origin(state, giver) };
    stepBringAmmo(ctx, state, events, giver);
  };
  // 1. Belts: a gunner below beltsMin gets one from whoever carries the most (not another gunner of that belt).
  //    Belts strictly first: while a belt is on its way to a gunner, magazines wait.
  let belts = false;
  for (const g of men) {
    if (slots <= 0) return;
    if (!g.belt || used.has(g.id)) continue;
    const have = spare(state.container.get(g.id), g.feed);
    if (have >= C.beltsMin) continue;
    let best: EntityId | null = null, bestN = 0;
    for (const o of men) {
      if (o.id === g.id || used.has(o.id) || !o.free || (o.belt && o.feed === g.feed) || !near(g, o)) continue;
      const n = spare(state.container.get(o.id), g.feed);
      if (n > bestN) { bestN = n; best = o.id; }
    }
    if (best !== null) { go(best, g.id, g.feed); belts = true; }
  }
  for (const m of u.members) { const it = state.soldier.get(m)?.intent; if (it?.kind === "bringAmmo" && it.consolidate === true && it.item !== undefined && ctx.catalog.weapons[state.weapon.get(it.target ?? -1)?.weapon ?? ""]?.sustained !== undefined) belts = true; }
  if (belts) return;
  // 2. Magazines, by weapon: the richest free man gives one to the poorest while they differ by magGap or more.
  // 3. Loose rounds, by cartridge: whole packages, while the counts differ by packageGap or more.
  const passes: { key: (m: typeof men[number]) => DefId | undefined; count: (m: typeof men[number]) => number; gap: number; item: (giver: EntityId, m: typeof men[number]) => DefId | undefined }[] = [
    { key: (m) => (m.belt ? undefined : m.feed), count: (m) => spare(state.container.get(m.id), m.feed), gap: C.magGap, item: (_g, m) => m.feed },
    { key: (m) => m.cart, count: (m) => packagesOf(ctx, state.container.get(m.id), m.cart).n, gap: C.packageGap, item: (g, m) => packagesOf(ctx, state.container.get(g), m.cart).type },
  ];
  for (const P of passes) {
    const groups = new Map<DefId, typeof men>();
    for (const m of men) { const k = P.key(m); if (k === undefined) continue; const g = groups.get(k); if (g) g.push(m); else groups.set(k, [m]); }
    for (const k of [...groups.keys()].sort()) {
      const g = groups.get(k)!;
      if (g.length < 2) continue;
      const counted = g.map((m) => ({ m, n: P.count(m) }));
      // The poorest (lowest count, then id) not already in a hand-over.
      const poor = counted.filter((x) => !used.has(x.m.id)).sort((a, b) => a.n - b.n || a.m.id - b.m.id)[0];
      if (!poor) continue;
      const rich = counted.filter((x) => x.m.id !== poor.m.id && !used.has(x.m.id) && x.m.free && x.n - poor.n >= P.gap && near(x.m, poor.m)).sort((a, b) => b.n - a.n || a.m.id - b.m.id)[0];
      if (!rich) continue;
      const item = P.item(rich.m.id, poor.m);
      if (item === undefined) continue;
      if (slots <= 0) return;
      go(rich.m.id, poor.m.id, item);
    }
  }
}

/** Packages of loose rounds of a cartridge he carries (with rounds in them), and the type of the fullest one. */
function packagesOf(ctx: SimContext, c: Container | undefined, cart: DefId | undefined): { n: number; type?: DefId } {
  let n = 0, type: DefId | undefined, best = -1;
  if (c && cart !== undefined) for (const s of c.stacks) {
    const d = ctx.catalog.items[s.type];
    if (d?.category !== "ammo-package" || d.chargeItem !== cart || (s.charge ?? 0) <= 0) continue;
    n += s.count;
    if ((s.charge ?? 0) > best) { best = s.charge ?? 0; type = s.type; }
  }
  return type === undefined ? { n } : { n, type };
}

// ---------------------------------------------------------------- taking (own casualties, enemy kit)

/** What `man` would take from `source` on a takeKit order: ammunition that fits his weapon, else a rifle swap. Null:
 *  nothing fits. */
export function kitPlan(ctx: SimContext, state: SimState, man: EntityId, source: EntityId): { take: { type: DefId; count: number; charge?: number }[]; swap: boolean } | null {
  const w = state.weapon.get(man), wd = w ? ctx.catalog.weapons[w.weapon] : undefined;
  const c = state.container.get(source);
  if (!wd || !c) return null;
  const fits = (feed: DefId) => {
    const cart = ctx.catalog.items[feed]?.chargeItem;
    return ammoStacks(ctx, c).filter((s) => s.type === feed || (cart !== undefined && ctx.catalog.items[s.type]?.category === "ammo-package" && ctx.catalog.items[s.type]?.chargeItem === cart));
  };
  const take = fits(wd.feed.magazine);
  if (take.length > 0) return { take, swap: false };
  // A rifleman may swap his rifle for the enemy's, with its magazines.
  const sw = state.weapon.get(source), swd = sw ? ctx.catalog.weapons[sw.weapon] : undefined;
  const rifle = (d: typeof wd | undefined) => d !== undefined && d.sustained === undefined && d.weaponItem !== undefined && (d.type === "rifle" || d.type === "carbine");
  if (!sw || !swd || !rifle(wd) || !rifle(swd) || swd.id === wd.id || state.soldier.get(source) === undefined) return null;
  const theirs = fits(swd.feed.magazine);
  if (theirs.length === 0 && (sw.magazine?.rounds ?? 0) <= 0) return null;
  return { take: theirs, swap: true };
}

/** Step a man's errand to take ammunition (own casualty) or kit (enemy, order): walk over, then the action. */
export function stepTake(ctx: SimContext, state: SimState, events: EventSink, id: EntityId): void {
  const C = ctx.catalog.behaviour.consolidate;
  const s = state.soldier.req(id), it = s.intent;
  if (!C || !it || (it.kind !== "takeAmmo" && it.kind !== "takeKit") || it.target === undefined) return;
  if (stepBack(ctx, state, id)) return;
  const src = it.target;
  const st = state.transform.get(src);
  if (!st || !state.container.has(src) || state.tick - it.tick > 120 * TICK_HZ || !isAble(s) || isMounted(s)) { s.intent = null; return; }
  if (state.action.has(id)) return;
  // (Review fix: fired on so that he goes to ground, he gives the errand up; his own rules take over.)
  if (it.kind === "takeAmmo" && shakenForErrand(ctx, s)) { s.intent = null; return; }
  const me = state.transform.req(id);
  const d = hypot2(me.x - st.x, me.y - st.y);
  if (d <= 2.0 && Math.abs(me.z - st.z) <= 1.5) {
    me.heading = atan2(st.y - me.y, st.x - me.x);
    const kind = it.kind;
    s.intent = it.x !== undefined ? { ...it, back: true } : null;
    const mv = state.mover.get(id);
    if (mv) mv.waypoints = []; // (he is there: the rest of his route is not walked)
    startAction(state, events, id, kind, secondsToTicks(kind === "takeKit" ? C.kitS : C.takeS), { source: src });
    return;
  }
  const m = state.mover.get(id);
  if (!m) { s.intent = null; return; }
  const last = m.waypoints[m.waypoints.length - 1];
  if (last && hypot2(last.x - st.x, last.y - st.y) < 1.5) return; // on his way
  const { search } = navFor(ctx, "foot");
  const leg = routeBetween(ctx, search, me.x, me.y, st.x, st.y, { maxExpansions: 6000, snapCells: 2 }, { sz: me.z, gz: st.z });
  if (!leg) { s.intent = null; return; }
  m.waypoints = routeWaypoints(leg, { x: 0, y: 0, mode: it.kind === "takeKit" ? "run" : "walk" });
  m.formation = null; m.endPosture = "crouching"; m.endHeading = null;
}

/** Beside the source, on his floor, still, able, not pinned down (review fix). */
function takeCheck(ctx: SimContext, state: SimState, actor: EntityId, src: EntityId): string | null {
  const s = state.soldier.get(actor);
  if (!s || !isAble(s) || !s.impair.canUseArms || isMounted(s)) return "unable";
  if (shakenForErrand(ctx, s)) return "suppressed";
  const a = state.transform.get(actor), b = state.transform.get(src);
  if (!a || !b || !state.container.has(src)) return "gone";
  if ((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y) > 2.5 * 2.5 || Math.abs(a.z - b.z) > 1.5) return "out-of-reach";
  if ((state.mover.get(actor)?.waypoints.length ?? 0) > 0) return "moving";
  return null;
}

/** Move stacks with transferItems and report each as taken. */
function takeStacks(ctx: SimContext, state: SimState, events: EventSink, from: EntityId, to: EntityId, stacks: readonly { type: DefId; count: number; charge?: number }[], source: "casualty" | "nest" | "enemy" | "cache", extra: { treated?: boolean; dead?: boolean }): void {
  for (const st of stacks) {
    const r = transferItems(ctx.catalog, state.container, st.charge === undefined ? { from, to, type: st.type, count: st.count } : { from, to, type: st.type, count: st.count, charge: st.charge });
    if (r.moved <= 0) continue;
    events.emit({ kind: "items.taken", tick: state.tick, from, to, item: st.type, count: r.moved, rounds: roundsIn({ count: r.moved, ...(st.charge !== undefined ? { charge: st.charge } : {}) }), source, ...extra });
  }
}

registerActionHandler("takeAmmo", {
  check(ctx, state, actor, a) {
    const src = Number(a.params["source"]);
    if (state.carry.has(src)) return "carried";
    return takeCheck(ctx, state, actor, src);
  },
  complete(ctx, state, actor, a, events) {
    const C = ctx.catalog.behaviour.consolidate, src = Number(a.params["source"]);
    const s = state.soldier.get(src);
    if (!C || !s || takeCheck(ctx, state, actor, src) !== null) return;
    // (Never before his treatment, owner: the gate again, now.)
    const busy = treatedNow(state);
    // (At the nest on arrival: no ammunition at the red cross, review fix.)
    if (s.atNest === undefined && !careDone(ctx, state, src, s, () => busy)) return;
    const k = keepOf(ctx, state, C, src, s);
    const treated = s.wounds.some((w) => w.treatments.length > 0);
    takeStacks(ctx, state, events, src, actor, ammoStacks(ctx, state.container.get(src), k.keep, k.type), s.atNest !== undefined ? "nest" : "casualty", { treated, dead: !s.physiology.alive });
  },
});

registerActionHandler("takeKit", {
  check(ctx, state, actor, a) {
    return takeCheck(ctx, state, actor, Number(a.params["source"]));
  },
  complete(ctx, state, actor, a, events) {
    const src = Number(a.params["source"]);
    if (takeCheck(ctx, state, actor, src) !== null) return;
    const plan = kitPlan(ctx, state, actor, src);
    if (!plan) return;
    const kind = state.soldier.has(src) ? "enemy" : "cache";
    if (plan.swap) swapRifle(ctx, state, events, actor, src);
    takeStacks(ctx, state, events, src, actor, plan.take, kind, {});
  },
});

/** He puts his rifle (and the magazine in it) into his load and takes up the enemy's rifle as it is. */
function swapRifle(ctx: SimContext, state: SimState, events: EventSink, man: EntityId, src: EntityId): void {
  const mine = state.weapon.req(man), theirs = state.weapon.req(src);
  const md = ctx.catalog.weapons[mine.weapon]!, c = state.container.req(man);
  addItems(c, md.weaponItem!, 1);
  if (mine.magazine) addItems(c, mine.magazine.item, 1, mine.magazine.rounds);
  const put = md.weaponItem!;
  mine.weapon = theirs.weapon;
  mine.magazine = theirs.magazine;
  mine.jammed = theirs.jammed;
  mine.burstLeft = 0; mine.burstIndex = 0;
  mine.lowAmmoReported = false; mine.lowAmmoRadioed = false;
  mine.nextShotTick = Math.max(mine.nextShotTick, state.tick + secondsToTicks(1));
  state.weapon.delete(src);
  // (His fire task, if any, was for the old weapon's range: he takes a new one when he next decides.)
  if (state.fire.get(man)?.self === true) state.fire.delete(man);
  events.emit({ kind: "weapon.swapped", tick: state.tick, soldier: man, from: src, weapon: mine.weapon, put });
}

/**
 * The player's `takeKit` order (validated: an enemy casualty or prisoner, or a pile): the nearest able man of the target
 * within `kitM` whose weapon something fits goes. True, or the radio key of the refusal.
 */
export function takeKitOrder(ctx: SimContext, state: SimState, events: EventSink, men: readonly EntityId[], source: EntityId): true | { unable: string } {
  const C = ctx.catalog.behaviour.consolidate;
  const st = state.transform.get(source);
  if (!C || !st) return { unable: "radio.kitNothing" };
  const cands = men.filter((m) => {
    const s = state.soldier.get(m);
    return isAble(s) && s!.impair.canWalk && s!.impair.canUseArms && !isMounted(s) && s!.carrying === undefined && s!.atNest === undefined && s!.intent?.kind !== "care"
      && s!.mental.behaviour !== "routed" && s!.mental.behaviour !== "panicked";
  }).map((m) => { const t = state.transform.req(m); return { m, d: hypot2(t.x - st.x, t.y - st.y) }; })
    .filter((x) => x.d <= C.kitM).sort((a, b) => a.d - b.d || a.m - b.m);
  if (cands.length === 0) return { unable: "radio.kitFar" };
  const who = cands.find((x) => kitPlan(ctx, state, x.m, source) !== null);
  if (!who) return { unable: "radio.kitNothing" };
  const s = state.soldier.req(who.m);
  interruptAction(state, events, who.m, "order");
  state.fire.delete(who.m);
  s.intent = { kind: "takeKit", tick: state.tick, target: source, ...origin(state, who.m) };
  const mv = state.mover.get(who.m);
  if (mv) mv.waypoints = [];
  stepTake(ctx, state, events, who.m);
  return true;
}

/** Is `source` something a takeKit order may name for side `side`: an enemy casualty or prisoner (dead or alive), or
 *  a pile on the ground (a container that is no man and no vehicle)? */
export function kitSource(state: SimState, side: string, source: EntityId): boolean {
  if (!state.container.has(source) || !state.transform.has(source) || state.vehicle.has(source)) return false;
  const s = state.soldier.get(source);
  if (!s) return !state.identity.has(source);
  const ss = state.identity.get(source)?.side;
  return ss !== undefined && ss !== side && (s.casualty !== "none" || s.captive !== null) && !isMounted(s);
}
