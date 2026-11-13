/** The "bar-card" step (owner choices S3, S4, S6): the unit card's snapshots, the fire row, the pace row, icons. */
import { describe, expect, it } from "vitest";
import { createSim, simHash, type Order } from "@tcs/sim";
import { getScenario, loadData } from "../../tools/src/scenarios";
import { AMBUSH_M, activityOf, ammoCells, fireChoice, fireChoiceRules, manDetail, manState, repaceMove, unitMenRows } from "../src/card";
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
    expect(d.callsign).toBe(sim.state.unit.get(i.unit)!.callsign);
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
