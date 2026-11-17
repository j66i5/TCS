/**
 * M11.9c prisoners of war (plan docs/plans/m11-mp-pow.md slice 55): escapes (only unwatched, the rule toggle, the flag
 * kept for the grace time, free only beside a man of his own side, recapture, guards never firing at him, save/load
 * mid-escape), the collection point under fire (moved, not one the player placed), law.exposure (only past 60 s, not
 * when moved), the player rule "ask", the AI keeping its last guard, and the battle record's prisoners block.
 */
import { describe, expect, it } from "vitest";
import { commanderController } from "@tcs/ai";
import {
  createSim, detonate, EventSink, hashState, loadSim, newBattleRecord, prisonerPointOrder, recordEvents, saveSim, showsSurrender, step, submitOrder,
  type Contact, type EntityId, type SerializedState, type SimEvent, type SimState,
} from "@tcs/sim";
import { loadData } from "../src/scenarios";
import { escapeSetup, prisonersBattle } from "../src/labs/prisoners";

const data = loadData();
const of = <K extends SimEvent["kind"]>(ev: readonly SimEvent[], k: K) => ev.filter((e): e is Extract<SimEvent, { kind: K }> => e.kind === k);

/** Man `man` knows enemy `target` at (x, y) now (the contact list stays sorted by target). */
function see(st: SimState, man: EntityId, target: EntityId, x: number, y: number, flags: Partial<Contact> = {}): void {
  const s = st.soldier.req(man);
  const c: Contact = { target, x, y, errM: 2, kind: "seen", tick: st.tick, reportedTick: st.tick, ...flags };
  const i = s.contacts.findIndex((k) => k.target >= target);
  if (i >= 0 && s.contacts[i]!.target === target) s.contacts[i] = c; else if (i < 0) s.contacts.push(c); else s.contacts.splice(i, 0, c);
}

function runFor(sim: ReturnType<typeof createSim>, seconds: number, ev: SimEvent[], each?: (t: number) => boolean | void): void {
  for (let t = 0; t < seconds * 60; t++) { if (each?.(t) === true) return; ev.push(...step(sim)); }
}

/** Four unwatched prisoners who try every minute (perMinute 1). */
function sure(n = 4, minutes = 20) {
  const b = escapeSetup(data, 1, n, minutes);
  b.sim.ctx.catalog.prisoners!.escape!.perMinute = 1;
  return b;
}

