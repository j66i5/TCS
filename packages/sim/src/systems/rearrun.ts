/**
 * COMBAT VEHICLES' REAR RUN (SPEC 9.1 "evacuation by own vehicles"; M10.6b). Owner answer M10-3 Q-9: combat vehicles
 * take wounded when going back or idle; the player can order any vehicle ("evacuate with this vehicle", order
 * `rearRun`). A generic task with a cargo kind: casualties now, ammunition in M11.
 *
 * A run: the hull drives to its platoon's Verwundetennest, halts, its crew takes the men lying there aboard T1 first
 * (as an ambulance does: the fetch on a litter abstracted as a time), drives to the map edge behind the nest and leaves
 * the map: the wounded aboard are handed over (evacuated, their Role 1 outcome settled: aftercare.ts). It is away
 * `awayS` (to the company's Verwundetensammelpunkt and back), then comes onto the map where it left and drives back to
 * its squad's leader (or where it set off from); the run is over there.
 *
 * Automatic ("idle", core/medical.json `rearRun`): a hull that has not moved for `idleS`, was not hit for `quietS`, whose
 * crew knows no enemy within `enemyM`, with no fit men riding in it and its squad in no assault or house clearing,
 * starts a run when `startT1` tagged T1 or `startAny` casualties wait at its platoon's nest within `maxNestM` and no
 * ambulance is there or due within `ambulanceWithinS`; at most `maxPerPlatoon` of a platoon's hulls at once, and the
 * platoon keeps `keepVehicles` on the map. "Going back": a hull carrying wounded aboard (the mount's fetch of M10.4b
 * takes the nest's men along) that stands idle starts a run with them. Same rules for every side, player and AI.
 * While away the hull is off the map (`isOffMap`); an order to its crew then is refused, on the map an order ends the
 * run (the player takes it back).
 *
 * Supplies (M11.4b, plan slice 47): when its side has an off-map stock (`state.stock`), a hull away on a run comes back
 * with its stowage refilled from the stock up to its standard stowage (what the data stows: ammunition only) and up
 * to `supply.vehicleRun.shareKg` of supplies for its platoon's supply point; on the map again it drives there first,
 * is unloaded (`unloadBaseS` + `unloadSecondsPerKg` per kg; the crates into the point's cache) and goes back to its
 * squad. An idle hull whose stowed ammunition is below `vehicleRun.stowageBelow` of standard (and whose side's stock has
 * some for it) starts a run of its own (`cargo` "supplies"), as does the player's `rearRun` with `cargo` "supplies".
 * Never on its own for a marked ambulance; on a player's order ammunition put into one is a breach (`law.misuse`).
 */
import type { RearRun, SoldierState, VehicleState } from "../components";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { secondsToTicks, ticksToSeconds, type DefId, type EntityId } from "../ids";
import { isAble } from "../impair";
import { needsEvacuation } from "../medical";
import { hypot2 } from "../math";
import { isMounted } from "../mount";
import { assetServing, isOffMap, parkOffMap } from "../offmap";
import type { Order } from "../orders";
import type { SimState } from "../state";
import { liesAboard, placesFit, placesUsed, seatCasualty } from "./boarding";
import { vehicleHalt, type OrderResult } from "./drive";
import {
  aboard, backAwayAndGo, canDrive, comingTo, cutShort, driveTo, entryPoint, evacuateAboard, HELD_UP_NEAR_M, radio, standSpot,
  STOP_SLACK_M, waitingAt,
} from "./evacuation";
import { careEnabled, treatedNow } from "./medical";
import { nestOf, supplyPointOf, topOf } from "./nest";
import { ammunitionIntoAmbulance, deliveriesEnabled, fromStock, loadForPlatoon, markedHull, stockOf, unloadInto } from "./delivery";
import { roundsInContainer } from "./supply";
import { fuelShortL, goResupply, rearmEnabled } from "./rearm";
import { moveCharge } from "../items";
import type { VehicleDef } from "../catalog";

/** Off the map within this of the exit when no ambulance data says otherwise (m). */
const EDGE_M = 20;
/** A run cancelled (nobody to take, an order) is not started again on its own for this long (s). */
const RETRY_S = 120;

/** The squad (foot units) this hull carries: units whose own carrier it is. */
function squadsOf(state: SimState, vid: EntityId): EntityId[] {
  const out: EntityId[] = [];
  for (const [uid, u] of state.unit.entries()) if (u.carrier === vid) out.push(uid);
  return out;
}

/** Is a squad of this hull assaulting or clearing a house (no rear run then: plan acceptance)? */
function squadBusy(state: SimState, vid: EntityId): boolean {
  for (const uid of squadsOf(state, vid)) {
    const u = state.unit.get(uid);
    if (!u) continue;
    if (u.drill?.kind === "assault" || u.drill?.kind === "clear" || u.boarding !== undefined) return true;
  }
  return false;
}

