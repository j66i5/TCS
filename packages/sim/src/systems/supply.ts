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
 * Same rules for every side, the player's and the computer's. `rules.resupply === false` switches the orders and the
 * automatic siting off (caches still burn and are captured: they are things on the ground).
 */
import { registerActionHandler, startAction } from "../actions";
import type { Cache } from "../components";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { secondsToTicks, TICK_HZ, type DefId, type EntityId, type SideId } from "../ids";
import { isAble } from "../impair";
import { indoorAt, routeBetween, routeWaypoints } from "../interior-nav";
import { addItems, emptyContainer, moveCharge, removeItems, transferItems, type Container, type ItemStack } from "../items";
import { atan2, cos, hypot2, PI, pow, sin } from "../math";
import { isMounted } from "../mount";
import { navCostAt, nearestPassable } from "../nav";
import { navFor } from "../navctx";
import { isOffMap } from "../offmap";
import { ammoIndexOf } from "../projectiles";
import { nextFloat, nextRange, Streams } from "../rng";
import { addSmoke } from "../smoke";
import { newEntity, type SimState } from "../state";
import { heightAt } from "../terrain";
import { origin, stepBack } from "./consolidate";
import { coveredFrom } from "./decisions";
import { detonate } from "./explosions";
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
  if (isAmmo(ctx, st.type) && nearNest(ctx, state, t.x, t.y)) return 0;
  return transferItems(ctx.catalog, state.container, st.charge === undefined ? { from, to: cache, type: st.type, count: st.count } : { from, to: cache, type: st.type, count: st.count, charge: st.charge }).moved;
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
  const cont = state.container.get(id);
  const full = (cont?.stacks.length ?? 0) > 0;
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
    if ((state.container.get(id)?.stacks.length ?? 0) === 0) continue;
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
  if (c.cookoff !== undefined || (state.container.get(id)?.stacks.length ?? 0) === 0) return;
  const dur = nextRange(state.rng, Streams.supply, S.cookoff.minS, S.cookoff.maxS);
  const bursts = explosiveIn(ctx, state.container.get(id));
  c.cookoff = { startTick: state.tick, endTick: state.tick + secondsToTicks(dur), nextTick: state.tick + 1, bursts };
  delete c.holdTick;
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
      events.emit({ kind: "items.destroyed", tick: state.tick, holder: id, item: s.type, count: items, ...(ammo !== undefined ? { ammo, rounds } : {}), cause: "cookoff" });
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
  if (old !== undefined && state.cache.has(old) && (state.container.get(old)?.stacks.length ?? 0) === 0 && state.cache.req(old).cookoff === undefined) {
    // An empty point is simply moved.
    const t = state.transform.req(old);
    t.x = px; t.y = py;
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
export function takePlan(ctx: SimContext, state: SimState, man: EntityId, cache: EntityId): { magRounds: number; bulkRounds: number } {
  const c = state.container.get(man), k = state.container.get(cache);
  if (!c || !k) return { magRounds: 0, bulkRounds: 0 };
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
  return { magRounds, bulkRounds };
}

/** Seconds a man takes at the cache for that plan. */
function takeSeconds(S: Supply, p: { magRounds: number; bulkRounds: number }): number {
  return S.take.baseS + p.magRounds * S.take.magSecondsPerRound + p.bulkRounds * S.take.bulkSecondsPerRound;
}

/** Can a cache supply these men (own side, not burning, something in it fits one of them)? */
function usable(state: SimState, cache: EntityId, side: SideId): boolean {
  const c = state.cache.get(cache);
  return c !== undefined && c.side === side && c.cookoff === undefined && (state.container.get(cache)?.stacks.length ?? 0) > 0;
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
  const need = (k: EntityId) => able.some((m) => { const p = takePlan(ctx, state, m, k); return p.magRounds + p.bulkRounds > 0; });
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
    if (p.magRounds + p.bulkRounds <= 0) continue;
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
    if (plan.magRounds + plan.bulkRounds <= 0) { s.intent = it.x !== undefined ? { ...it, back: true } : null; return; }
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

/** Beside the cache, on his floor, still, able; the cache his side's and not burning. */
function takeSupplyCheck(state: SimState, actor: EntityId, src: EntityId): string | null {
  const s = state.soldier.get(actor);
  if (!s || !isAble(s) || !s.impair.canUseArms || isMounted(s)) return "unable";
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
  check(_ctx, state, actor, a) {
    return takeSupplyCheck(state, actor, Number(a.params["source"]));
  },
  complete(ctx, state, actor, a, events) {
    const src = Number(a.params["source"]);
    if (takeSupplyCheck(state, actor, src) !== null) return;
    takeSupplies(ctx, state, events, actor, src);
  },
});
