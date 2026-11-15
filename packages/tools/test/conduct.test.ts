/**
 * Laws of war (M10.7b, roadmap-detail slice 16): breaches, medic self-defence, hits on protected people.
 * - Misidentification: an enemy medic fired at because he was not recognised — at night and in smoke, not by day.
 * - Deliberate breaches: the chance from the data (base, losses, discipline, panic) is the same for both sides; drawn
 *   at about that rate; a man who decides on one fires at a medic he has recognised.
 * - Self-defence: a medic fires on his own only at an enemy close by and keeps his protection; beyond, only on the
 *   player's order, which costs it.
 * - Nothing live (owner answer 7): no radio line, no string a player sees during the battle; the record keeps them.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCatalog } from "@tcs/data";
import {
  breachChance, breachChanceOf, createSim, decideDeliberate, DEFAULT_COMMS, environmentAt, flatMap, newBattleRecord, ownLossShare, protectionNow,
  PROT_MARKED, recordEvents, step, submitOrder, TICK_HZ,
  type BattleInput, type Catalog, type EntityId, type Order, type Sim, type SimEvent, type SoldierRecord,
} from "@tcs/sim";
import { loadData } from "../src/scenarios";

const data = loadData(true);
const catalog: Catalog = buildCatalog(data, ["de", "ru"]);
const P = catalog.medical!.protection;

function run(sim: Sim, seconds: number, on: (e: SimEvent) => void = () => undefined): void {
  for (let i = 0; i < seconds * TICK_HZ; i++) for (const e of step(sim)) on(e);
}
function man(personId: string, weapon: string, mag: string, armband: boolean): SoldierRecord {
  const r: SoldierRecord = { personId, given: "T", family: personId, rank: "r", role: "rifleman", skills: { marksmanship: 0.6, experience: 0.5 }, weapon, fatigue: 0, stress: 0, wounds: [], status: "fit", load: [{ type: mag, count: 6, charge: 30 }] };
  if (armband) r.load.push({ type: "de-armband", count: 1 });
  return r;
}
type Light = "day" | "night" | "smoke";
/** A blue rifleman (AK, iron sights: an armband by eye to 50 m by day) and a red medic with the armband `rangeM` away. */
function pair(rangeM: number, light: Light, cat: Catalog = catalog, seed = 1): { sim: Sim; obs: EntityId; med: EntityId } {
  const input: BattleInput = {
    map: flatMap("c", rangeM + 100, 200, 4), catalog: cat, seed, orders: [],
    ...(light === "night" ? { environment: environmentAt(cat, 3600, 0) } : {}),
    rules: { timeLimitSeconds: 900, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "none", physiologyParams: {}, objectives: [] },
    forces: [
      { side: "blue", faction: "ru", units: [{ key: "o", callsign: "O", echelon: "team", leaderIndex: 0, subunits: [], members: [man("obs", "ru-ak74m", "ru-ak74-mag", false)] }], placements: [{ personId: "obs", x: 20, y: 100, heading: 0 }] },
      { side: "red", faction: "de", units: [{ key: "m", callsign: "M", echelon: "team", leaderIndex: 0, subunits: [], members: [man("med", "de-g36", "de-g36-mag", true)] }], placements: [{ personId: "med", x: 20 + rangeM, y: 100, heading: Math.PI }] },
    ],
  };
  const sim = createSim(input);
  const ids = [...sim.state.identity.entries()];
  const obs = ids.find(([, i]) => i.side === "blue")![0], med = ids.find(([, i]) => i.side === "red")![0];
  for (const [id] of ids) sim.state.soldier.req(id).posture = "standing";
  sim.state.unit.req(sim.state.identity.req(med).unit).fireRule = "hold";
  sim.state.unit.req(sim.state.identity.req(obs).unit).fireRule = "free";
  if (light === "smoke") sim.state.smoke.push({ x: 20 + rangeM / 2, y: 100, radiusM: 2, startTick: -1200, untilTick: 900 * 60, gz: 0, topM: 6, burnS: 0 });
  return { sim, obs, med };
}

