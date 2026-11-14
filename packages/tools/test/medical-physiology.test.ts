/**
 * M10.1 medical data and the new physiology (roadmap-detail slice 3): one test per condition of the "medical"
 * physiology model, the data (roles, kits, the item factors), and save/load of a battle that runs it.
 * Nobody treats anyone yet (M10.2): these are the untreated courses.
 */
import { describe, expect, it } from "vitest";
import { buildCatalog } from "@tcs/data";
import {
  amputationChance, createSim, deserializeState, hashState, healthyPhysiology, loadSim, medicalPhysiology, saveSim,
  serializeState, simplePhysiology, step, submitOrder, updateImpairment, type Physiology, type PhysiologyEnv, type SerializedState, type Wound,
} from "@tcs/sim";
import { getScenario, loadData } from "../src/scenarios";

const data = loadData(true);
const catalog = buildCatalog(data, ["de", "ru", "xf"]);
const K: Record<string, number> = { ...catalog.wounds.physiology, ...catalog.medical!.physiology };

const wound = (extra: Partial<Wound> = {}): Wound => ({
  id: 1, zone: "chest", mechanism: "bullet", severity: 0.4, bleedingLps: 0, compressible: false, airway: false, breathing: false,
  consciousness: false, tickInflicted: 0, treatments: [], ...extra,
});
/** Run the medical model; returns when he passed out and died (seconds, -1 = not within the time). */
function course(wounds: Wound[], seconds: number, env?: PhysiologyEnv, p: Physiology = healthyPhysiology()) {
  let out = -1, dead = -1;
  for (let t = 0; t < seconds; t += 0.5) {
    medicalPhysiology.step(p, wounds, 0.5, K, env);
    if (out < 0 && p.consciousness < 0.5) out = t;
    if (dead < 0 && !p.alive) dead = t;
  }
  return { p, out, dead };
}

