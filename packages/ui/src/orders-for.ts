/**
 * Which orders the order bar offers for the selected unit. M7.1c told men on foot from a vehicle crew; M7.5a
 * (plan m7.5 §3) offers only what the unit can actually do now: `unitCapabilities` reads the state (a launcher
 * with rounds, grenades, fire support left, a vehicle to ride in, smoke dischargers, the guns' natures) and
 * `ordersFor` turns it into the bar. Nothing selected: every button shown greyed (`none`). Pure: tested
 * without a DOM.
 */
import { isAble, isOffMap, isOut, mpLeft, repairTaskFor, supportLeft, type Catalog, type EntityId, type SimView } from "@tcs/sim";
import type { OrderMode } from "./hud";
import { supplySourceNear } from "./supply";
import { prisonerSummary } from "./prisoners";

export type Nature = "ap" | "he" | "mg";

export interface OrderSet {
  /** Nothing selected (M7.5a): the bar shows the foot orders, every button disabled. */
  none?: boolean;
  modes: OrderMode[];
  halt: boolean;
  ceaseFire: boolean;
  posture: boolean;
  rules: boolean;
  /** Paces for the legs of a planned move, first = default. "reverse" = the slowest vehicle pace, in reverse. */
  paces: string[];
  /** The pace "reverse" stands for (the slowest vehicle pace), if offered. */
  reversePace?: string;
  /** Get in (men on foot with a vehicle to ride in) / get out (men aboard, or a vehicle with passengers) (M7.2). */
  mount: boolean;
  dismount: boolean;
  /** Vehicles (M7.3): the smoke dischargers, and the choice of gun and round for a fire order. */
  discharge: boolean;
  nature: boolean;
  /** The guns and rounds the vehicle's type has (M7.5a: the nature button cycles only through these). */
  natures?: Nature[];
  /** "Take wounded back" (M10.6b, owner Q-9): a combat vehicle's rear run. Absent: not offered. */
  rearRun?: boolean;
  /** "Repair" (M11.7a): the crew has a field repair it can do now (not already at it). Absent: not offered. */
  repair?: boolean;
  /** "Recover" (M11.7b): call a recovery vehicle for the crew's disabled hull (or the hull it bailed out of); `recoverLeft`
   *  recovery vehicles still wait. Absent: not offered. */
  recover?: boolean;
  recoverLeft?: number;
  /** "Take enemy kit" (M11.2): a known enemy casualty or prisoner is near enough. Absent: not offered. */
  takeKit?: boolean;
  /** "Resupply" (M11.3): an own cache with supplies is within reach. Absent: not offered. */
  resupply?: boolean;
  /** "Fetch ammunition" (M11.4a): two of the squad's men bring a crate from the platoon's supply point. */
  fetchAmmo?: boolean;
  /** "Order a delivery" (M11.4b): the side's supply vehicle waits off the map (`deliveryLeft` of them) and its stock
   *  holds supplies. Absent: not offered. */
  delivery?: boolean;
  deliveryLeft?: number;
  /** "Restock" (M11.4b): the hull goes back for ammunition (its side has a stock). Absent: not offered. */
  supplyRun?: boolean;
  /** "Escort prisoners" (M11.9a): the unit's prisoners wait for an escort. Absent: not offered. */
  escortPrisoners?: boolean;
  /** "Release guard" (M11.9a): men of the unit are on prisoner duty. Absent: not offered. */
  releaseGuard?: boolean;
  /** "Call MP" (M11.9b): the platoon holds prisoners; `mpLeft` military police teams wait off the map. Absent: not
   *  offered. */
  callMp?: boolean;
  mpLeft?: number;
}

/** What the selected unit can do about vehicles now (M7.2). */
export interface BoardingChoice { mount: boolean; dismount: boolean }

/**
 * What a unit can do now (M7.5a). `kind`: "vehicle" (a crew unit with its hull), "man" (a unit of one able man,
 * plan §7.4), "group" (a squad, team, platoon on foot or aboard), "none" (nothing selected or the unit is gone).
 */
