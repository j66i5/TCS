/**
 * M11.9a prisoners of war (plan docs/plans/m11-mp-pow.md slice 53): the collection point (siting, apart from the nest
 * and the supply point, moved when threatened), the search (taken and kept per item, documents, the overflow cache),
 * segregation by NATO code (and the xf fallback), escorts (the bearer filter, not under fire or in an assault), guards
 * (ceil(n / 6)), wounded prisoners to the captors' nest, the orders and their refusals, save/load mid-search and
 * mid-escort, the same rules for both sides, and the ledger (exact).
 */
import { describe, expect, it } from "vitest";
import { buildCatalog } from "@tcs/data";
import {
  checkConservation, consumedFromEvents, stackMassKg, createSim, emptyConsumption, hashState, isResponder, ledgerOf, loadSim, prisonerGroup, saveSim, step, submitOrder, tracerMap,
  type EntityId, type SerializedState, type SimEvent,
} from "@tcs/sim";
import { loadData } from "../src/scenarios";
import { prisonersBattle } from "../src/labs/prisoners";

const data = loadData();
const TPL: Record<string, string> = { de: "pzgren-zug", ru: "motor-rifle-platoon" };

function battle(faction: "de" | "ru", seed = 1, tweak?: (b: ReturnType<typeof prisonersBattle>) => void) {
  const b = prisonersBattle(data, faction, TPL[faction]!, seed);
  tweak?.(b);
  const sim = createSim(b.input);
  for (const [uid] of sim.state.unit.entries()) sim.state.unit.req(uid).fireRule = "hold";
  const events: SimEvent[] = [];
  const cons = emptyConsumption(), tracer = tracerMap(b.input.catalog);
  const start = ledgerOf(b.input.catalog, sim.state);
  const id = (p: string): EntityId => [...sim.state.identity.entries()].find(([, i]) => i.personId === p)![0];
  const run = (seconds: number, until?: () => boolean) => {
    for (let t = 0; t < seconds * 60; t++) {
      const out = step(sim);
      consumedFromEvents(cons, out, tracer);
      events.push(...out);
      if (until && t % 60 === 0 && until()) return;
    }
  };
  const pris = b.pris.map((m) => id(m.personId));
  return { ...b, recs: b.pris, sim, events, id, run, pris, leaks: () => checkConservation(start, ledgerOf(b.input.catalog, sim.state), cons) };
}
const of = <K extends SimEvent["kind"]>(ev: SimEvent[], k: K) => ev.filter((e): e is Extract<SimEvent, { kind: K }> => e.kind === k);

