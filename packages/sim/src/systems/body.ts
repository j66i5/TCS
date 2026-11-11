/**
 * The soldier's body (SPEC 6.2, 6.4): posture changes that take time, and a time-stepped physiology of
 * fatigue and heart rate. Every number comes from `catalog.body` (core/body.json).
 *
 * Exertion (work rate) w: the movement mode's exertion while moving (0 at rest), raised by the load carried
 * relative to body mass and by uphill grade. Above the sustainable rate fatigue builds, below it recovers;
 * heat speeds the build-up. Heart rate approaches a target set by exertion and fatigue with separate rise and
 * fall time constants. Fatigue slows movement (movement.ts) and later aiming and morale.
 */
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { DT, secondsToTicks, type EntityId } from "../ids";
import { containerMassKg } from "../items";
import { clamp, exp } from "../math";
import type { Posture } from "../orders";
import type { SimState } from "../state";

/** Mass of everything a soldier carries, kg. */
export function loadKg(ctx: SimContext, state: SimState, id: EntityId): number {
  const c = state.container.get(id);
  return c ? containerMassKg(ctx.catalog, c) : 0;
}

/** Seconds to go from one posture to another with a given load (owner decision: slower when loaded). */
export function postureChangeSeconds(ctx: SimContext, from: Posture, to: Posture, load: number): number {
  if (from === to) return 0;
  const t = ctx.catalog.body.transitions;
  const base = t.values[`${from}>${to}`] ?? 1;
  return base * (1 + t.slowdownPerKg * Math.max(0, load - t.freeLoadKg));
}

/** Start changing posture (no-op if already there or already changing to it). */
export function requestPosture(ctx: SimContext, state: SimState, id: EntityId, to: Posture): void {
  const s = state.soldier.get(id);
  if (!s) return;
  if (s.postureTo === to || (s.postureTo === null && s.posture === to)) return;
  const secs = postureChangeSeconds(ctx, s.posture, to, loadKg(ctx, state, id));
  s.postureTo = to;
  s.postureDoneTick = state.tick + Math.max(1, secondsToTicks(secs));
}

/** Complete posture changes whose time is up. */
export function postureSystem(_ctx: SimContext, state: SimState, events: EventSink): void {
  for (const [id, s] of state.soldier.entries()) {
    if (s.postureTo !== null && state.tick >= s.postureDoneTick) {
      s.posture = s.postureTo;
      s.postureTo = null;
      events.emit({ kind: "posture.changed", tick: state.tick, soldier: id, posture: s.posture });
    }
  }
}

/** Physiology step, run every tick: fatigue and heart rate from exertion, load, slope and heat. */
export function physiologySystem(ctx: SimContext, state: SimState): void {
  const p = ctx.catalog.body.physiology;
  const heat = 1 + p.heatPerC * Math.max(0, state.environment.temperatureC - p.heatThresholdC);
  const riseK = 1 - exp(-DT / p.hrRiseTauS), fallK = 1 - exp(-DT / p.hrFallTauS);
  for (const [id, s] of state.soldier.entries()) {
    if (!s.physiology.alive) continue;
    const m = state.mover.get(id);
    const mode = m && m.mode !== null && m.speedMps > 0 ? ctx.catalog.movementModes[m.mode] : undefined;
    let w = mode ? mode.exertion : s.postureTo !== null ? 0.3 : 0;
    if (w > 0) {
      w *= 1 + (p.loadExertionK * loadKg(ctx, state, id)) / p.bodyMassKg;
      w *= 1 + p.slopeExertionK * Math.max(0, m ? m.grade : 0);
    }
    const ph = s.physical;
    const d = w > p.sustainable ? (w - p.sustainable) * p.fatigueGainPerS * heat : -(p.sustainable - w) * p.recoveryPerS;
    ph.fatigue = clamp(ph.fatigue + d * DT, 0, 1);
    const target = p.hrRestBpm + (p.hrMaxBpm - p.hrRestBpm) * clamp(0.85 * Math.min(1, w) + 0.25 * ph.fatigue, 0, 1);
    ph.heartRateBpm += (target - ph.heartRateBpm) * (target > ph.heartRateBpm ? riseK : fallK);
  }
}
