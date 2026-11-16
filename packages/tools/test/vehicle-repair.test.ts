/**
 * Field repair (M11.7a, plan §8 and amendments): a crew fixes a broken track, a holed wheel side, the coax and the
 * radio with time and the parts aboard (counted items, rule 9); the men work outside exposed or inside off their
 * stations; a hit, fire on them, a move order stop the work (progress and parts kept); a failed task is beyond the
 * crew; nothing happens without core/repair.json, with `rules.repair = false`, on a hull without components or on a
 * lab target frozen whole; the drill saved and loaded mid-way continues identically; the xf fixture works.
 */
import { describe, expect, it } from "vitest";
import {
  componentIndex, countItems, createSim, isOutside, launchProjectile, sideKnowledge, standZ, loadSim, registerActionHandler, repairTaskFor, saveSim, simHash, startAction, step, submitOrder, TICK_HZ,
  type BattleInput, type Catalog, type EntityId, type RepairTaskDef, type Sim, type SimEvent,
} from "@tcs/sim";
import { duel } from "../src/labs/gunnery";
import { loadData } from "../src/scenarios";

const data = loadData();
const fixtures = loadData(true);

type RepairEv = Extract<SimEvent, { kind: "vehicle.repair" }>;
function run(sim: Sim, seconds: number, on: (e: SimEvent) => void = () => undefined): void {
  for (let i = 0; i < seconds * TICK_HZ; i++) for (const e of step(sim)) on(e);
}
function holdAll(sim: Sim): void {
  for (const [uid, u] of sim.state.unit.entries()) if (u.parent === null) submitOrder(sim, { tick: sim.state.tick, issuer: u.side, target: uid, kind: "rules", fire: "hold", at: "hold" });
  step(sim);
}
/** The catalog with quicker (or otherwise changed) repair tasks: the drill is the same, the tests shorter. */
function withTasks(input: BattleInput, tasks: Partial<Record<string, Partial<RepairTaskDef>>>): BattleInput {
  const R = input.catalog.repair!;
  const t = { ...R.tasks } as Record<string, RepairTaskDef>;
  for (const [k, v] of Object.entries(tasks)) t[k] = { ...t[k]!, ...v };
  input.catalog = { ...input.catalog, repair: { ...R, tasks: t } } as Catalog;
  return input;
}
interface Field { sim: Sim; input: BattleInput; vid: EntityId }
/** One own hull at (400, 600) facing east, the enemy 1.6 km off; everyone holds fire. */
function field(opts: { factions?: [string, string]; crews?: [string, string]; squads?: [string, string]; fixture?: boolean; quick?: boolean; tasks?: Partial<Record<string, Partial<RepairTaskDef>>>; noRepair?: boolean } = {}): Field {
  let input = duel(opts.fixture ? fixtures : data, opts.factions ?? ["de", "ru"], { blue: { x: 400, y: 600, heading: 0 }, red: { x: 2000, y: 600, heading: Math.PI } }, opts.squads, 2400, opts.crews);
  if (opts.quick !== false) input = withTasks(input, { track: { manMin: 6 }, wheels: { manMin: 4 }, coax: { manMin: 2 }, radio: { manMin: 2 }, ...(opts.tasks ?? {}) });
  else if (opts.tasks) input = withTasks(input, opts.tasks);
  if (opts.noRepair) input.rules.repair = false;
  const sim = createSim(input);
  holdAll(sim);
  const vid = [...sim.state.vehicle.entries()].find(([, v]) => v.side === "blue")![0];
  return { sim, input, vid };
}
/** Break one component (index of the first of that kind, or the given index) and set the status the hit would. */
function breakComp(sim: Sim, vid: EntityId, kind: Parameters<typeof componentIndex>[1], c: number, nth = 0): number {
  const v = sim.state.vehicle.req(vid), def = sim.ctx.catalog.vehicles[v.def]!;
  const ks = def.components!.map((x, k) => (x.kind === kind ? k : -1)).filter((k) => k >= 0);
  const k = ks[nth]!;
  v.comp[k] = c;
  if (c <= 0 && (kind === "track" || kind === "wheels" || kind === "engine" || kind === "transmission")) v.status = "immobilised";
  return k;
}
const stacks = (sim: Sim, vid: EntityId) => sim.state.container.req(vid).stacks.map((s) => ({ ...s }));

