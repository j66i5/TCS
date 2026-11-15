/**
 * LAWS OF WAR: BREACHES, SELF-DEFENCE AND HITS ON PROTECTED PEOPLE (SPEC 9.1, M10.7b).
 *
 * Owner answers (2026-11-14, binding): both sides try to keep the laws of war but may fail — mostly honest mistakes
 * (a red cross not seen at range, at night, in smoke, under stress), rarely a deliberate breach by a panicked,
 * vengeful or poorly disciplined man, more likely after own losses (answer 5); the same rules for both sides, from unit
 * data only (never a faction); medics are armed for self-defence and lose protection only when they fight otherwise
 * (answer 8); breaches are shown in the after-action review, never live (answer 7); an order to fire at a recognised
 * protected target is refused (Q-7, `protection.ts`), so an ordered breach can only be a misidentification; incidental
 * hits on protected people are a separate list in the review (Q-8).
 *
 * - `law.breach` "misidentified": a man (or a hull's gunner) fires at an enemy who IS protected now (an emblem, a
 *   marked ambulance, a carrying party, a man at the Verwundetennest) whom he has not recognised. Checked where the
 *   rounds leave (every two seconds of a fire task at a named enemy, once per task), with the circumstances: range,
 *   light, smoke on the line, his stress, whether it was ordered.
 * - `law.breach` "deliberate": a man on foot who sees an enemy he knows to be protected or giving up decides, at most
 *   once per `breachCheckS`, with chance `breachChance` (unit quality as his experience, his stress, his platoon's
 *   losses), to fire at him for `breachHoldS`. Crews do not: a crew decides together, one man saying "ambulance" holds
 *   the gun (decided without the owner).
 * - `law.hit`: a protected man (or marked ambulance) hit by enemy fire, aimed at him or not (incidental): the review's
 *   separate list.
 * - Self-defence: a man wearing an emblem fires on his own (and on a drill's or the AI's task) only within
 *   `selfDefenceM`; a shot within it costs no protection. Beyond it he fires only on the player's order, and that shot
 *   costs his protection for `medicFiredLosesProtectionS` (`SoldierState.protLostTick`). Anyone else loses it with any
 *   shot (a bearer or a wounded man at the nest who fires is back in the fight).
 */
import type { SimContext } from "./context";
import type { Contact, FireTask, SoldierState } from "./components";
import type { EventSink } from "./events";
import { secondsToTicks, type EntityId } from "./ids";
import { clamp, hypot2 } from "./math";
import { protectedContact, protectionNow, wearsEmblem, PROT_CARRYING, PROT_MARKED, PROT_POINT } from "./protection";
import { nextFloat, Streams } from "./rng";
import { smokePhysics, smokeTransmission } from "./smoke";
import type { SimState } from "./state";

/** How often fire at a named enemy is checked for a breach while it goes on (s). */
const LAW_CHECK_S = 2;

export type BreachProtection = "medical" | "carrying" | "point" | "surrendered";
export type HitProtection = BreachProtection | "wounded" | "prisoner";

/** The kind of protection from PROT_* bits (the first that applies), or null. */
function kindOf(bits: number): "medical" | "carrying" | "point" | null {
  if ((bits & PROT_MARKED) !== 0) return "medical";
  if ((bits & PROT_CARRYING) !== 0) return "carrying";
  if ((bits & PROT_POINT) !== 0) return "point";
  return null;
}

/** Is his deliberate breach on `target` going on now? */
export function breachActive(s: SoldierState, target: EntityId | undefined, tick: number): boolean {
  return s.breachOn !== undefined && s.breachOn.target === target && tick < s.breachOn.untilTick;
}

/** The share of his platoon (his unit's parent with all its men; his unit if it has none) that is down, dead or taken. */
export function ownLossShare(state: SimState, id: EntityId): number {
  const u0 = state.identity.get(id)?.unit;
  if (u0 === undefined) return 0;
  const root = state.unit.get(u0)?.parent ?? u0;
  let n = 0, lost = 0;
  const walk = (u: EntityId): void => {
    const unit = state.unit.get(u);
    if (!unit) return;
    for (const m of unit.members) {
      const s = state.soldier.get(m);
      if (!s) continue;
      n++;
      if (!s.physiology.alive || s.casualty !== "none" || s.captive !== null) lost++;
    }
    for (const c of unit.children) walk(c);
  };
  walk(root);
  return n > 0 ? lost / n : 0;
}

