/**
 * Recovery (M11.7b, plan §3.4, §8 and amendments): the side's recovery vehicle waits off the map from tick 0 (outside
 * the side's strength); a call brings it on after the delay, it drives to the disabled hull, reverses up to it, its
 * men hook up outside, it tows the hull (no faster than its cap, the hull following the hitch) off the map: the hull
 * is towed away (roster `recovery: towed`), its crew with it, its able passengers out first. Refusals (too heavy, none
 * left, already coming, a hull that still drives); a hull destroyed before it arrives (stood down); a recovery vehicle
 * that cannot drive any more mid-tow (lost, the tow dropped, a wreck again); waiting short of a hull under fire and
 * giving up; orders to a towed crew refused; save and load mid-tow continue identically; without catalog.medical and
 * with `rules.recovery = false`; the xf fixture tug tows the tortoise; the end-of-battle settlement (recovered,
 * captured) and the roster round trip through runBattle.
 */
import { describe, expect, it } from "vitest";
import {
  createSim, isOffMap, isWreck, loadSim, runBattle, saveSim, simHash, step, submitOrder, TICK_HZ,
  type BattleInput, type Catalog, type EntityId, type RecoveryDef, type Sim, type SimEvent, type VehicleRecord,
} from "@tcs/sim";
import { duel } from "../src/labs/gunnery";
import { loadData } from "../src/scenarios";

const data = loadData();
const fixtures = loadData(true);

type RecEv = Extract<SimEvent, { kind: "vehicle.recovery" }>;

function run(sim: Sim, seconds: number, on: (e: SimEvent) => void = () => undefined, until: () => boolean = () => false): void {
  for (let i = 0; i < seconds * TICK_HZ && !until(); i++) for (const e of step(sim)) on(e);
}
function holdAll(sim: Sim): void {
  for (const [uid, u] of sim.state.unit.entries()) if (u.parent === null) submitOrder(sim, { tick: sim.state.tick, issuer: u.side, target: uid, kind: "rules", fire: "hold", at: "hold" });
  step(sim);
}
interface Field { sim: Sim; input: BattleInput; vid: EntityId; rid: EntityId }
interface Opts {
  fixture?: boolean; factions?: [string, string]; crews?: [string, string]; squads?: [string, string]; heading?: number;
  recovery?: Partial<RecoveryDef>; noMedical?: boolean; noRecovery?: boolean; redSquadAt?: { x: number; y: number; spacing: number }; timeLimitS?: number;
}
/** One own hull at (400, 600), the enemy 1.6 km off, each side's recovery vehicle off the map; a quick delay. */
function build(opts: Opts = {}): BattleInput {
  const input = duel(opts.fixture ? fixtures : data, opts.factions ?? ["de", "ru"], { blue: { x: 400, y: 600, heading: opts.heading ?? 0.7 }, red: { x: 2000, y: 600, heading: Math.PI }, ...(opts.redSquadAt ? { redSquadAt: opts.redSquadAt } : {}) }, opts.squads, 2400, opts.crews ?? ["leopard2a7v-besatzung", "t90m-ekipazh"], true);
  const cat = { ...input.catalog, recovery: { ...input.catalog.recovery!, delayMinS: 5, delayMaxS: 5, ...(opts.recovery ?? {}) } } as Catalog;
  if (opts.noMedical) { delete (cat as { medical?: unknown }).medical; input.rules.physiologyModel = "none"; }
  input.catalog = cat;
  if (opts.noRecovery) input.rules.recovery = false;
  if (opts.timeLimitS !== undefined) input.rules.timeLimitSeconds = opts.timeLimitS;
  return input;
}
function field(opts: Opts = {}): Field {
  const input = build(opts);
  const sim = createSim(input);
  holdAll(sim);
  const vid = [...sim.state.vehicle.entries()].find(([, v]) => v.side === "blue" && v.offMap === undefined)![0];
  const rid = [...sim.state.vehicle.entries()].find(([, v]) => v.side === "blue" && v.offMap?.kind === "recovery")![0];
  return { sim, input, vid, rid };
}
/** Break the hull's first track (or set it immobilised when it has none). */
function immobilise(sim: Sim, vid: EntityId): void {
  const v = sim.state.vehicle.req(vid), def = sim.ctx.catalog.vehicles[v.def]!;
  const k = def.components?.findIndex((c) => c.kind === "track") ?? -1;
  if (k >= 0) v.comp[k] = 0;
  v.status = "immobilised";
}
function call(sim: Sim, vid: EntityId, side = "blue"): void {
  const v = sim.state.vehicle.req(vid);
  submitOrder(sim, { tick: sim.state.tick, issuer: side, target: v.unit!, kind: "callRecovery", player: true });
}
function refusals(sim: Sim, seconds = 5): string[] {
  const out: string[] = [];
  run(sim, seconds, (e) => { if (e.kind === "radio" && e.key.startsWith("radio.") && !e.key.startsWith("radio.ack")) out.push(e.key); });
  return out;
}

