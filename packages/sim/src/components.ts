/**
 * Component types. Entities are numbers; each kind of state lives in its own store (SPEC 4.3 rule 6).
 * All components are plain data (no methods, no class instances) so the whole state serialises.
 */
import type { AmmoRule, ContactRule, FireRule, StationKind } from "./catalog";
import type { DefId, EntityId, SideId } from "./ids";
import type { OrderBody, Posture, Waypoint } from "./orders";
import type { Physiology, Wound } from "./wounds";

/** Who a soldier is. Persistent across battles via the roster (`personId`). */
export interface Identity {
  personId: string;
  given: string;
  family: string;
  rank: DefId;
  role: DefId;
  faction: DefId;
  side: SideId;
  /** The lowest unit (team/squad) he belongs to. Unit path = walk up `Unit.parent`. */
  unit: EntityId;
}

export interface Transform {
  x: number;
  y: number;
  /** Height above ground, metres (eye/centre height is derived from posture). */
  z: number;
  /** Facing, radians, 0 = east, PI/2 = south (y grows south). */
  heading: number;
}

export interface Mover {
  /** Remaining waypoints; empty = idle. */
  waypoints: Waypoint[];
  /** Current speed, m/s. */
  speedMps: number;
  /** Grade of the ground along the direction of travel (rise/run), for exertion. */
  grade: number;
  /** Movement mode of the current leg (exertion), or null when not moving. */
  mode: DefId | null;
  /** Formation slot of a follower: offset from the leader in metres (right, back of his heading). */
  formation: { leader: EntityId; rightM: number; backM: number } | null;
  /** How far behind his slot this follower was last tick (m, 0 if not behind); the leader waits for laggards. */
  slotLagM: number;
  /** On reaching the last waypoint: take this posture and face this way (halt drill). */
  endPosture: Posture | null;
  /** Under fire on a walk or sneak leg he runs (`soldier.hurryMode`) until this tick; renewed while the fire lasts,
   *  dropped when his way ends. Optional (absent = his legs' own paces). */
  /** M8.3a: he waits in place until this tick (a mortar crew packing its tube before the move). Absent: no wait. */
  holdUntilTick?: number;
  hurryUntilTick?: number;
  endHeading: number | null;
}

/**
 * "surrendered" is set together with `captive` and is never overwritten while `captive !== null`; it is for
 * display and the `behaviour.changed` event — code asks `isCaptive`. There is no "captured" behaviour.
 */
export type Behaviour =
  | "steady" | "cautious" | "pinned" | "shaken" | "panicked" | "routed" | "surrendered" | "incapacitated";

/**
 * Sources of a man's lost morale (morale rework 2026-11-15), the order of `SoldierState.mental.why`. The first seven
 * belong to the shock (they fade with it), the rest to the strain. UI keys: `morale.reason.<source>`.
 */
export const MORALE_SOURCES = ["underFire", "artillery", "armour", "flanked", "enemyClose", "isolated", "comradeHit", "leaderLost", "squadLosses", "wounded", "uncared", "fatigue"] as const;
export type MoraleSource = (typeof MORALE_SOURCES)[number];
/** Index of the first strain source in `MORALE_SOURCES`. */
export const MORALE_STRAIN_FROM = 7;

/** A unit's morale (morale rework 2026-11-15), refreshed every `morale.unitStepSeconds` by systems/morale.ts. */
export interface UnitMorale {
  /** Mean morale of its able men (all men under it for a unit with sub-units). */
  value: number;
  state: "steady" | "shaken" | "pinned" | "broken";
  /** Men at the start (all men under it) and those lost since (killed, incapacitated, surrendered). */
  start: number;
  lost: number;
  /** Ticks of its latest losses (at most 8, within `shock.rapidWindowS`). */
  recent: number[];
  /** Enemy known on two sides or behind (`unit.flankSpanDeg`), and since when. */
  flanked: boolean;
  flankTick: number;
  /** Cohesion and trust 0..1: from its template or quality; falls with its leader lost and comrades left lying. */
  bond: number;
  /** First tick a man of it came under fire (-1 = not yet): no break within `unit.minBreakSeconds` of it. */
  firstContact: number;
  /** Since when its value has been below `unit.brokenValue` (-1 = it is not). */
  lowSince: number;
  /** Downed men of it with nobody coming to them, and since when there have been any (-1 = none). */
  uncared: number;
  uncaredSince: number;
  /** Own fire support relief given this minute (`relief.supportCapPerMin`) and the minute's start tick. */
  support: number;
  supportTick: number;
  /** Last "rallying" call on the radio. */
  radioTick: number;
  /** When it last rallied after a break (-1 = never): no new break within `unit.minBreakSeconds` of it. */
  rallied: number;
}

/** Why a man gave up (carried by the `surrendered` event). */
export type SurrenderReason = "wounded" | "panicked" | "routed";

/** A prisoner's group by rank (M11.9 segregation): from his rank's NATO code (OF-* officer, from
 *  `prisoners.segregation.ncoFrom` NCO, else man; a rank without a code: man). */
export type PrisonerGroup = "officer" | "nco" | "man";

/**
 * A man who has given up. Moves forward only: null -> surrendered -> captured. Never back.
 * M11.9 (systems/prisoners.ts; all optional, set once he is taken): `by` the side holding him; `unit` the unit whose
 * man took him (its squad sends his escort; its platoon's collection point and Verwundetennest are his);
 * `group` officer / NCO / man; `searchTicks` how long he has been searched so far (kept when a search is
 * interrupted); `searched` the tick his search ended; `escort` the man walking him back (or guarding him on the way);
 * `point` the collection point (a `rear` point of kind "prisoners") he has reached and is held at.
 */
export interface Captive {
  state: "surrendered" | "captured";
  /** Tick at which he gave up. */
  tick: number;
  by?: SideId;
  unit?: EntityId;
  group?: PrisonerGroup;
  searchTicks?: number;
  searched?: number;
  escort?: EntityId;
  point?: EntityId;
  /** M11.9b: aboard the military police hull `vehicle` (boarded at its point); `evacTick`: taken off the map by it (an
   *  evacuated prisoner, roster `powEvacuated`). */
  vehicle?: EntityId;
  evacTick?: number;
  /** M11.9b: documents items taken from him in his search (`BattleResult.prisoners`). */
  documents?: number;
  /**
   * M11.9c: he is escaping (systems/prisoners.ts "escapes"; the one way back from "captured": free, `captive` null, when
   * he reaches a fit man of his side; recaptured, back to "surrendered", when a fit man of the holding side reaches
   * him). `tick` he set off; `openTick`: from then on the enemy no longer sees a man giving up (`surrendered` flag);
   * `open`: the flags have been taken back; `routeTick`: when his way was last set. His `point` and `escort` are gone,
   * `by`, `unit`, `group` and `searched` stay (for the record and a recapture).
   */
  escape?: { tick: number; openTick: number; open?: true; routeTick: number };
}

/** Individual soldier state (SPEC 6.4). M0 holds the fields; systems that change them come in M1-M4. */
/**
 * M11.6: the battery fitted in one powered device a man carries (a radio, a goggle, a thermal sight). It lives outside
 * his container, as the magazine in his weapon does (mass and roster out count it). The charge is not stepped: it is
 * `wh0` Wh at tick `since` and falls at the device's draw while `on` (power.ts `chargeAt`); `flatTick` is the tick it
 * reaches 0 while on (NEVER_TICK when off). `battery` null: no battery fitted (a dead device). `flatSent`: the
 * `power.flat` event for this battery has gone out. `drawW`: the device's draw (W; from the catalog, kept here so the
 * charge can be read without it).
 */
export interface PowerSlot { device: DefId; battery: DefId | null; wh0: number; since: number; on: boolean; flatTick: number; drawW: number; flatSent?: true }

