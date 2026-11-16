/**
 * The conservation guard (M11.1): run a named scenario and check, for every ammunition id, that what the battle
 * started with minus what it ended with equals what the events say was fired, thrown, destroyed and (minus)
 * delivered (sim/ledger.ts). Used by the conservation test and `npm run lab -- consumption --conservation`.
 */
import {
  checkConservation, consumedFromEvents, continueBattle, createSim, emptyConsumption, ledgerOf, tracerMap,
  type BattleInput, type Consumption, type Controller, type Ledger,
} from "@tcs/sim";
import type { DataSet } from "@tcs/data";
import { getScenario } from "./scenarios";

export interface ConservationRun {
  scenario: string; seed: number; seconds: number; endS: number;
  start: Ledger; end: Ledger; consumption: Consumption;
  /** Ammunition ids with their unexplained difference (empty: exact). */
  leaks: Record<string, number>;
}

export function conservationRun(data: DataSet, scenario: string, seed: number, seconds: number, tweak?: (input: BattleInput) => void): ConservationRun {
  const sc = getScenario(scenario);
  const input = sc.build(data, seed, seconds);
  tweak?.(input);
  const controllers: Controller[] = sc.controllers?.(input) ?? [];
  const sim = createSim({ ...input, orders: [] });
  const catalog = input.catalog;
  const start = ledgerOf(catalog, sim.state);
  const consumption = emptyConsumption();
  const tracer = tracerMap(catalog);
  continueBattle(sim, input, { controllers, onEvents: (ev) => consumedFromEvents(consumption, ev, tracer) });
  const end = ledgerOf(catalog, sim.state);
  return { scenario, seed, seconds, endS: sim.state.tick / 60, start, end, consumption, leaks: checkConservation(start, end, consumption) };
}
