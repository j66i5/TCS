/**
 * INVENTORY IS REAL (SPEC 4.3 rule 9).
 *
 * Every consumable is a counted item with mass, held in a CONTAINER. A container is a component that any
 * entity can have: a soldier (his load), a vehicle, a crate, a depot, a casualty. One generic transfer
 * function moves items between containers; logistics, ammunition sharing, cross-loading from casualties
 * and medical kit all use it.
 *
 * Items that are not interchangeable once used (a half-empty magazine) are stacks with a `charge`:
 * 3 magazines with 30 rounds and 1 magazine with 12 rounds are two stacks of the same type.
 */
import { getItemDef, type Catalog } from "./catalog";
import type { DefId, EntityId } from "./ids";

export interface ItemStack {
  type: DefId;
  count: number;
  /** Charge per item (rounds, litres, Wh). Absent for items without charge. */
  charge?: number;
}

export interface Container {
  /** Kept sorted by (type, charge) so iteration order is deterministic. */
  stacks: ItemStack[];
  /** Optional mass limit, kg. Soldiers have none (overload shows as fatigue), crates and racks do. */
  maxMassKg?: number;
}

export function emptyContainer(maxMassKg?: number): Container {
  return maxMassKg === undefined ? { stacks: [] } : { stacks: [], maxMassKg };
}

function stackKeyCompare(a: ItemStack, b: ItemStack): number {
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  return (a.charge ?? -1) - (b.charge ?? -1);
}

export function stackMassKg(catalog: Catalog, s: ItemStack): number {
  const d = getItemDef(catalog, s.type);
  return s.count * (d.massKg + (s.charge ?? 0) * (d.chargeMassKg ?? 0));
}

export function containerMassKg(catalog: Catalog, c: Container): number {
  let m = 0;
  for (const s of c.stacks) m += stackMassKg(catalog, s);
  return m;
}

/** Count of items of a type (any charge). */
export function countItems(c: Container, type: DefId): number {
  let n = 0;
  for (const s of c.stacks) if (s.type === type) n += s.count;
  return n;
}

/** Add items. Merges into an existing stack with identical (type, charge). */
export function addItems(c: Container, type: DefId, count: number, charge?: number): void {
  if (count <= 0) return;
  for (const s of c.stacks) {
    if (s.type === type && s.charge === charge) {
      s.count += count;
      return;
    }
  }
  const stack: ItemStack = charge === undefined ? { type, count } : { type, count, charge };
  c.stacks.push(stack);
  c.stacks.sort(stackKeyCompare);
}

/**
 * Remove up to `count` items of `type` (optionally only those with exactly `charge`).
 * Without a charge filter, takes the fullest stacks first. Returns the removed stacks.
 */
export function removeItems(c: Container, type: DefId, count: number, charge?: number): ItemStack[] {
  const removed: ItemStack[] = [];
  let left = count;
  // Fullest first: iterate matching stacks by descending charge (stable, deterministic).
  const candidates = c.stacks
    .filter((s) => s.type === type && (charge === undefined || s.charge === charge))
    .sort((a, b) => (b.charge ?? 0) - (a.charge ?? 0));
  for (const s of candidates) {
    if (left <= 0) break;
    const take = Math.min(left, s.count);
    s.count -= take;
    left -= take;
    removed.push(s.charge === undefined ? { type, count: take } : { type, count: take, charge: s.charge });
  }
  c.stacks = c.stacks.filter((s) => s.count > 0);
  return removed;
}

export interface TransferRequest {
  from: EntityId;
  to: EntityId;
  type: DefId;
  count: number;
  /** Only items with exactly this charge; omit for "any, fullest first". */
  charge?: number;
}

export interface TransferResult {
  moved: number;
  /** Why fewer than requested moved, if so. */
  shortfall?: "not-enough-items" | "destination-full" | "no-container";
}

/**
 * THE generic transfer. Moves items between two containers, respecting the destination mass limit.
 * Instantaneous; the time it takes is modelled by the action that calls it (see actions.ts).
 */
export function transferItems(
  catalog: Catalog,
  containers: { get(id: EntityId): Container | undefined },
  req: TransferRequest,
): TransferResult {
  const from = containers.get(req.from);
  const to = containers.get(req.to);
  if (!from || !to) return { moved: 0, shortfall: "no-container" };
  const available = req.charge === undefined
    ? countItems(from, req.type)
    : from.stacks.filter((s) => s.type === req.type && s.charge === req.charge).reduce((n, s) => n + s.count, 0);
  let want = Math.min(req.count, available);
  let shortfall: TransferResult["shortfall"] = want < req.count ? "not-enough-items" : undefined;

  if (to.maxMassKg !== undefined) {
    // Reduce the request until it fits. Simple loop; counts are small.
    const free = to.maxMassKg - containerMassKg(catalog, to);
    const def = getItemDef(catalog, req.type);
    const perItemMax = def.massKg + (req.charge ?? def.chargeCapacity ?? 0) * (def.chargeMassKg ?? 0);
    if (perItemMax > 0) {
      const fit = Math.max(0, Math.floor(free / perItemMax + 1e-9));
      if (fit < want) {
        want = fit;
        shortfall = "destination-full";
      }
    }
  }
  const removed = removeItems(from, req.type, want, req.charge);
  let moved = 0;
  for (const s of removed) {
    addItems(to, s.type, s.count, s.charge);
    moved += s.count;
  }
  return shortfall === undefined ? { moved } : { moved, shortfall };
}
