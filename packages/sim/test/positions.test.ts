/** M11 hold battle: dug fighting positions (positions.ts): digging, the rim against rounds, fragments and blast. */
import { describe, expect, it } from "vitest";
import {
  ammoIndexOf, createSim, detonate, EventSink, hashState, launchProjectile, loadSim, positionAt, rimHeight, rimStops, saveSim, secondsToTicks, step,
  type BattleInput, type Catalog, type Sim, type SimEvent,
} from "../src/index";
import { armedInput, testCatalog } from "./helpers";

const FP = { halfWidthM: 0.5, depthM: 1.2, exposedM: { standing: 0.3, crouching: 0.2, prone: 0.1 }, spacingM: 1.5 };
const catalog: Catalog = { ...testCatalog, ballistics: { ...testCatalog.ballistics, fightingPosition: FP } };

function input(): BattleInput {
  const i = armedInput(1, 600);
  i.catalog = catalog;
  i.rules.physiologyModel = "simple";
  return i;
}
const redMen = (sim: Sim) => [...sim.state.unit.values()].find((u) => u.side === "red")!.members;
function run(sim: Sim, seconds: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < secondsToTicks(seconds); i++) out.push(...step(sim));
  return out;
}
/** A position dug under each of these men by hand. */
function dig(sim: Sim, men: readonly number[]): void {
  for (const m of men) { const t = sim.state.transform.req(m); (sim.state.terrain.positions ??= []).push({ x: t.x, y: t.y, side: "red", tick: 0 }); }
}

describe("the rim (geometry)", () => {
  it("stops what comes in low over the far side, never what strikes above the rim or starts inside the hole", () => {
    // A man at (0, 0) on flat ground, rim 0.9 m.
    expect(rimStops(0.5, 0.9, 0, 0, 0, -100, 0, 0.5, 0.5)).toBe(true); // flat, low: into the earth
    expect(rimStops(0.5, 0.9, 0, 0, 0, -100, 0, 1.0, 1.0)).toBe(false); // above the rim: his head
    expect(rimStops(0.5, 0.9, 0, 0, 0, -3, 0, 4, 0.5)).toBe(false); // steeply down from close by: over the rim
    expect(rimStops(0.5, 0.9, 0, 0, 0, -0.3, 0, 0.3, 0.3)).toBe(false); // a burst in the hole
    expect(rimStops(0.5, 0, 0, 0, 0, -100, 0, 0.5, 0.5)).toBe(false); // no position
  });
});

