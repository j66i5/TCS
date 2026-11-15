/**
 * ILLUMINATION FLARES GIVE LIGHT (M9.6). A parachute flare (state.flares, M8.4) is a point source of `candela`
 * that sinks at `descentMps` while it burns. At a point on the ground at horizontal distance d below a flare h
 * metres above it, the illuminance is E = candela / (h^2 + d^2) lux (inverse square; the cosine of the incidence
 * angle is left out: a man standing up shows his side to it). The light it gives, on the same 0..1 scale as
 * `environment.light`, is min(night.flareMaxLight, E / night.flareFullLux); several flares: the brightest counts.
 * Pure; plain arithmetic in the light itself (sqrt only via sim/math.ts, for the lit radius).
 */
import type { Catalog } from "./catalog";
import { sqrt } from "./math";
import type { Flare, SimState } from "./state";
import { TICK_HZ } from "./ids";

/** A flare's height (absolute z, m) at `tick`: its ejection height less what it has sunk (not below 0). */
export function flareZ(f: Flare, tick: number): number {
  const z = f.z - (f.descentMps * (tick - f.startTick)) / TICK_HZ;
  return z > 0 ? z : 0;
}

/** Whether a flare burns at `tick`. */
export function flareBurning(f: Flare, tick: number): boolean {
  return tick >= f.startTick && tick < f.untilTick;
}

/**
 * The light (0..1, as `environment.light`) the burning flares give at the ground point (x, y), whose height is `z`
 * (absolute, m; default 0). 0 when no flare burns.
 */
export function flareLightAt(state: SimState, catalog: Catalog, x: number, y: number, z = 0): number {
  const fl = state.flares;
  if (fl === undefined || fl.length === 0) return 0;
  const N = catalog.spotting.night, tick = state.tick;
  let best = 0;
  for (let i = 0; i < fl.length; i++) {
    const f = fl[i]!;
    if (!flareBurning(f, tick)) continue;
    let h = flareZ(f, tick) - z;
    if (h < 0) h = 0;
    const dx = f.x - x, dy = f.y - y, r2 = h * h + dx * dx + dy * dy;
    const e = f.candela / (r2 > 1 ? r2 : 1);
    if (e > best) best = e;
  }
  const light = best / N.flareFullLux;
  return light < N.flareMaxLight ? light : N.flareMaxLight;
}

/**
 * The radius (m) on the ground (height `groundZ`) around the point below a burning flare within which it gives at
 * least `level` of light (0..1); 0 when it gives less even straight below it, or it is not burning. For the renderer.
 */
export function flareLitRadius(catalog: Catalog, f: Flare, tick: number, level: number, groundZ = 0): number {
  if (!flareBurning(f, tick) || level <= 0) return 0;
  const N = catalog.spotting.night;
  if (level > N.flareMaxLight) return 0;
  const h = Math.max(0, flareZ(f, tick) - groundZ);
  const r2 = f.candela / (level * N.flareFullLux) - h * h;
  return r2 > 0 ? sqrt(r2) : 0;
}
