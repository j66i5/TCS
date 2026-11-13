/**
 * FIRE SUPPORT (M6.5c, pulled forward from M8 by the owner): a unit calls mortar fire — high explosive or
 * smoke — on a point. The call goes out by radio (the order's comms delay), then after the faction's
 * `fireSupport.delaySeconds` the rounds land one every `intervalSeconds`, each scattered about the aim point
 * (normal, `dispersionM` one standard deviation, own random stream). High explosive bursts like any other
 * explosive (blast, fragments, craters, suppression); smoke lays a cloud that blocks sight (spotting) for
 * `smokeSeconds` — not bullets. Each side has an allotment of rounds (`rules.support`).
 *
 * RANGING (step fire-support, owner 2026-11-13): a mission opens with `rangingRounds` single rounds, the first off
 * the point by the battery's aiming error (normal, `rangingErrorM` per axis). When the caller or a man of his
 * platoon sees where one fell (his eyes to a few metres above the burst: terrain, walls, woods, smoke), the error
 * shrinks to
 * `rangingCorrection` of itself; unseen, it stays. `rangingSeconds` later the next ranging round, then the whole
 * battery fires for effect: volleys of `tubes` rounds, `volleySpreadSeconds` apart, every `intervalSeconds`, each
 * round scattered by `dispersionM` about the corrected point. The ranging rounds come out of the section's stock
 * too (rule 9), on top of the rounds asked for while there are enough; short of rounds, the mission gives up
 * ranging rounds first (always one for effect). A point once ranged on, with at least one ranging round seen, is
 * remembered with the error left there: a new mission within `registeredM` fires for effect at once (an unobserved
 * point is not remembered: the next mission there ranges again).
 */
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { secondsToTicks, type EntityId, type SideId } from "../ids";
import { canReport } from "../impair";
import { exp, sqrt } from "../math";
import { nextNormal, Streams } from "../rng";
import { newEntity, type FireMission, type SimState, type SimView } from "../state";
import { addItems, countItems, emptyContainer, removeItems } from "../items";
import { heightAt, standZ } from "../terrain";
import { eyeHeightM, sight } from "../los";
import type { FactionDef } from "../catalog";
import { ammoIndexOf } from "../projectiles";
import { detonate } from "./explosions";
import { noteBeatenZone } from "./morale";

/** Give each side with an allotment its mortar section: an entity whose container holds the rounds. */
export function initSupport(ctx: SimContext, state: SimState): void {
  state.support = [];
  for (const s of ctx.rules.support ?? []) {
    const faction = state.sides.find((x) => x.id === s.side)?.faction;
    const fs = faction ? ctx.catalog.factions[faction]?.fireSupport : undefined;
    if (!fs) continue;
    const battery = newEntity(state);
    const c = emptyContainer();
    if (s.he > 0) addItems(c, fs.heAmmo, s.he);
    if (s.smoke > 0) addItems(c, fs.smokeAmmo, s.smoke);
    state.container.set(battery, c);
    state.support.push({ side: s.side, battery, heType: fs.heAmmo, smokeType: fs.smokeAmmo });
  }
}

/** Rounds the side may still call (counted in its mortar section's container). */
export function supportLeft(state: SimView, side: SideId, ammo: "he" | "smoke"): number {
  const s = state.support.find((x) => x.side === side);
  const c = s ? state.container.get(s.battery) : undefined;
  if (!s || !c) return 0;
  const type = ammo === "he" ? s.heType : s.smokeType;
  let n = 0;
  for (const st of c.stacks) if (st.type === type) n += st.count;
  return n;
}

/** The fire support of a caller's faction (absent: none). */
type FireSupportDef = NonNullable<FactionDef["fireSupport"]>;

/** Seconds from the call reaching the section to the first volley for effect at a point not yet ranged on. */
export function secondsToEffect(fs: FireSupportDef): number {
  return fs.delaySeconds + fs.rangingRounds * fs.rangingSeconds;
}

/** Start a fire mission (from a delivered `callFire` order). False if nobody can call or nothing is left. */
export function callFire(ctx: SimContext, state: SimState, side: SideId, callers: readonly EntityId[], x: number, y: number, ammo: "he" | "smoke", rounds: number): boolean {
  const caller = callers.find((m) => canReport(state.soldier.get(m)));
  const faction = caller !== undefined ? state.identity.get(caller)?.faction : undefined;
  const fs = faction ? ctx.catalog.factions[faction]?.fireSupport : undefined;
  const sec = state.support.find((s) => s.side === side);
  const c = sec ? state.container.get(sec.battery) : undefined;
  if (caller === undefined || !fs || !sec || !c) return false;
  const type = ammo === "he" ? sec.heType : sec.smokeType;
  // Ranging first, unless the section has already ranged on a point this close (its error there is known).
  const r2 = fs.registeredM * fs.registeredM;
  const reg = sec.registered?.find((p) => (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y) <= r2);
  const ranging = reg ? 0 : fs.rangingRounds;
  // The rounds leave the section's stock now (they are fired as the mission runs): the ranging rounds on top of
  // those asked for while there are enough; short, the ranging rounds go first, one always left for effect.
  const n = removeItems(c, type, Math.min(rounds + ranging, countItems(c, type))).reduce((a, st) => a + st.count, 0);
  if (n <= 0) return false;
  const m: FireMission = { side, caller, x, y, ammo, left: n, nextTick: state.tick + secondsToTicks(fs.delaySeconds) };
  const rg = Math.min(ranging, n - 1);
  if (rg > 0) m.ranging = rg;
  if (reg) { m.ex = reg.ex; m.ey = reg.ey; } else if (fs.rangingErrorM > 0) {
    m.ex = fs.rangingErrorM * nextNormal(state.rng, Streams.support);
    m.ey = fs.rangingErrorM * nextNormal(state.rng, Streams.support);
  }
  state.fireMissions.push(m);
  return true;
}

