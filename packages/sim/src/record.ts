/**
 * BATTLE RECORD (D2, roadmap-detail slice 10): what happened in a battle, folded from its event stream alone (rule 5:
 * the after-action review and the batch tool read events, never internals), as plain data. The app's review and the
 * batch report both use it, so they cannot disagree.
 *
 * It is a fold, not a function of the whole stream: `recordEvents` takes each tick's events with the state after that
 * tick (names, sides and callsigns are read from it at that moment, as the review always did), and `finishRecord`
 * adds the result. Keeping every event of a 40-minute battle to fold them at the end would cost far more memory.
 * Nothing here holds text: timeline entries carry string-table keys and raw values; the app turns them into words.
 * The record is JSON (it goes into the app's save game) and deterministic per seed.
 */
import type { Catalog } from "./catalog";
import type { BattleEndReason, SimEvent } from "./events";
import { tallyExpenditure, type Expenditure } from "./expenditure";
import { ticksToSeconds, type EntityId } from "./ids";
import type { SimView } from "./state";

/** Bump when the record's shape changes: an app save with another version starts a fresh record. */
export const RECORD_VERSION = 3;

/**
 * One line of the review's timeline. `key` is the string-table key; the other fields are raw values for its
 * parameters (side ids, a soldier's family name, a unit's callsign, an objective id, a status or end reason).
 */
export interface TimelineEntry {
  tick: number;
  /** The side whose colour the line takes (null: neither, e.g. the battle's end). */
  side: string | null;
  key: string;
  name?: string;
  callsign?: string;
  /** `casualty`: incapacitated or killed. */
  status?: string;
  objective?: string;
  /** `timeline.ended`: the end reason and the side that lost by breaking or being wiped out. */
  reason?: string;
  loser?: string;
  /** Vehicle lines: the crew's callsign (or the hull's roster id). */
  vehicle?: string;
}

/** Per side: counts from the events (care counts by the casualty's side; missiles and mortar by the firing side). */
export interface SideRecord {
  /** Game tick of the side's first dismount (M7.2), or null. */
  firstDismountTick: number | null;
  /** Crews (M7.4b): reversed out, fires started, fires put out. */
  crews: { reversedOut: number; fires: number; firesOut: number };
  /** Guided missiles fired by the side's hulls and how they ended; enemy hulls penetrated by its missiles and by its
   *  shoulder-fired rockets. */
  missiles: { fired: number; hit: number; lost: number; miss: number; penetrated: number; rocketPenetrated: number };
  /** Mortar fire called by the side: HE bursts, ranging rounds, enemy men wounded in a tick with one of its bursts,
   *  and of them put out of action. */
  mortar: { bursts: number; ranging: number; enemyWounded: number; enemyDown: number };
  /** Care (M10.2): treatments finished by the casualty himself and by others, of them worked, men treated at least
   *  once, tourniquets that worked. */
  care: { self: number; buddy: number; worked: number; men: number; tourniquets: number };
  /** Carers sent (M10.3a): comrades and first responders or medics. */
  carers: { comrades: number; responders: number };
  /** Triage tags (M10.3b) by the tagger's training, and of them wrong. */
  tags: Record<string, number>;
  wrongTags: Record<string, number>;
  /** Drags to cover started and finished (M10.3b); carrying parties by method, metres carried, times a party took
   *  cover (M10.4a); casualties lifted into and carried out of vehicles (M10.4b). */
  drags: number;
  dragsDone: number;
  carries: Record<string, number>;
  carriedM: number;
  holds: number;
  loaded: number;
  unloaded: number;
  /** The Verwundetennest (M10.5): nests sited and moved; casualties sent back with bearers and walking, arrived,
   *  returned to duty from it. */
  nest: { sited: number; moved: number; tasked: number; walks: number; arrived: number; returned: number };
  /** Re-triage (M10.5): tags given again where the last tag was wrong, and of them now right. */
  retriage: { wrongRetagged: number; corrected: number };
  /** Ambulance runs (M10.6a): called (by the player), came onto the map, reached the nest, men taken aboard, gone
   *  off the map; seconds from each call to its arrival at the nest; men evacuated and seconds from each one's first
   *  wound to his leaving the map. */
  amb: { called: number; ordered: number; cancelled: number; entered: number; arrived: number; loaded: number; away: number; callToArriveS: number[]; evacuated: number; woundToEvacS: number[] };
}

