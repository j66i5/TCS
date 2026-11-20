/**
 * SERVICE TALLY (M12.0a, `rules.campaignOut` only): what each man goes through in a battle, for the campaign's
 * experience and stress history (SPEC 9.3: "experience grows a little per battle and more under fire"). Write-only:
 * no system reads it, so a battle runs the same with or without it (only the state hash differs).
 *
 * Once a second every living man on the map: a second under effective fire (his suppression at least
 * `SERVICE_FIRE_SUPPRESSION`), a second in contact (he knows an enemy), his peak shock and strain. Every tick: the
 * rounds he fired (`shot.fired` events, his weapon or the vehicle station he serves). Wounds and the start's shock and
 * strain come from the input records at the end (`serviceOut`).
 */
import type { BattleInput, ServiceTally } from "./battle";
import type { SimContext } from "./context";
import type { SimEvent } from "./events";
import { TICK_HZ } from "./ids";
import { isOffMapMan, isAssetUnit } from "./offmap";
import type { SimState } from "./state";

/** M12.0a (game value, confidence low): the suppression from which a man counts as under effective fire (the care
 *  rules' "under fire" level, core/medical.json `care.underFireSuppression`). */
export const SERVICE_FIRE_SUPPRESSION = 0.1;

export function serviceSystem(_ctx: SimContext, state: SimState, events: readonly SimEvent[]): void {
  for (const e of events) {
    if (e.kind !== "shot.fired") continue;
    const s = state.soldier.get(e.shooter);
    if (s) (s.service ??= blank()).roundsFired++;
  }
  if (state.tick % TICK_HZ !== 0) return;
  // mounted: ok (a man aboard is in the battle too: his hull is fired on, he sees the enemy through its sights)
  for (const [, s] of state.soldier.entries()) {
    if (!s.physiology.alive || isOffMapMan(state, s)) continue;
    const t = (s.service ??= blank());
    if (s.mental.suppression >= SERVICE_FIRE_SUPPRESSION) t.underFireS++;
    if (s.contacts.length > 0) t.contactS++;
    if (s.mental.stress > t.peakShock) t.peakShock = s.mental.stress;
    if (s.mental.strain > t.peakStrain) t.peakStrain = s.mental.strain;
  }
}

const blank = () => ({ underFireS: 0, contactS: 0, roundsFired: 0, peakShock: 0, peakStrain: 0 });

/** `BattleResult.service`: every man of the forces in the state (not the off-map assets' crews), by `personId`. */
export function serviceOut(state: SimState, input: BattleInput): Record<string, ServiceTally> {
  const rec = new Map<string, { wounds: number; stress: number; strain: number }>();
  const walk = (u: BattleInput["forces"][number]["units"][number]) => { for (const m of u.members) rec.set(m.personId, { wounds: m.wounds.length, stress: m.stress, strain: m.strain ?? 0 }); u.subunits.forEach(walk); };
  for (const f of input.forces) f.units.forEach(walk);
  const out: Record<string, ServiceTally> = {};
  // mounted: ok (every man of the forces, aboard or not)
  for (const [id, ident] of state.identity.entries()) {
    if (isAssetUnit(state, ident.unit)) continue;
    const s = state.soldier.req(id), t = s.service ?? blank(), r = rec.get(ident.personId);
    out[ident.personId] = {
      underFireS: t.underFireS, contactS: t.contactS, roundsFired: t.roundsFired,
      wounds: Math.max(0, s.wounds.length - (r?.wounds ?? 0)),
      peakShock: Math.max(t.peakShock, r?.stress ?? 0, s.mental.stress), peakStrain: Math.max(t.peakStrain, r?.strain ?? 0, s.mental.strain),
    };
  }
  return out;
}
