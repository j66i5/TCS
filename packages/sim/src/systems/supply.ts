/**
 * SUPPLY POINTS AND CACHES (M11.3, plan slice 45; owner answers 2026-11-16: the supply point is separate from the
 * Verwundetennest, no ammunition at the red cross, caches are legitimate targets, a captured cache becomes the
 * captor's). Values: core/supply.json (game values, low).
 *
 *   caches        A cache is an entity with a transform, a container and a `cache` record: a platoon's supply point
 *                 (kind "point"; a `rear` point of kind "supply" names it) or any other pile on the ground (crates of a
 *                 scenario, a casualty's ammunition left outside the nest, kind "cache").
 *   siting        `sitePoint` (nest.ts) like the nest, but never within `nestApartM` of the platoon's nest (and the nest
 *                 never within it of the supply point). Nothing with ammunition is put within `nestClearM` of any nest
 *                 (`putInCache` refuses it). An automatic point is sited on first need (`ensureSupplyPoint`: the
 *                 deliveries of slices 46-47); while empty it moves when threatened or left behind, like the nest.
 *   seen          Men of another side see a cache within `seeM` with a line of sight (looked at every `stepS` per
 *                 cache); once seen it stays known to that side (`known`). Its own side always knows it.
 *   blast, fire   A burst (explosions.ts `detonate`) within `blast.reachScaledM` x filling^(1/3) takes some of its `hp`
 *                 and may set it off (chance per kg of filling); at hp 0 it is set off. A burning vehicle or cache within
 *                 `cookoff.fireM` may set it off too. Set off, it burns `minS`-`maxS` s: its contents are lost step by
 *                 step (`items.destroyed`, cause "cookoff"; the ledger stays exact), explosive rounds in it go off one at
 *                 a time (blast and fragments, owner: the cache), rifle rounds only burn and pop. It smokes.
 *   capture       No able man of its side within `capture.holdM` and an able enemy within `capture.enemyM` for
 *                 `capture.seconds`: it becomes the enemy's (`cache.captured`; a supply point stops being one).
 *   orders        `supplyPoint` (the platoon's supply point here; it stays) and `resupplyAt` (the squad's men go to a
 *                 cache, take up to their standard load — every magazine and belt full, every bandolier and pack of
 *                 loose rounds full — and walk back to where they stood). Refused on the radio: no cache in reach,
 *                 nothing there for them, under fire, already full.
 *
 *   requests      M11.4a (plan slice 46): each squad on foot is looked at every `request.stepS`. Quiet, halted and an own
 *                 cache within `request.useM` with something for its short men: they go and take (the `resupplyAt`
 *                 errand). Otherwise, below `request.below` of its standard load (or a machine gunner below
 *                 `beltsBelow` belts), it radios for ammunition at most every `everyS`; with the standing rule "auto"
 *                 (the default; the AI's) the platoon sends bearers at once, with "ask" the player decides ("Send
 *                 bearers" on the squad's card, the order `bearers`).
 *   bearers       At most two men, one per unit: the headquarters' (never its leader), then the asking squad's man
 *                 nearest the supply point, then a man of a squad not fighting; never a gunner, a leader, a medic or
 *                 first responder (they would lose their protection), a crew-served weapon's man; never from a squad
 *                 in an assault, a clearing, a withdrawal or broken, nor one fired on within `bearers.contactS` (the
 *                 asking squad and the headquarters may give a man who fires on his own). They walk to the point
 *                 (taking cover where they are while pinned), load a crate of what the squad is short of (whole
 *                 packages: `crateMaxKg` for two, `maxKg` for one; `loadS`), carry it to the squad leader with the
 *                 carry store (methods `crate`, `load`: the M10.4a party rules, cover under fire, rests) and put it
 *                 down beside him: a cache the squad's men take from when quiet. The crate in their hands is a cache
 *                 (`carried`): it can be set off, nobody takes from it on the way.
 *
 * Same rules for every side, the player's and the computer's. `rules.resupply === false` switches the orders, the
 * requests, the bearers and the automatic siting off (caches still burn and are captured: they are things on the
 * ground).
 */
import { registerActionHandler, startAction } from "../actions";
import { onAir } from "../comms";
import type { Cache } from "../components";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { secondsToTicks, TICK_HZ, type DefId, type EntityId, type SideId } from "../ids";
import { isAble } from "../impair";
import { indoorAt, routeBetween, routeWaypoints } from "../interior-nav";
import { addItems, containerMassKg, countItems, emptyContainer, moveCharge, removeItems, transferItems, type Container, type ItemStack } from "../items";
import { atan2, cos, hypot2, PI, pow, sin } from "../math";
import { isResponder } from "../medical";
import { isMounted } from "../mount";
import { wearsEmblem } from "../protection";
import { navCostAt, nearestPassable } from "../nav";
import { navFor } from "../navctx";
import { isOffMap } from "../offmap";
import { ammoIndexOf } from "../projectiles";
import { nextFloat, nextRange, Streams } from "../rng";
import { addSmoke } from "../smoke";
import { newEntity, type SimState, type SimView } from "../state";
import { heightAt } from "../terrain";
import { requestPosture } from "./body";
import { bearersBack, endCarry, startCarry } from "./carry";
import { origin, shakenForErrand, stepBack } from "./consolidate";
import { coveredFrom } from "./decisions";
import { detonate } from "./explosions";
import { isCowering } from "./morale";
import { tubeOf } from "./mortars";
import { nestOf, sitePoint, supplyPointOf, topOf } from "./nest";

type Supply = NonNullable<SimContext["catalog"]["supply"]>;

/** A man takes from a cache within this distance (m): the end of his route may lie a cell or so off a crate that stands
 *  against a wall. */
const TAKE_REACH_M = 4.5;

// ---------------------------------------------------------------- caches and points

/** A new cache at (x, y) with these stacks (an entity with a transform, a container and a cache record). */
export function newCache(state: SimState, side: SideId, x: number, y: number, load: readonly ItemStack[], kind: Cache["kind"] = "cache"): EntityId {
  const id = newEntity(state);
  state.transform.set(id, { x, y, z: 0, heading: 0 });
  const c = emptyContainer();
  for (const st of load) addItems(c, st.type, st.count, st.charge);
  state.container.set(id, c);
  state.cache.set(id, { side, kind, hp: 1, sitedTick: state.tick, checkTick: state.tick });
  return id;
}

/** Does any of these stacks hold ammunition (rounds in a magazine or package, or a whole round)? */
function isAmmo(ctx: SimContext, type: DefId): boolean {
  const d = ctx.catalog.items[type];
  return ctx.catalog.ammo[type] !== undefined || (d?.chargeItem !== undefined && ctx.catalog.ammo[d.chargeItem] !== undefined);
}

/** Is (x, y) inside a Verwundetennest's clear zone (owner: no ammunition at the red cross)? */
export function nearNest(ctx: SimContext, state: SimState, x: number, y: number, r?: number): boolean {
  const R = r ?? ctx.catalog.supply?.nestClearM ?? 0;
  if (R <= 0) return false;
  for (const [, p] of state.rear.entries()) if (p.kind === "medical" && (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y) < R * R) return true;
  return false;
}

/**
 * Put a stack from container `from` into cache `cache` (`transferItems`). Ammunition is refused when the cache lies
 * inside a nest's clear zone (owner): returns the number moved (0 when refused).
 */
export function putInCache(ctx: SimContext, state: SimState, from: EntityId, cache: EntityId, st: ItemStack): number {
  const t = state.transform.get(cache);
  if (!t || !state.container.has(cache)) return 0;
  // (Review fix: nothing goes into a cache that burns or has burnt out.)
  const c = state.cache.get(cache);
  if (c !== undefined && (c.burnt === true || c.cookoff !== undefined)) return 0;
  if (isAmmo(ctx, st.type) && nearNest(ctx, state, t.x, t.y)) return 0;
  return transferItems(ctx.catalog, state.container, st.charge === undefined ? { from, to: cache, type: st.type, count: st.count } : { from, to: cache, type: st.type, count: st.count, charge: st.charge }).moved;
}

/** Does a container hold anything (review fix): an item with its charge left, or a whole item; emptied packages, tins,
 *  belts and cans stay behind as counted items but make nobody's cache worth taking, setting off, capturing or
 *  shelling. */
export function cacheHolds(c: { readonly stacks: readonly { readonly count: number; readonly charge?: number }[] } | undefined): boolean {
  if (c) for (const s of c.stacks) if (s.count > 0 && (s.charge === undefined || s.charge > 0)) return true;
  return false;
}

/** Rounds of ammunition in a container (charge of magazines and packages, whole rounds). */
export function roundsInContainer(ctx: SimContext, c: Container | undefined): number {
  let n = 0;
  if (c) for (const s of c.stacks) {
    if (s.charge !== undefined) { if (ctx.catalog.items[s.type]?.chargeItem !== undefined) n += s.charge * s.count; }
    else if (ctx.catalog.ammo[s.type] !== undefined) n += s.count;
  }
  return n;
}