/** A casualty to take back: alive, wounded, and out of the fight or needing evacuation. */
function casualty(s: SoldierState | undefined): s is SoldierState {
  // (Review fix: not a man already handed over at the aid post: he would start a new run every minute.)
  return s !== undefined && s.physiology.alive && s.wounds.length > 0 && s.captive === null && s.evacuated === undefined && (!isAble(s) || needsEvacuation(s));
}

/** Wounded passengers aboard (lying or sitting: not the crew's stations). */
function woundedAboard(ctx: SimContext, state: SimState, v: VehicleState): EntityId[] {
  return aboard(v, ctx).filter((m) => casualty(state.soldier.get(m)));
}

/** A fit man riding as a passenger (a squad aboard: no run, it would take them out of the battle). */
function fitRiders(ctx: SimContext, state: SimState, v: VehicleState): boolean {
  return aboard(v, ctx).some((m) => { const s = state.soldier.get(m); return isAble(s) && !casualty(s); });
}

/** Is this hull idle (see the header)? */
function idle(ctx: SimContext, state: SimState, vid: EntityId, v: VehicleState): boolean {
  const R = ctx.catalog.medical!.rearRun!;
  const tick = state.tick;
  if (v.offMap !== undefined || v.rearRun !== undefined || v.unit === null || tick < (v.rearRunRetryTick ?? 0)) return false;
  if (!v.drive.arrived || v.drive.route.length > 0) return false;
  if (tick - (v.movedTick ?? 0) < secondsToTicks(R.idleS)) return false;
  if (tick - v.lastHitTick < secondsToTicks(R.quietS)) return false;
  if (v.crewReaction === "reverseOut" || v.crewReaction === "bailOut") return false;
  if (!canDrive(ctx, state, v) || fitRiders(ctx, state, v) || squadBusy(state, vid)) return false;
  const u = state.unit.get(v.unit);
  if (!u || u.boarding !== undefined) return false;
  const t = state.transform.req(vid), r2 = R.enemyM * R.enemyM;
  for (const m of u.members) {
    const s = state.soldier.get(m);
    if (!s || !isAble(s)) continue;
    for (const c of s.contacts) if (!c.down && !c.surrendered && (c.x - t.x) * (c.x - t.x) + (c.y - t.y) * (c.y - t.y) <= r2) return false;
  }
  return true;
}

/** The platoon (top unit) a hull belongs to, through its crew. */
function topOfHull(state: SimState, v: VehicleState): EntityId | null {
  return v.unit === null ? null : topOf(state, v.unit);
}

/** Start a run for hull `vid` of platoon `top` (to its nest `pid`, or straight back with the men aboard). */
function start(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, top: EntityId, pid: EntityId | null, ordered: boolean, cargo: RearRun["cargo"] = "casualties"): void {
  const v = state.vehicle.req(vid), t = state.transform.req(vid);
  v.rearRun = { phase: "toPoint", cargo, top, startTick: state.tick, from: { x: t.x, y: t.y }, ...(pid !== null ? { point: pid } : {}), ...(ordered ? { ordered: true as const } : {}) };
  events.emit({ kind: "medical.rearRun", tick: state.tick, side: v.side, vehicle: vid, phase: "started", unit: top, ...(pid !== null ? { point: pid } : {}), ...(ordered ? { ordered: true } : {}), ...(cargo === "supplies" ? { cargo } : {}) });
  if (!ordered && v.unit !== null) radio(state, events, v.unit, cargo === "supplies" ? "radio.supplyRun" : "radio.rearRun");
  if (pid === null) leaveFor(ctx, state, events, vid);
}

/** The run is over (back, cancelled, stranded). A run cancelled for want of anyone to take is not tried again soon. */
function end(state: SimState, events: EventSink, vid: EntityId, phase: "back" | "cancelled" | "lost"): void {
  const v = state.vehicle.req(vid), r = v.rearRun!;
  delete v.rearRun;
  if (phase === "cancelled") v.rearRunRetryTick = state.tick + secondsToTicks(RETRY_S);
  if (!isOffMap(v)) vehicleHalt(state, vid);
  events.emit({ kind: "medical.rearRun", tick: state.tick, side: v.side, vehicle: vid, phase, unit: r.top, ...(r.point !== undefined ? { point: r.point } : {}) });
}

/** Set off for the map edge behind the nest (or behind where it stands) with whoever is aboard. */
function leaveFor(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId): void {
  const R = ctx.catalog.medical!.rearRun!;
  const v = state.vehicle.req(vid), r = v.rearRun!, t = state.transform.req(vid);
  const p = r.point !== undefined ? state.rear.get(r.point) : undefined;
  if (r.cargo !== "supplies" && woundedAboard(ctx, state, v).length === 0) { end(state, events, vid, "cancelled"); return; }
  const exit = r.exit ?? entryPoint(ctx, state, r.top, p?.x ?? t.x, p?.y ?? t.y);
  if (!exit) { end(state, events, vid, "cancelled"); return; }
  r.exit = exit;
  delete r.loading;
  r.phase = "outbound"; r.departTick = state.tick;
  events.emit({ kind: "medical.rearRun", tick: state.tick, side: v.side, vehicle: vid, phase: "departed", unit: r.top, aboard: woundedAboard(ctx, state, v).length, ...(r.point !== undefined ? { point: r.point } : {}) });
  backAwayAndGo(ctx, state, vid, p, exit, R.pace, R.pace);
  r.retryTick = state.tick + secondsToTicks(30);
}

