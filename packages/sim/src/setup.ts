/**
 * Builds the initial SimState from a BattleInput. Also the inverse: extracting roster records
 * from a state at the end of a battle.
 */
import { lightAt } from "./light";
import type { BattleInput, ForceInput, Placement, SoldierRecord, UnitInput, VehicleRecord } from "./battle";
import type { DriveState, OffMapKind, SoldierState, VehicleState } from "./components";
import { CREW_STATION_ORDER } from "./mount";
import { cos, sin } from "./math";
import type { EntityId, SideId, DefId } from "./ids";
import { addItems, aglBoxOf, countItems, emptyContainer, removeItems, type ItemStack } from "./items";
import { fitBatteries, loadWithBatteries } from "./power";
import { nextNormal, Streams } from "./rng";
import { MORALE_SOURCES } from "./components";
import type { Catalog, VehicleDef } from "./catalog";
import { updateImpairment, rosterStatus } from "./impair";
import { createState, newEntity, type SimState, type SimView } from "./state";
import type { SimContext } from "./context";
import { EventSink } from "./events";
import { newCache, pointForCache } from "./systems/supply";
import { secondsToTicks, TICK_HZ } from "./ids";
import { ammoOf } from "./ledger";
import { healthyPhysiology } from "./wounds";
import { defaultEnvironment } from "./environment";
import { OFF_MAP_PARK, parkOffMap } from "./offmap";

export function buildInitialState(input: BattleInput): SimState {
  const state = createState(input.seed, input.catalog.fingerprint);
  state.environment = input.environment ? { ...input.environment, ...(input.environment.sky ? { sky: { ...input.environment.sky } } : {}) } : defaultEnvironment();
  if (state.environment.sky) state.environment.light = lightAt(input.catalog, state.environment.timeOfDaySeconds, state.environment.sky.moon);
  for (const force of input.forces) {
    if (state.sides.some((s) => s.id === force.side)) throw new Error(`duplicate side '${force.side}'`);
    if (!input.catalog.factions[force.faction]) throw new Error(`unknown faction '${force.faction}'`);
    state.sides.push(force.posture ? { id: force.side, faction: force.faction, posture: force.posture } : { id: force.side, faction: force.faction });
    const placements = new Map(force.placements.map((p) => [p.personId, p]));
    const offMap = new Set((force.offMap ?? []).map((a) => a.vehicleId));
    // Vehicles first (M7): crews are seated in them as their units are added. (Off-map assets come after every
    // force, M10.6a, so that the entities of the battle itself keep the ids they have without them.)
    const vehicles = addVehicles(state, force, input.catalog, (id) => !offMap.has(id));
    // (A unit arriving late, M11.1, enters at its time: arrivalSystem.)
    for (const u of force.units) if ((u.arriveS ?? 0) <= 0 && (u.vehicleId === undefined || !offMap.has(u.vehicleId))) addUnit(state, u, null, force.side, force.faction, placements, input.catalog, vehicles);
    seatPassengers(state, force, vehicles, input.catalog);
  }
  // Off-map assets (M10.6a): their crews are nobody's to order; they wait at the off-map park until called. (M11.9b:
  // the military police come after everything else, below, so that no other entity moves its id.)
  addOffMap(state, input, (k) => k !== "mp");
  // Crates and cans on the ground (M11.1): a place and a container (after everything else, so the other entities keep
  // their ids).
  // M11.3: each is a cache of its side (placed: it stays where it is); one marked `point` is the supply point of the
  // side's nearest platoon (its rear point after every cache, so the caches keep their ids).
  const points: EntityId[] = [];
  for (const force of input.forces) {
    for (const cache of force.caches ?? []) {
      const id = newCache(state, force.side, cache.x, cache.y, cache.load);
      state.cache.req(id).placed = true;
      if (cache.point === true) points.push(id);
    }
  }
  for (const id of points) pointForCache(state, new EventSink(), id);
  // M11.4b: each side's off-map stock (an entity with a container, after everything else so no other id moves).
  for (const force of input.forces) {
    if (!force.stock) continue;
    const id = newEntity(state);
    const c = emptyContainer();
    for (const st of force.stock.load) addItems(c, st.type, st.count, st.charge);
    state.container.set(id, c);
    const tu = force.stock.supportTopUp;
    state.stock.set(id, { side: force.side, ...(tu && tu.rounds > 0 && tu.everyS > 0 ? { topUp: { rounds: tu.rounds, everyS: tu.everyS }, nextTopUpTick: secondsToTicks(tu.everyS) } : {}) });
  }
  // M11.9b: the military police off the map, last of all.
  addOffMap(state, input, (k) => k === "mp");
  return state;
}

