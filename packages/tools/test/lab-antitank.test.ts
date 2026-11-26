/**
 * Shoulder-fired anti-tank weapons (M7.4a): the Panzerfaust 3 and the RPG-7 on order, the owner's Q21 answer in
 * the simulation, the standing anti-tank rule (Q19, plan C1), the back-blast and room rule (Q20), the flight
 * integrator shared by aiming and the projectile loop, and a rocket in flight surviving a save.
 */
import { describe, expect, it } from "vitest";
import { viewGround } from "@tcs/ai";
import { aimSolution, backblastBlocked, createContext, createSim, flightStep, launcherReachM, launcherRound, loadSim, saveSim, simHash, step, submitOrder, TICK_HZ, type EntityId, type FlightState, type Sim, type SimEvent } from "@tcs/sim";
import { antitankSetup, antitankTrial } from "../src/labs/antitank";
import { duel } from "../src/labs/gunnery";
import { getScenario, loadData } from "../src/scenarios";
import { launchProjectile } from "../../sim/src/systems/ballistics";

const data = loadData();
function run(sim: Sim, seconds: number, on: (e: SimEvent) => void = () => undefined): void {
  for (let i = 0; i < seconds * TICK_HZ; i++) for (const e of step(sim)) on(e);
}

describe("anti-tank lab (M7.4a)", () => {
  it("a Panzerfaust at a BMP-2 side-on at 100 m hits and knocks it out", () => {
    let hits = 0, out = 0;
    for (let k = 0; k < 4; k++) { const r = antitankTrial(data, ["de", "ru"], 100, "side", 1000 + k); if (r.hit) hits++; if (r.knockedOut) out++; }
    expect(hits).toBeGreaterThanOrEqual(3);
    expect(out).toBeGreaterThanOrEqual(2);
  });

  it("owner Q21 (b): a PG-7VL does not get through the Puma's front, but does through its side", () => {
    let frontPen = 0, frontHits = 0, sidePen = 0;
    for (let k = 0; k < 4; k++) {
      const f = antitankTrial(data, ["ru", "de"], 100, "front", 2000 + k);
      if (f.hit) frontHits++;
      if (f.penetrated) frontPen++;
      if (antitankTrial(data, ["ru", "de"], 100, "side", 2000 + k).penetrated) sidePen++;
    }
    expect(frontHits).toBeGreaterThanOrEqual(3);
    expect(frontPen).toBe(0);
    expect(sidePen).toBeGreaterThanOrEqual(3);
  });

  it("the round leaves the gunner's load (rule 9); the Panzerfaust's firing unit stays", () => {
    const { input, gunner, target } = antitankSetup(data, ["de", "ru"], 150, "side", 7);
    const sim = createSim(input);
    const c = sim.state.container.req(gunner);
    const count = (t: string) => c.stacks.filter((s) => s.type === t).reduce((n, s) => n + s.count, 0);
    expect(count("de-pzf3-dm12")).toBe(1);
    const tt = sim.state.transform.req(target);
    submitOrder(sim, { tick: 0, issuer: "blue", target: gunner, kind: "fire", x: tt.x, y: tt.y, contact: target, nature: "at" });
    let launched = 0;
    run(sim, 8, (e) => { if (e.kind === "grenade.launched" && e.method === "direct") launched++; });
    expect(launched).toBe(1);
    expect(count("de-pzf3-dm12")).toBe(0);
    expect(count("de-pzf3-firing-unit")).toBe(1);
    expect(launcherRound(sim.ctx, sim.state, gunner)).toBeNull();
  });
});

