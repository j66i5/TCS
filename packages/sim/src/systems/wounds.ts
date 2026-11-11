/**
 * HITS, ARMOUR AND WOUNDS (SPEC 6.4, 4.3 rule 10). A projectile that strikes a body zone meets the armour worn
 * there (items in the man's load with coverage and protection); if it gets through, a wound RECORD is added —
 * zone, mechanism, severity, bleeding, airway/breathing/consciousness effects. The physiology model then runs
 * on a clock. A casualty stays in the world as an entity; he is never deleted.
 */
import { interruptAction } from "../actions";
import type { SimContext } from "../context";
import type { EventSink } from "../events";
import { secondsToTicks, type EntityId } from "../ids";
import { canReport, isAble, updateImpairment } from "../impair";
import { unitSoldiers } from "./orders";
import { clamp, pow } from "../math";
import { nextFloat, nextNormal, Streams } from "../rng";
import type { SimState } from "../state";
import type { BodyZone, Wound } from "../wounds";

/** Zone groups in core/wounds.json; "arm" and "leg" become left or right by where the round struck. */
export const ZONE_GROUPS = ["head", "neck", "chest", "abdomen", "pelvis", "arm", "leg"] as const;

function zoneName(group: string, left: boolean): BodyZone {
  if (group === "arm") return left ? "armL" : "armR";
  if (group === "leg") return left ? "legL" : "legR";
  return group as BodyZone;
}

/**
 * A projectile has struck `target` in zone group `group`.
 * @param frontal true if it came from the front or back rather than the side
 * @param capacitySteelMm the round's penetration at impact, mm of steel
 * @param energyJ its kinetic energy at impact
 */
export function resolveBodyHit(
  ctx: SimContext, state: SimState, events: EventSink, target: EntityId, group: string, left: boolean, frontal: boolean,
  capacitySteelMm: number, energyJ: number, ammoId: string, owner: EntityId,
): void {
  const s = state.soldier.get(target);
  if (!s) return;
  const W = ctx.catalog.wounds, rng = state.rng;
  const zone = zoneName(group, left);

  // ---- armour worn over this zone: everything whose covered share includes the spot struck
  let protection = 0;
  const c = state.container.get(target);
  if (c) {
    const spot = nextFloat(rng, Streams.wounds);
    for (const st of c.stacks) {
      const def = ctx.catalog.items[st.type];
      if (!def?.armour) continue;
      for (const a of def.armour) {
        if (a.zone === group && spot < (frontal ? a.coverageFront : a.coverageSide)) protection += a.protectionSteelMm;
      }
    }
  }
  // A helmet is curved: many hits glance, which makes it thicker along the round's path.
  if (protection > 0 && group === "head") protection /= 0.25 + 0.75 * nextFloat(rng, Streams.wounds);

  if (protection > 0 && capacitySteelMm <= protection) {
    events.emit({ kind: "hit", tick: state.tick, target, zone, armour: "stopped", ammo: ammoId, owner });
    if (s.physiology.alive && energyJ > 200) {
      // Owner decision: knocked down for a few seconds, a minor blunt injury (pain, no bleeding).
      addWound(ctx, state, events, target, { zone, mechanism: "blunt", severity: W.wounding.bluntSeverity, bleedingLps: 0, compressible: true, airway: false, breathing: false, consciousness: false }, owner);
      s.stunnedUntilTick = Math.max(s.stunnedUntilTick, state.tick + secondsToTicks(W.wounding.knockdownSeconds));
      s.posture = "prone"; s.postureTo = null;
      interruptAction(state, events, target, "knocked-down"); // a reload in progress is broken off
    }
    return;
  }
  events.emit({ kind: "hit", tick: state.tick, target, zone, armour: protection > 0 ? "penetrated" : "none", ammo: ammoId, owner });
  if (!s.physiology.alive) return; // the dead are not wounded again
  const residual = protection > 0 ? energyJ * (1 - protection / capacitySteelMm) : energyJ;
  const zd = W.zones[group];
  if (!zd) return;
  const ef = clamp(pow(residual / W.wounding.referenceEnergyJ, W.wounding.energyExponent), W.wounding.energyFactorMin, W.wounding.energyFactorMax);
  const severity = clamp((zd.severityBase + zd.severitySpread * nextNormal(rng, Streams.wounds)) * ef, 0.03, 1);
  // Most wounds bleed far less than the worst case; a few strike a major vessel.
  const vessel = W.wounding.bleedFloor + (1 - W.wounding.bleedFloor) * pow(nextFloat(rng, Streams.wounds), W.wounding.bleedPower);
  addWound(ctx, state, events, target, {
    zone, mechanism: "bullet", severity,
    bleedingLps: zd.bleedLps * severity * vessel,
    compressible: zd.compressible,
    airway: zd.airway && severity >= W.wounding.flagSeverity,
    breathing: zd.breathing && severity >= W.wounding.flagSeverity,
    consciousness: severity >= zd.unconsciousAt,
  }, owner);
  if (severity >= zd.fatalAt) { s.physiology.alive = false; s.physiology.consciousness = 0; }
  else if (severity >= zd.unconsciousAt) s.physiology.consciousness = 0;
  refreshStatus(ctx, state, events, target);
}

