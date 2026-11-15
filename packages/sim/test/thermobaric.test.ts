/**
 * Thermobaric bursts (M7.6d, SPEC 3 abstract effect) and disposable anti-personnel rounds: a burst in a room (or on
 * its outer wall) fills that room (men in it take the blast at the radii x enclosedFactor, no wall shielding them);
 * a man in the next room behind an inner wall and men outdoors take the plain blast as before; in the open it is the
 * plain blast of its filling. A disposable round with no launcher item is fired and leaves the load (rule 9); a
 * launcher's round search never gives an anti-personnel round for a vehicle.
 */
import { describe, expect, it } from "vitest";
import { createSim, detonate, EventSink, hashState, launcherRound, roomOfPoint, type AmmoDef, type BattleInput, type Building, type Catalog, type MapDef, type Sim } from "../src/index";
import { armedInput, testCatalog } from "./helpers";

/** 12 x 10 m one-storey house: a hall west (room 0), two rooms east (1 north, 2 south) behind inner brick walls. */
function house(): Building {
  const fp = [100, 80, 112, 80, 112, 90, 100, 90];
  return {
    id: 7, kind: "house", footprint: fp, storeys: 1, storeyHeightM: 2.8, wallMaterial: "brick", wallThicknessM: 0.3, roofColour: "#8c4a3b",
    openings: [{ wall: 3, offsetM: 3, widthM: 1.0, kind: "door", sillM: 0, headM: 2.1 }],
    interior: {
      rooms: [
        { id: 0, floor: 0, poly: [100, 80, 106, 80, 106, 90, 100, 90], kind: "hall" },
        { id: 1, floor: 0, poly: [106, 80, 112, 80, 112, 85, 106, 85], kind: "room" },
        { id: 2, floor: 0, poly: [106, 85, 112, 85, 112, 90, 106, 90], kind: "room" },
      ],
      walls: [
        { id: 0, floor: 0, ax: 106, ay: 80, bx: 106, by: 90, thicknessM: 0.12, material: "brick", doors: [{ offsetM: 2.5, widthM: 0.9, headM: 2 }, { offsetM: 7.5, widthM: 0.9, headM: 2 }] },
        { id: 1, floor: 0, ax: 106, ay: 85, bx: 112, by: 85, thicknessM: 0.12, material: "brick", doors: [] },
      ],
      stairs: [],
    },
  };
}

const TB_BASE: AmmoDef = {
  id: "tb", calibre: "93mm-rpo", kind: "thermobaric", projectileMassKg: 3, cartridgeMassKg: 11, diameterM: 0.093, drag: { a: 0.3, b: 0, max: 0.35 },
  penetration: { steelMm: 0, atVelocityMps: 100 }, tracer: false, fuse: "impact", guidance: "unguided",
  explosive: { fillingKg: 2.1, fragmentCount: 0, fragmentAmmo: "shard", fragmentVelocityMps: [600, 1000], armingSeconds: 0.1, thermobaric: { enclosedFactor: 1.6 } },
  delivery: { method: "direct", velocityMps: 125, maxRangeM: 600, dispersionMrad: 2.5, aimSeconds: 3, backblastM: 15, disposable: true, role: "antiPersonnel" },
};

/** The test catalog with the thermobaric round `tb` (or the same round without the thermobaric block). */
function catalog(thermobaric: boolean): Catalog {
  const tb: AmmoDef = thermobaric ? TB_BASE : { ...TB_BASE, explosive: { ...TB_BASE.explosive!, thermobaric: undefined } };
  if (!thermobaric) delete tb.explosive!.thermobaric;
  return {
    ...testCatalog,
    // (Its own blast values: another test in this shared worker sets the test catalog's injury radius to 0.)
    ballistics: { ...testCatalog.ballistics, blast: { severeScaledM: 3, injuryScaledM: 6, stunScaledM: 25, stunSeconds: 4, craterScaledM: 0.6, breachSteelMmScaled: 15, breachReachScaledM: 2.5, breachWidthScaledM: 2.5, shieldSteelMm: 5 } },
    items: { ...testCatalog.items, tb: { id: "tb", massKg: 11, category: "ammunition" } },
    ammo: { ...testCatalog.ammo, tb },
    ammoIds: [...testCatalog.ammoIds, "tb"].sort(),
  };
}

/** Red men: three in room 1 (north-east), one in room 2 (south-east) behind the inner wall, one outdoors east. */
const RED_AT: [number, number][] = [[107, 81], [109, 82.5], [110.5, 84], [109, 87.5], [118, 82]];
function input(thermobaric: boolean): BattleInput {
  const inp = armedInput(1, 600);
  const m: MapDef = { ...inp.map, buildings: [house()] };
  inp.map = m;
  inp.catalog = catalog(thermobaric);
  const red = inp.forces[1]!;
  const proto = red.units[0]!.members[0]!;
  red.units[0]!.members = RED_AT.map((_, i) => ({ ...proto, personId: `b.${i}` }));
  red.placements = RED_AT.map(([x, y], i) => ({ personId: `b.${i}`, x, y, heading: 0 }));
  return inp;
}