/** Each second with the medical system: the runs under way, then automatic starts (see the header). */
export function rearRunSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  if (!careEnabled(ctx)) return;
  const M = ctx.catalog.medical!, R = M.rearRun;
  if (!R || !M.nest) return;
  if (state.tick % Math.max(1, secondsToTicks(M.care.stepS)) !== 0) return;
  // Hulls of the force on the map (no asset); nothing to do in a battle without any.
  let hulls: EntityId[] | null = null;
  for (const [vid, v] of state.vehicle.entries()) if (v.offMap === undefined && v.status !== "destroyed") (hulls ??= []).push(vid);
  if (hulls === null) return;
  // Who lies at which nest.
  let atNest: Map<EntityId, EntityId[]> | null = null;
  for (const [id, s] of state.soldier.entries()) {
    if (s.atNest === undefined || isMounted(s)) continue;
    const l = (atNest ??= new Map()).get(s.atNest);
    if (l) l.push(id); else atNest.set(s.atNest, [id]);
  }
  for (const vid of hulls) if (state.vehicle.req(vid).rearRun) stepRun(ctx, state, events, vid, atNest);
  // ---- going back: an idle hull with wounded aboard takes them off the map
  for (const vid of hulls) {
    const v = state.vehicle.req(vid);
    if (v.rearRun || woundedAboard(ctx, state, v).length === 0 || !idle(ctx, state, vid, v)) continue;
    const top = topOfHull(state, v);
    if (top === null) continue;
    start(ctx, state, events, vid, top, null, false);
  }
  // ---- M11.4b: idle hulls short of ammunition go back for it (when their side's stock has some for them)
  // (M11.5: or to an own cache near by first; short of fuel as well.)
  if ((state.stock.size > 0 && deliveriesEnabled(ctx) && ctx.catalog.supply?.vehicleRun) || (state.cache.size > 0 && rearmEnabled(ctx))) supplyStarts(ctx, state, events, hulls);
  // ---- idle hulls: a nest with T1 (or several) waiting and no ambulance there or due soon
  if (!atNest) return;
  for (const pid of [...atNest.keys()].sort((a, b) => a - b)) {
    const p = state.rear.get(pid);
    if (!p || p.kind !== "medical") continue;
    const waiting = waitingAt(state, pid, atNest.get(pid)!);
    const t1 = waiting.filter((c) => state.soldier.req(c).triage?.cat === 1).length;
    if (t1 < R.startT1 && waiting.length < R.startAny) continue;
    const a = assetServing(state, pid);
    if (a !== null) {
      const o = state.vehicle.req(a).offMap!;
      if (o.phase !== "called" || (o.enterTick ?? 0) - state.tick <= secondsToTicks(R.ambulanceWithinS)) continue;
    }
    let running = 0, onMap = 0;
    const cands: EntityId[] = [];
    for (const vid of hulls) {
      const v = state.vehicle.req(vid);
      if (topOfHull(state, v) !== p.unit) continue;
      if (v.rearRun) { running++; continue; }
      if (!canDrive(ctx, state, v)) continue;
      onMap++;
      if (idle(ctx, state, vid, v)) cands.push(vid);
    }
    if (running >= R.maxPerPlatoon || onMap <= R.keepVehicles || cands.length === 0) continue;
    // The nearest idle hull within reach with room for the first man waiting.
    let best: EntityId | null = null, bd = Infinity;
    for (const vid of cands) {
      const v = state.vehicle.req(vid), def = ctx.catalog.vehicles[v.def];
      if (!def) continue;
      const t = state.transform.req(vid), d = hypot2(t.x - p.x, t.y - p.y);
      if (d > R.maxNestM || d >= bd) continue;
      const used = placesUsed(state, v, def), lies = liesAboard(ctx, state.soldier.req(waiting[0]!));
      if (!placesFit(ctx, def, used.lying + (lies ? 1 : 0), used.sitting + (lies ? 0 : 1))) continue;
      best = vid; bd = d;
    }
    if (best !== null) start(ctx, state, events, best, p.unit, pid, false);
  }
}

