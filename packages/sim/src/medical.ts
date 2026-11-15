/**
 * CARE OF THE WOUNDED: WHAT IS DONE NEXT, BY WHOM, WITH WHAT (SPEC 9.1, M10.2).
 *
 * Pure questions about a casualty and a man who could treat him (himself: self-aid; a comrade: buddy aid; later a
 * first responder or a medic): which intervention comes next in MARCH order (massive bleeding, airway, respiration,
 * circulation, hypothermia; then pain and splints), whether this man is trained for it, which items it uses (the
 * casualty's own kit first, then the helper's), how long it takes and how likely it is to work. The treat action
 * (systems/medical.ts) performs it. Everything here is generic: training levels, items and numbers are data
 * (core/medical.json, roles.json `medical`, items' `medical` tags); no faction appears in code.
 */
import type { CareSkill, CarryMethodDef, Catalog, InterventionDef, MedicalDef } from "./catalog";
import type { SoldierState } from "./components";
import type { DefId, EntityId } from "./ids";
import { secondsToTicks } from "./ids";
import type { DeepReadonly, SimState } from "./state";
import type { Physiology, Wound } from "./wounds";

const LIMBS = new Set(["armL", "armR", "legL", "legR"]);

/** Items an intervention takes: `count` of `type` from the container of `from`. */
export interface CareItem { type: DefId; count: number; from: EntityId }

/** A treatment worked out before it starts. */
export interface CarePlan {
  intervention: DefId;
  /** The wound it is for (whole-body care, such as fluids or pain relief, is recorded on the worst wound). */
  wound: number;
  skill: CareSkill;
  items: CareItem[];
  durationTicks: number;
  /** Chance it works. */
  p: number;
}

/** The training a man treats with when he performs `def` (null: he cannot). The casualty himself is "self". */
export function careSkillFor(catalog: Catalog, state: SimState, performer: EntityId, casualty: EntityId, def: InterventionDef): CareSkill | null {
  if (performer === casualty) return def.timeS.self !== undefined ? "self" : null;
  const M = catalog.medical!;
  const ident = state.identity.get(performer);
  const role = ident ? catalog.factions[ident.faction]?.medicalRoles?.[ident.role] : undefined;
  if (role) {
    const skill = M.levels[role.level].skill;
    // A role trained narrower than its level (national training, owner Q-1b) falls back to what every soldier knows.
    if (def.timeS[skill] !== undefined && (role.interventions === undefined || role.interventions.includes(def.id))) return skill;
  }
  return def.timeS.buddy !== undefined ? "buddy" : null;
}

/** Is this a bleed too large to clot by itself (life-threatening)? */
export function majorBleed(w: Wound, params: Readonly<Record<string, number>>): boolean {
  return w.bleedingLps > 0 && w.bleedingLps >= (params["clotBelowLps"] ?? 0);
}

function succeeded(w: Wound, id: DefId): boolean {
  for (const t of w.treatments) if (t.intervention === id && t.success) return true;
  return false;
}
function attempts(w: Wound, id: DefId): number {
  let n = 0;
  for (const t of w.treatments) if (t.intervention === id) n++;
  return n;
}
/** A treatment of this kind (`treats`) has already worked on any of his wounds. */
function treatedBefore(M: MedicalDef, wounds: readonly Wound[], treats: string): boolean {
  for (const w of wounds) for (const t of w.treatments) if (t.success && M.interventions[t.intervention]?.treats === treats) return true;
  return false;
}

/** The wound recorded for whole-body care: the most severe (lowest id on a tie). */
function worstWound(wounds: readonly Wound[]): Wound | undefined {
  let best: Wound | undefined;
  for (const w of wounds) if (!best || w.severity > best.severity) best = w;
  return best;
}

/**
 * The wound this intervention would treat now, or undefined if he does not need it. `conscious`: the casualty is
 * awake (pain relief is for the conscious). Attempts already used up on a wound do not count.
 */
