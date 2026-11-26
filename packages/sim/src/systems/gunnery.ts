/**
 * VEHICLE GUNNERY (M7.3, plan §7): turrets, cannon and coaxial machine guns with counted ammunition, smoke
 * dischargers, refilling ready belts from stowage.
 *
 *   stationDecisionSystem  once a second per vehicle (staggered): what each station fires at, with what. An
 *                          ordered task is kept (and follows the named enemy as the crew knows him); otherwise,
 *                          if the crew unit's fire rule allows it, the crew picks among the enemies its men saw
 *                          lately or a comrade reported precisely: vehicles first (armour-piercing), then men
 *                          firing now, nearest first; groups and far men get high explosive at their feet, a
 *                          single near man the coaxial machine gun. The reasons are kept as string keys
 *                          (`station.why`, `vehicle.decision`) for the debug overlay. Halted, a ready belt run
 *                          low is refilled from stowage (owner Q17: both vehicles, about 90 s).
 *   turretSystem           lays the turret: bearing with lead (from the drop table's time of flight), elevation
 *                          with drop; traverse and elevation rates, limits and arc; a stabilised turret holds its
 *                          bearing while the hull turns. Laid = within the station's tolerance.
 *   stationFireSystem      fires: an able operator (the commander if the gunner is out and the station allows
 *                          it), rounds on the feed, feed switched, laid, line of fire clear from the muzzle (the
 *                          own hull ignored), no comrade on foot in the way, bursts as the weapon's data says.
 *                          Error from the station (stabiliser, speed), the gunner's skill and the weapon; range
 *                          error from the rangefinder or the gunner's eye. Rounds are counted off the ready feed
 *                          (rule 9). The owner of every round is the operator (the gunner), `shot.fired.vehicle`
 *                          names the vehicle.
 *
 * Single-round feeds (the fixture's sling; tank guns later): one round per `roundLoadSeconds`, slower without an
 * able man in the loader's station (`noLoaderFactor`), impossible without one if no factor is given. The round
 * stays counted on the rack until it is fired.
 */
import { isOffMap } from "../offmap";
import { registerActionHandler, startAction } from "../actions";
import { dropAt, flightTimeAt } from "../ballistics";
import type { AmmoDef, Catalog, VehicleDef } from "../catalog";
import type { Contact, FireTask, StationState, Unit, VehicleState, VehicleWeaponState } from "../components";
import type { SimContext } from "../context";
import type { EventSink, SimEvent } from "../events";
import type { OrderBody, Posture } from "../orders";
import { secondsToTicks, TICK_HZ, type EntityId } from "../ids";
import { isAble } from "../impair";
import { emptyContainer, transferItems } from "../items";
import { sight } from "../los";
import { atan2, cos, hypot2, log, PI, pow, sin, sqrt, wrapAngle } from "../math";
import { compCondition, fireTop, isMounted, occupant, onRoof, REPAIR_INSIDE, vehicleItems } from "../mount";
import { indoorAt } from "../interior-nav";
import { reactiveAdd, tileFor } from "../tiles";
import { nextFloat, nextNormal, Streams } from "../rng";
import type { SimState } from "../state";
import { heightAt } from "../terrain";
import { aimHeightAt, dangerRadiusM, friendInLine, ownMenWithin, skillFactor } from "./fire";
import { burstCadence, launchShot, pickRound } from "./shot";
import { launchProjectile } from "./ballistics";
import { radioFromTarget } from "./orders";
import { contactErrorM } from "./contacts";
import { smokePhysics, smokeTransmission } from "../smoke";
import { addSmoke } from "../smoke";
import { protectedTargets, refusesFireAt } from "../protection";
import { noteFireAt } from "../conduct";

export type Nature = "ap" | "he" | "mg" | "atgm";

/** The guided missile a station weapon fires (owner 2026-11-13), if it is a missile launcher. */
export function guidedRound(catalog: Catalog, wdef: VehicleDef["stations"][number]["weapons"][number] | undefined): { ammo: string; g: NonNullable<AmmoDef["guided"]> } | null {
  const round = wdef ? catalog.items[wdef.feeds[0]?.item ?? ""]?.chargeItem : undefined;
  const g = round !== undefined ? catalog.ammo[round]?.guided : undefined;
  return g && round !== undefined ? { ammo: round, g } : null;
}

/** A fire-and-forget guidance kind (M9.3a): no gunner after the launch. */
export function fireAndForget(kind: string | undefined): boolean {
  return kind !== undefined && kind.startsWith("fire-and-forget");
}

/** Can this vehicle still fight (not knocked out, abandoned or destroyed)? */
export function canFight(v: VehicleState): boolean {
  // (M11.7b: not on a recovery vehicle's tow bar.)
  return (v.status === "ok" || v.status === "immobilised") && v.towedBy === undefined;
}

/** The man who works this station now: its operator if able, else the commander if the station allows it. */
export function stationOperator(state: SimState, v: VehicleState, def: VehicleDef, si: number): EntityId | null {
  const sn = def.stations[si]!;
  // (M9.3a: a man out on the roof reloading works no station; M11.7a: nor one at a repair, outside or inside.)
  const fit = (id: EntityId | null) => { const s = id === null ? undefined : state.soldier.get(id); return s !== undefined && isAble(s) && s.impair.canFight && !onRoof(state, id!) && !(state.action.size > 0 && state.action.get(id!)?.kind === REPAIR_INSIDE); };
  const op = occupant(v, def, sn.operator);
  if (fit(op)) return op;
  if (sn.commanderOverride) { const c = occupant(v, def, "commander"); if (fit(c)) return c; }
  return null;
}

/** The platoon (top) unit above a unit. */
function topOf(state: SimState, uid: EntityId): Unit | undefined {
  let u = state.unit.get(uid);
  while (u && u.parent !== null) { const p = state.unit.get(u.parent); if (!p) break; u = p; }
  return u;
}

/**
 * May this crew open fire on its own? Its own rule and cease-fire (fireTop: a crew unit governs its own fire,
 * plan C19); "return" fire answers fire on the crew or on its platoon (an IFV supports its men).
 */
export function gunneryAllowed(ctx: SimContext, state: SimState, crewId: EntityId): boolean {
  const crew = state.unit.get(fireTop(state, crewId));
  if (!crew || crew.fireRule === "hold") return false;
  const top = topOf(state, crewId);
  const under = Math.max(crew.underFireTick, top?.underFireTick ?? -1e9);
  const firedOnSinceCease = under > crew.ceaseFireTick;
  if (crew.ceaseFireTick > -1e9 && !firedOnSinceCease) return false;
  if (crew.fireRule === "free") return true;
  return firedOnSinceCease && state.tick - under <= secondsToTicks(ctx.catalog.behaviour.decisions.underFireMemorySeconds);
}

/** Does this feed's round burst (high explosive)? */
function feedIsHe(catalog: Catalog, item: string): boolean {
  const round = catalog.items[item]?.chargeItem;
  return round !== undefined && catalog.ammo[round]?.explosive !== undefined;
}

/**
 * The weapon and feed for a nature on this station, with rounds: "mg" = a coaxial (non-cannon) weapon,
 * "ap" / "he" = a cannon feed of that kind. null if none has rounds.
 */
export function pickFeed(ctx: SimContext, def: VehicleDef, st: StationState, si: number, nature: Nature, v?: VehicleState): { weapon: number; feed: number } | null {
  const sn = def.stations[si]!;
  for (let wi = 0; wi < sn.weapons.length; wi++) {
    const wdef = sn.weapons[wi]!, w = st.weapons[wi]!;
    // Guided missiles only as "atgm" (owner 2026-11-13); a missile still being put on is not there.
    const guided = guidedRound(ctx.catalog, wdef) !== null;
    if (guided !== (nature === "atgm")) continue;
    if (guided) { if ((w.feeds[0]?.rounds ?? 0) > 0 && !(v && weaponOut(ctx, v, def, si, wi))) return { weapon: wi, feed: 0 }; continue; }
    const cannon = ctx.catalog.weapons[wdef.weapon]?.type === "autocannon" || !wdef.coax;
    if ((nature === "mg") === cannon) continue;
    if (v && weaponOut(ctx, v, def, si, wi)) continue; // wrecked (M7.4b)
    for (let fi = 0; fi < wdef.feeds.length; fi++) {
      if ((w.feeds[fi]?.rounds ?? 0) <= 0) continue;
      if (nature === "mg") return { weapon: wi, feed: fi };
      if (feedIsHe(ctx.catalog, wdef.feeds[fi]!.item) === (nature === "he")) return { weapon: wi, feed: fi };
    }
  }
  return null;
}

/** First choice of nature, then the others in a sensible order (a crew out of one kind uses what it has). */
function feedFor(ctx: SimContext, def: VehicleDef, st: StationState, si: number, want: Nature, v: VehicleState): { weapon: number; feed: number; nature: Nature } | null {
  const order: Nature[] = want === "atgm" ? ["atgm", "ap", "he"] : want === "ap" ? ["ap", "he"] : want === "he" ? ["he", "mg", "ap"] : ["mg", "he", "ap"];
  for (const n of order) { const f = pickFeed(ctx, def, st, si, n, v); if (f) return { ...f, nature: n }; }
  return null;
}

/** A station weapon wrecked (M7.4b): the cannon by the "gun" component, a coaxial machine gun by "coax". */
export function weaponOut(ctx: SimContext, v: VehicleState, def: VehicleDef, si: number, wi: number): boolean {
  const wdef = def.stations[si]?.weapons[wi];
  if (!wdef || !def.components) return false;
  // A missile launcher is guided through the gunner's sight: wrecked sights, no missile (owner 2026-11-13).
  // A missile fired through a tank's gun (M7.6a): the gun wrecked, no missile either.
  // (Balance pass 6: a launcher outside the armour is a part of its own: wrecked, no missile. A hull without one: 1.)
  if (guidedRound(ctx.catalog, wdef)) return compCondition(v, def, "sights") <= 0 || (ctx.catalog.weapons[wdef.weapon]?.type === "tank-gun" ? compCondition(v, def, "gun") <= 0 : compCondition(v, def, "launcher") <= 0);
  const cannon = ctx.catalog.weapons[wdef.weapon]?.type === "autocannon" || !wdef.coax;
  return compCondition(v, def, cannon ? "gun" : "coax") <= 0;
}

/** Nature of the weapon/feed a station task uses. */
function natureOf(ctx: SimContext, def: VehicleDef, si: number, wi: number, fi: number): Nature {
  const wdef = def.stations[si]?.weapons[wi];
  if (!wdef) return "mg";
  if (guidedRound(ctx.catalog, wdef)) return "atgm";
  const cannon = ctx.catalog.weapons[wdef.weapon]?.type === "autocannon" || !wdef.coax;
  if (!cannon) return "mg";
  return feedIsHe(ctx.catalog, wdef.feeds[fi]?.item ?? "") ? "he" : "ap";
}

/** Range the drop tables of this weapon are built to (beyond the infantry's 1500 m when it reaches further). */
function tableRange(engageRangeM: number): number {
  return Math.max(1500, Math.ceil(engageRangeM / 500) * 500 + 500);
}

/** Give a station a task: fire at (x, y) at `heightM` above the ground, with this weapon and feed. */
export function setStationTask(
  ctx: SimContext, state: SimState, vid: EntityId, si: number, x: number, y: number, heightM: number,
  weapon: number, feed: number, contact: EntityId | undefined, self: boolean,
): void {
  const v = state.vehicle.req(vid), def = ctx.catalog.vehicles[v.def]!, st = v.stations[si]!, sn = def.stations[si]!;
  const prev = st.task;
  const op = stationOperator(state, v, def, si);
  const skill = op === null ? 0.5 : (state.soldier.get(op)?.skills["marksmanship"] ?? 0.5);
  const G = ctx.catalog.behaviour.gunnery;
  // Range error: the laser rangefinder's, else the gunner's eye (stadia).
  const frac = sn.rangefinder ? G.lrfRangeErrorFraction : ctx.catalog.shooting.aim.rangeErrorFraction * skillFactor(ctx, skill);
  const same = prev !== null && hypot2(prev.x - x, prev.y - y) < 3 && st.taskWeapon === weapon;
  const task: FireTask = {
    x, y, heightM, reasonTick: state.tick,
    rangeError: same ? prev!.rangeError : frac * nextNormal(state.rng, Streams.station),
    startTick: same ? prev!.startTick : state.tick,
    lineCheckTick: same ? prev!.lineCheckTick : -100000, lineClear: same ? prev!.lineClear : true,
    linePosture: "standing", basePosture: "standing",
  };
  if (contact !== undefined) task.contact = contact;
  if (self) task.self = true;
  st.task = task;
  st.taskWeapon = weapon; st.taskFeed = feed;
}

/** A crew's picture of an enemy: the most certain contact any able man of the crew unit holds. */
function crewContact(ctx: SimContext, state: SimState, crew: Unit, target: EntityId): { x: number; y: number; err: number; vx: number; vy: number; z?: number; posture?: Posture; kind: Contact["kind"] } | null {
  let best: { x: number; y: number; err: number; vx: number; vy: number; z?: number; posture?: Posture; kind: Contact["kind"] } | null = null;
  for (const m of crew.members) {
    const s = state.soldier.get(m);
    if (!isAble(s)) continue;
    for (const c of s!.contacts) {
      if (c.target !== target) continue;
      const err = contactErrorM(ctx, c, state.tick);
      if (!best || err < best.err) best = { x: c.x, y: c.y, err, vx: c.vx ?? 0, vy: c.vy ?? 0, kind: c.kind, ...(c.z !== undefined ? { z: c.z } : {}), ...(c.posture !== undefined ? { posture: c.posture } : {}) };
    }
  }
  return best;
}

/** Is the enemy entity still worth firing at (a man not down, a vehicle still fighting)? */
function targetLive(state: SimState, id: EntityId): boolean {
  const s = state.soldier.get(id);
  if (s) return s.physiology.alive && s.casualty === "none" && s.captive === null;
  const v = state.vehicle.get(id);
  return v !== undefined && v.status !== "destroyed" && v.status !== "abandoned";
}

/**
 * Balance pass 4 (owner 2026-11-19, danger close): how near the point aimed at an own man must not be when this
 * station weapon fires this feed at `rangeM`: the round's danger radius (`dangerRadiusM`: its fragments and blast)
 * plus its spread there, one standard deviation of the range error (the laser rangefinder's, else the eye's; the
 * gunner's skill not counted: the worst case near enough) and two of the weapon's and the sight's angular error.
 * 0 for a round that does not burst.
 */
