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
import type { SimView } from "./state";

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

export interface ChargeRequest {
  /** The container giving charge and the one item there (type and its present charge) it comes out of. */
  from: EntityId; fromType: DefId; fromCharge: number;
  /** The container taking it and the one item there it goes into (the same container is fine). */
  to: EntityId; toType: DefId; toCharge: number;
  /** Charge to move (rounds, litres, Wh); less if the giver has less or the taker is full. */
  amount: number;
}

export interface ChargeResult {
  moved: number;
  refused?: "kind-mismatch" | "no-item" | "no-container";
}

/**
 * M11.1: move CHARGE (rounds, litres, watt-hours) from one item to another of the same charge kind (`chargeItem` for
 * rounds, else `chargeKind`): a bandolier into a magazine, a jerrycan into a tank, a charger into a battery. One item
 * of each stack is split off, its charge changed and merged back, so the total charge is conserved exactly. The
 * destination item fills up to its `chargeCapacity`; a mass limit on another container caps it too. Instantaneous;
 * the time it takes is the calling action's.
 */
export function moveCharge(
  catalog: Catalog,
  containers: { get(id: EntityId): Container | undefined },
  req: ChargeRequest,
): ChargeResult {
  const from = containers.get(req.from), to = containers.get(req.to);
  if (!from || !to) return { moved: 0, refused: "no-container" };
  const fd = catalog.items[req.fromType], td = catalog.items[req.toType];
  const kind = (d: typeof fd) => d?.chargeItem ?? d?.chargeKind;
  if (!fd || !td || kind(fd) === undefined || kind(fd) !== kind(td)) return { moved: 0, refused: "kind-mismatch" };
  const has = (c: Container, t: DefId, ch: number) => c.stacks.some((s) => s.type === t && (s.charge ?? 0) === ch && s.count > 0);
  if (!has(from, req.fromType, req.fromCharge) || !has(to, req.toType, req.toCharge)) return { moved: 0, refused: "no-item" };
  if (from === to && req.fromType === req.toType && req.fromCharge === req.toCharge) {
    // (The same stack: only meaningful with two items in it.)
    if (countWithCharge(from, req.fromType, req.fromCharge) < 2) return { moved: 0, refused: "no-item" };
  }
  let n = Math.min(Math.max(0, Math.floor(req.amount)), req.fromCharge, (td.chargeCapacity ?? 0) - req.toCharge);
  if (from !== to && to.maxMassKg !== undefined && (td.chargeMassKg ?? 0) > 0) {
    const free = to.maxMassKg - containerMassKg(catalog, to);
    n = Math.min(n, Math.max(0, Math.floor(free / td.chargeMassKg! + 1e-9)));
  }
  if (n <= 0) return { moved: 0 };
  removeItems(from, req.fromType, 1, req.fromCharge);
  removeItems(to, req.toType, 1, req.toCharge);
  addItems(from, req.fromType, 1, req.fromCharge - n);
  addItems(to, req.toType, 1, req.toCharge + n);
  return { moved: n };
}

function countWithCharge(c: Container, type: DefId, charge: number): number {
  let n = 0;
  for (const s of c.stacks) if (s.type === type && (s.charge ?? 0) === charge) n += s.count;
  return n;
}

/**
 * Draw up to `amount` of charge from ONE item of `type` with charge left: the fullest or the emptiest one (ties: the
 * first stack in order). The item stays a counted item, at its lower charge (an empty canteen stays in the load).
 * Returns the charge drawn (0 when no item of the type has charge). Fuel from a tank, water from a canteen (M11.6).
 */
export function drawCharge(c: Container, type: DefId, amount: number, order: "fullest" | "emptiest"): number {
  if (amount <= 0) return 0;
  let best: ItemStack | undefined;
  for (const s of c.stacks) {
    const ch = s.charge ?? 0;
    if (s.type !== type || ch <= 0) continue;
    if (best === undefined || (order === "fullest" ? ch > best.charge! : ch < best.charge!)) best = s;
  }
  if (best === undefined) return 0;
  const charge = best.charge!;
  const drawn = Math.min(amount, charge);
  removeItems(c, type, 1, charge);
  addItems(c, type, 1, charge - drawn);
  return drawn;
}

/**
 * M7.6d: the box on the automatic grenade launcher of man `id`'s team if he is the one it counts on (the post's
 * carrier), else null. It is part of his load (mass, roster out) as the magazine in his weapon is.
 */
export function aglBoxOf(state: SimView, id: EntityId): { item: DefId; rounds: number } | null {
  const uid = state.identity.get(id)?.unit;
  const box = uid === undefined ? undefined : state.unit.get(uid)?.missileTeam?.box;
  return box !== undefined && box.holder === id ? box : null;
}
