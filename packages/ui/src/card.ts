/**
 * The selected unit's card (the "bar-card" step, owner choices S3 and S6, 2026-11-13).
 *
 *   compact   the unit's name, men fit and state; two segmented rows always in view: how it moves (Run, Walk,
 *             Sneak, Crawl; a vehicle's own paces) and when it fires (Fire at will, Return fire, Hold, Ambush).
 *   detailed  also one row per man: his status pictogram, rank insignia, role, weapon, an ammunition bar (one cell
 *             per magazine or belt).
 *   man box   a tap on a row (or on one of the unit's men on the map): his insignia, status, name, rank, weapon and
 *             rounds, what he is doing, fatigue, stress, suppression and morale, his wounds.
 *
 * The data comes from read-only snapshots of the state (`unitMenRows`, `manDetail`; pure, tested without a DOM),
 * and every choice goes out as an existing order (pace: the next move, or the move under way sent again; fire: the
 * `rules` order — Ambush is the `ambush` order (D4b) at `AMBUSH_M`; `rulesOrder` builds either).
 */
import type { Insignia, Strings } from "@tcs/data";
import { shownCallsigns } from "@tcs/render";
import { isAble, isOut, MORALE_SOURCES, secondsToTicks, weaponOut, type Catalog, type EntityId, type Order, type SimView } from "@tcs/sim";
import type { UnitRules } from "./hud";
import { icon, paceIcon } from "./icons";
import { insigniaSvg } from "./insignia";
import { mentalPictogram, statusPictogram, type ManStatus } from "./pictograms";
import { unitSoldierIds } from "./orders-for";

/** A man's state as the card shows it (worst first: captive, down, wounded, pinned, shaken, steady). */
export type ManState = "steady" | "shaken" | "pinned" | "wounded" | "down" | "captive";

/** Rounds he has for his own weapon: in it, its capacity, and the spare magazines (or belts) with rounds in them. */
export interface AmmoState { loaded: number; capacity: number; spareMags: number; spareRounds: number }

export interface ManRow {
  id: EntityId;
  faction: string;
  role: string;
  rank: string;
  family: string;
  weapon: string | null;
  ammo: AmmoState | null;
  state: ManState;
  /** The finer state the row's pictogram shows (owner 2026-11-14). */
  status: ManStatus;
  leader: boolean;
  /** His triage tag (M10.3b): 1 = T1 immediate .. 3 = T3 minimal; absent: not triaged (or dead, or a prisoner). */
  triage?: 1 | 2 | 3;
  /** His state of mind beside the pictogram (morale rework): absent while steady. */
  mental?: MentalStatus;
}

type Man = NonNullable<ReturnType<SimView["soldier"]["get"]>>;

export function manState(s: Man): ManState {
  if (s.captive !== null) return "captive";
  if (isOut(s) || !isAble(s)) return "down";
  if (s.wounds.some((w) => w.mechanism !== "blunt")) return "wounded";
  const b = s.mental.behaviour;
  if (b === "pinned" || b === "panicked" || b === "routed") return "pinned";
  if (b === "shaken") return "shaken";
  return "steady";
}

/** His triage tag as shown (M10.3b): only while he is alive and not a prisoner. */
export function triageOf(s: Man): Man["triage"] | undefined {
  return s.triage !== undefined && s.physiology.alive && s.captive === null ? s.triage : undefined;
}

/** Wounds at or above this severity count as serious (as the man box labels them). */
export const SERIOUS_WOUND = 0.25;

/**
 * The pictogram's status (worst first): dead; a prisoner (surrendered, then captured); down (out of the fight);
 * seriously wounded (a wound of `SERIOUS_WOUND` or worse, or one still bleeding hard); lightly wounded; pinned
 * (also panicked or routed); shaken; aboard a vehicle; ready. Only own men are listed, so nothing here is hidden.
 */
export function manStatus(s: Man): ManStatus {
  if (s.casualty === "killed" || !s.physiology.alive) return "dead";
  if (s.captive !== null) return s.captive.state === "captured" ? "captured" : "surrendered";
  if (isOut(s) || !isAble(s)) return "down";
  const open = s.wounds.filter((w) => w.mechanism !== "blunt");
  if (open.some((w) => w.severity >= SERIOUS_WOUND || w.bleedingLps >= 0.01)) return "serious";
  if (open.length > 0) return "wounded";
  const b = s.mental.behaviour;
  if (b === "pinned" || b === "panicked" || b === "routed") return "pinned";
  if (b === "shaken") return "shaken";
  if (s.mount !== undefined) return "mounted";
  return "ready";
}

/** His state of mind as the second badge shows it (morale rework 2026-11-15): null while steady. A wounded and
 *  panicked man shows both his wound (`manStatus`) and this. */
export type MentalStatus = "shaken" | "pinned" | "panicked" | "fleeing" | "routed";
export function mentalStatus(s: Man): MentalStatus | null {
  if (s.captive !== null || isOut(s) || !isAble(s)) return null;
  const b = s.mental.behaviour;
  if (b === "panicked") return s.mental.flee ? "fleeing" : "panicked";
  if (b === "pinned" || b === "shaken" || b === "routed") return b;
  return null;
}

/** The two largest reasons for his lost morale (`morale.reason.<source>` keys' sources), largest first. */
export function moraleReasons(s: Man, min: number): string[] {
  const w = s.mental.why ?? [];
  const idx = MORALE_SOURCES.map((_, i) => i).filter((i) => (w[i] ?? 0) >= min).sort((a, b) => (w[b] ?? 0) - (w[a] ?? 0) || a - b);
  return idx.slice(0, 2).map((i) => MORALE_SOURCES[i]!);
}

/** What is helping him now (one `morale.relief.` key), or null: rallied lately, or his leader near. */
export function moraleRelief(view: SimView, catalog: Catalog, id: EntityId, s: Man): string | null {
  if (s.captive !== null || !isAble(s)) return null;
  if (view.tick - s.mental.rallyTick <= secondsToTicks(catalog.behaviour.morale.rally.reliefShowS)) return "rallied";
  const u = view.unit.get(view.identity.get(id)?.unit ?? -1);
  const l = u?.leader ?? null;
  if (l === null || l === id) return null;
  const ls = view.soldier.get(l), a = view.transform.get(id), b = view.transform.get(l);
  const r = catalog.behaviour.morale.damp.leaderNearM;
  if (!ls || !isAble(ls) || !a || !b || (ls.mount === undefined) !== (s.mount === undefined)) return null;
  return (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y) <= r * r ? "leaderNear" : null;
}

