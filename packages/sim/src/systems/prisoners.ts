/**
 * PRISONERS OF WAR (M11.9a, plan docs/plans/m11-mp-pow.md sections 4.1-4.6; values core/prisoners.json, the same for
 * every side; Third Geneva Convention as the owner listed it: humane treatment, evacuation from the combat zone as soon
 * as possible, no exposure to fire, wounded prisoners treated like own men, officers, NCOs and men kept apart, searched
 * for weapons and documents, personal effects kept).
 *
 *   taken          surrender.ts takes him (`captive.state` "captured") and notes the side holding him (`by`) and the
 *                  unit whose man took him (`unit`). Here he gets his group from his rank's NATO code (`group`:
 *                  OF-* officer, from `segregation.ncoFrom` NCO, else man; a rank without a code: man).
 *   point          The holding platoon's prisoner collection point: a `rear` point of kind "prisoners", sited when its
 *                  first prisoner is taken (`sitePoint` as the nest: `pcp.backM` behind the platoon away from the enemy
 *                  it knows, hidden from it, reachable by a wheeled vehicle; never within `pcp.apartM` of the platoon's
 *                  Verwundetennest or supply point, nor within `pcp.enemyM` of a known enemy). A known enemy coming
 *                  within `pcp.enemyM` moves it back (not one the player placed: `prisonerPoint`); the prisoners held
 *                  there and their guards walk to the new spot. Each group has its own spot `segregation.apartM` from
 *                  the others (officers west, NCOs east of the men's spot).
 *   escorts        When the capturing unit is quiet (not fired on within `escort.quietS`, no drill, not broken) its
 *                  prisoners who still need searching or walking back are given escorts: one man per `escort.perGuard`
 *                  prisoners of ONE group (groups are never walked together): the nearest man of the capturing unit
 *                  or of the platoon's other units that are not fighting (review fix; a man with a radio or an
 *                  anti-tank round last; nobody sent to prisoners under fire); the M11.4a bearer filter (never a leader, a machine
 *                  gunner, a medic or first responder, a man carrying, busy, in a drill; no unit left below
 *                  `escort.minLeft` able men). The player's `escortPrisoners` sends them at once, gate or not.
 *   search         The escort searches each of his prisoners in turn where they stand (`searchPrisoner`, `search.seconds`
 *                  a man; standing, exposed; interrupted by fire, progress kept in `captive.searchTicks`). Taken: his
 *                  weapon (as its `weaponItem`, with the magazine in it), the batteries fitted in his devices, and every
 *                  item without `prisonerKeeps` (ammunition, grenades, launchers, radios, sights, drones, documents ...),
 *                  each by `transferItems` into the searcher. Kept: `prisonerKeeps` items (helmet, vest, water,
 *                  rations, first aid and medical items, identity tag, armband, rescue blanket ...). What the searcher
 *                  took beyond `search.maxKg` he puts into a captured cache where he searched (review fix).
 *   walk back      The searched prisoners who can walk go to their group's spot at the point at the prisoners' pace
 *                  (`surrender.walkSpeedFactor` of a walk, movement.ts), the escort `escort.gapMinM`-`gapMaxM` behind
 *                  them at the same pace (he waits when closer, they wait when farther). Under fire everyone goes down;
 *                  a prisoner crawls out of the line of fire (surrender.ts) and they go on when it has eased.
 *   guards         An escort arriving stays as a guard while the point has fewer than ceil(held / `guard.perGuard`);
 *                  otherwise, and whenever there are more guards than that, he walks back to his squad leader. A man on
 *                  this duty (`SoldierState.guard`) is out of the fight: he fires only in self-defence within
 *                  `guard.selfDefenceM` (decisions.ts), orders to his unit pass him by, and only `releaseGuard` takes a
 *                  guard away.
 *   wounded        A prisoner who cannot walk (searched or not: an escort searches him at the nest) is carried to the HOLDING platoon's Verwundetennest by its
 *                  bearers (nest.ts) and taken back with its own wounded by urgency alone (evacuation.ts); one who gets
 *                  worse at the point goes the same way.
 *   under fire   (M11.9c, plan 4.7) Rounds landing within `pcp.fireM` of the point (a burst there: explosions.ts
 *                  `notePointFire`; rounds cracking past a man held or guarding there) move it, unless the player
 *                  placed it, at most once every `pcp.checkS`, to a spot at least `pcp.fireClearM` from where they
 *                  landed; the guards walk there at their pace, the prisoners at theirs, a suppressed prisoner crawling
 *                  out of the line of fire first. Each second the point is under fire (or a man there suppressed) with
 *                  prisoners held is a `pow.underFire`. Prisoners kept there more than `exposure.seconds` within
 *                  `pcp.enemyM` of a known enemy or suppressed, without being moved, are a `law.exposure` (review only).
 *   escapes      (M11.9c, plan 4.8, owner question Q5 option (a)) Once a minute (staggered by id) a walking prisoner nobody
 *                  of the holding side watches (a fit man within `guard.watchM` who sees him) tries with chance
 *                  `escape.perMinute` x `darkFactor` (dark) x `smokeFactor` (smoke across him) x `mixedFactor` (a
 *                  prisoner of another group beside him) x `searchedFactor` (searched), stream "prisoners"
 *                  (`rules.prisonerEscapes` false: never). He runs to the nearest fit man of his side; the enemy keeps
 *                  seeing a man giving up for `escape.graceSeconds` (impair.ts `showsSurrender`), then may fire; guards
 *                  never do (decisions.ts). Within `escape.freeM` of a fit man of his side he is free (`captive` null:
 *                  the one way back from "captured", DECISIONS M11.9c), unarmed if searched; a fit man of the holding
 *                  side within `escape.recaptureM` recaptures him ("surrendered" again: surrender.ts takes him); hurt so
 *                  that he cannot walk he gives up where he lies ("stopped", "surrendered").
 *   player rule  (M11.9c) `Unit.prisonerRule` "ask" (the `rules` order): its prisoners wait for the player's
 *                  `escortPrisoners`; guards for the point are still found on their own.
 * Looked at every `stepS` (1 s): one pass over the men finds the prisoners and the men on duty; nothing else runs in a
 * battle without prisoners. Random draws only for escapes (stream "prisoners"). Every item moves by `transferItems`
 * (rule 9).
 */
import { registerActionHandler, interruptAction, startAction } from "../actions";
import type { PrisonerGroup, RearPoint, SoldierState } from "../components";
import type { SimContext } from "../context";
import type { Catalog } from "../catalog";
import type { EventSink } from "../events";
import { secondsToTicks, type DefId, type EntityId } from "../ids";
import { canReport, isAble, isConscious } from "../impair";
import { indoorAt, routeBetween, routeWaypoints } from "../interior-nav";
import { addItems, stackMassKg, transferItems } from "../items";
import { atan2, hypot2 } from "../math";
import { isMounted } from "../mount";
import { navCostAt, nearestPassable } from "../nav";
import { navFor } from "../navctx";
import { chargeAt, settle } from "../power";
import { newEntity, type SimState } from "../state";
import { onAir } from "../comms";
import { bearersBack } from "./carry";
import { nestOf, prisonerPointOf, sitePoint, supplyPointOf, topOf } from "./nest";
import { bearerOk, footMen, newCache, putInCache } from "./supply";
import { crawlOutOfFire } from "./surrender";
import { requestPosture } from "./body";
import { eyeHeightM, sight, TARGET_POINT_M } from "../los";
import { standZ } from "../terrain";
import { nextFloat, Streams } from "../rng";
import { smokePhysics, smokeTransmission } from "../smoke";
import { launcherRound } from "./launcher";

type Prisoners = NonNullable<SimContext["catalog"]["prisoners"]>;

/** The prisoners' group from his rank's NATO code (header "taken"). */
export function prisonerGroup(ctx: SimContext, state: SimState, id: EntityId): PrisonerGroup {
  const ident = state.identity.get(id);
  return ident ? rankGroup(ctx.catalog, ident.faction, ident.rank) : "man";
}

/** A rank's prisoner group from its NATO code (also for the battle record). */
export function rankGroup(catalog: Catalog, faction: string, rank: string): PrisonerGroup {
  const code = catalog.factions[faction]?.natoCodes?.[rank];
  if (code === undefined) return "man";
  if (code.startsWith("OF-")) return "officer";
  if (code.startsWith("WO-")) return "nco";
  const from = Number((catalog.prisoners?.segregation.ncoFrom ?? "OR-5").slice(3));
  return code.startsWith("OR-") && Number(code.slice(3)) >= from ? "nco" : "man";
}

/** Is he a prisoner this system looks after: taken, alive, held by a unit's men, on the map, on foot? */
export function heldPrisoner(s: SoldierState): boolean { return held(s); }
function held(s: SoldierState): boolean {
  return s.captive !== null && s.captive.state === "captured" && s.captive.unit !== undefined && s.captive.escape === undefined && s.physiology.alive && s.evacuated === undefined && !isMounted(s);
}