export interface SoldierState {
  /** Skills 0..1: marksmanship, fieldcraft, medical, leadership, experience (keys are data). */
  skills: Record<string, number>;
  posture: Posture;
  /** Posture being taken, or null. The change completes at `postureDoneTick`. */
  postureTo: Posture | null;
  postureDoneTick: number;
  /** winded: reached the exhaustion limit; stays true until fatigue falls below the run-again level. */
  physical: { fatigue: number; heartRateBpm: number; hydration: number; winded: boolean };
  /**
   * His state of mind (morale rework 2026-11-15, systems/morale.ts). `morale` = resolve x (1 - shock) x (1 - strain),
   * written every morale step (the UI, medical care and the AI read it). `stress` is the SHOCK (fast fear: fire, a
   * comrade falling, tanks; recovers in minutes); `strain` the slow wear (losses, his wounds, his leader lost; tens
   * of minutes, never below his squad's loss floor). `nerve`: his own steadiness, drawn at setup (stream "morale").
   * `why`: how much of his shock and strain each source holds (`MORALE_SOURCES` order; the UI shows the largest).
   * `jolt`: suppression added since his last step (a near miss registers at once). `flee`: a panicked man running
   * back to (x, y) until `untilTick`. `rallyTick`: last rallied by his leader; `panicTick`: when he panicked.
   * `lossBooked`: counted as a loss of his units (once per man, however often he is hit, dies or gives up; cleared
   * when he comes round).
   */
  mental: {
    stress: number; suppression: number; morale: number; behaviour: Behaviour;
    strain: number; nerve: number; why: number[]; jolt: number;
    flee: { x: number; y: number; untilTick: number } | null; rallyTick: number; panicTick: number; lossBooked: boolean;
  };
  physiology: Physiology;
  wounds: Wound[];
  nextWoundId: number;
  /** What his wounds and condition allow, refreshed when they change (see systems/wounds.ts). */
  impair: { move: number; aim: number; canWalk: boolean; canUseArms: boolean; canFight: boolean; canSpeak: boolean };
  /** Knocked down (e.g. a round stopped by his plate): no moving or firing until this tick. */
  stunnedUntilTick: number;
  /** Enemies he can see now or saw moments ago (M3.2), ascending target ID. */
  seen: { target: EntityId; firstTick: number; lastTick: number }[];
  /** What he knows of the enemy (M3.3), ascending target ID: from his own eyes, his ears, or reports. */
  contacts: Contact[];
  /** Getting away from a grenade at (x, y): from startTick he runs from it (`run`) or drops flat; over at untilTick. */
  evade: { x: number; y: number; startTick: number; untilTick: number; run: boolean; /** He has left his planned way. */ ran: boolean; /** Stepping out of a vehicle's way (M7): no dive, back to his way at once. */ aside?: true } | null;
  /** What he decided on his own last (M4.2), for the debug overlay and to pace his decisions. */
  intent: Intent | null;
  /** Last tick he went looking for cover on his own. */
  coverTick: number;
  /** Sight realism step 2: the last tick he saw an enemy within `soldier.closeThreatM` in his front arc while he was
   *  caring for a comrade; his care waits until `decisions.contactLostSeconds` after it. Optional (absent = never). */
  closeThreatTick?: number;
  /**
   * Casualty status already reported: none, incapacitated (unconscious or unable to act) or killed.
   * Physical only: surrender lives in `captive`.
   */
  casualty: "none" | "incapacitated" | "killed";
  /**
   * The one source of truth for surrender (M6.6): null while he is in the fight. `casualty` stays physical, so
   * a prisoner can also be incapacitated or killed.
   */
  captive: Captive | null;
  /**
   * Walking over to give himself up (systems/surrender.ts, owner 2026-11-14): a surrendered man who can walk walks,
   * hands up, toward `to` (an enemy he knows of; null: toward the nearest enemy he knows of only by a sound or an
   * unfit man) and stops at (x, y, z), a few metres short. `tick`: when he set off. `down`: he has gone down under
   * fire and waits for it to pass. `done`: the walk is over (he could not go on, or ran out of time): he waits
   * where he is and an enemy may fetch him. Absent: he has not set off (or never will).
   */
  handOver?: { to: EntityId | null; x: number; y: number; z: number; tick: number; down?: true; done?: true };
  /** Aboard a vehicle (M7): which one and which seat (index into its seats). Absent when not mounted. `lying`: a
   *  casualty lying down (M10.4b): in a vehicle without an ambulance layout he takes `vehicleLoading.lyingSeats`
   *  passenger places (his seat and room beside it), in an ambulance one of its lying places. */
  mount?: { vehicle: EntityId; seat: number; lying?: true };
  /**
   * Beaten zone (soldier AI package B): where enemy mortar rounds have been bursting near him (running mean of the
   * bursts of one mission), the last burst's tick, how many, and whether he has already moved out of it. Absent
   * until a mission falls near him.
   */
  beaten?: {
    x: number; y: number; tick: number; n: number; left: boolean;
    /** Where he was when he left it (ox, oy: outdoors) and where he went (gx, gy): he goes back once it lifts. */
    ox?: number; oy?: number; gx?: number; gy?: number;
  };
  /**
   * Danger to the house he is in (M7.5e step "leave"): enemy bursts in or on building `building` (its id), counted
   * (a heavy round counts more) while no more than `soldier.houseTrapSeconds` pass between one and the next, and the
   * last one's tick. Absent until one bursts on a house he is in.
   */
  houseDanger?: { building: number; n: number; tick: number };
  /**
   * The posture of his fire position (soldier AI package C): where his last move, occupy or posture order left him
   * (kneeling or standing at a window, lying in the open). When the shooting near him has died down he takes it
   * again. Absent: none yet.
   */
  homePosture?: Posture;
  /**
   * Where the last rounds that cracked past him came from (soldier AI package B): a horizontal unit vector from him
   * back along their flight, and the tick. Absent until a round has passed close to him.
   */
  fireFrom?: { dx: number; dy: number; tick: number };
  /** Sight realism step 4: the last tick he saw an enemy man or vehicle with his own eyes (not a drone); absent: never. */
  sawEnemyTick?: number;
  /** M11.6: the battery in each powered device he carries (one slot per device type, ascending device id); absent:
   *  he carries none (or a save from before M11.6). See power.ts. */
  power?: PowerSlot[];
  /** Sight realism step 4: the tick of his last look for an enemy he lost (a peek); absent: none in this spell. */
  peekTick?: number;
  /** Sight realism step 4: he stands to look until this tick, then takes the posture he looked from again. */
  peekUntilTick?: number;
  /** Sight realism step 4 (review fix): the posture he stood up from to look (restored when the look ends, or taken
   *  as his fire posture if he opens fire meanwhile); absent: not standing to look. */
  peekFrom?: Posture;
  /** Sight realism step 4: where his looks in this blind spell started (side-steps are measured from here, so he does
   *  not drift); cleared when he sees the enemy again or his unit gets an order. */
  peekHome?: { x: number; y: number };
  /** Sight realism step 4: the tick he last moved to another window to see an enemy he lost; absent: never. */
  windowSwitchTick?: number;
  /** Last tick he threw a hand grenade on his own (soldier AI package D); absent: never. */
  grenadeTick?: number;
  /** M9.3b: the tick he last launched a guided missile from a tripod (the launch shows him); absent: never. */
  launchTick?: number;
  /** Sight realism step 3: the last tick he moved faster than spotting.stillBelowMps (movement system); absent: never. */
  movedTick?: number;
  /**
   * Sight realism step 3: how conspicuous he is while still (a lognormal factor of mean 1 on his size, the same for
   * every observer: how well his outline, colours and shadow blend in where he lies), drawn from the "conspicuity"
   * stream at (conspX, conspY) once for each posture he takes there (`conspBy`; review fix: kneeling to look and lying
   * down again on the same spot keeps both values, it does not draw anew); all drawn anew when he is more than
   * spotting.conceal.conspicuityResetM from there. `consp` / `conspPosture`: the value in use and its posture.
   * Absent until he first holds still.
   */
  consp?: number;
  conspX?: number;
  conspY?: number;
  conspPosture?: Posture;
  conspBy?: { prone?: number; crouching?: number; standing?: number };
  /**
   * Hiding from an enemy drone (M9.6, behaviour.soldier.droneHide). "freeze": stopped on his way since `since`, held
   * until `until`; "spent": he froze as long as he may and moves on regardless until `until`; "hide": lying down (under a
   * canopy, indoors, or going there) until `until`. `searched`: the tick he last looked for a canopy. `cool`: no new
   * freeze before this tick (carried over from a "spent" run into a "hide"). `ox`/`oy`: where he left from for a
   * canopy, `gx`/`gy`: the canopy, `home`: his fire position's posture then (he goes back once it is over). Absent:
   * not hiding.
   */
  droneHide?: {
    kind: "freeze" | "spent" | "hide"; since: number; until: number; searched?: number; cool?: number;
    ox?: number; oy?: number; gx?: number; gy?: number; home?: Posture;
  };
  /**
   * His triage tag (M10.3b), set by the man who treats him: category 1 immediate (T1), 2 delayed (T2), 3 minimal
   * (T3); who tagged him, when, with what training. It may be wrong (core/medical.json `triage`). Absent: not triaged.
   */
  triage?: Triage;
  /** "Medic!" has been called for him (M10.3b; the tick). Absent: not yet. */
  medicCalledTick?: number;
  /**
   * Dragged into cover here (M10.3b): while he lies within a metre of this spot, care for him is judged under fire on
   * the helper's own suppression only (the unit being fired on no longer counts). Absent: not dragged.
   */
  sheltered?: { x: number; y: number };
  /**
   * His side has checked him since he went down (owner request 2026-11-15): `dead` what was found. A dead man without
   * it (or checked alive before he died) is "down, state unknown" to his comrades: they come to him and drag him to
   * cover as to any casualty. Absent: not checked.
   */
  checked?: { tick: number; by: EntityId; dead: boolean };
  /** Crawling to cover here (owner request 2026-11-15: a casualty who cannot walk, a surrendered man under fire). */
  crawlCover?: { x: number; y: number; tick: number };
  /**
   * Why no carer is coming to him (M10.3b, for the debug overlay): nobody in reach, men in reach but none willing
   * (`too-exposed`: he lies under fire), or the one willing has no kit or training for what he needs. Absent: a carer is
   * on his way or beside him, or he needs nothing.
   */
  careWait?: "nobody" | "unwilling" | "too-exposed" | "no-kit";
  /**
   * The payload of the carrying party he belongs to (M10.4a; the `carry` store is keyed by it): a carrier, or a
   * walking wounded man in his own party. While set he leaves the fight (fires only in self-defence), and his unit's
   * orders and drills pass him by. Absent: not carrying.
   */
  carrying?: EntityId;
  /**
   * Escorting or guarding prisoners (M11.9, systems/prisoners.ts): the collection point `point` he works for; `phase`
   * "search" (searching his prisoners where they were taken), "escort" (walking them back, 3-5 m behind them),
   * "guard" (at the point until relieved; then the field is cleared and he walks back to his squad leader). `men`: the prisoners he searches and walks (one group). `took`: what he took from them in the search
   * (whatever is beyond `search.maxKg` goes into the point's cache when he gets there). While set he is out of the fight: he fires only in self-defence within `guard.selfDefenceM`, and orders to his unit
   * pass him by. Absent: no such duty.
   */
  guard?: { point: EntityId; phase: "search" | "escort" | "guard"; men: EntityId[]; took?: { type: DefId; count: number; charge?: number }[]; tick: number };
  /**
   * He lies (or sits) at this rear point (M10.5, the Verwundetennest; the `rear` store's key): brought there by bearers
   * or walked there himself. His unit's orders and drills pass him by. Cleared when he is more than twice the nest's
   * `arriveM` from it (the nest moved, an order to him alone). Absent: not at a nest.
   */
  atNest?: EntityId;
  /**
   * Laws of war (M10.7b, systems/conduct.ts). `protLostTick`: his last shot that was not self-defence (a man with an
   * emblem firing beyond `protection.selfDefenceM`; any shot of anyone else): it costs his protection for
   * `medicFiredLosesProtectionS`. `breachOn`: a deliberate breach — he fires at this enemy he knows to be protected
   * or giving up until `untilTick`. `conductTick`: when he last decided on one (at most every `breachCheckS`).
   * All absent: never.
   */
  protLostTick?: number;
  breachOn?: { target: EntityId; untilTick: number };
  conductTick?: number;
  /** The player ordered him taken to the Verwundetennest (M10.5 `evacuate`): first in the bearers' queue, and he goes
   *  even if he could still fight. Cleared when he arrives. */
  evacOrdered?: true;
  /** A trip to the Verwundetennest ended short (no way, bearers lost or gave up, M10.5): not tried again before this
   *  tick. Absent: no wait. */
  evacRetryTick?: number;
  /**
   * Evacuated (M10.6a): he left the battle in an ambulance that drove off the map at `tick`, and lies in `vehicle`
   * (off the map) from then on: his wounds no longer run their course here, he counts as out, and his roster status
   * is "evacuated" (the aid station's outcome is M10.6b). Absent: not evacuated.
   */
  evacuated?: { tick: number; vehicle?: EntityId; via?: "ambulance" | "vehicle" | "end" | "exit" };
  /** M11.9c review fix: the side he got away from as a prisoner in this battle (escaped, freed by his own men, or back
   *  with his side at the end; `SideResult.prisonersEscaped`). Absent: never. */
  freedFrom?: SideId;
  /**
   * What his roster record brought into this battle when it had been settled after an earlier one (review fix, rule
   * 11): how many of his wounds were already there (not handed over again) and the recovery days he still had.
   */
  rosterIn?: { wounds: number; recoveryDays: number };
  /** M12.0a (`rules.campaignOut` only): his tally in this battle so far (`serviceSystem`; `BattleResult.service`). */
  service?: { underFireS: number; contactS: number; roundsFired: number; peakShock: number; peakStrain: number };
  /**
   * What happens to him after the battle (M10.6b, settled when he is handed over to Role 1 — evacuated — or at the
   * battle's end): when he reaches Role 1 (`role1Tick`, battle ticks; or the captor's aid post, `by` "captor"), the days
   * until he is fit again (`recoveryDays`), and, if he dies of his wounds, when (`diedOfWoundsTick`, battle ticks, may
   * lie after the battle). `limbLost`: a limb lost to a tourniquet. Absent: not settled (fit men, the dead).
   */
  aftercare?: Aftercare;
}