/** His weapon's rounds (null without a weapon that takes magazines or belts). */
export function ammoOf(view: SimView, catalog: Catalog, id: EntityId): AmmoState | null {
  const w = view.weapon.get(id);
  const wd = w ? catalog.weapons[w.weapon] : undefined;
  if (!w || !wd) return null;
  const mag = wd.feed.magazine;
  const capacity = catalog.items[mag]?.chargeCapacity ?? w.magazine?.rounds ?? 0;
  let spareMags = 0, spareRounds = 0;
  for (const st of view.container.get(id)?.stacks ?? []) {
    if (st.type !== mag || (st.charge ?? 0) <= 0) continue;
    spareMags += st.count;
    spareRounds += st.count * (st.charge ?? 0);
  }
  return { loaded: w.magazine?.rounds ?? 0, capacity, spareMags, spareRounds };
}

/** The men the card lists: a vehicle's crew (its passengers are their own units), else every man of the unit. */
export function cardMen(view: SimView, catalog: Catalog, unit: EntityId, own = false): EntityId[] {
  const u = view.unit.get(unit);
  if (!u) return [];
  if (own && u.vehicle === undefined) return [...u.members]; // (a platoon's headquarters alone, owner 2026-11-15)
  const veh = u.vehicle !== undefined ? view.vehicle.get(u.vehicle) : undefined;
  const def = veh ? catalog.vehicles[veh.def] : undefined;
  if (veh && def) return veh.seats.filter((o, i): o is EntityId => o !== null && def.seats[i]?.station !== "passenger");
  return unitSoldierIds(view, unit);
}

/** What a vehicle gun's feed holds (D3): high explosive, armour-piercing, a guided missile, or machine-gun belts. */
/** ("ab": a high-explosive round that only bursts in the air by its fuze, balance pass 6: an impact order is refused.) */
export type GunFeedKind = "he" | "ab" | "ap" | "missile" | "mg";

/** One feed of a vehicle weapon: rounds ready on the weapon and stowed in the hull. */
export interface GunFeed { kind: GunFeedKind; ready: number; stowed: number }

/** One weapon of the unit's vehicle as the card shows it (D3). */
/** (`out`, balance pass 6 verification: the weapon cannot fire, its part wrecked: gun, coaxial machine gun, launcher, or
 *  the sights a missile is guided through.) */
export interface GunRow { weapon: string; faction: string; feeds: GunFeed[]; jammed: boolean; reloading: boolean; out?: boolean }

/** A damaged part of the unit's vehicle as the card names it: its kind and what is left of it, 0..100. */
export interface PartRow { kind: string; percent: number }

/**
 * The damaged parts of the unit's vehicle (balance pass 6 verification: a hit that did not get through may break
 * sights, tracks, a launcher; the compact card said "ready"): every kind below full with the worst of its parts;
 * none for a whole hull or a unit without one.
 */
export function vehicleDamage(view: SimView, catalog: Catalog, unit: EntityId): PartRow[] {
  const vid = view.unit.get(unit)?.vehicle;
  const veh = vid !== undefined ? view.vehicle.get(vid) : undefined;
  const comps = veh ? catalog.vehicles[veh.def]?.components : undefined;
  if (!veh || !comps) return [];
  const out: PartRow[] = [];
  comps.forEach((c, k) => {
    const x = veh.comp[k] ?? 1;
    if (x >= 1) return;
    const pct = Math.round(x * 100), e = out.find((r) => r.kind === c.kind);
    if (e) e.percent = Math.min(e.percent, pct); else out.push({ kind: c.kind, percent: pct });
  });
  return out;
}

/** The card's line for them: "Damaged: sights 0 %, track 40 %". */
export function damageText(s: Strings, parts: readonly PartRow[]): string {
  return s.t("card.damaged", { parts: parts.map((p) => `${s.t(`vehicle.comp.${p.kind}`)} ${p.percent} %`).join(", ") });
}

/**
 * The guns and their rounds of the unit's vehicle (D3, read only): one row per station weapon with each feed's
 * ready rounds (on the weapon) and stowed rounds (in the hull's container); none for a unit without a vehicle.
 */
export function vehicleGuns(view: SimView, catalog: Catalog, unit: EntityId): GunRow[] {
  const vid = view.unit.get(unit)?.vehicle;
  const veh = vid !== undefined ? view.vehicle.get(vid) : undefined;
  const def = veh ? catalog.vehicles[veh.def] : undefined;
  if (!veh || !def || vid === undefined) return [];
  const stacks = view.container.get(vid)?.stacks ?? [];
  const out: GunRow[] = [];
  def.stations.forEach((sd, si) => sd.weapons.forEach((wd, wi) => {
    const ws = veh.stations[si]?.weapons[wi];
    if (!ws) return;
    const cannon = catalog.weapons[wd.weapon]?.type === "autocannon" || !wd.coax;
    const feeds = wd.feeds.map((fd, fi): GunFeed => {
      const item = catalog.items[fd.item];
      const ammo = item?.chargeItem !== undefined ? catalog.ammo[item.chargeItem] : undefined;
      const kind: GunFeedKind = ammo?.guided !== undefined ? "missile" : !cannon ? "mg" : ammo?.explosive !== undefined ? (ammo.airburst?.only === true ? "ab" : "he") : "ap";
      let stowed = 0;
      for (const st of stacks) if (st.type === fd.item) stowed += st.count * (st.charge ?? item?.chargeCapacity ?? 1);
      return { kind, ready: ws.feeds[fi]?.rounds ?? 0, stowed };
    });
    out.push({ weapon: wd.weapon, faction: veh.faction, feeds, jammed: ws.jammed, reloading: ws.reloadDoneTick !== undefined, ...(weaponOut({ catalog }, veh, def, si, wi) ? { out: true } : {}) });
  }));
  return out;
}

/** M11.5: a vehicle's fuel (whole litres, its tank's capacity) and its re-arming or refuelling, if any. */
export interface VehicleFuel { litres: number; capacityL: number; doing?: "rearm" | "refuel" | "heading" }

