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
import type { VehicleStatus } from "./components";
import type { ItemStack } from "./items";
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
  stress: number;
  wounds: Wound[];
  /** Blood volume, shock, consciousness... of a man who is already hurt (omitted = healthy, or derived from status). */
  physiology?: Physiology;
  /** Load: counted items (SPEC 4.3 rule 9). */
  load: ItemStack[];
  /** Outcome status after a battle. "fit" going in. */
  /** "surrendered" / "captured" (M6.6): such a record placed in a battle is a prisoner from the first tick. */
  status: "fit" | "wounded" | "incapacitated" | "killed" | "missing" | "surrendered" | "captured";
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
  /** A vehicle crew unit (M7): the `vehicleId` of the force's vehicle it crews. */
  vehicleId?: string;
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
  /** Contents of its container: fuel tank (charge = litres), stowed belts, smoke and extinguisher charges.
   *  On output the ready belts of its weapons are added back in. */
  load: ItemStack[];
  /** Rounds on the ready belts/racks per station weapon (omitted = full from the data). */
  ready?: { item: DefId; rounds: number }[][];
  /** Condition of each component (omitted = all 1). */
  components?: number[];
  status?: VehicleStatus;
  /** Reserved: the side holding it (campaign). */
  capturedBy?: SideId | null;
  recovery?: null;
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
  vehiclePlacements?: { vehicleId: string; x: number; y: number; heading: number }[];
}

export interface BattleInput {
  map: MapDef;
  catalog: Catalog;
  forces: ForceInput[];
  rules: BattleRules;
  seed: number;
  /** The order stream. For AI or human play, orders produced during the battle are appended. */
  orders: Order[];
  environment?: Environment;
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
  /** Vehicles (M7): how many started and how they ended; absent for a force without vehicles. */
  vehicles?: { start: number; ok: number; immobilised: number; disarmed: number; abandoned: number; destroyed: number; captured: number };
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
  /** Destroyed, abandoned and immobilised hulls left on the map (M7; persistent map damage as data). */
  wrecks?: { vehicleId: string; type: DefId; side: SideId; x: number; y: number; heading: number; status: VehicleStatus }[];
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
