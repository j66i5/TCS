/**
 * PROJECTILE POOL (SPEC 4.3 rule 6, 6.3): every bullet, fragment and shell in flight is one row in a set of
 * typed arrays. No per-tick allocation; the pool doubles when full. Live projectiles occupy rows
 * [0, count); removing one moves the last row into its place (deterministic).
 *
 * Coordinates: x, y in map metres; z is ABSOLUTE height (same datum as the heightfield), unlike soldiers,
 * whose z is height above ground. Velocities in m/s.
 *
 * The pool is part of SimState and serialises to plain arrays of the live rows.
 */
import type { Catalog } from "./catalog";
import type { EntityId } from "./ids";

export interface ProjectilePool {
  count: number;
  x: Float64Array; y: Float64Array; z: Float64Array;
  vx: Float64Array; vy: Float64Array; vz: Float64Array;
  /** Index into catalog.ammoIds. */
  ammo: Uint16Array;
  /** Entity that fired it (0 = none). */
  owner: Int32Array;
  bornTick: Int32Array;
  /**
   * Debug guard (derived, never saved; plan C45): while `inLoop` is set (the projectile loop runs), every add is
   * counted in `loopAdds`, which must stay 0 (adding inside the loop may reallocate the arrays it holds).
   */
  watch?: { inLoop: boolean; loopAdds: number };
}

export function createProjectilePool(capacity = 1024): ProjectilePool {
  return {
    count: 0,
    x: new Float64Array(capacity), y: new Float64Array(capacity), z: new Float64Array(capacity),
    vx: new Float64Array(capacity), vy: new Float64Array(capacity), vz: new Float64Array(capacity),
    ammo: new Uint16Array(capacity), owner: new Int32Array(capacity), bornTick: new Int32Array(capacity),
  };
}

function grow(p: ProjectilePool): void {
  const cap = p.x.length * 2;
  const f = (a: Float64Array) => { const n = new Float64Array(cap); n.set(a); return n; };
  p.x = f(p.x); p.y = f(p.y); p.z = f(p.z); p.vx = f(p.vx); p.vy = f(p.vy); p.vz = f(p.vz);
  const am = new Uint16Array(cap); am.set(p.ammo); p.ammo = am;
  const ow = new Int32Array(cap); ow.set(p.owner); p.owner = ow;
  const bt = new Int32Array(cap); bt.set(p.bornTick); p.bornTick = bt;
}

/** Make room for `extra` more projectiles (so a burst can write its fragments straight into the arrays). */
export function reserveProjectiles(p: ProjectilePool, extra: number): void {
  while (p.count + extra > p.x.length) grow(p);
}

/** Add a projectile. `ammoIndex` is the index into catalog.ammoIds. Returns its row. */
export function addProjectile(
  p: ProjectilePool, ammoIndex: number, x: number, y: number, z: number, vx: number, vy: number, vz: number,
  owner: EntityId, tick: number,
): number {
  if (p.watch !== undefined && p.watch.inLoop) p.watch.loopAdds++;
  if (p.count >= p.x.length) grow(p);
  const i = p.count++;
  p.x[i] = x; p.y[i] = y; p.z[i] = z; p.vx[i] = vx; p.vy[i] = vy; p.vz[i] = vz;
  p.ammo[i] = ammoIndex; p.owner[i] = owner; p.bornTick[i] = tick;
  return i;
}

/** Remove row i by moving the last live row into it. */
export function removeProjectile(p: ProjectilePool, i: number): void {
  const last = --p.count;
  if (i !== last) {
    p.x[i] = p.x[last]!; p.y[i] = p.y[last]!; p.z[i] = p.z[last]!;
    p.vx[i] = p.vx[last]!; p.vy[i] = p.vy[last]!; p.vz[i] = p.vz[last]!;
    p.ammo[i] = p.ammo[last]!; p.owner[i] = p.owner[last]!; p.bornTick[i] = p.bornTick[last]!;
  }
}

export function ammoIndexOf(catalog: Catalog, ammoId: string): number {
  const i = catalog.ammoIds.indexOf(ammoId);
  if (i < 0) throw new Error(`unknown ammunition '${ammoId}'`);
  return i;
}

/** Plain-data form: only the live rows. */
export interface SerializedProjectiles {
  count: number;
  x: number[]; y: number[]; z: number[]; vx: number[]; vy: number[]; vz: number[];
  ammo: number[]; owner: number[]; bornTick: number[];
}

export function serializeProjectiles(p: ProjectilePool): SerializedProjectiles {
  const n = p.count;
  const a = (t: Float64Array | Uint16Array | Int32Array) => Array.from(t.subarray(0, n));
  return { count: n, x: a(p.x), y: a(p.y), z: a(p.z), vx: a(p.vx), vy: a(p.vy), vz: a(p.vz), ammo: a(p.ammo), owner: a(p.owner), bornTick: a(p.bornTick) };
}

export function deserializeProjectiles(s: SerializedProjectiles | undefined): ProjectilePool {
  if (!s) return createProjectilePool();
  let cap = 1024;
  while (cap < s.count) cap *= 2;
  const p = createProjectilePool(cap);
  p.count = s.count;
  p.x.set(s.x); p.y.set(s.y); p.z.set(s.z); p.vx.set(s.vx); p.vy.set(s.vy); p.vz.set(s.vz);
  p.ammo.set(s.ammo); p.owner.set(s.owner); p.bornTick.set(s.bornTick);
  return p;
}
