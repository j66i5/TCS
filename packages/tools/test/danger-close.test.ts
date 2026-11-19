/**
 * Balance pass 4 (owner 2026-11-19, decision H): danger close for bursting rounds. A vehicle gunner sees his own men
 * on foot in his line (his seat height is no other floor); a station's bursting round (cannon HE, an automatic
 * grenade launcher) is not fired at a point an own man is within its danger radius and spread of, on any side; the
 * danger radius comes from the round's fragments (ballistics.json `fragments.danger`).
 */
import { describe, expect, it } from "vitest";
import {
  aglDangerM, createSim, dangerRadiusM, friendInLine, submitOrder, heightAt, isOffMap, muzzleWorld, setStationTask, sight, stationDangerM, stationOperator, step,
  type EntityId, type Sim,
} from "@tcs/sim";
import { aglSetup } from "../src/labs/agl";
import { getScenario, loadData } from "../src/scenarios";

const data = loadData();

/** The defence's first crewed hull with a high-explosive cannon feed, its gunner, and a defender on foot. */
function setup(): { sim: Sim; vid: EntityId; op: EntityId; man: EntityId; wi: number; fi: number } {
  const sim = createSim(getScenario("platoon-vehicles").build(data, 1, 120));
  const s = sim.state, cat = sim.ctx.catalog;
  for (const [vid, v] of s.vehicle.entries()) {
    if (v.side !== "red" || isOffMap(v)) continue;
    const def = cat.vehicles[v.def]!;
    const op = stationOperator(s, v, def, 0);
    if (op === null) continue;
    const sn = def.stations[0]!;
    for (let wi = 0; wi < sn.weapons.length; wi++) for (let fi = 0; fi < sn.weapons[wi]!.feeds.length; fi++) {
      const round = cat.items[sn.weapons[wi]!.feeds[fi]!.item]?.chargeItem;
      if (round === undefined || cat.ammo[round]?.explosive === undefined || cat.ammo[round]?.guided !== undefined) continue;
      // mounted: ok a defender on foot (the defence's men start on foot)
      const man = [...s.identity.entries()].find(([id, i]) => i.side === "red" && s.soldier.get(id)?.mount === undefined)![0];
      return { sim, vid, op, man, wi, fi };
    }
  }
  throw new Error("no red hull with a high-explosive cannon feed");
}

