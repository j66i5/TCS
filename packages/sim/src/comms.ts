/**
 * COMMUNICATION STATE INTERFACE (SPEC 6.5, 9.5).
 *
 * All order delivery and (from M3) all contact sharing pass through a CommsModel. The foundations use a
 * simple fixed delay. The command & electronic-warfare extension replaces the model (radio nets, runners,
 * jamming, battle management systems) without touching the callers.
 */
import { isOffMap } from "./offmap";
import type { Catalog } from "./catalog";
import type { CommState } from "./components";
import { compCondition } from "./mount";
import { deviceLive, slotLive } from "./power";
import type { EntityId } from "./ids";
import { secondsToTicks } from "./ids";
import type { Order } from "./orders";
import { nextFloat, Streams } from "./rng";
import type { SimState } from "./state";

export interface CommsParams {
  /** Base delay from the issuing headquarters to a unit on the radio net, seconds. */
  orderDelaySeconds: number;
  /** Random extra delay, uniform in [0, this], seconds: radio traffic, the leader being busy. */
  orderDelayJitterSeconds: number;
  /** Delay for contact reports shared by radio, seconds (used from M3). */
  contactShareDelaySeconds: number;
  /** Voice range for shouted orders / contacts, metres (used from M3). */
  voiceRangeM: number;
}

export const DEFAULT_COMMS: CommsParams = {
  orderDelaySeconds: 1,
  orderDelayJitterSeconds: 1,
  contactShareDelaySeconds: 5,
  voiceRangeM: 40,
};

export interface CommsModel {
  readonly id: string;
  /** Recompute the comm state of every unit (called once per second of game time). */
  /** Once a second. `catalog` (M7.4b) lets the model read vehicle radios; absent in old callers. */
  update(state: SimState, params: CommsParams, catalog?: Catalog): void;
  /** Ticks between an order being received and it reaching the target. `null` = cannot be delivered now. */
  orderDelayTicks(state: SimState, params: CommsParams, order: Order): number | null;
  /** Ticks for a contact report to travel from one soldier to another (0 = within shouting distance).
   *  `null` = no path. */
  contactShareDelayTicks(state: SimState, params: CommsParams, from: EntityId, to: EntityId): number | null;
}

function unitOf(state: SimState, target: EntityId): EntityId | null {
  if (state.unit.has(target)) return target;
  return state.identity.get(target)?.unit ?? null;
}

/** Foundations model: every unit is on the radio net; delays are constants from the scenario rules. */
export const simpleComms: CommsModel = {
  id: "simple",
  update(state, _params, catalog) {
    for (const [, u] of state.unit.entries()) {
      const c: CommState = u.comms;
      c.link = "radio";
    }
    if (!catalog) return;
    // Flat radios (M11.6): a unit on foot whose radios are all flat is off the net.
    radioCoverage(state, catalog);
    // A wrecked radio (M7.4b, plan C63): its crew is off the net; so is a unit whose men are all aboard it.
    if (state.vehicle.size === 0) return;
    for (const [vid, v] of state.vehicle.entries()) {
      if (isOffMap(v)) continue;
      const def = catalog.vehicles[v.def];
      if (!def?.components || compCondition(v, def, "radio") > 0) continue;
      if (v.unit !== null) { const u = state.unit.get(v.unit); if (u) u.comms.link = "none"; }
      for (const [, u] of state.unit.entries()) {
        if (u.vehicle !== undefined || u.members.length === 0) continue;
        let aboard = 0, alive = 0;
        for (const m of u.members) {
          const s = state.soldier.get(m);
          if (!s || !s.physiology.alive) continue;
          alive++;
          if (s.mount?.vehicle === vid) aboard++;
        }
        if (alive > 0 && aboard === alive) u.comms.link = "none";
      }
    }
  },
  orderDelayTicks(state, params, order) {
    const u = unitOf(state, order.target);
    const unit = u === null ? undefined : state.unit.get(u);
    if (!unit || unit.comms.link === "none") return null;
    const jitter = params.orderDelayJitterSeconds > 0 ? nextFloat(state.rng, Streams.comms) * params.orderDelayJitterSeconds : 0;
    return secondsToTicks(params.orderDelaySeconds + jitter + unit.comms.extraDelaySeconds);
  },
  contactShareDelayTicks(state, params, from, to) {
    // Within voice range: shouted (no delay from the model; the caller adds the time to say it). Otherwise by
    // radio, if both men's units are on the net.
    // Aboard the same vehicle: the intercom (M7.2). Between a man aboard and one outside: only the radio.
    const ma = state.soldier.get(from)?.mount, mb = state.soldier.get(to)?.mount;
    if (ma && mb && ma.vehicle === mb.vehicle) return 0;
    const a = state.transform.get(from), b = state.transform.get(to);
    if (ma === undefined && mb === undefined && a && b && (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y) <= params.voiceRangeM * params.voiceRangeM) return 0;
    const ua = state.unit.get(state.identity.get(from)?.unit ?? -1), ub = state.unit.get(state.identity.get(to)?.unit ?? -1);
    if (!ua || !ub || ua.comms.link === "none" || ub.comms.link === "none") return null;
    return secondsToTicks(params.contactShareDelaySeconds + ua.comms.extraDelaySeconds + ub.comms.extraDelaySeconds);
  },
};

