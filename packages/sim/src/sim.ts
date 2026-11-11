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
import { mapFingerprint } from "./map";
import { buildMapIndex, validateMap } from "./terrain";
import { buildBallistics } from "./ballistics";
import { projectileSystem } from "./systems/ballistics";
import { buildInitialState } from "./setup";
import {
  deserializeState, hashState, serializeState, type SerializedState, type SimState,
} from "./state";
import { movementSystem } from "./systems/movement";
import { physiologySystem, postureSystem } from "./systems/body";
import { enqueueOrder, deliverOrders, receiveOrders } from "./systems/orders";

export interface Sim {
  ctx: SimContext;
  state: SimState;
}

export function createContext(input: BattleInput): SimContext {
  const comms = COMMS_MODELS[input.rules.commsModel];
  if (!comms) throw new Error(`unknown comms model '${input.rules.commsModel}'`);
  const problems = validateMap(input.map, input.catalog.terrain);
  if (problems.length > 0) throw new Error(`map '${input.map.id}' does not fit the data: ${problems.slice(0, 5).join("; ")}`);
  const mapIndex = buildMapIndex(input.map);
  return {
    catalog: input.catalog, map: input.map, mapIndex, mapFingerprint: mapFingerprint(input.map), nav: {},
    ballistics: buildBallistics(input.map, input.catalog, mapIndex, TICK_HZ),
    rules: input.rules, comms, physiology: null,
  };
}

/**
 * Create a simulation at tick 0. `input.orders` is NOT queued here: an order stream is fed tick by tick
 * by `runBattle` / `continueBattle`, so that a save never contains orders the stream will feed again.
 */
export function createSim(input: BattleInput): Sim {
  const ctx = createContext(input);
  const state = buildInitialState(input);
  state.mapFingerprint = ctx.mapFingerprint;
  return { ctx, state };
}

/**
 * Submit an order for the CURRENT tick (`order.tick === state.tick`); it is processed by the next `step`.
 * Orders for a past tick are accepted here and rejected as "late" by the step (network peers may be late).
 * Orders for a future tick throw: the caller must hold them until their tick. This keeps the simulation's
 * order inbox empty between ticks, so live play, replays and loaded saves see exactly the same state.
 */
export function submitOrder(sim: Sim, order: Order): number {
  if (order.tick > sim.state.tick) {
    throw new Error(`order for future tick ${order.tick} submitted at tick ${sim.state.tick}; hold it until its tick`);
  }
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
  postureSystem(ctx, state, events);
  movementSystem(ctx, state, events);
  physiologySystem(ctx, state);
  projectileSystem(ctx, state, events);
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

/** Load a save into a fresh Sim. The save must come from the same data (catalog fingerprint). */
export function loadSim(input: BattleInput, saved: SerializedState): Sim {
  if (saved.catalogFingerprint !== input.catalog.fingerprint) {
    throw new Error(
      `save was made with data ${saved.catalogFingerprint}, but the loaded data is ${input.catalog.fingerprint}; ` +
      "the battle would not continue identically",
    );
  }
  const ctx = createContext(input);
  if (saved.mapFingerprint !== ctx.mapFingerprint) {
    throw new Error(`save was made on map ${saved.mapFingerprint}, but the given map is ${ctx.mapFingerprint}`);
  }
  return { ctx, state: deserializeState(saved) };
}

export function simHash(sim: Sim): string {
  return hashState(sim.state);
}