/** Make cache `cache` the supply point of top unit `top` (a `rear` point of kind "supply"). */
function makePoint(state: SimState, events: EventSink, top: EntityId, cache: EntityId, placed: boolean, reason: "sited" | "ordered" | "scenario"): EntityId {
  const u = state.unit.req(top), t = state.transform.req(cache), c = state.cache.req(cache);
  c.kind = "point"; c.top = top;
  if (placed) c.placed = true; else delete c.placed;
  let pid = supplyPointOf(state, top);
  if (pid === null) {
    pid = newEntity(state);
    state.rear.set(pid, { kind: "supply", side: u.side, unit: top, x: t.x, y: t.y, cache, sitedTick: state.tick, checkTick: state.tick, ...(placed ? { placed: true as const } : {}) });
  } else {
    const p = state.rear.req(pid);
    p.x = t.x; p.y = t.y; p.cache = cache; p.sitedTick = state.tick; p.checkTick = state.tick;
    if (placed) p.placed = true; else delete p.placed;
  }
  events.emit({ kind: "supply.point", tick: state.tick, side: u.side, point: pid, cache, unit: top, x: Math.round(t.x), y: Math.round(t.y), reason });
  return pid;
}

/** A cache stops being a supply point (captured, or replaced by an order). */
function unPoint(state: SimState, cache: EntityId): void {
  const c = state.cache.get(cache);
  if (!c || c.kind !== "point") return;
  c.kind = "cache";
  if (c.top !== undefined) { const pid = supplyPointOf(state, c.top); if (pid !== null && state.rear.get(pid)?.cache === cache) state.rear.delete(pid); }
  delete c.top;
}

/**
 * The supply point of top unit `top`, sited now if it has none (the deliveries of slices 46-47 call this). Null if the
 * platoon has nobody left to site it from, or supply is off.
 */
export function ensureSupplyPoint(ctx: SimContext, state: SimState, events: EventSink, top: EntityId): EntityId | null {
  const S = ctx.catalog.supply;
  if (!S || ctx.rules.resupply === false) return null;
  const pid = supplyPointOf(state, top);
  if (pid !== null) return pid;
  const at = siteSupply(ctx, state, top);
  if (!at) return null;
  const cache = newCache(state, state.unit.req(top).side, at.x, at.y, [], "point");
  return makePoint(state, events, top, cache, false, "sited");
}

/** Where top unit `top`'s supply point goes: like the nest, never within `nestApartM` of its nest. */
export function siteSupply(ctx: SimContext, state: SimState, top: EntityId): { x: number; y: number } | null {
  const S = ctx.catalog.supply;
  if (!S) return null;
  const nid = nestOf(state, top);
  const nest = nid === null ? undefined : state.rear.req(nid);
  return sitePoint(ctx, state, top, S.site, nest ? { x: nest.x, y: nest.y, r: S.nestApartM } : undefined);
}

/** Setup (M11.3): crates of a force marked as its supply point serve the nearest platoon of that side. */
export function pointForCache(state: SimState, events: EventSink, cache: EntityId): void {
  const c = state.cache.req(cache), t = state.transform.req(cache);
  let best: EntityId | null = null, bestD = Infinity;
  for (const [uid, u] of state.unit.entries()) {
    if (u.side !== c.side || u.parent !== null || u.vehicle !== undefined || u.asset !== undefined || u.mortar !== undefined || u.missileTeam !== undefined) continue;
    let cx = 0, cy = 0, n = 0;
    const walk = (x: EntityId) => { const v = state.unit.get(x); if (!v) return; for (const m of v.members) { const mt = state.transform.get(m); if (mt) { cx += mt.x; cy += mt.y; n++; } } for (const ch of v.children) walk(ch); };
    walk(uid);
    if (n === 0) continue;
    const d = hypot2(cx / n - t.x, cy / n - t.y);
    if (d < bestD) { bestD = d; best = uid; }
  }
  if (best !== null && supplyPointOf(state, best) === null) makePoint(state, events, best, cache, true, "scenario");
}

// ---------------------------------------------------------------- the system

/** Caches each `stepS` (who sees them, capture, fire beside them, an automatic point's move) and cook-offs. */
export function supplySystem(ctx: SimContext, state: SimState, events: EventSink): void {
  const S = ctx.catalog.supply;
  if (!S || state.cache.size === 0) return;
  const every = Math.max(1, secondsToTicks(S.stepS));
  for (const [id, c] of state.cache.entries()) {
    if (c.cookoff !== undefined && state.tick >= c.cookoff.nextTick) stepCookoff(ctx, state, events, S, id, c);
    if ((state.tick + id) % every !== 0) continue;
    look(ctx, state, events, S, id, c);
  }
}

/** One cache's look (every `stepS`). */
function look(ctx: SimContext, state: SimState, events: EventSink, S: Supply, id: EntityId, c: Cache): void {
  const t = state.transform.req(id);
  // (M11.4a: a crate whose bearers are all gone — ordered away, hit — lies where it is as an ordinary cache.)
  if (c.carried === true && !state.carry.has(id) && !bearerHolds(state, id)) delete c.carried;
  // (Review fix: a crate on the move is not where the enemy saw it: they have to see it again where it is put down.)
  if (c.carried === true && c.known !== undefined) delete c.known;
  const full = cacheHolds(state.container.get(id));
  // (Emptied and not a supply point: nothing about it matters any more.)
  if (!full && c.kind !== "point") { if (c.holdTick !== undefined) delete c.holdTick; return; }
  // ---- men about it: its own side near, enemies at it, other sides that see it
  const hold2 = S.capture.holdM * S.capture.holdM, at2 = S.capture.enemyM * S.capture.enemyM, see2 = S.seeM * S.seeM;
  let own = false;
  let enemy: SideId | null = null;
  let seeing: SideId[] | null = null;
  // mounted: ok men aboard are skipped
  for (const [m, s] of state.soldier.entries()) {
    if (!isAble(s) || isMounted(s) || s.captive !== null) continue;
    const side = state.identity.get(m)?.side;
    if (side === undefined) continue;
    const mt = state.transform.get(m);
    if (!mt) continue;
    const d2 = (mt.x - t.x) * (mt.x - t.x) + (mt.y - t.y) * (mt.y - t.y);
    if (side === c.side) { if (d2 <= hold2) own = true; continue; }
    if (d2 <= at2 && enemy === null) enemy = side;
    if (d2 <= see2 && !(c.known?.includes(side) ?? false) && !(seeing?.includes(side) ?? false)) {
      if (d2 <= at2 || !coveredFrom(ctx, t.x, t.y, mt.x, mt.y, S.heightM, 0, mt.z)) (seeing ??= []).push(side);
    }
  }
  if (seeing) {
    const k = c.known ?? [];
    for (const sd of seeing) if (!k.includes(sd)) k.push(sd);
    k.sort();
    c.known = k;
    for (const sd of seeing) events.emit({ kind: "cache.seen", tick: state.tick, cache: id, side: sd });
  }
  // ---- capture
  if (full && enemy !== null && !own && c.cookoff === undefined) {
    c.holdTick ??= state.tick;
    if (state.tick - c.holdTick >= secondsToTicks(S.capture.seconds)) capture(ctx, state, events, id, c, enemy);
  } else if (c.holdTick !== undefined) delete c.holdTick;
  // ---- fire beside it (a burning vehicle, a cache cooking off)
  if (full && c.cookoff === undefined && S.cookoff.fireM > 0) {
    const r2 = S.cookoff.fireM * S.cookoff.fireM;
    let fire = false;
    for (const [vid, v] of state.vehicle.entries()) {
      if (v.fire === null || isOffMap(v)) continue;
      const vt = state.transform.get(vid);
      if (vt && (vt.x - t.x) * (vt.x - t.x) + (vt.y - t.y) * (vt.y - t.y) <= r2) { fire = true; break; }
    }
    if (!fire) for (const [oid, o] of state.cache.entries()) {
      if (oid === id || o.cookoff === undefined) continue;
      const ot = state.transform.req(oid);
      if ((ot.x - t.x) * (ot.x - t.x) + (ot.y - t.y) * (ot.y - t.y) <= r2) { fire = true; break; }
    }
    if (fire && nextFloat(state.rng, Streams.supply) < S.cookoff.fireChancePerS * S.stepS) ignite(ctx, state, events, S, id, c, "fire");
  }
  // ---- an automatic supply point, empty: it follows the platoon or moves away from a threat (like the nest)
  if (c.kind === "point" && c.placed !== true && !full && c.top !== undefined && ctx.rules.resupply !== false && state.tick - c.checkTick >= secondsToTicks(S.site.checkS)) {
    c.checkTick = state.tick;
    movePoint(ctx, state, events, S, id, c);
  }
}

/** An empty automatic supply point: moved when an enemy is known within `threatM` or it lies `driftM` behind. */
function movePoint(ctx: SimContext, state: SimState, events: EventSink, S: Supply, id: EntityId, c: Cache): void {
  const t = state.transform.req(id), top = c.top!;
  let cx = 0, cy = 0, n = 0, threat = false;
  const r2 = S.site.threatM * S.site.threatM;
  const walk = (x: EntityId) => {
    const v = state.unit.get(x); if (!v) return;
    for (const m of v.members) {
      const s = state.soldier.get(m), mt = state.transform.get(m);
      if (!s || !mt || !isAble(s)) continue;
      cx += mt.x; cy += mt.y; n++;
      if (!threat) for (const k of s.contacts) if (!k.down && !k.surrendered && (k.x - t.x) * (k.x - t.x) + (k.y - t.y) * (k.y - t.y) <= r2) { threat = true; break; }
    }
    for (const ch of v.children) walk(ch);
  };
  walk(top);
  if (n === 0) return;
  if (!threat && hypot2(cx / n - t.x, cy / n - t.y) <= S.site.driftM) return;
  const at = siteSupply(ctx, state, top);
  if (!at || hypot2(at.x - t.x, at.y - t.y) < 10) return;
  t.x = at.x; t.y = at.y;
  c.sitedTick = state.tick;
  delete c.known; // (review fix: moved, it is no longer where the enemy saw it)
  makePoint(state, events, top, id, false, "sited");
}