function stepRun(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, atNest: Map<EntityId, EntityId[]> | null): void {
  const M = ctx.catalog.medical!, R = M.rearRun!, edgeM = M.evacuation?.edgeM ?? EDGE_M;
  const v = state.vehicle.req(vid), r: RearRun = v.rearRun!;
  const tick = state.tick;
  if (r.phase === "away") {
    if (tick < (r.backTick ?? 0)) return;
    comeBack(ctx, state, events, vid);
    return;
  }
  if (!canDrive(ctx, state, v)) { end(state, events, vid, "lost"); return; }
  const t = state.transform.req(vid);
  // The nest it serves (moved or gone: the platoon's nest now).
  let pid = r.point ?? null;
  if (pid !== null && !state.rear.has(pid)) { pid = nestOf(state, r.top); if (pid !== null) r.point = pid; }
  const p = pid === null ? undefined : state.rear.get(pid);
  if (r.phase === "toPoint") {
    if (!p || pid === null) { leaveFor(ctx, state, events, vid); return; }
    const standM = M.evacuation?.standM ?? 15;
    const moved = !r.goal || hypot2(r.goal.px - p.x, r.goal.py - p.y) > standM;
    if (moved || (v.drive.arrived && tick >= (r.retryTick ?? 0) && hypot2(t.x - r.goal!.x, t.y - r.goal!.y) > 10)) {
      const g = cutShort(ctx, v, t, standSpot(ctx, t, p.x, p.y, standM), p.x, p.y, standM + STOP_SLACK_M);
      r.goal = { x: g.x, y: g.y, px: p.x, py: p.y };
      r.retryTick = tick + secondsToTicks(30);
      if (!driveTo(ctx, state, vid, g.x, g.y, true, R.pace, R.pace)) {
        if (ticksToSeconds(tick - r.startTick) >= R.maxStayS) leaveFor(ctx, state, events, vid);
        return;
      }
    }
    const dNest = hypot2(t.x - p.x, t.y - p.y);
    let near = dNest <= standM + 10 || hypot2(t.x - r.goal!.x, t.y - r.goal!.y) <= 6;
    if (!near && dNest <= HELD_UP_NEAR_M && (v.drive.stuckTicks > 0 || v.drive.replans >= 2) && Math.abs(v.drive.speed) < 0.5) near = true;
    if (!near && ticksToSeconds(tick - r.startTick) >= R.maxStayS) {
      if (hypot2(t.x - r.goal!.x, t.y - r.goal!.y) <= 40) near = true;
      else { leaveFor(ctx, state, events, vid); return; }
    }
    if (!near) return;
    vehicleHalt(state, vid);
    r.phase = "loading"; r.arriveTick = tick; r.lastLoadTick = tick;
    events.emit({ kind: "medical.rearRun", tick, side: v.side, vehicle: vid, phase: "arrived", point: pid, unit: r.top });
    return;
  }
  if (r.phase === "loading") {
    if (!p || pid === null) { leaveFor(ctx, state, events, vid); return; }
    const def = ctx.catalog.vehicles[v.def]!;
    const E = M.evacuation;
    if (r.loading) {
      const c = r.loading.casualty, s = state.soldier.get(c);
      if (tick < r.loading.doneTick) return;
      if (s && s.physiology.alive && s.atNest === pid && !isMounted(s) && !state.carry.has(c)) {
        if (treatedNow(state).has(c)) { r.loading.doneTick = tick + secondsToTicks(5); return; }
        if (seatCasualty(ctx, state, vid, c, events)) {
          delete s.atNest;
          r.lastLoadTick = tick;
          events.emit({ kind: "medical.rearRun", tick, side: v.side, vehicle: vid, phase: "loaded", point: pid, casualty: c });
        }
      }
      delete r.loading;
    }
    const waiting = waitingAt(state, pid, atNest?.get(pid) ?? []);
    const used = placesUsed(state, v, def);
    let next: EntityId | null = null;
    for (const c of waiting) {
      const lies = liesAboard(ctx, state.soldier.req(c));
      if (placesFit(ctx, def, used.lying + (lies ? 1 : 0), used.sitting + (lies ? 0 : 1))) { next = c; break; }
    }
    if (next !== null) {
      const ct = state.transform.req(next);
      const walkS = (2 * hypot2(ct.x - t.x, ct.y - t.y)) / (E?.carryMps ?? 1);
      r.loading = { casualty: next, doneTick: tick + secondsToTicks(def.ramp.loadCasualtySeconds + (E?.loadSecondsExtra ?? 20) + walkS) };
      return;
    }
    const full = waiting.length > 0;
    const since = ticksToSeconds(tick - (r.lastLoadTick ?? tick)), stay = ticksToSeconds(tick - (r.arriveTick ?? tick));
    if (full || stay >= R.maxStayS || (since >= R.waitS && !comingTo(state, pid))) leaveFor(ctx, state, events, vid);
    return;
  }
  if (r.phase === "outbound") {
    const exit = r.exit!;
    if (hypot2(t.x - exit.x, t.y - exit.y) <= edgeM || ticksToSeconds(tick - (r.departTick ?? tick)) >= R.maxStayS * 2) { offMap(ctx, state, events, vid); return; }
    if (v.drive.arrived && tick >= (r.retryTick ?? 0)) {
      driveTo(ctx, state, vid, exit.x, exit.y, false, R.pace, R.pace);
      r.retryTick = tick + secondsToTicks(30);
    }
    return;
  }
  if (r.phase === "unloading") {
    if (tick < (r.unloadTick ?? 0)) return;
    unloadShare(ctx, state, events, vid);
    return;
  }
  if (r.phase === "return" && r.share !== undefined) {
    // (M11.4b: first to the platoon's supply point with its share.)
    const V = ctx.catalog.supply?.vehicleRun;
    const sp = r.supplyPoint !== undefined ? state.rear.get(r.supplyPoint) : undefined;
    if (!V || !sp || sp.cache === undefined || !state.cache.has(sp.cache)) { delete r.share; delete r.supplyPoint; toSquad(ctx, state, events, vid); return; }
    const dP = hypot2(t.x - sp.x, t.y - sp.y);
    let near = dP <= V.standM + 10 || (r.goal !== undefined && hypot2(t.x - r.goal.x, t.y - r.goal.y) <= 6);
    if (!near && dP <= HELD_UP_NEAR_M && v.drive.arrived && (v.drive.stuckTicks > 0 || v.drive.replans >= 2)) near = true;
    if (near) {
      vehicleHalt(state, vid);
      r.phase = "unloading"; r.arriveTick = tick;
      r.unloadTick = tick + secondsToTicks(V.unloadBaseS + V.unloadSecondsPerKg * shareKg(ctx, r.share));
      return;
    }
    if (ticksToSeconds(tick - (r.backTick ?? tick)) >= R.maxStayS * 2) { unloadShare(ctx, state, events, vid); return; }
    if (!r.goal || hypot2(r.goal.px - sp.x, r.goal.py - sp.y) > V.standM || (v.drive.arrived && tick >= (r.retryTick ?? 0))) {
      const g = standSpot(ctx, t, sp.x, sp.y, V.standM, ctx.catalog.vehicles[v.def]?.class);
      r.goal = { x: g.x, y: g.y, px: sp.x, py: sp.y };
      driveTo(ctx, state, vid, g.x, g.y, false, R.pace, R.pace);
      r.retryTick = tick + secondsToTicks(30);
    }
    return;
  }
  if (r.phase === "return") {
    const g = r.goal!;
    if (hypot2(t.x - g.x, t.y - g.y) <= R.backM || ticksToSeconds(tick - (r.backTick ?? tick)) >= R.maxStayS * 2) { end(state, events, vid, "back"); return; }
    if (v.drive.arrived && tick >= (r.retryTick ?? 0)) {
      if (!driveTo(ctx, state, vid, g.x, g.y, false, R.pace, R.pace) && ticksToSeconds(tick - (r.backTick ?? tick)) >= 60) { end(state, events, vid, "back"); return; }
      r.retryTick = tick + secondsToTicks(30);
    }
  }
}

