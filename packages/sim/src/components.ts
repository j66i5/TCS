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

/** Why a man gave up (carried by the `surrendered` event). */
export type SurrenderReason = "wounded" | "panicked" | "routed";

/** A man who has given up. Moves forward only: null -> surrendered -> captured. Never back. */
export interface Captive { state: "surrendered" | "captured"; /** Tick at which he gave up. */ tick: number }

/** Individual soldier state (SPEC 6.4). M0 holds the fields; systems that change them come in M1-M4. */
export interface SoldierState {
  /** Skills 0..1: marksmanship, fieldcraft, medical, leadership, experience (keys are data). */
  skills: Record<string, number>;
  posture: Posture;
  /** Posture being taken, or null. The change completes at `postureDoneTick`. */
  postureTo: Posture | null;
  postureDoneTick: number;
  /** winded: reached the exhaustion limit; stays true until fatigue falls below the run-again level. */
  physical: { fatigue: number; heartRateBpm: number; hydration: number; winded: boolean };
  mental: { stress: number; suppression: number; morale: number; behaviour: Behaviour };
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
  /** Last tick he threw a hand grenade on his own (soldier AI package D); absent: never. */
  grenadeTick?: number;
  /** M9.3b: the tick he last launched a guided missile from a tripod (the launch shows him); absent: never. */
  launchTick?: number;
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
  evacuated?: { tick: number; vehicle?: EntityId; via?: "ambulance" | "vehicle" | "end" };
  /**
   * What his roster record brought into this battle when it had been settled after an earlier one (review fix, rule
   * 11): how many of his wounds were already there (not handed over again) and the recovery days he still had.
   */
  rosterIn?: { wounds: number; recoveryDays: number };
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
  kind: "medical" | "supply";
  side: SideId;
  unit: EntityId;
  x: number;
  y: number;
  placed?: true;
  /** When it was sited (or last moved) and last checked. */
  sitedTick: number;
  checkTick: number;
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
  kind: "engage" | "cover" | "bringAmmo" | "takePrisoner" | "fetchAmmo" | "reposition" | "care" | "hideDrone";
  tick: number;
  target?: EntityId;
  /** bringAmmo: the item to hand over when it is not the receiver's magazine (an anti-tank round, M7.4a). */
  item?: DefId;
  x?: number;
  y?: number;
  /** takePrisoner, care: his height above the ground at (x, y) (his floor; absent = the ground, M7.5 review fix). */
  z?: number;
  /** care: he went as the first responder or medic (M10.3a). */
  responder?: true;
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
  /** He knows this enemy has given up: he saw it, or a comrade told him. Absent until set; never cleared while the contact lasts. */
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
  /** Tick of the last order delivered to this unit or one of its men (M6.6: no prisoner errands right after). */
  orderTick: number;
  /** A drill in progress (M4.3), and whether the unit has broken and is running back. */
  drill: Drill | null;
  broken: boolean;
  /** A vehicle crew unit (M7): the vehicle it crews. */
  vehicle?: EntityId;
  /** A crew that bailed out (M7.4b): the vehicle it left. It is a unit on foot from then on (`vehicle` cleared). */
  exVehicle?: EntityId;
  /** A foot unit's own carrier (M7.2). */
  carrier?: EntityId;
  /** The crew of an off-map asset (M10.6a: an ambulance called from the rear): no commander, AI or player orders it;
   *  it counts in no side's strength. Absent: an ordinary unit. */
  asset?: "ambulance";
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
  suppress?: "order" | "drill";
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
  recovery: { state: "none" } | null;
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
}

/**
 * A combat vehicle's rear run (M10.6b; casualties now, supplies in M11). Phases: `toPoint` driving to the rear point
 * `point` (its platoon's Verwundetennest); `loading` halted there taking casualties aboard; `outbound` driving to the
 * map edge `exit`; `away` off the map (handing them over and driving back) until `backTick`; `return` on the map again
 * at `exit`, driving to `back`. It ends when it is back (or stranded, or ordered otherwise). `ordered`: the player's
 * `rearRun` order. `top`: the platoon (top unit) whose nest it serves.
 */
export interface RearRun {
  phase: "toPoint" | "loading" | "outbound" | "away" | "return";
  cargo: "casualties";
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
  kind: "ambulance";
  phase: "ready" | "called" | "inbound" | "loading" | "outbound" | "away" | "lost";
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