export function woundNeeding(M: MedicalDef, def: InterventionDef, wounds: readonly Wound[], p: Physiology, conscious: boolean, params: Readonly<Record<string, number>>): Wound | undefined {
  const C = M.care;
  const open = (w: Wound) => !succeeded(w, def.id) && attempts(w, def.id) < C.maxAttempts;
  // Bleeds: the one bleeding fastest first.
  const bleeding = (ok: (w: Wound) => boolean): Wound | undefined => {
    let best: Wound | undefined;
    for (const w of wounds) if (majorBleed(w, params) && w.compressible && ok(w) && open(w) && (!best || w.bleedingLps > best.bleedingLps)) best = w;
    return best;
  };
  const first = (ok: (w: Wound) => boolean): Wound | undefined => {
    for (const w of wounds) if (ok(w) && open(w)) return w;
    return undefined;
  };
  const body = (need: boolean): Wound | undefined => {
    if (!need) return undefined;
    const w = worstWound(wounds);
    return w && attempts(w, def.id) < C.maxAttempts ? w : undefined;
  };
  const e = def.effect;
  switch (def.treats) {
    case "limb-bleed": return bleeding((w) => LIMBS.has(w.zone) && w.tourniquetS === undefined);
    case "junctional-bleed": return bleeding((w) => C.junctionalZones.includes(w.zone));
    // (A limb with a tourniquet on bleeds no more; a dressing is the fallback when there is no tourniquet.)
    case "compressible-bleed": return bleeding((w) => w.tourniquetS === undefined);
    case "airway": return first((w) => w.airway && (e.airwayFactor ?? 1) < (w.airwayK ?? 1));
    // An open chest wound (penetrating): a seal. (Blast lung and burns are not sealed.)
    case "open-chest": return first((w) => w.breathing && w.zone === "chest" && (w.mechanism === "bullet" || w.mechanism === "fragment") && (e.breathingFactor ?? 1) < (w.breathingK ?? 1));
    case "tension": return first((w) => w.tension === true);
    case "fracture": return first((w) => w.fracture === true && w.splinted !== true);
    case "access": return body(p.shock > 0 && p.access !== true);
    case "volume": return body(p.shock > 0 && p.access === true && !(p.fluidL !== undefined && p.fluidL > 0));
    case "cold": return body(p.shock > 0 && p.warmed !== true);
    case "pain": return body(conscious && p.pain >= C.painTreatAt && !treatedBefore(M, wounds, "pain"));
    // Re-checking and converting a tourniquet are the medic's (M10.5).
    default: return undefined;
  }
}

/** Items for `def` from the casualty's kit first, then the helper's; null if either lacks them. */
export function careItems(catalog: Catalog, state: SimState, performer: EntityId, casualty: EntityId, def: InterventionDef): CareItem[] | null {
  const out: CareItem[] = [];
  for (const need of def.consumes) {
    let found: CareItem | null = null;
    for (const who of performer === casualty ? [casualty] : [casualty, performer]) {
      const c = state.container.get(who);
      if (!c) continue;
      for (const st of c.stacks) {
        if (st.count < need.count) continue;
        // (The same stack is not counted twice for two needs of one intervention.)
        const taken = out.reduce((n, x) => n + (x.type === st.type && x.from === who ? x.count : 0), 0);
        if (st.count - taken < need.count) continue;
        if (catalog.items[st.type]?.medical?.tags.includes(need.tag)) { found = { type: st.type, count: need.count, from: who }; break; }
      }
      if (found) break;
    }
    if (!found) return null;
    out.push(found);
  }
  return out;
}

/**
 * Time and chance of a treatment: the data's time and chance for his training (self-aid: the buddy chance times
 * `selfFactor`), the items' factors (a slower, less reliable tourniquet), stress and fire, and his own skill.
 */
