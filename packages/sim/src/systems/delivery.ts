/**
 * SUPPLIES FROM OFF THE MAP (M11.4b, plan slice 47; owner answers 2026-11-16: delivery by bearers, vehicle runs and
 * off-map deliveries; control automatic plus player orders; mortar and artillery allotments topped up by deliveries;
 * an ambulance carrying ammunition is a breach of the law of war). Values: core/supply.json `delivery`, `vehicleRun`,
 * `topUpCheckS` (game values, low).
 *
 *   stock       Each side may have an off-map stock (`state.stock`, an entity with a container, from the battle
 *               input): the only source of supplies arriving during the battle. Items leave it by `transferItems`
 *               (`fromStock`), each move an `items.delivered` event; the ledger counts the stock as outside the battle.
 *   deliveries  The side's supply vehicle (an off-map asset of kind "supply", faction manifest `supply`) is called to
 *               a platoon's supply point when the point holds below `delivery.callBelow` of its standard fill (its
 *               fill when first looked at, or its first delivery), or when a squad of a platoon without a point asked
 *               for ammunition lately (a point is sited then), or by the player's `callDelivery`. One delivery per
 *               side at a time. At the call it is loaded from the stock: whole packages of the cartridges the
 *               platoon's men fire, one per cartridge in turn, up to its `cargo.kg` and the point's shortfall. It comes
 *               on after `delayMinS`-`delayMaxS` (drawn, stream "supply") at the edge behind the point, drives to
 *               within `standM` of it, is unloaded (`unloadBaseS` + `unloadSecondsPerKg` per kg; the crates go into the
 *               point's cache) and drives back off the map; `turnaroundS` later it is ready again. A run that cannot
 *               reach the point within `heldMaxS` goes back with its load (still aboard: the next run brings it).
 *   top-up      A stock with `topUp` moves that many rounds into each of its side's off-map support sections (high
 *               explosive, else smoke) every `topUp.everyS` (`supply.topUp`).
 *   law of war  The automatic calls only ever use supply vehicles. A player's delivery with an ambulance named
 *               (`callDelivery` with `vehicle`) is carried out, but recorded as a breach (`law.misuse`, cause
 *               "ammunitionInAmbulance") and the ambulance has no protection while it carries the ammunition
 *               (`VehicleState.misuse`, read by protection.ts).
 *
 * Same rules for every side. Off: no `delivery` data, `rules.resupply === false` or `rules.deliveries === false`.
 * Off-map vehicles are skipped by every other system (offmap.ts); this one only steps the runs and looks at the
 * supply points every `checkS`.
 */
import { onAir } from "../comms";
import type { OffMapAsset, VehicleState } from "../components";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { secondsToTicks, ticksToSeconds, type DefId, type EntityId, type SideId } from "../ids";
import { transferItems, type ItemStack } from "../items";
import { cos, hypot2, sin } from "../math";
import { isOffMap, parkOffMap } from "../offmap";
import type { Order } from "../orders";
import { nextRange, Streams } from "../rng";
import type { SimState } from "../state";
import { vehicleHalt, vehicleMove, type OrderResult } from "./drive";
import { backAwayAndGo, canDrive, entryPoint, HELD_UP_NEAR_M, radio, standSpot } from "./evacuation";
import { topOf } from "./nest";
import { ensureSupplyPoint, newCache, putInCache, roundsInContainer } from "./supply";
import { tubeOf, type Tube } from "./mortars";
import { fuelShortL, stowageWants } from "./rearm";

/** Routes tried again after this (s). */
const RETRY_S = 30;

export function deliveriesEnabled(ctx: SimContext): boolean {
  return ctx.catalog.supply !== undefined && ctx.rules.resupply !== false && ctx.rules.deliveries !== false;
}

// ---------------------------------------------------------------- the stock

/** The side's off-map stock (lowest id), or null. */
export function stockOf(state: SimState, side: SideId): EntityId | null {
  if (state.stock.size === 0) return null;
  for (const [id, s] of state.stock.entries()) if (s.side === side) return id;
  return null;
}

