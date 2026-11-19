/**
 * MOUNTED-MAN INVARIANTS AT RUN TIME (plan §6 table, §15 M7.2; the source scan A7 is in architecture.test.ts).
 *
 * Whole battles with vehicles, men riding in and getting out, checked every tick: a man aboard sits in his seat
 * (his position is the seat's), never walks (no waypoints: the AI never makes him walk), never fires, reloads or
 * throws (no fire task, no such action), is never listed in what the enemy knows, and never blocks a comrade's
 * line of fire.
 */
import { describe, expect, it } from "vitest";
import { commanderController } from "@tcs/ai";
import { createSim, friendInLine, hypot2, isOffMap, isOutside, seatWorld, sideKnowledge, step, submitOrder, type EntityId, type Sim } from "@tcs/sim";
import { getScenario, loadData } from "../src/scenarios";

const data = loadData();
const FORBIDDEN = new Set(["reload", "clearStoppage", "grenade", "transferItems", "takeFromVehicle", "mount", "loadCasualty"]);

function check(sim: Sim, label: string): number {
  const s = sim.state;
  let aboard = 0;
  // mounted: ok the test looks at every man to find those aboard
  for (const [id, ss] of s.soldier.entries()) {
    const m = ss.mount;
    if (m === undefined) continue;
    const v = s.vehicle.req(m.vehicle);
    if (isOffMap(v)) continue; // (an off-map ambulance's crew, M10.6a: parked off the map, not in a seat's place)
    aboard++;
    expect(v.seats[m.seat], `${label} seat of ${id}`).toBe(id);
    const def = sim.ctx.catalog.vehicles[v.def]!, t = s.transform.req(m.vehicle), mt = s.transform.req(id);
    const [x, y] = seatWorld(def, m.seat, t.x, t.y, t.heading);
    // (M11.7a: a crewman repairing beside his hull keeps his seat but stands at the damage, like a man on foot.)
    if (!isOutside(s, id)) expect(hypot2(mt.x - x, mt.y - y), `${label} ${id} in his seat`).toBeLessThan(1e-6);
    expect(s.mover.get(id)?.waypoints.length ?? 0, `${label} ${id} walks`).toBe(0);
    expect(s.fire.has(id), `${label} ${id} fire task`).toBe(false);
    const a = s.action.get(id);
    expect(a !== undefined && FORBIDDEN.has(a.kind), `${label} ${id} action ${a?.kind}`).toBe(false);
  }
  return aboard;
}

function noneKnown(sim: Sim, label: string): void {
  for (const side of sim.state.sides) for (const k of sideKnowledge(sim.ctx, sim.state, side.id)) {
    if (isOutside(sim.state, k.target)) continue; // (outside his hull, M9.3a/M11.7a: seen like a man on foot)
    expect(sim.state.soldier.get(k.target)?.mount, `${label} ${side.id} knows ${k.target} aboard`).toBeUndefined();
  }
}

