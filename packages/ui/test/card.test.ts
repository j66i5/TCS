/** The "bar-card" step (owner choices S3, S4, S6): the unit card's snapshots, the fire row, the pace row, icons. */
import { describe, expect, it } from "vitest";
import { createSim, simHash, type Order } from "@tcs/sim";
import { getScenario, loadData } from "../../tools/src/scenarios";
import { AMBUSH_M, activityOf, ammoCells, fireChoice, fireChoiceRules, gunText, manDetail, manState, mentalStatus, moraleReasons, repaceMove, unitMenRows, vehicleGuns } from "../src/card";
import { MORALE_SOURCES } from "@tcs/sim";
import { Strings } from "@tcs/data";
import { shownCallsigns } from "@tcs/render";
import { ICON_NAMES, icon, paceIcon } from "../src/icons";
import { GROUP_OF } from "../src/hud";
import { unitTiles } from "../src/sidebar";

describe("unit card snapshots (S6)", () => {
  const sim = createSim(getScenario("platoon-vehicles").build(loadData(), 1, 600));
  const cat = sim.ctx.catalog;
  const tiles = unitTiles(sim.state, "blue", cat);
  const squad = tiles.find((t) => t.kind === "infantry")!;
  const veh = tiles.find((t) => t.kind === "vehicle")!;
  it("one row per man of a squad, with role, weapon, ammunition and state; read only", () => {
    const h = simHash(sim);
    const rows = unitMenRows(sim.state, cat, squad.unit);
    expect(simHash(sim)).toBe(h);
    expect(rows.length).toBe(squad.total);
    expect(rows.every((r) => r.state === "steady")).toBe(true);
    const armed = rows.filter((r) => r.weapon !== null);
    expect(armed.length).toBeGreaterThan(0);
    for (const r of armed) {
      expect(r.ammo).not.toBeNull();
      expect(r.ammo!.loaded).toBeGreaterThan(0);
      expect(r.ammo!.capacity).toBeGreaterThanOrEqual(r.ammo!.loaded);
      expect(r.ammo!.spareMags).toBeGreaterThan(0);
    }
    expect(rows.filter((r) => r.leader).length).toBe(1);
  });
  it("a vehicle's card lists its crew, not its passengers", () => {
    const rows = unitMenRows(sim.state, cat, veh.unit);
    expect(rows.length).toBe(veh.total);
  });
  it("the man's box: name, rank, weapon, rounds, condition and what he is doing", () => {
    const id = unitMenRows(sim.state, cat, squad.unit)[0]!.id;
    const h = simHash(sim);
    const d = manDetail(sim.state, cat, id)!;
    expect(simHash(sim)).toBe(h);
    const i = sim.state.identity.req(id);
    expect(d.family).toBe(i.family);
    expect(d.rank).toBe(i.rank);
    // (Review fix: the shown callsign, "1/Trupp 1" where two platoons have a Trupp 1.)
    expect(d.callsign).toBe(shownCallsigns(sim.state.unit.entries()).get(i.unit));
    expect(d.wounds).toEqual([]);
    expect(d.activity.key).toBe("aboard"); // the platoon starts mounted
    expect(d.morale).toBe(1);
  });
  it("states and activities follow the soldier: pinned, wounded, down, prisoner", () => {
    const id = unitMenRows(sim.state, cat, squad.unit)[1]!.id;
    const s = sim.state.soldier.req(id);
    const keep = structuredClone(s);
    delete s.mount;
    expect(activityOf(sim.state, id).key).toBe("holding");
    s.mental.behaviour = "pinned";
    expect(manState(s)).toBe("pinned");
    expect(activityOf(sim.state, id).key).toBe("pinned");
    s.wounds.push({ id: 1, zone: "legL", mechanism: "penetrating", severity: 0.4, bleedingLps: 0, compressible: true, airway: false, breathing: false, consciousness: false, tickInflicted: 0, treatments: [] } as never);
    expect(manState(s)).toBe("wounded");
    expect(manDetail(sim.state, cat, id)!.wounds).toEqual([{ zone: "legL", severity: 0.4 }]);
    s.casualty = "incapacitated";
    expect(manState(s)).toBe("down");
    expect(activityOf(sim.state, id).key).toBe("incapacitated");
    s.captive = { state: "surrendered", tick: 0 };
    expect(manState(s)).toBe("captive");
    Object.assign(s, keep);
  });
  it("triage (M10.3b): the tag on his row and in his box, by whom; care activities; not for the dead or prisoners", () => {
    const rows0 = unitMenRows(sim.state, cat, squad.unit);
    const id = rows0[2]!.id, by = rows0[3]!.id;
    const s = sim.state.soldier.req(id);
    const keep = structuredClone(s), keepBy = structuredClone(sim.state.soldier.req(by));
    expect(rows0[2]!.triage).toBeUndefined();
    s.triage = { cat: 1, by, tick: 0, skill: "buddy" };
    const h = simHash(sim);
    expect(unitMenRows(sim.state, cat, squad.unit)[2]!.triage).toBe(1);
    expect(manDetail(sim.state, cat, id)!.triage).toEqual({ cat: 1, byRole: sim.state.identity.req(by).role, byFaction: sim.state.identity.req(by).faction });
    expect(simHash(sim)).toBe(h);
    // What a helper is doing: treating, dragging, on his way.
    delete sim.state.soldier.req(by).mount;
    sim.state.action.set(by, { kind: "treat", startTick: 0, durationTicks: 60, params: { casualty: id } });
    expect(activityOf(sim.state, by).key).toBe("treating");
    sim.state.action.delete(by);
    const party = { method: "drag", carriers: [by], phase: "move" as const, phaseTick: 0, startTick: 0, dest: { x: 0, y: 0, z: 0 }, purpose: "cover" as const, massKg: 100, speedMps: 0.7, trail: [], sinceRestM: 0, totalM: 0 };
    sim.state.carry.set(id, party);
    sim.state.soldier.req(by).carrying = id;
    expect(activityOf(sim.state, by).key).toBe("dragging");
    sim.state.carry.set(id, { ...party, method: "fireman", purpose: "move" });
    expect(activityOf(sim.state, by).key).toBe("carrying");
    sim.state.carry.delete(id);
    delete sim.state.soldier.req(by).carrying;
    sim.state.soldier.req(by).intent = { kind: "care", tick: 0, target: id };
    expect(activityOf(sim.state, by).key).toBe("care");
    // No tag shown for a prisoner or a dead man.
    s.captive = { state: "surrendered", tick: 0 };
    expect(unitMenRows(sim.state, cat, squad.unit)[2]!.triage).toBeUndefined();
    s.captive = null; s.physiology.alive = false;
    expect(manDetail(sim.state, cat, id)!.triage).toBeUndefined();
    delete s.triage;
    Object.assign(s, keep);
    Object.assign(sim.state.soldier.req(by), keepBy);
  });
  it("morale (rework 2026-11-15): the box shows mental.morale, its reasons and what helps; a wounded panicked man shows both badges", () => {
    const rows0 = unitMenRows(sim.state, cat, squad.unit);
    const id = rows0[4]!.id;
    const s = sim.state.soldier.req(id);
    const keep = structuredClone(s);
    delete s.mount;
    s.mental.morale = 0.37; s.mental.behaviour = "panicked"; s.mental.flee = { x: 0, y: 0, untilTick: 999 };
    s.mental.why = s.mental.why.map(() => 0);
    s.mental.why[6] = 0.3; s.mental.why[7] = 0.2; s.mental.why[0] = 0.01; // comrades hit, leader lost; under fire too small
    s.wounds.push({ id: 1, zone: "legL", mechanism: "penetrating", severity: 0.3, bleedingLps: 0, compressible: true, airway: false, breathing: false, consciousness: false, tickInflicted: 0, treatments: [] } as never);
    const h = simHash(sim);
    const d = manDetail(sim.state, cat, id)!;
    expect(simHash(sim)).toBe(h);
    expect(d.morale).toBe(0.37);
    expect(d.behaviour).toBe("fleeing");
    expect(d.reasons).toEqual(["comradeHit", "leaderLost"]);
    expect(mentalStatus(s)).toBe("fleeing");
    const row = unitMenRows(sim.state, cat, squad.unit)[4]!;
    expect(row.status).toBe("serious");
    expect(row.mental).toBe("fleeing");
    expect(moraleReasons(s, 0.04)).toEqual(["comradeHit", "leaderLost"]);
    // Every key the box and the sidebar build is in the string table.
    const t = new Strings(loadData(), "en");
    const keys = [...MORALE_SOURCES.map((k) => `morale.reason.${k}`), "morale.relief.leaderNear", "morale.relief.rallied", "card.moraleWhy", "card.moraleHelp", "behaviour.fleeing",
      "man.activity.fleeing", "side.morale", "unitMorale.steady", "unitMorale.shaken", "unitMorale.pinned", "unitMorale.broken", "radio.squadShaken", "radio.rallying"];
    for (const k of keys) expect(t.has(k), k).toBe(true);
    Object.assign(s, keep);
  });
  it("the sidebar shows each squad's morale", () => {
    const t = unitTiles(sim.state, "blue", cat).find((x) => x.kind === "infantry")!;
    expect(t.morale).toBe(100);
    expect(t.moraleState).toBe("steady");
  });
  it("the ammunition bar: one cell per magazine, the loaded one first", () => {
    expect(ammoCells({ loaded: 15, capacity: 30, spareMags: 3, spareRounds: 90 })).toEqual({ fill: [0.5, 1, 1, 1], more: 0 });
    expect(ammoCells({ loaded: 0, capacity: 30, spareMags: 0, spareRounds: 0 })).toEqual({ fill: [0], more: 0 });
    expect(ammoCells({ loaded: 30, capacity: 30, spareMags: 10, spareRounds: 300 }).more).toBe(3);
  });
});