/** Ammunition rounds in one stack (charge of a magazine or package under its cartridge, or whole rounds), by id. */
function roundsOfStack(ctx: SimContext, type: DefId, count: number, charge: number | undefined): { ammo: DefId; rounds: number } | null {
  const d = ctx.catalog.items[type];
  if (charge !== undefined && d?.chargeItem !== undefined && ctx.catalog.ammo[d.chargeItem] !== undefined) return { ammo: d.chargeItem, rounds: charge * count };
  if (charge === undefined && ctx.catalog.ammo[type] !== undefined) return { ammo: type, rounds: count };
  return null;
}

/**
 * Move `count` items of `type` (with exactly `charge`, when given) from stock `stock` into container `to`
 * (`transferItems`); each move enters the battle: `items.delivered`. Returns how many moved.
 */
export function fromStock(ctx: SimContext, state: SimState, events: EventSink, stock: EntityId, to: EntityId, type: DefId, count: number, charge?: number): number {
  if (count <= 0) return 0;
  const moved = transferItems(ctx.catalog, state.container, charge === undefined ? { from: stock, to, type, count } : { from: stock, to, type, count, charge }).moved;
  if (moved > 0) {
    const r = roundsOfStack(ctx, type, moved, charge);
    // (M11.5: a fuel can's litres enter the battle too: counted by charge kind.)
    const d = ctx.catalog.items[type];
    const ck = charge !== undefined && d?.chargeItem === undefined ? d?.chargeKind : undefined;
    events.emit({ kind: "items.delivered", tick: state.tick, holder: to, item: type, count: moved, ...(r ? { ammo: r.ammo, rounds: r.rounds } : {}), ...(ck !== undefined ? { chargeKind: ck, amount: charge! * moved } : {}) });
  }
  return moved;
}

/** The cartridges the men of top unit `top` fire (their weapons' feeds), sorted. */
function platoonCartridges(ctx: SimContext, state: SimState, top: EntityId): DefId[] {
  const out = new Set<DefId>();
  const walk = (uid: EntityId) => {
    const u = state.unit.get(uid);
    if (!u) return;
    for (const m of u.members) {
      const s = state.soldier.get(m);
      if (!s || !s.physiology.alive || s.captive !== null) continue;
      const w = state.weapon.get(m), wd = w ? ctx.catalog.weapons[w.weapon] : undefined;
      const c = wd ? ctx.catalog.items[wd.feed.magazine]?.chargeItem : undefined;
      if (c !== undefined) out.add(c);
    }
    for (const ch of u.children) walk(ch);
  };
  walk(top);
  return [...out].sort();
}

/**
 * Load supplies for top unit `top` from stock `stock` into container `to`: whole packages (or magazines and belts) of
 * the cartridges its men fire, the fullest first, one per cartridge in turn, while within `capKg` and below `rounds`
 * rounds. Returns what was loaded (the stacks, their rounds and mass).
 */
export function loadForPlatoon(ctx: SimContext, state: SimState, events: EventSink, stock: EntityId, to: EntityId, top: EntityId, capKg: number, rounds: number): { load: ItemStack[]; rounds: number; kg: number } {
  const k = state.container.get(stock);
  const out: ItemStack[] = [];
  let kg = 0, n = 0;
  if (!k) return { load: out, rounds: 0, kg: 0 };
  const carts = platoonCartridges(ctx, state, top);
  const pick = (cart: DefId) => {
    let best: ItemStack | null = null;
    for (const s of k.stacks) {
      const d = ctx.catalog.items[s.type];
      if (s.count <= 0 || (s.charge ?? 0) <= 0 || d?.chargeItem !== cart || (d.category !== "ammo-package" && d.category !== "magazine")) continue;
      if (!best || (s.charge ?? 0) > (best.charge ?? 0) || ((s.charge ?? 0) === (best.charge ?? 0) && s.type < best.type)) best = s;
    }
    return best;
  };
  for (let progress = true; progress && n < rounds;) {
    progress = false;
    for (const c of carts) {
      if (n >= rounds) break;
      const s = pick(c);
      if (!s) continue;
      const d = ctx.catalog.items[s.type]!, ch = s.charge!;
      const one = d.massKg + ch * (d.chargeMassKg ?? 0);
      if (kg + one > capKg) continue;
      const type = s.type;
      if (fromStock(ctx, state, events, stock, to, type, 1, ch) !== 1) continue;
      kg += one; n += ch; progress = true;
      const o = out.find((x) => x.type === type && x.charge === ch);
      if (o) o.count++; else out.push({ type, count: 1, charge: ch });
    }
  }
  return { load: out, rounds: n, kg };
}