/** The outcome beyond the battle of a wounded man (M10.6b; core/medical.json `role1`). */
export interface Aftercare {
  role1Tick: number;
  by: "own" | "captor";
  recoveryDays: number;
  diedOfWoundsTick?: number;
  limbLost?: true;
}

/**
 * A rear point (M10.5, SPEC 9.1/9.2; the `rear` store, keyed by its own entity id): a place behind a unit where
 * something is collected. `kind` medical: the Verwundetennest, where bearers bring the unit's casualties and its
 * medic sees to them (supply points in M11 reuse it). `unit`: the top unit it serves. `placed`: put there by the
 * player's `casualtyPoint` order (it stays; an automatic one moves when threatened or left behind).
 */
export interface RearPoint {
  /** M11.9: "prisoners", the platoon's prisoner collection point (systems/prisoners.ts). */
  kind: "medical" | "supply" | "prisoners";
  side: SideId;
  unit: EntityId;
  /** kind "supply" (M11.3): the cache (an entity of the `cache` store) that is the platoon's supply point. kind
   *  "prisoners" (M11.9): the captured cache at the point where searchers leave what they cannot carry (absent: none
   *  yet). */
  cache?: EntityId;
  x: number;
  y: number;
  placed?: true;
  /** kind "prisoners" (M11.9b): the military police hull at the point that has taken over the guard. */
  mp?: EntityId;
  /** kind "prisoners" (M11.9c): where and when rounds last landed within `pcp.fireM` of it; since when its prisoners
   *  have been exposed (a known enemy within `pcp.enemyM`, or suppressed) without being moved, and whether that
   *  exposure has been recorded (`law.exposure`). */
  fire?: { tick: number; x: number; y: number };
  /** kind "prisoners" (review fix): where rounds landed when it was last moved away (kept `pcp.fireMemoryS`, at most
   *  four), avoided by its next moves as well, so that it does not go back to a spot it just left. */
  fireSpots?: { tick: number; x: number; y: number }[];
  exposedTick?: number;
  exposureNoted?: true;
  /** When it was sited (or last moved) and last checked. */
  sitedTick: number;
  checkTick: number;
}

/**
 * A cache (M11.3, plan slice 45; the `cache` store, keyed by its own entity, which also has a transform and a
 * container): ammunition and other supplies on the ground. `kind` "point": a platoon's supply point (a `rear` point of
 * kind "supply" names it; never at or within `supply.nestApartM` of its Verwundetennest); "cache": any other pile
 * (crates left at a delivery, a casualty's ammunition left outside the nest). `side`: whose it is now (a captured
 * cache becomes the captor's: `capturedBy`, and `from` the side it was taken from). `hp`: what is left of it (1 whole;
 * a burst nearby takes some; at 0 it is set off). `cookoff`: burning since `startTick` until `endTick`, its contents
 * lost step by step (`nextTick`), with bursts when it holds explosive rounds (`bursts`). `burnt`: burnt out.
 * `known`: the other sides whose men have seen it (its own side always knows it). `holdTick`: since when an enemy has
 * stood at it with none of its side near (capture after `supply.capture.seconds`). `placed`: put there by an order (or
 * the scenario); an automatic point moves when threatened or left behind while empty.
 */
