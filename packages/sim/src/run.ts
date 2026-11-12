/** runBattle: the battle-as-a-function entry point (SPEC 4.3 rule 11). */
import { battleScore } from "./systems/objectives";
import type { BattleInput, BattleResult, Controller, RunOptions, SaveGame, SideResult } from "./battle";
import type { SimEventKind } from "./events";
import { secondsToTicks, ticksToSeconds } from "./ids";
import type { Order } from "./orders";
import { unitsFromState } from "./setup";
import { createSim, loadSim, saveSim, simHash, step, submitOrder, type Sim } from "./sim";

export function runBattle(input: BattleInput, opts: RunOptions = {}): BattleResult {
  // Orders from the input stream are fed tick by tick (not all at once) so that a recorded
  // stream replays exactly like the live session that produced it.
  const sim = createSim({ ...input, orders: [] });
  return continueBattle(sim, input, opts);
}

/** Run an existing Sim (fresh or loaded from a save) to the end. Input orders before the current tick are skipped. */
export function continueBattle(sim: Sim, input: BattleInput, opts: RunOptions = {}): BattleResult {
  const stream = input.orders
    .map((o, i) => ({ o, i }))
    .filter(({ o }) => o.tick >= sim.state.tick)
    .sort((a, b) => a.o.tick - b.o.tick || a.i - b.i);
  const allOrders: Order[] = input.orders.filter((o) => o.tick < sim.state.tick);
  let next = 0;
  const counts: Partial<Record<SimEventKind, number>> = {};
  const maxTicks = opts.maxTicks ?? secondsToTicks(input.rules.timeLimitSeconds) + 1;

  while (!sim.state.ended && sim.state.tick < maxTicks) {
    const tick = sim.state.tick;
    while (next < stream.length && stream[next]!.o.tick <= tick) {
      const o = stream[next++]!.o;
      submitOrder(sim, o);
      allOrders.push(o);
    }
    for (const c of opts.controllers ?? []) {
      for (const o of c.think(sim.state, tick)) {
        if (o.issuer !== c.side) throw new Error(`controller for ${c.side} issued an order as ${o.issuer}`);
        if (o.tick !== tick) throw new Error(`controller for ${c.side} issued an order for tick ${o.tick} at tick ${tick}`);
        submitOrder(sim, o);
        allOrders.push(o);
      }
    }
    const ev = step(sim);
    for (const e of ev) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    opts.onEvents?.(ev, tick);
    opts.onTick?.(sim);
  }
  return summarize(sim, input, allOrders, counts);
}

function summarize(
  sim: Sim,
  input: BattleInput,
  orders: Order[],
  eventCounts: Partial<Record<SimEventKind, number>>,
): BattleResult {
  const { state } = sim;
  const sides: SideResult[] = state.sides.map((sd) => {
    let start = 0, fit = 0, wounded = 0, killed = 0;
    for (const [id, ident] of state.identity.entries()) {
      if (ident.side !== sd.id) continue;
      start++;
      const s = state.soldier.req(id);
      if (!s.physiology.alive) killed++;
      else if (s.wounds.length > 0) wounded++;
      else fit++;
    }
    return { side: sd.id, faction: sd.faction, soldiersStart: start, soldiersFit: fit, wounded, killed };
  });
  return {
    seed: input.seed,
    catalogFingerprint: input.catalog.fingerprint,
    endTick: state.tick,
    durationSeconds: ticksToSeconds(state.tick),
    endReason: state.ended?.reason ?? "scenario",
    finalStateHash: simHash(sim),
    sides,
    forcesOut: input.forces.map((f) => ({ side: f.side, faction: f.faction, units: unitsFromState(state, f.side, f.units) })),
    orders,
    eventCounts,
    ...battleScore(sim.ctx, state),
  };
}

/** Save a running battle: simulation state plus each controller's memory. Plain data (JSON-safe). */
export function saveGame(sim: Sim, controllers: readonly Controller[] = []): SaveGame {
  const out: SaveGame = { state: saveSim(sim), controllers: {} };
  for (const c of controllers) if (c.saveState) out.controllers[c.side] = c.saveState();
  return out;
}

/** Load a save game; restores the given (freshly created) controllers' memory. */
export function loadGame(input: BattleInput, save: SaveGame, controllers: readonly Controller[] = []): Sim {
  const sim = loadSim(input, save.state);
  for (const c of controllers) {
    const data = save.controllers[c.side];
    if (data !== undefined) {
      if (!c.loadState) throw new Error(`save has memory for controller '${c.side}' but the controller cannot load it`);
      c.loadState(data);
    }
  }
  return sim;
}
