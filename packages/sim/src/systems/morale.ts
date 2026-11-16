/**
 * SUPPRESSION AND MORALE (M4.1; morale rework 2026-11-15, owner: "morale is almost always at 100").
 *
 * SUPPRESSION is the physical part: gathered by the projectile system (an enemy round cracking past a man or striking
 * near him) and by bursts (`suppressByBurst`); here it fades.
 *
 * MORALE (0..1, `mental.morale`, the value the man box shows) = resolve x (1 - shock) x (1 - strain):
 *   resolve  his ceiling: his unit's quality (core/qualities.json `morale.resolve`), his own nerve (drawn at setup),
 *            fatigue, and heavy losses of his squad.
 *   shock    `mental.stress`, the fast fear. Kicks: suppression (sustained, and at once on every near miss), comrades
 *            hit (harder the closer and the nearer to him in the order of battle; losses in quick succession hit
 *            harder), his leader lost, his own wound, untreated wounds, comrades left lying, indirect fire, enemy
 *            armour, being outflanked, an enemy close, being alone. Recovers with a time constant of minutes when it
 *            is quiet, slower under light fire, not at all under heavier fire or in a beaten zone.
 *   strain   `mental.strain`, the slow wear: losses, his leader, his wounds. Recovers over tens of minutes and never
 *            falls below his squad's loss floor.
 * Kicks saturate (x += a(1 - x)) and are scaled by his SUSCEPTIBILITY k: experience, his leader near (x(1 - 0.5 L) of
 * the leader's leadership skill), mates around, his squad's cohesion (bond), good cover, own armour near, darkness.
 * Recovery is scaled likewise: quality, the leader near (x(1 + 1.5 L)), bond, cover, mates, own armour; winded halves it.
 * Relief: an enemy down that his squad knows of, an enemy unit breaking, own support bursting near a known enemy, a
 * medic treating a comrade, a casualty evacuated.
 *
 * BEHAVIOUR follows, with hysteresis (core/behaviour.json `morale.states`):
 *   shaken    morale below 0.60 (back at 0.70): fires less, aims worse.
 *   pinned    suppression at his quality's pin level (lower when shaken), or morale below 0.40 under fire: prone,
 *             does not move, fires a third as often.
 *   panicked  morale below 0.25 (his nerve shifts it; held at least 20 s; back at 0.40): does not fire. Under heavy
 *             fire or with an enemy close he cowers; otherwise he runs 50-150 m back from the enemy (`mental.flee`)
 *             and cowers there.
 * A leader rallies (action `rally`, 4 s) his worst-off man within 30 m. Each UNIT gets a morale value and state every
 * second (`Unit.morale`); a unit whose men panic or whose morale stays very low breaks (drills.ts runs the rout).
 * Values are data; the same for every side (differences come from quality, experience, fatigue and leadership).
 */
import { sendsRadio } from "../comms";
import { MORALE_SOURCES, MORALE_STRAIN_FROM, type Behaviour, type SoldierState, type Unit } from "../components";
import type { SimContext } from "../context";
import type { EventSink, SimEvent } from "../events";
import { secondsToTicks, staggerFirst, type EntityId } from "../ids";
import { isAble, isCaptive } from "../impair";
import type { SimState } from "../state";
import { atan2, PI, sqrt } from "../math";
import { registerActionHandler, startAction } from "../actions";
import { routeBetween, routeWaypoints, indoorAt } from "../interior-nav";
import { navFor } from "../navctx";
import { exposureAt } from "../nav";
import type { MoraleDef, QualityMoraleDef } from "../catalog";
import { requestPosture } from "./body";
import { unitSoldiers } from "./orders";
import { launcherRound } from "./launcher";
import { rallyRouted } from "./drills";

const SRC = Object.fromEntries(MORALE_SOURCES.map((k, i) => [k, i])) as Record<(typeof MORALE_SOURCES)[number], number>;
const N_SRC = MORALE_SOURCES.length;

/** His unit's quality values (core/qualities.json `morale`). */
export function qualityMorale(ctx: SimContext, state: SimState, id: EntityId): QualityMoraleDef {
  const u = state.unit.get(state.identity.get(id)?.unit ?? -1);
  const q = ctx.catalog.qualities[u?.quality ?? ctx.catalog.behaviour.morale.defaultQuality] ?? ctx.catalog.qualities[ctx.catalog.behaviour.morale.defaultQuality];
  return q!.morale;
}

const unitOf = (state: SimState, id: EntityId): Unit | undefined => state.unit.get(state.identity.get(id)?.unit ?? -1);
const d2 = (state: SimState, a: EntityId, b: EntityId): number => {
  const p = state.transform.get(a), q = state.transform.get(b);
  if (!p || !q) return Infinity;
  const dx = p.x - q.x, dy = p.y - q.y;
  return dx * dx + dy * dy;
};
/** Two men close enough to see and hear each other: both on foot, or aboard the same vehicle. */
const together = (a: SoldierState, b: SoldierState): boolean => (a.mount === undefined) === (b.mount === undefined) && (a.mount === undefined || a.mount.vehicle === b.mount!.vehicle);

/**
 * The leadership he feels now (0 = none): his unit's leader (for a leader, the leader above him, by radio) while that
 * leader is able and near; half when the leader's own morale is low, none when the leader has panicked or run.
 */
export function leaderNear(ctx: SimContext, state: SimState, id: EntityId, s: SoldierState): number {
  const D = ctx.catalog.behaviour.morale.damp;
  const u = unitOf(state, id);
  if (!u) return 0;
  let leader = u.leader, range = D.leaderNearM;
  if (leader === id) { leader = u.parent !== null ? state.unit.get(u.parent)?.leader ?? null : null; range = D.radioLeaderM; }
  if (leader === null || leader === id) return 0;
  const l = state.soldier.get(leader);
  if (!l || !isAble(l)) return 0;
  const b = l.mental.behaviour;
  if (b === "panicked" || b === "routed") return 0;
  if (range === D.leaderNearM ? !together(s, l) : false) return 0;
  if (d2(state, id, leader) > range * range) return 0;
  const L = l.skills["leadership"] ?? D.defaultLeadership;
  return l.mental.morale < D.leaderLowMorale ? L * D.leaderLowFactor : L;
}

/** Scratch: his situation this step (no allocation per man). */
const SIT = { k: 1, r: 1, L: 0, mates: 0, nearest2: Infinity, cover: false, armourNear: false };