export function stationDangerM(ctx: SimContext, def: VehicleDef, si: number, wi: number, fi: number, rangeM: number): number {
  const sn = def.stations[si], wdef = sn?.weapons[wi];
  const round = wdef ? ctx.catalog.items[wdef.feeds[fi]?.item ?? ""]?.chargeItem : undefined;
  const dr = round === undefined ? 0 : dangerRadiusM(ctx, round);
  if (dr <= 0) return 0;
  const disp = ctx.catalog.weapons[wdef!.weapon]?.dispersionMrad ?? 0;
  const frac = sn!.rangefinder ? ctx.catalog.behaviour.gunnery.lrfRangeErrorFraction : ctx.catalog.shooting.aim.rangeErrorFraction;
  return dr + rangeM * (frac + (2 * sqrt(sn!.baseErrorMrad * sn!.baseErrorMrad + disp * disp)) / 1000);
}

/** Why a crew holds its fire at the targets it has (the first such reason is shown). */
type HoldWhy = "why.hold.friends" | "why.hold.dangerClose" | "why.hold.noPierce";

/**
 * Balance pass 5 (F5): the enemy hulls an own missile is being guided onto now (a station's or a team's), or null.
 * Few hulls and teams: a scan per decision.
 */
export function guidedTargets(state: SimState, side: string): EntityId[] | null {
  let out: EntityId[] | null = null;
  for (const [, ov] of state.vehicle.entries()) {
    if (ov.side !== side || isOffMap(ov)) continue;
    for (const st of ov.stations) if (st.guide && st.guide.target >= 0) (out ??= []).push(st.guide.target);
  }
  for (const [, u] of state.unit.entries()) {
    const g = u.missileTeam?.guide;
    if (g && g.target >= 0 && u.side === side) (out ??= []).push(g.target);
  }
  return out;
}

/** The crew's choice of target: score, reasons, nature. */
function chooseTarget(ctx: SimContext, state: SimState, vid: EntityId, v: VehicleState, def: VehicleDef, crew: Unit, si: number):
  { target: EntityId; x: number; y: number; heightM: number; nature: Nature; keys: string[] } | HoldWhy | null {
  const G = ctx.catalog.behaviour.gunnery, tick = state.tick;
  const me = state.transform.req(vid);
  const sn = def.stations[si]!;
  // The guns' reach; a missile ready on its launcher, halted, reaches further at vehicles (owner 2026-11-13).
  let reach = 0;
  for (const w of sn.weapons) if (!guidedRound(ctx.catalog, w)) reach = Math.max(reach, w.engageRangeM);
  // (Balance pass 5, F1: also while it moves, when the crew may halt for it: `missileHoldSeconds`, not under a
  // player's move order.)
  const msl = missileReady(ctx, v, def, si, G.missileHoldSeconds !== undefined && v.playerHold !== true);
  let mReach = msl ? Math.min(sn.weapons[msl.weapon]!.engageRangeM, msl.g.maxRangeM) : 0;
  if (crew.maxEngageM > 0) { reach = Math.min(reach, crew.maxEngageM); mReach = Math.min(mReach, crew.maxEngageM); }
  // (An ambush laid, D4b: the crew holds its fire to its range until it is sprung.)
  if (crew.ambush !== undefined) { reach = Math.min(reach, crew.ambush.rangeM); mReach = Math.min(mReach, crew.ambush.rangeM); }
  // Candidates: what the crew saw lately, or a comrade reported precisely and recently (ascending target id).
  const cands = new Map<EntityId, { x: number; y: number; err: number; z?: number; posture?: Posture; kind: Contact["kind"] }>();
  const prot = protectedTargets(state, crew.members);
  for (const m of crew.members) {
    const s = state.soldier.get(m);
    if (!isAble(s)) continue;
    for (const c of s!.contacts) {
      if (c.surrendered || c.down) continue;
      // (M10.7a: one crewman who recognises an ambulance or a medic is enough for the whole crew.)
      if (prot !== null && prot.has(c.target)) continue;
      const age = tick - c.tick;
      const ok = c.kind === "seen" ? age <= secondsToTicks(G.seenWithinSeconds) : c.kind === "reported" && age <= secondsToTicks(G.reportedWithinSeconds) && contactErrorM(ctx, c, tick) <= G.reportedErrorM;
      if (!ok) continue;
      const err = contactErrorM(ctx, c, tick);
      const prev = cands.get(c.target);
      if (!prev || err < prev.err) cands.set(c.target, { x: c.x, y: c.y, err, kind: c.kind, ...(c.z !== undefined ? { z: c.z } : {}), ...(c.posture !== undefined ? { posture: c.posture } : {}) });
    }
  }
  const scored: { target: EntityId; x: number; y: number; z?: number; posture?: Posture; kind: Contact["kind"]; score: number; vehicle: boolean; firing: boolean }[] = [];
  // Balance pass 5 (F5): fire spread over the enemy's hulls: one an own missile is already guided onto, or one just
  // penetrated, counts as farther.
  const guided = guidedTargets(state, v.side);
  const gF = G.guidedTargetFactor ?? 1, pF = G.penetratedTargetFactor ?? 1, penT = secondsToTicks(G.recentPenSeconds ?? 0);
  for (const [target, c] of [...cands.entries()].sort((a, b) => a[0] - b[0])) {
    if (!targetLive(state, target)) continue;
    const d = hypot2(c.x - me.x, c.y - me.y);
    const isVeh = state.vehicle.has(target);
    if (d > (isVeh ? Math.max(reach, mReach) : reach)) continue;
    const ew = isVeh ? undefined : state.weapon.get(target);
    const firing = isVeh
      ? state.vehicle.get(target)!.stations.some((st) => st.weapons.some((w) => tick - w.lastShotTick <= 3 * TICK_HZ))
      : ew !== undefined && tick - ew.lastShotTick <= 3 * TICK_HZ;
    let spread = 1;
    if (isVeh) {
      if (guided !== null && guided.includes(target)) spread *= gF;
      const tv = state.vehicle.get(target)!;
      if (penT > 0 && tick - tv.lastPenTick <= penT) spread *= pF;
    }
    scored.push({ target, x: c.x, y: c.y, kind: c.kind, ...(c.z !== undefined ? { z: c.z } : {}), ...(c.posture !== undefined ? { posture: c.posture } : {}), score: d * (isVeh ? G.vehicleScore : 1) * (firing ? G.firingScore : 1) * spread, vehicle: isVeh, firing });
  }
  scored.sort((a, b) => a.score - b.score || a.target - b.target);
  // The best one the gun can reach from where the vehicle stands (a few lines of fire tried, best first), and fire at
  // it not held for own men (balance pass 4 review, H2: before, the crew kept a target its gun could never fire at).
  const st = v.stations[si]!;
  const op = stationOperator(state, v, def, si);
  let held: HoldWhy | null = null;
  let noPierce: (typeof scored)[number] | null = null;
  for (const cnd of scored.slice(0, 4)) {
    const [mx, my, mz] = muzzleWorld(ctx, def, si, 0, me.x, me.y, me.heading, st.azimuth);
    // M7.6b: at a vehicle, the lowest of its aim points the line clears (hull, else the turret over a crest).
    let ap = 0;
    if (cnd.vehicle) {
      ap = visibleAimIndex(ctx, state, cnd.target, mx, my, mz, vid, cnd.x, cnd.y);
      if (ap < 0) continue;
    } else {
      const tz = heightAt(ctx.map, cnd.x, cnd.y) + aimHeightAt(ctx, cnd); // ground: ok (a man's floor in his aim height)
      const r = sight(ctx, mx, my, mz, cnd.x, cnd.y, tz, vid, -1);
      if (!(r.blockedBy === null || (1 - r.blockedAt) * hypot2(cnd.x - mx, cnd.y - my) <= LINE_ALLOWANCE_M)) continue;
    }
    const pick = natureFor(ctx, state, vid, me, v, def, si, st, cands, cnd, ap, reach, mReach, msl);
    if (typeof pick === "string") { held ??= pick; if (pick === "why.hold.noPierce") noPierce ??= cnd; continue; }
    if (pick.nature !== "atgm" && op !== null) {
      const f = feedFor(ctx, def, st, si, pick.nature, v);
      const why = f ? stationHeld(ctx, state, vid, v, def, si, f.weapon, f.feed, op, cnd.x, cnd.y, pick.heightM) : null;
      if (why !== null) { held ??= why; continue; }
    }
    return { target: cnd.target, x: cnd.x, y: cnd.y, ...pick };
  }
  // Balance pass 6: nothing else to fire at, and a hull its armour-piercing round cannot get through: the cannon at
  // what is outside its armour.
  if (noPierce !== null && op !== null) {
    const dg = degradePick(ctx, state, vid, v, def, si, st, op, me, noPierce);
    if (dg) return dg;
  }
  return held;
}

/**
 * Degrading fire (balance pass 6, gunnery.degrade): the nature and aim point for a burst at an enemy hull the
 * armour-piercing round cannot get through: a cannon of the listed weapon types, the hull within `maxRangeM` and the
 * weapon's reach, the first listed nature with ready rounds above the reserve and not held for own men; aimed at the
 * turret (its highest aim point) when the line to it is clear, else at the lowest point in sight. Not under the
 * ammunition rule 'conserve'. null: hold.
 */
function degradePick(
  ctx: SimContext, state: SimState, vid: EntityId, v: VehicleState, def: VehicleDef, si: number, st: StationState, op: EntityId,
  me: { x: number; y: number; heading: number }, cnd: { target: EntityId; x: number; y: number },
): { target: EntityId; x: number; y: number; heightM: number; nature: Nature; keys: string[] } | null {
  const D = ctx.catalog.behaviour.gunnery.degrade;
  if (!D || !D.enabled) return null;
  // (Not with ammunition 'conserve': rounds that cannot kill are the first to be saved, as area fire is.)
  if (v.unit !== null && state.unit.get(fireTop(state, v.unit))?.ammoRule === "conserve") return null;
  const d = hypot2(cnd.x - me.x, cnd.y - me.y);
  if (d > D.maxRangeM) return null;
  const aps = aimPointsOf(ctx, state, cnd.target);
  const [mx, my, mz] = muzzleWorld(ctx, def, si, 0, me.x, me.y, me.heading, st.azimuth);
  let k = visibleAimIndex(ctx, state, cnd.target, mx, my, mz, vid, cnd.x, cnd.y);
  if (k < 0) return null;
  if (D.aimZone === "turret" && aps.length > 1 && k < aps.length - 1) {
    const top = aps[aps.length - 1]!;
    const tz = heightAt(ctx.map, cnd.x, cnd.y) + top[2]; // ground: ok (a hull's aim point)
    const r = sight(ctx, mx, my, mz, cnd.x, cnd.y, tz, vid, cnd.target);
    if (r.blockedBy === null || (1 - r.blockedAt) * hypot2(cnd.x - mx, cnd.y - my) <= LINE_ALLOWANCE_M) k = aps.length - 1;
  }
  const heightM = aps[k]![2];
  const sn = def.stations[si]!;
  for (const nature of D.natures) {
    const f = pickFeed(ctx, def, st, si, nature, v);
    if (!f) continue;
    const wdef = sn.weapons[f.weapon]!, fd = wdef.feeds[f.feed]!;
    if (!D.weaponTypes.includes(ctx.catalog.weapons[wdef.weapon]?.type ?? "") || d > wdef.engageRangeM) continue;
    if (st.weapons[f.weapon]!.feeds[f.feed]!.rounds <= D.reserveFraction * fd.ready.count * fd.ready.charge) continue;
    if (stationHeld(ctx, state, vid, v, def, si, f.weapon, f.feed, op, cnd.x, cnd.y, heightM) !== null) continue;
    return { target: cnd.target, x: cnd.x, y: cnd.y, heightM, nature, keys: ["why.target.vehicle", "why.nature.degrade"] };
  }
  return null;
}

/** The nature to fire at a chosen target and why (`chooseTarget`), or why not at all. */
function natureFor(
  ctx: SimContext, state: SimState, vid: EntityId, t: { x: number; y: number }, v: VehicleState, def: VehicleDef, si: number, st: StationState,
  cands: ReadonlyMap<EntityId, { x: number; y: number }>,
  best: { target: EntityId; x: number; y: number; z?: number; posture?: Posture; kind: Contact["kind"]; vehicle: boolean; firing: boolean },
  bestAp: number, reach: number, mReach: number, msl: ReturnType<typeof missileReady>,
): { heightM: number; nature: Nature; keys: string[] } | "why.hold.dangerClose" | "why.hold.noPierce" {
  const G = ctx.catalog.behaviour.gunnery;
  const sn = def.stations[si]!;
  const keys: string[] = [best.vehicle ? "why.target.vehicle" : best.firing ? "why.target.firing" : "why.target.nearest"];
  const d = hypot2(best.x - t.x, best.y - t.y);
  let nature: Nature;
  let heightM: number;
  if (best.vehicle) {
    heightM = aimPointsOf(ctx, state, best.target)[bestAp]![2];
    const zone = bestAp === 0 ? "hull" : "turret";
    // The missile at an enemy vehicle beyond missileBeyondM (or beyond the guns), or nearer when armour-piercing
    // cannot get through the face it shows (owner 2026-11-13).
    // M7.6a: the weapon's own missile range if it has one; nearer, only when the missile gets through where the
    // armour-piercing round does not (the face's plate and the tiles it expects there).
    const far = d > reach || (msl !== null && d >= (sn.weapons[msl.weapon]!.missileBeyondM ?? G.missileBeyondM ?? 1000));
    if (msl && d >= msl.g.minRangeM && d <= mReach && (far || (!apCanPierce(ctx, state, def, si, t.x, t.y, best.target, zone) && missileCanPierce(ctx, state, def, si, msl.weapon, t.x, t.y, best.target, zone))) && missileSeesTarget(ctx, state, vid, v, def, si, msl.weapon, best.target)) { nature = "atgm"; keys.push(far ? "why.nature.missileFar" : "why.nature.missileArmour"); }
    // Balance pass 5 (F1): no armour-piercing at a face it cannot get through (a stopped round does nothing and the
    // shots show the hull): another target, else hold.
    else if (!apCouldPierce(ctx, state, def, si, t.x, t.y, best.target, zone)) return "why.hold.noPierce";
    else { nature = "ap"; keys.push("why.nature.vehicle"); }
  }
  else {
    let group = 0;
    for (const [tg, c] of cands) if (tg !== best.target && !state.vehicle.has(tg) && hypot2(c.x - best.x, c.y - best.y) <= G.groupRadiusM) group++;
    if (group > 0) { nature = "he"; keys.push("why.nature.group"); }
    else if (d > G.coaxSingleWithinM) { nature = "he"; keys.push("why.nature.far"); }
    else { nature = "mg"; keys.push("why.nature.single"); }
    // (The machine gun at the middle of what the crew sees of him, package A.)
    heightM = nature === "he" ? 0 : aimHeightAt(ctx, best);
    // Never high explosive close to own men on foot: the machine gun, if he is in its reach, else nothing.
    // (Balance pass 4: at least the high-explosive round's danger radius and spread there, `stationDangerM`.)
    const he = nature === "he" ? pickFeed(ctx, def, st, si, "he", v) : null;
    if (nature === "he" && ownMenWithin(state, v.side, best.x, best.y, Math.max(G.friendlyClearM, he ? stationDangerM(ctx, def, si, he.weapon, he.feed, d) : 0))) {
      if (d <= (sn.weapons.find((w) => w.coax)?.engageRangeM ?? 0)) { nature = "mg"; heightM = aimHeightAt(ctx, best); keys.push("why.hold.friends"); }
      else return "why.hold.dangerClose";
    }
  }
  return { heightM, nature, keys };
}