/** Can the man who called the mission see a burst at (x, y)? His eyes (raised to at least kneeling: he lifts his
 *  head to watch the fall of shot) to the dust and smoke cloud a few metres above it, through terrain, walls, roofs
 *  and woods (nearly all of the view gone counts as unseen), and smoke. */
const BURST_SEEN_Z_M = 5;
const BURST_SEEN_VIS = 0.1;
function burstSeen(ctx: SimContext, state: SimState, caller: EntityId, x: number, y: number): boolean {
  const s = state.soldier.get(caller), t = state.transform.get(caller);
  if (!s || !t || !canReport(s)) return false;
  const ez = standZ(ctx.map, t) + Math.max(eyeHeightM(ctx, s.posture), s.mount !== undefined ? 0 : eyeHeightM(ctx, "crouching"));
  const tz = heightAt(ctx.map, x, y) + BURST_SEEN_Z_M; // ground: ok (a burst on the ground, not a man)
  const v = s.mount !== undefined ? s.mount.vehicle : -1;
  let vis = sight(ctx, t.x, t.y, ez, x, y, tz, v).visibility;
  if (vis > 0 && state.smoke.length > 0) {
    const D = ctx.catalog.spotting;
    vis *= smokeTransmission(state, D.smokeExtinctionPerM, t.x, t.y, x, y, secondsToTicks(D.smokeBuildSeconds));
  }
  return vis >= BURST_SEEN_VIS;
}

/**
 * Does anyone see the ranging round fall? The caller first, then any man of his platoon (his top-level unit, in ID
 * order) who can still use the radio: the call goes over the platoon net (game choice, step fire-support).
 */
function rangingSeen(ctx: SimContext, state: SimState, caller: EntityId, x: number, y: number): boolean {
  if (burstSeen(ctx, state, caller, x, y)) return true;
  let top = state.identity.get(caller)?.unit;
  for (let k = 0; top !== undefined && k < 16; k++) { const p = state.unit.get(top)?.parent; if (p === null || p === undefined) break; top = p; }
  if (top === undefined) return false;
  const stack: EntityId[] = [top];
  while (stack.length > 0) {
    const u = state.unit.get(stack.pop()!);
    if (!u) continue;
    for (const m of u.members) if (m !== caller && burstSeen(ctx, state, m, x, y)) return true;
    for (let i = u.children.length - 1; i >= 0; i--) stack.push(u.children[i]!);
  }
  return false;
}

/** One mortar round lands at (x, y): high explosive bursts, smoke lays its cloud. */
function landRound(ctx: SimContext, state: SimState, events: EventSink, fs: FireSupportDef, m: FireMission, x: number, y: number): void {
  if (m.ammo === "he") {
    const idx = ammoIndexOf(ctx.catalog, fs.heAmmo);
    if (idx >= 0) detonate(ctx, state, events, x, y, heightAt(ctx.map, x, y) + 0.05, idx, m.caller); // ground: ok (a mortar bomb on the ground)
    // The enemy near it remember the mission's beaten zone (soldier AI package B).
    noteBeatenZone(ctx, state, x, y, m.side);
  } else {
    state.smoke.push({ x, y, radiusM: fs.smokeRadiusM, startTick: state.tick, untilTick: state.tick + secondsToTicks(fs.smokeSeconds) });
    events.emit({ kind: "support.smoke", tick: state.tick, x, y, radiusM: fs.smokeRadiusM, side: m.side });
  }
}

/** A radio call from the man who called the mission (keys, rule 12). */
function radio(state: SimState, events: EventSink, m: FireMission, key: string, params: Record<string, string | number> = {}): void {
  const u = state.identity.get(m.caller)?.unit;
  events.emit({ kind: "radio", tick: state.tick, side: m.side, from: m.caller, key, params: { callsign: (u !== undefined ? state.unit.get(u)?.callsign : undefined) ?? "", ...params } });
}