/** Work out his susceptibility (gains) and recovery factors into SIT. */
function situation(ctx: SimContext, state: SimState, id: EntityId, s: SoldierState): typeof SIT {
  const M = ctx.catalog.behaviour.morale, D = M.damp, R = M.recovery;
  const u = unitOf(state, id);
  const Q = qualityMorale(ctx, state, id);
  const L = leaderNear(ctx, state, id, s);
  const bond = u?.morale.bond ?? Q.bond;
  // Mates around: able men of his own unit near him (aboard: those in the same hull).
  let mates = 0, nearest2 = Infinity;
  const t = state.transform.get(id);
  if (u && t) {
    const mm = D.matesM * D.matesM;
    for (const o of u.members) {
      if (o === id) continue;
      const os = state.soldier.get(o);
      if (!os || !isAble(os) || !together(s, os)) continue;
      const q = state.transform.get(o);
      if (!q) continue;
      const dx = q.x - t.x, dy = q.y - t.y, dd = dx * dx + dy * dy;
      if (dd < nearest2) nearest2 = dd;
      if (dd <= mm) mates++;
    }
  }
  let cover = false, armourNear = false;
  if (s.mount !== undefined) cover = true; // behind armour
  else if (t) {
    cover = indoorAt(ctx, t.x, t.y) >= 0 || exposureAt(navFor(ctx, "foot").grid, t.x, t.y) < M.relief.coverExposure;
    const side = state.identity.get(id)?.side, ar = M.relief.armourNearM * M.relief.armourNearM;
    for (const [vid, v] of state.vehicle.entries()) {
      if (v.side !== side || v.status === "destroyed" || v.status === "abandoned" || v.offMap !== undefined) continue;
      const q = state.transform.get(vid);
      if (q && (q.x - t.x) * (q.x - t.x) + (q.y - t.y) * (q.y - t.y) <= ar) { armourNear = true; break; }
    }
  }
  const matesOk = mates >= D.matesMin;
  let k = (1 - D.experience * (s.skills["experience"] ?? D.defaultExperience)) * (1 - D.leaderPerL * L) * (matesOk ? D.mates : 1) * (D.bondBase - D.bondPer * bond)
    * (cover ? D.cover : 1) * (armourNear ? D.armourNear : 1);
  const env = state.environment;
  if (env.sky !== undefined && env.light < M.shock.darkBelowLight) k *= M.shock.darkFactor;
  SIT.k = Math.min(D.max, Math.max(D.min, k));
  SIT.r = Q.recovery * (1 + R.leaderPerL * L) * (R.bondBase + R.bondPer * bond) * (cover ? R.cover : 1) * (matesOk ? R.mates : 1)
    * (s.physical.winded ? R.winded : 1) * (armourNear ? R.armourNear : 1);
  SIT.L = L; SIT.mates = mates; SIT.nearest2 = nearest2; SIT.cover = cover; SIT.armourNear = armourNear;
  return SIT;
}

/** Susceptibility alone (for event kicks). */
function gainFactor(ctx: SimContext, state: SimState, id: EntityId, s: SoldierState): number {
  return situation(ctx, state, id, s).k;
}

/** Add to his shock (saturating), booked to `src`. `k`: his susceptibility. */
function addShock(s: SoldierState, a: number, src: number, k: number): void {
  const m = s.mental;
  if (!(a > 0)) return;
  const d = Math.min(1, a * k) * (1 - m.stress);
  m.stress += d;
  m.why[src] = (m.why[src] ?? 0) + d;
}

/** Add to his strain (saturating), booked to `src`. */
function addStrain(s: SoldierState, a: number, src: number, k: number): void {
  const m = s.mental;
  if (!(a > 0)) return;
  const d = Math.min(1, a * k) * (1 - m.strain);
  m.strain += d;
  m.why[src] = (m.why[src] ?? 0) + d;
}

/** Scale the reasons that belong to the shock (from < MORALE_STRAIN_FROM) or to the strain by f. */
export function scaleWhy(s: SoldierState, f: number, strain: boolean): void {
  const w = s.mental.why;
  const a = strain ? MORALE_STRAIN_FROM : 0, b = strain ? N_SRC - 1 /* fatigue is set, not scaled */ : MORALE_STRAIN_FROM;
  for (let i = a; i < b; i++) w[i] = w[i]! * f;
}

/** Relief: shock down by `a` (absolute), its reasons in proportion. */
function relieveShock(s: SoldierState, a: number): void {
  const m = s.mental;
  if (!(a > 0) || m.stress <= 0) return;
  const next = Math.max(0, m.stress - a);
  scaleWhy(s, next / m.stress, false);
  m.stress = next;
}
function relieveStrain(s: SoldierState, a: number): void {
  const m = s.mental;
  if (!(a > 0) || m.strain <= 0) return;
  const next = Math.max(0, m.strain - a);
  scaleWhy(s, next / m.strain, true);
  m.strain = next;
}

/** A kick to an able man, scaled by his susceptibility. */
function kick(ctx: SimContext, state: SimState, id: EntityId, shock: number, strain: number, src: number, strainSrc = src): void {
  const s = state.soldier.get(id);
  if (!s || !isAble(s)) return;
  const k = gainFactor(ctx, state, id, s);
  addShock(s, shock, src, k);
  addStrain(s, strain, strainSrc, k);
}

/** His unit's loss share (0..1). */
function lossShare(u: Unit | undefined): number {
  return u && u.morale.start > 0 ? Math.min(1, u.morale.lost / u.morale.start) : 0;
}

/** His resolve: quality, nerve, fatigue, his squad's losses (0..1). */
export function resolveOf(ctx: SimContext, state: SimState, id: EntityId, s: SoldierState): number {
  const M = ctx.catalog.behaviour.morale, Q = qualityMorale(ctx, state, id);
  const ls = lossShare(unitOf(state, id));
  const r = Q.resolve + M.nerve.resolvePer * (s.mental.nerve - 0.5) - Q.fatigueCost * Math.max(0, s.physical.fatigue - M.fatigue.from)
    - M.strain.lossResolvePerRatio * Math.max(0, ls - M.strain.lossResolveFrom);
  return Math.min(1, Math.max(0, r));
}

/** morale = resolve x (1 - shock) x (1 - strain). */
export function moraleOf(ctx: SimContext, state: SimState, id: EntityId, s: SoldierState): number {
  return resolveOf(ctx, state, id, s) * (1 - s.mental.stress) * (1 - s.mental.strain);
}

/** Add suppression to a man (clamped to the maximum); what he takes also jolts his shock at his next step. */
export function addSuppression(ctx: SimContext, s: SoldierState, amount: number): void {
  if (!isAble(s) || amount <= 0) return;
  const max = ctx.catalog.behaviour.suppression.max;
  const next = Math.min(max, s.mental.suppression + amount);
  s.mental.jolt += next - s.mental.suppression;
  s.mental.suppression = next;
}

/** A burst suppresses everyone within `blastRadiusScale` x its stun radius (more the closer). */
export function suppressByBurst(ctx: SimContext, state: SimState, x: number, y: number, stunR: number, ownerSide?: string): void {
  const SUP = ctx.catalog.behaviour.suppression;
  const R = stunR * SUP.blastRadiusScale;
  if (!(R > 0)) return;
  for (const [id, s] of state.soldier.entries()) {
    const t = state.transform.get(id);
    if (!t || s.mount !== undefined) continue; // men aboard are behind armour (M7)
    // Like their rounds, men's own side's bursts do not suppress them (they know they are coming; the blast
    // itself still stuns and wounds).
    if (ownerSide !== undefined && state.identity.get(id)?.side === ownerSide) continue;
    const dx = t.x - x, dy = t.y - y, dd = dx * dx + dy * dy;
    if (dd > R * R) continue;
    addSuppression(ctx, s, SUP.blastFactor * (1 - sqrt(dd) / R));
  }
}

/**
 * A mortar round of `side` has burst (soldier AI package B, called by the fire support system): every man on foot
 * of the other side within `soldier.beatenNoticeM` remembers where that mission is falling (one zone per man: a
 * burst far from the one he remembers, or after his memory has lapsed, starts a new one).
 */