describe("prisoners: escapes (M11.9c)", () => {
  it("an unwatched prisoner escapes within a minute; the enemy keeps seeing a man giving up only for the grace time; free only beside his own side", () => {
    const b = sure();
    const st = b.sim.state, E = b.catalog.prisoners!.escape!;
    const ev: SimEvent[] = [];
    runFor(b.sim, 61, ev);
    const started = of(ev, "pow.escape").filter((e) => e.phase === "started" && b.pris.includes(e.soldier));
    expect(started.map((e) => e.soldier).sort((x, y) => x - y)).toEqual([...b.pris].sort((x, y) => x - y));
    const m = started[0]!.soldier, s = st.soldier.req(m);
    expect(s.captive?.state).toBe("captured");
    expect(s.captive?.point).toBeUndefined();
    // The flag: shown until openTick, not after.
    expect(showsSurrender(s, started[0]!.tick + Math.round(E.graceSeconds * 60) - 1)).toBe(true);
    expect(showsSurrender(s, started[0]!.tick + Math.round(E.graceSeconds * 60))).toBe(false);
    // Running, never free while far from every fit man of his side; free beside one.
    const ownNear = () => {
      const t = st.transform.req(m);
      let best = Infinity;
      for (const [o, os] of st.soldier.entries()) if (o !== m && os.captive === null && os.casualty === "none" && os.physiology.alive && st.identity.req(o).side === "red") { const q = st.transform.req(o); best = Math.min(best, Math.hypot(q.x - t.x, q.y - t.y)); }
      return best;
    };
    let freedAt = -1;
    runFor(b.sim, 900, ev, () => {
      if (st.soldier.req(m).captive === null) { freedAt = st.tick; return true; }
      expect(ownNear()).toBeGreaterThan(E.freeM - 3);
      return false;
    });
    expect(freedAt).toBeGreaterThan(0);
    expect(ownNear()).toBeLessThanOrEqual(E.freeM + 1);
    expect(s.mental.behaviour).not.toBe("surrendered");
    expect(of(ev, "pow.escape").some((e) => e.soldier === m && e.phase === "free")).toBe(true);
  });

  it("no escapes while watched by a fit man of the holding side, nor with rules.prisonerEscapes false", () => {
    const b = sure(4, 5);
    const st = b.sim.state;
    const g = b.own.find((m) => !b.hq.includes(m))!;
    const ev: SimEvent[] = [];
    runFor(b.sim, 180, ev, () => { const tr = st.transform.req(g); tr.x = 603; tr.y = 273; const mv = st.mover.get(g); if (mv) mv.waypoints = []; });
    expect(of(ev, "pow.escape").filter((e) => b.pris.includes(e.soldier))).toHaveLength(0);
    const c = sure(4, 5);
    (c.sim.ctx.rules as { prisonerEscapes?: boolean }).prisonerEscapes = false;
    const ev2: SimEvent[] = [];
    runFor(c.sim, 180, ev2);
    expect(of(ev2, "pow.escape")).toHaveLength(0);
  });

  it("recaptured by a fit man of the holding side beside him: surrendered, then taken again", () => {
    const b = sure(1, 5);
    const st = b.sim.state;
    const ev: SimEvent[] = [];
    runFor(b.sim, 61, ev);
    const m = b.pris[0]!;
    expect(st.soldier.req(m).captive?.escape).toBeDefined();
    const g = b.own.find((x) => !b.hq.includes(x))!;
    runFor(b.sim, 30, ev, () => { const p = st.transform.req(m), tr = st.transform.req(g); tr.x = p.x + 2; tr.y = p.y; });
    expect(of(ev, "pow.escape").some((e) => e.soldier === m && e.phase === "recaptured")).toBe(true);
    expect(of(ev, "captured").some((e) => e.soldier === m)).toBe(true);
    expect(st.soldier.req(m).captive?.state).toBe("captured");
    expect(st.soldier.req(m).captive?.escape).toBeUndefined();
  });

  it("saved and loaded mid-escape, the battle goes on exactly the same", () => {
    const b = sure(2, 10);
    const ev: SimEvent[] = [];
    runFor(b.sim, 75, ev);
    expect(b.pris.some((m) => b.sim.state.soldier.req(m).captive?.escape !== undefined)).toBe(true);
    const saved = JSON.parse(JSON.stringify(saveSim(b.sim))) as SerializedState;
    const again = loadSim(b.input, saved);
    again.ctx.catalog.prisoners!.escape!.perMinute = 1;
    for (let t = 0; t < 120 * 60; t++) { step(b.sim); step(again); }
    expect(hashState(again.state)).toBe(hashState(b.sim.state));
  });
});

