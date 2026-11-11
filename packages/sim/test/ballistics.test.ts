import { describe, expect, it } from "vitest";
import {
  createSim, flatMap, hashState, launchProjectile, loadSim, saveSim, step, type MapDef, type Sim, type SimEvent,
} from "../src/index";
import { testCatalog, testInput } from "./helpers";

type Impact = Extract<SimEvent, { kind: "impact" }>;

function range(map: MapDef): Sim {
  const input = testInput(1, 600);
  input.map = map;
  // keep the two test teams out of the way (they stand at x = 10 and 190, y = 10..20)
  return createSim(input);
}

function wall(m: MapDef, x: number, material: string, thicknessM: number, heightM = 3): void {
  m.obstacles.push({ id: m.obstacles.length + 1, kind: "wall", points: [x, 0, x, m.heightM], heightM, thicknessM, material });
}

function run(sim: Sim, ticks: number): Impact[] {
  const out: Impact[] = [];
  for (let i = 0; i < ticks; i++) for (const e of step(sim)) if (e.kind === "impact") out.push(e);
  return out;
}

describe("projectile flight", () => {
  it("drag slows a 5.56 mm bullet to 600-700 m/s at 300 m and gravity drops it 0.6-0.9 m", () => {
    const sim = range(flatMap("r", 1000, 100, 4));
    launchProjectile(sim.ctx, sim.state, "ball", 5, 50, 30, 920, 0, 0, 0);
    const P = sim.state.projectiles;
    while (P.count > 0 && P.x[0]! < 305) step(sim);
    expect(P.count).toBe(1);
    const v = Math.hypot(P.vx[0]!, P.vy[0]!, P.vz[0]!);
    expect(v).toBeGreaterThan(600);
    expect(v).toBeLessThan(700);
    expect(30 - P.z[0]!).toBeGreaterThan(0.6);
    expect(30 - P.z[0]!).toBeLessThan(0.9);
  });

  it("hot air is thinner: the bullet keeps more speed (environment is read by ballistics)", () => {
    const vAt300 = (tempC: number) => {
      const input = testInput(1, 600);
      input.map = flatMap("r", 1000, 100, 4);
      input.environment = { timeOfDaySeconds: 0, light: 1, windX: 0, windY: 0, rain: 0, visibilityM: 1e4, temperatureC: tempC };
      const sim = createSim(input);
      launchProjectile(sim.ctx, sim.state, "ball", 5, 50, 30, 920, 0, 0, 0);
      const P = sim.state.projectiles;
      while (P.x[0]! < 305) step(sim);
      return P.vx[0]!;
    };
    expect(vAt300(40)).toBeGreaterThan(vAt300(-20) + 15);
  });

  it("falls to the ground and stops there, at ground height", () => {
    const m = flatMap("r", 1000, 100, 4);
    m.heights.fill(12);
    const sim = range(m);
    launchProjectile(sim.ctx, sim.state, "ball", 5, 50, 13.5, 300, 0, -60, 0); // steep: no ricochet
    const hits = run(sim, 120);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ surface: "ground", result: "stopped", material: "soil" });
    expect(hits[0]!.z).toBeCloseTo(12, 1);
    expect(hits[0]!.x).toBeGreaterThan(5);
    expect(sim.state.projectiles.count).toBe(0);
  });

  it("leaves the map or runs out of speed without an impact", () => {
    const sim = range(flatMap("r", 200, 200, 4));
    launchProjectile(sim.ctx, sim.state, "ball", 100, 100, 50, 900, 0, 300, 0);
    expect(run(sim, 60)).toHaveLength(0);
    expect(sim.state.projectiles.count).toBe(0);
  });
});

