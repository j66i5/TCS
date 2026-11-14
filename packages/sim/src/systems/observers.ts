/**
 * OBSERVERS (M8.2b): who can watch the fall of shot for a fire mission, and how well they read it.
 *
 * An observer is a man on foot (his eyes, raised to at least kneeling to watch the fall), a crewman looking through
 * his seat's sight (from where it sits on the hull or turret; a laser rangefinder if the sight or station has one),
 * or — reserved for M9.5 — a drone's camera (`kind: "drone"`, no producer yet). The mission's observers are the caller
 * first, then every man of his platoon who can still use the radio, in ID order (the call goes over the platoon net).
 *
 * Reading a fall: a seen ranging round lets the battery take off all but `rangingCorrection` x `skillFactor` of the
 * error left, plus the observer's own reading error (one standard deviation per axis, m): `adjust.readBaseM` +
 * `adjust.readPerM` x his distance to the burst, or `adjust.laserReadM` with a laser, both x `skillFactor`. The
 * skill factor runs from `adjust.skillWorst` (skill 0) to `adjust.skillBest` (skill 1): a skilled observer
 * converges faster and closer.
 */
import type { SimContext } from "../context";
import type { EntityId } from "../ids";
import { canReport } from "../impair";
import { cos, sin, sqrt } from "../math";
import type { SimState } from "../state";
import { heightAt, standZ } from "../terrain";
import { eyeHeightM, sight } from "../los";
import type { FactionDef } from "../catalog";
import { smokePhysics, smokeTransmission } from "../smoke";

type FireSupportDef = NonNullable<FactionDef["fireSupport"]>;

export type ObserverKind = "man" | "vehicle" | "drone";
/** One observer now: where his eye (or sight, or camera) is, what to look past (his own hull), his skill, a laser. */
export interface Observer { kind: ObserverKind; who: EntityId; x: number; y: number; z: number; ignore: EntityId; skill: number; laser: boolean }

/** A man as an observer now (null: he cannot report). Aboard, the crew look through their seat's sight; a
 *  passenger (no sight of his own) looks out as best he can from the hull's middle. */
export function observerOf(ctx: SimContext, state: SimState, who: EntityId): Observer | null {
  const s = state.soldier.get(who);
  if (!s || !canReport(s)) return null;
  const skill = s.skills["observation"] ?? s.skills["experience"] ?? 0.5;
  if (s.mount !== undefined) {
    const t = state.transform.get(s.mount.vehicle), v = state.vehicle.get(s.mount.vehicle);
    const def = v ? ctx.catalog.vehicles[v.def] : undefined, seat = def?.seats[s.mount.seat];
    if (!t || !def || !seat) return null;
    const sn = seat.sensors?.[0];
    const p = sn?.pos ?? seat.pos;
    const c = cos(t.heading), si = sin(t.heading);
    const laser = seat.sensors?.some((x) => x.lrf === true) === true || def.stations.some((st) => st.rangefinder && st.operator === seat.station);
    return { kind: sn ? "vehicle" : "man", who, x: t.x + c * p[0] - si * p[1], y: t.y + si * p[0] + c * p[1], z: heightAt(ctx.map, t.x, t.y) + p[2], ignore: s.mount.vehicle, skill, laser }; // ground: ok (a vehicle sight)
  }
  const t = state.transform.get(who);
  if (!t) return null;
  const c = state.container.get(who);
  const laser = c !== undefined && c.stacks.some((st) => st.count > 0 && ctx.catalog.items[st.type]?.rangefinder === true);
  return { kind: "man", who, x: t.x, y: t.y, z: standZ(ctx.map, t) + Math.max(eyeHeightM(ctx, s.posture), eyeHeightM(ctx, "crouching")), ignore: -1, skill, laser };
}

/** The mission's observers: the caller first, then the men of his platoon (his top-level unit, in ID order) who can
 *  still report. (M9.5: a drone feed joins here.) */
export function observersFor(ctx: SimContext, state: SimState, caller: EntityId): Observer[] {
  const out: Observer[] = [];
  const first = observerOf(ctx, state, caller);
  if (first) out.push(first);
  let top = state.identity.get(caller)?.unit;
  for (let k = 0; top !== undefined && k < 16; k++) { const p = state.unit.get(top)?.parent; if (p === null || p === undefined) break; top = p; }
  if (top === undefined) return out;
  const stack: EntityId[] = [top];
  while (stack.length > 0) {
    const u = state.unit.get(stack.pop()!);
    if (!u) continue;
    for (const m of u.members) if (m !== caller) { const o = observerOf(ctx, state, m); if (o) out.push(o); }
    for (let i = u.children.length - 1; i >= 0; i--) stack.push(u.children[i]!);
  }
  return out;
}

/** Can this observer see a burst at (x, y)? To the dust and smoke cloud a few metres above it, through terrain,
 *  walls, roofs and woods (nearly all of the view gone counts as unseen), and smoke. */
const BURST_SEEN_Z_M = 5;
const BURST_SEEN_VIS = 0.1;
export function observerSees(ctx: SimContext, state: SimState, o: Observer, x: number, y: number): boolean {
  const tz = heightAt(ctx.map, x, y) + BURST_SEEN_Z_M; // ground: ok (a burst on the ground, not a man)
  let vis = sight(ctx, o.x, o.y, o.z, x, y, tz, o.ignore).visibility;
  if (vis > 0 && state.smoke.length > 0) vis *= smokeTransmission(state, smokePhysics(ctx.catalog), o.x, o.y, o.z, x, y, tz);
  return vis >= BURST_SEEN_VIS;
}

/** The observer's skill factor on the correction and his reading error (1 = an average observer, skill 0.5). */
export function adjustSkillFactor(fs: FireSupportDef, skill: number): number {
  const a = fs.adjust;
  if (!a) return 1;
  const k = Math.min(1, Math.max(0, skill));
  return a.skillWorst + (a.skillBest - a.skillWorst) * k;
}

/** His reading error of a fall `distM` away (one standard deviation per axis, m). */
export function readErrorM(fs: FireSupportDef, o: Pick<Observer, "skill" | "laser">, distM: number): number {
  const a = fs.adjust;
  if (!a) return 0;
  return (o.laser ? a.laserReadM : a.readBaseM + a.readPerM * distM) * adjustSkillFactor(fs, o.skill);
}

/** Of the observers who see the fall at (x, y), the one who reads it best (the smallest reading error; the caller
 *  first among equals); null if nobody sees it. */
export function bestObserverOf(ctx: SimContext, state: SimState, fs: FireSupportDef, obs: readonly Observer[], x: number, y: number): Observer | null {
  let best: Observer | null = null, bestErr = Infinity;
  for (const o of obs) {
    const d = sqrt((o.x - x) * (o.x - x) + (o.y - y) * (o.y - y));
    const e = readErrorM(fs, o, d) * (fs.rangingCorrection * adjustSkillFactor(fs, o.skill) + 1);
    if (e >= bestErr) continue;
    if (!observerSees(ctx, state, o, x, y)) continue;
    best = o; bestErr = e;
  }
  return best;
}
