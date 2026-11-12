/**
 * Builds the initial SimState from a BattleInput. Also the inverse: extracting roster records
 * from a state at the end of a battle.
 */
import type { BattleInput, ForceInput, Placement, SoldierRecord, UnitInput, VehicleRecord } from "./battle";
import type { DriveState, SoldierState, VehicleState } from "./components";
import { CREW_STATION_ORDER } from "./mount";
import { cos, sin } from "./math";
import type { EntityId, SideId, DefId } from "./ids";
import { addItems, emptyContainer, removeItems, type ItemStack } from "./items";
import type { Catalog, VehicleDef } from "./catalog";
import { updateImpairment, rosterStatus } from "./impair";
import { createState, newEntity, type SimState } from "./state";
import { healthyPhysiology } from "./wounds";
import { defaultEnvironment } from "./environment";

export function buildInitialState(input: BattleInput): SimState {
  const state = createState(input.seed, input.catalog.fingerprint);
  state.environment = input.environment ? { ...input.environment } : defaultEnvironment();
  for (const force of input.forces) {
    if (state.sides.some((s) => s.id === force.side)) throw new Error(`duplicate side '${force.side}'`);
    if (!input.catalog.factions[force.faction]) throw new Error(`unknown faction '${force.faction}'`);
    state.sides.push({ id: force.side, faction: force.faction });
    const placements = new Map(force.placements.map((p) => [p.personId, p]));
    // Vehicles first (M7): crews are seated in them as their units are added.
    const vehicles = addVehicles(state, force, input.catalog);
    for (const u of force.units) addUnit(state, u, null, force.side, force.faction, placements, input.catalog, vehicles);
    seatPassengers(state, force, vehicles, input.catalog);
  }
  return state;
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

function addVehicles(state: SimState, force: ForceInput, catalog: Catalog): Map<string, EntityId> {
  const out = new Map<string, EntityId>();
  const places = new Map((force.vehiclePlacements ?? []).map((p) => [p.vehicleId, p]));
  for (const rec of force.vehicles ?? []) {
    const def = catalog.vehicles[rec.type];
    if (!def) throw new Error(`vehicle ${rec.vehicleId}: unknown vehicle type '${rec.type}'`);
    if (out.has(rec.vehicleId)) throw new Error(`duplicate vehicleId '${rec.vehicleId}'`);
    const p = places.get(rec.vehicleId);
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
        weapons: sn.weapons.map((w, wi) => ({
          weapon: w.weapon,
          // Ready rounds per feed: from the record (station weapons in order, station by station), else full.
          feeds: w.feeds.map((f, fi) => ({ item: f.item, rounds: rec.ready?.[firstWeapon[si]! + wi]?.[fi]?.rounds ?? f.ready.count * f.ready.charge })),
          feed: 0, switchUntilTick: 0, nextShotTick: 0, burstLeft: 0, burstIndex: 0, loadedRound: false, jammed: false, lastShotTick: -100000,
          lowAmmoReported: w.feeds.map(() => false),
        })),
      })),
      comp: rec.components ? [...rec.components] : [],
      status: rec.status ?? "ok",
      fire: null, smokeReadyTick: 0, pendingSmokeTick: -1, crewReaction: null, reactionTick: -1, reactionWhy: [],
      lastHitTick: -1e9, lastPenTick: -1e9, hitsThisTick: 0, seatSwap: null, hatches: "closed", aps: null, recovery: null,
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

function addUnit(
  state: SimState,
  u: UnitInput,
  parent: EntityId | null,
  side: SideId,
  faction: DefId,
  placements: Map<string, Placement>,
  catalog: Catalog,
  vehicles: Map<string, EntityId>,
): EntityId {
  const id = newEntity(state);
  const vid = u.vehicleId === undefined ? undefined : vehicles.get(u.vehicleId);
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
  });
  const unit = state.unit.req(id);
  u.members.forEach((rec, i) => {
    const sid = addSoldier(state, rec, id, side, faction, placements, catalog, vt);
    unit.members.push(sid);
    if (i === u.leaderIndex) unit.leader = sid;
  });
  if (vid !== undefined) seatCrew(state, id, vid, unit.members, placements, catalog);
  for (const sub of u.subunits) unit.children.push(addUnit(state, sub, id, side, faction, placements, catalog, vehicles));
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
    physical: { fatigue: rec.fatigue, heartRateBpm: catalog.body.physiology.hrRestBpm, hydration: 1, winded: false },
    mental: { stress: rec.stress, suppression: 0, morale: 1, behaviour: "steady" },
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
  if (rec.status === "surrendered" || rec.status === "captured") { s.captive = { state: rec.status, tick: 0 }; s.mental.behaviour = "surrendered"; }
  updateImpairment(catalog, s);
  state.soldier.set(id, s);
  const c = emptyContainer();
  for (const st of rec.load) addItems(c, st.type, st.count, st.charge);
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
  return id;
}

/** Read a soldier back out as a roster record (after or during a battle). */
export function soldierRecordFromState(state: SimState, id: EntityId): SoldierRecord {
  const ident = state.identity.req(id);
  const s = state.soldier.req(id);
  const c = state.container.get(id);
  const w = state.weapon.get(id);
  const status: SoldierRecord["status"] = rosterStatus(s);
  return {
    personId: ident.personId,
    given: ident.given,
    family: ident.family,
    rank: ident.rank,
    role: ident.role,
    skills: { ...s.skills },
    fatigue: s.physical.fatigue,
    stress: s.mental.stress,
    wounds: JSON.parse(JSON.stringify(s.wounds)) as SoldierRecord["wounds"],
    // The magazine in the weapon goes back into the load, so nothing is lost between battles.
    load: loadWithMagazine(c ? c.stacks.map((x) => ({ ...x })) : [], w?.magazine ?? null),
    ...(w ? { weapon: w.weapon } : {}),
    ...(s.wounds.length > 0 || !s.physiology.alive ? { physiology: { ...s.physiology } } : {}),
    status,
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
  };
}

/** Every vehicle of a side as roster records, in entity order. */
export function vehiclesFromState(state: SimState, side: SideId): VehicleRecord[] {
  const out: VehicleRecord[] = [];
  for (const [id, v] of state.vehicle.entries()) if (v.side === side) out.push(vehicleRecordFromState(state, id));
  return out;
}

/** Rebuild the unit tree of one side as roster input, with updated soldier records. */
export function unitsFromState(state: SimState, side: SideId, template: UnitInput[]): UnitInput[] {
  // Map personId -> entity id
  const byPerson = new Map<string, EntityId>();
  for (const [id, ident] of state.identity.entries()) if (ident.side === side) byPerson.set(ident.personId, id);
  const rebuild = (u: UnitInput): UnitInput => ({
    ...u,
    members: u.members.map((m) => {
      const id = byPerson.get(m.personId);
      return id === undefined ? { ...m, status: "missing" as const } : soldierRecordFromState(state, id);
    }),
    subunits: u.subunits.map(rebuild),
  });
  return template.map(rebuild);
}

function loadWithMagazine(stacks: ItemStack[], mag: { item: DefId; rounds: number } | null): ItemStack[] {
  if (!mag) return stacks;
  const same = stacks.find((s) => s.type === mag.item && s.charge === mag.rounds);
  if (same) same.count++;
  else stacks.push({ type: mag.item, count: 1, charge: mag.rounds });
  return stacks.sort((a, b) => (a.type !== b.type ? (a.type < b.type ? -1 : 1) : (a.charge ?? -1) - (b.charge ?? -1)));
}