/** Can he walk back (awake, legs that carry him)? */
export function walks(state: SimState, s: SoldierState): boolean {
  return isConscious(s) && s.impair.canWalk && state.tick >= s.stunnedUntilTick && s.casualty !== "incapacitated";
}

/**
 * A prisoner who cannot walk (or one lying at the nest already) goes to the holding platoon's Verwundetennest (nest.ts
 * reads this), searched or not (review fix: wounded prisoners are taken back like own men; one not searched yet is
 * searched at the nest by an escort).
 */
export function prisonerForNest(s: SoldierState): boolean {
  if (s.captive === null || s.captive.state !== "captured" || s.captive.unit === undefined || s.captive.escape !== undefined || !s.physiology.alive || s.evacuated !== undefined) return false;
  if (s.atNest !== undefined) return true;
  if (s.wounds.length === 0) return false;
  return !isConscious(s) || !s.impair.canWalk || s.casualty === "incapacitated";
}

/** Is this unit fighting (fired on within `escort.quietS`, in a drill, broken)? Its men are not sent as escorts. */
function fighting(state: SimState, P: Prisoners, uid: EntityId): boolean {
  const u = state.unit.get(uid);
  if (!u) return true;
  return u.broken || u.drill !== null || state.tick - (u.ownFireTick ?? -1e9) < secondsToTicks(P.escort.quietS) || state.tick - u.underFireTick < secondsToTicks(P.escort.quietS);
}

/** Every unit of top unit `top` (itself first, then in id order). */
function unitsOf(state: SimState, top: EntityId): EntityId[] {
  const out: EntityId[] = [];
  const walk = (u: EntityId) => { const x = state.unit.get(u); if (!x) return; out.push(u); for (const c of [...x.children].sort((a, b) => a - b)) walk(c); };
  walk(top);
  return out;
}

// ---------------------------------------------------------------- the collection point

/** Where top unit `top`'s collection point goes (header "point"); null when the platoon has nobody to site it from. */
export function sitePrisonerPoint(ctx: SimContext, state: SimState, top: EntityId, avoid: readonly { x: number; y: number; r: number }[] = []): { x: number; y: number } | null {
  const P = ctx.catalog.prisoners!;
  const zones: { x: number; y: number; r: number }[] = [...avoid];
  const nid = nestOf(state, top), sid = supplyPointOf(state, top);
  if (nid !== null) zones.push({ x: state.rear.req(nid).x, y: state.rear.req(nid).y, r: P.pcp.apartM });
  if (sid !== null) zones.push({ x: state.rear.req(sid).x, y: state.rear.req(sid).y, r: P.pcp.apartM });
  for (const e of knownEnemies(ctx, state, top)) zones.push({ x: e.x, y: e.y, r: P.pcp.enemyM });
  return sitePoint(ctx, state, top, P.pcp, zones);
}

/** The enemy men and vehicles the platoon's able men know of (fresh, not down, not giving up), one per target. */
export function knownEnemies(ctx: SimContext, state: SimState, top: EntityId): { x: number; y: number }[] {
  const lost = secondsToTicks(ctx.catalog.behaviour.decisions.contactLostSeconds);
  const seen = new Set<EntityId>(), out: { x: number; y: number }[] = [];
  for (const uid of unitsOf(state, top)) for (const m of state.unit.req(uid).members) {
    const s = state.soldier.get(m);
    if (!s || !isAble(s)) continue;
    for (const c of s.contacts) {
      if (c.down === true || c.surrendered === true || c.kind === "heard" || state.tick - c.tick > lost || seen.has(c.target)) continue;
      seen.add(c.target); out.push({ x: c.x, y: c.y });
    }
  }
  return out;
}

/** Put (or move) top unit `top`'s collection point at (x, y). */
export function setPrisonerPoint(ctx: SimContext, state: SimState, events: EventSink, top: EntityId, x: number, y: number, reason: "sited" | "threatened" | "underFire" | "ordered"): EntityId | null {
  const u = state.unit.get(top);
  if (!u) return null;
  let pid = prisonerPointOf(state, top);
  if (pid === null) {
    pid = newEntity(state);
    state.rear.set(pid, { kind: "prisoners", side: u.side, unit: top, x, y, sitedTick: state.tick, checkTick: state.tick });
  } else {
    const p = state.rear.req(pid);
    p.x = x; p.y = y; p.sitedTick = state.tick; p.checkTick = state.tick;
    // (M11.9c: moved, so its prisoners are no longer kept where they were exposed.)
    delete p.exposedTick; delete p.exposureNoted;
  }
  const p = state.rear.req(pid);
  if (reason === "ordered") p.placed = true; else delete p.placed;
  events.emit({ kind: "pow.point", tick: state.tick, side: u.side, point: pid, unit: top, x: Math.round(x), y: Math.round(y), reason });
  if (reason !== "ordered" && onAir(state, top)) {
    const from = u.leader !== null && canReport(state.soldier.get(u.leader)) ? u.leader : null;
    if (from !== null) events.emit({ kind: "radio", tick: state.tick, side: u.side, from, key: reason === "sited" ? "radio.powPointSited" : reason === "underFire" ? "radio.powPointUnderFire" : "radio.powPointMoved", params: { callsign: u.callsign } });
  }
  return pid;
}

/** A passable spot on foot outdoors near (x, y) (itself if it is one). */
function passableNear(ctx: SimContext, x: number, y: number): { x: number; y: number } {
  const foot = navFor(ctx, "foot").grid;
  const W = ctx.map.widthM, H = ctx.map.heightM;
  const cx = Math.min(W - 2, Math.max(2, x)), cy = Math.min(H - 2, Math.max(2, y));
  if (navCostAt(foot, cx, cy) > 0 && indoorAt(ctx, cx, cy) < 0) return { x: cx, y: cy };
  const i = nearestPassable(foot, cx, cy, 10);
  return i >= 0 ? { x: (i % foot.cols + 0.5) * foot.cellM, y: (Math.floor(i / foot.cols) + 0.5) * foot.cellM } : { x: cx, y: cy };
}

/** A group's spot at the point (header "point"). */
export function groupSpot(ctx: SimContext, p: Pick<RearPoint, "x" | "y">, group: PrisonerGroup): { x: number; y: number } {
  const a = ctx.catalog.prisoners!.segregation.apartM;
  return passableNear(ctx, p.x + (group === "officer" ? -a : group === "nco" ? a : 0), p.y);
}

/** The k-th place of a group's spot (three abreast, 1.5 m apart). */
function slotAt(ctx: SimContext, p: Pick<RearPoint, "x" | "y">, group: PrisonerGroup, k: number): { x: number; y: number } {
  const g = groupSpot(ctx, p, group);
  return passableNear(ctx, g.x + ((k % 3) - 1) * 1.5, g.y + Math.floor(k / 3) * 1.5);
}

/** The k-th guard's place: `guard.standM` south of the men's spot, 2 m apart. */
export function guardSpot(ctx: SimContext, p: Pick<RearPoint, "x" | "y">, k: number): { x: number; y: number } {
  return passableNear(ctx, p.x + k * 2, p.y + ctx.catalog.prisoners!.guard.standM);
}

/** His place at point `pid`: his index among the prisoners of his group bound for it (held there or on the way). */
function slotOf(ctx: SimContext, state: SimState, pid: EntityId, id: EntityId, bound: readonly EntityId[]): { x: number; y: number } {
  const s = state.soldier.req(id), g = s.captive!.group ?? "man";
  const p = state.rear.req(pid);
  let k = 0;
  for (const m of bound) { if (m >= id) break; if (state.soldier.get(m)?.captive?.group === g) k++; }
  return slotAt(ctx, p, g, k);
}

/** Walk a man (prisoner or guard) to (x, y) on foot at height `gz` (his floor: review fix, a prisoner upstairs);
 *  `standing`: upright the whole way (a prisoner, hands up). */
export function walkTo(ctx: SimContext, state: SimState, id: EntityId, x: number, y: number, standing: boolean, gz = 0): boolean {
  const t = state.transform.req(id), m = state.mover.get(id);
  if (!m) return false;
  const leg = routeBetween(ctx, navFor(ctx, "foot").search, t.x, t.y, x, y, { maxExpansions: 8000, snapCells: 3 }, { sz: t.z, gz });
  if (!leg) return false;
  m.waypoints = routeWaypoints(leg, standing ? { x: 0, y: 0, mode: "walk", posture: "standing" as const } : { x: 0, y: 0, mode: "walk" });
  m.formation = null; m.endPosture = standing ? "standing" : null; m.endHeading = null;
  return true;
}

export function halt(state: SimState, id: EntityId): void {
  const m = state.mover.get(id);
  if (m) { m.waypoints = []; m.speedMps = 0; m.endPosture = null; m.endHeading = null; }
}