/** The forces' off-map assets of the kinds `which` takes: hulls, crews, parked off the map, waiting to be called. */
function addOffMap(state: SimState, input: BattleInput, which: (kind: OffMapKind) => boolean): void {
  for (const force of input.forces) {
    const list = (force.offMap ?? []).filter((a) => which(a.kind));
    if (list.length === 0) continue;
    const offMap = new Set(list.map((a) => a.vehicleId));
    const placements = new Map(force.placements.map((p) => [p.personId, p]));
    const vehicles = addVehicles(state, force, input.catalog, (id) => offMap.has(id));
    for (const u of force.units) if (u.vehicleId !== undefined && offMap.has(u.vehicleId)) addUnit(state, u, null, force.side, force.faction, placements, input.catalog, vehicles);
    for (const a of list) {
      const vid = vehicles.get(a.vehicleId);
      if (vid === undefined) throw new Error(`off-map asset: no vehicle '${a.vehicleId}' in force ${force.side}`);
      const v = state.vehicle.req(vid);
      v.offMap = { kind: a.kind, phase: "ready" };
      if (v.unit !== null) state.unit.req(v.unit).asset = a.kind;
      parkOffMap(state, vid);
    }
  }
}

/** A fresh drive state: standing still, no route. */
export function idleDrive(x: number, y: number): DriveState {
  return {
    trackL: 0, trackR: 0, speed: 0, yawRate: 0, gear: 1, shiftUntilTick: 0, steer: 0, throttle: 0, brake: 0,
    route: [], routeIdx: 0, endHeading: null, arrived: true, holdForDismount: false, stuckTicks: 0, replans: 0,
    progressX: x, progressY: y, progressTick: 0, yieldTo: null, yieldSinceTick: 0, crossing: null, fuelAccL: 0, backX: x, backY: y,
  };
}

/** A new vehicle's roster record: a full tank and the stowed load from the data (scenarios, labs, campaign). */
export function newVehicleRecord(catalog: Catalog, type: string, vehicleId: string): VehicleRecord {
  const def = catalog.vehicles[type];
  if (!def) throw new Error(`unknown vehicle type '${type}'`);
  const load: ItemStack[] = [{ type: def.fuel.item, count: 1, charge: def.fuel.capacityL }];
  for (const s of def.stowed) load.push(s.charge === undefined ? { type: s.item, count: s.count } : { type: s.item, count: s.count, charge: s.charge });
  return { vehicleId, type, load };
}

/** Where a seat is in the world for a hull at (x, y) facing `heading`: [x, y, height above ground]. */
export function seatWorld(def: VehicleDef, seat: number, x: number, y: number, heading: number): [number, number, number] {
  const p = def.seats[seat]!.pos;
  const c = cos(heading), s = sin(heading);
  // forward = (c, s); right = (-s, c) (y grows south)
  return [x + c * p[0] - s * p[1], y + s * p[0] + c * p[1], p[2]];
}

