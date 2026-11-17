/**
 * RE-ARMING AND REFUELLING VEHICLES, ROUNDS TO ON-MAP MORTARS (M11.5, plan slice 48; owner answers 2026-11-16:
 * everything in scope, delivery by bearers, vehicle runs and off-map, control automatic plus player orders). Values:
 * core/supply.json `rearm`, `refuel`, `mortarFetch` (game values, low).
 *
 *   re-arming   A halted hull (crew aboard, not hit for `rearm.quietS`, not burning, towed, under repair, away or on
 *               a rear run) within `rearm.standM` of an own cache, or of an own supply vehicle on the map, that holds
 *               items of its stowage takes them: whole items (`transferItems`) while the stowage holds fewer rounds of
 *               that type than the data stows. `baseS` to open up and start, then `secondsPerKg` per kg of each item.
 *               Its ready racks and belts refill from the stowage as before (gunnery.ts, owner Q17). Ammunition and
 *               reactive tiles alike (a tile is only moved here: fitting one is the repair session's); a marked
 *               ambulance takes no ammunition (law of war).
 *   refuelling  Then, or instead, litres by `moveCharge` into the tank: from fuel cans (any item of the tank's charge
 *               kind other than a tank; `refuel.jerrycanLpm`, one can at a time) or, from a supply vehicle, its own
 *               tank above `refuel.keepL` by pump (`pumpLpm`, a minute's worth at a time); `setupS` first. The empty
 *               cans stay where they were (counted items).
 *   asking      An idle hull (rear-run rules) below `rearm.below` of its stowed ammunition or `refuel.callBelow` of
 *               its tank drives to the nearest own cache within `rearm.driveM` that has something for it, works there
 *               and drives back (`heading`); with none, it goes on a supply run when its side has a stock (M11.4b,
 *               rearrun.ts decides both). A move order to its crew ends it (what was moved stays).
 *   mortars     An on-map mortar team holding fewer than `mortarFetch.below` rounds sends a man (not its gunner if it
 *               can) to the nearest own cache within `reachM` of the tube holding its rounds; he takes up to
 *               `carryKg` of them and walks back (the M11.3 resupply errand). The tube stays set up meanwhile.
 *
 * Every piece of work is timed by the state (`VehicleResupply.nextTick`), deterministic, and conserves items and
 * litres exactly (no event needed: nothing enters or leaves the battle). Same rules for every side.
 */
import type { VehicleDef } from "../catalog";
import type { VehicleResupply, VehicleState } from "../components";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { secondsToTicks, type DefId, type EntityId, type SideId } from "../ids";
import { isAble } from "../impair";
import { moveCharge, transferItems } from "../items";
import { hypot2 } from "../math";
import { isOffMap } from "../offmap";
import type { Order } from "../orders";
import type { SimState } from "../state";
import { fuelLitres, vehicleMove } from "./drive";
import { standSpot } from "./evacuation";
import { markedHull } from "./delivery";
import { teamRounds, tubeOf } from "./mortars";
import { resupplyAtOrder } from "./supply";

/** Gives up driving to a cache after this (s). */
const GO_MAX_S = 600;
/** After an order stopped its work, a hull starts none on its own for this long (s). */
const ORDER_HOLD_S = 120;
/** A halted hull beside a source refuels on its own only when its tank is short by this share or more. */
const PASSIVE_FUEL_SHARE = 0.05;

export function rearmEnabled(ctx: SimContext): boolean {
  return ctx.catalog.supply?.rearm !== undefined && ctx.rules.resupply !== false;
}

// ---------------------------------------------------------------- what a hull wants

/** One type of a hull's stowage it can take: the rounds (or items) the data stows and what it holds now. */
export interface StowWant { type: DefId; per: number; want: number; have: number; ammo: boolean }