/**
 * Balance pass 4 review (H1, H2): is a burst of this weapon and feed at (x, y), `heightM` above the ground, held for
 * own men? "why.hold.dangerClose": one within the round's danger radius and spread of the point (a bursting round,
 * `stationDangerM`); "why.hold.friends": one in the line (the safety cone, out to `gunnery.friendBeyondM` or the
 * danger radius past the point), unless the line passes well over his head (`friendInLine`'s `over`). The one gate
 * for choosing a target, the substitute round and each burst.
 */
export function stationHeld(
  ctx: SimContext, state: SimState, vid: EntityId, v: VehicleState, def: VehicleDef, si: number, wi: number, fi: number,
  op: EntityId, x: number, y: number, heightM: number, air = false,
): "why.hold.friends" | "why.hold.dangerClose" | null {
  const t = state.transform.req(vid);
  const dz = stationDangerM(ctx, def, si, wi, fi, hypot2(x - t.x, y - t.y));
  if (dz > 0 && ownMenWithin(state, v.side, x, y, dz)) return "why.hold.dangerClose";
  // Balance pass 5 review (MH5): an air burst with a forward cone (KETF) throws its pellets on past the point: own
  // men within the cone from the burst (`standoffM` short of the point) out to the pellets' injuring reach hold it.
  if (air) {
    const ab = airburstOf(ctx, def, si, wi, fi);
    if (ab?.cone && ownMenInCone(ctx, state, v.side, t.x, t.y, x, y, ab, def, si, wi, fi)) return "why.hold.dangerClose";
  }
  const mw = muzzleWorld(ctx, def, si, wi, t.x, t.y, t.heading, v.stations[si]!.azimuth), mz = mw[2];
  const tz = heightAt(ctx.map, x, y) + heightM; // ground: ok (the point fired at)
  // Balance pass 5 (urban assault lab): a bursting round that strikes a wall, a roof or the ground short of the point
  // bursts there: own men within its danger radius of that place hold it too (a Puma's HE at a target 500 m off burst
  // on a house 49 m in front of its muzzle, next to a man of its platoon). The line is traced only when an own man
  // is that near the line at all.
  if (dz > 0 && ownMenNearLine(state, v.side, mw[0], mw[1], x, y, dz)) {
    const s = sight(ctx, mw[0], mw[1], mz, x, y, tz);
    if (s.blockedBy === "wall" || s.blockedBy === "roof" || s.blockedBy === "ground") {
      const bx = mw[0] + (x - mw[0]) * s.blockedAt, by = mw[1] + (y - mw[1]) * s.blockedAt;
      if (ownMenWithin(state, v.side, bx, by, dz)) return "why.hold.dangerClose";
    }
  }
  if (friendInLine(ctx, state, op, x, y, Math.max(ctx.catalog.behaviour.gunnery.friendBeyondM ?? 0, dz), undefined, { mz, tz })) return "why.hold.friends";
  return null;
}

/** A pellet's injuring energy (J): the cone's reach is where its pellets fall below it (game value, low; the
 *  blast model's injury threshold for a fragment is of this order). */
const PELLET_INJURY_J = 80;
/** Across margin (m) round a pellet cone for own men (a body and the cone's own scatter). */
const CONE_MARGIN_M = 3;
const CONE_REACH = new WeakMap<Catalog, Map<string, number>>();

/**
 * Balance pass 5 review (MH5): how far past its burst point a cone round's pellets keep `PELLET_INJURY_J` (m): a
 * pellet at the round's muzzle velocity (the upper bound) slows as v(s) = v0 e^(-ks), k = rho Cd A / 2m, so its
 * energy falls as e^(-2ks). Cached per catalog and round.
 */
export function coneReachM(ctx: SimContext, roundId: string, v0: number): number {
  let m = CONE_REACH.get(ctx.catalog);
  if (!m) { m = new Map(); CONE_REACH.set(ctx.catalog, m); }
  const key = roundId + "@" + v0;
  const hit = m.get(key);
  if (hit !== undefined) return hit;
  const cone = ctx.catalog.ammo[roundId]?.airburst?.cone, pel = cone ? ctx.catalog.ammo[cone.fragmentAmmo] : undefined;
  let reach = 0;
  if (cone && pel) {
    const vp = v0 * Math.max(cone.velocityFraction[0], cone.velocityFraction[1]);
    const cd = Math.min(pel.drag.max, pel.drag.a + pel.drag.b / Math.max(vp, 1));
    const k = (ctx.catalog.ballistics.airDensityKgM3 * cd * PI * pel.diameterM * pel.diameterM / 4) / (2 * pel.projectileMassKg);
    const e0 = 0.5 * pel.projectileMassKg * vp * vp;
    reach = e0 <= PELLET_INJURY_J || k <= 0 ? 0 : log(e0 / PELLET_INJURY_J) / (2 * k);
  }
  m.set(key, reach);
  return reach;
}

/** Is an own man (on foot, alive, not a prisoner) inside the pellet cone of an air burst fired from (mx, my) at
 *  (x, y): from the burst point (`standoffM` short) along the line, within the cone's half angle (+ a margin), out
 *  to the pellets' reach (`coneReachM`)? */
function ownMenInCone(ctx: SimContext, state: SimState, side: string, mx: number, my: number, x: number, y: number,
  ab: NonNullable<AmmoDef["airburst"]>, def: VehicleDef, si: number, wi: number, fi: number): boolean {
  const wdef = def.stations[si]?.weapons[wi];
  const round = ctx.catalog.items[wdef?.feeds[fi]?.item ?? ""]?.chargeItem;
  const v0 = round !== undefined && wdef ? ctx.catalog.weapons[wdef.weapon]?.ammo[round] : undefined;
  if (round === undefined || v0 === undefined || !ab.cone) return false;
  const L = hypot2(x - mx, y - my);
  if (L < 1e-6) return false;
  const ux = (x - mx) / L, uy = (y - my) / L;
  const bx = x - ux * ab.standoffM, by = y - uy * ab.standoffM;
  const reach = coneReachM(ctx, round, v0), half = (ab.cone.halfAngleDeg * PI) / 180, tn = sin(half) / cos(half);
  for (const [id, ident] of state.identity.entries()) {
    if (ident.side !== side) continue;
    const s = state.soldier.get(id);
    if (s === undefined || !s.physiology.alive || s.captive !== null || (isMounted(s) && !onRoof(state, id))) continue;
    const p = state.transform.get(id);
    if (!p) continue;
    const along = (p.x - bx) * ux + (p.y - by) * uy;
    if (along < -CONE_MARGIN_M || along > reach) continue;
    const across = Math.abs(-(p.x - bx) * uy + (p.y - by) * ux);
    if (across <= CONE_MARGIN_M + Math.max(0, along) * tn) return true;
  }
  return false;
}

/** Is an able own man on foot (or on a roof) within `r` of the segment (ax, ay)-(bx, by)? */
function ownMenNearLine(state: SimState, side: string, ax: number, ay: number, bx: number, by: number, r: number): boolean {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, r2 = r * r;
  for (const [id, ident] of state.identity.entries()) {
    if (ident.side !== side) continue;
    const s = state.soldier.get(id);
    if (s === undefined || !s.physiology.alive || s.captive !== null || (isMounted(s) && !onRoof(state, id))) continue;
    const t = state.transform.get(id);
    if (!t) continue;
    const k = L2 > 0 ? Math.min(1, Math.max(0, ((t.x - ax) * dx + (t.y - ay) * dy) / L2)) : 0;
    const qx = ax + dx * k - t.x, qy = ay + dy * k - t.y;
    if (qx * qx + qy * qy <= r2) return true;
  }
  return false;
}

/** Balance pass 5: the air-burst setting of the round on a station weapon's feed, if it has one. */
export function airburstOf(ctx: SimContext, def: VehicleDef, si: number, wi: number, fi: number): AmmoDef["airburst"] {
  const round = ctx.catalog.items[def.stations[si]?.weapons[wi]?.feeds[fi]?.item ?? ""]?.chargeItem;
  return round === undefined ? undefined : ctx.catalog.ammo[round]?.airburst;
}

/** Balance pass 5: an ordered point this near a known enemy hull is fired at with the impact setting (m). */
const HULL_NEAR_M = 15;

/** Balance pass 5: an air burst is set only for a point at least this far beyond the burst's stand-off (m). */
const AIRBURST_CLEAR_M = 30;

/** Balance pass 5: may this air-burst setting be used at `d` m (the burst well clear of the muzzle)? */
export function airburstAt(ab: AmmoDef["airburst"], d: number): boolean {
  return ab !== undefined && d >= ab.standoffM + AIRBURST_CLEAR_M;
}

/** Balance pass 5 (area fire): a place enemy men were last known, as a crew knows it: a circle and its weight. */
export interface Suspect { x: number; y: number; r: number; w: number; men: number }

/**
 * The places the men of this crew last knew enemy men (gunnery.areaFire): each enemy man's freshest contact (seen or
 * reported, not known down or given up, at most `maxAgeSeconds` old, its error within `maxRadiusM`), merged within
 * gunnery.groupRadiusM; weight 0.5^(age / halfLife) per man, x `firingWeight` if he was firing at or after the
 * moment last seen; the circle the men's spread plus their error. Heaviest first. Pure.
 */
export function crewSuspects(ctx: SimContext, state: SimState, crew: Unit): Suspect[] {
  const G = ctx.catalog.behaviour.gunnery, A = G.areaFire;
  if (A === undefined) return [];
  const tick = state.tick, maxAge = secondsToTicks(A.maxAgeSeconds);
  const best = new Map<EntityId, Contact>();
  for (const m of crew.members) {
    const s = state.soldier.get(m);
    if (!isAble(s)) continue;
    for (const c of s!.contacts) {
      if (c.cls === "vehicle" || c.kind === "heard" || c.down === true || c.surrendered === true || tick - c.tick > maxAge) continue;
      const p = best.get(c.target);
      if (!p || c.tick > p.tick || (c.tick === p.tick && c.errM < p.errM)) best.set(c.target, c);
    }
  }
  if (best.size === 0) return [];
  const groups: { sx: number; sy: number; n: number; w: number; pts: { x: number; y: number; e: number }[] }[] = [];
  for (const [target, c] of [...best.entries()].sort((a, b) => a[0] - b[0])) {
    if (!state.soldier.has(target)) continue; // (gone from the field altogether)
    const e = contactErrorM(ctx, c, tick);
    if (e > A.maxRadiusM) continue;
    const ew = state.weapon.get(target);
    // (Review fix: only fire the crew could know of: his last shot within 3 s of when he was last seen or reported,
    // not shots fired later, unseen.)
    const firing = ew !== undefined && Math.abs(ew.lastShotTick - c.tick) <= 3 * TICK_HZ;
    const w = pow(0.5, (tick - c.tick) / TICK_HZ / A.halfLifeSeconds) * (firing ? A.firingWeight : 1);
    let g = groups.find((q) => hypot2(q.sx / q.n - c.x, q.sy / q.n - c.y) <= G.groupRadiusM);
    if (!g) { g = { sx: 0, sy: 0, n: 0, w: 0, pts: [] }; groups.push(g); }
    g.sx += c.x; g.sy += c.y; g.n++; g.w += w; g.pts.push({ x: c.x, y: c.y, e });
  }
  const out: Suspect[] = [];
  for (const g of groups) {
    if (g.w < A.minWeight) continue;
    const x = g.sx / g.n, y = g.sy / g.n;
    let r = A.minRadiusM;
    for (const p of g.pts) r = Math.max(r, hypot2(p.x - x, p.y - y) + p.e);
    out.push({ x, y, r: Math.min(r, A.maxRadiusM), w: g.w, men: g.n });
  }
  return out.sort((a, b) => b.w - a.w || a.x - b.x || a.y - b.y);
}

/**
 * The weapon and feed a station fires at a suspected place `d` m away of weight `w` (gunnery.areaFire): high
 * explosive (air burst where the round has it), else the coaxial machine gun within its reach; a ready feed only
 * while it holds more than the reserve; a main gun (single rounds) only at `mainGunMinWeight`. With the interval.
 */
function areaFeed(ctx: SimContext, def: VehicleDef, st: StationState, si: number, v: VehicleState, d: number, w: number, ammoRule: string):
  { weapon: number; feed: number; nature: "he" | "mg"; every: number; air: boolean } | null {
  const A = ctx.catalog.behaviour.gunnery.areaFire!;
  const reserve = ammoRule === "max" ? 0 : A.reserveFraction;
  const sn = def.stations[si]!;
  for (const n of ["he", "mg"] as const) {
    const f = pickFeed(ctx, def, st, si, n, v);
    if (!f) continue;
    const wdef = sn.weapons[f.weapon]!, fd = wdef.feeds[f.feed]!;
    if (d > wdef.engageRangeM) continue;
    if (st.weapons[f.weapon]!.feeds[f.feed]!.rounds <= reserve * fd.ready.count * fd.ready.charge) continue;
    const single = wdef.feedKind !== "belt";
    if (single && w < A.mainGunMinWeight) continue;
    const every = single ? A.mainGunEverySeconds : Math.max(A.minEverySeconds, A.everySeconds / Math.max(w, 1e-3));
    return { ...f, nature: n, every, air: n === "he" && airburstAt(airburstOf(ctx, def, si, f.weapon, f.feed), d) };
  }
  return null;
}

/**
 * Balance pass 5 (area fire; owner 2026-11-20: 'Make vehicles fire more near areas where they believe enemy infantry
 * is, even if they don't see them anymore'): a station with no live target fires at the heaviest suspected place it
 * can (`crewSuspects`): under fire 'free' only (not 'return' or 'hold', not with ammunition 'conserve', not while
 * an ambush is laid), within its range rule, not at a place a crewman knows protected men at, never within the
 * round's danger radius and spread (plus the place's circle) of own men or with own men in the line, and only with a
 * line from the muzzle into the place (cover within its circle is what it fires into). Own men are kept the round's
 * danger radius and spread, at least gunnery.friendlyClearM, clear of the circle. True: the station has its
 * task (kept when it is the same place).
 */