describe("the medical physiology model, untreated (M10.1)", () => {
  it("tension pneumothorax: nothing until the onset, then dead about tensionDeathS later", () => {
    const w = wound({ tensionInS: 300 });
    const r = course([w], 1800);
    expect(w.tension).toBe(true);
    expect(w.tensionInS).toBeUndefined();
    expect(r.dead).toBeGreaterThan(300 + 0.9 * K["tensionDeathS"]!);
    expect(r.dead).toBeLessThan(300 + 1.1 * K["tensionDeathS"]!);
    // The same wound without one: he lives.
    expect(course([wound()], 1800).p.alive).toBe(true);
  });

  it("head injury: conscious through the lucid interval, then out (alive)", () => {
    const w = wound({ zone: "head", headInS: 200 });
    const r = course([w], 600);
    expect(r.out).toBeGreaterThanOrEqual(199);
    expect(r.out).toBeLessThan(202);
    expect(r.p.alive).toBe(true);
    expect(w.consciousness).toBe(true);
  });

  it("burns lose plasma: volume falls at burnFluidLps per unit of severity; nothing for other wounds", () => {
    const r = course([wound({ mechanism: "burn", severity: 0.5 })], 600);
    expect(5 - r.p.bloodVolumeL).toBeCloseTo(K["burnFluidLps"]! * 0.5 * 600, 3);
    expect(course([wound()], 600).p.bloodVolumeL).toBe(5);
  });

  it("fluids: an infusion runs in over about 10 minutes and restores part of the lost volume, never above normal", () => {
    const p: Physiology = { ...healthyPhysiology(), bloodVolumeL: 3.5, fluidL: 0.5 };
    course([wound()], 900, undefined, p);
    expect(p.fluidL).toBeUndefined();
    expect(p.bloodVolumeL).toBeCloseTo(3.5 + 0.5 * K["fluidVolumeFactor"]!, 3);
    const full: Physiology = { ...healthyPhysiology(), fluidL: 0.5 };
    course([wound()], 900, undefined, full);
    expect(full.bloodVolumeL).toBe(5);
  });

  it("hypothermia: a man in shock cools, faster wet and windy, far slower aboard or wrapped; a healthy wounded man does not", () => {
    const shocked = (): Physiology => ({ ...healthyPhysiology(), bloodVolumeL: 3.6 }); // 28 % lost: in shock, conscious
    const cold: PhysiologyEnv = { temperatureC: 0, rain: 0, windMps: 0, sheltered: false };
    const drop = (env: PhysiologyEnv, p = shocked()) => { course([wound()], 3600, env, p); return 37 - (p.coreTempC ?? 37); };
    const dry = drop(cold), wet = drop({ ...cold, rain: 1, windMps: 15 }), aboard = drop({ ...cold, sheltered: true });
    const wrapped = drop(cold, { ...shocked(), warmed: true });
    expect(dry).toBeGreaterThan(0.5);
    expect(wet).toBeGreaterThan(2 * dry);
    expect(aboard).toBeLessThan(0.5 * dry);
    expect(wrapped).toBeLessThan(0.5 * dry);
    expect(drop(cold, healthyPhysiology())).toBe(0);
    // Below hypoC a small bleed clots more slowly, and a smaller loss kills.
    const clot = (t: number) => { const w = wound({ zone: "legL", bleedingLps: 0.0015 }); course([w], 300, { ...cold, temperatureC: t }, { ...healthyPhysiology(), coreTempC: t }); return w.bleedingLps; };
    expect(clot(33)).toBeGreaterThan(clot(36.5));
    const lethal: Physiology = { ...healthyPhysiology(), bloodVolumeL: 5 * (1 - K["deathLossFraction"]! + 0.04), coreTempC: 32 };
    expect(course([wound()], 1, cold, lethal).p.alive).toBe(false); // 4 points short of the normal lethal loss, but 3 degrees cold
  });

  it("tourniquet clock: time on the limb is counted; no limb lost within the safe time, then a rising chance", () => {
    const w = wound({ zone: "legL", tourniquetS: 0 });
    course([w], 600);
    expect(w.tourniquetS).toBeCloseTo(600, 6);
    expect(amputationChance(K["ischaemiaSafeS"]!, K)).toBe(0);
    expect(amputationChance(K["ischaemiaMidS"]!, K)).toBeCloseTo(K["ischaemiaMidChance"]!, 9);
    expect(amputationChance((K["ischaemiaSafeS"]! + K["ischaemiaMidS"]!) / 2, K)).toBeGreaterThan(0);
    expect(amputationChance(1e6, K)).toBe(K["ischaemiaLateChance"]);
  });

  it("broken bones: a small leg wound with a fracture stops him walking, an arm fracture stops him using his rifle", () => {
    const s = createSim(getScenario("shootout").build(data, 1, 10)).state;
    const [, man] = [...s.soldier.entries()][0]!;
    man.wounds = [wound({ zone: "legL", severity: 0.1 })];
    updateImpairment(catalog, man);
    expect(man.impair.canWalk).toBe(true);
    man.wounds[0]!.fracture = true;
    updateImpairment(catalog, man);
    expect(man.impair.canWalk).toBe(false);
    man.wounds = [wound({ zone: "armR", severity: 0.1, fracture: true })];
    updateImpairment(catalog, man);
    expect(man.impair.canUseArms).toBe(false);
    expect(man.impair.canWalk).toBe(true);
  });

  it("conditions are rolled when the wound is made: chest -> tension, head -> lucid interval, limb -> fracture", () => {
    const always = () => 0, never = () => 0.999;
    const c = wound(); medicalPhysiology.onWound!(c, always, K);
    expect(c.tensionInS).toBe(K["tensionOnsetMinS"]);
    const h = wound({ zone: "head", severity: 0.2 }); medicalPhysiology.onWound!(h, always, K);
    expect(h.headInS).toBe(K["headOnsetMinS"]);
    const l = wound({ zone: "legR", severity: 0.3 }); medicalPhysiology.onWound!(l, always, K);
    expect(l.fracture).toBe(true);
    const n = wound({ zone: "legR", severity: 0.3 }); medicalPhysiology.onWound!(n, never, K);
    expect(n.fracture).toBeUndefined();
    // Blunt, blast and burn wounds roll nothing.
    const b = wound({ mechanism: "blast" }); medicalPhysiology.onWound!(b, always, K);
    expect(b.tensionInS).toBeUndefined();
  });

  it("the simple model ignores every new field (the foundations clock is unchanged)", () => {
    const a = healthyPhysiology(), b = healthyPhysiology();
    const w1 = wound({ zone: "legL", bleedingLps: 0.01 }), w2 = wound({ zone: "legL", bleedingLps: 0.01, tensionInS: 10, fracture: true, tourniquetS: 5 });
    for (let t = 0; t < 600; t += 0.5) { simplePhysiology.step(a, [w1], 0.5, K); simplePhysiology.step(b, [w2], 0.5, K); }
    expect(b).toEqual(a);
    expect(w2.tensionInS).toBe(10);
  });
});

