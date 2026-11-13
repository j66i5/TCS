/** Upper floors (M7.5d): stairs, heights, moving upstairs, firing and seeing from upper windows, Occupy, saves. */
import { describe, expect, it } from "vitest";
import {
  createSim, deserializeState, floorOf, hashState, indoorAt, indoorSpots, lineBlocked, navFor, occupyPlaces, routeBetween, serializeState, sight, standZ, step, submitOrder,
  stripInteriors, type Building, type MapDef, type Sim, type SimEvent,
} from "../src/index";
import { armedInput, testInput } from "./helpers";

/** The M7.5c test house (12 x 10 m, two storeys of 2.8 m, two rooms each floor, stairs in the west room). */
function house(): Building {
  const fp = [100, 80, 112, 80, 112, 90, 100, 90];
  const west = [100, 80, 106, 80, 106, 90, 100, 90], east = [106, 80, 112, 80, 112, 90, 106, 90];
  return {
    id: 1, kind: "house", footprint: fp, storeys: 2, storeyHeightM: 2.8, wallMaterial: "brick", wallThicknessM: 0.3, roofColour: "#8c4a3b",
    openings: [
      { wall: 3, offsetM: 3, widthM: 1.0, kind: "door", sillM: 0, headM: 2.1 }, // west wall: y = 87
      { wall: 1, offsetM: 5, widthM: 1.2, kind: "window", sillM: 0.9, headM: 2.1, floor: 1 }, // east wall upstairs: y = 85
      { wall: 1, offsetM: 2, widthM: 1.2, kind: "window", sillM: 0.9, headM: 2.1, floor: 1 }, // east wall upstairs: y = 82
      { wall: 0, offsetM: 3, widthM: 1.2, kind: "window", sillM: 0.9, headM: 2.1, floor: 1 }, // north wall upstairs: x = 103
    ],
    interior: {
      rooms: [0, 1].flatMap((fl) => [{ id: fl * 2, floor: fl, poly: west, kind: "hall" as const }, { id: fl * 2 + 1, floor: fl, poly: east, kind: "room" as const }]),
      walls: [0, 1].map((fl) => ({ id: fl, floor: fl, ax: 106, ay: 80, bx: 106, by: 90, thicknessM: 0.12, material: "brick", doors: [{ offsetM: 5, widthM: 0.9, headM: 2 }] })),
      stairs: [{ id: 0, floor: 0, room: 0, x0: 101, y0: 81, x1: 104.5, y1: 81, widthM: 1 }],
    },
  };
}

function simWith(armed = false, interiors = true): Sim {
  const input = armed ? armedInput(1, 900) : testInput(1, 900);
  const m: MapDef = { ...input.map };
  m.buildings = [house()];
  input.map = interiors ? m : stripInteriors(m);
  return createSim(input);
}

function run(sim: Sim, ticks: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < ticks; i++) out.push(...step(sim));
  return out;
}

const blueUnit = (sim: Sim) => [...sim.state.unit.entries()].find(([, u]) => u.side === "blue")![0];
const blueMen = (sim: Sim) => [...sim.state.soldier.keys()].filter((id) => sim.state.identity.get(id)?.side === "blue");

describe("floors: routes and stairs", () => {
  it("routes from outside up the stairs to the room above, heights rising only on the stairs", () => {
    const sim = simWith();
    const r = routeBetween(sim.ctx, navFor(sim.ctx, "foot").search, 90, 87, 109, 85, {}, { gz: 2.8 })!;
    expect(r.zs).toBeDefined();
    expect(r.zs![r.zs!.length - 1]).toBe(2.8);
    // The climb is the stairs' leg: from (101, 81) at 0 to (104.5, 81) at 2.8.
    const i = r.zs!.findIndex((z) => z > 0);
    expect([r.points[i * 2], r.points[i * 2 + 1]]).toEqual([104.5, 81]);
    expect(r.zs![i - 1]).toBe(0);
    // Without heights the same call is the ground-floor route of M7.5c (no heights carried).
    expect(routeBetween(sim.ctx, navFor(sim.ctx, "foot").search, 90, 87, 109, 85)!.zs).toBeUndefined();
  });

  it("a squad ordered to the floor above climbs the stairs and ends upstairs; floorOf and standZ agree", () => {
    const sim = simWith();
    submitOrder(sim, { tick: 0, issuer: "blue", target: blueUnit(sim), kind: "move", waypoints: [{ x: 109, y: 85, mode: "walk" }], floor: 1 });
    let maxMid = 0;
    for (let k = 0; k < 120; k++) {
      run(sim, 60);
      for (const id of blueMen(sim)) { const z = sim.state.transform.req(id).z; if (z > 0.1 && z < 2.7) maxMid = Math.max(maxMid, z); }
    }
    expect(maxMid).toBeGreaterThan(0); // somebody was seen part way up
    for (const id of blueMen(sim)) {
      const t = sim.state.transform.req(id);
      expect(indoorAt(sim.ctx, t.x, t.y)).toBe(0);
      expect(t.z).toBeCloseTo(2.8, 9);
      expect(floorOf(sim.ctx, t.x, t.y, t.z)).toBe(1);
      expect(standZ(sim.ctx.map, t)).toBeCloseTo(2.8, 9);
    }
    // And back down and out.
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: blueUnit(sim), kind: "move", waypoints: [{ x: 80, y: 87, mode: "walk" }] });
    run(sim, 60 * 120);
    for (const id of blueMen(sim)) {
      const t = sim.state.transform.req(id);
      expect(indoorAt(sim.ctx, t.x, t.y)).toBe(-1);
      expect(t.z).toBe(0);
    }
  });

  it("stairs are slower than level floor", () => {
    const sim = simWith();
    const id = blueMen(sim)[0]!;
    const t = sim.state.transform.req(id), m = sim.state.mover.req(id);
    t.x = 101; t.y = 81;
    m.waypoints = [{ x: 104.5, y: 81, mode: "walk", z: 2.8 }];
    let n = 0;
    while (m.waypoints.length > 0 && n < 6000) { step(sim); n++; }
    const sim2 = simWith();
    const t2 = sim2.state.transform.req(id), m2 = sim2.state.mover.req(id);
    t2.x = 101; t2.y = 81;
    m2.waypoints = [{ x: 104.5, y: 81, mode: "walk" }];
    let n2 = 0;
    while (m2.waypoints.length > 0 && n2 < 6000) { step(sim2); n2++; }
    expect(n).toBeGreaterThan(n2 * 1.6);
    expect(t.z).toBe(2.8);
  });

  it("a save made half way up the stairs loads and carries on identically", () => {
    const sim = simWith();
    submitOrder(sim, { tick: 0, issuer: "blue", target: blueUnit(sim), kind: "move", waypoints: [{ x: 109, y: 85, mode: "walk" }], floor: 1 });
    let mid = false;
    for (let k = 0; k < 60 * 120 && !mid; k++) { step(sim); mid = blueMen(sim).some((id) => { const z = sim.state.transform.req(id).z; return z > 0.2 && z < 2.6; }); }
    expect(mid).toBe(true);
    const back = deserializeState(JSON.parse(JSON.stringify(serializeState(sim.state))));
    expect(hashState(back)).toBe(hashState(sim.state));
    const sim2 = simWith();
    sim2.state = back;
    run(sim, 600); run(sim2, 600);
    expect(hashState(sim2.state)).toBe(hashState(sim.state));
  });
});