describe("laws of war: breaches (M10.7b)", () => {
  it("misidentification: the medic at 40 m is spared by day, fired at at night and through smoke (a breach with its circumstances)", () => {
    type Row = { shots: number; breaches: Extract<SimEvent, { kind: "law.breach" }>[]; radio: string[]; hits: number };
    const out = {} as Record<Light, Row>;
    for (const light of ["day", "night", "smoke"] as const) {
      const { sim, obs, med } = pair(40, light);
      const o: Row = { shots: 0, breaches: [], radio: [], hits: 0 };
      out[light] = o;
      run(sim, 60, (e) => {
        if (e.kind === "shot.fired" && e.shooter === obs) o.shots++;
        if (e.kind === "law.breach") o.breaches.push(e);
        if (e.kind === "law.hit" && e.target === med) { o.hits++; expect(e.aimed).toBe(true); expect(e.protection).toBe("medical"); }
        if (e.kind === "radio") o.radio.push(e.key);
      });
    }
    expect(out.day.shots).toBe(0);
    expect(out.day.breaches.length).toBe(0);
    for (const light of ["night", "smoke"] as const) {
      expect(out[light].shots, light).toBeGreaterThan(0);
      expect(out[light].breaches.length, light).toBe(1); // once per fire task
      const b = out[light].breaches[0]!;
      expect(b.cause).toBe("misidentified");
      expect(b.protection).toBe("medical");
      expect(b.side).toBe("blue");
      expect(b.ordered).toBe(false);
      expect(Math.abs(b.rangeM - 40)).toBeLessThan(3);
      if (light === "night") expect(b.light).toBeLessThan(0.3);
      else expect(b.smoke).toBeLessThan(0.9);
      // Nothing live (owner answer 7): no radio line about it.
      expect(out[light].radio.filter((k) => /law|breach|protect/i.test(k))).toEqual([]);
    }
  });

  it("the record keeps breaches with their circumstances (the review's source); nothing live in the string tables", () => {
    const { sim } = pair(40, "night");
    const rec = newBattleRecord(["blue", "red"]);
    for (let i = 0; i < 60 * TICK_HZ; i++) recordEvents(rec, step(sim), sim.state, catalog);
    const c = rec.sides["blue"]!.conduct;
    expect(c.misidentified).toBe(1);
    expect(c.breaches[0]).toMatchObject({ cause: "misidentified", protection: "medical", by: "obs", target: "med", ordered: false, vehicle: false });
    // No radio or notice string mentions breaches: they are review-only.
    for (const f of ["core/strings.en.json", "factions/de/strings.en.json", "factions/ru/strings.en.json"]) {
      const t = JSON.parse(readFileSync(new URL(`../../data/${f}`, import.meta.url), "utf8")) as Record<string, unknown>;
      const keys = Object.keys((t["strings"] as Record<string, unknown> | undefined) ?? t);
      expect(keys.filter((k) => k.startsWith("radio.") && /breach/i.test(k))).toEqual([]);
    }
  });

  it("deliberate breach chance: the data's base, raised by losses, low discipline and panic; the same for both sides", () => {
    const ctx = { catalog } as Parameters<typeof breachChance>[0];
    const base = breachChance(ctx, 0, 1, 0);
    expect(base).toBeCloseTo(P.breachBase, 10);
    expect(breachChance(ctx, P.breachLossesAt, 1, 0)).toBeCloseTo(P.breachBase * P.breachLossesK, 10);
    expect(breachChance(ctx, 1, 1, 0)).toBeCloseTo(P.breachBase * P.breachLossesK, 10); // full at breachLossesAt
    expect(breachChance(ctx, 0, 0, 0)).toBeCloseTo(P.breachBase * P.breachLowDisciplineK, 10);
    expect(breachChance(ctx, 0, 1, 1)).toBeCloseTo(P.breachBase * P.breachPanicK, 10);
    expect(breachChance(ctx, P.breachLossesAt / 2, 0.5, 0.5)).toBeGreaterThan(base);
    // Both sides: the same men (same skills, stress, losses) on either side have the same chance.
    const { sim, obs, med } = pair(40, "day");
    const a = sim.state.soldier.req(obs), b = sim.state.soldier.req(med);
    a.skills["experience"] = b.skills["experience"] = 0.3; a.mental.stress = b.mental.stress = 0.4;
    expect(ownLossShare(sim.state, obs)).toBe(ownLossShare(sim.state, med));
    expect(breachChanceOf(sim.ctx, sim.state, obs, a)).toBe(breachChanceOf(sim.ctx, sim.state, med, b));
  });

  it("deliberate breaches are drawn at the chance: near the base rate when calm, raised by losses and panic", () => {
    const rate = (stress: number): { got: number; want: number } => {
      const { sim, obs, med } = pair(40, "day");
      const s = sim.state.soldier.req(obs);
      s.skills["experience"] = 1; s.mental.stress = stress;
      const want = breachChanceOf(sim.ctx, sim.state, obs, s);
      let got = 0;
      const n = 4000;
      for (let i = 0; i < n; i++) { delete s.breachOn; delete s.conductTick; if (decideDeliberate(sim.ctx, sim.state, obs, s, med)) got++; }
      return { got: got / n, want };
    };
    const calm = rate(0), hard = rate(1);
    expect(calm.want).toBeCloseTo(P.breachBase, 10);
    expect(Math.abs(calm.got - calm.want)).toBeLessThan(0.006);
    expect(hard.want).toBeCloseTo(P.breachBase * P.breachPanicK, 10);
    expect(Math.abs(hard.got - hard.want)).toBeLessThan(0.008);
    expect(hard.got).toBeGreaterThan(calm.got);
  });

  it("a man who decides on a deliberate breach fires at a medic he has recognised (never when the chance is 0)", () => {
    const shotsWith = (breachBase: number): { shots: number; breaches: Extract<SimEvent, { kind: "law.breach" }>[] } => {
      const cat = structuredClone(catalog);
      cat.medical!.protection.breachBase = breachBase;
      const { sim, obs, med } = pair(30, "day", cat);
      let shots = 0;
      const breaches: Extract<SimEvent, { kind: "law.breach" }>[] = [];
      run(sim, 90, (e) => { if (e.kind === "shot.fired" && e.shooter === obs) shots++; if (e.kind === "law.breach") breaches.push(e); });
      if (breachBase === 0) expect(sim.state.soldier.req(obs).contacts.find((k) => k.target === med)?.marked).toBe(true);
      return { shots, breaches };
    };
    const never = shotsWith(0), always = shotsWith(1);
    expect(never.shots).toBe(0);
    expect(never.breaches.length).toBe(0);
    expect(always.shots).toBeGreaterThan(0);
    expect(always.breaches[0]).toMatchObject({ cause: "deliberate", protection: "medical", side: "blue" });
  });
});

