/**
 * THE SHOOTER (SPEC 6.3): soldiers carrying out a fire order.
 *
 * Each man with a fire task and a working, loaded weapon fires at the rate the range calls for (data:
 * shooting.json bands). Every round is drawn from the magazine in his weapon; an empty magazine means a reload
 * (a timed action) from the magazines he carries; a stoppage means clearing it. Where the round goes follows
 * from his aiming error — skill, posture, fatigue, heart rate, suppression, rate of fire, recoil in a burst,
 * his sight — combined with the weapon's own dispersion and his error in judging the range. No hit tables.
 *
 * Ammunition management (owner decision 2026-11-11): the unit fires at the full rate while it has reason to
 * (the order, incoming fire near it), then slows to a trickle, then ceases fire and reports. A man stops when
 * only the magazine in his weapon is left. In lulls men swap a partly used magazine for a fuller one.
 */
import { onAir } from "../comms";
import { DRONE_SEEN_S, droneInSight, shootAtDrone } from "./drones";
import { startAction } from "../actions";
import { aimErrorFactor, fireRateFactor, isCowering } from "./morale";
import type { Contact, FireTask, SoldierState, WeaponState } from "../components";
import { sight } from "../los";
import type { Posture } from "../orders";
import { loadKg, postureChangeSeconds, requestPosture, thirstAimFactor } from "./body";
import type { WeaponDef } from "../catalog";
import type { SimContext } from "../context";
import type { EventSink, SimEvent } from "../events";
import { secondsToTicks, staggerFirst, TICK_HZ, type EntityId } from "../ids";
import { isAble } from "../impair";
import type { Container } from "../items";
import { atan2, cos, exp, hypot2, PI, pow, sin, sqrt } from "../math";
import { restWithinReach } from "../nav";
import { navFor } from "../navctx";
import { indoorAt } from "../interior-nav";
import { nextFloat, nextNormal, Streams } from "../rng";
import type { SimState } from "../state";
import { heightAt, standZ } from "../terrain";
import { burstCadence, launchShot, pickRound } from "./shot";
import { radioFromTarget, unitSoldiers } from "./orders";
import { isMounted, onRoof, onRoofTop } from "../mount";
import { bodyStrikeT } from "../ballistics";
import { isGuiding } from "./missile-team";
import { protectedContact } from "../protection";
import { beyondSelfDefence, breachActive, noteFireAt, noteShot } from "../conduct";

/** Rounds in the fullest spare magazine of a type (0 if none). */
function fullestSpare(c: Container | undefined, magazine: string): number {
  let best = 0;
  if (c) for (const s of c.stacks) if (s.type === magazine && (s.charge ?? 0) > best) best = s.charge ?? 0;
  return best;
}

/** How far a man's marksmanship moves his errors from the average soldier's (1 = skill 0.5). */
export function skillFactor(ctx: SimContext, marksmanship: number): number {
  const a = ctx.catalog.shooting.aim;
  return Math.max(a.minSkillFactor, 1 + a.skillSlope * (0.5 - marksmanship));
}

/** Aiming error (one standard deviation, mrad) of this shooter right now, before the weapon's own dispersion. */
export function aimErrorMrad(ctx: SimContext, state: SimState, id: EntityId, w: WeaponState, aimed: boolean): number {
  const a = ctx.catalog.shooting.aim, s = state.soldier.req(id);
  const hrMax = ctx.catalog.body.physiology.hrMaxBpm;
  const hr = Math.max(0, (s.physical.heartRateBpm - a.heartRateCalmBpm) / Math.max(1, hrMax - a.heartRateCalmBpm));
  const wdef = ctx.catalog.weapons[w.weapon];
  const sight = wdef?.sights[0]?.kind ?? "iron";
  // A machine gun on its bipod is built for bursts: no penalty for firing fast, and far less climb.
  // (Only with the bipod down: lying, or resting it on something.)
  const tr = state.transform.get(id);
  const sus = wdef?.sustained && (s.posture === "prone" || (tr !== undefined && restWithinReach(navFor(ctx, "foot").grid, tr.x, tr.y))) ? wdef.sustained : undefined;
  // Time spent aiming: the first shots at a new point are hurried.
  const task = state.fire.get(id);
  const settle = task ? 1 + a.settleK * exp(-(state.tick - task.startTick) / (a.settleTauS * TICK_HZ)) : 1;
  // Bracing: off the ground, with a wall, fence, hedge, house wall or tree within arm's reach (his 2 m cell or
  // the next one), he rests the weapon on it (a bipod gun and a prone man are steady already). Which way he
  // fires and how high the thing is are not looked at.
  const t = state.transform.get(id);
  const braced = !sus && s.posture !== "prone" && t !== undefined && restWithinReach(navFor(ctx, "foot").grid, t.x, t.y) ? a.bracedFactor : 1;
  // Firing on the move (assault fire, package D): far worse.
  const mv = state.mover.get(id);
  const onTheMove = task?.onTheMove === true && mv !== undefined && mv.speedMps > 0.2 ? ctx.catalog.behaviour.soldier.assaultFireAimFactor : 1;
  return onTheMove * settle * braced * a.baseMrad * skillFactor(ctx, s.skills["marksmanship"] ?? 0.5) * a.postureFactor[s.posture]
    * (1 + a.fatigueK * s.physical.fatigue) * (s.physical.hydration < 1 ? thirstAimFactor(ctx.catalog, s.physical.hydration) : 1) * (1 + a.heartRateK * hr) * (1 + a.suppressionK * s.mental.suppression)
    * (a.sightFactor[sight] ?? 1) * (aimed || sus ? 1 : a.rapidFactor) * (1 + a.burstGrowth * (sus ? sus.recoilFactor : 1) * w.burstIndex) * s.impair.aim * aimErrorFactor(ctx, s);
}

/** A wall or the ground this close to the point fired at does not count as blocking: it is the target. */
const LINE_OF_FIRE_ALLOWANCE_M = 5;
/** Geometry of the friend-in-line check (not behaviour): the muzzle sits this far out in front of him, a man's body
 * this far from where he stands (more lying down), and a man more than this far above or below is on another floor. */
const MUZZLE_OUT_M = 0.4, BODY_REACH_M = 0.7, FLOOR_APART_M = 1;
/** Balance pass 4 (G): a comrade nearer than this to the shooter shares his spot (a placement artefact), not his line (m). */
const SAME_SPOT_M = 0.15;
/** Margin round a friendly hull in the line of fire (balance pass 3), as a man's body reach. */
const HULL_GROW_M = 0.5;

/**
 * The line from his muzzle (in posture `p`) to a point: 2 clear of ground, walls and roofs (except within the last
 * few metres before the point, which is what he fires at); 1 blocked only by cover within `shortM` before the point,
 * and in the far half of the line (covering fire, overnight pick "covering-fire": his rounds go into the cover the
 * enemy is behind, and still crack past the men there; never a wall in front of his own face); 0 blocked.
 */
