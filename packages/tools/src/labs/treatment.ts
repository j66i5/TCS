/**
 * TREATMENT LAB (M10.2, roadmap-detail slice 4): does care do what the data says?
 *
 * Part 1, the odds: for every intervention and every training that may perform it (self, buddy, first responder,
 * medic), 300 trials through the real "treat" action of a running battle: a casualty with a wound that needs exactly
 * that intervention, a man of that training beside him (or the casualty himself), the items in the casualty's kit.
 * Each trial starts the treatment as the medical system would (`planIntervention` + `startTreatment`), lets the
 * action run out and records whether it worked (`medical.treated`). Expected = the data's chance for that training
 * (self-aid: the buddy chance x `selfFactor`) x the item's success factor (x the stress factor under fire); time =
 * the data's time x the item's time factor (x `underFireTimeFactor` under fire). Extra rows: the tourniquet under
 * fire, and the Russian rubber tourniquet (x1.4 time, x0.8 success, owner Q-1d).
 *
 * Part 2, self-aid (acceptance): 300 men alone on open ground, each with one limb wound bleeding too fast to clot
 * by itself (drawn from core/wounds.json like a rifle hit), with their own kit. Dead by 10 minutes with care
 * against the same men with care switched off (`rules.medicalCare: false`). The plan's acceptance: self-applied
 * tourniquets cut those deaths to a third or less.
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import {
  createRng, createSim, DEFAULT_COMMS, EventSink, flatMap, healthyPhysiology, nextFloat, nextNormal, planIntervention, pow, startTreatment,
  step, type BattleInput, type CareSkill, type Catalog, type EntityId, type InterventionDef, type Sim, type SoldierRecord, type Wound,
} from "@tcs/sim";

export const TRIALS = 300;

export interface OddsRow {
  intervention: string; skill: CareSkill; item: string; underFire: boolean; trials: number;
  expectedP: number; measuredP: number; expectedS: number; measuredS: number;
}
export interface SelfAidRow { men: number; deadNoCare10: number; deadCare10: number; tourniquetOn: number; medianSecondsToTourniquet: number | null }

const baseWound = (extra: Partial<Wound>): Wound => ({
  id: 1, zone: "chest", mechanism: "bullet", severity: 0.4, bleedingLps: 0, compressible: false, airway: false, breathing: false,
  consciousness: false, tickInflicted: 0, treatments: [], ...extra,
});

/** A wound (and condition) that needs exactly this kind of care. */
function caseFor(treats: string): { wounds: Wound[]; shock?: number; pain?: number; access?: boolean } | null {
  switch (treats) {
    case "limb-bleed": return { wounds: [baseWound({ zone: "legL", bleedingLps: 0.005, compressible: true })] };
    case "junctional-bleed": return { wounds: [baseWound({ zone: "neck", bleedingLps: 0.005, compressible: true })] };
    case "compressible-bleed": return { wounds: [baseWound({ zone: "head", bleedingLps: 0.005, compressible: true })] };
    case "airway": return { wounds: [baseWound({ zone: "head", airway: true, compressible: true })] };
    case "open-chest": return { wounds: [baseWound({ breathing: true })] };
    case "tension": return { wounds: [baseWound({ tension: true })] };
    case "access": return { wounds: [baseWound({})], shock: 0.3 };
    case "volume": return { wounds: [baseWound({})], shock: 0.3, access: true };
    case "cold": return { wounds: [baseWound({})], shock: 0.3 };
    case "pain": return { wounds: [baseWound({})], pain: 0.8 };
    case "fracture": return { wounds: [baseWound({ zone: "legL", fracture: true })] };
    default: return null;
  }
}

const ROLE: Record<string, Record<CareSkill, string>> = {
  de: { self: "grenadier", buddy: "grenadier", firstResponder: "einsatzersthelfer", medic: "sanitaeter" },
  ru: { self: "rifleman", buddy: "rifleman", firstResponder: "strelok-sanitar", medic: "strelok-sanitar" },
};