export function noteBeatenZone(ctx: SimContext, state: SimState, x: number, y: number, side: string): void {
  const S = ctx.catalog.behaviour.soldier, r2 = S.beatenNoticeM * S.beatenNoticeM;
  const memory = secondsToTicks(S.beatenMemorySeconds);
  for (const [id, s] of state.soldier.entries()) {
    if (!isAble(s) || s.mount !== undefined || state.identity.get(id)?.side === side) continue;
    const t = state.transform.get(id);
    if (!t) continue;
    const dx = t.x - x, dy = t.y - y;
    if (dx * dx + dy * dy > r2) continue;
    const b = s.beaten;
    if (b && state.tick - b.tick <= memory && sqrt((b.x - x) * (b.x - x) + (b.y - y) * (b.y - y)) <= S.beatenNoticeM) {
      b.x = (b.x * b.n + x) / (b.n + 1); b.y = (b.y * b.n + y) / (b.n + 1); b.n++; b.tick = state.tick;
    } else s.beaten = { x, y, tick: state.tick, n: 1, left: false };
  }
}

/** His unit has lost its leader: every man of it takes the blow; a platoon's loss reaches its squads by radio. */
export function leaderLost(ctx: SimContext, state: SimState, unitId: EntityId, leader?: EntityId): void {
  const M = ctx.catalog.behaviour.morale;
  const u = state.unit.get(unitId);
  if (!u) return;
  u.morale.bond = Math.max(0, u.morale.bond - M.unit.bondLeaderLost);
  // mounted: ok losing the leader shakes every man; a man aboard a closed hull only when the leader fell inside it
  // (owner 2026-11-13, "only own vehicle"); the strain reaches every man (they hear it on the radio)
  const inside = leader === undefined ? undefined : state.soldier.get(leader)?.mount?.vehicle;
  for (const m of unitSoldiers(state, unitId)) {
    const s = state.soldier.get(m);
    if (!s || m === leader) continue;
    const mv = s.mount?.vehicle;
    const feels = !(mv !== undefined && leader !== undefined && mv !== inside);
    const own = state.identity.get(m)?.unit === unitId;
    const sub = own ? 1 : M.shock.leaderLostSubUnit;
    kick(ctx, state, m, feels ? M.shock.leaderLost * sub : 0, M.strain.leaderLost * sub, SRC.leaderLost!);
  }
  // A platoon (a unit with sub-units) lost its leader: its squad leaders take a further blow.
  if (u.children.length > 0) for (const c of u.children) {
    const cl = state.unit.get(c)?.leader ?? null;
    if (cl !== null) kick(ctx, state, cl, M.shock.platoonLeaderLost, M.strain.platoonLeaderLost, SRC.leaderLost!);
  }
}

/** Pinned or panicked: he lies flat and stays where he is (a panicked man running back moves on a `bolt` way). */
export function isCowering(s: SoldierState): boolean {
  return s.mental.behaviour === "pinned" || s.mental.behaviour === "panicked";
}

/** Factor on his rate of fire from his state (1 = unaffected, 0 = does not fire). */
export function fireRateFactor(ctx: SimContext, s: SoldierState): number {
  const E = ctx.catalog.behaviour.effects;
  switch (s.mental.behaviour) {
    case "panicked": case "routed": case "surrendered": return 0;
    case "pinned": return E.pinnedFireRateFactor;
    case "shaken": return E.shakenFireRateFactor;
    default: return 1;
  }
}

/** Factor on his aiming error from his state (shaken: he aims worse). */
export function aimErrorFactor(ctx: SimContext, s: SoldierState): number {
  return s.mental.behaviour === "shaken" ? 1 / ctx.catalog.behaviour.morale.effects.shakenAimFactor : 1;
}

/** The suppression that pins him: his quality's, lower when he is shaken. */
function pinLevel(ctx: SimContext, state: SimState, id: EntityId, s: SoldierState): number {
  const S = ctx.catalog.behaviour.morale.states;
  return qualityMorale(ctx, state, id).pinSuppression - (s.mental.behaviour === "shaken" ? S.shakenPinShift : 0);
}

function nextBehaviour(ctx: SimContext, state: SimState, id: EntityId, s: SoldierState): Behaviour {
  const M = ctx.catalog.behaviour.morale, S = M.states, m = s.mental, mo = m.morale, sup = m.suppression;
  const panicAt = S.panic + M.nerve.panicPer * (0.5 - m.nerve);
  if (m.behaviour === "panicked" && (state.tick - m.panicTick < secondsToTicks(S.panicHoldS) || mo < S.unpanic)) return "panicked";
  if (mo < panicAt) return "panicked";
  const pinS = pinLevel(ctx, state, id, s);
  if (sup >= pinS || (mo < S.pinnedMorale && sup >= S.pinnedMoraleSuppression)) return "pinned";
  if (m.behaviour === "pinned" && !(sup < pinS - S.unpinGap && mo >= S.unpinMorale)) return "pinned";
  if (mo < S.shaken) return "shaken";
  if ((m.behaviour === "shaken" || m.behaviour === "pinned" || m.behaviour === "panicked" || m.behaviour === "cautious") && mo < S.unshaken) return "shaken";
  return "steady";
}

/** Where the enemy he knows is (mean of his live contacts), or null. */
function enemyCentre(s: SoldierState): { x: number; y: number } | null {
  let sx = 0, sy = 0, n = 0;
  for (const c of s.contacts) { if (c.surrendered || c.down || c.wreck) continue; sx += c.x; sy += c.y; n++; }
  return n > 0 ? { x: sx / n, y: sy / n } : null;
}

/** A seen enemy within `r` metres? */
function enemySeenWithin(state: SimState, id: EntityId, s: SoldierState, r: number): boolean {
  const t = state.transform.get(id);
  if (!t) return false;
  for (const e of s.seen) {
    const q = state.transform.get(e.target);
    if (q && (q.x - t.x) * (q.x - t.x) + (q.y - t.y) * (q.y - t.y) <= r * r) return true;
  }
  return false;
}

/** Panicked and not pinned down by fire: he runs back from the enemy he knows (a bolt way: pinning does not hold it). */
function startFlight(ctx: SimContext, state: SimState, id: EntityId, s: SoldierState): boolean {
  const S = ctx.catalog.behaviour.morale.states;
  if (s.mount !== undefined || s.carrying !== undefined || s.atNest !== undefined || !s.impair.canWalk) return false;
  if (s.mental.suppression >= S.cowerSuppression || enemySeenWithin(state, id, s, S.cowerEnemyM)) return false;
  const e = enemyCentre(s), t = state.transform.get(id), mv = state.mover.get(id);
  if (!e || !t || !mv) return false;
  const dx = t.x - e.x, dy = t.y - e.y, L = sqrt(dx * dx + dy * dy) || 1;
  const run = S.fleeMinM + (S.fleeMaxM - S.fleeMinM) * s.mental.nerve;
  const gx = Math.min(Math.max(t.x + (dx / L) * run, 5), ctx.map.widthM - 5), gy = Math.min(Math.max(t.y + (dy / L) * run, 5), ctx.map.heightM - 5);
  const leg = routeBetween(ctx, navFor(ctx, "foot").search, t.x, t.y, gx, gy, { maxExpansions: S.fleeMaxExpansions, snapCells: 3 }, { sz: t.z, gz: 0 });
  if (!leg) return false;
  mv.waypoints = routeWaypoints(leg, { x: 0, y: 0, mode: "run", bolt: true as const }).map((w) => ({ ...w, posture: "crouching" as const }));
  mv.formation = null; mv.endPosture = "prone"; mv.endHeading = atan2(e.y - leg.goalY, e.x - leg.goalX);
  state.fire.delete(id);
  s.intent = null;
  s.mental.flee = { x: leg.goalX, y: leg.goalY, untilTick: state.tick + secondsToTicks(S.fleeSeconds) };
  return true;
}