export function lineOfFireTo(ctx: SimContext, state: SimState, id: EntityId, x: number, y: number, heightM: number, p: Posture, shortM = 0, from?: { x: number; y: number; z: number }): 0 | 1 | 2 {
  const t = from ?? state.transform.req(id);
  const a0 = atan2(y - t.y, x - t.x);
  const mx = t.x + cos(a0) * 0.4, my = t.y + sin(a0) * 0.4;
  const mz = standZ(ctx.map, t, mx, my) + ctx.catalog.body.postures[p].muzzleHeightM;
  const tz = heightAt(ctx.map, x, y) + heightM; // ground: ok (a point fired at; a man's floor is in heightM)
  const r = sight(ctx, mx, my, mz, x, y, tz);
  if (r.blockedBy === null) return 2;
  // (Within the last few metres before the point, a wall or the ground is what he is firing at.)
  const range = hypot2(x - mx, y - my), short = (1 - r.blockedAt) * range;
  if (short <= LINE_OF_FIRE_ALLOWANCE_M) return 2;
  return short <= shortM && r.blockedAt >= 0.5 ? 1 : 0;
}

/**
 * Is the line from his muzzle (in posture `p`) to the point he is told to fire at free of ground, walls and
 * roofs, except within the last few metres before the point? (A drill's or an order's task, `suppress`, also
 * accepts cover up to `drills.suppressShortM` short of the point: see `lineOfFireTo`.)
 */
export function lineOfFireClear(ctx: SimContext, state: SimState, id: EntityId, task: FireTask, p: Posture): boolean {
  return lineOfFireTo(ctx, state, id, task.x, task.y, task.heightM, p, task.suppress !== undefined ? ctx.catalog.behaviour.drills.suppressShortM : 0) > 0;
}

/** Give a soldier a fire task (from a fire order). */
/**
 * Aim height above the ground for firing at an enemy man (M7.5d): the usual aim point, on his floor when the
 * shooter knows him to be upstairs (M7.5 review fix: `known` is the shooter's contact, whose height is where he was
 * last seen; never the target's true position). An enemy only heard or reported (`kind`, D4b) is aimed at low,
 * at `aimUnseenHeightM` at most (owner pick: grazing fire where he is likely lying or kneeling).
 */
export function aimHeightAt(ctx: SimContext, known: { z?: number; posture?: Posture; kind?: Contact["kind"] } | undefined): number {
  const F = ctx.catalog.shooting.fire;
  // The middle of what he sees of him (soldier AI package A): by the posture he was last seen in; never seen, the
  // usual aim point.
  let base = known?.posture !== undefined ? F.aimHeightByPostureM[known.posture] : F.aimPointHeightM;
  if (F.aimUnseenHeightM !== undefined && (known?.kind === "heard" || known?.kind === "reported")) base = Math.min(base, F.aimUnseenHeightM);
  const z = known?.z ?? 0;
  return z > 0 ? base + z : base;
}

/** Spare magazines (or belts) of his weapon's type with rounds in them. */
export function spareMagazines(c: Container | undefined, magazine: string): number {
  let n = 0;
  if (c) for (const s of c.stacks) if (s.type === magazine && (s.charge ?? 0) > 0) n += s.count;
  return n;
}

/**
 * Close-defence reserve (soldier AI package A): a rifleman down to the magazine in his weapon fires it only at an
 * enemy he knows within `reserveCloseM`, or within `reserveAssaultM` whose unit is assaulting (men rushing at him:
 * something he sees, not a guess).
 */
export function reserveTargetOk(ctx: SimContext, state: SimState, c: { target: EntityId; x: number; y: number }, me: { x: number; y: number }): boolean {
  const S = ctx.catalog.behaviour.soldier;
  const d = hypot2(c.x - me.x, c.y - me.y);
  if (d <= S.reserveCloseM) return true;
  if (d > S.reserveAssaultM) return false;
  let u = state.identity.get(c.target)?.unit ?? null;
  while (u !== null) {
    const unit = state.unit.get(u);
    if (!unit) return false;
    if (unit.drill?.kind === "assault" || unit.drill?.kind === "clear") return true;
    u = unit.parent;
  }
  return false;
}

export function assignFireTask(ctx: SimContext, state: SimState, id: EntityId, x: number, y: number, heightM: number, player = false): boolean {
  const w = state.weapon.get(id), s = state.soldier.get(id), t = state.transform.get(id);
  if (!w || !s || !t || !isAble(s) || !s.impair.canFight || s.mount !== undefined) return false; // aboard: the station fires (M7.3)
  // A man wearing the red cross fires only in self-defence (owner answer 8, M10.7b): beyond `selfDefenceM` only on the
  // player's own order (`player`), which costs his protection.
  if (!player && ctx.catalog.medical !== undefined && beyondSelfDefence(ctx, state, id, x, y)) return false;
  const a = ctx.catalog.shooting.aim;
  const prev = state.fire.get(id);
  state.fire.set(id, {
    x, y, heightM, reasonTick: state.tick,
    // A renewed order at (nearly) the same point does not make him start aiming afresh.
    startTick: prev !== undefined && hypot2(prev.x - x, prev.y - y) < 3 ? prev.startTick : state.tick,
    lineCheckTick: -100000, lineClear: true, linePosture: s.posture,
    // The posture he goes back to when rising is no longer needed: his own, or the one he was firing from.
    // (If he is changing posture now, the one he is going to: a man ordered down who opens fire meanwhile.)
    // (His fire position's posture first, package C: a man who rose to look goes back down when he can.)
    basePosture: prev?.basePosture ?? s.homePosture ?? s.postureTo ?? s.posture,
    rangeError: a.rangeErrorFraction * skillFactor(ctx, s.skills["marksmanship"] ?? 0.5) * nextNormal(state.rng, Streams.fire),
  });
  // Men do not all fire on the same tick.
  w.nextShotTick = state.tick + Math.floor(nextFloat(state.rng, Streams.fire) * TICK_HZ);
  w.burstLeft = 0; w.burstIndex = 0;
  t.heading = atan2(y - t.y, x - t.x);
  return true;
}

function topUnit(state: SimState, soldier: EntityId): EntityId | null {
  let u: EntityId | null = state.identity.get(soldier)?.unit ?? null;
  for (;;) {
    if (u === null) return null;
    const p: EntityId | null = state.unit.get(u)?.parent ?? null;
    if (p === null) return u;
    u = p;
  }
}

/**
 * Is a man of his side in front of the muzzle, inside the safety cone and nearer than the target (or no more than
 * `beyondM` past it)? (Balance pass 2026-11-13: any platoon of his side, not only his own; the attacker's two
 * platoons fired through each other.) Fire discipline (2026-11-14): a man beside him counts too (from 0.3 m
 * behind his shoulder, more for a man lying down, whose body is long: the muzzle is 0.4 m out, so a comrade lying at
 * his elbow was shot), and the caller may look `beyondM` past the point fired at (a burst's beaten zone: rounds
 * that miss go on). `from`: as if he were there (a covering man looking for a spot with a clear line).
 */