/** Cache `id` becomes side `by`'s. */
function capture(ctx: SimContext, state: SimState, events: EventSink, id: EntityId, c: Cache, by: SideId): void {
  const from = c.side;
  unPoint(state, id);
  c.from = from; c.side = by; c.capturedBy = by;
  delete c.holdTick;
  const k = c.known ?? [];
  if (!k.includes(from)) { k.push(from); k.sort(); }
  c.known = k.filter((sd) => sd !== by);
  if (c.known.length === 0) delete c.known;
  events.emit({ kind: "cache.captured", tick: state.tick, cache: id, side: by, from, rounds: roundsInContainer(ctx, state.container.get(id)) });
}

// ---------------------------------------------------------------- blast and cook-off

/**
 * A burst of `fillingKg` at (x, y, z) (explosions.ts): caches within reach lose hp and may be set off. Cheap without
 * caches.
 */
export function cacheBurst(ctx: SimContext, state: SimState, events: EventSink, x: number, y: number, fillingKg: number): void {
  const S = ctx.catalog.supply;
  if (!S || state.cache.size === 0 || fillingKg <= 0) return;
  const R = S.blast.reachScaledM * pow(fillingKg, 1 / 3);
  for (const [id, c] of state.cache.entries()) {
    if (c.cookoff !== undefined || c.burnt === true) continue;
    const t = state.transform.req(id);
    const dx = t.x - x, dy = t.y - y;
    if (dx > R || dx < -R || dy > R || dy < -R) continue;
    const d = hypot2(dx, dy);
    if (d > R) continue;
    const f = 1 - d / R;
    if (!cacheHolds(state.container.get(id))) continue;
    c.hp = Math.max(0, c.hp - f * Math.min(1, fillingKg / S.blast.hpKg));
    const chance = f * Math.min(S.blast.maxChance, fillingKg * S.blast.chancePerKg);
    if (c.hp <= 0 || nextFloat(state.rng, Streams.supply) < chance) ignite(ctx, state, events, S, id, c, "blast");
  }
}

/** The chance that a burst of `fillingKg` at distance `d` sets a full cache off (one burst; the lab's table). */
export function cookoffChance(S: Supply, fillingKg: number, d: number, hp = 1): number {
  const R = S.blast.reachScaledM * pow(fillingKg, 1 / 3);
  if (d > R) return 0;
  const f = 1 - d / R;
  if (hp - f * Math.min(1, fillingKg / S.blast.hpKg) <= 0) return 1;
  return f * Math.min(S.blast.maxChance, fillingKg * S.blast.chancePerKg);
}

/** Does the cache hold explosive rounds (whole rounds, or rounds in a crate whose cartridge is explosive)? */
function explosiveIn(ctx: SimContext, c: Container | undefined): boolean {
  if (c) for (const s of c.stacks) { const a = ammoOfStack(ctx, s.type); if (a !== undefined && ctx.catalog.ammo[a]?.explosive !== undefined) return true; }
  return false;
}

/** The ammunition id of a stack's rounds (whole round: its own id; a magazine or package: its cartridge). */
function ammoOfStack(ctx: SimContext, type: DefId): DefId | undefined {
  if (ctx.catalog.ammo[type] !== undefined) return type;
  const ci = ctx.catalog.items[type]?.chargeItem;
  return ci !== undefined && ctx.catalog.ammo[ci] !== undefined ? ci : undefined;
}

/** Set cache `id` off: it burns for `minS`-`maxS` s. */
export function ignite(ctx: SimContext, state: SimState, events: EventSink, S: Supply, id: EntityId, c: Cache, cause: "blast" | "fire"): void {
  if (c.cookoff !== undefined || c.burnt === true || !cacheHolds(state.container.get(id))) return;
  const dur = nextRange(state.rng, Streams.supply, S.cookoff.minS, S.cookoff.maxS);
  const bursts = explosiveIn(ctx, state.container.get(id));
  c.cookoff = { startTick: state.tick, endTick: state.tick + secondsToTicks(dur), nextTick: state.tick + 1, bursts };
  delete c.holdTick;
  // (A crate set off in bearers' hands: they drop it, M11.4a.)
  if (c.carried === true) { if (state.carry.has(id)) endCarry(ctx, state, events, id, "gone"); delete c.carried; }
  const t = state.transform.req(id);
  if (S.cookoff.smokeRadiusM > 0) addSmoke(ctx, state, t.x, t.y, S.cookoff.smokeRadiusM, dur, S.cookoff.smokeTopM, dur);
  events.emit({ kind: "cache.cookoff", tick: state.tick, cache: id, side: c.side, cause, bursts, endTick: c.cookoff.endTick });
}

/** One step of a cook-off: a share of every stack is lost; an explosive round in it goes off. */
function stepCookoff(ctx: SimContext, state: SimState, events: EventSink, S: Supply, id: EntityId, c: Cache): void {
  const k = c.cookoff!, step = Math.max(1, secondsToTicks(S.cookoff.stepS));
  const cont = state.container.get(id);
  const last = state.tick >= k.endTick;
  const left = last ? 1 : Math.max(1, Math.ceil((k.endTick - state.tick) / step));
  const t = state.transform.req(id);
  let bursts = 0;
  if (cont) {
    const stacks = cont.stacks.map((s) => ({ type: s.type, count: s.count, ...(s.charge !== undefined ? { charge: s.charge } : {}) }));
    for (const s of stacks) {
      if (s.count <= 0) continue;
      const ammo = ammoOfStack(ctx, s.type);
      let items = 0, rounds: number;
      if (s.charge !== undefined && ammo !== undefined && s.charge > 0) {
        // Rounds in crates and cans: a share of each item's rounds; the item is gone with its last round.
        const lose = last ? s.charge : Math.ceil(s.charge / left);
        removeItems(cont, s.type, s.count, s.charge);
        if (s.charge - lose > 0) addItems(cont, s.type, s.count, s.charge - lose); else items = s.count;
        rounds = lose * s.count;
      } else {
        items = last ? s.count : Math.ceil(s.count / left);
        removeItems(cont, s.type, items, s.charge);
        rounds = ammo !== undefined && s.charge === undefined ? items : 0;
      }
      // (M11.5: a fuel can's litres burn with it: counted by charge kind.)
      const ck = ammo === undefined && s.charge !== undefined && s.charge > 0 && items > 0 ? ctx.catalog.items[s.type]?.chargeKind : undefined;
      events.emit({ kind: "items.destroyed", tick: state.tick, holder: id, item: s.type, count: items, ...(ammo !== undefined ? { ammo, rounds } : {}), ...(ck !== undefined ? { chargeKind: ck, amount: items * s.charge! } : {}), cause: "cookoff" });
      // An explosive round goes off (the others burn): blast and fragments, the cache as owner.
      if (k.bursts && ammo !== undefined && rounds > 0 && bursts < S.cookoff.maxBurstsPerStep && ctx.catalog.ammo[ammo]?.explosive !== undefined) {
        bursts++;
        const a = nextFloat(state.rng, Streams.supply) * 2 * PI, r = nextFloat(state.rng, Streams.supply) * 1.5;
        const bx = t.x + r * cos(a), by = t.y + r * sin(a);
        detonate(ctx, state, events, bx, by, heightAt(ctx.map, bx, by) + 0.3, ammoIndexOf(ctx.catalog, ammo), id); // ground: ok (the burst lies on the ground)
      }
    }
  }
  if (last || (cont?.stacks.length ?? 0) === 0) {
    delete c.cookoff;
    c.burnt = true; c.hp = 0;
    // (Review fix: a supply point that has burnt out is one no longer: the platoon's next point is sited afresh.)
    unPoint(state, id);
    events.emit({ kind: "cache.burnt", tick: state.tick, cache: id, side: c.side });
    return;
  }
  k.nextTick = state.tick + step;
}

// ---------------------------------------------------------------- orders

/** The player's `supplyPoint` order: the target's platoon has its supply point at (x, y) from now on. */
export function supplyPointOrder(ctx: SimContext, state: SimState, events: EventSink, target: EntityId, x: number, y: number): true | false | { unable: string } {
  const S = ctx.catalog.supply;
  const uid = state.unit.has(target) ? target : state.identity.get(target)?.unit;
  if (!S || uid === undefined) return false;
  const top = topOf(state, uid), side = state.unit.req(top).side;
  const foot = navFor(ctx, "foot").grid;
  let px = x, py = y;
  if (navCostAt(foot, x, y) <= 0 || indoorAt(ctx, x, y) >= 0) {
    const i = nearestPassable(foot, x, y, 10);
    if (i < 0) return false;
    px = (i % foot.cols + 0.5) * foot.cellM; py = (Math.floor(i / foot.cols) + 0.5) * foot.cellM;
  }
  // (Owner: never at the Verwundetennest; `nestApartM` from the platoon's own nest.)
  const nid = nestOf(state, top);
  if (nid !== null && hypot2(state.rear.req(nid).x - px, state.rear.req(nid).y - py) < S.nestApartM) return { unable: "radio.supplyNearNest" };
  if (nearNest(ctx, state, px, py)) return { unable: "radio.supplyNearNest" };
  const pid = supplyPointOf(state, top);
  const old = pid === null ? undefined : state.rear.req(pid).cache;
  if (old !== undefined && state.cache.has(old) && !cacheHolds(state.container.get(old)) && state.cache.req(old).cookoff === undefined && state.cache.req(old).burnt !== true) {
    // An empty point is simply moved.
    const t = state.transform.req(old);
    t.x = px; t.y = py;
    delete state.cache.req(old).known; // (review fix: no longer where the enemy saw it)
    makePoint(state, events, top, old, true, "ordered");
    return true;
  }
  // A point with supplies stays where it is as a plain cache; the new point starts empty.
  if (old !== undefined) unPoint(state, old);
  const cache = newCache(state, side, px, py, [], "point");
  makePoint(state, events, top, cache, true, "ordered");
  return true;
}