/** At the map edge: the wounded aboard are handed over; the hull is away `awayS`. */
function offMap(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId): void {
  const R = ctx.catalog.medical!.rearRun!;
  const v = state.vehicle.req(vid), r = v.rearRun!;
  // (The wounded passengers, and a crewman who can no longer fight: the fit crew stays with the hull.)
  const n = evacuateAboard(ctx, state, events, vid, "vehicle", (_sid, s) => casualty(s));
  r.phase = "away"; r.awayTick = state.tick; r.backTick = state.tick + secondsToTicks(R.awayS);
  delete r.goal; delete r.retryTick; delete r.loading;
  parkOffMap(state, vid);
  restock(ctx, state, events, vid);
  if (v.unit !== null) { const u = state.unit.get(v.unit); if (u) u.moving = false; }
  events.emit({ kind: "medical.rearRun", tick: state.tick, side: v.side, vehicle: vid, phase: "away", unit: r.top, aboard: n, ...(r.point !== undefined ? { point: r.point } : {}) });
}

/** Back onto the map where it left, driving to its squad's leader (or where it set off from). */
function comeBack(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId): void {
  const v = state.vehicle.req(vid), r = v.rearRun!, exit = r.exit!;
  const t = state.transform.req(vid);
  t.x = exit.x; t.y = exit.y; t.z = 0; t.heading = exit.heading;
  const d = v.drive;
  d.progressX = exit.x; d.progressY = exit.y; d.progressTick = state.tick; d.backX = exit.x; d.backY = exit.y; d.brake = 0;
  v.movedTick = state.tick;
  // Its men aboard come with it (their places follow the hull).
  for (const sid of v.seats) { if (sid === null) continue; const mt = state.transform.get(sid); if (mt) { mt.x = exit.x; mt.y = exit.y; mt.z = 0; } }
  r.phase = "return"; r.backTick = state.tick;
  events.emit({ kind: "medical.rearRun", tick: state.tick, side: v.side, vehicle: vid, phase: "returned", unit: r.top });
  // (M11.4b: with a share for the platoon's supply point it drives there first: stepRun.)
  if (r.share !== undefined) { delete r.goal; r.retryTick = state.tick; return; }
  toSquad(ctx, state, events, vid);
}