export interface UnitCapabilities {
  kind: "none" | "group" | "man" | "vehicle";
  /** The vehicle's movement class (tracked / wheeled), null on foot. */
  vehicleClass: "tracked" | "wheeled" | null;
  /** Able men (aboard or not; a vehicle: its crew). */
  ableMen: number;
  /** Able men on foot (not aboard a vehicle; D4b: an arc is for them). Absent: as `ableMen`. */
  onFoot?: number;
  /** An able man has an anti-tank launcher with a round for it (the same test as the simulation's `launcherRound`). */
  hasLauncherRounds: boolean;
  /** Hand grenades and rifle grenades (with their launcher) among the able men. */
  handGrenades: number;
  rifleGrenades: number;
  /** Hand smoke grenades among the able men (D1). */
  smokeGrenades: number;
  /** Mortar rounds the side can still call (HE, smoke). */
  supportHe: number;
  supportSmoke: number;
  canMount: boolean;
  canDismount: boolean;
  /** Men riding in the vehicle (a vehicle selected). */
  passengers: number;
  hasSmokeDischargers: boolean;
  natures: Nature[];
  /** The unit's own men alone (a platoon's headquarters, owner 2026-11-15): no drills. */
  own?: boolean;
  /** A combat vehicle that can take wounded back (M10.6b): the battle has rear runs, it is on the map, not on one. */
  canRearRun?: boolean;
  /** The crew can start a field repair now (M11.7a): a task with its parts aboard, not already working at it. */
  canRepair?: boolean;
  /** M11.9a: the platoon holds prisoners (or has a collection point): "Prisoner point" is offered. */
  prisonerPoint?: boolean;
  /** M11.9a: prisoners of the unit waiting for an escort, and its men on prisoner duty. */
  powWaiting?: number;
  /** M11.9b: the platoon holds prisoners (the military police can be called; `mpLeft` wait off the map). */
  powHeld?: boolean;
  mpLeft?: number;
  powDuty?: number;
  /** A recovery vehicle can be called for this crew's hull (M11.7b): immobilised or abandoned, none coming yet, one
   *  waiting (`recoverLeft`). */
  canRecover?: boolean;
  recoverLeft?: number;
  /** M11.2: the nearest enemy casualty or prisoner the unit's men know of (their contacts marked down or given up)
   *  within `consolidate.kitM` of one of its able men on foot: the source of a "Take enemy kit" order. */
  kitSource?: EntityId;
  /** M11.3: the own cache with supplies a "Resupply" order would send its men on foot to (`supply.take.reachM`). */
  supplySource?: EntityId;
  /** M11.3: the battle has supply points (core/supply.json): "Supply point" is offered to units on foot. */
  supply?: boolean;
  /** M11.4a: a squad on foot whose platoon has a supply point with supplies: "Fetch ammunition" is offered. */
  bearers?: boolean;
  /** M11.4a: its request for ammunition waits for the player (rule "ask"): "Send bearers" on the card. */
  supplyAsk?: boolean;
  /** M11.4b: supply vehicles of its side waiting off the map with a stock to bring (none on its way): "Order a
   *  delivery". */
  deliveryLeft?: number;
  /** M11.4b: the crew's hull can go back for ammunition (its side has an off-map stock): "Restock". */
  canSupplyRun?: boolean;
}

const NONE: UnitCapabilities = { kind: "none", vehicleClass: null, ableMen: 0, hasLauncherRounds: false, handGrenades: 0, rifleGrenades: 0, smokeGrenades: 0, supportHe: 0, supportSmoke: 0, canMount: false, canDismount: false, passengers: 0, hasSmokeDischargers: false, natures: [] };

/** M11.4a: the supply point of the unit's platoon (its top unit) holds supplies (not burning). */
function platoonPointHasSupplies(view: SimView, unitId: EntityId): boolean {
  let top = unitId;
  for (let p = view.unit.get(top)?.parent ?? null; p !== null; p = view.unit.get(top)?.parent ?? null) top = p;
  for (const [, r] of view.rear.entries()) {
    if (r.kind !== "supply" || r.unit !== top || r.cache === undefined) continue;
    const c = view.cache.get(r.cache);
    if (c && c.cookoff === undefined && (view.container.get(r.cache)?.stacks.length ?? 0) > 0) return true;
  }
  return false;
}