/**
 * M11.5: load for top unit `top`'s hulls from stock `stock` into container `to`: whole items of what their stowage is
 * short of (ammunition and reactive tiles, as re-arming takes them), then fuel cans for what their tanks are short of,
 * within `capKg`. Returns the stacks loaded.
 */
function loadForHulls(ctx: SimContext, state: SimState, events: EventSink, stock: EntityId, to: EntityId, top: EntityId, capKg: number): ItemStack[] {
  const k = state.container.get(stock);
  const out: ItemStack[] = [];
  if (!k || capKg <= 0) return out;
  let kg = 0;
  const take = (type: DefId, charge: number | undefined): boolean => {
    const d = ctx.catalog.items[type];
    if (!d) return false;
    const one = d.massKg + (charge ?? 0) * (d.chargeMassKg ?? 0);
    if (kg + one > capKg || fromStock(ctx, state, events, stock, to, type, 1, charge) !== 1) return false;
    kg += one;
    const o = out.find((x) => x.type === type && x.charge === charge);
    if (o) o.count++; else out.push(charge !== undefined ? { type, count: 1, charge } : { type, count: 1 });
    return true;
  };
  const fuel = new Map<string, number>();
  for (const [vid, v] of state.vehicle.entries()) {
    if (v.offMap !== undefined || v.unit === null || v.status === "destroyed" || topOf(state, v.unit) !== top) continue;
    const def = ctx.catalog.vehicles[v.def];
    if (!def) continue;
    for (const w of stowageWants(ctx, state, vid, v)) {
      let missing = w.want - w.have;
      while (missing > 0) {
        let best: { charge: number | undefined; per: number } | null = null;
        for (const x of k.stacks) {
          if (x.type !== w.type || x.count <= 0) continue;
          const per = x.charge ?? 1;
          if (per > 0 && per <= missing && (!best || per > best.per)) best = { charge: x.charge, per };
        }
        if (!best || !take(w.type, best.charge)) break;
        missing -= best.per;
      }
    }
    const kind = ctx.catalog.items[def.fuel.item]?.chargeKind;
    if (kind !== undefined) fuel.set(kind, (fuel.get(kind) ?? 0) + fuelShortL(state, vid, def));
  }
  for (const [kind, litres] of [...fuel.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    let left = litres;
    while (left > 0) {
      let can: { type: DefId; charge: number } | null = null;
      for (const x of k.stacks) {
        const d = ctx.catalog.items[x.type];
        if (x.count > 0 && (x.charge ?? 0) > 0 && d?.chargeKind === kind && d.category !== "fuel" && (!can || x.charge! > can.charge)) can = { type: x.type, charge: x.charge! };
      }
      if (!can || !take(can.type, can.charge)) break;
      left -= can.charge;
    }
  }
  return out;
}

/** Rounds in a list of stacks. */
function roundsIn(ctx: SimContext, load: readonly ItemStack[]): number {
  let n = 0;
  for (const s of load) n += roundsOfStack(ctx, s.type, s.count, s.charge)?.rounds ?? 0;
  return n;
}

/** Mass of a list of stacks (kg). */
function massOf(ctx: SimContext, load: readonly ItemStack[]): number {
  let kg = 0;
  for (const s of load) { const d = ctx.catalog.items[s.type]; if (d) kg += s.count * (d.massKg + (s.charge ?? 0) * (d.chargeMassKg ?? 0)); }
  return kg;
}

/** Put a load from container `from` into cache `cache` (as much of each stack as is still there). Rounds moved. */
export function unloadInto(ctx: SimContext, state: SimState, from: EntityId, cache: EntityId, load: readonly ItemStack[]): number {
  let n = 0;
  for (const s of load) {
    const moved = putInCache(ctx, state, from, cache, s);
    n += roundsOfStack(ctx, s.type, moved, s.charge)?.rounds ?? 0;
  }
  return n;
}

// ---------------------------------------------------------------- law of war

/** Is this hull a marked ambulance (protected by its emblem)? */
export function markedHull(ctx: SimContext, v: VehicleState): boolean {
  return ctx.catalog.vehicles[v.def]?.ambulance?.marked === true;
}

/** Ammunition was put into a marked ambulance (always on a player's order: the computer never does it). */
export function ammunitionIntoAmbulance(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, ordered: boolean): void {
  const v = state.vehicle.req(vid);
  if (!markedHull(ctx, v) || v.misuse === true) return;
  v.misuse = true;
  events.emit({ kind: "law.misuse", tick: state.tick, side: v.side, vehicle: vid, cause: "ammunitionInAmbulance", ordered });
}

// ---------------------------------------------------------------- deliveries

/** A delivery of the side under way (called, on its way, unloading or driving back)? */
function deliveryUnderWay(state: SimState, side: SideId): boolean {
  for (const [, v] of state.vehicle.entries()) {
    const o = v.offMap;
    if (v.side === side && o?.cargo === "supplies" && (o.phase === "called" || o.phase === "inbound" || o.phase === "loading" || o.phase === "outbound")) return true;
  }
  return false;
}

/** The side's next supply vehicle waiting off the map (lowest id), or null. */
function readySupply(ctx: SimContext, state: SimState, side: SideId): EntityId | null {
  for (const [vid, v] of state.vehicle.entries()) {
    if (v.side === side && v.offMap?.kind === "supply" && v.offMap.phase === "ready" && ctx.catalog.vehicles[v.def]?.cargo !== undefined) return vid;
  }
  return null;
}

/** How many supply vehicles of the side wait off the map, and whether a delivery is under way (for the interface). */
export function deliveryState(state: SimState, side: SideId): { ready: number; underWay: boolean } {
  let ready = 0;
  for (const [, v] of state.vehicle.entries()) if (v.side === side && v.offMap?.kind === "supply" && v.offMap.phase === "ready") ready++;
  return { ready, underWay: deliveryUnderWay(state, side) };
}

/**
 * Call a delivery to top unit `top`'s supply point (sited now if it has none). `vid`: the vehicle (a ready supply
 * vehicle; a ready ambulance only on a player's order: a breach), else the side's next supply vehicle. True, or why
 * not (a radio key).
 */
export function callDelivery(ctx: SimContext, state: SimState, events: EventSink, top: EntityId, ordered: boolean, vid?: EntityId): true | { unable: string } {
  const D = ctx.catalog.supply?.delivery;
  const u = state.unit.get(top);
  if (!D || !u || !deliveriesEnabled(ctx)) return { unable: "radio.deliveryNone" };
  const stock = stockOf(state, u.side);
  if (stock === null) return { unable: "radio.deliveryNone" };
  if (deliveryUnderWay(state, u.side)) return { unable: "radio.deliveryComing" };
  let asset = vid ?? readySupply(ctx, state, u.side);
  if (asset !== null) {
    const v = state.vehicle.get(asset);
    const ok = v !== undefined && v.side === u.side && v.offMap?.phase === "ready" && (v.offMap.kind === "supply" || (ordered && v.offMap.kind === "ambulance"));
    if (!ok) asset = null;
  }
  if (asset === null) return { unable: "radio.deliveryNone" };
  const pid = ensureSupplyPoint(ctx, state, events, top);
  const p = pid === null ? undefined : state.rear.get(pid);
  const cache = p?.cache;
  if (!p || pid === null || cache === undefined || !state.cache.has(cache)) return { unable: "radio.deliveryNoPoint" };
  const v = state.vehicle.req(asset), def = ctx.catalog.vehicles[v.def]!;
  const entry = entryPoint(ctx, state, top, p.x, p.y, def.class);
  if (!entry) return { unable: "radio.deliveryNoWay" };
  // The load: what the point is short of its standard fill (all it can carry when not known), from the stock.
  const c = state.cache.req(cache);
  const have = roundsInContainer(ctx, state.container.get(cache));
  // (The player's order brings a full point's worth, even to a point that is not short yet.)
  const want = c.fill === undefined ? Infinity : ordered ? c.fill : Math.max(0, c.fill - have);
  const capKg = def.cargo?.kg ?? (def.ambulance ? D.ambulanceKg : 0);
  const prev = v.offMap?.load ?? [];
  const got = loadForPlatoon(ctx, state, events, stock, asset, top, Math.max(0, capKg - massOf(ctx, prev)), Math.max(0, want - roundsIn(ctx, prev)));
  // M11.5: what the platoon's hulls are short of in their stowage and tanks, in the room left.
  const forHulls = loadForHulls(ctx, state, events, stock, asset, top, Math.max(0, capKg - massOf(ctx, prev) - got.kg));
  const load = mergeLoads(mergeLoads(prev, got.load), forHulls);
  if (load.length === 0) return { unable: "radio.deliveryNoStock" };
  if (markedHull(ctx, v)) ammunitionIntoAmbulance(ctx, state, events, asset, ordered);
  const delayS = nextRange(state.rng, Streams.supply, D.delayMinS, D.delayMaxS);
  v.offMap = {
    kind: v.offMap!.kind, phase: "called", cargo: "supplies", point: pid, unit: top, callTick: state.tick, enterTick: state.tick + secondsToTicks(delayS), entry, load,
    ...(ordered ? { ordered: true as const } : {}),
  };
  const dueS = Math.round(delayS);
  events.emit({ kind: "supply.delivery", tick: state.tick, side: u.side, vehicle: asset, phase: "called", point: pid, unit: top, rounds: roundsIn(ctx, load), kg: Math.round(massOf(ctx, load)), dueS, ...(ordered ? { ordered: true as const } : {}) });
  if (!ordered) radio(state, events, top, "radio.deliveryCalled", { min: Math.round(dueS / 60) });
  return true;
}

function mergeLoads(a: readonly ItemStack[], b: readonly ItemStack[]): ItemStack[] {
  const out = a.map((s) => ({ ...s }));
  for (const s of b) { const o = out.find((x) => x.type === s.type && x.charge === s.charge); if (o) o.count += s.count; else out.push({ ...s }); }
  return out;
}

/**
 * The player's `callDelivery` order (M11.4b, "Order a delivery"): the target's platoon calls a delivery to its supply
 * point; `vehicle` names the vehicle (an ambulance: carried out, but a breach of the law of war).
 */
export function callDeliveryOrder(ctx: SimContext, state: SimState, events: EventSink, order: Order & { kind: "callDelivery" }): OrderResult {
  const uid = state.unit.has(order.target) ? order.target : state.identity.get(order.target)?.unit;
  const u = uid === undefined ? undefined : state.unit.get(uid);
  if (!u || u.asset !== undefined || uid === undefined) return "unable";
  return callDelivery(ctx, state, events, topOf(state, uid), order.player === true, order.vehicle);
}

/** Each second: the support top-up, automatic calls every `checkS`, and every delivery run. */
export function deliverySystem(ctx: SimContext, state: SimState, events: EventSink): void {
  if (state.stock.size === 0 || !deliveriesEnabled(ctx)) return;
  const S = ctx.catalog.supply!, D = S.delivery;
  if (state.tick % secondsToTicks(1) !== 0) return;
  if (state.tick % secondsToTicks(S.topUpCheckS ?? 10) === 0) topUp(ctx, state, events);
  if (!D) return;
  if (state.tick % secondsToTicks(D.checkS) === 0) autoCalls(ctx, state, events);
  // off-map: ok (the delivery vehicles themselves, on the map or not)
  for (const [vid, v] of state.vehicle.entries()) {
    const o = v.offMap;
    if (o?.cargo === "supplies" || (o?.kind === "supply" && o.phase === "away")) stepRun(ctx, state, events, vid, v, o);
  }
}

/** The support top-up of each stock that has one, when due. */
function topUp(ctx: SimContext, state: SimState, events: EventSink): void {
  for (const [sid, st] of state.stock.entries()) {
    if (!st.topUp || state.tick < (st.nextTopUpTick ?? 0)) continue;
    st.nextTopUpTick = (st.nextTopUpTick ?? 0) + secondsToTicks(st.topUp.everyS);
    for (const sec of state.support) {
      if (sec.side !== st.side) continue;
      let left = st.topUp.rounds;
      for (const type of [sec.heType, sec.smokeType]) {
        if (left <= 0) break;
        const n = fromStock(ctx, state, events, sid, sec.battery, type, left);
        if (n > 0) { left -= n; events.emit({ kind: "supply.topUp", tick: state.tick, side: st.side, battery: sec.battery, item: type, count: n }); }
      }
    }
    // M11.5: the side's on-map mortar sections get theirs beside their tubes (a cache their men fetch from).
    if (ctx.catalog.supply?.mortarFetch === undefined) continue;
    for (const [sec, tubes] of onMapSections(ctx, state, st.side)) {
      let left = st.topUp.rounds;
      let cache: EntityId | null = null;
      for (const [cid, c] of state.cache.entries()) if (c.tubes === sec && c.side === st.side && c.cookoff === undefined && c.burnt !== true) { cache = cid; break; }
      if (cache === null) {
        // Beside the tubes, a few metres behind where their gunners face.
        let x = 0, y = 0, hx = 0, hy = 0;
        for (const t of tubes) { x += t.x; y += t.y; const h = state.transform.get(t.carrier)?.heading ?? 0; hx += cos(h); hy += sin(h); }
        x /= tubes.length; y /= tubes.length;
        const L = hypot2(hx, hy);
        if (L > 1e-6) { x -= (hx / L) * TUBE_CACHE_M; y -= (hy / L) * TUBE_CACHE_M; }
        x = Math.min(Math.max(x, 1), ctx.map.widthM - 1); y = Math.min(Math.max(y, 1), ctx.map.heightM - 1);
        cache = newCache(state, st.side, x, y, []);
        state.cache.req(cache).tubes = sec;
      }
      const def = tubes[0]!.def;
      for (const type of [def.he, def.smoke]) {
        if (left <= 0) break;
        const n = fromStock(ctx, state, events, sid, cache, type, left);
        if (n > 0) { left -= n; events.emit({ kind: "supply.topUp", tick: state.tick, side: st.side, battery: cache, item: type, count: n }); }
      }
    }
  }
}

/** A cache for a mortar section's top-up lies this far behind its tubes (m). */
const TUBE_CACHE_M = 8;

/** M11.5: the side's on-map mortar sections (the teams' parent unit, or the team) and their tubes, by section id. */
function onMapSections(ctx: SimContext, state: SimState, side: SideId): [EntityId, Tube[]][] {
  const out = new Map<EntityId, Tube[]>();
  for (const [uid, u] of state.unit.entries()) {
    if (!u.mortar || u.side !== side) continue;
    const t = tubeOf(ctx, state, uid);
    if (!t) continue;
    const sec = u.parent ?? uid;
    const l = out.get(sec);
    if (l) l.push(t); else out.set(sec, [t]);
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0]);
}