/** The fuel of the unit's vehicle and its re-arming or refuelling (M11.5, read only); null without a vehicle. */
export function vehicleFuel(view: SimView, catalog: Catalog, unit: EntityId): VehicleFuel | null {
  const vid = view.unit.get(unit)?.vehicle;
  const veh = vid !== undefined ? view.vehicle.get(vid) : undefined;
  const def = veh ? catalog.vehicles[veh.def] : undefined;
  if (!veh || !def || vid === undefined) return null;
  let l = 0;
  for (const st of view.container.get(vid)?.stacks ?? []) if (st.type === def.fuel.item) l += (st.charge ?? 0) * st.count;
  const r = veh.resupply;
  const doing = r === undefined ? undefined : r.phase === "go" ? "heading" : r.what;
  return { litres: Math.round(l), capacityL: def.fuel.capacityL, ...(doing !== undefined ? { doing } : {}) };
}

/** The fuel entry on the card's gun row (M11.5): "Fuel 640 / 900 l", and "re-arming" or "refuelling" while at it. */
export function fuelText(s: Strings, f: VehicleFuel): string {
  return `${s.t("card.fuel", { l: f.litres, cap: f.capacityL })}${f.doing !== undefined ? ` · ${s.t(`card.resupply.${f.doing}`)}` : ""}`;
}

/** One row per man of the unit (S6), in the unit's order (leader of each unit first as the data lists him). */
export function unitMenRows(view: SimView, catalog: Catalog, unit: EntityId, own = false): ManRow[] {
  const out: ManRow[] = [];
  const leaders = new Set<EntityId>();
  const stack: EntityId[] = [unit];
  while (stack.length > 0) {
    const u = view.unit.get(stack.pop()!);
    if (!u) continue;
    if (u.leader !== null) leaders.add(u.leader);
    stack.push(...u.children);
  }
  for (const id of cardMen(view, catalog, unit, own)) {
    const s = view.soldier.get(id), i = view.identity.get(id);
    if (!i) continue;
    // (No soldier record left for a listed man: shown as missing rather than dropped.)
    if (!s) { out.push({ id, faction: i.faction, role: i.role, rank: i.rank, family: i.family, weapon: null, ammo: null, state: "down", status: "missing", leader: leaders.has(id) }); continue; }
    const tag = triageOf(s);
    // (The second badge only where the status picture shows his body: wounded or aboard; shaken and pinned show there.)
    const status = manStatus(s), mental = status === "wounded" || status === "serious" || status === "mounted" ? mentalStatus(s) : null;
    out.push({ id, faction: i.faction, role: i.role, rank: i.rank, family: i.family, weapon: view.weapon.get(id)?.weapon ?? null, ammo: ammoOf(view, catalog, id), state: manState(s), status, leader: leaders.has(id), ...(tag ? { triage: tag.cat } : {}), ...(mental ? { mental } : {}) });
  }
  return out;
}

/** What he is doing now, as a string key under `man.activity.` (and the pace when he moves). */
export interface Activity { key: string; pace?: string; posture?: string; /** M11.9a: prisoners he escorts or guards. */ n?: number }

export function activityOf(view: SimView, id: EntityId): Activity {
  const s = view.soldier.get(id);
  if (!s) return { key: "unknown" };
  // (M11.9a: a prisoner held at a collection point, or being searched.)
  // (M11.9b: boarding the military police hull, aboard it, taken away by it.)
  if (s.captive !== null) return { key: s.captive.escape !== undefined ? "powEscaping" : s.captive.evacTick !== undefined ? "powEvacuated" : s.captive.vehicle !== undefined ? (s.mount !== undefined ? "powAboard" : "boarding") : s.captive.point !== undefined && s.atNest === undefined ? "held" : s.captive.state };
  if (s.casualty === "killed" || !s.physiology.alive) return { key: "killed" };
  if (s.casualty === "incapacitated" || !isAble(s)) return { key: "incapacitated" };
  if (s.mount !== undefined) return { key: "aboard" };
  if (s.evade && view.tick >= s.evade.startTick && view.tick < s.evade.untilTick) return { key: "evading" };
  // Care (M10.2-M10.3b): treating himself or a comrade, dragging one into cover, on his way to one.
  const act = view.action.get(id);
  // (M11.9a: searching a prisoner, escorting prisoners back, guarding them at the collection point.)
  if (act?.kind === "searchPrisoner") return { key: "searching" };
  if (s.guard !== undefined) {
    if (s.guard.phase === "guard") { let n = 0; for (const [, x] of view.soldier.entries()) if (x.captive?.point === s.guard.point && x.physiology.alive && x.atNest === undefined && x.evacuated === undefined) n++; return { key: "guarding", n }; }
    return { key: "escorting", n: s.guard.men.length };
  }
  if (act?.kind === "treat") return { key: Number(act.params["casualty"]) === id ? "selfAid" : "treating" };
  // A man down (owner request 2026-11-15): checking him, taking his identity tag.
  if (act?.kind === "checkDown") return { key: "checking" };
  if (act?.kind === "takeTag") return { key: "takingTag" };
  // Into or out of a vehicle (M10.4b).
  if (act?.kind === "loadCasualty") return { key: "loading" };
  if (act?.kind === "unloadCasualty") return { key: "unloading" };
  // (M11.2: taking a casualty's ammunition, or enemy kit; handing over in the squad's consolidation.)
  if (act?.kind === "takeAmmo" || act?.kind === "takeKit") return { key: act.kind };
  // (M11.3: taking supplies at a cache.)
  if (act?.kind === "takeSupply") return { key: "takeSupply" };
  // (M11.4a: an ammunition bearer loading a crate, carrying it, on his way to the supply point.)
  if (act?.kind === "loadSupply") return { key: "loadSupply" };
  // Carrying (M10.4a): a drag into cover, any other carry, or walking out wounded.
  if (s.carrying !== undefined && s.carrying !== id) {
    const c = view.carry.get(s.carrying);
    return { key: c?.cargo === true ? "bear" : c?.purpose === "cover" ? "dragging" : "carrying" };
  }
  if (s.carrying === id) return { key: "walkingOut" };
  // Crawling to cover, wounded (owner request 2026-11-15).
  if (s.crawlCover !== undefined && (view.mover.get(id)?.waypoints.length ?? 0) > 0) return { key: "crawling" };
  if (s.intent?.kind === "care") return { key: "care" };
  const b = s.mental.behaviour;
  if (b === "panicked" && s.mental.flee) return { key: "fleeing" };
  if (b === "panicked" || b === "routed") return { key: b };
  const intent = s.intent?.kind;
  if (intent === "cover" || intent === "bringAmmo" || intent === "fetchAmmo" || intent === "takePrisoner" || intent === "reposition" || intent === "hideDrone" || intent === "takeAmmo" || intent === "takeKit" || intent === "resupply" || intent === "bear") return { key: intent };
  const f = view.fire.get(id);
  if (f) return { key: f.self ? "engaging" : "firing" };
  if (b === "pinned") return { key: "pinned" };
  const m = view.mover.get(id);
  const wp = m?.waypoints;
  if (wp && wp.length > 0) return { key: "moving", pace: m?.mode ?? wp[wp.length - 1]!.mode };
  return { key: "holding", posture: s.posture };
}