export function careOdds(catalog: Catalog, def: InterventionDef, skill: CareSkill, items: readonly CareItem[], performer: SoldierState, underFire: boolean): { seconds: number; p: number } {
  const C = catalog.medical!.care;
  let timeK = 1, successK = 1;
  for (const it of items) {
    const m = catalog.items[it.type]?.medical;
    if (!m) continue;
    timeK = Math.max(timeK, m.timeFactor);
    successK = Math.min(successK, m.successFactor);
  }
  const base = skill === "self" ? (def.success.self ?? (def.success.buddy ?? 0) * def.selfFactor) : (def.success[skill] ?? 0);
  const stress = Math.max(underFire ? 1 : 0, Math.min(1, performer.mental.stress));
  const own = 1 + C.skillK * ((performer.skills["medical"] ?? C.skillRef) - C.skillRef);
  const p = Math.min(1, Math.max(0, base * successK * (1 - (1 - def.stressFactor) * stress) * own));
  const seconds = (def.timeS[skill] ?? 0) * timeK * (underFire ? def.underFireTimeFactor : 1);
  return { seconds, p };
}

/**
 * The next treatment `performer` gives `casualty`, in MARCH order (core/medical.json `care.order`): the first
 * intervention the casualty needs that this man is trained for and has the items for; under fire only those allowed
 * under fire. Null: nothing he can do now.
 */
export function nextIntervention(catalog: Catalog, state: SimState, performer: EntityId, casualty: EntityId, underFire: boolean, params: Readonly<Record<string, number>>): CarePlan | null {
  const M = catalog.medical;
  if (!M) return null;
  for (const id of M.care.order) {
    const plan = planIntervention(catalog, state, performer, casualty, id, underFire, params);
    if (plan) return plan;
  }
  return null;
}

/**
 * One intervention as `performer` would give it to `casualty` now: null if the casualty does not need it, the man is
 * not trained for it, the items are missing, or it is not allowed under fire.
 */
export function planIntervention(catalog: Catalog, state: SimState, performer: EntityId, casualty: EntityId, id: DefId, underFire: boolean, params: Readonly<Record<string, number>>): CarePlan | null {
  const M = catalog.medical;
  const s = state.soldier.get(casualty), ps = state.soldier.get(performer);
  const def = M?.interventions[id];
  if (!M || !def || !s || !ps || !s.physiology.alive || s.wounds.length === 0) return null;
  if (underFire && !def.underFire) return null;
  const w = woundNeeding(M, def, s.wounds, s.physiology, s.physiology.consciousness >= 0.5, params);
  if (!w) return null;
  const skill = careSkillFor(catalog, state, performer, casualty, def);
  if (skill === null) return null;
  const items = careItems(catalog, state, performer, casualty, def);
  if (items === null) return null;
  const { seconds, p } = careOdds(catalog, def, skill, items, ps, underFire);
  return { intervention: id, wound: w.id, skill, items, durationTicks: Math.max(1, secondsToTicks(seconds)), p };
}

/** What a treatment that worked does to the casualty (the intervention's `effect`). */
export function applyCareEffect(def: InterventionDef, w: Wound, p: Physiology): void {
  const e = def.effect;
  if (e.bleedFactor !== undefined) w.bleedingLps *= e.bleedFactor;
  if (e.tourniquet === true) w.tourniquetS = 0;
  else if (e.tourniquet === false) delete w.tourniquetS;
  if (e.painAdd !== undefined) p.pain = Math.min(1, p.pain + e.painAdd);
  if (e.painRelief !== undefined) p.pain = Math.max(0, p.pain - e.painRelief);
  if (e.airwayFactor !== undefined) w.airwayK = Math.min(w.airwayK ?? 1, e.airwayFactor);
  if (e.breathingFactor !== undefined) w.breathingK = Math.min(w.breathingK ?? 1, e.breathingFactor);
  if (e.decompress === true) { delete w.tension; delete w.tensionInS; }
  if (e.access === true) p.access = true;
  if (e.fluidL !== undefined) p.fluidL = (p.fluidL ?? 0) + e.fluidL;
  if (e.warms === true) p.warmed = true;
  if (e.splints === true) w.splinted = true;
}

/**
 * What a casualty needs, whoever treats him (M10.3a): null if nothing in `care.order` is needed now; `urgent` when
 * one of the needs is in `carers.urgentTreats` (he looks T1: massive bleeding, airway, breathing, shock). Training
 * and kit are not asked here (the carer's own `nextIntervention` is).
 */