/** An item of `faction` carrying `tag` (the first by id). */
function itemFor(catalog: Catalog, faction: string, tag: string): string | undefined {
  return Object.keys(catalog.items).sort().find((id) => id.startsWith(`${faction}-`) && catalog.items[id]!.medical?.tags.includes(tag));
}

function pairSim(catalog: Catalog, faction: string, skill: CareSkill, care: boolean, seed: number): { sim: Sim; casualty: EntityId; performer: EntityId } {
  const man = (personId: string, role: string): SoldierRecord => ({
    personId, given: "Lab", family: personId, rank: "r", role, skills: { marksmanship: 0.5, medical: catalog.medical!.care.skillRef },
    fatigue: 0, stress: 0, wounds: [], load: [], status: "fit",
  });
  const members = [man("c#1", ROLE[faction]!.self), ...(skill === "self" ? [] : [man("p#1", ROLE[faction]![skill])])];
  const input: BattleInput = {
    map: flatMap("treatment-lab", 100, 100, 4, "grass"), catalog, seed, orders: [],
    rules: { timeLimitSeconds: 36000, commsModel: "simple", comms: { ...DEFAULT_COMMS }, physiologyModel: "medical", physiologyParams: {}, objectives: [], medicalCare: care },
    forces: [{ side: "blue", faction, units: [{ key: "t", callsign: "T", echelon: "team", leaderIndex: 0, subunits: [], members }],
      placements: members.map((m, i) => ({ personId: m.personId, x: 50 + i, y: 50, heading: 0 })) }],
  };
  const sim = createSim(input);
  const idOf = new Map<string, EntityId>();
  for (const [id, ident] of sim.state.identity.entries()) idOf.set(ident.personId, id);
  const casualty = idOf.get("c#1")!;
  return { sim, casualty, performer: skill === "self" ? casualty : idOf.get("p#1")! };
}

/** One cell: `TRIALS` treatments through the real action. */
export function oddsCell(catalog: Catalog, faction: string, def: InterventionDef, skill: CareSkill, underFire: boolean, item?: string, trials = TRIALS): OddsRow | null {
  const cs = caseFor(def.treats);
  if (!cs) return null;
  const items = def.consumes.map((c) => (c.tag === def.consumes[0]?.tag && item ? item : itemFor(catalog, faction, c.tag)));
  if (items.some((x) => x === undefined)) return null;
  const { sim, casualty, performer } = pairSim(catalog, faction, skill, false, 1);
  const st = sim.state;
  let ok = 0, n = 0, ticks = 0;
  for (let t = 0; t < trials; t++) {
    // Fresh casualty, kit and helper for every trial.
    const s = st.soldier.req(casualty);
    s.wounds = cs.wounds.map((w) => ({ ...w, treatments: [] }));
    s.physiology = { ...healthyPhysiology(), shock: cs.shock ?? 0, pain: cs.pain ?? 0, ...(cs.access ? { access: true as const } : {}) };
    s.casualty = "none";
    st.container.req(casualty).stacks = items.map((type, i) => ({ type: type!, count: def.consumes[i]!.count })).sort((a, b) => (a.type < b.type ? -1 : 1));
    // (Merge duplicates: two needs of the same item type.)
    const merged = new Map<string, number>();
    for (const x of st.container.req(casualty).stacks) merged.set(x.type, (merged.get(x.type) ?? 0) + x.count);
    st.container.req(casualty).stacks = [...merged].map(([type, count]) => ({ type, count }));
    const ps = st.soldier.req(performer);
    ps.mental.suppression = underFire ? 1 : 0; ps.mental.stress = 0;
    st.action.delete(performer);
    const plan = planIntervention(catalog, st, performer, casualty, def.id, underFire, sim.ctx.physiologyParams);
    if (!plan || plan.skill !== skill) return null;
    startTreatment(sim.ctx, st, new EventSink(), performer, casualty, plan, underFire);
    ticks += plan.durationTicks;
    // Run the action out: jump to its last tick, then one real step completes it (check, items, roll, effect).
    st.action.req(performer).startTick = st.tick - plan.durationTicks;
    for (const e of step(sim)) if (e.kind === "medical.treated" && e.casualty === casualty) { n++; if (e.success) ok++; }
  }
  const im = catalog.items[item ?? items[0]!]?.medical;
  const base = skill === "self" ? (def.success.self ?? (def.success.buddy ?? 0) * def.selfFactor) : (def.success[skill] ?? 0);
  const expectedP = Math.min(1, base * (im?.successFactor ?? 1) * (underFire ? def.stressFactor : 1));
  const expectedS = (def.timeS[skill] ?? 0) * (im?.timeFactor ?? 1) * (underFire ? def.underFireTimeFactor : 1);
  return { intervention: def.id, skill, item: item ?? items[0]!, underFire, trials: n, expectedP, measuredP: n > 0 ? ok / n : 0, expectedS, measuredS: ticks / trials / 60 };
}