/** Drive back to its squad's leader (or where it set off from): the last leg of the run. */
function toSquad(ctx: SimContext, state: SimState, _events: EventSink, vid: EntityId): void {
  const R = ctx.catalog.medical!.rearRun!;
  const v = state.vehicle.req(vid), r = v.rearRun!;
  r.phase = "return";
  let gx = r.from.x, gy = r.from.y;
  for (const uid of squadsOf(state, vid)) {
    const u = state.unit.get(uid);
    const lead = u?.leader ?? null;
    const ls = lead !== null ? state.soldier.get(lead) : undefined;
    if (lead !== null && ls && isAble(ls) && !isMounted(ls)) { const lt = state.transform.req(lead); gx = lt.x; gy = lt.y; break; }
  }
  r.goal = { x: gx, y: gy, px: gx, py: gy };
  driveTo(ctx, state, vid, gx, gy, false, R.pace, R.pace);
  r.retryTick = state.tick + secondsToTicks(30);
}

/**
 * The player's `rearRun` order (M10.6b, owner Q-9 "evacuate with this vehicle"): the target crew's hull takes the
 * casualties at its platoon's nest (or those aboard) off the map. Unable, with a radio reason, when it cannot drive,
 * its squad is assaulting, or nobody waits.
 */
export function rearRunOrder(ctx: SimContext, state: SimState, events: EventSink, target: EntityId, cargo?: "supplies"): OrderResult {
  if (!careEnabled(ctx) || !ctx.catalog.medical?.rearRun) return "unable";
  const vid = state.unit.get(target)?.vehicle;
  const v = vid === undefined ? undefined : state.vehicle.get(vid);
  if (vid === undefined || !v || v.offMap !== undefined) return "unable";
  if (v.rearRun) return v.rearRun.phase === "away" ? { unable: "radio.rearRunAway" } : true;
  if (!canDrive(ctx, state, v)) return "unable";
  if (squadBusy(state, vid)) return { unable: "radio.rearRunAssault" };
  const top = topOfHull(state, v);
  if (top === null) return "unable";
  if (cargo === "supplies") {
    // (M11.4b: a supply run: the side's stock must have something for its stowage or its platoon.)
    if (!deliveriesEnabled(ctx) || !ctx.catalog.supply?.vehicleRun || stockOf(state, v.side) === null) return { unable: "radio.rearRunNoStock" };
    start(ctx, state, events, vid, top, null, true, "supplies");
    return true;
  }
  const pid = nestOf(state, top);
  let waiting = 0;
  if (pid !== null) for (const [, s] of state.soldier.entries()) if (s.atNest === pid && s.physiology.alive && !isMounted(s)) waiting++;
  if (waiting === 0 && woundedAboard(ctx, state, v).length === 0) return { unable: "radio.rearRunNobody" };
  start(ctx, state, events, vid, top, waiting > 0 ? pid : null, true);
  return true;
}

/**
 * An order meets a hull on a rear run (M10.6b): to its crew, or getting its squad aboard. Away: refused with a reason;
 * on the map: the run ends (the order takes the hull back) and the order goes on. Null: nothing to do with a run.
 */
export function rearRunGate(state: SimState, events: EventSink, order: Order): OrderResult | null {
  // (Fire discipline, an ambush too (D4b), is no reason to stop or refuse a run.)
  if (order.kind === "rearRun" || order.kind === "fire" || order.kind === "ceaseFire" || order.kind === "rules" || order.kind === "ambush" || order.kind === "discharge") return null;
  let vid: EntityId | undefined = state.unit.get(order.target)?.vehicle;
  if (vid === undefined && order.kind === "mount") {
    const uid = state.unit.has(order.target) ? order.target : state.identity.get(order.target)?.unit;
    for (let u: EntityId | null = uid ?? null; u !== null && vid === undefined; u = state.unit.get(u)?.parent ?? null) vid = state.unit.get(u)?.carrier;
    if (order.vehicle !== undefined) vid = order.vehicle;
  }
  const v = vid === undefined ? undefined : state.vehicle.get(vid);
  if (vid === undefined || !v?.rearRun) return null;
  if (v.rearRun.phase === "away") return { unable: "radio.rearRunAway" };
  end(state, events, vid, "cancelled");
  return null;
}

// ---------------------------------------------------------------- M11.4b supplies

/** The ammunition of a hull's standard stowage (what the data stows), by item type: the rounds wanted and held in its
 *  container (its guns' ready feeds are loaded on top of the stowage at the start and refilled from it). */
