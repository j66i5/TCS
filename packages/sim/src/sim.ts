/**
 * The simulation loop. Fixed timestep (60 Hz). No wall-clock time, no Math.random, no DOM, no Node.
 * The app calls `step` as often as real time requires; the headless tools call it as fast as they can.
 */
import { droneSystem } from "./systems/drones";
import { powerSystem } from "./systems/power";
import { lightAt } from "./light";
import { initMortars, mortarSystem } from "./systems/mortars";
import { missileTeamSystem } from "./systems/missile-team";
import { aglTeamSystem } from "./systems/agl-team";
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
import { rebuildVehicleGrid } from "./hulls";
import { syncTerrainDamage } from "./systems/explosions";
import { evadeSystem, grenadeReactionSystem } from "./systems/grenades";
import { projectileSystem } from "./systems/ballistics";
import { missileSystem } from "./systems/missiles";
import { crewReactionSystem, vehicleDamageSystem } from "./systems/armour";
import { repairSystem } from "./systems/repair";
import { fireSystem, incomingFireSystem } from "./systems/fire";
import { woundSystem } from "./systems/wounds";
import { moraleSystem } from "./systems/morale";
import { decisionSystem } from "./systems/decisions";
import { ambushSystem } from "./systems/ambush";
import { prisonersSystem } from "./systems/prisoners";
import { surrenderSystem } from "./systems/surrender";
import { medicalSystem } from "./systems/medical";
import { nestSystem } from "./systems/nest";
import { evacuationSystem } from "./systems/evacuation";
import { settleBattle } from "./systems/aftercare";
import { rearRunSystem } from "./systems/rearrun";
import { recoverySystem, settleVehicles, towSystem } from "./systems/recovery";
import { mpSystem } from "./systems/mp";
import { consolidateSystem } from "./systems/consolidate";
import { requestSystem, supplySystem } from "./systems/supply";
import { deliverySystem } from "./systems/delivery";
import { mortarFetchSystem, rearmSystem } from "./systems/rearm";
import { drillSystem } from "./systems/drills";
import { boardingSystem } from "./systems/boarding";
import { stationDecisionSystem, stationFireSystem, turretSystem, vehicleIncomingSystem } from "./systems/gunnery";
import { initObjectives, objectiveSystem } from "./systems/objectives";
import { exitSystem } from "./systems/exits";
import { initSupport, supportSystem } from "./systems/support";
import { spottingSystem } from "./systems/spotting";
import { contactSystem } from "./systems/contacts";
import { PHYSIOLOGY_MODELS } from "./wounds";
import { arrivalSystem, buildInitialState } from "./setup";
import {
  deserializeState, hashState, serializeState, type SerializedState, type SimState,
} from "./state";
import { movementSystem } from "./systems/movement";
import { carrySystem } from "./systems/carry";
import { vehicleDriveSystem, vehicleSyncSystem } from "./systems/drive";
import { physiologySystem, postureSystem } from "./systems/body";
import { enqueueOrder, deliverOrders, receiveOrders } from "./systems/orders";
import { positionsSystem } from "./positions";
import { serviceSystem } from "./service";

export interface Sim {
  ctx: SimContext;
  state: SimState;
}

