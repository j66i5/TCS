/**
 * BATTERIES (M11.6): once a second per man (staggered by id), his powered devices are switched on or off by the light
 * (a night device only below its `onBelowLight`), a battery that has gone flat is reported once (`power.flat`), and a
 * flat battery, or in a lull one nearly flat, is changed for his fullest spare: the action "swapBattery", which takes
 * the device's `swapSeconds` and changes nothing if it is interrupted. The charge itself is never stepped (power.ts).
 * A dead man's or a prisoner's devices are switched off.
 */
import { registerActionHandler, startAction } from "../actions";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { secondsToTicks, staggerFirst, TICK_HZ } from "../ids";
import { isAble } from "../impair";
import { addItems, removeItems } from "../items";
import { chargeAt, fullestSpare, powerOf, settle, stampSlot, wantOn } from "../power";
import type { SimState } from "../state";
import { isGuiding } from "./missile-team";

/** A lull change needs a spare holding at least this share of full more than the fitted battery (game value, low). */
export const LULL_MARGIN_SHARE = 0.25;

/** The action that changes a device's battery. params: { device }. */
export const SWAP_ACTION = "swapBattery";

registerActionHandler(SWAP_ACTION, {
  check(_ctx, state, actor) {
    const s = state.soldier.get(actor);
    if (!isAble(s) || !s!.impair.canUseArms || state.tick < s!.stunnedUntilTick) return "unable";
    return null;
  },
  complete(ctx, state, actor, a, events) {
    const s = state.soldier.get(actor), c = state.container.get(actor);
    const device = String(a.params["device"]);
    const slot = s?.power?.find((x) => x.device === device);
    const pw = powerOf(ctx.catalog, device);
    if (!slot || !pw || !c) return;
    const tick = state.tick;
    const now = chargeAt(slot, tick);
    const best = fullestSpare(c, pw.def.battery);
    if (best <= (slot.battery === null ? 0 : now)) return; // nothing better to fit
    const taken = removeItems(c, pw.def.battery, 1, best)[0];
    if (!taken) return;
    // The spent battery goes back into his load as a counted item, even empty (like an empty magazine).
    const whOut = slot.battery === null ? -1 : settle(now);
    if (slot.battery !== null) addItems(c, slot.battery, 1, whOut);
    slot.battery = taken.type;
    stampSlot(slot, best, wantOn(pw.def, state.environment.light), tick);
    delete slot.flatSent;
    events.emit({ kind: "power.swapped", tick, soldier: actor, device, battery: taken.type, whOut: Math.max(0, whOut), whIn: best });
  },
});

export function powerSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  const tick = state.tick, light = state.environment.light;
  const P = ctx.catalog.behaviour.soldier.power;
  for (let id = staggerFirst(tick, TICK_HZ); id < state.nextEntityId; id += TICK_HZ) {
    const s = state.soldier.get(id);
    if (s?.power === undefined) continue;
    // A dead man's or a prisoner's devices are switched off (no drain, no flat report: review fix 2026-11-16).
    const out = !s.physiology.alive || s.captive !== null;
    let swap: string | null = null;
    for (const slot of s.power) {
      const pw = powerOf(ctx.catalog, slot.device);
      if (!pw) continue;
      if (out) {
        if (slot.on) stampSlot(slot, chargeAt(slot, tick), false, tick);
        continue;
      }
      // On or off by the light (night devices): restamp at the change.
      const on = wantOn(pw.def, light);
      if (on !== slot.on) stampSlot(slot, chargeAt(slot, tick), on, tick);
      const flat = slot.battery === null || (slot.on && tick >= slot.flatTick) || (!slot.on && slot.wh0 <= 0);
      if (flat && slot.battery !== null && slot.flatSent === undefined) {
        slot.flatSent = true;
        const side = state.identity.get(id)?.side;
        if (side !== undefined) events.emit({ kind: "power.flat", tick, soldier: id, device: slot.device, side });
      }
      if (swap !== null) continue;
      const spare = fullestSpare(state.container.get(id), pw.def.battery);
      if (spare <= 0) continue;
      if (flat) swap = slot.device;
      else if (P !== undefined && slot.on && !state.fire.has(id) && (s.mental.behaviour === "steady" || s.mental.behaviour === "cautious")) {
        // In a lull only for a spare clearly fuller (review fix 2026-11-16: no ping-pong between part-used batteries).
        const now = chargeAt(slot, tick);
        if (now < P.swapBelowShare * pw.capWh && spare >= Math.max(P.lullSpareShare * pw.capWh, now + LULL_MARGIN_SHARE * pw.capWh)) swap = slot.device;
      }
    }
    if (swap === null || out || state.action.has(id)) continue;
    if (!isAble(s) || !s.impair.canUseArms || tick < s.stunnedUntilTick || isGuiding(state, id)) continue;
    startAction(state, events, id, SWAP_ACTION, secondsToTicks(powerOf(ctx.catalog, swap)!.def.swapSeconds), { device: swap });
  }
}