function addVehicles(state: SimState, force: ForceInput, catalog: Catalog, which: (vehicleId: string) => boolean): Map<string, EntityId> {
  const out = new Map<string, EntityId>();
  const places = new Map((force.vehiclePlacements ?? []).map((p) => [p.vehicleId, p]));
  const offMap = new Set((force.offMap ?? []).map((a) => a.vehicleId));
  for (const rec of force.vehicles ?? []) {
    if (!which(rec.vehicleId)) continue;
    const def = catalog.vehicles[rec.type];
    if (!def) throw new Error(`vehicle ${rec.vehicleId}: unknown vehicle type '${rec.type}'`);
    if (out.has(rec.vehicleId)) throw new Error(`duplicate vehicleId '${rec.vehicleId}'`);
    // (An off-map asset, M10.6a, needs no placement: it starts at the off-map park.)
    const p = places.get(rec.vehicleId) ?? (offMap.has(rec.vehicleId) ? { vehicleId: rec.vehicleId, x: OFF_MAP_PARK.x, y: OFF_MAP_PARK.y, heading: 0 } : undefined);
    if (!p) throw new Error(`no placement for vehicle ${rec.vehicleId}`);
    const id = newEntity(state);
    out.set(rec.vehicleId, id);
    state.transform.set(id, { x: p.x, y: p.y, z: 0, heading: p.heading });
    const c = emptyContainer();
    for (const st of rec.load) addItems(c, st.type, st.count, st.charge);
    state.container.set(id, c);
    // Station weapons are numbered in order, station by station (the record's `ready` index).
    const firstWeapon: number[] = [];
    def.stations.reduce((n, sn) => { firstWeapon.push(n); return n + sn.weapons.length; }, 0);
    const v: VehicleState = {
      def: rec.type, vehicleId: rec.vehicleId, side: force.side, faction: force.faction, unit: null,
      seats: def.seats.map(() => null),
      drive: idleDrive(p.x, p.y),
      stations: def.stations.map((sn, si) => ({
        azimuth: 0, elevation: 0, azCmd: 0, elCmd: 0, laidTick: -1, task: null, taskWeapon: 0, taskFeed: 0, scanAz: 0, why: { tick: -1, keys: [] },
        weapons: sn.weapons.map((w, wi) => {
          // Ready rounds per feed: from the record (station weapons in order, station by station), else full.
          const feeds = w.feeds.map((f, fi) => ({ item: f.item, rounds: rec.ready?.[firstWeapon[si]! + wi]?.[fi]?.rounds ?? f.ready.count * f.ready.charge }));
          return {
            weapon: w.weapon, feeds,
            // M7.6a: a single-round gun may start with a round of its first feed in the breech.
            feed: 0, switchUntilTick: 0, nextShotTick: 0, burstLeft: 0, burstIndex: 0, loadedRound: w.startLoaded === true && (feeds[0]?.rounds ?? 0) > 0, jammed: false, lastShotTick: -100000,
            lowAmmoReported: w.feeds.map(() => false),
          };
        }),
      })),
      // Components (M7.4a): from the record, else all in full working order.
      comp: rec.components ? [...rec.components] : (def.components ?? []).map(() => 1),
      status: rec.status ?? "ok",
      fire: null, smokeReadyTick: 0, pendingSmokeTick: -1, crewReaction: null, reactionTick: -1, reactionWhy: [],
      lastHitTick: -1e9, lastPenTick: -1e9, lastShapedHitTick: -1e9, threatAz: null, hitsThisTick: 0, seatSwap: null, hatches: "closed", aps: null,
      // (M11.7b: how it was recovered in an earlier battle, as the roster gives it.)
      recovery: rec.recovery ? { ...rec.recovery } : null,
      capturedBy: rec.capturedBy ?? null,
    };
    state.vehicle.set(id, v);
  }
  return out;
}

function seatMan(state: SimState, def: VehicleDef, vid: EntityId, seat: number, sid: EntityId): void {
  const v = state.vehicle.req(vid);
  if (seat < 0 || seat >= def.seats.length) throw new Error(`vehicle ${v.vehicleId}: no seat ${seat}`);
  if (v.seats[seat] !== null) throw new Error(`vehicle ${v.vehicleId}: seat ${def.seats[seat]!.id} is taken twice`);
  v.seats[seat] = sid;
  state.soldier.req(sid).mount = { vehicle: vid, seat };
  const t = state.transform.req(vid), mt = state.transform.req(sid);
  const [x, y, z] = seatWorld(def, seat, t.x, t.y, t.heading);
  mt.x = x; mt.y = y; mt.z = z; mt.heading = t.heading;
}

