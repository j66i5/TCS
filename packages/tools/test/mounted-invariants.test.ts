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
import { createSim, friendInLine, hypot2, seatWorld, sideKnowledge, step, submitOrder, type EntityId, type Sim } from "@tcs/sim";
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
    aboard++;
    const v = s.vehicle.req(m.vehicle);
    expect(v.seats[m.seat], `${label} seat of ${id}`).toBe(id);
    const def = sim.ctx.catalog.vehicles[v.def]!, t = s.transform.req(m.vehicle), mt = s.transform.req(id);
    const [x, y] = seatWorld(def, m.seat, t.x, t.y, t.heading);
    expect(hypot2(mt.x - x, mt.y - y), `${label} ${id} in his seat`).toBeLessThan(1e-6);
    expect(s.mover.get(id)?.waypoints.length ?? 0, `${label} ${id} walks`).toBe(0);
    expect(s.fire.has(id), `${label} ${id} fire task`).toBe(false);
    const a = s.action.get(id);
    expect(a !== undefined && FORBIDDEN.has(a.kind), `${label} ${id} action ${a?.kind}`).toBe(false);
  }
  return aboard;
}

function noneKnown(sim: Sim, label: string): void {
  for (const side of sim.state.sides) for (const k of sideKnowledge(sim.ctx, sim.state, side.id)) {
    expect(sim.state.soldier.get(k.target)?.mount, `${label} ${side.id} knows ${k.target} aboard`).toBeUndefined();
  }
}

describe("mounted-man invariants at run time (M7.2)", () => {
  for (const [name, seed] of [["platoon-vehicles", 1], ["platoon-ru-vehicles", 2]] as const) {
    it(`${name} s${seed}: men aboard sit, ride, never walk, fire, reload or throw, and are never known to the enemy`, () => {
      const sc = getScenario(name);
      const input = sc.build(data, seed, 180);
      const sim = createSim(input);
      const ctrls = [commanderController("blue", input), commanderController("red", input)];
      let maxAboard = 0, gotOut = 0, rode = false;
      for (let i = 0; i < 180 * 60 && !sim.state.ended; i++) {
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
      expect(gotOut).toBeGreaterThan(30);
    });
  }

  it("a man aboard never blocks a comrade's line of fire (he is behind armour)", () => {
    const sc = getScenario("platoon-vehicles");
    const sim = createSim(sc.build(data, 1, 60));
    const s = sim.state;
    let checked = 0;
    // Defenders: their vehicle crews are aboard behind the objective, the riflemen on foot in front.
    // mounted: ok the test pairs men on foot with men aboard
    const men = [...s.identity.entries()].filter(([, i]) => i.side === "red");
    const foot = men.filter(([id]) => s.soldier.req(id).mount === undefined).map(([id]) => id);
    const aboard = men.filter(([id]) => s.soldier.req(id).mount !== undefined).map(([id]) => id);
    for (const f of foot) for (const a of aboard) {
      const ft = s.transform.req(f), at = s.transform.req(a);
      const d = hypot2(at.x - ft.x, at.y - ft.y);
      const tx = ft.x + ((at.x - ft.x) / d) * (d + 30), ty = ft.y + ((at.y - ft.y) / d) * (d + 30);
      // Only where no other man on foot is anywhere near that line.
      const clear = foot.every((o: EntityId) => {
        if (o === f) return true;
        const ot = s.transform.req(o);
        const u = ((ot.x - ft.x) * (tx - ft.x) + (ot.y - ft.y) * (ty - ft.y)) / ((d + 30) * (d + 30));
        const px = ft.x + u * (tx - ft.x), py = ft.y + u * (ty - ft.y);
        return u < -0.1 || u > 1.1 || hypot2(ot.x - px, ot.y - py) > 15;
      });
      if (!clear) continue;
      checked++;
      expect(friendInLine(sim.ctx, s, f, tx, ty), `${f} past ${a}`).toBe(false);
    }
    expect(checked).toBeGreaterThan(5);
    step(sim);
  });
});