/** Is the last waypoint of his way within `r` of (x, y)? */
export function headingFor(state: SimState, id: EntityId, x: number, y: number, r: number): boolean {
  const w = state.mover.get(id)?.waypoints;
  const last = w && w.length > 0 ? w[w.length - 1]! : undefined;
  return last !== undefined && hypot2(last.x - x, last.y - y) <= r;
}

/** Has he no way to go (no waypoints, or a way that ends where he stands: the route snapped its goal back to him)? */
function noWay(state: SimState, id: EntityId): boolean {
  const w = state.mover.get(id)?.waypoints, t = state.transform.req(id);
  const last = w && w.length > 0 ? w[w.length - 1]! : undefined;
  return last === undefined || hypot2(last.x - t.x, last.y - t.y) < 0.5;
}

function dist(state: SimState, a: EntityId, x: number, y: number): number {
  const t = state.transform.req(a);
  return hypot2(t.x - x, t.y - y);
}

// ---------------------------------------------------------------- the system

export function prisonersSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  const P = ctx.catalog.prisoners;
  if (!P) return;
  const every = Math.max(1, secondsToTicks(P.stepS));
  if (state.tick % every !== 0) return;
  let byTop: Map<EntityId, EntityId[]> | null = null;
  let duty: EntityId[] | null = null, esc: EntityId[] | null = null;
  // mounted: ok (prisoners and men on duty are on foot; held() and the duty step check)
  for (const [id, s] of state.soldier.entries()) {
    if (s.guard !== undefined) (duty ??= []).push(id);
    if (s.captive?.escape !== undefined && s.physiology.alive) (esc ??= []).push(id);
    if (!held(s)) continue;
    const c = s.captive!;
    // (M11.9b: on foot again with a hull named — got out of a stranded or burning military police hull, or no longer
    // its man walking to the door: he is held at his point again.)
    if (c.vehicle !== undefined && state.vehicle.get(c.vehicle)?.offMap?.boarding?.prisoner !== id) delete c.vehicle;
    c.group ??= prisonerGroup(ctx, state, id);
    if (!state.unit.has(c.unit!)) continue;
    const top = topOf(state, c.unit!);
    const l = (byTop ??= new Map()).get(top);
    if (l) l.push(id); else byTop.set(top, [id]);
  }
  if (byTop === null && duty === null && esc === null) return;
  if (esc) for (const id of esc) stepEscape(ctx, state, events, P, id);
  // (Review fix: a prisoner whose own men stand beside him with none of the holding side near is freed by them.)
  if (byTop) for (const top of [...byTop.keys()].sort((a, b) => a - b)) {
    const men = byTop.get(top)!.filter((m) => !liberate(ctx, state, events, P, m));
    if (men.length > 0) byTop.set(top, men); else byTop.delete(top);
  }
  if (byTop) for (const top of [...byTop.keys()].sort((a, b) => a - b)) stepPlatoon(ctx, state, events, P, top, byTop.get(top)!, null);
  // (Review fix: a guard whose platoon holds nobody any more — the last prisoner killed, escaped, taken to the rear —
  // goes back to his squad; stepPlatoon above only runs for platoons that hold prisoners.)
  if (duty) for (const id of duty) {
    const g = state.soldier.get(id)?.guard;
    if (g?.phase !== "guard") continue;
    const top = state.rear.get(g.point)?.unit;
    if (top !== undefined && !byTop?.has(top)) release(ctx, state, events, id, false);
  }
  // (A man released above — no guard needed any more — has no duty left to step.)
  if (duty) for (const id of duty) if (state.soldier.get(id)?.guard !== undefined) stepDuty(ctx, state, events, P, id);
  // (M11.9c: once a minute each, staggered by id, the prisoners nobody watches may try to escape.)
  if (byTop && P.escape && ctx.rules.prisonerEscapes !== false) {
    const per = Math.max(1, Math.round(60 / P.stepS)), slot = Math.floor(state.tick / every);
    for (const top of [...byTop.keys()].sort((a, b) => a - b)) for (const m of byTop.get(top)!) if ((slot + m) % per === 0) tryEscape(ctx, state, events, P, m);
  }
}

/**
 * One platoon's prisoners (`men`: all it holds): its point (sited, moved), escorts for those waiting, guards counted,
 * the held kept in place. `only` (the player's `escortPrisoners`, review fix): escorts at once, gate or not, for these
 * of them alone; nothing else of the step runs (it is not the scheduled pass).
 */
function stepPlatoon(ctx: SimContext, state: SimState, events: EventSink, P: Prisoners, top: EntityId, men: readonly EntityId[], only: ReadonlySet<EntityId> | null): number {
  const forced = only !== null;
  let pid = prisonerPointOf(state, top);
  if (pid === null) {
    const at = sitePrisonerPoint(ctx, state, top);
    if (!at) return 0;
    pid = setPrisonerPoint(ctx, state, events, top, at.x, at.y, "sited");
    if (pid === null) return 0;
  }
  const p = state.rear.req(pid);
  if (!forced) heldStep(ctx, state, events, P, top, men, pid, p);
  return escorts(ctx, state, events, P, top, men, pid, only);
}

/** The scheduled part of a platoon's step: the point moved under fire or threat, the held kept in place, seconds under
 *  fire and exposure, guards counted. */
function heldStep(ctx: SimContext, state: SimState, events: EventSink, P: Prisoners, top: EntityId, men: readonly EntityId[], pid: EntityId, p: RearPoint): void {
  const D = ctx.catalog.behaviour.decisions, step = Math.max(1, secondsToTicks(P.stepS));
  // ---- M11.9c: rounds cracking past a man held or guarding there (a burst near it is noted by explosions.ts)
  let suppressed = false;
  if (P.pcp.fireM !== undefined) {
    // mounted: ok (prisoners and men on duty are on foot; held() and the duty step check)
    for (const [m, ms] of state.soldier.entries()) {
      if (ms.captive?.point !== pid && ms.guard?.point !== pid) continue;
      if (!ms.physiology.alive || isMounted(ms)) continue;
      if (ms.mental.suppression >= D.seekCoverSuppression) suppressed = true;
      if (ms.fireFrom !== undefined && state.tick - ms.fireFrom.tick < step) { const t = state.transform.req(m); p.fire = { tick: state.tick, x: t.x, y: t.y }; }
    }
  }
  const fireNow = p.fire !== undefined && state.tick - p.fire.tick < step;
  // (Review fix: loading means its men out at the point; once it breaks off — the point not quiet, mp.ts — the point may
  // move again.)
  const mpo = p.mp !== undefined ? state.vehicle.get(p.mp)?.offMap : undefined;
  const mpLoading = mpo?.phase === "loading" && mpo.mpStep === "out";
  // (Review fix: the spots it was moved away from within `fireMemoryS` are avoided as well, at most four.)
  const memory = secondsToTicks(P.pcp.fireMemoryS ?? 0);
  if (p.fireSpots) { p.fireSpots = p.fireSpots.filter((f) => state.tick - f.tick < memory); if (p.fireSpots.length === 0) delete p.fireSpots; }
  const clear = P.pcp.fireClearM ?? 0;
  const avoid = (p.fireSpots ?? []).map((f) => ({ x: f.x, y: f.y, r: clear }));
  // ---- moved back when rounds land near it (not one the player placed, not while the military police loads there)
  if (fireNow && !p.placed && !mpLoading && P.pcp.fireClearM !== undefined && state.tick - p.sitedTick >= secondsToTicks(P.pcp.checkS)) {
    const f = p.fire!;
    const at = sitePrisonerPoint(ctx, state, top, [...avoid, { x: f.x, y: f.y, r: clear }]);
    if (at && hypot2(at.x - p.x, at.y - p.y) > P.pcp.arriveM * 4) {
      if (memory > 0) p.fireSpots = [...(p.fireSpots ?? []), { tick: state.tick, x: f.x, y: f.y }].slice(-4);
      setPrisonerPoint(ctx, state, events, top, at.x, at.y, "underFire");
    }
  }
  // ---- moved back when a known enemy comes within enemyM (not one the player placed, not while the military police
  // loads there)
  if (!p.placed && !mpLoading && state.tick - p.checkTick >= secondsToTicks(P.pcp.checkS)) {
    p.checkTick = state.tick;
    const near = knownEnemies(ctx, state, top).some((e) => hypot2(e.x - p.x, e.y - p.y) < P.pcp.enemyM);
    if (near) {
      const at = sitePrisonerPoint(ctx, state, top, avoid);
      if (at && hypot2(at.x - p.x, at.y - p.y) > P.pcp.arriveM * 4) setPrisonerPoint(ctx, state, events, top, at.x, at.y, "threatened");
    }
  }
  // ---- who is bound for this point (held there, or on the way with an escort): their places
  const bound = men.filter((m) => { const c = state.soldier.req(m).captive!; return c.point === pid || (c.escort !== undefined && state.soldier.get(c.escort)?.guard?.point === pid); });
  // ---- the held: at their place (a moved point: they walk to the new one; suppressed, they crawl out of the line of
  // fire first, M11.9c)
  let nHeld = 0;
  for (const m of men) {
    const s = state.soldier.req(m), c = s.captive!;
    if (c.point !== pid || s.atNest !== undefined || state.carry.has(m)) continue;
    nHeld++;
    // (M11.9b: one walking to the military police hull is its to move.)
    if (c.vehicle !== undefined || !walks(state, s) || s.crawlCover !== undefined) continue;
    if (s.mental.suppression >= D.seekCoverSuppression) {
      if (crawlOutOfFire(ctx, state, events, m, s)) continue;
      if ((state.mover.get(m)?.waypoints.length ?? 0) > 0) halt(state, m);
      if (s.posture !== "prone") requestPosture(ctx, state, m, "prone");
      continue;
    }
    const at = slotOf(ctx, state, pid, m, bound);
    if (dist(state, m, at.x, at.y) > P.pcp.arriveM * 2 && !headingFor(state, m, at.x, at.y, 1)) walkTo(ctx, state, m, at.x, at.y, true);
  }
  // ---- M11.9c: seconds under fire, and prisoners kept exposed without being moved (law.exposure)
  if (nHeld > 0 && (fireNow || suppressed)) events.emit({ kind: "pow.underFire", tick: state.tick, side: p.side, point: pid, held: nHeld });
  if (P.exposure) {
    const near = nHeld > 0 && !suppressed ? knownEnemies(ctx, state, top).some((e) => hypot2(e.x - p.x, e.y - p.y) < P.pcp.enemyM) : false;
    if (nHeld > 0 && (suppressed || near) && !mpLoading) {
      p.exposedTick ??= state.tick;
      const sec = (state.tick - p.exposedTick) / secondsToTicks(1);
      if (!p.exposureNoted && sec > P.exposure.seconds) {
        p.exposureNoted = true;
        events.emit({ kind: "law.exposure", tick: state.tick, side: p.side, point: pid, unit: top, prisoners: nHeld, cause: suppressed ? "fire" : "enemy", seconds: Math.round(sec), placed: p.placed === true });
      }
    } else { delete p.exposedTick; delete p.exposureNoted; }
  }
  // ---- guards: no more than ceil(held / perGuard), none while the military police holds the point (M11.9b); the rest
  // (all, with nobody held) go back to their squads
  const mpHere = mpLoading;
  if (p.mp !== undefined && !mpHere) delete p.mp;
  const need = mpHere ? 0 : Math.ceil(nHeld / P.guard.perGuard);
  const guards: EntityId[] = [];
  let duty = 0;
  // mounted: ok (prisoners and men on duty are on foot; held() and the duty step check)
  for (const [g, gs] of state.soldier.entries()) { if (gs.guard?.point === pid) { duty++; if (gs.guard.phase === "guard") guards.push(g); } }
  for (let k = guards.length - 1; k >= need; k--) release(ctx, state, events, guards[k]!, false);
  // (M11.9b: prisoners held with fewer guards and escorts bound for the point than needed — a guard lost, the military
  // police gone with some of them — get a guard from a unit of the platoon that is not fighting.)
  if (duty < need) {
    const at = men.filter((m) => { const ms = state.soldier.req(m); return ms.captive!.point === pid && ms.atNest === undefined && !state.carry.has(m); });
    // (Review fix: the nearest man of any unit of the platoon that is not fighting.)
    const g = at.length > 0 ? pickEscort(ctx, state, P, top, null, at, new Set(), false) : null;
    if (g !== null) {
      const gs = state.soldier.req(g);
      interruptAction(state, events, g, "order");
      state.fire.delete(g); gs.intent = null; halt(state, g);
      gs.guard = { point: pid, phase: "guard", men: [], tick: state.tick };
      events.emit({ kind: "pow.guard", tick: state.tick, soldier: g, side: state.identity.req(g).side, point: pid, phase: "guard" });
    }
  }
}