/** What a man would take at cache `cache` to be back at his standard load: per magazine or package type he carries,
 *  the rounds missing (mags: magazines and belts; bulk: bandoliers and packs), limited by what the cache holds. */
export function takePlan(ctx: SimContext, state: SimState, man: EntityId, cache: EntityId): { magRounds: number; bulkRounds: number; wholeRounds: number } {
  const c = state.container.get(man), k = state.container.get(cache);
  if (!c || !k) return { magRounds: 0, bulkRounds: 0, wholeRounds: 0 };
  const have = new Map<DefId, number>();
  for (const s of k.stacks) {
    const d = ctx.catalog.items[s.type];
    if (s.charge === undefined || d?.chargeItem === undefined || (d.category !== "ammo-package" && d.category !== "magazine")) continue;
    have.set(d.chargeItem, (have.get(d.chargeItem) ?? 0) + s.charge * s.count);
  }
  let magRounds = 0, bulkRounds = 0;
  // Magazines and belts first, then loose rounds.
  for (const pass of ["magazine", "ammo-package"] as const) {
    for (const s of c.stacks) {
      const d = ctx.catalog.items[s.type];
      if (s.charge === undefined || d?.category !== pass || d.chargeItem === undefined || (d.chargeCapacity ?? 0) <= s.charge) continue;
      const left = have.get(d.chargeItem) ?? 0;
      const n = Math.min(left, (d.chargeCapacity! - s.charge) * s.count);
      if (n <= 0) continue;
      have.set(d.chargeItem, left - n);
      if (pass === "magazine") magRounds += n; else bulkRounds += n;
    }
  }
  let wholeRounds = 0;
  for (const r of mortarTake(ctx, state, man, cache)) wholeRounds += r.count;
  return { magRounds, bulkRounds, wholeRounds };
}

/**
 * M11.5: the mortar rounds (whole items) a man of an on-map mortar team takes at cache `cache`: high explosive, then
 * smoke, up to `mortarFetch.carryKg` (and what the cache holds). None for anyone else.
 */
export function mortarTake(ctx: SimContext, state: SimState, man: EntityId, cache: EntityId): { type: DefId; count: number }[] {
  const M = ctx.catalog.supply?.mortarFetch;
  const uid = state.identity.get(man)?.unit;
  if (!M || uid === undefined || !state.unit.get(uid)?.mortar) return [];
  const tube = tubeOf(ctx, state, uid), k = state.container.get(cache);
  if (!tube || !k) return [];
  const out: { type: DefId; count: number }[] = [];
  let kg = M.carryKg;
  for (const type of [tube.def.he, tube.def.smoke]) {
    const m = ctx.catalog.items[type]?.massKg ?? 0;
    const n = Math.min(countItems(k, type), m > 0 ? Math.floor(kg / m + 1e-9) : 0);
    if (n <= 0) continue;
    out.push({ type, count: n });
    kg -= n * m;
  }
  return out;
}

/** Seconds a man takes at the cache for that plan. */
function takeSeconds(S: Supply, p: { magRounds: number; bulkRounds: number; wholeRounds: number }): number {
  return S.take.baseS + p.magRounds * S.take.magSecondsPerRound + p.bulkRounds * S.take.bulkSecondsPerRound + p.wholeRounds * (S.mortarFetch?.secondsPerRound ?? 0);
}

/** Can a cache supply these men (own side, not burning, something in it fits one of them)? */
function usable(state: SimState, cache: EntityId, side: SideId): boolean {
  const c = state.cache.get(cache);
  return c !== undefined && c.side === side && c.cookoff === undefined && c.burnt !== true && c.carried !== true && cacheHolds(state.container.get(cache));
}

/**
 * The player's `resupplyAt` order: the men go to cache `cache` (absent: the nearest own cache within `take.reachM` that
 * has something for them), take up to their standard load and walk back. True, or the radio key of the refusal.
 */
export function resupplyAtOrder(ctx: SimContext, state: SimState, events: EventSink, men: readonly EntityId[], side: SideId, cache?: EntityId): true | { unable: string } {
  const S = ctx.catalog.supply;
  if (!S) return { unable: "radio.supplyNone" };
  const able = men.filter((m) => {
    const s = state.soldier.get(m);
    return isAble(s) && s!.impair.canWalk && s!.impair.canUseArms && !isMounted(s) && s!.carrying === undefined && s!.atNest === undefined && s!.intent?.kind !== "care"
      && s!.mental.behaviour !== "routed" && s!.mental.behaviour !== "panicked" && s!.captive === null;
  });
  if (able.length === 0) return { unable: "radio.unable" };
  // (Not while the squad is being fired on.)
  const units = new Set(able.map((m) => state.identity.req(m).unit));
  for (const u of units) if (state.tick - (state.unit.get(u)?.ownFireTick ?? -1e9) < secondsToTicks(S.take.underFireS)) return { unable: "radio.supplyUnderFire" };
  let cx = 0, cy = 0;
  for (const m of able) { const t = state.transform.req(m); cx += t.x; cy += t.y; }
  cx /= able.length; cy /= able.length;
  const need = (k: EntityId) => able.some((m) => { const p = takePlan(ctx, state, m, k); return p.magRounds + p.bulkRounds + p.wholeRounds > 0; });
  let pick: EntityId | null = null;
  if (cache !== undefined) {
    const t = state.transform.get(cache);
    if (!t || state.cache.get(cache)?.side !== side) return { unable: "radio.supplyNone" };
    if (hypot2(t.x - cx, t.y - cy) > S.take.reachM) return { unable: "radio.supplyFar" };
    if (!usable(state, cache, side)) return { unable: "radio.supplyEmpty" };
    if (!need(cache)) return { unable: anyLow(ctx, state, able) ? "radio.supplyEmpty" : "radio.supplyFull" };
    pick = cache;
  } else {
    let bestD = S.take.reachM, any = false;
    for (const [k] of state.cache.entries()) {
      if (!usable(state, k, side)) continue;
      const t = state.transform.req(k);
      const d = hypot2(t.x - cx, t.y - cy);
      if (d > S.take.reachM) continue;
      any = true;
      if (d < bestD && need(k)) { bestD = d; pick = k; }
    }
    if (pick === null) return { unable: !any ? "radio.supplyNone" : anyLow(ctx, state, able) ? "radio.supplyEmpty" : "radio.supplyFull" };
  }
  let sent = 0;
  for (const m of able) {
    const p = takePlan(ctx, state, m, pick);
    if (p.magRounds + p.bulkRounds + p.wholeRounds <= 0) continue;
    const s = state.soldier.req(m);
    const a = state.action.get(m);
    if (a) { state.action.delete(m); events.emit({ kind: "action.interrupted", tick: state.tick, actor: m, action: a.kind, reason: "order" }); }
    state.fire.delete(m);
    s.intent = { kind: "resupply", tick: state.tick, target: pick, ...origin(state, m) };
    const mv = state.mover.get(m);
    if (mv) mv.waypoints = [];
    stepResupply(ctx, state, events, m);
    sent++;
  }
  if (sent === 0) return { unable: "radio.supplyFull" };
  events.emit({ kind: "supply.resupply", tick: state.tick, side, cache: pick, men: sent });
  return true;
}

/** Is any of these men short of rounds in his magazines, belts or packages? */
function anyLow(ctx: SimContext, state: SimState, men: readonly EntityId[]): boolean {
  for (const m of men) {
    const c = state.container.get(m);
    if (c) for (const s of c.stacks) {
      const d = ctx.catalog.items[s.type];
      if (s.charge !== undefined && (d?.category === "magazine" || d?.category === "ammo-package") && d.chargeItem !== undefined && s.charge < (d.chargeCapacity ?? 0)) return true;
    }
  }
  return false;
}

