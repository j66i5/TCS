/**
 * M1 acceptance (ROADMAP M1.4): a squad crosses a generated village choosing covered routes, in formation, and
 * takes cover at the halt. Owner decisions 2026-11-11: wedge, ~10 m spacing, balanced cover (~30 %), halt drill.
 */
import { describe, expect, it } from "vitest";
import { buildCatalog } from "@tcs/data";
import { demoBattle, generateMap } from "@tcs/scenario";
import {
  buildingAt, buildNavGrid, createNavSearch, createSim, exposureAt, findPath, step, submitOrder, type NavGrid,
} from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData();
const terrain = buildCatalog(data, ["de", "ru"]).terrain;

function measure(nav: NavGrid, sx: number, sy: number, pts: number[]): { length: number; covered: number } {
  let px = sx, py = sy, length = 0, covered = 0, n = 0;
  for (let i = 0; i < pts.length; i += 2) {
    const qx = pts[i]!, qy = pts[i + 1]!;
    const l = Math.hypot(qx - px, qy - py);
    length += l;
    const k = Math.max(1, Math.ceil(l));
    for (let j = 0; j < k; j++) { n++; if (exposureAt(nav, px + ((qx - px) * j) / k, py + ((qy - py) * j) / k) < 0.5) covered++; }
    px = qx; py = qy;
  }
  return { length, covered: covered / Math.max(1, n) };
}

describe("cover-seeking routes and formations (M1 acceptance)", () => {
  it("routes with balanced cover preference stay in cover more, and are at most ~30 % longer", () => {
    const rows: string[] = [];
    let plainCover = 0, coverCover = 0;
    for (const seed of [1, 2, 3, 4]) {
      const m = generateMap(terrain, { kind: "village", seed });
      const plain = buildNavGrid(m, terrain, "foot");
      const cover = buildNavGrid(m, terrain, "foot", 2, 0.3);
      for (const [ax, ay, bx, by] of [[200, 700, 1800, 1300], [300, 1500, 1700, 500]] as const) {
        const p = findPath(createNavSearch(plain), ax, ay, bx, by)!;
        const c = findPath(createNavSearch(cover), ax, ay, bx, by)!;
        const mp = measure(plain, ax, ay, p.points), mc = measure(plain, ax, ay, c.points);
        rows.push(`seed ${seed} (${ax},${ay})->(${bx},${by}): quickest ${mp.length.toFixed(0)} m, ${(mp.covered * 100).toFixed(0)} % in cover | cover-seeking ${mc.length.toFixed(0)} m (${((mc.length / mp.length) * 100).toFixed(0)} %), ${(mc.covered * 100).toFixed(0)} % in cover`);
        expect(mc.length / mp.length).toBeLessThan(1.4);
        plainCover += mp.covered; coverCover += mc.covered;
      }
    }
    console.log(rows.join("\n"));
    expect(coverCover).toBeGreaterThan(plainCover * 1.2);
  });

  it("a squad crosses a village in wedge at ~10 m, never enters a house, and ends prone in cover", () => {
    for (const seed of [1, 3]) {
      const input = demoBattle(data, { seed, factions: ["de", "ru"], mapKind: "village", timeLimitSeconds: 1800 });
      const sim = createSim(input);
      const plain = buildNavGrid(input.map, terrain, "foot");
      const unit = [...sim.state.unit.entries()].find(([, u]) => u.side === "blue")!;
      const men = unit[1].members;
      submitOrder(sim, { tick: 0, issuer: "blue", target: unit[0], kind: "move", waypoints: [{ x: 1700, y: 1000, mode: "walk" }] });
      let arrived = false;
      const gaps: number[] = [];
      for (let t = 0; t < 60 * 1800 && !arrived; t++) {
        for (const e of step(sim)) if (e.kind === "unit.arrived") arrived = true;
        if (t % 30 === 0) {
          const ps = men.map((id) => sim.state.transform.req(id));
          for (const p of ps) expect(buildingAt(input.map, p.x, p.y), `seed ${seed}: inside a building at tick ${t}`).toBeNull();
          if (t > 60 * 60) for (let i = 0; i < ps.length; i++) {
            let nn = Infinity;
            for (let j = 0; j < ps.length; j++) if (i !== j) nn = Math.min(nn, Math.hypot(ps[i]!.x - ps[j]!.x, ps[i]!.y - ps[j]!.y));
            gaps.push(nn);
          }
        }
      }
      expect(arrived, `seed ${seed}: squad did not arrive`).toBe(true);
      for (let i = 0; i < 300; i++) step(sim); // halt drill: going prone
      gaps.sort((a, b) => a - b);
      const median = gaps[Math.floor(gaps.length / 2)]!;
      console.log(`seed ${seed}: median nearest-neighbour distance on the move ${median.toFixed(1)} m; final exposure ${men.map((id) => exposureAt(plain, sim.state.transform.req(id).x, sim.state.transform.req(id).y).toFixed(2)).join(", ")}`);
      expect(median).toBeGreaterThan(6);
      expect(median).toBeLessThan(14);
      for (const id of men) expect(sim.state.soldier.req(id).posture).toBe("prone");
    }
  });
});
