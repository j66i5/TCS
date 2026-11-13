/**
 * M7.2: the platoon battle with vehicles (opt-in until M7.4a, owner Q26): crews and carriage from the templates
 * (Q1, Q2), the attacker mounted at its edge, the defender's vehicles behind its main objective; and the AI
 * commander riding in, getting out on arrival or at once when a hull is hit, getting back in on withdrawal (Q24).
 */
import { describe, expect, it } from "vitest";
import { buildScenario, lastDeadGround, withoutVehicles, buildForceWithVehicles, type ScenarioDef } from "@tcs/scenario";
import { commanderController } from "@tcs/ai";
import {
  createSim, hashState, hypot2, isAble, step, submitOrder, type BattleInput, type Controller, type EntityId, type Sim, type SimEvent,
} from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData();
const def = (seed: number, over: Partial<ScenarioDef> = {}): ScenarioDef => ({ kind: "platoon-attack", seed, mapKind: "village", factions: ["de", "ru"], attacker: "blue", vehicles: true, ...over });

function play(input: BattleInput, seconds: number, each?: (sim: Sim, ev: SimEvent[], ctrls: Controller[]) => boolean | void, setup?: (ctrls: Controller[]) => void): { sim: Sim; events: SimEvent[]; orders: { tick: number; kind: string; target: EntityId }[] } {
  const sim = createSim(input);
  const ctrls = [commanderController("blue", input), commanderController("red", input)];
  setup?.(ctrls);
  const events: SimEvent[] = [], orders: { tick: number; kind: string; target: EntityId }[] = [];
  for (let i = 0; i < seconds * 60; i++) {
    for (const c of ctrls) for (const o of c.think(sim.state, sim.state.tick)) { orders.push({ tick: o.tick, kind: o.kind, target: o.target }); submitOrder(sim, o); }
    const ev = step(sim);
    events.push(...ev);
    if (each?.(sim, ev, ctrls) === true) break;
  }
  return { sim, events, orders };
}