export function friendInLine(ctx: SimContext, state: SimState, id: EntityId, tx: number, ty: number, beyondM = 0, from?: { x: number; y: number }, over?: { mz: number; tz: number }, shot?: ShotLine): boolean {
  const side = state.identity.get(id)?.side;
  if (side === undefined) return false;
  const self = state.transform.req(id);
  const me = from ?? self;
  const dx = tx - me.x, dy = ty - me.y;
  const range = hypot2(dx, dy);
  if (range < 1e-6) return false;
  const ux = dx / range, uy = dy / range;
  const sinCone = sin((ctx.catalog.shooting.fire.safetyConeDeg * PI) / 180);
  // (Balance pass 4: a gunner aboard sits 1.2-1.6 m above the ground (his seat), which the floor test below took for
  // another floor: a vehicle gunner never saw his own men on foot in his line. Aboard, he fires from ground level.)
  const selfZ = isMounted(state.soldier.get(id)) && !onRoof(state, id) ? 0 : self.z;
  // (Balance pass 4 review, H1: a station's gun fires over own men on foot whose heads its line clears well, `over`:
  // the muzzle's and the point's world heights; `gunnery.overClearM` etc. Without, every man in the cone blocks.)
  const GN = ctx.catalog.behaviour.gunnery;
  const ovC = over !== undefined && GN.overClearM !== undefined ? GN.overClearM : -1, ovP = GN.overPerM ?? 0, ovN = GN.overNearM ?? 0;
  // (Men aboard a vehicle are behind armour, M7: their hull blocks, `hullInLine`. A man aboard but working outside
  // it (repairing, hooking up, reloading on the roof) is a body like a man on foot: he blocks, balance pass 3 review.)
  // (Review 2026-11-24, problem 1: a body a round from his muzzle would strike blocks, dead or alive: a comrade's
  // corpse lying over a prone man's muzzle took every round he fired. A man on foot only; a gunner aboard as before.)
  const onFoot = over === undefined && !(isMounted(state.soldier.get(id)) && !onRoof(state, id));
  if (onFoot && bodyInLine(ctx, state, id, tx, ty, shot, from)) return true;
  for (const [other, ident] of state.identity.entries()) {
    const os = state.soldier.get(other);
    if (ident.side !== side || other === id || (isMounted(os) && !onRoof(state, other))) continue;
    // (Review fixes 2026-11-14: the dead and prisoners never block his fire by fire discipline (a body a round would
    // strike does, `bodyInLine` above); a man lying hit counts only between the muzzle and the point, as before fire
    // discipline, not at the elbow or in the beaten zone past the point.)
    if (os !== undefined && (!os.physiology.alive || os.captive !== null)) continue;
    const o = state.transform.req(other);
    // (A man on another floor is not in the line: the window places of two floors share x, y. Review fixes.)
    if (Math.abs(o.z - selfZ) > FLOOR_APART_M) continue;
    // (A man lying down is long: his body reaches about a metre from where he is.)
    const reach = os?.posture === "prone" ? Math.max(BODY_REACH_M, ctx.ballistics.bodyReachM) : BODY_REACH_M;
    const along = (o.x - me.x) * ux + (o.y - me.y) * uy;
    if (along <= MUZZLE_OUT_M - reach || along >= range + beyondM) continue;
    if (os !== undefined && os.casualty !== "none" && (along <= 0.5 || along >= range + LINE_OF_FIRE_ALLOWANCE_M)) continue;
    const across = Math.abs((o.x - me.x) * -uy + (o.y - me.y) * ux);
    // (Balance pass 4, G: a comrade on the very spot he stands on — within SAME_SPOT_M, two men given one window place
    // or one place in a house — is no body in front of his muzzle; before, such men held each other's fire for good:
    // hold-resupply-ru seed 4, a squad upstairs fired 9 rounds in 4 minutes against 760. A comrade at his elbow, 0.3 m
    // or more off, still counts.)
    // (Only for his own spot: a covering man testing another spot, `from`, is blocked by a comrade standing on it.)
    // (Review 2026-11-24: only once `bodyInLine` found that no round of his would strike that man's body: a comrade
    // lying on his spot is in front of a prone man's muzzle.)
    if (from === undefined && along * along + across * across < SAME_SPOT_M * SAME_SPOT_M) continue;
    if (across >= reach + Math.max(0, along) * sinCone) continue;
    if (ovC >= 0 && along > ovN && along < range) {
      const lineZ = over!.mz + ((over!.tz - over!.mz) * along) / range;
      const top = standZ(ctx.map, o) + ctx.catalog.body.postures[os?.posture ?? "standing"].heightM;
      if (lineZ - top >= ovC + ovP * along) continue;
    }
    return true;
  }
  return hullInLine(ctx, state, side, id, self.z, me.x, me.y, ux, uy, range + beyondM, sinCone);
}

/**
 * Review 2026-11-24 (over-blocking): does his own side hold this fire, as the fire system will judge it? The checks
 * made before a fire task is given (return fire, fire at a known place, self-defence, drills, the commander's siting)
 * use this, not `friendInLine` alone: blocked in his posture only by a body over his muzzle, he rises to a kneel or
 * to his feet if that clears it (`fireSystem`, as over a bank), so the task stands. A pinned man or one on the move
 * does not rise (a man to fire `from` another spot is taken as halted there). `from`, `shot`: as `friendInLine`.
 */
export function friendHolds(ctx: SimContext, state: SimState, id: EntityId, tx: number, ty: number, beyondM = 0, from?: { x: number; y: number }, shot?: ShotLine): boolean {
  if (!friendInLine(ctx, state, id, tx, ty, beyondM, from, undefined, shot)) return false;
  const s = state.soldier.get(id);
  if (s === undefined || isCowering(s) || (from === undefined && (state.mover.get(id)?.waypoints.length ?? 0) > 0)) return true;
  const p0 = shot?.posture ?? s.posture;
  // (Held by a living comrade in the cone or a hull: no posture clears that.)
  if (POSTURE_RANK[p0] >= POSTURE_RANK.standing || isMounted(s) || !bodyInLine(ctx, state, id, tx, ty, { ...shot, posture: p0 }, from)) return true;
  for (const p of RISE_ORDER) {
    if (POSTURE_RANK[p] <= POSTURE_RANK[p0]) continue;
    if (!friendInLine(ctx, state, id, tx, ty, beyondM, from, undefined, { ...shot, posture: p })) return false;
  }
  return true;
}
const RISE_ORDER: readonly Posture[] = ["crouching", "standing"];

/** The shot a line check is for: his posture (default: the one he is in) and the world height of the point he aims
 *  at (default: level with his muzzle). */
export interface ShotLine { posture?: Posture; tz?: number; /** A lobbed round (an automatic grenade launcher's): it
 *  passes high over a body lying farther out, so only the bodies at his muzzle count. */ lob?: boolean }

/** Bodies within this of the shooter are tested against the round's path itself (m): muzzle, a prone body's reach
 *  and a margin. */
const NEAR_BODY_M = 2;
/** The body boxes grown by this in the strike test (m): the aim moves a little between the check and the shot. */
const STRIKE_GROW_M = 0.05;
/** A comrade's body lying farther out (dead) is struck when the round's path passes within its box grown by
 *  `STRIKE_GROW_M` plus this many of his spreads (aim and weapon, one standard deviation each) per m of range. */
const LYING_SPREADS = 2;

