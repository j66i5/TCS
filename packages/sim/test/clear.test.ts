/** Clearing a house (M7.5e step "clear"): room order, the stack, grenades room by room, entering, fails safe, saves. */
import { describe, expect, it } from "vitest";
import { createSim, deserializeState, hashState, indoorAt, throwArcExists, roomAt, roomOrder, serializeState, step, submitOrder, type BattleInput, type Building, type MapDef, type Sim, type SimEvent } from "../src/index";
import { armedInput, testCatalog } from "./helpers";

/**
 * A 12 x 10 m house of two storeys: a door west into the hall (room 0, with the stairs), two rooms east (1 north,
 * 2 south) through doorways in the hall's east wall, a window in room 1's north wall; upstairs a west room (3) and an
 * east room (4).
 */
function house(): Building {
  const fp = [100, 80, 112, 80, 112, 90, 100, 90];
  const west = [100, 80, 106, 80, 106, 90, 100, 90], ne = [106, 80, 112, 80, 112, 85, 106, 85], se = [106, 85, 112, 85, 112, 90, 106, 90], east = [106, 80, 112, 80, 112, 90, 106, 90];
  return {
    id: 7, kind: "house", footprint: fp, storeys: 2, storeyHeightM: 2.8, wallMaterial: "brick", wallThicknessM: 0.3, roofColour: "#8c4a3b",
    openings: [
      { wall: 3, offsetM: 3, widthM: 1.0, kind: "door", sillM: 0, headM: 2.1 },
      { wall: 0, offsetM: 9, widthM: 1.2, kind: "window", sillM: 0.9, headM: 2.1 },
      { wall: 1, offsetM: 5, widthM: 1.2, kind: "window", sillM: 0.9, headM: 2.1, floor: 1 },
    ],
    interior: {
      rooms: [
        { id: 0, floor: 0, poly: west, kind: "hall" }, { id: 1, floor: 0, poly: ne, kind: "room" }, { id: 2, floor: 0, poly: se, kind: "room" },
        { id: 3, floor: 1, poly: west, kind: "hall" }, { id: 4, floor: 1, poly: east, kind: "room" },
      ],
      walls: [
        { id: 0, floor: 0, ax: 106, ay: 80, bx: 106, by: 90, thicknessM: 0.12, material: "brick", doors: [{ offsetM: 2.5, widthM: 0.9, headM: 2 }, { offsetM: 7.5, widthM: 0.9, headM: 2 }] },
        { id: 1, floor: 0, ax: 106, ay: 85, bx: 112, by: 85, thicknessM: 0.12, material: "brick", doors: [] },
        { id: 2, floor: 1, ax: 106, ay: 80, bx: 106, by: 90, thicknessM: 0.12, material: "brick", doors: [{ offsetM: 5, widthM: 0.9, headM: 2 }] },
      ],
      stairs: [{ id: 0, floor: 0, room: 0, x0: 101, y0: 81, x1: 104.5, y1: 81, widthM: 1 }],
    },
  };
}

/** Blue: four men with two hand grenades each, 20 m west of the door; red far off; everyone holding fire. */
function input(bombs = 2, drills: Partial<typeof testCatalog.behaviour.drills> = {}): BattleInput {
  const inp = armedInput(1, 900);
  const m: MapDef = { ...inp.map };
  m.buildings = [house()];
  inp.map = m;
  inp.catalog = { ...testCatalog, behaviour: { ...testCatalog.behaviour, drills: { ...testCatalog.behaviour.drills, ...drills } } };
  const blue = inp.forces[0]!;
  const extra = { ...blue.units[0]!.members[0]!, personId: "a.3" };
  blue.units[0]!.members.push(extra);
  for (const mm of blue.units[0]!.members) mm.load = [...mm.load.filter((l) => l.type !== "bomb"), ...(bombs > 0 ? [{ type: "bomb", count: bombs }] : [])];
  blue.placements = blue.units[0]!.members.map((mm, i) => ({ personId: mm.personId, x: 80, y: 83 + i * 2.5, heading: 0 }));
  return inp;
}

function run(sim: Sim, ticks: number, out: SimEvent[] = []): SimEvent[] {
  for (let i = 0; i < ticks; i++) out.push(...step(sim));
  return out;
}

const unitOf = (sim: Sim, side: string) => [...sim.state.unit.entries()].find(([, u]) => u.side === side)![0];
const menOf = (sim: Sim, side: string) => [...sim.state.soldier.keys()].filter((id) => sim.state.identity.get(id)?.side === side);
const roomOfMan = (sim: Sim, id: number) => { const t = sim.state.transform.req(id), b = sim.ctx.map.buildings[0]!; return indoorAt(sim.ctx, t.x, t.y) === 0 ? roomAt(b, t.z > 1.4 ? 1 : 0, t.x, t.y) : -1; };

function clearing(bombs = 2, drills: Partial<typeof testCatalog.behaviour.drills> = {}): Sim {
  const sim = createSim(input(bombs, drills));
  for (const side of ["blue", "red"] as const) submitOrder(sim, { tick: 0, issuer: side, target: unitOf(sim, side), kind: "rules", fire: "hold" });
  submitOrder(sim, { tick: 0, issuer: "blue", target: unitOf(sim, "blue"), kind: "assault", x: 106, y: 85, building: 7 });
  return sim;
}

