/** Leaving a house (M7.5e step "leave"): a trap, the enemy inside, cut off from behind; staying otherwise; saves. */
import { describe, expect, it } from "vitest";
import { createSim, deserializeState, detonate, hashState, indoorAt, serializeState, step, submitOrder, type BattleInput, type Building, type MapDef, type Sim, type SimEvent } from "../src/index";
import { EventSink } from "../src/events";
import { armedInput, team, testCatalog } from "./helpers";
import { houseThreat, leftLately } from "../src/systems/house";

/** The M7.5c/d test house (12 x 10 m, two storeys, a door west, windows upstairs east and north). */
function house(): Building {
  const fp = [100, 80, 112, 80, 112, 90, 100, 90];
  const west = [100, 80, 106, 80, 106, 90, 100, 90], east = [106, 80, 112, 80, 112, 90, 106, 90];
  return {
    id: 1, kind: "house", footprint: fp, storeys: 2, storeyHeightM: 2.8, wallMaterial: "brick", wallThicknessM: 0.3, roofColour: "#8c4a3b",
    openings: [
      { wall: 3, offsetM: 3, widthM: 1.0, kind: "door", sillM: 0, headM: 2.1 },
      { wall: 1, offsetM: 5, widthM: 1.2, kind: "window", sillM: 0.9, headM: 2.1, floor: 1 },
      { wall: 1, offsetM: 2, widthM: 1.2, kind: "window", sillM: 0.9, headM: 2.1, floor: 1 },
      { wall: 0, offsetM: 3, widthM: 1.2, kind: "window", sillM: 0.9, headM: 2.1, floor: 1 },
    ],
    interior: {
      rooms: [0, 1].flatMap((fl) => [{ id: fl * 2, floor: fl, poly: west, kind: "hall" as const }, { id: fl * 2 + 1, floor: fl, poly: east, kind: "room" as const }]),
      walls: [0, 1].map((fl) => ({ id: fl, floor: fl, ax: 106, ay: 80, bx: 106, by: 90, thicknessM: 0.12, material: "brick", doors: [{ offsetM: 5, widthM: 0.9, headM: 2 }] })),
      stairs: [{ id: 0, floor: 0, room: 0, x0: 101, y0: 81, x1: 104.5, y1: 81, widthM: 1 }],
    },
  };
}

type SoldierRules = typeof testCatalog.behaviour.soldier;
function input(rules: Partial<SoldierRules> = {}): BattleInput {
  const inp = armedInput(1, 900);
  const m: MapDef = { ...inp.map };
  m.buildings = [house()];
  inp.map = m;
  inp.catalog = { ...testCatalog, behaviour: { ...testCatalog.behaviour, soldier: { ...testCatalog.behaviour.soldier, ...rules } } };
  return inp;
}

function run(sim: Sim, ticks: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < ticks; i++) out.push(...step(sim));
  return out;
}

const unitOf = (sim: Sim, side: string) => [...sim.state.unit.entries()].find(([, u]) => u.side === side)![0];
const menOf = (sim: Sim, side: string) => [...sim.state.soldier.keys()].filter((id) => sim.state.identity.get(id)?.side === side);
const inside = (sim: Sim) => menOf(sim, "blue").filter((id) => { const t = sim.state.transform.req(id); return indoorAt(sim.ctx, t.x, t.y) === 0; });

/** Blue occupies the house facing east (red 50 m east, holding fire, seen); 90 s to get in. */
function occupied(rules: Partial<SoldierRules> = {}): Sim {
  const sim = createSim(input(rules));
  menOf(sim, "red").forEach((id, i) => { const t = sim.state.transform.req(id); t.x = 160; t.y = 82 + i * 4; });
  for (const side of ["blue", "red"] as const) submitOrder(sim, { tick: 0, issuer: side, target: unitOf(sim, side), kind: "rules", fire: "hold" });
  submitOrder(sim, { tick: 0, issuer: "blue", target: unitOf(sim, "blue"), kind: "occupy", building: 1, facing: 0 });
  run(sim, 60 * 90);
  expect(inside(sim).length).toBe(3);
  return sim;
}

/** Two small bursts by red just outside the west wall (the wall shields the men): a trap by count alone. */
function twoBursts(sim: Sim): void {
  const red = menOf(sim, "red")[0]!, bomb = testCatalog.ammoIds.indexOf("bomb");
  detonate(sim.ctx, sim.state, new EventSink(), 99.5, 82, 0.05, bomb, red);
  run(sim, 60 * 2);
  detonate(sim.ctx, sim.state, new EventSink(), 99.5, 88.5, 0.05, bomb, red);
}