/** A fleeing man stops: arrived, run out of time, or no longer panicked. He lies down where he is. */
function endFlight(ctx: SimContext, state: SimState, id: EntityId, s: SoldierState): void {
  s.mental.flee = null;
  const mv = state.mover.get(id);
  if (mv && mv.waypoints.length > 0 && mv.waypoints[mv.waypoints.length - 1]!.bolt === true) { mv.waypoints = []; mv.speedMps = 0; }
  if (isAble(s) && s.posture !== "prone" && s.evade === null) requestPosture(ctx, state, id, "prone");
}

// ---------------------------------------------------------------------------------------------- rally (action)

/** A leader rallies a man of his unit: params { soldier }. He shouts and gestures, crouching (exposed). */
registerActionHandler("rally", {
  check(ctx, state, actor, a) {
    const R = ctx.catalog.behaviour.morale.rally;
    const l = state.soldier.get(actor), t = Number(a.params["soldier"]), s = state.soldier.get(t);
    if (!l || !isAble(l) || isCowering(l) || l.mental.behaviour === "routed") return "unable";
    if (!s || !isAble(s)) return "gone";
    if (d2(state, actor, t) > (R.rangeM + 5) * (R.rangeM + 5)) return "out-of-reach";
    return null;
  },
  complete(ctx, state, actor, a, events) {
    const t = Number(a.params["soldier"]);
    const s = state.soldier.get(t), l = state.soldier.get(actor);
    if (!s || !l || !isAble(s)) return;
    rallyMan(ctx, state, t, s, l.skills["leadership"] ?? ctx.catalog.behaviour.morale.damp.defaultLeadership, events, actor, 1);
  },
});

/** The effect of a rally on one man (`share`: 1 for his own leader's rally, half for a squad rally). */
function rallyMan(ctx: SimContext, state: SimState, id: EntityId, s: SoldierState, L: number, events: EventSink, leader: EntityId, share: number): void {
  const R = ctx.catalog.behaviour.morale.rally;
  const m = s.mental;
  const f = 1 - share * R.shockCut * L * (1 - m.suppression);
  scaleWhy(s, f, false);
  m.stress *= f;
  relieveStrain(s, share * R.strain);
  m.rallyTick = state.tick;
  m.panicTick = -1e9; // the minimum hold of panic is over
  if (m.flee) endFlight(ctx, state, id, s);
  m.morale = moraleOf(ctx, state, id, s);
  events.emit({ kind: "morale.rally", tick: state.tick, leader, soldier: id });
}

/** Squad rally: the leader above a broken unit, near it, gets it back on its feet (8 s). params { unit } */
registerActionHandler("rallyUnit", {
  check(ctx, state, actor, a) {
    const R = ctx.catalog.behaviour.morale.rally;
    const l = state.soldier.get(actor), u = state.unit.get(Number(a.params["unit"]));
    if (!l || !isAble(l) || isCowering(l) || l.mental.behaviour === "routed") return "unable";
    if (!u || !u.broken) return "done";
    const c = centreOf(state, unitSoldiers(state, Number(a.params["unit"])).filter((m) => isAble(state.soldier.get(m)) && state.soldier.get(m)!.mount === undefined));
    const t = state.transform.get(actor);
    if (!c || !t || (c.x - t.x) * (c.x - t.x) + (c.y - t.y) * (c.y - t.y) > (R.squadRangeM + 10) * (R.squadRangeM + 10)) return "out-of-reach";
    return null;
  },
  complete(ctx, state, actor, a, events) {
    const uid = Number(a.params["unit"]), l = state.soldier.get(actor);
    if (!l) return;
    const M = ctx.catalog.behaviour.morale, L = l.skills["leadership"] ?? M.damp.defaultLeadership;
    // mounted: ok (morale rework) men aboard are counted; each blow below says whether it reaches them
    for (const m of unitSoldiers(state, uid)) {
      const s = state.soldier.get(m);
      if (s && isAble(s)) rallyMan(ctx, state, m, s, L, events, actor, M.rally.squadShare);
    }
    rallyRouted(ctx, state, uid, events);
  },
});

function centreOf(state: SimState, men: EntityId[]): { x: number; y: number } | null {
  let sx = 0, sy = 0, n = 0;
  for (const m of men) { const t = state.transform.get(m); if (t) { sx += t.x; sy += t.y; n++; } }
  return n > 0 ? { x: sx / n, y: sy / n } : null;
}

// ---------------------------------------------------------------------------------------------- events

function sideOfOwner(state: SimState, owner: EntityId): string | undefined {
  return state.identity.get(owner)?.side ?? state.vehicle.get(owner)?.side;
}

/** Top unit of a unit. */
function topOf(state: SimState, uid: EntityId): EntityId {
  let u = uid;
  for (let p = state.unit.get(u)?.parent ?? null; p !== null; p = state.unit.get(u)?.parent ?? null) u = p;
  return u;
}

/**
 * A man of this unit fell (down, killed or given up): the loss is booked on his unit and every unit above it, ONCE per
 * man (`mental.lossBooked`): a man who goes down and later dies, or goes down and then gives up, is one loss.
 * Returns false when he was booked already.
 */
function bookLoss(ctx: SimContext, state: SimState, victim: EntityId, uid: EntityId): boolean {
  const s = state.soldier.get(victim);
  if (s) { if (s.mental.lossBooked) return false; s.mental.lossBooked = true; }
  const SH = ctx.catalog.behaviour.morale.shock, win = secondsToTicks(SH.rapidWindowS);
  for (let u: EntityId | null = uid; u !== null; u = state.unit.get(u)?.parent ?? null) {
    const un = state.unit.get(u);
    if (!un) break;
    un.morale.lost++;
    const r = un.morale.recent.filter((t) => state.tick - t <= win);
    r.push(state.tick);
    un.morale.recent = r.slice(-SH.recentMax);
  }
  return true;
}

/** A man booked as a loss came round (not a prisoner): he is no loss any more (wounds.ts). */
export function unbookLoss(state: SimState, id: EntityId): void {
  const s = state.soldier.get(id), i = state.identity.get(id);
  if (!s || !s.mental.lossBooked || s.captive !== null || !i) return;
  s.mental.lossBooked = false;
  for (let u: EntityId | null = i.unit; u !== null; u = state.unit.get(u)?.parent ?? null) {
    const un = state.unit.get(u);
    if (!un) break;
    un.morale.lost = Math.max(0, un.morale.lost - 1);
  }
}