describe("the fire row (S3)", () => {
  it("Ambush is fire at will held to the ambush range; the other chips are the fire rule", () => {
    expect(fireChoice({ fire: "free", maxEngageM: 0 })).toBe("free");
    expect(fireChoice({ fire: "free", maxEngageM: 400 })).toBe("free");
    expect(fireChoice({ fire: "free", maxEngageM: AMBUSH_M })).toBe("ambush");
    expect(fireChoice({ fire: "return", maxEngageM: AMBUSH_M })).toBe("return");
    expect(fireChoice({ fire: "hold", maxEngageM: 0 })).toBe("hold");
    expect(fireChoiceRules("ambush", { fire: "hold", maxEngageM: 0 })).toEqual({ fire: "free", maxEngageM: AMBUSH_M });
    // Leaving an ambush lifts its range; a range from the Rules panel stays otherwise.
    expect(fireChoiceRules("free", { fire: "free", maxEngageM: AMBUSH_M })).toEqual({ fire: "free", maxEngageM: 0 });
    expect(fireChoiceRules("hold", { fire: "free", maxEngageM: 400 })).toEqual({ fire: "hold" });
  });
});

describe("the pace row (S3): a move under way sent again at another pace", () => {
  const prev: Extract<Order, { kind: "move" }> = { tick: 1, issuer: "blue", target: 5, kind: "move", formation: "line", facing: 1, waypoints: [{ x: 100, y: 0, mode: "walk" }, { x: 100, y: 100, mode: "run" }, { x: 0, y: 100, mode: "walk" }] };
  it("keeps the rest of the route from where the unit is, at the new pace", () => {
    const o = repaceMove(prev, { x: 50, y: 0 }, "sneak", 9);
    expect(o.waypoints).toEqual([{ x: 100, y: 0, mode: "sneak" }, { x: 100, y: 100, mode: "sneak" }, { x: 0, y: 100, mode: "sneak" }]);
    expect(o.tick).toBe(9);
    expect(o.formation).toBe("line");
    expect(o.facing).toBe(1);
    expect(repaceMove(prev, { x: 100, y: 60 }, "run", 9).waypoints.map((w) => [w.x, w.y])).toEqual([[100, 100], [0, 100]]);
    expect(repaceMove(prev, { x: 40, y: 100 }, "crawl", 9).waypoints).toEqual([{ x: 0, y: 100, mode: "crawl" }]);
  });
});