describe("field repair: a broken track (M11.7a)", () => {
  it("the crew repairs it in the expected time, uses two links, keeps the tool kit; immobilised -> ok; the hull drives again", () => {
    const { sim, vid } = field();
    const v = sim.state.vehicle.req(vid);
    const k = breakComp(sim, vid, "track", 0);
    const before = stacks(sim, vid);
    const evs: RepairEv[] = [];
    let outsideSeen = 0, cmdOutside = 0;
    const def = sim.ctx.catalog.vehicles[v.def]!;
    const drv = v.seats[def.seats.findIndex((s) => s.station === "driver")]!;
    const cmd = v.seats[def.seats.findIndex((s) => s.station === "commander")]!;
    for (let i = 0; i < 400 * TICK_HZ && !evs.some((e) => e.phase === "done"); i++) {
      for (const e of step(sim)) if (e.kind === "vehicle.repair") evs.push(e);
      if (isOutside(sim.state, drv)) {
        outsideSeen++;
        if (outsideSeen === 30) {
          // On the ground beside the hull, crouching, facing it; the commander stays at his post.
          const mt = sim.state.transform.req(drv), t = sim.state.transform.req(vid);
          expect(mt.z).toBe(0);
          expect(Math.hypot(mt.x - t.x, mt.y - t.y)).toBeGreaterThan(Math.abs(def.body.hull.r[0]));
          expect(sim.state.soldier.req(drv).posture).toBe("crouching");
        }
      }
      if (isOutside(sim.state, cmd)) cmdOutside++;
    }
    const started = evs.find((e) => e.phase === "started")!, done = evs.find((e) => e.phase === "done")!;
    expect(started.component).toBe(k);
    expect(started.part).toBe("track");
    // Expected: the man-minutes over the two men's rates (driver x1.25), within the 1 s step.
    const took = (done.tick - started.tick) / TICK_HZ;
    expect(Math.abs(took - started.etaS!)).toBeLessThanOrEqual(2);
    expect(outsideSeen).toBeGreaterThan(0);
    expect(cmdOutside).toBe(0);
    expect(done.status).toBe("ok");
    expect(v.status).toBe("ok");
    expect(v.comp[k]).toBeCloseTo(0.8);
    expect(done.parts).toEqual([{ item: "de-kettenglied-puma", count: 2 }]);
    // Parts conservation: exactly two links fewer, everything else (the tool kit too) as it was.
    const after = stacks(sim, vid);
    const count = (ss: { type: string; count: number }[], t: string) => ss.filter((s) => s.type === t).reduce((n, s) => n + s.count, 0);
    for (const t of new Set([...before, ...after].map((s) => s.type))) expect(count(after, t)).toBe(count(before, t) - (t === "de-kettenglied-puma" ? 2 : 0));
    expect(count(after, "de-bordwerkzeug")).toBe(1);
    // Nobody is outside any more, and the hull drives.
    expect(isOutside(sim.state, drv)).toBe(false);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: v.unit!, kind: "move", waypoints: [{ x: 600, y: 600, mode: "run" }] });
    run(sim, 20);
    expect(sim.state.transform.req(vid).x).toBeGreaterThan(450);
  });

  it("a hit mid-way stops the work: progress and parts kept, it resumes after the quiet period", () => {
    const { sim, vid } = field();
    const v = sim.state.vehicle.req(vid);
    breakComp(sim, vid, "track", 0);
    const evs: RepairEv[] = [];
    const radio: string[] = [];
    let hitAt = -1;
    for (let i = 0; i < 600 * TICK_HZ && !evs.some((e) => e.phase === "done"); i++) {
      for (const e of step(sim)) { if (e.kind === "vehicle.repair") evs.push(e); if (e.kind === "radio" && e.side === "blue") radio.push(e.key); }
      if (hitAt < 0 && v.repair && v.repair.doneManS > v.repair.needManS / 2) { hitAt = sim.state.tick; v.lastHitTick = sim.state.tick; }
    }
    const phases = evs.map((e) => e.phase);
    expect(phases).toEqual(["started", "interrupted", "resumed", "done"]);
    const stop = evs[1]!, resume = evs[2]!, started = evs[0]!, done = evs[3]!;
    expect(stop.why).toBe("hit");
    expect(countItems(sim.state.container.req(vid), "de-kettenglied-puma")).toBe(2);
    // Resumed after the quiet period, finished with the work left (not from scratch).
    expect((resume.tick - hitAt) / TICK_HZ).toBeGreaterThanOrEqual(60);
    expect((resume.tick - hitAt) / TICK_HZ).toBeLessThanOrEqual(62);
    const worked = (stop.tick - started.tick + done.tick - resume.tick) / TICK_HZ;
    expect(Math.abs(worked - started.etaS!)).toBeLessThanOrEqual(3);
    expect(radio).toContain("radio.vehicleRepairing");
    expect(radio).toContain("radio.repairStopped");
    expect(radio).toContain("radio.vehicleRepaired");
  });

  it("the outside men are bodies in the open: bullets and fragments can reach them, contacts list them; inside men are off their stations", () => {
    const { sim, vid } = field();
    const v = sim.state.vehicle.req(vid), def = sim.ctx.catalog.vehicles[v.def]!;
    breakComp(sim, vid, "track", 0);
    run(sim, 5);
    const drv = v.seats[def.seats.findIndex((s) => s.station === "driver")]!;
    expect(isOutside(sim.state, drv)).toBe(true);
    // A man on the other side's knowledge lists him (men aboard never are).
    const redMan = [...sim.state.soldier.entries()].find(([id]) => sim.state.identity.get(id)?.side === "red" && sim.state.soldier.get(id)?.mount === undefined)![1];
    redMan.contacts.push({ target: drv, x: sim.state.transform.req(drv).x, y: sim.state.transform.req(drv).y, errM: 1, kind: "seen", tick: sim.state.tick, reportedTick: sim.state.tick });
    expect(sideKnowledge(sim.ctx, sim.state, "red").some((k) => k.target === drv)).toBe(true);
    // Rounds fired at him from 30 m at crouch height strike him (a man in his seat could not be hit so).
    const mt = { ...sim.state.transform.req(drv) }, t = sim.state.transform.req(vid);
    const ux = (mt.x - t.x) / Math.hypot(mt.x - t.x, mt.y - t.y), uy = (mt.y - t.y) / Math.hypot(mt.x - t.x, mt.y - t.y);
    const owner = [...sim.state.identity.entries()].find(([, i]) => i.side === "red")![0];
    const gz = standZ(sim.ctx.map, mt) + 0.75;
    const hits: EntityId[] = [];
    for (let i = 0; i < 6; i++) {
      launchProjectile(sim.ctx, sim.state, "ru-545-7n10", mt.x + ux * 30, mt.y + uy * 30 + (i - 3) * 0.05, gz, -ux * 850, -uy * 850, 0, owner);
      run(sim, 0.2, (e) => { if (e.kind === "hit") hits.push(e.target); });
    }
    expect(hits).toContain(drv);
  });

  it("a move order ends the work (the men back in); the hull, mobile with a broken coax, drives off; work resumes once it halts", () => {
    const { sim, vid } = field({ tasks: { coax: { manMin: 4, chance: 1 } } });
    const v = sim.state.vehicle.req(vid);
    breakComp(sim, vid, "coax", 0);
    const evs: RepairEv[] = [];
    run(sim, 30, (e) => { if (e.kind === "vehicle.repair") evs.push(e); });
    expect(evs.map((e) => e.phase)).toEqual(["started"]);
    expect(v.status).toBe("ok");
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: v.unit!, kind: "move", waypoints: [{ x: 500, y: 600, mode: "walk" }] });
    run(sim, 2, (e) => { if (e.kind === "vehicle.repair") evs.push(e); });
    expect(evs[1]?.phase).toBe("interrupted");
    expect(evs[1]?.why).toBe("ordered");
    const done0 = v.repair!.doneManS;
    expect(done0).toBeGreaterThan(0);
    run(sim, 400, (e) => { if (e.kind === "vehicle.repair") evs.push(e); });
    expect(sim.state.transform.req(vid).x).toBeGreaterThan(470);
    expect(evs.map((e) => e.phase)).toEqual(["started", "interrupted", "resumed", "done"]);
  });
});