type NewWound = Pick<Wound, "zone" | "mechanism" | "severity" | "bleedingLps" | "compressible" | "airway" | "breathing" | "consciousness">;

function addWound(ctx: SimContext, state: SimState, events: EventSink, target: EntityId, w: NewWound, source: EntityId): void {
  const s = state.soldier.req(target);
  const wound: Wound = { id: s.nextWoundId++, ...w, tickInflicted: state.tick, treatments: [] };
  if (source > 0) wound.source = source;
  s.wounds.push(wound);
  s.physiology.pain = Math.max(s.physiology.pain, w.severity);
  events.emit({ kind: "wound", tick: state.tick, soldier: target, woundId: wound.id, zone: w.zone, mechanism: w.mechanism, severity: w.severity });
  updateImpairment(ctx.catalog, s);
}

/** Recompute what the man can do; if he has just become a casualty, stop what he was doing and report it. */
export function refreshStatus(ctx: SimContext, state: SimState, events: EventSink, id: EntityId): void {
  const s = state.soldier.req(id);
  updateImpairment(ctx.catalog, s);
  const now = !s.physiology.alive ? "killed" : s.physiology.consciousness < 0.5 ? "incapacitated" : "none";
  if (now === s.casualty || (now === "none" && s.casualty !== "incapacitated")) return;
  if (now === "none") { // came round
    s.casualty = "none";
    if (s.mental.behaviour === "incapacitated") s.mental.behaviour = "steady";
    return;
  }
  const first = s.casualty === "none";
  s.casualty = now;
  s.mental.behaviour = "incapacitated";
  events.emit({ kind: "casualty", tick: state.tick, soldier: id, status: now });
  if (!first) return; // already down: died of his wounds
  // He drops where he is.
  const m = state.mover.get(id);
  if (m) { m.waypoints = []; m.speedMps = 0; m.formation = null; m.endPosture = null; m.endHeading = null; m.mode = null; }
  const hadTask = state.fire.has(id);
  state.fire.delete(id);
  interruptAction(state, events, id, "casualty");
  s.posture = "prone"; s.postureTo = null;
  // His unit: someone else leads if he led, and a comrade reports him down.
  const ident = state.identity.req(id);
  const unit = state.unit.get(ident.unit);
  if (unit) {
    // The next able man leads: one of the unit's own men first, else one from its sub-units.
    const able = (x: EntityId) => isAble(state.soldier.get(x));
    if (unit.leader === id) unit.leader = unit.members.find(able) ?? unitSoldiers(state, ident.unit).find(able) ?? null;
    let top = ident.unit;
    for (let p = state.unit.get(top)?.parent ?? null; p !== null; p = state.unit.get(top)?.parent ?? null) top = p;
    const all = unitSoldiers(state, top);
    const speaker = (x: EntityId) => x !== id && canReport(state.soldier.get(x));
    const from = unit.members.find(speaker) ?? all.find(speaker);
    if (from !== undefined) events.emit({ kind: "radio", tick: state.tick, side: ident.side, from, key: "radio.manDown", params: { callsign: unit.callsign, name: ident.family } });
    // If he was the last man firing, the unit's fire has ended.
    const tu = state.unit.req(top);
    if (hadTask && tu.firing && !all.some((m) => state.fire.has(m))) {
      tu.firing = false;
      events.emit({ kind: "fire.ceased", tick: state.tick, unit: top, reason: "unable" });
    }
  }
}

/** Physiology on its clock: every living wounded man deteriorates (or clots) every step. */
export function woundSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  const model = ctx.physiology;
  const params = ctx.physiologyParams;
  const every = Math.max(1, secondsToTicks(params["stepSeconds"] ?? 0.5));
  if (state.tick % every !== 0) return;
  const dt = every / secondsToTicks(1);
  for (const [id, s] of state.soldier.entries()) {
    if (s.wounds.length === 0 || !s.physiology.alive) continue;
    // Without a physiology model ("none") nothing bleeds, but pain still fades.
    if (model) model.step(s.physiology, s.wounds, dt, params);
    else s.physiology.pain = Math.max(0, s.physiology.pain - (params["painDecayPerS"] ?? 0) * dt);
    refreshStatus(ctx, state, events, id);
  }
}