/** Seat a crew unit in its vehicle: crew seats in station order, unless a placement names the seat. */
function seatCrew(state: SimState, uid: EntityId, vid: EntityId, members: EntityId[], placements: Map<string, Placement>, catalog: Catalog): void {
  const v = state.vehicle.req(vid);
  const def = catalog.vehicles[v.def]!;
  if (v.unit !== null) throw new Error(`vehicle ${v.vehicleId} is crewed by two units`);
  v.unit = uid;
  state.unit.req(uid).vehicle = vid;
  const order: number[] = [];
  for (const k of CREW_STATION_ORDER) def.seats.forEach((s, i) => { if (s.station === k) order.push(i); });
  const named = new Set<number>();
  for (const m of members) { const s = placements.get(state.identity.req(m).personId)?.seat; if (s !== undefined) named.add(s); }
  const free = order.filter((i) => !named.has(i));
  for (const m of members) {
    const s = placements.get(state.identity.req(m).personId)?.seat;
    const seat = s ?? free.shift();
    if (seat === undefined) throw new Error(`vehicle ${v.vehicleId}: more crew than crew seats`);
    seatMan(state, def, vid, seat, m);
  }
}

/** Men placed `mountedIn` a vehicle (passengers), after all units exist. */
function seatPassengers(state: SimState, force: ForceInput, vehicles: Map<string, EntityId>, catalog: Catalog): void {
  const byPerson = new Map<string, EntityId>();
  // mounted: ok roster mapping (every man, aboard or not)
  for (const [id, ident] of state.identity.entries()) if (ident.side === force.side) byPerson.set(ident.personId, id);
  for (const p of force.placements) {
    if (p.mountedIn === undefined) continue;
    const vid = vehicles.get(p.mountedIn);
    if (vid === undefined) throw new Error(`soldier ${p.personId}: no vehicle '${p.mountedIn}'`);
    const sid = byPerson.get(p.personId);
    if (sid === undefined || state.soldier.req(sid).mount !== undefined) continue;
    const v = state.vehicle.req(vid), def = catalog.vehicles[v.def]!;
    const seat = p.seat ?? def.seats.findIndex((s, i) => s.station === "passenger" && v.seats[i] === null);
    if (seat < 0) throw new Error(`soldier ${p.personId}: no free seat in vehicle ${p.mountedIn}`);
    seatMan(state, def, vid, seat, sid);
  }
}

