/**
 * FIRE SUPPORT (M6.5c, pulled forward from M8 by the owner): a unit calls mortar fire — high explosive or
 * smoke — on a point. The call goes out by radio (the order's comms delay), then after the faction's
 * `fireSupport.delaySeconds` the rounds land one every `intervalSeconds`, each scattered about the aim point
 * (normal, `dispersionM` one standard deviation, own random stream). High explosive bursts like any other
 * explosive (blast, fragments, craters, suppression); smoke lays a cloud that blocks sight (spotting) for
 * `smokeSeconds` — not bullets. Each side has an allotment of rounds (`rules.support`).
 */
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { secondsToTicks, type EntityId, type SideId } from "../ids";
import { canReport } from "../impair";
import { exp, sqrt } from "../math";
import { nextNormal, Streams } from "../rng";
import { newEntity, type SimState, type SimView } from "../state";
import { addItems, countItems, emptyContainer, removeItems } from "../items";
import { heightAt } from "../terrain";
import { ammoIndexOf } from "../projectiles";
import { detonate } from "./explosions";

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

/** Start a fire mission (from a delivered `callFire` order). False if nobody can call or nothing is left. */
export function callFire(ctx: SimContext, state: SimState, side: SideId, callers: readonly EntityId[], x: number, y: number, ammo: "he" | "smoke", rounds: number): boolean {
  const caller = callers.find((m) => canReport(state.soldier.get(m)));
  const faction = caller !== undefined ? state.identity.get(caller)?.faction : undefined;
  const fs = faction ? ctx.catalog.factions[faction]?.fireSupport : undefined;
  const sec = state.support.find((s) => s.side === side);
  const c = sec ? state.container.get(sec.battery) : undefined;
  if (caller === undefined || !fs || !sec || !c) return false;
  const type = ammo === "he" ? sec.heType : sec.smokeType;
  // The rounds leave the section's stock now (they are fired as the mission runs).
  const n = removeItems(c, type, Math.min(rounds, countItems(c, type))).reduce((a, st) => a + st.count, 0);
  if (n <= 0) return false;
  state.fireMissions.push({ side, caller, x, y, ammo, left: n, nextTick: state.tick + secondsToTicks(fs.delaySeconds) });
  return true;
}

export function supportSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  if (state.smoke.length > 0) state.smoke = state.smoke.filter((c) => c.untilTick > state.tick);
  if (state.fireMissions.length === 0) return;
  for (const m of state.fireMissions) {
    if (m.left <= 0 || state.tick < m.nextTick) continue;
    const faction = state.identity.get(m.caller)?.faction ?? "";
    const fs = ctx.catalog.factions[faction]?.fireSupport;
    if (!fs) { m.left = 0; continue; }
    const W = ctx.map.widthM, H = ctx.map.heightM;
    const x = Math.min(Math.max(m.x + fs.dispersionM * nextNormal(state.rng, Streams.support), 1), W - 1);
    const y = Math.min(Math.max(m.y + fs.dispersionM * nextNormal(state.rng, Streams.support), 1), H - 1);
    if (m.ammo === "he") {
      const idx = ammoIndexOf(ctx.catalog, fs.heAmmo);
      if (idx >= 0) detonate(ctx, state, events, x, y, heightAt(ctx.map, x, y) + 0.05, idx, m.caller); // ground: ok (a mortar bomb on the ground)
    } else {
      state.smoke.push({ x, y, radiusM: fs.smokeRadiusM, startTick: state.tick, untilTick: state.tick + secondsToTicks(fs.smokeSeconds) });
      events.emit({ kind: "support.smoke", tick: state.tick, x, y, radiusM: fs.smokeRadiusM, side: m.side });
    }
    m.left--;
    m.nextTick = state.tick + Math.max(1, secondsToTicks(fs.intervalSeconds));
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