export interface Cache {
  side: SideId;
  kind: "point" | "cache";
  /** The top unit (platoon) it serves, for a supply point. */
  top?: EntityId;
  placed?: true;
  hp: number;
  cookoff?: { startTick: number; endTick: number; nextTick: number; bursts: boolean };
  burnt?: true;
  capturedBy?: SideId;
  from?: SideId;
  known?: SideId[];
  holdTick?: number;
  /** M11.4a: a crate on its way to a squad in bearers' hands (a carry party's payload): nobody takes from it on the
   *  way. Absent: lying on the ground. */
  carried?: true;
  /** When it was sited (or last moved) and last checked (automatic points). */
  sitedTick: number;
  checkTick: number;
  /** M11.4b: a supply point's standard fill (rounds): what it held when it became the point (or its first delivery);
   *  a delivery is called below `delivery.callBelow` of it. Absent: not known yet. */
  fill?: number;
  /** M11.5: rounds put beside on-map mortar tubes (the off-map top-up of the mortar section `tubes`). Absent: none. */
  tubes?: EntityId;
}

/**
 * The side's off-map stock (M11.4b, plan section 4): an entity with a container of what the rear can send forward
 * (`BattleInput` / scenario), parked off the map. The only source of anything delivered during a battle: items leave
 * it by `transferItems` (event `items.delivered`); the ledger counts it as outside the battle. `topUp`: rounds moved
 * into the side's off-map support sections every `everyS` (mortar and artillery allotments topped up, owner).
 */
export interface Stock {
  side: SideId;
  topUp?: { rounds: number; everyS: number };
  nextTopUpTick?: number;
}

/**
 * A carrying party (M10.4a, SPEC 9.1 "carrying as a movement mode"): `carriers` move the payload (the store's key: a
 * casualty now, supplies in M11) with a carry method of core/medical.json. carriers[0] leads and walks the route;
 * the others and the payload follow on his trail (newest point first). Empty `carriers`: a walking wounded man who
 * walks himself (he is his own leader). Phases: gather (carriers come to him), setup (a litter is unfolded), move,
 * rest (endurance used up), cover (under fire, to the nearest hidden spot), hold (lying there until it is quiet).
 */
export interface Carry {
  method: DefId;
  carriers: EntityId[];
  phase: "gather" | "setup" | "move" | "rest" | "cover" | "hold";
  phaseTick: number;
  startTick: number;
  /** Where he is taken (his floor's height z). */
  dest: { x: number; y: number; z: number };
  /** "cover": a drag to the nearest hidden spot under fire (M10.3b): no rests, no holds; "move": anywhere else. */
  purpose: "cover" | "move";
  /** The payload's mass (body and load, kg) and the speed it is carried at on level open ground (m/s). */
  massKg: number;
  speedMps: number;
  /** The leader's recent positions, newest first: x, y, z, x, y, z, ... */
  trail: number[];
  /** Metres carried since the last rest, and in all. */
  sinceRestM: number;
  totalM: number;
  /** Last tick the party was under fire (hold: it goes on after `carrying.resumeQuietS` without). */
  fireTick?: number;
  /** Given up at this tick if not there yet (a drag to cover). Absent: no limit. */
  untilTick?: number;
  /** The litter (stretcher) used: its item type and the carrier holding it (the item stays in his container). */
  litter?: { type: DefId; from: EntityId };
  /** Taken to this rear point (M10.5, the Verwundetennest): on arrival he is at it; the bearers go back. */
  point?: EntityId;
  /** M11.4a: the payload is supplies (a crate, a cache entity) taken to a squad by bearers: no medical bookkeeping;
   *  carriers lost end the party (the bearers' errand picks it up again). Absent: a casualty. */
  cargo?: true;
}

/** A triage tag (M10.3b). */
export interface Triage { cat: 1 | 2 | 3; by: EntityId; tick: number; skill: "buddy" | "firstResponder" | "medic" }

export type CommLink = "voice" | "radio" | "none";

/** Communication state of a unit (SPEC 6.5, 9.5). Updated by the CommsModel. */
export interface CommState {
  link: CommLink;
  /** Extra delay on top of the model's base delay, seconds (EW, leader condition ... later). */
  extraDelaySeconds: number;
}

/**
 * A contact: what one soldier believes about one enemy (SPEC 6.5). The position is an estimate with an
 * uncertainty; `tick` is when that information was true. `target` identifies the enemy inside the simulation
 * (for merging reports and for fire orders); the player's view shows only kind, position, uncertainty, age.
 */
/**
 * A soldier's own decision (M4.2): firing at an enemy, going to cover, bringing or waiting for ammunition.
 * takePrisoner (M6.6, set and carried out by systems/surrender.ts): he walks over to the surrendered enemy
 * `target` and takes him prisoner; (x, y) is where he stood, to which he then returns.
 * care (M10.3a, set and carried out by systems/medical.ts): he has left the fight to go to the wounded comrade
 * `target` and treat him; (x, y, z) is where he stood, to which he returns when done. `responder`: he went as the
 * first responder or medic (else as a comrade).
 */
export interface Intent {
  kind: "engage" | "cover" | "bringAmmo" | "takePrisoner" | "fetchAmmo" | "reposition" | "care" | "hideDrone" | "takeAmmo" | "takeKit" | "resupply" | "bear";
  tick: number;
  /** takeAmmo (M11.2, systems/consolidate.ts): he goes to the own casualty `target` (treated, or dead) to take his
   *  ammunition; takeKit: to the enemy casualty, prisoner or pile `target` the player named (order `takeKit`);
   *  resupply (M11.3, order `resupplyAt`): to the own cache `target` to take up to his standard load. */
  target?: EntityId;
  /** bringAmmo: the item to hand over when it is not the receiver's magazine (an anti-tank round, M7.4a). */
  item?: DefId;
  /** bringAmmo (M11.2): a hand-over of the squad's consolidation (the receiver may still have some). */
  consolidate?: true;
  /** bringAmmo (consolidation), takeAmmo, takeKit (M11.2): the hand-over or taking has begun; once it is done he walks
   *  back to (x, y, z), where he stood when he set out, faces `heading` (rad) and takes `posture` again. */
  back?: true;
  /** ... and he is on his way back now (the errand ends when he is there). */
  returning?: true;
  heading?: number;
  posture?: Posture;
  x?: number;
  y?: number;
  /** takePrisoner, care: his height above the ground at (x, y) (his floor; absent = the ground, M7.5 review fix). */
  z?: number;
  /** care: he went as the first responder or medic (M10.3a). */
  responder?: true;
  /** bear (M11.4a, systems/supply.ts): an ammunition bearer: to the supply point `target`, then with a crate (`load`,
   *  a cache entity) to squad `squad`; his fellow bearer `mate` (absent: alone); `lead`: he loads and leads the carry. */
  squad?: EntityId;
  load?: EntityId;
  mate?: EntityId;
  lead?: true;
  /** bear: since when he has waited at the point for his mate. */
  waitTick?: number;
}

export interface Contact {
  target: EntityId;
  x: number;
  y: number;
  /** Uncertainty of the position (radius, m) at `tick`; it grows with age when used. */
  errM: number;
  /** seen: he saw him; heard: shots from that direction; reported: told by a comrade. */
  kind: "seen" | "heard" | "reported";
  tick: number;
  /** When he last passed this contact on (reports are not passed on again: no gossip chains). */
  reportedTick: number;
  /** He knows this enemy has given up: he saw it, or a comrade told him. Absent until set; never cleared while the contact
   *  lasts, except for a prisoner escaping (M11.9c: after `escape.graceSeconds`, never by a guard) or one back free. */
  surrendered?: true;
  /**
   * He knows this enemy is down (soldier AI package A): he saw him lying hit or saw him fall, or a comrade told him.
   * Like `surrendered`, never cleared; nobody fires at, takes cover from or plans against a man known to be down.
   */
  down?: true;
  /** Vehicles (M7, filled from M7.3): what he believes the contact is and how it moves. */
  cls?: "vehicle";
  vtype?: DefId;
  heading?: number;
  vx?: number;
  vy?: number;
  wreck?: true;
  /**
   * A man on foot above the ground (M7.5 review fix): his height above the ground (his floor) when he was seen
   * there. Absent = on the ground, or not known (a sound gives no height). What men aim and take cover by.
   */
  z?: number;
  /**
   * A man on foot: the posture he was in when last seen (soldier AI package A, 2026-11-13). A sound keeps the last
   * seen one; absent = never seen (aim at the usual height). What men aim by: the middle of what they see.
   */
  posture?: Posture;
  /**
   * Recognised as protected (M10.7a, owner answer 6), by his own eyes only (never from a report): a man wearing a
   * protective emblem or a marked ambulance (`marked`), a man of a carrying party (`carrying`), a man at a marked
   * Verwundetennest (`atPoint`). Set or cleared on a sighting within the recognition range; kept beyond it. Nobody
   * fires at, shells or takes cover from a contact with any of them (`protection.ts` `spared`).
   */
  marked?: true;
  carrying?: true;
  atPoint?: true;
}