describe("prisoners (M11.9a)", () => {
  it("groups come from the rank's NATO code; a rank without one, or the fixture faction, falls back to 'man'", () => {
    const b = battle("de");
    const st = b.sim.state;
    expect(b.pris.slice(0, 7).map((m) => prisonerGroup(b.sim.ctx, st, m))).toEqual(["officer", "nco", "man", "man", "man", "man", "man"]);
    const m = b.pris[2]!;
    st.identity.req(m).rank = "no-such-rank";
    expect(prisonerGroup(b.sim.ctx, st, m)).toBe("man");
    // The fixture faction: its codes (boss OR-6 is an NCO); without prisoners data, no codes at all.
    const xf = buildCatalog(loadData(true), ["xf"]);
    expect(xf.factions["xf"]!.natoCodes).toEqual({ boss: "OR-6", private: "OR-1" });
  });

  it("every unit leader of both factions (and the fixture) carries documents; documents are never kept", () => {
    const all = loadData(true);
    for (const f of ["de", "ru", "xf"] as const) {
      const pack = all.factions[f]!;
      for (const u of Object.values(pack.units)) {
        const li = u.leaderIndex;
        if (li < 0 || li >= u.members.length) continue;
        expect(u.members[li]!.load.some((l) => pack.items[l.item]?.documents === true), `${u.id}`).toBe(true);
      }
      for (const it of Object.values(pack.items)) if (it.documents === true) expect(it.prisonerKeeps).toBe(false);
    }
  });

  for (const f of ["de", "ru"] as const) {
    it(`${f}: search, segregation, escorts, guards, the point and the nest (same rules for both sides)`, () => {
      const b = battle(f);
      const st = b.sim.state, cat = b.input.catalog, P = cat.prisoners!;
      // (Review fix: the man who cannot walk goes to the nest unsearched and is searched there.)
      b.run(1200, () => b.pris.slice(0, 6).every((m) => st.soldier.req(m).captive?.point !== undefined) && st.soldier.req(b.pris[6]!).atNest !== undefined && st.soldier.req(b.pris[6]!).captive?.searched !== undefined);
      // The point: behind the platoon, apart from the nest and the supply point.
      const pt = [...st.rear.entries()].find(([, p]) => p.kind === "prisoners")!;
      expect(pt).toBeDefined();
      for (const k of ["medical", "supply"] as const) {
        const q = [...st.rear.entries()].find(([, p]) => p.kind === k)![1];
        expect(Math.hypot(q.x - pt[1].x, q.y - pt[1].y)).toBeGreaterThanOrEqual(P.pcp.apartM);
      }
      expect(pt[1].x).toBeLessThan(450);
      // Escorts walk one group each, never more than perGuard; never a leader, gunner, medic or first responder.
      for (const e of of(b.events, "pow.escort")) {
        expect(new Set(e.prisoners.map((m) => st.soldier.req(m).captive!.group)).size).toBe(1);
        expect(e.prisoners.length).toBeLessThanOrEqual(P.escort.perGuard);
        const u = st.unit.req(st.identity.req(e.escort).unit);
        expect(u.leader).not.toBe(e.escort);
        expect(isResponder(cat, st, e.escort)).toBe(false);
        const w = st.weapon.get(e.escort);
        expect(w === undefined || cat.weapons[w.weapon]!.sustained === undefined).toBe(true);
      }
      // Searched: nothing of the taken classes left; every kept item still on him; 30 s a man.
      for (const [k, m] of b.pris.entries()) {
        const s = st.soldier.req(m);
        expect(s.captive!.searched).toBeDefined();
        expect(st.weapon.has(m)).toBe(false);
        expect(s.power).toBeUndefined();
        for (const x of st.container.get(m)!.stacks) expect(cat.items[x.type]?.prisonerKeeps, x.type).toBe(true);
        for (const l of b.recs[k]!.load) if (cat.items[l.type]?.prisonerKeeps === true) {
          expect(st.container.get(m)!.stacks.filter((x) => x.type === l.type).reduce((n, x) => n + x.count, 0)).toBeGreaterThanOrEqual(l.count);
        }
      }
      const started = new Map<EntityId, number>();
      for (const e of b.events) {
        if (e.kind === "action.started" && e.action === "searchPrisoner") started.set(e.actor, e.tick);
        if (e.kind === "action.completed" && e.action === "searchPrisoner") expect(e.tick - started.get(e.actor)!).toBe(P.search.seconds * 60);
      }
      expect(of(b.events, "pow.documents").length).toBeGreaterThan(0);
      // What the escorts could not carry is in a captured cache (review fix: where they searched); none walks his
      // prisoners back with more than maxKg of what he took.
      for (const e of of(b.events, "pow.cached")) {
        const c = st.cache.req(e.cache);
        expect(c.side).toBe("blue"); expect(c.capturedBy).toBe("blue"); expect(c.from).toBe("red");
      }
      for (const [, s] of st.soldier.entries()) if (s.guard?.took) expect(s.guard.took.reduce((n, x) => n + stackMassKg(cat, x), 0)).toBeLessThanOrEqual(P.search.maxKg + 1e-6);
      // Held apart by group; guards = ceil(held / perGuard), out of the fight.
      let held = 0;
      for (const m of b.pris.slice(0, 6)) {
        const s = st.soldier.req(m), t = st.transform.req(m);
        held++;
        const off = s.captive!.group === "officer" ? -P.segregation.apartM : s.captive!.group === "nco" ? P.segregation.apartM : 0;
        expect(Math.hypot(t.x - (pt[1].x + off), t.y - pt[1].y)).toBeLessThan(P.segregation.apartM / 2);
      }
      const guards = [...st.soldier.entries()].filter(([, s]) => s.guard?.phase === "guard");
      expect(guards.length).toBe(Math.ceil(held / P.guard.perGuard));
      // The man who cannot walk lies at the captors' nest.
      const lame = st.soldier.req(b.pris[6]!);
      expect(st.rear.req(lame.atNest!).side).toBe("blue");
      expect(Object.keys(b.leaks())).toEqual([]);
    });
  }

  it("no escort while the capturing squad is fired on or in an assault; the order sends one anyway", () => {
    const b = battle("de");
    const st = b.sim.state;
    // Keep the capturing squad "under fire" (as if rounds kept cracking past it).
    const squad = () => st.unit.req(st.soldier.req(b.pris[0]!).captive!.unit!);
    const blue = [...st.unit.entries()].filter(([, u]) => u.side === "blue").map(([k]) => k);
    for (let k = 0; k < 60; k++) { for (const u of blue) st.unit.req(u).ownFireTick = st.tick; b.run(1); }
    expect(b.pris.slice(0, 6).every((m) => st.soldier.req(m).captive?.state === "captured")).toBe(true);
    expect(of(b.events, "pow.escort").length).toBe(0);
    // The player's "Escort prisoners" waives the gate.
    submitOrder(b.sim, { tick: st.tick, issuer: "blue", target: st.soldier.req(b.pris[0]!).captive!.unit!, kind: "escortPrisoners", player: true });
    squad().ownFireTick = st.tick;
    b.run(2);
    expect(of(b.events, "pow.escort").length).toBeGreaterThan(0);
    expect(of(b.events, "pow.escort").every((e) => e.ordered === true)).toBe(true);
  });

  it("orders: prisoner point refused at the nest or supply point; release guard refused for the last guard near an enemy", () => {
    const b = battle("ru");
    const st = b.sim.state;
    b.run(1200, () => [...st.soldier.values()].some((s) => s.guard?.phase === "guard"));
    const top = [...st.rear.values()].find((p) => p.kind === "prisoners")!.unit;
    const nest = [...st.rear.values()].find((p) => p.kind === "medical")!;
    const radio = () => of(b.events, "radio").map((e) => e.key);
    submitOrder(b.sim, { tick: st.tick, issuer: "blue", target: top, kind: "prisonerPoint", x: nest.x + 5, y: nest.y });
    b.run(1);
    expect(radio()).toContain("radio.powNearNest");
    // Put it 120 m east of the nest: it moves there, the held prisoners walk over.
    submitOrder(b.sim, { tick: st.tick, issuer: "blue", target: top, kind: "prisonerPoint", x: Math.min(1900, nest.x + 120), y: nest.y });
    b.run(1);
    expect(of(b.events, "pow.point").at(-1)!.reason).toBe("ordered");
    // The last guard, an enemy known within enemyM: refused unless confirmed.
    const guard = [...st.soldier.entries()].find(([, s]) => s.guard?.phase === "guard")![0];
    const p = [...st.rear.values()].find((q) => q.kind === "prisoners")!;
    const lead = st.unit.req(top).leader!;
    const cs = st.soldier.req(lead).contacts, tgt = b.pris[6]!;
    const c = { target: tgt, x: p.x + 100, y: p.y, errM: 1, kind: "seen" as const, tick: st.tick, reportedTick: st.tick };
    const at = cs.findIndex((x) => x.target >= tgt);
    if (at >= 0 && cs[at]!.target === tgt) cs[at] = c; else if (at >= 0) cs.splice(at, 0, c); else cs.push(c);
    submitOrder(b.sim, { tick: st.tick, issuer: "blue", target: guard, kind: "releaseGuard" });
    b.run(1);
    expect(radio()).toContain("radio.powLastGuard");
    expect(st.soldier.req(guard).guard).toBeDefined();
    submitOrder(b.sim, { tick: st.tick, issuer: "blue", target: guard, kind: "releaseGuard", confirm: true });
    b.run(1);
    expect(st.soldier.req(guard).guard).toBeUndefined();
    expect(of(b.events, "pow.guard").some((e) => e.phase === "released" && e.ordered === true)).toBe(true);
    // Nobody waiting, nobody on duty: refused.
    submitOrder(b.sim, { tick: st.tick, issuer: "blue", target: top, kind: "escortPrisoners" });
    b.run(1);
    expect(radio()).toContain("radio.powNone");
  });

  it("an order to a guard's unit passes him by", () => {
    const b = battle("de");
    const st = b.sim.state;
    b.run(1200, () => [...st.soldier.values()].some((s) => s.guard?.phase === "guard"));
    const [g, gs] = [...st.soldier.entries()].find(([, s]) => s.guard?.phase === "guard")!;
    const at = { ...st.transform.req(g) };
    submitOrder(b.sim, { tick: st.tick, issuer: "blue", target: st.identity.req(g).unit, kind: "move", waypoints: [{ x: at.x + 60, y: at.y, mode: "walk" }] });
    b.run(20);
    expect(gs.guard?.phase).toBe("guard");
    // (He may still be stepping to his own place at the point, up to 3 x arriveM from where his escort ended; the
    // order would have taken him 60 m east.)
    expect(Math.hypot(st.transform.req(g).x - at.x, st.transform.req(g).y - at.y)).toBeLessThan(8);
  });

  it("review fix: a guard goes back to his squad once his platoon holds nobody", () => {
    const b = battle("de");
    const st = b.sim.state;
    b.run(1200, () => [...st.soldier.values()].some((s) => s.guard?.phase === "guard"));
    const [g, gs] = [...st.soldier.entries()].find(([, s]) => s.guard?.phase === "guard")!;
    // (Every prisoner taken off the map at once.)
    for (const m of b.pris) st.soldier.req(m).evacuated = { tick: st.tick, via: "end" };
    b.run(3);
    expect(gs.guard).toBeUndefined();
    expect(of(b.events, "pow.guard").some((e) => e.soldier === g && e.phase === "released")).toBe(true);
  });

  it("save and load mid-search and mid-escort give the same battle", () => {
    for (const until of ["search", "escort"] as const) {
      const b = battle("de", 2);
      const st = b.sim.state;
      b.run(1200, () => until === "search" ? [...st.action.values()].some((a) => a.kind === "searchPrisoner") : [...st.soldier.values()].some((s) => s.guard?.phase === "escort" && (b.sim.state.mover.get(0)?.waypoints.length ?? 0) >= 0));
      b.run(3);
      const saved = JSON.parse(JSON.stringify(saveSim(b.sim))) as SerializedState;
      const again = loadSim(b.input, saved);
      for (let t = 0; t < 90 * 60; t++) { step(b.sim); step(again); }
      expect(hashState(again.state)).toBe(hashState(b.sim.state));
    }
  });

  it("without prisoners data nothing changes: a prisoner stays where he is taken", () => {
    const b = prisonersBattle(data, "de", TPL["de"]!, 1);
    const { prisoners: _p, ...rest } = b.input.catalog;
    void _p;
    const sim = createSim({ ...b.input, catalog: { ...rest } });
    for (let t = 0; t < 120 * 60; t++) step(sim);
    expect([...sim.state.rear.values()].some((p) => p.kind === "prisoners")).toBe(false);
    expect([...sim.state.soldier.values()].some((s) => s.guard !== undefined || s.captive?.unit !== undefined)).toBe(false);
  });
});