export interface ManDetail {
  id: EntityId;
  given: string;
  family: string;
  rank: string;
  role: string;
  faction: string;
  callsign: string;
  weapon: string | null;
  ammo: AmmoState | null;
  state: ManState;
  status: ManStatus;
  /** His state word (`behaviour.<key>`; "fleeing" for a panicked man running back). */
  behaviour: string;
  /** 0..1 each (morale: 1 = high; stress: his shock, strain: his slow wear). */
  fatigue: number;
  stress: number;
  strain: number;
  suppression: number;
  morale: number;
  /** Why his morale is down (up to two `morale.reason.` sources) and what helps (a `morale.relief.` key). */
  reasons: string[];
  relief: string | null;
  heartRateBpm: number;
  winded: boolean;
  /** Wounds that broke the skin (as in the after-action review), worst first. */
  wounds: { zone: string; severity: number }[];
  activity: Activity;
  /** His triage tag (M10.3b) and the role of the man who gave it (his faction's role id). */
  triage?: { cat: 1 | 2 | 3; byRole: string; byFaction: string };
}

/** Everything the man box shows (S6): a read-only snapshot of one man. */
export function manDetail(view: SimView, catalog: Catalog, id: EntityId): ManDetail | null {
  const s = view.soldier.get(id), i = view.identity.get(id);
  if (!s || !i) return null;
  return {
    id, given: i.given, family: i.family, rank: i.rank, role: i.role, faction: i.faction,
    callsign: shownCallsigns(view.unit.entries()).get(i.unit) ?? view.unit.get(i.unit)?.callsign ?? "",
    weapon: view.weapon.get(id)?.weapon ?? null, ammo: ammoOf(view, catalog, id), state: manState(s), status: manStatus(s), behaviour: s.mental.behaviour === "panicked" && s.mental.flee ? "fleeing" : s.mental.behaviour,
    fatigue: s.physical.fatigue, stress: s.mental.stress, strain: s.mental.strain, suppression: s.mental.suppression, morale: s.mental.morale,
    reasons: isAble(s) && s.captive === null ? moraleReasons(s, catalog.behaviour.morale.states.whyMin) : [], relief: moraleRelief(view, catalog, id, s),
    heartRateBpm: s.physical.heartRateBpm, winded: s.physical.winded,
    wounds: s.wounds.filter((w) => w.mechanism !== "blunt").map((w) => ({ zone: w.zone, severity: w.severity })).sort((a, b) => b.severity - a.severity),
    activity: activityOf(view, id),
    ...triageDetail(view, s),
  };
}

function triageDetail(view: SimView, s: Man): Pick<ManDetail, "triage"> {
  const t = triageOf(s);
  if (!t) return {};
  const by = view.identity.get(t.by);
  return { triage: { cat: t.cat, byRole: by?.role ?? "", byFaction: by?.faction ?? "" } };
}

// ---- the fire row (S3)

export type FireChoice = "free" | "return" | "hold" | "ambush";
export const FIRE_CHOICES: readonly FireChoice[] = ["free", "return", "hold", "ambush"];
/** Ambush (owner S3: "hold until within N m"; D4b: the real `ambush` order): fire held until an enemy is this close,
 *  then at will. A game value, the shortest range the Rules panel offers. */
export const AMBUSH_M = 100;

/** Which chip of the fire row is lit for these rules: Ambush while one is laid (not yet sprung). */
export function fireChoice(r: Pick<UnitRules, "fire" | "ambush">): FireChoice {
  if ((r.ambush ?? 0) > 0) return "ambush";
  return r.fire;
}

/** The rules a chip of the fire row sets: an ambush at `AMBUSH_M`, or a fire rule (which ends an ambush laid). */
export function fireChoiceRules(c: FireChoice, now: Pick<UnitRules, "fire" | "ambush">): Partial<UnitRules> {
  if (c === "ambush") return { ambush: AMBUSH_M };
  return (now.ambush ?? 0) > 0 ? { fire: c, ambush: 0 } : { fire: c };
}

/**
 * Rules shown as ordered (`pend`) settle (D4b): once an order of `kind` has been delivered, the sim's own value is the
 * truth, what it carried is no longer shown as pending (an ambush delivered and sprung at once leaves no ambush to
 * match its range). `now`: the unit's rules now; any pending value equal to it settles too. Returns whether
 * anything is still pending.
 */
export function settleRules(pend: Partial<UnitRules>, now: UnitRules, kind?: string): boolean {
  if (kind === "ambush") delete pend.ambush;
  if (kind === "rules") {
    delete pend.fire; delete pend.maxEngageM; delete pend.onContact; delete pend.ammo; delete pend.at; delete pend.supply; delete pend.prisoners;
    if (pend.ambush === 0) delete pend.ambush;
  }
  for (const k of Object.keys(pend) as (keyof UnitRules)[]) if (pend[k] === (now[k] ?? 0)) delete pend[k];
  return Object.keys(pend).length > 0;
}

/** The order for rules from the card or the Rules panel (`base`: tick, issuer, target): an ambush to lay is the
 *  `ambush` order (D4b); anything else the `rules` order (a fire rule in it ends an ambush). */
export function rulesOrder(base: { tick: number; issuer: string; target: EntityId }, r: Partial<UnitRules>): Order {
  if (r.ambush !== undefined && r.ambush > 0) return { ...base, kind: "ambush", rangeM: r.ambush };
  return {
    ...base, kind: "rules", ...(r.fire ? { fire: r.fire } : {}), ...(r.maxEngageM !== undefined ? { maxEngageM: r.maxEngageM } : {}),
    ...(r.onContact ? { onContact: r.onContact } : {}), ...(r.ammo ? { ammo: r.ammo } : {}), ...(r.at ? { at: r.at } : {}),
    ...(r.supply ? { supply: r.supply } : {}), ...(r.prisoners ? { prisoners: r.prisoners } : {}),
  };
}

/** Defend arc (D4b): its width, a game value (owner to review). */
export const ARC_WIDTH_RAD = (120 * Math.PI) / 180;

