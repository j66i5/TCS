/**
 * AFTER THE BATTLE: ROLE 1 OUTCOME AND THE END-OF-BATTLE SETTLEMENT (SPEC 9.1 "evacuated casualties' outcome"; M10.6b).
 * Owner answers: realistic delays, and whoever is still waiting at the end is settled by an end-of-battle roll (Q-1e);
 * the side holding the ground evacuates, wounded on enemy-held ground are captured and treated (Q-10); recovery for
 * the campaign in days from wound severity and treatment (Q-16, plan default). All numbers: core/medical.json `role1`.
 *
 * `handOver` settles one wounded man as he is handed over (an ambulance or a combat vehicle leaving the map, M10.6a/b;
 * or at the end): he reaches Role 1 (or the captor's aid post) at `role1Tick`; whether he dies of his wounds there or
 * later is drawn (the "medical" stream) from his condition as he leaves — shock, blood lost, oxygen debt,
 * consciousness, his worst wound — and how late he reaches Role 1 after the first wound (past the golden hour,
 * `chain.role1S`); his recovery days from his worst wound, a broken bone, untreated bleeding, lateness and a limb lost
 * to a tourniquet. The result is `SoldierState.aftercare`; the roster record carries it (`recoveryDays`,
 * `diedOfWoundsTick`). `settleBattle` runs once, on the tick the battle ends: every living wounded man not yet handed
 * over is settled by who holds the ground where he lies. Same rules for every side; no faction in code.
 */
import type { SoldierState } from "../components";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { secondsToTicks, ticksToSeconds, type EntityId, type SideId } from "../ids";
import { isAble } from "../impair";
import { needsEvacuation } from "../medical";
import { isAssetUnit, isOffMapMan } from "../offmap";
import { nextFloat, nextRange, Streams } from "../rng";
import type { SimState } from "../state";
import { amputationChance, healthyPhysiology } from "../wounds";
import { pow } from "../math";

/** The first wound's tick (his own tick if he has none). */
function firstWoundTick(s: SoldierState, tick: number): number {
  let t = tick;
  for (const w of s.wounds) t = Math.min(t, w.tickInflicted);
  return t;
}

/**
 * The chance that this man dies of his wounds after reaching care at `role1Tick` (core/medical.json `role1.dow`).
 * Pure: the condition he is in now, how late care comes, whose care.
 */
export function diedOfWoundsChance(ctx: SimContext, s: SoldierState, role1Tick: number, by: "own" | "captor"): number {
  const R = ctx.catalog.medical?.role1;
  if (!R) return 0;
  const D = R.dow, p = s.physiology, normal = healthyPhysiology().bloodVolumeL;
  const lost = Math.min(1, Math.max(0, (normal - p.bloodVolumeL) / normal));
  let worst = 0;
  for (const w of s.wounds) worst = Math.max(worst, w.severity);
  let x = D.base + D.shockK * p.shock + D.bloodK * lost + D.respK * p.respiratory + D.unconsciousK * (1 - p.consciousness) + D.severityK * worst;
  const lateH = Math.max(0, ticksToSeconds(role1Tick - firstWoundTick(s, role1Tick)) - ctx.catalog.medical!.chain.role1S) / 3600;
  x *= 1 + D.lateKPerH * lateH;
  if (by === "captor") x *= D.captorFactor;
  return Math.min(D.max, Math.max(0, x));
}

/**
 * Settle his outcome beyond the battle now (see the header): reaching care at `role1Tick`. Draws from the "medical"
 * stream in a fixed order (death, its delay, the recovery band, a broken bone, each tourniquet). Emits `medical.role1`.
 */