/** All soldiers of a unit and its sub-units. */
export function unitSoldierIds(view: SimView, unit: EntityId): EntityId[] {
  const u = view.unit.get(unit);
  if (!u) return [];
  return [...u.members, ...u.children.flatMap((c) => unitSoldierIds(view, c))];
}

const countIn = (view: SimView, id: EntityId, item: string) => {
  let n = 0;
  for (const st of view.container.get(id)?.stacks ?? []) if (st.type === item) n += st.count;
  return n;
};

/**
 * Can the unit get in (men on foot whose unit, or a unit above it, has a carrier) or out (men aboard; a vehicle
 * with passengers)? (M7.2; moved here from the app in M7.5a.)
 */
export function boardingOf(view: SimView, catalog: Catalog, uid: EntityId | null, own = false): BoardingChoice {
  const u = uid === null ? undefined : view.unit.get(uid);
  if (!u || uid === null) return { mount: false, dismount: false };
  if (u.vehicle !== undefined) {
    const v = view.vehicle.get(u.vehicle), def = v ? catalog.vehicles[v.def] : undefined;
    return { mount: false, dismount: !!v && !!def && v.seats.some((o, i) => o !== null && def.seats[i]?.station === "passenger") };
  }
  let carrier = false;
  for (let x: EntityId | null = uid; x !== null; x = view.unit.get(x)?.parent ?? null) if (view.unit.get(x)?.carrier !== undefined) carrier = true;
  // (`own`: the unit's own men alone, a platoon's headquarters, owner 2026-11-15.)
  const men = (own ? [...u.members] : unitSoldierIds(view, uid)).filter((m) => view.unit.get(view.identity.get(m)?.unit ?? -1)?.vehicle === undefined && !isOut(view.soldier.req(m)));
  return { mount: carrier && men.some((m) => view.soldier.req(m).mount === undefined), dismount: men.some((m) => view.soldier.req(m).mount !== undefined) };
}

/** What the unit can do now (pure, reads the state only). `own` (owner 2026-11-15): its own men alone (a platoon's
 *  headquarters without its squads and vehicles). */