describe("fighting positions", () => {
  it("a crouching man in a position is hit only above the rim; out of one, all over", () => {
    const count = (inHole: boolean) => {
      const sim = createSim(input());
      const target = redMen(sim)[0]!;
      sim.state.soldier.req(target).posture = "crouching";
      if (inHole) dig(sim, [target]);
      expect(rimHeight(sim.ctx, sim.state, target)).toBeCloseTo(inHole ? 0.9 : 0, 6);
      const b = sim.state.transform.req(target);
      for (let i = 0; i < 21; i++) for (let j = 0; j < 13; j++) launchProjectile(sim.ctx, sim.state, "ball", b.x - 150, b.y - 1 + i * 0.1, 0.25 + j * 0.1, 900, 0, 0, 0);
      const ev = run(sim, 1);
      const hits = ev.filter((e): e is Extract<SimEvent, { kind: "hit" }> => e.kind === "hit");
      const soil = ev.filter((e) => e.kind === "impact" && e.material === "soil" && e.surface === "ground" && Math.abs(e.x - b.x) < 1).length;
      return { hits, soil };
    };
    const open = count(false), dug = count(true);
    expect(open.hits.length).toBeGreaterThan(20);
    expect(dug.hits.length).toBeGreaterThan(0);
    expect(dug.hits.length).toBeLessThan(open.hits.length / 3);
    for (const h of dug.hits) expect(["head", "neck", "armL", "armR"]).toContain(h.zone);
    expect(dug.soil).toBeGreaterThan(10);
  });

  it("a grenade bursting a few metres off: in a position he is not hurt by its blast or fragments", () => {
    const wounded = (inHole: boolean) => {
      const sim = createSim(input());
      const target = redMen(sim)[0]!;
      sim.state.soldier.req(target).posture = "prone";
      if (inHole) dig(sim, [target]);
      const b = sim.state.transform.req(target);
      let n = 0;
      for (let k = 0; k < 6; k++) {
        detonate(sim.ctx, sim.state, new EventSink(), b.x - 4, b.y + (k - 2.5) * 0.7, 0.05, ammoIndexOf(sim.ctx.catalog, "bomb"), 0);
        n += run(sim, 0.5).filter((e) => e.kind === "wound" && e.soldier === target).length;
      }
      return n;
    };
    expect(wounded(false)).toBeGreaterThan(0);
    expect(wounded(true)).toBe(0);
  });

  it("a prepared side digs in where its men halt within the window, not after; positions save and load", () => {
    const build = () => { const i = input(); i.rules.prepared = [{ side: "red", fromS: 1, untilS: 2 }]; return i; };
    const sim = createSim(build());
    run(sim, 0.5);
    expect(sim.state.terrain.positions ?? []).toHaveLength(0);
    run(sim, 2);
    const ps = sim.state.terrain.positions!;
    expect(ps).toHaveLength(redMen(sim).length);
    expect(ps.every((p) => p.side === "red")).toBe(true);
    for (const m of redMen(sim)) { const t = sim.state.transform.req(m); expect(positionAt(sim.ctx, sim.state, t.x, t.y)).toBeGreaterThanOrEqual(0); }
    // After the window, a man who moves on digs no new one.
    const m0 = redMen(sim)[0]!;
    sim.state.transform.req(m0).x -= 20;
    run(sim, 2);
    expect(sim.state.terrain.positions).toHaveLength(redMen(sim).length);
    expect(rimHeight(sim.ctx, sim.state, m0)).toBe(0);
    const copy = loadSim(build(), JSON.parse(JSON.stringify(saveSim(sim))));
    expect(copy.state.terrain.positions).toEqual(sim.state.terrain.positions);
    run(sim, 1); run(copy, 1);
    expect(hashState(copy.state)).toBe(hashState(sim.state));
  });

  it("balance pass 2: a hasty window (`rules.prepared[].depthM`) digs holes at most that deep; the rim of a prone man is the same", () => {
    const build = () => { const i = input(); i.rules.prepared = [{ side: "red", fromS: 1, untilS: 2, depthM: 0.6 }]; return i; };
    const sim = createSim(build());
    run(sim, 2.5);
    const ps = sim.state.terrain.positions!;
    expect(ps.length).toBeGreaterThan(0);
    expect(ps.every((p) => p.depthM === 0.6)).toBe(true);
    const m = redMen(sim)[0]!, s = sim.state.soldier.req(m);
    s.posture = "crouching";
    expect(rimHeight(sim.ctx, sim.state, m)).toBeCloseTo(0.6, 6); // (1.2 m deep: 0.9)
    s.posture = "prone";
    const prone = rimHeight(sim.ctx, sim.state, m);
    expect(prone).toBeGreaterThan(0);
    expect(prone).toBeLessThan(0.6);
    // A hole dug by hand without a depth is the data's (1.2 m).
    (sim.state.terrain.positions ??= []).splice(0, ps.length);
    dig(sim, [m]);
    s.posture = "crouching";
    expect(rimHeight(sim.ctx, sim.state, m)).toBeCloseTo(0.9, 6);
  });

  it("without positions nothing changes: no position, no rim, no digging", () => {
    const sim = createSim(input());
    run(sim, 3);
    expect(sim.state.terrain.positions).toBeUndefined();
    expect(rimHeight(sim.ctx, sim.state, redMen(sim)[0]!)).toBe(0);
  });
});
