/**
 * Component store: entity ID -> component (plain data).
 *
 * Iteration is ALWAYS in ascending entity-ID order. A plain Map iterates in insertion order, which would
 * differ between a live state (where a component was removed and re-added) and the same state after
 * save/load. That would silently break determinism, so all stores go through this wrapper.
 */
import type { EntityId } from "./ids";

/** Read-only face of a Store, handed to code that must not change simulation state. */
export interface ReadonlyStore<T> {
  readonly size: number;
  get(id: EntityId): T | undefined;
  req(id: EntityId): T;
  has(id: EntityId): boolean;
  entries(): IterableIterator<[EntityId, T]>;
  keys(): IterableIterator<EntityId>;
  values(): IterableIterator<T>;
}

export class Store<T> implements ReadonlyStore<T> {
  private map = new Map<EntityId, T>();
  private maxKey = -Infinity;

  get size(): number {
    return this.map.size;
  }

  get(id: EntityId): T | undefined {
    return this.map.get(id);
  }

  /** Like get, but throws if missing. */
  req(id: EntityId): T {
    const v = this.map.get(id);
    if (v === undefined) throw new Error(`entity ${id} has no such component`);
    return v;
  }

  has(id: EntityId): boolean {
    return this.map.has(id);
  }

  set(id: EntityId, value: T): void {
    if (this.map.has(id) || id > this.maxKey) {
      this.map.set(id, value);
      if (id > this.maxKey) this.maxKey = id;
      return;
    }
    // Out-of-order insert: rebuild sorted. Rare (re-adding a component to an old entity).
    const entries = [...this.map.entries(), [id, value] as [EntityId, T]].sort((a, b) => a[0] - b[0]);
    this.map = new Map(entries);
  }

  delete(id: EntityId): void {
    this.map.delete(id);
  }

  /** Ascending entity-ID order. */
  entries(): IterableIterator<[EntityId, T]> {
    return this.map.entries();
  }

  keys(): IterableIterator<EntityId> {
    return this.map.keys();
  }

  values(): IterableIterator<T> {
    return this.map.values();
  }

  toEntries(): [EntityId, T][] {
    return [...this.map.entries()];
  }

  static fromEntries<T>(entries: [EntityId, T][]): Store<T> {
    const s = new Store<T>();
    for (const [id, v] of [...entries].sort((a, b) => a[0] - b[0])) s.set(id, v);
    return s;
  }
}