describe("what a crew cannot repair (M11.7a, plan B1)", () => {
  it("no parts: no start, the order is refused; light damage below the task line is left; an engine kill makes the track beyond the crew", () => {
    const { sim, vid } = field();
    const v = sim.state.vehicle.req(vid), def = sim.ctx.catalog.vehicles[v.def]!;
    // A track at 0.9: not a task (restores to 0.8), nothing used.
    const k = breakComp(sim, vid, "track", 0.9);
    expect(repairTaskFor(sim.ctx.catalog, sim.state, vid, v, def)).toBe("nothing");
    // Track at 0 and the engine at 0: the hull would stay immobile: beyond the crew.
    v.comp[k] = 0; v.status = "immobilised";
    const ke = componentIndex(def, "engine");
    v.comp[ke] = 0;
    expect(repairTaskFor(sim.ctx.catalog, sim.state, vid, v, def)).toBe("beyondCrew");
    v.comp[ke] = 1;
    // Without the links: no parts.
    const c = sim.state.container.req(vid);
    const links = countItems(c, "de-kettenglied-puma");
    c.stacks = c.stacks.filter((s) => s.type !== "de-kettenglied-puma");
    expect(repairTaskFor(sim.ctx.catalog, sim.state, vid, v, def)).toBe("noParts");
    const radio: string[] = [], evs: RepairEv[] = [];
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: v.unit!, kind: "repair", player: true });
    run(sim, 30, (e) => { if (e.kind === "radio" && e.side === "blue") radio.push(e.key); if (e.kind === "vehicle.repair") evs.push(e); });
    expect(radio).toContain("radio.repairNoParts");
    expect(evs).toEqual([]);
    expect(links).toBe(4);
  });

  it("a failed task (chance 0) is beyond the crew: no retry, the order is refused; the parts of a coax task are used", () => {
    const { sim, vid } = field({ tasks: { coax: { manMin: 1, chance: 0 } } });
    const v = sim.state.vehicle.req(vid);
    const k = breakComp(sim, vid, "coax", 0);
    const evs: RepairEv[] = [], radio: string[] = [];
    run(sim, 120, (e) => { if (e.kind === "vehicle.repair") evs.push(e); if (e.kind === "radio" && e.side === "blue") radio.push(e.key); });
    expect(evs.map((e) => e.phase)).toEqual(["started", "failed"]);
    expect(v.repairBeyond).toEqual([k]);
    expect(v.comp[k]).toBe(0);
    expect(countItems(sim.state.container.req(vid), "de-mg5-rohr")).toBe(0);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: v.unit!, kind: "repair", player: true });
    run(sim, 5, (e) => { if (e.kind === "radio" && e.side === "blue") radio.push(e.key); });
    expect(radio).toContain("radio.repairBeyond");
  });

  it("nothing at all: repair off by rule, a lab target frozen whole, a hull without components", () => {
    const off = field({ noRepair: true });
    breakComp(off.sim, off.vid, "track", 0);
    const evs: SimEvent[] = [];
    run(off.sim, 60, (e) => { if (e.kind === "vehicle.repair") evs.push(e); });
    expect(evs).toEqual([]);
    // A target entering immobilised with every part whole (the labs' frozen targets): never repaired.
    const input = duel(data, ["de", "ru"], { blue: { x: 400, y: 600, heading: 0 }, red: { x: 2000, y: 600, heading: Math.PI } });
    for (const rec of input.forces[0]!.vehicles ?? []) rec.status = "immobilised";
    const sim = createSim(input);
    holdAll(sim);
    run(sim, 90, (e) => { if (e.kind === "vehicle.repair") evs.push(e); });
    expect(evs).toEqual([]);
    expect([...sim.state.vehicle.values()].find((v) => v.side === "blue")!.status).toBe("immobilised");
    // The fixture cart has no components: nothing to repair.
    const cart = field({ fixture: true, factions: ["xf", "de"], squads: ["porter-band", "pzgren-schuetzentrupp"], crews: ["cart-crew", "puma-besatzung"] });
    const cv = cart.sim.state.vehicle.req(cart.vid);
    expect(repairTaskFor(cart.sim.ctx.catalog, cart.sim.state, cart.vid, cv, cart.sim.ctx.catalog.vehicles[cv.def]!)).toBe("nothing");
  });
});