/** A contact report on its way from one soldier to another. */
export interface ContactReport {
  deliverTick: number;
  from: EntityId;
  to: EntityId;
  contact: Omit<Contact, "reportedTick">;
}

/** Why a unit left a house (M7.5e): grenades or HE on it, the enemy inside, cut off from behind. */
export type HouseLeaveReason = "trap" | "enemy" | "flank";

export interface Unit {
  callsign: string;
  side: SideId;
  faction: DefId;
  /** "platoon" | "squad" | "team" | "section" ... (data). */
  echelon: DefId;
  parent: EntityId | null;
  children: EntityId[];
  /** Soldiers directly in this unit (not in child units). */
  members: EntityId[];
  leader: EntityId | null;
  comms: CommState;
  /** True while executing a move order (cleared on arrival). */
  moving: boolean;
  /** True while members are carrying out a fire order. */
  firing: boolean;
  /** "No line of fire" has been reported for the current fire order (reset by the next fire order). */
  lineBlockedReported: boolean;
  /** Tick of this unit's last contact call-out on the radio (call-outs are spaced out). */
  lastCallTick: number;
  /** Standing fire rule (M4.2): when its men open fire on their own. */
  fireRule: FireRule;
  /** Standing rules (M5): no fire on their own beyond this range (0 = the weapon's range), what to do on contact
   * while moving, and ammunition discipline. */
  maxEngageM: number;
  onContact: ContactRule;
  ammoRule: AmmoRule;
  /** Last tick a man of this unit (or its sub-units) came under fire, and of its last cease-fire order. */
  underFireTick: number;
  ceaseFireTick: number;
  /** When the unit's current spell under fire began (fire after a quiet spell), and its last move order (M4.3). */
  contactTick: number;
  moveTick: number;
  /** The same two for this unit's own men only (not its sub-units): a man of THIS unit under fire, and the start
   *  of its own spell under fire. React to contact goes by these, so only the squad fired on goes to ground.
   *  Optional (absent = never). */
  ownFireTick?: number;
  ownContactTick?: number;
  /** M11.2 (consolidate.ts): since when all of this unit's men on foot have stood still (no route; men on a
   *  consolidation errand aside). Absent: moving, or not looked at yet. */
  haltedTick?: number;
  /** Sight realism step 2 (2026-11-15): the last tick a man of this unit (or, on a top unit, of any unit under it)
   *  saw an enemy, not spared, within `drills.reactSeenM` (night: `reactSeenNightM`); and on the man's own unit the
   *  start of that spell of sightings (anew after `decisions.contactLostSeconds` without one): react to contact on
   *  sight goes by it, as by `ownContactTick`. Optional (absent = never). */
  seenContactTick?: number;
  seenSpellTick?: number;
  /** Tick of the last order delivered to this unit or one of its men (M6.6: no prisoner errands right after). */
  orderTick: number;
  /** A drill in progress (M4.3), and whether the unit has broken and is running back. */
  drill: Drill | null;
  /** Broken (any echelon, morale rework): its men run back (the rout drill) until it rallies. */
  broken: boolean;
  /** Its quality level (core/qualities.json; absent: `morale.defaultQuality`) and its morale (morale rework). */
  quality?: DefId;
  morale: UnitMorale;
  /** A vehicle crew unit (M7): the vehicle it crews. */
  vehicle?: EntityId;
  /** A crew that bailed out (M7.4b): the vehicle it left. It is a unit on foot from then on (`vehicle` cleared). */
  exVehicle?: EntityId;
  /** A foot unit's own carrier (M7.2). */
  carrier?: EntityId;
  /** The crew of an off-map asset (M10.6a: an ambulance called from the rear): no commander, AI or player orders it;
   *  it counts in no side's strength. Absent: an ordinary unit. */
  asset?: OffMapKind;
  /** Getting in or out of a vehicle (M7.2); not a drill. */
  boarding?: Boarding;
  /**
   * The house this unit last left on its own (M7.5e step "leave"): the building's id, when, and why. Its own rules
   * keep it out of that house for `soldier.houseReenterSeconds`. Absent: none.
   */
  leftHouse?: { building: number; tick: number; reason: HouseLeaveReason };
  /** The house this unit last tried and failed to send anyone out of (M7.5e review): it looks again after
   *  `soldier.houseLeaveRetryS`. Absent: none. */
  leaveTry?: { building: number; tick: number };
  /** Tick of the unit's last hand smoke screen (D1, systems/smoke.ts). Absent: none yet. */
  smokeTick?: number;
  /** Tick of the unit's last medical radio call of each kind, by string key ("radio.medic", "radio.treating"; M10.3b).
   *  Absent: none yet. */
  medRadio?: Record<string, number>;
  /** M8.3a: a mortar team (its men carry a tube): packed, setting up (ready at `readyTick`) or ready; `stillTick`:
   *  when it last moved (it sets up on its own after standing still a moment). Absent: not a mortar team. */
  mortar?: { state: "packed" | "setting" | "ready"; readyTick: number; stillTick: number };
  /**
   * M9.3b: a dismounted missile team (its gunner carries a `crewServed` launch post): packed, setting up or ready
   * like a mortar; `heading`: the bearing its tripod is laid on (it traverses `traverseDeg` either side of it, beyond
   * that it re-lays: ready again at `relayTick`); its last launch and how many it has fired; the missile it is
   * guiding now (with the sight's place, where the tripod stood at the launch: `ox, oy, oz`); a shot ordered while
   * packed, fired once set up (`queued`). Absent: not a missile team.
   */
  missileTeam?: {
    state: "packed" | "setting" | "ready"; readyTick: number; stillTick: number;
    heading: number; lastLaunchTick: number; shots: number;
    relayTick?: number;
    /** (M7.6d, agl: `bursts`: bursts of the ordered series still to fire.) */
    queued?: { x: number; y: number; target: EntityId; bursts?: number };
    guide: TeamGuide | null;
    /** M7.6d: an automatic grenade launcher team (systems/agl-team.ts; `guide` stays null, `lastLaunchTick` and
     *  `shots` count its bursts). Absent kind: a missile team. */
    kind?: "agl";
    /** M7.6d (agl): the box on the gun (absent: none put on yet; the first goes on while it sets up): its item, the
     *  rounds left in it and the man it counts on (the post's carrier: his mass, his roster load; rule 9, like
     *  `WeaponState.magazine`). It follows the post when the post passes to another man. */
    box?: { item: DefId; rounds: number; holder: EntityId };
    /** M7.6d (agl): the burst it fires now: rounds left in it, the tick of the next round, the round's index in the
     *  burst, the aim (target: an enemy man's id or -1, the ground point x, y), the range error of this series (a
     *  fraction). */
    burst?: { left: number; nextTick: number; index: number; target: EntityId; x: number; y: number; rangeError: number };
    /** M7.6d (agl): where its last burst was aimed and that series' range error (the crew watches the fall: a burst at the
     *  same place soon after halves the error). */
    lastAim?: { x: number; y: number; rangeError: number };
  };
  /** Standing rule for anti-tank weapons (M7.4a); absent = the default from the data. */
  atRule?: "vehicles" | "vehiclesAndPositions" | "hold";
  /** An ambush laid (D4b, `ambush` order) on this unit and every unit under `root` (the unit the order went to):
   *  fire held until an enemy is within `rangeM` of one of their men, one of them fires, or they are fired on after
   *  `tick` (systems/ambush.ts). Absent: none (or sprung). */
  ambush?: { rangeM: number; tick: number; root: EntityId };
  /** An arc to defend (D4b, `defendArc` order): its men face `facing` (rad) and fire on their own only at enemies
   *  within `halfRad` of it. Absent: none. */
  arc?: { facing: number; halfRad: number };
  /** M11.4a (systems/supply.ts): the squad's last request for ammunition (`tick`); `pending`: the player's standing
   *  rule is "ask" and nobody has been sent yet (the card's "Send bearers"); `bearers`: the men on their way to it.
   *  Absent: it never asked. */
  supplyAsk?: { tick: number; pending?: true; bearers?: EntityId[] };
  /** M11.4a standing rule: a squad's request sends bearers at once ("auto") or waits for the player ("ask"). Absent:
   *  "auto". */
  supplyRule?: "auto" | "ask";
  /** M11.9c standing rule: the unit's prisoners get escorts on their own ("auto") or only on the player's
   *  `escortPrisoners` ("ask"). Absent: "auto" (its top unit's rule when it has none). */
  prisonerRule?: "auto" | "ask";
}

