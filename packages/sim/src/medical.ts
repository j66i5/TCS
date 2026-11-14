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
import type { CareSkill, Catalog, InterventionDef, MedicalDef } from "./catalog";
import type { SoldierState } from "./components";
import type { DefId, EntityId } from "./ids";
import { secondsToTicks } from "./ids";
import type { SimState } from "./state";
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