describe("recovery: the off-map recovery vehicle (M11.7b)", () => {
  it("waits off the map from tick 0, outside the side's strength and its vehicle counts", () => {
    const { sim, rid } = field();
    const r = sim.state.vehicle.req(rid);
    expect(r.offMap).toEqual({ kind: "recovery", phase: "ready" });
    expect(isOffMap(r)).toBe(true);
    expect(sim.state.unit.req(r.unit!).asset).toBe("recovery");
    expect(sim.ctx.catalog.vehicles[r.def]!.recovery).toBeDefined();
    const res = runBattle(build({ timeLimitS: 5 }));
    // One own hull per side counted, not the recovery vehicle; its crew not among the men.
    for (const sd of res.sides) expect(sd.vehicles!.start).toBe(1);
  });

  it("a call brings it after the delay; it reverses up to the hull, hooks up, tows at its cap with the hull on the bar, both leave the map", () => {
    const { sim, vid, rid } = field();
    immobilise(sim, vid);
    const v = sim.state.vehicle.req(vid), r = sim.state.vehicle.req(rid);
    const def = sim.ctx.catalog.vehicles[r.def]!, tdef = sim.ctx.catalog.vehicles[v.def]!;
    const crew = v.seats.filter((x): x is EntityId => x !== null);
    call(sim, vid);
    const evs: RecEv[] = [];
    let maxTowSpeed = 0, worstBar = 0, hookOutside = 0, hookPos = 0;
    run(sim, 900, (e) => { if (e.kind === "vehicle.recovery") evs.push(e); }, () => {
      const o = r.offMap!;
      if (o.phase === "towing") {
        maxTowSpeed = Math.max(maxTowSpeed, Math.abs(r.drive.speed));
        const rt = sim.state.transform.req(rid), tt = sim.state.transform.req(vid);
        const hx = rt.x - Math.cos(rt.heading) * def.body.lengthM / 2, hy = rt.y - Math.sin(rt.heading) * def.body.lengthM / 2;
        worstBar = Math.max(worstBar, Math.abs(Math.hypot(hx - tt.x, hy - tt.y) - o.towLenM!));
        expect(v.towedBy).toBe(rid);
      }
      if (o.phase === "hookUp") {
        for (const sid of r.seats) if (sid !== null && sim.state.action.get(sid)?.kind === "hookUp") {
          hookOutside++;
          // Behind its hull, at the hitch, on the ground.
          const mt = sim.state.transform.req(sid), rt = sim.state.transform.req(rid);
          const along = Math.cos(rt.heading) * (mt.x - rt.x) + Math.sin(rt.heading) * (mt.y - rt.y);
          if (along < -def.body.lengthM / 2 && mt.z === 0) hookPos++;
        }
      }
      return v.towAway === true;
    });
    const phases = evs.map((e) => e.phase);
    expect(phases).toEqual(["called", "entered", "arrived", "hookedUp", "departed", "away"]);
    const at = (p: string) => evs.find((e) => e.phase === p)!.tick;
    expect((at("entered") - at("called")) / TICK_HZ).toBeCloseTo(5, 0);
    // Hook-up: the vehicle's hookUpS (one man at it, the whole time; checked once a second).
    expect(Math.abs((at("hookedUp") - at("arrived")) / TICK_HZ - def.recovery!.hookUpS)).toBeLessThanOrEqual(2);
    expect(hookOutside).toBeGreaterThan(0);
    // (the tick he goes out he is still in his seat until the next seat sync)
    expect(hookPos).toBeGreaterThanOrEqual(hookOutside - 2);
    expect(maxTowSpeed).toBeLessThanOrEqual(def.recovery!.towMaxMps + 0.05);
    expect(maxTowSpeed).toBeGreaterThan(def.recovery!.towMaxMps * 0.8);
    expect(worstBar).toBeLessThan(0.01);
    // At the hull: its spot within the tolerance (centre to centre about the two half lengths and the gap).
    // Gone: the hull towed away, off the map with its crew aboard; the roster state; the recovery vehicle away.
    expect(v.towAway).toBe(true);
    expect(isOffMap(v)).toBe(true);
    expect(v.recovery?.state).toBe("towed");
    expect(v.recovery?.repairDays).toBeGreaterThan(0);
    expect(r.offMap!.phase).toBe("away");
    for (const sid of crew) expect(sim.state.soldier.req(sid).mount?.vehicle).toBe(vid);
    expect(tdef.massKg).toBeLessThanOrEqual(def.recovery!.towMaxKg);
    // Orders to the towed-away crew are refused.
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: v.unit!, kind: "move", waypoints: [{ x: 600, y: 600, mode: "run" }] });
    expect(refusals(sim)).toContain("radio.towedAway");
  });

  it("the hook-up spot is close to the hull: no endless yielding to the hull it came for", () => {
    for (const heading of [0, 0.7, Math.PI / 2, Math.PI]) {
      const { sim, vid, rid } = field({ heading });
      immobilise(sim, vid);
      call(sim, vid);
      const r = sim.state.vehicle.req(rid);
      run(sim, 400, () => undefined, () => r.offMap!.phase === "hookUp");
      expect(r.offMap!.phase).toBe("hookUp");
      const rt = sim.state.transform.req(rid), tt = sim.state.transform.req(vid);
      const def = sim.ctx.catalog.vehicles[r.def]!, tdef = sim.ctx.catalog.vehicles[sim.state.vehicle.req(vid).def]!;
      const want = def.body.lengthM / 2 + tdef.body.lengthM / 2 + sim.ctx.catalog.recovery!.gapM;
      expect(Math.abs(Math.hypot(rt.x - tt.x, rt.y - tt.y) - want)).toBeLessThan(sim.ctx.catalog.recovery!.standTolM);
    }
  });

  it("refusals: a hull that still drives, too heavy, already coming, none left", () => {
    const a = field();
    call(a.sim, a.vid);
    expect(refusals(a.sim)).toContain("radio.recoveryNotNeeded");
    const b = field({ recovery: {} });
    b.input.catalog.vehicles["de-bergepanzer3"] = { ...b.input.catalog.vehicles["de-bergepanzer3"]!, recovery: { ...b.input.catalog.vehicles["de-bergepanzer3"]!.recovery!, towMaxKg: 1000 } };
    immobilise(b.sim, b.vid);
    call(b.sim, b.vid);
    expect(refusals(b.sim)).toContain("radio.recoveryTooHeavy");
    const c = field();
    immobilise(c.sim, c.vid);
    call(c.sim, c.vid);
    run(c.sim, 2);
    call(c.sim, c.vid);
    expect(refusals(c.sim)).toContain("radio.recoveryAlready");
    // The only one is on its way: a second hull gets none (the red side's own is not blue's).
    const v = c.sim.state.vehicle.req(c.vid);
    delete v.recoveryBy;
    call(c.sim, c.vid);
    expect(refusals(c.sim)).toContain("radio.noRecovery");
  });

  it("a hull destroyed before it comes on: stood down, it waits for the next call; destroyed on the way: it goes back", () => {
    const a = field({ recovery: { delayMinS: 60, delayMaxS: 60 } });
    immobilise(a.sim, a.vid);
    call(a.sim, a.vid);
    run(a.sim, 5);
    a.sim.state.vehicle.req(a.vid).status = "destroyed";
    const evs: RecEv[] = [];
    run(a.sim, 70, (e) => { if (e.kind === "vehicle.recovery") evs.push(e); });
    expect(evs.map((e) => e.phase)).toEqual(["cancelled"]);
    expect(a.sim.state.vehicle.req(a.rid).offMap).toEqual({ kind: "recovery", phase: "ready" });
    expect(a.sim.state.vehicle.req(a.vid).recoveryBy).toBeUndefined();
    const b = field();
    immobilise(b.sim, b.vid);
    call(b.sim, b.vid);
    run(b.sim, 30);
    expect(b.sim.state.vehicle.req(b.rid).offMap!.phase).toBe("inbound");
    b.sim.state.vehicle.req(b.vid).status = "destroyed";
    const ev2: RecEv[] = [];
    run(b.sim, 200, (e) => { if (e.kind === "vehicle.recovery") ev2.push(e); });
    expect(ev2.map((e) => e.phase)).toEqual(["cancelled", "away"]);
  });

  it("a recovery vehicle that cannot drive mid-tow is lost: the tow drops, the hull is a wreck again", () => {
    const { sim, vid, rid } = field();
    immobilise(sim, vid);
    call(sim, vid);
    const r = sim.state.vehicle.req(rid), v = sim.state.vehicle.req(vid);
    run(sim, 600, () => undefined, () => r.offMap!.phase === "towing");
    run(sim, 20);
    r.status = "immobilised";
    const evs: RecEv[] = [];
    run(sim, 3, (e) => { if (e.kind === "vehicle.recovery") evs.push(e); });
    expect(evs.map((e) => e.phase)).toEqual(["lost"]);
    expect(v.towedBy).toBeUndefined();
    expect(v.recoveryBy).toBeUndefined();
    expect(r.drive.towCapMps).toBeUndefined();
    const at = { ...sim.state.transform.req(vid) };
    run(sim, 30, () => undefined, () => false);
    // (it stays where the tow dropped it, a wreck stamp again after the immobilised wait)
    expect(Math.hypot(sim.state.transform.req(vid).x - at.x, sim.state.transform.req(vid).y - at.y)).toBeLessThan(0.5);
    expect(isWreck(v, sim.state.tick)).toBe(true);
  });

  it("does not drive into fire: waits short of a hull hit lately, goes on when quiet, gives up after giveUpS", () => {
    const a = field({ recovery: { giveUpS: 100000 } });
    immobilise(a.sim, a.vid);
    call(a.sim, a.vid);
    const v = a.sim.state.vehicle.req(a.vid), r = a.sim.state.vehicle.req(a.rid);
    const evs: RecEv[] = [];
    // Hit every few seconds for two minutes: it waits about waitShortM short.
    for (let s = 0; s < 120; s++) { if (s % 5 === 0) v.lastHitTick = a.sim.state.tick; run(a.sim, 1, (e) => { if (e.kind === "vehicle.recovery") evs.push(e); }); }
    expect(r.offMap!.phase).toBe("waiting");
    const rt = a.sim.state.transform.req(a.rid), tt = a.sim.state.transform.req(a.vid);
    expect(Math.hypot(rt.x - tt.x, rt.y - tt.y)).toBeGreaterThan(a.sim.ctx.catalog.recovery!.waitShortM - 40);
    run(a.sim, 600, (e) => { if (e.kind === "vehicle.recovery") evs.push(e); }, () => r.offMap!.phase === "hookUp");
    expect(evs.map((e) => e.phase)).toEqual(["called", "entered", "waiting", "arrived"]);
    const b = field({ recovery: { giveUpS: 60 } });
    immobilise(b.sim, b.vid);
    call(b.sim, b.vid);
    const vb = b.sim.state.vehicle.req(b.vid), ev2: RecEv[] = [];
    for (let s = 0; s < 240; s++) { if (s % 5 === 0) vb.lastHitTick = b.sim.state.tick; run(b.sim, 1, (e) => { if (e.kind === "vehicle.recovery") ev2.push(e); }); }
    expect(ev2.map((e) => e.phase).slice(0, 4)).toEqual(["called", "entered", "waiting", "cancelled"]);
    expect(ev2[3]!.why).toBe("underFire");
  });

  it("a hit on the recovery vehicle stops the hook-up; the men go back out when quiet", () => {
    const { sim, vid, rid } = field();
    immobilise(sim, vid);
    call(sim, vid);
    const r = sim.state.vehicle.req(rid);
    run(sim, 600, () => undefined, () => r.offMap!.phase === "hookUp");
    run(sim, 30);
    const done0 = r.offMap!.hookDoneS!;
    r.lastHitTick = sim.state.tick;
    run(sim, 30);
    expect(r.offMap!.phase).toBe("hookUp");
    expect(r.offMap!.hookDoneS! - done0).toBeLessThanOrEqual(2);
    run(sim, 400, () => undefined, () => r.offMap!.phase === "towing");
    expect(r.offMap!.phase).toBe("towing");
  });

  it("the hull's able passengers get out before the hook-up; its crew stays aboard", () => {
    const input = build({ crews: ["puma-besatzung", "bmp2-ekipazh"] });
    // (The squad stands beside its carrier, not out of the way as in the gunnery duel.)
    const crewIds = new Set(input.forces[0]!.units.flatMap((u) => u.subunits).filter((u) => u.vehicleId !== undefined).flatMap((u) => u.members.map((m) => m.personId)));
    let k = 0;
    for (const pl of input.forces[0]!.placements) if (!crewIds.has(pl.personId)) { pl.x = 385; pl.y = 595 + 2 * k++; }
    const sim = createSim(input);
    holdAll(sim);
    const vid = [...sim.state.vehicle.entries()].find(([, x]) => x.side === "blue" && x.offMap === undefined)![0];
    const rid = [...sim.state.vehicle.entries()].find(([, x]) => x.side === "blue" && x.offMap?.kind === "recovery")![0];
    // The squad gets in first.
    const v = sim.state.vehicle.req(vid);
    const squad = [...sim.state.unit.entries()].find(([, u]) => u.side === "blue" && u.carrier === vid)![0];
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: squad, kind: "mount" });
    run(sim, 120, () => undefined, () => v.seats.filter((x) => x !== null).length > 4);
    run(sim, 30);
    const def = sim.ctx.catalog.vehicles[v.def]!;
    const riders = v.seats.filter((x, k) => x !== null && def.seats[k]!.station === "passenger").length;
    expect(riders).toBeGreaterThan(0);
    immobilise(sim, vid);
    call(sim, vid);
    const r = sim.state.vehicle.req(rid);
    run(sim, 600, () => undefined, () => r.offMap!.phase === "hookUp");
    run(sim, 2);
    expect(v.seats.filter((x, k) => x !== null && def.seats[k]!.station === "passenger").length).toBe(0);
    expect(v.seats.filter((x, k) => x !== null && def.seats[k]!.station !== "passenger").length).toBeGreaterThan(0);
    // A mount order onto the hull being hooked up is refused.
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: squad, kind: "mount" });
    expect(refusals(sim)).toContain("radio.underTow");
  });

  it("save and load mid-tow continues identically (every 37 ticks through JSON)", () => {
    const runIt = (saveEvery: number | null) => {
      const base = field();
      let sim = base.sim;
      immobilise(sim, base.vid);
      call(sim, base.vid);
      const hashes: string[] = [], phases: string[] = [];
      for (let t = 0; t < 420 * TICK_HZ; t++) {
        for (const e of step(sim)) if (e.kind === "vehicle.recovery") phases.push(e.phase);
        if (saveEvery !== null && sim.state.tick > 200 * TICK_HZ && sim.state.tick % saveEvery === 0) sim = loadSim(base.input, JSON.parse(JSON.stringify(saveSim(sim))));
        if (sim.state.tick % 60 === 0) hashes.push(simHash(sim));
      }
      return { hashes, phases };
    };
    const a = runIt(null), b = runIt(37);
    expect(a.phases).toContain("departed");
    expect(b.phases).toEqual(a.phases);
    expect(b.hashes).toEqual(a.hashes);
  });

  it("works without medical data; nothing with rules.recovery = false", () => {
    const a = field({ noMedical: true });
    immobilise(a.sim, a.vid);
    call(a.sim, a.vid);
    run(a.sim, 900, () => undefined, () => a.sim.state.vehicle.req(a.vid).towAway === true);
    expect(a.sim.state.vehicle.req(a.vid).recovery?.state).toBe("towed");
    const b = field({ noRecovery: true });
    immobilise(b.sim, b.vid);
    call(b.sim, b.vid);
    const evs: SimEvent[] = [];
    run(b.sim, 60, (e) => { if (e.kind === "vehicle.recovery" || e.kind === "order.rejected") evs.push(e); });
    expect(evs.filter((e) => e.kind === "vehicle.recovery")).toEqual([]);
    expect(b.sim.state.vehicle.req(b.rid).offMap!.phase).toBe("ready");
  });

  it("the fixture faction (rule 8): the xf tug tows the tortoise", () => {
    const { sim, vid, rid } = field({ fixture: true, factions: ["xf", "de"], squads: ["porter-band", "pzgren-schuetzentrupp"], crews: ["tortoise-crew", "puma-besatzung"] });
    expect(sim.state.vehicle.req(rid).def).toBe("xf-tug");
    immobilise(sim, vid);
    call(sim, vid);
    run(sim, 900, () => undefined, () => sim.state.vehicle.req(vid).towAway === true);
    expect(sim.state.vehicle.req(vid).recovery?.state).toBe("towed");
  });
});