/** Is a stowed item ammunition (by its cartridge, or a whole round)? */
function isAmmoItem(ctx: SimContext, item: DefId, charge: number | undefined): boolean {
  const d = ctx.catalog.items[item];
  return charge !== undefined ? d?.chargeItem !== undefined && ctx.catalog.ammo[d.chargeItem] !== undefined : ctx.catalog.ammo[item] !== undefined;
}

/**
 * What hull `vid` can take into its stowage: per stowed type of ammunition (none for a marked ambulance) and reactive
 * tile, the rounds (or items) the data stows and what its container holds now.
 */
export function stowageWants(ctx: SimContext, state: SimState, vid: EntityId, v: VehicleState): StowWant[] {
  const def = ctx.catalog.vehicles[v.def], k = state.container.get(vid);
  const out: StowWant[] = [];
  if (!def || !k) return out;
  const marked = markedHull(ctx, v);
  const tiles = def.armour?.tiles;
  for (const st of def.stowed) {
    const ammo = isAmmoItem(ctx, st.item, st.charge);
    const tile = !ammo && tiles !== undefined && tiles.some((t) => t.item === st.item);
    if ((!ammo && !tile) || (ammo && marked)) continue;
    const per = st.charge ?? 1;
    let have = 0;
    for (const s of k.stacks) if (s.type === st.item) have += (s.charge ?? 1) * s.count;
    out.push({ type: st.item, per, want: per * st.count, have, ammo });
  }
  return out;
}

/** Its stowed ammunition as a share of what the data stows (1 with none stowed). */
export function ammoShare(wants: readonly StowWant[]): number {
  let want = 0, have = 0;
  for (const w of wants) if (w.ammo) { want += w.want; have += Math.min(w.have, w.want); }
  return want > 0 ? have / want : 1;
}

/** Litres its tank is short of full (whole litres). */
export function fuelShortL(state: SimState, vid: EntityId, def: VehicleDef): number {
  return Math.max(0, Math.floor(def.fuel.capacityL - fuelLitres(state, vid, def) + 1e-9));
}

/** The charge kind of its tank (litres of what), or undefined. */
function tankKind(ctx: SimContext, def: VehicleDef): string | undefined {
  return ctx.catalog.items[def.fuel.item]?.chargeKind;
}

/** The fullest item at `source` that fits a want (whole items of the type, no more than it is short), or null. A
 *  supply vehicle keeps what its own data stows (its crew's kit): only its cargo is given. */
function nextItem(ctx: SimContext, state: SimState, source: EntityId, wants: readonly StowWant[]): { type: DefId; charge?: number; per: number } | null {
  const k = state.container.get(source);
  if (!k) return null;
  const sv = state.vehicle.get(source);
  const own = sv ? ctx.catalog.vehicles[sv.def]?.stowed : undefined;
  for (const w of wants) {
    if (own !== undefined && own.some((o) => o.item === w.type)) continue;
    const missing = w.want - w.have;
    if (missing <= 0) continue;
    let best: { type: DefId; charge?: number; per: number } | null = null;
    for (const s of k.stacks) {
      if (s.type !== w.type || s.count <= 0) continue;
      const per = s.charge ?? 1;
      if (per <= 0 || per > missing) continue;
      if (!best || per > best.per) best = s.charge !== undefined ? { type: s.type, charge: s.charge, per } : { type: s.type, per };
    }
    if (best) return best;
  }
  return null;
}

/** A supply vehicle that can give (own side, on the map, with cargo room in its data, halted). */
function supplyVehicle(ctx: SimContext, state: SimState, id: EntityId, side: SideId): VehicleState | null {
  const sv = state.vehicle.get(id);
  if (!sv || sv.side !== side || isOffMap(sv) || ctx.catalog.vehicles[sv.def]?.cargo === undefined) return null;
  if (sv.status === "destroyed" || sv.fire !== null || !sv.drive.arrived || Math.abs(sv.drive.speed) > 0.2) return null;
  return sv;
}