export function oddsLab(data: DataSet, trials = TRIALS): OddsRow[] {
  const catalog = buildCatalog(data, ["de", "ru"]);
  const M = catalog.medical!;
  const rows: OddsRow[] = [];
  for (const id of M.care.order) {
    const def = M.interventions[id]!;
    for (const skill of ["self", "buddy", "firstResponder", "medic"] as CareSkill[]) {
      if (def.timeS[skill] === undefined) continue;
      // (Interventions only in the Russian kit, such as the pain syringe, are tried with the Russian roles.)
      const faction = def.consumes.every((c) => itemFor(catalog, "de", c.tag) !== undefined) ? "de" : "ru";
      const r = oddsCell(catalog, faction, def, skill, false, undefined, trials);
      if (r) rows.push(r);
    }
  }
  const tq = M.interventions["tourniquet"]!;
  for (const skill of ["self", "buddy"] as CareSkill[]) {
    const r = oddsCell(catalog, "de", tq, skill, true, undefined, trials);
    if (r) rows.push(r);
  }
  const rubber = itemFor(catalog, "ru", "tourniquet");
  for (const skill of ["self", "buddy"] as CareSkill[]) {
    const r = oddsCell(catalog, "ru", tq, skill, false, rubber, trials);
    if (r) rows.push(r);
  }
  return rows;
}

