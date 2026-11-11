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

export interface BattleRules {
  /** The battle ends when this much game time has passed. */
  timeLimitSeconds: number;
  /** Which CommsModel to use (registry key) and its parameters. */
  commsModel: string;
  comms: CommsParams;
  /** Which PhysiologyModel to use and its data-driven rates (M2+). */
  physiologyModel: string;
  physiologyParams: Record<string, number>;
  /** Objectives, victory points, reinforcements, support allotments: reserved for M6. */
  objectives: unknown[];
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
}