/** The next litres for the tank from `source`: its fullest fuel can of the tank's kind, else (a supply vehicle) its
 *  own tank above `keepL` by pump. Null: nothing for it. */
function fuelFrom(ctx: SimContext, state: SimState, source: EntityId, def: VehicleDef, side: SideId, short: number): { type: DefId; charge: number; litres: number; pump?: true } | null {
  const R = ctx.catalog.supply!.refuel;
  const kind = tankKind(ctx, def);
  if (!R || kind === undefined || short <= 0) return null;
  const k = state.container.get(source);
  if (!k) return null;
  const sv = supplyVehicle(ctx, state, source, side);
  const ownTank = sv ? ctx.catalog.vehicles[sv.def]!.fuel.item : undefined;
  let best: { type: DefId; charge: number } | null = null;
  for (const s of k.stacks) {
    const d = ctx.catalog.items[s.type];
    if (s.count <= 0 || (s.charge ?? 0) <= 0 || d?.chargeKind !== kind || d.category === "fuel" || s.type === ownTank) continue;
    if (!best || s.charge! > best.charge) best = { type: s.type, charge: s.charge! };
  }
  if (best) return { ...best, litres: Math.min(best.charge, short) };
  if (sv && ownTank !== undefined && ctx.catalog.items[ownTank]?.chargeKind === kind) {
    const sdef = ctx.catalog.vehicles[sv.def]!;
    const spare = Math.floor(fuelLitres(state, source, sdef) - R.keepL);
    if (spare > 0) {
      let tank: { type: DefId; charge: number } | null = null;
      for (const s of k.stacks) if (s.type === ownTank && s.count > 0 && (s.charge ?? 0) > 0 && (!tank || s.charge! > tank.charge)) tank = { type: s.type, charge: s.charge! };
      if (tank) return { ...tank, litres: Math.min(short, spare, tank.charge, Math.max(1, Math.floor(R.pumpLpm))), pump: true };
    }
  }
  return null;
}

/** Can `source` give the hull something it is short of (ammunition or tiles: `ammo`; litres: `fuel`)? */
function hasFor(ctx: SimContext, state: SimState, vid: EntityId, v: VehicleState, source: EntityId, ammo: boolean, fuel: boolean): boolean {
  const def = ctx.catalog.vehicles[v.def];
  if (!def) return false;
  if (ammo && nextItem(ctx, state, source, stowageWants(ctx, state, vid, v)) !== null) return true;
  return fuel && fuelFrom(ctx, state, source, def, v.side, fuelShortL(state, vid, def)) !== null;
}

/** Is cache `id` one the side can take from (its own, not burning or burnt, not in bearers' hands)? */
function usableCache(state: SimState, id: EntityId, side: SideId): boolean {
  const c = state.cache.get(id);
  return c !== undefined && c.side === side && c.cookoff === undefined && c.burnt !== true && c.carried !== true;
}

// ---------------------------------------------------------------- at work

/** May the crew work at stowage and tank now (see the header)? */
function canWork(ctx: SimContext, state: SimState, v: VehicleState, def: VehicleDef): boolean {
  const R = ctx.catalog.supply!.rearm!;
  if (isOffMap(v) || v.offMap !== undefined || v.rearRun || v.towedBy !== undefined || v.recoveryBy !== undefined || v.unit === null) return false;
  if (v.status === "destroyed" || v.status === "abandoned" || v.crewReaction === "bailOut" || v.crewReaction === "reverseOut" || v.fire !== null || v.repair?.working === true) return false;
  if (!v.drive.arrived || Math.abs(v.drive.speed) > 0.2) return false;
  if (state.tick - v.lastHitTick < secondsToTicks(R.quietS)) return false;
  for (let i = 0; i < v.seats.length; i++) {
    const o = v.seats[i];
    if (o !== null && o !== undefined && def.seats[i]?.station !== "passenger" && isAble(state.soldier.get(o))) return true;
  }
  return false;
}