/** Automatic calls: a supply point below `callBelow` of its fill, or a platoon whose squad asked lately without one. */
function autoCalls(ctx: SimContext, state: SimState, events: EventSink): void {
  const S = ctx.catalog.supply!, D = S.delivery!;
  const tops = new Set<EntityId>();
  for (const [pid, p] of [...state.rear.entries()].sort((a, b) => a[0] - b[0])) {
    if (p.kind !== "supply" || p.cache === undefined) continue;
    const c = state.cache.get(p.cache);
    if (!c || c.cookoff !== undefined || c.burnt === true) continue;
    tops.add(p.unit);
    const have = roundsInContainer(ctx, state.container.get(p.cache));
    if (c.fill === undefined && have > 0) { c.fill = have; continue; }
    if (c.fill !== undefined && have >= D.callBelow * c.fill) continue;
    tryCall(ctx, state, events, p.unit, pid);
  }
  // A platoon without a point whose squad asked lately (within `request.everyS`): a point is sited and supplies called.
  const R = S.request;
  if (!R) return;
  for (const [uid, u] of state.unit.entries()) {
    if (u.parent === null || u.supplyAsk === undefined || state.tick - u.supplyAsk.tick > secondsToTicks(R.everyS)) continue;
    const top = topOf(state, uid);
    if (tops.has(top)) continue;
    tops.add(top);
    tryCall(ctx, state, events, top, null);
  }
}