/** The world height of the point a fire task aims at. */
function aimZ(ctx: SimContext, task: FireTask): number {
  return heightAt(ctx.map, task.x, task.y) + task.heightM; // ground: ok (a point fired at; a man's floor is in heightM)
}

/**
 * Review 2026-11-24, problem 1 (friendly fire): would a round from his muzzle, in posture `shot.posture`, strike the
 * body of a man of his side? Every man of his side on foot within `NEAR_BODY_M` (alive, hit, dead or a prisoner):
 * the round's path from the muzzle against his body's box (`bodyStrikeT`, the projectile's own geometry); a dead
 * man farther out, between the muzzle and the point: the same against his body's box grown by the spread of the
 * rounds at that range (not for a lobbed round, `shot.lob`). (Before, the dead never blocked: a prone rifleman with a comrade's corpse lying over his muzzle fired 43
 * rounds into it, platoon seed 1.) Living men farther out are fire discipline's matter (`friendInLine`'s cone).
 * `from`: as if he were there.
 */
export function bodyInLine(ctx: SimContext, state: SimState, id: EntityId, tx: number, ty: number, shot?: ShotLine, from?: { x: number; y: number }): boolean {
  const side = state.identity.get(id)?.side;
  const s = state.soldier.get(id);
  if (side === undefined || s === undefined) return false;
  const self = state.transform.req(id);
  const mx0 = from?.x ?? self.x, my0 = from?.y ?? self.y;
  const range0 = hypot2(tx - mx0, ty - my0);
  if (range0 < 1e-6) return false;
  const ux = (tx - mx0) / range0, uy = (ty - my0) / range0;
  const mx = mx0 + ux * MUZZLE_OUT_M, my = my0 + uy * MUZZLE_OUT_M;
  const p = shot?.posture ?? s.posture;
  const mz = standZ(ctx.map, self, mx, my) + ctx.catalog.body.postures[p].muzzleHeightM;
  const tz = shot?.tz ?? mz;
  const range = Math.max(0.5, range0 - MUZZLE_OUT_M);
  const slope = (tz - mz) / range;
  const B = ctx.ballistics, hbs = B.hitboxes;
  const near = NEAR_BODY_M + B.bodyReachM;
  const seg = Math.min(range, near + B.bodyReachM);
  // (Over-block fix: the spread per m of range a body farther out is grown by, worked out at the first such body.)
  let perM = -1;
  const lob = shot?.lob === true;
  for (const [other, ident] of state.identity.entries()) {
    if (ident.side !== side || other === id) continue;
    const os = state.soldier.get(other);
    if (os === undefined || (isMounted(os) && !onRoof(state, other))) continue;
    const o = state.transform.get(other);
    if (o === undefined) continue;
    const ox = o.x - mx0, oy = o.y - my0;
    const along = ox * ux + oy * uy;
    if (along < -B.bodyReachM || along >= range0 + LINE_OF_FIRE_ALLOWANCE_M) continue;
    const across = Math.abs(ox * -uy + oy * ux);
    const bgz = standZ(ctx.map, o);
    if (along <= near && across <= near) {
      // (The projectile loop's posture rows: a reloader on a hull's roof stands.)
      const hb = hbs[(isMounted(os) && onRoofTop(state, other)) || os.posture === "standing" ? 0 : os.posture === "crouching" ? 1 : 2]!;
      const t = bodyStrikeT(hb, o.x, o.y, bgz, cos(o.heading), sin(o.heading), mx, my, mz, ux * seg, uy * seg, slope * seg, STRIKE_GROW_M);
      if (t <= 1) return true;
      continue;
    }
    if (os.physiology.alive || lob) continue;
    // A body lying farther out, short of the point: the round's path against his body's box (the hitbox of his
    // posture, 0.3 m high lying), grown by the spread of his rounds at that range: his aiming error in that posture
    // when firing fast and the weapon's dispersion, `LYING_SPREADS` standard deviations. (Review 2026-11-24, over-
    // blocking: the safety cone, 4 degrees, held a man for a corpse 5.8 m off his line at 146 m, platoon seed 4.)
    if (along <= 0.5 || along >= range0) continue;
    if (perM < 0) {
      const A = ctx.catalog.shooting.aim, wd = ctx.catalog.weapons[state.weapon.get(id)?.weapon ?? ""];
      const aim = A.baseMrad * A.postureFactor[p] * A.rapidFactor, disp = wd?.dispersionMrad ?? 0;
      perM = (LYING_SPREADS * sqrt(aim * aim + disp * disp)) / 1000;
    }
    const grow = STRIKE_GROW_M + perM * along;
    if (across >= B.bodyReachM + grow) continue;
    const hb = hbs[os.posture === "standing" ? 0 : os.posture === "crouching" ? 1 : 2]!;
    if (bodyStrikeT(hb, o.x, o.y, bgz, cos(o.heading), sin(o.heading), mx, my, mz, ux * range, uy * range, tz - mz, grow) <= 1) return true;
  }
  return false;
}

/**
 * Balance pass 4 (owner 2026-11-19, danger close for bursting rounds): how near the burst of this round a man is in
 * danger (m): where its fragments, spread evenly over a sphere, strike a body of `danger.presentedAreaM2` with a
 * chance of `danger.hitChance` (ballistics.json `fragments.danger`), at least the blast's injury radius. 0 for a round
 * that does not burst.
 */
export function dangerRadiusM(ctx: SimContext, ammoId: string): number {
  const ex = ctx.catalog.ammo[ammoId]?.explosive;
  if (!ex) return 0;
  const bal = ctx.catalog.ballistics, dg = bal.fragments.danger;
  const blast = bal.blast.injuryScaledM * pow(ex.fillingKg, 1 / 3);
  const frag = dg ? sqrt((ex.fragmentCount * dg.presentedAreaM2) / (4 * PI * dg.hitChance)) : 0;
  return Math.max(blast, frag);
}

/** Balance pass 4: an own man of `side` on foot (or out on a hull), alive and not a prisoner, within `r` of the
 *  point (no bursting round there). */
export function ownMenWithin(state: SimState, side: string, x: number, y: number, r: number): boolean {
  const r2 = r * r;
  for (const [id, ident] of state.identity.entries()) {
    if (ident.side !== side) continue;
    const s = state.soldier.get(id);
    if (s === undefined || !s.physiology.alive || s.captive !== null || (isMounted(s) && !onRoof(state, id))) continue;
    const t = state.transform.get(id);
    if (t && (t.x - x) * (t.x - x) + (t.y - y) * (t.y - y) <= r2) return true;
  }
  return false;
}

/**
 * Balance pass 3 (owner 2026-11-18): a hull of his side (and so the men aboard it) in front of the muzzle, inside
 * the safety cone, nearer than the point (or within `reachM` of the line's end) blocks his fire, whoever he is: a
 * man on foot or a gunner aboard (his own hull never counts). The hull's rectangle from the vehicle grid (rebuilt
 * every tick by the drive system) is grown by the cone's width at its distance; heights are not looked at, except
 * that a man well above its roof (an upper floor) fires over it. Wrecks ("destroyed") do not count: no one aboard,
 * and they stop rounds as obstacles in `sight` already. A few multiplications per hull of his side.
 */