describe("recovery: the end of the battle and the roster (M11.7b, D18/D19)", () => {
  it("an immobilised hull on ground its side holds is recovered; on ground the enemy holds, captured; the records go round", () => {
    // Own ground: nobody else near.
    const a = build({ timeLimitS: 20 });
    a.forces[0]!.vehicles![0]!.status = "immobilised";
    a.forces[0]!.vehicles![0]!.components = (() => { const c = a.catalog.vehicles[a.forces[0]!.vehicles![0]!.type]!.components!.map(() => 1); c[2] = 0; return c; })();
    const ra = runBattle(a);
    const recA = ra.forcesOut[0]!.vehicles!.find((r) => r.vehicleId === a.forces[0]!.vehicles![0]!.vehicleId)!;
    expect(recA.recovery?.state).toBe("recovered");
    expect(recA.recovery?.repairDays).toBeGreaterThan(0);
    expect(recA.capturedBy ?? null).toBeNull();
    expect(ra.sides[0]!.vehicles!.recovered).toBe(1);
    // The enemy's squad beside it, more men than its crew: captured.
    const b = build({ timeLimitS: 20, redSquadAt: { x: 420, y: 600, spacing: 3 } });
    b.forces[0]!.vehicles![0]!.status = "immobilised";
    const rb = runBattle(b);
    const recB = rb.forcesOut[0]!.vehicles!.find((r) => r.vehicleId === b.forces[0]!.vehicles![0]!.vehicleId)!;
    expect(recB.recovery?.state).toBe("captured");
    expect(recB.capturedBy).toBe("red");
    expect(rb.sides[0]!.vehicles!.captured).toBe(1);
    // Round trip: the record goes back in and comes out unchanged (recovery, capturedBy, components).
    const c = build({ timeLimitS: 2 });
    c.forces[0]!.vehicles = c.forces[0]!.vehicles!.map((r): VehicleRecord => (r.vehicleId === recB.vehicleId ? { ...recB } : r));
    const rc = runBattle(c);
    const recC = rc.forcesOut[0]!.vehicles!.find((r) => r.vehicleId === recB.vehicleId)!;
    expect(recC.recovery).toEqual(recB.recovery);
    expect(recC.capturedBy).toBe("red");
    expect(recC.components).toEqual(recB.components);
  });

  it("a hull towed away in the battle comes out as towed (and counted)", () => {
    const input = build({ timeLimitS: 700 });
    input.forces[0]!.vehicles![0]!.status = "immobilised";
    const unitKey = input.forces[0]!.units[0]!.subunits.find((u) => u.vehicleId === input.forces[0]!.vehicles![0]!.vehicleId)!;
    expect(unitKey).toBeDefined();
    // The order goes in the input's stream (rule 3): the crew calls at once.
    const sim = createSim(input);
    const crew = sim.state.vehicle.req([...sim.state.vehicle.entries()].find(([, v]) => v.side === "blue" && v.offMap === undefined)![0]).unit!;
    input.orders = [{ tick: 1, issuer: "blue", target: crew, kind: "callRecovery", player: true }];
    const res = runBattle(input);
    const rec = res.forcesOut[0]!.vehicles!.find((r) => r.vehicleId === input.forces[0]!.vehicles![0]!.vehicleId)!;
    expect(rec.recovery?.state).toBe("towed");
    expect(res.sides[0]!.vehicles!.towed).toBe(1);
  });
});