describe("the Panzerfaust 3's fire-control sight (balance pass 6)", () => {
  const de = data.factions["de"]!;
  /** The data without the sight: the firing unit as before balance pass 6. */
  const plain = { ...data, factions: { ...data.factions, de: { ...de, items: { ...de.items, "de-pzf3-firing-unit": (({ launcherSight: _s, ...rest }) => rest)(de.items["de-pzf3-firing-unit"]!) } } } } as typeof data;
  /** The sight with its rangefinder alone (part 1 of the pass): without the smaller aiming error of the verification fix. */
  const rangeOnly = { ...data, factions: { ...data.factions, de: { ...de, items: { ...de.items, "de-pzf3-firing-unit": { ...de.items["de-pzf3-firing-unit"]!, launcherSight: { rangeErrorFraction: 0.01 } } } } } } as typeof data;
  /** The elevation (mrad) the gunner fires at on order, 300 m from a halted BMP-2 side-on. */
  const launchEl = (d: typeof data, seed: number): number => {
    const { input, gunner, target } = antitankSetup(d, ["de", "ru"], 300, "side", seed);
    const sim = createSim(input);
    for (const [uid, u] of sim.state.unit.entries()) if (u.parent === null) submitOrder(sim, { tick: sim.state.tick, issuer: u.side, target: uid, kind: "rules", fire: "hold", at: "hold" });
    step(sim);
    const t = sim.state.transform.req(target);
    submitOrder(sim, { tick: sim.state.tick, issuer: "blue", target: gunner, kind: "fire", x: t.x, y: t.y, contact: target, nature: "at" });
    for (let i = 0; i < 8 * TICK_HZ; i++) for (const e of step(sim)) if (e.kind === "grenade.launched") {
      const P = sim.state.projectiles, n = P.count - 1;
      return 1000 * Math.atan2(P.vz[n]!, Math.hypot(P.vx[n]!, P.vy[n]!));
    }
    throw new Error("no shot");
  };
  const sd = (xs: number[]) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length); };

  it("the firing unit carries the sight in the data (range error 1 %); the RPG-7 has none; the rounds' reach is their own", () => {
    const cat = createSim(antitankSetup(data, ["de", "ru"], 100, "side", 1).input).ctx.catalog;
    expect(cat.items["de-pzf3-firing-unit"]!.launcherSight).toEqual({ rangeErrorFraction: 0.01, aimErrorFactor: 0.6 });
    expect(cat.items["ru-rpg7"]!.launcherSight).toBeUndefined();
    expect(launcherReachM(cat, "de-pzf3-dm12")).toBe(cat.ammo["de-pzf3-dm12"]!.delivery!.maxRangeM);
    expect(launcherReachM(cat, "ru-pg7vl")).toBe(300);
    // A sight that gives a reach of its own replaces the round's.
    const far = { ...cat, items: { ...cat.items, "de-pzf3-firing-unit": { ...cat.items["de-pzf3-firing-unit"]!, launcherSight: { rangeErrorFraction: 0.01, maxRangeM: 600 } } } };
    expect(launcherReachM(far, "de-pzf3-dm12")).toBe(600);
  });

  it("through the sight the elevation laid for 300 m scatters less than by the estimated range (the same draws: only the range error differs)", () => {
    const seeds = Array.from({ length: 12 }, (_, k) => 1000 + k);
    const withSight = seeds.map((s) => launchEl(rangeOnly, s)), without = seeds.map((s) => launchEl(plain, s));
    // (Verification fix: the sight's one aiming mark also takes part of the gunner's own error: less scatter again,
    // from the same draws.)
    const full = seeds.map((s) => launchEl(data, s));
    expect(sd(full)).toBeLessThan(sd(withSight));
    expect(sd(full)).toBeGreaterThan(1.5);
    // The range error is one of three draws (range, azimuth, elevation): the scatter falls, it does not vanish.
    expect(sd(withSight)).toBeLessThan(sd(without));
    expect(sd(withSight)).toBeGreaterThan(2);
    // And nothing else moved: each shot differs only by its range term, 4 % of the range's elevation at most a few mrad.
    for (let k = 0; k < seeds.length; k++) expect(Math.abs(withSight[k]! - without[k]!)).toBeLessThan(8);
  });

  it("the RPG-7's shots are untouched (same seeds, same hits as before the sight)", () => {
    // (Baseline of 2026-11-25 on origin/main c3d742c: 17 hits of 20 at a Puma side-on at 200 m.)
    let hits = 0;
    for (let k = 0; k < 20; k++) if (antitankTrial(data, ["ru", "de"], 200, "side", 1000 + k).hit) hits++;
    expect(hits).toBe(17);
  }, 60000);
});