function hullInLine(ctx: SimContext, state: SimState, side: string, id: EntityId, z: number, mx: number, my: number, ux: number, uy: number, reachM: number, sinCone: number): boolean {
  const G = ctx.ballistics.vehicles, n = G.n;
  if (n === 0) return false;
  const own = state.soldier.get(id)?.mount?.vehicle ?? -1;
  const ex = ux * reachM, ey = uy * reachM;
  for (let k = 0; k < n; k++) {
    const vid = G.id[k]!;
    if (vid === own) continue;
    const v = state.vehicle.get(vid);
    if (v === undefined || v.side !== side || v.status === "destroyed") continue;
    const c = G.ch[k]!, s = G.sh[k]!;
    const f0 = G.f0[k]!, f1 = G.f1[k]!, r0 = G.r0[k]!, r1 = G.r1[k]!;
    const fc = (f0 + f1) / 2, rc = (r0 + r1) / 2;
    const ox = G.x[k]! + c * fc - s * rc, oy = G.y[k]! + s * fc + c * rc;
    const rx = mx - ox, ry = my - oy;
    // Behind him (the box's far corner short of his muzzle) or beyond the line's end: not in it.
    const hl0 = (f1 - f0) / 2, hw0 = (r1 - r0) / 2;
    const along = -(rx * ux + ry * uy), radius = hl0 + hw0;
    if (along + radius <= MUZZLE_OUT_M || along - radius >= reachM) continue;
    // (`z` is his height above the ground: a man on an upper floor fires over it; a gunner aboard sits below its roof.)
    if (z > Math.max(G.u1[k]!, G.tu1[k]!) + FLOOR_APART_M) continue;
    // In the box's frame: the segment from him to the line's end against the grown rectangle (slab clipping).
    let pf = rx * c + ry * s, pr = -rx * s + ry * c;
    const df = ex * c + ey * s, dr = -ex * s + ey * c;
    const grow = HULL_GROW_M + Math.max(0, along) * sinCone;
    let hl = hl0 + grow, hw = hw0 + grow;
    if (pf >= -hl && pf <= hl && pr >= -hw && pr <= hw) {
      // He stands at the hull (within the margin): only the hull itself, from his muzzle on, counts.
      hl = hl0; hw = hw0;
      pf += (ux * c + uy * s) * MUZZLE_OUT_M; pr += (-ux * s + uy * c) * MUZZLE_OUT_M;
    }
    let t0 = 0, t1 = 1;
    if (Math.abs(df) < 1e-12) { if (pf < -hl || pf > hl) continue; }
    else {
      let a = (-hl - pf) / df, b = (hl - pf) / df;
      if (a > b) { const q = a; a = b; b = q; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) continue;
    }
    if (Math.abs(dr) < 1e-12) { if (pr < -hw || pr > hw) continue; }
    else {
      let a = (-hw - pr) / dr, b = (hw - pr) / dr;
      if (a > b) { const q = a; a = b; b = q; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) continue;
    }
    return true;
  }
  return false;
}

function shoot(ctx: SimContext, state: SimState, events: EventSink, id: EntityId, w: WeaponState, task: FireTask, aimed: boolean): void {
  const wd = ctx.catalog.weapons[w.weapon]!;
  const s = state.soldier.req(id), t = state.transform.req(id);
  const { ammoId, v0 } = pickRound(ctx.catalog, wd, w.magazine!.item, w.magazine!.rounds);
  if (v0 === undefined) return;
  const a0 = atan2(task.y - t.y, task.x - t.x);
  t.heading = a0;
  const mx = t.x + cos(a0) * 0.4, my = t.y + sin(a0) * 0.4;
  const mz = standZ(ctx.map, t, mx, my) + ctx.catalog.body.postures[s.posture].muzzleHeightM;
  const range = hypot2(task.x - mx, task.y - my);
  if (range < 0.5) return;
  const tz = heightAt(ctx.map, task.x, task.y) + task.heightM; // ground: ok (a point fired at; a man's floor is in heightM)
  // He sets his point of aim for the range he believes it is.
  const believed = range * (1 + task.rangeError);
  const sd = aimErrorMrad(ctx, state, id, w, aimed);
  const total = sqrt(sd * sd + wd.dispersionMrad * wd.dispersionMrad) / 1000;
  launchShot(ctx, state, events, id, w.weapon, ammoId, v0, mx, my, mz, tz, a0, range, believed, total);
  // At a drone (M9.4b): whether this round hits it (its hit box against the spread; the bullet flies on regardless).
  if (task.contact !== undefined && state.drone.size > 0 && state.drone.has(task.contact)) shootAtDrone(ctx, state, task.contact, id, mx, my, mz, task.x, task.y, tz, total, v0);
  w.magazine!.rounds--;
  w.lastShotTick = state.tick;
  // Laws of war (M10.7b): his protection (if any) and whether this is fire at a protected enemy.
  if (ctx.catalog.medical !== undefined) {
    noteShot(ctx, state, id, s, task.x, task.y);
    if (task.contact !== undefined) noteFireAt(ctx, state, events, id, task, task.self !== true && task.suppress === "order");
  }
  if (wd.jamProbability > 0 && nextFloat(state.rng, Streams.fire) < wd.jamProbability) {
    w.jammed = true;
    w.burstLeft = 0;
    events.emit({ kind: "weapon.jammed", tick: state.tick, soldier: id });
  }
}

const POSTURE_RANK: Record<Posture, number> = { prone: 0, crouching: 1, standing: 2 };

/**
 * How he fires at this point now (band, trickle, last-magazine reserve) and how far past it a comrade still counts
 * as in his line: a burst's beaten zone (`friendBeyondM`), a single shot's point. One rule for the shot and for the
 * re-check of a man ducked for a comrade (review fixes 2026-11-14).
 */
function shotMode(ctx: SimContext, state: SimState, id: EntityId, task: FireTask, wd: WeaponDef, trickle: boolean, reserve: boolean) {
  const F = ctx.catalog.shooting.fire;
  const me = state.transform.req(id);
  const range = hypot2(task.x - me.x, task.y - me.y);
  const band = F.bands.find((b) => range <= b.maxRangeM) ?? F.bands[F.bands.length - 1]!;
  const canBurst = wd.fireModes.includes("auto") || wd.fireModes.includes("burst");
  // A machine gun fires bursts at every range (also on the slow rate: the same bursts, further apart).
  const mode = wd.sustained ? "burst" : trickle || reserve ? "aimed" : band.mode === "burst" && !canBurst ? "rapid" : band.mode;
  const beyond = wd.sustained || mode === "burst" ? ctx.catalog.behaviour.soldier.friendBeyondM : LINE_OF_FIRE_ALLOWANCE_M;
  return { band, mode, beyond, range };
}

/**
 * Fire discipline (2026-11-14): may he go back down to his fire position's posture now? Raised above it, not at a
 * window indoors (his place there sets his posture), not on the move, and not within `soldier.duckHoldS` of his
 * last change for this (so it cannot see-saw with package C's return to his fire position).
 */