function onCasualty(ctx: SimContext, state: SimState, victim: EntityId, killed: boolean, tickEvents: readonly SimEvent[]): void {
  const M = ctx.catalog.behaviour.morale, SH = M.shock, ST = M.strain;
  const vi = state.identity.get(victim), at = state.transform.get(victim);
  if (!vi || !at) return;
  const vs = state.soldier.get(victim);
  // Down already (now dead of his wounds, or a prisoner): his comrades took that blow when he fell.
  if (!bookLoss(ctx, state, victim, vi.unit)) return;
  const vTop = topOf(state, vi.unit);
  const inside = vs?.mount?.vehicle;
  const vu = state.unit.get(vi.unit)!;
  const rapid = vu.morale.recent.length - 1; // losses of his unit in the window before this one
  const full2 = SH.fullM * SH.fullM, zero2 = SH.zeroM * SH.zeroM;
  // Who hit him (relief for the shooter).
  let shooter: EntityId | null = null;
  for (const e of tickEvents) if (e.kind === "hit" && e.target === victim) shooter = e.owner;
  // mounted: ok (morale rework) men aboard are counted; each blow below says whether it reaches them
  for (const [id, s] of state.soldier.entries()) {
    if (id === victim || !isAble(s)) continue;
    const ident = state.identity.get(id);
    if (!ident) continue;
    const t = state.transform.get(id);
    if (ident.side === vi.side) {
      const rel = ident.unit === vi.unit ? SH.relation.squad : topOf(state, ident.unit) === vTop ? SH.relation.platoon : SH.relation.other;
      let fall = 0;
      if (s.mount !== undefined) {
        // mounted: ok men aboard a closed hull feel only a comrade falling inside it (owner 2026-11-13, "only own vehicle")
        if (s.mount.vehicle === inside) fall = 1;
      } else if (t && inside === undefined) {
        const dd = (t.x - at.x) * (t.x - at.x) + (t.y - at.y) * (t.y - at.y);
        fall = dd <= full2 ? 1 : dd >= zero2 ? 0 : (SH.zeroM - sqrt(dd)) / (SH.zeroM - SH.fullM);
      }
      const k = gainFactor(ctx, state, id, s);
      if (fall > 0) addShock(s, (killed ? SH.killed : SH.incapacitated) * rel * fall, SRC.comradeHit!, k);
      // The strain of a loss reaches his own platoon's men on foot (aboard: only those in his hull).
      if (s.mount === undefined || s.mount.vehicle === inside) {
        if (topOf(state, ident.unit) === vTop) addStrain(s, (killed ? ST.killed : ST.incapacitated) * rel, SRC.squadLosses!, k);
        // Losses in quick succession: each beyond the first in the window shakes the whole squad more.
        if (ident.unit === vi.unit && rapid > 0) addShock(s, SH.rapidLossExtra * rapid, SRC.comradeHit!, k);
      }
    } else if (t && s.mount === undefined) {
      // Relief: an enemy his squad knows of went down within reach.
      const R = M.relief;
      if ((t.x - at.x) * (t.x - at.x) + (t.y - at.y) * (t.y - at.y) > R.enemyDownM * R.enemyDownM) continue;
      if (id === shooter) { relieveShock(s, R.enemyDownByHim); continue; }
      if (s.contacts.some((c) => c.target === victim)) relieveShock(s, R.enemyDown);
    }
  }
}

/** An own-side burst near a contact his unit holds: relief, at most `supportCapPerMin` a minute per unit. */
function onBurst(ctx: SimContext, state: SimState, x: number, y: number, ammo: string, owner: EntityId): void {
  const M = ctx.catalog.behaviour.morale, SH = M.shock, R = M.relief;
  const am = ctx.catalog.ammo[ammo];
  if (!am || am.diameterM < SH.indirectMinDiameterM) return;
  const side = sideOfOwner(state, owner);
  const heavy = am.diameterM >= SH.heavyDiameterM ? SH.heavyFactor : 1;
  const r2 = SH.indirectM * SH.indirectM, s2 = R.supportM * R.supportM;
  const minute = secondsToTicks(60);
  for (const [, u] of state.unit.entries()) {
    if (u.side === side) {
      // own support: relief for a unit holding a contact near the burst
      if (u.members.length === 0) continue;
      let near = false;
      for (const m of u.members) {
        const s = state.soldier.get(m);
        if (!s || !isAble(s)) continue;
        for (const c of s.contacts) if (!c.down && !c.surrendered && (c.x - x) * (c.x - x) + (c.y - y) * (c.y - y) <= s2) { near = true; break; }
        if (near) break;
      }
      if (!near) continue;
      if (state.tick - u.morale.supportTick > minute) { u.morale.supportTick = state.tick; u.morale.support = 0; }
      if (u.morale.support >= R.supportCapPerMin) continue;
      u.morale.support += R.supportPerRound;
      for (const m of u.members) { const s = state.soldier.get(m); if (s && isAble(s)) relieveShock(s, R.supportPerRound); }

    } else {
      // enemy (or unknown) burst: dread of indirect fire for men on foot near it
      for (const m of u.members) {
        const s = state.soldier.get(m), t = state.transform.get(m);
        if (!s || !t || !isAble(s) || s.mount !== undefined) continue;
        const dd = (t.x - x) * (t.x - x) + (t.y - y) * (t.y - y);
        if (dd > r2) continue;
        addShock(s, SH.indirect * heavy * (1 - sqrt(dd) / SH.indirectM), SRC.artillery!, gainFactor(ctx, state, m, s));
      }
    }
  }
}

/** The blows and relief of these events (the system runs it on each tick's events; labs and tests call it directly). */
export function moraleKicks(ctx: SimContext, state: SimState, tickEvents: readonly SimEvent[]): void { eventKicks(ctx, state, tickEvents); }

