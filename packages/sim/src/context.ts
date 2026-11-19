/**
 * The static context a battle runs in: catalog (data), map, rules and the swappable models.
 * Not part of SimState (it never changes during a battle), but recorded in the BattleInput.
 */
import type { Catalog } from "./catalog";
import type { CommsModel, CommsParams } from "./comms";
import type { MapDef } from "./map";
import type { MapIndex } from "./terrain";
import type { NavGrid, NavSearch, NavStamp } from "./nav";
import type { InteriorGraph } from "./interior-nav";
import type { PhysiologyModel } from "./wounds";
import type { BallisticsCtx, DropTable } from "./ballistics";
import type { DefId, SideId } from "./ids";
import type { Placement, UnitInput } from "./battle";

export interface BattleRules {
  /** The battle ends when this much game time has passed. */
  timeLimitSeconds: number;
  /** Which CommsModel to use (registry key) and its parameters. */
  commsModel: string;
  comms: CommsParams;
  /** Which PhysiologyModel to use and its data-driven rates (M2+). */
  physiologyModel: string;
  physiologyParams: Record<string, number>;
  /** Objective areas (M6): who holds them at the end scores their points. */
  objectives: ObjectiveDef[];
  /** How the battle is won (M6). Without it the battle simply runs to its time limit. */
  victory?: VictoryRules;
  /** Mortar rounds each side may call (M6.5c); the kind of fire is the faction's `fireSupport`. */
  /** M8.2a: `planned` targets set in deployment: points the side's mortars have registered on before the battle
   *  (a mission within `registeredM` of one fires for effect at once, with the small error left there). */
  /** M9.5: sides with an off-map fixed-wing reconnaissance drone overhead (it locates targets and watches falls). */
  airRecon?: SideId[];
  support?: { side: SideId; he: number; smoke: number; planned?: { x: number; y: number }[]; /** M8.4: illumination rounds; the artillery battery (default: the mortars). */ illum?: number; asset?: "mortar" | "artillery" }[];
  /** Care of the wounded (M10.2 on): false switches it off (`--no-medical`, comparison batches). Default on
   *  whenever the data has core/medical.json. */
  medicalCare?: boolean;
  /** Field repair by crews (M11.7a): false switches it off (`--no-repair`, labs holding a target still). Default on
   *  whenever the data has core/repair.json. */
  repair?: boolean;
  /** Recovery vehicles called to tow disabled hulls (M11.7b): false switches it off (`--no-recovery`). Default on
   *  whenever the data has core/repair.json `recovery`. */
  recovery?: boolean;
  /** M11: the supply chain (slices 44-48: supply points and caches, men sent to a cache, bearers, requests, vehicles
   *  re-arming, mortars fetching rounds, deliveries and the support top-up); false switches it off (`--no-resupply`,
   *  comparison batches). Balance pass 3 (owner 2026-11-18): it no longer switches off a man refilling his magazines
   *  from his own loose rounds or the squad evening out its ammunition (`refill`). Default on. */
  resupply?: boolean;
  /** Balance pass 3: a man refilling his magazines from his own loose rounds (M11.1) and the squad evening out and
   *  taking its casualties' ammunition (M11.2, consolidate.ts); false switches both off (`--no-refill`, comparison
   *  batches). Default on, with or without `resupply`. */
  refill?: boolean;
  /** M11.4b: supplies from off the map (supply vehicle deliveries, combat vehicles' rear runs with supplies, the
   *  support top-up); false switches them off and leaves resupply on foot (`--no-deliveries`, comparison batches:
   *  "foot only"). Default on; off too with `resupply: false`. */
  deliveries?: boolean;
  /** M11.9c: prisoners may escape (owner question Q5, option (a)); false switches escapes off (labs). Default on
   *  whenever the data has core/prisoners.json `escape`. */
  prisonerEscapes?: boolean;
  /** M11 hold battle: a side whose positions were prepared before the battle: each of its men who halts on the
   *  ground outdoors between `fromS` and `untilS` is in a dug fighting position there (`positions.ts`). `depthM`
   *  (balance pass 2): the positions dug in this window are at most this deep (a hasty dig-in; absent: the data's
   *  `fightingPosition.depthM`). */
  prepared?: { side: SideId; fromS: number; untilS: number; depthM?: number }[];
  /** M12.0a: the battle's result carries what a campaign needs (`BattleResult.damageOut`, `service`; a per-man tally
   *  kept in `SoldierState.service`). Absent or false: nothing of it (every golden and batch result as before). */
  campaignOut?: boolean;
}

/** An area worth holding (M6). */
export interface ObjectiveDef {
  id: string;
  /** String-table key of its name. */
  nameKey: string;
  x: number;
  y: number;
  radiusM: number;
  points: number;
  /** Who holds it at the start (the defender), or nobody. */
  holder: SideId | null;
}

/**
 * Victory (owner decision 2026-11-12): points for the objectives held at the end, minus `casualtyPoints` for
 * each own man down (killed or incapacitated); a side that breaks (all its units broken) or has nobody left
 * standing loses at once.
 */
export interface VictoryRules {
  casualtyPoints: number;
  /** End the battle as soon as one side has broken or has nobody left. */
  endOnDefeat: boolean;
  /** Vehicles (M7.4a, owner Q9): points off for each own vehicle destroyed or abandoned (`lost`) or immobilised. */
  vehiclePoints?: { lost: number; immobilised: number };
}

export interface SimContext {
  catalog: Catalog;
  map: MapDef;
  /** Derived from the map at creation: spatial index of wall segments. */
  mapIndex: MapIndex;
  mapFingerprint: string;
  /** Derived ballistics tables (coarse grids, wall and material properties). Never saved. */
  ballistics: BallisticsCtx;
  /** Drop tables per ammunition and muzzle velocity (built on first use). Never saved. */
  dropTables: Record<string, DropTable>;
  /** Derived navigation grids and search scratch per movement class (built on first use). Never saved. */
  nav: Record<string, { grid: NavGrid; search: NavSearch }>;
  rules: BattleRules;
  comms: CommsModel;
  physiology: PhysiologyModel | null;
  /** Rates for the physiology model: data (core/wounds.json) overridden by the scenario rules. */
  physiologyParams: Record<string, number>;
  /** Holes blown in walls so far (a reference to the state's list; set by syncTerrainDamage). */
  breaches: readonly { owner: "obstacle" | "building"; id: number; part: number; offsetM: number; widthM: number; sillM?: number; headM?: number }[];
  /** M12.0a: craters carried in from earlier battles (`BattleInput.damage`): rough ground in the navigation grids. */
  navCraters?: readonly { x: number; y: number; radiusM: number }[];
  /** Wrecks stamped into the navigation grids (derived from the vehicle store; M7), and their key. */
  navStamps: NavStamp[];
  navStampKey: string;
  /** Interior graphs per building index (M7.5c; built on first use, rebuilt after a breach). Never saved. */
  interiorNav?: Record<number, InteriorGraph>;
  /** Does the map have any building interior (M7.5c; derived on first use)? */
  hasInteriors?: boolean;
  /** M11.1: the top-level units that arrive late (`UnitInput.arriveS`), from the input; never saved (the state's
   *  `arrived` says which have come). */
  late: { side: SideId; faction: DefId; unit: UnitInput; tick: number; placements: Map<string, Placement> }[];
}
