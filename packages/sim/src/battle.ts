/**
 * A BATTLE IS A FUNCTION (SPEC 4.3 rule 11):
 *     (map, forces, scenario rules, seed, order stream) -> result record
 *
 * The forces going in (`ForceInput`, built from roster records) and the result coming out
 * (`BattleResult`, with updated roster records) are defined here, independently of the battle internals,
 * so the campaign can feed battles and read their outcome, and run AI-versus-AI battles headless.
 */
import type { Catalog } from "./catalog";
import type { BattleRules } from "./context";
import type { Environment } from "./environment";
import type { BattleEndReason, SimEvent, SimEventKind } from "./events";
import type { DefId, SideId } from "./ids";
import type { OffMapKind, TerrainState, VehicleRecovery, VehicleStatus } from "./components";
import type { ItemStack } from "./items";
import type { SideLogistics } from "./ledger";
import type { MapDef } from "./map";
import type { Order } from "./orders";
import type { Physiology, Wound } from "./wounds";
import type { SerializedState, SimView } from "./state";
import type { Sim } from "./sim";
import type { SideScore } from "./systems/objectives";

/** A soldier as the ROSTER knows him: persists between battles (campaign, SPEC 9.3). */
export interface SoldierRecord {
  personId: string;
  given: string;
  family: string;
  rank: DefId;
  role: DefId;
  skills: Record<string, number>;
  /** Personal weapon (catalog weapon ID); its magazines are items in `load`. */
  weapon?: DefId;
  /** Carried-over condition. */
  fatigue: number;
  /** His shock (fast fear) as it stood, and his strain (slow wear; morale rework 2026-11-15; absent = 0). */
  stress: number;
  strain?: number;
  /** M11.6: his water (1 = no deficit, 0 = the deficit at which thirst tells fully; absent = 1). */
  hydration?: number;
  wounds: Wound[];
  /** Blood volume, shock, consciousness... of a man who is already hurt (omitted = healthy, or derived from status). */
  physiology?: Physiology;
  /** Load: counted items (SPEC 4.3 rule 9). */
  load: ItemStack[];
  /** M11.6: the batteries in his devices went back into `load` after an earlier battle: setup fits his fullest ones as
   *  they are (absent: a fresh record, whose fitted batteries start partly used; see power.ts `fitBatteries`). */
  powerFitted?: true;
  /** Outcome status after a battle. "fit" going in. */
  /** "surrendered" / "captured" (M6.6): such a record placed in a battle is a prisoner from the first tick. */
  /** "evacuated" (M10.6a/b): taken off the map by an ambulance, a combat vehicle's rear run, or at the battle's end
   *  by his side holding the ground. A man who died of his wounds after the battle is "killed", with `diedOfWoundsTick`. */
  status: "fit" | "wounded" | "incapacitated" | "killed" | "missing" | "surrendered" | "captured" | "evacuated";
  /** Days until he is fit again (M10.6b, owner Q-16: from wound severity and treatment). Absent: not wounded, or not
   *  yet settled (a record that went into a battle and was not hurt again keeps whatever it had: the campaign's). */
  recoveryDays?: number;
  /** He died of his wounds after the battle, at this battle tick (M10.6b; it may lie after the battle's end). */
  diedOfWoundsTick?: number;
  /** M11.9b: a "captured" man: the side holding him (placed in a later battle he is its prisoner from the first tick). */
  heldBy?: SideId;
  /** M11.9b: the battle tick the holder's military police took him off the map (an evacuated prisoner). */
  powEvacuated?: number;
}

export interface UnitInput {
  /** Stable key within the roster ("1/2" = 2nd squad of 1st platoon), kept in results. */
  key: string;
  callsign: string;
  echelon: DefId;
  /** Index into `members` of the leader, or -1. */
  leaderIndex: number;
  members: SoldierRecord[];
  subunits: UnitInput[];
  /** Its quality level (core/qualities.json; morale rework 2026-11-15). Absent: its parent's, else the data's default. */
  quality?: DefId;
  /** Its cohesion and trust 0..1 at the start (unit template `bond`). Absent: its quality's. */
  bond?: number;
  /** A vehicle crew unit (M7): the `vehicleId` of the force's vehicle it crews. */
  vehicleId?: string;
  /** A unit on foot (M7.2): the `vehicleId` of the vehicle that carries it (its own men; sub-units without a
   *  carrier of their own ride in it too). */
  carrierId?: string;
  /** M11.1 late arrival (a wave): a top-level unit that enters the battle this many seconds after the start, at its
   *  men's placements. Until then it is not in the state at all (no system sees it, nothing costs per tick), its side
   *  is not beaten while it is still to come, and its roster records come out unchanged if it never arrives. */
  arriveS?: number;
}