function eventKicks(ctx: SimContext, state: SimState, tickEvents: readonly SimEvent[]): void {
  const M = ctx.catalog.behaviour.morale, SH = M.shock, ST = M.strain, R = M.relief;
  for (const e of tickEvents) {
    switch (e.kind) {
      case "wound": {
        if (e.mechanism === "blunt") break;
        const s = state.soldier.get(e.soldier);
        if (!s || !isAble(s)) break;
        const k = gainFactor(ctx, state, e.soldier, s);
        addShock(s, SH.woundBase + SH.woundPerSeverity * e.severity, SRC.wounded!, k);
        addStrain(s, ST.woundPerSeverity * e.severity, SRC.wounded!, k);
        break;
      }
      case "casualty": onCasualty(ctx, state, e.soldier, e.status === "killed", tickEvents); break;
      case "surrendered": {
        const i = state.identity.get(e.soldier);
        if (i) bookLoss(ctx, state, e.soldier, i.unit);
        // The enemy who sees it takes heart as at a man going down.
        const at = state.transform.get(e.soldier);
        if (at) for (const [id, s] of state.soldier.entries()) {
          if (!isAble(s) || state.identity.get(id)?.side === e.side || s.mount !== undefined) continue;
          if (s.contacts.some((c) => c.target === e.soldier) && d2(state, id, e.soldier) <= R.enemyDownM * R.enemyDownM) relieveShock(s, R.enemyDown);
        }
        break;
      }
      case "vehicle.hit": {
        // Men aboard take a blow from hits on their own hull (owner 2026-11-13): a penetration, or a heavy round or
        // a burst that the armour stops (rifle-calibre strikes, aggregated, do not count).
        const pen = e.result === "penetrated";
        const am = ctx.catalog.ammo[e.ammo];
        const a = pen ? SH.ownPenetrated : am !== undefined && (am.diameterM >= 0.0125 || am.explosive !== undefined) ? SH.ownStruck : 0;
        const v = a > 0 ? state.vehicle.get(e.vehicle) : undefined;
        if (v) for (const id of v.seats) if (id !== null && id !== undefined) kick(ctx, state, id, a, pen ? M.strain.ownPenetrated : 0, SRC.armour!, SRC.squadLosses!);
        break;
      }
      case "vehicle.destroyed": {
        const v = state.vehicle.get(e.vehicle), at = state.transform.get(e.vehicle);
        if (!v || !at) break;
        const r2 = SH.ownVehicleLostM * SH.ownVehicleLostM;
        for (const [id, s] of state.soldier.entries()) {
          if (!isAble(s) || state.identity.get(id)?.side !== v.side || s.mount?.vehicle === e.vehicle) continue;
          const t = state.transform.get(id);
          if (t && (t.x - at.x) * (t.x - at.x) + (t.y - at.y) * (t.y - at.y) <= r2) addShock(s, SH.ownVehicleLost, SRC.armour!, gainFactor(ctx, state, id, s));
        }
        break;
      }
      case "explosion": onBurst(ctx, state, e.x, e.y, e.ammo, e.owner); break;
      case "medical.treated": {
        // A comrade being treated nearby: relief for his squad mates around.
        const ci = state.identity.get(e.casualty);
        if (!ci || !e.success) break;
        const mr = R.medicM * R.medicM;
        for (const m of state.unit.get(ci.unit)?.members ?? []) {
          if (m === e.casualty) continue;
          const s = state.soldier.get(m);
          if (s && isAble(s) && s.mount === undefined && d2(state, m, e.casualty) <= mr) relieveShock(s, R.medic);
        }
        break;
      }
      case "medical.evacuated": {
        const ci = state.identity.get(e.casualty);
        const u = ci ? state.unit.get(ci.unit) : undefined;
        if (!u) break;
        u.morale.bond = Math.min(1, u.morale.bond + M.unit.bondEvacuated);
        for (const m of u.members) { const s = state.soldier.get(m); if (s && isAble(s)) relieveStrain(s, R.evacuatedStrain); }
        break;
      }
      case "radio": {
        if (e.key !== "radio.broken") break;
        // An enemy unit has broken: heart for the men facing it.
        const at = state.transform.get(e.from);
        if (!at) break;
        const r2 = R.enemyBrokeM * R.enemyBrokeM;
        // mounted: ok (morale rework) men aboard are counted; each blow below says whether it reaches them
        for (const [id, s] of state.soldier.entries()) {
          if (!isAble(s) || state.identity.get(id)?.side === e.side) continue;
          const t = state.transform.get(id);
          if (t && (t.x - at.x) * (t.x - at.x) + (t.y - at.y) * (t.y - at.y) <= r2) { relieveShock(s, R.enemyBroke); relieveStrain(s, R.enemyBrokeStrain); }
        }
        break;
      }
      default: break;
    }
  }
}

// ---------------------------------------------------------------------------------------------- the man's step

/** His squad has an anti-tank weapon with a round (halves the dread of tanks). */
function squadHasAt(ctx: SimContext, state: SimState, u: Unit): boolean {
  for (const m of u.members) if (isAble(state.soldier.get(m)) && launcherRound(ctx, state, m) !== null) return true;
  return false;
}

function stepMan(ctx: SimContext, state: SimState, events: EventSink, id: EntityId, s: SoldierState, dt: number): void {
  const M = ctx.catalog.behaviour.morale, SH = M.shock, ST = M.strain, RC = M.recovery;
  const m = s.mental;
  const u = unitOf(state, id);
  const sit = situation(ctx, state, id, s);
  const k = sit.k;
  // ---- gains
  // (Fire alone, without losses, holds a man down but seldom breaks him: its share is capped, `underFireCap`.)
  if ((m.why[SRC.underFire!] ?? 0) < SH.underFireCap) addShock(s, SH.fromSuppressionPerS * m.suppression * dt + SH.nearMissFactor * m.jolt, SRC.underFire!, k);
  m.jolt = 0;
  const capped = (src: number, perS: number, cap: number) => { if ((m.why[src] ?? 0) < cap) addShock(s, perS * dt, src, k); };
  if (s.mount === undefined) {
    // alone: no able mate of his unit within isolatedM (only in a unit of more than one able man)
    if (u && sit.nearest2 > SH.isolatedM * SH.isolatedM && sit.nearest2 < Infinity) capped(SRC.isolated!, SH.isolatedPerS, SH.isolatedCap);
    if (u?.morale.flanked) capped(SRC.flanked!, SH.flankedPerS, SH.flankedCap);
    if (enemySeenWithin(state, id, s, SH.enemyCloseM)) addShock(s, SH.enemyClosePerS * dt, SRC.enemyClose!, k);
    // enemy armour he knows of within armourM
    const t = state.transform.get(id);
    if (t && (m.why[SRC.armour!] ?? 0) < SH.armourCap) {
      const a2 = SH.armourM * SH.armourM;
      for (const c of s.contacts) {
        if (c.cls !== "vehicle" || c.wreck) continue;
        if ((c.x - t.x) * (c.x - t.x) + (c.y - t.y) * (c.y - t.y) > a2) continue;
        addShock(s, SH.armourPerS * dt * (u && squadHasAt(ctx, state, u) ? SH.armourWithAtFactor : 1), SRC.armour!, k);
        break;
      }
    }
  }
  // his own wounds untreated
  if (s.wounds.some((w) => w.mechanism !== "blunt" && w.treatments.length === 0)) capped(SRC.wounded!, SH.untreatedPerS, SH.untreatedCap + SH.woundBase);
  // comrades of his unit left lying with nobody coming
  if (u && u.morale.uncared > 0 && u.morale.uncaredSince >= 0 && state.tick - u.morale.uncaredSince >= secondsToTicks(SH.uncaredAfterS)) {
    capped(SRC.uncared!, SH.uncaredPerS * u.morale.uncared, SH.uncaredCap);
  }
  // ---- recovery
  const beaten = s.beaten !== undefined && !s.beaten.left && state.tick - s.beaten.tick <= secondsToTicks(ctx.catalog.behaviour.soldier.beatenMemorySeconds);
  const lastLoss = u && u.morale.recent.length > 0 ? u.morale.recent[u.morale.recent.length - 1]! : -1e9;
  const quiet = !beaten && m.suppression < RC.quietBelowSuppression && state.tick - lastLoss >= secondsToTicks(RC.quietAfterLossS);
  const tau = beaten ? 0 : quiet ? RC.quietTauS : m.suppression < RC.lightBelowSuppression ? RC.lightTauS : 0;
  if (tau > 0 && m.stress > 0) {
    const f = Math.max(0, 1 - (dt * sit.r) / tau);
    m.stress *= f;
    scaleWhy(s, f, false);
  }
  if (quiet && m.strain > 0) {
    const f = Math.max(0, 1 - (dt * sit.r) / ST.tauQuietS);
    m.strain *= f;
    scaleWhy(s, f, true);
  }
  // the floor of his squad's losses
  const floor = ST.lossFloorPerRatio * lossShare(u);
  if (m.strain < floor) { m.why[SRC.squadLosses!] = (m.why[SRC.squadLosses!] ?? 0) + floor - m.strain; m.strain = floor; }
  // fatigue as a reason (it lowers his resolve)
  m.why[SRC.fatigue!] = qualityMorale(ctx, state, id).fatigueCost * Math.max(0, s.physical.fatigue - M.fatigue.from);
  m.morale = moraleOf(ctx, state, id, s);
  // ---- state
  if (m.behaviour === "routed") return; // a routed man stays so until his unit rallies (drills)
  // A fleeing man: arrived or out of time, he cowers where he is.
  if (m.flee) {
    const mv = state.mover.get(id);
    const going = mv !== undefined && mv.waypoints.length > 0 && mv.waypoints[mv.waypoints.length - 1]!.bolt === true;
    if (!going || state.tick >= m.flee.untilTick || m.behaviour !== "panicked" || s.mount !== undefined) endFlight(ctx, state, id, s);
  }
  const next = nextBehaviour(ctx, state, id, s);
  if (next === m.behaviour) return;
  const from = m.behaviour;
  m.behaviour = next;
  if (next === "panicked") { m.panicTick = state.tick; startFlight(ctx, state, id, s); }
  else if (m.flee) endFlight(ctx, state, id, s);
  events.emit({ kind: "behaviour.changed", tick: state.tick, soldier: id, from, to: next });
  if (isCowering(s) && !m.flee && s.posture !== "prone" && s.evade === null) requestPosture(ctx, state, id, "prone");
}

