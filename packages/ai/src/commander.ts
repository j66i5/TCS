/**
 * THE OPPOSING COMMANDER (M6.3, owner decision 2026-11-12: "doctrinal and cautious").
 *
 * A Controller like a human player: it sees what its OWN men know (their contacts, the objective holders)
 * and acts only through orders, every few seconds. Squads (the platoon's sub-units) fight with the M4 drills
 * and decisions; the commander decides what each squad does.
 *
 * Defence: everyone down in his position, fire at will out to `defenceRangeM`; a squad that has lost half its
 *   men pulls back once the enemy is close (within `fallback.threatM`, its objective assaulted, or enemies on two
 *   sides) to a covered rally point of its own behind it that still sees its objective, and holds there; if the main
 *   objective is lost while two squads are still fit (a squad holding its rally point counts as the second), or one
 *   nearly whole, the strongest counterattacks it. A squad whose men left a house on their own (a trap, the enemy
 *   inside, cut off: sim systems/house.ts, M7.5e) takes fire positions outdoors around where they went.
 * Attack: the platoon moves up to a support line about `supportM` from the main objective, on an axis turned away
 *   from the other objective's garrison (blinded with smoke), each squad to a place with a field of fire (going
 *   to ground on contact, then moving on to it), and looks for the enemy there (up to `reconSeconds`) while the
 *   mortars' high explosive and a smoke screen come in; then half the squads fire on the objective man by man
 *   from the support line while the others run in under the smoke on a flank and assault it by fire and
 *   movement, with grenades; once it is taken, the base of fire comes up and the strongest squad assaults the
 *   second objective, supported by the rest. Losses beyond the faction's doctrine
 *   (`casualtyToleranceBeforeWithdrawal`) make it break off and withdraw to the start (balance pass 2026-11-13,
 *   docs/research/inf-assault.md).
 *
 * Its memory is plain data (saved with the game). Values not from data are listed in COMMANDER.
 */
import { withDrones } from "./drone";
import {
  atan2, backblastBlocked, friendInLine, buildingIndex as buildingIndexOf, clearable, contactErrorM, bestCoverNear, cos, exposureAt, createContext, heightAt, indoorAt, mapHasInteriors, navCostAt, navFor, PI, sin, hypot2, isAssetUnit, isCaptive, onlyProtectedAt, protectedContact, spared, isMortarUnit, isOffMap, isOut, launcherOf, aglOf, aglDangerM, AGL_BURST_M, teamRound, teamRounds, AUTO_DEPLOY_S, rebuildVehicleGrid, secondsToEffect, sight, standZ, supportLeft, syncTerrainDamage, eyeHeightM, TARGET_POINT_M,
  positionAt, type BattleInput, type Contact, type Controller, type EntityId, type ObjectiveDef, type Order, type SideId, type SimContext, type SimState, type SimView, type SoldierState, type UnitInput,
} from "@tcs/sim";
import { approachPoints, seenShare, siteDefence, siteOverwatch, type SitingGroup } from "./siting";
import { isArmourSection, tankSections, TANKS, tankVehicles, type TanksMemory } from "./tanks";
import { recoveryCalls } from "./recovery";

export const COMMANDER = { stepSeconds: 5, /** Morale rework 2026-11-15: no new assault by a squad pinned, broken or with morale below this. */ assaultMinMorale: 0.45, supportM: 330, reconSeconds: 60, defenceRangeM: 300, refireSeconds: 20, reassaultSeconds: 30, grenadeRangeM: 35, grenadeEverySeconds: 20, heEverySeconds: 45, heRounds: 6, smokeEverySeconds: 120, smokeRounds: 3, smokeAheadM: 45, defenceHeEverySeconds: 120, defenceHeRounds: 4, rideTimeoutSeconds: 300, dismountStepM: 50, dismountCandidates: 3, vehicleSlotM: 60, vehicleLossShare: 2 / 3, vehicleFireNearOwnM: 80, followReplanM: 40, supportFireEverySeconds: 20, houseResiteSeconds: 30,
  // Defence siting (overnight pick "defence-siting"; the rest in siting.ts SITING): a group within this of an
  // objective's ring holds it, and its men stay inside the ring.
  siteRingSlackM: 15,
  // Clearing houses (M7.5e step "clear", D8/D9; game values, low): during the assault each assaulting squad takes the
  // houses on its way in first, one `assault {building}` each (sim drill "clear"): those within `ringSlackM` of the
  // objective's ring and those within `corridorM` of its line from where it is to the objective, ahead of it; a house
  // is cleared if an enemy was known in it within `enemySeconds`, or it lies inside the main objective's ring while an
  // enemy is known in that ring (within `enemySeconds`), the nearest along the way first; one that failed is left for `retrySeconds`. A squad that took a house within `ringSlackM` of the main
  // objective's ring holds it (the defence's siting around it within `holdSiteM`, windows included, facing the next
  // objective or away from where the attack came from) and is not sent on unless it is the only squad left to assault.
  // Review fixes (2026-11-14): only an enemy placed within `errM` (a sight, a close report; not a far sound) marks a
  // house; a squad is sent only to houses within `reachM` of it; a house with an enemy known in it within `stillS` of
  // the drill's end is not taken (left for `retrySeconds`); a taken house is cleared again once an enemy is known in
  // it after it was taken; it is taken with at least `takenMen` able men of the squad inside (fewer if it has fewer).
  // On the approach (owner answer 2026-11-14, slice s0-clear): before the assault too — a squad advancing to the
  // support line, or an assaulting squad closing in, first clears a house with an enemy known in it (as above) that
  // lies on its way (within `approachM` of it, ahead of it, within `approachCorridorM` of its line to where it is
  // going, short of it) and overlooks that way (a sight line from where the enemy was placed, at the window height of
  // any of its floors, to the squad or to where it is going); advancing, never a house within `ringSlackM` of the ring
  // of the objective it goes for (the assault's); closing in, its line runs on to the objective, so a house of that
  // ring on its way counts; at most `approachMax` such clearings at a time, only a squad with `approachMinMen` able men.
  clear: { ringSlackM: 20, corridorM: 25, enemySeconds: 60, retrySeconds: 120, holdSiteM: 30, pendingSeconds: 20, errM: 10, reachM: 200, stillS: 15, takenMen: 2,
    approachM: 150, approachCorridorM: 60, approachMax: 1, approachMinMen: 4, storeyM: 3, eyeM: 1.5 },
  // Falling back (overnight pick "defence-fallback", game values, low confidence): a squad below half strength
  // pulls back only when a known enemy is within `threatM` of it, its objective is contested while it is within
  // `assaultSlackM` of the ring, or enemies are known within `flankM` on two sides (bearings spread `flankDeg`).
  // Its rally point: `rallyM` back (at least `rallyMinM` after the snap), up to `rallyMaxDeg` off the way away from
  // the enemy within `enemyNearM` (`rallyAsideDeg` tried), snapped to the best cover within `rallyCoverM`, scored by
  // what it sees of its objective + `coverW` x cover - `offW` x the turn, never in the open (`openExposure`) or
  // within `rallySpreadM` of another squad's. There each man takes a fire position within `rallySiteM` (siting.ts);
  // a squad holding there with `counterMinMen` able men counts for the counter-attack. `drillStartSeconds`: an order
  // whose drill never showed counts as done after this.
  fallback: { threatM: 150, assaultSlackM: 30, flankM: 300, flankDeg: 120, enemyNearM: 400, rallyM: [100, 80, 125, 150], rallyMinM: 60,
    rallyAsideDeg: [0, -15, 15, -30, 30], rallyMaxDeg: 30, rallyCoverM: 30, coverW: 0.3, offW: 0.2, openExposure: 0.9, rallySpreadM: 25, rallySiteM: 20,
    counterMinMen: 2, drillStartSeconds: 30 },
  // Anti-tank tasks (M7.4b): how often the commander looks for a shot, how fresh a vehicle contact must be, how
  // long a man waits between shots, how far beyond his weapon's range he goes after a halted vehicle (and where
  // he stops: this share of the range), how many such hunters a side sends at once and for how long.
  // Missile teams (M9.3b, game values, low): at its post within `mtArrivedM`; a move to it sent again after
  // `mtResendSeconds` if the team stopped short; the attacker's carriers wait in dead ground for its team to be ready,
  // at most `overwatchWaitSeconds`, and only while the team can still be set up on its post within that time (its
  // walk at `mtWalkMps` (the last `sneakM` at `mtSneakMps`), packing and set-up; review fix). The attacker's team sites its post on the ground
  // `mtBeyondObjectiveM` beyond the main objective (where the defence's vehicles stand).
  mtArrivedM: 15, mtResendSeconds: 60, overwatchWaitSeconds: 90, mtWalkMps: 0.9, mtSneakMps: 0.45, mtBeyondObjectiveM: 100,
  // M7.6d: an automatic grenade launcher team's post is this far from the enemy's area (within its engage range;
  // game values, low: about its effective range against point targets).
  aglMinM: 300, aglMaxM: 700,
  // M7.6d: fire orders to an AGL team on its post: at enemy men seen within `aglSeenSeconds`, placed to `aglErrM`,
  // at most one series every `aglOrderSeconds` (game values, low).
  aglSeenSeconds: 10, aglErrM: 25, aglOrderSeconds: 20,
  // M7.6d: an AGL team that has fired nothing for this long on its post moves on to its next post (game value, low).
  aglRepostSeconds: 120,
  atEverySeconds: 5, atContactSeconds: 10, atRefireSeconds: 12, huntBeyondM: 300, huntAtRangeShare: 0.8, huntersMax: 2, huntSeconds: 150, atSidestepM: 8,
  // Getting out at once on an anti-tank threat (M7.4b): enemy men known this close to a carrier, or an enemy
  // vehicle seen this close; a crew reversing out is left to it this long (its hold, behaviour crew.reverseHoldSeconds);
  // vehicles reverse this far on withdrawal.
  dismountThreatMenM: 400, dismountThreatVehicleM: 600, reverseOutHoldSeconds: 15, withdrawReverseM: 80,
  // The infantry attack (balance pass 2026-11-13, game values, low confidence; docs/research/inf-assault.md; the
  // pass also moved supportM 300 -> 330, sneakM 200 -> 50 and heEverySeconds 90 -> 45):
  // - axis (on foot): the way in is turned about the objective by up to `axisMaxDeg` so that the support line keeps
  //   `flankClearM` from the other objectives the enemy holds; their garrisons are blinded with smoke laid
  //   `blindAheadM` in front of them;
  // - support line: each squad's place is chosen once near its slot (`placeDepthsM` x `placeAsideM` around it)
  //   for its field of fire onto the objective (a line of fire allowed to end `lineAllowanceM` short of the point);
  //   a squad gone to ground short of it moves on after `resumeSeconds` (at a run under fire, at most `resumeMax`
  //   times); in place within `arrivedM`; two thirds in place is enough; the advance stops waiting after
  //   `advanceTimeoutSeconds`; the fires before the assault are called when the first squad is within the fire's
  //   delay plus `prepLeadS` of its place at a walk (overnight pick "assault-tempo" 2026-11-14, low; it was 100 m
  //   short along the axis, which on a turned axis called them minutes early);
  // - base of fire: man by man at the enemies known near the objective (full rate), lifting off any its own men are
  //   within `liftM` of; one squad keeps the other objective's garrison down;
  // - assault element: runs (screened by smoke `screenShare` of the way from the objective to the assault position)
  //   toward a point `closeInM` short, on the bearing up to `flankMaxDeg` off the axis seen least from the
  //   objectives; under fire (a man's suppression >= `underFireSuppression`) within `assaultPositionM` it goes over
  //   to fire and movement at once, and after `closeTimeoutSeconds` in any case; its grenade launchers engage
  //   from `launcherReachM`.
  // - assault tempo (overnight pick "assault-tempo" 2026-11-14, game values, low): the assault element walks to
  //   that point (sneaking the last `sneakM`), running only under fire; there, not under fire, it gets its breath
  //   back until its men's mean fatigue is below `restFatigue` or `restMaxSeconds` have passed (closeTimeoutSeconds
  //   180 -> 300 for the slower pace), and smoke is called when the rest begins, to stand as it goes in.
  // Night drills (M9.6, game values, low; all only while the light is below `belowLight`, so daylight battles are
  // unchanged): the defender fires one illumination round over the enemy men its men have seen or been told of (not
  // only heard; within `contactSeconds`) within `illumTriggerM` of the main objective or `illumAnyM` of any, once
  // there are at least `illumMinMen` of them (review fix: 450 m of any objective, heard contacts too, spent its four
  // rounds before the assault), the attacker one `illumBeyondM` beyond the objective it assaults (on the
  // axis: it silhouettes the defence for the assault element), each at most every `illumEverySeconds` while rounds
  // last; the attacker starts sneaking `sneakFactor` x `sneakM` out and lays its support line at `supportFactor` x
  // `supportM` (closer, within night sight); the defender's men fire at will only out to `defenceRangeM`.
  night: { belowLight: 0.3, illumTriggerM: 300, illumAnyM: 200, illumMinMen: 2, illumEverySeconds: 90, illumBeyondM: 150, contactSeconds: 60, sneakFactor: 2.5, supportFactor: 0.7, defenceRangeM: 200 },
  sneakM: 50, resumeSeconds: 15, resumeMax: 4, arrivedM: 40, advanceTimeoutSeconds: 600, assaultPositionM: 120, flankMaxDeg: 50, closeTimeoutSeconds: 300, closeInM: 60, underFireSuppression: 0.1, prepLeadS: 15, restFatigue: 0.35, restMaxSeconds: 60, blindAheadM: 10, axisMaxDeg: 45, screenShare: 0.5, screenHalfM: 50, screenRounds: 4, screenLeadS: 20, dangerCloseMarginM: 50, liftM: 40, lineAllowanceM: 5, placeDepthsM: [0, 20, -10], placeAsideM: [0, -20, 20, -40, 40], flankClearM: 320, launcherReachM: 200,
  // Sight realism step 5 (squads shift to see a lost enemy again; game values, low confidence: alternate and
  // supplementary positions and local repositioning in the defence, hold the ground rather than pursue, from search
  // extracts only). Defence, in "hold": a squad is looked at every `everySeconds` (staggered); it is re-sited when its
  // men know an enemy man (seen or reported, not heard) within the defence's range of fire to `errM` or better, none of
  // them has seen an enemy for `blindSeconds`, and it is neither pinned, broken, moving nor in a drill. Its men's places
  // are sited again (siting.ts, kneeling eye, a point counts at visibility `seenVisibility`) against the known
  // positions and a ring of 4 points at their uncertainty (a contact closing on it by more than `closingM` over
  // `trailSeconds` counted twice), each man within `leashM` of where he was sited (inside the objective's ring); only
  // men whose new place sees and whose place now does not are moved, at most `moveShare` of the squad, crawling within
  // `crawlM`, else walking. They go back once no contact of theirs is fresher than `restoreSeconds`. A bounded follow:
  // when the squad's freshest contact has drawn away by more than `followRecedeM` over `trailSeconds` and the squad's
  // morale is at `assaultMinMorale` or above, half the squad is sited within `followLeashM` instead (never beyond the
  // objective's ring plus that), and comes back under fire or after `followMaxSeconds`.
  // Attack: a base-of-fire squad none of whose men has seen an enemy for `baseBlindSeconds` slides along the support
  // line (`baseShiftM` either way, `baseForwardM` forward) to the spot that sees most of the enemies known near the
  // objective, at most every `baseShiftSeconds`.
  reacquire: { everySeconds: 10, blindSeconds: 6, errM: 40, leashM: 35, seenVisibility: 0.2, closingM: 10, trailSeconds: 20, moveShare: 0.5, crawlM: 8,
    restoreSeconds: 60, longBlindSeconds: 30, longRingM: 15, followRecedeM: 30, followLeashM: 50, followMaxSeconds: 60, ringPts: 4, maxContacts: 6,
    baseBlindSeconds: 60, baseShiftM: [20, -20, 40, -40, 60, -60], baseForwardM: [0, 20], baseShiftSeconds: 30 },
  // D4a (game values, low, owner to review): the platoon's reserve in the assault and the base of fire's bounds.
  reserve: { minSquads: 3, backM: 60, commitStrength: 0.6, commitSeconds: 90 },
  baseBound: { maskedLooks: 2, everySeconds: 40, stepM: 60, minM: 150, turnDeg: [20, 40, 60], shiftM: 250, stepAsideM: [3, -3, 6, -6, 9, -9], stepAsideSeconds: 30 } } as const;

type Phase = "start" | "ride" | "advance" | "recon" | "assault" | "second" | "hold" | "withdraw";
interface Memory extends TanksMemory {
  phase: Phase; phaseTick: number; target: number; lastFire: number; lastAssault: Record<string, number>; pulledBack: number[]; counterTick: number; lastGrenade?: Record<string, number>; lastHe?: number; lastSmoke?: number;
  /** M7.2 ride and dismount: the last vehicle hit it has seen (polled `lastHitTick`), squads and men ordered out,
   *  vehicles waiting for their squad to get back in during a withdrawal. */
  lastHitSeen?: number; out?: number[]; remount?: number[];
  /** M7.3 after the dismount: vehicle crews set loose (fire free), where each following vehicle was last sent,
   *  and when the vehicles last got a fire order. */
  crewsFree?: boolean; followAt?: Record<string, [number, number]>; lastVehicleFire?: number;
  /** M7.4b: crews that bailed out and were sent back; anti-tank tasks: the last look, each gunner's last shot
   *  order, and the men sent after a vehicle (target, since when). */
  sentBack?: number[]; lastAt?: number; atShot?: Record<string, number>; hunt?: Record<string, [number, number]>;
  /** M11.3: when it last shelled an enemy cache. */
  lastCacheHe?: number;
  /** M11.7b: hulls a recovery vehicle was called for, and the last look (recovery.ts). */
  recoveryCalled?: number[]; lastRecoveryLook?: number;
  /** Infantry attack (balance pass 2026-11-13): when each squad was last sent on toward its place; the assault
   *  position (bearing off the line of advance, rad); squads that have reached it (or stopped trying). */
  resumeAt?: Record<string, number>; resumeN?: Record<string, number>; flank?: number; closed?: number[]; closedAt?: Record<string, number>; maxRate?: number[]; lastBlind?: number;
  /** The turn of the attack's axis about its objective (rad), chosen once per objective. */
  axis?: number;
  /** Each squad's support-by-fire place for objective `placesFor` (chosen once from the map: its field of fire). */
  places?: Record<string, [number, number]>; placesFor?: number;
  /** Defence (overnight pick "defence-fallback"): the way the attack is expected (rad); each squad's rally point
   *  [x, y, objective index, tick ordered]; squads seen in their withdraw drill; squads rallied and placed. */
  front?: number; rally?: Record<string, [number, number, number, number]>; rallySeen?: number[]; rallied?: number[];
  /** M7.5e step "leave": per squad, the tick of the house leaving it has been re-sited after. */
  houseLeft?: Record<string, number>;
  /** M9.3b missile teams, per team: its overwatch posts [x, y, facing] (chosen once), the post it holds or goes to,
   *  the last launch it has answered (by moving on), and when it was last sent. */
  mt?: Record<string, { posts: [number, number, number][]; post: number; launch: number; sent: number }>;
  /** M7.5e step "clear": per squad, the house (building id) it was sent to clear and when; houses taken (ids); per
   *  squad, the house in the main ring it holds; per house, when its clearing last failed and when an enemy was last
   *  known in it. */
  /** M9.6 night: when it last called an illumination round; whether the defence's rules were last sent for the dark. */
  lastIllum?: number; darkRules?: boolean;
  /** M9.6 review fix: the support distance the places for `placesFor` were chosen at (frozen at dusk crossings). */
  placesD?: number;
  /** D4a: the attack's tally (read by the batch through `attackStats`): five-second looks at a base-of-fire squad
   *  and those it was masked by its own men; objectives taken; the reserve kept, committed, committed before a take. */
  att?: AttackStats;
  /** D4a: the reserve squad of the assault on the main objective (-1: committed or released; reset when the main
   *  objective is assaulted afresh), the assault squads it backs, the squad committed and when; per base-of-fire squad,
   *  its masked looks in a row and when it last bounded forward; per man, when he last stepped aside. */
  reserve?: number; reserveLead?: number[]; reserveSq?: number; reserveAt?: number; maskedRun?: Record<string, number>; baseMoved?: Record<string, number>; stepAside?: Record<string, number>;
  /** Sight realism step 5: each defender's sited place [x, y, building id or -1, window index or -1]; per squad, the
   *  men re-sited toward a lost enemy, since when, and whether it is a follow; per enemy man, where his side's
   *  freshest contact placed him at each look of the last `trailSeconds` [x, y, tick]; per base-of-fire squad, its
   *  last slide along the support line. */
  sited?: Record<string, [number, number, number, number]>; resited?: Record<string, { men: number[]; tick: number; follow: boolean }>;
  trail?: Record<string, [number, number, number][]>; baseShift?: Record<string, number>;
  /** Step 5's tally (read by the reacquire lab through `reacquireStats`). */
  rq?: ReacquireStats; rqMoved?: Record<string, number>;
  clearing?: Record<string, [number, number]>; taken?: number[]; takenAt?: Record<string, number>; held?: Record<string, number>; clearFailed?: Record<string, number>; houseSeen?: Record<string, number>;
}

