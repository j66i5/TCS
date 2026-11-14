/**
 * Which orders the order bar offers for the selected unit. M7.1c told men on foot from a vehicle crew; M7.5a
 * (plan m7.5 §3) offers only what the unit can actually do now: `unitCapabilities` reads the state (a launcher
 * with rounds, grenades, fire support left, a vehicle to ride in, smoke dischargers, the guns' natures) and
 * `ordersFor` turns it into the bar. Nothing selected: every button shown greyed (`none`). Pure: tested
 * without a DOM.
 */
import { isAble, isOut, supportLeft, type Catalog, type EntityId, type SimView } from "@tcs/sim";
import type { OrderMode } from "./hud";

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
  /** An able man has an anti-tank launcher with a round for it (the same test as the simulation's `launcherRound`). */
  hasLauncherRounds: boolean;
  /** Hand grenades and rifle grenades (with their launcher) among the able men. */
  handGrenades: number;
  rifleGrenades: number;
  /** Mortar rounds the side can still call (HE, smoke). */
  supportHe: number;
  supportSmoke: number;
  canMount: boolean;
  canDismount: boolean;
  /** Men riding in the vehicle (a vehicle selected). */
  passengers: number;
  hasSmokeDischargers: boolean;
  natures: Nature[];
}

const NONE: UnitCapabilities = { kind: "none", vehicleClass: null, ableMen: 0, hasLauncherRounds: false, handGrenades: 0, rifleGrenades: 0, supportHe: 0, supportSmoke: 0, canMount: false, canDismount: false, passengers: 0, hasSmokeDischargers: false, natures: [] };

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
export function boardingOf(view: SimView, catalog: Catalog, uid: EntityId | null): BoardingChoice {
  const u = uid === null ? undefined : view.unit.get(uid);
  if (!u || uid === null) return { mount: false, dismount: false };
  if (u.vehicle !== undefined) {
    const v = view.vehicle.get(u.vehicle), def = v ? catalog.vehicles[v.def] : undefined;
    return { mount: false, dismount: !!v && !!def && v.seats.some((o, i) => o !== null && def.seats[i]?.station === "passenger") };
  }
  let carrier = false;
  for (let x: EntityId | null = uid; x !== null; x = view.unit.get(x)?.parent ?? null) if (view.unit.get(x)?.carrier !== undefined) carrier = true;
  const men = unitSoldierIds(view, uid).filter((m) => view.unit.get(view.identity.get(m)?.unit ?? -1)?.vehicle === undefined && !isOut(view.soldier.req(m)));
  return { mount: carrier && men.some((m) => view.soldier.req(m).mount === undefined), dismount: men.some((m) => view.soldier.req(m).mount !== undefined) };
}

/** What the unit can do now (pure, reads the state only). */
export function unitCapabilities(view: SimView, catalog: Catalog, unitId: EntityId | null): UnitCapabilities {
  const u = unitId === null ? undefined : view.unit.get(unitId);
  if (!u || unitId === null) return NONE;
  const out: UnitCapabilities = { ...NONE, natures: [] };
  const b = boardingOf(view, catalog, unitId);
  out.canMount = b.mount; out.canDismount = b.dismount;
  out.supportHe = supportLeft(view, u.side, "he");
  out.supportSmoke = supportLeft(view, u.side, "smoke");
  const veh = u.vehicle !== undefined ? view.vehicle.get(u.vehicle) : undefined;
  const vdef = veh ? catalog.vehicles[veh.def] : undefined;
  if (veh && vdef && u.vehicle !== undefined) {
    out.kind = "vehicle";
    out.vehicleClass = vdef.class === "wheeled" ? "wheeled" : "tracked";
    out.ableMen = veh.seats.filter((o, i) => o !== null && vdef.seats[i]?.station !== "passenger" && isAble(view.soldier.get(o))).length;
    out.passengers = veh.seats.filter((o, i) => o !== null && vdef.seats[i]?.station === "passenger").length;
    out.hasSmokeDischargers = vdef.dischargers !== undefined && countIn(view, u.vehicle, vdef.dischargers.item) > 0;
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
    return out;
  }
  out.kind = "group";
  for (const m of unitSoldierIds(view, unitId)) {
    const s = view.soldier.get(m);
    if (!isAble(s)) continue;
    out.ableMen++;
    const c = view.container.get(m);
    if (!c) continue;
    for (const st of c.stacks) {
      if (st.count <= 0) continue;
      const d = catalog.ammo[st.type]?.delivery;
      if (!d) continue;
      if (d.method === "direct") { if (d.launcher !== undefined && countIn(view, m, d.launcher) > 0) out.hasLauncherRounds = true; continue; }
      if (!catalog.ammo[st.type]?.explosive) continue;
      if (d.method === "thrown") out.handGrenades += st.count;
      else if (d.launcher !== undefined && countIn(view, m, d.launcher) > 0) out.rifleGrenades += st.count;
    }
  }
  if (out.ableMen === 1) out.kind = "man";
  if (out.ableMen === 0) out.kind = "none"; // nobody left to take an order
  return out;
}

