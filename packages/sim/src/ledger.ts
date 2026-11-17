/**
 * THE LEDGER (M11.1, plan section 4): counts every countable thing in a battle, from the state alone (pure; tools and
 * tests only, never the sim's own systems: it costs a walk over every container).
 *
 * - `ammo`: rounds and whole rounds of ammunition, by ammunition id. A magazine, belt, bandolier, can or box counts its
 *   charge under its `chargeItem` (the cartridge); a whole item whose id is an ammunition id (a hand grenade, a
 *   rocket, a mortar bomb, a missile) counts one each. Wherever they are: containers (men, vehicles, crates, support
 *   sections, off-map assets, casualties, carried men), the magazine in a weapon, a vehicle's ready feeds, the box on
 *   an automatic grenade launcher, and an off-map fire mission's rounds already taken from the section. Not a side's
 *   off-map stock (M11.4b): it is outside the battle; what leaves it for the battle is "delivered".
 * - `charge`: other charge by its `chargeKind` (litres of diesel, watt-hours).
 * - `items`: whole items by item id (every stack, magazines and tanks too, regardless of charge).
 *
 * The conservation guard (`consumedFromEvents` + `checkConservation`): for every ammunition id
 * `start - end = fired + thrown + destroyed - delivered`, where the right-hand side comes from the event stream alone
 * (rule 5). A leak is any difference.
 */
import type { Catalog } from "./catalog";
import type { SimEvent } from "./events";
import type { SimView } from "./state";

export interface Ledger {
  ammo: Record<string, number>;
  charge: Record<string, number>;
  items: Record<string, number>;
}

function add(m: Record<string, number>, k: string, n: number): void {
  if (n === 0) return;
  m[k] = (m[k] ?? 0) + n;
}

/** The charge kind of an item: its cartridge (`chargeItem`) for rounds, else its `chargeKind`, else none. */
export function chargeKindOf(catalog: Catalog, item: string): string | undefined {
  const d = catalog.items[item];
  return d?.chargeItem ?? d?.chargeKind;
}

/** Count everything in the state. */
export function ledgerOf(catalog: Catalog, state: SimView): Ledger {
  const out: Ledger = { ammo: {}, charge: {}, items: {} };
  const rounds = (item: string, n: number) => {
    const d = catalog.items[item];
    if (d?.chargeItem !== undefined) add(out.ammo, d.chargeItem, n);
    else if (d?.chargeKind !== undefined) add(out.charge, d.chargeKind, n);
  };
  for (const [id, c] of state.container.entries()) {
    // (M11.4b: a side's off-map stock is outside the battle: what leaves it is delivered, `items.delivered`.)
    if (state.stock.has(id)) continue;
    for (const s of c.stacks) {
      add(out.items, s.type, s.count);
      if (s.charge !== undefined) rounds(s.type, s.charge * s.count);
      else if (catalog.ammo[s.type] !== undefined) add(out.ammo, s.type, s.count);
    }
  }
  // mounted: ok every magazine counts, aboard or not
  for (const [, w] of state.weapon.entries()) {
    if (w.magazine) { rounds(w.magazine.item, w.magazine.rounds); add(out.items, w.magazine.item, 1); }
    // (M11.2: a weapon in the hands counts as its item, so a rifle put away or picked up neither appears nor vanishes.)
    const wi = catalog.weapons[w.weapon]?.weaponItem;
    if (wi !== undefined) add(out.items, wi, 1);
  }
  for (const [, v] of state.vehicle.entries()) { // off-map: ok every vehicle's rounds count, on the map or not
    for (const st of v.stations) for (const w of st.weapons) for (const f of w.feeds) rounds(f.item, f.rounds);
    // (A smoke salvo ordered but not yet fired: its grenades left the container at the order, gunnery.ts.)
    const D = catalog.vehicles[v.def]?.dischargers;
    if (D && v.pendingSmokeTick >= 0) add(out.ammo, D.item, D.perSalvo);
  }
  for (const [, u] of state.unit.entries()) { const b = u.missileTeam?.box; if (b) rounds(b.item, b.rounds); }
  // An off-map fire mission's rounds left the section's container when it was called (support.ts); on-map missions
  // take each round from the tubes as it is fired.
  for (const m of state.fireMissions) {
    if (m.tubes !== undefined || m.left <= 0) continue;
    const type = missionItem(state, m.side, m.asset, m.ammo);
    if (type !== undefined) add(out.ammo, type, m.left);
  }
  return out;
}

/** The ammunition (by id) that some entities hold: their containers and the magazines in their weapons. For a unit
 *  arriving late (M11.1): it enters the battle as a delivery. */
export function ammoOf(catalog: Catalog, state: SimView, ids: readonly number[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of ids) {
    const c = state.container.get(id);
    if (c) for (const s of c.stacks) {
      const d = catalog.items[s.type];
      if (s.charge !== undefined && d?.chargeItem !== undefined) add(out, d.chargeItem, s.charge * s.count);
      else if (s.charge === undefined && catalog.ammo[s.type] !== undefined) add(out, s.type, s.count);
    }
    const w = state.weapon.get(id);
    const mi = w?.magazine ? catalog.items[w.magazine.item]?.chargeItem : undefined;
    if (w?.magazine && mi !== undefined) add(out, mi, w.magazine.rounds);
  }
  return out;
}

