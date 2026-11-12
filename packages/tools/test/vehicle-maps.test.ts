/**
 * Vehicles on generated maps (M7.1c): random routed moves of a Puma on village maps arrive (stall rate), the hull
 * never overlaps a house, a wall it cannot cross or deep water, and the vehicle grids stay within their budget.
 */
import { describe, expect, it } from "vitest";
import { buildCatalog } from "@tcs/data";
import {
  buildNavGrid, createRng, createSim, DEFAULT_COMMS, hullTerrain, navFor, nearestPassable, nextRange, step, submitOrder,
  type BattleInput, type Catalog, type MapDef,
} from "@tcs/sim";
import { generateMap, vehicleBattle } from "@tcs/scenario";
import { loadData } from "../src/scenarios";

const data = loadData();
const catalog: Catalog = buildCatalog(data, ["de", "ru"]);

function pumaOn(map: MapDef, seed: number): BattleInput {
  const crew = { key: "c", callsign: "C", echelon: "vehicle", leaderIndex: 0, vehicleId: "v", subunits: [],
    members: [0, 1, 2].map((i) => ({ personId: `c${i}`, given: "a", family: "b", rank: "r", role: "x", skills: {}, fatigue: 0, stress: 0, wounds: [], load: [], status: "fit" as const })) };
  const def = catalog.vehicles["de-puma"]!;
  const g = buildNavGrid(map, catalog.terrain, "tracked", 2, 0, [], { clearanceCells: 3 });
  const c0 = nearestPassable(g, map.widthM / 2, map.heightM / 2, 100);
  return {
    map, catalog, seed, orders: [],
    forces: [
      { side: "blue", faction: "de", units: [crew], placements: [], vehicles: [{ vehicleId: "v", type: "de-puma", load: [{ type: def.fuel.item, count: 1, charge: def.fuel.capacityL }] }],
        vehiclePlacements: [{ vehicleId: "v", x: ((c0 % g.cols) + 0.5) * 2, y: (Math.floor(c0 / g.cols) + 0.5) * 2, heading: 0 }] },
      { side: "red", faction: "ru", units: [], placements: [] },
    ],
    rules: { timeLimitSeconds: 1e6, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "none", physiologyParams: {}, objectives: [] },
  };
}

describe("vehicles on generated maps", () => {
  it("village: under 5 % of 100 random routed Puma moves stall, and the hull never overlaps a house, an uncrossable wall or water", () => {
    let moves = 0, arrived = 0, noRoute = 0, overlap = 0;
    const ht = { blocked: false, crossObstacle: -1, crossPart: -1 };
    for (const seed of [1, 2]) {
      const map = generateMap(catalog.terrain, { kind: "village", seed, widthM: 1200, heightM: 900 });
      const sim = createSim(pumaOn(map, seed));
      const [vid, v] = [...sim.state.vehicle.entries()][0]!;
      const def = catalog.vehicles["de-puma"]!;
      const rng = createRng(seed);
      for (let k = 0; k < 50; k++) {
        submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: v.unit!, kind: "move", waypoints: [{ x: nextRange(rng, "a", 100, 1100), y: nextRange(rng, "a", 100, 800), mode: "run" }] });
        moves++;
        for (let t = 0; t < 60 * 240; t++) {
          const ev = step(sim);
          const tr = sim.state.transform.req(vid);
          if (hullTerrain(sim.ctx, def, tr.x, tr.y, tr.heading, ht).blocked) overlap++;
          if (ev.some((e) => e.kind === "radio" && e.key === "radio.noRoute")) { if (t < 2) noRoute++; break; }
          if (ev.some((e) => e.kind === "unit.arrived")) { arrived++; break; }
        }
      }
    }
    const stalls = moves - arrived - noRoute;
    console.log(`village: ${moves} routed moves, ${arrived} arrived, ${noRoute} without a route, ${stalls} stalled (${((100 * stalls) / (moves - noRoute)).toFixed(1)} %)`);
    expect(overlap).toBe(0);
    expect(stalls / (moves - noRoute)).toBeLessThan(0.05);
  });

  it("vehicle grid at 2 x 2 km: size and build time within budget", () => {
    const map = generateMap(catalog.terrain, { kind: "village", seed: 3, widthM: 2000, heightM: 2000 });
    const sim = createSim(pumaOn(map, 3));
    const t0 = performance.now();
    const { grid } = navFor(sim.ctx, "tracked");
    const ms = performance.now() - t0;
    const bytes = grid.cost.byteLength + grid.wall.byteLength + grid.region.byteLength + grid.exposure.byteLength;
    console.log(`tracked:c1 at 2 x 2 km: ${(bytes / 1e6).toFixed(1)} MB, built in ${ms.toFixed(0)} ms`);
    expect(bytes).toBeLessThan(14e6);
    expect(ms).toBeLessThan(3000);
  });

  it("the vehicles scenario places every hull on ground it can drive, crewed, in the map's main area", () => {
    for (const seed of [1, 2, 3]) {
      const input = vehicleBattle(data, { seed, factions: ["de", "ru"], mapKind: "farmland" });
      const sim = createSim(input);
      expect(sim.state.vehicle.size).toBe(4);
      const ht = { blocked: false, crossObstacle: -1, crossPart: -1 };
      for (const [vid, v] of sim.state.vehicle.entries()) {
        const t = sim.state.transform.req(vid);
        expect(hullTerrain(sim.ctx, sim.ctx.catalog.vehicles[v.def]!, t.x, t.y, t.heading, ht).blocked).toBe(false);
        expect(v.seats.filter((s) => s !== null).length).toBe(3);
        expect(sim.state.unit.req(v.unit!).vehicle).toBe(vid);
      }
    }
  });
});
