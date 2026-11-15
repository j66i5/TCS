/**
 * Disposable anti-personnel rounds (M7.6d, the RPO-A): a man with the tube and no launcher item fires it on his own at
 * enemies holding a house within `antitank.thermobaricRangeM`, whatever the anti-tank rule, and the tube leaves his
 * load (rule 9); never at a vehicle (neither on his own nor ordered at one); an RPG man is unchanged.
 */
import { describe, expect, it } from "vitest";
import { demoBattle } from "@tcs/scenario";
import { countItems, createSim, launcherRound, step, submitOrder, type EntityId, type Sim, type SimEvent } from "@tcs/sim";
import { duel } from "../src/labs/gunnery";
import { loadData } from "../src/scenarios";

const data = loadData();

function run(sim: Sim, ticks: number, on: (e: SimEvent) => void = () => undefined): void {
  for (let i = 0; i < ticks; i++) for (const e of step(sim)) on(e);
}

/** The village demo: blue occupies the two-storey house nearest it; red (each man an RPO-A) walks to 150 m of it. */
function houseFight(seed: number): { sim: Sim; rpo: Set<EntityId> } {
  const input = demoBattle(data, { seed, factions: ["de", "ru"], timeLimitSeconds: 600, mapKind: "village", frontM: 300 });
  const red = input.forces.find((f) => f.side === "red")!;
  for (const m of red.units.flatMap((u) => [...u.members, ...u.subunits.flatMap((s) => s.members)])) m.load.push({ type: "ru-rpo-a", count: 1 });
  const blueF = input.forces.find((f) => f.side === "blue")!;
  const bc = { x: blueF.placements.reduce((a, p) => a + p.x, 0) / blueF.placements.length, y: blueF.placements.reduce((a, p) => a + p.y, 0) / blueF.placements.length };
  let house = input.map.buildings[0]!, hd = Infinity, hx = 0, hy = 0;
  for (const b of input.map.buildings) {
    if (!b.interior || b.storeys < 2) continue;
    const n = b.footprint.length / 2;
    let cx = 0, cy = 0;
    for (let k = 0; k < n; k++) { cx += b.footprint[k * 2]! / n; cy += b.footprint[k * 2 + 1]! / n; }
    const d = Math.hypot(cx - bc.x, cy - bc.y);
    if (d < hd) { hd = d; house = b; hx = cx; hy = cy; }
  }
  const sim = createSim(input);
  const rc = { x: red.placements.reduce((a, p) => a + p.x, 0) / red.placements.length, y: red.placements.reduce((a, p) => a + p.y, 0) / red.placements.length };
  const dl = Math.hypot(rc.x - hx, rc.y - hy);
  for (const [id, u] of sim.state.unit.entries()) {
    if (u.parent !== null) continue;
    if (u.side === "blue") { submitOrder(sim, { tick: 0, issuer: "blue", target: id, kind: "rules", fire: "hold" }); submitOrder(sim, { tick: 0, issuer: "blue", target: id, kind: "occupy", building: house.id, facing: Math.atan2(rc.y - hy, rc.x - hx) }); }
    else { submitOrder(sim, { tick: 0, issuer: "red", target: id, kind: "rules", fire: "free" }); submitOrder(sim, { tick: 0, issuer: "red", target: id, kind: "move", waypoints: [{ x: hx + ((rc.x - hx) / dl) * 150, y: hy + ((rc.y - hy) / dl) * 150, mode: "walk" }] }); }
  }
  const rpo = new Set([...sim.state.identity.entries()].filter(([, i]) => i.side === "red").map(([id]) => id));
  return { sim, rpo };
}

describe("disposable anti-personnel rounds (M7.6d)", () => {
  it("men with an RPO-A fire it on their own at a held house (the default anti-tank rule is 'vehicles'); each tube fired leaves the load", () => {
    let fired = 0, seeds = 0;
    for (const seed of [1, 2, 3]) {
      const { sim, rpo } = houseFight(seed);
      const before = [...rpo].reduce((n, m) => n + countItems(sim.state.container.req(m), "ru-rpo-a"), 0);
      let n = 0;
      run(sim, 60 * 300, (e) => { if (e.kind === "grenade.launched" && e.ammo === "ru-rpo-a") { n++; expect(e.method).toBe("direct"); } });
      const after = [...rpo].reduce((k, m) => k + countItems(sim.state.container.req(m), "ru-rpo-a"), 0);
      expect(before - after).toBe(n);
      fired += n; if (n > 0) seeds++;
    }
    expect(seeds).toBeGreaterThanOrEqual(2);
    expect(fired).toBeGreaterThan(0);
  });

  it("never at a vehicle: an RPO-A man facing a BTR-82A in the open fires nothing, on his own or ordered at it; an RPG man does", () => {
    for (const load of ["ru-rpo-a", "rpg"] as const) {
      const input = duel(data, ["de", "ru"], { blue: { x: 600, y: 600, heading: Math.PI / 2 }, red: { x: 1900, y: 1100, heading: 0 } }, undefined, 2400, ["boxer-besatzung", "btr82a-ekipazh"]);
      for (const rec of input.forces[0]!.vehicles ?? []) rec.status = "immobilised";
      const red = input.forces[1]!;
      const sq = red.units.flatMap((u) => u.subunits).find((u) => u.vehicleId === undefined) ?? red.units[0]!;
      const men = sq.members.length > 0 ? sq.members : red.units[0]!.members;
      for (const m of men) m.load = m.load.filter((l) => !["ru-rpg7", "ru-pg7vl"].includes(l.type));
      men[0]!.load.push(...(load === "rpg" ? [{ type: "ru-rpg7", count: 1 }, { type: "ru-pg7vl", count: 2 }] : [{ type: "ru-rpo-a", count: 2 }]));
      const ids = new Set(men.map((m) => m.personId));
      for (const pl of red.placements) if (ids.has(pl.personId)) { pl.x = 450; pl.y = 600 + (pl.y % 10); pl.heading = 0; }
      const sim = createSim(input);
      const man = [...sim.state.identity.entries()].find(([, i]) => i.personId === men[0]!.personId)![0];
      expect(launcherRound(sim.ctx, sim.state, man) === null).toBe(load !== "rpg");
      for (const [id, u] of sim.state.unit.entries()) if (u.parent === null) submitOrder(sim, { tick: 0, issuer: u.side, target: id, kind: "rules", fire: u.side === "red" ? "free" : "hold" });
      const vid = [...sim.state.vehicle.entries()].find(([, v]) => v.side === "blue")![0];
      let shots = 0;
      run(sim, 60 * 30, (e) => { if (e.kind === "grenade.launched" && e.method === "direct") shots++; });
      submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: sim.state.identity.req(man).unit, kind: "fire", x: 600, y: 600, contact: vid, nature: "at" });
      run(sim, 60 * 15, (e) => { if (e.kind === "grenade.launched" && e.method === "direct") shots++; });
      if (load === "rpg") expect(shots).toBeGreaterThan(0);
      else expect(shots).toBe(0);
    }
  });
});