/** The item a section fires for a mission's ammunition kind. */
export function missionItem(state: SimView, side: string, asset: "artillery" | undefined, ammo: "he" | "smoke" | "illum"): string | undefined {
  const sec = state.support.find((s) => s.side === side && (s.asset === "artillery") === (asset === "artillery"));
  if (!sec) return undefined;
  return ammo === "he" ? sec.heType : ammo === "smoke" ? sec.smokeType : sec.illumType;
}

/** What the events say left or entered the battle, by ammunition id: used (fired, thrown, launched, landed off-map
 *  rounds), destroyed and delivered. Tracer rounds count as their belt's cartridge (the belt counts them so). */
export interface Consumption {
  used: Record<string, number>; destroyed: Record<string, number>; delivered: Record<string, number>;
  /** M11.5: the same for charge by its kind (litres of diesel): burnt, destroyed, delivered. Absent in older tallies. */
  charge?: { used: Record<string, number>; destroyed: Record<string, number>; delivered: Record<string, number> };
}

export function emptyConsumption(): Consumption { return { used: {}, destroyed: {}, delivered: {}, charge: { used: {}, destroyed: {}, delivered: {} } }; }

/** M11.5: the charge kinds whose use the events report (fuels: litres burnt, `items.burnt`), sorted. */
export function fuelKinds(catalog: Catalog): string[] {
  const out = new Set<string>();
  for (const d of Object.values(catalog.items)) if (d.category === "fuel" && d.chargeKind !== undefined) out.add(d.chargeKind);
  return [...out].sort();
}

export function tracerMap(catalog: Catalog): Record<string, string> {
  const t: Record<string, string> = {};
  for (const d of Object.values(catalog.items)) if (d.tracerItem !== undefined && d.chargeItem !== undefined) t[d.tracerItem] = d.chargeItem;
  return t;
}

/** Add one tick's events to the tally. */
export function consumedFromEvents(out: Consumption, events: readonly SimEvent[], tracer: Record<string, string>): void {
  for (const e of events) {
    if (e.kind === "shot.fired") add(out.used, tracer[e.ammo] ?? e.ammo, 1);
    else if (e.kind === "grenade.launched") add(out.used, e.ammo, 1);
    else if (e.kind === "vehicle.smoke") { if (e.item !== undefined) add(out.used, e.item, e.count ?? 0); }
    else if (e.kind === "support.round") { if (e.item !== undefined) add(out.used, e.item, 1); }
    else if (e.kind === "items.destroyed") {
      if (e.ammo !== undefined) add(out.destroyed, e.ammo, e.rounds ?? 0);
      if (e.chargeKind !== undefined) add((out.charge ??= { used: {}, destroyed: {}, delivered: {} }).destroyed, e.chargeKind, e.amount ?? 0);
    } else if (e.kind === "items.delivered") {
      if (e.ammo !== undefined) add(out.delivered, e.ammo, e.rounds ?? 0);
      if (e.chargeKind !== undefined) add((out.charge ??= { used: {}, destroyed: {}, delivered: {} }).delivered, e.chargeKind, e.amount ?? 0);
    } else if (e.kind === "items.burnt") add((out.charge ??= { used: {}, destroyed: {}, delivered: {} }).used, e.chargeKind, e.amount);
  }
}

/** Every ammunition id where start - end != used + destroyed - delivered, with the difference (positive: rounds
 *  vanished unexplained; negative: rounds appeared). Empty: exact. */
export function checkConservation(start: Ledger, end: Ledger, c: Consumption): Record<string, number> {
  const keys = new Set([...Object.keys(start.ammo), ...Object.keys(end.ammo), ...Object.keys(c.used), ...Object.keys(c.destroyed), ...Object.keys(c.delivered)]);
  const leaks: Record<string, number> = {};
  for (const k of [...keys].sort()) {
    const d = (start.ammo[k] ?? 0) - (end.ammo[k] ?? 0) - ((c.used[k] ?? 0) + (c.destroyed[k] ?? 0) - (c.delivered[k] ?? 0));
    if (d !== 0) leaks[k] = d;
  }
  return leaks;
}

/** M11.5: the same check for charge of kinds `kinds` (litres: equal within `tol`). Empty: exact. */
export function checkChargeConservation(start: Ledger, end: Ledger, c: Consumption, kinds: readonly string[], tol = 1e-6): Record<string, number> {
  const ch = c.charge ?? { used: {}, destroyed: {}, delivered: {} };
  const leaks: Record<string, number> = {};
  for (const k of kinds) {
    const d = (start.charge[k] ?? 0) - (end.charge[k] ?? 0) - ((ch.used[k] ?? 0) + (ch.destroyed[k] ?? 0) - (ch.delivered[k] ?? 0));
    if (Math.abs(d) > tol) leaks[k] = d;
  }
  return leaks;
}