export function unitCapabilities(view: SimView, catalog: Catalog, unitId: EntityId | null, own = false): UnitCapabilities {
  const u = unitId === null ? undefined : view.unit.get(unitId);
  if (!u || unitId === null) return NONE;
  const out: UnitCapabilities = { ...NONE, natures: [] };
  const b = boardingOf(view, catalog, unitId, own);
  if (own) out.own = true;
  out.canMount = b.mount; out.canDismount = b.dismount;
  out.supportHe = supportLeft(view, u.side, "he", catalog);
  out.supportSmoke = supportLeft(view, u.side, "smoke", catalog);
  const veh = u.vehicle !== undefined ? view.vehicle.get(u.vehicle) : undefined;
  const vdef = veh ? catalog.vehicles[veh.def] : undefined;
  if (veh && vdef && u.vehicle !== undefined) {
    out.kind = "vehicle";
    out.vehicleClass = vdef.class === "wheeled" ? "wheeled" : "tracked";
    out.ableMen = veh.seats.filter((o, i) => o !== null && vdef.seats[i]?.station !== "passenger" && isAble(view.soldier.get(o))).length;
    out.passengers = veh.seats.filter((o, i) => o !== null && vdef.seats[i]?.station === "passenger").length;
    out.hasSmokeDischargers = vdef.dischargers !== undefined && countIn(view, u.vehicle, vdef.dischargers.item) > 0;
    if (catalog.medical?.rearRun !== undefined && veh.offMap === undefined && veh.rearRun === undefined && (veh.status === "ok" || veh.status === "disarmed")) {
      out.canRearRun = true;
      // (M11.4b: "Restock" when its side has an off-map stock; never offered for a marked ambulance.)
      if (catalog.supply?.vehicleRun !== undefined && vdef.ambulance === undefined && hasStock(view, u.side)) out.canSupplyRun = true;
    }
    if (catalog.repair !== undefined && veh.offMap === undefined && veh.rearRun === undefined && veh.repair?.working !== true && veh.fire === null && (veh.status !== "abandoned" && veh.status !== "destroyed")
      && typeof repairTaskFor(catalog, view, u.vehicle, veh, vdef) !== "string") out.canRepair = true;
    // The natures its guns offer: a coaxial machine gun "mg"; a cannon "ap" / "he" by the feed's round.
    const set = new Set<Nature>();
    vdef.stations.forEach((st, si) => st.weapons.forEach((w, wi) => {
      // A guided missile launcher (owner 2026-11-13): "Anti-tank" while a missile is on it or in stowage.
      const round = catalog.items[w.feeds[0]?.item ?? ""]?.chargeItem;
      if (round !== undefined && catalog.ammo[round]?.guided !== undefined) {
        if ((veh.stations[si]?.weapons[wi]?.feeds[0]?.rounds ?? 0) > 0 || countIn(view, u.vehicle!, w.feeds[0]!.item) > 0) out.hasLauncherRounds = true;
        return;
      }
      const cannon = catalog.weapons[w.weapon]?.type === "autocannon" || !w.coax;
      if (!cannon) { set.add("mg"); return; }
      for (const f of w.feeds) { const r = catalog.items[f.item]?.chargeItem; set.add(r !== undefined && catalog.ammo[r]?.explosive !== undefined ? "he" : "ap"); }
    }));
    out.natures = (["ap", "he", "mg"] as const).filter((n) => set.has(n));
    recoverable(view, catalog, u.side, veh, out);
    return out;
  }
  // (M11.7b: a crew that bailed out can still call a recovery vehicle for the hull it left.)
  if (u.exVehicle !== undefined) recoverable(view, catalog, u.side, view.vehicle.get(u.exVehicle), out);
  out.kind = "group";
  out.onFoot = 0;
  for (const m of own ? u.members : unitSoldierIds(view, unitId)) {
    const s = view.soldier.get(m);
    if (!isAble(s)) continue;
    out.ableMen++;
    if (s!.mount === undefined) out.onFoot = (out.onFoot ?? 0) + 1;
    const c = view.container.get(m);
    if (!c) continue;
    for (const st of c.stacks) {
      if (st.count <= 0) continue;
      const d = catalog.ammo[st.type]?.delivery;
      if (!d) continue;
      if (d.method === "direct") { if (d.launcher !== undefined ? countIn(view, m, d.launcher) > 0 : d.disposable === true) out.hasLauncherRounds = true; continue; }
      if (catalog.ammo[st.type]?.smoke !== undefined && d.method === "thrown") { out.smokeGrenades += st.count; continue; }
      if (!catalog.ammo[st.type]?.explosive) continue;
      if (d.method === "thrown") out.handGrenades += st.count;
      else if (d.launcher !== undefined && countIn(view, m, d.launcher) > 0) out.rifleGrenades += st.count;
    }
  }
  const kit = kitSourceNear(view, catalog, own ? [...u.members] : unitSoldierIds(view, unitId));
  if (kit !== null) out.kitSource = kit;
  if (catalog.supply !== undefined) {
    out.supply = true;
    const src = supplySourceNear(view, catalog, u.side, own ? [...u.members] : unitSoldierIds(view, unitId));
    if (src !== null) out.supplySource = src;
    if (catalog.supply.bearers !== undefined && u.parent !== null && u.vehicle === undefined && u.members.length > 0 && platoonPointHasSupplies(view, unitId)) out.bearers = true;
    if (u.supplyAsk?.pending === true) out.supplyAsk = true;
    const left = deliveriesLeft(view, catalog, u.side);
    if (left > 0 && u.members.length > 0 && u.vehicle === undefined) out.deliveryLeft = left;
  }
  if (catalog.prisoners !== undefined && u.vehicle === undefined) {
    // (M11.9a: the platoon's collection point once it holds prisoners; escorts and guards of the unit's own.)
    let top = unitId;
    for (let p = view.unit.get(top)?.parent ?? null; p !== null; p = view.unit.get(top)?.parent ?? null) top = p;
    const mine = prisonerSummary(view, unitId);
    if (mine.waiting > 0) out.powWaiting = mine.waiting;
    if (mine.escorts + mine.guards > 0) out.powDuty = mine.escorts + mine.guards;
    const held = prisonerSummary(view, top).total;
    if (held > 0 || [...view.rear.entries()].some(([, r]) => r.kind === "prisoners" && r.unit === top)) out.prisonerPoint = true;
    if (held > 0 && catalog.prisoners.mp !== undefined) { out.powHeld = true; out.mpLeft = mpLeft(view, u.side); }
  }
  if (out.ableMen === 1) out.kind = "man";
  if (out.ableMen === 0) out.kind = "none"; // nobody left to take an order
  return out;
}