/** The own source (cache, then supply vehicle) nearest the hull within `r` that has something for it, or null. */
function sourceNear(ctx: SimContext, state: SimState, vid: EntityId, v: VehicleState, r: number, ammo: boolean, fuel: boolean): EntityId | null {
  const t = state.transform.req(vid);
  let best: EntityId | null = null, bestD = r;
  for (const [id] of state.cache.entries()) {
    if (!usableCache(state, id, v.side)) continue;
    const ct = state.transform.get(id);
    if (!ct) continue;
    const d = hypot2(ct.x - t.x, ct.y - t.y);
    if (d <= bestD && hasFor(ctx, state, vid, v, id, ammo, fuel)) { bestD = d; best = id; }
  }
  if (best !== null) return best;
  for (const [id, sv] of state.vehicle.entries()) { // off-map: ok (supplyVehicle skips off-map hulls)
    if (id === vid || sv.side !== v.side || ctx.catalog.vehicles[sv.def]?.cargo === undefined || supplyVehicle(ctx, state, id, v.side) === null) continue;
    const st = state.transform.req(id);
    const d = hypot2(st.x - t.x, st.y - t.y);
    if (d <= bestD && hasFor(ctx, state, vid, v, id, ammo, fuel)) { bestD = d; best = id; }
  }
  return best;
}

/** Is the source still there, the side's and within reach of the hull? */
function sourceOk(ctx: SimContext, state: SimState, vid: EntityId, v: VehicleState, source: EntityId): boolean {
  const R = ctx.catalog.supply!.rearm!;
  if (state.cache.has(source)) { if (!usableCache(state, source, v.side)) return false; }
  else if (supplyVehicle(ctx, state, source, v.side) === null) return false;
  const a = state.transform.req(vid), b = state.transform.get(source);
  return b !== undefined && hypot2(a.x - b.x, a.y - b.y) <= R.standM + 0.5;
}

function emit(state: SimState, events: EventSink, vid: EntityId, v: VehicleState, r: VehicleResupply, phase: "heading" | "started" | "done" | "stopped", why?: string): void {
  events.emit({
    kind: "vehicle.resupply", tick: state.tick, vehicle: vid, side: v.side, what: r.what, phase, source: r.source,
    ...(r.items > 0 ? { items: r.items } : {}), ...(r.rounds > 0 ? { rounds: r.rounds } : {}), ...(r.litres > 0 ? { litres: r.litres } : {}), ...(why !== undefined ? { why } : {}),
  });
}

/** Start work at `source` (halted beside it). */
function startWork(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, v: VehicleState, source: EntityId, from?: { x: number; y: number }): void {
  const S = ctx.catalog.supply!;
  const ammo = nextItem(ctx, state, source, stowageWants(ctx, state, vid, v)) !== null;
  const what = ammo ? "rearm" : "refuel";
  const setupS = what === "rearm" ? S.rearm!.baseS : S.refuel?.setupS ?? 0;
  v.resupply = { phase: "work", source, what, startTick: state.tick, nextTick: state.tick + secondsToTicks(setupS), items: 0, rounds: 0, litres: 0, ...(from ? { from } : {}) };
  emit(state, events, vid, v, v.resupply, "started");
}

/** Done or stopped: the event, and back to where it came from when it drove there on its own. */
function finish(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, v: VehicleState, phase: "done" | "stopped", why?: string): void {
  const r = v.resupply!;
  emit(state, events, vid, v, r, phase, why);
  delete v.resupply;
  if (r.from && phase === "done" && why === undefined) back(ctx, state, vid, r.from);
}

function back(ctx: SimContext, state: SimState, vid: EntityId, from: { x: number; y: number }): void {
  const pace = paceOf(ctx);
  if (pace !== undefined) vehicleMove(ctx, state, vid, [{ x: from.x, y: from.y, mode: pace }], undefined);
}

