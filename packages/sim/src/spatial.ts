/**
 * Spatial hash of soldiers for neighbourhood queries (SPEC 4.4): "who is within r metres of here?" without
 * looking at everyone. Buckets of `cellM`; rebuilt from the transforms when needed (cheap: one pass).
 * Results are in ascending entity ID, so callers stay deterministic.
 */
import type { EntityId } from "./ids";
import type { SimView } from "./state";

export interface SpatialHash {
  cellM: number;
  buckets: Map<number, EntityId[]>;
}

const key = (c: number, r: number) => c * 65536 + r;

export function buildSpatialHash(state: SimView, cellM = 16): SpatialHash {
  const buckets = new Map<number, EntityId[]>();
  for (const [id, t] of state.transform.entries()) {
    const k = key(Math.floor(t.x / cellM), Math.floor(t.y / cellM));
    const b = buckets.get(k);
    if (b) b.push(id); else buckets.set(k, [id]);
  }
  return { cellM, buckets };
}

/** Entities within `r` metres of (x, y), ascending ID. */
export function queryRadius(h: SpatialHash, state: SimView, x: number, y: number, r: number): EntityId[] {
  const out: EntityId[] = [];
  const c0 = Math.floor((x - r) / h.cellM), c1 = Math.floor((x + r) / h.cellM);
  const r0 = Math.floor((y - r) / h.cellM), r1 = Math.floor((y + r) / h.cellM);
  for (let c = c0; c <= c1; c++) for (let rr = r0; rr <= r1; rr++) {
    for (const id of h.buckets.get(key(c, rr)) ?? []) {
      const t = state.transform.req(id);
      const dx = t.x - x, dy = t.y - y;
      if (dx * dx + dy * dy <= r * r) out.push(id);
    }
  }
  return out.sort((a, b) => a - b);
}