function tryCall(ctx: SimContext, state: SimState, events: EventSink, top: EntityId, _pid: EntityId | null): void {
  const u = state.unit.get(top);
  if (!u || !onAir(state, top) || stockOf(state, u.side) === null) return;
  if (deliveryUnderWay(state, u.side) || readySupply(ctx, state, u.side) === null) return;
  callDelivery(ctx, state, events, top, false);
}

function emit(state: SimState, events: EventSink, vid: EntityId, v: VehicleState, phase: "entered" | "arrived" | "unloaded" | "away" | "ready" | "lost" | "cancelled", extra: { rounds?: number } = {}): void {
  const o = v.offMap!;
  events.emit({ kind: "supply.delivery", tick: state.tick, side: v.side, vehicle: vid, phase, ...(o.point !== undefined ? { point: o.point } : {}), ...(o.unit !== undefined ? { unit: o.unit } : {}), ...(o.ordered ? { ordered: true as const } : {}), ...extra });
}

/** The spot it stops at for point `pid`, and whether it is there. */
function goalFor(ctx: SimContext, state: SimState, vid: EntityId, v: VehicleState, px: number, py: number): { x: number; y: number } {
  const D = ctx.catalog.supply!.delivery!;
  return standSpot(ctx, state.transform.req(vid), px, py, D.standM, ctx.catalog.vehicles[v.def]!.class);
}