describe("who works (M11.7a, plan A4, B2)", () => {
  it("a busy man is not taken: the other starts alone, the busy one joins when free; a GTK's wheels take its driver only", () => {
    registerActionHandler("testBusy", { check: () => null, complete: () => undefined });
    const { sim, vid } = field();
    const v = sim.state.vehicle.req(vid), def = sim.ctx.catalog.vehicles[v.def]!;
    const drv = v.seats[def.seats.findIndex((s) => s.station === "driver")]!;
    const gnr = v.seats[def.seats.findIndex((s) => s.station === "gunner")]!;
    startAction(sim.state, { emit: () => undefined } as never, drv, "testBusy", 20 * TICK_HZ, {});
    breakComp(sim, vid, "track", 0);
    run(sim, 3);
    expect(sim.state.action.get(drv)?.kind).toBe("testBusy");
    expect(isOutside(sim.state, gnr)).toBe(true);
    run(sim, 20);
    expect(isOutside(sim.state, drv)).toBe(true);

    const gtk = field({ crews: ["boxer-besatzung", "bmp2-ekipazh"] });
    const gv = gtk.sim.state.vehicle.req(gtk.vid), gdef = gtk.sim.ctx.catalog.vehicles[gv.def]!;
    const k = breakComp(gtk.sim, gtk.vid, "wheels", 0);
    const evs: RepairEv[] = [];
    run(gtk.sim, 3, (e) => { if (e.kind === "vehicle.repair") evs.push(e); });
    const out = gv.seats.filter((m) => m !== null && isOutside(gtk.sim.state, m));
    expect(out).toEqual([gv.seats[gdef.seats.findIndex((s) => s.station === "driver")]]);
    run(gtk.sim, 400, (e) => { if (e.kind === "vehicle.repair") evs.push(e); });
    expect(evs.map((e) => e.phase)).toEqual(["started", "done"]);
    // A holed side back to limping: mobile, no part used (none carried).
    expect(gv.comp[k]).toBeCloseTo(0.5);
    expect(gv.status).toBe("ok");
    expect(evs[1]!.parts).toBeUndefined();
  });

  it("the player's order skips the quiet period (not a fresh hit)", () => {
    const { sim, vid } = field({ quick: true });
    const v = sim.state.vehicle.req(vid);
    breakComp(sim, vid, "track", 0);
    // Hit 30 s ago: the drill waits (60 s), the order goes now; hit just now: refused.
    v.lastHitTick = sim.state.tick - 3 * TICK_HZ;
    const radio: string[] = [], evs: RepairEv[] = [];
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: v.unit!, kind: "repair", player: true });
    run(sim, 2, (e) => { if (e.kind === "radio" && e.side === "blue") radio.push(e.key); if (e.kind === "vehicle.repair") evs.push(e); });
    expect(radio).toContain("radio.repairUnderFire");
    expect(evs).toEqual([]);
    v.lastHitTick = sim.state.tick - 30 * TICK_HZ;
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: v.unit!, kind: "repair", player: true });
    run(sim, 2, (e) => { if (e.kind === "radio" && e.side === "blue") radio.push(e.key); if (e.kind === "vehicle.repair") evs.push(e); });
    expect(radio).toContain("radio.ack.repair");
    expect(evs.map((e) => [e.phase, e.ordered])).toEqual([["started", true]]);
  });
});