/** M11.4b: does the side have an off-map stock with anything in it? */
function hasStock(view: SimView, side: string): boolean {
  for (const [id, st] of view.stock.entries()) if (st.side === side && (view.container.get(id)?.stacks.some((x) => x.count > 0) ?? false)) return true;
  return false;
}

/** M11.4b: supply vehicles of the side waiting off the map, 0 when a delivery is under way or the side has no stock. */
export function deliveriesLeft(view: SimView, catalog: Catalog, side: string): number {
  if (catalog.supply?.delivery === undefined || !hasStock(view, side)) return 0;
  let n = 0;
  for (const [, v] of view.vehicle.entries()) {
    const o = v.offMap;
    if (v.side !== side || o === undefined) continue;
    if (o.cargo === "supplies" && (o.phase === "called" || o.phase === "inbound" || o.phase === "loading" || o.phase === "outbound")) return 0;
    if (o.kind === "supply" && o.phase === "ready") n++;
  }
  return n;
}

/** M11.7b: can a recovery vehicle be called for this hull now (disabled, not burning, none coming, one waiting)? */
function recoverable(view: SimView, catalog: Catalog, side: string, v: ReturnType<SimView["vehicle"]["get"]>, out: UnitCapabilities): void {
  if (catalog.recovery === undefined || !v || v.offMap !== undefined || isOffMap(v) || v.recoveryBy !== undefined || v.fire !== null) return;
  if (v.status !== "immobilised" && v.status !== "abandoned") return;
  let left = 0;
  for (const [, x] of view.vehicle.entries()) if (x.side === side && x.offMap?.kind === "recovery" && x.offMap.phase === "ready") left++;
  if (left === 0) return;
  out.canRecover = true; out.recoverLeft = left;
}

/**
 * The enemy casualty or prisoner nearest to these men that one of them knows of (M11.2: his contact marked down or
 * given up; the player's knowledge, never the enemy's real state) within `consolidate.kitM` of an able man on foot,
 * or null.
 */
export function kitSourceNear(view: SimView, catalog: Catalog, men: readonly EntityId[]): EntityId | null {
  const R = catalog.behaviour.consolidate?.kitM;
  if (R === undefined) return null;
  let best: EntityId | null = null, bestD = R * R;
  for (const m of men) {
    const s = view.soldier.get(m), t = view.transform.get(m);
    if (!s || !t || !isAble(s) || s.mount !== undefined) continue;
    for (const c of s.contacts) {
      if (c.down !== true && c.surrendered !== true) continue;
      if (!view.container.has(c.target)) continue;
      const d = (c.x - t.x) * (c.x - t.x) + (c.y - t.y) * (c.y - t.y);
      if (d < bestD || (d === bestD && best !== null && c.target < best)) { bestD = d; best = c.target; }
    }
  }
  return best;
}

export const FOOT_PACES = ["walk", "run", "sneak", "crawl"];
const FOOT_MODES: OrderMode[] = ["move", "assault", "withdraw", "occupy", "clear", "fire", "antitank", "grenade", "grenades", "smoke", "support", "arc"];
type Modes = Readonly<Record<string, { class: string; speedFraction?: number }>>;

/** The greyed bar shown while nothing is selected (M7.5a, owner answer 6). */
export function noOrders(): OrderSet {
  return { none: true, modes: ["move", "assault", "fire", "grenade"], halt: true, ceaseFire: true, posture: true, rules: true, paces: FOOT_PACES, mount: false, dismount: false, discharge: false, nature: false };
}

/** The bar for a reconnaissance quadcopter (M9.4a): Move (a tap sends it there) and Halt (home to land). */
export function droneOrders(): OrderSet {
  return { modes: ["move"], halt: true, ceaseFire: false, posture: false, rules: false, paces: ["walk"], mount: false, dismount: false, discharge: false, nature: false };
}

