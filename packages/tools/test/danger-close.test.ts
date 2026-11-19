/**
 * Balance pass 4 (owner 2026-11-19, decision H): danger close for bursting rounds. A vehicle gunner sees his own men
 * on foot in his line (his seat height is no other floor); a station's bursting round (cannon HE, an automatic
 * grenade launcher) is not fired at a point an own man is within its danger radius and spread of, on any side; the
 * danger radius comes from the round's fragments (ballistics.json `fragments.danger`).
 */
import { describe, expect, it } from "vitest";
import {
  createSim, dangerRadiusM, friendInLine, heightAt, isOffMap, muzzleWorld, setStationTask, sight, stationDangerM, stationOperator, step,
  type EntityId, type Sim,
} from "@tcs/sim";
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

/** Shots from the hull's stations in `seconds`. */
function shots(sim: Sim, vid: EntityId, seconds: number): number {
  let n = 0;
  for (let i = 0; i < seconds * 60; i++) for (const e of step(sim)) if (e.kind === "shot.fired" && e.vehicle === vid) n++;
  return n;
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
  });

  it("a station holds its high explosive while an own man is within the danger radius of the point, on any side; fires once he is clear", () => {
    const fire = (manOff: number): number => {
      const { sim, vid, man, wi, fi } = setup();
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
      // The man beside the point, across the line (not in it): `manOff` m off.
      const mt = s.transform.req(man);
      mt.x = px - Math.sin(ht.heading) * manOff; mt.y = py + Math.cos(ht.heading) * manOff;
      setStationTask(sim.ctx, s, vid, 0, px, py, 0, wi, fi, undefined, false);
      return shots(sim, vid, 12);
    };
    expect(fire(6)).toBe(0);
    expect(fire(400)).toBeGreaterThan(0);
  });
});