describe("the fixture faction (rule 8)", () => {
  it("the xf tug's crew fixes a track with xf-links; the litter cart's crew a wheel side without parts", () => {
    const tug = field({ fixture: true, factions: ["xf", "de"], squads: ["porter-band", "pzgren-schuetzentrupp"], crews: ["tug-crew", "puma-besatzung"] });
    const k = breakComp(tug.sim, tug.vid, "track", 0, 1);
    const evs: RepairEv[] = [];
    run(tug.sim, 600, (e) => { if (e.kind === "vehicle.repair") evs.push(e); });
    expect(evs.map((e) => e.phase)).toEqual(["started", "done"]);
    expect(evs[0]!.component).toBe(k);
    expect(evs[1]!.parts).toEqual([{ item: "xf-link", count: 2 }]);
    expect(countItems(tug.sim.state.container.req(tug.vid), "xf-link")).toBe(2);
    expect(tug.sim.state.vehicle.req(tug.vid).status).toBe("ok");
    const cart = field({ fixture: true, factions: ["xf", "de"], squads: ["porter-band", "pzgren-schuetzentrupp"], crews: ["litter-crew", "puma-besatzung"] });
    breakComp(cart.sim, cart.vid, "wheels", 0);
    const ev2: RepairEv[] = [];
    run(cart.sim, 400, (e) => { if (e.kind === "vehicle.repair") ev2.push(e); });
    expect(ev2.map((e) => e.phase)).toEqual(["started", "done"]);
  });
});