/**
 * The chance of a deliberate breach at one decision (owner answer 5): `breachBase` for a calm, fully disciplined man
 * of a platoon without losses, raised by own losses (full at `breachLossesAt`), low discipline (1 − experience) and
 * panic (stress). Inputs only: no side, no faction.
 */
export function breachChance(ctx: SimContext, lossShare: number, experience: number, stress: number): number {
  const P = ctx.catalog.medical?.protection;
  if (!P) return 0;
  const loss = clamp(lossShare / P.breachLossesAt, 0, 1);
  return clamp(P.breachBase
    * (1 + (P.breachLossesK - 1) * loss)
    * (1 + (P.breachLowDisciplineK - 1) * (1 - clamp(experience, 0, 1)))
    * (1 + (P.breachPanicK - 1) * clamp(stress, 0, 1)), 0, 1);
}

/** `breachChance` for this man now. */
export function breachChanceOf(ctx: SimContext, state: SimState, id: EntityId, s: SoldierState): number {
  return breachChance(ctx, ownLossShare(state, id), s.skills["experience"] ?? 0.5, s.mental.stress);
}

/** May he be the target of a deliberate breach as this man knows him: recognised as protected, or giving up (not one
 *  known to be down: a man lying hit may be dead). */
export function breachCandidate(c: Contact): boolean {
  return c.down !== true && c.cls !== "vehicle" && (protectedContact(c) || c.surrendered === true);
}

/**
 * A man on foot free to fire on his own sees `candidate` (the nearest enemy he knows to be protected or giving up,
 * found in his target choice). At most once per `breachCheckS` he decides whether to fire at him anyway. Returns true
 * when he now does (`breachOn` set).
 */
export function decideDeliberate(ctx: SimContext, state: SimState, id: EntityId, s: SoldierState, candidate: EntityId): boolean {
  const P = ctx.catalog.medical?.protection;
  if (!P || P.breachBase <= 0) return false;
  if (s.breachOn !== undefined) {
    if (state.tick < s.breachOn.untilTick) return false;
    delete s.breachOn;
  }
  if (s.conductTick !== undefined && state.tick - s.conductTick < secondsToTicks(P.breachCheckS)) return false;
  const es = state.soldier.get(candidate);
  if (!es || !es.physiology.alive || es.casualty !== "none" || es.captive?.state === "captured") return false;
  s.conductTick = state.tick;
  if (nextFloat(state.rng, Streams.conduct) >= breachChanceOf(ctx, state, id, s)) return false;
  s.breachOn = { target: candidate, untilTick: state.tick + secondsToTicks(P.breachHoldS) };
  return true;
}

/**
 * Fire is leaving at `task.contact` (a man's task, or a hull's station task with `vehicle`): every two seconds, and
 * once per task, a breach is recorded if that enemy is protected now — "deliberate" when it is his breach, else
 * "misidentified" when none of `crew` (the shooter, or the hull's crew) recognised him (one who had would have held
 * his fire: the task would have stopped).
 */