function mayDuck(ctx: SimContext, state: SimState, id: EntityId, task: FireTask, posture: Posture, moving: boolean): boolean {
  if (moving || POSTURE_RANK[posture] <= POSTURE_RANK[task.basePosture]) return false;
  if (task.duckTick !== undefined && state.tick - task.duckTick < secondsToTicks(ctx.catalog.behaviour.soldier.duckHoldS)) return false;
  const t = state.transform.req(id);
  return indoorAt(ctx, t.x, t.y) < 0;
}

/** He goes down to his fire position's posture, remembering the one he fires from (`up`, if he will rise again). */
function duck(ctx: SimContext, state: SimState, id: EntityId, task: FireTask, up: Posture | null, friend = false): void {
  requestPosture(ctx, state, id, task.basePosture);
  task.duckTick = state.tick;
  if (up !== null) {
    task.duck = { up, riseTicks: secondsToTicks(postureChangeSeconds(ctx, task.basePosture, up, loadKg(ctx, state, id))) };
    if (friend) task.duck.friend = true;
  } else delete task.duck;
}

export function fireSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  const F = ctx.catalog.shooting.fire, S = ctx.catalog.behaviour.soldier;
  const tick = state.tick;
  // ---- lulls: swap a partly used magazine for a fuller one (staggered check, twice a second per man)
  // Not while he has a fire task (even a slow one), and only if the magazine is well below full.
  for (let id = staggerFirst(tick, 30); id < state.nextEntityId; id += 30) {
    const w = state.weapon.get(id);
    if (w === undefined || !w.magazine || state.action.has(id) || state.fire.has(id)) continue;
    if (isMounted(state.soldier.get(id))) continue; // aboard: no reloading his own weapon (M7)
    if (tick - w.lastShotTick < secondsToTicks(F.topUpAfterSeconds)) continue;
    if (isGuiding(state, id)) continue; // (M9.3b review fix: a gunner guiding a missile stays at his sight)
    const sol = state.soldier.get(id);
    if (!isAble(sol) || tick < sol!.stunnedUntilTick || !sol!.impair.canUseArms) continue;
    const wd = ctx.catalog.weapons[w.weapon];
    const capacity = wd ? (ctx.catalog.items[wd.feed.magazine]?.chargeCapacity ?? 0) : 0;
    // (Belts are not swapped in lulls: a belt change takes long and a part-used belt is not put away.)
    if (wd && !wd.sustained && w.magazine.rounds <= capacity * F.topUpBelowFraction && fullestSpare(state.container.get(id), wd.feed.magazine) > w.magazine.rounds) {
      startAction(state, events, id, "reload", secondsToTicks(wd.reloadSeconds), {});
    }
  }
  if (state.fire.size === 0) return;

  const fullTicks = secondsToTicks(F.fullRateSeconds), endTicks = fullTicks + secondsToTicks(F.trickleSeconds);
  const ended = new Map<EntityId, "no-target" | "ammunition" | "unable">(); // top unit -> why a member stopped
  const blockedReported = new Set<EntityId>();
  for (const [id, task] of state.fire.toEntries()) {
    const w = state.weapon.get(id), s = state.soldier.get(id), wd = w ? ctx.catalog.weapons[w.weapon] : undefined;
    const stop = (why: "no-target" | "ammunition" | "unable") => {
      state.fire.delete(id);
      const top = topUnit(state, id);
      if (top !== null && ended.get(top) !== "no-target" && !(ended.get(top) === "ammunition" && why === "unable")) ended.set(top, why);
    };
    if (!w || !s || !wd || !isAble(s) || !s.impair.canFight) { stop("unable"); continue; }
    // He knows the man he is firing at has given up (his own contact says so, M6.6): he holds his fire —
    // whether the task came from an order, a drill or himself. (Fire at a point is not stopped by this.)
    // (Not his deliberate breach, M10.7b: he fires at him anyway, conduct.ts.)
    if (task.contact !== undefined && s.contacts.find((k) => k.target === task.contact)?.surrendered === true && !breachActive(s, task.contact, tick)) { stop("no-target"); continue; }
    // He has recognised him as protected (M10.7a: armband, ambulance, carrying party, at the nest): he holds his fire.
    if (task.contact !== undefined && (tick + id) % 30 === 0) { const k = s.contacts.find((q) => q.target === task.contact); if (k !== undefined && protectedContact(k) && !breachActive(s, task.contact, tick)) { stop("no-target"); continue; } }
    // He saw the man he is firing at go down (package A: aiming low at men lying down, rounds went into the fallen):
    // he stops (a man he has not seen for a few seconds may still be up: fire at where he was goes on).
    if (task.contact !== undefined && (tick + id) % 30 === 0 && s.contacts.find((k) => k.target === task.contact)?.down === true) { stop("no-target"); continue; }
    if (tick < s.stunnedUntilTick) continue; // knocked down
    const rateK = fireRateFactor(ctx, s);
    if (rateK <= 0) continue; // panicked: he does not fire (the task stays for when he recovers)
    if (s.evade !== null && tick >= s.evade.startTick) continue; // diving away from a grenade
    const since = tick - task.reasonTick;
    if (since > endTicks) { stop("no-target"); continue; }
    if (s.postureTo !== null || state.action.has(id)) continue;
    if (isGuiding(state, id)) continue; // (M9.3b review fix: no fire, reload or ducking while he guides; task kept)
    // A drone (M9.4b): he aims where he sees it now; out of his sight (or down), he stops.
    if (task.contact !== undefined && state.drone.size > 0 && state.drone.has(task.contact)) {
      const p = droneInSight(state, id, task.contact, secondsToTicks(DRONE_SEEN_S));
      if (!p) { stop("no-target"); continue; }
      task.x = p.x; task.y = p.y; task.heightM = p.z; task.reasonTick = tick;
    }
    // A man on the move does not fire — except assault fire (package D), from the posture he moves in.
    const moving = (state.mover.get(id)?.waypoints.length ?? 0) > 0;
    if (moving && task.onTheMove !== true) continue;
    if (w.jammed) { startAction(state, events, id, "clearStoppage", secondsToTicks(F.clearStoppageSeconds), {}); continue; }
    const spare = fullestSpare(state.container.get(id), wd.feed.magazine);
    let reserve = false;
    if (!w.magazine || w.magazine.rounds <= 0) {
      // (Fire discipline: he goes down to his fire position first, and reloads there.)
      if (spare > 0 && mayDuck(ctx, state, id, task, s.posture, moving)) { duck(ctx, state, id, task, s.posture); continue; }
      if (spare > 0) startAction(state, events, id, "reload", secondsToTicks(wd.reloadSeconds), {});
      else stop("ammunition");
      continue;
    }
    if (spare <= 0) {
      // Only the magazine in the weapon is left: he keeps it and reports. (A machine gunner reports too, but
      // fires his last belt: the rule was made for rifle magazines, and a gun with a belt in it is no reserve.)
      // One report per unit, not one per man.
      const top = topUnit(state, id);
      // mounted: ok only men who fire report low ammunition, and men aboard do not fire
      const already = top !== null && unitSoldiers(state, top).some((m) => m !== id && state.weapon.get(m)?.lowAmmoReported === true);
      if (!w.lowAmmoReported) w.lowAmmoReported = true;
      if (!already && !w.lowAmmoRadioed) {
        w.lowAmmoRadioed = true;
        if (onAir(state, state.identity.req(id).unit)) events.emit({ kind: "radio", tick, side: state.identity.req(id).side, from: id, key: "radio.lowAmmo", params: { callsign: state.unit.get(state.identity.req(id).unit)?.callsign ?? "" } });
      }
      // A rifleman keeps that last magazine as a close-defence reserve (package A): he fires it, aimed, only at an
      // enemy close by or assaulting him.
      if (!wd.sustained) {
        const c = task.contact !== undefined ? s.contacts.find((k) => k.target === task.contact) : undefined;
        if (!c || !reserveTargetOk(ctx, state, c, state.transform.req(id))) { stop("ammunition"); continue; }
        reserve = true;
      }
    }
    // Ducked between shots (fire discipline): up again just in time for the next one.
    if (task.duck !== undefined) {
      if (moving || POSTURE_RANK[s.posture] >= POSTURE_RANK[task.duck.up]) delete task.duck;
      else if (w.nextShotTick - tick <= task.duck.riseTicks) {
        // (Down because a comrade was in his line: he stays down while that comrade is still there.)
        if (task.duck.friend === true && friendInLine(ctx, state, id, task.x, task.y, shotMode(ctx, state, id, task, wd, since > fullTicks, reserve).beyond, undefined, undefined, { posture: task.duck.up, tz: aimZ(ctx, task) })) { w.nextShotTick = tick + TICK_HZ / 2 + task.duck.riseTicks; continue; }
        requestPosture(ctx, state, id, task.duck.up);
        task.duckTick = tick;
        delete task.duck;
        continue;
      } else continue;
    }
    if (tick < w.nextShotTick) continue;
    // Line of fire: a bank, a crest or a wall right in front of him — he rises to a kneel or to his feet if
    // that clears it, otherwise he holds his fire and the unit says so (checked once a second).
    // The check is worked out for one posture; if he is in another now (an order changed it), it is redone.
    // He tries the posture he was in when the fire order came first, then higher ones: so a man who rose to fire
    // over a bank goes back down when a new point (or a new position) no longer needs it.
    if (w.burstLeft <= 0 && (tick - task.lineCheckTick >= TICK_HZ || task.linePosture !== s.posture)) {
      task.lineCheckTick = tick;
      // Firing at a contact: follow it as his picture of the enemy changes (target movement in the aiming
      // error is still to come: he aims at the last known position).
      if (task.spot !== undefined) {
        // (Area return fire, review 2026-11-24 problem 2: a new point of the circle for each shot or burst; the circle
        // itself follows his picture of the place, decisions.ts.)
        const sp = task.spot, rho = sp.r * sqrt(nextFloat(state.rng, Streams.fire)), th = 2 * PI * nextFloat(state.rng, Streams.fire);
        task.x = Math.min(Math.max(sp.cx + rho * cos(th), 0), ctx.map.widthM); task.y = Math.min(Math.max(sp.cy + rho * sin(th), 0), ctx.map.heightM);
      } else if (task.contact !== undefined) {
        const c = s.contacts.find((k) => k.target === task.contact);
        if (c && (c.x !== task.x || c.y !== task.y)) { task.x = c.x; task.y = c.y; }
        // (His aim height follows the posture he sees the man in, package A, unless the order gave one.)
        if (c && task.aimAuto === true) task.heightM = aimHeightAt(ctx, c);
      }
      const order: Posture[] = ["prone", "crouching", "standing"];
      // A pinned man does not raise himself to clear a bank: he fires from where he lies or not at all.
      const from = isCowering(s) ? ["prone" as Posture] : moving ? [s.posture] : order.slice(order.indexOf(task.basePosture));
      // (Covering fire, `suppress`: a posture with a clear line first, else one that reaches the cover near the point.)
      const shortM = task.suppress !== undefined ? ctx.catalog.behaviour.drills.suppressShortM : 0;
      let ok: Posture | undefined, short: Posture | undefined, body: Posture | undefined;
      // (Review 2026-11-24, problem 1: a posture whose rounds would strike a comrade's body (dead or alive, lying over
      // his muzzle) is no line either: he rises to a kneel over it, as over a bank. If none clears it, he takes the
      // first posture with a line and the friend check holds his fire.)
      const tz = aimZ(ctx, task);
      for (const p of from) {
        const q = lineOfFireTo(ctx, state, id, task.x, task.y, task.heightM, p, shortM);
        if (q > 0 && bodyInLine(ctx, state, id, task.x, task.y, { posture: p, tz })) { if (q === 2) body ??= p; continue; }
        if (q === 2) { ok = p; break; }
        if (q === 1) short ??= p;
      }
      if (ok === undefined && short === undefined) ok = body;
      if (ok === undefined && short !== undefined) { ok = short; task.intoCover = true; } else delete task.intoCover;
      task.lineClear = ok !== undefined;
      task.linePosture = ok ?? s.posture;
      if (ok !== undefined && ok !== s.posture) { requestPosture(ctx, state, id, ok); continue; }
      if (ok === undefined) {
        // (Fire discipline: no posture gives him a line, so he does not stand there with no shot to take.)
        if (mayDuck(ctx, state, id, task, s.posture, moving)) { duck(ctx, state, id, task, null); task.linePosture = task.basePosture; }
        const top = topUnit(state, id);
        if (top !== null && !blockedReported.has(top)) {
          blockedReported.add(top);
          const u = state.unit.get(top);
          if (u && !u.lineBlockedReported) {
            u.lineBlockedReported = true;
            if (onAir(state, state.identity.req(id).unit)) events.emit({ kind: "radio", tick, side: state.identity.req(id).side, from: id, key: "radio.noLineOfFire", params: { callsign: state.unit.get(state.identity.req(id).unit)?.callsign ?? "" } });
          }
        }
      }
    }
    if (!task.lineClear) continue;
    // (M11.1 point 7a: no trickle while he knows an enemy — seen or told of — within trickleKnownS.)
    const trickle = since > fullTicks && (F.trickleKnownS === undefined || !knowsEnemyWithin(s, tick - secondsToTicks(F.trickleKnownS)));
    const { band, mode, beyond, range } = shotMode(ctx, state, id, task, wd, trickle, reserve);
    if (w.burstLeft <= 0) {
      // (A burst, or a machine gun's: its beaten zone, friendBeyondM past the point, counts too; a single shot: a
      // man at the point itself.)
      if (friendInLine(ctx, state, id, task.x, task.y, beyond, undefined, undefined, { tz: aimZ(ctx, task) })) {
        w.nextShotTick = tick + TICK_HZ / 2;
        // (Fire discipline: held by a comrade in his line for a while, he does not wait for him raised up.)
        if (!wd.sustained && tick - w.lastShotTick >= secondsToTicks(S.duckAboveIntervalS) && mayDuck(ctx, state, id, task, s.posture, moving)) {
          duck(ctx, state, id, task, s.posture, true);
        }
        continue;
      }
      w.burstLeft = wd.sustained ? wd.sustained.burstRounds : mode === "burst" ? band.burstRounds : 1;
      w.burstIndex = 0;
    }
    shoot(ctx, state, events, id, w, task, mode === "aimed");
    w.burstLeft--;
    w.burstIndex++;
    if (w.burstLeft > 0 && w.magazine.rounds > 0 && !w.jammed) {
      w.nextShotTick = tick + burstCadence(wd.cyclicRpm);
    } else {
      w.burstLeft = 0;
      // (Into the cover near the point, covering fire: at the sustained rate, `drills.suppressIntervalS`.)
      // (M11.1 point 7c: a machine gun fires rapid for the first rapidSeconds of its task, then sustained.)
      const su = wd.sustained;
      const susInterval = su === undefined ? 0 : su.rapidIntervalS !== undefined && tick - task.startTick < secondsToTicks(su.rapidSeconds ?? 0) ? su.rapidIntervalS : su.intervalS;
      const interval0 = trickle ? F.trickleIntervalS : su ? susInterval : band.intervalS;
      // (A drill's covering fire at a point, no enemy named, likewise: before, riflemen ran dry in a long attack.)
      const sustained = task.intoCover === true || (task.suppress === "drill" && task.contact === undefined);
      // (Fire at a known place, M11.1 point 7b: one shot per suppressKnown.intervalS, a burst per mgIntervalS.)
      // (Return fire at a shooter's known place, balance pass 4: returnFire.intervalS / mgIntervalS.)
      const RF = ctx.catalog.behaviour.soldier.returnFire;
      // (Area return fire, review 2026-11-24 problem 2: returnFire.areaIntervalS / areaMgIntervalS.)
      const SK = task.suppress === "known" ? ctx.catalog.behaviour.soldier.suppressKnown : task.suppress === "return" ? RF
        : task.suppress === "area" && RF !== undefined ? { intervalS: RF.areaIntervalS ?? RF.intervalS, mgIntervalS: RF.areaMgIntervalS ?? RF.mgIntervalS } : undefined;
      const interval = SK ? Math.max(interval0, su ? SK.mgIntervalS : SK.intervalS) : sustained ? Math.max(interval0, ctx.catalog.behaviour.drills.suppressIntervalS) : interval0;
      // +-15 % so men do not fire in step.
      // Ammunition discipline of his unit (M5): conserve stretches the pause, maximum shortens it.
      const rule = state.unit.get(state.identity.req(id).unit)?.ammoRule ?? "normal";
      const disc = ctx.catalog.behaviour.decisions.ammoIntervalFactor[rule]
        // Long-range discipline (package A): a rifleman (no magnified sight) firing on his own beyond longRangeM fires
        // slower (ordered fire, e.g. a base of fire keeping the enemy down, keeps its rate).
        * (task.self === true && !wd.sustained && range > S.longRangeM && !wd.sights.some((q) => q.magnification >= 4) ? S.longRangeIntervalFactor : 1);
      w.nextShotTick = tick + Math.max(1, Math.round((secondsToTicks(interval) * disc / rateK) * (0.85 + 0.3 * nextFloat(state.rng, Streams.fire))));
      // Fire discipline (2026-11-14): risen above his fire position for the shot, with the next one a while off, he
      // goes back down meanwhile (not a machine gunner firing bursts: he stays on his gun).
      // (Only when it is worth it: the way down and up again, and a moment lying there, fit in before the next shot.)
      if (!wd.sustained && !w.jammed && w.magazine.rounds > 0 && w.nextShotTick - tick >= secondsToTicks(S.duckAboveIntervalS) && mayDuck(ctx, state, id, task, s.posture, moving)) {
        const load = loadKg(ctx, state, id);
        const downUp = postureChangeSeconds(ctx, s.posture, task.basePosture, load) + postureChangeSeconds(ctx, task.basePosture, s.posture, load);
        if (w.nextShotTick - tick >= secondsToTicks(downUp + S.duckHoldS)) duck(ctx, state, id, task, s.posture);
      }
    }
  }

  // ---- units whose last firing member has stopped
  for (const [uid, why] of [...ended.entries()].sort((a, b) => a[0] - b[0])) {
    const unit = state.unit.get(uid);
    if (!unit || !unit.firing) continue;
    // mounted: ok fire tasks belong to men on foot only
    if (unitSoldiers(state, uid).some((m) => state.fire.has(m))) continue;
    unit.firing = false;
    events.emit({ kind: "fire.ceased", tick, unit: uid, reason: why });
    if (why === "no-target") radioFromTarget(state, uid, "radio.noTarget", events);
  }
}

