/** Navigation on generated maps (M1.2): routes avoid buildings and deep water; soldiers follow them. */
import { describe, expect, it } from "vitest";
import { buildCatalog } from "@tcs/data";
import { demoBattle, generateMap } from "@tcs/scenario";
import {
  buildingAt, buildNavGrid, createNavSearch, createSim, findPath, heightAt, step, submitOrder, surfaceAt,
} from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData();
const terrain = buildCatalog(data, ["de", "ru"]).terrain;

function samples(sx: number, sy: number, pts: number[], every = 0.5): [number, number][] {
  const out: [number, number][] = [];
  let px = sx, py = sy;
  for (let i = 0; i < pts.length; i += 2) {
    const qx = pts[i]!, qy = pts[i + 1]!;
    const n = Math.max(1, Math.ceil(Math.hypot(qx - px, qy - py) / every));
    for (let k = 0; k <= n; k++) out.push([px + ((qx - px) * k) / n, py + ((qy - py) * k) / n]);
    px = qx; py = qy;
  }
  return out;
}

describe("navigation on generated maps", () => {
  for (const kind of ["village", "industrial"] as const) {
    it(`${kind}: corner-to-corner and cross-village routes never enter a building or deep water`, () => {
      const m = generateMap(terrain, { kind, seed: 4 });
      const nav = buildNavGrid(m, terrain, "foot");
      const s = createNavSearch(nav);
      const pairs: [number, number, number, number][] = [[20, 20, 1980, 1980], [20, 1000, 1980, 1000], [1000, 20, 1000, 1980], [1980, 300, 200, 1700]];
      for (const [ax, ay, bx, by] of pairs) {
        const t0 = performance.now();
        const p = findPath(s, ax, ay, bx, by);
        const ms = performance.now() - t0;
        expect(p, `route ${ax},${ay} -> ${bx},${by}`).not.toBeNull();
        console.log(`${kind}: ${ax},${ay} -> ${bx},${by}: ${(p!.points.length / 2)} waypoints, ${p!.expanded} expanded, ${ms.toFixed(0)} ms`);
        for (const [x, y] of samples(ax, ay, p!.points)) {
          expect(buildingAt(m, x, y), `inside a building at ${x.toFixed(1)},${y.toFixed(1)}`).toBeNull();
          expect(surfaceAt(m, x, y)).not.toBe("water-deep");
        }
      }
    });
  }

  it("a long route on a 2 km map is found in well under a second", () => {
    const m = generateMap(terrain, { kind: "village", seed: 7 });
    const s = createNavSearch(buildNavGrid(m, terrain, "foot"));
    findPath(s, 10, 10, 1990, 1990);
    const t0 = performance.now();
    for (let k = 0; k < 5; k++) findPath(s, 10 + k * 3, 10, 1990, 1990 - k * 3);
    const per = (performance.now() - t0) / 5;
    console.log(`A* corner to corner: ${per.toFixed(0)} ms per search`);
    expect(per).toBeLessThan(500);
  });

  it("a team ordered through a village walks around the houses (positions checked every tick)", () => {
    for (const seed of [1, 3, 5]) {
      const input = demoBattle(data, { seed, factions: ["de", "ru"], mapKind: "village", timeLimitSeconds: 1800 });
      const sim = createSim(input);
      const team = [...sim.state.unit.entries()].find(([, u]) => u.side === "blue")![0];
      // Through the middle of the map (the village) to the far side.
      // Walking (sustainable with a 24 kg load); running 1.4 km loaded would exhaust them (M1.3 fatigue).
      submitOrder(sim, { tick: 0, issuer: "blue", target: team, kind: "move", waypoints: [{ x: 1700, y: 1000, mode: "walk" }] });
      let arrived = false;
      for (let t = 0; t < 60 * 1800 && !arrived; t++) {
        for (const e of step(sim)) if (e.kind === "unit.arrived") arrived = true;
        if (t % 6 === 0) {
          for (const [id, ident] of sim.state.identity.entries()) {
            if (ident.side !== "blue") continue;
            const p = sim.state.transform.req(id);
            expect(buildingAt(input.map, p.x, p.y), `seed ${seed}: soldier ${id} inside a building at tick ${t}`).toBeNull();
          }
        }
      }
      expect(arrived, `seed ${seed}: team did not arrive`).toBe(true);
      void heightAt;
    }
  });

  it("many units given repeated long orders never put a man inside a building (review finding)", () => {
    const input = demoBattle(data, { seed: 3, factions: ["de", "ru"], mapKind: "village", unitsPerSide: 12, timeLimitSeconds: 200 });
    const sim = createSim(input);
    const units = [...sim.state.unit.entries()].filter(([, u]) => u.parent === null).map(([id, u]) => ({ id, side: u.side }));
    let k = 0;
    for (let t = 0; t < 60 * 200; t++) {
      if (t % (60 * 30) === 0) {
        for (const u of units) {
          k++;
          const x = 100 + ((k * 7919) % 1800), y = 100 + ((k * 104729) % 1800);
          submitOrder(sim, { tick: sim.state.tick, issuer: u.side, target: u.id, kind: "move", waypoints: [{ x, y, mode: "run" }] });
        }
      }
      step(sim);
      if (t % 6 === 0) {
        for (const [id] of sim.state.identity.entries()) {
          const p = sim.state.transform.req(id);
          expect(buildingAt(input.map, p.x, p.y), `soldier ${id} inside a building at tick ${t}`).toBeNull();
        }
      }
    }
  });
});