// ---------------------------------------------------------------------------------------------- the unit's step

const SHAKEN_OR_WORSE = (b: Behaviour) => b === "shaken" || b === "pinned" || b === "panicked" || b === "routed";

/**
 * The last tick a man of this unit came under fire: its own men (`ownFireTick`, stamped for every unit, a squad on
 * foot or a crew that bailed out included) or, for a top unit or a crew, any man under it (`underFireTick`).
 */
export function firedOnTick(u: Unit): number {
  return Math.max(u.underFireTick, u.ownFireTick ?? -1e9);
}

function stepUnit(ctx: SimContext, state: SimState, events: EventSink, uid: EntityId, u: Unit, flankNow: boolean): void {
  const M = ctx.catalog.behaviour.morale, U = M.unit, mo = u.morale;
  // mounted: ok (morale rework) men aboard are counted; each blow below says whether it reaches them
  const men = unitSoldiers(state, uid);
  // (`nOwn`/`panickedOwn`: the men not in a broken sub-unit. A sub-unit's rout is its own break; it counts toward the
  // parent's through the "half its squads broken" rule, not again as panic in the parent's share.)
  let sum = 0, n = 0, shaken = 0, pinned = 0, nOwn = 0, panickedOwn = 0, uncared = 0;
  for (const m of men) {
    const s = state.soldier.get(m)!;
    if (isAble(s)) {
      n++; sum += s.mental.morale;
      const b = s.mental.behaviour;
      if (SHAKEN_OR_WORSE(b)) shaken++;
      if (b === "pinned" || b === "panicked" || b === "routed") pinned++;
      const mu = state.identity.get(m)?.unit;
      if (mu !== uid && mu !== undefined && state.unit.get(mu)?.broken === true) continue;
      nOwn++;
      if (b === "panicked" || b === "routed") panickedOwn++;
    } else if (s.physiology.alive && !isCaptive(s) && s.careWait !== undefined && u.members.includes(m)) uncared++;
  }
  // comrades left lying: the count, since when, and the bond lost once for each newly left man
  if (uncared > mo.uncared && mo.uncaredSince >= 0 && state.tick - mo.uncaredSince >= secondsToTicks(M.shock.uncaredAfterS)) mo.bond = Math.max(0, mo.bond - U.bondUncared * (uncared - mo.uncared));
  if (uncared === 0) mo.uncaredSince = -1; else if (mo.uncaredSince < 0) mo.uncaredSince = state.tick;
  mo.uncared = uncared;
  mo.value = n > 0 ? sum / n : 0;
  const fired = firedOnTick(u);
  if (mo.firstContact === -1 && fired >= 0) mo.firstContact = fired;
  if (mo.value < U.brokenValue && n > 0) { if (mo.lowSince < 0) mo.lowSince = state.tick; } else mo.lowSince = -1;
  // ---- flanking (every flankStepSeconds)
  if (flankNow) {
    const was = mo.flanked;
    mo.flanked = flanked(ctx, state, men, u.parent === null ? men : unitSoldiers(state, topOf(state, uid)));
    if (mo.flanked && !was) {
      mo.flankTick = state.tick;
      for (const m of u.members) { const s = state.soldier.get(m); if (s && isAble(s) && s.mount === undefined) addStrain(s, M.strain.flanked, SRC.flanked!, gainFactor(ctx, state, m, s)); }
    }
  }
  // ---- state
  let broken = u.broken;
  if (!broken && n > 0) {
    // No break in its first minutes under fire (unless it has lost heavily; never so for a top unit, whose break
    // ends the battle), nor in the same span after it rallied (not even for heavy losses).
    const rallied = mo.rallied >= 0 && state.tick - mo.rallied < secondsToTicks(U.minBreakSeconds);
    const guard = mo.firstContact === -1 || state.tick - mo.firstContact < secondsToTicks(U.minBreakSeconds) || rallied;
    const heavyLoss = u.parent !== null && !rallied && lossShare(u) >= U.earlyBreakLossShare;
    let squadsBroken = 0, squads = 0;
    for (const c of u.children) { const cu = state.unit.get(c); if (!cu || cu.vehicle !== undefined || cu.asset !== undefined) continue; squads++; if (cu.broken) squadsBroken++; }
    const breaks = (panickedOwn > 0 && panickedOwn >= U.brokenPanicShare * nOwn)
      || (mo.lowSince >= 0 && state.tick - mo.lowSince >= secondsToTicks(U.brokenForS))
      || (squads > 1 && squadsBroken >= U.brokenSquadShare * squads);
    // A top unit (its break loses the battle) breaks only once it has lost `topBreakLossShare` of its men (killed,
    // incapacitated, given up; Dupuy Institute breakpoint extracts: about a fifth for an attacker, more for a defender:
    // `topBreakLossShareDefence` for a side whose posture is "defend").
    const defends = state.sides.find((sd) => sd.id === u.side)?.posture === "defend";
    const topHolds = u.parent === null && lossShare(u) < (defends ? U.topBreakLossShareDefence : U.topBreakLossShare);
    if (breaks && (!guard || heavyLoss) && !topHolds) broken = true;
  }
  const prev = mo.state;
  mo.state = broken ? "broken" : n > 0 && pinned >= U.pinnedShare * n ? "pinned" : n > 0 && (mo.value < U.shakenValue || shaken >= U.shakenShare * n) ? "shaken" : "steady";
  // (A unit that breaks reports it itself, drills.ts "radio.broken".)
  if (prev === "steady" && mo.state === "shaken" && u.vehicle === undefined && state.tick - mo.radioTick >= secondsToTicks(M.rally.radioSpacingS)) {
    mo.radioTick = state.tick;
    radioFrom(state, uid, "radio.squadShaken", events);
  }
  // ---- rally: the leader picks his worst-off man
  rallyStep(ctx, state, events, uid, u);
}