describe("medic self-defence (M10.7b, owner answer 8)", () => {
  /** A red DE medic (armband) free to fire, and a blue rifleman `rangeM` away who holds his fire. */
  function medicFacing(rangeM: number): { sim: Sim; obs: EntityId; med: EntityId } {
    const { sim, obs, med } = pair(rangeM, "day");
    sim.state.unit.req(sim.state.identity.req(med).unit).fireRule = "free";
    sim.state.unit.req(sim.state.identity.req(obs).unit).fireRule = "hold";
    return { sim, obs, med };
  }
  it("at an enemy within selfDefenceM he fires and keeps his protection", () => {
    const { sim, med } = medicFacing(35);
    let shots = 0;
    run(sim, 40, (e) => { if (e.kind === "shot.fired" && e.shooter === med) shots++; });
    expect(shots).toBeGreaterThan(0);
    expect(protectionNow(catalog, sim.state, med) & PROT_MARKED).toBe(PROT_MARKED);
  });
  it("beyond it: not on his own nor on an AI order; on the player's order he fires and loses his protection", () => {
    const { sim, obs, med } = medicFacing(120);
    let shots = 0;
    run(sim, 30, (e) => { if (e.kind === "shot.fired" && e.shooter === med) shots++; });
    expect(shots).toBe(0);
    const unit = sim.state.identity.req(med).unit;
    submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: unit, kind: "fire", x: 20, y: 100, contact: obs } as Order);
    run(sim, 15, (e) => { if (e.kind === "shot.fired" && e.shooter === med) shots++; });
    expect(shots).toBe(0);
    expect(protectionNow(catalog, sim.state, med) & PROT_MARKED).toBe(PROT_MARKED);
    submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: unit, kind: "fire", x: 20, y: 100, contact: obs, player: true } as Order);
    run(sim, 15, (e) => { if (e.kind === "shot.fired" && e.shooter === med) shots++; });
    expect(shots).toBeGreaterThan(0);
    expect(protectionNow(catalog, sim.state, med)).toBe(0);
    // ... for medicFiredLosesProtectionS after his last shot.
    submitOrder(sim, { tick: sim.state.tick, issuer: "red", target: unit, kind: "ceaseFire" } as Order);
    run(sim, P.medicFiredLosesProtectionS + 5);
    expect(protectionNow(catalog, sim.state, med) & PROT_MARKED).toBe(PROT_MARKED);
  });
});