function areaFireTask(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, v: VehicleState, def: VehicleDef, crew: Unit, si: number): boolean {
  const G = ctx.catalog.behaviour.gunnery, tick = state.tick;
  const rules = state.unit.get(fireTop(state, v.unit!));
  if (!rules || rules.fireRule !== "free" || rules.ammoRule === "conserve" || crew.ambush !== undefined) return false;
  const op = stationOperator(state, v, def, si);
  if (op === null) return false;
  const sus = crewSuspects(ctx, state, crew);
  if (sus.length === 0) return false;
  const st = v.stations[si]!, me = state.transform.req(vid);
  const maxM = crew.maxEngageM > 0 ? crew.maxEngageM : Infinity;
  for (const s of sus.slice(0, 4)) {
    const d = hypot2(s.x - me.x, s.y - me.y);
    if (d > maxM) continue;
    const f = areaFeed(ctx, def, st, si, v, d, s.w, rules.ammoRule);
    if (!f) continue;
    if (ctx.catalog.medical !== undefined && refusesFireAt(state, crew.members, s.x, s.y, undefined, ctx.catalog.medical.protection.aimSpareM + s.r)) continue;
    const dz = stationDangerM(ctx, def, si, f.weapon, f.feed, d);
    // (Unobserved fire spread over a circle: own men are kept `friendlyClearM` clear of it whatever the round.)
    if (ownMenWithin(state, v.side, s.x, s.y, Math.max(dz, G.friendlyClearM) + s.r)) continue;
    const h = f.air ? airburstOf(ctx, def, si, f.weapon, f.feed)!.aimHeightM : f.nature === "he" ? 0 : 0.6;
    if (stationHeld(ctx, state, vid, v, def, si, f.weapon, f.feed, op, s.x, s.y, h, f.air) !== null) continue;
    const [mx, my, mz] = muzzleWorld(ctx, def, si, f.weapon, me.x, me.y, me.heading, st.azimuth);
    const r = sight(ctx, mx, my, mz, s.x, s.y, heightAt(ctx.map, s.x, s.y) + 0.6, vid, -1); // ground: ok (the place fired at)
    if (!(r.blockedBy === null || (1 - r.blockedAt) * hypot2(s.x - mx, s.y - my) <= Math.max(LINE_ALLOWANCE_M, s.r))) continue;
    const prev = st.task;
    const area = { r: s.r, w: s.w, every: f.every, ox: 0, oy: 0 };
    if (prev !== null && prev.area !== undefined && hypot2(prev.x - s.x, prev.y - s.y) <= G.groupRadiusM && st.taskWeapon === f.weapon && st.taskFeed === f.feed) {
      prev.x = s.x; prev.y = s.y; prev.reasonTick = tick; area.ox = prev.area.ox; area.oy = prev.area.oy; prev.area = area;
    } else {
      setStationTask(ctx, state, vid, si, s.x, s.y, h, f.weapon, f.feed, undefined, true);
      st.task!.area = area;
      if (f.air) st.task!.fuse = "airburst";
    }
    emitDecision(events, state, vid, si, st, f.nature, ["why.target.suspected", f.air ? "why.nature.airburst" : f.nature === "he" ? "why.nature.he" : "why.nature.mg"]);
    return true;
  }
  return false;
}

function emitDecision(events: EventSink, state: SimState, vid: EntityId, si: number, st: StationState, nature: Nature | null, keys: string[]): void {
  const same = st.why.keys.length === keys.length && st.why.keys.every((k, i) => k === keys[i]);
  const target = st.task?.contact ?? null;
  st.why = { tick: state.tick, keys };
  if (same && st.task !== null) return;
  events.emit({ kind: "vehicle.decision", tick: state.tick, vehicle: vid, station: si, target, x: st.task?.x ?? 0, y: st.task?.y ?? 0, nature, keys });
}

/** Once a second per vehicle: targets of every station, refilling ready belts. */
export function stationDecisionSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  if (state.vehicle.size === 0) return;
  const G = ctx.catalog.behaviour.gunnery, tick = state.tick;
  const every = Math.max(1, secondsToTicks(G.stepSeconds));
  for (const [vid, v] of state.vehicle.entries()) {
    if ((vid + tick) % every !== 0 || v.stations.length === 0 || isOffMap(v)) continue;
    const def = ctx.catalog.vehicles[v.def];
    const crew = v.unit !== null ? state.unit.get(v.unit) : undefined;
    if (!def) continue;
    if (!crew || !canFight(v)) { for (const st of v.stations) st.task = null; continue; }
    const allowed = gunneryAllowed(ctx, state, v.unit!);
    for (let si = 0; si < v.stations.length; si++) {
      const st = v.stations[si]!;
      // The gunner is guiding a missile: nothing else until it ends (owner 2026-11-13); a fire-and-forget one needs
      // no gunner after the launch (M9.3a).
      if (st.guide && !fireAndForget(st.guide.kind)) continue;
      refillCheck(ctx, state, events, vid, v, def, si);
      if (stationOperator(state, v, def, si) === null) continue;
      // Its target is down or a wreck (M7.4a): the task ends, ordered or not.
      if (st.task?.contact !== undefined && !targetLive(state, st.task.contact)) { st.task = null; emitDecision(events, state, vid, si, st, null, ["why.hold.targetDown"]); }
      if (st.task && !st.task.self) {
        // An ordered task: follow the named enemy as the crew knows him; the order's nature stays.
        if (st.task.contact !== undefined) {
          const c = crewContact(ctx, state, crew, st.task.contact);
          if (c) { st.task.x = c.x; st.task.y = c.y; }
        }
        continue;
      }
      if (!allowed) {
        if (st.task) { st.task = null; emitDecision(events, state, vid, si, st, null, ["why.hold.rule"]); }
        continue;
      }
      const pick = chooseTarget(ctx, state, vid, v, def, crew, si);
      // Balance pass 5 (area fire): nothing live to fire at: the places its men last knew enemy men.
      if (pick === null && G.areaFire !== undefined && areaFireTask(ctx, state, events, vid, v, def, crew, si)) continue;
      if (pick === null || typeof pick === "string") {
        // (Balance pass 4 review: targets there, but fire at each held for own men: say so.)
        if (st.task || (pick !== null && st.why.keys[0] !== pick)) { st.task = null; emitDecision(events, state, vid, si, st, null, [pick ?? "why.hold.noTarget"]); }
        continue;
      }
      const f = feedFor(ctx, def, st, si, pick.nature, v);
      if (!f) {
        if (st.task) { st.task = null; emitDecision(events, state, vid, si, st, null, ["why.hold.ammunition"]); }
        continue;
      }
      // (The feed fired, a substitute included, was checked for own men in chooseTarget: `stationHeld`.)
      // (Balance pass 5: high explosive at a man with a round that has an air-burst setting: air burst, unless he is
      // in a building, where the impact setting strikes the wall or the window.)
      const me = state.transform.req(vid);
      const air = f.nature === "he" && !state.vehicle.has(pick.target) && airburstAt(airburstOf(ctx, def, si, f.weapon, f.feed), hypot2(pick.x - me.x, pick.y - me.y)) && indoorAt(ctx, pick.x, pick.y) < 0;
      const hM = air ? airburstOf(ctx, def, si, f.weapon, f.feed)!.aimHeightM : pick.heightM;
      const changed = !st.task || st.task.contact !== pick.target || st.taskWeapon !== f.weapon || st.taskFeed !== f.feed || st.task.area !== undefined || (st.task.fuse === "airburst") !== air;
      if (changed) { setStationTask(ctx, state, vid, si, pick.x, pick.y, hM, f.weapon, f.feed, pick.target, true); if (air) { st.task!.fuse = "airburst"; pick.keys.push("why.nature.airburst"); } }
      else { st.task!.x = pick.x; st.task!.y = pick.y; st.task!.reasonTick = tick; if (state.vehicle.has(pick.target)) st.task!.heightM = pick.heightM; if (air) pick.keys.push("why.nature.airburst"); }
      if (f.nature !== pick.nature) pick.keys.push("why.nature.substitute");
      // Balance pass 5 (F1): its own missile chosen on the move: the hull halts for the launch (its route kept).
      if (f.nature === "atgm" && G.missileHoldSeconds !== undefined && v.playerHold !== true && Math.abs(v.drive.speed) > (G.missileHaltedMps ?? 0.3)) {
        v.drive.fireHoldUntilTick = Math.max(v.drive.fireHoldUntilTick ?? 0, tick + secondsToTicks(G.missileHoldSeconds));
      }
      emitDecision(events, state, vid, si, st, f.nature, pick.keys);
    }
  }
}

/** The turret pivot (world) and the world azimuth of station `si`. */
function pivotOf(def: VehicleDef, x: number, y: number, heading: number): { px: number; py: number } {
  const pf = def.body.turret?.pivotF ?? 0;
  return { px: x + cos(heading) * pf, py: y + sin(heading) * pf };
}

/** Lay every turret toward its task (or back to the front), at its rates and within its limits. */
export function turretSystem(ctx: SimContext, state: SimState): void {
  if (state.vehicle.size === 0) return;
  const G = ctx.catalog.behaviour.gunnery, tick = state.tick, dt = 1 / TICK_HZ;
  for (const [vid, v] of state.vehicle.entries()) {
    if (v.stations.length === 0 || isOffMap(v)) continue;
    const def = ctx.catalog.vehicles[v.def], t = state.transform.get(vid);
    if (!def || !t) continue;
    // Damaged turret drive (M7.4b): below half, hand traverse at a quarter of the rate; a wrecked stabiliser.
    const driveK = compCondition(v, def, "turret-drive") < 0.5 ? 0.25 : 1;
    const stabOut = compCondition(v, def, "stabiliser") <= 0;
    for (let si = 0; si < v.stations.length; si++) {
      const st = v.stations[si]!, sn = def.stations[si]!;
      // A stabilised turret holds its bearing while the hull turns under it.
      if (sn.stabiliser !== "none" && !stabOut) st.azimuth = wrapAngle(st.azimuth - v.drive.yawRate * dt);
      const task = st.task;
      // Nothing to lay and already at rest: nothing to do.
      if (!task && st.laidTick < 0 && st.azimuth === st.azCmd && st.elevation === st.elCmd && st.azCmd === st.scanAz && st.elCmd === 0) continue;
      const { px, py } = pivotOf(def, t.x, t.y, t.heading);
      if (task) {
        const wdef = sn.weapons[st.taskWeapon];
        const w = st.weapons[st.taskWeapon];
        let tx = task.x, ty = task.y;
        const range0 = hypot2(tx - px, ty - py);
        let elDrop = 0;
        if (wdef && w) {
          const feed = w.feeds[st.taskFeed];
          const wd = ctx.catalog.weapons[wdef.weapon];
          const round = feed ? ctx.catalog.items[feed.item]?.chargeItem : undefined;
          const v0 = round !== undefined ? wd?.ammo[round] : undefined;
          // (A guided missile flies along the sight line: no drop, no lead.)
          if (round !== undefined && v0 !== undefined && range0 > 1 && ctx.catalog.ammo[round]?.guided === undefined) {
            const tr = tableRange(wdef.engageRangeM);
            // Lead on a moving vehicle the crew knows the movement of.
            const crew = v.unit !== null ? state.unit.get(v.unit) : undefined;
            if (task.contact !== undefined && crew) {
              const c = crewContact(ctx, state, crew, task.contact);
              if (c && (c.vx !== 0 || c.vy !== 0)) { const tof = flightTimeAt(ctx, round, v0, Math.min(range0, tr), tr); tx += c.vx * tof; ty += c.vy * tof; }
            }
            elDrop = atan2(dropAt(ctx, round, v0, Math.min(range0, tr), tr), Math.max(1, range0));
          }
        }
        const range = Math.max(1, hypot2(tx - px, ty - py));
        // ground: ok (a vehicle's gun; the point fired at)
        const mz = heightAt(ctx.map, t.x, t.y) + (def.body.turret?.trunnionU ?? 2);
        const tz = heightAt(ctx.map, task.x, task.y) + task.heightM; // ground: ok (the point fired at) // ground: ok
        let az = wrapAngle(atan2(ty - py, tx - px) - t.heading);
        if (sn.traverseArcRad) az = Math.min(Math.max(az, sn.traverseArcRad[0]), sn.traverseArcRad[1]);
        st.azCmd = az;
        st.elCmd = Math.min(Math.max(atan2(tz - mz, range) + elDrop, sn.elevationRad[0]), sn.elevationRad[1]);
      } else {
        // Back to the front a while after its last shot (not while a smoke salvo it is laid for is on its way:
        // the dischargers fire along the turret, M7 review).
        const last = st.weapons.reduce((m, w) => Math.max(m, w.lastShotTick), -1e9);
        if (v.pendingSmokeTick < 0 && tick - last >= secondsToTicks(G.scanReturnSeconds)) { st.azCmd = st.scanAz; st.elCmd = 0; }
      }
      const da = wrapAngle(st.azCmd - st.azimuth), de = st.elCmd - st.elevation;
      const stepA = sn.traverseRadS * driveK * dt, stepE = sn.elevateRadS * driveK * dt;
      st.azimuth = wrapAngle(st.azimuth + (da > stepA ? stepA : da < -stepA ? -stepA : da));
      st.elevation += de > stepE ? stepE : de < -stepE ? -stepE : de;
      const tol = sn.layToleranceMrad / 1000;
      const laid = task !== null && Math.abs(wrapAngle(st.azCmd - st.azimuth)) <= tol && Math.abs(st.elCmd - st.elevation) <= tol;
      if (laid) { if (st.laidTick < 0) st.laidTick = tick; } else st.laidTick = -1;
    }
  }
}

/** World position of a station weapon's muzzle (turret frame [f, r, u] about the pivot). */
export function muzzleWorld(ctx: SimContext, def: VehicleDef, si: number, wi: number, x: number, y: number, heading: number, azimuth: number): [number, number, number] {
  const m = def.stations[si]!.weapons[wi]!.muzzle;
  const { px, py } = pivotOf(def, x, y, heading);
  const a = heading + azimuth, c = cos(a), s = sin(a);
  return [px + c * m[0] - s * m[1], py + s * m[0] + c * m[1], heightAt(ctx.map, x, y) + m[2]]; // ground: ok (a vehicle's muzzle)
}