describe("platoons with vehicles (M7.2)", () => {
  it("owner 2026-11-13: the attacker starts in dead ground, out of the defenders' sight, at least 600 m from the objectives; off: the old line at its edge", () => {
    for (const [mapKind, attacker] of [["farmland", "red"], ["village", "blue"]] as const) {
      for (const seed of [1, 2, 12]) {
        const input = buildScenario(data, def(seed, { attacker, mapKind }));
        const dg = lastDeadGround!;
        const atk = input.forces.find((f) => f.side === attacker)!, dfn = input.forces.find((f) => f.side !== attacker)!;
        expect(dg.observers).toBe((dfn.vehiclePlacements?.length ?? 0) + 4);
        expect(dg.seen.length).toBe(atk.vehiclePlacements!.length);
        expect(dg.seen.every((n) => n === 0), `${mapKind} seed ${seed}: ${JSON.stringify(dg)}`).toBe(true);
        for (const p of atk.vehiclePlacements!) for (const o of input.rules.objectives) expect(hypot2(p.x - o.x, p.y - o.y)).toBeGreaterThan(590);
        // Deterministic: the same definition, the same starts.
        expect(buildScenario(data, def(seed, { attacker, mapKind })).forces.find((f) => f.side === attacker)!.vehiclePlacements).toEqual(atk.vehiclePlacements);
        const old = buildScenario(data, def(seed, { attacker, mapKind, deadGroundStart: false })).forces.find((f) => f.side === attacker)!;
        for (const p of old.vehiclePlacements!) expect(Math.abs(p.x - (attacker === "blue" ? 0.08 : 0.92) * input.map.widthM)).toBeLessThan(20);
      }
    }
  });

  it("templates: four Pumas (the fourth carries the platoon leader and radio operator, Q1); three BMP-2s with the commander in the back of the first (Q2)", () => {
    const de = buildForceWithVehicles(data, { faction: "de", template: "pzgren-zug", seed: 3, keyPrefix: "b" });
    expect(de.vehicles.map((v) => v.type)).toEqual(["de-puma", "de-puma", "de-puma", "de-puma"]);
    const deCrews = de.unit.subunits.filter((u) => u.vehicleId !== undefined);
    expect(deCrews.map((c) => c.callsign)).toEqual(["Puma 1", "Puma 2", "Puma 3", "Puma 4"]);
    const deSquads = de.unit.subunits.filter((u) => u.vehicleId === undefined);
    expect(deSquads.map((s) => s.carrierId)).toEqual(deCrews.slice(0, 3).map((c) => c.vehicleId));
    expect(de.unit.carrierId).toBe(deCrews[3]!.vehicleId);
    const ru = buildForceWithVehicles(data, { faction: "ru", template: "motor-rifle-platoon", seed: 3, keyPrefix: "r" });
    const ruCrews = ru.unit.subunits.filter((u) => u.vehicleId !== undefined);
    expect(ruCrews).toHaveLength(3);
    for (const c of ruCrews) expect(c.members).toHaveLength(3);
    expect(ru.unit.carrierId).toBe(ruCrews[0]!.vehicleId);
    // Without vehicles the platoon is exactly the infantry platoon of before (crews come after the squads).
    const inf = withoutVehicles(de.unit);
    expect(inf.subunits).toHaveLength(3);
    expect(JSON.stringify(inf)).not.toContain("carrierId");
  });

  it("off by default: the same battle as before, on foot, with no vehicles", () => {
    const off = buildScenario(data, def(2, { vehicles: undefined }));
    for (const f of off.forces) { expect(f.vehicles).toBeUndefined(); for (const u of f.units) expect(u.subunits).toHaveLength(3); }
  });

  it("the attacker starts aboard at its edge; the Russian platoon commander sits in the back of the first BMP-2; the defender's vehicles stand behind its objective, crews only", () => {
    for (const attacker of ["blue", "red"] as const) {
      const input = buildScenario(data, def(3, { attacker, mapKind: "farmland" }));
      const sim = createSim(input);
      const s = sim.state;
      const obj = input.rules.objectives[0]!;
      const atkSide = attacker, dfnSide = attacker === "blue" ? "red" : "blue";
      // Attackers: every man aboard, every vehicle on its own side (in dead ground, owner 2026-11-13: the next test).
      const atkMen = [...s.identity.entries()].filter(([, i]) => i.side === atkSide);
      // mounted: ok the test checks that every man is aboard
      for (const [id] of atkMen) expect(s.soldier.req(id).mount, `man ${id}`).toBeDefined();
      for (const [vid, v] of s.vehicle.entries()) {
        const t = s.transform.req(vid);
        if (v.side === atkSide) expect(atkSide === "blue" ? t.x < 0.4 * input.map.widthM : t.x > 0.6 * input.map.widthM).toBe(true);
        else {
          // Behind the main objective (away from the attack), crew only.
          const d = hypot2(t.x - obj.x, t.y - obj.y);
          expect(d).toBeGreaterThan(30);
          expect(d).toBeLessThan(220);
          const def2 = input.catalog.vehicles[v.def]!;
          v.seats.forEach((o, i) => { if (def2.seats[i]!.station === "passenger") expect(o).toBeNull(); else expect(o).not.toBeNull(); });
        }
      }
      // The Russian platoon commander (the platoon's own man) rides in the back of the first BMP-2 (Q2).
      const ruTop = [...s.unit.entries()].find(([, u]) => u.side === (attacker === "red" ? "red" : "red") && u.parent === null)!;
      const cmd = ruTop[1].members[0]!;
      const firstBmp = s.unit.req(ruTop[1].children.find((c) => s.unit.req(c).vehicle !== undefined)!).vehicle!;
      if (attacker === "red") {
        const m = s.soldier.req(cmd).mount!;
        expect(m.vehicle).toBe(firstBmp);
        expect(input.catalog.vehicles[s.vehicle.req(firstBmp).def]!.seats[m.seat]!.station).toBe("passenger");
      } else expect(s.soldier.req(cmd).mount).toBeUndefined(); // defending: on foot in his position
      // Defenders on foot are on foot.
      for (const [id, i] of s.identity.entries()) if (i.side === dfnSide && s.unit.req(i.unit).vehicle === undefined) expect(s.soldier.req(id).mount).toBeUndefined();
      expect(hashState(createSim(buildScenario(data, def(3, { attacker, mapKind: "farmland" }))).state)).toBe(hashState(s));
    }
  });

  it("the AI rides in and gets out short of the objective, out of reach of its own doctrine distance", () => {
    for (const [attacker, kind] of [["blue", "village"], ["red", "farmland"]] as const) {
      const input = buildScenario(data, def(1, { attacker, mapKind: kind }));
      const D = input.catalog.factions[attacker === "blue" ? "de" : "ru"]!.dismountM!;
      const { sim, events } = play(input, 180);
      const outs = events.filter((e): e is Extract<SimEvent, { kind: "unit.dismounted" }> => e.kind === "unit.dismounted");
      expect(outs.length, `${attacker}`).toBeGreaterThanOrEqual(6);
      for (const e of outs) {
        // (Where the hull is now: it held while they got out.)
        const t = sim.state.transform.req(e.vehicle);
        for (const o of input.rules.objectives) expect(hypot2(t.x - o.x, t.y - o.y)).toBeGreaterThan(D - 40);
      }
      // Nobody of the attacker is aboard any more, apart from the crews (and wounded who cannot walk, left in a struck hull: the
      // defender's BMP-2s have missiles since 2026-11-13).
      for (const [id, i] of sim.state.identity.entries()) if (i.side === attacker && sim.state.unit.req(i.unit).vehicle === undefined && isAble(sim.state.soldier.req(id)) && sim.state.soldier.req(id).impair.canWalk) expect(sim.state.soldier.req(id).mount).toBeUndefined();
    }
  });

  it("a hit on a hull gets its men out at once (polled lastHitTick), before the vehicles arrive", () => {
    const input = buildScenario(data, def(1));
    let hitTick = -1;
    const { events } = play(input, 40, (sim) => {
      if (hitTick < 0 && sim.state.tick === 10 * 60) {
        // A round struck the first Puma (as the projectile system records it).
        const v = [...sim.state.vehicle.values()].find((x) => x.side === "blue")!;
        v.lastHitTick = sim.state.tick; hitTick = sim.state.tick;
      }
    });
    const out = events.find((e) => e.kind === "unit.dismounted");
    expect(out).toBeDefined();
    expect(out!.tick - hitTick).toBeLessThan(25 * 60);
    expect(events.some((e) => e.kind === "unit.arrived" && e.tick < out!.tick)).toBe(false);
  });

  it("losses force a withdrawal: squads within 100 m of their vehicle get back in, and the vehicles drive back (Q24)", () => {
    const input = buildScenario(data, def(1));
    let hurt = false;
    const { events, sim } = play(input, 200, (s) => {
      // Once everyone is out, half the attacking platoon's men fall (beyond the doctrine's tolerance).
      if (!hurt && s.state.tick > 90 * 60 && [...s.state.unit.values()].every((u) => u.boarding === undefined)) {
        hurt = true;
        const men = [...s.state.identity.entries()].filter(([id, i]) => i.side === "blue" && s.state.unit.req(i.unit).vehicle === undefined && s.state.soldier.req(id).mount === undefined);
        men.filter((_, k) => k % 2 === 0).forEach(([id]) => { const ss = s.state.soldier.req(id); ss.physiology.alive = false; ss.physiology.consciousness = 0; ss.casualty = "killed"; });
      }
    });
    expect(hurt).toBe(true);
    const mounted = events.filter((e) => e.kind === "unit.mounted");
    expect(mounted.length).toBeGreaterThan(0);
    // Their vehicles were sent back toward the start after they got in.
    for (const e of mounted) {
      const v = sim.state.vehicle.req((e as Extract<SimEvent, { kind: "unit.mounted" }>).vehicle);
      expect(v.drive.route.length > 0 || v.drive.arrived).toBe(true);
    }
  });

  it("a squad still aboard near an objective it is to hold gets out [C29]", () => {
    const input = buildScenario(data, def(1));
    const obj = input.rules.objectives[0]!;
    // Every vehicle of the attacker starts 60 m from the main objective, its men aboard.
    for (const p of input.forces[0]!.vehiclePlacements!) { p.x = obj.x - 60; p.y = obj.y + (input.forces[0]!.vehiclePlacements!.indexOf(p) - 3) * 14; }
    for (const p of input.forces[0]!.placements) { const vp = input.forces[0]!.vehiclePlacements!.find((q) => q.vehicleId === p.mountedIn); if (vp) { p.x = vp.x; p.y = vp.y; } }
    // The commander past its ride (as if loaded from a save in its advance phase): only the hold rule acts.
    const { events } = play(input, 30, undefined, (ctrls) => ctrls[0]!.loadState!({ phase: "advance", phaseTick: 0, target: 0, lastFire: -1e9, lastAssault: {}, pulledBack: [], counterTick: -1e9, out: [] }));
    expect(events.filter((e) => e.kind === "unit.dismounted").length).toBeGreaterThanOrEqual(3);
  });

  it("M7.4b anti-tank tasks: a man with a Panzerfaust is ordered to fire at an enemy vehicle his side knows within its range", () => {
    // Russia attacks; the German defenders are told of a BMP-2 250 m from one of their Panzerfaust gunners.
    // (The old start at the edge, as when the test was written: the told-of BMP-2 is where the contact says.)
    const input = buildScenario(data, def(1, { attacker: "red", mapKind: "farmland", deadGroundStart: false }));
    let gunner = -1;
    const { orders } = play(input, 60, (sim) => {
      if (sim.state.tick !== 20 * 60) return;
      const red = [...sim.state.vehicle.entries()].find(([, v]) => v.side === "red")![0];
      for (const [id, i] of sim.state.identity.entries()) {
        if (i.side !== "blue" || sim.state.soldier.req(id).mount !== undefined) continue;
        const c = sim.state.container.req(id);
        if (!c.stacks.some((x) => x.type === "de-pzf3-firing-unit")) continue;
        gunner = id;
        const t = sim.state.transform.req(id);
        sim.state.soldier.req(id).contacts.push({ target: red, x: Math.min(t.x + 250, input.map.widthM - 5), y: t.y, errM: 5, kind: "seen", tick: sim.state.tick, reportedTick: sim.state.tick, cls: "vehicle" });
        break;
      }
    });
    expect(gunner).toBeGreaterThan(0);
    // Either the shot, or first a step aside out of a comrade's danger zone (Q20), then the shot.
    expect(orders.some((o) => o.target === gunner && o.tick >= 20 * 60 && (o.kind === "fire" || o.kind === "move"))).toBe(true);
  });

  it("M7.4b: enemy men known close to a carrier get its squad out at once, before the vehicles arrive", () => {
    const input = buildScenario(data, def(1));
    let at = -1;
    const { events } = play(input, 40, (sim) => {
      if (at >= 0 || sim.state.tick !== 8 * 60) return;
      const [vid, v] = [...sim.state.vehicle.entries()].find(([, x]) => x.side === "blue" && x.seats.some((m, k) => m !== null && sim.ctx.catalog.vehicles[x.def]!.seats[k]!.station === "passenger"))!;
      const crewman = v.seats.find((m, k) => m !== null && sim.ctx.catalog.vehicles[v.def]!.seats[k]!.station === "commander")!;
      const enemy = [...sim.state.identity.entries()].find(([, i]) => i.side === "red")![0];
      const t = sim.state.transform.req(vid);
      sim.state.soldier.req(crewman!).contacts.push({ target: enemy, x: t.x + 300, y: t.y, errM: 10, kind: "seen", tick: sim.state.tick, reportedTick: sim.state.tick });
      at = sim.state.tick;
    });
    const out = events.find((e) => e.kind === "unit.dismounted");
    expect(out).toBeDefined();
    expect(out!.tick - at).toBeLessThan(25 * 60);
  });
});