/** Burst the round at (x, y, z) and return each red man's blast severity (0: none) and stun. */
function burst(thermobaric: boolean, x: number, y: number, z: number): { sim: Sim; sev: number[]; stunned: boolean[] } {
  const sim = createSim(input(thermobaric));
  const owner = [...sim.state.identity.entries()].find(([, i]) => i.side === "blue")![0];
  detonate(sim.ctx, sim.state, new EventSink(), x, y, z, sim.ctx.catalog.ammoIds.indexOf("tb"), owner);
  const red = [...sim.state.identity.entries()].filter(([, i]) => i.side === "red").map(([id]) => id);
  return {
    sim,
    sev: red.map((id) => sim.state.soldier.req(id).wounds.filter((w) => w.mechanism === "blast").reduce((a, w) => Math.max(a, w.severity), 0)),
    stunned: red.map((id) => sim.state.soldier.req(id).stunnedUntilTick > sim.state.tick),
  };
}

describe("thermobaric bursts (M7.6d)", () => {
  it("roomOfPoint: a point in a room, a point on the outer wall (the room inside), outdoors none", () => {
    const sim = createSim(input(true));
    expect(roomOfPoint(sim.ctx, 109, 82, 1)).toEqual({ bi: 0, floor: 0, room: 1 });
    expect(roomOfPoint(sim.ctx, 109, 79.7, 1)).toBeNull();
    expect(roomOfPoint(sim.ctx, 109, 79.7, 1, 0.6)).toEqual({ bi: 0, floor: 0, room: 1 });
    expect(roomOfPoint(sim.ctx, 130, 82, 1, 0.6)).toBeNull();
  });

  it("in a room: every man in it takes the blast at the larger radii; the next room and outdoors as the plain blast", () => {
    const tb = burst(true, 106.6, 80.6, 1), plain = burst(false, 106.6, 80.6, 1);
    // Room 1: all three wounded, the farthest (5.3 m) severely with the thermobaric (plain: an injury only).
    for (let i = 0; i < 3; i++) { expect(tb.sev[i]).toBeGreaterThan(0); expect(tb.sev[i]).toBeGreaterThanOrEqual(plain.sev[i]!); }
    expect(tb.sev[2]).toBeGreaterThan(plain.sev[2]!);
    // Room 2 (behind the inner wall) and outdoors: exactly the plain burst's result.
    for (const i of [3, 4]) { expect(tb.sev[i]).toBe(plain.sev[i]); expect(tb.stunned[i]).toBe(plain.stunned[i]); }
  });

  it("on the room's outer wall (a rocket striking it from outside) it fills the room inside", () => {
    const tb = burst(true, 109, 79.7, 1), plain = burst(false, 109, 79.7, 1);
    for (let i = 0; i < 3; i++) expect(tb.sev[i]).toBeGreaterThan(0);
    expect(tb.sev.slice(0, 3).reduce((a, b) => a + b, 0)).toBeGreaterThan(plain.sev.slice(0, 3).reduce((a, b) => a + b, 0));
  });

  it("in the open: the plain blast of its filling", () => {
    const tb = burst(true, 125, 82, 0.05), plain = burst(false, 125, 82, 0.05);
    expect(tb.sev).toEqual(plain.sev);
    expect(tb.stunned).toEqual(plain.stunned);
  });

  it("deterministic: the same burst twice gives the same state", () => {
    expect(hashState(burst(true, 106.6, 80.6, 1).sim.state)).toBe(hashState(burst(true, 106.6, 80.6, 1).sim.state));
  });
});

describe("disposable anti-personnel rounds (M7.6d)", () => {
  it("a man with the tube and no launcher item has a round for a position, none for a vehicle", () => {
    const inp = input(true);
    inp.forces[0]!.units[0]!.members[0]!.load.push({ type: "tb", count: 1 });
    const sim = createSim(inp);
    const man = [...sim.state.identity.entries()].find(([, i]) => i.side === "blue")![0];
    expect(launcherRound(sim.ctx, sim.state, man)).toBeNull();
    expect(launcherRound(sim.ctx, sim.state, man, "vehicle")).toBeNull();
    expect(launcherRound(sim.ctx, sim.state, man, "position")).toEqual({ ammo: "tb", launcher: null });
    expect(launcherRound(sim.ctx, sim.state, man, "antiPersonnel")).toEqual({ ammo: "tb", launcher: null });
  });
});