export function addUnit(
  state: SimState,
  u: UnitInput,
  parent: EntityId | null,
  side: SideId,
  faction: DefId,
  placements: Map<string, Placement>,
  catalog: Catalog,
  vehicles: Map<string, EntityId>,
  parentQuality?: DefId,
): EntityId {
  const id = newEntity(state);
  const vid = u.vehicleId === undefined ? undefined : vehicles.get(u.vehicleId);
  const quality = u.quality ?? parentQuality;
  const Q = catalog.qualities[quality ?? catalog.behaviour.morale.defaultQuality];
  if (!Q) throw new Error(`unit ${u.key}: unknown quality '${quality ?? catalog.behaviour.morale.defaultQuality}'`);
  if (u.vehicleId !== undefined && vid === undefined) throw new Error(`unit ${u.key}: no vehicle '${u.vehicleId}' in its force`);
  // A crewman needs no placement of his own: he starts in his seat.
  const vt = vid === undefined ? undefined : state.transform.req(vid);
  state.unit.set(id, {
    callsign: u.callsign,
    side,
    faction,
    echelon: u.echelon,
    parent,
    children: [],
    members: [],
    leader: null,
    comms: { link: "radio", extraDelaySeconds: 0 },
    moving: false,
    firing: false,
    lineBlockedReported: false,
    fireRule: catalog.behaviour.decisions.defaultFireRule,
    maxEngageM: 0,
    onContact: "ground",
    ammoRule: "normal",
    underFireTick: -1e9,
    ceaseFireTick: -1e9,
    contactTick: -1e9,
    moveTick: -1e9,
    orderTick: -1e9,
    drill: null,
    broken: false,
    lastCallTick: -100000,
    ...(quality !== undefined ? { quality } : {}),
    morale: {
      value: 1, state: "steady", start: 0, lost: 0, recent: [], flanked: false, flankTick: -1, bond: u.bond ?? Q.morale.bond,
      firstContact: -1, lowSince: -1, uncared: 0, uncaredSince: -1, support: 0, supportTick: -1, radioTick: -1e9, rallied: -1,
    },
  });
  const unit = state.unit.req(id);
  u.members.forEach((rec, i) => {
    const sid = addSoldier(state, rec, id, side, faction, placements, catalog, vt);
    unit.members.push(sid);
    if (i === u.leaderIndex) unit.leader = sid;
  });
  if (vid !== undefined) seatCrew(state, id, vid, unit.members, placements, catalog);
  if (u.carrierId !== undefined) {
    const cv = vehicles.get(u.carrierId);
    if (cv === undefined) throw new Error(`unit ${u.key}: no vehicle '${u.carrierId}' to ride in`);
    unit.carrier = cv;
  }
  for (const sub of u.subunits) unit.children.push(addUnit(state, sub, id, side, faction, placements, catalog, vehicles, quality));
  // Men at the start, all of them under it (morale: its loss share).
  const count = (x: UnitInput): number => x.members.length + x.subunits.reduce((n, c) => n + count(c), 0);
  unit.morale.start = count(u);
  return id;
}