function radioFrom(state: SimState, uid: EntityId, key: string, events: EventSink): void {
  const u = state.unit.req(uid);
  // (M11.6: a flat radio sends nothing; recorded lines such as "radio.broken" always go: comms.ts sendsRadio.)
  if (!sendsRadio(state, uid, key)) return;
  const from = u.leader !== null && isAble(state.soldier.get(u.leader)) ? u.leader : u.members.find((m) => isAble(state.soldier.get(m)));
  if (from !== undefined) events.emit({ kind: "radio", tick: state.tick, side: u.side, from, key, params: { callsign: u.callsign } });
}

/**
 * Enemy known on two sides or behind (geometry around the unit's centre). `pool`: the men whose contacts count (its
 * whole top unit: a squad knows what the platoon has reported).
 */
function flanked(ctx: SimContext, state: SimState, men: EntityId[], pool: EntityId[]): boolean {
  const U = ctx.catalog.behaviour.morale.unit;
  const able = men.filter((m) => { const s = state.soldier.get(m); return isAble(s) && s!.mount === undefined; });
  const c = centreOf(state, able);
  if (!c) return false;
  const c2 = U.contactM * U.contactM, f2 = U.flankM * U.flankM;
  const angs: number[] = [], near: boolean[] = [];
  let sx = 0, sy = 0;
  const seen = new Set<EntityId>();
  for (const m of pool) {
    const ps = state.soldier.get(m);
    if (!ps || !isAble(ps)) continue;
    for (const k of ps.contacts) {
    if (k.down || k.surrendered || k.wreck || seen.has(k.target)) continue;
    const dx = k.x - c.x, dy = k.y - c.y, dd = dx * dx + dy * dy;
    if (dd > c2 || dd < 1) continue;
    seen.add(k.target);
    const L = sqrt(dd);
    sx += dx / L; sy += dy / L;
    angs.push(atan2(dy, dx)); near.push(dd <= f2);
    }
  }
  if (angs.length < 2) return false;
  const main = atan2(sy, sx);
  const rear = (U.flankRearDeg * PI) / 180, span = (U.flankSpanDeg * PI) / 180;
  let lo = 0, hi = 0;
  for (let i = 0; i < angs.length; i++) {
    let d = angs[i]! - main;
    while (d > PI) d -= 2 * PI;
    while (d < -PI) d += 2 * PI;
    if (near[i] && Math.abs(d) > rear) return true;
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return hi - lo > span;
}

function rallyStep(ctx: SimContext, state: SimState, events: EventSink, uid: EntityId, u: Unit): void {
  const M = ctx.catalog.behaviour.morale, R = M.rally;
  // Squad rally: a broken sub-unit near its parent's leader.
  if (u.broken && u.drill?.kind === "rout" && u.parent !== null) {
    const pl = state.unit.get(u.parent)?.leader ?? null, ps = pl !== null ? state.soldier.get(pl) : undefined;
    if (pl !== null && ps && isAble(ps) && ps.mount === undefined && !isCowering(ps) && ps.mental.behaviour !== "routed" && !state.action.has(pl)
      && ps.mental.morale >= R.minMorale && ps.mental.suppression < R.maxSuppression) {
      const foot = unitSoldiers(state, uid).filter((m) => isAble(state.soldier.get(m)) && state.soldier.get(m)!.mount === undefined);
      // (Only once its runners have stopped: men still running would be out of his reach before he is done.)
      const running = foot.some((m) => (state.mover.get(m)?.waypoints.length ?? 0) > 0);
      const c = running ? null : centreOf(state, foot);
      const t = state.transform.get(pl);
      if (c && t && (c.x - t.x) * (c.x - t.x) + (c.y - t.y) * (c.y - t.y) <= R.squadRangeM * R.squadRangeM) {
        startAction(state, events, pl, "rallyUnit", secondsToTicks(R.squadSeconds), { unit: uid });
        const pu = state.unit.get(u.parent)!;
        if (state.tick - pu.morale.radioTick >= secondsToTicks(R.radioSpacingS)) { pu.morale.radioTick = state.tick; radioFrom(state, u.parent, "radio.rallying", events); }
        return;
      }
    }
  }
  const lid = u.leader;
  if (lid === null || u.broken) return;
  const l = state.soldier.get(lid);
  if (!l || !isAble(l) || isCowering(l) || l.mental.behaviour === "routed" || state.action.has(lid) || l.mental.morale < R.minMorale || l.mental.suppression >= R.maxSuppression) return;
  if (l.carrying !== undefined || l.intent?.kind === "care") return;
  const spacing = secondsToTicks(R.spacingS), r2 = R.rangeM * R.rangeM;
  let best: EntityId | null = null, bestM = Infinity;
  for (const m of u.members) {
    if (m === lid) continue;
    const s = state.soldier.get(m);
    if (!s || !isAble(s) || !together(s, l) || state.tick - s.mental.rallyTick < spacing) continue;
    const b = s.mental.behaviour;
    if (!(b === "panicked" || b === "pinned" || (b === "shaken" && s.mental.morale < R.targetBelowMorale))) continue;
    // (A man pinned by fire alone, with morale still good, needs no rally: the fire is what holds him.)
    if (b === "pinned" && s.mental.morale >= R.targetBelowMorale) continue;
    if (d2(state, lid, m) > r2) continue;
    if (s.mental.morale < bestM) { bestM = s.mental.morale; best = m; }
  }
  if (best === null) return;
  startAction(state, events, lid, "rally", secondsToTicks(R.seconds), { soldier: best });
  if (l.posture === "prone" && l.mount === undefined && l.evade === null) requestPosture(ctx, state, lid, "crouching");
  if (state.tick - u.morale.radioTick >= secondsToTicks(R.radioSpacingS)) { u.morale.radioTick = state.tick; radioFrom(state, uid, "radio.rallying", events); }
}

// ---------------------------------------------------------------------------------------------- the system

export function moraleSystem(ctx: SimContext, state: SimState, events: EventSink, tickEvents: readonly SimEvent[]): void {
  const B = ctx.catalog.behaviour, M = B.morale;
  // ---- this tick's blows and relief
  eventKicks(ctx, state, tickEvents);
  // ---- each man every stepSeconds (staggered)
  const every = Math.max(1, secondsToTicks(M.stepSeconds)), dt = every / 60;
  // mounted: ok morale and suppression run for every man
  for (let id = staggerFirst(state.tick, every); id < state.nextEntityId; id += every) {
    const s = state.soldier.get(id);
    if (s === undefined) continue;
    s.mental.suppression = Math.max(0, s.mental.suppression - B.suppression.decayPerS * dt);
    if (!isAble(s)) { s.mental.jolt = 0; if (s.mental.flee) s.mental.flee = null; continue; }
    stepMan(ctx, state, events, id, s, dt);
  }
  // ---- each unit every unitStepSeconds
  const ue = Math.max(1, secondsToTicks(M.unitStepSeconds));
  if (state.tick % ue !== 0) return;
  const flankNow = state.tick % Math.max(ue, secondsToTicks(M.unit.flankStepSeconds)) === 0;
  for (const [uid, u] of state.unit.entries()) {
    if (u.asset !== undefined) continue;
    stepUnit(ctx, state, events, uid, u, flankNow);
  }
}

/** The morale value as the UI shows a unit (for tools and tests). */
export function unitMoraleState(u: Unit): Unit["morale"]["state"] { return u.morale.state; }
export type { MoraleDef };