export function handOver(ctx: SimContext, state: SimState, events: EventSink, sid: EntityId, by: "own" | "captor", fromTick: number, extraS = 0): void {
  const M = ctx.catalog.medical, R = M?.role1;
  const s = state.soldier.get(sid);
  if (!M || !R || !s || s.aftercare !== undefined || !s.physiology.alive || s.wounds.length === 0) return;
  const role1Tick = fromTick + secondsToTicks(extraS + (by === "captor" ? R.captiveTransferS : R.transferS));
  const rng = state.rng, ST = Streams.medical;
  const dies = nextFloat(rng, ST) < diedOfWoundsChance(ctx, s, role1Tick, by);
  let dowTick: number | undefined;
  if (dies) {
    const u = nextFloat(rng, ST);
    const h = R.dow.delayMinH * pow(R.dow.delayMaxH / Math.max(1e-6, R.dow.delayMinH), u);
    dowTick = role1Tick + secondsToTicks(h * 3600);
  }
  // Recovery days: his worst wound's band, a broken bone, untreated bleeding, lateness, a limb lost.
  const C = R.recovery;
  let worst = 0, fracture = false, untreated = false;
  for (const w of s.wounds) {
    worst = Math.max(worst, w.severity);
    if (w.fracture) fracture = true;
    if (w.treatments.length === 0 && (w.bleedingLps > 0 || w.compressible) && w.severity >= C.bands[0]!.upTo) untreated = true;
  }
  const band = C.bands.find((b) => worst <= b.upTo) ?? C.bands[C.bands.length - 1]!;
  let days = nextRange(rng, ST, band.minD, band.maxD);
  if (fracture) days += nextRange(rng, ST, C.fractureMinD, C.fractureMaxD);
  if (untreated) days *= C.untreatedFactor;
  const late = ticksToSeconds(role1Tick - firstWoundTick(s, role1Tick)) > M.chain.role1S;
  if (late) days *= C.lateFactor;
  // A limb kept under a tourniquet until surgery (an hour or so after Role 1: chain.surgeryS - role1S) may be lost.
  let limbLost = false;
  const toSurgeryS = ticksToSeconds(role1Tick - state.tick) + Math.max(0, M.chain.surgeryS - M.chain.role1S);
  for (const w of s.wounds) {
    if (w.tourniquetS === undefined) continue;
    if (nextFloat(rng, ST) < amputationChance(w.tourniquetS + toSurgeryS, ctx.physiologyParams)) limbLost = true;
  }
  if (limbLost) days += C.amputationD;
  const recoveryDays = dies ? 0 : Math.max(1, Math.round(days));
  s.aftercare = { role1Tick, by, recoveryDays, ...(dowTick !== undefined ? { diedOfWoundsTick: dowTick } : {}), ...(limbLost ? { limbLost: true as const } : {}) };
  const ident = state.identity.get(sid);
  events.emit({
    kind: "medical.role1", tick: state.tick, casualty: sid, side: ident!.side, by, role1Tick, woundedTick: firstWoundTick(s, state.tick), inTime: !late,
    recoveryDays, ...(dowTick !== undefined ? { diedOfWoundsTick: dowTick } : {}), ...(s.triage ? { cat: s.triage.cat } : {}),
  });
}