/** A wall or the ground this close to the point fired at is the target, not a block. */
const LINE_ALLOWANCE_M = 5;

const HULL_ONLY: readonly (readonly [number, number, number])[] = [[0, 0, 1.2]];

/** An enemy vehicle's aim points (hull first, then higher ones: the turret), as its type's signature gives them. */
function aimPointsOf(ctx: SimContext, state: SimState, target: EntityId): readonly (readonly [number, number, number])[] {
  const tv = state.vehicle.get(target);
  const aps = tv ? ctx.catalog.vehicles[tv.def]?.signature?.aimPoints : undefined;
  return aps && aps.length > 0 ? aps : HULL_ONLY;
}

/**
 * M7.6b: the lowest of an enemy vehicle's aim points (index into its signature's `aimPoints`: 0 the hull, higher the
 * turret) that a line from (sx, sy, sz) clears, or is blocked only within `LINE_ALLOWANCE_M` of it; -1: none. `own`
 * (the shooter's hull) and the target are ignored by the line. With (px, py), the points stand at that place (where
 * the shooter knows the vehicle to be) at their heights; without, at their true places on the hull. The order is
 * spotting's: a hull-down vehicle shows only its turret, and is aimed at there.
 */
export function visibleAimIndex(ctx: SimContext, state: SimState, target: EntityId, sx: number, sy: number, sz: number, own: EntityId, px?: number, py?: number): number {
  const tt = state.transform.get(target);
  if (!tt) return -1;
  const aps = aimPointsOf(ctx, state, target);
  const c = cos(tt.heading), s = sin(tt.heading);
  const gz = heightAt(ctx.map, px ?? tt.x, py ?? tt.y); // ground: ok (a hull's aim points)
  for (let k = 0; k < aps.length; k++) {
    const ap = aps[k]!;
    const ax = px ?? tt.x + c * ap[0] - s * ap[1], ay = py ?? tt.y + s * ap[0] + c * ap[1];
    const r = sight(ctx, sx, sy, sz, ax, ay, gz + ap[2], own, target);
    if (r.blockedBy === null || (1 - r.blockedAt) * hypot2(ax - sx, ay - sy) <= LINE_ALLOWANCE_M) return k;
  }
  return -1;
}

/**
 * Could this crew fire at a man at (x, y), `tz` m above sea level, from where it stands (owner 2026-11-13: a crew
 * reverses out of point-blank infantry only when it cannot)? A station with a man to work it and a gun or machine
 * gun (not a missile) that is not wrecked, has rounds ready and reaches him; the bearing within its arc, the
 * elevation within its limits, and a clear line from the muzzle. The fire rule does not matter here.
 */
export function canEngageAt(ctx: SimContext, state: SimState, vid: EntityId, v: VehicleState, def: VehicleDef, x: number, y: number, tz: number): boolean {
  const t = state.transform.req(vid);
  const { px, py } = pivotOf(def, t.x, t.y, t.heading);
  const range = Math.max(1, hypot2(x - px, y - py));
  const az = wrapAngle(atan2(y - py, x - px) - t.heading);
  // ground: ok (a vehicle's gun)
  const el = atan2(tz - (heightAt(ctx.map, t.x, t.y) + (def.body.turret?.trunnionU ?? 2)), range);
  for (let si = 0; si < v.stations.length; si++) {
    const sn = def.stations[si]!, st = v.stations[si]!;
    if (sn.traverseArcRad && (az < sn.traverseArcRad[0] || az > sn.traverseArcRad[1])) continue;
    if (el < sn.elevationRad[0] || el > sn.elevationRad[1]) continue;
    if (stationOperator(state, v, def, si) === null) continue;
    for (let wi = 0; wi < sn.weapons.length; wi++) {
      const wdef = sn.weapons[wi]!;
      if (range > wdef.engageRangeM || guidedRound(ctx.catalog, wdef) !== null || weaponOut(ctx, v, def, si, wi)) continue;
      if (!(st.weapons[wi]?.feeds.some((f) => f.rounds > 0) ?? false)) continue;
      const [mx, my, mz] = muzzleWorld(ctx, def, si, wi, t.x, t.y, t.heading, az);
      const r = sight(ctx, mx, my, mz, x, y, tz, vid, -1);
      if (r.blockedBy === null || (1 - r.blockedAt) * hypot2(x - mx, y - my) <= LINE_ALLOWANCE_M) return true;
    }
  }
  return false;
}

/** Fire the stations, and fire smoke salvos that are due. */
export function stationFireSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  if (state.vehicle.size === 0) return;
  const tick = state.tick, F = ctx.catalog.shooting.fire, A = ctx.catalog.shooting.aim;
  const fullTicks = secondsToTicks(F.fullRateSeconds), endTicks = fullTicks + secondsToTicks(F.trickleSeconds);
  for (const [vid, v] of state.vehicle.entries()) {
    if (isOffMap(v)) continue;
    const def = ctx.catalog.vehicles[v.def], t = state.transform.get(vid);
    if (!def || !t) continue;
    if (v.pendingSmokeTick >= 0 && tick >= v.pendingSmokeTick) smokeScreen(ctx, state, events, vid, v, def);
    if (!canFight(v) || v.stations.length === 0) continue;
    const crew = v.unit !== null ? state.unit.get(v.unit) : undefined;
    for (let si = 0; si < v.stations.length; si++) {
      const st = v.stations[si]!, task = st.task, sn = def.stations[si]!;
      // (M9.3a: while a fire-and-forget missile flies the station's guns fire on; no second missile until it ends.)
      if (!task || (st.guide && !fireAndForget(st.guide.kind))) continue;
      const op = stationOperator(state, v, def, si);
      if (op === null) continue;
      const os = state.soldier.req(op);
      if (tick < os.stunnedUntilTick || state.action.get(op)?.kind === "reloadStation") continue;
      // An ordered task runs at the full rate while there is reason, then slows, then ends (as for men on foot).
      const since = tick - task.reasonTick;
      if (!task.self && since > endTicks) {
        st.task = null;
        if (crew && v.unit !== null) { crew.firing = false; events.emit({ kind: "fire.ceased", tick, unit: v.unit, reason: "no-target" }); radioFromTarget(state, v.unit, "radio.noTarget", events); }
        continue;
      }
      const wdef = sn.weapons[st.taskWeapon], w = st.weapons[st.taskWeapon];
      if (!wdef || !w) continue;
      const wd = ctx.catalog.weapons[wdef.weapon];
      if (!wd) continue;
      // The weapon wrecked (M7.4b): the task ends; the next decision picks another weapon if one works.
      if (weaponOut(ctx, v, def, si, st.taskWeapon)) { st.task = null; continue; }
      // A guided missile (owner 2026-11-13): fired halted, laid, with the line clear; then guided (missiles.ts).
      const gr = guidedRound(ctx.catalog, wdef);
      if (gr) { fireMissile(ctx, state, events, vid, v, def, si, op, gr, crew, t.x, t.y, t.heading); continue; }
      // Feed: switch to the task's feed first (a dual-feed cannon takes a moment).
      if (w.feed !== st.taskFeed) { w.feed = st.taskFeed; w.switchUntilTick = tick + secondsToTicks(wdef.switchSeconds); w.burstLeft = 0; w.loadedRound = false; w.burstIndex = 0; }
      if (tick < w.switchUntilTick) continue;
      const feed = w.feeds[w.feed];
      if (!feed || feed.rounds <= 0) {
        if (feed && !w.lowAmmoReported[w.feed] && v.unit !== null) { w.lowAmmoReported[w.feed] = true; radioFromTarget(state, v.unit, "radio.feedEmpty", events); }
        if (!task.self) {
          // Ordered: the same nature from another weapon or feed, else the order cannot be carried out.
          const f = feedFor(ctx, def, st, si, natureOf(ctx, def, si, st.taskWeapon, st.taskFeed), v);
          if (f) { st.taskWeapon = f.weapon; st.taskFeed = f.feed; } else { st.task = null; if (crew && v.unit !== null) { crew.firing = false; events.emit({ kind: "fire.ceased", tick, unit: v.unit, reason: "ammunition" }); } }
        }
        continue;
      }
      if (w.jammed) { w.jammed = false; w.nextShotTick = tick + secondsToTicks(F.clearStoppageSeconds); continue; }
      // Single-round feeds: a round must be loaded (by the loader if there is one).
      if (wdef.feedKind !== "belt" && !w.loadedRound) {
        if (w.burstIndex !== -1) {
          const load = loadTicks(state, v, wdef, def);
          if (load < 0) continue; // nobody can load it
          // The load runs during the interval set at the last shot (the trickle, the ammunition rule): whichever
          // ends later (review fix: the load no longer overrides them).
          w.burstIndex = -1; w.nextShotTick = Math.max(w.nextShotTick, tick + load);
        } else if (tick >= w.nextShotTick) { w.loadedRound = true; w.burstIndex = 0; }
        continue;
      }
      // Line of fire from the muzzle, once a second (the own hull and a target hull are not obstacles).
      if (w.burstLeft <= 0 && tick - task.lineCheckTick >= TICK_HZ) {
        task.lineCheckTick = tick;
        if (task.contact !== undefined && crew) { const c = crewContact(ctx, state, crew, task.contact); if (c) { task.x = c.x; task.y = c.y; } }
        const [mx, my, mz] = muzzleWorld(ctx, def, si, st.taskWeapon, t.x, t.y, t.heading, st.azimuth);
        // (Fire at the ground — high explosive at men's feet — is checked to a point a little above it: a line
        // grazing flat ground short of the point is not a wall in the way.)
        const tz = heightAt(ctx.map, task.x, task.y) + Math.max(task.heightM, 0.6); // ground: ok (the point fired at)
        const tv = task.contact !== undefined && state.vehicle.has(task.contact) ? task.contact : -1;
        const r = sight(ctx, mx, my, mz, task.x, task.y, tz, vid, tv);
        const range = hypot2(task.x - mx, task.y - my);
        task.lineClear = r.blockedBy === null || (1 - r.blockedAt) * range <= LINE_ALLOWANCE_M;
        if (!task.lineClear && crew && v.unit !== null && !crew.lineBlockedReported) { crew.lineBlockedReported = true; radioFromTarget(state, v.unit, "radio.noLineOfFire", events); }
      }
      if (!task.lineClear || st.laidTick < 0 || tick < w.nextShotTick) continue;
      if (w.burstLeft <= 0) {
        // Own men in the line (unless it passes well over their heads), past the point within the beaten zone, or (a
        // bursting round, balance pass 4: danger close) within its danger radius and spread of the point: no burst.
        // (Review fix: the crew's own task is dropped, with the reason, and the next decision picks a target it can
        // fire at; an ordered one waits, the player told once why.)
        // Balance pass 5 (area fire): each burst at a point of the suspected place, drawn evenly over its circle; the
        // point drawn is the one checked for own men (review fix: not the circle's middle).
        if (task.area) {
          const ar = task.area, rho = ar.r * sqrt(nextFloat(state.rng, Streams.areaFire)), th = 2 * PI * nextFloat(state.rng, Streams.areaFire);
          ar.ox = rho * cos(th); ar.oy = rho * sin(th);
        }
        const why = stationHeld(ctx, state, vid, v, def, si, st.taskWeapon, w.feed, op, task.x + (task.area?.ox ?? 0), task.y + (task.area?.oy ?? 0), task.heightM, task.fuse === "airburst");
        if (why !== null) {
          if (task.self) { st.task = null; emitDecision(events, state, vid, si, st, null, [why]); }
          else if (st.why.keys[0] !== why) emitDecision(events, state, vid, si, st, natureOf(ctx, def, si, st.taskWeapon, w.feed), [why]);
          w.nextShotTick = tick + TICK_HZ / 2; continue;
        }
        w.burstLeft = wdef.feedKind === "belt" && wd.sustained ? wd.sustained.burstRounds : 1;
        w.burstIndex = 0;
        if (task.area) {
          const ar = task.area;
          const nat = natureOf(ctx, def, si, st.taskWeapon, w.feed);
          events.emit({ kind: "vehicle.areaFire", tick, vehicle: vid, station: si, x: task.x + ar.ox, y: task.y + ar.oy, nature: nat === "mg" ? "mg" : "he", fuse: task.fuse === "airburst" ? "airburst" : "impact", weight: Math.round(ar.w * 100) / 100 });
        }
      }
      // ---- one round
      const { ammoId, v0 } = pickRound(ctx.catalog, wd, feed.item, feed.rounds);
      if (v0 === undefined) { st.task = null; continue; }
      const [mx, my, mz] = muzzleWorld(ctx, def, si, st.taskWeapon, t.x, t.y, t.heading, st.azimuth);
      let tx = task.x, ty = task.y;
      if (task.area) { tx += task.area.ox; ty += task.area.oy; }
      const tr = tableRange(wdef.engageRangeM);
      if (task.contact !== undefined && crew) {
        const c = crewContact(ctx, state, crew, task.contact);
        if (c && (c.vx !== 0 || c.vy !== 0)) { const tof = flightTimeAt(ctx, ammoId, v0, Math.min(hypot2(tx - mx, ty - my), tr), tr); tx += c.vx * tof; ty += c.vy * tof; }
      }
      const range = hypot2(tx - mx, ty - my);
      if (range < 2) { st.task = null; continue; }
      const tz = heightAt(ctx.map, task.area ? tx : task.x, task.area ? ty : task.y) + task.heightM; // ground: ok (the point fired at)
      const a0 = atan2(ty - my, tx - mx);
      const believed = range * (1 + task.rangeError);
      const skill = os.skills["marksmanship"] ?? 0.5;
      const speed = Math.abs(v.drive.speed);
      const recoil = wd.sustained?.recoilFactor ?? 1;
      // Components (M7.4b): a wrecked stabiliser fires as unstabilised; wrecked sights treble the error.
      const stab = compCondition(v, def, "stabiliser") <= 0 ? "none" : sn.stabiliser;
      const sightK = compCondition(v, def, "sights") <= 0 ? 3 : 1;
      const sd = (sn.baseErrorMrad + sn.movingMradPerMps * speed * (stab === "none" ? 3 : stab === "one-plane" ? 1.5 : 1))
        * skillFactor(ctx, skill) * (1 + A.burstGrowth * recoil * w.burstIndex) * os.impair.aim * sightK;
      const total = sqrt(sd * sd + wd.dispersionMrad * wd.dispersionMrad) / 1000;
      launchShot(ctx, state, events, op, wdef.weapon, ammoId, v0, mx, my, mz, tz, a0, range, believed, total, vid, tr);
      // Balance pass 5: the programmed fuze, set at the muzzle to burst `standoffM` short of the range the crew believes.
      if (task.fuse === "airburst") {
        const ab = ctx.catalog.ammo[ammoId]?.airburst;
        if (ab) {
          const tof = flightTimeAt(ctx, ammoId, v0, Math.min(Math.max(1, believed - ab.standoffM), tr), tr);
          state.projectiles.burstTick[state.projectiles.count - 1] = tick + Math.max(1, Math.round(tof * TICK_HZ));
        }
      }
      feed.rounds--;
      w.lastShotTick = tick;
      if (task.contact !== undefined && ctx.catalog.medical !== undefined) noteFireAt(ctx, state, events, op, task, task.self !== true, vid, crew?.members); // laws of war (M10.7b)
      if (wdef.feedKind !== "belt") w.loadedRound = false;
      if (wd.jamProbability > 0 && nextFloat(state.rng, Streams.fire) < wd.jamProbability) { w.jammed = true; w.burstLeft = 0; }
      w.burstLeft--;
      w.burstIndex++;
      if (w.burstLeft > 0 && feed.rounds > 0 && !w.jammed) w.nextShotTick = tick + burstCadence(wd.cyclicRpm);
      else {
        w.burstLeft = 0;
        const trickle = !task.self && since > fullTicks;
        const interval = task.area ? task.area.every : trickle ? F.trickleIntervalS : wd.sustained ? wd.sustained.intervalS : 60 / wd.cyclicRpm;
        const disc = ctx.catalog.behaviour.decisions.ammoIntervalFactor[crew?.ammoRule ?? "normal"];
        w.nextShotTick = tick + Math.max(1, Math.round(secondsToTicks(interval) * disc * (0.85 + 0.3 * nextFloat(state.rng, Streams.fire))));
        if (wdef.feedKind !== "belt") w.burstIndex = 0;
      }
    }
  }
}