describe("mounted-man invariants at run time (M7.2)", () => {
  // (Balance pass 4 review: the defending Pumas fire over their own infantry now; in platoon-ru-vehicles s2 they kill
  // the leading T-90M at 97 s and the BMP-2s move off at about 150 s, dismounting from 180 s: 240 s there.)
  for (const [name, seed, secs] of [["platoon-vehicles", 1, 180], ["platoon-ru-vehicles", 2, 240]] as const) {
    it(`${name} s${seed}: men aboard sit, ride, never walk, fire, reload or throw, and are never known to the enemy`, () => {
      const sc = getScenario(name);
      const input = sc.build(data, seed, secs);
      const sim = createSim(input);
      const ctrls = [commanderController("blue", input), commanderController("red", input)];
      let maxAboard = 0, gotOut = 0, rode = false;
      for (let i = 0; i < secs * 60 && !sim.state.ended; i++) {
        for (const c of ctrls) for (const o of c.think(sim.state, sim.state.tick)) submitOrder(sim, o);
        const ev = step(sim);
        gotOut += ev.filter((e) => e.kind === "soldier.dismounted").length;
        const n = check(sim, `${name} t=${sim.state.tick}`);
        maxAboard = Math.max(maxAboard, n);
        if (sim.state.tick % 60 === 0) noneKnown(sim, `${name} t=${sim.state.tick}`);
        if (!rode && [...sim.state.vehicle.values()].some((v) => Math.abs(v.drive.speed) > 3 && v.seats.some((x, k) => x !== null && sim.ctx.catalog.vehicles[v.def]!.seats[k]!.station === "passenger"))) rode = true;
      }
      expect(rode).toBe(true);
      expect(maxAboard).toBeGreaterThan(40);
      // (M7.5e defend: with the German defence at windows, platoon-ru-vehicles s2 loses two BMPs with men aboard in
      // the first minute; 22 men get out by 180 s, 31 before. Still plenty to check the invariants on.)
      expect(gotOut).toBeGreaterThan(20);
    }, 120_000);
  }

  it("a hull of his side, and the men aboard it, block a comrade's line of fire; wide of it they do not (balance pass 3)", () => {
    const sc = getScenario("platoon-vehicles");
    let through = 0, wide = 0;
    // (Balance pass 4: the defence's hulls start on their posts, spread out: two seeds for enough pairs.)
    for (const seed of [1, 2]) {
    const sim = createSim(sc.build(data, seed, 60));
    const s = sim.state;
    // Defenders: their vehicle crews are aboard behind the objective, the riflemen on foot in front.
    // mounted: ok the test pairs men on foot with men aboard
    const men = [...s.identity.entries()].filter(([, i]) => i.side === "red");
    const foot = men.filter(([id]) => s.soldier.req(id).mount === undefined).map(([id]) => id);
    const hulls = [...s.vehicle.entries()].filter(([, v]) => v.side === "red" && !isOffMap(v) && v.seats.some((x) => x !== null)).map(([id]) => id);
    expect(hulls.length).toBeGreaterThan(0);
    for (const f of foot) for (const h of hulls) {
      const ft = s.transform.req(f), ht = s.transform.req(h);
      const d = hypot2(ht.x - ft.x, ht.y - ft.y);
      if (d < 15) continue;
      const ux = (ht.x - ft.x) / d, uy = (ht.y - ft.y) / d;
      // Through the hull to 30 m past it; and the same distance, but 40 m to its side (plus the cone).
      const tx = ft.x + ux * (d + 30), ty = ft.y + uy * (d + 30);
      const side = 40 + d * 0.1;
      const wx = ft.x + ux * d - uy * side, wy = ft.y + uy * d + ux * side;
      // Only where no other man on foot is anywhere near either line.
      const clearOf = (ex: number, ey: number) => foot.every((o: EntityId) => {
        if (o === f) return true;
        const ot = s.transform.req(o);
        const L2 = (ex - ft.x) * (ex - ft.x) + (ey - ft.y) * (ey - ft.y);
        const u = ((ot.x - ft.x) * (ex - ft.x) + (ot.y - ft.y) * (ey - ft.y)) / L2;
        const px = ft.x + u * (ex - ft.x), py = ft.y + u * (ey - ft.y);
        return u < -0.1 || u > 1.1 || hypot2(ot.x - px, ot.y - py) > 15;
      });
      if (clearOf(tx, ty)) { through++; expect(friendInLine(sim.ctx, s, f, tx, ty), `${f} through ${h}`).toBe(true); }
      // (Wide of this hull: no other own hull near that line either.)
      const otherHull = hulls.some((o) => {
        const ot = s.transform.req(o);
        const L2 = (wx - ft.x) * (wx - ft.x) + (wy - ft.y) * (wy - ft.y);
        const u = ((ot.x - ft.x) * (wx - ft.x) + (ot.y - ft.y) * (wy - ft.y)) / L2;
        const px = ft.x + u * (wx - ft.x), py = ft.y + u * (wy - ft.y);
        return u > -0.1 && u < 1.1 && hypot2(ot.x - px, ot.y - py) < 15;
      });
      if (clearOf(wx, wy) && !otherHull) { wide++; expect(friendInLine(sim.ctx, s, f, wx, wy), `${f} wide of ${h}`).toBe(false); }
    }
    step(sim);
    }
    expect(through).toBeGreaterThan(2);
    expect(wide).toBeGreaterThan(2);
  });

  it("a gunner aboard does not fire through a hull of his side; his own hull and an enemy hull do not block (balance pass 3)", () => {
    const sc = getScenario("platoon-vehicles");
    const sim = createSim(sc.build(data, 1, 60));
    const s = sim.state;
    const blue = [...s.vehicle.entries()].filter(([, v]) => v.side === "blue" && !isOffMap(v) && v.stations.length > 0 && v.seats.some((x) => x !== null));
    expect(blue.length).toBeGreaterThan(1);
    const gunnerOf = (vid: EntityId): EntityId => s.vehicle.req(vid).seats.find((x) => x !== null)!;
    let pairs = 0;
    for (const [a] of blue) for (const [b] of blue) {
      if (a === b) continue;
      const g = gunnerOf(a), at = s.transform.req(a), bt = s.transform.req(b), gt = s.transform.req(g);
      const d = hypot2(bt.x - gt.x, bt.y - gt.y);
      if (d < 12) continue;
      const ux = (bt.x - gt.x) / d, uy = (bt.y - gt.y) / d;
      pairs++;
      // Through the other Puma, 200 m on: blocked.
      expect(friendInLine(sim.ctx, s, g, gt.x + ux * (d + 200), gt.y + uy * (d + 200)), `${a} through ${b}`).toBe(true);
      // Away from it (the opposite way, past his own hull): only if nothing else of his side is that way.
      const bx = at.x - ux * 200, by = at.y - uy * 200;
      const behind = [...s.vehicle.entries()].some(([o, v]) => o !== a && v.side === "blue" && !isOffMap(v) && ((s.transform.req(o).x - at.x) * -ux + (s.transform.req(o).y - at.y) * -uy) > -5)
        || [...s.identity.entries()].some(([o, i]) => i.side === "blue" && s.soldier.req(o).mount === undefined && ((s.transform.req(o).x - at.x) * -ux + (s.transform.req(o).y - at.y) * -uy) > -5);
      if (!behind) expect(friendInLine(sim.ctx, s, g, bx, by), `${a} away from ${b}`).toBe(false);
    }
    expect(pairs).toBeGreaterThan(0);
    // An enemy hull in the line is no friend.
    const red = [...s.vehicle.entries()].find(([, v]) => v.side === "red" && !isOffMap(v))!;
    const [a] = blue[0]!;
    const g = gunnerOf(a), gt = s.transform.req(g), rt = s.transform.req(red[0]);
    const clear = !blue.some(([o]) => o !== a && (() => {
      const ot = s.transform.req(o), L = hypot2(rt.x - gt.x, rt.y - gt.y);
      const u = ((ot.x - gt.x) * (rt.x - gt.x) + (ot.y - gt.y) * (rt.y - gt.y)) / (L * L);
      const px = gt.x + u * (rt.x - gt.x), py = gt.y + u * (rt.y - gt.y);
      return u > -0.1 && u < 1.1 && hypot2(ot.x - px, ot.y - py) < 15 + L * 0.07;
    })()) && ![...s.identity.entries()].some(([o, i]) => i.side === "blue" && s.soldier.req(o).mount === undefined);
    if (clear) expect(friendInLine(sim.ctx, s, g, rt.x, rt.y)).toBe(false);
    // A destroyed hull of his side no longer counts.
    for (const [b] of blue) if (b !== a) s.vehicle.req(b).status = "destroyed";
    const [b] = blue.find(([o]) => o !== a)!;
    const bt = s.transform.req(b), d = hypot2(bt.x - gt.x, bt.y - gt.y);
    const onFoot = [...s.identity.entries()].some(([o, i]) => i.side === "blue" && s.soldier.req(o).mount === undefined);
    if (!onFoot && d > 12) expect(friendInLine(sim.ctx, s, g, gt.x + ((bt.x - gt.x) / d) * (d + 200), gt.y + ((bt.y - gt.y) / d) * (d + 200))).toBe(false);
  });

  it("a crewman working outside his hull blocks a comrade's line like a man on foot (balance pass 3 review)", () => {
    const sim = createSim(getScenario("platoon-vehicles").build(data, 1, 60));
    const s = sim.state;
    // mounted: ok the test takes a man on foot and a crewman aboard
    const red = [...s.identity.entries()].filter(([, i]) => i.side === "red").map(([id]) => id);
    const f = red.find((id) => s.soldier.req(id).mount === undefined)!;
    const c = red.find((id) => s.soldier.req(id).mount !== undefined && !isOffMap(s.vehicle.req(s.soldier.req(id).mount!.vehicle)))!;
    const ft = s.transform.req(f);
    // A direction from him with nothing of his side within 20 m of a 60 m line.
    let dir: [number, number] | null = null;
    for (let k = 0; k < 32 && dir === null; k++) {
      const ux = Math.cos((k * Math.PI) / 16), uy = Math.sin((k * Math.PI) / 16);
      const clear = [...red, ...[...s.vehicle.entries()].filter(([, v]) => v.side === "red").map(([id]) => id)].every((o) => {
        if (o === f || o === c) return true;
        const ot = s.transform.req(o), u = (ot.x - ft.x) * ux + (ot.y - ft.y) * uy;
        return u < -5 || u > 65 || Math.abs((ot.x - ft.x) * -uy + (ot.y - ft.y) * ux) > 20;
      });
      if (clear) dir = [ux, uy];
    }
    expect(dir).not.toBeNull();
    const [ux, uy] = dir!;
    const ct = s.transform.req(c);
    ct.x = ft.x + ux * 30; ct.y = ft.y + uy * 30; ct.z = ft.z;
    const tx = ft.x + ux * 60, ty = ft.y + uy * 60;
    // Aboard (in his seat as far as fire is concerned): behind armour, not a body in the line.
    expect(friendInLine(sim.ctx, s, f, tx, ty)).toBe(false);
    // Outside at the hull's track: a body in the line.
    s.action.set(c, { kind: "repairOutside", startTick: 0, durationTicks: 600, params: {} });
    expect(friendInLine(sim.ctx, s, f, tx, ty)).toBe(true);
  });
});