export function careNeed(catalog: Catalog, state: SimState, casualty: EntityId, params: Readonly<Record<string, number>>): { urgent: boolean } | null {
  const M = catalog.medical, s = state.soldier.get(casualty);
  if (!M || !s || !s.physiology.alive || s.wounds.length === 0) return null;
  const urgentTreats = M.carers?.urgentTreats ?? [];
  const conscious = s.physiology.consciousness >= 0.5;
  let need = false;
  for (const id of M.care.order) {
    const def = M.interventions[id];
    if (!def || !woundNeeding(M, def, s.wounds, s.physiology, conscious, params)) continue;
    if (urgentTreats.includes(def.treats)) return { urgent: true };
    need = true;
  }
  return need ? { urgent: false } : null;
}

/**
 * Is he to be taken to the Verwundetennest (M10.5)? A living, uncaptured wounded man who is out of the fight
 * (incapacitated, cannot walk or cannot fight), or whom the player ordered back.
 */
export function needsEvacuation(s: DeepReadonly<SoldierState>): boolean {
  return s.physiology.alive && s.captive === null && s.wounds.length > 0
    && (s.evacOrdered === true || s.casualty === "incapacitated" || !s.impair.canWalk || !s.impair.canFight);
}

/** Is this man a first responder or a medic by his role (data: `medicalRoles`)? He answers urgent casualties. */
export function isResponder(catalog: Catalog, state: SimState, id: EntityId): boolean {
  const ident = state.identity.get(id);
  const lvl = ident ? catalog.factions[ident.faction]?.medicalRoles?.[ident.role]?.level : undefined;
  return lvl === "firstResponder" || lvl === "medic" || lvl === "ambulanceCrew"; // (review fix: an ambulance medic on foot, e.g. after a bail-out)
}

/**
 * His true triage category now (M10.3b; core/medical.json `triage`): 1 immediate (T1) when he needs one of
 * `immediateTreats`, his shock is at `immediateShock` or more, or he is barely conscious; 2 delayed (T2) when he
 * cannot walk or needs any other care; 3 minimal (T3) otherwise (walking wounded).
 */
export function trueTriage(catalog: Catalog, state: SimState, casualty: EntityId, params: Readonly<Record<string, number>>): 1 | 2 | 3 {
  const M = catalog.medical, s = state.soldier.get(casualty);
  if (!M || !s) return 3;
  const T = M.triage, p = s.physiology;
  if (p.shock >= T.immediateShock || p.consciousness < T.immediateConsciousness) return 1;
  const conscious = p.consciousness >= 0.5;
  let other = false;
  for (const id of M.care.order) {
    const def = M.interventions[id];
    if (!def || !woundNeeding(M, def, s.wounds, p, conscious, params)) continue;
    if (T.immediateTreats.includes(def.treats)) return 1;
    other = true;
  }
  return other || !s.impair.canWalk ? 2 : 3;
}

/**
 * The tag a man gives (M10.3b): the true category, or with chance `errorChance[skill]` (+ `underFireAdd` under fire)
 * one category off — T1 and T3 can only go to T2; T2 goes to T1 or T3 by `u2`. `u1`, `u2`: draws in [0, 1).
 */
export function triageTag(catalog: Catalog, actual: 1 | 2 | 3, skill: CareSkill, underFire: boolean, u1: number, u2: number): 1 | 2 | 3 {
  const T = catalog.medical!.triage;
  const err = Math.min(1, (T.errorChance[skill] ?? T.errorChance.buddy ?? 0) + (underFire ? T.underFireAdd : 0));
  if (u1 >= err) return actual;
  if (actual !== 2) return 2;
  return u2 < 0.5 ? 1 : 3;
}

/** Training levels from lowest to highest (a higher level re-triages a lower one's tag). */
export const SKILL_RANK: Readonly<Record<CareSkill, number>> = { self: 0, buddy: 1, firstResponder: 2, medic: 3 };

/**
 * The life-threatening needs he has now that care can answer (M10.3b; the batch counts a death after one of these as
 * preventable): any of `triage.immediateTreats` (massive bleeding, airway, breathing), whoever treats him.
 */
