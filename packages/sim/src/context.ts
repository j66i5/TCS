/**
 * The static context a battle runs in: catalog (data), map, rules and the swappable models.
 * Not part of SimState (it never changes during a battle), but recorded in the BattleInput.
 */
import type { Catalog } from "./catalog";
import type { CommsModel, CommsParams } from "./comms";
import type { MapDef } from "./map";
import type { MapIndex } from "./terrain";
import type { NavGrid, NavSearch } from "./nav";
import type { PhysiologyModel } from "./wounds";
import type { BallisticsCtx } from "./ballistics";
import type { SideId } from "./ids";

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
  dropTables: Record<string, Float32Array>;
  /** Derived navigation grids and search scratch per movement class (built on first use). Never saved. */
  nav: Record<string, { grid: NavGrid; search: NavSearch }>;
  rules: BattleRules;
  comms: CommsModel;
  physiology: PhysiologyModel | null;
  /** Rates for the physiology model: data (core/wounds.json) overridden by the scenario rules. */
  physiologyParams: Record<string, number>;
  /** Holes blown in walls so far (a reference to the state's list; set by syncTerrainDamage). */
  breaches: readonly { owner: "obstacle" | "building"; id: number; part: number; offsetM: number; widthM: number }[];
}