describe("walls: swept hits, penetration, ricochet, openings", () => {
  it("a fast bullet never skips a thin wall, wherever in the tick it meets it", () => {
    const m = flatMap("r", 400, 100, 4);
    wall(m, 200, "steel", 0.05); // 50 mm armour plate: always stops
    const sim = range(m);
    for (let k = 0; k < 60; k++) launchProjectile(sim.ctx, sim.state, "ball", 150 + k * 0.25, 30 + k * 0.5, 1.5, 920, 0, 0, 0);
    const hits = run(sim, 30);
    expect(hits).toHaveLength(60);
    for (const h of hits) {
      expect(h.x).toBeCloseTo(200, 6);
      expect(h).toMatchObject({ surface: "obstacle", result: "stopped", material: "steel" });
    }
  });

  /** Fire one bullet at a wall 50 m away; report what happened and its speed just after the wall. */
  const shoot = (material: string, thicknessM: number, vx = 900, vy = 0) => {
    const m = flatMap("r", 400, 400, 4);
    wall(m, 100, material, thicknessM);
    const sim = range(m);
    launchProjectile(sim.ctx, sim.state, "ball", 50, 50, 1.5, vx, vy, 0, 0);
    const P = sim.state.projectiles;
    for (let i = 0; i < 60; i++) {
      const hit = step(sim).find((e): e is Impact => e.kind === "impact" && e.surface === "obstacle" && e.result !== "ricochet");
      if (hit) return { result: hit.result, speed: P.count > 0 ? Math.hypot(P.vx[0]!, P.vy[0]!, P.vz[0]!) : 0 };
    }
    return { result: "none", speed: 0 };
  };

  it("penetrates what a rifle bullet should and is stopped by what it should not", () => {
    const fence = shoot("wood", 0.04);
    expect(fence.result).toBe("penetrated");
    expect(fence.speed).toBeGreaterThan(800); // little energy lost in 4 cm of wood
    expect(shoot("steel", 0.003).result).toBe("penetrated");
    expect(shoot("steel", 0.02).result).toBe("stopped");
    expect(shoot("brick", 0.25).result).toBe("stopped");
    const log = shoot("wood", 0.4);
    expect(log.result).toBe("penetrated");
    expect(log.speed).toBeLessThan(fence.speed - 100); // thicker wood takes more energy
  });

  it("a wall struck at an angle is thicker along the bullet's path", () => {
    expect(shoot("wood", 0.6).result).toBe("penetrated");
    expect(shoot("wood", 0.6, 477, 763).result).toBe("stopped"); // 58 degrees from square-on: nearly twice the thickness
  });

  it("ricochets off hard surfaces only at shallow angles", () => {
    const count = (vy: number) => {
      const m = flatMap("r", 400, 400, 4);
      wall(m, 100, "steel", 0.05);
      const sim = range(m);
      for (let k = 0; k < 200; k++) launchProjectile(sim.ctx, sim.state, "ball", 95, 20 + k * 0.01, 1.5, 100, vy, 0, 0);
      const hits = run(sim, 60).filter((h) => h.surface === "obstacle");
      return hits.filter((h) => h.result === "ricochet").length / 200;
    };
    expect(count(0)).toBe(0); // square on
    expect(count(900)).toBeGreaterThan(0.4); // ~6 degrees from the surface
  });

  it("passes through a window and is stopped by the wall beside it", () => {
    const m = flatMap("r", 200, 200, 4);
    m.buildings.push({
      id: 1, kind: "house", footprint: [100, 80, 110, 80, 110, 90, 100, 90], storeys: 1, storeyHeightM: 2.8,
      wallMaterial: "brick", wallThicknessM: 0.3, roofColour: "#8c4a3b",
      openings: [{ wall: 3, offsetM: 5, widthM: 1.2, kind: "window", sillM: 0.9, headM: 2.1 }], // west wall (100,90)->(100,80)
    });
    const sim = range(m);
    launchProjectile(sim.ctx, sim.state, "ball", 60, 85, 1.5, 900, 0, 0, 1); // through the window (offset 5 m = y 85)
    launchProjectile(sim.ctx, sim.state, "ball", 60, 82, 1.5, 900, 0, 0, 2); // beside it
    launchProjectile(sim.ctx, sim.state, "ball", 60, 85, 0.5, 900, 0, 0, 3); // below the sill
    const hits = run(sim, 10).filter((h) => h.surface === "building");
    const byOwner = (o: number) => hits.filter((h) => h.owner === o);
    expect(byOwner(1).map((h) => h.x)).toEqual([expect.closeTo(110, 4)]); // first wall it meets is the far one
    expect(byOwner(2)[0]!.x).toBeCloseTo(100, 4);
    expect(byOwner(3)[0]!.x).toBeCloseTo(100, 4);
  });
});

describe("projectiles are battle state", () => {
  it("pool grows beyond its first size and removal keeps the others intact", () => {
    const sim = range(flatMap("r", 2000, 2000, 4));
    for (let k = 0; k < 3000; k++) launchProjectile(sim.ctx, sim.state, "ball", 1000, 1000, 50 + (k % 50), 600, (k % 7) * 30, 100, k);
    expect(sim.state.projectiles.count).toBe(3000);
    for (let i = 0; i < 30; i++) step(sim);
    expect(sim.state.projectiles.count).toBe(3000);
    expect(new Set(Array.from(sim.state.projectiles.owner.subarray(0, 3000))).size).toBe(3000);
  });

  it("a save with bullets in flight continues identically", () => {
    const build = () => {
      const m = flatMap("r", 600, 200, 4);
      wall(m, 300, "wood", 0.1);
      wall(m, 400, "steel", 0.05);
      const input = testInput(5, 600);
      input.map = m;
      return input;
    };
    const input = build();
    const a = createSim(input);
    for (let k = 0; k < 400; k++) launchProjectile(a.ctx, a.state, "ball", 50, 20 + k * 0.4, 1.2 + (k % 5) * 0.2, 850, (k % 9) * 40 - 160, (k % 4) * 3 - 2, k);
    for (let i = 0; i < 12; i++) step(a);
    expect(a.state.projectiles.count).toBeGreaterThan(50);
    const b = loadSim(build(), JSON.parse(JSON.stringify(saveSim(a))));
    expect(hashState(b.state)).toBe(hashState(a.state));
    for (let i = 0; i < 90; i++) { step(a); step(b); }
    expect(hashState(b.state)).toBe(hashState(a.state));
    void testCatalog;
  });
});