describe("floors: sight, fire, blast", () => {
  it("a man at the upstairs window sees over a wall that hides the ground floor", () => {
    const sim = simWith();
    // Eye at the upstairs window (standZ + eye) out to a man 30 m east; the ground-floor east wall has no window.
    expect(sight(sim.ctx, 111.3, 85, 2.8 + 1.6, 140, 85, 1.0).blockedBy).toBe(null);
    expect(sight(sim.ctx, 111.3, 85, 1.6, 140, 85, 1.0).blockedBy).toBe("wall");
  });

  it("a grenade bursting downstairs does not reach a man upstairs above it (the floor shields him)", () => {
    const sim = simWith();
    const B = sim.ctx.ballistics, m = sim.ctx.map, ix = sim.ctx.mapIndex;
    expect(lineBlocked(B, m, ix, 109, 84, 0.2, 109, 85, 2.8 + 0.9)).toBe(true);
    expect(lineBlocked(B, m, ix, 109, 84, 2.8 + 0.2, 109, 85, 2.8 + 0.9)).toBe(false);
  });

  it("men occupying the house take the upstairs windows facing the enemy and fire from them", () => {
    const sim = simWith(true);
    // The enemy east of the house.
    const reds = [...sim.state.soldier.keys()].filter((id) => sim.state.identity.get(id)?.side === "red");
    reds.forEach((id, i) => { const t = sim.state.transform.req(id); t.x = 160; t.y = 82 + i * 4; });
    submitOrder(sim, { tick: 0, issuer: "blue", target: blueUnit(sim), kind: "rules", fire: "hold" });
    submitOrder(sim, { tick: 0, issuer: "blue", target: blueUnit(sim), kind: "occupy", building: 1, facing: 0 });
    run(sim, 60 * 90);
    const placed = blueMen(sim).map((id) => sim.state.transform.req(id));
    const upstairsEast = placed.filter((t) => t.z === 2.8 && t.x > 111);
    expect(upstairsEast.length).toBe(2);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: blueUnit(sim), kind: "rules", fire: "free" });
    const ev = run(sim, 60 * 30);
    const shots = ev.filter((e) => e.kind === "shot.fired" && blueMen(sim).includes((e as { shooter: number }).shooter));
    expect(shots.length).toBeGreaterThan(0);
  });
});

describe("floors: occupy and spreading", () => {
  it("occupy places are deterministic, at windows first, never two in one place", () => {
    const sim = simWith();
    const a = occupyPlaces(sim.ctx, 0, 5, undefined, 0), b = occupyPlaces(sim.ctx, 0, 5, undefined, 0);
    expect(a).toEqual(b);
    expect(a.slice(0, 2).every((p) => p.z === 2.8 && p.x > 111)).toBe(true);
    for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) expect(a[i]!.x !== a[j]!.x || a[i]!.y !== a[j]!.y || a[i]!.z !== a[j]!.z).toBe(true);
  });

  it("a squad's indoor places spread over the rooms (about one man per 4.5 m2), then the floor above", () => {
    const sim = simWith();
    const s = indoorSpots(sim.ctx, 0, 109, 85, 16);
    const east0 = s.filter((p) => p.z === 0 && p.x > 106).length, west0 = s.filter((p) => p.z === 0 && p.x < 106).length;
    expect(east0).toBeLessThanOrEqual(Math.floor(60 / 4.5));
    expect(west0).toBeGreaterThan(0);
    const t = indoorSpots(sim.ctx, 0, 109, 85, 30);
    expect(t.some((p) => p.z === 2.8)).toBe(true);
    // Men's places a little apart.
    const f = indoorSpots(sim.ctx, 0, 109, 85, 6);
    for (let i = 0; i < f.length; i++) for (let j = i + 1; j < f.length; j++) expect(Math.hypot(f[i]!.x - f[j]!.x, f[i]!.y - f[j]!.y)).toBeGreaterThan(0.79);
  });
});
