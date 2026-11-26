/**
 * Damage from kinetic hits that do not get through (balance pass 6, review 2026-11-24 problem 4; core/ballistics.json
 * `armour.nonPenetrating`): a cannon round stopped by the plate or glancing off may break what is outside the armour
 * where it struck. Forced strikes on a Puma (real data; the sim's own test catalog has no hull with parts): the
 * data's chance, never a penetration, fire or wound, nothing from rifle calibres, nothing without the data block,
 * the same after save and load, a track broken this way is the crew's repair task and is mended, a wrecked launcher
 * fires no missile, and the BMP-2's cannon degrades a Puma head-on without killing it.
 */
import { describe, expect, it } from "vitest";
import {
  componentIndex, createSim, deserializeState, hashState, repairTaskFor, resolveVehicleHit, serializeState, step, submitOrder, TICK_HZ, vehicleRow, weaponOut,
  type BattleInput, type Catalog, type EntityId, type Sim, type SimEvent,
} from "@tcs/sim";
import { duel } from "../src/labs/gunnery";
import { NONPEN_CASES, nonPenLab, nonPenRun } from "../src/labs/nonpen";
import { loadData } from "../src/scenarios";

const data = loadData();
const AP = "ru-30x165-3ubr8", V = 900;

interface Field { sim: Sim; input: BattleInput; vid: EntityId; shooter: EntityId }
/** A halted Puma (blue) at (400, 600) facing east, a BMP-2 far off; everyone holds fire. */
function field(change?: (input: BattleInput) => void): Field {
  const input = duel(data, ["de", "ru"], { blue: { x: 400, y: 600, heading: 0 }, red: { x: 2000, y: 600, heading: Math.PI } });
  change?.(input);
  const sim = createSim(input);
  for (const [uid, u] of sim.state.unit.entries()) if (u.parent === null) submitOrder(sim, { tick: 0, issuer: u.side, target: uid, kind: "rules", fire: "hold", at: "hold" });
  step(sim);
  const vid = [...sim.state.vehicle.entries()].find(([, v]) => v.side === "blue")![0];
  const shooter = [...sim.state.identity.entries()].find(([, i]) => i.side === "red")![0];
  return { sim, input, vid, shooter };
}
/**
 * One round striking the hull (part 0) or turret (part 1) on `face` (0 front, 1 its right side) at (f, r, u) of
 * that part's frame, flying square on to the face; the events of the hit.
 */
function strike(F: Field, ammo: string, speed: number, part: 0 | 1, face: 0 | 1, f: number, r: number, u: number): SimEvent[] {
  const { sim, vid, shooter } = F;
  const G = sim.ctx.ballistics.vehicles, row = vehicleRow(G, vid);
  const ox = part === 1 ? G.tx[row]! : G.x[row]!, oy = part === 1 ? G.ty[row]! : G.y[row]!;
  const c = part === 1 ? G.tch[row]! : G.ch[row]!, s = part === 1 ? G.tsh[row]! : G.sh[row]!;
  const x = ox + f * c - r * s, y = oy + f * s + r * c, z = G.gz[row]! + u;
  // Square on: against the face's outward normal (front: -forward; right side: -right).
  const dx = face === 0 ? -c : s, dy = face === 0 ? -s : -c;
  const events: SimEvent[] = [];
  const sink = { events, emit(e: SimEvent) { events.push(e); } };
  resolveVehicleHit(sim.ctx, sim.state, sink as never, row, x, y, z, dx * speed, dy * speed, 0, speed, sim.ctx.catalog.ammoIds.indexOf(ammo), shooter, part, face, 100, () => undefined);
  return events;
}
const pumaOf = (F: Field) => { const v = F.sim.state.vehicle.req(F.vid); return { v, def: F.sim.ctx.catalog.vehicles[v.def]! }; };
/** The middle of the first part of `kind`, pushed onto the turret's front face. */
function onTurretFront(F: Field, kind: Parameters<typeof componentIndex>[1]): { k: number; f: number; r: number; u: number } {
  const { def } = pumaOf(F), k = componentIndex(def, kind), b = def.components![k]!.box;
  return { k, f: def.body.turret!.f[1], r: (b.r[0] + b.r[1]) / 2, u: Math.min((b.u[0] + b.u[1]) / 2, def.body.turret!.u[1] - 0.01) };
}
const rngOf = (sim: Sim) => JSON.stringify(sim.state.rng);

