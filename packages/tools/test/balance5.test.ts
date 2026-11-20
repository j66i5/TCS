/**
 * Balance pass 5 (Germany against Russia in the mounted battle): the crews' fixes, both sides by the same code.
 *   F1  no armour-piercing at a face it cannot get through; the missile chosen on the move, the hull halting for it.
 *   F2  a top-attack missile judged against the roof (a Puma takes its Spike to a T-90M's front).
 *   F3  a hull counts as firing between two looks for vehicles, and while its gunner guides a missile.
 *   F4  a hit on a carrier calls out the squads in it and in carriers near it, not the whole side.
 *   F5  fire spread: an own missile guided onto a hull is known to the side's crews.
 *   F9  night: the BMP-2's first-generation night sight reaches about 850 m; no missile guided in the dark beyond it.
 */
import { describe, expect, it } from "vitest";
import { createSim, environmentAt, step, submitOrder, TICK_HZ, type BattleInput, type Sim, type SimEvent } from "@tcs/sim";
import { carrierHitNear } from "../../sim/src/mount";
import { guidedTargets, stationSightLight } from "../../sim/src/systems/gunnery";
import { vehicleFiringTicks, vehicleShowsFiring } from "../../sim/src/systems/spotting";
import { duel } from "../src/labs/gunnery";
import { loadData } from "../src/scenarios";

const data = loadData();

/** One hull a side, crews only, facing each other on open ground `R` m apart; day. */
function hulls(blue: string, red: string, R: number, seed = 1): BattleInput {
  const input = duel(data, ["de", "ru"], { blue: { x: 300, y: 600, heading: 0 }, red: { x: 300 + R, y: 600, heading: Math.PI } }, undefined, R + 600, [blue, red]);
  for (const f of input.forces) {
    const keep = new Set<string>();
    for (const u of f.units) { u.subunits = u.subunits.filter((s) => s.vehicleId !== undefined); for (const s of u.subunits) for (const m of s.members) keep.add(m.personId); }
    f.placements = f.placements.filter((p) => keep.has(p.personId));
  }
  input.seed = 100 + seed;
  return input;
}

function vehicleOf(sim: Sim, side: string): number {
  return [...sim.state.vehicle.entries()].find(([, v]) => v.side === side && v.offMap === undefined)![0];
}

function rules(sim: Sim, side: string, fire: "free" | "hold"): void {
  const v = sim.state.vehicle.req(vehicleOf(sim, side));
  submitOrder(sim, { tick: sim.state.tick, issuer: side, target: v.unit!, kind: "rules", fire } as never);
}

function run(sim: Sim, seconds: number, on: (e: SimEvent) => void): void {
  for (let i = 0; i < seconds * TICK_HZ; i++) for (const e of step(sim)) on(e);
}

/** Take every guided missile off a hull (its launcher and its stowage). */
function noMissiles(sim: Sim, vid: number): void {
  const v = sim.state.vehicle.req(vid);
  const def = sim.ctx.catalog.vehicles[v.def]!;
  const missileItems = new Set<string>();
  def.stations.forEach((sn, si) => sn.weapons.forEach((w, wi) => {
    const item = w.feeds[0]?.item;
    const round = item ? sim.ctx.catalog.items[item]?.chargeItem : undefined;
    if (round !== undefined && sim.ctx.catalog.ammo[round]?.guided) { missileItems.add(item!); for (const f of v.stations[si]!.weapons[wi]!.feeds) f.rounds = 0; }
  }));
  const c = sim.state.container.get(vid);
  if (c) c.stacks = c.stacks.filter((s) => !missileItems.has(s.type));
}