/**
 * A unit drill (M4.3). assault / withdraw: two groups take turns, one bounding toward (x, y) while the other
 * covers; `mover` is the group bounding now, since `phaseTick`; `final`: the last rush (or the last leg back).
 * rout: the unit has broken and runs to (x, y), where it rallies.
 */
export interface Drill {
  kind: "assault" | "withdraw" | "rout" | "clear";
  x: number;
  y: number;
  groups: EntityId[][];
  mover: number;
  phaseTick: number;
  final: boolean;
  /** A bound with a single runner still on his way (the others down): since this tick (overnight pick
   *  "assault-tempo"); absent otherwise. */
  trailTick?: number;
  /** The runners of this bound wait for their covering men to open fire (overnight pick "covering-fire"): since
   *  `phaseTick`; absent once they go. */
  waitFire?: true;
  /** Covering men who moved aside this bound for a line of fire (overnight pick "covering-fire"). */
  stepped?: EntityId[];
  /** clear (M7.5e): the building's id; (x, y) is the point outside its entry door where the unit stacks up. */
  building?: number;
  /** clear: the stage after the bounds (absent while bounding): stacking beside the door, a man getting to his place
   *  and throwing, waiting for the burst, men going into the room. */
  stage?: ClearStage;
  /** clear: since this tick in the stage; since this tick past the bounds (for its time limit). */
  stageTick?: number; startTick?: number;
  /** clear: the entry door (index into the building's interior graph nodes). */
  entry?: number;
  /** clear: the rooms in the order they are cleared (room indices) and how many are done. */
  rooms?: number[]; room?: number;
  /** clear: the man throwing into the next room, his place (x, y, height), the grenade, how many he had, and the
   *  throw places tried for this room. */
  thrower?: EntityId; throwAt?: [number, number, number]; ammo?: string; had?: number; tried?: number;
  /** clear: the point in the room the grenade is aimed at; where the thrower steps aside to after the throw (thrown
   *  from in line with the opening). */
  aimAt?: [number, number]; aside?: [number, number, number];
  /** clear: the tick the grenade bursts (and the men go in after `clearAfterBurstS`). */
  burstTick?: number;
  /** clear: the men going into the room now. */
  entryMen?: EntityId[];
}

/** The stages of a house clearing after its bounds (M7.5e). */
export type ClearStage = "stack" | "throw" | "wait" | "enter";

/** An action with duration that can be interrupted (SPEC 9.1 foundation requirement). */
export interface Action {
  kind: string;
  startTick: number;
  durationTicks: number;
  params: Record<string, string | number>;
}

/**
 * Terrain damage (SPEC 6.1 "destructible in a simple way", 9.3 "persistent map damage stored as data").
 * Lives in SimState so it saves, replays and can be carried into the campaign. Systems that create damage
 * arrive with ballistics (M2); movement, spotting and cover will read it.
 */
export interface TerrainState {
  /**
   * Holes blown in walls: in obstacle/building `id`, segment `part`, centred `offsetM` from its start. sillM/headM
   * (M7.5 review fix): the hole's bottom and top above the ground — one storey of the outer wall of a building with
   * floors; absent = the whole height of the wall.
   */
  breaches: { owner: "obstacle" | "building"; id: number; part: number; offsetM: number; widthM: number; sillM?: number; headM?: number; tick: number }[];
  craters: { x: number; y: number; radiusM: number; depthM: number; tick: number }[];
  /** Vegetation thinned by fire: [cell index, fraction removed 0..1], sorted by cell. */
  vegetationLoss: [number, number][];
  /** M11 hold battle: dug fighting positions (`positions.ts`), in the order they were dug; anyone in one is in it. */
  positions?: { x: number; y: number; side: string; tick: number; /** Balance pass 2: dug only this deep (absent: `fightingPosition.depthM`). */ depthM?: number }[];
}

/** A soldier's personal weapon. The loaded magazine is here, not in his container, while it is in the weapon. */
export interface WeaponState {
  weapon: DefId;
  magazine: { item: DefId; rounds: number } | null;
  nextShotTick: number;
  /** Rounds still to fire in the current burst, and rounds already fired in it (recoil builds up). */
  burstLeft: number;
  burstIndex: number;
  jammed: boolean;
  lastShotTick: number;
  /** He has already reported that he is down to his last magazine (reset when he loads a fresh one). */
  lowAmmoReported: boolean;
  /** He has sent that report by radio (one report per unit). */
  lowAmmoRadioed: boolean;
}

/** A soldier's task to fire at a point (from a fire order). */
export interface FireTask {
  x: number;
  y: number;
  /** Aim height above the ground at the target point, m. */
  heightM: number;
  /** Tick of the last reason to fire at the full rate (the order, incoming fire near the unit). */
  reasonTick: number;
  /** His error in judging the range to this target, as a fraction (constant for the task). */
  rangeError: number;
  /** Tick at which he began to aim at this point (his aim settles over the first seconds). */
  startTick: number;
  /** When his line of fire was last checked, and whether it was clear from where he is. */
  lineCheckTick: number;
  lineClear: boolean;
  /** Fire at this enemy as each man knows him (his contact), not at a fixed point. */
  contact?: EntityId;
  /** He opened fire on his own (M4.2), not on an order: he stops when he loses sight of the enemy. */
  self?: boolean;
  /** The posture that check was worked out for, and the lowest posture he may go back down to. */
  linePosture: Posture;
  basePosture: Posture;
  /** Aim height worked out from his contact (package A): it follows the posture he sees the man in. */
  aimAuto?: true;
  /**
   * Covering fire (overnight pick "covering-fire"): a drill's or an order's task, never one he took on his own; his
   * line may end in cover up to `drills.suppressShortM` short of the point (he fires into it). A drill's covering
   * fire at a point (no enemy named) is fired at the sustained rate too.
   */
  suppress?: "order" | "drill" | "known" | "return";
  /** His line reaches only the cover near the point (`suppress`): he fires into it at the sustained rate. */
  intoCover?: true;
  /** Assault fire (package D): he fires while moving (with a heavy aiming penalty), from the posture he moves in. */
  onTheMove?: true;
  /**
   * Fire discipline (2026-11-14): he went down to `basePosture` between shots; `up` is the posture he fires from,
   * which he takes again `riseTicks` before his next shot (`friend`: he went down because a comrade was in his
   * line, and stays down while that comrade is still there). `duckTick`: when he last went down or up for this.
   */
  duck?: { up: Posture; riseTicks: number; friend?: true };
  duckTick?: number;
  /** Laws of war (M10.7b, systems/conduct.ts): the next tick at which fire at `contact` is checked for a breach
   *  (every two seconds while he fires), and whether a breach was already recorded for this task (once per task). */
  lawTick?: number;
  breached?: true;
}

// ---------------------------------------------------------------- vehicles (M7, schema 16)

export type VehicleStatus = "ok" | "immobilised" | "disarmed" | "abandoned" | "destroyed";
export type { StationKind };

/** Drive state of a vehicle: everything history-dependent the drive model needs (rule 1). */
export interface DriveState {
  /** Tracked: ground speed of each track (signed m/s, + forward). Body speed and yaw rate follow from them. */
  trackL: number; trackR: number;
  /** Signed speed along the heading, m/s (= (L + R) / 2 for tracked vehicles; integrated for wheeled). */
  speed: number;
  /** rad/s, + = clockwise on screen (heading 0 = east, PI/2 = south). */
  yawRate: number;
  /** >= 1 forward, <= -1 reverse, 0 neutral. */
  gear: number;
  shiftUntilTick: number;
  /** Wheeled: wheel angle, rad (0 for tracked). */
  steer: number;
  /** Last commanded, 0..1 (labs, debug). */
  throttle: number; brake: number;
  route: Waypoint[]; routeIdx: number;
  endHeading: number | null;
  arrived: boolean;
  holdForDismount: boolean;
  /** Consecutive ticks the hull was blocked; re-plans since the order. */
  stuckTicks: number; replans: number;
  /** Getting clear after striking something (M7.1c): a small move held until `untilTick`. Absent normally. */
  escape?: { speed: number; yawRate: number; untilTick: number };
  progressX: number; progressY: number; progressTick: number;
  yieldTo: EntityId | null; yieldSinceTick: number;
  crossing: { obstacle: number; part: number; untilTick: number; capMps: number } | null;
  /** M11.7b: a recovery vehicle towing a hull drives no faster than this (m/s). Absent: no cap. */
  towCapMps?: number;
  /** Sub-litre remainder of fuel burnt but not yet taken from the tank item (the litres are its charge). */
  fuelAccL: number;
  /** Last pose hidden from known threats (reverse-out target, M7.4b). */
  backX: number; backY: number;
}