describe("anti-tank lab: main battle tanks (M7.6a)", () => {
  /** Penetrated / hits over `n` trials at 200 m (the lab's seeds). */
  const share = (factions: [string, string], crew: [string, string], aspect: "side" | "front", n: number, eraSpent = false) => {
    let hits = 0, pen = 0;
    for (let k = 0; k < n; k++) { const r = antitankTrial(data, factions, 200, aspect, 1000 + k, { crewTemplates: crew, eraSpent }); if (r.hit) hits++; if (r.penetrated) pen++; }
    return { hits, pen, share: hits > 0 ? pen / hits : 0 };
  };
  const T90: [string, string] = ["puma-besatzung", "t90m-ekipazh"], LEO: [string, string] = ["bmp2-ekipazh", "leopard2a7v-besatzung"];

  it("Panzerfaust 3 at a T-90M's front: Relikt stops most rounds that hit; with the tiles used up nearly all get through", () => {
    const full = share(["de", "ru"], T90, "front", 20), spent = share(["de", "ru"], T90, "front", 10, true);
    expect(full.hits).toBeGreaterThan(5);
    expect(full.share).toBeGreaterThanOrEqual(0.1);
    expect(full.share).toBeLessThanOrEqual(0.45);
    expect(spent.share).toBeGreaterThanOrEqual(0.8);
  }, 120_000);

  it("Panzerfaust 3 at a T-90M's side gets through even with its tiles there", () => {
    // (Balance pass 6: with the firing unit's sight other rounds land; 7 of the 10 hits get through, before 9 of 11:
    // the side tiles' coverage stops the rest.)
    expect(share(["de", "ru"], T90, "side", 20).share).toBeGreaterThanOrEqual(0.65);
  }, 120_000);

  it("PG-7VL at a Leopard 2A7V: through its side, never its front", () => {
    expect(share(["ru", "de"], LEO, "side", 8).share).toBeGreaterThanOrEqual(0.8);
    const front = share(["ru", "de"], LEO, "front", 8);
    expect(front.hits).toBeGreaterThan(0);
    expect(front.pen).toBe(0);
  }, 120_000);

  it("M7.6c: a Panzerfaust 3 gets through a BTR-82A and a PG-7VL through a GTK Boxer, side and front, at 100 m (at least 90 % of hits)", () => {
    const at100 = (factions: [string, string], crew: [string, string], aspect: "side" | "front") => {
      let hits = 0, pen = 0;
      for (let k = 0; k < 10; k++) { const r = antitankTrial(data, factions, 100, aspect, 1000 + k, { crewTemplates: crew }); if (r.hit) hits++; if (r.penetrated) pen++; }
      return { hits, share: hits > 0 ? pen / hits : 0 };
    };
    for (const aspect of ["side", "front"] as const) {
      for (const [f, c] of [[["de", "ru"], ["puma-besatzung", "btr82a-ekipazh"]], [["ru", "de"], ["bmp2-ekipazh", "boxer-besatzung"]]] as const) {
        const r = at100([f[0], f[1]], [c[0], c[1]], aspect);
        expect(r.hits, `${c[1]} ${aspect}`).toBeGreaterThanOrEqual(5);
        expect(r.share, `${c[1]} ${aspect}`).toBeGreaterThanOrEqual(0.9);
      }
    }
  }, 180_000);

  it("used-up tiles stay counted items: the record's tiles are gone, the rest of its load is not", () => {
    const full = antitankSetup(data, ["de", "ru"], 200, "front", 1, { crewTemplates: T90 }).input.forces[1]!.vehicles![0]!.load;
    const spent = antitankSetup(data, ["de", "ru"], 200, "front", 1, { crewTemplates: T90, eraSpent: true }).input.forces[1]!.vehicles![0]!.load;
    expect(full.filter((l) => l.type.startsWith("ru-relikt")).reduce((n, l) => n + l.count, 0)).toBe(26 + 10 + 20 + 12);
    expect(spent.some((l) => l.type.startsWith("ru-relikt"))).toBe(false);
    expect(spent.length).toBe(full.length - 4);
  });
});

/** Blue's anti-tank gunner at `rangeM` from the red BMP-2 (side-on), every unit's fire rule free, the AT rule as given. */
function standingRule(rule: "vehicles" | "vehiclesAndPositions" | "hold", seed = 5): { sim: Sim; gunner: EntityId } {
  const { input, gunner } = antitankSetup(data, ["de", "ru"], 180, "side", seed);
  const sim = createSim(input);
  for (const [uid, u] of sim.state.unit.entries()) {
    if (u.parent !== null) continue;
    submitOrder(sim, { tick: 0, issuer: u.side, target: uid, kind: "rules", fire: u.side === "blue" ? "free" : "hold", ...(u.side === "blue" ? { at: rule } : {}) });
  }
  return { sim, gunner };
}

