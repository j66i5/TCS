/**
 * The mounted assault (balance pass 5, owner 2026-11-20): an assault order to men aboard drives their carrier to a
 * dismount point short of the objective, lets them out into the assault drill, and backs the hull to a support-by-fire
 * post; a hull with nobody aboard assaults by fire; a hit on the way lets them out early; the drill survives a save.
 */
import { describe, expect, it } from "vitest";
import {
  builtUpAround, createSim, dismountDistance, hashState, hypot2, isBuiltUp, loadSim, saveSim, step, streetPoints, submitOrder, threatMenFor,
  type BattleInput, type Catalog, type EntityId, type MountedAssaultDef, type Sim, type SimEvent, type UnitInput,
} from "../src/index";
import { rec, testCatalog, vehicleInput } from "./helpers";

const MA: MountedAssaultDef = {
  stepSeconds: 0.5, dismountStepM: 50, dismountCandidates: 3, slotM: 60, objectiveRadiusM: 30, arriveM: 15,
  threatMenM: 400, threatVehicleM: 600, threatSeenSeconds: 60, hitNearM: 300, hitRecentSeconds: 10, rideTimeoutSeconds: 300, dismountTimeoutSeconds: 60,
  postBackM: 60, postMinBackM: 20, postRingsM: [0, 40, 80], postMinSeen: 0.25, postStandoffM: 300, noRidersStandoffM: 250, minObjectiveM: 150,
  fireEverySeconds: 20, fireNearObjectiveM: 120, fireSeenSeconds: 60, ownClearM: 80, shiftM: 200, liftM: 100,
  followReplanM: 40, takenSlackM: 40, consolidateM: 60, pickupBackM: 20, nightBelowLight: 0.3,
  urban: { radiusM: 120, minBuildings: 8, minShare: 0.04, minObjectiveM: 60, postStandoffM: 200, streetPoints: 6 },
  driveRetries: 2, threatMarginM: 50,
};

/** The test tank with six passenger seats; the mounted-assault block; faction "fa" dismounts 200 m short. */
function catalog(withBlock = true): Catalog {
  const base = testCatalog.vehicles["tank"]!;
  return {
    ...testCatalog,
    factions: { ...testCatalog.factions, fa: { ...testCatalog.factions["fa"]!, dismountM: 200, dismountUrbanM: 100, afterDismount: { kind: "overwatch", followM: 150 } } },
    behaviour: { ...testCatalog.behaviour, mounting: { ...testCatalog.behaviour.mounting, ...(withBlock ? { mountedAssault: MA } : {}) } },
    vehicles: {
      tank: {
        ...base,
        seats: [
          ...base.seats.filter((s) => s.station !== "passenger"),
          ...[0, 1, 2, 3, 4, 5].map((i) => ({ id: `p${i + 1}`, station: "passenger" as const, pos: [-1 - 0.8 * Math.floor(i / 2), i % 2 === 0 ? 0.8 : -0.8, 1.2] as [number, number, number], part: "hull" as const, hatch: false })),
        ],
      },
    },
  };
}

/** The tank at (50, 100) facing east with squad "sq" (4 men) aboard; the red man far off at (590, 190). */
function input(o: { withBlock?: boolean; aboard?: boolean; houses?: boolean } = {}): BattleInput {
  const inp = vehicleInput(1, 600);
  inp.catalog = catalog(o.withBlock ?? true);
  if (o.houses === true) addHouses(inp);
  const sq: UnitInput = {
    key: "sq", callsign: "Sq", echelon: "squad", leaderIndex: 0, subunits: [], carrierId: "v1",
    members: Array.from({ length: 4 }, (_, i) => ({ ...rec(`sq.${i}`, [{ type: "mag", count: 3, charge: 30 }]), weapon: "rifle" })),
  };
  const blue = inp.forces[0]!;
  blue.units.push(sq);
  blue.placements.push(...sq.members.map((m, i) => ((o.aboard ?? true) ? { personId: m.personId, x: 50, y: 100, heading: 0, mountedIn: "v1" } : { personId: m.personId, x: 20, y: 20 + 4 * i, heading: 0 })));
  return inp;
}