export interface BattleRecord {
  v: number;
  timeline: TimelineEntry[];
  /** Heat map: shots as x, y, side index triples (capped), falls and wrecks the same. */
  heatShots: number[];
  heatFalls: number[];
  /** Ammunition used per side (M7.3). */
  exp: Expenditure;
  sides: Record<string, SideRecord>;
  /** Casualty id -> tick of his first finished treatment (the Medical tab and the batch's time to first care). */
  firstTreated: Record<string, number>;
  /** Casualty id -> his last triage tag and the true category then (M10.5: was it wrong?). */
  lastTag: Record<string, [number, number]>;
  /** Casualty id -> tick he first reached a Verwundetennest (M10.5). */
  atNest: Record<string, number>;
  /** Ambulance id -> tick of its current call (M10.6a; the time to its arrival). Casualty id -> tick he was evacuated. */
  ambCall: Record<string, number>;
  evacuated: Record<string, number>;
  /** Filled by `finishRecord`. */
  end: { tick: number; reason: BattleEndReason; winner: string | null; loser: string | null } | null;
}

/** Shots kept for the heat map (x, y, side per shot): about 100 000 shots. */
const HEAT_SHOTS_MAX = 300000;

export function newSideRecord(): SideRecord {
  return {
    firstDismountTick: null,
    crews: { reversedOut: 0, fires: 0, firesOut: 0 },
    missiles: { fired: 0, hit: 0, lost: 0, miss: 0, penetrated: 0, rocketPenetrated: 0 },
    mortar: { bursts: 0, ranging: 0, enemyWounded: 0, enemyDown: 0 },
    care: { self: 0, buddy: 0, worked: 0, men: 0, tourniquets: 0 },
    carers: { comrades: 0, responders: 0 },
    tags: {}, wrongTags: {},
    drags: 0, dragsDone: 0, carries: {}, carriedM: 0, holds: 0, loaded: 0, unloaded: 0,
    nest: { sited: 0, moved: 0, tasked: 0, walks: 0, arrived: 0, returned: 0 }, retriage: { wrongRetagged: 0, corrected: 0 },
    amb: { called: 0, ordered: 0, cancelled: 0, entered: 0, arrived: 0, loaded: 0, away: 0, callToArriveS: [], evacuated: 0, woundToEvacS: [] },
  };
}

/** An empty record for a battle between these sides. */
export function newBattleRecord(sides: readonly string[]): BattleRecord {
  return { v: RECORD_VERSION, timeline: [], heatShots: [], heatFalls: [], exp: {}, sides: Object.fromEntries(sides.map((s) => [s, newSideRecord()])), firstTreated: {}, lastTag: {}, atNest: {}, ambCall: {}, evacuated: {}, end: null };
}

/** A record read back from a save, or null if it is from another version (the review then starts afresh). */
export function readRecord(x: unknown): BattleRecord | null {
  const r = x as Partial<BattleRecord> | null | undefined;
  return r && typeof r === "object" && r.v === RECORD_VERSION && Array.isArray(r.timeline) && r.sides ? (r as BattleRecord) : null;
}