describe("hits that do not get through (balance pass 6)", () => {
  const N = data.ballistics!.armour.nonPenetrating!;

  it("the data block is there, low confidence, and lists only parts a hull can have", () => {
    expect(N.confidence).toBe("low");
    expect(Object.keys(N.parts).sort()).toEqual(["coax", "dischargers", "gun", "launcher", "sights", "track", "wheels"]);
  });

  it("30 mm armour-piercing on a Puma's sight: the data's chance (x energy), half the sights a strike, never through, no fire, nobody hurt", () => {
    const F = field();
    const { v, def } = pumaOf(F), at = onTurretFront(F, "sights");
    const ammo = F.sim.ctx.catalog.ammo[AP]!;
    const ef = Math.min(N.maxEnergyFactor, Math.pow((0.5 * ammo.projectileMassKg * V * V) / N.energyRefJ, N.energyExponent));
    const want = Math.min(1, N.parts.sights!.chance * ef);
    let hit = 0;
    const trials = 600, all: SimEvent[] = [];
    for (let i = 0; i < trials; i++) {
      v.comp[at.k] = 1;
      const ev = strike(F, AP, V, 1, 0, at.f, at.r, at.u);
      all.push(...ev);
      const vh = ev.find((e) => e.kind === "vehicle.hit");
      expect(vh?.kind === "vehicle.hit" && vh.result).toBe("stopped");
      if (v.comp[at.k]! < 1) {
        hit++;
        expect(v.comp[at.k]).toBeCloseTo(1 - N.parts.sights!.loss * Math.min(1, ef), 9);
        expect(vh?.kind === "vehicle.hit" && vh.components).toEqual([at.k]);
      }
    }
    // (600 draws: three standard deviations of a share near 0.74 are about 0.054.)
    expect(Math.abs(hit / trials - want)).toBeLessThan(0.06);
    expect(all.some((e) => e.kind === "vehicle.fire" || e.kind === "vehicle.destroyed" || e.kind === "hit" || e.kind === "wound")).toBe(false);
    expect(v.lastPenTick).toBeLessThan(0);
    expect(v.fire).toBeNull();
    expect(v.status).toBe("ok");
    expect(v.seats.every((m) => m === null || F.sim.state.soldier.req(m).wounds.length === 0)).toBe(true);
    expect(def.components![at.k]!.external).toBe(true);
  });

  it("two such strikes blind it: the crew calls its sights out, the gun's error trebles through the wrecked sight", () => {
    const F = field();
    const { v } = pumaOf(F), at = onTurretFront(F, "sights");
    const radio: string[] = [];
    for (let i = 0; i < 200 && v.comp[at.k]! > 0; i++) for (const e of strike(F, AP, V, 1, 0, at.f, at.r, at.u)) if (e.kind === "radio") radio.push(e.key);
    expect(v.comp[at.k]).toBe(0);
    expect(radio).toEqual(["radio.vehicleSightsOut"]);
    expect(v.status).toBe("ok"); // blind, not disarmed: it can still move and fire
  });

  it("a strike away from every part does nothing and draws nothing; rifle and 12.7 mm rounds never roll", () => {
    const F = field();
    const { v, def } = pumaOf(F), at = onTurretFront(F, "sights");
    const before = rngOf(F.sim), comp0 = [...v.comp];
    // The hull front's middle, well above the tracks and below the turret: no listed part there.
    for (let i = 0; i < 50; i++) strike(F, AP, V, 0, 0, def.body.hull.f[1], 0, 1.8);
    for (let i = 0; i < 50; i++) { strike(F, "de-127x99-ap", 800, 1, 0, at.f, at.r, at.u); strike(F, "de-762-dm111", 800, 1, 0, at.f, at.r, at.u); }
    expect(v.comp).toEqual(comp0);
    expect(rngOf(F.sim)).toBe(before);
    // (The cannon round on the sight does draw.)
    strike(F, AP, V, 1, 0, at.f, at.r, at.u);
    expect(rngOf(F.sim)).not.toBe(before);
  });

  it("without the data block a stopped round does nothing, as before", () => {
    const F = field((input) => {
      const B = input.catalog.ballistics, { nonPenetrating: _gone, ...armour } = B.armour;
      void _gone;
      input.catalog = { ...input.catalog, ballistics: { ...B, armour } } as Catalog;
    });
    const { v } = pumaOf(F), at = onTurretFront(F, "sights");
    const before = rngOf(F.sim), comp0 = [...v.comp];
    for (let i = 0; i < 100; i++) expect(strike(F, AP, V, 1, 0, at.f, at.r, at.u).filter((e) => e.kind === "vehicle.component").length).toBe(0);
    expect(v.comp).toEqual(comp0);
    expect(rngOf(F.sim)).toBe(before);
  });

  it("a glancing round has the lesser chance (ricochetFactor); a tank's long rod the capped energy factor", () => {
    // (Read from the data: the rule's numbers stay in the ranges the note explains.)
    expect(N.ricochetFactor).toBeLessThan(1);
    const cat = field().sim.ctx.catalog, rod = cat.ammo["ru-125-3bm60"]!;
    expect(Math.pow((0.5 * rod.projectileMassKg * 1500 * 1500) / N.energyRefJ, N.energyExponent)).toBeGreaterThan(N.maxEnergyFactor);
    const ap = cat.ammo[AP]!;
    expect(ap.diameterM).toBeGreaterThanOrEqual(N.minDiameterM);
    const ef = Math.pow((0.5 * ap.projectileMassKg * V * V) / N.energyRefJ, N.energyExponent);
    expect(ef).toBeGreaterThan(0.8);
    expect(ef).toBeLessThan(1.3);
  });

  it("the state with parts damaged this way saves and loads to the same hash, and goes on the same", () => {
    const F = field(), G2 = field();
    const at = onTurretFront(F, "sights");
    for (const X of [F, G2]) for (let i = 0; i < 3; i++) strike(X, AP, V, 1, 0, at.f, at.r, at.u);
    expect(hashState(G2.sim.state)).toBe(hashState(F.sim.state));
    G2.sim.state = deserializeState(serializeState(G2.sim.state));
    expect(hashState(G2.sim.state)).toBe(hashState(F.sim.state));
    for (const X of [F, G2]) { for (let i = 0; i < 5; i++) strike(X, AP, V, 1, 0, at.f, at.r, at.u); for (let i = 0; i < 30; i++) step(X.sim); }
    expect(hashState(G2.sim.state)).toBe(hashState(F.sim.state));
  });

  it("a track broken from the side by stopped rounds immobilises it; the crew's repair task is the track and mends it", () => {
    const F = field((input) => {
      // (A quicker task: the drill is M11.7a's, the test shorter.)
      const R = input.catalog.repair!;
      input.catalog = { ...input.catalog, repair: { ...R, tasks: { ...R.tasks, track: { ...R.tasks.track!, manMin: 4 } } } } as Catalog;
    });
    const { v, def } = pumaOf(F);
    const k = def.components!.findIndex((c) => c.kind === "track" && c.box.r[1] > 0), b = def.components![k]!.box;
    // The right track, struck on the hull's right side at the track's height. A 30 mm round gets through a Puma's
    // side: the rule is for rounds that do not, so the strikes are slow ones (a spent round).
    let n = 0;
    const radio: string[] = [];
    while (v.comp[k]! > 0 && n < 400) { n++; for (const e of strike(F, AP, 300, 0, 1, 0, def.body.hull.r[1], (b.u[0] + b.u[1]) / 2)) { if (e.kind === "vehicle.hit") expect(e.result).not.toBe("penetrated"); if (e.kind === "radio") radio.push(e.key); } }
    expect(v.comp[k]).toBe(0);
    expect(v.status).toBe("immobilised");
    expect(radio).toContain("radio.vehicleImmobilised");
    expect(v.crewReaction).not.toBe("bailOut");
    const pick = repairTaskFor(F.sim.ctx.catalog, F.sim.state, F.vid, v, def);
    expect(typeof pick === "object" && pick.kind).toBe("track");
    let mended = false;
    for (let i = 0; i < 900 * TICK_HZ && !mended; i++) for (const e of step(F.sim)) if (e.kind === "vehicle.repair" && e.vehicle === F.vid && e.phase === "done") mended = true;
    expect(mended).toBe(true);
    expect(v.comp[k]).toBeGreaterThan(0);
    expect(v.status).toBe("ok");
  }, 60000);

  it("a wrecked launcher fires no missile; a hull without a launcher part is not affected", () => {
    const F = field();
    const { v, def } = pumaOf(F);
    const si = 0, wi = def.stations[si]!.weapons.findIndex((w) => F.sim.ctx.catalog.ammo[F.sim.ctx.catalog.items[w.feeds[0]!.item]?.chargeItem ?? ""]?.guided !== undefined);
    expect(wi).toBeGreaterThanOrEqual(0);
    expect(weaponOut(F.sim.ctx, v, def, si, wi)).toBe(false);
    v.comp[componentIndex(def, "launcher")] = 0;
    expect(weaponOut(F.sim.ctx, v, def, si, wi)).toBe(true);
    // The other weapons are not out with it.
    def.stations[si]!.weapons.forEach((_, j) => { if (j !== wi) expect(weaponOut(F.sim.ctx, v, def, si, j)).toBe(false); });
    // A tank (its missile goes through the gun; no launcher part): the gun and the sights decide, as before.
    const T = createSim(duel(data, ["de", "ru"], { blue: { x: 400, y: 600, heading: 0 }, red: { x: 2000, y: 600, heading: Math.PI } }, undefined, 2400, ["puma-besatzung", "t90m-ekipazh"]));
    const tv = [...T.state.vehicle.entries()].find(([, x]) => x.side === "red")![1], tdef = T.ctx.catalog.vehicles[tv.def]!;
    expect(componentIndex(tdef, "launcher")).toBe(-1);
    const twi = tdef.stations[0]!.weapons.findIndex((w) => T.ctx.catalog.ammo[T.ctx.catalog.items[w.feeds[0]!.item]?.chargeItem ?? ""]?.guided !== undefined);
    expect(weaponOut(T.ctx, tv, tdef, 0, twi)).toBe(false);
    tv.comp[componentIndex(tdef, "gun")] = 0;
    expect(weaponOut(T.ctx, tv, tdef, 0, twi)).toBe(true);
  });
});