/** Escorts for the prisoners waiting (not searched yet, or searched and able to walk), one group per escort. */
function escorts(ctx: SimContext, state: SimState, events: EventSink, P: Prisoners, top: EntityId, men: readonly EntityId[], pid: EntityId, only: ReadonlySet<EntityId> | null): number {
  const forced = only !== null;
  const quiet = secondsToTicks(P.escort.quietS), seek = ctx.catalog.behaviour.decisions.seekCoverSuppression;
  const waiting = men.filter((m) => {
    const s = state.soldier.req(m), c = s.captive!;
    if ((only !== null && !only.has(m)) || c.point !== undefined || c.escort !== undefined || state.carry.has(m)) return false;
    // (Review fix: one lying at the nest unsearched is searched there.)
    if (s.atNest !== undefined) return c.searched === undefined;
    return c.searched === undefined || walks(state, s);
  });
  let sent = 0;
  if (waiting.length === 0) return 0;
  const taken = new Set<EntityId>();
  for (const g of ["officer", "nco", "man"] as const) {
    // (By the capturing unit, then by group: one escort walks one group of one unit's prisoners.)
    const units = [...new Set(waiting.map((m) => state.soldier.req(m).captive!.unit!))].sort((a, b) => a - b);
    for (const uid of units) {
      if (!forced && prisonerRule(state, uid) === "ask") continue;
      const list = waiting.filter((m) => { const c = state.soldier.req(m).captive!; return c.group === g && c.unit === uid; });
      for (let i = 0; i < list.length; i += P.escort.perGuard) {
        const chunk = list.slice(i, i + P.escort.perGuard);
        // (More men giving up close by: they are gathered first, so that one escort walks them together.)
        if (!forced && surrenderingNear(ctx, state, chunk)) continue;
        // (Review fix: nobody is sent into fire — the prisoners fired at or suppressed within `escort.quietS`.)
        if (!forced && chunk.some((m) => { const ms = state.soldier.req(m); return ms.mental.suppression >= seek || (ms.fireFrom !== undefined && state.tick - ms.fireFrom.tick < quiet); })) continue;
        // (Review fix: the capturing unit fighting, a man of another unit of the platoon that is not.)
        const e = pickEscort(ctx, state, P, top, !forced && fighting(state, P, uid) ? -1 : uid, chunk, taken, forced);
        if (e === null) break;
        taken.add(e);
        assignEscort(ctx, state, events, pid, e, chunk, g, forced);
        sent++;
      }
    }
  }
  return sent;
}

/** Is a man who has given up but is not yet taken within `surrender.walkToEnemyM` of these prisoners (and alive, of
 *  their side)? Their escort waits for him (he is walking over or being fetched). */
function surrenderingNear(ctx: SimContext, state: SimState, chunk: readonly EntityId[]): boolean {
  const r = ctx.catalog.behaviour.surrender.walkToEnemyM;
  const side = state.identity.req(chunk[0]!).side;
  // mounted: ok (prisoners and men on duty are on foot; held() and the duty step check)
  for (const [o, os] of state.soldier.entries()) {
    if (os.captive?.state !== "surrendered" || !os.physiology.alive || isMounted(os) || state.identity.get(o)?.side !== side) continue;
    if (!walks(state, os) || (os.handOver?.done === true)) continue;
    const t = state.transform.req(o);
    for (const m of chunk) { const q = state.transform.req(m); if (hypot2(q.x - t.x, q.y - t.y) <= r) return true; }
  }
  return false;
}

/**
 * An escort for prisoners `chunk` (review fix): the nearest man to them of the capturing unit `uid` (null or -1: none of
 * it) or of any other unit of the platoon that is not fighting (`forced`: fighting or not); the M11.4a bearer filter, no
 * unit left below `escort.minLeft` able men; a man with a radio or an anti-tank round only when nobody else is free.
 */
function pickEscort(ctx: SimContext, state: SimState, P: Prisoners, top: EntityId, uid: EntityId | null, chunk: readonly EntityId[], taken: ReadonlySet<EntityId>, forced: boolean): EntityId | null {
  let cx = 0, cy = 0;
  for (const m of chunk) { const t = state.transform.req(m); cx += t.x; cy += t.y; }
  cx /= chunk.length; cy /= chunk.length;
  let best: EntityId | null = null, bestD = Infinity;
  for (const x of unitsOf(state, top)) {
    if (x !== uid && !forced && fighting(state, P, x)) continue;
    const able = footMen(state, x).filter((m) => state.soldier.req(m).guard === undefined && !taken.has(m));
    if (able.length - 1 < P.escort.minLeft) continue;
    for (const m of able) {
      if (!bearerOk(ctx, state, m, true)) continue;
      const d = dist(state, m, cx, cy) + (keyMan(ctx, state, m) ? KEY_MAN_M : 0);
      if (d < bestD) { bestD = d; best = m; }
    }
  }
  return best;
}

/** A key man's distance handicap in the escort choice (m): taken only when nobody else is free. */
const KEY_MAN_M = 1e6;
/** Does he carry a radio or have an anti-tank round for his launcher (review fix: the platoon's radio operator, its
 *  anti-tank gunners)? */
