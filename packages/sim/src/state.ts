/**
 * THE WHOLE SIMULATION STATE IS SERIALISABLE (SPEC 4.3 rule 4).
 *
 * `serializeState` turns the state into plain JSON-compatible data; `deserializeState` rebuilds it.
 * `hashState` hashes the canonical serialisation: equal hash <=> equal state. Used for the determinism
 * test, golden replays, saves and battle results.
 */
import type { Action, ContactReport, FireTask, Identity, Mover, SoldierState, TerrainState, Transform, Unit, VehicleState, WeaponState } from "./components";
import { defaultEnvironment, type Environment } from "./environment";
import type { SmokeCloud } from "./smoke";
import type { DefId, EntityId, SideId } from "./ids";
import type { Container } from "./items";
import type { InboxOrder, PendingOrder } from "./orders";
import { createRng, type RngState } from "./rng";
import { Store, type ReadonlyStore } from "./store";
import type { BattleEndReason } from "./events";
import { canonicalJson, hashText } from "./hash";
import {
  createProjectilePool, deserializeProjectiles, serializeProjectiles, type ProjectilePool, type SerializedProjectiles,
} from "./projectiles";

/** Deeply read-only type: what controllers, the renderer and UI may see of the state. */
/** Read-only face of a typed array (index and length only). */
/**
 * A side's mortar section (M6.5c): an off-map entity whose container holds its rounds (rule 9). `registered`
 * (step fire-support): points it has already ranged onto, with the aiming error left there (m), so a new mission
 * near one fires for effect at once. Absent until the first mission has ranged.
 */
export interface SupportSection {
  side: SideId; battery: EntityId; heType: DefId; smokeType: DefId;
  registered?: { x: number; y: number; ex: number; ey: number }[];
}

/**
 * A fire mission on its way (M6.5c). `left`: rounds still to land in all (ranging rounds included). Step
 * fire-support: `ranging` ranging rounds land first, one at a time, each off the point by the battery's aiming
 * error (`ex`, `ey`, m), which the caller corrects when he sees where it fell; then the battery fires for effect
 * in volleys (`volley` = rounds of the current volley fired).
 */
export interface FireMission {
  side: SideId; caller: EntityId; x: number; y: number; ammo: "he" | "smoke"; left: number; nextTick: number;
  ranging?: number; ex?: number; ey?: number; volley?: number;
  /** Review fixes: true once someone of the side saw one of its ranging rounds fall (only then is the point
   *  remembered as registered: an unobserved one would keep the full aiming error for later missions). */
  observed?: boolean;
  /** M8.1 screen: the rounds for effect land along a line through (x, y) from (x - lx, y - ly) to (x + lx, y + ly),
   *  evenly: `effect` rounds in all, `fired` of them down. */
  lx?: number; ly?: number; effect?: number; fired?: number;
}

export interface ReadonlyNumbers { readonly length: number; readonly [index: number]: number }

export type DeepReadonly<T> =
  T extends Float64Array | Float32Array | Int32Array | Uint16Array | Uint8Array ? ReadonlyNumbers
  : T extends Store<infer V> ? ReadonlyStore<DeepReadonly<V>>
  : T extends (infer R)[] ? ReadonlyArray<DeepReadonly<R>>
  : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

/** The simulation state as seen from outside: read-only. Changes go through orders. */
export type SimView = DeepReadonly<SimState>;

/** Bump when the serialised shape changes; old saves are then migrated or rejected. */
export const STATE_SCHEMA_VERSION = 17;

export interface SideState {
  id: SideId;
  faction: DefId;
  /** Whether this side attacks or defends in this battle (scenario); absent = not stated. */
  posture?: SidePosture;
}

export type SidePosture = "attack" | "defend";

export interface SimState {
  /** Fingerprint of the data (catalog) this battle runs with; checked when a save is loaded. */
  catalogFingerprint: string;
  /** Fingerprint of the map; checked when a save is loaded. */
  mapFingerprint: string;
  tick: number;
  rng: RngState;
  nextEntityId: number;
  nextOrderSeq: number;
  environment: Environment;
  sides: SideState[];
  inbox: InboxOrder[];
  pendingOrders: PendingOrder[];
  /** Contact reports on their way from one soldier to another (voice or radio, M3.3). */
  contactReports: ContactReport[];
  /** Who holds each objective (M6), in the order of `rules.objectives`. */
  objectives: { id: string; holder: SideId | null; contested: boolean }[];
  /** The side that lost early (broken or wiped out), if one did. */
  endLoser: SideId | null;
  /** Fire support (M6.5c): each side's mortar section (an off-map entity whose container holds its rounds as
   *  counted items, rule 9, and the item types of its HE and smoke rounds), missions on their way, smoke clouds. */
  support: SupportSection[];
  fireMissions: FireMission[];
  /** `multispectral` (M7.3): also blinds thermal sights; absent = ordinary smoke. */
  smoke: SmokeCloud[];
  ended: { tick: number; reason: BattleEndReason } | null;
  terrain: TerrainState;
  /** Bullets, fragments and shells in flight (typed arrays; see projectiles.ts). */
  projectiles: ProjectilePool;

  // Component stores
  identity: Store<Identity>;
  transform: Store<Transform>;
  mover: Store<Mover>;
  soldier: Store<SoldierState>;
  unit: Store<Unit>;
  container: Store<Container>;
  action: Store<Action>;
  weapon: Store<WeaponState>;
  fire: Store<FireTask>;
  /** Vehicles (M7). */
  vehicle: Store<VehicleState>;
}

const STORE_KEYS = ["identity", "transform", "mover", "soldier", "unit", "container", "action", "weapon", "fire", "vehicle"] as const;
type StoreKey = (typeof STORE_KEYS)[number];

