/**
 * The simulation loop. Fixed timestep (60 Hz). No wall-clock time, no Math.random, no DOM, no Node.
 * The app calls `step` as often as real time requires; the headless tools call it as fast as they can.
 */
import { actionSystem } from "./actions";
import type { BattleInput } from "./battle";
import { COMMS_MODELS } from "./comms";
import type { SimContext } from "./context";
import { EventSink, type SimEvent } from "./events";
import { secondsToTicks, TICK_HZ } from "./ids";
import type { Order } from "./orders";
import { buildInitialState } from "./setup";
import {
  deserializeState, hashState, serializeState, type SerializedState, type SimState,
} from "./state";
import { movementSystem } from "./systems/movement";
import { enqueueOrder, deliverOrders, receiveOrders } from "./systems/orders";

export interface Sim {
  ctx: SimContext;
  state: SimState;
}

export function createContext(input: BattleInput): SimContext {
  const comms = COMMS_MODELS[input.rules.commsModel];
  if (!comms) throw new Error(`unknown comms model '${input.rules.commsModel}'`);
  return { catalog: input.catalog, map: input.map, rules: input.rules, comms, physiology: null };
}

/** Create a simulation at tick 0. Orders in `input.orders` are queued immediately. */
export function createSim(input: BattleInput): Sim {
  const sim: Sim = { ctx: createContext(input), state: buildInitialState(input) };
  for (const o of input.orders) submitOrder(sim, o);
  return sim;
}

/** Submit an order. Its `tick` must not be in the past (it would be rejected as late). */
export function submitOrder(sim: Sim, order: Order): number {
  return enqueueOrder(sim.state, order);
}

/** Advance one tick (1/60 s). Returns the events of that tick. */
export function step(sim: Sim): SimEvent[] {
  const { ctx, state } = sim;
  const events = new EventSink();
  if (state.ended) return events.events;

  if (state.tick % TICK_HZ === 0) ctx.comms.update(state, ctx.rules.comms);
  receiveOrders(ctx, state, events);
  deliverOrders(ctx, state, events);
  actionSystem(ctx, state, events);
  movementSystem(ctx, state, events);
  // M1+: fatigue, spotting, AI, ballistics, physiology ... in a fixed, documented order.

  state.environment.timeOfDaySeconds += 1 / TICK_HZ;
  state.tick++;

  if (state.tick >= secondsToTicks(ctx.rules.timeLimitSeconds)) {
    state.ended = { tick: state.tick, reason: "time-limit" };
    events.emit({ kind: "battle.ended", tick: state.tick, reason: "time-limit" });
  }
  return events.events;
}

/** Save: the full state as plain data. The BattleInput (minus orders already applied) is stored alongside. */
export function saveSim(sim: Sim): SerializedState {
  return serializeState(sim.state);
}

/** Load a save into a fresh Sim with the same context. */
export function loadSim(input: BattleInput, saved: SerializedState): Sim {
  return { ctx: createContext(input), state: deserializeState(saved) };
}

export function simHash(sim: Sim): string {
  return hashState(sim.state);
}