describe("standing anti-tank rule (owner Q19, plan C1)", () => {
  it("vehicles (the default): he fires on his own at an enemy vehicle he sees; hold: only on order", () => {
    for (const [rule, expectShot] of [["vehicles", true], ["hold", false]] as const) {
      const { sim, gunner } = standingRule(rule);
      let shots = 0;
      run(sim, 60, (e) => { if (e.kind === "grenade.launched" && e.soldier === gunner) shots++; });
      expect(shots > 0).toBe(expectShot);
    }
  });

  it("D4b review F9: not at a vehicle outside the arc his unit defends", () => {
    const { sim, gunner } = standingRule("vehicles");
    const me = sim.state.transform.req(gunner);
    const hull = [...sim.state.vehicle.keys()].find((v) => sim.state.vehicle.req(v).side !== "blue")!;
    const at = sim.state.transform.req(hull);
    // A narrow arc square to the BMP: he still sees it (to his side), it is outside the arc.
    sim.state.unit.req(sim.state.identity.req(gunner).unit).arc = { facing: Math.atan2(at.y - me.y, at.x - me.x) + Math.PI / 2, halfRad: Math.PI / 8 };
    let shots = 0;
    run(sim, 60, (e) => { if (e.kind === "grenade.launched" && e.soldier === gunner) shots++; });
    expect(shots).toBe(0);
  });

  it("the default rule for a unit without one is the data's (vehicles)", () => {
    const { input, gunner } = antitankSetup(data, ["de", "ru"], 180, "side", 5);
    const sim = createSim(input);
    expect(sim.ctx.catalog.behaviour.antitank.atRuleDefault).toBe("vehicles");
    expect(sim.state.unit.req(sim.state.identity.req(gunner).unit).atRule).toBeUndefined();
  });

  it("vehiclesAndPositions: he fires at a machine gun; vehicles only: he does not", () => {
    const shotsAt = (rule: "vehicles" | "vehiclesAndPositions") => {
      // The red BMP-2 far off out of reach; the red squad (with its machine gun) 120 m from the blue gunner.
      const input = duel(data, ["de", "ru"], { blue: { x: 60, y: 1100, heading: 0 }, red: { x: 2300, y: 100, heading: Math.PI / 2 } }, undefined);
      input.forces[1]!.placements.forEach((p, k) => { const crew = input.forces[1]!.units.flatMap((u) => u.subunits).some((u) => u.vehicleId !== undefined && u.members.some((m) => m.personId === p.personId)); if (!crew) { p.x = 1120; p.y = 590 + 4 * k; p.heading = Math.PI; } });
      const probe = createSim(input);
      const gp = [...probe.state.identity.entries()].find(([id, i]) => i.side === "blue" && probe.state.soldier.req(id).mount === undefined && launcherRound(probe.ctx, probe.state, id))![1].personId;
      const pl = input.forces[0]!.placements.find((p) => p.personId === gp)!;
      pl.x = 1000; pl.y = 600; pl.heading = 0;
      const sim = createSim(input);
      for (const [uid, u] of sim.state.unit.entries()) if (u.parent === null) submitOrder(sim, { tick: 0, issuer: u.side, target: uid, kind: "rules", fire: u.side === "blue" ? "free" : "hold", ...(u.side === "blue" ? { at: rule } : {}) });
      const g = [...sim.state.identity.entries()].find(([, i]) => i.personId === gp)![0];
      let shots = 0;
      run(sim, 40, (e) => { if (e.kind === "grenade.launched" && e.soldier === g && e.method === "direct") shots++; });
      return shots;
    };
    expect(shotsAt("vehicles")).toBe(0);
    expect(shotsAt("vehiclesAndPositions")).toBeGreaterThan(0);
  });
});