/** Part 2: self-applied tourniquets on major limb bleeds, care against no care. */
export function selfAidLab(data: DataSet, men = TRIALS): SelfAidRow {
  const catalog = buildCatalog(data, ["de", "ru"]);
  const W = catalog.wounds, k = { ...W.physiology };
  const rng = createRng(4242);
  const wounds: Wound[] = [];
  while (wounds.length < men) {
    const leg = nextFloat(rng, "lab") < 0.6;
    const zd = W.zones[leg ? "leg" : "arm"]!;
    const severity = Math.min(1, Math.max(0.03, zd.severityBase + zd.severitySpread * nextNormal(rng, "lab")));
    const vessel = W.wounding.bleedFloor + (1 - W.wounding.bleedFloor) * pow(nextFloat(rng, "lab"), W.wounding.bleedPower);
    const bleed = zd.bleedLps * severity * vessel;
    if (bleed < k["clotBelowLps"]!) continue; // only bleeds that do not stop by themselves
    wounds.push(baseWound({ zone: leg ? "legL" : "armR", severity, bleedingLps: bleed, compressible: true }));
  }
  const load = [
    { type: "de-tourniquet-cat", count: 1 }, { type: "de-pressure-dressing", count: 2 }, { type: "de-hemostatic-gauze", count: 1 },
    { type: "de-rescue-blanket", count: 1 }, { type: "de-pain-tablets", count: 1 },
  ];
  const run = (care: boolean) => {
    const recs: SoldierRecord[] = wounds.map((w, i) => ({
      personId: `m#${i}`, given: "Lab", family: `m${i}`, rank: "r", role: "grenadier", skills: { marksmanship: 0.5, medical: catalog.medical!.care.skillRef },
      fatigue: 0, stress: 0, wounds: [{ ...w, treatments: [] }], load: load.map((x) => ({ ...x })), status: "wounded",
    }));
    const input: BattleInput = {
      map: flatMap("selfaid-lab", 200, 200, 4, "grass"), catalog, seed: 7, orders: [],
      rules: { timeLimitSeconds: 36000, commsModel: "simple", comms: { ...DEFAULT_COMMS }, physiologyModel: "medical", physiologyParams: {}, objectives: [], medicalCare: care },
      forces: [{ side: "blue", faction: "de", units: [{ key: "t", callsign: "T", echelon: "team", leaderIndex: 0, subunits: [], members: recs }],
        // 10 m apart: nobody within reach of another (self-aid only).
        placements: recs.map((m, i) => ({ personId: m.personId, x: 5 + (i % 19) * 10, y: 5 + Math.floor(i / 19) * 10, heading: 0 })) }],
    };
    const sim = createSim(input);
    const firstTq: number[] = [];
    const seen = new Set<EntityId>();
    for (let t = 0; t < 600 * 60; t++) {
      for (const e of step(sim)) if (e.kind === "medical.treated" && e.intervention === "tourniquet" && e.success && !seen.has(e.casualty)) { seen.add(e.casualty); firstTq.push(e.tick / 60); }
    }
    let dead = 0;
    for (const [, s] of sim.state.soldier.entries()) if (!s.physiology.alive) dead++;
    firstTq.sort((a, b) => a - b);
    return { dead, tq: seen.size, median: firstTq.length > 0 ? firstTq[Math.floor(firstTq.length / 2)]! : null };
  };
  const off = run(false), on = run(true);
  return { men, deadNoCare10: off.dead, deadCare10: on.dead, tourniquetOn: on.tq, medianSecondsToTourniquet: on.median };
}

export function treatmentLabMarkdown(rows: OddsRow[], self: SelfAidRow): string {
  const pc = (x: number) => `${(100 * x).toFixed(0)} %`;
  const out = [
    `Part 1: ${TRIALS} treatments per row through the real "treat" action (one casualty, one man of that training or the casualty himself, the item in the casualty's kit, medical skill at the reference value, no stress). Expected = core/medical.json.`, "",
    "| intervention | by | item | under fire | trials | success expected | success measured | time expected (s) | time measured (s) |",
    "|---|---|---|---|---:|---:|---:|---:|---:|",
  ];
  for (const r of rows) out.push(`| ${r.intervention} | ${r.skill} | ${r.item ?? "–"} | ${r.underFire ? "yes" : "no"} | ${r.trials} | ${pc(r.expectedP)} | ${pc(r.measuredP)} | ${r.expectedS.toFixed(1)} | ${r.measuredS.toFixed(1)} |`);
  out.push("", `Part 2: ${self.men} men alone, each with one limb wound bleeding too fast to clot by itself, own kit (one CAT tourniquet, two dressings).`, "",
    "| | dead by 10 min |", "|---|---:|",
    `| no care (\`medicalCare: false\`) | ${self.deadNoCare10} (${pc(self.deadNoCare10 / self.men)}) |`,
    `| self-aid | ${self.deadCare10} (${pc(self.deadCare10 / self.men)}) |`,
    "", `Tourniquet on (worked) for ${self.tourniquetOn} of ${self.men} men; median ${self.medianSecondsToTourniquet === null ? "–" : self.medianSecondsToTourniquet.toFixed(0)} s after the start. Acceptance: deaths with self-aid at most a third of those without.`);
  return out.join("\n");
}