describe("prisoners: guards, fire, exposure, the player rule, the AI (M11.9c)", () => {
  /** The lab's platoon with its six walking prisoners held at the point (and a guard). */
  function heldBattle(faction: "de" | "ru" = "de") {
    const b = prisonersBattle(data, faction, faction === "de" ? "pzgren-zug" : "motor-rifle-platoon", 1, { limitS: 3600 });
    const sim = createSim(b.input);
    const st = sim.state;
    for (const [uid] of st.unit.entries()) st.unit.req(uid).fireRule = "hold";
    const red = [...st.identity.entries()].filter(([, i]) => i.side === "red").map(([id]) => id);
    const walkers = red.filter((m) => st.soldier.req(m).wounds.length === 0);
    const ev: SimEvent[] = [];
    runFor(sim, 1800, ev, (t) => t % 60 === 0 && t > 0 && walkers.every((m) => st.soldier.req(m).captive?.point !== undefined));
    const [pid, p] = [...st.rear.entries()].find(([, x]) => x.kind === "prisoners")!;
    const guard = [...st.soldier.entries()].find(([, s]) => s.guard?.phase === "guard")?.[0];
    return { ...b, sim, st, walkers, ev, pid, p, guard };
  }

  it("guards never fire at an escaping prisoner, even one they no longer know to be giving up", () => {
    const h = heldBattle();
    expect(h.guard).toBeDefined();
    const g = h.guard!, m = h.walkers[2]!;
    const s = h.st.soldier.req(m), gt = h.st.transform.req(g);
    // He has got away from the point (as if out of sight) and is running past the guard 30 m off.
    delete s.captive!.point;
    s.captive!.escape = { tick: h.st.tick, openTick: h.st.tick, open: true, routeTick: h.st.tick };
    const tr = h.st.transform.req(m); tr.x = gt.x + 30; tr.y = gt.y;
    h.st.unit.req(h.st.identity.req(g).unit).fireRule = "free";
    const ev: SimEvent[] = [];
    runFor(h.sim, 20, ev, () => { see(h.st, g, m, h.st.transform.req(m).x, h.st.transform.req(m).y); expect(h.st.fire.get(g)?.contact).not.toBe(m); });
    expect(of(ev, "shot.fired").filter((e) => e.shooter === g)).toHaveLength(0);
  });

  it("rounds landing 20 m from the point move it at once; one the player placed stays", () => {
    const h = heldBattle();
    const ammo = h.input.catalog.ammoIds.indexOf(h.input.catalog.factions["ru"]!.fireSupport!.heAmmo);
    const x0 = h.p.x, y0 = h.p.y;
    detonate(h.sim.ctx, h.st, new EventSink(), x0 + 20, y0, 0, ammo, h.walkers[0]!);
    const ev: SimEvent[] = [];
    runFor(h.sim, 2, ev);
    expect(of(ev, "pow.point").some((e) => e.reason === "underFire")).toBe(true);
    expect(Math.hypot(h.p.x - (x0 + 20), h.p.y - y0)).toBeGreaterThanOrEqual(h.input.catalog.prisoners!.pcp.fireClearM! - 1);
    // Placed by the player: it stays where it is.
    const k = heldBattle();
    const top = k.p.unit;
    expect(prisonerPointOrder(k.sim.ctx, k.st, new EventSink(), top, k.p.x, k.p.y)).toBe(true);
    detonate(k.sim.ctx, k.st, new EventSink(), k.p.x + 20, k.p.y, 0, ammo, k.walkers[0]!);
    const ev2: SimEvent[] = [];
    runFor(k.sim, 15, ev2);
    expect(of(ev2, "pow.point").filter((e) => e.reason === "underFire")).toHaveLength(0);
  });

  it("law.exposure: only past exposure.seconds with an enemy near and the point kept there, never when it is moved", () => {
    const sec = data.prisoners!.prisoners.exposure!.seconds;
    // Placed by the player (it stays): recorded once, after the time.
    const h = heldBattle();
    expect(prisonerPointOrder(h.sim.ctx, h.st, new EventSink(), h.p.unit, h.p.x, h.p.y)).toBe(true);
    const watcher = [...h.st.soldier.entries()].find(([id, s]) => s.guard === undefined && s.captive === null && h.st.identity.req(id).side === "blue" && s.casualty === "none")![0];
    const enemy = h.walkers[0]!;
    const ev: SimEvent[] = [];
    let t0 = -1;
    runFor(h.sim, sec + 10, ev, () => { if (t0 < 0) t0 = h.st.tick; see(h.st, watcher, 100000, h.p.x + 150, h.p.y); });
    void enemy;
    const ex = of(ev, "law.exposure");
    expect(ex).toHaveLength(1);
    expect(ex[0]!.cause).toBe("enemy");
    expect(ex[0]!.placed).toBe(true);
    expect((ex[0]!.tick - t0) / 60).toBeGreaterThan(sec);
    // Automatic: the point is moved away and nothing is recorded.
    const k = heldBattle();
    const w2 = [...k.st.soldier.entries()].find(([id, s]) => s.guard === undefined && s.captive === null && k.st.identity.req(id).side === "blue" && s.casualty === "none")![0];
    const ex0 = { x: k.p.x + 150, y: k.p.y };
    const ev2: SimEvent[] = [];
    runFor(k.sim, sec * 2, ev2, () => see(k.st, w2, 100000, ex0.x, ex0.y));
    expect(of(ev2, "pow.point").some((e) => e.reason === "threatened")).toBe(true);
    expect(of(ev2, "law.exposure")).toHaveLength(0);
  });

  it("rule 'ask': no escorts until the player orders them; the rules order sets it", () => {
    const b = prisonersBattle(data, "de", "pzgren-zug", 1, { limitS: 3600 });
    const sim = createSim(b.input);
    const st = sim.state;
    for (const [uid] of st.unit.entries()) st.unit.req(uid).fireRule = "hold";
    const top = [...st.unit.entries()].find(([, u]) => u.side === "blue" && u.parent === null)![0];
    submitOrder(sim, { tick: 0, issuer: "blue", target: top, kind: "rules", prisoners: "ask" });
    const ev: SimEvent[] = [];
    runFor(sim, 240, ev);
    expect(st.unit.req(top).prisonerRule).toBe("ask");
    expect(of(ev, "captured").length).toBeGreaterThan(0);
    expect(of(ev, "pow.escort")).toHaveLength(0);
    const squad = st.identity.req(of(ev, "captured")[0]!.by).unit;
    submitOrder(sim, { tick: st.tick, issuer: "blue", target: squad, kind: "escortPrisoners" });
    runFor(sim, 5, ev);
    expect(of(ev, "pow.escort").length).toBeGreaterThan(0);
    expect(of(ev, "pow.escort").every((e) => e.ordered === true)).toBe(true);
  });

  it("the AI never sends its last guard away with an enemy near the point", () => {
    const h = heldBattle();
    expect(h.guard).toBeDefined();
    const ctl = commanderController("blue", h.input);
    const watcher = [...h.st.soldier.entries()].find(([id, s]) => s.guard === undefined && s.captive === null && h.st.identity.req(id).side === "blue" && s.casualty === "none")![0];
    const orders: string[] = [];
    for (let t = 0; t < 180 * 60; t++) {
      if (t % 60 === 0) see(h.st, watcher, 100000, h.p.x + 200, h.p.y);
      for (const o of ctl.think(h.st, h.st.tick)) { orders.push(o.kind); if (o.target === h.guard) orders.push(`to-guard:${o.kind}`); submitOrder(h.sim, o); }
      step(h.sim);
    }
    expect(orders.filter((k) => k === "releaseGuard" || k.startsWith("to-guard:"))).toEqual([]);
    expect(h.st.soldier.req(h.guard!).guard?.phase).toBe("guard");
  });

  it("the battle record's prisoners block (version 12): taken by group, searched, escorts, duty, held at the end", () => {
    const b = prisonersBattle(data, "de", "pzgren-zug", 1, { limitS: 3600 });
    const sim = createSim(b.input);
    for (const [uid] of sim.state.unit.entries()) sim.state.unit.req(uid).fireRule = "hold";
    const rec = newBattleRecord(["blue", "red"]);
    expect(rec.v).toBe(12);
    for (let t = 0; t < 900 * 60; t++) { const out = step(sim); recordEvents(rec, out, sim.state, b.input.catalog); }
    recordEvents(rec, [{ kind: "battle.ended", tick: sim.state.tick, reason: "time-limit" }], sim.state, b.input.catalog);
    const p = rec.sides["blue"]!.pow;
    expect(p.taken.officer + p.taken.nco + p.taken.man).toBe(7);
    expect(p.taken.officer).toBe(1);
    expect(p.taken.nco).toBe(1);
    expect(p.searched).toBe(7);
    expect(p.weapons).toBeGreaterThanOrEqual(6);
    expect(p.documents).toBeGreaterThanOrEqual(1);
    expect(p.escorts).toBeGreaterThan(0);
    expect(p.walkS.length).toBe(6);
    expect(p.dutyS).toBeGreaterThan(0);
    expect(p.heldEnd).toBe(7);
    expect(rec.sides["red"]!.pow.taken.man).toBe(0);
    expect(Object.keys(rec.powDuty)).toHaveLength(0);
  });
});