function keyMan(ctx: SimContext, state: SimState, m: EntityId): boolean {
  const c = state.container.get(m);
  if (c) for (const st of c.stacks) if (st.count > 0 && ctx.catalog.items[st.type]?.radio === true) return true;
  return launcherRound(ctx, state, m, "vehicle") !== null;
}

function assignEscort(ctx: SimContext, state: SimState, events: EventSink, pid: EntityId, e: EntityId, chunk: readonly EntityId[], group: PrisonerGroup, ordered: boolean): void {
  const s = state.soldier.req(e);
  interruptAction(state, events, e, "order");
  state.fire.delete(e);
  s.intent = null;
  halt(state, e);
  s.guard = { point: pid, phase: "search", men: [...chunk], tick: state.tick };
  for (const m of chunk) state.soldier.req(m).captive!.escort = e;
  events.emit({ kind: "pow.escort", tick: state.tick, side: state.identity.req(e).side, escort: e, point: pid, group, prisoners: [...chunk], ...(ordered ? { ordered: true as const } : {}) });
}

/** M11.9b: the military police hull `vid` takes over the guard at point `pid`: the squads' guards there walk back to
 *  their squads at once (escorts still walking prisoners there stay with them until they are held). */
export function mpTakeOver(ctx: SimContext, state: SimState, events: EventSink, pid: EntityId, vid: EntityId): number {
  const p = state.rear.get(pid);
  if (!p) return 0;
  p.mp = vid;
  let n = 0;
  // mounted: ok (prisoners and men on duty are on foot; held() and the duty step check)
  for (const [g, gs] of state.soldier.entries()) if (gs.guard?.point === pid && gs.guard.phase === "guard") { release(ctx, state, events, g, false); n++; }
  return n;
}

/** His duty ends: he walks back to his squad leader (`lost`: he could no longer do it). His prisoners wait. */
function release(ctx: SimContext, state: SimState, events: EventSink, id: EntityId, ordered: boolean, lost = false): void {
  const s = state.soldier.get(id);
  if (!s?.guard) return;
  const g = s.guard;
  for (const m of g.men) { const c = state.soldier.get(m)?.captive; if (c?.escort === id) delete c.escort; }
  delete s.guard;
  if (state.action.get(id)?.kind === "searchPrisoner") interruptAction(state, events, id, "released");
  events.emit({ kind: "pow.guard", tick: state.tick, soldier: id, side: state.identity.req(id).side, point: g.point, phase: lost ? "lost" : "released", ...(ordered ? { ordered: true as const } : {}) });
  if (!lost) bearersBack(ctx, state, [id]);
}

/** One man on duty: search, walk back, guard (header). */
function stepDuty(ctx: SimContext, state: SimState, events: EventSink, P: Prisoners, id: EntityId): void {
  const s = state.soldier.req(id), g = s.guard!;
  const p = state.rear.get(g.point);
  if (!p || !isAble(s) || !s.impair.canWalk || isMounted(s) || s.captive !== null || s.mental.behaviour === "panicked" || s.mental.behaviour === "routed") { release(ctx, state, events, id, false, true); return; }
  // His prisoners still with him (alive, taken, on foot, not carried or at the nest, not held yet).
  // (Review fix: one at the nest stays his until searched there.)
  // (A man dropped here — carried off to the nest by its bearers — is no longer his: another escort searches him there.)
  g.men = g.men.filter((m) => {
    const ms = state.soldier.get(m);
    const mine = ms !== undefined && held(ms) && ms.captive!.escort === id && (ms.atNest === undefined || ms.captive!.searched === undefined) && !state.carry.has(m) && ms.captive!.point === undefined;
    if (!mine && ms?.captive?.escort === id) delete ms.captive.escort;
    return mine;
  });
  const D = ctx.catalog.behaviour.decisions;
  const under = s.mental.suppression >= D.seekCoverSuppression;
  if (g.phase === "search") {
    if (state.action.has(id)) return;
    const next = g.men.find((m) => state.soldier.req(m).captive!.searched === undefined);
    if (next === undefined) {
      // (Nobody of his who can walk: the nest's bearers fetch the rest; he goes back to his squad with what he took.)
      if (!g.men.some((m) => walks(state, state.soldier.req(m)))) { for (const m of g.men) delete state.soldier.req(m).captive!.escort; release(ctx, state, events, id, false); return; }
      g.phase = "escort"; g.tick = state.tick; stepEscort(ctx, state, events, P, id, g, p, under); return;
    }
    if (under) { if ((state.mover.get(id)?.waypoints.length ?? 0) > 0) halt(state, id); if (s.posture !== "prone") requestPosture(ctx, state, id, "prone"); return; }
    const pt = state.transform.req(next), me = state.transform.req(id);
    if (hypot2(pt.x - me.x, pt.y - me.y) <= P.search.reachM && Math.abs(pt.z - me.z) <= 1.5) {
      halt(state, id);
      if (s.posture !== "standing") { requestPosture(ctx, state, id, "standing"); return; }
      me.heading = atan2(pt.y - me.y, pt.x - me.x);
      const c = state.soldier.req(next).captive!;
      const left = Math.max(1, secondsToTicks(P.search.seconds) - (c.searchTicks ?? 0));
      startAction(state, events, id, "searchPrisoner", left, { prisoner: next, prior: c.searchTicks ?? 0 });
      return;
    }
    // To him (a step short, on the side he stands).
    if ((state.mover.get(next)?.waypoints.length ?? 0) > 0) halt(state, next);
    const L = Math.max(1e-6, hypot2(me.x - pt.x, me.y - pt.y)), k = Math.min(1, (P.search.reachM * 0.6) / L);
    const gx = pt.x + (me.x - pt.x) * k, gy = pt.y + (me.y - pt.y) * k;
    // (Review fix: on his floor — a prisoner taken upstairs.)
    if (!headingFor(state, id, gx, gy, 0.5) && !walkTo(ctx, state, id, gx, gy, true, pt.z)) release(ctx, state, events, id, false);
    return;
  }
  if (g.phase === "escort") { stepEscort(ctx, state, events, P, id, g, p, under); return; }
  // ---- guard: at his place, facing his prisoners
  const k = guardIndex(state, id, g.point);
  const at = guardSpot(ctx, p, k);
  if (under) { if ((state.mover.get(id)?.waypoints.length ?? 0) > 0) halt(state, id); return; }
  if (dist(state, id, at.x, at.y) > P.pcp.arriveM * 2) { if (!headingFor(state, id, at.x, at.y, 1)) walkTo(ctx, state, id, at.x, at.y, false); return; }
  if ((state.mover.get(id)?.waypoints.length ?? 0) === 0 && !state.fire.has(id)) { const t = state.transform.req(id); t.heading = atan2(p.y - t.y, p.x - t.x); }
}

function guardIndex(state: SimState, id: EntityId, pid: EntityId): number {
  let k = 0;
  // mounted: ok (prisoners and men on duty are on foot; held() and the duty step check)
  for (const [g, gs] of state.soldier.entries()) { if (g >= id) break; if (gs.guard?.point === pid && gs.guard.phase === "guard") k++; }
  return k;
}