export const FOOT_PACES = ["walk", "run", "sneak", "crawl"];
const FOOT_MODES: OrderMode[] = ["move", "assault", "withdraw", "occupy", "clear", "fire", "antitank", "grenade", "grenades", "support"];
type Modes = Readonly<Record<string, { class: string; speedFraction?: number }>>;

/** The greyed bar shown while nothing is selected (M7.5a, owner answer 6). */
export function noOrders(): OrderSet {
  return { none: true, modes: ["move", "assault", "fire", "grenade"], halt: true, ceaseFire: true, posture: true, rules: true, paces: FOOT_PACES, mount: false, dismount: false, discharge: false, nature: false };
}

/** The bar for a vehicle of this class: move and fire; its class's paces (drive first) and reverse. */
function vehicleOrders(vehicleClass: "tracked" | "wheeled", modes: Modes, boarding: BoardingChoice): OrderSet {
  const paces = Object.entries(modes).filter(([, m]) => m.class === vehicleClass).sort((a, b) => (a[1].speedFraction ?? 0) - (b[1].speedFraction ?? 0) || (a[0] < b[0] ? -1 : 1)).map(([id]) => id);
  // Default: the middle pace ("drive"), then the others, then reverse.
  const mid = paces[Math.floor((paces.length - 1) / 2)];
  const ordered = mid === undefined ? [] : [mid, ...paces.filter((p) => p !== mid)];
  // A vehicle's crew can only let its passengers out (they get in by an order to their own unit).
  // It fires its guns (M7.3) and its smoke dischargers.
  const out: OrderSet = { modes: ["move", "fire"], halt: true, ceaseFire: true, posture: false, rules: true, paces: ordered, mount: false, dismount: boarding.dismount, discharge: true, nature: true };
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
    return o;
  }
  const grenades = cap.handGrenades + cap.rifleGrenades;
  if (cap.kind === "man") {
    return { modes: ["move", "occupy", "fire", ...(grenades > 0 ? ["grenade" as const] : [])], halt: true, ceaseFire: true, posture: true, rules: false, paces: FOOT_PACES, mount: b.mount, dismount: b.dismount, discharge: false, nature: false };
  }
  // (Slice s0-clear: Clear a house — a squad's drill, never a single man's.)
  const m: OrderMode[] = ["move", "assault", "withdraw", "occupy", "clear", "fire"];
  if (cap.hasLauncherRounds) m.push("antitank");
  if (grenades > 0) m.push("grenade");
  if (grenades > 1) m.push("grenades");
  // (Step fire-support: one Fire support button; the pop-up offers what is left of HE and smoke.)
  if (cap.supportHe > 0 || cap.supportSmoke > 0) m.push("support");
  return { modes: m, halt: true, ceaseFire: true, posture: true, rules: true, paces: FOOT_PACES, mount: b.mount, dismount: b.dismount, discharge: false, nature: false };
}

/** A planned leg's pace as a waypoint mode: "reverse" drives the slowest vehicle pace backwards. */
export function paceToWaypoint(pace: string, set: OrderSet): { mode: string; reverse?: true } {
  if (pace === "reverse" && set.reversePace !== undefined) return { mode: set.reversePace, reverse: true };
  return { mode: pace };
}