describe("balance pass 5: crews' gunnery", () => {
  it("F1: a BMP-2 with no missile left holds its fire at a Puma's front instead of firing armour-piercing", () => {
    const sim = createSim(hulls("puma-besatzung", "bmp2-ekipazh", 600));
    const bmp = vehicleOf(sim, "red");
    noMissiles(sim, bmp);
    rules(sim, "blue", "hold"); rules(sim, "red", "free");
    let shots = 0, noPierce = 0;
    run(sim, 30, (e) => {
      if (e.kind === "shot.fired" && e.vehicle === bmp) shots++;
      if (e.kind === "vehicle.decision" && e.vehicle === bmp && e.keys.includes("why.hold.noPierce")) noPierce++;
    });
    expect(shots).toBe(0);
    expect(noPierce).toBeGreaterThan(0);
  });

  it("F1: a BMP-2 reversing slowly halts for its Konkurs at a Puma head-on at 600 m and launches it", () => {
    const sim = createSim(hulls("puma-besatzung", "bmp2-ekipazh", 600));
    const bmp = vehicleOf(sim, "red");
    rules(sim, "blue", "hold"); rules(sim, "red", "free");
    const v = sim.state.vehicle.req(bmp);
    const t = sim.state.transform.req(bmp);
    submitOrder(sim, { tick: 0, issuer: "red", target: v.unit!, kind: "move", waypoints: [{ x: t.x + 300, y: t.y, mode: "walk", reverse: true }] } as never);
    let launch = -1, cannon = 0, held = false;
    run(sim, 40, (e) => {
      if (e.kind === "shot.fired" && e.vehicle === bmp) {
        if (sim.ctx.catalog.ammo[e.ammo]?.guided) { if (launch < 0) launch = e.tick; }
        else cannon++;
      }
      if (sim.state.vehicle.req(bmp).drive.fireHoldUntilTick !== undefined) held = true;
    });
    expect(launch).toBeGreaterThan(0);
    expect(held).toBe(true);
    expect(cannon).toBe(0);
  });

  it("F2: a Puma takes its top-attack Spike, not the cannon, to a T-90M head-on at 700 m", () => {
    const sim = createSim(hulls("puma-besatzung", "t90m-ekipazh", 700));
    const puma = vehicleOf(sim, "blue");
    rules(sim, "blue", "free"); rules(sim, "red", "hold");
    let first: string | null = null;
    run(sim, 30, (e) => { if (e.kind === "shot.fired" && e.vehicle === puma && first === null) first = e.ammo; });
    expect(first).not.toBeNull();
    expect(sim.ctx.catalog.ammo[first!]?.guided?.topAttack).toBeDefined();
  });

  it("F3: a hull counts as firing between two looks for vehicles after a shot, and while its gunner guides", () => {
    const sim = createSim(hulls("puma-besatzung", "bmp2-ekipazh", 1000));
    const D = sim.ctx.catalog.spotting;
    const ft = vehicleFiringTicks(D);
    expect(ft).toBeGreaterThanOrEqual(4 * D.scanSeconds * TICK_HZ);
    const v = sim.state.vehicle.req(vehicleOf(sim, "red"));
    const tick = 10000;
    v.stations[0]!.weapons[0]!.lastShotTick = tick - Math.round(3 * TICK_HZ);
    expect(vehicleShowsFiring(v, tick, ft)).toBe(true);
    v.stations[0]!.weapons[0]!.lastShotTick = tick - ft - 1;
    expect(vehicleShowsFiring(v, tick, ft)).toBe(false);
    v.stations[0]!.guide = { ammo: "x", weapon: 0, gunner: 0, launchTick: tick - 300, target: 1, errH: 0, errV: 0, checkTick: -1, ax: 0, ay: 0, az: 0 };
    expect(vehicleShowsFiring(v, tick, ft)).toBe(true);
  });

  it("F5: the hull an own missile is guided onto is known to the side (and not to the enemy)", () => {
    const sim = createSim(hulls("puma-besatzung", "bmp2-ekipazh", 1500));
    const puma = vehicleOf(sim, "blue"), bmp = vehicleOf(sim, "red");
    rules(sim, "blue", "free"); rules(sim, "red", "hold");
    let seen: number[] | null = null;
    run(sim, 20, () => { const g = guidedTargets(sim.state, "blue"); if (g !== null && seen === null) seen = g; });
    expect(seen).toEqual([bmp]);
    expect(guidedTargets(sim.state, "red")).toBeNull();
    expect(puma).toBeGreaterThan(0);
  });

  it("F4: a hit on a carrier calls out its own squad and those in carriers within reach, not one 1 km away", () => {
    const sim = createSim(hulls("puma-besatzung", "bmp2-ekipazh", 1000));
    const blue = vehicleOf(sim, "blue"), red = vehicleOf(sim, "red");
    expect(carrierHitNear(sim.state, blue, [], 300)).toBe(false);
    expect(carrierHitNear(sim.state, blue, [blue], 300)).toBe(true);
    expect(carrierHitNear(sim.state, blue, [red], 300)).toBe(false);
    expect(carrierHitNear(sim.state, blue, [red], 1001)).toBe(true);
  });

  it("F9: the BMP-2 gunner's night channel reaches 850 m and the commander's 400 m; the Puma's thermal 3000 m", () => {
    const sim = createSim(hulls("puma-besatzung", "bmp2-ekipazh", 1000));
    const bmp = sim.ctx.catalog.vehicles["ru-bmp2"]!, puma = sim.ctx.catalog.vehicles["de-puma"]!;
    expect(stationSightLight(sim.ctx, bmp, 0, 800)).toBe(0.5);
    expect(stationSightLight(sim.ctx, bmp, 0, 1500)).toBe(0);
    expect(stationSightLight(sim.ctx, puma, 0, 2500)).toBe(1);
    const cmd = bmp.seats.find((x) => x.station === "commander")!;
    expect(cmd.sensors!.map((x) => sim.ctx.catalog.spotting.sensors[x.kind]!.maxRangeM)).toContain(400);
  });

  it("F9: on a moonless night a BMP-2 does not launch its Konkurs at a Puma 1500 m off; by day it does", () => {
    const launches = (night: boolean): number => {
      const input = hulls("puma-besatzung", "bmp2-ekipazh", 1500);
      input.environment = night ? environmentAt(input.catalog, 0, 0) : environmentAt(input.catalog, 12 * 3600, 0.5);
      const sim = createSim(input);
      const bmp = vehicleOf(sim, "red");
      sim.state.vehicle.req(vehicleOf(sim, "blue")).movedTick = 0; // a hot hull, easy to see
      rules(sim, "blue", "hold"); rules(sim, "red", "free");
      let n = 0;
      run(sim, 40, (e) => { if (e.kind === "shot.fired" && e.vehicle === bmp && sim.ctx.catalog.ammo[e.ammo]?.guided) n++; });
      return n;
    };
    expect(launches(false)).toBeGreaterThan(0);
    expect(launches(true)).toBe(0);
  });
});