export function lifeThreatNeed(catalog: Catalog, state: SimState, casualty: EntityId, params: Readonly<Record<string, number>>): boolean {
  const M = catalog.medical, s = state.soldier.get(casualty);
  if (!M || !s || !s.physiology.alive || s.wounds.length === 0) return false;
  const conscious = s.physiology.consciousness >= 0.5;
  for (const id of M.care.order) {
    const def = M.interventions[id];
    if (def && M.triage.immediateTreats.includes(def.treats) && woundNeeding(M, def, s.wounds, s.physiology, conscious, params)) return true;
  }
  return false;
}

/**
 * The way to carry a casualty (M10.4a; pure): of the data's carry methods those `carriers` men can do (enough of
 * them; a litter among them if it needs one), with the casualty walking himself when he can (`walks`: awake, legs
 * that carry him; `move`: his own pace factor from his wounds) or lying when he cannot, and under fire only methods
 * that keep everyone low. The fastest (a walking method at the casualty's own pace), then the one that lasts
 * longest before a rest, then the one needing fewer carriers, then by id. Null: none possible.
 */
export function chooseCarryMethod(catalog: Catalog, carriers: number, walks: boolean, move: number, underFire: boolean, hasLitter: boolean): DefId | null {
  const C = catalog.medical?.carry;
  if (!C) return null;
  let best: DefId | null = null, bestV = -1, bestE = -1, bestN = Infinity;
  for (const id of Object.keys(C).sort()) {
    const d = C[id]!;
    if (d.carriers > carriers || (d.casualtyWalks === true) !== walks) continue;
    if (d.needsTag !== undefined && !hasLitter) continue;
    if (underFire && d.upright && !d.casualtyWalks) continue;
    const v = d.carriers === 0 ? d.speedMps * move : d.speedMps;
    if (v > bestV + 1e-9 || (Math.abs(v - bestV) <= 1e-9 && (d.enduranceM > bestE || (d.enduranceM === bestE && d.carriers < bestN)))) {
      best = id; bestV = v; bestE = d.enduranceM; bestN = d.carriers;
    }
  }
  return best;
}

/** Where the payload and the other carriers go on the leader's trail (m behind him), by method (M10.4a). */
export function carryLayout(def: CarryMethodDef): { payloadM: number; followersM: number[] } {
  if (def.carriers === 0) return { payloadM: 0, followersM: [] };
  if (def.carriers === 1) return { payloadM: def.upright ? (def.casualtyWalks ? 0.5 : 0) : 0.9, followersM: [] };
  if (def.carriers === 2) return def.upright ? { payloadM: 0.6, followersM: [1.2] } : { payloadM: 0.9, followersM: [0.4] };
  // A litter: two carriers at the head, two at the foot, the casualty between them.
  const out: number[] = [];
  for (let i = 1; i < def.carriers; i++) out.push(i < def.carriers / 2 ? 0.3 * i : 1.9 + 0.3 * (i - Math.ceil(def.carriers / 2)));
  return { payloadM: 1.1, followersM: out };
}

/**
 * Down, state unknown (owner request 2026-11-15): a dead man his side has not checked since he died. To his comrades
 * he is a casualty like any other until one of them has checked him (the `checkDown` action). Without `down` data the
 * dead are known dead at once (old data sets).
 */
export function downUnknown(catalog: Catalog, s: DeepReadonly<SoldierState>): boolean {
  return catalog.medical?.down !== undefined && !s.physiology.alive && s.checked?.dead !== true;
}

/**
 * The identity tags a comrade can take from a man (owner request 2026-11-15; faction data `identityTag`): all he
 * carries beyond what stays with the body (`perMan` - `taken`: the half that stays on a German tag; nothing of a
 * Russian one). Null: none left, or his faction has no tags.
 */
export function tagsLeft(catalog: Catalog, state: SimState, id: EntityId): { item: DefId; count: number } | null {
  const ident = state.identity.get(id), g = ident ? catalog.factions[ident.faction]?.identityTag : undefined;
  const c = state.container.get(id);
  if (!g || !c || catalog.medical?.down === undefined) return null;
  let n = 0;
  for (const st of c.stacks) if (st.type === g.item) n += st.count;
  n -= g.perMan - g.taken;
  return n > 0 ? { item: g.item, count: n } : null;
}