export function createState(seed: number, catalogFingerprint = "", mapFingerprint = ""): SimState {
  return {
    catalogFingerprint,
    mapFingerprint,
    terrain: { breaches: [], craters: [], vegetationLoss: [] },
    projectiles: createProjectilePool(),
    tick: 0,
    rng: createRng(seed),
    nextEntityId: 1,
    nextOrderSeq: 0,
    environment: defaultEnvironment(),
    sides: [],
    inbox: [],
    pendingOrders: [],
    contactReports: [],
    objectives: [],
    endLoser: null,
    support: [],
    fireMissions: [],
    smoke: [],
    ended: null,
    identity: new Store(),
    transform: new Store(),
    mover: new Store(),
    soldier: new Store(),
    unit: new Store(),
    container: new Store(),
    action: new Store(),
    weapon: new Store(),
    fire: new Store(),
    vehicle: new Store(),
  };
}

export function newEntity(state: SimState): EntityId {
  return state.nextEntityId++;
}

/** Plain JSON-compatible form of the state. */
export interface SerializedState {
  schema: number;
  catalogFingerprint: string;
  mapFingerprint: string;
  tick: number;
  rng: RngState;
  nextEntityId: number;
  nextOrderSeq: number;
  environment: Environment;
  sides: SideState[];
  inbox: InboxOrder[];
  pendingOrders: PendingOrder[];
  /** Contact reports on their way from one soldier to another (voice or radio, M3.3). */
  contactReports: ContactReport[];
  /** Who holds each objective (M6), in the order of `rules.objectives`. */
  objectives: { id: string; holder: SideId | null; contested: boolean }[];
  /** The side that lost early (broken or wiped out), if one did. */
  endLoser: SideId | null;
  /** Fire support (M6.5c): each side's mortar section (an off-map entity whose container holds its rounds as
   *  counted items, rule 9, and the item types of its HE and smoke rounds), missions on their way, smoke clouds. */
  support: SupportSection[];
  fireMissions: FireMission[];
  /** `multispectral` (M7.3): also blinds thermal sights; absent = ordinary smoke. */
  smoke: SmokeCloud[];
  ended: SimState["ended"];
  terrain: TerrainState;
  projectiles: SerializedProjectiles;
  stores: Record<StoreKey, [EntityId, unknown][]>;
}

export function serializeState(s: SimState): SerializedState {
  const stores = {} as Record<StoreKey, [EntityId, unknown][]>;
  for (const k of STORE_KEYS) stores[k] = (s[k] as Store<unknown>).toEntries();
  // Deep copy so the serialised form never aliases live state; rejects NaN/Infinity (they would turn
  // into null in JSON and silently change the battle after a load).
  return toPlain(
    {
      schema: STATE_SCHEMA_VERSION,
      catalogFingerprint: s.catalogFingerprint,
      mapFingerprint: s.mapFingerprint,
      terrain: s.terrain,
      projectiles: serializeProjectiles(s.projectiles),
      tick: s.tick,
      rng: s.rng,
      nextEntityId: s.nextEntityId,
      nextOrderSeq: s.nextOrderSeq,
      environment: s.environment,
      sides: s.sides,
      inbox: s.inbox,
      pendingOrders: s.pendingOrders,
      contactReports: s.contactReports,
      objectives: s.objectives,
      endLoser: s.endLoser,
      support: s.support,
      fireMissions: s.fireMissions,
      smoke: s.smoke,
      ended: s.ended,
      stores,
    },
    "state",
  ) as SerializedState;
}

/**
 * Deep copy into JSON-compatible plain data. Throws on NaN/Infinity (naming the path), drops undefined
 * object fields, and normalises -0 to 0 (JSON cannot store -0; simulation code must not depend on the
 * sign of zero - sim/math.atan2 never returns -0).
 */
export function toPlain(value: unknown, path: string): unknown {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`non-finite number ${value} at ${path}`);
    return value === 0 ? 0 : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v, i) => toPlain(v, `${path}[${i}]`));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v !== undefined) out[k] = toPlain(v, `${path}.${k}`);
  }
  return out;
}

export function deserializeState(data: SerializedState): SimState {
  if (data.schema !== STATE_SCHEMA_VERSION) {
    throw new Error(`save has state schema ${data.schema}, this build expects ${STATE_SCHEMA_VERSION}`);
  }
  const d = toPlain(data, "save") as SerializedState;
  const st = (k: StoreKey) => Store.fromEntries(d.stores[k] ?? []);
  return {
    tick: d.tick,
    rng: d.rng,
    nextEntityId: d.nextEntityId,
    nextOrderSeq: d.nextOrderSeq,
    environment: d.environment,
    sides: d.sides,
    inbox: d.inbox,
    pendingOrders: d.pendingOrders,
    contactReports: d.contactReports,
    objectives: d.objectives,
    endLoser: d.endLoser,
    support: d.support,
    fireMissions: d.fireMissions,
    smoke: d.smoke,
    ended: d.ended,
    catalogFingerprint: d.catalogFingerprint,
    mapFingerprint: d.mapFingerprint,
    terrain: d.terrain,
    projectiles: deserializeProjectiles(d.projectiles),
    identity: st("identity") as Store<Identity>,
    transform: st("transform") as Store<Transform>,
    mover: st("mover") as Store<Mover>,
    soldier: st("soldier") as Store<SoldierState>,
    unit: st("unit") as Store<Unit>,
    container: st("container") as Store<Container>,
    action: st("action") as Store<Action>,
    weapon: st("weapon") as Store<WeaponState>,
    fire: st("fire") as Store<FireTask>,
    vehicle: st("vehicle") as Store<VehicleState>,
  };
}

export function hashState(s: SimState): string {
  return hashText(canonicalJson(serializeState(s)));
}