describe("medical data (M10.1)", () => {
  it("roles, kits and item factors: one first responder per German Gruppe, a marked Sanitäter in the Zug HQ, one Russian rifleman-medic per platoon", () => {
    const de = data.factions["de"]!, ru = data.factions["ru"]!;
    const medRole = (pack: typeof de, role: string) => pack.roles[role]?.medical?.level;
    const count = (pack: typeof de, t: string, level: string): number => {
      const u = pack.units[t]!;
      return u.members.filter((m) => medRole(pack, m.role) === level).length + u.subunits.reduce((n, s) => n + count(pack, s, level), 0);
    };
    expect(count(de, "pzgren-schuetzentrupp", "firstResponder")).toBe(1);
    expect(de.units["pzgren-schuetzentrupp"]!.members.length).toBe(6); // no extra man
    expect(count(de, "pzgren-zug", "medic")).toBe(1);
    expect(count(de, "pzgren-zug", "firstResponder")).toBe(3);
    const san = de.units["pzgren-zug"]!.members.find((m) => medRole(de, m.role) === "medic")!;
    expect(san.load.some((l) => catalog.items[l.item]?.emblem === true)).toBe(true);
    expect(count(ru, "motor-rifle-platoon", "firstResponder")).toBe(1);
    expect(count(ru, "motor-rifle-platoon", "medic")).toBe(0);
    expect(ru.units["motor-rifle-squad-1"]!.members.length).toBe(ru.units["motor-rifle-squad"]!.members.length);
    // Owner: the Russian rubber tourniquet and haemostatic powder are slower and less reliable (item data).
    expect(catalog.items["ru-tourniquet-rubber"]!.medical).toEqual({ tags: ["tourniquet"], timeFactor: 1.4, successFactor: 0.8 });
    expect(catalog.items["de-tourniquet-cat"]!.medical).toEqual({ tags: ["tourniquet"], timeFactor: 1, successFactor: 1 });
    // Skills per national training (Q-1b): the Russian rifleman-medic does dressings and tourniquets, no needle or IV.
    expect(catalog.factions["ru"]!.medicalRoles!["strelok-sanitar"]!.interventions).not.toContain("iv-access");
    expect(catalog.factions["de"]!.medicalRoles!["einsatzersthelfer"]!.interventions).toContain("iv-access");
    expect(catalog.factions["xf"]!.medicalRoles!["boss"]!.level).toBe("firstResponder");
  });

  it("the first-aid kit placeholder became its counted contents at the same mass (0.6 kg)", () => {
    for (const f of ["de", "ru"]) {
      const sq = data.factions[f]!.units[f === "de" ? "pzgren-schuetzentrupp" : "motor-rifle-squad"]!;
      const m = sq.members[1]!; // a man without a medical bag
      const kit = m.load.filter((l) => l.item === `${f}-ifak` || catalog.items[l.item]?.medical !== undefined);
      expect(kit.reduce((kg, l) => kg + catalog.items[l.item]!.massKg * l.count, 0)).toBeCloseTo(0.6, 9);
    }
  });

  it("every intervention's consumed tags are carried by a real faction's items; nothing claims high confidence", () => {
    const tags = new Set(Object.values(catalog.items).flatMap((i) => i.medical?.tags ?? []));
    for (const v of data.medical!.interventions) {
      expect(v.confidence).not.toBe("high");
      for (const c of v.consumes) expect(tags.has(c.tag), `${v.id}: ${c.tag}`).toBe(true);
    }
  });
});

describe("battles with the medical model (M10.1)", () => {
  function run(sc: string, seed: number, seconds: number, onTick?: (tick: number, sim: ReturnType<typeof createSim>) => void) {
    const s = getScenario(sc);
    const input = s.build(data, seed, seconds);
    const sim = createSim(input);
    const ctrls = s.controllers?.(input) ?? [];
    for (let i = 0; i < seconds * 60; i++) {
      for (const c of ctrls) for (const o of c.think(sim.state, sim.state.tick)) submitOrder(sim, o);
      step(sim);
      onTick?.(sim.state.tick, sim);
    }
    return { sim, input };
  }

  it("scenarios run it by default; wounds made in battle carry the rolled conditions; save and load mid-battle keeps the hash", () => {
    let saved: SerializedState | null = null;
    const { sim, input } = run("shootout", 1, 150, (t, s) => { if (t === 90 * 60) saved = JSON.parse(JSON.stringify(saveSim(s))) as SerializedState; });
    expect(input.rules.physiologyModel).toBe("medical");
    const wounds = [...sim.state.soldier.values()].flatMap((s) => s.wounds);
    expect(wounds.length).toBeGreaterThanOrEqual(3);
    expect(sim.state.rng.streams["conditions"]).toBeDefined();
    // The same battle from the save at 90 s ends on the same hash.
    const again = loadSim(input, saved!);
    const ctrls = getScenario("shootout").controllers!(input);
    while (again.state.tick < 150 * 60) {
      for (const c of ctrls) for (const o of c.think(again.state, again.state.tick)) submitOrder(again, o);
      step(again);
    }
    expect(hashState(again.state)).toBe(hashState(sim.state));
  });

  it("a schema-17 save (before M10.1) still loads; an older one is refused", () => {
    const { sim } = run("shootout", 2, 5);
    const s = serializeState(sim.state);
    const old = { ...s, schema: 17 } as SerializedState;
    expect(hashState(deserializeState(old))).toBe(hashState(deserializeState(s)));
    expect(() => deserializeState({ ...s, schema: 16 } as SerializedState)).toThrow(/schema 16/);
  });

  it("the fixture faction (xf) battle runs with the medical model", () => {
    const { sim, input } = run("demo-fixture", 1, 60);
    expect(input.rules.physiologyModel).toBe("medical");
    expect(sim.state.tick).toBe(60 * 60);
  });

  it("the medical model needs core/medical.json", () => {
    const input = getScenario("shootout").build(data, 1, 5);
    const { medical: _m, ...bare } = input.catalog;
    expect(() => createSim({ ...input, catalog: bare })).toThrow(/medical/);
  });
});
