/**
 * COMMUNICATION STATE INTERFACE (SPEC 6.5, 9.5).
 *
 * All order delivery and (from M3) all contact sharing pass through a CommsModel. The foundations use a
 * simple fixed delay. The command & electronic-warfare extension replaces the model (radio nets, runners,
 * jamming, battle management systems) without touching the callers.
 */
import type { CommState } from "./components";
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
  update(state: SimState, params: CommsParams): void;
  /** Ticks between an order being received and it reaching the target. `null` = cannot be delivered now. */
  orderDelayTicks(state: SimState, params: CommsParams, order: Order): number | null;
  /** Ticks for a contact report to travel from one soldier to another. `null` = no path (used from M3). */
  contactShareDelayTicks(state: SimState, params: CommsParams, from: EntityId, to: EntityId): number | null;
}

function unitOf(state: SimState, target: EntityId): EntityId | null {
  if (state.unit.has(target)) return target;
  return state.identity.get(target)?.unit ?? null;
}

/** Foundations model: every unit is on the radio net; delays are constants from the scenario rules. */
export const simpleComms: CommsModel = {
  id: "simple",
  update(state) {
    for (const [, u] of state.unit.entries()) {
      const c: CommState = u.comms;
      c.link = "radio";
    }
  },
  orderDelayTicks(state, params, order) {
    const u = unitOf(state, order.target);
    const unit = u === null ? undefined : state.unit.get(u);
    if (!unit || unit.comms.link === "none") return null;
    const jitter = params.orderDelayJitterSeconds > 0 ? nextFloat(state.rng, Streams.comms) * params.orderDelayJitterSeconds : 0;
    return secondsToTicks(params.orderDelaySeconds + jitter + unit.comms.extraDelaySeconds);
  },
  contactShareDelayTicks(_state, params) {
    return secondsToTicks(params.contactShareDelaySeconds);
  },
};

export const COMMS_MODELS: Record<string, CommsModel> = { simple: simpleComms };
