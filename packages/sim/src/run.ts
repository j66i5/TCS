/** runBattle: the battle-as-a-function entry point (SPEC 4.3 rule 11). */
import { isWreck } from "./hulls";
import { emptyLogistics, logisticsFromEvents, tracerMap, type SideLogistics } from "./ledger";
import { rosterStatus } from "./impair";
import { isAssetUnit, isOffMap } from "./offmap";
import { battleScore } from "./systems/objectives";
import { exitedOf } from "./systems/exits";
import type { BattleInput, BattleResult, Controller, PrisonerResult, RunOptions, SaveGame, SideResult, UnitInput } from "./battle";
import type { SimState } from "./state";
import type { SimContext } from "./context";
import { prisonerGroup } from "./systems/prisoners";
import type { SimEventKind } from "./events";
import { secondsToTicks, ticksToSeconds } from "./ids";
import type { Order } from "./orders";
import { unitsFromState, vehiclesFromState } from "./setup";
import { serviceOut } from "./service";
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
  // M11.8: the sides' logistics (consumed, delivered, captured, destroyed) from the events.
  const logistics: SideLogistics[] = sim.state.sides.map((s) => emptyLogistics(s.id));
  const tracer = tracerMap(sim.ctx.catalog);
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
    if (ev.length > 0) logisticsFromEvents(logistics, ev, sim.state, sim.ctx.catalog, tracer);
    opts.onEvents?.(ev, tick);
    opts.onTick?.(sim);
  }
  return { ...summarize(sim, input, allOrders, counts), logistics };
}