function stepRun(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, v: VehicleState, o: OffMapAsset): void {
  const D = ctx.catalog.supply!.delivery!;
  const tick = state.tick;
  if (o.phase === "away") {
    if (tick < (o.backTick ?? 0)) return;
    // Ready for the next call (an ambulance back to its own work; the load not unloaded stays aboard).
    const load = o.load;
    v.offMap = { kind: o.kind, phase: "ready", ...(load && load.length > 0 ? { load } : {}) };
    emit(state, events, vid, v, "ready");
    return;
  }
  if (o.phase === "ready" || o.phase === "lost") return;
  if (o.phase === "called") {
    if (tick < (o.enterTick ?? 0)) return;
    const entry = o.entry!;
    const t = state.transform.req(vid);
    t.x = entry.x; t.y = entry.y; t.z = 0; t.heading = entry.heading;
    const d = v.drive;
    d.progressX = entry.x; d.progressY = entry.y; d.progressTick = tick; d.backX = entry.x; d.backY = entry.y; d.brake = 0;
    for (const sid of v.seats) { if (sid === null) continue; const mt = state.transform.get(sid); if (mt) { mt.x = entry.x; mt.y = entry.y; mt.z = 0; } }
    v.movedTick = tick;
    o.phase = "inbound"; delete o.arriveTick; o.retryTick = tick;
    emit(state, events, vid, v, "entered");
  }
  if (!canDrive(ctx, state, v)) {
    // Stranded on the map: an ordinary hull from now on (its load stays aboard).
    o.phase = "lost";
    emit(state, events, vid, v, "lost");
    return;
  }
  const t = state.transform.req(vid);
  const p = o.point !== undefined ? state.rear.get(o.point) : undefined;
  if (o.phase === "inbound") {
    if (!p || p.cache === undefined || !state.cache.has(p.cache)) { goBack(ctx, state, events, vid, v, o, "cancelled"); return; }
    const dP = hypot2(t.x - p.x, t.y - p.y);
    let near = dP <= D.standM + 10 || (o.goal !== undefined && hypot2(t.x - o.goal.x, t.y - o.goal.y) <= 6);
    if (!near && dP <= HELD_UP_NEAR_M && v.drive.arrived && (v.drive.stuckTicks > 0 || v.drive.replans >= 2)) near = true;
    if (near) {
      vehicleHalt(state, vid);
      o.phase = "loading"; o.arriveTick = tick;
      o.unloadTick = tick + secondsToTicks(D.unloadBaseS + D.unloadSecondsPerKg * massOf(ctx, o.load ?? []));
      emit(state, events, vid, v, "arrived");
      if (o.unit !== undefined) radio(state, events, o.unit, "radio.deliveryArrived");
      return;
    }
    if (ticksToSeconds(tick - (o.enterTick ?? tick)) >= D.heldMaxS) { goBack(ctx, state, events, vid, v, o, "cancelled"); return; }
    const moved = !o.goal || hypot2(o.goal.px - p.x, o.goal.py - p.y) > D.standM;
    if (moved || (v.drive.arrived && tick >= (o.retryTick ?? 0))) {
      const g = goalFor(ctx, state, vid, v, p.x, p.y);
      o.goal = { x: g.x, y: g.y, px: p.x, py: p.y };
      vehicleMove(ctx, state, vid, [{ x: g.x, y: g.y, mode: D.pace }], undefined);
      o.retryTick = tick + secondsToTicks(RETRY_S);
    }
    return;
  }
  if (o.phase === "loading") {
    if (tick < (o.unloadTick ?? 0)) return;
    const cache = p?.cache;
    let n = 0;
    if (cache !== undefined && state.cache.has(cache) && o.load) {
      n = unloadInto(ctx, state, vid, cache, o.load);
      const c = state.cache.req(cache);
      if (c.fill === undefined) c.fill = roundsInContainer(ctx, state.container.get(cache));
    }
    delete o.load;
    if (v.misuse === true) delete v.misuse;
    emit(state, events, vid, v, "unloaded", { rounds: n });
    if (o.unit !== undefined) radio(state, events, o.unit, "radio.deliveryUnloaded", { rounds: n });
    goBack(ctx, state, events, vid, v, o, null);
    return;
  }
  if (o.phase === "outbound") {
    const entry = o.entry!;
    if (hypot2(t.x - entry.x, t.y - entry.y) <= D.edgeM || ticksToSeconds(tick - (o.departTick ?? tick)) >= D.heldMaxS) { offTheMap(ctx, state, events, vid, v, o); return; }
    if (v.drive.arrived && tick >= (o.retryTick ?? 0)) {
      vehicleMove(ctx, state, vid, [{ x: entry.x, y: entry.y, mode: D.pace }], undefined);
      o.retryTick = tick + secondsToTicks(RETRY_S);
    }
  }
}