/** The side holding the ground at (x, y): more able men within `holdM`, else the nearest able man's; null: nobody. */
function holderAt(able: readonly { side: SideId; x: number; y: number }[], x: number, y: number, holdM: number): SideId | null {
  const count = new Map<SideId, number>();
  let near: SideId | null = null, nd = Infinity;
  const r2 = holdM * holdM;
  for (const a of able) {
    const d = (a.x - x) * (a.x - x) + (a.y - y) * (a.y - y);
    if (d <= r2) count.set(a.side, (count.get(a.side) ?? 0) + 1);
    if (d < nd) { nd = d; near = a.side; }
  }
  let best: SideId | null = null, bn = 0, tie = false;
  for (const [sd, n] of [...count.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (n > bn) { best = sd; bn = n; tie = false; } else if (n === bn) tie = true;
  }
  return best !== null && !tie ? best : near;
}

/**
 * The end-of-battle settlement (owner Q-1e, Q-10): on the tick the battle ends, every living wounded man of the force
 * not yet handed over is settled. A prisoner is treated by his captors. A man who needs taking back (or lies at a
 * nest): the side holding the ground where he lies (`holdM`) evacuates him if it is his own (he reaches an ambulance
 * after `settleDelayS`), else he is captured and treated. A walking wounded man who can still fight stays with his
 * unit; his wounds are seen to after the battle (the same delay). Emits `medical.settled` and `medical.role1`.
 */
export function settleBattle(ctx: SimContext, state: SimState, events: EventSink): void {
  const R = ctx.catalog.medical?.role1;
  if (!R) return;
  const pos = (id: EntityId): { x: number; y: number } | undefined => {
    const s = state.soldier.get(id);
    const vid = s?.mount?.vehicle;
    return state.transform.get(vid !== undefined ? vid : id);
  };
  const able: { side: SideId; x: number; y: number }[] = [];
  // mounted: ok a man aboard holds the ground where his hull stands
  for (const [id, ident] of state.identity.entries()) {
    const s = state.soldier.get(id);
    if (!s || !isAble(s) || isAssetUnit(state, ident.unit) || isOffMapMan(state, s)) continue;
    const t = pos(id);
    if (t) able.push({ side: ident.side, x: t.x, y: t.y });
  }
  // mounted: ok the wounded aboard a hull are settled where it stands
  for (const [id, ident] of state.identity.entries()) {
    const s = state.soldier.get(id);
    if (!s || !s.physiology.alive || !hasBattleWound(s) || s.aftercare !== undefined || s.evacuated !== undefined) continue;
    if (isAssetUnit(state, ident.unit)) continue;
    const side = ident.side;
    if (s.captive !== null) {
      handOver(ctx, state, events, id, "captor", state.tick);
      events.emit({ kind: "medical.settled", tick: state.tick, casualty: id, side, outcome: "prisoner" });
      continue;
    }
    // Aboard a hull off the map (a rear run's hand-over not reached yet): his own side takes him on.
    const off = isOffMapMan(state, s);
    if (!off && !needsEvacuation(s) && s.atNest === undefined) {
      handOver(ctx, state, events, id, "own", state.tick, R.settleDelayS);
      events.emit({ kind: "medical.settled", tick: state.tick, casualty: id, side, outcome: "stays" });
      continue;
    }
    const t = pos(id);
    const holder = off || !t ? side : holderAt(able, t.x, t.y, R.holdM) ?? side;
    if (holder === side) {
      s.evacuated = { tick: state.tick, via: "end" };
      delete s.atNest; delete s.evacOrdered; delete s.evacRetryTick;
      handOver(ctx, state, events, id, "own", state.tick, R.settleDelayS);
      events.emit({ kind: "medical.settled", tick: state.tick, casualty: id, side, outcome: "evacuated" });
    } else {
      // Left on ground the enemy holds: captured where he lies, and treated by his captors.
      s.captive = { state: "captured", tick: state.tick };
      delete s.atNest; delete s.evacOrdered; delete s.evacRetryTick;
      handOver(ctx, state, events, id, "captor", state.tick);
      events.emit({ kind: "medical.settled", tick: state.tick, casualty: id, side, outcome: "captured", holder });
    }
  }
}

/**
 * Has he a wound of this battle that needs seeing to (review fix)? A bruise under body armour (`blunt`) does not, and
 * wounds his roster record brought in were settled in their own battle.
 */
export function hasBattleWound(s: Pick<SoldierState, "wounds" | "rosterIn">): boolean {
  for (let i = s.rosterIn?.wounds ?? 0; i < s.wounds.length; i++) if (s.wounds[i]!.mechanism !== "blunt") return true;
  return false;
}

/** Is this man counted as having died of his wounds after the battle (M10.6b)? */
export function diedOfWounds(s: Pick<SoldierState, "aftercare">): boolean {
  return s.aftercare?.diedOfWoundsTick !== undefined;
}
