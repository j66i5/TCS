/**
 * DETECTION (SPEC 6.5, M3.2): who sees whom.
 *
 * Every soldier who is alive and conscious scans once every `scanSeconds` (staggered by ID). For every enemy
 * within range the chance that he sees him in this scan is 1 - exp(-rate x scanSeconds), with
 *   rate = base x (reference range / range)^exponent x exposed size (posture) x movement or firing
 *          x visibility along the line of sight x where he is looking x optic x skill x stress x light.
 * A man already seen is kept at a much higher rate, and forgotten after `forgetSeconds` without a sighting.
 * Visibility comes from the line of sight (M3.1): ground, walls and roofs hide him completely; vegetation
 * thins the view — but a man moving through it shakes the plants and a man firing shows flash and dust, so
 * then at least a floor share of him shows. Every number is in core/spotting.json.
 *
 * Exactly one random draw per observer, target and scan, always, from the "spotting" stream: the line-of-sight
 * check is skipped when the draw could not succeed even with a perfect view, which saves most of the cost.
 */
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { secondsToTicks, TICK_HZ, type EntityId } from "../ids";
import { isAble } from "../impair";
import { eyeHeightM, sight, TARGET_POINT_M } from "../los";
import { atan2, exp, PI, pow, sqrt } from "../math";
import { nextFloat, Streams } from "../rng";
import type { SimState } from "../state";
import { heightAt } from "../terrain";

/** How big an angle (radians, 0..PI) lies between heading `h` and bearing `b`. */
function angleBetween(h: number, b: number): number {
  let d = (b - h) % (2 * PI);
  if (d < 0) d += 2 * PI;
  return d > PI ? 2 * PI - d : d;
}