describe("danger close for bursting rounds (balance pass 4)", () => {
  it("the danger radius comes from the round's fragments: about 8 m for 30 mm HE, 15-18 m for grenades, none for ball", () => {
    const ctx = createSim(getScenario("platoon-vehicles").build(data, 1, 60)).ctx;
    expect(dangerRadiusM(ctx, "de-30x173-he")).toBeGreaterThan(7);
    expect(dangerRadiusM(ctx, "de-30x173-he")).toBeLessThan(9);
    expect(dangerRadiusM(ctx, "de-40mm-he")).toBeGreaterThan(14);
    expect(dangerRadiusM(ctx, "ru-vog30")).toBeGreaterThan(dangerRadiusM(ctx, "de-40mm-he"));
    expect(dangerRadiusM(ctx, "ru-125-3of26")).toBeGreaterThan(30);
    expect(dangerRadiusM(ctx, "de-556-dm11")).toBe(0);
  });

  it("a vehicle gunner sees an own man on foot in his line (before, his seat height counted as another floor)", () => {
    const { sim, op, man } = setup();
    const s = sim.state;
    const g = s.transform.req(op), m = s.transform.req(man);
    // The man 60 m in front of the gunner (along his hull's front, away from the defence), the point 300 m on; and
    // the same point 80 m to the side (the other defenders far behind).
    const h = s.transform.req(s.soldier.req(op).mount!.vehicle).heading, ux = Math.cos(h), uy = Math.sin(h);
    // mounted: ok the defence's men on foot
    for (const [id, i] of s.identity.entries()) if (i.side === "red" && id !== man && s.soldier.get(id)?.mount === undefined) { const t = s.transform.req(id); t.x = g.x - ux * 400; t.y = g.y - uy * 400; }
    expect(s.transform.req(op).z).toBeGreaterThan(1); // (seated above the ground)
    m.x = g.x + ux * 60; m.y = g.y + uy * 60;
    expect(friendInLine(sim.ctx, s, op, g.x + ux * 300, g.y + uy * 300)).toBe(true);
    expect(friendInLine(sim.ctx, s, op, g.x + ux * 300 - uy * 80, g.y + uy * 300 + ux * 80)).toBe(false);
    // Review fix (H1): a line passing well over his head does not count him (lying 60 m out, the line 8 m up); a man
    // standing near the muzzle, or past the point, still does.
    const px = g.x + ux * 300, py = g.y + uy * 300;
    const over = { mz: heightAt(sim.ctx.map, g.x, g.y) + 8, tz: heightAt(sim.ctx.map, px, py) + 8 }; // ground: ok (test heights)
    s.soldier.req(man).posture = "prone";
    m.z = 0;
    expect(friendInLine(sim.ctx, s, op, px, py, 0, undefined, over)).toBe(false);
    m.x = g.x + ux * 10; m.y = g.y + uy * 10;
    expect(friendInLine(sim.ctx, s, op, px, py, 0, undefined, over)).toBe(true);
    m.x = g.x + ux * 330; m.y = g.y + uy * 330;
    expect(friendInLine(sim.ctx, s, op, px, py, 60, undefined, over)).toBe(true);
    // A line only 1 m over him at 60 m (less than overClearM 1 m + 3 mrad): he counts.
    m.x = g.x + ux * 60; m.y = g.y + uy * 60;
    const low = { mz: heightAt(sim.ctx.map, m.x, m.y) + 1.4, tz: heightAt(sim.ctx.map, m.x, m.y) + 1.4 }; // ground: ok (test heights)
    expect(friendInLine(sim.ctx, s, op, px, py, 0, undefined, low)).toBe(true);
  });

  it("a station holds its high explosive while an own man is within the danger radius of the point, on any side; fires once he is clear", () => {
    const fire = (manOff: number | "outsideCone"): { shots: number; why: string[]; inLine: boolean } => {
      const { sim, vid, op, man, wi, fi } = setup();
      const s = sim.state, ht = s.transform.req(vid);
      const def = sim.ctx.catalog.vehicles[s.vehicle.req(vid).def]!;
      // A point ahead of the hull (its post faces the approach) its gun sees: the first clear one out from 200 m.
      const [mx, my, mz] = muzzleWorld(sim.ctx, def, 0, wi, ht.x, ht.y, ht.heading, s.vehicle.req(vid).stations[0]!.azimuth);
      let px = 0, py = 0, r = 0;
      for (const [rr, a] of [200, 300, 400, 500].flatMap((x) => [-0.3, -0.15, 0, 0.15, 0.3].map((b) => [x, b] as const))) {
        const x = ht.x + Math.cos(ht.heading + a) * rr, y = ht.y + Math.sin(ht.heading + a) * rr;
        // ground: ok (a point on open ground)
        if (sight(sim.ctx, mx, my, mz, x, y, heightAt(sim.ctx.map, x, y) + 0.6, vid, -1).blockedBy === null) { px = x; py = y; r = rr; break; }
      }
      expect(r).toBeGreaterThan(0);
      const dz = stationDangerM(sim.ctx, def, 0, wi, fi, r);
      expect(dz).toBeGreaterThan(8);
      // The man beside the point, across the line: `manOff` m off; "outsideCone": half-way between the edge of the
      // safety cone there and the danger radius (review fix L2: only the danger-close check can hold the burst).
      const L = Math.hypot(px - ht.x, py - ht.y), ux = (px - ht.x) / L, uy = (py - ht.y) / L;
      const cone = 0.7 + L * Math.sin((sim.ctx.catalog.shooting.fire.safetyConeDeg * Math.PI) / 180);
      if (manOff === "outsideCone") expect(dz - cone).toBeGreaterThan(2);
      const off = manOff === "outsideCone" ? (cone + dz) / 2 : manOff;
      const mt = s.transform.req(man);
      mt.x = px - uy * off; mt.y = py + ux * off;
      const inLine = friendInLine(sim.ctx, s, op, px, py, 60);
      setStationTask(sim.ctx, s, vid, 0, px, py, 0, wi, fi, undefined, false);
      const why: string[] = [];
      let n = 0;
      for (let i = 0; i < 12 * 60; i++) for (const e of step(sim)) {
        if (e.kind === "shot.fired" && e.vehicle === vid) n++;
        if (e.kind === "vehicle.decision" && e.vehicle === vid) why.push(...e.keys);
      }
      return { shots: n, why, inLine };
    };
    expect(fire(6).shots).toBe(0);
    const cone = fire("outsideCone");
    expect(cone.inLine).toBe(false);
    expect(cone.shots).toBe(0);
    // (An ordered task held: the player is told why, once.)
    expect(cone.why.filter((k) => k === "why.hold.dangerClose")).toHaveLength(1);
    expect(fire(400).shots).toBeGreaterThan(0);
  });

  it("an automatic grenade launcher team holds its ordered burst while an own man is within the round's danger radius of the point, beside the line", () => {
    const fire = (manAt: { x: number; y: number } | null): number => {
      const sim = createSim(aglSetup(data, "ru", 800, 4));
      const s = sim.state;
      const tid = [...s.unit.entries()].find(([, u]) => u.missileTeam?.kind === "agl")![0];
      for (const [uid, u] of s.unit.entries()) if (uid !== tid) u.fireRule = "hold";
      const team = new Set(s.unit.req(tid).members);
      // mounted: ok a red man on foot outside the team
      const man = [...s.identity.entries()].find(([id, i]) => i.side === "red" && !team.has(id) && s.soldier.get(id)?.mount === undefined)![0];
      const mt = s.transform.req(man);
      if (manAt) { mt.x = manAt.x; mt.y = manAt.y; } else { mt.x = 30; mt.y = 1150; }
      submitOrder(sim, { tick: s.tick, issuer: "red", target: tid, kind: "rules", fire: "hold" });
      submitOrder(sim, { tick: s.tick, issuer: "red", target: tid, kind: "fire", x: 300, y: 600 });
      let n = 0;
      for (let i = 0; i < 90 * 60; i++) for (const e of step(sim)) if (e.kind === "shot.fired" && sim.ctx.catalog.weapons[e.weapon]?.type === "grenade-machine-gun") n++;
      return n;
    };
    // The team at (200, 600), the point 100 m out: the safety cone there is under 8 m wide each side, the round's
    // danger radius and range error over 15 m.
    const ctx = createSim(aglSetup(data, "ru", 800, 4)).ctx;
    expect(aglDangerM(ctx, 100, "ru-vog30")).toBeGreaterThan(15);
    expect(fire(null)).toBeGreaterThan(0);
    expect(fire({ x: 300, y: 612 })).toBe(0);
    expect(fire({ x: 300, y: 1000 })).toBeGreaterThan(0);
  });
});