function addSoldier(
  state: SimState,
  rec: SoldierRecord,
  unit: EntityId,
  side: SideId,
  faction: DefId,
  placements: Map<string, Placement>,
  catalog: Catalog,
  fallback?: { x: number; y: number; heading: number },
): EntityId {
  // (Review fix: a man evacuated in an earlier battle is in the rear, not on this field: the battle input leaves him
  // out until he is back, M12.)
  if (rec.status === "evacuated") throw new Error(`soldier ${rec.personId} is evacuated (in the rear): leave him out of the battle input`);
  const id = newEntity(state);
  const p = placements.get(rec.personId) ?? fallback;
  if (!p) throw new Error(`no placement for soldier ${rec.personId}`);
  state.identity.set(id, {
    personId: rec.personId,
    given: rec.given,
    family: rec.family,
    rank: rec.rank,
    role: rec.role,
    faction,
    side,
    unit,
  });
  state.transform.set(id, { x: p.x, y: p.y, z: 0, heading: p.heading });
  state.mover.set(id, { waypoints: [], speedMps: 0, grade: 0, mode: null, formation: null, slotLagM: 0, endPosture: null, endHeading: null });
  const s: SoldierState = {
    skills: { ...rec.skills },
    posture: "standing",
    postureTo: null,
    postureDoneTick: 0,
    physical: { fatigue: rec.fatigue, heartRateBpm: catalog.body.physiology.hrRestBpm, hydration: rec.hydration ?? 1, winded: false },
    // His nerve (morale rework): his own steadiness, the same distribution for every side (stream "morale").
    mental: {
      stress: rec.stress, suppression: 0, morale: 1, behaviour: "steady", strain: rec.strain ?? 0,
      nerve: Math.min(1, Math.max(0, catalog.behaviour.morale.nerve.mean + catalog.behaviour.morale.nerve.sd * nextNormal(state.rng, Streams.morale))),
      why: MORALE_SOURCES.map(() => 0), jolt: 0, flee: null, rallyTick: -1e9, panicTick: -1e9, lossBooked: false,
    },
    // A man who comes into the battle already hurt keeps his condition (rule 11: records in and out).
    physiology: rec.physiology ? { ...rec.physiology } : { ...healthyPhysiology(), ...(rec.status === "killed" ? { alive: false, consciousness: 0 } : rec.status === "incapacitated" ? { consciousness: 0 } : {}) },
    wounds: rec.wounds.map((w) => ({ ...w, treatments: [...w.treatments] })),
    nextWoundId: rec.wounds.reduce((m, w) => Math.max(m, w.id + 1), 0),
    impair: { move: 1, aim: 1, canWalk: true, canUseArms: true, canFight: true, canSpeak: true },
    stunnedUntilTick: 0,
    seen: [],
    contacts: [],
    evade: null,
    intent: null,
    coverTick: -1e9,
    casualty: "none",
    captive: null,
  };
  if (!s.physiology.alive || s.physiology.consciousness < 0.5) {
    s.casualty = s.physiology.alive ? "incapacitated" : "killed";
    s.mental.behaviour = "incapacitated";
    s.posture = "prone";
  }
  // A prisoner record (M6.6) enters the battle out of the fight.
  // (M11.9b: with the side holding him, `heldBy`.)
  if (rec.status === "surrendered" || rec.status === "captured") { s.captive = { state: rec.status, tick: 0, ...(rec.heldBy !== undefined ? { by: rec.heldBy } : {}) }; s.mental.behaviour = "surrendered"; }
  // (Review fix: a record with recovery days was settled after an earlier battle: those wounds are not handed over
  // again, and his recovery days go out again unless new wounds are settled here. Wounds without them — a scenario
  // that starts with wounded men — are this battle's to settle.)
  if (rec.recoveryDays !== undefined) s.rosterIn = { wounds: rec.wounds.length, recoveryDays: rec.recoveryDays };
  updateImpairment(catalog, s);
  state.soldier.set(id, s);
  const c = emptyContainer();
  // (M11.6: a charged item listed without a charge that is not a magazine or belt, a battery or water, comes in full.)
  for (const st of rec.load) {
    const d = st.charge === undefined ? catalog.items[st.type] : undefined;
    addItems(c, st.type, st.count, d !== undefined && d.chargeCapacity !== undefined && d.chargeItem === undefined ? d.chargeCapacity : st.charge);
  }
  // His identity tag (owner request 2026-11-15; faction data): issued if his record has none.
  const tag = catalog.medical?.down !== undefined ? catalog.factions[faction]?.identityTag : undefined;
  if (tag && catalog.items[tag.item] && countItems(c, tag.item) === 0) addItems(c, tag.item, tag.perMan);
  // A man dead before the battle is known dead.
  if (!s.physiology.alive) s.checked = { tick: 0, by: id, dead: true };
  state.container.set(id, c);
  if (rec.weapon !== undefined) {
    const wd = catalog.weapons[rec.weapon];
    if (!wd) throw new Error(`soldier ${rec.personId}: unknown weapon '${rec.weapon}'`);
    // He starts with his fullest magazine in the weapon.
    const mag = removeItems(c, wd.feed.magazine, 1)[0];
    state.weapon.set(id, {
      weapon: rec.weapon,
      magazine: mag && (mag.charge ?? 0) > 0 ? { item: mag.type, rounds: mag.charge ?? 0 } : null,
      nextShotTick: 0, burstLeft: 0, burstIndex: 0, jammed: false, lastShotTick: -100000, lowAmmoReported: false, lowAmmoRadioed: false,
    });
    if (mag && (mag.charge ?? 0) <= 0) addItems(c, mag.type, 1, mag.charge);
  }
  // M11.6: the batteries in his powered devices (a fresh record's partly used, stream "power").
  fitBatteries(catalog, state.rng, s, c, state.environment.light, rec.powerFitted === true, state.tick);
  return id;
}