export interface VehicleWeaponState {
  weapon: DefId;
  /** Ready belts/racks; index = the def's feed index. */
  feeds: { item: DefId; rounds: number }[];
  feed: number;
  switchUntilTick: number;
  nextShotTick: number; burstLeft: number; burstIndex: number;
  /** Single-round feeds: a round is in the chamber. */
  loadedRound: boolean;
  jammed: boolean; lastShotTick: number;
  lowAmmoReported: boolean[];
  /** Guided missile launchers (owner 2026-11-13): the next missile is on the launcher at this tick (absent: no
   *  reload running). */
  reloadDoneTick?: number;
}

/**
 * A wire-guided missile in flight from a station (owner 2026-11-13). The projectile is the row of the pool whose
 * owner is `gunner`, ammunition `ammo` and birth tick `launchTick` (one missile per station at a time).
 */
export interface MissileGuide {
  ammo: DefId; weapon: number; gunner: EntityId; launchTick: number;
  /** The enemy vehicle the gunner keeps in his sight. */
  target: EntityId;
  /** His tracking error now, rad (across the sight line, and up). */
  errH: number; errV: number;
  /** When the sight line was last checked (-1: not yet: the error is drawn then). */
  checkTick: number;
  /** His aim point now (world; the target's aim point, or the point ordered), without his error. */
  ax: number; ay: number; az: number;
  /** M9.3a: how it is guided ("command-wire" when absent; "command-beam"; "fire-and-forget-..."): fire-and-forget
   *  needs no gunner after the launch, its seeker keeps (ax, ay, az) at the last point it saw. */
  kind?: string;
  /** M9.3a: the target's crew noticed the launch; at this tick it fires its smoke toward the launcher. */
  warnTick?: number;
}

/** A missile guided from a team's tripod (M9.3b): as a station's, plus where the gunner's sight stands. */
export interface TeamGuide extends MissileGuide { ox: number; oy: number; oz: number }

export interface StationState {
  /** Relative to the hull, rad. */
  azimuth: number; elevation: number;
  azCmd: number; elCmd: number;
  laidTick: number;
  weapons: VehicleWeaponState[];
  task: FireTask | null;
  taskWeapon: number; taskFeed: number;
  scanAz: number;
  /** Last decision and its reasons (string keys), for the debug overlay. */
  why: { tick: number; keys: string[] };
  /** A guided missile this station's gunner is guiding (owner 2026-11-13; absent or null: none). */
  guide?: MissileGuide | null;
}

/** Getting in or out (M7.2). */
export interface Boarding {
  kind: "mount" | "dismount" | "bailOut";
  vehicle: EntityId;
  startTick: number;
  /** Men still to pass an exit, ascending id. */
  queue: EntityId[];
  /** Order to carry out after getting out. */
  then: OrderBody | null;
  /** -1 = not open yet. */
  rampOpenTick: number;
  /** Who `then` is for when not the unit itself (an order to one man aboard, Q12). */
  thenTarget?: EntityId;
  /** Mount: when the first man got in (-1 = none yet); boarding ends `completeAfterSeconds` later. */
  firstTick?: number;
  /** Mount: where the hull stood when the walk to it was planned (re-planned when it has moved). */
  hullX?: number; hullY?: number;
  /** Mount: wounded men to load (two comrades carry each in, owner Q25); M10.4b: those farther than
   *  `mounting.casualtyLoadM` from an exit are first carried to it by a carrying party. Dismount (M10.4b, an order
   *  with `wounded`): casualties aboard to carry out once the able men are out. */
  casualties?: EntityId[];
  /** Mount (M10.4b): casualties a carrying party was sent for (each is fetched once; given up if it ends short). */
  fetched?: EntityId[];
}

/**
 * A reconnaissance quadcopter in the air (M9.4a): an entity with a Transform (z: height above the ground), a
 * Container (its airframe and the battery in it, rule 9) and this. `unit`: the unit it belongs to (its operator's);
 * `operator`: the man flying it now (null: nobody, it hovers and, after a while, comes home on its own). `mode`:
 * climbing after the launch, flying to `goal`, hovering there, coming home to land. `home`: where it lands when no
 * operator is left. `seen`: what its cameras have in view (as a man's), `rep`: when each was last passed on.
 */
export interface DroneState {
  side: SideId; unit: EntityId; item: DefId; operator: EntityId | null;
  mode: "climb" | "fly" | "hover" | "home";
  goal: { x: number; y: number } | null; altGoal: number; homeX: number; homeY: number;
  /** Tick since when it has had no operator (absent: it has one). */
  aloneSince?: number;
  /** It has called "battery low" (coming home). */
  low?: true;
  /** Hit (M9.4b): it falls at this tick (when the round that hit it arrives). */
  hitTick?: number; hitBy?: EntityId;
  /** M14 hook: its control link (absent: as now, the operator always reaches it within its control range). */
  link?: "radio" | "fibre";
  seen: { target: EntityId; firstTick: number; lastTick: number; rep?: number }[];
}

/** A vehicle (entity with a Transform, a Container and this; no Identity, Mover or SoldierState). */
export interface VehicleState {
  def: DefId; vehicleId: string;
  side: SideId; faction: DefId;
  /** Its crew unit, or null (a parked or abandoned hull). */
  unit: EntityId | null;
  /** Occupant of each seat (index = def.seats). */
  seats: (EntityId | null)[];
  drive: DriveState;
  stations: StationState[];
  /** Condition 0..1 of each component (index = def.components; empty until M7.4b). */
  comp: number[];
  status: VehicleStatus;
  /** Burning (M7.4a): since when, the next cook-off check, how hard (2 = in the ammunition: harder to put out),
   *  and the next try of the extinguisher (M7.4b; -1 = none left). */
  fire: { startTick: number; nextCheckTick: number; intensity: number; nextExtTick: number } | null;
  smokeReadyTick: number;
  pendingSmokeTick: number;
  /** Last tick it moved (M9.2: a hull halted longer than thermal.hotSeconds has cooled). Absent: not since the start. */
  movedTick?: number;
  crewReaction: "continue" | "reverseOut" | "bailOut" | null; reactionTick: number;
  reactionWhy: string[];
  lastHitTick: number; lastPenTick: number; hitsThisTick: number;
  /** Last hit by a rocket or other shaped charge, through or not (M7.4b; since 2026-11-13 no reason by itself to
   *  reverse out: a rocket that bounces off does not drive the crew back). */
  lastShapedHitTick: number;
  /** Where it stood before reversing out for a reason other than damage (owner 2026-11-13): it drives back there
   *  when the hold ends; kept while it drives back; dropped on arrival, on any move or halt order, or on damage. */
  returnTo?: { x: number; y: number; heading: number };
  /** Its last move or halt order came from the player (Order.player, owner 2026-11-13): enemy men close or a
   *  panicked commander do not drive it back; only penetration and lost weapons do. */
  playerHold?: true;
  /** Bearing (world, rad) the last heavy or penetrating hit came from, null before any (M7.4b: away from it). */
  threatAz: number | null;
  seatSwap: { seat: number; actor: EntityId; untilTick: number } | null;
  /** Reserved ("open" = commander head-out, later). */
  hatches: "closed";
  /** Active protection (M7.4b, fixture): when it can engage again; charges are container items only. */
  aps: { nextReadyTick: number } | null;
  /** How the hull was recovered (M11.7b): towed off the map in the battle, or settled at its end (recovered by its own
   *  side, captured, lost). Null: nothing happened to it (intact, or fixed in the field). Roster output. */
  recovery: VehicleRecovery | null;
  /** M11.7b: the recovery vehicle called for this hull (from the call until the run ends; the hull is no wreck in
   *  the navigation grids meanwhile). Absent: none. */
  recoveryBy?: EntityId;
  /** M11.7b: hooked up and towed by this recovery vehicle (it skips its own drive; its pose follows the hitch). */
  towedBy?: EntityId;
  /** M11.7b: towed off the map (it and its crew aboard are off the map for good, `isOffMap`). */
  towAway?: true;
  /** M12.0b: left the map by its side's exit zone at this tick, with everyone aboard (`isOffMap` for good; saved). */
  exited?: number;
  /** M12.0a: a wreck of an earlier battle (`BattleInput.wrecksIn`, side `WRECK_SIDE`): the side it was and its status
   *  then, for `BattleResult.wrecks`. */
  wreckIn?: { side: SideId; status: VehicleStatus };
  /**
   * Field repair (M11.7a): the crew's task on component `comp` — man-seconds of work needed and done, who ordered it
   * (`ordered`: the player's `repair` order: no waiting for the quiet period), when it started and last had men at
   * it; `working` while men are at it, `stopWhy` the reason the last of them stopped. Kept while interrupted (the
   * progress stays); removed when done, failed or no longer needed. Absent: no repair.
   */
  repair?: RepairState;
  /** Components that failed a repair this battle (M11.7a): beyond the crew. Absent: none. */
  repairBeyond?: number[];
  /** Reserved: the side holding an abandoned hull (campaign). */
  capturedBy: SideId | null;
  /**
   * An off-map asset (M10.6a, SPEC "off-map entity state"): a vehicle that is in the battle from tick 0 but comes onto
   * the map only when called, and leaves it again. While off the map (`isOffMap`) every system skips it, and its men
   * aboard with it. Absent: an ordinary vehicle, on the map from the start.
   */
  offMap?: OffMapAsset;
  /**
   * A rear run (M10.6b, owner Q-9): this combat vehicle takes casualties back off the map and comes back. Absent: none.
   */
  rearRun?: RearRun;
  /** A rear run was cancelled (M10.6b): none starts on its own again before this tick. Absent: no wait. */
  rearRunRetryTick?: number;
  /** M11.4b: a marked ambulance with ammunition aboard (a player's order: a breach of the law of war, `law.misuse`):
   *  it has no protection while it carries it. Absent: none. */
  misuse?: true;
  /** M11.5: re-arming or refuelling at `source` (systems/rearm.ts). Absent: neither. */
  resupply?: VehicleResupply;
  /** M11.5: an order stopped its re-arming or refuelling: none starts on its own again before this tick. Absent: none. */
  resupplyHoldTick?: number;
}