/**
 * Incoming fire: an enemy round fired past a unit (within the incoming radius of any member, out to the reach
 * distance from the muzzle) or striking near it gives its firing members reason to keep up the full rate.
 * A unit that had slowed to a trickle answers at once. (Suppression and fear come in M4; this is only the
 * ammunition-management clock.)
 */
export function incomingFireSystem(ctx: SimContext, state: SimState, events: readonly SimEvent[]): void {
  if (state.fire.size === 0) return;
  const F = ctx.catalog.shooting.fire;
  const r2 = F.incomingRadiusM * F.incomingRadiusM;
  let targets: { id: EntityId; x: number; y: number; side: string }[] | null = null;
  const refresh = new Set<EntityId>(); // top units
  for (const e of events) {
    let side: string | undefined;
    if (e.kind === "shot.fired") { if (e.indirect) continue; side = state.identity.get(e.shooter)?.side; } // (M8.3b: a mortar has no flat line of fire)
    else if (e.kind === "impact" && e.owner > 0) side = state.identity.get(e.owner)?.side;
    else continue;
    if (side === undefined) continue;
    if (targets === null) {
      targets = [];
      // mounted: ok fire tasks belong to men on foot only
      for (const [id] of state.fire.entries()) {
        const t = state.transform.req(id);
        targets.push({ id, x: t.x, y: t.y, side: state.identity.req(id).side });
      }
    }
    for (const m of targets) {
      if (m.side === side) continue;
      const dx = m.x - e.x, dy = m.y - e.y;
      let near: boolean;
      if (e.kind === "impact") near = dx * dx + dy * dy <= r2;
      else {
        const along = dx * e.dirX + dy * e.dirY;
        const across = dx * -e.dirY + dy * e.dirX;
        near = along > 0 && along <= F.incomingReachM && across * across <= r2;
      }
      if (near) { const top = topUnit(state, m.id); if (top !== null) refresh.add(top); }
    }
  }
  const fullTicks = secondsToTicks(F.fullRateSeconds);
  for (const top of [...refresh].sort((a, b) => a - b)) {
    // mounted: ok fire tasks belong to men on foot only
    for (const m of unitSoldiers(state, top)) {
      const task = state.fire.get(m);
      if (!task) continue;
      if (state.tick - task.reasonTick > fullTicks) {
        // He was on the slow rate: answer now, not at the next slow shot.
        const w = state.weapon.get(m);
        if (w) w.nextShotTick = Math.min(w.nextShotTick, state.tick + TICK_HZ / 2);
      }
      task.reasonTick = state.tick;
    }
  }
}

/** M11.1: does he know an enemy (not down, not given up) whose contact was updated at or after `since`? */
function knowsEnemyWithin(s: SoldierState, since: number): boolean {
  for (const c of s.contacts) if (c.tick >= since && c.down !== true && c.surrendered !== true) return true;
  return false;
}