/** Ten 10 x 10 m houses in two rows north and south of the way in round the objective (520, 100): built-up. */
function addHouses(inp: BattleInput): void {
  let id = 1;
  for (const y of [30, 160]) for (const x of [460, 490, 520, 550, 580]) {
    inp.map.buildings.push({ id: id++, kind: "house", footprint: [x, y, x + 10, y, x + 10, y + 10, x, y + 10], storeys: 1, storeyHeightM: 2.8, wallMaterial: "brick", wallThicknessM: 0.3, openings: [], roofColour: "#8c4a3b" });
  }
}

const unitBy = (sim: Sim, callsign: string): EntityId => [...sim.state.unit.entries()].find(([, u]) => u.callsign === callsign)![0];
const vid = (sim: Sim): EntityId => [...sim.state.vehicle.keys()][0]!;
const order = (sim: Sim, target: EntityId, body: Record<string, unknown>) => submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target, ...body } as never);
function run(sim: Sim, seconds: number, until?: (all: SimEvent[]) => boolean): SimEvent[] {
  const all: SimEvent[] = [];
  for (let i = 0; i < seconds * 60; i++) { all.push(...step(sim)); if (until?.(all)) break; }
  return all;
}
const OBJ = { x: 520, y: 100 };

describe("mounted assault (balance pass 5)", () => {
  it("drives the riders to the dismount point (doctrine distance), lets them out into the assault drill, then backs to a support post", () => {
    const sim = createSim(input());
    const sq = unitBy(sim, "Sq"), v = vid(sim);
    order(sim, sq, { kind: "assault", ...OBJ });
    const ev = run(sim, 120, (all) => all.some((e) => e.kind === "assault.supportPost"));
    const ma = sim.state.unit.get(sq)!.mountedAssault!;
    expect(ma).toBeDefined();
    const pt = ev.find((e) => e.kind === "assault.dismountPoint") as Extract<SimEvent, { kind: "assault.dismountPoint" }>;
    // 200 m short of the objective on the way in (flat open map: nothing hides it, the first point).
    expect(hypot2(pt.x - OBJ.x, pt.y - OBJ.y)).toBeCloseTo(200, 0);
    const out = ev.find((e) => e.kind === "assault.dismounted") as Extract<SimEvent, { kind: "assault.dismounted" }>;
    expect(out.distM).toBeGreaterThan(200 - 50);
    expect(out.distM).toBeLessThan(200 + 50);
    expect(ev.some((e) => e.kind === "unit.dismounted" && e.unit === sq)).toBe(true);
    // The squad took the assault drill toward the objective.
    expect(sim.state.unit.req(sq).drill?.kind).toBe("assault");
    expect(sim.state.unit.req(sq).drill?.x).toBe(OBJ.x);
    // The hull's post: behind where it let them out, not nearer the objective than minObjectiveM, sees it.
    const c = ma.carriers[0]!;
    expect(c.phase).toBe("support");
    expect(c.post).toBeTruthy();
    expect(hypot2(c.post!.x - OBJ.x, c.post!.y - OBJ.y)).toBeGreaterThanOrEqual(MA.minObjectiveM);
    expect(hypot2(c.post!.x - OBJ.x, c.post!.y - OBJ.y)).toBeGreaterThan(out.distM + MA.postMinBackM - 1);
    // It backs there (reversing: never turning its side to the objective).
    expect(sim.state.vehicle.req(v).drive.route.some((w) => w.reverse === true)).toBe(true);
    run(sim, 60);
    const t = sim.state.transform.req(v);
    expect(hypot2(t.x - c.post!.x, t.y - c.post!.y)).toBeLessThan(10);
  });

  it("an assault to the hull itself carries its passengers' squad the same way", () => {
    const sim = createSim(input());
    const crew = unitBy(sim, "Crew"), sq = unitBy(sim, "Sq");
    order(sim, crew, { kind: "assault", ...OBJ });
    const ev = run(sim, 120, (all) => all.some((e) => e.kind === "unit.dismounted"));
    expect(sim.state.unit.get(crew)!.mountedAssault!.carriers[0]!.squads).toEqual([sq]);
    expect(ev.some((e) => e.kind === "unit.dismounted" && e.unit === sq)).toBe(true);
    run(sim, 2);
    expect(sim.state.unit.req(sq).drill?.kind).toBe("assault");
  });

  it("a hull with nobody aboard assaults by fire: straight to a post short of the objective, never onto it", () => {
    const sim = createSim(input({ aboard: false }));
    const crew = unitBy(sim, "Crew"), v = vid(sim);
    order(sim, crew, { kind: "assault", ...OBJ });
    run(sim, 2);
    const c = sim.state.unit.get(crew)!.mountedAssault!.carriers[0]!;
    expect(c.squads).toEqual([]);
    expect(c.phase).toBe("support");
    expect(c.post).toBeTruthy();
    expect(hypot2(c.post!.x - OBJ.x, c.post!.y - OBJ.y)).toBeGreaterThanOrEqual(MA.minObjectiveM);
    run(sim, 90);
    const t = sim.state.transform.req(v);
    expect(hypot2(t.x - OBJ.x, t.y - OBJ.y)).toBeGreaterThanOrEqual(MA.minObjectiveM - 10);
  });

  it("a hit on the carrier on the way lets the squad out where it is", () => {
    const sim = createSim(input());
    const sq = unitBy(sim, "Sq"), v = vid(sim);
    order(sim, sq, { kind: "assault", ...OBJ });
    run(sim, 8);
    const x0 = sim.state.transform.req(v).x;
    expect(sim.state.unit.req(sq).mountedAssault!.carriers[0]!.phase).toBe("drive");
    sim.state.vehicle.req(v).lastHitTick = sim.state.tick;
    const ev = run(sim, 2);
    const out = ev.find((e) => e.kind === "assault.dismounted") as Extract<SimEvent, { kind: "assault.dismounted" }> | undefined;
    expect(out).toBeDefined();
    expect(out!.distM).toBeGreaterThan(300);
    expect(sim.state.transform.req(v).x).toBeLessThan(x0 + 30);
  });

  it("taken: once the squad's drill is over with a man on the objective, the hull closes up to it", () => {
    const sim = createSim(input());
    const sq = unitBy(sim, "Sq"), v = vid(sim);
    order(sim, sq, { kind: "assault", ...OBJ });
    run(sim, 120, (all) => all.some((e) => e.kind === "assault.supportPost"));
    // The squad on the objective, its drill over.
    for (const m of sim.state.unit.req(sq).members) { const t = sim.state.transform.req(m); t.x = OBJ.x; t.y = OBJ.y; sim.state.mover.delete(m); }
    sim.state.unit.req(sq).drill = null;
    const ev = run(sim, 2);
    const end = ev.find((e) => e.kind === "assault.ended") as Extract<SimEvent, { kind: "assault.ended" }>;
    expect(end?.taken).toBe(true);
    expect(sim.state.unit.req(sq).mountedAssault).toBeUndefined();
    const r = sim.state.vehicle.req(v).drive.route;
    expect(hypot2(r[r.length - 1]!.x - OBJ.x, r[r.length - 1]!.y - OBJ.y)).toBeLessThan(MA.consolidateM + 10);
  });

  it("a move order to the squad ends its part; a save mid-drill replays the same", () => {
    const inp = input();
    const a = createSim(inp);
    const sq = unitBy(a, "Sq");
    order(a, sq, { kind: "assault", ...OBJ });
    run(a, 10);
    const b = loadSim(inp, JSON.parse(JSON.stringify(saveSim(a))));
    run(a, 40); run(b, 40);
    expect(hashState(b.state)).toBe(hashState(a.state));
    order(a, sq, { kind: "move", waypoints: [{ x: 100, y: 100, mode: "walk" }] });
    run(a, 1);
    expect(a.state.unit.req(sq).mountedAssault).toBeUndefined();
  });

  it("without the data block an assault to riders dismounts them first, as before", () => {
    const sim = createSim(input({ withBlock: false }));
    const sq = unitBy(sim, "Sq");
    order(sim, sq, { kind: "assault", ...OBJ });
    const ev = run(sim, 5);
    expect(ev.some((e) => e.kind === "radio" && e.key === "radio.dismountFirst")).toBe(true);
    expect(sim.state.unit.req(sq).mountedAssault).toBeUndefined();
  });

  it("built-up objectives (owner 2026-11-20): enough houses round the objective, or a building, count; then the urban distance applies", () => {
    const open = createSim(input()), town = createSim(input({ houses: true }));
    const ctxOpen = open.ctx;
    const ctxTown = town.ctx;
    expect(builtUpAround(ctxOpen, OBJ.x, OBJ.y, 120)).toEqual({ buildings: 0, share: 0 });
    const b = builtUpAround(ctxTown, OBJ.x, OBJ.y, 120);
    expect(b.buildings).toBe(10);
    expect(b.share).toBeCloseTo(1000 / (Math.PI * 120 * 120), 4);
    expect(isBuiltUp(ctxOpen, OBJ.x, OBJ.y)).toBe(false);
    expect(isBuiltUp(ctxTown, OBJ.x, OBJ.y)).toBe(true);
    // Far from the houses: open ground again.
    expect(isBuiltUp(ctxTown, 100, 100)).toBe(false);
    // An objective that is a building is built-up whatever stands round it.
    expect(isBuiltUp(ctxOpen, OBJ.x, OBJ.y, 3)).toBe(true);
    expect(dismountDistance(ctxOpen, "fa", OBJ.x, OBJ.y)).toEqual({ dismountM: 200, urban: false });
    expect(dismountDistance(ctxTown, "fa", OBJ.x, OBJ.y)).toEqual({ dismountM: 100, urban: true });
    // Without the urban values nothing is built-up.
    const noUrban = { ...ctxTown, catalog: { ...ctxTown.catalog, behaviour: { ...ctxTown.catalog.behaviour, mounting: { ...ctxTown.catalog.behaviour.mounting, mountedAssault: { ...MA, urban: undefined } as unknown as MountedAssaultDef } } } };
    expect(isBuiltUp(noUrban, OBJ.x, OBJ.y)).toBe(false);
    // The threat cap: the distance in force + the margin, never beyond threatMenM.
    expect(threatMenFor(MA, 200)).toBe(250);
    expect(threatMenFor(MA, 400)).toBe(400);
    expect(threatMenFor({ ...MA, threatMarginM: undefined } as unknown as MountedAssaultDef, 100)).toBe(400);
  });

  it("street points: road points round the objective, spread out, nearest first", () => {
    const inp = input();
    inp.map.roads.push({ id: 1, points: [300, 100, 600, 100], widthM: 6, surface: inp.map.surfacePalette[0]! });
    const sim = createSim(inp);
    const pts = streetPoints(sim.ctx, OBJ.x, OBJ.y, 120, 6);
    expect(pts.length).toBeGreaterThan(2);
    expect(pts.length).toBeLessThanOrEqual(6);
    for (const p of pts) { expect(p.y).toBe(100); expect(hypot2(p.x - OBJ.x, p.y - OBJ.y)).toBeLessThanOrEqual(120); }
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) expect(hypot2(pts[i]!.x - pts[j]!.x, pts[i]!.y - pts[j]!.y)).toBeGreaterThanOrEqual(25);
  });

  it("a built-up objective: the riders get out at the shorter urban distance, the hull's post may stand closer", () => {
    const run1 = (houses: boolean) => {
      const sim = createSim(input({ houses }));
      const sq = unitBy(sim, "Sq");
      order(sim, sq, { kind: "assault", ...OBJ });
      const ev = run(sim, 150, (all) => all.some((e) => e.kind === "assault.supportPost"));
      const out = ev.find((e) => e.kind === "assault.dismounted") as Extract<SimEvent, { kind: "assault.dismounted" }> | undefined;
      return { sim, sq, out, ma: sim.state.unit.get(sq)!.mountedAssault };
    };
    const open = run1(false), town = run1(true);
    expect(open.out!.reason).toBe("point");
    expect(town.out!.reason).toBe("point");
    expect(town.ma!.urban).toBe(true);
    expect(open.ma!.urban).toBeUndefined();
    expect(open.out!.distM).toBeGreaterThan(150);
    expect(town.out!.distM).toBeGreaterThan(100 - 30);
    expect(town.out!.distM).toBeLessThan(100 + 50);
    expect(town.out!.distM).toBeLessThan(open.out!.distM - 50);
  });
});