/** The bar for a vehicle of this class: move and fire; its class's paces (drive first) and reverse. */
function vehicleOrders(vehicleClass: "tracked" | "wheeled", modes: Modes, boarding: BoardingChoice): OrderSet {
  const paces = Object.entries(modes).filter(([, m]) => m.class === vehicleClass).sort((a, b) => (a[1].speedFraction ?? 0) - (b[1].speedFraction ?? 0) || (a[0] < b[0] ? -1 : 1)).map(([id]) => id);
  // Default: the middle pace ("drive"), then the others, then reverse.
  const mid = paces[Math.floor((paces.length - 1) / 2)];
  const ordered = mid === undefined ? [] : [mid, ...paces.filter((p) => p !== mid)];
  // A vehicle's crew can only let its passengers out (they get in by an order to their own unit).
  // It fires its guns (M7.3) and its smoke dischargers.
  // (Balance pass 5: Assault: its passengers get out short of the objective and assault it while it supports them by
  // fire; with nobody aboard, assault by fire from a post short of it.)
  const out: OrderSet = { modes: ["move", "assault", "fire"], halt: true, ceaseFire: true, posture: false, rules: true, paces: ordered, mount: false, dismount: boarding.dismount, discharge: true, nature: true };
  if (paces[0] !== undefined) { out.paces = [...ordered, "reverse"]; out.reversePace = paces[0]; }
  return out;
}

/**
 * The order bar for a unit. Given capabilities (M7.5a): only the relevant actions — Anti-tank only with launcher
 * rounds, grenades only with grenades, Fire support only with mortar rounds left, the smoke screen only with
 * dischargers loaded; a single man moves, fires, throws, changes posture, halts and ceases fire.
 * Given a vehicle class or null (M7.1c form, kept for the planner): the full bar of that class.
 */
export function ordersFor(cap: UnitCapabilities | "tracked" | "wheeled" | null, modes: Modes, boarding: BoardingChoice = { mount: false, dismount: false }): OrderSet {
  const o = ordersForBase(cap, modes, boarding);
  // (M11.9a: prisoners — the collection point in the Move tray, escorts now, a guard back to his squad.)
  if (cap !== null && typeof cap !== "string" && cap.kind !== "none" && cap.kind !== "vehicle") {
    if (cap.prisonerPoint === true && cap.own !== true) o.modes = [...o.modes, "prisoners"];
    if ((cap.powWaiting ?? 0) > 0) o.escortPrisoners = true;
    if ((cap.powDuty ?? 0) > 0) o.releaseGuard = true;
    if (cap.powHeld === true) { o.callMp = true; o.mpLeft = cap.mpLeft ?? 0; }
  }
  return o;
}