/**
 * A vehicle as the ROSTER knows it (M7): a force-level asset, linked to its crew unit by `vehicleId`, so it
 * comes out of the battle whatever happened to the crew.
 */
export interface VehicleRecord {
  /** Stable key within the roster. */
  vehicleId: string;
  /** Vehicle type (catalog `vehicles`). */
  type: DefId;
  /** Contents of its container only: fuel tank (charge = litres), stowed belts, smoke and extinguisher charges.
   *  The rounds on the ready belts are NOT in it (they are in `ready`), on input and on output alike, so a record
   *  that comes out goes back in unchanged and nothing is counted twice: its rounds = `load` + `ready`. */
  load: ItemStack[];
  /** Rounds on the ready belts/racks per station weapon (station weapons in order, station by station; per feed),
   *  on input (omitted = full from the data) and on output (as they stand). */
  ready?: { item: DefId; rounds: number }[][];
  /** Condition of each component (omitted = all 1). */
  components?: number[];
  status?: VehicleStatus;
  /** The side holding it (M11.7b: written at the end for a hull left on ground the enemy holds). */
  capturedBy?: SideId | null;
  /** How it was recovered (M11.7b): towed off the map, recovered or captured at the end, lost. Null/absent: nothing. */
  recovery?: VehicleRecovery | null;
}

export interface Placement {
  personId: string;
  x: number;
  y: number;
  heading: number;
  /** M7: he starts aboard this vehicle (`vehicleId`) ... */
  mountedIn?: string;
  /** ... in this seat (index into the vehicle's seats); also overrides a crewman's seat. */
  seat?: number;
}

export interface ForceInput {
  side: SideId;
  faction: DefId;
  units: UnitInput[];
  /** Where each soldier starts. Chosen by the scenario (deployment zones), not the roster. */
  placements: Placement[];
  /** The force's vehicles (M7), and where each starts. */
  vehicles?: VehicleRecord[];
  /** `onPost` (balance pass 4): the hull starts on the hull-down post its commander sited for it (ai
   *  `defenceStartPosts`); the commander keeps it there. The simulation does not read it. */
  vehiclePlacements?: { vehicleId: string; x: number; y: number; heading: number; onPost?: true }[];
  /** Off-map assets (M10.6a): vehicles of `vehicles` (with their crews) that start off the map and come on only when
   *  called (an ambulance). They need no placement. */
  offMap?: { vehicleId: string; kind: OffMapKind }[];
  /** Whether this side attacks or defends (scenario). Optional: absent = not stated. */
  posture?: "attack" | "defend";
  /** M12.0b: the side's plan in the battle (scenario kinds, SPEC 6.9), for its commander (AI or the player's briefing).
   *  The simulation does not read it. Absent: the plan follows from `posture` and the objectives (every battle before). */
  plan?: ForcePlan;
  /** M11.1: crates and cans of this side on the ground: each a cache (M11.3: an entity with a place, a container and
   *  a `cache` record of this side). `point`: the supply point of the side's nearest platoon. */
  caches?: { x: number; y: number; load: ItemStack[]; point?: boolean }[];
  /** M11.4b: what the rear holds for this side (its off-map stock): the only source of deliveries during the battle
   *  (supply vehicle runs, combat vehicles' rear runs, the support top-up). `supportTopUp`: `rounds` moved into the
   *  side's off-map mortar or artillery section every `everyS` (owner: allotments topped up by deliveries). */
  stock?: { load: ItemStack[]; supportTopUp?: { rounds: number; everyS: number } };
}