export function createContext(input: BattleInput): SimContext {
  const comms = COMMS_MODELS[input.rules.commsModel];
  if (!comms) throw new Error(`unknown comms model '${input.rules.commsModel}'`);
  const problems = validateMap(input.map, input.catalog.terrain);
  if (problems.length > 0) throw new Error(`map '${input.map.id}' does not fit the data: ${problems.slice(0, 5).join("; ")}`);
  if (input.rules.physiologyModel === "medical" && !input.catalog.medical) throw new Error("the 'medical' physiology model needs core/medical.json in the data");
  const mapIndex = buildMapIndex(input.map);
  return {
    catalog: input.catalog, map: input.map, mapIndex, mapFingerprint: mapFingerprint(input.map), nav: {},
    ballistics: buildBallistics(input.map, input.catalog, mapIndex, TICK_HZ), dropTables: {},
    rules: input.rules, comms,
    physiology: PHYSIOLOGY_MODELS[input.rules.physiologyModel] ?? null,
    physiologyParams: { ...input.catalog.wounds.physiology, ...input.catalog.medical?.physiology, ...input.rules.physiologyParams },
    breaches: [], navStamps: [], navStampKey: "",
    // (M12.0a: craters of earlier battles are rough ground; this battle's own craters do not touch the grids.)
    ...(input.damage && input.damage.craters.length > 0 ? { navCraters: input.damage.craters.map((c) => ({ x: c.x, y: c.y, radiusM: c.radiusM })) } : {}),
    late: input.forces.flatMap((f) => {
      const placements = new Map(f.placements.map((p) => [p.personId, p]));
      return f.units.filter((u) => (u.arriveS ?? 0) > 0).map((u) => ({ side: f.side, faction: f.faction, unit: u, tick: secondsToTicks(u.arriveS!), placements, force: f }));
    }),
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
  initObjectives(ctx, state);
  initSupport(ctx, state);
  initMortars(ctx, state);
  syncTerrainDamage(ctx, state);
  rebuildVehicleGrid(ctx, state);
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

  // The vehicle grid (hull boxes, turret pose, wreck stamps) from this tick's state, before anything queries it
  // (orders, grenades, launchers, routes): a loaded save and an unbroken run see the same grid (M7 review).
  if (state.vehicle.size > 0 || ctx.ballistics.vehicles.n > 0) rebuildVehicleGrid(ctx, state);
  if (state.tick % TICK_HZ === 0) ctx.comms.update(state, ctx.rules.comms, ctx.catalog);
  receiveOrders(ctx, state, events);
  deliverOrders(ctx, state, events);
  actionSystem(ctx, state, events);
  postureSystem(ctx, state, events);
  evadeSystem(ctx, state, events);
  // Vehicles (M7): drive, then the men aboard move with their seats.
  vehicleDriveSystem(ctx, state, events);
  // Towed hulls follow their recovery vehicles' hitches (M11.7b; nothing without a tow).
  towSystem(ctx, state);
  vehicleSyncSystem(ctx, state);
  movementSystem(ctx, state, events);
  // Carrying parties (M10.4a): the payload and the other carriers follow the leader's trail; phases, rests, cover.
  carrySystem(ctx, state, events);
  droneSystem(ctx, state, events);
  physiologySystem(ctx, state, events);
  // Batteries (M11.6): once a second per man, staggered (after physiology: the tick's loads are summed by then).
  powerSystem(ctx, state, events);
  // Vehicle gunnery (M7.3; each returns at once without vehicles): lay the turrets, then fire.
  turretSystem(ctx, state);
  fireSystem(ctx, state, events);
  stationFireSystem(ctx, state, events);
  mortarSystem(ctx, state, events);
  missileTeamSystem(ctx, state, events);
  aglTeamSystem(ctx, state, events); // (M7.6d)
  supportSystem(ctx, state, events);
  projectileSystem(ctx, state, events);
  // Wire-guided missiles (owner 2026-11-13): end, lose or steer each one in flight; reload launchers.
  missileSystem(ctx, state, events);
  // Fire, cook-off and bailing out of damaged vehicles (M7.4a; returns at once without vehicles).
  vehicleDamageSystem(ctx, state, events);
  grenadeReactionSystem(ctx, state, events);
  // Hits on hulls and fire near vehicles (M7.3) before the infantry's incoming fire: its early return no longer
  // skips station tasks (plan C34).
  vehicleIncomingSystem(ctx, state, events.events);
  incomingFireSystem(ctx, state, events.events);
  woundSystem(ctx, state, events);
  moraleSystem(ctx, state, events, events.events);
  // Crews decide to fight on or reverse out of reach (M7.4b; returns at once without vehicles).
  crewReactionSystem(ctx, state, events);
  // Field repair by the crews (M11.7a; once a second, returns at once without core/repair.json or damage).
  repairSystem(ctx, state, events);
  spottingSystem(ctx, state, events);
  contactSystem(ctx, state, events);
  // Surrender (M6.6): after contacts (what he knows is fresh), before any decision, drill or objective check.
  surrenderSystem(ctx, state, events);
  prisonersSystem(ctx, state, events); // (M11.9)
  // Self-aid and buddy aid (M10.2): before decisions, so a man who starts treating is not given something else.
  medicalSystem(ctx, state, events);
  nestSystem(ctx, state, events);
  evacuationSystem(ctx, state, events);
  // Combat vehicles' rear runs (M10.6b): after the ambulances (a nest an ambulance serves needs no hull).
  rearRunSystem(ctx, state, events);
  // Recovery vehicles' runs (M11.7b; once a second, returns at once without a run).
  recoverySystem(ctx, state, events);
  mpSystem(ctx, state, events); // (M11.9b)
  // Redistribution in quiet squads, own casualties' ammunition after treatment, none left at the nest (M11.2).
  consolidateSystem(ctx, state, events);
  // Supply points and caches (M11.3): who sees them, capture, fire beside them, cook-offs (nothing without caches).
  supplySystem(ctx, state, events);
  requestSystem(ctx, state, events);
  deliverySystem(ctx, state, events);
  rearmSystem(ctx, state, events); // (M11.5)
  mortarFetchSystem(ctx, state, events);
  // Ambushes (D4b): sprung before the decisions, so the men open fire at once.
  ambushSystem(ctx, state, events);
  decisionSystem(ctx, state, events);
  stationDecisionSystem(ctx, state, events);
  drillSystem(ctx, state, events);
  // Getting in and out of vehicles, seat swaps (M7.2; returns at once without vehicles).
  boardingSystem(ctx, state, events);
  if (ctx.rules.exits !== undefined && ctx.rules.exits.length > 0) exitSystem(ctx, state, events); // (M12.0b)
  objectiveSystem(ctx, state, events);
  if (ctx.rules.prepared !== undefined) positionsSystem(ctx, state, events); // (M11 hold battle)
  // Late arrivals (M11.1): a wave enters at its time (once a second; nothing without late units).
  if (ctx.late.length > 0) arrivalSystem(ctx, state, events);
  // M12.0a: the men's service tally for the campaign (write-only; only when the input asks for it).
  if (ctx.rules.campaignOut === true) serviceSystem(ctx, state, events.events);
  // M1+: fatigue, spotting, AI, ballistics, physiology ... in a fixed, documented order.

  state.environment.timeOfDaySeconds += 1 / TICK_HZ;
  state.tick++;
  // Night and light (M9.1): with a sky, the light follows the clock, once a second.
  const sky = state.environment.sky;
  if (sky !== undefined && state.tick % TICK_HZ === 0) state.environment.light = lightAt(ctx.catalog, state.environment.timeOfDaySeconds, sky.moon);

  if (state.ended) return events.events;
  if (state.tick >= secondsToTicks(ctx.rules.timeLimitSeconds)) {
    state.ended = { tick: state.tick, reason: "time-limit" };
    events.emit({ kind: "battle.ended", tick: state.tick, reason: "time-limit" });
    settleBattle(ctx, state, events);
    settleVehicles(ctx, state, events);
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
  const state = deserializeState(saved);
  syncTerrainDamage(ctx, state);
  rebuildVehicleGrid(ctx, state);
  return { ctx, state };
}

export function simHash(sim: Sim): string {
  return hashState(sim.state);
}