function stowage(ctx: SimContext, state: SimState, vid: EntityId, v: VehicleState): { type: DefId; per: number; want: number; have: number }[] {
  const def = ctx.catalog.vehicles[v.def], k = state.container.get(vid);
  const out: { type: DefId; per: number; want: number; have: number }[] = [];
  if (!def || !k) return out;
  for (const st of def.stowed) {
    const d = ctx.catalog.items[st.item];
    const ammo = st.charge !== undefined ? d?.chargeItem !== undefined && ctx.catalog.ammo[d.chargeItem] !== undefined : ctx.catalog.ammo[st.item] !== undefined;
    if (!ammo) continue;
    const per = st.charge ?? 1;
    let have = 0;
    for (const s of k.stacks) if (s.type === st.item) have += (s.charge ?? 1) * s.count;
    out.push({ type: st.item, per, want: per * st.count, have });
  }
  return out;
}

/** Its stowed ammunition as a share of standard (1 with none stowed). */
function stowageShare(ctx: SimContext, state: SimState, vid: EntityId, v: VehicleState): number {
  let want = 0, have = 0;
  for (const s of stowage(ctx, state, vid, v)) { want += s.want; have += Math.min(s.have, s.want); }
  return want > 0 ? have / want : 1;
}

/** Does the stock hold any item of these types? */
function stockHas(state: SimState, stock: EntityId, types: readonly DefId[]): boolean {
  const k = state.container.get(stock);
  return k !== undefined && k.stacks.some((s) => s.count > 0 && types.includes(s.type));
}

/**
 * Idle hulls short of stowed ammunition (or, M11.5, of fuel) drive to an own cache near by that has some for them
 * (rearm.ts), else start a supply run when their side's stock has some (the platoon limits of casualty runs apply).
 */
function supplyStarts(ctx: SimContext, state: SimState, events: EventSink, hulls: readonly EntityId[]): void {
  const R = ctx.catalog.medical!.rearRun!, S = ctx.catalog.supply!, V = S.vehicleRun;
  const runs = state.stock.size > 0 && deliveriesEnabled(ctx) && V !== undefined;
  for (const vid of hulls) {
    const v = state.vehicle.req(vid);
    if (v.rearRun || v.resupply || v.recoveryBy !== undefined || v.towedBy !== undefined) continue;
    const def = ctx.catalog.vehicles[v.def];
    if (!def) continue;
    const marked = markedHull(ctx, v);
    const st = marked ? [] : stowage(ctx, state, vid, v);
    const share = st.length > 0 ? stowageShare(ctx, state, vid, v) : 1;
    const fuelLow = S.refuel !== undefined && fuelShortL(state, vid, def) > (1 - S.refuel.callBelow) * def.fuel.capacityL;
    const ammoLow = S.rearm !== undefined && share < S.rearm.below;
    const stock = runs ? stockOf(state, v.side) : null;
    const runAmmo = stock !== null && st.length > 0 && share < V!.stowageBelow && stockHas(state, stock, st.map((s) => s.type));
    const runFuel = stock !== null && fuelLow && stockFuel(ctx, state, stock, def) > 0;
    if (!ammoLow && !fuelLow && !runAmmo && !runFuel) continue;
    if (!idle(ctx, state, vid, v)) continue;
    // (M11.5: an own cache within reach that has something for it first.)
    if ((ammoLow || fuelLow) && goResupply(ctx, state, events, vid, ammoLow, fuelLow)) continue;
    if (marked || stock === null || (!runAmmo && !runFuel)) continue;
    const top = topOfHull(state, v);
    if (top === null) continue;
    let running = 0, onMap = 0;
    for (const h of hulls) {
      const hv = state.vehicle.req(h);
      if (topOfHull(state, hv) !== top) continue;
      if (hv.rearRun) running++; else if (canDrive(ctx, state, hv)) onMap++;
    }
    if (running >= R.maxPerPlatoon || onMap <= R.keepVehicles) continue;
    start(ctx, state, events, vid, top, null, false, "supplies");
  }
}