/** Step a man's errand to a cache (the decision step): walk there, take, walk back. */
export function stepResupply(ctx: SimContext, state: SimState, events: EventSink, id: EntityId): void {
  const S = ctx.catalog.supply;
  const s = state.soldier.req(id), it = s.intent;
  if (!S || !it || it.kind !== "resupply" || it.target === undefined) return;
  if (stepBack(ctx, state, id)) return;
  const src = it.target;
  const st = state.transform.get(src);
  if (!st || !usable(state, src, state.identity.req(id).side) || state.tick - it.tick > 300 * TICK_HZ || !isAble(s) || isMounted(s)) { s.intent = null; return; }
  if (state.action.has(id)) return;
  const me = state.transform.req(id);
  const m = state.mover.get(id);
  // (At it: beside it, or at the end of his route within reach of it — a crate beside a wall or a house lies off the
  // navigation cells, and the route ends on the nearest one.)
  const d = hypot2(me.x - st.x, me.y - st.y);
  if ((d <= 2.0 || (d <= TAKE_REACH_M && (m?.waypoints.length ?? 0) === 0)) && Math.abs(me.z - st.z) <= 1.5) {
    const plan = takePlan(ctx, state, id, src);
    if (plan.magRounds + plan.bulkRounds + plan.wholeRounds <= 0) { s.intent = it.x !== undefined ? { ...it, back: true } : null; return; }
    me.heading = atan2(st.y - me.y, st.x - me.x);
    s.intent = it.x !== undefined ? { ...it, back: true } : null;
    const mv = state.mover.get(id);
    if (mv) mv.waypoints = [];
    startAction(state, events, id, "takeSupply", Math.max(1, secondsToTicks(takeSeconds(S, plan))), { source: src });
    return;
  }
  if (!m) { s.intent = null; return; }
  const lastWp = m.waypoints[m.waypoints.length - 1];
  if (lastWp && hypot2(lastWp.x - st.x, lastWp.y - st.y) < TAKE_REACH_M) return; // on his way
  const leg = routeBetween(ctx, navFor(ctx, "foot").search, me.x, me.y, st.x, st.y, { maxExpansions: 6000, snapCells: 2 }, { sz: me.z, gz: st.z });
  if (!leg) { s.intent = null; return; }
  m.waypoints = routeWaypoints(leg, { x: 0, y: 0, mode: "run" });
  m.formation = null; m.endPosture = "crouching"; m.endHeading = null;
}

/** Beside the cache, on his floor, still, able, not pinned down (review fix); the cache his side's and not burning. */
function takeSupplyCheck(ctx: SimContext, state: SimState, actor: EntityId, src: EntityId): string | null {
  const s = state.soldier.get(actor);
  if (!s || !isAble(s) || !s.impair.canUseArms || isMounted(s)) return "unable";
  if (shakenForErrand(ctx, s)) return "suppressed";
  const a = state.transform.get(actor), b = state.transform.get(src);
  if (!a || !b || !state.container.has(src)) return "gone";
  if (!usable(state, src, state.identity.req(actor).side)) return "gone";
  if ((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y) > (TAKE_REACH_M + 0.5) * (TAKE_REACH_M + 0.5) || Math.abs(a.z - b.z) > 1.5) return "out-of-reach";
  if ((state.mover.get(actor)?.waypoints.length ?? 0) > 0) return "moving";
  return null;
}

/** Fill a man's magazines and belts, then his packages, from the cache's rounds (moveCharge: conserved exactly). */
function takeSupplies(ctx: SimContext, state: SimState, events: EventSink, man: EntityId, src: EntityId): void {
  const c = state.container.req(man), k = state.container.req(src);
  const taken = new Map<DefId, number>();
  for (const pass of ["magazine", "ammo-package"] as const) {
    // (Bounded: each move fills one item or empties one source item.)
    for (let guard = 0; guard < 400; guard++) {
      let to: ItemStack | null = null;
      for (const s of c.stacks) {
        const d = ctx.catalog.items[s.type];
        if (s.count > 0 && s.charge !== undefined && d?.category === pass && d.chargeItem !== undefined && s.charge < (d.chargeCapacity ?? 0) && sourceIn(ctx, k, d.chargeItem) !== null) { to = s; break; }
      }
      if (!to) break;
      const cart = ctx.catalog.items[to.type]!.chargeItem!;
      const from = sourceIn(ctx, k, cart)!;
      const r = moveCharge(ctx.catalog, state.container, { from: src, to: man, fromType: from.type, fromCharge: from.charge!, toType: to.type, toCharge: to.charge!, amount: (ctx.catalog.items[to.type]!.chargeCapacity ?? 0) - to.charge! });
      if (r.moved <= 0) break;
      taken.set(to.type, (taken.get(to.type) ?? 0) + r.moved);
    }
  }
  // M11.5: a mortar man's whole rounds for his tube.
  for (const r of mortarTake(ctx, state, man, src)) {
    const n = transferItems(ctx.catalog, state.container, { from: src, to: man, type: r.type, count: r.count }).moved;
    if (n > 0) taken.set(r.type, (taken.get(r.type) ?? 0) + n);
  }
  // (Empty packages stay in the cache: the crate and its tins are counted items.)
  for (const [type, rounds] of [...taken.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) events.emit({ kind: "items.taken", tick: state.tick, from: src, to: man, item: type, count: 0, rounds, source: "cache" });
}

/** The fullest source of rounds of a cartridge in a cache: a package, else a magazine. */
function sourceIn(ctx: SimContext, k: Container, cart: DefId): ItemStack | null {
  let best: ItemStack | null = null, bestP = -1;
  for (const s of k.stacks) {
    const d = ctx.catalog.items[s.type];
    if (s.count <= 0 || (s.charge ?? 0) <= 0 || d?.chargeItem !== cart || (d.category !== "ammo-package" && d.category !== "magazine")) continue;
    const pr = (d.category === "ammo-package" ? 1e6 : 0) + (s.charge ?? 0);
    if (pr > bestP) { bestP = pr; best = s; }
  }
  return best;
}

registerActionHandler("takeSupply", {
  check(ctx, state, actor, a) {
    return takeSupplyCheck(ctx, state, actor, Number(a.params["source"]));
  },
  complete(ctx, state, actor, a, events) {
    const src = Number(a.params["source"]);
    if (takeSupplyCheck(ctx, state, actor, src) !== null) return;
    takeSupplies(ctx, state, events, actor, src);
  },
});

// ---------------------------------------------------------------- M11.4a: squads ask, bearers carry

/**
 * A man's rounds for his own weapon now and at his standard load: the magazine in his weapon, every magazine or belt
 * of its feed and every package of its cartridge he carries (full: their capacities). `belt`: a machine gunner's belt
 * capacity (0 for anyone else).
 */
export function roundsOfMan(ctx: { catalog: SimContext["catalog"] }, state: SimView, id: EntityId): { rounds: number; full: number; belt: number } {
  const w = state.weapon.get(id), wd = w ? ctx.catalog.weapons[w.weapon] : undefined;
  if (!w || !wd) return { rounds: 0, full: 0, belt: 0 };
  const feed = wd.feed.magazine, fd = ctx.catalog.items[feed], cart = fd?.chargeItem;
  let rounds = 0, full = 0;
  if (w.magazine) { rounds += w.magazine.rounds; full += ctx.catalog.items[w.magazine.item]?.chargeCapacity ?? w.magazine.rounds; }
  const c = state.container.get(id);
  if (c) for (const s of c.stacks) {
    const d = ctx.catalog.items[s.type];
    if (!d || s.charge === undefined) continue;
    if (s.type === feed || (cart !== undefined && d.category === "ammo-package" && d.chargeItem === cart)) { rounds += s.charge * s.count; full += (d.chargeCapacity ?? s.charge) * s.count; }
  }
  return { rounds, full, belt: wd.sustained !== undefined ? fd?.chargeCapacity ?? 0 : 0 };
}

/** The squad's able men on foot (its own members, ascending id). */
function footMen(state: SimState, uid: EntityId): EntityId[] {
  const out: EntityId[] = [];
  for (const m of state.unit.get(uid)?.members ?? []) {
    const s = state.soldier.get(m);
    if (s && isAble(s) && !isMounted(s) && s.captive === null && s.atNest === undefined) out.push(m);
  }
  return out.sort((a, b) => a - b);
}

/** A squad's ammunition state: its able men's rounds as a share of their standard load, and a machine gunner below
 *  `beltsBelow` belts. */
export function squadAmmo(ctx: SimContext, state: SimState, uid: EntityId): { share: number; gunnerLow: boolean; men: number } {
  const R = ctx.catalog.supply?.request;
  let rounds = 0, full = 0, gunnerLow = false;
  const men = footMen(state, uid);
  for (const m of men) {
    const r = roundsOfMan(ctx, state, m);
    rounds += r.rounds; full += r.full;
    if (r.belt > 0 && R && r.rounds < R.beltsBelow * r.belt) gunnerLow = true;
  }
  return { share: full > 0 ? rounds / full : 1, gunnerLow, men: men.length };
}

/** Is the squad low enough to ask (`request.below`, or a machine gunner below `beltsBelow` belts)? */
export function squadLow(ctx: SimContext, state: SimState, uid: EntityId): boolean {
  const R = ctx.catalog.supply?.request;
  if (!R) return false;
  const a = squadAmmo(ctx, state, uid);
  return a.men > 0 && (a.share < R.below || a.gunnerLow);
}

/** Can this unit ask for ammunition (a unit on foot under a platoon, not a crew, not an off-map asset)? */
function asks(u: { parent: EntityId | null; vehicle?: EntityId; asset?: unknown; members: EntityId[] }): boolean {
  return u.parent !== null && u.vehicle === undefined && u.asset === undefined && u.members.length > 0;
}

/** Squads each `request.stepS`: take from an own cache close by when quiet, else ask for ammunition when low. */
export function requestSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  const S = ctx.catalog.supply, R = S?.request;
  if (!S || !R || ctx.rules.resupply === false) return;
  const every = Math.max(1, secondsToTicks(R.stepS));
  for (const [uid, u] of state.unit.entries()) {
    if ((state.tick + uid) % every !== 0 || !asks(u)) continue;
    stepSquad(ctx, state, events, S, uid);
  }
}