/** Radio coverage of a unit's own men: none of them carries a radio, all their radios are flat, or one has power. */
const NO_RADIO = 0, FLAT = 1, LIVE = 2;

/**
 * Flat radios (M11.6 stage 2). A unit on foot (not a vehicle crew) is on the net while a radio (an item with `radio`)
 * carried by a man of its subtree has power (power.ts: an unpowered radio always has); a unit whose subtree carries no
 * radio is covered by its parent's (walking up); with no radio anywhere up the chain it stays on the net (as before
 * M11.6). A man down or dead still counts as carrying his radio (in this slice). A unit whose alive men all sit in hulls
 * with a working radio stays on the net (the hull radio). Once a second; nothing to do (one pass over the battery
 * slots) while no radio is flat.
 */
function radioCoverage(state: SimState, catalog: Catalog): void {
  const tick = state.tick;
  let anyFlat = false;
  // mounted: ok a radio aboard is still carried (only its battery slots are read)
  for (const [, s] of state.soldier.entries()) {
    if (!s.power) continue;
    for (const slot of s.power) if (catalog.items[slot.device]?.radio === true && !slotLive(slot, tick)) { anyFlat = true; break; }
    if (anyFlat) break;
  }
  if (!anyFlat) return;
  // Each unit's own men's coverage, then its subtree's (live beats flat beats none).
  const own = new Map<EntityId, number>();
  for (const [uid, u] of state.unit.entries()) {
    let cov = NO_RADIO;
    for (const m of u.members) {
      const c = state.container.get(m);
      if (!c) continue;
      for (const st of c.stacks) {
        if (st.count <= 0 || catalog.items[st.type]?.radio !== true) continue;
        cov = deviceLive(catalog, state, m, st.type, tick) ? LIVE : Math.max(cov, FLAT);
        if (cov === LIVE) break;
      }
      if (cov === LIVE) break;
    }
    own.set(uid, cov);
  }
  const sub = new Map<EntityId, number>();
  const subtree = (uid: EntityId, depth: number): number => {
    const known = sub.get(uid);
    if (known !== undefined) return known;
    let cov = own.get(uid) ?? NO_RADIO;
    const u = state.unit.get(uid);
    if (u && depth < 16) for (const ch of u.children) { if (cov === LIVE) break; cov = Math.max(cov, subtree(ch, depth + 1)); }
    sub.set(uid, cov);
    return cov;
  };
  for (const [uid, u] of state.unit.entries()) {
    if (u.vehicle !== undefined) continue;
    let cov = subtree(uid, 0), p = u.parent;
    for (let k = 0; cov === NO_RADIO && p !== null && k < 16; k++) { cov = subtree(p, 0); p = state.unit.get(p)?.parent ?? null; }
    if (cov !== FLAT) continue;
    if (allAboardHullRadio(state, catalog, u.members)) continue;
    u.comms.link = "none";
  }
}

/** True when the unit has alive men and all of them sit in hulls whose radio works. */
function allAboardHullRadio(state: SimState, catalog: Catalog, members: readonly EntityId[]): boolean {
  let alive = 0;
  for (const m of members) {
    const s = state.soldier.get(m);
    if (!s || !s.physiology.alive) continue;
    alive++;
    const v = s.mount ? state.vehicle.get(s.mount.vehicle) : undefined;
    if (!v) return false;
    const def = catalog.vehicles[v.def];
    if (def?.components && compCondition(v, def, "radio") > 0) return false;
  }
  return alive > 0;
}

/** Whether unit `uid` (or a man's unit) is on the net now: its radio lines go out (M11.6). Unknown: false. */
export function onAir(state: SimState, uid: EntityId | null | undefined): boolean {
  if (uid === null || uid === undefined) return false;
  const u = state.unit.get(uid) ?? state.unit.get(state.identity.get(uid)?.unit ?? -1);
  return u !== undefined && u.comms.link !== "none";
}

export const COMMS_MODELS: Record<string, CommsModel> = { simple: simpleComms };