/** Off the map (away): its stowage filled from the side's stock up to standard, and a share for its platoon's point. */
function restock(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId): void {
  const V = ctx.catalog.supply?.vehicleRun;
  const v = state.vehicle.req(vid), r = v.rearRun!;
  if (!V || !deliveriesEnabled(ctx)) return;
  const stock = stockOf(state, v.side), k = stock === null ? undefined : state.container.get(stock);
  if (stock === null || !k) return;
  // (A marked ambulance takes nothing on its own: only a supply run the player ordered puts ammunition into it.)
  const marked = markedHull(ctx, v);
  if (marked && !(r.ordered === true && r.cargo === "supplies")) return;
  let rounds = 0;
  for (const s of stowage(ctx, state, vid, v)) {
    let missing = s.want - s.have;
    // Whole items of that type from the stock, the fullest that still fits, while short.
    while (missing > 0) {
      let best: { charge: number | undefined; per: number } | null = null;
      for (const x of k.stacks) {
        if (x.type !== s.type || x.count <= 0) continue;
        const per = x.charge ?? 1;
        if (per <= 0 || per > missing) continue;
        if (!best || per > best.per) best = { charge: x.charge, per };
      }
      if (!best) break;
      if (fromStock(ctx, state, events, stock, vid, s.type, 1, best.charge) !== 1) break;
      missing -= best.per; rounds += best.per;
    }
  }
  // M11.5: its tank filled from the stock's fuel cans (litres by moveCharge; the empty cans stay in the stock).
  const litres = refuelFromStock(ctx, state, events, stock, vid, v);
  const pid = supplyPointOf(state, r.top);
  const sp = pid === null ? undefined : state.rear.get(pid);
  if (pid !== null && sp?.cache !== undefined && state.cache.has(sp.cache) && V.shareKg > 0) {
    const c = state.cache.req(sp.cache);
    const want = c.fill !== undefined ? Math.max(0, c.fill - roundsInContainer(ctx, state.container.get(sp.cache))) : Infinity;
    const got = loadForPlatoon(ctx, state, events, stock, vid, r.top, V.shareKg, want);
    if (got.load.length > 0) { r.share = got.load; r.supplyPoint = pid; }
  }
  if ((rounds > 0 || r.share !== undefined) && marked) ammunitionIntoAmbulance(ctx, state, events, vid, r.ordered === true);
  if (rounds > 0 || litres > 0) events.emit({ kind: "medical.rearRun", tick: state.tick, side: v.side, vehicle: vid, phase: "restocked", unit: r.top, rounds, ...(litres > 0 ? { litres } : {}), ...(r.cargo === "supplies" ? { cargo: "supplies" as const } : {}) });
}

/** Litres of the hull's fuel kind in the stock's cans. */
function stockFuel(ctx: SimContext, state: SimState, stock: EntityId, def: VehicleDef): number {
  const kind = ctx.catalog.items[def.fuel.item]?.chargeKind, k = state.container.get(stock);
  if (kind === undefined || !k) return 0;
  let l = 0;
  for (const s of k.stacks) if (ctx.catalog.items[s.type]?.chargeKind === kind) l += (s.charge ?? 0) * s.count;
  return l;
}

/** M11.5: fill the hull's tank from the stock's cans of its fuel (each move enters the battle: `items.delivered`). */
function refuelFromStock(ctx: SimContext, state: SimState, events: EventSink, stock: EntityId, vid: EntityId, v: VehicleState): number {
  const def = ctx.catalog.vehicles[v.def];
  if (!def || ctx.catalog.supply?.refuel === undefined) return 0;
  const kind = ctx.catalog.items[def.fuel.item]?.chargeKind, k = state.container.get(stock), c = state.container.get(vid);
  if (kind === undefined || !k || !c) return 0;
  let total = 0;
  for (let guard = 0; guard < 200; guard++) {
    const short = fuelShortL(state, vid, def);
    if (short <= 0) break;
    let can: { type: DefId; charge: number } | null = null;
    for (const s of k.stacks) if (s.count > 0 && (s.charge ?? 0) > 0 && ctx.catalog.items[s.type]?.chargeKind === kind && (!can || s.charge! > can.charge)) can = { type: s.type, charge: s.charge! };
    let tank: number | undefined;
    for (const s of c.stacks) if (s.type === def.fuel.item && s.count > 0) { tank = s.charge ?? 0; break; }
    if (!can || tank === undefined) break;
    const m = moveCharge(ctx.catalog, state.container, { from: stock, fromType: can.type, fromCharge: can.charge, to: vid, toType: def.fuel.item, toCharge: tank, amount: short });
    if (m.moved <= 0) break;
    total += m.moved;
    events.emit({ kind: "items.delivered", tick: state.tick, holder: vid, item: def.fuel.item, count: 0, chargeKind: kind, amount: m.moved });
  }
  return total;
}

/** Mass of the share it brings (kg). */
function shareKg(ctx: SimContext, share: readonly { type: DefId; count: number; charge?: number }[]): number {
  let kg = 0;
  for (const s of share) { const d = ctx.catalog.items[s.type]; if (d) kg += s.count * (d.massKg + (s.charge ?? 0) * (d.chargeMassKg ?? 0)); }
  return kg;
}

/** Its share put into the platoon's supply point (what is still aboard of it), then back to its squad. */
function unloadShare(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId): void {
  const v = state.vehicle.req(vid), r = v.rearRun!;
  const sp = r.supplyPoint !== undefined ? state.rear.get(r.supplyPoint) : undefined;
  let n = 0;
  if (sp?.cache !== undefined && state.cache.has(sp.cache) && r.share) n = unloadInto(ctx, state, vid, sp.cache, r.share);
  events.emit({ kind: "medical.rearRun", tick: state.tick, side: v.side, vehicle: vid, phase: "unloaded", unit: r.top, rounds: n, ...(r.supplyPoint !== undefined ? { point: r.supplyPoint } : {}), ...(r.cargo === "supplies" ? { cargo: "supplies" as const } : {}) });
  delete r.share; delete r.supplyPoint; delete r.unloadTick;
  if (v.misuse === true && stowageShare(ctx, state, vid, v) <= 0) delete v.misuse;
  toSquad(ctx, state, events, vid);
}