function paceOf(ctx: SimContext): DefId | undefined {
  return ctx.catalog.supply?.delivery?.pace ?? ctx.catalog.medical?.rearRun?.pace;
}

/** The piece of work due now is done (moved), and the next one picked; none left: done. */
function stepWork(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, v: VehicleState, def: VehicleDef): void {
  const S = ctx.catalog.supply!, R = S.rearm!, F = S.refuel;
  const r = v.resupply!;
  const ch = r.chunk;
  if (ch) {
    if (ch.litres !== undefined) {
      // Litres into the tank (the fullest tank item: the only one).
      const k = state.container.get(vid);
      let tank: number | undefined;
      if (k) for (const s of k.stacks) if (s.type === def.fuel.item && s.count > 0) { tank = s.charge ?? 0; break; }
      if (tank !== undefined && ch.charge !== undefined) {
        const m = moveCharge(ctx.catalog, state.container, { from: r.source, fromType: ch.type, fromCharge: ch.charge, to: vid, toType: def.fuel.item, toCharge: tank, amount: ch.litres });
        r.litres += m.moved;
      }
    } else {
      const m = transferItems(ctx.catalog, state.container, ch.charge !== undefined ? { from: r.source, to: vid, type: ch.type, count: 1, charge: ch.charge } : { from: r.source, to: vid, type: ch.type, count: 1 });
      if (m.moved > 0) { r.items++; if (isAmmoItem(ctx, ch.type, ch.charge)) r.rounds += ch.charge ?? 1; }
    }
    delete r.chunk;
  }
  // The next piece: items while re-arming, then litres.
  if (r.what === "rearm") {
    const it = nextItem(ctx, state, r.source, stowageWants(ctx, state, vid, v));
    if (it) {
      const d = ctx.catalog.items[it.type]!;
      const kg = d.massKg + (it.charge ?? 0) * (d.chargeMassKg ?? 0);
      r.chunk = it.charge !== undefined ? { type: it.type, charge: it.charge } : { type: it.type };
      r.nextTick = state.tick + Math.max(1, secondsToTicks(kg * R.secondsPerKg));
      return;
    }
    // Rounds done: fuel next, if there is any for it here.
    if (F && fuelFrom(ctx, state, r.source, def, v.side, fuelShortL(state, vid, def)) !== null) {
      emit(state, events, vid, v, r, "done");
      r.what = "refuel"; r.items = 0; r.rounds = 0;
      r.nextTick = state.tick + secondsToTicks(F.setupS);
      return;
    }
    finish(ctx, state, events, vid, v, "done");
    return;
  }
  const f = F ? fuelFrom(ctx, state, r.source, def, v.side, fuelShortL(state, vid, def)) : null;
  if (!f || !F) { finish(ctx, state, events, vid, v, "done"); return; }
  r.chunk = f.pump ? { type: f.type, charge: f.charge, litres: f.litres, pump: true } : { type: f.type, charge: f.charge, litres: f.litres };
  r.nextTick = state.tick + Math.max(1, secondsToTicks((f.litres / (f.pump ? F.pumpLpm : F.jerrycanLpm)) * 60));
}

/**
 * Each `rearm.stepS` (a piece of work ends at the first step at or after its time): halted hulls beside a source start,
 * hulls driving to one arrive or give up, hulls that may no longer work stop. Then the mortar teams.
 */