/**
 * M12.0b: what a side is to do in a battle of a scenario kind (`ForceInput.plan`): "attack" / "defend" the objectives;
 * "meeting" advance to the objectives in the middle (both sides); "ambush" lie in wait (`ambushRangeM`) and spring it;
 * "transit" move along `route` to the side's exit zone `exit` (the ambushed side); "withdraw" hold the objectives until
 * `untilS`, then get out by `exit`; "follow" attack the objectives and, from `untilS` on, follow the enemy up toward
 * `exit` (the enemy's exit). `reserve`: callsigns of the side's units arriving late (`UnitInput.arriveS`) that attack
 * on their own when they come (a counter-attack, reinforcements).
 */
export interface ForcePlan {
  posture: "attack" | "defend" | "meeting" | "ambush" | "transit" | "withdraw" | "follow";
  untilS?: number;
  exit?: { x0: number; y0: number; x1: number; y1: number };
  route?: { x: number; y: number }[];
  reserve?: string[];
  ambushRangeM?: number;
}

/**
 * M12.0a: terrain damage carried from earlier battles on the same map (a campaign sector): holes in walls, craters,
 * thinned vegetation, dug fighting positions, as `state.terrain` holds them (`BattleResult.damageOut`). Applied at
 * setup: holes go into the wall tables, the navigation grids and the building interiors exactly as a hole blown in
 * the battle; craters are rough ground in the navigation grids (`CRATER_NAV`, nav.ts); positions protect anyone in
 * them. Their ticks are those of the battle that made them (before this one).
 */
export type TerrainDamage = TerrainState;

/** A wreck lying on the map (M7 `BattleResult.wrecks`; M12.0a `BattleInput.wrecksIn`). */
export interface WreckRecord { vehicleId: string; type: DefId; side: SideId; x: number; y: number; heading: number; status: VehicleStatus }

/**
 * M12.0a: what one man went through in a battle (`BattleResult.service`, per `personId`; the campaign's experience
 * and stress history). Seconds are counted once a second: under effective fire (his suppression at least
 * `SERVICE_FIRE_SUPPRESSION`), in contact (he knows an enemy); rounds he fired (his weapon or a vehicle station he
 * served); wounds taken in this battle; his peak shock and strain (1 Hz samples and the start).
 */
export interface ServiceTally { underFireS: number; contactS: number; roundsFired: number; wounds: number; peakShock: number; peakStrain: number }

export interface BattleInput {
  map: MapDef;
  catalog: Catalog;
  forces: ForceInput[];
  rules: BattleRules;
  seed: number;
  /** The order stream. For AI or human play, orders produced during the battle are appended. */
  orders: Order[];
  environment?: Environment;
  /** M12.0a: terrain damage from earlier battles on this map (absent: none; the battle is as before). */
  damage?: TerrainDamage;
  /** M12.0a: wrecks from earlier battles on this map: crewless hulls of neither force (`WRECK_SIDE`), empty, burnt
   *  out, lying where they were (navigation stamp as `isWreck`; they stop rounds as any hull). Placed after every
   *  other entity, so the ids of the battle itself are as without them. */
  wrecksIn?: WreckRecord[];
}

export interface SideResult {
  side: SideId;
  faction: DefId;
  soldiersStart: number;
  soldiersFit: number;
  wounded: number;
  killed: number;
  /** Living prisoners (M6.6): start = fit + wounded + killed + surrendered + captured. */
  surrendered: number;
  captured: number;
  /** Of the wounded (M10.6a): evacuated off the map (by ambulance, a combat vehicle's rear run, or at the end by the
   *  side holding the ground, M10.6b). Absent: none. */
  evacuated?: number;
  /** Of the wounded and prisoners (M10.6b): died of their wounds after the battle (roster status "killed" with
   *  `diedOfWoundsTick`; not in `killed`, which counts the men killed in the battle). Absent: none. */
  diedOfWounds?: number;
  /** M11.9b (absent: none): the enemy men this side took prisoner in the battle and holds at the end (end settlement
   *  included), how many of them its military police took off the map, and how many escaped from it (M11.9c). */
  prisonersTaken?: number;
  prisonersEvacuated?: number;
  prisonersEscaped?: number;
  /** M12.0b (absent: none): men out by the side's exit zones (saved; counted in fit or wounded as they left). */
  saved?: number;
  /** Vehicles (M7): how many started and how they ended; absent for a force without vehicles. */
  vehicles?: { start: number; ok: number; immobilised: number; disarmed: number; abandoned: number; destroyed: number; captured: number;
    /** M11.7b (absent: none): towed off the map in the battle; recovered by the own side at the end. */
    towed?: number; recovered?: number;
    /** M12.0b (absent: none): out by the side's exit zones with everyone aboard (counted by their status too). */
    exited?: number };
}