describe("icons (S4)", () => {
  it("every order mode belongs to a group and has a drawing; paces map to drawings", () => {
    for (const m of Object.keys(GROUP_OF)) expect(icon(m)).toContain("<svg");
    for (const n of ICON_NAMES) expect(icon(n)).toMatch(/^<svg[^>]*>.*<\/svg>$/s);
    expect(icon("nope")).toBe("");
    expect(paceIcon("drive-fast")).toBe("run");
    expect(paceIcon("wdrive-slow")).toBe("sneak");
    expect(paceIcon("drive")).toBe("walk");
    expect(paceIcon("reverse")).toBe("reverse");
    expect(paceIcon("crawl")).toBe("crawl");
  });
});

describe("the vehicle's guns on the card (D3)", () => {
  const data = loadData();
  const strings = new Strings(data, "en");
  for (const name of ["platoon-vehicles", "platoon-ru-vehicles"]) {
    it(`${name}: every gun with ready and stowed rounds by nature; read only; none for a squad`, () => {
      const sim = createSim(getScenario(name).build(data, 1, 600));
      const cat = sim.ctx.catalog;
      const tiles = unitTiles(sim.state, "blue", cat);
      const veh = tiles.find((t) => t.kind === "vehicle")!;
      const squad = tiles.find((t) => t.kind === "infantry")!;
      const h = simHash(sim);
      const guns = vehicleGuns(sim.state, cat, veh.unit);
      expect(simHash(sim)).toBe(h);
      expect(vehicleGuns(sim.state, cat, squad.unit)).toEqual([]);
      const def = cat.vehicles[sim.state.vehicle.req(sim.state.unit.req(veh.unit).vehicle!).def]!;
      expect(guns.length).toBe(def.stations.reduce((n, s) => n + s.weapons.length, 0));
      const kinds = new Set(guns.flatMap((g) => g.feeds.map((f) => f.kind)));
      expect(kinds.has("mg")).toBe(true);
      expect(kinds.has("he") || kinds.has("ap")).toBe(true);
      for (const g of guns) {
        const line = gunText(strings, g);
        expect(line).not.toContain("[[");
        expect(line.startsWith(strings.t(`weapon.${g.weapon}`, {}, g.faction))).toBe(true);
      }
      const cannon = guns.find((g) => g.feeds.some((f) => f.kind === "he" || f.kind === "ap"))!;
      expect(cannon.feeds.some((f) => f.ready > 0)).toBe(true);
      expect(gunText(strings, cannon)).toMatch(/(HE|AP) \d+/);
    });
  }
  it("the line: natures, a machine gun's belt by count, stowed rounds, jams and reloads", () => {
    expect(gunText(strings, { weapon: "de-mk30-2", faction: "de", jammed: false, reloading: false, feeds: [{ kind: "he", ready: 160, stowed: 0 }, { kind: "ap", ready: 80, stowed: 120 }] }))
      .toBe("MK30-2 · HE 160 | AP 80 (+120 stowed)");
    expect(gunText(strings, { weapon: "de-mg5-coax", faction: "de", jammed: true, reloading: false, feeds: [{ kind: "mg", ready: 500, stowed: 0 }] }))
      .toBe("MG5 (coaxial) · 500 · jammed");
    expect(gunText(strings, { weapon: "ru-9p135m", faction: "ru", jammed: false, reloading: true, feeds: [{ kind: "missile", ready: 0, stowed: 3 }] }))
      .toBe("9P135M launcher · Missiles 0 (+3 stowed) · reloading");
  });
  it("the BMP-2's launcher counts as missiles", () => {
    const sim = createSim(getScenario("platoon-ru-vehicles").build(data, 1, 600));
    const kinds = new Set<string>();
    for (const t of unitTiles(sim.state, "blue", sim.ctx.catalog)) {
      if (t.kind !== "vehicle") continue;
      for (const g of vehicleGuns(sim.state, sim.ctx.catalog, t.unit)) for (const f of g.feeds) kinds.add(f.kind);
    }
    expect(kinds.has("missile")).toBe(true);
  });
});
