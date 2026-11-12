/**
 * Shot helpers shared by every shooter (split out of fire.ts in M7.1a; vehicle stations use them from M7.3):
 * which round comes next off a belt or magazine, putting one round in the air with its aiming error, and the
 * time between rounds of a burst. Behaviour is exactly that of the infantry shooter they came from.
 */
import { dropAt } from "../ballistics";
import type { Catalog, ItemTypeDef, WeaponDef } from "../catalog";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { TICK_HZ, type EntityId } from "../ids";
import { atan2, cos, sin } from "../math";
import { nextNormal, Streams } from "../rng";
import type { SimState } from "../state";
import { launchProjectile } from "./ballistics";

/**
 * The round that comes next off a feed holding `roundsLeft` rounds of item `feedItem`: a belt mixes in a tracer
 * every few rounds. Returns the ammunition id and its muzzle velocity in this weapon (undefined: cannot fire it).
 */
export function pickRound(catalog: Catalog, wd: WeaponDef, feedItem: string, roundsLeft: number): { ammoId: string; v0: number | undefined } {
  const magDef: ItemTypeDef | undefined = catalog.items[feedItem];
  const tracerDue = magDef?.tracerItem !== undefined && magDef.tracerEvery !== undefined && roundsLeft % magDef.tracerEvery === 0 && wd.ammo[magDef.tracerItem] !== undefined;
  const ammoId = (tracerDue ? magDef!.tracerItem : magDef?.chargeItem) ?? "";
  return { ammoId, v0: wd.ammo[ammoId] };
}

/**
 * Fire one round from the muzzle (mx, my, mz) at the point (tx, ty, tz), `range` metres away horizontally, with
 * the sights set for `believedRange`, an error of `errRad` (one standard deviation) in both planes, and emit
 * `shot.fired`. Returns the azimuth the round left at. Draws two normals from the fire stream (azimuth first).
 */
export function launchShot(
  ctx: SimContext, state: SimState, events: EventSink, owner: EntityId, weapon: string, ammoId: string, v0: number,
  mx: number, my: number, mz: number, tz: number, a0: number, range: number, believedRange: number, errRad: number,
  vehicle?: EntityId, tableRangeM = 1500,
): number {
  const e0 = atan2(tz - mz, range) + atan2(dropAt(ctx, ammoId, v0, believedRange, tableRangeM), believedRange);
  const az = a0 + errRad * nextNormal(state.rng, Streams.fire);
  const el = e0 + errRad * nextNormal(state.rng, Streams.fire);
  const ce = cos(el);
  launchProjectile(ctx, state, ammoId, mx, my, mz, v0 * cos(az) * ce, v0 * sin(az) * ce, v0 * sin(el), owner);
  events.emit(vehicle === undefined
    ? { kind: "shot.fired", tick: state.tick, shooter: owner, x: mx, y: my, z: mz, dirX: cos(az), dirY: sin(az), weapon, ammo: ammoId }
    : { kind: "shot.fired", tick: state.tick, shooter: owner, x: mx, y: my, z: mz, dirX: cos(az), dirY: sin(az), weapon, ammo: ammoId, vehicle });
  return az;
}

/** Ticks between two rounds of one burst at the weapon's cyclic rate (at least one tick). */
export function burstCadence(cyclicRpm: number): number {
  return Math.max(1, Math.round((TICK_HZ * 60) / cyclicRpm));
}