/** The walk back (header "walk back"). */
function stepEscort(ctx: SimContext, state: SimState, events: EventSink, P: Prisoners, id: EntityId, g: NonNullable<SoldierState["guard"]>, p: RearPoint, under: boolean): void {
  const D = ctx.catalog.behaviour.decisions;
  const bound: EntityId[] = [];
  // mounted: ok (prisoners and men on duty are on foot; held() and the duty step check)
  for (const [m, ms] of state.soldier.entries()) {
    const c = ms.captive;
    if (c && held(ms) && (c.point === g.point || (c.escort !== undefined && state.soldier.get(c.escort)?.guard?.point === g.point))) bound.push(m);
  }
  const walking = g.men.filter((m) => walks(state, state.soldier.req(m)));
  // (Those who can no longer walk stay where they are: the nest's bearers fetch them; he is no longer their escort.)
  for (const m of g.men) if (!walking.includes(m)) { const c = state.soldier.req(m).captive!; delete c.escort; }
  g.men = walking;
  const gs = guardSpot(ctx, p, guardIndex(state, id, g.point));
  // Under fire: everyone down; the prisoners crawl out of the line of fire.
  const fire = under || walking.some((m) => state.soldier.req(m).mental.suppression >= D.seekCoverSuppression);
  if (fire) {
    halt(state, id);
    if (state.soldier.req(id).posture !== "prone") requestPosture(ctx, state, id, "prone");
    for (const m of walking) {
      const ms = state.soldier.req(m);
      if (crawlOutOfFire(ctx, state, events, m, ms)) continue;
      if ((state.mover.get(m)?.waypoints.length ?? 0) > 0) halt(state, m);
      if (ms.posture !== "prone") requestPosture(ctx, state, m, "prone");
    }
    return;
  }
  let minD = Infinity, behind = false;
  // (He walks behind them to their group's spot, then to his own place; they wait for him only while he walks.)
  const spot = groupSpot(ctx, p, state.soldier.get(walking[0] ?? -1)?.captive?.group ?? "man");
  const me = state.transform.req(id), hold = state.tick + Math.max(1, secondsToTicks(P.stepS));
  const escortMoving = (state.mover.get(id)?.waypoints.length ?? 0) > 0 && hypot2(me.x - spot.x, me.y - spot.y) > P.escort.gapMaxM;
  for (const m of walking) {
    const ms = state.soldier.req(m);
    if (ms.crawlCover !== undefined) { if ((state.mover.get(m)?.waypoints.length ?? 0) > 0) continue; delete ms.crawlCover; }
    const at = slotOf(ctx, state, g.point, m, bound);
    const d = dist(state, m, at.x, at.y);
    // (Review fix: a place he cannot get closer to — the route snaps its goal back onto his own cell — within three
    // times arriveM counts as reached.)
    let there = d <= P.pcp.arriveM;
    if (!there && d <= P.pcp.arriveM * 3 && !headingFor(state, m, at.x, at.y, 1)) there = !walkTo(ctx, state, m, at.x, at.y, true) || noWay(state, m);
    if (there) {
      // Arrived: held at the point.
      halt(state, m);
      ms.captive!.point = g.point;
      delete ms.captive!.escort;
      events.emit({ kind: "pow.held", tick: state.tick, soldier: m, side: state.identity.req(m).side, point: g.point, group: ms.captive!.group ?? "man", escort: id });
      continue;
    }
    if (!headingFor(state, m, at.x, at.y, 1)) walkTo(ctx, state, m, at.x, at.y, true);
    const t = state.transform.req(m), dm = hypot2(t.x - me.x, t.y - me.y);
    minD = Math.min(minD, dm);
    // (Too far ahead of him: he waits a moment. Behind him — their ways cross —: the escort waits for him.)
    if (d < hypot2(me.x - at.x, me.y - at.y)) { if (dm > P.escort.gapMaxM + 2 && escortMoving) { const mv = state.mover.get(m); if (mv) mv.holdUntilTick = hold; } }
    else behind = true;
  }
  g.men = g.men.filter((m) => state.soldier.req(m).captive!.point === undefined);
  if (g.men.length > 0) {
    // He follows them at their pace to their spot, waiting while closer than gapMinM.
    if (hypot2(me.x - spot.x, me.y - spot.y) > P.escort.gapMinM && !headingFor(state, id, spot.x, spot.y, 1)) walkTo(ctx, state, id, spot.x, spot.y, false);
    if (minD < P.escort.gapMinM || behind) { const mv = state.mover.get(id); if (mv) mv.holdUntilTick = hold; }
    return;
  }
  // ---- everyone held: he leaves what he cannot carry at the point, then stays as a guard or goes back
  if (dist(state, id, gs.x, gs.y) > P.pcp.arriveM * 3) { if (!headingFor(state, id, gs.x, gs.y, 1)) walkTo(ctx, state, id, gs.x, gs.y, false); return; }
  overflow(ctx, state, events, P, id, g.point);
  let nHeld = 0, guards = 0;
  // mounted: ok (prisoners and men on duty are on foot; held() and the duty step check)
  for (const [m, ms] of state.soldier.entries()) {
    if (ms.captive?.point === g.point && held(ms) && ms.atNest === undefined && !state.carry.has(m)) nHeld++;
    if (ms.guard?.point === g.point && ms.guard.phase === "guard") guards++;
  }
  if (guards < Math.ceil(nHeld / P.guard.perGuard)) {
    g.phase = "guard"; g.men = []; g.tick = state.tick;
    delete g.took;
    events.emit({ kind: "pow.guard", tick: state.tick, soldier: id, side: state.identity.req(id).side, point: g.point, phase: "guard" });
    return;
  }
  release(ctx, state, events, id, false);
}

/**
 * What he took in his searches beyond `search.maxKg` goes into a captured cache (last taken first): the point's when he
 * gets there; review fix: `here`, right after a search, one where he stands (beside him already, else a new one), so
 * that he never walks his prisoners back loaded beyond `maxKg`. What stays with him is `took`.
 */
function overflow(ctx: SimContext, state: SimState, events: EventSink, P: Prisoners, id: EntityId, pid: EntityId, here = false): void {
  const g = state.soldier.req(id).guard!;
  const took = g.took ?? [];
  delete g.took;
  let kg = 0;
  for (const st of took) kg += stackMassKg(ctx.catalog, st);
  if (kg <= P.search.maxKg + 1e-9) { if (here && took.length > 0) g.took = took; return; }
  const p = state.rear.req(pid);
  const me = state.transform.req(id);
  let cache: EntityId | undefined;
  if (here) {
    // mounted: ok (caches are never aboard)
    for (const [k, c] of state.cache.entries()) {
      if (c.capturedBy !== p.side || c.burnt === true || c.cookoff !== undefined) continue;
      const t = state.transform.req(k);
      if (hypot2(t.x - me.x, t.y - me.y) <= 5) { cache = k; break; }
    }
  } else cache = p.cache !== undefined && state.cache.has(p.cache) && state.cache.req(p.cache).burnt !== true && state.cache.req(p.cache).cookoff === undefined ? p.cache : undefined;
  const kept = took.map((st) => ({ ...st }));
  let left = kg, put = 0;
  for (let i = took.length - 1; i >= 0 && left > P.search.maxKg + 1e-9; i--) {
    const st = took[i]!;
    const per = stackMassKg(ctx.catalog, { ...st, count: 1 });
    const n = per > 0 ? Math.min(st.count, Math.ceil((left - P.search.maxKg) / per - 1e-9)) : 0;
    if (n <= 0) continue;
    if (cache === undefined) {
      const at = here ? passableNear(ctx, me.x, me.y) : passableNear(ctx, p.x - 6, p.y + P.guard.standM);
      cache = newCache(state, p.side, at.x, at.y, []);
      const from = state.sides.find((x) => x.id !== p.side)?.id;
      const c = state.cache.req(cache);
      c.capturedBy = p.side;
      if (from !== undefined) c.from = from;
      if (!here) p.cache = cache;
    }
    const moved = putInCache(ctx, state, id, cache, st.charge === undefined ? { type: st.type, count: n } : { type: st.type, count: n, charge: st.charge });
    if (moved <= 0) continue;
    kept[i]!.count -= moved;
    const m = moved * per;
    left -= m; put += m;
  }
  if (here) { const rest = kept.filter((st) => st.count > 0); if (rest.length > 0) g.took = rest; }
  if (put > 0 && cache !== undefined) events.emit({ kind: "pow.cached", tick: state.tick, soldier: id, side: p.side, point: pid, cache, kg: Math.round(put * 10) / 10 });
}

// ---------------------------------------------------------------- escapes (M11.9c)

/** A unit's standing rule for its prisoners' escorts (its own, else its top unit's; absent: "auto"). */
export function prisonerRule(state: SimState, uid: EntityId): "auto" | "ask" {
  const u = state.unit.get(uid);
  return u?.prisonerRule ?? state.unit.get(topOf(state, uid))?.prisonerRule ?? "auto";
}

/** Is prisoner `m` watched: a fit man of the holding side `by` on foot within `guard.watchM` who sees him? */
export function watched(ctx: SimContext, state: SimState, P: Prisoners, m: EntityId, by: string): boolean {
  const R = P.guard.watchM ?? 25, E = P.escape!;
  const pt = state.transform.req(m), ps = state.soldier.req(m);
  const pz = standZ(ctx.map, pt) + TARGET_POINT_M[ps.posture];
  const smoke = state.smoke.length > 0 ? smokePhysics(ctx.catalog) : null;
  // mounted: ok (a man aboard does not watch prisoners)
  for (const [w, ws] of state.soldier.entries()) {
    if (w === m || ws.casualty !== "none" || !isAble(ws) || isMounted(ws) || state.identity.get(w)?.side !== by) continue;
    const t = state.transform.req(w);
    const dx = t.x - pt.x, dy = t.y - pt.y;
    if (dx * dx + dy * dy > R * R) continue;
    const ez = standZ(ctx.map, t) + eyeHeightM(ctx, ws.posture);
    const sg = sight(ctx, t.x, t.y, ez, pt.x, pt.y, pz);
    if (sg.blockedBy !== null) continue;
    const v = sg.visibility * (smoke ? smokeTransmission(state, smoke, t.x, t.y, ez, pt.x, pt.y, pz) : 1);
    if (v >= E.seeMin) return true;
  }
  return false;
}