/** D4a: what a commander's attack did (from its saved memory; zero for a defender). */
export interface AttackStats {
  baseLooks: number; maskedLooks: number; taken: number;
  /** Reserves held; committed (any reason); committed because the assault faltered (the rest: its lead got into a
   *  house of the objective's ring, `reserveExploit`). */
  reserveKept: number; reserveCommitted: number; committedBeforeTake: number; reserveExploit?: number;
  baseBounds: number; inLineLooks?: number; stepped?: number;
}
/** Sight realism step 5: what a commander did to see a lost enemy again (from its saved memory). */
export interface ReacquireStats {
  /** Defence: squads re-sited (looks that moved men), men moved, of them on a follow, men sent back. Attack: base-of-fire
   *  squads slid along the support line. */
  resites: number; men: number; follows: number; followMen: number; back: number; baseShifts: number;
}
export function reacquireStats(saved: unknown): ReacquireStats | null {
  const m = (saved as { rq?: ReacquireStats } | null | undefined)?.rq;
  return m === undefined ? null : { ...m };
}
export function attackStats(saved: unknown): AttackStats | null {
  const m = (saved as { att?: AttackStats } | null | undefined)?.att;
  return m === undefined ? null : { ...m };
}

/**
 * A controller's own view of the ground (built once, when first needed; derived, never saved): before each use it
 * is brought up to the view it is given, holes blown in walls (when there are new ones) and the hulls and wrecks
 * as they stand (once per tick), so sight lines and back-blast checks agree with the sim's (M7 review).
 */
export function viewGround(input: BattleInput): (view: SimView, tick: number) => SimContext {
  let ctx: SimContext | null = null;
  let seenBreaches = -1, groundTick = -1;
  return (view, tick) => {
    const c = ctx ??= createContext({ ...input, orders: [] });
    const st = view as unknown as SimState;
    if (st.terrain.breaches.length !== seenBreaches) { syncTerrainDamage(c, st); seenBreaches = st.terrain.breaches.length; }
    if (groundTick !== tick) { rebuildVehicleGrid(c, st); groundTick = tick; }
    return c;
  };
}

const able = (s: SoldierState | undefined) => s !== undefined && !isOut(s) && s.mental.behaviour !== "routed";
/** Morale rework 2026-11-15: a squad pinned down, broken or badly shaken is not sent into an assault (it waits for
 *  its leader to rally it, or for the fire to ease). */
const moraleReady = (u: { morale?: { state: string; value: number } }) =>
  u.morale === undefined || (u.morale.state !== "pinned" && u.morale.state !== "broken" && u.morale.value >= COMMANDER.assaultMinMorale);
/** M10.5: a man carrying a casualty back, gone to one, or on his way to (or at) the Verwundetennest is not the
 *  commander's to task (an order to him alone would take him out of it). */
const committed = (s: SoldierState | undefined) => s !== undefined && (s.carrying !== undefined || s.atNest !== undefined || s.intent?.kind === "care");

/** The men of a unit and its sub-units, vehicle crews left out (they fight from their vehicles). */
function members(view: SimView, uid: EntityId): EntityId[] {
  const u = view.unit.get(uid);
  if (!u) return [];
  return [...u.members, ...u.children.filter((c) => isFootUnit(view, c)).flatMap((c) => members(view, c))];
}

/** A unit on foot that fights as a squad: not a vehicle crew, nor a crew that bailed out (M7.4b). */
function isFootUnit(view: SimView, uid: EntityId): boolean {
  const u = view.unit.get(uid);
  return u !== undefined && u.vehicle === undefined && u.exVehicle === undefined && u.mortar === undefined && u.missileTeam === undefined;
}

/** Able men of a unit who are aboard a vehicle (not crew): they ride, and are never ordered to walk. */
function riders(view: SimView, uid: EntityId): EntityId[] {
  const u = view.unit.get(uid);
  if (!u || u.vehicle !== undefined) return [];
  return u.members.filter((m) => { const s = view.soldier.get(m) as SoldierState | undefined; return s?.mount !== undefined && able(s) && s.impair.canWalk; });
}

/** The anti-tank round (and its effective range) a man of the side carries ready to fire: a launcher and a round. */
function launcherReady(view: SimView, input: BattleInput, m: EntityId): { range: number; ammo: string } | null {
  const c = view.container.get(m);
  if (!c) return null;
  for (const st of c.stacks) {
    if (st.count <= 0) continue;
    const d = input.catalog.ammo[st.type]?.delivery;
    if (d?.method !== "direct" || d.launcher === undefined) continue;
    if (c.stacks.some((x) => x.type === d.launcher && x.count > 0)) return { range: d.maxRangeM ?? 300, ammo: st.type };
  }
  return null;
}