/** Read a soldier back out as a roster record (after or during a battle). */
export function soldierRecordFromState(state: SimState, id: EntityId): SoldierRecord {
  const ident = state.identity.req(id);
  const s = state.soldier.req(id);
  const c = state.container.get(id);
  const w = state.weapon.get(id);
  const dow = s.aftercare?.diedOfWoundsTick;
  // (Died of his wounds after the battle, M10.6b: killed, with the tick.)
  const status: SoldierRecord["status"] = dow !== undefined ? "killed" : rosterStatus(s);
  return {
    personId: ident.personId,
    given: ident.given,
    family: ident.family,
    rank: ident.rank,
    role: ident.role,
    skills: { ...s.skills },
    fatigue: s.physical.fatigue,
    stress: s.mental.stress,
    ...(s.mental.strain > 0 ? { strain: s.mental.strain } : {}),
    ...(s.physical.hydration < 1 ? { hydration: s.physical.hydration } : {}),
    wounds: JSON.parse(JSON.stringify(s.wounds)) as SoldierRecord["wounds"],
    // The magazine in the weapon goes back into the load, so nothing is lost between battles.
    // (M7.6d: so does the box on his team's AGL, if he carries its post.)
    // (M11.6: so do the batteries in his devices, at their charge now.)
    // (M11.6: and a drone still in the air goes into its operator's load, airframe and battery as they are.)
    load: loadWithAirborne(loadWithBatteries(loadWithMagazine(loadWithMagazine(c ? c.stacks.map((x) => ({ ...x })) : [], w?.magazine ?? null), aglBoxOf(state, id)), s, state.tick), state, id),
    ...(s.power !== undefined ? { powerFitted: true as const } : {}),
    ...(w ? { weapon: w.weapon } : {}),
    ...(s.wounds.length > 0 || !s.physiology.alive ? { physiology: { ...s.physiology } } : {}),
    status,
    // (A man not settled again keeps the recovery days he came in with; a new settlement covers all his wounds.)
    ...(dow === undefined && (s.aftercare?.recoveryDays ?? s.rosterIn?.recoveryDays) !== undefined ? { recoveryDays: s.aftercare?.recoveryDays ?? s.rosterIn!.recoveryDays } : {}),
    ...(dow !== undefined ? { diedOfWoundsTick: dow } : {}),
    // (M11.9b: a prisoner's holder, and when the military police took him off the map.)
    ...(s.captive?.state === "captured" && s.captive.by !== undefined ? { heldBy: s.captive.by } : {}),
    ...(s.captive?.evacTick !== undefined ? { powEvacuated: s.captive.evacTick } : {}),
  };
}

/** Read a vehicle back out as a roster record: its container (fuel left, stowed load) and ready belts. */
export function vehicleRecordFromState(state: SimState, id: EntityId): VehicleRecord {
  const v = state.vehicle.req(id);
  const c = state.container.get(id);
  return {
    vehicleId: v.vehicleId, type: v.def,
    load: c ? c.stacks.map((x) => ({ ...x })) : [],
    ready: v.stations.flatMap((sn) => sn.weapons.map((w) => w.feeds.map((f) => ({ item: f.item, rounds: f.rounds })))),
    ...(v.comp.length > 0 ? { components: [...v.comp] } : {}),
    status: v.status,
    capturedBy: v.capturedBy,
    ...(v.recovery !== null ? { recovery: { ...v.recovery } } : {}),
  };
}

/** Every vehicle of a side as roster records, in entity order. */
export function vehiclesFromState(state: SimState, side: SideId): VehicleRecord[] {
  const out: VehicleRecord[] = [];
  // off-map: ok the roster lists every vehicle of the side, an off-map asset too (rule 11: records in and out)
  for (const [id, v] of state.vehicle.entries()) if (v.side === side) out.push(vehicleRecordFromState(state, id));
  return out;
}

/** Rebuild the unit tree of one side as roster input, with updated soldier records. */
export function unitsFromState(state: SimState, side: SideId, template: UnitInput[]): UnitInput[] {
  // Map personId -> entity id
  const byPerson = new Map<string, EntityId>();
  // mounted: ok roster mapping (every man, aboard or not)
  for (const [id, ident] of state.identity.entries()) if (ident.side === side) byPerson.set(ident.personId, id);
  // (A unit that was still to arrive, M11.1, comes out as it went in.)
  const rebuild = (u: UnitInput, late: boolean): UnitInput => ({
    ...u,
    members: u.members.map((m) => {
      const id = byPerson.get(m.personId);
      return id === undefined ? (late ? m : { ...m, status: "missing" as const }) : soldierRecordFromState(state, id);
    }),
    subunits: u.subunits.map((c) => rebuild(c, late)),
  });
  return template.map((u) => rebuild(u, (u.arriveS ?? 0) > 0 && !(state.arrived ?? []).includes(u.key)));
}

