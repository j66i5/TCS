/**
 * The CATALOG is the static, read-only rulebook a battle runs with: item types, factions, movement
 * modes, quality levels and so on. It is produced from data files by @tcs/data (validated there) and
 * handed to the simulation. The simulation never branches on a specific faction or item ID; it only
 * reads numbers and flags from these definitions (SPEC 4.3 rule 8).
 *
 * Only the fields the simulation reads are declared here. Data files may carry more (sources,
 * confidence, notes) which the loader keeps out of the sim.
 */
import type { DefId } from "./ids";

export interface ItemTypeDef {
  id: DefId;
  /** Mass of one item, kg (for a magazine: the empty magazine). */
  massKg: number;
  /** Category, used by systems to find items generically ("magazine", "grenade", "medical", "armour", ...). */
  category: string;
  /** For items that hold a charge (rounds in a magazine, Wh in a battery, litres in a can): maximum charge. */
  chargeCapacity?: number;
  /** Mass of one unit of charge, kg (one round, one litre ...). */
  chargeMassKg?: number;
  /** Which ammunition type the charge consists of (for magazines and belts). */
  chargeItem?: DefId;
}

export interface MovementModeDef {
  id: DefId; // "walk" | "run" | "sneak" | "crawl" | "wheeled" | "tracked" ... (data, not code)
  /** Nominal speed on open, level ground, m/s. */
  speedMps: number;
}

export interface QualityDef {
  id: DefId; // "conscript" | "regular" | "veteran" ...
  /** Mean and standard deviation of each skill, 0..1. */
  skills: Record<string, { mean: number; sd: number }>;
}

export interface FactionDef {
  id: DefId;
  /** Key into the string table for the faction's display name. */
  nameKey: string;
  /** Doctrine profile values (data-driven behaviour weights; SPEC 6.6). */
  doctrine: Record<string, number>;
}

export interface Catalog {
  /** Content fingerprint of the loaded data (stable hash). Stored in battle results and saves. */
  fingerprint: string;
  items: Record<DefId, ItemTypeDef>;
  movementModes: Record<DefId, MovementModeDef>;
  qualities: Record<DefId, QualityDef>;
  factions: Record<DefId, FactionDef>;
}

export function getItemDef(catalog: Catalog, id: DefId): ItemTypeDef {
  const d = catalog.items[id];
  if (!d) throw new Error(`Unknown item type '${id}'`);
  return d;
}