/** Men free to go to a cache by themselves: nothing else to do, not firing, standing still. */
function freeForCache(state: SimState, id: EntityId): boolean {
  const s = state.soldier.get(id);
  if (!s || s.intent !== null || state.action.has(id) || state.fire.has(id) || s.carrying !== undefined || state.tick < s.stunnedUntilTick) return false;
  return s.mental.behaviour !== "panicked" && s.mental.behaviour !== "routed" && s.mental.behaviour !== "pinned" && (state.mover.get(id)?.waypoints.length ?? 0) === 0;
}

/** An own cache on the ground within `request.useM` of the squad's middle with something for its men (nearest). */
function nearCache(ctx: SimContext, state: SimState, S: Supply, men: readonly EntityId[], side: SideId, minRounds: number): { cache: EntityId; men: EntityId[] } | null {
  if (men.length === 0 || state.cache.size === 0) return null;
  let cx = 0, cy = 0;
  for (const m of men) { const t = state.transform.req(m); cx += t.x; cy += t.y; }
  cx /= men.length; cy /= men.length;
  let best: { cache: EntityId; men: EntityId[] } | null = null, bestD = S.request!.useM;
  for (const [k] of state.cache.entries()) {
    if (!usable(state, k, side)) continue;
    const t = state.transform.req(k), d = hypot2(t.x - cx, t.y - cy);
    if (d > bestD) continue;
    const want = men.filter((m) => { const p = takePlan(ctx, state, m, k); return p.magRounds + p.bulkRounds >= minRounds; });
    if (want.length === 0) continue;
    bestD = d; best = { cache: k, men: want };
  }
  return best;
}

/** One squad's look: an own cache close by (quiet and halted: its short men go and take), else a request. */
function stepSquad(ctx: SimContext, state: SimState, events: EventSink, S: Supply, uid: EntityId): void {
  const R = S.request!, u = state.unit.req(uid);
  const men = footMen(state, uid);
  if (men.length === 0) return;
  const quiet = state.tick - (u.ownFireTick ?? -1e9) >= secondsToTicks(S.take.underFireS);
  if (quiet && !u.moving && u.drill === null) {
    const near = nearCache(ctx, state, S, men.filter((m) => freeForCache(state, m)), u.side, R.useMinRounds);
    if (near && resupplyAtOrder(ctx, state, events, near.men, u.side, near.cache) === true) return;
  }
  if (state.tick - (u.supplyAsk?.tick ?? -1e9) < secondsToTicks(R.everyS)) return;
  if (bearersFor(state, uid).length > 0) return; // (they are coming)
  if (!squadLow(ctx, state, uid)) return;
  // (A crate beside them with something for them: they take from it when it is quiet; no new trip.)
  if (nearCache(ctx, state, S, men, u.side, 1) !== null) return;
  const a = squadAmmo(ctx, state, uid);
  const top = topOf(state, uid);
  // (Review fix: nobody could answer — no supply point, and no stock with a supply vehicle to bring one: no request.)
  if (!supplyReachable(ctx, state, top, u.side)) return;
  const rule = u.supplyRule ?? state.unit.get(top)?.supplyRule ?? "auto";
  u.supplyAsk = { tick: state.tick, ...(rule === "ask" ? { pending: true as const } : {}) };
  const from = u.leader !== null && men.includes(u.leader) ? u.leader : men[0]!;
  if (onAir(state, uid)) events.emit({ kind: "radio", tick: state.tick, side: u.side, from, key: "radio.ammoRequest", params: { callsign: u.callsign, percent: Math.round(a.share * 100) } });
  events.emit({ kind: "supply.request", tick: state.tick, side: u.side, unit: uid, percent: Math.round(a.share * 100), ...(rule === "ask" ? { pending: true as const } : {}) });
  if (rule === "auto") {
    const r = sendBearers(ctx, state, events, uid, false);
    // (Nobody could be sent: the platoon says why; without a supply point the request itself says enough.)
    const tu = state.unit.get(top);
    if (r !== true && r.unable !== "radio.bearersNoPoint" && tu && tu.leader !== null && onAir(state, top)) events.emit({ kind: "radio", tick: state.tick, side: u.side, from: tu.leader, key: r.unable, params: { callsign: tu.callsign } });
  }
}

/** Could anything answer a request of top unit `top`'s squads: its supply point, or the side's off-map stock with a
 *  supply vehicle that is not lost (a delivery brings a point)? */
function supplyReachable(ctx: SimContext, state: SimState, top: EntityId, side: SideId): boolean {
  if (supplyPointOf(state, top) !== null) return true;
  if (ctx.rules.deliveries === false || ctx.catalog.supply?.delivery === undefined) return false;
  let stock = false;
  for (const [, st] of state.stock.entries()) if (st.side === side) { stock = true; break; }
  if (!stock) return false;
  for (const [, v] of state.vehicle.entries()) if (v.side === side && v.offMap?.kind === "supply" && v.offMap.phase !== "lost" && v.status !== "destroyed") return true;
  return false;
}

/** The men now carrying ammunition to (or on their way to fetch it for) this squad. */
export function bearersFor(state: SimState, uid: EntityId): EntityId[] {
  const out: EntityId[] = [];
  for (const m of state.unit.get(uid)?.supplyAsk?.bearers ?? []) {
    const s = state.soldier.get(m);
    if (s && isAble(s) && s.intent?.kind === "bear" && s.intent.squad === uid) out.push(m);
  }
  return out;
}

/** What bearers bring this squad from cache `point`: whole packages and magazines of the cartridges its men are
 *  short of, the fullest first, while the load stays within `capKg`. */