export function rearmSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  if (!rearmEnabled(ctx) || state.vehicle.size === 0) return;
  const R = ctx.catalog.supply!.rearm!;
  // (Once a step: a piece of work ends at the first step at or after its time; per-tick work stays nil.)
  if (state.tick % Math.max(1, secondsToTicks(R.stepS)) !== 0) return;
  // (Nothing to take from anywhere: nothing to look at; a hull already at work still finishes or stops.)
  const sources = state.cache.size > 0 || supplyOnMap(ctx, state);
  for (const [vid, v] of state.vehicle.entries()) { // off-map: ok (canWork skips off-map hulls; a hull at work away stops)
    const r = v.resupply;
    if (!r && !sources) continue;
    const def = ctx.catalog.vehicles[v.def];
    if (!def) continue;
    if (r?.phase === "work") {
      if (!canWork(ctx, state, v, def) || !sourceOk(ctx, state, vid, v, r.source)) {
        const why = state.tick - v.lastHitTick < secondsToTicks(R.quietS) ? "hit" : !sourceOk(ctx, state, vid, v, r.source) ? "source" : "moved";
        finish(ctx, state, events, vid, v, "stopped", why);
        continue;
      }
      if (state.tick >= r.nextTick) stepWork(ctx, state, events, vid, v, def);
      continue;
    }
    if (r?.phase === "go") {
      const t = state.transform.req(vid), st = state.transform.get(r.source);
      const ok = st !== undefined && (state.cache.has(r.source) ? usableCache(state, r.source, v.side) : supplyVehicle(ctx, state, r.source, v.side) !== null);
      if (!ok || state.tick - r.startTick > secondsToTicks(GO_MAX_S) || v.rearRun || isOffMap(v)) { finish(ctx, state, events, vid, v, "stopped", "source"); continue; }
      if (hypot2(t.x - st.x, t.y - st.y) <= R.standM && canWork(ctx, state, v, def)) { const from = r.from; delete v.resupply; startWork(ctx, state, events, vid, v, r.source, from); continue; }
      if (v.drive.arrived && Math.abs(v.drive.speed) < 0.2) {
        // (Stopped short: try to get closer once more, else work if it is within reach anyway.)
        const pace = paceOf(ctx);
        const g = standSpot(ctx, t, st.x, st.y, R.standM * 0.4, def.class);
        if (pace === undefined || vehicleMove(ctx, state, vid, [{ x: g.x, y: g.y, mode: pace }], undefined) !== true) finish(ctx, state, events, vid, v, "stopped", "noWay");
      }
      continue;
    }
    // Idle beside a source: start (halted, crew aboard, quiet, something it is short of there).
    if (state.tick < (v.resupplyHoldTick ?? 0) || !canWork(ctx, state, v, def)) continue;
    // (Fuel only when a can's worth or more is missing: no stop for the few litres burnt since the last fill.)
    const src = sourceNear(ctx, state, vid, v, R.standM, true, fuelShortL(state, vid, def) >= PASSIVE_FUEL_SHARE * def.fuel.capacityL);
    if (src !== null) startWork(ctx, state, events, vid, v, src);
  }
}

/** Any supply vehicle of any side on the map (on a delivery, or an ordinary hull)? */
function supplyOnMap(ctx: SimContext, state: SimState): boolean {
  for (const [, v] of state.vehicle.entries()) if (ctx.catalog.vehicles[v.def]?.cargo !== undefined && !isOffMap(v)) return true;
  return false;
}

/**
 * M11.5 "asking" (called by rearrun.ts for an idle hull): short of ammunition (`ammo`) or fuel (`fuel`), with an own
 * cache within `rearm.driveM` that has something for it: it drives there (true). False: none; a supply run may follow.
 */