export function commanderController(side: SideId, input: BattleInput, only?: { callsign: string }): Controller {
  const objectives: readonly ObjectiveDef[] = input.rules.objectives;
  const W = input.map.widthM, H = input.map.heightM;
  const force = input.forces.find((f) => f.side === side)!;
  const doctrine = input.catalog.factions[force.faction]?.doctrine ?? {};
  const tolerance = doctrine["casualtyToleranceBeforeWithdrawal"] ?? 0.3;
  // (Step fire-support: until the volleys for effect, after the ranging rounds.)
  const fsDef = input.catalog.factions[force.faction]?.fireSupport;
  const fireDelayS = fsDef ? secondsToEffect(fsDef) : 0;
  const walkMode = input.catalog.movementModes["walk"], walkMps = walkMode?.class === "foot" ? walkMode.speedMps : 1.4;
  // Where this side starts (its men's mean position): the way back, and the side the attack comes from.
  // (M11.1: a commander of one wave — `only` — starts from where that wave's men come in.)
  const mine = only === undefined ? null : new Set(unitPersons(force.units.find((u) => u.callsign === only.callsign)));
  const starts = mine === null ? force.placements : force.placements.filter((p) => mine.has(p.personId));
  const sx = starts.reduce((a, p) => a + p.x, 0) / Math.max(1, starts.length);
  const sy = starts.reduce((a, p) => a + p.y, 0) / Math.max(1, starts.length);
  const defending = objectives.length > 0 && objectives[0]!.holder === side;
  let mem: Memory = { phase: "start", phaseTick: 0, target: 0, lastFire: -1e9, lastAssault: {}, pulledBack: [], counterTick: -1e9 };
  const every = COMMANDER.stepSeconds * 60;
  // Where the attacker gets out (M7.2, owner Q22): this far short of the objective, from its faction's doctrine;
  // without one, the plan's formula from the willingness to dismount.
  const dismountM = input.catalog.factions[force.faction]?.dismountM ?? 300 + (1 - (doctrine["willingnessToDismount"] ?? 0.5)) * 500;
  const M = input.catalog.behaviour.mounting;
  // Its own view of the ground for sight lines and back-blast checks [C58], kept up with the view (M7 review).
  const groundOf = viewGround(input);
  let curView: SimView | null = null, curTick = -1;
  const ground = (): SimContext => groundOf(curView!, curTick);
  /** Out of sight of (ox, oy) from a man standing there to a hull's top at (x, y)? */
  const hidden = (ox: number, oy: number, x: number, y: number): boolean => {
    const ctx = ground();
    // ground: ok (the commander's view of open ground)
    const z0 = heightAt(input.map, ox, oy) + 1.7, z1 = heightAt(input.map, x, y) + 2.2;
    return sight(ctx, ox, oy, z0, x, y, z1).blockedBy !== null;
  };

  // ---- falling back (overnight pick "defence-fallback"; values in COMMANDER.fallback)
  /** The way the attack is expected (rad, from the main objective): toward the middle of the map edge farthest
   *  from where the side starts. */
  const front0 = (): number => {
    const main = objectives[0]!;
    const edges = [[0, H / 2], [W, H / 2], [W / 2, 0], [W / 2, H]] as const;
    const far = edges.reduce((a, e) => (hypot2(e[0] - sx, e[1] - sy) > hypot2(a[0] - sx, a[1] - sy) ? e : a));
    return atan2(far[1] - main.y, far[0] - main.x);
  };
  /** Enemies the side's men know (not down or given up), each once: its freshest report. */
  const sideContacts = (view: SimView): { x: number; y: number }[] => {
    const best = new Map<EntityId, { x: number; y: number; tick: number }>();
    for (const [id, idn] of view.identity.entries()) {
      if (idn.side !== side) continue;
      const s = view.soldier.get(id);
      if (!s || isCaptive(s) || isOut(s)) continue;
      for (const c of s.contacts) {
        if (c.surrendered === true || c.down === true) continue;
        const b = best.get(c.target);
        if (!b || c.tick > b.tick) best.set(c.target, { x: c.x, y: c.y, tick: c.tick });
      }
    }
    return [...best.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
  };
  /** The held objective nearest to (x, y) (index; the main one if none is held). */
  const ownObjective = (x: number, y: number): number => {
    let bi = 0, bd = Infinity;
    objectives.forEach((o, i) => { const d = hypot2(o.x - x, o.y - y); if (curView!.objectives[i]?.holder === side && d < bd) { bd = d; bi = i; } });
    return bi;
  };
  /** A close threat to a squad at (cx, cy): a known enemy within `threatM`, its objective under assault (contested
   *  while it is within `assaultSlackM` of the ring), or enemies known within `flankM` on two sides (their bearings
   *  spread over `flankDeg` or more). */
  const fallbackThreat = (cx: number, cy: number): boolean => {
    const F = COMMANDER.fallback, view = curView!;
    const cs = sideContacts(view);
    if (cs.some((c) => hypot2(c.x - cx, c.y - cy) <= F.threatM)) return true;
    const oi = ownObjective(cx, cy), o = objectives[oi]!;
    if (view.objectives[oi]?.contested === true && hypot2(o.x - cx, o.y - cy) <= o.radiusM + F.assaultSlackM) return true;
    const bs = cs.filter((c) => hypot2(c.x - cx, c.y - cy) <= F.flankM).map((c) => atan2(c.y - cy, c.x - cx)).sort((a, b) => a - b);
    if (bs.length < 2) return false;
    let gap = bs[0]! + 2 * PI - bs[bs.length - 1]!;
    for (let i = 1; i < bs.length; i++) gap = Math.max(gap, bs[i]! - bs[i - 1]!);
    return 2 * PI - gap >= (F.flankDeg * PI) / 180;
  };
  /** Where the enemy is, as these men know him (within `enemyNearM` of (x, y) if any are; else the side's
   *  knowledge); null if nobody knows of any. */
  const enemyCentre = (x: number, y: number, men: EntityId[]): { x: number; y: number } | null => {
    const view = curView!;
    const own: { x: number; y: number }[] = [];
    for (const m of men) { const s = view.soldier.get(m); if (s) for (const c of s.contacts) if (c.surrendered !== true && c.down !== true) own.push(c); }
    const pick = (cs: { x: number; y: number }[]) => {
      const near = cs.filter((c) => hypot2(c.x - x, c.y - y) <= COMMANDER.fallback.enemyNearM);
      const use = near.length > 0 ? near : cs;
      return use.length === 0 ? null : { x: use.reduce((a, c) => a + c.x, 0) / use.length, y: use.reduce((a, c) => a + c.y, 0) / use.length };
    };
    return pick(own) ?? pick(sideContacts(view));
  };
  /** What a squad at its rally point must see: its objective (the centre and the ring) and the ground beyond it
   *  toward the enemy (`toward`, rad). */
  const rallyView = (o: ObjectiveDef, toward: number): { x: number; y: number }[] => {
    const pts = [{ x: o.x, y: o.y }];
    for (let k = 0; k < 8; k++) pts.push({ x: o.x + cos((k * PI) / 4) * o.radiusM, y: o.y + sin((k * PI) / 4) * o.radiusM });
    for (const r of [o.radiusM + 40, o.radiusM + 90]) for (const a of [-30, 0, 30]) {
      const b = toward + (a * PI) / 180;
      pts.push({ x: o.x + cos(b) * r, y: o.y + sin(b) * r });
    }
    return pts.filter((p) => p.x > 2 && p.y > 2 && p.x < W - 2 && p.y < H - 2);
  };
  /**
   * A squad's rally point: `rallyM` back from where it is, away from the enemy its men know (else from the way the
   * attack is expected), at most `rallyMaxDeg` off that bearing; each candidate snapped to the best cover within
   * `rallyCoverM`; the one in cover (exposure < `openExposure`) that sees most of its objective, nearest the bearing,
   * not within `rallySpreadM` of another squad's rally point.
   */
  const rallyPoint = (cx: number, cy: number, men: EntityId[], oi: number): { x: number; y: number } => {
    const F = COMMANDER.fallback, ctx = ground(), foot = navFor(ctx, "foot").grid;
    const e = enemyCentre(cx, cy, men);
    const away = e && hypot2(cx - e.x, cy - e.y) > 1 ? atan2(cy - e.y, cx - e.x) : (mem.front ?? front0()) + PI;
    const o = objectives[oi]!;
    const pts = rallyView(o, away + PI);
    const others = Object.values(mem.rally ?? {});
    let best: { x: number; y: number } | null = null, bestScore = -Infinity;
    for (const dist of F.rallyM) for (const da of F.rallyAsideDeg) {
      const b = away + (da * PI) / 180;
      const x = Math.min(Math.max(cx + cos(b) * dist, 5), W - 5), y = Math.min(Math.max(cy + sin(b) * dist, 5), H - 5);
      const q = bestCoverNear(foot, x, y, F.rallyCoverM);
      if (!q || navCostAt(foot, q.x, q.y) <= 0 || indoorAt(ctx, q.x, q.y) >= 0) continue;
      const qd = hypot2(q.x - cx, q.y - cy);
      if (qd < F.rallyMinM) continue;
      let off = Math.abs(atan2(q.y - cy, q.x - cx) - away);
      if (off > PI) off = 2 * PI - off;
      if (off > (F.rallyMaxDeg * PI) / 180) continue;
      const exp = exposureAt(foot, q.x, q.y);
      const crowd = others.some((r) => hypot2(r[0] - q.x, r[1] - q.y) < F.rallySpreadM);
      const score = seenShare(ctx, q.x, q.y, pts) + F.coverW * (1 - exp) - (exp >= F.openExposure ? 1 : 0) - (crowd ? 1 : 0) - (F.offW * off * 180) / PI / F.rallyMaxDeg;
      if (score > bestScore) { bestScore = score; best = q; }
    }
    return best ?? { x: Math.min(Math.max(cx + cos(away) * F.rallyM[0]!, 5), W - 5), y: Math.min(Math.max(cy + sin(away) * F.rallyM[0]!, 5), H - 5) };
  };

  /** Enemy vehicles these men know (seen or reported within `atContactSeconds`, not wrecks), the freshest report of
   *  each (M7.4b; shared with the missile teams, M9.3b). */
  const freshVehicleContacts = (men: readonly EntityId[]): Map<EntityId, { x: number; y: number; tick: number; moving: boolean }> => {
    const v = curView!, tick = curTick;
    const vk = new Map<EntityId, { x: number; y: number; tick: number; moving: boolean }>();
    for (const m of men) {
      const s = v.soldier.get(m);
      if (s === undefined || isCaptive(s)) continue;
      for (const c of s.contacts) {
        if (spared(c)) continue; // (M10.7a: not a recognised ambulance)
        if (c.cls !== "vehicle" || c.wreck === true || c.kind === "heard" || tick - c.tick > COMMANDER.atContactSeconds * 60) continue;
        const prev = vk.get(c.target);
        if (!prev || c.tick > prev.tick) vk.set(c.target, { x: c.x, y: c.y, tick: c.tick, moving: Math.abs(c.vx ?? 0) + Math.abs(c.vy ?? 0) > 1 });
      }
    }
    return vk;
  };
  /** Is this missile team set up on its overwatch post (M9.3b)? */
  const teamOnPost = (view: SimView, id: EntityId): boolean => {
    const mt = view.unit.get(id)?.missileTeam, st = mem.mt?.[String(id)], p = st?.posts[st.post];
    const l = launcherOf(ground(), view, id), lt = l ? view.transform.get(l.carrier) : undefined;
    return mt?.state === "ready" && (!p || (lt !== undefined && hypot2(p[0] - lt.x, p[1] - lt.y) <= COMMANDER.mtArrivedM));
  };
  /** Can this missile team still fight: rounds left and an able man (review fix)? */
  const teamLive = (view: SimView, id: EntityId): boolean => {
    const u = view.unit.get(id), l = launcherOf(ground(), view, id);
    return u !== undefined && l !== null && teamRounds(view, id, l.def.round) > 0 && u.members.some((m) => able(view.soldier.get(m) as SoldierState | undefined));
  };
  /** When this missile team will be set up on its post, s from now (Infinity: not sited, or cannot fight; review fix). */
  const teamEtaS = (view: SimView, id: EntityId, tick: number): number => {
    if (!teamLive(view, id)) return Infinity;
    if (teamOnPost(view, id)) return 0;
    const mt = view.unit.get(id)!.missileTeam!, st = mem.mt?.[String(id)], p = st?.posts[st.post];
    const l = launcherOf(ground(), view, id)!, lt = view.transform.get(l.carrier);
    if (!p || !lt) return Infinity;
    const d = hypot2(p[0] - lt.x, p[1] - lt.y);
    if (d <= COMMANDER.mtArrivedM) return mt.state === "setting" ? Math.max(0, mt.readyTick - tick) / 60 : AUTO_DEPLOY_S + l.def.setupSeconds;
    const sneak = Math.min(d, COMMANDER.sneakM); // (the last stretch sneaking, as the move is ordered)
    return (mt.state === "packed" ? 0 : l.def.packSeconds) + (d - sneak) / COMMANDER.mtWalkMps + sneak / COMMANDER.mtSneakMps + AUTO_DEPLOY_S + l.def.setupSeconds;
  };
  /** The men of the side's missile teams (M9.3b). */
  const teamMen = (view: SimView): EntityId[] => [...view.unit.values()].filter((u) => u.side === side && u.missileTeam !== undefined && u.missileTeam.kind !== "agl").flatMap((u) => u.members);
  /** M9.3b: site, move and fire the side's missile teams (see the call). */
  const missileTeams = (view: SimView, tick: number, order: (target: EntityId, body: Record<string, unknown>) => void, vk: Map<EntityId, { x: number; y: number; tick: number; moving: boolean }>): void => {
    const ids = [...view.unit.entries()].filter(([, u]) => u.side === side && u.missileTeam !== undefined && u.missileTeam.kind !== "agl").map(([id]) => id);
    if (ids.length === 0) return;
    mem.mt ??= {};
    const main = objectives[0];
    for (const id of ids) {
      const u = view.unit.get(id)!, mt = u.missileTeam!;
      const l = launcherOf(ground(), view, id);
      if (!l) continue;
      const gr = teamRound(ground(), l.def);
      const lt = view.transform.get(l.carrier);
      if (!gr || !lt) continue;
      if (!teamLive(view, id)) continue; // (review fix: no rounds or no able man: no more moves or fire orders)
      let st = mem.mt[String(id)];
      if (!st) {
        // The way the enemy comes: the defender looks out along the expected attack; the attacker at the main objective.
        // (Review fix: the attacker looks at the ground just beyond the main objective, where the defence's vehicles stand.)
        const away = main ? atan2(main.y - lt.y, main.x - lt.x) : 0;
        const enemy = defending && main ? { x: clamp(main.x + cos(front0()) * 700, W), y: clamp(main.y + sin(front0()) * 700, H) } : main ? { x: clamp(main.x + cos(away) * COMMANDER.mtBeyondObjectiveM, W), y: clamp(main.y + sin(away) * COMMANDER.mtBeyondObjectiveM, H) } : { x: W / 2, y: H / 2 };
        const anchor = defending && main ? { x: lt.x, y: lt.y } : { x: lt.x, y: lt.y };
        const nearPts = defending ? [enemy] : objectives.filter((o) => o.holder !== side).map((o) => ({ x: o.x, y: o.y }));
        const posts = siteOverwatch(ground(), anchor, enemy, l.def.sightHeightM, nearPts, l.def.backblastM, defending);
        st = mem.mt[String(id)] = { posts: posts.map((p) => [p.x, p.y, p.facing]), post: 0, launch: mt.lastLaunchTick, sent: -1e9 };
        // On its way it does not go to ground at every contact (it would set up short of its post).
        order(id, { kind: "rules", onContact: "push" });
      }
      const busy = mt.guide !== null || view.action.has(l.carrier);
      // After a launch (the missile's flight over): on to the next post.
      if (mt.lastLaunchTick !== st.launch && !busy) { st.launch = mt.lastLaunchTick; if (st.posts.length > 1) { st.post = (st.post + 1) % st.posts.length; st.sent = -1e9; } }
      const p = st.posts[st.post];
      const moving = u.moving || u.members.some((m) => (view.mover.get(m)?.waypoints.length ?? 0) > 0);
      if (p && !busy && hypot2(p[0] - lt.x, p[1] - lt.y) > COMMANDER.mtArrivedM && (!moving || st.sent < 0) && tick - st.sent >= COMMANDER.mtResendSeconds * 60) {
        const d = hypot2(p[0] - lt.x, p[1] - lt.y), k = Math.max(0, d - COMMANDER.sneakM) / Math.max(1, d);
        const wp = d > COMMANDER.sneakM ? [{ x: lt.x + (p[0] - lt.x) * k, y: lt.y + (p[1] - lt.y) * k, mode: "walk" }, { x: p[0], y: p[1], mode: "sneak" }] : [{ x: p[0], y: p[1], mode: "sneak" }];
        order(id, { kind: "move", waypoints: wp, facing: p[2] });
        st.sent = tick;
        continue;
      }
      // Ready with nothing in flight: the enemy vehicle in its range that threatens the own carriers most (nearest
      // to one of them), else the nearest to the team.
      if (mt.state !== "ready" || busy || mt.queued !== undefined || vk.size === 0) continue;
      const hulls = [...view.vehicle.entries()].filter(([, v]) => v.side === side && !isOffMap(v) && v.status !== "destroyed" && v.status !== "abandoned").map(([vid]) => view.transform.get(vid)).filter((q) => q !== undefined);
      let best: { id: EntityId; x: number; y: number; score: number } | null = null;
      for (const [vid, k] of [...vk.entries()].sort((a, b) => a[0] - b[0])) {
        const d = hypot2(k.x - lt.x, k.y - lt.y);
        if (d < gr.g.minRangeM || d > gr.g.maxRangeM) continue;
        const threat = hulls.reduce((a, q) => Math.min(a, hypot2(q.x - k.x, q.y - k.y)), Infinity);
        const score = hulls.length > 0 ? threat : d;
        if (!best || score < best.score) best = { id: vid, x: k.x, y: k.y, score };
      }
      if (best) order(id, { kind: "fire", x: clamp(best.x, W), y: clamp(best.y, H), contact: best.id, nature: "at" });
    }
  };

  /**
   * M7.6d: site and move the side's automatic grenade launcher teams: each to an overwatch post (sited once, within
   * its engage range of the enemy's area: the attacker's main objective, the defender's expected attack), sneaking
   * the last stretch; there the sim sets it up and it fires on its own at the enemy men its men see, and on the
   * commander's orders at those the side sees; with nothing to fire at for `aglRepostSeconds` it moves to its next post.
   */
  const aglTeams = (view: SimView, tick: number, order: (target: EntityId, body: Record<string, unknown>) => void, men: readonly EntityId[], sideSpared: ReadonlySet<EntityId>): void => {
    const ids = [...view.unit.entries()].filter(([, u]) => u.side === side && u.missileTeam?.kind === "agl").map(([id]) => id);
    if (ids.length === 0) return;
    mem.mt ??= {};
    const main = objectives[0];
    for (const id of ids) {
      const u = view.unit.get(id)!;
      const l = aglOf(ground(), view, id), lt = l ? view.transform.get(l.carrier) : undefined;
      if (!l || !lt || !u.members.some((m) => able(view.soldier.get(m) as SoldierState | undefined))) continue;
      let st = mem.mt[String(id)];
      if (!st) {
        const away = main ? atan2(main.y - lt.y, main.x - lt.x) : 0;
        const enemy = defending && main ? { x: clamp(main.x + cos(front0()) * 500, W), y: clamp(main.y + sin(front0()) * 500, H) } : main ? { x: clamp(main.x + cos(away) * 50, W), y: clamp(main.y + sin(away) * 50, H) } : { x: W / 2, y: H / 2 };
        const nearPts = defending ? [enemy] : objectives.filter((o) => o.holder !== side).map((o) => ({ x: o.x, y: o.y }));
        const posts = siteOverwatch(ground(), { x: lt.x, y: lt.y }, enemy, l.def.sightHeightM, nearPts, 0, defending, { rangeM: [COMMANDER.aglMinM, Math.min(COMMANDER.aglMaxM, l.def.engageRangeM)], targetZ: 1, targetRingsM: [0, 60, 120] });
        st = mem.mt[String(id)] = { posts: posts.map((p) => [p.x, p.y, p.facing]), post: 0, launch: -1e9, sent: -1e9 };
        order(id, { kind: "rules", onContact: "push" });
      }
      const p = st.posts[st.post];
      const moving = u.moving || u.members.some((m) => (view.mover.get(m)?.waypoints.length ?? 0) > 0);
      if (p && hypot2(p[0] - lt.x, p[1] - lt.y) > COMMANDER.mtArrivedM && (!moving || st.sent < 0) && tick - st.sent >= COMMANDER.mtResendSeconds * 60) {
        const d = hypot2(p[0] - lt.x, p[1] - lt.y), k = Math.max(0, d - COMMANDER.sneakM) / Math.max(1, d);
        const wp = d > COMMANDER.sneakM ? [{ x: lt.x + (p[0] - lt.x) * k, y: lt.y + (p[1] - lt.y) * k, mode: "walk" }, { x: p[0], y: p[1], mode: "sneak" }] : [{ x: p[0], y: p[1], mode: "sneak" }];
        order(id, { kind: "move", waypoints: wp, facing: p[2] });
        st.sent = tick;
        continue;
      }
      // Ready on its post with nothing to fire at: the enemy men the side's men saw (within `aglSeenSeconds`, placed
      // to within `aglErrM`) in its range and in the gun's line, the biggest group first, as an ordered series (its
      // own fire only takes what its own two or three men see).
      const mt = u.missileTeam!;
      // Nothing to fire at from here for a while (its last order, or since it was laid): on to its next post.
      // (Review fix: its own bursts count as firing: a team firing on its own is not moved.)
      if (mt.state === "ready" && mt.burst === undefined && st.posts.length > 1 && tick - Math.max(st.launch, mt.readyTick, mt.lastLaunchTick) > COMMANDER.aglRepostSeconds * 60) {
        st.post = (st.post + 1) % st.posts.length; st.sent = -1e9; st.launch = tick;
        continue;
      }
      if (mt.state !== "ready" || mt.burst !== undefined || mt.queued !== undefined || view.action.has(l.carrier) || tick - st.launch < COMMANDER.aglOrderSeconds * 60) continue;
      const cands: { x: number; y: number; n: number; d: number }[] = [];
      // (Review fix: never at an enemy any of the side's men spares, nor where a burst would reach a man its men
      // recognise as protected: a medic, bearers, a man at the Verwundetennest; nor near its own men.)
      const prot: { x: number; y: number }[] = [];
      for (const m of men) {
        const sm = view.soldier.get(m);
        if (sm === undefined || isCaptive(sm)) continue;
        for (const c of sm.contacts) {
          if (protectedContact(c)) prot.push({ x: c.x, y: c.y });
          if (c.cls === "vehicle" || c.kind !== "seen" || c.down === true || c.surrendered === true || spared(c) || sideSpared.has(c.target) || c.errM > COMMANDER.aglErrM || tick - c.tick > COMMANDER.aglSeenSeconds * 60) continue;
          const d = hypot2(c.x - lt.x, c.y - lt.y);
          if (d < COMMANDER.aglMinM * 0.5 || d > l.def.engageRangeM) continue;
          if (cands.some((q) => hypot2(q.x - c.x, q.y - c.y) < 3)) continue;
          cands.push({ x: c.x, y: c.y, n: 0, d });
        }
      }
      for (const a of cands) for (const b of cands) if (hypot2(a.x - b.x, a.y - b.y) <= 10) a.n++;
      cands.sort((a, b) => b.n - a.n || a.d - b.d || a.x - b.x || a.y - b.y);
      const z0 = heightAt(ground().map, lt.x, lt.y) + l.def.sightHeightM; // ground: ok (the gun on the ground)
      const own = men.filter((m) => { const s = view.soldier.get(m) as SoldierState | undefined; return s !== undefined && !isOut(s) && s.mount === undefined; }).map((m) => view.transform.get(m)).filter((t) => t !== undefined);
      const safe = cands.filter((c) => {
        const r = aglDangerM(ground(), c.d);
        return !prot.some((p) => hypot2(p.x - c.x, p.y - c.y) <= AGL_BURST_M) && !own.some((t) => hypot2(t.x - c.x, t.y - c.y) <= r);
      });
      for (const c of safe.slice(0, 4)) {
        const r = sight(ground(), lt.x, lt.y, z0, c.x, c.y, heightAt(ground().map, c.x, c.y) + 1, l.carrier, -1); // ground: ok (a man on the ground)
        if (r.blockedBy !== null && (1 - r.blockedAt) * c.d > 40) continue;
        order(id, { kind: "fire", x: clamp(c.x, W), y: clamp(c.y, H) });
        st.launch = tick;
        break;
      }
    }
  };

  /**
   * Sight realism step 5: defending squads shift to see a lost enemy again (values and rules in COMMANDER.reacquire).
   * `known`: what a man knows of the enemy the commander may act on (not spared); `rangeM`: the defence's range of fire.
   */
  const reacquire = (view: SimView, tick: number, groups: readonly [EntityId, EntityId[]][], order: (t: EntityId, body: Record<string, unknown>) => void,
    known: (m: EntityId) => readonly Contact[], rangeM: number): void => {
    const RQ = COMMANDER.reacquire, ctx = ground(), map = ctx.map, step = Math.floor(tick / every);
    const sited = mem.sited ??= {}, resited = mem.resited ??= {}, trail = mem.trail ??= {};
    const tally = mem.rq ??= { resites: 0, men: 0, follows: 0, followMen: 0, back: 0, baseShifts: 0 };
    const fresh = (m: EntityId, s: number) => { const t = view.soldier.get(m)?.sawEnemyTick; return t !== undefined && tick - t < s * 60; };
    // Where the side's freshest contacts put each enemy man, over the last `trailSeconds` (one entry a look).
    const latest = new Map<EntityId, { x: number; y: number; tick: number }>();
    for (const [, ms] of groups) for (const m of ms) for (const c of known(m)) {
      if (c.cls === "vehicle" || c.kind === "heard" || c.down === true || c.surrendered === true) continue;
      const b = latest.get(c.target);
      if (!b || c.tick > b.tick) latest.set(c.target, c);
    }
    for (const [id, c] of [...latest.entries()].sort((a, b) => a[0] - b[0])) {
      const l = trail[String(id)] ??= [];
      if (l.length === 0 || l[l.length - 1]![2] !== c.tick) l.push([c.x, c.y, c.tick]);
      while (l.length > 1 && tick - l[1]![2] >= RQ.trailSeconds * 60) l.shift();
    }
    for (const k of Object.keys(trail)) { const l = trail[k]!; if (l.length === 0 || tick - l[l.length - 1]![2] > RQ.restoreSeconds * 60) delete trail[k]; }
    /** How far (m) this enemy's known place came nearer (x, y) over the trail (negative: drew away). */
    const closing = (id: EntityId, x: number, y: number): number => {
      const l = trail[String(id)];
      if (!l || l.length < 2) return 0;
      const a = l[0]!, b = l[l.length - 1]!;
      if (b[2] - a[2] < (RQ.trailSeconds / 2) * 60) return 0;
      return hypot2(a[0] - x, a[1] - y) - hypot2(b[0] - x, b[1] - y);
    };
    const back = (m: EntityId) => {
      const p = sited[String(m)], t = view.transform.get(m);
      if (!p || !t || (p[2] < 0 && hypot2(p[0] - t.x, p[1] - t.y) <= 2)) return;
      if (p[2] >= 0) order(m, { kind: "occupy", building: p[2], windowIndex: p[3], mode: "walk" });
      else order(m, { kind: "move", waypoints: [{ x: p[0], y: p[1], mode: hypot2(p[0] - t.x, p[1] - t.y) <= RQ.crawlM ? "crawl" : "walk" }], facing: mem.front ?? t.heading });
    };
    groups.forEach(([sq, ms], i) => {
      const u = view.unit.get(sq), key = String(sq);
      if (!u) return;
      const men = ms.filter((m) => { const s = view.soldier.get(m) as SoldierState | undefined; return able(s) && !committed(s) && s!.mount === undefined && s!.impair.canWalk && view.transform.has(m); }).sort((a, b) => a - b);
      if (men.length === 0) { delete resited[key]; return; }
      // Back to where they were sited: no contact of theirs fresher than `restoreSeconds`; a follow also under fire
      // or after `followMaxSeconds`.
      const r = resited[key];
      if (r) {
        const anyFresh = men.some((m) => known(m).some((c) => c.cls !== "vehicle" && c.down !== true && c.surrendered !== true && tick - c.tick <= RQ.restoreSeconds * 60));
        const live = r.men.filter((m) => men.includes(m));
        const hit = live.some((m) => (view.soldier.get(m)?.mental.suppression ?? 0) >= COMMANDER.underFireSuppression);
        if (live.length === 0 || !anyFresh || (r.follow && (hit || tick - r.tick >= RQ.followMaxSeconds * 60))) {
          // (A house clearing under way: the record waits for its end, then they are sent back — review fix. An assault,
          // a withdrawal or a rout has taken them elsewhere on purpose: they stay with it.)
          if (u.drill?.kind === "clear" && live.length > 0) return;
          if (!u.drill) for (const m of live) { back(m); tally.back++; }
          delete resited[key];
          return;
        }
        // (A follow under way is not added to; a re-siting may be, while the squad is still blind.)
        if (r.follow) return;
      }
      if ((step + i) % Math.max(1, Math.round(RQ.everySeconds / COMMANDER.stepSeconds)) !== 0) return;
      // (Not `moving`: a man of it still on his way is left out below, the others may shift.)
      if (u.drill || u.broken || u.morale?.state === "pinned" || u.morale?.state === "broken") return;
      // The men who may shift: blind for `blindSeconds`, not pinned or panicked, not under fire, halted, not moved for
      // this in the last `everySeconds` x 2.
      const lastMoved = mem.rqMoved ??= {};
      const blind = men.filter((m) => {
        const s = view.soldier.get(m)!, b = s.mental.behaviour;
        return !fresh(m, RQ.blindSeconds) && b !== "pinned" && b !== "panicked" && s.mental.suppression < COMMANDER.underFireSuppression
          && (view.mover.get(m)?.waypoints.length ?? 0) === 0 && tick - (lastMoved[String(m)] ?? -1e9) >= 2 * RQ.everySeconds * 60;
      });
      if (blind.length === 0) return;
      const allBlind = !men.some((m) => fresh(m, RQ.blindSeconds));
      // The enemy men its men know well enough, the freshest of each, within the range of fire of one of them.
      const cs = new Map<EntityId, { x: number; y: number; z?: number; tick: number; posture?: string; err: number }>();
      for (const m of men) for (const c of known(m)) {
        if (c.cls === "vehicle" || c.kind === "heard" || c.down === true || c.surrendered === true) continue;
        const err = contactErrorM(ctx, c, tick);
        if (err > RQ.errM) continue;
        const b = cs.get(c.target);
        if (b && b.tick >= c.tick) continue;
        if (!men.some((f) => { const t = view.transform.get(f)!; return hypot2(c.x - t.x, c.y - t.y) <= rangeM; })) continue;
        cs.set(c.target, { x: c.x, y: c.y, ...(c.z !== undefined ? { z: c.z } : {}), tick: c.tick, ...(c.posture !== undefined ? { posture: c.posture } : {}), err });
      }
      if (cs.size === 0) return;
      const cx = men.reduce((a, m) => a + view.transform.get(m)!.x, 0) / men.length, cy = men.reduce((a, m) => a + view.transform.get(m)!.y, 0) / men.length;
      const list = [...cs.entries()].sort((a, b) => hypot2(a[1].x - cx, a[1].y - cy) - hypot2(b[1].x - cx, b[1].y - cy) || a[0] - b[0]).slice(0, RQ.maxContacts);
      // A follow: the freshest contact drew away (and none comes nearer), the squad steady enough.
      const freshest = [...list].sort((a, b) => b[1].tick - a[1].tick || a[0] - b[0])[0]!;
      const follow = allBlind && blind.length === men.length && closing(freshest[0], cx, cy) < -RQ.followRecedeM && !list.some(([id]) => closing(id, cx, cy) > RQ.closingM) && moraleReady(u);
      const pts: { x: number; y: number; h: number }[] = [];
      for (const [id, c] of list) {
        const h = (TARGET_POINT_M[(c.posture ?? "crouching") as keyof typeof TARGET_POINT_M] ?? 0.75) + (c.z ?? 0);
        const one = [{ x: c.x, y: c.y, h }];
        const rr = Math.max(3, c.err);
        for (let k = 0; k < RQ.ringPts; k++) {
          const a = (2 * PI * k) / RQ.ringPts, x = c.x + cos(a) * rr, y = c.y + sin(a) * rr;
          if (x > 2 && y > 2 && x < W - 2 && y < H - 2) one.push({ x, y, h });
        }
        pts.push(...one);
        if (closing(id, cx, cy) > RQ.closingM) pts.push(...one); // (a closing enemy counts twice)
      }
      const inPosition = (m: EntityId): boolean => { const t = view.transform.get(m)!; return t.z === 0 && positionAt(ctx, view, t.x, t.y) >= 0; };
      // Does he see any of the points from where he is now (kneeling outdoors, at his own eye indoors)?
      const seesNow = (m: EntityId): boolean => {
        const t = view.transform.get(m)!, s = view.soldier.get(m)!;
        const indoor = t.z > 0 || indoorAt(ctx, t.x, t.y) >= 0;
        const z0 = standZ(map, t) + eyeHeightM(ctx, indoor && s.posture === "standing" ? "standing" : "crouching");
        // ground: ok (the target points are on open ground)
        return pts.some((p) => sight(ctx, t.x, t.y, z0, p.x, p.y, heightAt(map, p.x, p.y) + p.h).visibility >= RQ.seenVisibility);
      };
      // (Only a blind man who sees none of them where he is may shift: if there is none, nothing to work out — review
      // fix, a cost bound; the others are anchored where they are.)
      // (M11: a man in a dug fighting position keeps it: a prepared defence does not leave its holes to look.)
      const shift = blind.filter((m) => !seesNow(m) && !inPosition(m));
      if (shift.length === 0) return;
      // (A squad blind as a whole for `longBlindSeconds` may reach as far as a follow, within the ring plus `longRingM`.)
      const longBlind = allBlind && men.every((m) => !fresh(m, RQ.longBlindSeconds));
      const leash = follow || longBlind ? RQ.followLeashM : RQ.leashM;
      const anchors = new Map<number, { x: number; y: number; r: number }>();
      for (const m of men) {
        const t = view.transform.get(m)!;
        let p = sited[String(m)];
        // (A man far from where he was sited — a counter-attack, a rally — is anchored where he is now.)
        if (!p || hypot2(p[0] - t.x, p[1] - t.y) > 2 * RQ.followLeashM) p = sited[String(m)] = [t.x, t.y, -1, -1];
        // (The others keep their places: anchored where they are.)
        anchors.set(m, shift.includes(m) ? { x: p[0], y: p[1], r: leash } : { x: t.x, y: t.y, r: 1 });
      }
      const o = objectives.find((ob) => ob.holder === side && hypot2(ob.x - cx, ob.y - cy) <= ob.radiusM + COMMANDER.siteRingSlackM);
      const ring = o ? { x: o.x, y: o.y, r: o.radiusM + (follow ? RQ.followLeashM : longBlind ? RQ.longRingM : COMMANDER.siteRingSlackM) } : undefined;
      // Places the side's other men hold: kept clear.
      const takenBy: { x: number; y: number; bi: number; z: number }[] = [];
      for (const [id, idn] of view.identity.entries()) {
        if (idn.side !== side || men.includes(id)) continue;
        const t = view.transform.get(id), s = view.soldier.get(id);
        if (!t || !s || isOut(s) || s.mount !== undefined) continue;
        const w = view.mover.get(id)?.waypoints, end = w && w.length > 0 ? w[w.length - 1]! : t;
        takenBy.push({ x: end.x, y: end.y, bi: indoorAt(ctx, end.x, end.y), z: end.z ?? 0 });
      }
      const places = siteDefence(ctx, [{ men: men.map((m) => { const t = view.transform.get(m)!; return { id: m, x: t.x, y: t.y }; }), cx, cy, ...(ring ? { ring } : {}) }], pts, leash,
        { anchors, taken: takenBy, eyePosture: "crouching", seenVisibility: RQ.seenVisibility });
      const maxMove = Math.max(1, Math.floor(men.length * RQ.moveShare));
      const moved: number[] = [];
      const faceX = list.reduce((a, [, c]) => a + c.x, 0) / list.length, faceY = list.reduce((a, [, c]) => a + c.y, 0) / list.length;
      for (const p of [...places].sort((a, b) => (b.seen ?? 0) - (a.seen ?? 0) || a.id - b.id)) {
        if (moved.length >= maxMove) break;
        if (!p.move || (p.seen ?? 0) <= 0 || !shift.includes(p.id)) continue;
        lastMoved[String(p.id)] = tick;
        const t = view.transform.get(p.id)!;
        if (p.building !== undefined) order(p.id, { kind: "occupy", building: p.building, windowIndex: p.windowIndex, mode: "walk" });
        else order(p.id, { kind: "move", waypoints: [{ x: p.x, y: p.y, mode: hypot2(p.x - t.x, p.y - t.y) <= RQ.crawlM ? "crawl" : "walk" }], facing: atan2(faceY - p.y, faceX - p.x) });
        moved.push(p.id);
      }
      if (moved.length > 0) {
        tally.resites++; tally.men += moved.length;
        if (follow) { tally.follows++; tally.followMen += moved.length; }
        // (A follow starts its clock now; a re-siting adds its men to those already shifted.)
        resited[key] = { men: [...new Set([...(r?.men ?? []), ...moved])].sort((a, b) => a - b), tick: follow || !r ? tick : r.tick, follow };
      }
    });
  };

  const ctl: Controller = {
    side,
    think(view, tick): Order[] {
      if (view.ended || tick % every !== 0) return [];
      curView = view; curTick = tick;
      const out: Order[] = [];
      // (M10.5: never an order to a man alone who carries a casualty, is with one, or is on his way to or at the
      // Verwundetennest: it would take him out of that.)
      // (M10.6b: nor to a hull on a rear run, nor "mount" to the squad it carries: the run is its own task.)
      const onRun = (target: EntityId, kind: unknown) => {
        const u = view.unit.get(target);
        const vid = u?.vehicle ?? (kind === "mount" ? u?.carrier : undefined);
        const v = vid === undefined ? undefined : view.vehicle.get(vid);
        // (M11.7b: nor to the crew of a hull on a recovery vehicle's tow bar or towed away, nor "mount" onto one.)
        return v !== undefined && (v.rearRun !== undefined || v.towedBy !== undefined || v.towAway === true);
      };
      // (M11.7a: nor a move to a crew at a field repair, unless the platoon assaults or withdraws: then the move, the
      // commander's choice, ends the repair.)
      const repairing = (target: EntityId, kind: unknown) => {
        if (kind !== "move" || mem.phase === "assault" || mem.phase === "withdraw") return false;
        const vid = view.unit.get(target)?.vehicle;
        return vid !== undefined && view.vehicle.get(vid)?.repair?.working === true;
      };
      const order = (target: EntityId, body: Record<string, unknown>) => { if (!committed(view.soldier.get(target) as SoldierState | undefined) && !onRun(target, body["kind"]) && !repairing(target, body["kind"])) out.push({ tick, issuer: side, target, ...body } as Order); };
      // Every platoon of the side (the attacker may have two): their squads and their own men.
      // (M8.3a: a mortar section fires missions; it is not a platoon to manoeuvre.)
      // (M9.3b: nor a missile team: it is sited and fired below; its men's eyes still count for what the side knows.)
      // (M10.6a: nor an off-map asset's crew: an ambulance is called by the casualties' platoon, never commanded.)
      // (M7.6b: nor a tank section: it is sited and moved below, tanks.ts.)
      const tops = [...view.unit.entries()].filter(([id, u]) => u.side === side && u.parent === null && !isMortarUnit(view, id) && u.missileTeam === undefined && !isArmourSection(view, ground(), id) && !isAssetUnit(view, id) && (only === undefined || u.callsign === only.callsign));
      if (tops.length === 0) return out;
      const topIds = tops.map(([id]) => id);
      // Squads on foot and vehicle crews (M7.2), paired by the squad's carrier.
      const children = tops.flatMap(([, u]) => u.children).sort((a, b) => a - b);
      const squads = children.filter((c) => isFootUnit(view, c));
      const crews = children.filter((c) => view.unit.get(c)?.vehicle !== undefined);
      // Crews that bailed out (M7.4b): on foot, they go back to where the side started (once each).
      const bailed = children.filter((c) => view.unit.get(c)?.exVehicle !== undefined);
      const crewOfVehicle = (vid: EntityId | undefined) => crews.find((c) => view.unit.get(c)?.vehicle === vid);
      // (M10.5: not the medic seeing to a casualty, nor a wounded man on his way to the nest.)
      const hq = tops.flatMap(([, u]) => u.members).filter((m) => able(view.soldier.get(m) as SoldierState | undefined) && !committed(view.soldier.get(m) as SoldierState | undefined));
      const toAll = (body: Record<string, unknown>) => { for (const id of topIds) order(id, body); };
      // What its men know of the enemy: not what its own prisoners know, and never an enemy they know has
      // given up (M6.6: the commander does not fire, shell or throw at him), nor one they recognise as protected
      // (M10.7a: a medic, an ambulance, bearers, men at the Verwundetennest).
      // (Review fix: what one of its men recognises the commander knows over the radio. He orders no fire at an enemy
      // any of them spares: a squad that has not recognised the bearers would fire as ordered, one that has would
      // refuse, again and again.)
      const sideSpared = new Set<EntityId>();
      for (const id of topIds) for (const m of members(view, id)) { const s = view.soldier.get(m); if (s !== undefined && !isCaptive(s)) for (const c of s.contacts) if (spared(c)) sideSpared.add(c.target); }
      const known = (m: EntityId) => { const s = view.soldier.get(m); return s === undefined || isCaptive(s) ? [] : s.contacts.filter((c) => !spared(c) && !sideSpared.has(c.target)); };
      // Men only (M7.3): no mortar, grenade or rifle base of fire at a vehicle contact (plan §12).
      const knownMen = (m: EntityId) => known(m).filter((c) => c.cls !== "vehicle");
      // Fire is called through the first platoon that still has a man who can use the radio.
      const caller = topIds.find((id) => members(view, id).some((m) => { const s = view.soldier.get(m); return able(s as SoldierState | undefined) && s!.impair.canSpeak; })) ?? topIds[0]!;
      // M10.5: bearers carrying a casualty back, carers with one and men at the Verwundetennest are committed.
      const strength = (uid: EntityId) => { const ms = members(view, uid); return ms.length ? ms.filter((m) => { const s = view.soldier.get(m) as SoldierState | undefined; return able(s) && !committed(s); }).length / ms.length : 0; };
      /** Men not killed or out (a man who panicked and ran is not lost: his unit rallies). */
      const fitShare = (uid: EntityId) => { const ms = members(view, uid); return ms.length ? ms.filter((m) => { const s = view.soldier.get(m); return s !== undefined && !isOut(s); }).length / ms.length : 0; };
      const all = topIds.flatMap((id) => members(view, id));
      // ---- night (M9.6): the light its men see by; the attack's distances and the illumination round.
      const N = COMMANDER.night, dark = view.environment.light < N.belowLight;
      const sneakM = dark ? COMMANDER.sneakM * N.sneakFactor : COMMANDER.sneakM;
      const supportM = dark ? COMMANDER.supportM * N.supportFactor : COMMANDER.supportM;
      /** One illumination round over (x, y), by the mortars, else the artillery (not while its battery is moving;
       *  danger close: a flare does no blast harm, and the point is always near own men); at most every
       *  `illumEverySeconds`, counted from the last call actually sent. */
      const illumCall = (x: number, y: number): boolean => {
        if (tick - (mem.lastIllum ?? -1e9) < N.illumEverySeconds * 60) return false;
        const artSec = view.support.find((s) => s.side === side && s.asset === "artillery");
        const artReady = artSec !== undefined && (artSec.movingUntil === undefined || tick >= artSec.movingUntil);
        const asset = supportLeft(view, side, "illum", input.catalog) > 0 ? "mortar" : artReady && supportLeft(view, side, "illum", input.catalog, "artillery") > 0 ? "artillery" : null;
        if (asset === null) return false;
        order(caller, { kind: "callFire", x: clamp(x, W), y: clamp(y, H), ammo: "illum", rounds: 1, ...(asset === "artillery" ? { asset, dangerClose: true } : {}) });
        mem.lastIllum = tick;
        return true;
      };
      // M8.5: smoke as a screen across the line from the enemy (fromX, fromY) to (cx, cy), `screenHalfM` either side,
      // laid upwind by the wind over `screenLeadS` so it drifts onto the line (with no wind: on it).
      const screen = (cx: number, cy: number, fromX: number, fromY: number) => {
        const dx = cx - fromX, dy = cy - fromY, d = Math.max(1, hypot2(dx, dy)), px = -dy / d, py = dx / d;
        const env = view.environment, lead = COMMANDER.screenLeadS;
        const mx = clamp(cx - env.windX * lead, W), my = clamp(cy - env.windY * lead, H), L = COMMANDER.screenHalfM;
        order(caller, { kind: "callFire", x: clamp(mx - px * L, W), y: clamp(my - py * L, H), x2: clamp(mx + px * L, W), y2: clamp(my + py * L, H), ammo: "smoke", rounds: COMMANDER.screenRounds });
      };
      // M8.5: high explosive by the artillery when the side has it, no own man is within its danger-close distance
      // and the battery is not moving (airburst on men seen in the open where it has the fuse), else by the mortars.
      const artDef = input.catalog.factions[force.faction]?.artillery;
      const heCall = (x: number, y: number, rounds: number) => {
        // M10.7a: never a mission on a place where all its men know is protected people.
        const spare = input.catalog.medical?.protection.missionSpareM;
        if (spare !== undefined) { const cs: SoldierState["contacts"] = []; for (const m of all) { const s = view.soldier.get(m); if (s && !isCaptive(s)) cs.push(...s.contacts); } if (onlyProtectedAt(cs, x, y, spare)) return; }
        const sec = view.support.find((s) => s.side === side && s.asset === "artillery");
        const left = supportLeft(view, side, "he", input.catalog, "artillery");
        const dc = artDef?.dangerCloseM ?? 0;
        const clear = !all.some((f) => { const ft = view.transform.get(f); return ft !== undefined && !isOut(view.soldier.get(f) as SoldierState) && hypot2(ft.x - x, ft.y - y) < dc + COMMANDER.dangerCloseMarginM; });
        if (artDef && sec && left > 0 && clear && (sec.movingUntil === undefined || tick >= sec.movingUntil)) {
          let open = 0, n = 0;
          for (const m of all) for (const c of knownMen(m)) { if (hypot2(c.x - x, c.y - y) > 60) continue; n++; if (indoorAt(ground(), c.x, c.y) === null) open++; }
          const air = artDef.airburstHeightM !== undefined && n > 0 && open * 2 >= n;
          order(caller, { kind: "callFire", x, y, ammo: "he", rounds: Math.min(rounds, left), asset: "artillery", ...(air ? { fuse: "airburst" } : {}) });
          return;
        }
        order(caller, { kind: "callFire", x, y, ammo: "he", rounds });
      };
      // Vehicles (M7.2): the polled state the plan lists (§12): status, arrival, hits since the last look.
      const vehicleOf = (c: EntityId) => { const vid = view.unit.get(c)?.vehicle; return vid === undefined ? undefined : view.vehicle.get(vid); };
      const hitNow = crews.some((c) => (vehicleOf(c)?.lastHitTick ?? -1e9) > (mem.lastHitSeen ?? -1e9));
      for (const c of crews) mem.lastHitSeen = Math.max(mem.lastHitSeen ?? -1e9, vehicleOf(c)?.lastHitTick ?? -1e9);
      // Its own vehicles (a crew that bailed out no longer has one: count the hulls of its side).
      // (M7.6b: the platoons' own hulls: not the tank sections'.)
      const tankVids = tankVehicles(view, ground(), side);
      const ownVehicles = [...view.vehicle.entries()].filter(([vid, v]) => v.side === side && v.offMap === undefined && !tankVids.has(vid)).map(([, v]) => v);
      const tankCrews = [...view.unit.entries()].filter(([id, u]) => u.side === side && isArmourSection(view, ground(), id)).flatMap(([, u]) => u.children).filter((c) => view.unit.get(c)?.vehicle !== undefined).sort((a, b) => a - b);
      /** M7.6b: the side's tank sections (tanks.ts); returns the tanks not yet on their first post. */
      const tanks = (ux: number, uy: number, backOf: (c: EntityId) => Record<string, unknown>): number => {
        if (tankCrews.length === 0) return 0;
        const ownFoot = all.filter((m) => { const s = view.soldier.get(m) as SoldierState | undefined; return able(s) && s!.mount === undefined; }).map((m) => view.transform.get(m)).filter((x) => x !== undefined);
        return tankSections({ view, tick, side, ctx: ground(), objectives, mem, order, defending, ux, uy, phase: mem.phase, phaseTick: mem.phaseTick, remounting: mem.remount?.length ?? 0, ownFoot, back: backOf, reverseHoldSeconds: COMMANDER.reverseOutHoldSeconds });
      };
      // (M11.7a: an immobilised hull whose crew is at a repair with under 300 s of work left for two men is not lost.)
      const fixing = (v: (typeof ownVehicles)[number]) => v.repair?.working === true && (v.repair.needManS - v.repair.doneManS) / 2 < 300;
      const lostVehicles = ownVehicles.filter((v) => v.status === "destroyed" || v.status === "abandoned" || (v.status === "immobilised" && !fixing(v))).length;
      // M11.7b: a recovery vehicle for a hull out of the fight for good, when it is quiet there (recovery.ts).
      for (const o of recoveryCalls(view, ground(), side, tick, mem, () => all.flatMap((m) => known(m)), caller)) out.push(o);
      mem.sentBack ??= [];
      // (M7.6b review fix: the tank sections' crews that bailed out too.)
      const tankBailed = [...view.unit.entries()].filter(([id, u]) => u.side === side && isArmourSection(view, ground(), id)).flatMap(([, u]) => u.children).filter((c) => view.unit.get(c)?.exVehicle !== undefined).sort((a, b) => a - b);
      for (const c of [...bailed, ...tankBailed]) {
        if (mem.sentBack.includes(c)) continue;
        order(c, { kind: "move", waypoints: [{ x: clamp(sx, W), y: clamp(sy, H), mode: "run" }] });
        mem.sentBack.push(c);
      }
      // ---- anti-tank tasks (M7.4b): men with a Panzerfaust or an RPG engage the enemy vehicles their side knows
      // within their weapon's range (an order to the man: he fires once, his squad's drill goes on), under their
      // unit's anti-tank rule; a halted vehicle a little beyond it is stalked by up to two of them, who go to a
      // point inside their range on the line to it (the AI's "tank-hunting team").
      if (mem.phase !== "start" && mem.phase !== "ride" && tick - (mem.lastAt ?? -1e9) >= COMMANDER.atEverySeconds * 60) {
        mem.lastAt = tick;
        mem.atShot ??= {}; mem.hunt ??= {};
        // Enemy vehicles its men know (seen or reported recently, not wrecks), the freshest report of each.
        const vk = freshVehicleContacts(all);
        // Hunters whose target is gone, or who have been out long enough, are let go (their squad's next order takes them back).
        for (const [k, h] of Object.entries(mem.hunt)) if (!vk.has(h[0]) || tick - h[1] > COMMANDER.huntSeconds * 60) delete mem.hunt[k];
        if (vk.size > 0) {
          const atRule = (uid: EntityId): string => {
            for (let u = view.unit.get(uid); u; u = u.parent === null ? undefined : view.unit.get(u.parent)) if (u.atRule !== undefined) return u.atRule;
            return input.catalog.behaviour.antitank.atRuleDefault;
          };
          const targets = [...vk.entries()].sort((a, b) => a[0] - b[0]);
          for (const m of all) {
            const s = view.soldier.get(m) as SoldierState | undefined;
            if (!able(s) || committed(s) || s!.mount !== undefined || !s!.impair.canUseArms || view.action.has(m)) continue;
            const uid = view.identity.get(m)?.unit;
            if (uid === undefined || atRule(uid) === "hold") continue;
            const rd = launcherReady(view, input, m);
            const t = view.transform.get(m);
            if (!rd || !t) continue;
            let best: { id: EntityId; x: number; y: number; d: number; moving: boolean } | null = null;
            for (const [id, k] of targets) { const d = hypot2(k.x - t.x, k.y - t.y); if (!best || d < best.d) best = { id, x: k.x, y: k.y, d, moving: k.moving }; }
            if (!best) continue;
            if (best.d <= rd.range && best.d >= 20) {
              if (tick - (mem.atShot[String(m)] ?? -1e9) < COMMANDER.atRefireSeconds * 60) continue;
              // A comrade (or a wall) in the danger zone behind him (owner Q20): he first steps a few metres aside,
              // and fires at the next look.
              const az = atan2(best.y - t.y, best.x - t.x);
              if (backblastBlocked(ground(), view as unknown as SimState, m, rd.ammo, az) !== null) {
                const side = m % 2 === 0 ? 1 : -1;
                order(m, { kind: "move", waypoints: [{ x: clamp(t.x - sin(az) * side * COMMANDER.atSidestepM, W), y: clamp(t.y + cos(az) * side * COMMANDER.atSidestepM, H), mode: "run" }] });
                mem.atShot[String(m)] = tick - (COMMANDER.atRefireSeconds - COMMANDER.atEverySeconds) * 60;
                continue;
              }
              order(m, { kind: "fire", x: best.x, y: best.y, contact: best.id, nature: "at" });
              mem.atShot[String(m)] = tick;
              continue;
            }
            // Stalk a halted vehicle a little out of reach (not while the platoon breaks off).
            if (mem.phase === "withdraw" || best.moving || best.d > rd.range + COMMANDER.huntBeyondM) continue;
            const h = mem.hunt[String(m)];
            // A hunter already out: sent on again if he has stopped short (pulled back by a squad order, or gone to ground).
            if (h !== undefined && (h[0] !== best.id || (view.mover.get(m)?.waypoints.length ?? 0) > 0)) continue;
            if (h === undefined && Object.keys(mem.hunt).length >= COMMANDER.huntersMax) continue;
            const goal = rd.range * COMMANDER.huntAtRangeShare;
            const gx = clamp(best.x + ((t.x - best.x) / best.d) * goal, W), gy = clamp(best.y + ((t.y - best.y) / best.d) * goal, H);
            order(m, { kind: "move", waypoints: [{ x: gx, y: gy, mode: "run" }] });
            if (h === undefined) mem.hunt[String(m)] = [best.id, tick];
          }
        }
      }
      // ---- missile teams (M9.3b): each to an overwatch post (sited once), sneaking the last stretch; set up there
      // on its own (sim); fired at the enemy vehicle that threatens the own carriers most; after each launch it
      // moves on to its next post.
      missileTeams(view, tick, order, freshVehicleContacts([...all, ...teamMen(view)]));
      aglTeams(view, tick, order, all, sideSpared); // (M7.6d)
      const down = all.filter((m) => { const s = view.soldier.get(m); return s !== undefined && isOut(s); }).length / Math.max(1, all.length);
      const holds = (i: number) => view.objectives[i]?.holder === side;
      const main = objectives[0];
      if (!main) return out;
      // M11.3: an enemy cache its men have seen is a legitimate target: high explosive on it when the mortars have had
      // nothing better to fire at for `supply.ai.everyS` and no own man is near it.
      const SA = input.catalog.supply?.ai;
      if (SA && view.cache.size > 0 && supportLeft(view, side, "he", input.catalog) > 0 && tick - (mem.lastHe ?? -1e9) >= SA.everyS * 60 && tick - (mem.lastCacheHe ?? -1e9) >= SA.everyS * 60) {
        for (const [cid, c] of view.cache.entries()) {
          if (c.side === side || c.burnt === true || c.cookoff !== undefined || !(c.known?.includes(side) ?? false)) continue;
          const ct = view.transform.get(cid);
          if (!ct || all.some((f) => { const ft = view.transform.get(f); return ft !== undefined && hypot2(ft.x - ct.x, ft.y - ct.y) < SA.ownClearM; })) continue;
          heCall(ct.x, ct.y, SA.heRounds);
          mem.lastCacheHe = tick;
          break;
        }
      }

      if (defending) {
        { const f = mem.front ?? front0(); tanks(cos(f), sin(f), () => ({ kind: "move", waypoints: [{ x: clamp(sx, W), y: clamp(sy, H), mode: "run" }] })); }
        if (mem.phase === "start") {
          toAll({ kind: "rules", fire: "free", maxEngageM: dark ? N.defenceRangeM : COMMANDER.defenceRangeM });
          mem.darkRules = dark;
          // Each man to a fire position of his own near his group's place (overnight pick "defence-siting"):
          // field of fire over the approach, cover, spacing (siting.ts); the rest lie down where they are.
          const groups: SitingGroup[] = [...topIds.map((id) => view.unit.get(id)!.members), ...squads.map((sq) => members(view, sq))].map((ms) => {
            const men = ms.filter((m) => { const s = view.soldier.get(m) as SoldierState | undefined; return able(s) && s!.mount === undefined && s!.impair.canWalk && view.transform.has(m); })
              .sort((a, b) => a - b).map((m) => { const t = view.transform.get(m)!; return { id: m, x: t.x, y: t.y }; });
            const cx = men.reduce((a, m) => a + m.x, 0) / Math.max(1, men.length), cy = men.reduce((a, m) => a + m.y, 0) / Math.max(1, men.length);
            const o = objectives.find((ob) => ob.holder === side && hypot2(ob.x - cx, ob.y - cy) <= ob.radiusM + COMMANDER.siteRingSlackM);
            return { men, cx, cy, ...(o ? { ring: { x: o.x, y: o.y, r: o.radiusM } } : {}) };
          }).filter((g) => g.men.length > 0);
          // The attack is expected from the middle of the map edge farthest from where the side starts.
          const front = mem.front = front0();
          const placed = new Set<EntityId>();
          mem.sited ??= {};
          for (const p of siteDefence(ground(), groups, approachPoints(ground(), main.x, main.y, front))) {
            mem.sited[String(p.id)] = [p.x, p.y, p.building ?? -1, p.windowIndex ?? -1];
            if (!p.move) continue;
            // (M7.5e: a window place is one man's occupy order, at a walk.)
            if (p.building !== undefined) order(p.id, { kind: "occupy", building: p.building, windowIndex: p.windowIndex, mode: "walk" });
            else order(p.id, { kind: "move", waypoints: [{ x: p.x, y: p.y, mode: "walk" }], facing: Number.isNaN(p.facing) ? front : p.facing });
            placed.add(p.id);
          }
          for (const m of all) if (!placed.has(m)) order(m, { kind: "posture", posture: "prone" });
          mem.phase = "hold";
          return out;
        }
        mem.front ??= front0();
        // Night (M9.6): its range of fire at will follows the light (sent again when it crosses the threshold).
        if ((mem.darkRules ?? false) !== dark) { toAll({ kind: "rules", fire: "free", maxEngageM: dark ? N.defenceRangeM : COMMANDER.defenceRangeM }); mem.darkRules = dark; }
        // An illumination round over the enemy men its men know closing on an objective (M9.6).
        if (dark) {
          // (Men seen or reported, not only heard, near the main objective or close to any; at least `illumMinMen`.)
          let ix = 0, iy = 0, n = 0;
          const men = new Set<EntityId>();
          for (const m of all) for (const c of knownMen(m)) {
            if (c.kind === "heard" || tick - c.tick > N.contactSeconds * 60) continue;
            if (hypot2(c.x - main.x, c.y - main.y) > N.illumTriggerM && !objectives.some((o) => hypot2(c.x - o.x, c.y - o.y) <= N.illumAnyM)) continue;
            ix += c.x; iy += c.y; n++; men.add(c.target);
          }
          if (men.size >= N.illumMinMen) illumCall(ix / n, iy / n);
        }
        // Falling back (overnight pick "defence-fallback"): a squad below half strength pulls back only under a
        // close threat, each to a covered rally point of its own behind its own position, then holds there.
        const F = COMMANDER.fallback;
        for (const sq of squads) {
          const f = fitShare(sq);
          if (f >= 0.5 || f <= 0 || mem.pulledBack.includes(sq)) continue;
          const men = members(view, sq).filter((m) => able(view.soldier.get(m) as SoldierState | undefined) && view.transform.has(m) && (view.soldier.get(m) as SoldierState).mount === undefined);
          if (men.length === 0) continue;
          const cx = men.reduce((a, m) => a + view.transform.get(m)!.x, 0) / men.length, cy = men.reduce((a, m) => a + view.transform.get(m)!.y, 0) / men.length;
          if (!fallbackThreat(cx, cy)) continue;
          const oi = ownObjective(cx, cy);
          const rp = rallyPoint(cx, cy, men, oi);
          order(sq, { kind: "withdraw", x: rp.x, y: rp.y });
          mem.pulledBack.push(sq);
          (mem.rally ??= {})[String(sq)] = [rp.x, rp.y, oi, tick];
        }
        // At the rally point (the drill over): each man to a fire position of his own within `rallySiteM`, lying
        // down facing the objective and the way the enemy comes.
        for (const sq of mem.pulledBack) {
          const r = mem.rally?.[String(sq)];
          if (!r || (mem.rallied ??= []).includes(sq)) continue;
          const d = view.unit.get(sq)?.drill;
          if (d) {
            if (d.kind === "withdraw" && !(mem.rallySeen ??= []).includes(sq)) mem.rallySeen.push(sq);
            continue;
          }
          if (!(mem.rallySeen ?? []).includes(sq) && tick - r[3] < F.drillStartSeconds * 60) continue;
          mem.rallied.push(sq);
          const men = members(view, sq).filter((m) => { const s = view.soldier.get(m) as SoldierState | undefined; return able(s) && s!.mount === undefined && s!.impair.canWalk && view.transform.has(m); })
            .sort((a, b) => a - b).map((m) => { const t = view.transform.get(m)!; return { id: m, x: t.x, y: t.y }; });
          if (men.length === 0) continue;
          const o = objectives[r[2]] ?? main;
          const e = enemyCentre(r[0], r[1], men.map((m) => m.id));
          const toward = e ? atan2(e.y - o.y, e.x - o.x) : mem.front;
          for (const p of siteDefence(ground(), [{ men, cx: r[0], cy: r[1] }], rallyView(o, toward), F.rallySiteM, { windows: false })) {
            (mem.sited ??= {})[String(p.id)] = [p.x, p.y, -1, -1];
            if (p.move) order(p.id, { kind: "move", waypoints: [{ x: p.x, y: p.y, mode: "run" }], facing: Number.isNaN(p.facing) ? toward : p.facing });
            else order(p.id, { kind: "posture", posture: "prone" });
          }
          if (mem.resited) delete mem.resited[String(sq)];
        }
        // Out of a house (M7.5e step "leave": a trap, the enemy inside, cut off): once its men are out and halted (or
        // `houseResiteSeconds` on), each takes a fire position of his own around where they went, outdoors
        // (`rallySiteM`), facing its objective and the way the enemy comes, as after a rally.
        for (const sq of squads) {
          const u = view.unit.get(sq), lh = u?.leftHouse;
          if (!u || !lh || u.drill || (mem.houseLeft ??= {})[String(sq)] === lh.tick) continue;
          const men = members(view, sq).filter((m) => { const s = view.soldier.get(m) as SoldierState | undefined; return able(s) && s!.mount === undefined && s!.impair.canWalk && view.transform.has(m); })
            .sort((a, b) => a - b).map((m) => { const t = view.transform.get(m)!; return { id: m, x: t.x, y: t.y }; });
          if (men.length === 0) { mem.houseLeft[String(sq)] = lh.tick; continue; }
          if (tick - lh.tick < COMMANDER.houseResiteSeconds * 60 && men.some((m) => (view.mover.get(m.id)?.waypoints.length ?? 0) > 0)) continue;
          mem.houseLeft[String(sq)] = lh.tick;
          const cx = men.reduce((a, m) => a + m.x, 0) / men.length, cy = men.reduce((a, m) => a + m.y, 0) / men.length;
          const o = objectives[ownObjective(cx, cy)] ?? main;
          const e = enemyCentre(cx, cy, men.map((m) => m.id));
          const toward = e ? atan2(e.y - o.y, e.x - o.x) : mem.front;
          for (const p of siteDefence(ground(), [{ men, cx, cy }], rallyView(o, toward), F.rallySiteM, { windows: false })) {
            (mem.sited ??= {})[String(p.id)] = [p.x, p.y, -1, -1];
            if (p.move) order(p.id, { kind: "move", waypoints: [{ x: p.x, y: p.y, mode: "run" }], facing: Number.isNaN(p.facing) ? toward : p.facing });
          }
          if (mem.resited) delete mem.resited[String(sq)];
        }
        // (The platoon headquarters' own men are a group of their own, as the squads.)
        reacquire(view, tick, [...topIds.map((id): [EntityId, EntityId[]] => [id, [...view.unit.get(id)!.members]]), ...squads.map((sq): [EntityId, EntityId[]] => [sq, members(view, sq)])], order, known, dark ? N.defenceRangeM : COMMANDER.defenceRangeM);
        // Mortars on attackers its men have seen out in the open (not near its own men).
        if (supportLeft(view, side, "he", input.catalog) > 0 && tick - (mem.lastHe ?? -1e9) >= COMMANDER.defenceHeEverySeconds * 60) {
          let sx2 = 0, sy2 = 0, n = 0;
          for (const m of all) for (const c of knownMen(m)) {
            if (c.kind === "reported" || hypot2(c.x - main.x, c.y - main.y) < 120) continue;
            sx2 += c.x; sy2 += c.y; n++;
          }
          if (n >= 3) {
            const px = sx2 / n, py = sy2 / n;
            const nearOwn = all.some((f) => { const ft = view.transform.get(f); return ft !== undefined && hypot2(ft.x - px, ft.y - py) < 100; });
            if (!nearOwn) { heCall(px, py, COMMANDER.defenceHeRounds); mem.lastHe = tick; }
          }
        }
        if (!holds(0) && tick - mem.counterTick > 60 * 60) {
          const fit = squads.filter((sq) => !mem.pulledBack.includes(sq) && strength(sq) >= 0.5);
          // (Overnight pick "defence-fallback": a squad that fell back and holds its rally point with at least
          // `counterMinMen` able men still counts as the second squad: it covers the counter-attack from there.)
          const holding = squads.filter((sq) => (mem.rallied ?? []).includes(sq) && !view.unit.get(sq)?.drill
            && members(view, sq).filter((m) => able(view.soldier.get(m) as SoldierState | undefined)).length >= COMMANDER.fallback.counterMinMen);
          const best = [...fit].sort((a, b) => strength(b) - strength(a) || a - b)[0];
          if (best !== undefined && (fit.length + holding.length >= 2 || strength(best) >= 0.7)) {
            order(best, { kind: "assault", x: main.x, y: main.y });
            mem.counterTick = tick;
          }
        }
        return out;
      }

      // ---- attack
      // (Holding what it took, it stays: breaking off would give the objectives back.)
      const tgt = objectives[mem.target] ?? main;
      // The axis of the attack (balance pass 2026-11-13): from the start, turned about the objective (up to
      // `axisMaxDeg`) so that the support line keeps `flankClearM` from the other objectives the enemy holds
      // (their garrisons would fire into the flank of the attack); the least turn that does, else the best.
      // (A mounted attack keeps the straight way in: its carriers' route and dismount points are planned on it.)
      if (mem.axis === undefined && mem.phase === "start" && squads.some((sq) => riders(view, sq).length > 0)) mem.axis = 0;
      if (mem.axis === undefined) {
        const b0 = atan2(sy - tgt.y, sx - tgt.x), R = supportM, half = 2 * 45;
        let best = 0, bestScore = -Infinity;
        for (const k of [0, -1, 1, -2, 2, -3, 3]) {
          const a = b0 + (k * COMMANDER.axisMaxDeg * PI) / 180 / 3;
          const cx = tgt.x + cos(a) * R, cy = tgt.y + sin(a) * R;
          if (cx < 40 || cy < 40 || cx > W - 40 || cy > H - 40) continue;
          const pts = [-half, 0, half].map((o) => ({ x: cx - sin(a) * o, y: cy + cos(a) * o }));
          let gap = Infinity;
          objectives.forEach((o, i) => { if (i !== mem.target && o.holder !== side) for (const p of pts) gap = Math.min(gap, hypot2(o.x - p.x, o.y - p.y)); });
          const score = Math.min(gap, COMMANDER.flankClearM) - Math.abs(k) * 1;
          if (score > bestScore) { bestScore = score; best = a - b0; }
        }
        mem.axis = best;
      }
      const ax = tgt.x + cos(mem.axis) * (sx - tgt.x) - sin(mem.axis) * (sy - tgt.y), ay = tgt.y + sin(mem.axis) * (sx - tgt.x) + cos(mem.axis) * (sy - tgt.y);
      const dx = tgt.x - ax, dy = tgt.y - ay, L = hypot2(dx, dy) || 1, ux = dx / L, uy = dy / L;
      /** Back to the start, each vehicle to its own spot in a line across the way in. */
      const back = (c: EntityId): Record<string, unknown> => {
        // (M7.6b review fix: the tanks take the spots after the platoons' vehicles, each its own.)
        const slot = crews.includes(c) ? crews.indexOf(c) : crews.length + Math.max(0, tankCrews.indexOf(c));
        const off = (slot - (crews.length - 1) / 2) * 20;
        const end = { x: clamp(sx - uy * off, W), y: clamp(sy + ux * off, H), mode: "run" };
        // M7.4b: it first reverses out a little (its front and gun still toward the enemy), then turns for home.
        const vt = (() => { const vid = view.unit.get(c)?.vehicle; return vid === undefined ? undefined : view.transform.get(vid); })();
        if (!vt || hypot2(vt.x - sx, vt.y - sy) < COMMANDER.withdrawReverseM * 2) return { kind: "move", waypoints: [end] };
        return { kind: "move", waypoints: [{ x: clamp(vt.x - ux * COMMANDER.withdrawReverseM, W), y: clamp(vt.y - uy * COMMANDER.withdrawReverseM, H), mode: "run", reverse: true }, end] };
      };
      const vehiclesLost = ownVehicles.length > 0 && lostVehicles >= COMMANDER.vehicleLossShare * ownVehicles.length;
      if (mem.phase !== "withdraw" && mem.phase !== "hold" && (down > tolerance || vehiclesLost)) {
        // Squads within reach of their vehicle get back in (owner Q24); the others break contact on foot.
        mem.remount = [];
        const near = (uid: EntityId, men: EntityId[]): EntityId | undefined => {
          const vid = view.unit.get(uid)?.carrier;
          const v = vid === undefined ? undefined : view.vehicle.get(vid);
          const vt = vid === undefined ? undefined : view.transform.get(vid);
          const crew = crewOfVehicle(vid);
          if (!v || !vt || crew === undefined || v.status !== "ok") return undefined;
          const fit = men.filter((m) => able(view.soldier.get(m) as SoldierState | undefined));
          if (fit.length === 0) return undefined;
          const cx = fit.reduce((a, m) => a + view.transform.get(m)!.x, 0) / fit.length, cy = fit.reduce((a, m) => a + view.transform.get(m)!.y, 0) / fit.length;
          return hypot2(cx - vt.x, cy - vt.y) <= M.remountM ? crew : undefined;
        };
        for (const sq of squads) {
          const crew = near(sq, members(view, sq));
          if (riders(view, sq).length > 0 && crew !== undefined) { mem.remount.push(crew); continue; } // still aboard: ride back
          if (crew !== undefined) { order(sq, { kind: "mount" }); mem.remount.push(crew); } else order(sq, { kind: "withdraw", x: sx, y: sy });
        }
        const hqFoot = hq.filter((m) => (view.soldier.get(m) as SoldierState | undefined)?.mount === undefined);
        const hqCrew = tops.length > 0 ? near(tops[0]![0], hqFoot) : undefined;
        for (const m of hqFoot) order(m, hqCrew !== undefined ? { kind: "mount" } : { kind: "move", waypoints: [{ x: sx, y: sy, mode: "run" }] });
        if (hqCrew !== undefined && !mem.remount.includes(hqCrew)) mem.remount.push(hqCrew);
        // Vehicles with nobody to pick up go back at once.
        for (const c of crews) if (!mem.remount.includes(c) && vehicleOf(c)?.status === "ok") order(c, back(c));
        mem.phase = "withdraw"; mem.phaseTick = tick;
        return out;
      }
      // A vehicle drives back once its men are in (or after a minute).
      if (mem.phase === "withdraw" && (mem.remount?.length ?? 0) > 0) {
        mem.remount = mem.remount!.filter((c) => {
          const vid = view.unit.get(c)?.vehicle;
          const boarding = [...view.unit.values()].some((u) => u.boarding?.kind === "mount" && u.boarding.vehicle === vid);
          if (boarding && tick - mem.phaseTick < 60 * 60) return true;
          order(c, back(c));
          return false;
        });
      }
      // A squad still aboard close to an objective gets out to hold it [C29].
      if (mem.phase !== "start" && mem.phase !== "ride" && mem.phase !== "withdraw") {
        for (const sq of squads) {
          const vid = view.unit.get(sq)?.carrier;
          const vt = vid === undefined ? undefined : view.transform.get(vid);
          if (!vt || riders(view, sq).length === 0 || view.unit.get(sq)?.boarding) continue;
          if (objectives.some((o) => hypot2(o.x - vt.x, o.y - vt.y) <= M.holdDismountM + o.radiusM)) order(sq, { kind: "dismount" });
        }
      }
      // The support distance (M9.6 review fix): the one the squads' places for this objective were chosen at, so a
      // dusk or dawn crossing does not move the support point and HQ away from the places (by day: `supportM`).
      const supportD = () => (mem.placesFor === mem.target && mem.places !== undefined ? mem.placesD ?? supportM : supportM);
      const supportAt = () => { const d = supportD(); return { x: clamp(tgt.x - ux * d, W), y: clamp(tgt.y - uy * d, H) }; };
      const lateral = (k: number) => { const support = supportAt(); return { x: clamp(support.x - uy * k, W), y: clamp(support.y + ux * k, H) }; };
      /** The advance on foot to the support line: walk most of the way, sneak the last stretch (from where the
       *  squad is: men who got out near the line only sneak). */
      /** Can a man lying (or, failing that, kneeling) at (x, y) fire at (tx, ty), `hz` above the ground there? 1, 0.6, 0. */
      const posture = input.catalog.body.postures;
      const fireLine = (x: number, y: number, tx: number, ty: number, hz: number): number => {
        const ctx = ground();
        // ground: ok (the commander's view of the open ground)
        const z0 = heightAt(input.map, x, y), z1 = heightAt(input.map, tx, ty) + hz, d = hypot2(tx - x, ty - y);
        const ok = (h: number) => { const r = sight(ctx, x, y, z0 + h, tx, ty, z1); return r.blockedBy === null || (1 - r.blockedAt) * d <= COMMANDER.lineAllowanceM; };
        return ok(posture.prone.muzzleHeightM) ? 1 : ok(posture.crouching.muzzleHeightM) ? 0.6 : 0;
      };
      /** Support-by-fire places (balance pass 2026-11-13): each squad its slot on the support line, moved to the
       *  nearby spot (closer, farther, aside) with the best field of fire onto the objective; chosen once. */
      const slot = (i: number) => (i - (squads.length - 1) / 2) * (squads.length > 3 ? 45 : 60);
      const ensurePlaces = () => {
        if (mem.placesFor === mem.target && mem.places !== undefined) return;
        const foot = navFor(ground(), "foot").grid;
        const aims = [{ x: tgt.x, y: tgt.y }, ...[0, 1, 2, 3].map((k) => ({ x: tgt.x + cos((k * PI) / 2) * tgt.radiusM * 0.6, y: tgt.y + sin((k * PI) / 2) * tgt.radiusM * 0.6 }))];
        mem.places = {};
        mem.placesD = supportM;
        squads.forEach((sq, i) => {
          let best: [number, number] | null = null, bestScore = -1;
          for (const dd of COMMANDER.placeDepthsM) for (const da of COMMANDER.placeAsideM) {
            const lat = slot(i) + da, d = mem.placesD! + dd;
            const x = clamp(tgt.x - ux * d - uy * lat, W), y = clamp(tgt.y - uy * d + ux * lat, H);
            if (navCostAt(foot, x, y) <= 0 || indoorAt(ground(), x, y) >= 0) continue;
            const score = aims.reduce((a, t) => a + fireLine(x, y, t.x, t.y, 0.9), 0) - (Math.abs(dd) + Math.abs(da)) * 0.002;
            if (score > bestScore) { bestScore = score; best = [x, y]; }
          }
          const p = lateral(slot(i));
          mem.places![String(sq)] = best ?? [p.x, p.y];
        });
        mem.placesFor = mem.target;
      };
      /** A squad's place on the support line. */
      const placeOf = (i: number) => { ensurePlaces(); const p = mem.places?.[String(squads[i])]; return p ? { x: p[0], y: p[1] } : lateral(slot(i)); };
      const centre = (sq: EntityId): { x: number; y: number } | null => {
        const ms = members(view, sq).filter((m) => able(view.soldier.get(m) as SoldierState | undefined)).map((m) => view.transform.get(m)).filter((x) => x !== undefined);
        return ms.length > 0 ? { x: ms.reduce((a, b) => a + b.x, 0) / ms.length, y: ms.reduce((a, b) => a + b.y, 0) / ms.length } : null;
      };
      /** Under fire now: one of its men is being suppressed. */
      const suppressed = (m: EntityId) => { const s = view.soldier.get(m) as SoldierState | undefined; return able(s) && s!.mental.suppression >= COMMANDER.underFireSuppression; };
      const underFire = (sq: EntityId) => members(view, sq).some(suppressed);
      const hqUnderFire = () => hq.some(suppressed);
      /** Halted, not in a drill, getting in or out, broken or mostly pinned: free to be sent on. */
      const idle = (sq: EntityId) => {
        const u = view.unit.get(sq);
        if (!u || u.moving || u.drill || u.boarding || u.broken || riders(view, sq).length > 0) return false;
        const ms = members(view, sq).filter((m) => able(view.soldier.get(m) as SoldierState | undefined));
        const pinned = ms.filter((m) => { const b = view.soldier.get(m)!.mental.behaviour; return b === "pinned" || b === "panicked"; }).length;
        return ms.length > 0 && pinned * 2 < ms.length;
      };
      /** On (or past) its place on the support line: within `arrivedM` of it, measured along the way in. */
      const onLine = (sq: EntityId) => {
        const c = centre(sq), i = squads.indexOf(sq), p = placeOf(i < 0 ? 0 : i);
        return c !== null && (tgt.x - c.x) * ux + (tgt.y - c.y) * uy <= (tgt.x - p.x) * ux + (tgt.y - p.y) * uy + COMMANDER.arrivedM;
      };
      /** Gone to ground short of `p` (balance pass 2026-11-13): sent on after a short while, at a run under fire.
       *  `close`: the assault element closing in walks, sneaking the last `sneakM` (overnight pick "assault-tempo"). */
      const sendOn = (sq: EntityId, p: { x: number; y: number }, close = false): boolean => {
        mem.resumeAt ??= {};
        const c = centre(sq);
        if (!c || hypot2(c.x - p.x, c.y - p.y) <= COMMANDER.arrivedM) return false;
        if (!idle(sq) || tick - (mem.resumeAt[String(sq)] ?? -1e9) < COMMANDER.resumeSeconds * 60) return true;
        // Sent on often enough (its place cannot be reached, or it keeps being stopped): it stays where it is.
        mem.resumeN ??= {};
        if ((mem.resumeN[String(sq)] ?? 0) >= COMMANDER.resumeMax) return false;
        mem.resumeN[String(sq)] = (mem.resumeN[String(sq)] ?? 0) + 1;
        const d = hypot2(c.x - p.x, c.y - p.y), q = { x: p.x + ((c.x - p.x) / d) * sneakM, y: p.y + ((c.y - p.y) / d) * sneakM };
        const wps = underFire(sq) ? [{ x: p.x, y: p.y, mode: "run" as const }]
          : close && d > sneakM + COMMANDER.arrivedM ? [{ x: q.x, y: q.y, mode: "walk" as const }, { x: p.x, y: p.y, mode: "sneak" as const }]
          : [{ x: p.x, y: p.y, mode: close ? "sneak" as const : "walk" as const }];
        order(sq, { kind: "move", waypoints: wps, facing: atan2(tgt.y - p.y, tgt.x - p.x) });
        mem.resumeAt[String(sq)] = tick;
        return true;
      };
      /** The assault position (balance pass 2026-11-13): `assaultPositionM` short of the objective, `ang` off the
       *  line of advance (toward the start), `off` across it. */
      const assaultPos = (ang: number, off = 0, dist: number = COMMANDER.assaultPositionM) => {
        const bx = -ux * cos(ang) + uy * sin(ang), by = -uy * cos(ang) - ux * sin(ang);
        return { x: clamp(tgt.x + bx * dist - by * off, W), y: clamp(tgt.y + by * dist + bx * off, H) };
      };
      /** Choose its bearing once: the candidate seen from the fewest of the objectives' edges and the enemies its men
       *  know, the straighter one when equal ("flanking along covered routes"). */
      const chooseFlank = (): number => {
        if (mem.flank !== undefined) return mem.flank;
        const eyes = [...objectives.flatMap((o) => [{ x: o.x - ux * o.radiusM, y: o.y - uy * o.radiusM }, { x: o.x - uy * o.radiusM, y: o.y + ux * o.radiusM }, { x: o.x + uy * o.radiusM, y: o.y - ux * o.radiusM }]),
          ...all.flatMap((m) => knownMen(m)).sort((a, b) => a.target - b.target).slice(0, 6)];
        const lim = (COMMANDER.flankMaxDeg * PI) / 180;
        let best = 0, bestScore = Infinity;
        for (const k of [0, -1, 1, -2, 2]) {
          const a = (k * lim) / 2, p = assaultPos(a);
          // (Away from the other objectives the enemy holds: their men would fire into its flank.)
          const exposed = objectives.filter((o, oi) => oi !== mem.target && view.objectives[oi]?.holder !== side && hypot2(o.x - p.x, o.y - p.y) < COMMANDER.flankClearM).length;
          const score = eyes.filter((e) => !hidden(e.x, e.y, p.x, p.y)).length + Math.abs(k) * 0.25 + exposed * 2;
          if (score < bestScore) { bestScore = score; best = a; }
        }
        mem.flank = best;
        return best;
      };
      // ---- houses (M7.5e step "clear", D8/D9; values COMMANDER.clear)
      const CL = COMMANDER.clear;
      /** Where an enemy was known in each house lately (the houses' ids), from what its men know. */
      /** Where enemies were placed in each house lately (building index -> places; derived on each call, never saved). */
      const houseSpots = new Map<number, { x: number; y: number }[]>();
      const noteHouses = () => {
        const ctx = ground();
        houseSpots.clear();
        if (!mapHasInteriors(ctx)) return;
        mem.houseSeen ??= {};
        for (const m of all) for (const c of knownMen(m)) {
          if (tick - c.tick > CL.enemySeconds * 60 || contactErrorM(ctx, c, tick) > CL.errM) continue;
          const bi = indoorAt(ctx, c.x, c.y);
          if (bi < 0) continue;
          const k = String(ctx.map.buildings[bi]!.id);
          if ((mem.houseSeen[k] ?? -1e9) < c.tick) mem.houseSeen[k] = c.tick;
          const spots = houseSpots.get(bi);
          if (!spots) houseSpots.set(bi, [{ x: c.x, y: c.y }]);
          else if (spots.length < 4 && !spots.some((p) => hypot2(p.x - c.x, p.y - c.y) < 1)) spots.push({ x: c.x, y: c.y });
        }
      };
      const houseMid = (bi: number) => { const fp = input.map.buildings[bi]!.footprint, n = fp.length / 2; let x = 0, y = 0; for (let k = 0; k < n; k++) { x += fp[k * 2]! / n; y += fp[k * 2 + 1]! / n; } return { x, y }; };
      const inMainRing = (bi: number) => { const h = houseMid(bi); return hypot2(h.x - main.x, h.y - main.y) <= main.radiusM + CL.ringSlackM; };
      /** The next house squad `sq` clears on its way to the objective (index in map.buildings), or -1. */
      const nextHouse = (sq: EntityId): number => {
        const c = centre(sq);
        if (!c) return -1;
        const ctx = ground();
        const dl = hypot2(tgt.x - c.x, tgt.y - c.y) || 1, vx = (tgt.x - c.x) / dl, vy = (tgt.y - c.y) / dl;
        const busy = new Set(Object.entries(mem.clearing ?? {}).filter(([k]) => k !== String(sq)).map(([, v]) => v[0]));
        const ringDefended = all.some((m) => knownMen(m).some((c) => tick - c.tick <= CL.enemySeconds * 60 && hypot2(c.x - tgt.x, c.y - tgt.y) <= tgt.radiusM));
        let best = -1, bestAlong = Infinity;
        input.map.buildings.forEach((b, bi) => {
          // (A house taken is cleared again once an enemy is known in it after it was taken.)
          const retaken = (mem.houseSeen?.[String(b.id)] ?? -1e9) > (mem.takenAt?.[String(b.id)] ?? -1e9);
          if (!b.interior || ((mem.taken ?? []).includes(b.id) && !retaken) || busy.has(b.id) || tick - (mem.clearFailed?.[String(b.id)] ?? -1e9) < CL.retrySeconds * 60) return;
          const h = houseMid(bi), dT = hypot2(h.x - tgt.x, h.y - tgt.y);
          if (hypot2(h.x - c.x, h.y - c.y) > CL.reachM) return;
          const along = (h.x - c.x) * vx + (h.y - c.y) * vy, across = Math.abs(-(h.x - c.x) * vy + (h.y - c.y) * vx);
          const near = dT <= tgt.radiusM + CL.ringSlackM, onWay = along > -10 && along < dl && across <= CL.corridorM;
          if (!near && !onWay) return;
          const enemy = tick - (mem.houseSeen?.[String(b.id)] ?? -1e9) <= CL.enemySeconds * 60;
          // (A house in the ring with no enemy known in it: only on the main objective while enemies are known in its
          // ring; the second, or an objective nobody defends any more, is taken quickly.)
          if (!enemy && (dT > tgt.radiusM || mem.phase === "second" || !ringDefended)) return;
          if (along >= bestAlong || !clearable(ctx, b.id)) return;
          best = bi; bestAlong = along;
        });
        return best;
      };
      /** Is house `bi` free to be sent to (an interior, not taken unless an enemy came back, nobody else on it, not
       *  failed lately, a way in)? */
      const houseFree = (bi: number, sq: EntityId): boolean => {
        const b = input.map.buildings[bi]!;
        const retaken = (mem.houseSeen?.[String(b.id)] ?? -1e9) > (mem.takenAt?.[String(b.id)] ?? -1e9);
        if (!b.interior || ((mem.taken ?? []).includes(b.id) && !retaken) || tick - (mem.clearFailed?.[String(b.id)] ?? -1e9) < CL.retrySeconds * 60) return false;
        if (Object.entries(mem.clearing ?? {}).some(([k, v]) => k !== String(sq) && v[0] === b.id)) return false;
        return clearable(ground(), b.id);
      };
      /** On the approach (slice s0-clear): the house with a known, well-placed enemy squad `sq` clears on its way to
       *  `goal` (index in map.buildings), or -1; `looks`: the places the enemy must overlook (besides the squad);
       *  `ringToo`: houses of the objective it is going for count (closing in on it). */
      const approachHouse = (sq: EntityId, goal: { x: number; y: number }, looks: { x: number; y: number }[], ringToo: boolean): number => {
        const c = centre(sq);
        if (!c || houseSpots.size === 0) return -1;
        if (members(view, sq).filter((m) => able(view.soldier.get(m) as SoldierState | undefined)).length < CL.approachMinMen) return -1;
        const dl = hypot2(goal.x - c.x, goal.y - c.y);
        if (dl < 1) return -1;
        const vx = (goal.x - c.x) / dl, vy = (goal.y - c.y) / dl;
        const ctx = ground();
        let best = -1, bestAlong = Infinity;
        for (const [bi, spots] of [...houseSpots.entries()].sort((a, b) => a[0] - b[0])) {
          const b = input.map.buildings[bi]!, h = houseMid(bi);
          if (tick - (mem.houseSeen?.[String(b.id)] ?? -1e9) > CL.enemySeconds * 60) continue;
          if (hypot2(h.x - c.x, h.y - c.y) > CL.approachM) continue;
          const along = (h.x - c.x) * vx + (h.y - c.y) * vy, across = Math.abs(-(h.x - c.x) * vy + (h.y - c.y) * vx);
          if (along <= -10 || along >= dl || across > CL.approachCorridorM || along >= bestAlong) continue;
          // (Advancing to the support line, a house of the objective it is going for is the assault's.)
          if (!ringToo && hypot2(h.x - tgt.x, h.y - tgt.y) <= tgt.radiusM + CL.ringSlackM) continue;
          // Well placed: a sight line from where an enemy was placed in it, at a window of any floor, to the squad or
          // to where it is going.
          const overlooks = spots.some((p) => {
            // ground: ok (the commander's view: a window's height above the ground at the house)
            const z = heightAt(input.map, p.x, p.y);
            for (let f = 0; f < Math.max(1, b.storeys); f++) {
              const z0 = z + CL.eyeM + f * CL.storeyM;
              for (const q of [c, ...looks]) {
                // ground: ok (the commander's view of open ground)
                if (sight(ctx, p.x, p.y, z0, q.x, q.y, heightAt(input.map, q.x, q.y) + 1).blockedBy === null) return true;
              }
            }
            return false;
          });
          if (!overlooks || !houseFree(bi, sq)) continue;
          best = bi; bestAlong = along;
        }
        return best;
      };
      /** Sends squads on their approach to clear such a house first (at most `approachMax` at a time); true if `sq`
       *  is clearing one (or was just sent to). */
      const clearOnApproach = (sq: EntityId, goal: { x: number; y: number }, looks: { x: number; y: number }[], ringToo: boolean): boolean => {
        if (mem.clearing?.[String(sq)] !== undefined) return true;
        const u = view.unit.get(sq);
        if (!u || u.drill || u.boarding || u.broken || riders(view, sq).length > 0 || mem.held?.[String(sq)] !== undefined) return false;
        if (Object.keys(mem.clearing ?? {}).length >= CL.approachMax) return false;
        const hb = approachHouse(sq, goal, looks, ringToo);
        if (hb < 0) return false;
        const h = houseMid(hb), bid = input.map.buildings[hb]!.id;
        order(sq, { kind: "assault", x: clamp(h.x, W), y: clamp(h.y, H), building: bid });
        (mem.clearing ??= {})[String(sq)] = [bid, tick];
        return true;
      };
      /** A squad that took a house in the main ring holds it: the defence's siting around it, windows included. */
      const holdHouse = (sq: EntityId, bi: number) => {
        const men = members(view, sq).filter((m) => { const s = view.soldier.get(m) as SoldierState | undefined; return able(s) && s!.mount === undefined && s!.impair.canWalk && view.transform.has(m); })
          .sort((a, b) => a - b).map((m) => { const t = view.transform.get(m)!; return { id: m, x: t.x, y: t.y }; });
        if (men.length === 0) return;
        const h = houseMid(bi);
        const next = objectives.find((o, i) => i !== 0 && !holds(i));
        const toward = next ? atan2(next.y - h.y, next.x - h.x) : atan2(h.y - sy, h.x - sx);
        for (const p of siteDefence(ground(), [{ men, cx: h.x, cy: h.y }], approachPoints(ground(), h.x, h.y, toward), CL.holdSiteM)) {
          if (!p.move) continue;
          if (p.building !== undefined) order(p.id, { kind: "occupy", building: p.building, windowIndex: p.windowIndex, mode: "run" });
          else order(p.id, { kind: "move", waypoints: [{ x: p.x, y: p.y, mode: "run" }], facing: Number.isNaN(p.facing) ? toward : p.facing });
        }
      };
      /** How the clearings went: a squad out of its drill with men in the house took it (and holds it if it lies in
       *  the main ring); without: the house is left for a while. */
      const reviewClearings = () => {
        const ctx = ground();
        // (A squad that left the house it held, step "leave": it no longer holds it.)
        for (const [k, bid] of Object.entries(mem.held ?? {})) if (view.unit.get(Number(k))?.leftHouse?.building === bid) delete mem.held![k];
        for (const [k, [bid, t0]] of Object.entries(mem.clearing ?? {})) {
          const sq = Number(k), u = view.unit.get(sq);
          if (u?.drill?.kind === "clear" && u.drill.building === bid) continue;
          if (u && !u.drill && tick - t0 < CL.pendingSeconds * 60) continue;
          delete mem.clearing![k];
          const bi = buildingIndexOf(ctx, bid);
          const ables = members(view, sq).filter((m) => able(view.soldier.get(m) as SoldierState | undefined) && view.transform.has(m));
          const inside = bi >= 0 ? ables.filter((m) => { const t = view.transform.get(m)!; return indoorAt(ctx, t.x, t.y) === bi; }).length : 0;
          // (Taken: men of the squad inside, and no enemy known in it lately — a drill that ran out of time or men
          // with the enemy still upstairs did not take it.)
          const still = tick - (mem.houseSeen?.[String(bid)] ?? -1e9) <= CL.stillS * 60;
          if (inside < Math.min(CL.takenMen, ables.length) || inside === 0 || still) { (mem.clearFailed ??= {})[String(bid)] = tick; continue; }
          if (!(mem.taken ??= []).includes(bid)) mem.taken.push(bid);
          (mem.takenAt ??= {})[String(bid)] = tick;
          if (inMainRing(bi) && mem.held?.[k] === undefined) { (mem.held ??= {})[k] = bid; holdHouse(sq, bi); }
        }
      };
      const advance = (sq: EntityId, i: number) => {
        const p = placeOf(i);
        (mem.resumeAt ??= {})[String(sq)] = tick;
        const q = { x: clamp(p.x - ux * sneakM, W), y: clamp(p.y - uy * sneakM, H) };
        const ms = members(view, sq).map((m) => view.transform.get(m)).filter((x) => x !== undefined);
        const here = ms.length > 0 ? { x: ms.reduce((a, b) => a + b.x, 0) / ms.length, y: ms.reduce((a, b) => a + b.y, 0) / ms.length } : { x: sx, y: sy };
        const ahead = hypot2(q.x - tgt.x, q.y - tgt.y) < hypot2(here.x - tgt.x, here.y - tgt.y);
        // Under fire it runs the open stretch (overnight pick 2026-11-14: nobody walks on into fire).
        order(sq, { kind: "move", waypoints: ahead ? [{ x: q.x, y: q.y, mode: underFire(sq) ? "run" : "walk" }, { x: p.x, y: p.y, mode: "sneak" }] : [{ x: p.x, y: p.y, mode: "sneak" }], facing: atan2(uy, ux) });
      };
      // ---- vehicles after the dismount (M7.3, plan §12): fire free; German overwatch (they stay where they dropped
      // the squads), Russian following (each about followM behind its squad); support by fire on the objective.
      const fighting = crews.filter((c) => { const v = vehicleOf(c); return v !== undefined && (v.status === "ok" || v.status === "immobilised"); });
      if (crews.length > 0 && mem.phase !== "start" && mem.phase !== "ride" && mem.phase !== "withdraw") {
        if (!mem.crewsFree) { for (const c of fighting) order(c, { kind: "rules", fire: "free" }); mem.crewsFree = true; }
        const after = input.catalog.factions[force.faction]?.afterDismount;
        if (after?.kind === "follow") {
          mem.followAt ??= {};
          for (const c of fighting) {
            const vid = view.unit.get(c)?.vehicle;
            const sq = squads.find((u) => view.unit.get(u)?.carrier === vid);
            const v = vehicleOf(c), vt = vid === undefined ? undefined : view.transform.get(vid);
            if (sq === undefined || !v || !vt || v.status !== "ok" || riders(view, sq).length > 0 || view.unit.get(sq)?.boarding) continue;
            // A crew reversing out of danger (M7.4b) is left to it for a while.
            if (v.crewReaction === "reverseOut" && tick - v.reactionTick < COMMANDER.reverseOutHoldSeconds * 60) continue;
            const men = members(view, sq).filter((m) => able(view.soldier.get(m) as SoldierState | undefined)).map((m) => view.transform.get(m)).filter((x) => x !== undefined);
            if (men.length === 0) continue;
            const cx = men.reduce((a, b) => a + b.x, 0) / men.length, cy = men.reduce((a, b) => a + b.y, 0) / men.length;
            const px = clamp(cx - ux * after.followM, W), py = clamp(cy - uy * after.followM, H);
            const prev = mem.followAt[String(c)];
            // Only once the squad has moved on (and the vehicle is not on its way already).
            if (prev && hypot2(prev[0] - px, prev[1] - py) < COMMANDER.followReplanM) continue;
            if (hypot2(vt.x - px, vt.y - py) < COMMANDER.followReplanM) { mem.followAt[String(c)] = [px, py]; continue; }
            order(c, { kind: "move", waypoints: [{ x: px, y: py, mode: "walk" }], facing: atan2(uy, ux) });
            mem.followAt[String(c)] = [px, py];
          }
        }
      }
      // (M7.6b review fix: also for the tanks of a side whose platoons have no vehicles.)
      if ((crews.length > 0 || tankCrews.length > 0) && mem.phase !== "start" && mem.phase !== "ride" && mem.phase !== "withdraw") {
        // Support by fire: during the assault each vehicle fires at an enemy its side knows near the objective,
        // never close to its own men on foot (they shift or stop, plan §12).
        if ((mem.phase === "assault" || mem.phase === "second") && tick - (mem.lastVehicleFire ?? -1e9) >= COMMANDER.supportFireEverySeconds * 60) {
          const used = new Set<number>();
          const ownFoot = all.filter((f) => { const s = view.soldier.get(f); return s !== undefined && s.mount === undefined && s.physiology.alive; }).map((f) => view.transform.get(f)).filter((x) => x !== undefined);
          // (M7.6b: the tanks too, unless their crew knows an enemy vehicle within its gun's reach: that is theirs.)
          const tankFire = tankCrews.filter((c) => {
            const v = vehicleOf(c), vt = v ? view.transform.get(view.unit.get(c)!.vehicle!) : undefined;
            if (!v || !vt || (v.status !== "ok" && v.status !== "immobilised")) return false;
            const reach = input.catalog.vehicles[v.def]?.stations[0]?.weapons[0]?.engageRangeM ?? 0;
            return ![...freshVehicleContacts(view.unit.get(c)!.members).values()].some((k) => hypot2(k.x - vt.x, k.y - vt.y) <= reach);
          });
          for (const c of [...fighting, ...tankFire]) {
            let best: { target: EntityId; x: number; y: number } | null = null, bestD = 150;
            for (const m of all) for (const k of known(m)) {
              if (k.kind === "heard") continue;
              const d = hypot2(k.x - tgt.x, k.y - tgt.y) + (used.has(k.target) ? 60 : 0);
              if (d >= bestD) continue;
              if (ownFoot.some((f) => hypot2(f.x - k.x, f.y - k.y) < COMMANDER.vehicleFireNearOwnM)) continue;
              bestD = d; best = { target: k.target, x: k.x, y: k.y };
            }
            if (!best) continue;
            used.add(best.target);
            order(c, { kind: "fire", x: best.x, y: best.y, contact: best.target });
          }
          mem.lastVehicleFire = tick;
        }
      }
      /** What its men know of the enemy around the objective (seen or heard). */
      const knownNear = () => { let n = 0; for (const m of all) for (const c of known(m)) if (hypot2(c.x - tgt.x, c.y - tgt.y) < 150) n++; return n; };
      /** Blinding smoke (balance pass 2026-11-13): on the garrison of each other objective the enemy holds, which
       *  would fire into the flank of the attack, repeated as the cloud thins (while rounds last). */
      const blind = () => {
        if (tick - (mem.lastBlind ?? -1e9) < COMMANDER.smokeEverySeconds * 60) return;
        let any = false;
        objectives.forEach((o, i) => {
          if (i === mem.target || view.objectives[i]?.holder === side || supportLeft(view, side, "smoke", input.catalog) <= 0) return;
          order(caller, { kind: "callFire", x: clamp(o.x - ux * COMMANDER.blindAheadM, W), y: clamp(o.y - uy * COMMANDER.blindAheadM, H), ammo: "smoke", rounds: COMMANDER.smokeRounds });
          any = true;
        });
        if (any) mem.lastBlind = tick;
      };
      /** The fires before the assault: high explosive on the enemy its men know nearest the objective (else on it),
       *  and (balance pass 2026-11-13) smoke between the objective and the assault position, so that the assault
       *  element crosses the open ground under it. Each called once. */
      const prepFires = () => {
        if (supportLeft(view, side, "he", input.catalog) > 0 && mem.lastHe === undefined) {
          let hx = tgt.x, hy = tgt.y, best = 150;
          for (const m of all) for (const c of knownMen(m)) { const d = hypot2(c.x - tgt.x, c.y - tgt.y); if (d < best) { best = d; hx = c.x; hy = c.y; } }
          heCall(hx, hy, Math.max(COMMANDER.heRounds, Math.floor(supportLeft(view, side, "he", input.catalog) / 4)));
          mem.lastHe = tick;
        }
        if (supportLeft(view, side, "smoke", input.catalog) > 0 && mem.lastSmoke === undefined) {
          const sp = assaultPos(chooseFlank()), f = COMMANDER.screenShare;
          screen(clamp(tgt.x + (sp.x - tgt.x) * f, W), clamp(tgt.y + (sp.y - tgt.y) * f, H), tgt.x, tgt.y);
          mem.lastSmoke = tick;
        }
        blind();
      };
      // M7.6b: the tank sections (overwatch from hull-down posts; tanks.ts).
      const tanksNotReady = tanks(ux, uy, back);
      switch (mem.phase) {
        case "start":
          // M9.3b (A4): mounted, the carriers wait in dead ground until the side's missile team is set up on its
          // post (or `overwatchWaitSeconds` have passed): it covers their ride in.
          // (Review fix: only while the team can still be there in time: its walk and set-up within the wait.)
          if (squads.some((sq) => riders(view, sq).length > 0) && tick < COMMANDER.overwatchWaitSeconds * 60
            && [...view.unit.entries()].some(([id, u]) => {
              if (u.side !== side || u.missileTeam === undefined || u.missileTeam.kind === "agl" || teamOnPost(view, id)) return false;
              return tick / 60 + teamEtaS(view, id, tick) <= COMMANDER.overwatchWaitSeconds;
            })) break;
          // M7.6b: and until the side's tanks are on their first posts in overwatch (at most `carrierWaitSeconds`).
          if (tanksNotReady > 0 && tick < TANKS.carrierWaitSeconds * 60) break;
          toAll({ kind: "rules", fire: "return", onContact: "ground" });
          // Mounted (M7.2): the vehicles drive the squads to their dismount points; the squads ride.
          if (squads.some((sq) => riders(view, sq).length > 0)) {
            // The dismount point: this far short of the objective along the way in, the nearest point at or beyond
            // it out of sight of the objective (and of enemies its men know); none hidden: at the distance itself.
            // Each vehicle its own slot across the way in; "short of the objective" counts from every objective
            // (the nearer one may lie on a flank), and "out of sight" from the objectives' near edges.
            const known0 = all.flatMap((m) => known(m)).slice(0, 4);
            const eyes = [...objectives.flatMap((o) => [{ x: o.x - ux * o.radiusM, y: o.y - uy * o.radiusM }, { x: o.x - uy * o.radiusM, y: o.y + ux * o.radiusM }, { x: o.x + uy * o.radiusM, y: o.y - ux * o.radiusM }]), ...known0];
            const carried = crews.filter((c) => squads.some((sq) => view.unit.get(sq)?.carrier === view.unit.get(c)?.vehicle) || topIds.some((tp) => view.unit.get(tp)?.carrier === view.unit.get(c)?.vehicle));
            carried.forEach((c, i) => {
              const off = (i - (carried.length - 1) / 2) * COMMANDER.vehicleSlotM;
              // The headquarters' vehicle a little behind the others.
              const hqV = topIds.some((tp) => view.unit.get(tp)?.carrier === view.unit.get(c)?.vehicle) && !squads.some((sq) => view.unit.get(sq)?.carrier === view.unit.get(c)?.vehicle);
              const behind = hqV ? 40 : 0;
              const at = (d: number) => ({ x: clamp(tgt.x - ux * d - uy * off, W), y: clamp(tgt.y - uy * d + ux * off, H) });
              const far = (p: { x: number; y: number }) => objectives.every((o) => hypot2(o.x - p.x, o.y - p.y) >= dismountM);
              // The first point far enough from every objective, then up to 100 m farther back for one out of sight.
              let k0 = 0;
              while (k0 < 20 && !far(at(dismountM + behind + k0 * COMMANDER.dismountStepM))) k0++;
              const first = at(dismountM + behind + k0 * COMMANDER.dismountStepM);
              let spot: { x: number; y: number } | null = null;
              for (let k = k0; k < k0 + COMMANDER.dismountCandidates && spot === null; k++) {
                const p = at(dismountM + behind + k * COMMANDER.dismountStepM);
                if (eyes.every((e) => hidden(e.x, e.y, p.x, p.y))) spot = p;
              }
              const p = spot ?? first;
              order(c, { kind: "move", waypoints: [{ x: p.x, y: p.y, mode: "run" }], facing: atan2(uy, ux) });
            });
            toAll({ kind: "rules", fire: "return" });
            mem.out = [];
            mem.phase = "ride"; mem.phaseTick = tick;
            break;
          }
          // Walk most of the way, sneak the last stretch to the support line (M6.5b); routes keep to cover as
          // the faction's doctrine prefers (systems/orders.ts).
          squads.forEach((sq, i) => advance(sq, i));
          for (const m of hq) order(m, { kind: "move", waypoints: [{ x: supportAt().x - ux * 30, y: supportAt().y - uy * 30, mode: hqUnderFire() ? "run" : "walk" }] });
          mem.phase = "advance"; mem.phaseTick = tick;
          break;
        case "ride": {
          // An anti-tank threat (M7.4b, plan §12): enemy men its crews know close to the carrier (any of them may
          // carry a Panzerfaust or an RPG), or an enemy vehicle seen: out at once.
          const crewKnown = crews.flatMap((c) => view.unit.get(c)?.members ?? []).flatMap((m) => known(m));
          const atThreat = (vid: EntityId): boolean => {
            const vt = view.transform.get(vid);
            if (!vt) return false;
            return crewKnown.some((c) => c.wreck !== true && tick - c.tick <= 60 * 60 && c.kind !== "heard"
              && hypot2(c.x - vt.x, c.y - vt.y) <= (c.cls === "vehicle" ? (c.kind === "seen" ? COMMANDER.dismountThreatVehicleM : 0) : COMMANDER.dismountThreatMenM));
          };
          // Out when its vehicle has arrived, at once when a vehicle was hit, or after the ride has taken too long:
          // the squad is ordered to its support-line position and gets out first (Q12).
          const late = tick - mem.phaseTick >= COMMANDER.rideTimeoutSeconds * 60;
          mem.out ??= [];
          squads.forEach((sq, i) => {
            if (mem.out!.includes(sq)) return;
            const vid = view.unit.get(sq)?.carrier;
            const v = vid === undefined ? undefined : view.vehicle.get(vid);
            const there = v === undefined || v.drive.arrived || v.drive.routeIdx >= v.drive.route.length || v.status !== "ok";
            if (riders(view, sq).length > 0 && !(there || hitNow || late || (vid !== undefined && atThreat(vid)))) return;
            advance(sq, i);
            mem.out!.push(sq);
          });
          const hqIn = hq.filter((m) => (view.soldier.get(m) as SoldierState | undefined)?.mount !== undefined);
          const hqV = tops.length > 0 ? view.unit.get(tops[0]![0])?.carrier : undefined;
          const hv = hqV === undefined ? undefined : view.vehicle.get(hqV);
          if (hqIn.length > 0 && !mem.out.includes(-1) && (hv === undefined || hv.drive.arrived || hitNow || late || (hqV !== undefined && atThreat(hqV)))) {
            for (const m of hqIn) order(m, { kind: "move", waypoints: [{ x: supportAt().x - ux * 30, y: supportAt().y - uy * 30, mode: hqUnderFire() ? "run" : "walk" }] });
            mem.out.push(-1);
          }
          if (squads.every((sq) => mem.out!.includes(sq))) { mem.phase = "advance"; mem.phaseTick = tick; }
          break;
        }
        case "advance": {
          // (A squad still getting out before its move has not arrived.) A squad that went to ground on contact
          // short of its place moves on to it (balance pass 2026-11-13: it used to count as arrived, and the base
          // of fire lay 430-480 m out, beyond the reach of its rifles).
          // (Slice s0-clear: a house with a known, well-placed enemy on a squad's way is cleared first.)
          noteHouses();
          reviewClearings();
          let short = 0;
          squads.forEach((sq, i) => {
            if (strength(sq) < 0.5 || onLine(sq)) return;
            if (clearOnApproach(sq, placeOf(i), [placeOf(i)], false) || sendOn(sq, placeOf(i))) short++;
          });
          // (Two thirds of the squads in place is enough: the others come on as the fires go in.)
          const placed = squads.filter((sq) => onLine(sq) && !view.unit.get(sq)?.boarding).length;
          const arrived = (short === 0 && squads.every((sq) => !view.unit.get(sq)?.boarding && (onLine(sq) || !view.unit.get(sq)?.moving))) || placed * 3 >= squads.length * 2;
          // The squads nearing their places: the fires are called now, to land about as two thirds of them are in
          // place (when the squad that makes up two thirds is within the fire's delay and `prepLeadS` of its place at
          // a walk; overnight pick "assault-tempo": it was the first squad 100 m short along the axis).
          // (At night the last `sneakM` is longer, at the sneak's pace: by day the second term is 0.)
          const sneakMode = input.catalog.movementModes["sneak"], sneakMps = sneakMode?.class === "foot" ? sneakMode.speedMps : 0.7;
          const eta = squads.map((sq, i) => {
            const c = centre(sq), p = placeOf(i);
            if (c === null) return Infinity;
            if (onLine(sq)) return 0;
            const d = hypot2(c.x - p.x, c.y - p.y);
            return d / walkMps + (sneakM > COMMANDER.sneakM ? (Math.min(d, sneakM) - Math.min(d, COMMANDER.sneakM)) * (1 / sneakMps - 1 / walkMps) : 0);
          }).sort((a, b) => a - b);
          if (eta.length > 0 && eta[Math.max(0, Math.ceil((eta.length * 2) / 3) - 1)]! <= fireDelayS + COMMANDER.prepLeadS) prepFires();
          if (arrived || tick - mem.phaseTick > COMMANDER.advanceTimeoutSeconds * 60) { mem.phase = "recon"; mem.phaseTick = tick; toAll({ kind: "rules", fire: "free" }); }
          break;
        }
        case "recon": {
          // Look for the enemy around the objective before going in (what the men have seen or heard); call the
          // mortars (they take a minute or more) unless already called, and go in when their rounds are landing.
          prepFires();
          const fireLanding = mem.lastHe === undefined || tick - mem.lastHe >= (fireDelayS + 10) * 60;
          if ((knownNear() > 0 && fireLanding) || tick - mem.phaseTick >= Math.max(COMMANDER.reconSeconds, fireDelayS + 30) * 60) { mem.phase = "assault"; mem.phaseTick = tick; mem.lastAssault = {}; mem.closed = []; mem.closedAt = {}; mem.resumeN = {}; }
          break;
        }
        case "hold":
          // The enemy has taken an objective back: go for it again.
          if (objectives.some((_, i) => !holds(i))) { mem.target = objectives.findIndex((_, i) => !holds(i)); mem.phase = mem.target === 0 ? "assault" : "second"; mem.phaseTick = tick; mem.lastAssault = {}; if (mem.target === 0) { delete mem.reserve; delete mem.reserveLead; delete mem.reserveSq; delete mem.reserveAt; } }
          break;
        case "assault":
        case "second": {
          // In the second phase, the main objective lost again comes first.
          if (mem.phase === "second" && !holds(0)) { mem.target = 0; mem.phase = "assault"; mem.lastAssault = {}; delete mem.reserve; delete mem.reserveLead; delete mem.reserveSq; delete mem.reserveAt; }
          if (holds(mem.target)) {
            (mem.att ??= { baseLooks: 0, maskedLooks: 0, taken: 0, reserveKept: 0, reserveCommitted: 0, committedBeforeTake: 0, baseBounds: 0 }).taken++;
            // (A reserve still held is released: the objective fell without it.)
            if (mem.reserve !== undefined && mem.reserve >= 0) mem.reserve = -1;
            // Then the next objective the enemy still holds, the main one first; the main one is assaulted afresh
            // (closing in, then fire and movement), any other by the strongest squad.
            const next = objectives.findIndex((_, i) => !holds(i));
            if (next >= 0) {
              mem.target = next; mem.phase = next === 0 ? "assault" : "second"; mem.phaseTick = tick; mem.lastAssault = {};
              delete mem.flank; delete mem.axis;
              if (next === 0) { mem.closed = []; mem.closedAt = {}; mem.resumeN = {}; delete mem.reserve; delete mem.reserveLead; delete mem.reserveSq; delete mem.reserveAt; }
            } else { mem.phase = "hold"; toAll({ kind: "posture", posture: "prone" }); }
            break;
          }
          // The base of fire: the first squad still standing (in the second phase the weakest), the rest assault.
          const live = squads.filter((sq) => strength(sq) > 0);
          if (live.length === 0) break;
          const ranked = mem.phase === "second" ? [...live].sort((a, b) => strength(a) - strength(b) || a - b) : live;
          // Mortars (M6.5c): high explosive on the enemies its men know near the objective (else on it), smoke on
          // its near edge to blind them while the assault goes in; repeated while rounds last.
          // (Its own men near the point now, or squads assaulting toward it — they will be there when the rounds land.)
          const ownNear = (px: number, py: number, r: number) => all.some((f) => { const ft = view.transform.get(f); return ft !== undefined && view.soldier.get(f)?.physiology.alive === true && hypot2(ft.x - px, ft.y - py) < r; })
            || squads.some((sq) => { const d = view.unit.get(sq)?.drill; return d !== null && d !== undefined && (d.kind === "assault" || d.kind === "clear") && hypot2(d.x - px, d.y - py) < 150; });
          if (supportLeft(view, side, "he", input.catalog) > 0 && tick - (mem.lastHe ?? -1e9) >= COMMANDER.heEverySeconds * 60) {
            let hx = tgt.x, hy = tgt.y, best = 150;
            for (const m of all) for (const c of knownMen(m)) { const d = hypot2(c.x - tgt.x, c.y - tgt.y); if (d < best) { best = d; hx = c.x; hy = c.y; } }
            if (!ownNear(hx, hy, 90)) { heCall(hx, hy, Math.max(COMMANDER.heRounds, Math.floor(supportLeft(view, side, "he", input.catalog) / 4))); mem.lastHe = tick; }
          }
          if (mem.phase === "assault") blind();
          // Night (M9.6): an illumination round beyond the objective, along the way in, while the assault element closes.
          if (dark) illumCall(tgt.x + ux * N.illumBeyondM, tgt.y + uy * N.illumBeyondM);
          if (supportLeft(view, side, "smoke", input.catalog) > 0 && tick - (mem.lastSmoke ?? -1e9) >= COMMANDER.smokeEverySeconds * 60) {
            // (On the assault position's side of the objective.)
            const ap = assaultPos(chooseFlank()), af = COMMANDER.smokeAheadM / COMMANDER.assaultPositionM;
            const sx3 = clamp(tgt.x + (ap.x - tgt.x) * af, W), sy3 = clamp(tgt.y + (ap.y - tgt.y) * af, H);
            order(caller, { kind: "callFire", x: sx3, y: sy3, ammo: "smoke", rounds: COMMANDER.smokeRounds });
            mem.lastSmoke = tick;
          }
          // Half the squads fire (at least one), the others assault (M6.5b).
          const nBase = live.length > 1 ? Math.max(1, Math.floor(live.length / 2)) : 0;
          const bases = ranked.slice(0, nBase);
          const assaulters0 = live.length > 1 ? live.filter((sq) => !bases.includes(sq)) : [ranked[0]!];
          // (M7.5e: houses on the way in; a squad holding a house in the main ring stays there unless it is the only
          // one left to assault.)
          noteHouses();
          reviewClearings();
          const free = assaulters0.filter((sq) => mem.held?.[String(sq)] === undefined);
          const assaultersAll = free.length > 0 ? free : assaulters0;
          // D4a reserve (SPEC 6.9; owner to review): in the assault on the main objective, with `reserve.minSquads`
          // squads or more, the last of the assault element is held back `reserve.backM` behind the assault position
          // on the same flank, and committed when the assault falters: a squad of it broken or below
          // `reserve.commitStrength`, or all of it closed in and assaulting for `reserve.commitSeconds` without taking
          // the objective. Taken without it: it is released to the next task.
          const R = COMMANDER.reserve;
          const att = mem.att ??= { baseLooks: 0, maskedLooks: 0, taken: 0, reserveKept: 0, reserveCommitted: 0, committedBeforeTake: 0, baseBounds: 0 };
          if (mem.phase === "assault" && mem.reserve === undefined && live.length >= R.minSquads && assaultersAll.length >= 2) {
            mem.reserve = assaultersAll[assaultersAll.length - 1]!;
            mem.reserveLead = assaultersAll.filter((sq) => sq !== mem.reserve);
            att.reserveKept++;
          }
          let reserve = mem.phase === "assault" && mem.reserve !== undefined && mem.reserve >= 0 && live.includes(mem.reserve) ? mem.reserve : -1;
          if (mem.phase === "assault" && mem.reserve !== undefined && mem.reserve >= 0 && reserve < 0) mem.reserve = -1; // (gone)
          if (reserve >= 0) {
            // The squads it backs (as chosen: one cut down to nobody still counts as faltering). Faltering: one broken or
            // below `commitStrength`, or every one of them closed in for `commitSeconds` (since it reached the assault
            // position, not since its last re-assault) without the objective taken.
            const lead = mem.reserveLead ?? [];
            const faltering = lead.length === 0 || lead.some((sq) => view.unit.get(sq)?.broken === true || strength(sq) < R.commitStrength)
              || lead.every((sq) => mem.closed?.includes(sq) === true && tick - (mem.closedAt?.[String(sq)] ?? tick) >= R.commitSeconds * 60);
            // (Its lead in a house of the objective's ring: it goes in after them, to exploit.)
            const inHouse = !faltering && lead.every((sq) => mem.held?.[String(sq)] !== undefined || strength(sq) <= 0);
            const ready = strength(reserve) >= 0.5 && view.unit.get(reserve)?.broken !== true;
            // (A lead with nobody left able: it goes in whatever its state, or nobody would.)
            const leadGone = lead.every((sq) => strength(sq) <= 0 || view.unit.get(sq)?.broken === true);
            if ((faltering && (ready || leadGone)) || inHouse) {
              // (Its own closing in starts now: re-sends counted afresh, `closeTimeoutSeconds` from the commitment.)
              mem.reserveSq = reserve; mem.reserveAt = tick;
              if (mem.resumeN) delete mem.resumeN[String(reserve)];
              mem.reserve = -1; reserve = -1;
              att.reserveCommitted++;
              if (inHouse) att.reserveExploit = (att.reserveExploit ?? 0) + 1; else att.committedBeforeTake++;
            } else {
              // Held: to its place behind the assault position (sent on as the others are), facing the objective.
              sendOn(reserve, assaultPos(chooseFlank(), 0, COMMANDER.assaultPositionM + R.backM));
            }
          }
          const assaulters = assaultersAll.filter((sq) => sq !== reserve);
          for (const sq of assaulters) if (mem.held?.[String(sq)] !== undefined) delete mem.held![String(sq)];
          // D4a: is each squad of the base of fire masked by its own men? A man is, when every enemy near the objective
          // (or the objective itself, none known) he has a line of fire to has own men within `liftM` of it or in the
          // safety cone of his line; the squad is, when half its men who have a line at all are. Tallied once a look.
          const maskedBases = new Set<EntityId>();
          /** Men of the base whose every line of fire has an own man in it (each with the first such aim). */
          const blockedMen: [EntityId, { x: number; y: number; h: number }, EntityId][] = [], steppedNow = new Set<EntityId>(), boundNow = new Set<EntityId>();
          const maskOwn = all.filter((f) => { const s = view.soldier.get(f) as SoldierState | undefined; return able(s) && s!.mount === undefined && !bases.includes(view.identity.get(f)?.unit ?? -1); })
            .map((f) => view.transform.get(f)).filter((x) => x !== undefined);
          const lifted = (x: number, y: number) => maskOwn.some((f) => hypot2(f.x - x, f.y - y) < COMMANDER.liftM);
          const maskPts = new Map<EntityId, { x: number; y: number }>();
          for (const m of all) for (const c of knownMen(m)) if (!maskPts.has(c.target) && hypot2(c.x - tgt.x, c.y - tgt.y) <= 120) maskPts.set(c.target, { x: c.x, y: c.y });
          // (At a man's chest, as the base's fire; none known: the objective at 0.5 m.)
          const maskAims = [...maskPts.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => ({ ...p, h: 0.9 }));
          if (maskAims.length === 0) maskAims.push({ x: tgt.x, y: tgt.y, h: 0.5 });
          {
            const aims = maskAims, st = view as unknown as SimState;
            for (const base of bases) {
              const u = view.unit.get(base);
              if (!u || u.drill?.kind === "clear" || riders(view, base).length > 0) continue;
              let lined = 0, masked = 0, inLine = 0;
              for (const m of members(view, base)) {
                const s = view.soldier.get(m) as SoldierState | undefined, mt = view.transform.get(m);
                if (!able(s) || committed(s) || s!.mount !== undefined || !mt) continue;
                const open = aims.filter((p) => fireLine(mt.x, mt.y, p.x, p.y, p.h) > 0);
                if (open.length === 0) continue;
                lined++;
                const line = open.map((p) => friendInLine(ground(), st, m, p.x, p.y));
                if (open.every((p, j) => lifted(p.x, p.y) || line[j])) masked++;
                if (line.every((x) => x)) blockedMen.push([m, open[0]!, base]);
                // (Masked by men in his line itself, the lift aside.)
                if (line.every((x) => x)) inLine++;
              }
              if (lined === 0) continue;
              att.baseLooks++;
              if (masked * 2 >= lined) { att.maskedLooks++; maskedBases.add(base); }
              if (inLine * 2 >= lined) att.inLineLooks = (att.inLineLooks ?? 0) + 1;
            }
          }
          // D4a: a squad of the base of fire masked `baseBound.maskedLooks` looks in a row bounds forward (owner to
          // review): to the spot, `baseBound.stepM` or half of it nearer the objective (never within `baseBound.minM`)
          // and turned up to `baseBound.turnDeg` away from the assault's side, with the most lines of fire onto the
          // enemies known near the objective clear of its own men; at a run under fire. At most every `everySeconds`.
          {
            const BB = COMMANDER.baseBound, st = view as unknown as SimState;
            mem.maskedRun ??= {}; mem.baseMoved ??= {};
            const ac = assaulters.map(centre).filter((x) => x !== null);
            const aBear = ac.length > 0 ? atan2(ac.reduce((a, p) => a + p.y, 0) / ac.length - tgt.y, ac.reduce((a, p) => a + p.x, 0) / ac.length - tgt.x) : null;
            for (const base of bases) {
              const k = String(base);
              mem.maskedRun[k] = maskedBases.has(base) ? (mem.maskedRun[k] ?? 0) + 1 : 0;
              if (mem.maskedRun[k]! < BB.maskedLooks || tick - (mem.baseMoved[k] ?? -1e9) < BB.everySeconds * 60 || !idle(base)) continue;
              const c = centre(base);
              const shooter = members(view, base).find((m) => able(view.soldier.get(m) as SoldierState | undefined));
              if (!c || shooter === undefined) continue;
              const dc = hypot2(c.x - tgt.x, c.y - tgt.y), bc = atan2(c.y - tgt.y, c.x - tgt.x);
              let diff = aBear === null ? 1 : bc - aBear;
              while (diff > PI) diff -= 2 * PI;
              while (diff < -PI) diff += 2 * PI;
              const away = diff >= 0 ? 1 : -1;
              // (Enemies its own men are close to are theirs: no spot helps there.)
              const aims = maskAims.filter((p) => !lifted(p.x, p.y));
              if (aims.length === 0) continue;
              const foot = navFor(ground(), "foot").grid;
              let best: { x: number; y: number } | null = null, bestScore = 0;
              for (const turn of BB.turnDeg) for (const step of [BB.stepM, BB.stepM / 2]) {
                const d = Math.max(BB.minM, dc - step), a = bc + (away * turn * PI) / 180;
                // (Forward only: a base already within `minM` (the second objective) stays.)
                if (d >= dc - 1) continue;
                const x = clamp(tgt.x + cos(a) * d, W), y = clamp(tgt.y + sin(a) * d, H);
                if (navCostAt(foot, x, y) <= 0 || indoorAt(ground(), x, y) >= 0) continue;
                const score = aims.reduce((n, p) => n + (fireLine(x, y, p.x, p.y, p.h) > 0 && !friendInLine(ground(), st, shooter, p.x, p.y, 0, { x, y }) ? 1 : 0), 0)
                  - hypot2(x - c.x, y - c.y) * 0.002;
                if (score > bestScore) { bestScore = score; best = { x, y }; }
              }
              if (!best) continue;
              order(base, { kind: "move", waypoints: [{ x: best.x, y: best.y, mode: underFire(base) ? "run" : "walk" }], facing: atan2(tgt.y - best.y, tgt.x - best.x) });
              mem.baseMoved[k] = tick; mem.maskedRun[k] = 0;
              boundNow.add(base);
              att.baseBounds++;
            }
          }
          // Sight realism step 5: a base-of-fire squad none of whose men has seen an enemy for `baseBlindSeconds` slides
          // along the support line (`baseShiftM` either way, `baseForwardM` forward) to the spot that sees most of the
          // enemies known near the objective (else the objective's ring), rather than firing blind; at most every
          // `baseShiftSeconds`, and only when the spot sees more than where it lies now.
          {
            const RQ = COMMANDER.reacquire, ctx = ground();
            mem.baseShift ??= {};
            const tally = mem.rq ??= { resites: 0, men: 0, follows: 0, followMen: 0, back: 0, baseShifts: 0 };
            const pts = maskAims.length > 0 && !(maskAims.length === 1 && maskAims[0]!.h === 0.5) ? maskAims.map((p) => ({ x: p.x, y: p.y }))
              : [0, 1, 2, 3, 4, 5, 6, 7].map((k) => ({ x: tgt.x + cos((k * PI) / 4) * tgt.radiusM, y: tgt.y + sin((k * PI) / 4) * tgt.radiusM })).concat([{ x: tgt.x, y: tgt.y }]);
            for (const base of bases) {
              const k = String(base);
              if (boundNow.has(base) || !idle(base) || !onLine(base) || tick - (mem.baseShift[k] ?? -1e9) < RQ.baseShiftSeconds * 60 || tick - (mem.baseMoved?.[k] ?? -1e9) < RQ.baseShiftSeconds * 60) continue;
              const ms = members(view, base).filter((m) => able(view.soldier.get(m) as SoldierState | undefined));
              if (ms.length === 0 || ms.some((m) => { const t = view.soldier.get(m)?.sawEnemyTick; return t !== undefined && tick - t < RQ.baseBlindSeconds * 60; })) continue;
              if (tick - mem.phaseTick < RQ.baseBlindSeconds * 60) continue;
              const c = centre(base);
              if (!c) continue;
              const foot = navFor(ctx, "foot").grid;
              const here = seenShare(ctx, c.x, c.y, pts);
              const L = hypot2(tgt.x - c.x, tgt.y - c.y) || 1, fx = (tgt.x - c.x) / L, fy = (tgt.y - c.y) / L;
              let best: { x: number; y: number } | null = null, bestScore = here + 0.05;
              for (const fwd of RQ.baseForwardM) for (const off of RQ.baseShiftM) {
                const x = clamp(c.x + fx * fwd - fy * off, W), y = clamp(c.y + fy * fwd + fx * off, H);
                if (navCostAt(foot, x, y) <= 0 || indoorAt(ctx, x, y) >= 0) continue;
                const q = bestCoverNear(foot, x, y, 4) ?? { x, y };
                const score = seenShare(ctx, q.x, q.y, pts) - hypot2(q.x - c.x, q.y - c.y) * 0.001;
                if (score > bestScore) { bestScore = score; best = q; }
              }
              mem.baseShift[k] = tick;
              if (!best) continue;
              order(base, { kind: "move", waypoints: [{ x: best.x, y: best.y, mode: underFire(base) ? "run" : "walk" }], facing: atan2(tgt.y - best.y, tgt.x - best.x) });
              (mem.baseMoved ??= {})[k] = tick;
              boundNow.add(base);
              tally.baseShifts++;
            }
          }
          // D4a: a man of the base whose every line of fire has an own man in it (a squad gone to ground on its way lies
          // in file: two thirds of the masked looks were its own men) dashes a few metres across his line
          // (`baseBound.stepAsideM`, nearest first) to a spot on open ground, `soldier.minSpacingM` clear of others, with
          // a line of fire to an enemy known near the objective that no own man is in; at most every `stepAsideSeconds`.
          // Then the base's fire is given again at the next look (after this look's fire, below).
          if (blockedMen.length > 0) {
            const BB = COMMANDER.baseBound, st = view as unknown as SimState, ctx = ground(), foot = navFor(ctx, "foot").grid;
            const minM = input.catalog.behaviour.soldier.minSpacingM;
            const ours = all.map((f) => view.transform.get(f)).filter((x) => x !== undefined);
            let stepped = 0;
            mem.stepAside ??= {};
            for (const [m, aim, base] of blockedMen) {
              // (Not a man whose squad bounds forward this look: its move takes him along.)
              if (boundNow.has(base)) continue;
              const mt = view.transform.get(m)!;
              if (mt.z > 0 || indoorAt(ctx, mt.x, mt.y) >= 0 || tick - (mem.stepAside[String(m)] ?? -1e9) < BB.stepAsideSeconds * 60) continue;
              if ((view.mover.get(m)?.waypoints.length ?? 0) > 0) continue;
              const L = hypot2(aim.x - mt.x, aim.y - mt.y);
              if (L < 1) continue;
              const px = -(aim.y - mt.y) / L, py = (aim.x - mt.x) / L;
              for (const off of BB.stepAsideM) {
                const x = mt.x + px * off, y = mt.y + py * off;
                if (x < 1 || y < 1 || x > W - 1 || y > H - 1 || navCostAt(foot, x, y) <= 0 || indoorAt(ctx, x, y) >= 0) continue;
                if (ours.some((o) => o !== mt && hypot2(o.x - x, o.y - y) < minM)) continue;
                const to = maskAims.find((p) => !lifted(p.x, p.y) && fireLine(x, y, p.x, p.y, p.h) > 0 && !friendInLine(ctx, st, m, p.x, p.y, 0, { x, y }));
                if (!to) continue;
                order(m, { kind: "move", waypoints: [{ x, y, mode: "run" }], facing: atan2(to.y - y, to.x - x) });
                mem.stepAside[String(m)] = tick;
                steppedNow.add(m);
                stepped++;
                break;
              }
            }
            if (stepped > 0) att.stepped = (att.stepped ?? 0) + stepped;
          }
          if (bases.length > 0 && tick - mem.lastFire >= COMMANDER.refireSeconds * 60) {
            // Distribution of fire (balance pass 2026-11-13): each man of the base of fire at another enemy its men
            // know near the objective, at the full rate; fire lifts off an enemy its own men are close to (they
            // are going in there); none known: at the objective while it is clear of its own men.
            const ownFoot = all.filter((f) => { const s = view.soldier.get(f) as SoldierState | undefined; return able(s) && s!.mount === undefined && !bases.includes(view.identity.get(f)?.unit ?? -1); })
              .map((f) => view.transform.get(f)).filter((x) => x !== undefined);
            const clear = (x: number, y: number) => !ownFoot.some((f) => hypot2(f.x - x, f.y - y) < COMMANDER.liftM);
            /** The enemies the base's men know within `r` of (px, py), not near its own men, in a fixed order. */
            const near = (px: number, py: number, r: number): [EntityId, { x: number; y: number }][] => {
              const targets = new Map<EntityId, { x: number; y: number }>();
              for (const base of bases) for (const m of members(view, base)) for (const c of knownMen(m)) {
                if (hypot2(c.x - px, c.y - py) > r || targets.has(c.target)) continue;
                targets.set(c.target, { x: c.x, y: c.y });
              }
              return [...targets.entries()].sort((a, b) => a[0] - b[0]).filter(([, p]) => clear(p.x, p.y));
            };
            // One squad of the base keeps the other objective's garrison down while the main one is attacked
            // (it lies on the flank of the way in), when the base has two squads or more.
            const other = mem.target === 0 && objectives.length > 1 && !holds(1) && bases.length > 1 ? objectives[1]! : null;
            // (D4a shift fire: none left near the objective clear of its own men, the enemies it knows in depth or on the
            // flanks, out to `baseBound.shiftM`.)
            const near0 = near(tgt.x, tgt.y, 120);
            const mainList = near0.length > 0 ? near0 : near(tgt.x, tgt.y, COMMANDER.baseBound.shiftM);
            const sideList = other ? near(other.x, other.y, other.radiusM + 30) : [];
            let k = 0;
            bases.forEach((base, bi) => {
              // (A squad clearing a house on its approach is left to its drill; one bounding forward to its move, D4a.)
              if (view.unit.get(base)?.drill?.kind === "clear" || boundNow.has(base) || (view.unit.get(base)?.moving === true && tick - (mem.baseMoved?.[String(base)] ?? -1e9) < COMMANDER.baseBound.everySeconds * 60)) return;
              if (mem.maxRate?.includes(base) !== true) { order(base, { kind: "rules", ammo: "max" }); (mem.maxRate ??= []).push(base); }
              const flankBase = other !== null && bi === bases.length - 1;
              const list = flankBase ? sideList : mainList, aim = flankBase ? other : tgt;
              for (const m of members(view, base)) {
                if (!able(view.soldier.get(m) as SoldierState | undefined) || committed(view.soldier.get(m) as SoldierState | undefined) || view.action.has(m) || steppedNow.has(m)) continue;
                // (The next enemy on the list he has a line of fire to; none: the objective, if he can fire at it.)
                const mt = view.transform.get(m);
                if (!mt) continue;
                let done = false;
                for (let j = 0; j < list.length && !done; j++) {
                  const [id, p] = list[(k + j) % list.length]!;
                  if (fireLine(mt.x, mt.y, p.x, p.y, 0.9) > 0) { order(m, { kind: "fire", x: p.x, y: p.y, contact: id }); k += j + 1; done = true; }
                }
                // (Not where all he knows there is protected people: he would refuse, Q-7.)
                const spareM = input.catalog.medical?.protection.aimSpareM;
                if (!done && spareM !== undefined && onlyProtectedAt(view.soldier.get(m)?.contacts ?? [], aim.x, aim.y, spareM)) done = true;
                if (!done && clear(aim.x, aim.y) && fireLine(mt.x, mt.y, aim.x, aim.y, 0.5) > 0) order(m, { kind: "fire", x: aim.x, y: aim.y, heightM: 0.5 });
              }
            });
            mem.lastFire = tick;
          }
          // (D4a: men who stepped aside this look fire again at the next one, from their new spots.)
          if (steppedNow.size > 0) mem.lastFire = Math.min(mem.lastFire, tick + every - COMMANDER.refireSeconds * 60);
          // Close in: grenades at an enemy an assaulting squad knows within throwing range (M6.5b); from the
          // assault position on (balance pass 2026-11-13) also its grenade launchers, at the nearest enemy it knows
          // within their reach (the order's men pick hand grenade or launcher by range).
          mem.lastGrenade ??= {};
          for (const sq of assaulters) {
            if (tick - (mem.lastGrenade[String(sq)] ?? -1e9) < COMMANDER.grenadeEverySeconds * 60) continue;
            // (A squad clearing a house throws its own, room by room.)
            if (view.unit.get(sq)?.drill?.kind === "clear") continue;
            const reach = mem.closed?.includes(sq) === true ? COMMANDER.launcherReachM : COMMANDER.grenadeRangeM;
            const men = members(view, sq).filter((m) => able(view.soldier.get(m) as SoldierState | undefined));
            let hit: { x: number; y: number } | null = null, hitD = Infinity;
            for (const m of men) {
              const t = view.transform.get(m);
              if (!t) continue;
              for (const c of knownMen(m)) {
                const dc = hypot2(c.x - t.x, c.y - t.y);
                if (dc > reach || dc >= hitD) continue;
                // Never where a friend is close to the burst.
                if (all.some((f) => { const ft = view.transform.get(f); return ft !== undefined && view.soldier.get(f)?.physiology.alive === true && hypot2(ft.x - c.x, ft.y - c.y) < 15; })) continue;
                hit = { x: c.x, y: c.y }; hitD = dc;
              }
            }
            if (hit) { order(sq, { kind: "grenade", x: hit.x, y: hit.y, count: 2 }); mem.lastGrenade[String(sq)] = tick; }
          }
          // The assault element first runs to the assault position (once, in the first phase), then assaults.
          mem.closed ??= [];
          const flank = chooseFlank();
          assaulters.forEach((sq, i) => {
            if (mem.closed!.includes(sq)) return;
            const off = (i - (assaulters.length - 1) / 2) * 25;
            const late = mem.phase === "second" || tick - (sq === mem.reserveSq ? mem.reserveAt ?? mem.phaseTick : mem.phaseTick) >= COMMANDER.closeTimeoutSeconds * 60;
            // (Slice s0-clear: closing in, a house with a known, well-placed enemy on its way is cleared first.)
            // (Its way leads on to the objective: a house of the objective's ring on it counts.)
            if (!late && clearOnApproach(sq, tgt, [assaultPos(flank, off, COMMANDER.closeInM)], true)) return;
            // Not under fire, it goes on past the assault position to `closeInM`; under fire within reach of it,
            // it goes over to fire and movement from where it is.
            const c = centre(sq), d = c === null ? 0 : hypot2(c.x - tgt.x, c.y - tgt.y);
            const there = d <= COMMANDER.closeInM + COMMANDER.arrivedM || (d <= COMMANDER.assaultPositionM + COMMANDER.arrivedM && underFire(sq));
            if (late || there || !sendOn(sq, assaultPos(flank, off, COMMANDER.closeInM), true)) {
              mem.closed!.push(sq);
              (mem.closedAt ??= {})[String(sq)] = tick;
              // (Smoke on the near edge again, to stand while it goes in after its rest, if the last is thinning.)
              if (mem.phase === "assault" && supportLeft(view, side, "smoke", input.catalog) > 0 && tick - (mem.lastSmoke ?? -1e9) >= (COMMANDER.smokeEverySeconds / 2) * 60) {
                const ap = assaultPos(flank), af = COMMANDER.smokeAheadM / COMMANDER.assaultPositionM;
                screen(clamp(tgt.x + (ap.x - tgt.x) * af, W), clamp(tgt.y + (ap.y - tgt.y) * af, H), tgt.x, tgt.y);
                mem.lastSmoke = tick;
              }
            }
          });
          /** Its breath back at the assault position (first assault only; at once under fire). */
          const rested = (sq: EntityId) => {
            const t0 = mem.closedAt?.[String(sq)];
            if (mem.phase !== "assault" || t0 === undefined || mem.lastAssault[String(sq)] !== undefined || underFire(sq) || tick - t0 >= COMMANDER.restMaxSeconds * 60) return true;
            const f = members(view, sq).map((m) => view.soldier.get(m) as SoldierState | undefined).filter((x) => able(x)).map((x) => x!.physical.fatigue);
            return f.length === 0 || f.reduce((a, b) => a + b, 0) / f.length < COMMANDER.restFatigue;
          };
          assaulters.forEach((sq, i) => {
            const u = view.unit.get(sq);
            const last = mem.lastAssault[String(sq)] ?? -1e9;
            if (!mem.closed!.includes(sq) || mem.clearing?.[String(sq)] !== undefined && !u?.drill) return;
            if (u && !u.drill && !u.broken && moraleReady(u) && strength(sq) >= 0.5 && tick - last >= COMMANDER.reassaultSeconds * 60 && rested(sq)) {
              const off = (i - (assaulters.length - 1) / 2) * 20;
              const hb = nextHouse(sq);
              if (hb >= 0) {
                const h = houseMid(hb), bid = input.map.buildings[hb]!.id;
                order(sq, { kind: "assault", x: clamp(h.x, W), y: clamp(h.y, H), building: bid });
                (mem.clearing ??= {})[String(sq)] = [bid, tick];
              } else order(sq, { kind: "assault", x: clamp(tgt.x - uy * off, W), y: clamp(tgt.y + ux * off, H) });
              mem.lastAssault[String(sq)] = tick;
            }
          });
          break;
        }
        default:
          break;
      }
      return out;
    },
    saveState: () => JSON.parse(JSON.stringify(mem)) as unknown,
    loadState: (d) => { mem = JSON.parse(JSON.stringify(d)) as Memory; },
  };
  // (M9.4b: it also keeps its platoons' drones up, over where it wants to look.)
  return withDrones(ctl, input);
}

function clamp(v: number, max: number): number { return Math.min(Math.max(v, 5), max - 5); }

function unitPersons(u: UnitInput | undefined): string[] {
  return u === undefined ? [] : [...u.members.map((m) => m.personId), ...u.subunits.flatMap(unitPersons)];
}

/**
 * M11.1 (hold-resupply): a side that fights in waves — top-level platoons arriving late (`UnitInput.arriveS`) — gets
 * one commander per platoon, each planning its own attack from where it comes in, as if it were the only platoon of
 * the side (losses of an earlier wave do not count against a fresh one). Their memories are saved together.
 */
export function waveCommanders(side: SideId, input: BattleInput): Controller {
  const force = input.forces.find((f) => f.side === side)!;
  const plats = force.units.filter((u) => u.echelon === "platoon");
  const subs = plats.map((u) => commanderController(side, input, { callsign: u.callsign }));
  return {
    side,
    think(view, tick) { return subs.flatMap((c) => c.think(view, tick)); },
    saveState: () => subs.map((c) => c.saveState?.() ?? null),
    loadState: (d) => { (d as unknown[]).forEach((x, i) => { if (x !== null) subs[i]?.loadState?.(x); }); },
  };
}
