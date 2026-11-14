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
  /** Aboard a vehicle (M7): which one and which seat (index into its seats). Absent when not mounted. */
  mount?: { vehicle: EntityId; seat: number };
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
}

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
 */
export interface Intent {
  kind: "engage" | "cover" | "bringAmmo" | "takePrisoner" | "fetchAmmo" | "reposition";
  tick: number;
  target?: EntityId;
  /** bringAmmo: the item to hand over when it is not the receiver's magazine (an anti-tank round, M7.4a). */
  item?: DefId;
  x?: number;
  y?: number;
  /** takePrisoner: his height above the ground at (x, y) (his floor; absent = the ground, M7.5 review fix). */
  z?: number;
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
}

/** A contact report on its way from one soldier to another. */
export interface ContactReport {
  deliverTick: number;
  from: EntityId;
  to: EntityId;
  contact: Omit<Contact, "reportedTick">;
}

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
  /** Getting in or out of a vehicle (M7.2); not a drill. */
  boarding?: Boarding;
  /** Standing rule for anti-tank weapons (M7.4a); absent = the default from the data. */
  atRule?: "vehicles" | "vehiclesAndPositions" | "hold";
}

/**
 * A unit drill (M4.3). assault / withdraw: two groups take turns, one bounding toward (x, y) while the other
 * covers; `mover` is the group bounding now, since `phaseTick`; `final`: the last rush (or the last leg back).
 * rout: the unit has broken and runs to (x, y), where it rallies.
 */
export interface Drill {
  kind: "assault" | "withdraw" | "rout";
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
}

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
}

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
  /** Mount: wounded men to load (two comrades carry each in, owner Q25). */
  casualties?: EntityId[];
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
}
