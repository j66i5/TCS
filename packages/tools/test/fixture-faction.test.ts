/**
 * FIXTURE FACTION (SPEC 4.3 rule 8, 9.4): a third, made-up faction loads from data alone and fights a
 * battle. If this ever needs an engine change, a faction has leaked into code. Must stay green forever.
 */
import { describe, expect, it } from "vitest";
import { buildCatalog, formatErrors, loadDataSet, Strings } from "@tcs/data";
import { allMembers, buildForce, buildForceWithVehicles, demoBattle } from "@tcs/scenario";
import { countItems, createSim, DEFAULT_COMMS, flatMap, idleDrive, newVehicleRecord, runBattle, step, stepDriveDynamics, submitOrder, type Placement, type SimEvent } from "@tcs/sim";
import { driveBattle } from "../src/labs/drive";
import { wanderController } from "@tcs/ai";
import { readDataFiles } from "../src/data-files";

const files = readDataFiles(["core", "factions", "fixtures"]);

describe("fixture faction 'xf'", () => {
  const { data, errors } = loadDataSet(files);
  it("loads without errors", () => {
    expect(formatErrors(errors.filter((e) => e.severity === "error"))).toBe("");
    expect(data?.factions["xf"]?.manifest.fixture).toBe(true);
  });

  it("builds a force entirely from its data (names, ranks, nested units, loads)", () => {
    const u = buildForce(data!, { faction: "xf", template: "porter-band", seed: 4, keyPrefix: "x" });
    expect(u.callsign).toBe("Band 1");
    expect(u.subunits.map((s) => s.callsign)).toEqual(["Gang 1", "Gang 2"]);
    const men = allMembers(u);
    expect(men).toHaveLength(6);
    const names = data!.factions["xf"]!.names;
    for (const m of men) {
      expect(names.given.concat(names.givenFemale)).toContain(m.given);
      expect(names.family.some((f) => m.family === f || m.family === f + names.familyFemaleSuffix)).toBe(true);
      expect(["private", "boss"]).toContain(m.rank);
    }
  });

  it("fights a battle against a real faction and its load comes back out", () => {
    const input = demoBattle(data!, { seed: 9, factions: ["xf", "de"], templates: ["porter-band", "demo-team"], timeLimitSeconds: 60 });
    expect(Object.keys(input.catalog.factions)).toEqual(["de", "xf"]);
    const result = runBattle(input, {
      controllers: [wanderController("blue", 1, input.map), wanderController("red", 2, input.map)],
    });
    expect(result.endReason).toBe("time-limit");
    expect(result.sides.find((s) => s.side === "blue")).toMatchObject({ faction: "xf", soldiersStart: 6 });
    const out = result.forcesOut.find((f) => f.faction === "xf")!;
    const men = out.units.flatMap(allMembers);
    const mags = men.reduce((n, m) => n + m.load.filter((l) => l.type === "xf-mag").reduce((k, l) => k + l.count, 0), 0);
    expect(mags).toBe(2 * (4 + 10 + 2));
    expect(result.eventCounts["order.delivered"]).toBeGreaterThan(0);
    void countItems;
  });

  it("uses its own radio phrasing through the string table, with fallback to core", () => {
    const s = new Strings(data!);
    expect(s.t("radio.ack.move", { callsign: "Gang 1" }, "xf")).toBe("Gang 1 goes.");
    expect(s.t("radio.arrived", { callsign: "Gang 1" }, "xf")).toBe("Gang 1: in position.");
    expect(s.t("radio.ack.move", { callsign: "Trupp 1" }, "de")).toBe("Trupp 1: roger, moving.");
    expect(s.t("no.such.key")).toBe("[[no.such.key]]");
  });

  it("catalog contains only the factions taking part", () => {
    const c = buildCatalog(data!, ["xf"]);
    expect(Object.keys(c.items).sort()).toEqual(["xf-bolt", "xf-bolt-rack", "xf-bomb", "xf-charm", "xf-crate", "xf-hay", "xf-mag", "xf-round", "xf-shard", "xf-shingle", "xf-vest"]);
    expect(Object.keys(c.vehicles)).toEqual(["xf-cart", "xf-wagon"]);
  });

  it("xf-cart loads and keeps its turn radius (wheeled, no pivot), and drives from orders to its crew", () => {
    const c = buildCatalog(data!, ["xf"]);
    const cart = c.vehicles["xf-cart"]!;
    expect(cart.class).toBe("wheeled");
    expect(cart.seats.some((s) => s.station === "commander")).toBe(false);
    expect(cart.stations[0]!.weapons[0]!.feedKind).toBe("single");
    const st = cart.drive.steering;
    if (st.kind !== "wheeled") throw new Error("wheeled steering expected");
    const minR = cart.body.wheelbaseM! / Math.tan(st.maxSteerRad);
    // Full lock at a walking pace for 40 s: the circle it drives is never tighter than the geometry allows.
    const surf = { rolling: 0.03, traction: 0.8, lateral: 0.7, capMps: Infinity, sinPitch: 0, cosPitch: 1 };
    let d = idleDrive(0, 0), x = 0, y = 0, h = 0, minX = 0, maxX = 0, minY = 0, maxY = 0;
    for (let i = 0; i < 60 * 40; i++) {
      d = stepDriveDynamics(cart, d, { speed: 3, yawRate: 0, curvature: 10 }, surf, 1 / 60, i).drive;
      h += d.yawRate / 60; x += Math.cos(h) * d.speed / 60; y += Math.sin(h) * d.speed / 60;
      if (i > 60 * 10) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    }
    expect(Math.abs(d.speed)).toBeGreaterThan(2);
    expect((maxX - minX) / 2).toBeGreaterThanOrEqual(minR * 0.98);
    expect((maxY - minY) / 2).toBeGreaterThanOrEqual(minR * 0.98);
    expect((maxX - minX) / 2).toBeLessThan(minR * 1.6);
    // And it drives from a move order to its crew unit (the lab's set-up).
    const { sim, vid, unit } = driveBattle(data!, "xf-cart", { surface: "grass" });
    submitOrder(sim, { tick: 0, issuer: "blue", target: unit, kind: "move", waypoints: [{ x: 400, y: 260, mode: "wdrive" }] });
    for (let i = 0; i < 60 * 60; i++) step(sim);
    const t = sim.state.transform.req(vid);
    expect(Math.hypot(t.x - 400, t.y - 260)).toBeLessThan(6);
  });
  it("cart-band: each porter gang rides its own cart (carriage from data), gets on and off on orders (M7.2)", () => {
    const built = buildForceWithVehicles(data!, { faction: "xf", template: "cart-band", seed: 5, keyPrefix: "x" });
    expect(built.vehicles.map((v) => v.type)).toEqual(["xf-cart", "xf-cart"]);
    const catalog = buildCatalog(data!, ["xf", "de"]);
    const gangs = built.unit.subunits.filter((u) => u.vehicleId === undefined);
    expect(gangs.map((g) => g.carrierId)).toEqual(built.vehicles.map((v) => v.vehicleId));
    const placements: Placement[] = [];
    const vehiclePlacements = built.vehicles.map((v, i) => ({ vehicleId: v.vehicleId, x: 200, y: 100 + i * 80, heading: 0 }));
    built.vehicles.forEach((v, i) => v.crewSeats.forEach((cs) => placements.push({ personId: cs.personId, x: 200, y: 100 + i * 80, heading: 0, seat: catalog.vehicles["xf-cart"]!.seats.findIndex((q) => q.id === cs.seat) })));
    gangs.forEach((g, gi) => g.members.forEach((m, k) => placements.push({ personId: m.personId, x: 175, y: 95 + gi * 80 + k * 4, heading: 0 })));
    const foe = buildForce(data!, { faction: "de", template: "demo-team", seed: 6, keyPrefix: "d" });
    const sim = createSim({
      map: flatMap("f", 400, 300), catalog, seed: 5, orders: [],
      forces: [
        { side: "blue", faction: "xf", units: [built.unit], placements, vehicles: built.vehicles.map((v) => newVehicleRecord(catalog, v.type, v.vehicleId)), vehiclePlacements },
        { side: "red", faction: "de", units: [foe], placements: allMembers(foe).map((m, k) => ({ personId: m.personId, x: 390, y: 280 - k * 3, heading: 0 })) },
      ],
      rules: { timeLimitSeconds: 300, commsModel: "simple", comms: { ...DEFAULT_COMMS }, physiologyModel: "simple", physiologyParams: {}, objectives: [] },
    });
    const band = [...sim.state.unit.entries()].find(([, u]) => u.side === "blue" && u.parent === null)![0];
    submitOrder(sim, { tick: 0, issuer: "blue", target: band, kind: "mount" });
    const ev: SimEvent[] = [];
    for (let i = 0; i < 60 * 60; i++) ev.push(...step(sim));
    const s = new Strings(data!);
    const radio = ev.find((e): e is Extract<SimEvent, { kind: "radio" }> => e.kind === "radio" && e.key === "radio.ack.mount");
    expect(s.t(radio!.key, radio!.params, "xf")).toMatch(/climbs on/);
    expect(ev.filter((e) => e.kind === "unit.mounted")).toHaveLength(2);
    for (const [uid, u] of sim.state.unit.entries()) {
      if (u.carrier === undefined || u.side !== "blue") continue;
      for (const m of u.members) expect(sim.state.soldier.req(m).mount?.vehicle, `${u.callsign}`).toBe(u.carrier);
      void uid;
    }
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: band, kind: "dismount" });
    for (let i = 0; i < 30 * 60; i++) ev.push(...step(sim));
    expect(ev.filter((e) => e.kind === "unit.dismounted")).toHaveLength(2);
  });
});