describe("back-blast and rooms (owner Q20)", () => {
  it("the commander's own view of the ground has the hulls in it, as the sim's has (M7 review finding 4)", () => {
    // A red hull side-on 2.5 m east of a red man who would fire west: a wall right behind the tube.
    const input = duel(data, ["de", "ru"], { blue: { x: 400, y: 600, heading: 0 }, red: { x: 1002.5, y: 600, heading: Math.PI / 2 }, redSquadAt: { x: 1000, y: 600, spacing: 3 } });
    const sim = createSim(input);
    step(sim);
    const man = [...sim.state.identity.entries()].filter(([id, i]) => i.side === "red" && sim.state.soldier.req(id).mount === undefined)
      .sort((a, b) => Math.abs(sim.state.transform.req(a[0]).y - 600) - Math.abs(sim.state.transform.req(b[0]).y - 600))[0]![0];
    expect(backblastBlocked(sim.ctx, sim.state, man, "ru-pg7vl", Math.PI)).toBe("at.wallBehind");
    const ground = viewGround(input);
    expect(backblastBlocked(ground(sim.state, sim.state.tick), sim.state, man, "ru-pg7vl", Math.PI)).toBe("at.wallBehind");
    // (A bare context built from the input knows the walls but not the hulls: what the commander used before.)
    expect(backblastBlocked(createContext({ ...input, orders: [] }), sim.state, man, "ru-pg7vl", Math.PI)).toBeNull();
  });


  it("no shot with a comrade in the danger zone behind or a wall right behind; no order shot either", () => {
    const { input, gunner, target } = antitankSetup(data, ["ru", "de"], 150, "side", 3);
    const sim = createSim(input);
    const t = sim.state.transform.req(gunner);
    expect(backblastBlocked(sim.ctx, sim.state, gunner, "ru-pg7vl", 0)).toBeNull();
    // A comrade steps behind him (east is the target, so behind is west).
    const mate = [...sim.state.identity.entries()].find(([id, i]) => i.side === "blue" && id !== gunner && sim.state.soldier.req(id).mount === undefined)![0];
    const mt = sim.state.transform.req(mate);
    mt.x = t.x - 8; mt.y = t.y + 1;
    expect(backblastBlocked(sim.ctx, sim.state, gunner, "ru-pg7vl", 0)).toBe("at.backblast");
    const tt = sim.state.transform.req(target);
    submitOrder(sim, { tick: 0, issuer: "blue", target: gunner, kind: "fire", x: tt.x, y: tt.y, contact: target, nature: "at" });
    let launched = 0, unable = 0;
    run(sim, 6, (e) => { if (e.kind === "grenade.launched") launched++; if (e.kind === "radio" && e.key === "radio.unable") unable++; });
    expect(launched).toBe(0);
    expect(unable).toBe(1);
  });

  it("inside a small house that is not breached he may not fire; in a large one or a breached one he may", () => {
    // A village map has houses: put the gunner inside the smallest and the largest.
    const input = getScenario("platoon").build(data, 1, 60);
    const sim = createSim(input);
    const g = [...sim.state.identity.keys()].find((id) => launcherRound(sim.ctx, sim.state, id) !== null)!;
    const area = (f: readonly number[]) => { let a = 0; for (let k = 0; k < f.length; k += 2) { const j = (k + 2) % f.length; a += f[k]! * f[j + 1]! - f[j]! * f[k + 1]!; } return Math.abs(a) / 2; };
    const bs = [...sim.ctx.map.buildings].sort((a, b) => area(a.footprint) - area(b.footprint));
    const centre = (f: readonly number[]) => { let x = 0, y = 0; for (let k = 0; k < f.length; k += 2) { x += f[k]!; y += f[k + 1]!; } return { x: (2 * x) / f.length, y: (2 * y) / f.length }; };
    const small = bs[0]!, large = bs[bs.length - 1]!;
    expect(area(small.footprint)).toBeLessThan(sim.ctx.catalog.behaviour.antitank.largeRoomM2);
    const t = sim.state.transform.req(g);
    Object.assign(t, centre(small.footprint));
    // (Clear of comrades behind: they stand elsewhere; the wall check is part of the same answer.)
    const inSmall = backblastBlocked(sim.ctx, sim.state, g, "ru-pg7vl", 0);
    expect(inSmall).toBe("at.room");
    sim.state.terrain.breaches.push({ owner: "building", id: small.id, part: 0, offsetM: 1, widthM: 1, tick: 0 });
    expect(backblastBlocked(sim.ctx, sim.state, g, "ru-pg7vl", 0)).not.toBe("at.room");
    if (area(large.footprint) >= sim.ctx.catalog.behaviour.antitank.largeRoomM2) {
      Object.assign(t, centre(large.footprint));
      expect(backblastBlocked(sim.ctx, sim.state, g, "ru-pg7vl", 0)).not.toBe("at.room");
    }
  });
});