/**
 * M11.5: a hull re-arming or refuelling (systems/rearm.ts). `go`: driving on its own to `source` (a cache or a supply
 * vehicle), from `from` (it drives back there when done); `work`: halted at it, `what` it is doing; the next piece of
 * work (`chunk`: one item into stowage, or `litres` from a can or the pump) is done at `nextTick` (nothing pending:
 * the setup time runs). `items`, `rounds`, `litres`: moved so far.
 */
export interface VehicleResupply {
  phase: "go" | "work";
  source: EntityId;
  what: "rearm" | "refuel";
  startTick: number;
  nextTick: number;
  chunk?: { type: DefId; charge?: number; litres?: number; pump?: true };
  from?: { x: number; y: number };
  items: number; rounds: number; litres: number;
}

/** The kinds of off-map asset (M10.6a ambulance, M11.7b recovery vehicle). */
export type OffMapKind = "ambulance" | "recovery" | "supply" | "mp";

/** A hull's recovery state (M11.7b, roster `VehicleRecord.recovery`): `towed` off the map by a recovery vehicle,
 *  `recovered` by its own side at the end (held ground), `captured` by the enemy holding the ground, `lost`
 *  (destroyed); `tick` when; `repairDays` workshop days (campaign input). */
export interface VehicleRecovery { state: "towed" | "recovered" | "captured" | "lost"; tick: number; repairDays?: number }

/** A crew's field repair in progress (M11.7a, `VehicleState.repair`). */
export interface RepairState {
  comp: number; needManS: number; doneManS: number; startTick: number; lastWorkTick: number; working: boolean;
  ordered?: true; stopWhy?: string;
}

/**
 * A combat vehicle's rear run (M10.6b; casualties now, supplies in M11). Phases: `toPoint` driving to the rear point
 * `point` (its platoon's Verwundetennest); `loading` halted there taking casualties aboard; `outbound` driving to the
 * map edge `exit`; `away` off the map (handing them over and driving back) until `backTick`; `return` on the map again
 * at `exit`, driving to `back`. It ends when it is back (or stranded, or ordered otherwise). `ordered`: the player's
 * `rearRun` order. `top`: the platoon (top unit) whose nest it serves.
 */
export interface RearRun {
  /** M11.4b: `unloading` halted at its platoon's supply point putting down the share it brought (`share`). */
  phase: "toPoint" | "loading" | "outbound" | "away" | "return" | "unloading";
  /** M11.4b: "supplies": a run started for supplies (its stowage was low, or ordered); a casualty run brings supplies
   *  back as well when its side has a stock. */
  cargo: "casualties" | "supplies";
  /** M11.4b: the items it brought for its platoon's supply point `supplyPoint` (unloaded there, `unloadTick`). */
  share?: { type: DefId; count: number; charge?: number }[];
  supplyPoint?: EntityId;
  unloadTick?: number;
  top: EntityId;
  point?: EntityId;
  ordered?: true;
  startTick: number;
  /** Where it was when it set off (it comes back there, or to its squad), and the map edge it leaves by. */
  from: { x: number; y: number };
  exit?: { x: number; y: number; heading: number };
  goal?: { x: number; y: number; px: number; py: number };
  loading?: { casualty: EntityId; doneTick: number };
  arriveTick?: number;
  lastLoadTick?: number;
  departTick?: number;
  awayTick?: number;
  backTick?: number;
  retryTick?: number;
}

/**
 * An off-map asset's run (M10.6a; an ambulance). Phases: `ready` waiting off the map for a call; `called` on its way
 * to the map edge (it comes on at `enterTick`); `inbound` on the map driving to the rear point `point`; `loading`
 * halted there taking casualties aboard; `outbound` driving back to its entry point `entry`; `away` gone off the map
 * with its casualties (one run per hull); `lost` stranded on the map (no driver, immobilised, destroyed: an ordinary
 * hull from then on). Off the map: ready, called, away.
 */
export interface OffMapAsset {
  kind: OffMapKind;
  /** M11.4b: on a delivery run (a supply vehicle, or an ambulance the player sent with supplies: a breach). The
   *  delivery's `point` is a supply rear point; `unloadTick` when it is unloaded; `backTick` when it is ready again
   *  after leaving the map. */
  cargo?: "supplies";
  unloadTick?: number;
  backTick?: number;
  /** M11.4b: the supplies aboard for the point (taken from the side's stock at the call; unloaded at the point). */
  load?: { type: DefId; count: number; charge?: number }[];
  /** M11.7b recovery adds `waiting` (short of a hull under fire), `hookUp` (its men outside hooking it up) and
   *  `towing` (driving off the map with it). */
  phase: "ready" | "called" | "inbound" | "loading" | "outbound" | "away" | "lost" | "waiting" | "hookUp" | "towing";
  /** M11.7b: the hull a recovery vehicle was called for. */
  target?: EntityId;
  /** M11.9b (kind "mp", phase "loading"): the step at the collection point (`out`: its men taking over the guard and
   *  the prisoners boarding; `mount`: its men getting back in), the prisoner walking to it and when he is aboard
   *  (`doneTick` set once he is at the door), and how many it has taken aboard. */
  mpStep?: "out" | "mount";
  boarding?: { prisoner: EntityId; doneTick?: number; sinceTick: number };
  taken?: number;
  /** M11.7b: hook-up work done (s, at full crew), when it began waiting short, the last tick its target was not
   *  quiet, whether the towed hull hangs on by its rear, and the bar length (hitch to the towed hull's centre, m). */
  hookDoneS?: number;
  waitTick?: number;
  /** M11.7b: seconds a recovery vehicle has waited short of its hull so far (it gives up after `giveUpS` in all). */
  waitedS?: number;
  noisyTick?: number;
  towRear?: boolean;
  towLenM?: number;
  /** The rear point it was called to (a Verwundetennest), and the top unit that called (the nest's platoon). */
  point?: EntityId;
  unit?: EntityId;
  /** The player called it (`callAmbulance`). */
  ordered?: true;
  /** When it was called, when it comes onto the map, when it reached the rear point, when it set off back, when it
   *  left the map. */
  callTick?: number;
  enterTick?: number;
  arriveTick?: number;
  departTick?: number;
  leftTick?: number;
  /** Where it comes onto the map and leaves it again (a point on the edge behind the rear point; heading inward). */
  entry?: { x: number; y: number; heading: number };
  /** The spot it drives to (short of the rear point) and the rear point's place it was routed for. */
  goal?: { x: number; y: number; px: number; py: number };
  /** The casualty being taken aboard and when he is in. Absent: nobody. */
  loading?: { casualty: EntityId; doneTick: number };
  /** Last time it took someone aboard or reached the point (the wait for more starts here); next route try. */
  lastLoadTick?: number;
  retryTick?: number;
}