function seen(sim: Sim, who: number, target: number, x: number, y: number, z = 0): void {
  const s = sim.state.soldier.req(who), tick = sim.state.tick;
  s.contacts = s.contacts.filter((c) => c.target !== target);
  s.contacts.push({ target, x, y, z, errM: 0, kind: "seen", tick, reportedTick: tick });
}

describe("house leave: a trap", () => {
  it("two enemy bursts on the house within 30 s: every man of the unit runs out to cover 20-55 m away, and says so", () => {
    const sim = occupied();
    twoBursts(sim);
    for (const id of menOf(sim, "blue")) expect(sim.state.soldier.req(id).houseDanger?.n).toBe(2);
    const ev = run(sim, 60 * 25);
    expect(inside(sim)).toEqual([]);
    const u = sim.state.unit.req(unitOf(sim, "blue"));
    expect(u.leftHouse).toMatchObject({ building: 1, reason: "trap" });
    expect(ev.some((e) => e.kind === "radio" && e.key === "radio.houseLeftTrap")).toBe(true);
    for (const id of menOf(sim, "blue")) {
      const t = sim.state.transform.req(id), d = Math.hypot(t.x - 106, t.y - 85);
      expect(d).toBeGreaterThan(18);
      expect(d).toBeLessThan(60);
      expect(t.x).toBeLessThan(106); // away from red (east)
      expect(t.z).toBe(0);
    }
  });

  it("one burst is not a trap; own bursts do not count; the rule switched off keeps them in", () => {
    const sim = occupied();
    const blue = menOf(sim, "blue")[0]!, red = menOf(sim, "red")[0]!, bomb = testCatalog.ammoIds.indexOf("bomb");
    detonate(sim.ctx, sim.state, new EventSink(), 99.5, 82, 0.05, bomb, red);
    detonate(sim.ctx, sim.state, new EventSink(), 99.5, 88.5, 0.05, bomb, blue);
    run(sim, 60 * 25);
    expect(inside(sim).length).toBe(3);
    // Bursts more than 30 s apart do not add up.
    run(sim, 60 * 10);
    detonate(sim.ctx, sim.state, new EventSink(), 99.5, 82, 0.05, bomb, red);
    run(sim, 60 * 35);
    detonate(sim.ctx, sim.state, new EventSink(), 99.5, 82, 0.05, bomb, red);
    run(sim, 60 * 10);
    expect(inside(sim).length).toBe(3);
    const off = occupied({ houseLeave: false });
    twoBursts(off);
    run(off, 60 * 25);
    expect(inside(off).length).toBe(3);
    expect(off.state.unit.req(unitOf(off, "blue")).leftHouse).toBeUndefined();
  });

  it("a heavy round on the house counts double", () => {
    const sim = occupied({ houseHeavyKg: 0.05 });
    const red = menOf(sim, "red")[0]!, bomb = testCatalog.ammoIds.indexOf("bomb"), shell = testCatalog.ammoIds.indexOf("shell");
    detonate(sim.ctx, sim.state, new EventSink(), 99.5, 88.5, 0.05, shell, red); // 0.032 kg: light
    expect(sim.state.soldier.req(menOf(sim, "blue")[0]!).houseDanger?.n).toBe(1);
    detonate(sim.ctx, sim.state, new EventSink(), 99.5, 82, 0.05, bomb, red); // 0.06 kg: heavy here
    expect(sim.state.soldier.req(menOf(sim, "blue")[0]!).houseDanger?.n).toBe(3);
  });

  it("no trigger: the men stay at their windows", () => {
    const sim = occupied();
    run(sim, 60 * 60);
    expect(inside(sim).length).toBe(3);
    expect(sim.state.unit.req(unitOf(sim, "blue")).leftHouse).toBeUndefined();
  });
});