/** The `defendArc` order facing from the unit's middle `from` toward the point tapped `to`. */
export function arcOrder(base: { tick: number; issuer: string; target: EntityId }, from: { x: number; y: number }, to: { x: number; y: number }): Order {
  return { ...base, kind: "defendArc", facing: Math.atan2(to.y - from.y, to.x - from.x), widthRad: ARC_WIDTH_RAD };
}

// ---- the pace row (S3)

type MoveOrder = Extract<Order, { kind: "move" }>;
type Pt = { x: number; y: number };

/**
 * A move under way sent again at another pace (S3: a pace chip pressed while the unit moves). The legs it has
 * already walked are dropped: it goes on from where it is (`at`) through the rest of the route. The unit is on the
 * leg between two route points nearest to it (within 15 m), else still on its first leg.
 */
export function repaceMove(prev: MoveOrder, at: Pt, pace: string, tick: number): MoveOrder {
  const w = prev.waypoints;
  let k = 0, best = 15;
  for (let i = 1; i < w.length; i++) {
    const ax = w[i - 1]!.x, ay = w[i - 1]!.y, dx = w[i]!.x - ax, dy = w[i]!.y - ay;
    const len2 = dx * dx + dy * dy;
    const u = len2 > 0 ? Math.max(0, Math.min(1, ((at.x - ax) * dx + (at.y - ay) * dy) / len2)) : 0;
    const d = Math.hypot(ax + u * dx - at.x, ay + u * dy - at.y);
    if (d <= best) { best = d; k = u > 0.02 ? i : i - 1; }
  }
  const rest = w.slice(k);
  return {
    tick, issuer: prev.issuer, target: prev.target, kind: "move",
    waypoints: rest.map((p) => ({ x: p.x, y: p.y, mode: pace })),
    ...(prev.formation !== undefined ? { formation: prev.formation } : {}),
    ...(prev.frontageM !== undefined ? { frontageM: prev.frontageM } : {}),
    ...(prev.facing !== undefined ? { facing: prev.facing } : {}),
    ...(prev.floor !== undefined ? { floor: prev.floor } : {}),
  };
}

// ---- DOM

export interface UnitCardModel {
  callsign: string;
  /** A short label beside the callsign (owner 2026-11-15: "HQ" for a platoon's headquarters), translated. */
  badge?: string;
  fit: number;
  total: number;
  /** The unit's state line ("ready", "pinned", ...), already translated. */
  state: string;
  men: readonly ManRow[];
  /** The vehicle's guns and their rounds (D3); absent or empty: no gun row. */
  guns?: readonly GunRow[];
  /** The vehicle's damaged parts (balance pass 6 verification); absent or empty: no line. */
  damage?: readonly PartRow[];
  /** M11.4a: the squad asked for ammunition and waits for the player (rule "ask"): the "Send bearers" button. */
  supplyAsk?: boolean;
  /** M11.5: the vehicle's fuel and what it is doing about supplies; absent: no vehicle. */
  fuel?: VehicleFuel;
  /** M11.9a: the unit's prisoners and men on prisoner duty, as one line (`prisonerCardText`); absent: none. */
  prisoners?: string;
}

export interface UnitCardCallbacks {
  onPace(pace: string): void;
  onFire(choice: FireChoice): void;
  onRules(): void;
  onMan(id: EntityId): void;
  /** M11.4a: "Send bearers" pressed (the squad's request waiting for the player). */
  onSendBearers?(): void;
  /** The card grew or shrank (detailed / compact). */
  onResize?(): void;
}

