/**
 * COMMUNICATION STATE INTERFACE (SPEC 6.5, 9.5).
 *
 * All order delivery and (from M3) all contact sharing pass through a CommsModel. The foundations use a
 * simple fixed delay. The command & electronic-warfare extension replaces the model (radio nets, runners,
 * jamming, battle management systems) without touching the callers.
 */
import type { Catalog } from "./catalog";
import type { CommState } from "./components";
import { compCondition } from "./mount";
import type { EntityId } from "./ids";
import { secondsToTicks } from "./ids";
import type { Order } from "./orders";
import { nextFloat, Streams } from "./rng";
import type { SimState } from "./state";

export interface CommsParams {
  /** Base delay from the issuing headquarters to a unit on the radio net, seconds. */
  orderDelaySeconds: number;
  /** Random extra delay, uniform in [0, this], seconds: radio traffic, the leader being busy. */
  orderDelayJitterSeconds: number;
  /** Delay for contact reports shared by radio, seconds (used from M3). */
  contactShareDelaySeconds: number;
  /** Voice range for shouted orders / contacts, metres (used from M3). */
  voiceRangeM: number;
}

export const DEFAULT_COMMS: CommsParams = {
  orderDelaySeconds: 1,
  orderDelayJitterSeconds: 1,
  contactShareDelaySeconds: 5,
  voiceRangeM: 40,
};

export interface CommsModel {
  readonly id: string;
  /** Recompute the comm state of every unit (called once per second of game time). */
  /** Once a second. `catalog` (M7.4b) lets the model read vehicle radios; absent in old callers. */
  update(state: SimState, params: CommsParams, catalog?: Catalog): void;
  /** Ticks between an order being received and it reaching the target. `null` = cannot be delivered now. */
  orderDelayTicks(state: SimState, params: CommsParams, order: Order): number | null;
  /** Ticks for a contact report to travel from one soldier to another (0 = within shouting distance).
   *  `null` = no path. */
  contactShareDelayTicks(state: SimState, params: CommsParams, from: EntityId, to: EntityId): number | null;
}

function unitOf(state: SimState, target: EntityId): EntityId | null {
  if (state.unit.has(target)) return target;
  return state.identity.get(target)?.unit ?? null;
}

/** Foundations model: every unit is on the radio net; delays are constants from the scenario rules. */
export const simpleComms: CommsModel = {
  id: "simple",
  update(state, _params, catalog) {
    for (const [, u] of state.unit.entries()) {
      const c: CommState = u.comms;
      c.link = "radio";
    }
    // A wrecked radio (M7.4b, plan C63): its crew is off the net; so is a unit whose men are all aboard it.
    if (!catalog || state.vehicle.size === 0) return;
    for (const [vid, v] of state.vehicle.entries()) {
      const def = catalog.vehicles[v.def];
      if (!def?.components || compCondition(v, def, "radio") > 0) continue;
      if (v.unit !== null) { const u = state.unit.get(v.unit); if (u) u.comms.link = "none"; }
      for (const [, u] of state.unit.entries()) {
        if (u.vehicle !== undefined || u.members.length === 0) continue;
        let aboard = 0, alive = 0;
        for (const m of u.members) {
          const s = state.soldier.get(m);
          if (!s || !s.physiology.alive) continue;
          alive++;
          if (s.mount?.vehicle === vid) aboard++;
        }
        if (alive > 0 && aboard === alive) u.comms.link = "none";
      }
    }
  },
  orderDelayTicks(state, params, order) {
    const u = unitOf(state, order.target);
    const unit = u === null ? undefined : state.unit.get(u);
    if (!unit || unit.comms.link === "none") return null;
    const jitter = params.orderDelayJitterSeconds > 0 ? nextFloat(state.rng, Streams.comms) * params.orderDelayJitterSeconds : 0;
    return secondsToTicks(params.orderDelaySeconds + jitter + unit.comms.extraDelaySeconds);
  },
  contactShareDelayTicks(state, params, from, to) {
    // Within voice range: shouted (no delay from the model; the caller adds the time to say it). Otherwise by
    // radio, if both men's units are on the net.
    // Aboard the same vehicle: the intercom (M7.2). Between a man aboard and one outside: only the radio.
    const ma = state.soldier.get(from)?.mount, mb = state.soldier.get(to)?.mount;
    if (ma && mb && ma.vehicle === mb.vehicle) return 0;
    const a = state.transform.get(from), b = state.transform.get(to);
    if (ma === undefined && mb === undefined && a && b && (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y) <= params.voiceRangeM * params.voiceRangeM) return 0;
    const ua = state.unit.get(state.identity.get(from)?.unit ?? -1), ub = state.unit.get(state.identity.get(to)?.unit ?? -1);
    if (!ua || !ub || ua.comms.link === "none" || ub.comms.link === "none") return null;
    return secondsToTicks(params.contactShareDelaySeconds + ua.comms.extraDelaySeconds + ub.comms.extraDelaySeconds);
  },
};

export const COMMS_MODELS: Record<string, CommsModel> = { simple: simpleComms };