/** His chance this minute (header "escapes"), unwatched: the data chance times the factors that apply now. */
export function escapeChance(ctx: SimContext, state: SimState, P: Prisoners, m: EntityId): number {
  const E = P.escape!, s = state.soldier.req(m), c = s.captive!, t = state.transform.req(m);
  let k = E.perMinute;
  if (state.environment.light < E.darkBelowLight) k *= E.darkFactor;
  if (state.smoke.length > 0) {
    const z = standZ(ctx.map, t) + 1;
    if (smokeTransmission(state, smokePhysics(ctx.catalog), t.x - 5, t.y, z, t.x + 5, t.y, z) < E.smokeBelow) k *= E.smokeFactor;
  }
  const g = c.group ?? "man", side = state.identity.req(m).side;
  // mounted: ok (prisoners are on foot)
  for (const [o, os] of state.soldier.entries()) {
    if (o === m || !os.captive || os.captive.state !== "captured" || (os.captive.group ?? "man") === g || !os.physiology.alive || isMounted(os) || state.identity.get(o)?.side !== side) continue;
    const q = state.transform.req(o);
    if (hypot2(q.x - t.x, q.y - t.y) <= E.mixedM) { k *= E.mixedFactor; break; }
  }
  if (c.searched !== undefined) k *= E.searchedFactor;
  return Math.min(1, k);
}

/** The nearest fit man of his side on foot (where he runs), or null. */
function ownNearest(state: SimState, m: EntityId): { id: EntityId; d: number } | null {
  const side = state.identity.req(m).side, t = state.transform.req(m);
  let best: { id: EntityId; d: number } | null = null;
  // mounted: ok (he runs to a man on foot)
  for (const [o, os] of state.soldier.entries()) {
    if (o === m || os.casualty !== "none" || !isAble(os) || isMounted(os) || state.identity.get(o)?.side !== side) continue;
    const q = state.transform.req(o), d = hypot2(q.x - t.x, q.y - t.y);
    if (best === null || d < best.d) best = { id: o, d };
  }
  return best;
}

/** Once a minute: a walking prisoner nobody watches may try to escape (header "escapes"). */
function tryEscape(ctx: SimContext, state: SimState, events: EventSink, P: Prisoners, m: EntityId): void {
  const s = state.soldier.get(m);
  if (!s || !held(s) || !walks(state, s)) return;
  const c = s.captive!;
  if (c.vehicle !== undefined || s.atNest !== undefined || state.carry.has(m) || state.action.has(m) || c.by === undefined) return;
  if (ownNearest(state, m) === null) return; // (nowhere to run to)
  if (watched(ctx, state, P, m, c.by)) return;
  const chance = escapeChance(ctx, state, P, m);
  if (nextFloat(state.rng, Streams.prisoners) >= chance) return;
  const point = c.point;
  if (c.escort !== undefined) { const g = state.soldier.get(c.escort)?.guard; if (g) g.men = g.men.filter((x) => x !== m); }
  delete c.point; delete c.escort; delete c.vehicle;
  c.escape = { tick: state.tick, openTick: state.tick + secondsToTicks(P.escape!.graceSeconds), routeTick: -1e9 };
  delete s.crawlCover;
  halt(state, m);
  events.emit({ kind: "pow.escape", tick: state.tick, soldier: m, side: state.identity.req(m).side, by: c.by, phase: "started", chance: Math.round(chance * 10000) / 10000, ...(point !== undefined ? { point } : {}), searched: c.searched !== undefined });
}

/** Enemies of `side` no longer know man `m` to be giving up (every one, or all but the guards). */
function unflag(state: SimState, m: EntityId, side: string, all: boolean): void {
  // mounted: ok (a man aboard forgets the flag as well)
  for (const [o, os] of state.soldier.entries()) {
    if ((!all && os.guard !== undefined) || state.identity.get(o)?.side === side) continue;
    for (const k of os.contacts) if (k.target === m && k.surrendered === true) delete k.surrendered;
  }
}

/** He is free (escaped, or freed by his own men): back with his side, the holding side `by` noted. */
function setFree(state: SimState, events: EventSink, m: EntityId, by: string): void {
  const s = state.soldier.req(m), side = state.identity.req(m).side;
  s.captive = null;
  delete s.handOver; delete s.crawlCover;
  s.freedFrom = by;
  unflag(state, m, side, true);
  s.mental.behaviour = "shaken";
  events.emit({ kind: "behaviour.changed", tick: state.tick, soldier: m, from: "surrendered", to: "shaken" });
}

/**
 * Review fix: a held prisoner with a fit man of his side within `escape.freeM` and no fit man of the holding side
 * within that is freed by his own men (the ground retaken): `pow.escape` "free" (with no attempt). True when freed.
 */
function liberate(ctx: SimContext, state: SimState, events: EventSink, P: Prisoners, m: EntityId): boolean {
  const s = state.soldier.req(m), c = s.captive!, by = c.by;
  if (!P.escape || by === undefined) return false;
  const R = P.escape.freeM;
  const own = ownNearest(state, m);
  if (own === null || own.d > R) return false;
  const t = state.transform.req(m);
  // mounted: ok (a man aboard holds nobody)
  for (const [o, os] of state.soldier.entries()) {
    if (os.casualty !== "none" || !isAble(os) || isMounted(os) || state.identity.get(o)?.side !== by) continue;
    const q = state.transform.req(o);
    if (hypot2(q.x - t.x, q.y - t.y) <= R) return false;
  }
  if (c.escort !== undefined) { const g = state.soldier.get(c.escort)?.guard; if (g) g.men = g.men.filter((x) => x !== m); }
  halt(state, m);
  setFree(state, events, m, by);
  events.emit({ kind: "pow.escape", tick: state.tick, soldier: m, side: state.identity.req(m).side, by, phase: "free", searched: c.searched !== undefined });
  return true;
}

/** A prisoner escaping, each step (header "escapes"). */
function stepEscape(ctx: SimContext, state: SimState, events: EventSink, P: Prisoners, m: EntityId): void {
  const E = P.escape, s = state.soldier.req(m), c = s.captive!, esc = c.escape!;
  const side = state.identity.req(m).side, by = c.by ?? side;
  const end = (phase: "free" | "recaptured" | "stopped") => {
    halt(state, m);
    events.emit({ kind: "pow.escape", tick: state.tick, soldier: m, side, by, phase, searched: c.searched !== undefined });
  };
  const giveUp = (phase: "recaptured" | "stopped") => {
    c.state = "surrendered";
    delete c.escape; delete c.unit; delete c.point; delete c.escort; delete c.by;
    end(phase);
  };
  if (!E || !walks(state, s) || isMounted(s)) { giveUp("stopped"); return; }
  // The enemy no longer sees a man giving up: their flags taken back (never a guard's: guards let him go).
  if (esc.open !== true && state.tick >= esc.openTick) { esc.open = true; unflag(state, m, side, false); }
  const t = state.transform.req(m);
  // Recaptured: a fit man of the holding side beside him.
  // mounted: ok (a man aboard takes nobody)
  for (const [o, os] of state.soldier.entries()) {
    if (os.casualty !== "none" || !isAble(os) || isMounted(os) || state.identity.get(o)?.side !== by) continue;
    const q = state.transform.req(o);
    if (hypot2(q.x - t.x, q.y - t.y) <= E.recaptureM && Math.abs(q.z - t.z) <= 1.5) { giveUp("recaptured"); return; }
  }
  const own = ownNearest(state, m);
  if (own !== null && own.d <= E.freeM) {
    // Free: back with his side (the one way back from "captured"), unarmed if he was searched.
    setFree(state, events, m, by);
    end("free");
    return;
  }
  if (own === null) { if ((state.mover.get(m)?.waypoints.length ?? 0) > 0) halt(state, m); return; }
  if (state.tick - esc.routeTick < secondsToTicks(E.routeS) && (state.mover.get(m)?.waypoints.length ?? 0) > 0) return;
  esc.routeTick = state.tick;
  const q = state.transform.req(own.id), mv = state.mover.get(m);
  const leg = mv ? routeBetween(ctx, navFor(ctx, "foot").search, t.x, t.y, q.x, q.y, { maxExpansions: 8000, snapCells: 3 }, { sz: t.z, gz: q.z }) : null;
  if (!mv || !leg) return;
  mv.waypoints = routeWaypoints(leg, { x: 0, y: 0, mode: "run" });
  mv.formation = null; mv.endPosture = null; mv.endHeading = null;
}

// ---------------------------------------------------------------- the search

/** Beside the prisoner, able, not pinned down. */
function searchCheck(ctx: SimContext, state: SimState, actor: EntityId, pr: EntityId): string | null {
  const s = state.soldier.get(actor), ps = state.soldier.get(pr);
  if (!s || !isAble(s) || !s.impair.canUseArms || isMounted(s) || s.guard?.phase !== "search") return "unable";
  if (!ps || !held(ps)) return "gone";
  if (s.mental.suppression >= ctx.catalog.behaviour.decisions.seekCoverSuppression) return "suppressed";
  const a = state.transform.req(actor), b = state.transform.req(pr);
  const r = (ctx.catalog.prisoners?.search.reachM ?? 2) + 0.5;
  if ((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y) > r * r || Math.abs(a.z - b.z) > 1.5) return "out-of-reach";
  return null;
}

/**
 * Search prisoner `pr` (header "search"): everything he may not keep goes to `searcher` by `transferItems`; his weapon
 * becomes its counted item first (the ledger counts a weapon in the hands as that item), the batteries in his devices
 * go back into his load first (they are taken with the devices).
 */