/** Back to where it came on (unloaded, or giving up with its load). */
function goBack(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, v: VehicleState, o: OffMapAsset, why: "cancelled" | null): void {
  const D = ctx.catalog.supply!.delivery!;
  if (why !== null) { emit(state, events, vid, v, why); if (o.unit !== undefined) radio(state, events, o.unit, "radio.deliveryNoWay"); }
  o.phase = "outbound"; o.departTick = state.tick;
  delete o.goal;
  const p = o.point !== undefined ? state.rear.get(o.point) : undefined;
  backAwayAndGo(ctx, state, vid, p, o.entry!, D.pace, D.nearPace);
  o.retryTick = state.tick + secondsToTicks(RETRY_S);
}

/** Off the map: it waits `turnaroundS`, then is ready for the next call. */
function offTheMap(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, v: VehicleState, o: OffMapAsset): void {
  const D = ctx.catalog.supply!.delivery!;
  o.phase = "away"; o.leftTick = state.tick; o.backTick = state.tick + secondsToTicks(D.turnaroundS);
  delete o.goal; delete o.retryTick; delete o.unloadTick;
  parkOffMap(state, vid);
  if (v.unit !== null) { const u = state.unit.get(v.unit); if (u) u.moving = false; }
  emit(state, events, vid, v, "away");
}

/** Is this vehicle on a delivery on the map (for the interface)? */
export function onDelivery(v: VehicleState): boolean {
  return v.offMap?.cargo === "supplies" && !isOffMap(v) && v.offMap.phase !== "lost";
}