function ordersForBase(cap: UnitCapabilities | "tracked" | "wheeled" | null, modes: Modes, boarding: BoardingChoice): OrderSet {
  if (cap === null) return { modes: FOOT_MODES, halt: true, ceaseFire: true, posture: true, rules: true, paces: FOOT_PACES, mount: boarding.mount, dismount: boarding.dismount, discharge: false, nature: false };
  if (typeof cap === "string") return vehicleOrders(cap, modes, boarding);
  if (cap.kind === "none") return noOrders();
  const b = { mount: cap.canMount, dismount: cap.canDismount };
  if (cap.kind === "vehicle" && cap.vehicleClass !== null) {
    const o = vehicleOrders(cap.vehicleClass, modes, b);
    o.discharge = cap.hasSmokeDischargers;
    o.natures = cap.natures;
    o.nature = cap.natures.length > 1;
    if (cap.hasLauncherRounds) o.modes = [...o.modes, "antitank"];
    if (cap.canRearRun) o.rearRun = true;
    if (cap.canSupplyRun) o.supplyRun = true;
    if (cap.canRepair) o.repair = true;
    if (cap.canRecover) { o.recover = true; o.recoverLeft = cap.recoverLeft ?? 0; }
    return o;
  }
  const grenades = cap.handGrenades + cap.rifleGrenades;
  // A platoon's headquarters on its own (owner 2026-11-15): moves, fire, grenades, smoke, fire support, getting
  // in and out; no drills (assault, withdraw, occupy, clear are the platoon's or a squad's).
  if (cap.own === true) {
    const m: OrderMode[] = ["move", "fire"];
    if (cap.hasLauncherRounds) m.push("antitank");
    if (grenades > 0) m.push("grenade");
    if (cap.smokeGrenades > 0) m.push("smoke");
    if (cap.supportHe > 0 || cap.supportSmoke > 0) m.push("support");
    if (onFoot(cap)) m.push("arc"); // (D4b: Defend arc, a unit's; not for men all aboard)
    if (cap.supply === true) m.push("supply"); // (M11.3: the platoon's supply point)
    return { modes: m, halt: true, ceaseFire: true, posture: true, rules: true, paces: FOOT_PACES, mount: b.mount, dismount: b.dismount, discharge: false, nature: false, ...(cap.kitSource !== undefined ? { takeKit: true } : {}), ...(cap.supplySource !== undefined ? { resupply: true } : {}), ...(cap.bearers === true ? { fetchAmmo: true } : {}), ...(cap.deliveryLeft !== undefined ? { delivery: true, deliveryLeft: cap.deliveryLeft } : {}) };
  }
  if (cap.kind === "man") {
    return { modes: ["move", "occupy", "fire", ...(grenades > 0 ? ["grenade" as const] : []), ...(cap.smokeGrenades > 0 ? ["smoke" as const] : [])], halt: true, ceaseFire: true, posture: true, rules: false, paces: FOOT_PACES, mount: b.mount, dismount: b.dismount, discharge: false, nature: false, ...(cap.canRecover ? { recover: true, recoverLeft: cap.recoverLeft ?? 0 } : {}), ...(cap.kitSource !== undefined ? { takeKit: true } : {}), ...(cap.supplySource !== undefined ? { resupply: true } : {}), ...(cap.bearers === true ? { fetchAmmo: true } : {}) };
  }
  // (Slice s0-clear: Clear a house — a squad's drill, never a single man's.)
  const m: OrderMode[] = ["move", "assault", "withdraw", "occupy", "clear", "fire"];
  if (cap.hasLauncherRounds) m.push("antitank");
  if (grenades > 0) m.push("grenade");
  if (grenades > 1) m.push("grenades");
  // (D1: a hand smoke screen, thrown by one man.)
  if (cap.smokeGrenades > 0) m.push("smoke");
  // (Step fire-support: one Fire support button; the pop-up offers what is left of HE and smoke.)
  if (cap.supportHe > 0 || cap.supportSmoke > 0) m.push("support");
  // (D4b: Defend arc — a unit on foot faces a sector and fires on its own only into it; not offered while all its
  // men are aboard: the sim would answer "unable" for a platoon whose squads ride.)
  if (onFoot(cap)) m.push("arc");
  // (M11.3: Supply point — the platoon's, put where the player taps.)
  if (cap.supply === true) m.push("supply");
  return { modes: m, halt: true, ceaseFire: true, posture: true, rules: true, paces: FOOT_PACES, mount: b.mount, dismount: b.dismount, discharge: false, nature: false, ...(cap.canRecover ? { recover: true, recoverLeft: cap.recoverLeft ?? 0 } : {}), ...(cap.kitSource !== undefined ? { takeKit: true } : {}), ...(cap.supplySource !== undefined ? { resupply: true } : {}), ...(cap.bearers === true ? { fetchAmmo: true } : {}), ...(cap.deliveryLeft !== undefined ? { delivery: true, deliveryLeft: cap.deliveryLeft } : {}) };
}

/** Has the unit able men on foot (D4b)? */
function onFoot(cap: UnitCapabilities): boolean {
  return (cap.onFoot ?? cap.ableMen) > 0;
}

/** A planned leg's pace as a waypoint mode: "reverse" drives the slowest vehicle pace backwards. */
export function paceToWaypoint(pace: string, set: OrderSet): { mode: string; reverse?: true } {
  if (pace === "reverse" && set.reversePace !== undefined) return { mode: set.reversePace, reverse: true };
  return { mode: pace };
}