// ---------------------------------------------------------------- guided missiles (owner 2026-11-13)

/** Does this vehicle carry a guided missile launcher? */
export function vehicleHasMissiles(ctx: SimContext, state: SimState, vid: EntityId | undefined): boolean {
  const v = vid === undefined ? undefined : state.vehicle.get(vid);
  const def = v ? ctx.catalog.vehicles[v.def] : undefined;
  return def !== undefined && def.stations.some((sn) => sn.weapons.some((w) => guidedRound(ctx.catalog, w) !== null));
}

/** The point a missile gunner holds his sight on: an enemy vehicle's aim point (its true place: he sees it). */
export function missileAimPoint(ctx: SimContext, state: SimState, target: EntityId, out: { x: number; y: number; z: number }, from?: { x: number; y: number; z: number; own: EntityId }): boolean {
  const tv = state.vehicle.get(target), tt = state.transform.get(target);
  const td = tv ? ctx.catalog.vehicles[tv.def] : undefined;
  if (!tv || !tt || !td) return false;
  // M7.6b: from the gunner's sight, the lowest aim point he sees (the turret of a hull-down vehicle); else the hull's.
  const k = from ? Math.max(0, visibleAimIndex(ctx, state, target, from.x, from.y, from.z, from.own)) : 0;
  const ap = aimPointsOf(ctx, state, target)[k]!;
  const c = cos(tt.heading), s = sin(tt.heading);
  out.x = tt.x + c * ap[0] - s * ap[1]; out.y = tt.y + s * ap[0] + c * ap[1];
  out.z = heightAt(ctx.map, tt.x, tt.y) + ap[2]; // ground: ok (a hull's aim point)
  return true;
}

/** A sight line blocked this close to its end is blocked by the target's surroundings, not in the way. */
const MISSILE_END_ALLOWANCE_M = 5;

/**
 * Does the missile gunner at (sx, sy, sz) see the point (ax, ay, az) well enough to guide onto it? Not blocked
 * (ground, walls, roofs, hulls; the own and the target's hull ignored), and seen through woods, hedges and smoke
 * (a day sight: nothing through smoke) at least `missileSeenFloor`.
 */
export function missileSees(ctx: SimContext, state: SimState, vid: EntityId, target: EntityId, sx: number, sy: number, sz: number, ax: number, ay: number, az: number, sightLight?: number): boolean {
  const range = hypot2(ax - sx, ay - sy);
  // Balance pass 5 (F9): in the dark, only with a night or thermal sight that reaches (`sightLight`, a station's).
  const floor = ctx.catalog.behaviour.gunnery.missileNightFloor;
  if (sightLight !== undefined && floor !== undefined && Math.max(state.environment.light, sightLight) < floor) return false;
  const r = sight(ctx, sx, sy, sz, ax, ay, az, vid, target);
  if (r.blockedBy !== null && (1 - r.blockedAt) * range > MISSILE_END_ALLOWANCE_M) return false;
  let seen = r.visibility;
  if (state.smoke.length > 0) {
    // (A day sight keeps only what smoke of either kind lets through: spotting's throughSmoke with factor 0.)
    seen *= smokeTransmission(state, smokePhysics(ctx.catalog), sx, sy, sz, ax, ay, az);
  }
  return seen >= (ctx.catalog.behaviour.gunnery.missileSeenFloor ?? 0.2);
}

const MSL_AIM = { x: 0, y: 0, z: 0 };

/** Can this station's missile gunner, from where the launcher stands now, see the enemy vehicle to guide onto it? */
function missileSeesTarget(ctx: SimContext, state: SimState, vid: EntityId, v: VehicleState, def: VehicleDef, si: number, wi: number, target: EntityId): boolean {
  const t = state.transform.get(vid);
  if (!t) return false;
  const [sx, sy, sz] = muzzleWorld(ctx, def, si, wi, t.x, t.y, t.heading, v.stations[si]!.azimuth);
  if (!missileAimPoint(ctx, state, target, MSL_AIM, { x: sx, y: sy, z: sz, own: vid })) return false;
  return missileSees(ctx, state, vid, target, sx, sy, sz, MSL_AIM.x, MSL_AIM.y, MSL_AIM.z, stationSightLight(ctx, def, si, hypot2(MSL_AIM.x - sx, MSL_AIM.y - sy), wi));
}

/**
 * Balance pass 5 (F9): the light the best sight of a station's operator seat gives at `rangeM`: the largest
 * `nightLight` of its sensors that reach that far (a day sight 0, an image intensifier 0.5, a thermal 1).
 */
export function stationSightLight(ctx: SimContext, def: VehicleDef, si: number, rangeM: number, wi?: number): number {
  const op = def.stations[si]?.operator;
  // (Review fix C21: a launcher guided through its own sight only, `guideSensors`: the BMP-2's 9Sh119M1 is a day sight.)
  const only = wi === undefined ? undefined : def.stations[si]?.weapons[wi]?.guideSensors;
  let best = 0;
  for (const seat of def.seats) {
    if (seat.station !== op) continue;
    for (const sn of seat.sensors ?? []) {
      if (only !== undefined && !only.includes(sn.kind)) continue;
      const k = ctx.catalog.spotting.sensors[sn.kind];
      if (k && (k.maxRangeM ?? Infinity) >= rangeM && k.nightLight > best) best = k.nightLight;
    }
  }
  return best;
}

/** A missile on this station's launcher, ready to fire now: halted, nothing in flight, the launcher working. */
function missileReady(ctx: SimContext, v: VehicleState, def: VehicleDef, si: number, moving = false): { weapon: number; g: NonNullable<AmmoDef["guided"]> } | null {
  const st = v.stations[si]!, sn = def.stations[si]!;
  // (`moving`: balance pass 5, F1: the crew may halt for it, so its speed now does not matter.)
  if (st.guide || (!moving && Math.abs(v.drive.speed) > (ctx.catalog.behaviour.gunnery.missileHaltedMps ?? 0.3))) return null;
  for (let wi = 0; wi < sn.weapons.length; wi++) {
    const gr = guidedRound(ctx.catalog, sn.weapons[wi]);
    if (!gr || (st.weapons[wi]?.feeds[0]?.rounds ?? 0) <= 0 || weaponOut(ctx, v, def, si, wi)) continue;
    return { weapon: wi, g: gr.g };
  }
  return null;
}

/**
 * What the crew expects it takes to get through the face an enemy vehicle shows from (x, y) (M7.6a, factored out of
 * `apCanPierce`): the hull plate on that face struck level (resistance per mm by kind), plus the add-on tile it
 * expects there: a reactive tile's mm times the chance of meeting one (`coverage * left / fitted`), a legacy factor
 * tile (shaped charges) while tiles last; a kinetic round counts a reactive tile only if heavy and at or above its
 * trigger (`penMm`, `heavy`: the round judged; left out, one that sets it off), as the hit does. No random draw.
 * null: no plate data (assume it gets through).
 */
export function faceNeed(ctx: SimContext, state: SimState, target: EntityId, x: number, y: number, kind: "kinetic" | "shaped" | "tandem", penMm = Infinity, heavy = true, zone: "hull" | "turret" = "hull", top = false, bare = false): number | null {
  const tv = state.vehicle.get(target), tt = state.transform.get(target);
  const rt = tv ? ctx.ballistics.vehicleRT[tv.def] : undefined;
  if (!tv || !tt || !rt) return null;
  if (top) return roofNeed(ctx, state, target, tv.def, rt, kind, penMm, heavy);
  const bearing = atan2(y - tt.y, x - tt.x);
  const faceAt = (h: number): number => { const rel = Math.abs(wrapAngle(bearing - h)); return rel < PI / 4 ? 0 : rel > (3 * PI) / 4 ? 2 : 1; };
  // M7.6b: the part aimed at; a turret face without a plate of its own is judged by the hull's. The turret's face is
  // taken in the turret's frame (hull heading + first station's traverse), as the hit resolves it (hulls.ts).
  const tf = zone === "turret" ? faceAt(tt.heading + (tv.stations[0]?.azimuth ?? 0)) : 0;
  const tp = zone === "turret" ? rt.plates[4 + tf] : undefined;
  const face = tp ? tf : faceAt(tt.heading);
  const part = tp ? "turret" : "hull";
  const p = tp ?? rt.plates[face];
  if (!p) return null;
  let need = (p.thicknessMm * (kind === "kinetic" ? p.kPerMm : p.sPerMm)) / Math.max(p.cosS, ctx.catalog.ballistics.armour.losFloorCos);
  const tdef = ctx.catalog.vehicles[tv.def];
  const tile = tdef?.armour?.tiles && !bare ? tileFor(tdef, part, face === 0 ? "front" : face === 2 ? "rear" : "side") : undefined;
  if (tile) {
    const left = vehicleItems(state, target, tile.item);
    if (left > 0) {
      if (tile.factor !== undefined) { if (kind !== "kinetic") need *= tile.factor; }
      else {
        const r = ctx.catalog.items[tile.item]?.reactive;
        // As the hit does (armour.ts useTile): a kinetic round sets the tile off only if heavy and at its trigger.
        const sets = kind !== "kinetic" || (heavy && penMm >= (r?.triggerSteelMm ?? 0));
        if (r && sets && tile.coverage !== undefined && tile.fitted > 0) need += tile.coverage * Math.min(1, left / tile.fitted) * reactiveAdd(r, kind);
      }
    }
  }
  return need;
}

/**
 * Balance pass 5 (F2): what it takes to get through a hull's roof from above (a top-attack missile's dive): the
 * stronger of the hull's and the turret's top plates (struck square on), each with the reactive tile it expects
 * there, as `faceNeed` counts one. null: no roof plate (assume it gets through).
 */
function roofNeed(ctx: SimContext, state: SimState, target: EntityId, defId: string, rt: { plates: readonly ({ thicknessMm: number; kPerMm: number; sPerMm: number } | null)[] }, kind: "kinetic" | "shaped" | "tandem", penMm: number, heavy: boolean): number | null {
  const tdef = ctx.catalog.vehicles[defId];
  let worst: number | null = null;
  for (const part of ["hull", "turret"] as const) {
    const p = rt.plates[(part === "turret" ? 4 : 0) + 3];
    if (!p) continue;
    let need = p.thicknessMm * (kind === "kinetic" ? p.kPerMm : p.sPerMm);
    const tile = tdef?.armour?.tiles ? tileFor(tdef, part, "top") : undefined;
    const left = tile ? vehicleItems(state, target, tile.item) : 0;
    if (tile && left > 0) {
      if (tile.factor !== undefined) { if (kind !== "kinetic") need *= tile.factor; }
      else {
        const r = ctx.catalog.items[tile.item]?.reactive;
        const sets = kind !== "kinetic" || (heavy && penMm >= (r?.triggerSteelMm ?? 0));
        if (r && sets && tile.coverage !== undefined && tile.fitted > 0) need += tile.coverage * Math.min(1, left / tile.fitted) * reactiveAdd(r, kind);
      }
    }
    worst = worst === null ? need : Math.max(worst, need);
  }
  return worst;
}

/**
 * The crew's judgement whether its armour-piercing round gets through the face the enemy vehicle shows it (hull,
 * struck level, with the tiles it expects there): the round's published penetration against `faceNeed`.
 */
function apCanPierce(ctx: SimContext, state: SimState, def: VehicleDef, si: number, x: number, y: number, target: EntityId, zone: "hull" | "turret" = "hull", noApPasses = false): boolean {
  return apPierce(ctx, state, def, si, x, y, target, zone, noApPasses, false);
}

/**
 * Balance pass 5 (F1): could the armour-piercing round get through that face at all: the plate alone, without the
 * tile it expects (a tile does not cover the whole face). False: no chance, and the crew holds that fire.
 */
function apCouldPierce(ctx: SimContext, state: SimState, def: VehicleDef, si: number, x: number, y: number, target: EntityId, zone: "hull" | "turret"): boolean {
  return apPierce(ctx, state, def, si, x, y, target, zone, true, true);
}

function apPierce(ctx: SimContext, state: SimState, def: VehicleDef, si: number, x: number, y: number, target: EntityId, zone: "hull" | "turret", noApPasses: boolean, bare: boolean): boolean {
  let pen = 0, heavy = false;
  for (const w of def.stations[si]!.weapons) {
    if (guidedRound(ctx.catalog, w)) continue;
    for (const f of w.feeds) {
      const round = ctx.catalog.items[f.item]?.chargeItem;
      const am = round !== undefined ? ctx.catalog.ammo[round] : undefined;
      if (am && am.explosive === undefined && am.penetration.steelMm > pen) { pen = am.penetration.steelMm; heavy = am.diameterM >= 0.0125; }
    }
  }
  // (`noApPasses`: a station with no armour-piercing round is not judged here: it fires what it has, as before.)
  if (pen <= 0 && noApPasses) return true;
  const need = faceNeed(ctx, state, target, x, y, "kinetic", pen, heavy, zone, false, bare);
  return need === null || pen >= need;
}