describe("clear: the order and the room order", () => {
  it("an assault on a building with an interior starts the drill; a building without one is rejected", () => {
    const sim = clearing();
    run(sim, 120);
    const d = sim.state.unit.req(unitOf(sim, "blue")).drill;
    expect(d?.kind).toBe("clear");
    expect(d?.building).toBe(7);
    expect(d?.rooms).toEqual([0, 1, 2, 3, 4]);
    const bad = createSim(input());
    submitOrder(bad, { tick: 0, issuer: "blue", target: unitOf(bad, "blue"), kind: "assault", x: 106, y: 85, building: 99 });
    const ev = run(bad, 120);
    expect(ev.some((e) => e.kind === "order.rejected" && e.reason === "invalid-params")).toBe(true);
    expect(bad.state.unit.req(unitOf(bad, "blue")).drill).toBeNull();
  });

  it("rooms breadth first from the door, the ground floor first, a room with a known enemy first among equals", () => {
    const sim = createSim(input());
    expect(roomOrder(sim.ctx, 0, 0, new Set())).toEqual([0, 1, 2, 3, 4]);
    expect(roomOrder(sim.ctx, 0, 0, new Set([2]))).toEqual([0, 2, 1, 3, 4]);
    expect(roomOrder(sim.ctx, 0, 0, new Set([4]))).toEqual([0, 1, 2, 3, 4]); // (upstairs after the ground floor)
  });
});

describe("clear: stack, grenade, in", () => {
  it("the men stack up beside the door, not in front of it", () => {
    const sim = clearing();
    const ev = run(sim, 60 * 3);
    expect(ev.some((e) => e.kind === "radio" && e.key === "radio.clearing")).toBe(true);
    for (const id of menOf(sim, "blue")) {
      const w = sim.state.mover.req(id).waypoints, last = w[w.length - 1];
      if (!last) continue;
      expect(last.x).toBeLessThan(100); // outside the west wall
      expect(Math.abs(last.y - 87)).toBeGreaterThanOrEqual(0.5 + testCatalog.behaviour.drills.clearStackAsideM - 0.01); // beside the 1 m door at y = 87
    }
  });

  it("a grenade into each room it can throw into, nobody in a room before its grenade bursts, every room entered", () => {
    const sim = clearing();
    const ev: SimEvent[] = [];
    const firstIn = new Map<number, number>();
    for (let k = 0; k < 60 * 240; k++) {
      ev.push(...step(sim));
      if (k % 15 === 0) for (const id of menOf(sim, "blue")) { const r = roomOfMan(sim, id); if (r >= 0 && !firstIn.has(r)) firstIn.set(r, sim.state.tick); }
      if (ev.some((e) => e.kind === "radio" && e.key === "radio.houseCleared")) break;
    }
    expect(ev.some((e) => e.kind === "radio" && e.key === "radio.houseCleared")).toBe(true);
    expect(sim.state.unit.req(unitOf(sim, "blue")).drill).toBeNull();
    const b = sim.ctx.map.buildings[0]!;
    if (process.env.DBG) console.log(ev.filter((e) => e.kind === "explosion" || e.kind === "grenade.launched" || e.kind === "radio" || e.kind === "action.started").map((e) => JSON.stringify(e)).join("\n"));
    const bursts = ev.filter((e) => e.kind === "explosion" && indoorAt(sim.ctx, e.x, e.y) === 0).map((e) => e as Extract<SimEvent, { kind: "explosion" }>);
    // (Into the hall, both east rooms and the east room upstairs: none up the stairs.)
    expect(bursts.length).toBeGreaterThanOrEqual(4);
    const burstRoom = (e: { x: number; y: number; z: number }) => roomAt(b, e.z > 2 ? 1 : 0, e.x, e.y);
    for (const r of [0, 1, 2, 4]) {
      const bt = bursts.find((e) => burstRoom(e) === r);
      expect(bt, `a grenade burst in room ${r}`).toBeDefined();
      expect(firstIn.get(r)!).toBeGreaterThan(bt!.tick);
    }
    for (const r of [0, 1, 2, 3, 4]) expect(firstIn.has(r), `room ${r} entered`).toBe(true);
    // (The men still able: the burst keeps away from them.)
    expect(menOf(sim, "blue").filter((id) => sim.state.soldier.req(id).casualty === "none").length).toBeGreaterThanOrEqual(3);
  });

  it("upstairs a throw along the floor finds its arc (it comes down on the slab, not the ground under it)", () => {
    const sim = createSim(input());
    const man = menOf(sim, "blue")[0]!;
    for (const pose of ["crouching", "standing"] as const) for (const [x, y] of [[111, 81], [111, 89]] as const) {
      expect(throwArcExists(sim.ctx, sim.state, man, "bomb", x, y, { x: 105.6, y: 85, z: 2.8 }, pose), `${pose} (${x}, ${y})`).toBe(true);
    }
  });

  it("without grenades the men still go in, room by room", () => {
    const sim = clearing(0);
    const ev = run(sim, 60 * 200);
    expect(ev.some((e) => e.kind === "grenade.launched")).toBe(false);
    expect(ev.some((e) => e.kind === "radio" && e.key === "radio.houseCleared")).toBe(true);
  });

  it("ends when the unit is below clearMinMen able men", () => {
    const sim = clearing(2, { clearMinMen: 5 });
    run(sim, 60 * 5);
    expect(sim.state.unit.req(unitOf(sim, "blue")).drill).toBeNull();
  });

  it("save and load in the middle of a clearing: the same hash after, and the same end", () => {
    const a = clearing();
    run(a, 60 * 30);
    expect(a.state.unit.req(unitOf(a, "blue")).drill?.stage).toBeDefined();
    const b = createSim(input());
    b.state = deserializeState(serializeState(a.state));
    expect(hashState(b.state)).toBe(hashState(a.state));
    run(a, 60 * 40); run(b, 60 * 40);
    expect(hashState(b.state)).toBe(hashState(a.state));
  });
});