describe("house leave: the enemy inside, outflanked", () => {
  it("an enemy seen inside: the men leave, but one in the enemy's own room within 4 m fights", () => {
    const sim = occupied();
    const red = menOf(sim, "red")[0]!, blue = menOf(sim, "blue");
    // A red man in the west room upstairs.
    const rt = sim.state.transform.req(red);
    rt.x = 103; rt.y = 87; rt.z = 2.8;
    const b0 = sim.state.transform.req(blue[0]!);
    for (const b of blue) seen(sim, b, red, 103, 87, 2.8);
    // Whoever is upstairs in the west room within 4 m of him stays.
    const fighter = blue.filter((b) => { const t = sim.state.transform.req(b); return t.z > 1 && t.x < 106 && Math.hypot(t.x - 103, t.y - 87) <= 4; });
    void b0;
    const ev = run(sim, 60 * 3);
    expect(ev.some((e) => e.kind === "radio" && e.key === "radio.houseLeftEnemy")).toBe(true);
    const u = sim.state.unit.req(unitOf(sim, "blue"));
    expect(u.leftHouse?.reason).toBe("enemy");
    for (const b of blue) {
      const w = sim.state.mover.req(b).waypoints;
      if (fighter.includes(b)) expect(w.some((p) => p.bolt)).toBe(false);
      else expect(w.length > 0 && w[w.length - 1]!.bolt === true).toBe(true);
    }
  });

  it("an enemy behind the house (west, its windows face east and north): the men leave, not toward him", () => {
    const sim = occupied();
    const reds = menOf(sim, "red"), blue = menOf(sim, "blue");
    const rt = sim.state.transform.req(reds[0]!);
    rt.x = 40; rt.y = 85;
    for (const b of blue) seen(sim, b, reds[0]!, 40, 85);
    const ev = run(sim, 60 * 25);
    expect(ev.some((e) => e.kind === "radio" && e.key === "radio.houseLeftFlank")).toBe(true);
    expect(inside(sim)).toEqual([]);
    for (const b of blue) expect(sim.state.transform.req(b).x).toBeGreaterThan(70);
  });

  it("the unit keeps out of the house for a while (its own rules); an order may send it back in", () => {
    const sim = occupied();
    twoBursts(sim);
    run(sim, 60 * 25);
    expect(inside(sim)).toEqual([]);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: unitOf(sim, "blue"), kind: "occupy", building: 1, facing: 0 });
    run(sim, 60 * 90);
    expect(inside(sim).length).toBe(3);
  });
});

describe("house leave: review fixes", () => {
  it("outflanked needs two enemies: one man known at an old place behind the house and now in front is not", () => {
    const sim = occupied();
    const reds = menOf(sim, "red"), blue = menOf(sim, "blue"), tick = sim.state.tick;
    for (const b of blue) sim.state.soldier.req(b).contacts = [];
    const put = (who: number, target: number, x: number, y: number, ago: number) => {
      const s = sim.state.soldier.req(who);
      s.contacts = [...s.contacts.filter((c) => c.target !== target), { target, x, y, z: 0, errM: 0, kind: "seen" as const, tick: tick - ago, reportedTick: tick - ago }].sort((p, q) => p.target - q.target);
    };
    put(blue[0]!, reds[0]!, 60, 85, 8 * 60); // seen west 8 s ago...
    put(blue[1]!, reds[0]!, 160, 85, 0); //     ...and east now
    const u = sim.state.unit.req(unitOf(sim, "blue")), men = inside(sim);
    expect(houseThreat(sim.ctx, sim.state, sim.state.soldier.req(blue[0]!), u, 0, men)).toBeNull();
    put(blue[0]!, reds[1]!, 60, 85, 8 * 60); // another man west: cut off
    expect(houseThreat(sim.ctx, sim.state, sim.state.soldier.req(blue[0]!), u, 0, men)?.reason).toBe("flank");
  });

  it("a burst on the house right after a load counts as before it (the lazily known interiors)", () => {
    const sim = occupied();
    const red = menOf(sim, "red")[0]!, bomb = testCatalog.ammoIds.indexOf("bomb"), b0 = menOf(sim, "blue")[0]!;
    detonate(sim.ctx, sim.state, new EventSink(), 99.5, 82, 0.05, bomb, red);
    const copy = createSim(input());
    copy.state = deserializeState(JSON.parse(JSON.stringify(serializeState(sim.state))));
    expect(copy.ctx.hasInteriors).toBeUndefined();
    detonate(sim.ctx, sim.state, new EventSink(), 99.5, 88.5, 0.05, bomb, red);
    detonate(copy.ctx, copy.state, new EventSink(), 99.5, 88.5, 0.05, bomb, red);
    expect(copy.state.soldier.req(b0).houseDanger?.n).toBe(2);
    expect(hashState(copy.state)).toBe(hashState(sim.state));
  });

  it("an order after leaving: the house is looked at afresh — back in, a new burst makes it a trap again", () => {
    const sim = occupied();
    twoBursts(sim);
    run(sim, 60 * 25);
    expect(inside(sim)).toEqual([]);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: unitOf(sim, "blue"), kind: "occupy", building: 1, facing: 0 });
    run(sim, 60 * 60);
    expect(inside(sim).length).toBe(3);
    const red = menOf(sim, "red")[0]!, bomb = testCatalog.ammoIds.indexOf("bomb");
    detonate(sim.ctx, sim.state, new EventSink(), 99.5, 82, 0.05, bomb, red);
    run(sim, 60 * 2);
    detonate(sim.ctx, sim.state, new EventSink(), 99.5, 88.5, 0.05, bomb, red);
    const ev = run(sim, 60 * 25);
    expect(ev.some((e) => e.kind === "radio" && e.key === "radio.houseLeftTrap")).toBe(true);
    expect(inside(sim)).toEqual([]);
  });
});