/** A prisoner at the end of a battle (M11.9b, `BattleResult.prisoners`). */
export interface PrisonerResult {
  holder: SideId; side: SideId; unitKey: string; personIndex: number;
  group: "officer" | "nco" | "man"; wounded: boolean; evacuated: "mp" | "medical" | "held"; documents: number;
}

export interface BattleResult {
  seed: number;
  catalogFingerprint: string;
  endTick: number;
  durationSeconds: number;
  endReason: BattleEndReason;
  finalStateHash: string;
  sides: SideResult[];
  /** The forces as they come out: same units and persons, updated condition and load. */
  forcesOut: { side: SideId; faction: DefId; units: UnitInput[]; /** M7: every vehicle of the force. */ vehicles?: VehicleRecord[] }[];
  /** Wrecks left on the map (M7; persistent map damage as data): destroyed, abandoned, and immobilised hulls not
   *  penetrated for more than 30 s (`isWreck`, the same hulls stamped into the navigation grids). */
  wrecks?: WreckRecord[];
  /** Caches on the map at the end (M11.3): whose they are (`from`: the side a captured one was taken from), where, what
   *  is left in them, `burnt`. The contents of a captured cache count as captured (the campaign gives them to its
   *  captor). */
  caches?: { side: SideId; kind: "point" | "cache"; x: number; y: number; load: ItemStack[]; from?: SideId; burnt?: true }[];
  /** M11.8: per side, consumed, delivered from off the map, captured and destroyed (rounds by ammunition id, whole
   *  items by item id, litres by fuel kind), from the events of this run (`ledger.ts` `logisticsFromEvents`; a run
   *  continued from a save counts from there). Input for M12 and M13; `forcesOut` carries the loads. */
  logistics?: SideLogistics[];
  /** M11.9b: the prisoners each side holds at the end (absent: none): who holds him (`holder`), his own side and roster
   *  place (`unitKey`, `personIndex` among the unit's members), his group, wounded, how he left the battle (`mp`: taken
   *  off the map by the holder's military police; `medical`: by the holder's medical chain, wounded; `held`: still
   *  held on the map at the end), and the documents items taken from him. Input for M12 (roster) and M13 (intelligence). */
  prisoners?: PrisonerResult[];
  /** M12.0a (only with `rules.campaignOut`): the map's terrain damage at the end, the input's `damage` included. */
  damageOut?: TerrainDamage;
  /** M12.0a (only with `rules.campaignOut`): per `personId` of every man of the forces who took part (late arrivals
   *  that never came are not in it), what he went through (`ServiceTally`). */
  service?: Record<string, ServiceTally>;
  /** Full order stream, including orders produced by controllers during the battle. */
  orders: Order[];
  eventCounts: Partial<Record<SimEventKind, number>>;
  /** Score per side and the winner (M6; null = a draw, or no victory rules). */
  scores: SideScore[];
  winner: SideId | null;
}

/**
 * Something that issues orders during a battle: an AI commander, a scripted test, a network peer.
 * It sees the state READ-ONLY and acts only through the orders it returns.
 */
export interface Controller {
  side: SideId;
  /** Called every tick before the step. Returns orders for THIS tick (`order.tick === tick`). */
  think(view: SimView, tick: number): Order[];
  /** Plain-data snapshot of the controller's own memory (its RNG, plans), stored in save games. */
  saveState?(): unknown;
  /** Restore what `saveState` returned. */
  loadState?(data: unknown): void;
}

/** A complete save game: simulation state plus the memory of every controller. */
export interface SaveGame {
  state: SerializedState;
  controllers: Record<SideId, unknown>;
}

export interface RunOptions {
  controllers?: Controller[];
  /** Called with each tick's events. */
  onEvents?: (events: SimEvent[], tick: number) => void;
  /** Called after each tick (e.g. to record hashes). */
  onTick?: (sim: Sim) => void;
  /** Hard stop regardless of rules, ticks. */
  maxTicks?: number;
}