/** Fold one tick's events into the record; `view` is the state after that tick. */
export function recordEvents(rec: BattleRecord, events: readonly SimEvent[], view: SimView, catalog: Catalog): void {
  if (events.length === 0) return;
  tallyExpenditure(rec.exp, events, view, catalog);
  const sideIdx = (side: string) => Math.max(0, view.sides.findIndex((x) => x.id === side));
  const sideOfMan = (id: EntityId) => view.identity.get(id)?.side;
  const side = (s: string | undefined) => (s === undefined ? undefined : rec.sides[s]);
  const callsignOf = (id: EntityId) => view.unit.get(view.identity.get(id)?.unit ?? -1)?.callsign ?? "";
  const enemyOf = (s: string | undefined) => (s === undefined ? undefined : view.sides.find((x) => x.id !== s)?.id);

  // Mortar bursts this tick (by the side of the man who called them), then the enemy men hurt in the same tick.
  let burstSide: string | undefined;
  for (const e of events) {
    if (e.kind === "explosion" && isMortarHe(catalog, e.ammo)) { burstSide = sideOfMan(e.owner); const m = side(burstSide); if (m) m.mortar.bursts++; }
    else if (e.kind === "support.ranging") { const m = side(e.side); if (m) m.mortar.ranging++; }
  }
  if (burstSide !== undefined && rec.sides[burstSide]) {
    const m = rec.sides[burstSide]!.mortar;
    const hurt = new Set<EntityId>();
    for (const e of events) {
      if (e.kind === "wound" && (e.mechanism === "fragment" || e.mechanism === "blast") && sideOfMan(e.soldier) !== burstSide && !hurt.has(e.soldier)) { hurt.add(e.soldier); m.enemyWounded++; }
      else if (e.kind === "casualty" && sideOfMan(e.soldier) !== burstSide) m.enemyDown++;
    }
  }

  for (const e of events) {
    switch (e.kind) {
      case "shot.fired":
        if (rec.heatShots.length < HEAT_SHOTS_MAX) rec.heatShots.push(e.x, e.y, sideIdx(sideOfMan(e.shooter) ?? ""));
        // (M9.3b: a missile from a team on foot counts for its gunner's side.)
        if (catalog.ammo[e.ammo]?.guided !== undefined) { const r = side(e.vehicle !== undefined ? view.vehicle.get(e.vehicle)?.side : sideOfMan(e.shooter)); if (r) r.missiles.fired++; }
        break;
      case "casualty": {
        const t = view.transform.get(e.soldier), id = view.identity.get(e.soldier);
        if (t && id) {
          rec.heatFalls.push(t.x, t.y, sideIdx(id.side));
          rec.timeline.push({ tick: e.tick, side: id.side, key: "timeline.casualty", name: id.family, callsign: callsignOf(e.soldier), status: e.status });
        }
        break;
      }
      case "surrendered": case "captured": case "surrender.walk": {
        const id = view.identity.get(e.soldier);
        if (id) rec.timeline.push({ tick: e.tick, side: id.side, key: `timeline.${e.kind}`, name: id.family, callsign: callsignOf(e.soldier) });
        break;
      }
      case "objective.changed":
        if (e.holder !== null) rec.timeline.push({ tick: e.tick, side: e.holder, key: "timeline.objective", objective: e.objective });
        break;
      case "radio":
        if (e.key === "radio.broken" || e.key === "radio.rallied" || e.key === "radio.objectiveTaken") {
          const key = e.key === "radio.broken" ? "timeline.broken" : e.key === "radio.rallied" ? "timeline.rallied" : "timeline.taken";
          rec.timeline.push({ tick: e.tick, side: e.side, key, callsign: String(e.params["callsign"] ?? "") });
        }
        break;
      case "battle.ended":
        rec.timeline.push({ tick: e.tick, side: null, key: "timeline.ended", reason: e.reason, ...(e.loser ? { loser: e.loser } : {}) });
        break;
      case "medical.treated": {
        const r = side(sideOfMan(e.casualty));
        if (r) {
          if (e.by === e.casualty) r.care.self++; else r.care.buddy++;
          if (e.success) r.care.worked++;
          if (e.success && e.intervention === "tourniquet") r.care.tourniquets++;
        }
        const k = String(e.casualty);
        if (rec.firstTreated[k] === undefined) { rec.firstTreated[k] = e.tick; if (r) r.care.men++; }
        break;
      }
      case "medical.triaged": {
        const r = side(sideOfMan(e.casualty));
        if (r) { r.tags[e.skill] = (r.tags[e.skill] ?? 0) + 1; if (e.cat !== e.actual) r.wrongTags[e.skill] = (r.wrongTags[e.skill] ?? 0) + 1; }
        const k = String(e.casualty), last = rec.lastTag[k];
        if (r && last && last[0] !== last[1]) { r.retriage.wrongRetagged++; if (e.cat === e.actual) r.retriage.corrected++; }
        rec.lastTag[k] = [e.cat, e.actual];
        break;
      }
      case "medical.dragged": {
        const r = side(sideOfMan(e.casualty));
        if (r) { if (e.done) r.dragsDone++; else r.drags++; }
        break;
      }
      case "medical.carried": {
        const r = side(sideOfMan(e.payload));
        if (r && e.phase === "start") r.carries[e.method] = (r.carries[e.method] ?? 0) + 1;
        if (r && e.phase === "hold") r.holds++;
        if (r && e.phase === "done") r.carriedM += e.distanceM;
        break;
      }
      case "medical.nest": { const r = side(e.side); if (r) { if (e.reason === "sited") r.nest.sited++; else r.nest.moved++; } break; }
      case "medical.evac": {
        const r = side(sideOfMan(e.casualty));
        if (r) { if (e.phase === "tasked") r.nest.tasked++; else if (e.phase === "walks") r.nest.walks++; else if (e.phase === "returned") r.nest.returned++; }
        const k = String(e.casualty);
        if (e.phase === "arrived" && rec.atNest[k] === undefined) { rec.atNest[k] = e.tick; if (r) r.nest.arrived++; }
        break;
      }
      case "medical.ambulance": {
        const r = side(e.side);
        if (!r) break;
        const k = String(e.vehicle);
        if (e.phase === "called") { r.amb.called++; if (e.ordered) r.amb.ordered++; rec.ambCall[k] = e.tick; }
        else if (e.phase === "entered") r.amb.entered++;
        else if (e.phase === "arrived") { r.amb.arrived++; const c = rec.ambCall[k]; if (c !== undefined) r.amb.callToArriveS.push(Math.round(ticksToSeconds(e.tick - c))); }
        else if (e.phase === "loaded") r.amb.loaded++;
        else if (e.phase === "away") r.amb.away++;
        else if (e.phase === "cancelled") r.amb.cancelled++;
        break;
      }
      case "medical.evacuated": {
        const r = side(e.side);
        if (r) { r.amb.evacuated++; r.amb.woundToEvacS.push(Math.round(ticksToSeconds(e.tick - e.woundedTick))); }
        rec.evacuated[String(e.casualty)] = e.tick;
        break;
      }
      case "medical.carer":
        if (e.assigned) { const r = side(sideOfMan(e.casualty)); if (r) { if (e.responder) r.carers.responders++; else r.carers.comrades++; } }
        break;
      case "action.completed":
        // M10.4b: casualties lifted into and carried out of vehicles (the lead's action completes).
        if (e.action === "loadCasualty" || e.action === "unloadCasualty") { const r = side(sideOfMan(e.actor)); if (r) { if (e.action === "loadCasualty") r.loaded++; else r.unloaded++; } }
        break;
      case "missile.ended": { const r = side(e.vehicle !== undefined ? view.vehicle.get(e.vehicle)?.side : sideOfMan(e.gunner)); if (r) r.missiles[e.result]++; break; }
      case "unit.dismounted": { const r = side(view.unit.get(e.unit)?.side); if (r && r.firstDismountTick === null) r.firstDismountTick = e.tick; break; }
      default: break;
    }
    // Vehicles hit, immobilised, burning, destroyed, abandoned (M7.4a); wrecks go on the heat map.
    if ((e.kind === "vehicle.hit" && e.result === "penetrated") || e.kind === "vehicle.status" || e.kind === "vehicle.fire" || e.kind === "vehicle.destroyed" || e.kind === "vehicle.abandoned" || e.kind === "vehicle.extinguished" || (e.kind === "vehicle.reaction" && e.reaction === "reverseOut")) {
      const v = view.vehicle.get(e.vehicle);
      if (v) {
        // (Its crew's callsign, remembered: a crew that bailed out no longer belongs to the hull, M7.4b.)
        let name = v.vehicleId;
        if (v.unit !== null) name = view.unit.get(v.unit)?.callsign ?? v.vehicleId;
        else for (const u of view.unit.values()) if (u.exVehicle === e.vehicle) { name = u.callsign; break; }
        const key = e.kind === "vehicle.hit" ? "aar.vehicle.hit" : e.kind === "vehicle.status" ? `aar.vehicle.${e.status}` : e.kind === "vehicle.fire" ? "aar.vehicle.fire" : e.kind === "vehicle.destroyed" ? "aar.vehicle.destroyed" : e.kind === "vehicle.extinguished" ? "aar.vehicle.extinguished" : e.kind === "vehicle.reaction" ? "aar.vehicle.reversedOut" : "aar.vehicle.abandoned";
        rec.timeline.push({ tick: e.tick, side: v.side, key, vehicle: name });
        const t = view.transform.get(e.vehicle);
        if (t && (e.kind === "vehicle.destroyed" || e.kind === "vehicle.abandoned")) rec.heatFalls.push(t.x, t.y, sideIdx(v.side));
      }
    }
    if (e.kind === "vehicle.hit" && e.result === "penetrated") {
      const am = catalog.ammo[e.ammo];
      const r = side(enemyOf(view.vehicle.get(e.vehicle)?.side));
      if (r && am?.guided !== undefined) r.missiles.penetrated++;
      else if (r && am?.delivery?.method === "direct") r.missiles.rocketPenetrated++;
    }
    if (e.kind === "vehicle.reaction" || e.kind === "vehicle.fire" || e.kind === "vehicle.extinguished") {
      const r = side(view.vehicle.get(e.vehicle)?.side);
      if (r) { if (e.kind === "vehicle.reaction" && e.reaction === "reverseOut") r.crews.reversedOut++; else if (e.kind === "vehicle.fire") r.crews.fires++; else if (e.kind === "vehicle.extinguished") r.crews.firesOut++; }
    }
  }
}

/** The battle's end, from its result (`runBattle`) or, in the app, from `battleScore` and the state. */
export function finishRecord(rec: BattleRecord, end: { endTick: number; endReason: BattleEndReason; winner: string | null; loser?: string | null }): BattleRecord {
  rec.end = { tick: end.endTick, reason: end.endReason, winner: end.winner, loser: end.loser ?? null };
  return rec;
}

/** Is this ammunition a mortar's HE round in any faction's fire support (the batch's mortar block)? */
function isMortarHe(catalog: Catalog, ammo: string): boolean {
  for (const f of Object.values(catalog.factions)) if (f.fireSupport?.heAmmo === ammo) return true;
  return false;
}