export function spottingSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  const D = ctx.catalog.spotting, map = ctx.map, tick = state.tick;
  const every = Math.max(1, secondsToTicks(D.scanSeconds));
  const scanS = every / TICK_HZ;
  const front = (D.frontHalfAngleDeg * PI) / 180, side = (D.sideHalfAngleDeg * PI) / 180;
  const light = state.environment.light;
  // Fog: nothing is seen beyond the meteorological visibility.
  const fogR2 = state.environment.visibilityM * state.environment.visibilityM;
  const forget = secondsToTicks(D.forgetSeconds);
  const maxR2 = D.maxRangeM * D.maxRangeM;
  let targets: { id: EntityId; side: string; x: number; y: number; z: number; size: number; motion: number; firing: boolean; moving: boolean; vegTopZ: number }[] | null = null;
  const B = ctx.ballistics;

  for (const [oid, os] of state.soldier.entries()) {
    if ((oid + tick) % every !== 0) continue;
    // Forget what has not been seen for a while, and the dead.
    if (os.seen.length > 0) os.seen = os.seen.filter((e) => tick - e.lastTick <= forget && state.soldier.get(e.target)?.physiology.alive === true);
    if (!isAble(os)) continue;
    const ot = state.transform.get(oid), oi = state.identity.get(oid);
    if (!ot || !oi) continue;
    if (targets === null) {
      targets = [];
      for (const [tid, ts] of state.soldier.entries()) {
        if (!ts.physiology.alive) continue;
        const tt = state.transform.get(tid), ti = state.identity.get(tid);
        if (!tt || !ti) continue;
        const speed = state.mover.get(tid)?.speedMps ?? 0;
        const moving = speed > D.stillBelowMps;
        const firing = tick - (state.weapon.get(tid)?.lastShotTick ?? -1e9) <= secondsToTicks(D.firingWithinSeconds);
        // Top of the vegetation he is in (where moving plants or the flash of his shots show), or -Infinity.
        const g = heightAt(map, tt.x, tt.y);
        const cell = Math.floor(tt.y / map.cellSizeM) * map.cols + Math.floor(tt.x / map.cellSizeM);
        const v = cell >= 0 && cell < map.vegetation.length ? map.vegetation[cell]! : 0;
        const vegTopZ = v > 0 ? g + B.vegHeightM[v - 1]! : -Infinity;
        targets.push({
          vegTopZ,
          id: tid, side: ti.side, x: tt.x, y: tt.y, z: g + TARGET_POINT_M[ts.posture],
          size: D.postureSize[ts.posture], moving, firing,
          motion: (firing ? D.firingFactor : 1) * (!moving ? 1 : speed > D.runningAboveMps ? D.runningFactor : D.movingFactor),
        });
      }
    }
    const ez = heightAt(map, ot.x, ot.y) + eyeHeightM(ctx, os.posture);
    const skill = os.skills["observation"] ?? os.skills["marksmanship"] ?? 0.5;
    const own = Math.max(0.2, 1 + D.skillSlope * (skill - 0.5)) * Math.max(0, 1 - D.stressK * Math.max(os.mental.stress, os.mental.suppression));
    // His sensors: his eyes, his weapon's sight, anything he carries that he looks through (night vision).
    const sensors = [D.sensors["eye"]];
    const sightKind = ctx.catalog.weapons[state.weapon.get(oid)?.weapon ?? ""]?.sights[0]?.kind;
    if (sightKind !== undefined) sensors.push(D.sensors[sightKind]);
    const box = state.container.get(oid);
    if (box) for (const st of box.stacks) { const k = ctx.catalog.items[st.type]?.sensor; if (k !== undefined && st.count > 0) sensors.push(D.sensors[k]); }
    for (const tg of targets) {
      if (tg.side === oi.side || tg.id === oid) continue;
      const dx = tg.x - ot.x, dy = tg.y - ot.y, d2 = dx * dx + dy * dy;
      if (d2 > maxR2 || d2 > fogR2) continue;
      const dist = sqrt(d2);
      let sensor = 0;
      for (const sn of sensors) if (sn) { const f = (dist >= sn.fromM ? sn.factor : 1) * Math.max(D.lightFloor, light, sn.nightLight); if (f > sensor) sensor = f; }
      const idx = os.seen.findIndex((e) => e.target === tg.id);
      const look = angleBetween(ot.heading, atan2(dy, dx));
      const view = look <= front ? 1 : look <= side ? D.sideFactor : D.rearFactor;
      let rate = D.baseRatePerS * pow(D.referenceRangeM / Math.max(D.minRangeM, dist), D.rangeExponent) * tg.size * tg.motion * view * own * sensor;
      if (idx >= 0) rate *= D.keepRateFactor;
      const u = nextFloat(state.rng, Streams.spotting);
      if (u >= 1 - exp(-rate * scanS)) continue; // could not succeed even with a perfect view
      // He can only keep track of so many: a new one only if nearer than the farthest he watches (checked
      // before the costly sight line: it could not be taken on anyway).
      let far = -1;
      if (idx < 0 && os.seen.length >= D.maxTracked) {
        let farD = -1;
        for (let q = 0; q < os.seen.length; q++) {
          const xt = state.transform.get(os.seen[q]!.target);
          const dq = xt ? (xt.x - ot.x) * (xt.x - ot.x) + (xt.y - ot.y) * (xt.y - ot.y) : Infinity;
          if (dq > farD) { farD = dq; far = q; }
        }
        if (farD <= d2) continue;
      }
      const sg = sight(ctx, ot.x, ot.y, ez, tg.x, tg.y, tg.z);
      if (sg.blockedBy !== null) continue;
      let vis = sg.visibility;
      // Moving through vegetation shakes the plants above him, firing shows flash and dust: seen if the line to
      // the top of the vegetation over him is clear (not through a wood between).
      if ((tg.firing || tg.moving) && tg.vegTopZ > tg.z) {
        const top = sight(ctx, ot.x, ot.y, ez, tg.x, tg.y, tg.vegTopZ + 0.1);
        if (top.blockedBy === null) vis = Math.max(vis, (tg.firing ? D.firingVisibilityFloor : D.movingVisibilityFloor) * top.visibility);
      }
      if (vis < D.minVisibility) vis = 0;
      if (u >= 1 - exp(-rate * vis * scanS)) continue;
      if (idx >= 0) { os.seen[idx]!.lastTick = tick; continue; }
      if (far >= 0) os.seen.splice(far, 1);
      os.seen.push({ target: tg.id, firstTick: tick, lastTick: tick });
      os.seen.sort((a, b) => a.target - b.target);
      events.emit({ kind: "spotted", tick, observer: oid, target: tg.id, side: oi.side, rangeM: dist });
    }
  }
}