export function loadFor(ctx: SimContext, state: SimState, uid: EntityId, point: EntityId, capKg: number): { type: DefId; count: number; charge: number }[] {
  const k = state.container.get(point);
  if (!k) return [];
  const need = new Map<DefId, number>();
  for (const m of footMen(state, uid)) {
    const w = state.weapon.get(m), wd = w ? ctx.catalog.weapons[w.weapon] : undefined;
    const cart = wd ? ctx.catalog.items[wd.feed.magazine]?.chargeItem : undefined;
    if (cart === undefined) continue;
    const r = roundsOfMan(ctx, state, m);
    if (r.full > r.rounds) need.set(cart, (need.get(cart) ?? 0) + r.full - r.rounds);
  }
  const cands = k.stacks.filter((s) => {
    const d = ctx.catalog.items[s.type];
    return s.count > 0 && (s.charge ?? 0) > 0 && d?.chargeItem !== undefined && (d.category === "ammo-package" || d.category === "magazine") && (need.get(d.chargeItem) ?? 0) > 0;
  }).sort((a, b) => (b.charge ?? 0) - (a.charge ?? 0) || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  const out: { type: DefId; count: number; charge: number }[] = [];
  let kg = 0;
  for (const s of cands) {
    const d = ctx.catalog.items[s.type]!, cart = d.chargeItem!;
    const one = d.massKg + (s.charge ?? 0) * (d.chargeMassKg ?? 0);
    let n = 0;
    while (n < s.count && (need.get(cart) ?? 0) > 0 && kg + one <= capKg) { n++; kg += one; need.set(cart, (need.get(cart) ?? 0) - (s.charge ?? 0)); }
    if (n > 0) out.push({ type: s.type, count: n, charge: s.charge! });
  }
  return out;
}

/** Can he be an ammunition bearer: able, free, not a leader, a gunner, a medic or first responder (they would lose
 *  their protection), not a crew-served weapon's man. `ownFire`: a man firing on his own (not on an order) may go (his
 *  squad's or the headquarters' man: one rifle less for a few minutes). */
function bearerOk(ctx: SimContext, state: SimState, id: EntityId, ownFire = false): boolean {
  const s = state.soldier.get(id);
  if (!s || !isAble(s) || !s.impair.canWalk || !s.impair.canUseArms || isMounted(s) || s.evade !== null || s.captive !== null || state.action.has(id)) return false;
  const f = state.fire.get(id);
  if ((s.intent !== null && s.intent.kind !== "cover" && s.intent.kind !== "engage") || (f !== undefined && !(ownFire && f.self === true)) || s.carrying !== undefined || s.atNest !== undefined || state.tick < s.stunnedUntilTick) return false;
  if (s.mental.behaviour === "panicked" || s.mental.behaviour === "routed" || s.mental.behaviour === "pinned") return false;
  const uid = state.identity.get(id)?.unit, u = uid !== undefined ? state.unit.get(uid) : undefined;
  if (!u || u.leader === id || u.mortar !== undefined || u.missileTeam !== undefined || u.vehicle !== undefined) return false;
  const w = state.weapon.get(id);
  if (w && ctx.catalog.weapons[w.weapon]?.sustained !== undefined) return false;
  return !isResponder(ctx.catalog, state, id) && !wearsEmblem(ctx.catalog, state, id);
}

/** Is this unit fighting (fired on within `bearers.contactS`, in an assault, a house clearing, a withdrawal or a
 *  rout, broken)? Its men are never taken as bearers by the platoon. */
function fighting(ctx: SimContext, state: SimState, uid: EntityId): boolean {
  const u = state.unit.get(uid), B = ctx.catalog.supply?.bearers;
  if (!u || !B) return true;
  return u.broken || u.drill !== null || state.tick - (u.ownFireTick ?? -1e9) < secondsToTicks(B.contactS);
}

/**
 * The platoon's bearers for squad `uid` (at most two, one per unit): the headquarters' men first, then a man of the
 * asking squad, then of a squad not fighting; in each unit the man nearest the supply point (its rear). `own`: from the
 * squad itself only (the player's "Fetch ammunition"; also while it is fighting). A unit keeps at least two able men.
 */
export function pickSupplyBearers(ctx: SimContext, state: SimState, uid: EntityId, point: EntityId, own: boolean): EntityId[] {
  const top = topOf(state, uid), pt = state.transform.req(point);
  const units: { u: EntityId; rank: number }[] = [];
  const walk = (x: EntityId) => { const v = state.unit.get(x); if (!v) return; units.push({ u: x, rank: x === top ? 0 : x === uid ? 1 : 2 }); for (const c of v.children) walk(c); };
  if (own) units.push({ u: uid, rank: 0 }); else walk(top);
  units.sort((a, b) => a.rank - b.rank || a.u - b.u);
  const out: EntityId[] = [];
  for (const { u: x } of units) {
    if (out.length >= 2) break;
    if (!own && fighting(ctx, state, x)) continue;
    const able = footMen(state, x);
    if (x !== top && able.length <= 2) continue;
    let best: EntityId | null = null, bestD = Infinity;
    const ownFire = own || x === uid || x === top;
    for (const m of able) {
      if (!bearerOk(ctx, state, m, ownFire)) continue;
      const t = state.transform.req(m), d = hypot2(t.x - pt.x, t.y - pt.y);
      if (d < bestD) { bestD = d; best = m; }
    }
    if (best !== null) out.push(best);
    if (own && best !== null) {
      // (Fetch ammunition: two men of the squad itself when it can spare them.)
      let second: EntityId | null = null, sd = Infinity;
      for (const m of able) {
        if (m === best || !bearerOk(ctx, state, m, true) || able.length <= 3) continue;
        const t = state.transform.req(m), d = hypot2(t.x - pt.x, t.y - pt.y);
        if (d < sd) { sd = d; second = m; }
      }
      if (second !== null) out.push(second);
    }
  }
  return out;
}

/**
 * Send bearers to squad `uid` from its platoon's supply point (the squad's request with the rule "auto", the card's
 * "Send bearers", the order `bearers`). True, or the radio key of the refusal.
 */
export function sendBearers(ctx: SimContext, state: SimState, events: EventSink, uid: EntityId, own: boolean): true | { unable: string } {
  const S = ctx.catalog.supply, B = S?.bearers;
  const u = state.unit.get(uid);
  if (!S || !B || !u || ctx.rules.resupply === false || !asks(u)) return { unable: "radio.unable" };
  if (bearersFor(state, uid).length > 0) return { unable: "radio.bearersComing" };
  const top = topOf(state, uid), pid = supplyPointOf(state, top);
  let point = pid === null ? undefined : state.rear.get(pid)?.cache;
  if (point === undefined || !state.cache.has(point)) return { unable: "radio.bearersNoPoint" };
  if (!usable(state, point, u.side) || loadFor(ctx, state, uid, point, B.crateMaxKg).length === 0) {
    // (Review fix: the point holds nothing for them — moved, emptied — but crates left behind may: the nearest own
    // cache within `take.reachM` of the point with something for the squad.)
    const alt = fallbackCache(ctx, state, uid, point, u.side, B.crateMaxKg);
    if (alt === null) return { unable: "radio.supplyEmpty" };
    point = alt;
  }
  const men = pickSupplyBearers(ctx, state, uid, point, own);
  if (men.length === 0) return { unable: "radio.bearersNone" };
  for (let i = 0; i < men.length; i++) {
    const m = men[i]!, s = state.soldier.req(m);
    const a = state.action.get(m);
    if (a) { state.action.delete(m); events.emit({ kind: "action.interrupted", tick: state.tick, actor: m, action: a.kind, reason: "order" }); }
    state.fire.delete(m);
    const mate = men[1 - i];
    s.intent = { kind: "bear", tick: state.tick, target: point, squad: uid, ...(mate !== undefined ? { mate } : {}), ...(i === 0 ? { lead: true as const } : {}) };
    const mv = state.mover.get(m);
    if (mv) mv.waypoints = [];
  }
  u.supplyAsk = { tick: u.supplyAsk?.tick ?? state.tick, bearers: [...men] };
  events.emit({ kind: "supply.bearers", tick: state.tick, side: u.side, unit: uid, point, men: [...men], ...(own ? { own: true as const } : {}) });
  const tu = state.unit.get(top);
  if (tu && onAir(state, top) && tu.leader !== null) events.emit({ kind: "radio", tick: state.tick, side: u.side, from: tu.leader, key: "radio.bearersSent", params: { callsign: tu.callsign, squad: u.callsign } });
  for (const m of men) stepBear(ctx, state, events, m);
  return true;
}

/** The nearest own cache lying on the ground (not a crate on the move, not a mortar section's rounds) within
 *  `take.reachM` of `point` that holds something for squad `uid`, or null. */
function fallbackCache(ctx: SimContext, state: SimState, uid: EntityId, point: EntityId, side: SideId, capKg: number): EntityId | null {
  const S = ctx.catalog.supply!, pt = state.transform.req(point);
  let best: EntityId | null = null, bestD = S.take.reachM;
  for (const [k, c] of state.cache.entries()) {
    if (k === point || c.tubes !== undefined || !usable(state, k, side)) continue;
    const t = state.transform.req(k), d = hypot2(t.x - pt.x, t.y - pt.y);
    if (d >= bestD || loadFor(ctx, state, uid, k, capKg).length === 0) continue;
    bestD = d; best = k;
  }
  return best;
}

/** Where a crate for squad `uid` is put: beside its leader, else its first able man (his floor's height); never
 *  inside a Verwundetennest's clear zone (review fix: moved out of it, away from the nest, onto passable ground). */
function dropSpot(ctx: SimContext, state: SimState, uid: EntityId): { x: number; y: number; z: number } | null {
  const u = state.unit.get(uid);
  if (!u) return null;
  const men = footMen(state, uid);
  const who = u.leader !== null && men.includes(u.leader) ? u.leader : men[0];
  if (who === undefined) return null;
  const t = state.transform.req(who);
  const R = ctx.catalog.supply?.nestClearM ?? 0;
  if (R > 0) for (const [, p] of state.rear.entries()) {
    if (p.kind !== "medical") continue;
    const dx = t.x - p.x, dy = t.y - p.y, d = hypot2(dx, dy);
    if (d >= R) continue;
    const ux = d > 0.5 ? dx / d : 1, uy = d > 0.5 ? dy / d : 0;
    let x = p.x + ux * (R + 3), y = p.y + uy * (R + 3);
    const foot = navFor(ctx, "foot").grid;
    if (navCostAt(foot, x, y) <= 0) {
      const i = nearestPassable(foot, x, y, 4);
      if (i >= 0) { x = (i % foot.cols + 0.5) * foot.cellM; y = (Math.floor(i / foot.cols) + 0.5) * foot.cellM; }
    }
    if (nearNest(ctx, state, x, y)) return null; // (nowhere to put it down)
    return { x, y, z: heightAt(ctx.map, x, y) }; // ground: ok (a crate on the ground outside the nest)
  }
  return { x: t.x, y: t.y, z: t.z };
}

/** Is a bearer still on his way with this crate? */
function bearerHolds(state: SimState, load: EntityId): boolean {
  // mounted: ok (a bearer is never aboard: a mounted man has no errand)
  for (const [, s] of state.soldier.entries()) if (s.intent?.kind === "bear" && s.intent.load === load && isAble(s)) return true;
  return false;
}

/** A crate the bearers put down where it is: an ordinary cache from now on. */
function putDown(state: SimState, load: EntityId): void {
  const c = state.cache.get(load);
  if (c?.carried === true && !state.carry.has(load)) delete c.carried;
}

/** He gives up his errand (the crate, if he has one, stays where it lies) and goes back to his unit. */
function quitBear(ctx: SimContext, state: SimState, id: EntityId): void {
  const s = state.soldier.req(id), it = s.intent;
  if (it?.kind !== "bear") return;
  if (it.load !== undefined) {
    const mate = it.mate !== undefined ? state.soldier.get(it.mate) : undefined;
    // (His mate still on it: the crate stays his.)
    if (!(mate && isAble(mate) && mate.intent?.kind === "bear" && mate.intent.load === it.load)) putDown(state, it.load);
  }
  s.intent = null;
  if (isAble(s) && !isMounted(s)) bearersBack(ctx, state, [id]);
}

/** Is his fellow bearer still on the same errand? */
function mateOn(state: SimState, it: { mate?: EntityId; squad?: EntityId }): EntityId | null {
  if (it.mate === undefined) return null;
  const ms = state.soldier.get(it.mate);
  return ms && isAble(ms) && ms.intent?.kind === "bear" && ms.intent.squad === it.squad ? it.mate : null;
}

/** Step an ammunition bearer (the decision step; while he carries, the carry system moves him). */
export function stepBear(ctx: SimContext, state: SimState, events: EventSink, id: EntityId): void {
  const S = ctx.catalog.supply, B = S?.bearers;
  const s = state.soldier.req(id), it = s.intent;
  if (!it || it.kind !== "bear") return;
  if (s.carrying !== undefined) return; // (the carry system has him)
  if (!S || !B || ctx.rules.resupply === false || it.squad === undefined || it.target === undefined || !isAble(s) || isMounted(s)) { quitBear(ctx, state, id); return; }
  if (state.tick - it.tick > secondsToTicks(B.giveUpS)) { quitBear(ctx, state, id); return; }
  const side = state.identity.req(id).side;
  const drop = dropSpot(ctx, state, it.squad);
  if (!drop) { quitBear(ctx, state, id); return; }
  const me = state.transform.req(id), mv = state.mover.get(id);
  if (it.load !== undefined) {
    const lc = state.cache.get(it.load), lt = state.transform.get(it.load);
    if (!lc || !lt || lc.side !== side || lc.cookoff !== undefined || lc.burnt === true) { quitBear(ctx, state, id); return; }
    if (state.carry.has(it.load)) return;
    if (hypot2(lt.x - drop.x, lt.y - drop.y) <= B.deliverM) { deliver(ctx, state, events, id, it.load, it.squad); return; }
    // The carry stopped short (a man lost, no way, the squad moved on): the lead takes it on.
    const mate = mateOn(state, it);
    if (it.lead !== true && mate !== null) return;
    if (it.lead !== true) s.intent = { ...it, lead: true };
    if (hypot2(me.x - lt.x, me.y - lt.y) > 3 || Math.abs(me.z - lt.z) > 1.5) {
      // (Back to the crate first.)
      const last = mv?.waypoints[mv.waypoints.length - 1];
      if (mv && !(last && hypot2(last.x - lt.x, last.y - lt.y) < 2)) {
        const leg = routeBetween(ctx, navFor(ctx, "foot").search, me.x, me.y, lt.x, lt.y, { maxExpansions: 6000, snapCells: 2 }, { sz: me.z, gz: lt.z });
        if (!leg) { quitBear(ctx, state, id); return; }
        mv.waypoints = routeWaypoints(leg, { x: 0, y: 0, mode: "walk" });
        mv.formation = null; mv.endPosture = "crouching"; mv.endHeading = null;
      }
      return;
    }
    const mateNear = mate !== null && (() => { const t = state.transform.req(mate); return hypot2(t.x - lt.x, t.y - lt.y) <= 3 && state.soldier.req(mate).carrying === undefined; })();
    const kg = containerMassKg(ctx.catalog, state.container.req(it.load));
    const method = mateNear ? "crate" : kg <= B.maxKg ? "load" : null;
    if (method === null) {
      // (Too heavy for one man: he waits for his mate, or leaves it.)
      if (mate !== null) return;
      quitBear(ctx, state, id); return;
    }
    const party = method === "crate" ? [id, mate!] : [id];
    if (!startCarry(ctx, state, events, it.load, party, drop, { method, cargo: true })) { quitBear(ctx, state, id); return; }
    return;
  }
  // On his way to the supply point.
  if (!usable(state, it.target, side)) { quitBear(ctx, state, id); return; }
  // Fired on: he takes cover where he is and goes on once it is quiet (the carry rules, M10.4a).
  const H = ctx.catalog.medical?.carrying?.holdSuppression ?? 0.3;
  if (s.mental.suppression >= H || isCowering(s)) {
    if (mv && mv.waypoints.length > 0) { mv.waypoints = []; mv.speedMps = 0; }
    if (s.posture !== "prone" && s.postureTo === null) requestPosture(ctx, state, id, "prone");
    return;
  }
  if (state.action.has(id)) return; // (loading)
  const pt = state.transform.req(it.target);
  const d = hypot2(me.x - pt.x, me.y - pt.y);
  if ((d <= 2.0 || (d <= TAKE_REACH_M && (mv?.waypoints.length ?? 0) === 0)) && Math.abs(me.z - pt.z) <= 1.5) {
    const mate = mateOn(state, it);
    if (it.lead !== true && mate !== null) return; // (his mate loads)
    if (mate !== null) {
      const mt = state.transform.req(mate);
      const there = hypot2(mt.x - pt.x, mt.y - pt.y) <= TAKE_REACH_M + 0.5;
      if (!there) {
        if (it.waitTick === undefined) { s.intent = { ...it, waitTick: state.tick }; return; }
        if (state.tick - it.waitTick < secondsToTicks(B.waitMateS)) return;
      }
    }
    me.heading = atan2(pt.y - me.y, pt.x - me.x);
    if (mv) mv.waypoints = [];
    startAction(state, events, id, "loadSupply", Math.max(1, secondsToTicks(B.loadS)), { source: it.target, squad: it.squad });
    return;
  }
  if (!mv) { quitBear(ctx, state, id); return; }
  const lastWp = mv.waypoints[mv.waypoints.length - 1];
  if (lastWp && hypot2(lastWp.x - pt.x, lastWp.y - pt.y) < TAKE_REACH_M) return; // on his way
  const leg = routeBetween(ctx, navFor(ctx, "foot").search, me.x, me.y, pt.x, pt.y, { maxExpansions: 8000, snapCells: 2 }, { sz: me.z, gz: pt.z });
  if (!leg) { quitBear(ctx, state, id); return; }
  mv.waypoints = routeWaypoints(leg, { x: 0, y: 0, mode: "walk" });
  mv.formation = null; mv.endPosture = "crouching"; mv.endHeading = null;
}

/** The crate is beside the squad: it lies there as the squad's cache (its men take from it when quiet); the bearers
 *  go back. */
function deliver(ctx: SimContext, state: SimState, events: EventSink, id: EntityId, load: EntityId, squad: EntityId): void {
  const s = state.soldier.req(id), it = s.intent!;
  const c = state.cache.req(load);
  delete c.carried;
  const rounds = roundsInContainer(ctx, state.container.get(load));
  events.emit({ kind: "supply.delivered", tick: state.tick, side: c.side, unit: squad, load, rounds });
  const men = [id];
  const mate = mateOn(state, it);
  if (mate !== null && state.soldier.req(mate).carrying === undefined) men.push(mate);
  for (const m of men) state.soldier.req(m).intent = null;
  const u = state.unit.get(squad);
  if (u?.supplyAsk?.bearers) { const b = u.supplyAsk.bearers.filter((m) => !men.includes(m)); if (b.length > 0) u.supplyAsk.bearers = b; else delete u.supplyAsk.bearers; }
  bearersBack(ctx, state, men);
}

/** At the point, the lead (and his mate if there) beside it, the point usable. */
function loadSupplyCheck(state: SimState, actor: EntityId, src: EntityId): string | null {
  const s = state.soldier.get(actor);
  if (!s || !isAble(s) || !s.impair.canUseArms || isMounted(s) || s.intent?.kind !== "bear") return "unable";
  const a = state.transform.get(actor), b = state.transform.get(src);
  if (!a || !b || !usable(state, src, state.identity.req(actor).side)) return "gone";
  if ((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y) > (TAKE_REACH_M + 0.5) * (TAKE_REACH_M + 0.5) || Math.abs(a.z - b.z) > 1.5) return "out-of-reach";
  return null;
}

registerActionHandler("loadSupply", {
  check(_ctx, state, actor, a) {
    return loadSupplyCheck(state, actor, Number(a.params["source"]));
  },
  complete(ctx, state, actor, a, events) {
    const src = Number(a.params["source"]);
    const B = ctx.catalog.supply?.bearers;
    const s = state.soldier.get(actor), it = s?.intent;
    if (!B || !s || !it || it.kind !== "bear" || it.squad === undefined || loadSupplyCheck(state, actor, src) !== null) return;
    const side = state.identity.req(actor).side, pt = state.transform.req(src);
    const mate = mateOn(state, it);
    const mateThere = mate !== null && (() => { const t = state.transform.req(mate); return hypot2(t.x - pt.x, t.y - pt.y) <= TAKE_REACH_M + 0.5 && Math.abs(t.z - pt.z) <= 1.5 && state.soldier.req(mate).carrying === undefined; })();
    const drop = dropSpot(ctx, state, it.squad);
    const items = drop ? loadFor(ctx, state, it.squad, src, mateThere ? B.crateMaxKg : B.maxKg) : [];
    if (items.length === 0) { quitBear(ctx, state, actor); if (mate !== null) quitBear(ctx, state, mate); return; }
    const load = newCache(state, side, pt.x, pt.y, [], "cache");
    state.transform.req(load).z = pt.z;
    state.cache.req(load).carried = true;
    for (const st of items) {
      const r = transferItems(ctx.catalog, state.container, { from: src, to: load, type: st.type, count: st.count, charge: st.charge });
      if (r.moved > 0) events.emit({ kind: "items.transferred", tick: state.tick, from: src, to: load, item: st.type, count: r.moved });
    }
    const k = state.container.req(load);
    events.emit({ kind: "supply.loaded", tick: state.tick, side, unit: it.squad, load, rounds: roundsInContainer(ctx, k), kg: Math.round(containerMassKg(ctx.catalog, k) * 10) / 10 });
    s.intent = { ...it, load };
    if (mate !== null) { const ms = state.soldier.req(mate); ms.intent = { ...ms.intent!, load }; }
    const party = mateThere ? [actor, mate!] : [actor];
    if (!startCarry(ctx, state, events, load, party, drop!, { method: mateThere ? "crate" : "load", cargo: true })) putDown(state, load);
  },
});