export function noteFireAt(ctx: SimContext, state: SimState, events: EventSink, shooter: EntityId, task: Pick<FireTask, "contact" | "lawTick" | "breached">, ordered: boolean, vehicle?: EntityId, crew?: readonly EntityId[]): void {
  if (ctx.catalog.medical === undefined || task.contact === undefined || task.breached === true) return;
  if (task.lawTick !== undefined && state.tick < task.lawTick) return;
  task.lawTick = state.tick + secondsToTicks(LAW_CHECK_S);
  const target = task.contact, s = state.soldier.get(shooter);
  if (!s) return;
  let cause: "misidentified" | "deliberate", prot: BreachProtection | null;
  if (breachActive(s, target, state.tick)) {
    cause = "deliberate";
    const es = state.soldier.get(target);
    prot = kindOf(protectionNow(ctx.catalog, state, target)) ?? (es?.captive !== null && es?.captive !== undefined ? "surrendered" : null);
  } else {
    prot = kindOf(protectionNow(ctx.catalog, state, target));
    if (prot === null) return;
    for (const m of crew ?? [shooter]) {
      const c = state.soldier.get(m)?.contacts.find((k) => k.target === target);
      if (c !== undefined && protectedContact(c)) return; // known: the fire stops (not a mistake)
    }
    cause = "misidentified";
  }
  if (prot === null) return;
  task.breached = true;
  const from = state.transform.get(vehicle ?? shooter), to = state.transform.get(target);
  const side = state.identity.get(shooter)?.side;
  if (!from || !to || side === undefined) return;
  const smoke = state.smoke.length > 0 ? smokeTransmission(state, smokePhysics(ctx.catalog), from.x, from.y, from.z + 1.6, to.x, to.y, to.z + 1) : 1;
  events.emit({
    kind: "law.breach", tick: state.tick, side, by: shooter, target, cause, protection: prot, rangeM: hypot2(to.x - from.x, to.y - from.y),
    light: state.environment.light, smoke, stress: Math.max(s.mental.stress, s.mental.suppression), ordered, ...(vehicle !== undefined ? { vehicle } : {}),
  });
}

/**
 * A shot by `id` at (x, y) (rule 9 of owner answer 8): for a man wearing an emblem, a shot within `selfDefenceM` is
 * self-defence; any other shot of his, and every shot of anyone else, starts the time his protection is lost.
 */
export function noteShot(ctx: SimContext, state: SimState, id: EntityId, s: SoldierState, x: number, y: number): void {
  const P = ctx.catalog.medical?.protection;
  if (!P) return;
  const t = state.transform.get(id);
  if (t && hypot2(x - t.x, y - t.y) <= P.selfDefenceM && wearsEmblem(ctx.catalog, state, id)) return;
  s.protLostTick = state.tick;
}

/** Fire by a man wearing an emblem at (x, y) that is not his to take on (his own choice, a drill's or the AI's task):
 *  beyond `selfDefenceM`. */
export function beyondSelfDefence(ctx: SimContext, state: SimState, id: EntityId, x: number, y: number): boolean {
  const P = ctx.catalog.medical?.protection;
  if (!P) return false;
  const t = state.transform.get(id);
  return t !== undefined && hypot2(x - t.x, y - t.y) > P.selfDefenceM && wearsEmblem(ctx.catalog, state, id);
}

/**
 * A hit on `target` (a man, or a hull with `vehicle`) by `owner`'s fire (Q-8): if he is protected now — an emblem,
 * a marked ambulance, a carrying party, at the nest, wounded out of action, giving up or held prisoner — and of the
 * enemy side, a `law.hit` is recorded: `aimed` when the shooter's fire was at him, else incidental.
 */
export function noteHit(ctx: SimContext, state: SimState, events: EventSink, target: EntityId, owner: EntityId, fragment: boolean): void {
  if (ctx.catalog.medical === undefined) return;
  const side = state.identity.get(owner)?.side;
  const tside = state.identity.get(target)?.side ?? state.vehicle.get(target)?.side;
  if (side === undefined || tside === undefined || side === tside) return;
  let prot: HitProtection | null = null;
  const s = state.soldier.get(target);
  if (s) {
    if (!s.physiology.alive) return;
    if (s.captive !== null) prot = s.captive.state === "captured" ? "prisoner" : "surrendered";
    else if (s.casualty !== "none") prot = "wounded";
    else if (s.carrying !== undefined || s.atNest !== undefined || wearsEmblem(ctx.catalog, state, target)) prot = kindOf(protectionNow(ctx.catalog, state, target));
  } else if (state.vehicle.has(target)) {
    const v = state.vehicle.get(target)!;
    if (ctx.catalog.vehicles[v.def]?.ambulance?.marked === true) prot = kindOf(protectionNow(ctx.catalog, state, target));
  }
  if (prot === null) return;
  let aimed = state.fire.get(owner)?.contact === target;
  const om = state.soldier.get(owner)?.mount;
  if (!aimed && om !== undefined) { const ov = state.vehicle.get(om.vehicle); if (ov) for (const st of ov.stations) if (st.task?.contact === target) aimed = true; }
  events.emit({ kind: "law.hit", tick: state.tick, side, by: owner, target, protection: prot, aimed, fragment });
}