describe("determinism mid-repair (M11.7a)", () => {
  it("a battle with a repair under way, saved every 37 ticks through JSON, continues identically", () => {
    const base = field({ tasks: { track: { manMin: 3 }, coax: { manMin: 1, chance: 0.5 } } });
    const runIt = (saveEvery: number | null) => {
      let sim = createSim(base.input);
      holdAll(sim);
      const vid = [...sim.state.vehicle.entries()].find(([, v]) => v.side === "blue")![0];
      breakComp(sim, vid, "track", 0);
      breakComp(sim, vid, "coax", 0);
      const hashes: string[] = [];
      const phases: string[] = [];
      for (let t = 0; t < 260 * TICK_HZ; t++) {
        if (t === 60 * TICK_HZ) sim.state.vehicle.req(vid).lastHitTick = sim.state.tick; // an interruption
        for (const e of step(sim)) if (e.kind === "vehicle.repair") phases.push(e.phase);
        if (saveEvery !== null && sim.state.tick % saveEvery === 0) sim = loadSim(base.input, JSON.parse(JSON.stringify(saveSim(sim))));
        if (sim.state.tick % 60 === 0) hashes.push(simHash(sim));
      }
      return { hashes, phases };
    };
    const a = runIt(null), b = runIt(37);
    expect(a.phases).toContain("interrupted");
    expect(a.phases.filter((p) => p === "done" || p === "failed").length).toBe(2);
    expect(b.phases).toEqual(a.phases);
    expect(b.hashes).toEqual(a.hashes);
  });
});