describe("house leave: who goes", () => {
  it("spreads to the men of his own unit in that house only; the other unit, not knowing, stays", () => {
    const inp = input();
    const c = team("c", 2);
    for (const m of c.members) m.weapon = "rifle";
    const blue = inp.forces.find((f) => f.side === "blue")!;
    blue.units.push(c);
    blue.placements.push(...c.members.map((m, i) => ({ personId: m.personId, x: 12, y: 40 + i * 5, heading: 0 })));
    const sim = createSim(inp);
    menOf(sim, "red").forEach((id, i) => { const t = sim.state.transform.req(id); t.x = 160; t.y = 82 + i * 4; });
    const units = [...sim.state.unit.entries()].filter(([, u]) => u.side === "blue").map(([id]) => id);
    expect(units.length).toBe(2);
    for (const u of [...units, unitOf(sim, "red")]) submitOrder(sim, { tick: 0, issuer: sim.state.unit.req(u).side, target: u, kind: "rules", fire: "hold" });
    for (const u of units) submitOrder(sim, { tick: 0, issuer: "blue", target: u, kind: "occupy", building: 1, facing: 0 });
    run(sim, 60 * 100);
    expect(inside(sim).length).toBe(5);
    // A red man in the house, seen by the first unit's men only.
    const red = menOf(sim, "red")[0]!, rt = sim.state.transform.req(red);
    rt.x = 101; rt.y = 84; rt.z = 0;
    const [ua, ub] = units.map((u) => sim.state.unit.req(u));
    for (const m of ua!.members) seen(sim, m, red, 101, 84, 0);
    // (The second unit must not learn of him: its men forget anything about red.)
    const forget = () => { for (const m of ub!.members) sim.state.soldier.req(m).contacts = []; };
    for (let k = 0; k < 60 * 3; k++) { forget(); step(sim); }
    expect(ua!.leftHouse?.reason).toBe("enemy");
    expect(ub!.leftHouse).toBeUndefined();
    for (const m of ub!.members) { const w = sim.state.mover.req(m).waypoints; expect(w.some((p) => p.bolt)).toBe(false); }
    for (const m of ua!.members) {
      const w = sim.state.mover.req(m).waypoints, t = sim.state.transform.req(m);
      const fights = Math.hypot(t.x - 101, t.y - 84) <= 4 && t.z === 0;
      if (!fights) expect(w.length > 0 && w[w.length - 1]!.bolt === true).toBe(true);
    }
  });

  it("its own rules keep the unit out of the house it left for houseReenterSeconds", () => {
    const sim = occupied();
    twoBursts(sim);
    run(sim, 60 * 3);
    const u = unitOf(sim, "blue");
    expect(leftLately(sim.ctx, sim.state, u, 0)).toBe(true);
    run(sim, 60 * 120);
    expect(leftLately(sim.ctx, sim.state, u, 0)).toBe(false);
  });
});

describe("house leave: saves", () => {
  it("houseDanger and leftHouse save and load mid-leave with the same hash and the same future", () => {
    const sim = occupied();
    twoBursts(sim);
    run(sim, 60 * 3);
    expect(sim.state.unit.req(unitOf(sim, "blue")).leftHouse).toBeDefined();
    const back = deserializeState(JSON.parse(JSON.stringify(serializeState(sim.state))));
    expect(hashState(back)).toBe(hashState(sim.state));
    expect(back.unit.req(unitOf(sim, "blue")).leftHouse).toBeDefined();
    expect(back.soldier.req(menOf(sim, "blue")[0]!).houseDanger).toBeDefined();
    const copy = createSim(input());
    copy.state = back;
    run(sim, 60 * 10); run(copy, 60 * 10);
    expect(hashState(copy.state)).toBe(hashState(sim.state));
  });
});