/**
 * M11.6: whose roster record a drone still in the air at the end goes to: its operator; with none (he was hit, nobody
 * took the controller over), the first man of its unit still alive in ID order, else its first man. Nobody: null.
 */
export function airborneHolder(state: SimState, droneId: EntityId): EntityId | null {
  const d = state.drone.get(droneId);
  if (!d) return null;
  if (d.operator !== null && state.soldier.has(d.operator)) return d.operator;
  let first: EntityId | null = null, alive: EntityId | null = null;
  for (const m of state.unit.get(d.unit)?.members ?? []) {
    const s = state.soldier.get(m);
    if (!s) continue;
    if (first === null || m < first) first = m;
    if (s.physiology.alive && (alive === null || m < alive)) alive = m;
  }
  return alive ?? first;
}

/** M11.6: the stacks of every drone in the air whose holder is man `id` (airframe, battery at its charge) added to a load. */
function loadWithAirborne(stacks: ItemStack[], state: SimState, id: EntityId): ItemStack[] {
  if (state.drone.size === 0) return stacks;
  let added = false;
  for (const did of state.drone.keys()) {
    if (airborneHolder(state, did) !== id) continue;
    for (const st of state.container.get(did)?.stacks ?? []) {
      const same = stacks.find((x) => x.type === st.type && x.charge === st.charge);
      if (same) same.count += st.count;
      else stacks.push({ ...st });
      added = true;
    }
  }
  return added ? stacks.sort((a, b) => (a.type !== b.type ? (a.type < b.type ? -1 : 1) : (a.charge ?? -1) - (b.charge ?? -1))) : stacks;
}

function loadWithMagazine(stacks: ItemStack[], mag: { item: DefId; rounds: number } | null): ItemStack[] {
  if (!mag) return stacks;
  const same = stacks.find((s) => s.type === mag.item && s.charge === mag.rounds);
  if (same) same.count++;
  else stacks.push({ type: mag.item, count: 1, charge: mag.rounds });
  return stacks.sort((a, b) => (a.type !== b.type ? (a.type < b.type ? -1 : 1) : (a.charge ?? -1) - (b.charge ?? -1)));
}

/**
 * LATE ARRIVAL (M11.1): once a second, every top-level unit whose time has come enters the battle at its men's
 * placements (built exactly as at the start; its key goes into `state.arrived`, so a loaded save does not bring it
 * twice). Called only when the battle has late units.
 */
export function arrivalSystem(ctx: SimContext, state: SimState, events: EventSink): void {
  if (state.tick % TICK_HZ !== 0) return;
  for (const l of ctx.late) {
    if (state.tick < l.tick || (state.arrived ?? []).includes(l.unit.key)) continue;
    const first = state.nextEntityId;
    const uid = addUnit(state, l.unit, null, l.side, l.faction, l.placements, ctx.catalog, new Map());
    (state.arrived ??= []).push(l.unit.key);
    events.emit({ kind: "unit.entered", tick: state.tick, unit: uid, side: l.side });
    // (What its men carry enters the battle with them: a delivery from off the map, for the conservation guard.)
    const ids: number[] = [];
    for (let id = first; id < state.nextEntityId; id++) ids.push(id);
    const ammo = ammoOf(ctx.catalog, state, ids);
    for (const k of Object.keys(ammo).sort()) events.emit({ kind: "items.delivered", tick: state.tick, holder: uid, item: k, count: ammo[k]!, ammo: k, rounds: ammo[k]! });
  }
}

/** Has this side a unit still to arrive (M11.1)? Such a side is not beaten yet. */
export function latePending(ctx: SimContext, state: SimView, side: SideId): boolean {
  return ctx.late.some((l) => l.side === side && !(state.arrived ?? []).includes(l.unit.key));
}