/** The same judgement for the station's missile (M7.6a): its jet (tandem or single) against `faceNeed`. */
function missileCanPierce(ctx: SimContext, state: SimState, def: VehicleDef, si: number, wi: number, x: number, y: number, target: EntityId, zone: "hull" | "turret" = "hull"): boolean {
  const gr = guidedRound(ctx.catalog, def.stations[si]!.weapons[wi]);
  const am = gr ? ctx.catalog.ammo[gr.ammo] : undefined;
  if (!am) return true;
  // (Balance pass 5, F2: a top-attack missile is judged against the roof it dives onto, not the face it is fired at.)
  const need = faceNeed(ctx, state, target, x, y, am.kind === "tandem-shaped-charge" ? "tandem" : "shaped", Infinity, true, zone, am.guided?.topAttack !== undefined);
  return need === null || am.penetration.steelMm >= need;
}

/**
 * Fire the station's missile at its task (owner 2026-11-13): halted, laid, the line clear from the launcher, the
 * range between the missile's minimum and its wire; it leaves at the launcher's velocity along the sight line and
 * is guided from the next tick (systems/missiles.ts). The round comes off the launcher (counted).
 */
function fireMissile(
  ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, v: VehicleState, def: VehicleDef, si: number, op: EntityId,
  gr: { ammo: string; g: NonNullable<AmmoDef["guided"]> }, crew: Unit | undefined, x: number, y: number, heading: number,
): void {
  const st = v.stations[si]!, task = st.task!, tick = state.tick, wi = st.taskWeapon;
  const w = st.weapons[wi]!, wdef = def.stations[si]!.weapons[wi]!, feed = w.feeds[0];
  const nature = (): void => {
    // Nothing on the launcher: an ordered task goes on with armour-piercing; a crew's own choice is made again.
    if (!task.self) { const f = feedFor(ctx, def, st, si, "ap", v); if (f) { st.taskWeapon = f.weapon; st.taskFeed = f.feed; return; } }
    st.task = null;
  };
  if (!feed || feed.rounds <= 0) { nature(); return; }
  if (st.guide) return; // one missile in flight per station (M9.3a: also while a fire-and-forget one flies)
  if (Math.abs(v.drive.speed) > (ctx.catalog.behaviour.gunnery.missileHaltedMps ?? 0.3) || st.laidTick < 0) return;
  if (task.contact !== undefined && crew) { const c = crewContact(ctx, state, crew, task.contact); if (c) { task.x = c.x; task.y = c.y; } }
  const [mx, my, mz] = muzzleWorld(ctx, def, si, wi, x, y, heading, st.azimuth);
  const range = hypot2(task.x - mx, task.y - my);
  if (range < gr.g.minRangeM || range > Math.min(gr.g.maxRangeM, wdef.engageRangeM)) { nature(); return; }
  const tz = heightAt(ctx.map, task.x, task.y) + task.heightM; // ground: ok (the point fired at)
  const tv = task.contact !== undefined && state.vehicle.has(task.contact) ? task.contact : -1;
  if (tick - task.lineCheckTick >= TICK_HZ) {
    task.lineCheckTick = tick;
    // At a vehicle: the gunner must see it well enough to guide (the same test as in flight); at a point: the line.
    if (tv >= 0) task.lineClear = missileSeesTarget(ctx, state, vid, v, def, si, wi, tv);
    else { const r = sight(ctx, mx, my, mz, task.x, task.y, tz, vid, tv); task.lineClear = r.blockedBy === null || (1 - r.blockedAt) * range <= LINE_ALLOWANCE_M; }
    if (!task.lineClear && task.self) { nature(); return; } // the crew's own choice: the gun instead
  }
  // (Own men on the way are no bar: the missile flies along the gunner's sight line, above their heads.)
  if (!task.lineClear || tick < w.nextShotTick) return;
  const v0 = ctx.catalog.weapons[wdef.weapon]?.ammo[gr.ammo] ?? 50;
  const a0 = launchGuided(ctx, state, gr, v0, mx, my, mz, task.x, task.y, tz, op);
  events.emit({ kind: "shot.fired", tick, shooter: op, x: mx, y: my, z: mz, dirX: cos(a0), dirY: sin(a0), weapon: wdef.weapon, ammo: gr.ammo, vehicle: vid });
  feed.rounds--;
  w.lastShotTick = tick;
  if (task.contact !== undefined && ctx.catalog.medical !== undefined) noteFireAt(ctx, state, events, op, task, task.self !== true, vid, crew?.members); // laws of war (M10.7b)
  w.nextShotTick = tick + TICK_HZ;
  st.guide = { ammo: gr.ammo, weapon: wi, gunner: op, launchTick: tick, target: tv, errH: 0, errV: 0, checkTick: -1, ax: task.x, ay: task.y, az: tz };
  const kind = ctx.catalog.ammo[gr.ammo]?.guidance;
  if (kind !== undefined && kind !== "command-wire") st.guide.kind = kind;
  // Balance pass 5 (F1): the crew's own missile, wire- or beam-guided: the hull stays halted while it flies (its time
  // of flight at cruise speed, and a second), unless the player drives it.
  const holdS = ctx.catalog.behaviour.gunnery.missileHoldSeconds;
  if (task.self && holdS !== undefined && v.playerHold !== true && !fireAndForget(kind)) {
    v.drive.fireHoldUntilTick = Math.max(v.drive.fireHoldUntilTick ?? 0, tick + secondsToTicks(range / Math.max(1, gr.g.cruiseMps) + 1));
  }
  // Launch warning (M9.3a): the target's crew notices the launch — a laser warner against a beam-riding missile, or
  // an able crewman who has the launcher in sight — and fires its smoke toward it a moment later (missiles.ts).
  if (tv >= 0 && launchNoticed(ctx, state, tv, vid, kind)) st.guide.warnTick = tick + Math.max(1, secondsToTicks(ctx.catalog.behaviour.crew.launchReactionSeconds));
}

/**
 * Launch a guided missile (shared by vehicle stations and teams on foot, M9.3b): from (mx, my, mz) toward the point
 * (tx, ty, tz) at the launcher's velocity `v0` (a top-attack missile pointing up, to climb above its target); it is
 * guided from the next tick (missiles.ts). Returns its launch bearing.
 */
export function launchGuided(
  ctx: SimContext, state: SimState, gr: { ammo: string; g: NonNullable<AmmoDef["guided"]> }, v0: number,
  mx: number, my: number, mz: number, tx: number, ty: number, tz: number, owner: EntityId,
): number {
  const range = hypot2(tx - mx, ty - my);
  // (M9.3a: a top-attack missile leaves pointing up, to climb above its target.)
  const loft = gr.g.topAttack ? (gr.g.topAttack.launchElevationDeg * PI) / 180 : 0;
  const a0 = atan2(ty - my, tx - mx), e0 = atan2(tz - mz, range) + loft;
  const ce = cos(e0);
  launchProjectile(ctx, state, gr.ammo, mx, my, mz, v0 * cos(a0) * ce, v0 * sin(a0) * ce, v0 * sin(e0), owner);
  return a0;
}

/**
 * Does the crew of vehicle `tv` notice a missile launched at it from `from` (M9.3a): a vehicle, or (M9.3b) the
 * gunner of a team on foot — an able crewman who saw him lately (the crew's `seen` lists hold men and hulls alike)?
 */
export function launchNoticed(ctx: SimContext, state: SimState, tv: EntityId, from: EntityId, kind: string | undefined): boolean {
  const v = state.vehicle.get(tv), def = v ? ctx.catalog.vehicles[v.def] : undefined;
  if (!v || !def || !def.dischargers || v.unit === null || v.status === "destroyed" || v.status === "abandoned") return false;
  if (def.laserWarner === true && kind === "command-beam") return true;
  const recent = secondsToTicks(ctx.catalog.behaviour.gunnery.seenWithinSeconds);
  for (let k = 0; k < def.seats.length; k++) {
    if (def.seats[k]!.station === "passenger") continue;
    const m = v.seats[k];
    const s = m === null || m === undefined ? undefined : state.soldier.get(m);
    if (!isAble(s)) continue;
    for (const e of s!.seen) if (e.target === from && state.tick - e.lastTick <= recent) return true;
  }
  return false;
}

/** Ticks to load one round into a single-round or autoloader gun (slower without an able loader); -1: nobody can. */
function loadTicks(state: SimState, v: VehicleState, wdef: VehicleDef["stations"][number]["weapons"][number], def: VehicleDef): number {
  const loader = wdef.feedKind === "single" && wdef.loaderStation !== undefined ? loaderFit(state, v, def, wdef.loaderStation) : true;
  if (!loader && wdef.noLoaderFactor === undefined) return -1;
  return Math.max(1, secondsToTicks((wdef.roundLoadSeconds ?? 1) * (loader ? 1 : wdef.noLoaderFactor!)));
}

function loaderFit(state: SimState, v: VehicleState, def: VehicleDef, kind: string): boolean {
  for (let i = 0; i < def.seats.length; i++) {
    if (def.seats[i]!.station !== kind) continue;
    const o = v.seats[i];
    if (o !== null && o !== undefined && isAble(state.soldier.get(o))) return true;
  }
  return false;
}

// ---------------------------------------------------------------- smoke dischargers

/**
 * Order: fire a salvo of smoke grenades (counted items from the container, rule 9). The clouds stand after the
 * dischargers' delay. Returns true, or a radio key why not.
 */
export function dischargeSmoke(ctx: SimContext, state: SimState, vid: EntityId): true | { unable: string } {
  const v = state.vehicle.get(vid);
  const def = v ? ctx.catalog.vehicles[v.def] : undefined;
  const D = def?.dischargers;
  const c = state.container.get(vid);
  // Any crew still in a vehicle that is not burnt out can fire its dischargers if they work (M7.4b).
  if (!v || !def || !D || !c || v.status === "destroyed" || v.status === "abandoned" || compCondition(v, def, "dischargers") <= 0) return { unable: "radio.noSmoke" };
  if (v.pendingSmokeTick >= 0) return true; // a salvo is on its way already
  const have = c.stacks.filter((s) => s.type === D.item).reduce((n, s) => n + s.count, 0);
  if (have < D.perSalvo) return { unable: "radio.noSmoke" };
  // The grenades leave the container now; the screen stands after the delay.
  const sink = emptyContainer();
  transferItems(ctx.catalog, { get: (id) => (id === vid ? c : id === -1 ? sink : undefined) }, { from: vid, to: -1, type: D.item, count: D.perSalvo });
  v.pendingSmokeTick = state.tick + Math.max(1, secondsToTicks(D.delaySeconds));
  v.smokeReadyTick = v.pendingSmokeTick;
  return true;
}

function smokeScreen(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, v: VehicleState, def: VehicleDef): void {
  v.pendingSmokeTick = -1;
  const D = def.dischargers;
  const t = state.transform.get(vid);
  if (!D || !t) return;
  const ms = ctx.catalog.ammo[D.item]?.multispectral === true;
  const az = t.heading + (v.stations[0]?.azimuth ?? 0);
  let sx = 0, sy = 0;
  for (let k = 0; k < D.perSalvo; k++) {
    const a = az + (D.perSalvo === 1 ? 0 : D.arcRad * (k / (D.perSalvo - 1) - 0.5));
    const x = Math.min(Math.max(t.x + cos(a) * D.rangeM, 1), ctx.map.widthM - 1), y = Math.min(Math.max(t.y + sin(a) * D.rangeM, 1), ctx.map.heightM - 1);
    addSmoke(ctx, state, x, y, D.cloudRadiusM, D.cloudSeconds, D.cloudTopM ?? 8, 0, ms);
    sx += x; sy += y;
  }
  events.emit({ kind: "vehicle.smoke", tick: state.tick, vehicle: vid, x: sx / D.perSalvo, y: sy / D.perSalvo, item: D.item, count: D.perSalvo });
}

// ---------------------------------------------------------------- ready belts from stowage (owner Q17)

/** Capacity of a feed's ready belts, rounds. */
function readyCapacity(def: VehicleDef, si: number, wi: number, fi: number): number {
  const r = def.stations[si]?.weapons[wi]?.feeds[fi]?.ready;
  return r ? r.count * r.charge : 0;
}

/** Halted, a feed run low with belts of its kind in stowage: the operator refills it (timed action). */
function refillCheck(ctx: SimContext, state: SimState, events: EventSink, vid: EntityId, v: VehicleState, def: VehicleDef, si: number): void {
  const sn = def.stations[si]!;
  if (!sn.readyRefillInBattle || sn.refillSeconds === undefined) return;
  if (Math.abs(v.drive.speed) > 0.3 || (v.drive.route.length > v.drive.routeIdx && !v.drive.arrived)) return;
  const op = stationOperator(state, v, def, si);
  if (op === null || state.action.has(op)) return;
  const c = state.container.get(vid);
  if (!c) return;
  const frac = ctx.catalog.behaviour.gunnery.refillBelowFraction;
  const st = v.stations[si]!;
  for (let wi = 0; wi < st.weapons.length; wi++) {
    const w = st.weapons[wi]!;
    if (guidedRound(ctx.catalog, def.stations[si]!.weapons[wi])) continue; // missiles: systems/missiles.ts reloads
    for (let fi = 0; fi < w.feeds.length; fi++) {
      const f = w.feeds[fi]!, cap = readyCapacity(def, si, wi, fi);
      if (cap <= 0 || f.rounds > cap * frac) continue;
      const belt = c.stacks.find((s) => s.type === f.item && (s.charge ?? 0) > 0 && f.rounds + (s.charge ?? 0) <= cap);
      if (!belt) continue;
      startAction(state, events, op, "reloadStation", secondsToTicks(sn.refillSeconds), { vehicle: vid, station: si, weapon: wi, feed: fi });
      return;
    }
  }
}