describe("rocket flight (plan §9)", () => {
  it("aiming and the projectile engine fly the same path: a PG-7VL laid for 300 m passes within 0.5 m of the aim point", () => {
    const sim = createSim(duel(data, ["ru", "de"], { blue: { x: 60, y: 1100, heading: 0 }, red: { x: 2300, y: 100, heading: 0 } }));
    sim.state.environment.windX = 0; sim.state.environment.windY = 0; sim.state.environment.temperatureC = sim.ctx.catalog.ballistics.referenceTempC;
    const idx = sim.ctx.catalog.ammoIds.indexOf("ru-pg7vl");
    const am = sim.ctx.ballistics.ammo[idx]!;
    const v0 = sim.ctx.catalog.ammo["ru-pg7vl"]!.delivery!.velocityMps!;
    const sol = aimSolution(sim.ctx, am, v0, 300, 0)!;
    expect(sol).not.toBeNull();
    expect(sol.tof).toBeGreaterThan(0.8);
    expect(sol.tof).toBeLessThan(2);
    // The integrator alone.
    const f: FlightState = { x: 0, y: 0, z: 0, vx: v0 * Math.cos(sol.el), vy: 0, vz: v0 * Math.sin(sol.el), age: 0 };
    let zAt = NaN;
    for (let k = 0; k < 600 && Number.isNaN(zAt); k++) { const px = f.x, pz = f.z; flightStep(f, am, sim.ctx.catalog.ballistics.airDensityKgM3, 0, 0, sim.ctx.catalog.ballistics.gravityMps2); if (f.x >= 300) zAt = pz + ((f.z - pz) * (300 - px)) / (f.x - px); }
    expect(Math.abs(zAt)).toBeLessThan(0.05);
    // The projectile engine: launched high above flat ground, it passes 300 m east within 0.5 m of its start height.
    const x0 = 600, y0 = 600, z0 = 200;
    const owner = [...sim.state.soldier.keys()][0]!;
    launchProjectile(sim.ctx, sim.state, "ru-pg7vl", x0, y0, z0, v0 * Math.cos(sol.el), 0, v0 * Math.sin(sol.el), owner);
    let zEngine = NaN;
    for (let k = 0; k < 200 && Number.isNaN(zEngine); k++) {
      const P = sim.state.projectiles;
      let i = -1;
      for (let q = 0; q < P.count; q++) if (P.ammo[q] === idx) i = q;
      if (i < 0) break;
      const px = P.x[i]!, pz = P.z[i]!;
      step(sim);
      let j = -1;
      for (let q = 0; q < sim.state.projectiles.count; q++) if (sim.state.projectiles.ammo[q] === idx) j = q;
      if (j < 0) break;
      const nx = sim.state.projectiles.x[j]!, nz = sim.state.projectiles.z[j]!;
      if (nx >= x0 + 300) zEngine = pz + ((nz - pz) * (x0 + 300 - px)) / (nx - px);
    }
    expect(Math.abs(zEngine - z0)).toBeLessThan(0.5);
  });

  it("a battle with a rocket in flight, saved every 37 ticks through JSON, continues identically", () => {
    const { input, gunner, target } = antitankSetup(data, ["ru", "de"], 250, "side", 11);
    const runIt = (saveEvery: number | null) => {
      let sim = createSim(input);
      const tt = sim.state.transform.req(target);
      submitOrder(sim, { tick: 0, issuer: "blue", target: gunner, kind: "fire", x: tt.x, y: tt.y, contact: target, nature: "at" });
      let inFlight = 0;
      const hashes: string[] = [];
      for (let t = 0; t < 12 * TICK_HZ; t++) {
        step(sim);
        if (sim.state.projectiles.count > 0 && sim.state.tick > 3 * TICK_HZ) inFlight++;
        if (saveEvery !== null && sim.state.tick % saveEvery === 0) sim = loadSim(input, JSON.parse(JSON.stringify(saveSim(sim))));
        if (sim.state.tick % 60 === 0) hashes.push(simHash(sim));
      }
      return { hashes, inFlight };
    };
    const a = runIt(null), b = runIt(37);
    expect(a.inFlight).toBeGreaterThan(0);
    expect(b.hashes).toEqual(a.hashes);
  });
});