export function goResupply(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, ammo: boolean, fuel: boolean): boolean {
  if (!rearmEnabled(ctx)) return false;
  const R = ctx.catalog.supply!.rearm!;
  const v = state.vehicle.req(vid), def = ctx.catalog.vehicles[v.def];
  const pace = paceOf(ctx);
  if (!def || v.resupply || pace === undefined || state.cache.size === 0 || state.tick < (v.resupplyHoldTick ?? 0)) return false;
  const t = state.transform.req(vid);
  let best: EntityId | null = null, bestD = R.driveM;
  for (const [id] of state.cache.entries()) {
    if (!usableCache(state, id, v.side)) continue;
    const ct = state.transform.get(id);
    if (!ct) continue;
    const d = hypot2(ct.x - t.x, ct.y - t.y);
    if (d <= bestD && hasFor(ctx, state, vid, v, id, ammo, fuel)) { bestD = d; best = id; }
  }
  if (best === null) return false;
  const ct = state.transform.req(best);
  const from = { x: t.x, y: t.y };
  if (bestD <= R.standM && canWork(ctx, state, v, def)) { startWork(ctx, state, events, vid, v, best, undefined); return true; }
  const g = standSpot(ctx, t, ct.x, ct.y, R.standM * 0.4, def.class);
  if (vehicleMove(ctx, state, vid, [{ x: g.x, y: g.y, mode: pace }], undefined) !== true) return false;
  v.resupply = { phase: "go", source: best, what: ammo ? "rearm" : "refuel", startTick: state.tick, nextTick: state.tick, from, items: 0, rounds: 0, litres: 0 };
  emit(state, events, vid, v, v.resupply, "heading");
  return true;
}

/** An order to a hull's crew ends its re-arming or refuelling (what was moved stays). Order kinds that leave the hull
 *  where it is (fire discipline, rules) do not. */
export function resupplyGate(state: SimState, events: EventSink, order: Order): void {
  if (order.kind === "fire" || order.kind === "ceaseFire" || order.kind === "rules" || order.kind === "ambush" || order.kind === "discharge") return;
  const vid = state.unit.get(order.target)?.vehicle;
  const v = vid === undefined ? undefined : state.vehicle.get(vid);
  if (vid === undefined || !v?.resupply) return;
  const r = v.resupply;
  events.emit({
    kind: "vehicle.resupply", tick: state.tick, vehicle: vid, side: v.side, what: r.what, phase: "stopped", source: r.source,
    ...(r.items > 0 ? { items: r.items } : {}), ...(r.rounds > 0 ? { rounds: r.rounds } : {}), ...(r.litres > 0 ? { litres: r.litres } : {}), why: "order",
  });
  delete v.resupply;
  v.resupplyHoldTick = state.tick + secondsToTicks(ORDER_HOLD_S);
}

// ---------------------------------------------------------------- on-map mortars

/** Each `mortarFetch.checkS`: on-map mortar teams short of rounds send a man to an own cache near the tube. */
export function mortarFetchSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  const M = ctx.catalog.supply?.mortarFetch;
  if (!M || ctx.rules.resupply === false || state.cache.size === 0) return;
  if (state.tick % Math.max(1, secondsToTicks(M.checkS)) !== 0) return;
  for (const [uid, u] of state.unit.entries()) {
    if (!u.mortar) continue;
    const tube = tubeOf(ctx, state, uid);
    if (!tube || teamRounds(state, uid, tube.def.he) + teamRounds(state, uid, tube.def.smoke) >= M.below) continue;
    if (u.members.some((m) => state.soldier.get(m)?.intent?.kind === "resupply")) continue;
    let cache: EntityId | null = null, bestD = M.reachM;
    for (const [id] of state.cache.entries()) {
      if (!usableCache(state, id, u.side)) continue;
      const k = state.container.get(id), ct = state.transform.get(id);
      if (!k || !ct || !k.stacks.some((s) => s.count > 0 && (s.type === tube.def.he || s.type === tube.def.smoke))) continue;
      const d = hypot2(ct.x - tube.x, ct.y - tube.y);
      if (d <= bestD) { bestD = d; cache = id; }
    }
    if (cache === null) continue;
    // A man other than the gunner (the tube's carrier) if one can go; else the gunner himself.
    const men = [...u.members.filter((m) => m !== tube.carrier), tube.carrier];
    for (const m of men) {
      const s = state.soldier.get(m);
      if (!isAble(s) || state.action.has(m) || (s!.intent !== null && s!.intent !== undefined)) continue;
      if (resupplyAtOrder(ctx, state, events, [m], u.side, cache) === true) break;
    }
  }
}