describe("armour lab, part 'not penetrated' (balance pass 6)", () => {
  const bmpAtPuma = NONPEN_CASES.find((c) => c.label.startsWith("BMP-2") && c.label.endsWith("Puma"))!;

  it("ordered armour-piercing from a BMP-2 at a Puma head-on at 800 m: no round gets through, nobody is hurt, the Puma is never destroyed; in some runs its sights or launcher go", () => {
    const rows = nonPenLab(data, 6, [bmpAtPuma], ["ordered"]);
    const r = rows[0]!;
    expect(r.penetrated).toBe(0);
    expect(r.stopped).toBeGreaterThan(40);
    expect(r.destroyed + r.fire + r.hurt + r.left).toBe(0);
    const partsOut = Object.values(r.out).reduce((a, b) => a + b, 0);
    expect(partsOut).toBeGreaterThanOrEqual(1);
    // Not every run: tens of hits for a part.
    expect(r.out["sights"] ?? 0).toBeLessThan(6);
    expect(Object.keys(r.out).every((k) => ["sights", "launcher", "dischargers", "coax", "gun", "track"].includes(k))).toBe(true);
  }, 120000);

  it("its own choice with no missile aboard: the crew fires at the armour it cannot get through (why.nature.degrade), high explosive at the turret, and blinds the Puma without killing it", () => {
    const r = nonPenRun(data, bmpAtPuma, "own", 101);
    expect(r.why).toContain("why.nature.degrade");
    expect(r.why).not.toContain("why.hold.noPierce");
    expect(r.rounds).toBeGreaterThan(50);
    expect(r.penetrated).toBe(0);
    expect(r.out).toContain("sights");
    expect(r.status).toBe("immobilised"); // (the lab's freeze: neither destroyed nor left)
    expect(r.fire || r.hurt).toBe(false);
  }, 60000);

  it("with degrading fire switched off in the data the crew holds that fire, as before", () => {
    const B = data.behaviour!;
    const off = { ...data, behaviour: { ...B, gunnery: { ...B.gunnery, degrade: { ...B.gunnery.degrade!, enabled: false } } } };
    const r = nonPenRun(off, bmpAtPuma, "own", 101);
    expect(r.rounds).toBe(0);
    expect(r.why).toContain("why.hold.noPierce");
    expect(Object.keys(r.damaged)).toEqual([]);
  }, 60000);
});