/** Remember the point a mission has ranged on, with the error left there (one entry per point, a few per side). */
const REGISTERED_MAX = 6;
function register(state: SimState, fs: FireSupportDef, m: FireMission): void {
  const sec = state.support.find((s) => s.side === m.side);
  if (!sec) return;
  const list = sec.registered ?? (sec.registered = []);
  const r2 = fs.registeredM * fs.registeredM;
  const i = list.findIndex((p) => (p.x - m.x) * (p.x - m.x) + (p.y - m.y) * (p.y - m.y) <= r2);
  if (i >= 0) list.splice(i, 1);
  list.push({ x: m.x, y: m.y, ex: m.ex ?? 0, ey: m.ey ?? 0 });
  if (list.length > REGISTERED_MAX) list.shift();
}

export function supportSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  if (state.smoke.length > 0) state.smoke = state.smoke.filter((c) => c.untilTick > state.tick);
  if (state.fireMissions.length === 0) return;
  const W = ctx.map.widthM, H = ctx.map.heightM;
  for (const m of state.fireMissions) {
    if (m.left <= 0 || state.tick < m.nextTick) continue;
    const faction = state.identity.get(m.caller)?.faction ?? "";
    const fs = ctx.catalog.factions[faction]?.fireSupport;
    if (!fs) { m.left = 0; continue; }
    const ax = m.x + (m.ex ?? 0), ay = m.y + (m.ey ?? 0);
    const x = Math.min(Math.max(ax + fs.dispersionM * nextNormal(state.rng, Streams.support), 1), W - 1);
    const y = Math.min(Math.max(ay + fs.dispersionM * nextNormal(state.rng, Streams.support), 1), H - 1);
    // (A ranging round: seen or not before its own smoke is in the way.)
    const ranging = (m.ranging ?? 0) > 0;
    const seen = ranging && rangingSeen(ctx, state, m.caller, x, y);
    landRound(ctx, state, events, fs, m, x, y);
    m.left--;
    if (ranging) {
      // A ranging round: the caller corrects the aim if he saw where it fell.
      const missM = Math.round(sqrt((x - m.x) * (x - m.x) + (y - m.y) * (y - m.y)));
      if (seen) { m.ex = (m.ex ?? 0) * fs.rangingCorrection; m.ey = (m.ey ?? 0) * fs.rangingCorrection; m.observed = true; }
      m.ranging = m.ranging! - 1;
      events.emit({ kind: "support.ranging", tick: state.tick, side: m.side, caller: m.caller, x, y, tx: m.x, ty: m.y, ammo: m.ammo, seen, missM, left: m.ranging });
      radio(state, events, m, seen ? "radio.fireAdjust" : "radio.fireUnobserved", { miss: missM });
      // Only an observed point is remembered: unseen, the error is still the battery's full one, and a later
      // mission there must range again rather than fire for effect with it.
      if (m.ranging === 0) { delete m.ranging; if (m.observed) register(state, fs, m); }
      m.nextTick = state.tick + Math.max(1, secondsToTicks(fs.rangingSeconds));
      continue;
    }
    // Fire for effect: volleys of the battery's tubes.
    if (m.volley === undefined) {
      m.volley = 0;
      if (m.ex !== undefined) radio(state, events, m, "radio.fireForEffect");
    }
    m.volley++;
    if (m.volley >= fs.tubes) { m.volley = 0; m.nextTick = state.tick + Math.max(1, secondsToTicks(fs.intervalSeconds)); }
    else m.nextTick = state.tick + Math.max(1, secondsToTicks(fs.volleySpreadSeconds));
  }
  state.fireMissions = state.fireMissions.filter((m) => m.left > 0);
}

/**
 * How much of the view survives the smoke along a line (1 = none in the way): exp(-k x metres of smoke). A
 * cloud grows to its full size over `buildTicks` (data: spotting.smokeBuildSeconds).
 */
export function smokeTransmission(state: SimView, k: number, x0: number, y0: number, x1: number, y1: number, buildTicks = 600, only: "all" | "conventional" | "multispectral" = "all"): number {
  if (state.smoke.length === 0 || k <= 0) return 1;
  const dx = x1 - x0, dy = y1 - y0, L2 = dx * dx + dy * dy;
  let metres = 0;
  for (const c of state.smoke) {
    // (M7.3: thermal sights see through ordinary smoke in part, not through a multispectral cloud.)
    if (only !== "all" && (c.multispectral === true) !== (only === "multispectral")) continue;
    const grow = buildTicks > 0 ? Math.min(1, (state.tick - c.startTick) / buildTicks) : 1;
    const r = c.radiusM * (0.3 + 0.7 * grow);
    // Chord of the segment through the circle.
    const fx = x0 - c.x, fy = y0 - c.y;
    const b = fx * dx + fy * dy, cc = fx * fx + fy * fy - r * r;
    if (L2 <= 1e-9) { if (cc <= 0) metres += r; continue; }
    const disc = b * b - L2 * cc;
    if (disc <= 0) continue;
    const s = sqrt(disc);
    const t0 = Math.max(0, (-b - s) / L2), t1 = Math.min(1, (-b + s) / L2);
    if (t1 > t0) metres += (t1 - t0) * sqrt(L2);
  }
  return metres > 0 ? exp(-k * metres) : 1;
}