export function searchPrisoner(ctx: SimContext, state: SimState, events: EventSink, searcher: EntityId, pr: EntityId): void {
  const ps = state.soldier.req(pr), pc = state.container.get(pr);
  const cap = ps.captive!;
  if (pc && ps.power) {
    for (const slot of ps.power) if (slot.battery !== null) addItems(pc, slot.battery, 1, settle(chargeAt(slot, state.tick)));
    delete ps.power;
  }
  let weapons = 0;
  const w = state.weapon.get(pr), wd = w ? ctx.catalog.weapons[w.weapon] : undefined;
  if (pc && w && wd?.weaponItem !== undefined) {
    if (w.magazine) addItems(pc, w.magazine.item, 1, w.magazine.rounds);
    addItems(pc, wd.weaponItem, 1);
    state.weapon.delete(pr);
    state.fire.delete(pr);
  }
  let rounds = 0, documents = 0, kg = 0, kept = 0;
  const took: { type: DefId; count: number; charge?: number }[] = [];
  for (const st of pc ? [...pc.stacks] : []) {
    const d = ctx.catalog.items[st.type];
    if (d?.prisonerKeeps === true) { kept += st.count; continue; }
    const r = transferItems(ctx.catalog, state.container, st.charge === undefined ? { from: pr, to: searcher, type: st.type, count: st.count } : { from: pr, to: searcher, type: st.type, count: st.count, charge: st.charge });
    if (r.moved <= 0) continue;
    const moved = st.charge === undefined ? { type: st.type, count: r.moved } : { type: st.type, count: r.moved, charge: st.charge };
    took.push(moved);
    kg += stackMassKg(ctx.catalog, moved);
    if (d?.category === "weapon") weapons += r.moved;
    if (d?.documents === true) documents += r.moved;
    if (st.charge !== undefined && d?.chargeItem !== undefined && ctx.catalog.ammo[d.chargeItem] !== undefined) rounds += st.charge * r.moved;
    else if (ctx.catalog.ammo[st.type] !== undefined) rounds += r.moved;
    events.emit({ kind: "items.taken", tick: state.tick, from: pr, to: searcher, item: st.type, count: r.moved, rounds: st.charge !== undefined ? st.charge * r.moved : ctx.catalog.ammo[st.type] !== undefined ? r.moved : 0, source: "enemy" });
  }
  cap.searched = state.tick;
  if (documents > 0) cap.documents = (cap.documents ?? 0) + documents;
  cap.searchTicks = secondsToTicks(ctx.catalog.prisoners?.search.seconds ?? 0);
  const g = state.soldier.get(searcher)?.guard;
  if (g) g.took = [...(g.took ?? []), ...took];
  const side = state.identity.req(pr).side;
  events.emit({ kind: "pow.searched", tick: state.tick, soldier: pr, side, by: searcher, weapons, rounds, documents, kg: Math.round(kg * 10) / 10, kept });
  if (documents > 0) events.emit({ kind: "pow.documents", tick: state.tick, soldier: pr, side, by: searcher, count: documents });
}

registerActionHandler("searchPrisoner", {
  check(ctx, state, actor, a) {
    const pr = Number(a.params["prisoner"]);
    const why = searchCheck(ctx, state, actor, pr);
    // (Progress is kept: an interrupted search goes on from here, header "search".)
    const c = state.soldier.get(pr)?.captive;
    if (c && c.searched === undefined) c.searchTicks = Number(a.params["prior"] ?? 0) + (state.tick - a.startTick);
    return why;
  },
  complete(ctx, state, actor, a, events) {
    const pr = Number(a.params["prisoner"]);
    if (searchCheck(ctx, state, actor, pr) !== null) return;
    searchPrisoner(ctx, state, events, actor, pr);
    // (Review fix: beyond `search.maxKg` into a captured cache where he searched, not carried along.)
    const g = state.soldier.get(actor)?.guard, P = ctx.catalog.prisoners;
    if (g && P && state.rear.has(g.point)) overflow(ctx, state, events, P, actor, g.point, true);
  },
});

// ---------------------------------------------------------------- orders

/** The player's `prisonerPoint` (header "point"): the target's platoon has its collection point here (it stays). */
export function prisonerPointOrder(ctx: SimContext, state: SimState, events: EventSink, target: EntityId, x: number, y: number): true | false | { unable: string } {
  const P = ctx.catalog.prisoners;
  const uid = state.unit.has(target) ? target : state.identity.get(target)?.unit;
  if (!P || uid === undefined) return false;
  const top = topOf(state, uid);
  const at = passableNear(ctx, x, y);
  for (const q of [nestOf(state, top), supplyPointOf(state, top)]) {
    if (q === null) continue;
    const r = state.rear.req(q);
    if (hypot2(r.x - at.x, r.y - at.y) < P.pcp.apartM) return { unable: r.kind === "medical" ? "radio.powNearNest" : "radio.powNearSupply" };
  }
  return setPrisonerPoint(ctx, state, events, top, at.x, at.y, "ordered") !== null;
}

/** The player's `escortPrisoners`: the target unit's prisoners waiting get escorts now (the quiet gate waived). */
export function escortPrisonersOrder(ctx: SimContext, state: SimState, events: EventSink, target: EntityId): true | { unable: string } {
  const P = ctx.catalog.prisoners;
  const uid = state.unit.has(target) ? target : state.identity.get(target)?.unit;
  if (!P || uid === undefined) return { unable: "radio.powNone" };
  const inTree = new Set(unitsOf(state, uid));
  const top = topOf(state, uid);
  // (Review fix: the platoon's prisoners all — the step counts them — and escorts for the target's alone.)
  const men: EntityId[] = [];
  // mounted: ok (prisoners and men on duty are on foot; held() and the duty step check)
  for (const [id, s] of state.soldier.entries()) {
    if (!held(s) || !state.unit.has(s.captive!.unit!) || topOf(state, s.captive!.unit!) !== top) continue;
    s.captive!.group ??= prisonerGroup(ctx, state, id);
    men.push(id);
  }
  const waiting = men.filter((m) => { const s = state.soldier.req(m), c = s.captive!; return inTree.has(c.unit!) && c.point === undefined && c.escort === undefined && !state.carry.has(m) && (s.atNest !== undefined ? c.searched === undefined : c.searched === undefined || walks(state, s)); });
  if (waiting.length === 0) return { unable: "radio.powNone" };
  return stepPlatoon(ctx, state, events, P, top, men, new Set(waiting)) > 0 ? true : { unable: "radio.powNoEscort" };
}

/**
 * The player's `releaseGuard`: the target (a man on duty, or a unit's men on duty) go back to their squads. The last
 * guard of a point with prisoners and a known enemy within `pcp.enemyM` is refused unless `confirm`.
 */
export function releaseGuardOrder(ctx: SimContext, state: SimState, events: EventSink, target: EntityId, confirm: boolean): true | { unable: string } {
  const P = ctx.catalog.prisoners;
  if (!P) return { unable: "radio.powNoGuard" };
  const men = state.unit.has(target) ? unitsOf(state, target).flatMap((u) => state.unit.req(u).members) : [target];
  const on = men.filter((m) => state.soldier.get(m)?.guard !== undefined).sort((a, b) => a - b);
  if (on.length === 0) return { unable: "radio.powNoGuard" };
  // (Review fix: per point, the guards left once ALL of these are gone.)
  const going = new Set(on);
  const points = [...new Set(on.map((m) => state.soldier.req(m).guard!).filter((g) => g.phase === "guard").map((g) => g.point))].sort((a, b) => a - b);
  if (!confirm) for (const pid of points) {
    const p = state.rear.get(pid);
    let others = 0, nHeld = 0;
    // mounted: ok (prisoners and men on duty are on foot; held() and the duty step check)
    for (const [o, os] of state.soldier.entries()) {
      if (!going.has(o) && os.guard?.point === pid && os.guard.phase === "guard") others++;
      if (os.captive?.point === pid && held(os)) nHeld++;
    }
    if (p && others === 0 && nHeld > 0 && knownEnemies(ctx, state, p.unit).some((e) => hypot2(e.x - p.x, e.y - p.y) < P.pcp.enemyM)) return { unable: "radio.powLastGuard" };
  }
  for (const m of on) release(ctx, state, events, m, true);
  return true;
}

/** For the UI and the review: a point's prisoners held by group, and its guards. */
export function pointCounts(view: { soldier: { entries(): Iterable<[EntityId, SoldierState]> } }, pid: EntityId): { officer: number; nco: number; man: number; guards: number } {
  const out = { officer: 0, nco: 0, man: 0, guards: 0 };
  for (const [, s] of view.soldier.entries()) {
    if (s.captive?.point === pid && s.physiology.alive && s.evacuated === undefined && s.atNest === undefined && s.mount === undefined) out[s.captive.group ?? "man"]++;
    if (s.guard?.point === pid && s.guard.phase === "guard") out.guards++;
  }
  return out;
}