registerActionHandler("reloadStation", {
  check(_ctx, state, actor, a) {
    const v = state.vehicle.get(Number(a.params["vehicle"]));
    if (!v || state.soldier.get(actor)?.mount?.vehicle !== Number(a.params["vehicle"])) return "left-vehicle";
    if (Math.abs(v.drive.speed) > 0.3) return "moving";
    return null;
  },
  complete(ctx, state, actor, a, events) {
    const vid = Number(a.params["vehicle"]), si = Number(a.params["station"]), wi = Number(a.params["weapon"]), fi = Number(a.params["feed"]);
    const v = state.vehicle.get(vid), def = v ? ctx.catalog.vehicles[v.def] : undefined, c = state.container.get(vid);
    const w: VehicleWeaponState | undefined = v?.stations[si]?.weapons[wi];
    const f = w?.feeds[fi];
    if (!v || !def || !c || !w || !f) return;
    const cap = readyCapacity(def, si, wi, fi);
    // Whole belts from stowage onto the ready feed while they fit (counted items, the one generic transfer).
    const ready = emptyContainer();
    const box = { get: (id: EntityId) => (id === vid ? c : id === -1 ? ready : undefined) };
    let moved = 0;
    for (;;) {
      const belt = [...c.stacks].filter((s) => s.type === f.item && (s.charge ?? 0) > 0).sort((p, q) => (q.charge ?? 0) - (p.charge ?? 0))[0];
      if (!belt || f.rounds + (belt.charge ?? 0) > cap) break;
      const r = transferItems(ctx.catalog, box, { from: vid, to: -1, type: f.item, count: 1, charge: belt.charge! });
      if (r.moved === 0) break;
      for (const s of ready.stacks) f.rounds += (s.charge ?? 0) * s.count;
      moved += r.moved;
      ready.stacks = [];
    }
    if (moved > 0) {
      w.lowAmmoReported[fi] = false;
      events.emit({ kind: "items.transferred", tick: state.tick, from: vid, to: actor, item: f.item, count: moved });
    }
  },
});

// ---------------------------------------------------------------- orders and incoming fire

/**
 * Balance pass 5 (mounted assault): would station 0's line of fire from its muzzle reach a contact of the crew (its
 * own picture of `target`, else (x, y)) as the line check of an ordered task does? Used to put a hull only on
 * enemies it can fire at.
 */
export function stationLineTo(ctx: SimContext, state: SimState, vid: EntityId, target: EntityId, x: number, y: number): boolean {
  const v = state.vehicle.get(vid), def = v ? ctx.catalog.vehicles[v.def] : undefined;
  if (!v || !def || v.stations.length === 0) return false;
  const crew = v.unit !== null ? state.unit.get(v.unit) : undefined;
  const c = crew ? crewContact(ctx, state, crew, target) : null;
  const px = c ? c.x : x, py = c ? c.y : y;
  const t = state.transform.req(vid);
  const [mx, my, mz] = muzzleWorld(ctx, def, 0, 0, t.x, t.y, t.heading, v.stations[0]!.azimuth);
  const tz = heightAt(ctx.map, px, py) + (c?.z ?? 0) + 0.6; // ground: ok (the point fired at; his floor in z)
  const r = sight(ctx, mx, my, mz, px, py, tz, vid, state.vehicle.has(target) ? target : -1);
  return r.blockedBy === null || (1 - r.blockedAt) * hypot2(px - mx, py - my) <= LINE_ALLOWANCE_M;
}

/** A fire order to a vehicle crew: each station that can, at the point or the named enemy, with the nature asked. */
export function stationFireOrder(ctx: SimContext, state: SimState, vid: EntityId, order: Extract<OrderBody, { kind: "fire" }>, issuer: string): true | "unable" | { unable: string } {
  const v = state.vehicle.get(vid), def = v ? ctx.catalog.vehicles[v.def] : undefined;
  if (!v || !def || !canFight(v)) return "unable";
  if (v.stations.length === 0) return "unable";
  const crew = v.unit !== null ? state.unit.get(v.unit) : undefined;
  const t = state.transform.req(vid);
  // The named enemy, if the crew knows him (an unknown or own entity is ignored: the point is used).
  const named = order.contact !== undefined && targetLive(state, order.contact) && (state.identity.get(order.contact)?.side ?? state.vehicle.get(order.contact)?.side) !== issuer ? order.contact : undefined;
  let x = order.x, y = order.y;
  let known: { z?: number; posture?: Posture } | undefined;
  // Owner Q-7 (M10.7a): a crew that recognises the target as protected will not fire at it.
  if (crew && ctx.catalog.medical !== undefined && refusesFireAt(state, crew.members, order.x, order.y, named, ctx.catalog.medical.protection.aimSpareM)) return { unable: "radio.refuseProtected" };
  if (named !== undefined && crew) { const c = crewContact(ctx, state, crew, named); if (c) { x = c.x; y = c.y; known = c; } }
  const isVeh = named !== undefined && state.vehicle.has(named);
  const d = hypot2(x - t.x, y - t.y);
  const G = ctx.catalog.behaviour.gunnery;
  // M7.6b: at a vehicle, the lowest aim point the line from the (first) muzzle clears; none: the hull's.
  const apk = isVeh ? Math.max(0, visibleAimIndex(ctx, state, named, ...muzzleWorld(ctx, def, 0, 0, t.x, t.y, t.heading, v.stations[0]!.azimuth), vid, x, y)) : 0;
  const zone = apk === 0 ? "hull" : "turret";
  // "Anti-tank" (owner 2026-11-13): the guided missile if the vehicle has one ready, else armour-piercing.
  // An order without a nature at an enemy vehicle: the missile where the crew would choose it itself.
  const mslVeh = (si: number): boolean => {
    const m = isVeh ? missileReady(ctx, v, def, si) : null;
    return m !== null && named !== undefined && d >= m.g.minRangeM && d <= Math.min(m.g.maxRangeM, def.stations[si]!.weapons[m.weapon]!.engageRangeM)
      && (d >= (def.stations[si]!.weapons[m.weapon]!.missileBeyondM ?? G.missileBeyondM ?? 1000) || (!apCanPierce(ctx, state, def, si, t.x, t.y, named, zone) && missileCanPierce(ctx, state, def, si, m.weapon, t.x, t.y, named, zone)));
  };
  // Balance pass 5: an air burst asked for is high explosive (and only from a round that has the setting).
  const wantAir = order.fuse === "airburst";
  // (The crew's own setting at a point where it knows an enemy hull: impact, at the hull.)
  const hullNear = crew !== undefined && crew.members.some((m) => state.soldier.get(m)?.contacts.some((c) => c.cls === "vehicle" && c.wreck !== true && hypot2(c.x - x, c.y - y) <= HULL_NEAR_M) === true);
  const want0: Nature = order.nature === "at" ? "atgm" : wantAir ? "he" : order.nature ?? (isVeh ? "ap" : d > G.coaxSingleWithinM ? "he" : "mg");
  let any = false, noAir = false;
  for (let si = 0; si < v.stations.length; si++) {
    if (stationOperator(state, v, def, si) === null) continue;
    const want: Nature = order.nature === undefined && !wantAir && mslVeh(si) ? "atgm" : want0;
    const f = wantAir ? (() => { const p = pickFeed(ctx, def, v.stations[si]!, si, "he", v); return p ? { ...p, nature: "he" as Nature } : null; })() : feedFor(ctx, def, v.stations[si]!, si, want, v);
    if (!f) continue;
    // The air-burst setting: asked for, or the crew's choice at men in the open (not a vehicle, not a building).
    const ab = f.nature === "he" ? airburstOf(ctx, def, si, f.weapon, f.feed) : undefined;
    const air = ab !== undefined && airburstAt(ab, d) && order.fuse !== "impact" && (wantAir || (!isVeh && !hullNear && indoorAt(ctx, x, y) < 0));
    if (wantAir && !air) { noAir = true; continue; }
    const h = air && order.heightM === undefined ? ab.aimHeightM : order.heightM ?? (isVeh ? aimPointsOf(ctx, state, named)[apk]![2] : f.nature === "atgm" ? 1.2 : f.nature === "he" ? 0 : aimHeightAt(ctx, known));
    setStationTask(ctx, state, vid, si, x, y, h, f.weapon, f.feed, named, false);
    if (air) v.stations[si]!.task!.fuse = "airburst";
    v.stations[si]!.why = { tick: state.tick, keys: ["why.target.ordered", air ? "why.nature.airburst" : `why.nature.${f.nature}`] };
    any = true;
  }
  if (!any) return { unable: noAir ? "radio.noAirburst" : "radio.noAmmunition" };
  if (crew) { crew.firing = true; crew.lineBlockedReported = false; }
  return true;
}

/**
 * Balance pass 5 (area fire): an ordered area fire (a drill's support fire at an objective where no enemy is known):
 * each station that can fires at the circle of `r` m round (x, y) as at a suspected place of weight `w`
 * (`areaFeed`: high explosive with its air burst where it has one, else the coaxial machine gun; the reserve kept),
 * never with own men within the danger radius plus the circle or in the line. True if any station took it.
 */
export function areaFireOrder(ctx: SimContext, state: SimState, vid: EntityId, x: number, y: number, r: number, w: number): boolean {
  const v = state.vehicle.get(vid), def = v ? ctx.catalog.vehicles[v.def] : undefined;
  if (!v || !def || !canFight(v) || ctx.catalog.behaviour.gunnery.areaFire === undefined) return false;
  const crew = v.unit !== null ? state.unit.get(v.unit) : undefined;
  if (!crew) return false;
  const rules = state.unit.get(fireTop(state, v.unit!));
  const t = state.transform.req(vid), d = hypot2(x - t.x, y - t.y);
  let any = false;
  for (let si = 0; si < v.stations.length; si++) {
    const op = stationOperator(state, v, def, si), st = v.stations[si]!;
    if (op === null || (st.guide && !fireAndForget(st.guide.kind))) continue;
    const f = areaFeed(ctx, def, st, si, v, d, w, rules?.ammoRule ?? "normal");
    if (!f) continue;
    const dz = stationDangerM(ctx, def, si, f.weapon, f.feed, d);
    if (ownMenWithin(state, v.side, x, y, dz + r)) continue;
    const h = f.air ? airburstOf(ctx, def, si, f.weapon, f.feed)!.aimHeightM : f.nature === "he" ? 0 : 0.6;
    if (stationHeld(ctx, state, vid, v, def, si, f.weapon, f.feed, op, x, y, h, f.air) !== null) continue;
    const prev = st.task;
    const area = { r, w, every: f.every, ox: prev?.area?.ox ?? 0, oy: prev?.area?.oy ?? 0 };
    if (prev !== null && prev.area !== undefined && !prev.self && hypot2(prev.x - x, prev.y - y) < 3 && st.taskWeapon === f.weapon && st.taskFeed === f.feed) { prev.reasonTick = state.tick; prev.area = area; }
    else {
      setStationTask(ctx, state, vid, si, x, y, h, f.weapon, f.feed, undefined, false);
      st.task!.area = area;
      if (f.air) st.task!.fuse = "airburst";
    }
    st.why = { tick: state.tick, keys: ["why.target.ordered", f.air ? "why.nature.airburst" : `why.nature.${f.nature}`] };
    any = true;
  }
  if (any) { crew.firing = true; crew.lineBlockedReported = false; }
  return any;
}

/** Cease fire for a crew: its station tasks end, and it holds its fire until fired upon again. */
export function stationCeaseFire(state: SimState, crewId: EntityId, events: EventSink): void {
  const crew = state.unit.get(crewId);
  if (!crew || crew.vehicle === undefined) return;
  crew.ceaseFireTick = state.tick;
  const v = state.vehicle.get(crew.vehicle);
  let had = false;
  if (v) for (const st of v.stations) if (st.task) { st.task = null; had = true; }
  if (crew.firing || had) { crew.firing = false; events.emit({ kind: "fire.ceased", tick: state.tick, unit: crewId, reason: "ordered" }); }
}

/**
 * Hits on a hull (plan §1): the crew unit and its platoon are under fire (return-fire rule, drills), and the
 * vehicle remembers when (the AI polls `lastHitTick`). Incoming fire near a vehicle keeps its ordered tasks at
 * the full rate.
 */
export function vehicleIncomingSystem(ctx: SimContext, state: SimState, events: readonly SimEvent[]): void {
  if (state.vehicle.size === 0) return;
  const D = ctx.catalog.behaviour.decisions, F = ctx.catalog.shooting.fire, tick = state.tick;
  const mem = secondsToTicks(D.underFireMemorySeconds);
  const stamp = (u: Unit | undefined) => { if (!u) return; if (tick - u.underFireTick > mem) u.contactTick = tick; u.underFireTick = tick; };
  let near: { vid: EntityId; x: number; y: number; side: string }[] | null = null;
  const r2 = F.incomingRadiusM * F.incomingRadiusM;
  const refresh = new Set<EntityId>();
  for (const e of events) {
    if (e.kind === "vehicle.hit") {
      const v = state.vehicle.get(e.vehicle);
      if (!v) continue;
      const sideOwner = state.identity.get(e.owner)?.side;
      if (sideOwner === v.side) continue;
      v.lastHitTick = tick;
      if (v.unit !== null) { stamp(state.unit.get(v.unit)); stamp(topOf(state, v.unit)); }
      refresh.add(e.vehicle);
      continue;
    }
    let side: string | undefined;
    if (e.kind === "shot.fired") { if (e.indirect) continue; side = state.identity.get(e.shooter)?.side; } // (M8.3b: a mortar)
    else if (e.kind === "impact" && e.owner > 0) side = state.identity.get(e.owner)?.side;
    else continue;
    if (side === undefined) continue;
    if (near === null) {
      near = [];
      for (const [vid, v] of state.vehicle.entries()) {
        if (isOffMap(v) || !v.stations.some((s) => s.task !== null)) continue;
        const t = state.transform.get(vid);
        if (t) near.push({ vid, x: t.x, y: t.y, side: v.side });
      }
    }
    for (const m of near) {
      if (m.side === side) continue;
      const dx = m.x - e.x, dy = m.y - e.y;
      let hit: boolean;
      if (e.kind === "impact") hit = dx * dx + dy * dy <= r2;
      else { const along = dx * e.dirX + dy * e.dirY, across = dx * -e.dirY + dy * e.dirX; hit = along > 0 && along <= F.incomingReachM && across * across <= r2; }
      if (hit) refresh.add(m.vid);
    }
  }
  const fullTicks = secondsToTicks(F.fullRateSeconds);
  for (const vid of [...refresh].sort((a, b) => a - b)) {
    const v = state.vehicle.get(vid);
    if (!v) continue;
    const def = ctx.catalog.vehicles[v.def];
    for (let si = 0; si < v.stations.length; si++) {
      const st = v.stations[si]!;
      if (!st.task) continue;
      if (tick - st.task.reasonTick > fullTicks) {
        for (let wi = 0; wi < st.weapons.length; wi++) {
          const w = st.weapons[wi]!;
          // A round being loaded (review fix): the slow interval goes, the load itself does not.
          const wdef = def?.stations[si]?.weapons[wi];
          const loading = wdef !== undefined && wdef.feedKind !== "belt" && !w.loadedRound && w.burstIndex === -1;
          const floor = loading ? Math.max(w.lastShotTick + 1, w.switchUntilTick) + Math.max(0, loadTicks(state, v, wdef, def!)) : 0;
          w.nextShotTick = Math.min(w.nextShotTick, Math.max(tick + TICK_HZ / 2, floor));
        }
      }
      st.task.reasonTick = tick;
    }
  }
}