function summarize(
  sim: Sim,
  input: BattleInput,
  orders: Order[],
  eventCounts: Partial<Record<SimEventKind, number>>,
): BattleResult {
  const { state } = sim;
  const prisoners = prisonersAtEnd(sim.ctx, state, input);
  const sides: SideResult[] = state.sides.map((sd) => {
    let start = 0, fit = 0, wounded = 0, killed = 0, surrendered = 0, captured = 0, evacuated = 0, dow = 0;
    // mounted: ok results count every man, aboard or not (not the crews of off-map assets, M10.6a: not of the force)
    for (const [id, ident] of state.identity.entries()) {
      if (ident.side !== sd.id || isAssetUnit(state, ident.unit)) continue;
      start++;
      const sold = state.soldier.req(id), st = rosterStatus(sold);
      if (sold.aftercare?.diedOfWoundsTick !== undefined) dow++;
      if (st === "killed") killed++;
      else if (st === "captured") captured++;
      else if (st === "surrendered") surrendered++;
      else if (st === "fit") fit++;
      else { wounded++; if (st === "evacuated") evacuated++; }
    }
    const out: SideResult = { side: sd.id, faction: sd.faction, soldiersStart: start, soldiersFit: fit, wounded, killed, surrendered, captured, ...(evacuated > 0 ? { evacuated } : {}), ...(dow > 0 ? { diedOfWounds: dow } : {}) };
    // (M11.9b: the prisoners it holds, and those its military police took off the map.)
    const taken = prisoners.filter((p) => p.holder === sd.id);
    if (taken.length > 0) { out.prisonersTaken = taken.length; const ev = taken.filter((p) => p.evacuated === "mp").length; if (ev > 0) out.prisonersEvacuated = ev; }
    // (Review fix: the enemy men who got away from it — escaped, freed by their own men, back with their side at the end.)
    let escaped = 0;
    // mounted: ok (a man who got away counts wherever he is)
    for (const [, s] of state.soldier.entries()) if (s.freedFrom === sd.id) escaped++;
    if (escaped > 0) out.prisonersEscaped = escaped;
    // (M12.0b: out by the side's exit zones.)
    if ((input.rules.exits ?? []).length > 0) { const sv = exitedOf(state, sd.id).men; if (sv > 0) out.saved = sv; }
    // Vehicles (M7): only for a side that has any, so infantry results keep their shape.
    let vs: NonNullable<SideResult["vehicles"]> | null = null;
    for (const [, v] of state.vehicle.entries()) {
      // (Off-map assets, M10.6a, are not of the force: an ambulance is counted nowhere here.)
      if (v.offMap !== undefined || v.side !== sd.id) continue;
      vs ??= { start: 0, ok: 0, immobilised: 0, disarmed: 0, abandoned: 0, destroyed: 0, captured: 0 };
      vs.start++;
      vs[v.status]++;
      if (v.capturedBy !== null) vs.captured++;
      // (M11.7b: a hull towed off the map counts by its status and as towed; one recovered at the end too.)
      if (v.recovery?.state === "towed") vs.towed = (vs.towed ?? 0) + 1;
      else if (v.recovery?.state === "recovered") vs.recovered = (vs.recovered ?? 0) + 1;
      if (v.exited !== undefined) vs.exited = (vs.exited ?? 0) + 1;
    }
    if (vs) out.vehicles = vs;
    return out;
  });
  const wrecks: NonNullable<BattleResult["wrecks"]> = [];
  for (const [id, v] of state.vehicle.entries()) {
    if (isOffMap(v) || !isWreck(v, state.tick)) continue;
    const t = state.transform.req(id);
    // (M12.0a: a wreck of an earlier battle as it came in: its old side and status.)
    wrecks.push({ vehicleId: v.vehicleId, type: v.def, side: v.wreckIn?.side ?? v.side, x: t.x, y: t.y, heading: t.heading, status: v.wreckIn?.status ?? v.status });
  }
  // Caches left on the map (M11.3): whose they are now, what is in them; a captured one names the side it was taken from.
  const caches: NonNullable<BattleResult["caches"]> = [];
  for (const [id, c] of state.cache.entries()) {
    const t = state.transform.req(id);
    const load = (state.container.get(id)?.stacks ?? []).filter((s) => s.count > 0).map((s) => (s.charge === undefined ? { type: s.type, count: s.count } : { type: s.type, count: s.count, charge: s.charge }));
    caches.push({ side: c.side, kind: c.kind, x: Math.round(t.x), y: Math.round(t.y), load, ...(c.from !== undefined ? { from: c.from } : {}), ...(c.burnt === true ? { burnt: true as const } : {}) });
  }
  return {
    seed: input.seed,
    catalogFingerprint: input.catalog.fingerprint,
    endTick: state.tick,
    durationSeconds: ticksToSeconds(state.tick),
    endReason: state.ended?.reason ?? "scenario",
    finalStateHash: simHash(sim),
    sides,
    forcesOut: input.forces.map((f) => ({
      side: f.side, faction: f.faction, units: unitsFromState(state, f.side, f.units),
      ...(f.vehicles && f.vehicles.length > 0 ? { vehicles: vehiclesFromState(state, f.side) } : {}),
    })),
    ...([...state.vehicle.values()].some((v) => v.offMap === undefined) || wrecks.length > 0 ? { wrecks } : {}),
    ...(caches.length > 0 ? { caches } : {}),
    ...(prisoners.length > 0 ? { prisoners } : {}),
    // M12.0a: what a campaign needs, only when asked for (every other result keeps its shape).
    ...(input.rules.campaignOut === true ? { damageOut: JSON.parse(JSON.stringify(state.terrain)) as BattleResult["damageOut"], service: serviceOut(state, input) } : {}),
    orders,
    eventCounts,
    ...battleScore(sim.ctx, state),
  };
}

/**
 * The prisoners each side holds at the end (M11.9b, `BattleResult.prisoners`): every living man held "captured" by a
 * side (`captive.by`; the end settlement included), in entity order, with his roster place.
 */
export function prisonersAtEnd(ctx: SimContext, state: SimState, input: BattleInput): PrisonerResult[] {
  const place = new Map<string, { unitKey: string; personIndex: number }>();
  const walk = (u: UnitInput) => { u.members.forEach((m, i) => place.set(m.personId, { unitKey: u.key, personIndex: i })); u.subunits.forEach(walk); };
  for (const f of input.forces) f.units.forEach(walk);
  const out: PrisonerResult[] = [];
  // mounted: ok results count every man, aboard or not
  for (const [id, ident] of state.identity.entries()) {
    const s = state.soldier.get(id), c = s?.captive;
    if (!s || !c || c.state !== "captured" || c.by === undefined || !s.physiology.alive || isAssetUnit(state, ident.unit)) continue;
    const at = place.get(ident.personId);
    if (!at) continue;
    out.push({
      holder: c.by, side: ident.side, unitKey: at.unitKey, personIndex: at.personIndex, group: c.group ?? prisonerGroup(ctx, state, id), wounded: s.wounds.length > 0,
      evacuated: c.evacTick !== undefined ? "mp" : s.evacuated !== undefined ? "medical" : "held", documents: c.documents ?? 0,
    });
  }
  return out;
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