export interface UnitCard {
  readonly el: HTMLElement;
  /** null hides the card (nothing selected). */
  update(m: UnitCardModel | null): void;
  setPaces(paces: readonly string[], current: string): void;
  /** null hides the fire row. */
  setFire(c: FireChoice | null): void;
  setRulesButton(on: boolean, open: boolean): void;
  setInspected(id: EntityId | null): void;
  setDetailed(on: boolean): void;
  detailed(): boolean;
  /** Review step 5: is the card folded to its one line now (a phone held sideways); fold or unfold it; force the
   *  one-line mode on or off (checks; else it follows the screen). */
  isLine(): boolean;
  setFolded(on: boolean): void;
  setLineMode(on: boolean): void;
  /** The rank insignia of the factions taking part (from the appearance data); absent: rows show none. */
  setInsignia(t: Readonly<Record<string, Insignia>> | undefined): void;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

const CARD_KEY = "tcs.ui.card";

/** Review step 5 (item 5): on a phone held sideways the card is one line until tapped. */
export const CARD_LINE_QUERY = "(max-height: 480px) and (orientation: landscape)";
/** The card's fold: `lineMode` (the screen is a phone held sideways), `open` (unfolded by a tap), the unit shown. */
export interface CardFold { lineMode: boolean; open: boolean; unit: string }
export type CardFoldEvent = { type: "mode"; on: boolean } | { type: "toggle" } | { type: "fold"; on: boolean } | { type: "unit"; unit: string };
/** The fold after an event: a tap toggles it; another unit selected folds it again; the mode follows the screen.
 *  Never stored: the remembered compact / detailed choice keeps its meaning. */
export function foldCard(f: CardFold, e: CardFoldEvent): CardFold {
  switch (e.type) {
    case "mode": return e.on === f.lineMode ? f : { ...f, lineMode: e.on, open: false };
    case "toggle": return f.lineMode ? { ...f, open: !f.open } : f;
    case "fold": return f.lineMode ? { ...f, open: !e.on } : f;
    case "unit": return e.unit === f.unit ? f : { ...f, unit: e.unit, open: false };
  }
}
/** Is the card drawn as its one line? */
export const cardIsLine = (f: CardFold): boolean => f.lineMode && !f.open;

/** The ammunition bar: one cell per magazine or belt (the one in the weapon first, filled by its rounds), at most 8. */
export function ammoCells(a: AmmoState): { fill: number[]; more: number } {
  const full = Math.max(1, a.capacity);
  const spare = a.spareMags;
  const cells = [Math.max(0, Math.min(1, a.loaded / full))];
  // The spare magazines are shown full except the average shortfall spread over them (partly used ones are rare).
  const avg = spare > 0 ? Math.max(0, Math.min(1, a.spareRounds / spare / full)) : 0;
  for (let k = 0; k < Math.min(7, spare); k++) cells.push(avg);
  return { fill: cells, more: Math.max(0, spare - 7) };
}

/**
 * One weapon's line on the card (D3): its name, then each feed's ready rounds by nature ("HE 160 | AP 80"; a
 * machine gun's belt by count alone), the stowed rounds in the hull, and a jam or a missile reload under way.
 */
export function gunText(s: Strings, g: GunRow): string {
  const feeds = g.feeds.map((f) => (f.kind === "mg" ? String(f.ready) : `${s.t(`card.gun.${f.kind}`)} ${f.ready}`)).join(" | ");
  const stowed = g.feeds.reduce((n, f) => n + f.stowed, 0);
  return `${s.t(`weapon.${g.weapon}`, {}, g.faction)} · ${feeds}`
    + (stowed > 0 ? ` ${s.t("card.gun.stowed", { n: stowed })}` : "")
    + (g.out === true ? ` · ${s.t("card.gun.out")}` : "")
    + (g.jammed ? ` · ${s.t("card.gun.jammed")}` : "")
    + (g.reloading ? ` · ${s.t("card.gun.reloading")}` : "");
}

export function createUnitCard(s: Strings, cb: UnitCardCallbacks): UnitCard {
  const root = h("div", "hud-card");
  root.hidden = true;
  const head = h("div", "hud-card-head");
  const name = h("span", "hud-card-name");
  const badge = h("span", "hud-badge hud-card-badge");
  badge.hidden = true;
  const men = h("span", "hud-card-men");
  const detailBtn = h("button", "hud-btn hud-card-btn");
  detailBtn.dataset["card"] = "detail";
  detailBtn.innerHTML = `${icon("men", 16)}<span>${s.t("card.men")}</span>`;
  detailBtn.title = s.t("card.menHint");
  const rulesBtn = h("button", "hud-btn hud-card-btn");
  rulesBtn.dataset["card"] = "rules";
  rulesBtn.innerHTML = `${icon("rules", 16)}<span>${s.t("order.rules")}</span>`;
  rulesBtn.onclick = () => cb.onRules();
  // M11.4a: the squad's request for ammunition, waiting for the player (rule "ask").
  const bearersBtn = h("button", "hud-btn hud-card-btn hud-card-ask");
  bearersBtn.dataset["card"] = "bearers";
  bearersBtn.innerHTML = `${icon("resupply", 16)}<span>${s.t("order.sendBearers")}</span>`;
  bearersBtn.title = `${s.t("card.supplyAsk")}: ${s.t("order.sendBearersTitle")}`;
  bearersBtn.hidden = true;
  bearersBtn.onclick = () => cb.onSendBearers?.();
  // Review step 5: folded to one line (a phone held sideways) the head shows the pace and the fire rule as icons
  // and a chevron; a tap on the line unfolds the card, a tap on the head folds it again.
  const lineIcons = h("span", "hud-card-line-icons");
  const foldBtn = h("button", "hud-btn hud-card-btn hud-card-fold");
  foldBtn.dataset["card"] = "fold";
  head.append(name, badge, men, lineIcons, detailBtn, rulesBtn, bearersBtn, foldBtn);
  const paceRow = h("div", "hud-seg");
  paceRow.dataset["row"] = "pace";
  const fireRow = h("div", "hud-seg");
  fireRow.dataset["row"] = "fire";
  // The vehicle's guns and rounds (D3): one compact row in both modes, one entry per weapon (wraps on a phone).
  const gunRow = h("div", "hud-seg hud-card-guns");
  gunRow.dataset["row"] = "guns";
  gunRow.title = s.t("card.gun.title");
  gunRow.hidden = true;
  // M11.9a: the unit's prisoners and its men on prisoner duty ("Prisoners 4 (1 NCO) · guard 1").
  const powRow = h("div", "hud-seg hud-card-pow");
  powRow.dataset["row"] = "prisoners";
  powRow.hidden = true;
  let gunKey = "";
  const list = h("div", "hud-card-list");
  root.append(head, paceRow, fireRow, gunRow, powRow, list);

  const store = (): Storage | null => { try { return globalThis.localStorage; } catch { return null; } };
  let detailed = false;
  try { detailed = store()?.getItem(CARD_KEY) === "detailed"; } catch { /* no storage */ }
  const applyDetailed = () => { list.hidden = !detailed; detailBtn.classList.toggle("on", detailed); root.classList.toggle("detailed", detailed); };
  detailBtn.onclick = () => { detailed = !detailed; try { store()?.setItem(CARD_KEY, detailed ? "detailed" : "compact"); } catch { /* no storage */ } applyDetailed(); cb.onResize?.(); };
  applyDetailed();

  let fold: CardFold = { lineMode: false, open: false, unit: "" };
  let linePace = "", lineFire: FireChoice | null = null;
  const paintLine = () => { lineIcons.innerHTML = `${linePace ? icon(paceIcon(linePace), 16) : ""}${lineFire ? icon(lineFire, 16) : ""}`; };
  const applyFold = (e: CardFoldEvent) => {
    const was = fold;
    fold = foldCard(fold, e);
    if (fold === was) return;
    const line = cardIsLine(fold);
    root.classList.toggle("line-mode", fold.lineMode);
    root.classList.toggle("line", line);
    foldBtn.textContent = line ? "\u25B8" : "\u25BE";
    foldBtn.setAttribute("aria-label", s.t(line ? "card.expand" : "card.collapse"));
    foldBtn.title = s.t(line ? "card.expand" : "card.collapse");
    if (built && (cardIsLine(was) !== line || was.lineMode !== fold.lineMode)) cb.onResize?.();
  };
  /** (No callback while the card is being built: the HUD does not hold it yet.) */
  let built = false;
  // (A tap on a button of the head does its own job; "Send bearers" stays reachable on the folded line.)
  head.onclick = (ev) => {
    if (!fold.lineMode) return;
    const b = (ev.target as HTMLElement | null)?.closest?.("button");
    if (b && b !== foldBtn) return;
    applyFold({ type: "toggle" });
  };
  const mq = typeof globalThis.matchMedia === "function" ? globalThis.matchMedia(CARD_LINE_QUERY) : null;
  if (mq) {
    applyFold({ type: "mode", on: mq.matches });
    mq.addEventListener?.("change", (ev) => applyFold({ type: "mode", on: ev.matches }));
  }
  built = true;

  const segLabel = (key: string) => h("span", "hud-seg-label", s.t(key));
  let paceKey = "";
  let paceBtns: { p: string; b: HTMLButtonElement }[] = [];
  const fireBtns = FIRE_CHOICES.map((c) => {
    const b = h("button", "hud-chip");
    b.dataset["fire"] = c;
    b.innerHTML = `${icon(c, 16)}<span>${s.t(`card.fire.${c}`)}</span>`;
    b.title = s.t(`card.fire.${c}.hint`, { m: AMBUSH_M });
    b.onclick = () => cb.onFire(c);
    return { c, b };
  });
  fireRow.append(segLabel("card.fireRow"), ...fireBtns.map((x) => x.b));

  let inspected: EntityId | null = null;
  let insignia: Readonly<Record<string, Insignia>> | undefined;
  const rows = new Map<EntityId, { b: HTMLButtonElement; key: string }>();
  const fmtAmmo = (a: AmmoState | null) => {
    if (!a) return "";
    const { fill, more } = ammoCells(a);
    return `<span class="hud-ammo" title="${s.t("card.ammoTitle", { loaded: a.loaded, spare: a.spareRounds, mags: a.spareMags })}">${fill.map((f) => `<i style="--f:${Math.round(f * 100)}%"></i>`).join("")}${more > 0 ? `<b>+${more}</b>` : ""}</span>`;
  };
  const text = (k: string, faction: string) => s.t(k, {}, faction);
  /** A short label if the string table has one, else the longer one. */
  const tOr = (k: string, fallback: string) => { const v = s.t(k); return v.startsWith("[[") ? s.t(fallback) : v; };

  return {
    el: root,
    update(m) {
      root.hidden = m === null;
      if (!m) { applyFold({ type: "unit", unit: "" }); return; }
      applyFold({ type: "unit", unit: `${m.callsign}|${m.badge ?? ""}` });
      name.textContent = m.callsign;
      badge.hidden = !m.badge; badge.textContent = m.badge ?? "";
      bearersBtn.hidden = m.supplyAsk !== true;
      men.textContent = `${s.t("side.men", { fit: m.fit, total: m.total })} · ${m.state}`;
      powRow.hidden = m.prisoners === undefined;
      if (m.prisoners !== undefined && powRow.textContent !== m.prisoners) powRow.textContent = m.prisoners;
      const guns = [...(m.guns ?? []).map((g) => gunText(s, g)), ...(m.damage !== undefined && m.damage.length > 0 ? [damageText(s, m.damage)] : []), ...(m.fuel ? [fuelText(s, m.fuel)] : [])];
      const gk = guns.join("\n");
      if (gk !== gunKey) {
        gunKey = gk;
        gunRow.hidden = guns.length === 0;
        const label = guns.length > 0 ? [segLabel("card.gunRow")] : [];
        const col = h("div", "hud-guns");
        col.append(...guns.map((g) => h("span", "hud-gun", g)));
        gunRow.replaceChildren(...label, col);
      }
      if (!detailed) return;
      const keep = new Set<EntityId>();
      m.men.forEach((r, i) => {
        keep.add(r.id);
        let e = rows.get(r.id);
        if (!e) {
          const b = h("button", "hud-man");
          b.dataset["man"] = String(r.id);
          b.onclick = () => cb.onMan(r.id);
          e = { b, key: "" };
          rows.set(r.id, e);
        }
        const a = r.ammo;
        const key = `${r.status}|${r.state}|${r.rank}|${r.role}|${r.weapon}|${a ? `${a.loaded}/${a.spareMags}/${a.spareRounds}` : ""}|${r.leader}|${insignia ? 1 : 0}|${r.triage ?? ""}|${r.mental ?? ""}`;
        if (key !== e.key) {
          e.key = key;
          const rankName = text(`rank.${r.faction}.${r.rank}`, r.faction), statusName = s.t(`card.status.${r.status}`);
          e.b.className = `hud-man st-${r.state} ss-${r.status}${r.leader ? " leader" : ""}`;
          e.b.dataset["status"] = r.status;
          // His triage tag (M10.3b) sits in the pictogram cell's corner slot.
          const tag = r.triage ? `<span class="hud-man-tag"><span class="hud-triage t${r.triage}" title="${s.t(`card.triage.${r.triage}`)}">${s.t(`card.triage.short.${r.triage}`)}</span></span>` : "";
          // His state of mind as a second badge (morale rework): shown beside a wound too.
          const mentalName = r.mental ? s.t(`behaviour.${r.mental}`) : "";
          const badge = r.mental ? `<span class="hud-man-mental ms-${r.mental}" title="${esc(mentalName)}">${mentalPictogram(r.mental, 12, mentalName)}</span>` : "";
          e.b.innerHTML = `<span class="hud-man-mark">${statusPictogram(r.status, 20, statusName)}${tag}${badge}</span>`
            + `<span class="hud-man-rank">${insigniaSvg(insignia?.[r.faction], r.rank, 34, rankName)}</span>`
            + `<span class="hud-man-role">${text(`role.${r.faction}.${r.role}`, r.faction)}</span>`
            + `<span class="hud-man-weapon">${r.weapon ? text(`weapon.${r.weapon}`, r.faction) : ""}</span>`
            + fmtAmmo(a);
          e.b.title = `${rankName} ${r.family} · ${statusName}${r.mental ? ` · ${mentalName}` : ""}`;
        }
        e.b.classList.toggle("inspected", inspected === r.id);
        if (list.children[i] !== e.b) list.insertBefore(e.b, list.children[i] ?? null);
      });
      for (const [id, e] of rows) if (!keep.has(id)) { e.b.remove(); rows.delete(id); }
    },
    setPaces(paces, current) {
      const key = paces.join();
      if (key !== paceKey) {
        paceKey = key;
        // Fastest first (Run, Walk, Sneak, Crawl; a vehicle's fast, drive, slow, reverse).
        const rank = (p: string) => (p === "reverse" ? 9 : ["run", "walk", "sneak", "crawl"].indexOf(paceIcon(p)));
        paceBtns = [...paces].sort((a, b) => rank(a) - rank(b)).map((p) => {
          const b = h("button", "hud-chip");
          b.dataset["pace"] = p;
          b.innerHTML = `${icon(paceIcon(p), 16)}<span>${tOr(`card.pace.${p}`, `move.${p}`)}</span>`;
          b.onclick = () => cb.onPace(p);
          b.title = s.t(`move.${p}`);
          return { p, b };
        });
        paceRow.replaceChildren(segLabel("card.paceRow"), ...paceBtns.map((x) => x.b));
      }
      for (const x of paceBtns) x.b.classList.toggle("on", x.p === current);
      paceRow.hidden = paces.length === 0;
      const lp = paces.length === 0 ? "" : current;
      if (lp !== linePace) { linePace = lp; paintLine(); }
    },
    setFire(c) {
      fireRow.hidden = c === null;
      if (c !== lineFire) { lineFire = c; paintLine(); }
      for (const x of fireBtns) x.b.classList.toggle("on", x.c === c);
    },
    setRulesButton(on, open) { rulesBtn.hidden = !on; rulesBtn.classList.toggle("on", open); },
    setInspected(id) { inspected = id; for (const [k, e] of rows) e.b.classList.toggle("inspected", k === id); },
    setDetailed(on) { if (on !== detailed) detailBtn.click(); },
    detailed: () => detailed,
    isLine: () => cardIsLine(fold),
    setFolded(on) { applyFold({ type: "fold", on }); },
    setLineMode(on) { applyFold({ type: "mode", on }); },
    setInsignia(t) { insignia = t; },
  };
}

export interface ManBox {
  readonly el: HTMLElement;
  /** null hides it. */
  update(d: ManDetail | null): void;
  setInsignia(t: Readonly<Record<string, Insignia>> | undefined): void;
}

/** A bar of 0..1 with a label (fatigue, suppression, ...); `bad`: high values are bad (drawn warmer); `col`: its colour. */
function bar(label: string, v: number, bad: boolean, col?: string, word?: string): string {
  const x = Math.max(0, Math.min(1, v));
  const warm = bad ? x : 1 - x;
  const c = col ?? (warm > 0.66 ? "#ff6b57" : warm > 0.33 ? "#ffd23d" : "#8fd36a");
  return `<div class="hud-manbox-bar"><span>${label}</span><i><b style="width:${Math.round(x * 100)}%;background:${c}"></b></i><em>${Math.round(x * 100)} %${word ? ` ${word}` : ""}</em></div>`;
}

/** The morale bar's colour by his state (green steady, amber shaken, orange pinned, red panicked or running). */
const MORALE_COLOUR: Record<string, string> = { steady: "#8fd36a", cautious: "#8fd36a", shaken: "#ffd23d", pinned: "#ff9f43", panicked: "#ff6b57", fleeing: "#ff6b57", routed: "#ff6b57" };

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The man's detail box (S6). */
export function createManBox(s: Strings, onClose: () => void): ManBox {
  const root = h("div", "hud-manbox");
  root.hidden = true;
  const body = h("div", "hud-manbox-body");
  const close = h("button", "hud-btn hud-manbox-close");
  close.innerHTML = icon("close", 16);
  close.setAttribute("aria-label", s.t("card.close"));
  close.onclick = () => onClose();
  root.append(close, body);
  let last = "";
  let insignia: Readonly<Record<string, Insignia>> | undefined;
  return {
    el: root,
    setInsignia(t) { insignia = t; last = ""; },
    update(d) {
      root.hidden = d === null;
      if (!d) { last = ""; return; }
      const f = d.faction;
      const sev = (x: number) => s.t(x >= 0.6 ? "card.wound.critical" : x >= 0.25 ? "card.wound.serious" : "card.wound.light");
      const a = d.ammo;
      const act = d.activity;
      const doing = s.t(`man.activity.${act.key}`, {
        n: act.n ?? 0,
        pace: act.pace ? s.t(`move.${act.pace}`) : "",
        posture: act.posture ? s.t(`card.posture.${act.posture}`) : "",
      });
      const rankName = s.t(`rank.${f}.${d.rank}`, {}, f), statusName = s.t(`card.status.${d.status}`);
      const ins = insigniaSvg(insignia?.[f], d.rank, 64, rankName);
      const html = `<div class="hud-manbox-head">${ins ? `<span class="hud-manbox-rank">${ins}</span>` : ""}<div>`
        + `<div class="hud-manbox-name">${esc(rankName)} ${esc(d.given)} ${esc(d.family)}</div>`
        + `<div class="hud-manbox-status ss-${d.status}">${statusPictogram(d.status, 24, statusName)}<span>${esc(statusName)}</span></div></div></div>`
        + `<div class="hud-manbox-line">${esc(s.t(`role.${f}.${d.role}`, {}, f))} · ${esc(d.callsign)}</div>`
        + `<div class="hud-manbox-line">${d.weapon ? esc(s.t(`weapon.${d.weapon}`, {}, f)) : esc(s.t("card.noWeapon"))}${a ? ` · ${esc(s.t("card.rounds", { loaded: a.loaded, spare: a.spareRounds, mags: a.spareMags }))}` : ""}</div>`
        + `<div class="hud-manbox-line"><b>${esc(s.t("card.doing"))}</b> ${esc(doing)}</div>`
        + `<div class="hud-manbox-line"><b>${esc(s.t("card.stateLabel"))}</b> ${esc(s.t(`behaviour.${d.behaviour}`))}${d.winded ? ` · ${esc(s.t("card.winded"))}` : ""} · ${esc(s.t("card.pulse", { bpm: Math.round(d.heartRateBpm) }))}</div>`
        + bar(s.t("card.morale"), d.morale, false, MORALE_COLOUR[d.behaviour] ?? "#9aa4ad", esc(s.t(`behaviour.${d.behaviour}`)))
        + (d.reasons.length > 0 || d.relief ? `<div class="hud-manbox-line hud-manbox-why">${d.reasons.length > 0 ? `<b>${esc(s.t("card.moraleWhy"))}</b> ${d.reasons.map((r) => esc(s.t(`morale.reason.${r}`))).join(", ")}` : ""}`
          + `${d.relief ? `${d.reasons.length > 0 ? " · " : ""}<b>${esc(s.t("card.moraleHelp"))}</b> ${esc(s.t(`morale.relief.${d.relief}`))}` : ""}</div>` : "")
        + bar(s.t("card.suppression"), d.suppression, true) + bar(s.t("card.fatigue"), d.fatigue, true)
        + `<div class="hud-manbox-line"><b>${esc(s.t("card.wounds"))}</b> ${d.wounds.length === 0 ? esc(s.t("card.noWounds")) : d.wounds.map((w) => esc(`${s.t(`zone.${w.zone}`)} (${sev(w.severity)})`)).join(", ")}</div>`
        + (d.triage ? `<div class="hud-manbox-line"><b>${esc(s.t("card.triage"))}</b> <span class="hud-triage t${d.triage.cat}">${esc(s.t(`card.triage.short.${d.triage.cat}`))}</span> ${esc(s.t("card.triage.by", { cat: s.t(`card.triage.${d.triage.cat}`), role: s.t(`role.${d.triage.byFaction}.${d.triage.byRole}`, {}, d.triage.byFaction) }))}</div>` : "");
      if (html !== last) { last = html; body.innerHTML = html; }
    },
  };
}
