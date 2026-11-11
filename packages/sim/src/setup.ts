/**
 * Builds the initial SimState from a BattleInput. Also the inverse: extracting roster records
 * from a state at the end of a battle.
 */
import type { BattleInput, SoldierRecord, UnitInput } from "./battle";
import type { SoldierState } from "./components";
import type { EntityId, SideId, DefId } from "./ids";
import { addItems, emptyContainer, removeItems, type ItemStack } from "./items";
import type { Catalog } from "./catalog";
import { updateImpairment } from "./impair";
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
    for (const u of force.units) addUnit(state, u, null, force.side, force.faction, placements, input.catalog);
  }
  return state;
}

function addUnit(
  state: SimState,
  u: UnitInput,
  parent: EntityId | null,
  side: SideId,
  faction: DefId,
  placements: Map<string, { x: number; y: number; heading: number }>,
  catalog: Catalog,
): EntityId {
  const id = newEntity(state);
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
  });
  const unit = state.unit.req(id);
  u.members.forEach((rec, i) => {
    const sid = addSoldier(state, rec, id, side, faction, placements, catalog);
    unit.members.push(sid);
    if (i === u.leaderIndex) unit.leader = sid;
  });
  for (const sub of u.subunits) unit.children.push(addUnit(state, sub, id, side, faction, placements, catalog));
  return id;
}

function addSoldier(
  state: SimState,
  rec: SoldierRecord,
  unit: EntityId,
  side: SideId,
  faction: DefId,
  placements: Map<string, { x: number; y: number; heading: number }>,
  catalog: Catalog,
): EntityId {
  const id = newEntity(state);
  const p = placements.get(rec.personId);
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
    casualty: "none",
  };
  if (!s.physiology.alive || s.physiology.consciousness < 0.5) {
    s.casualty = s.physiology.alive ? "incapacitated" : "killed";
    s.mental.behaviour = "incapacitated";
    s.posture = "prone";
  }
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
  const status: SoldierRecord["status"] = !s.physiology.alive
    ? "killed"
    : s.casualty === "incapacitated"
      ? "incapacitated"
      : s.wounds.length > 0
        ? "wounded"
        : "fit";
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
