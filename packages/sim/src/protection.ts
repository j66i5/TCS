/**
 * RECOGNITION AND RESPECT (SPEC 9.1, M10.7a): who is protected, and when an enemy can tell.
 *
 * Protected while they commit no act harmful to the enemy (owner answer 6; CIHL rules 25, 29, 47): a man wearing a
 * protective emblem (an item with `emblem`: the red cross armband), a vehicle whose type is a marked ambulance, the
 * men of a carrying party, and men at a marked Verwundetennest (every medical rear point is marked). Wounded out of
 * action and men giving up were spared before (contact flags `down` and `surrendered`). A man or hull that fired
 * within `medicFiredLosesProtectionS` is not protected, except a man wearing an emblem who fired in self-defence
 * (M10.7b, conduct.ts).
 *
 * Recognition happens in the contact scan, on a sighting (no scan of its own): within the range for the target's
 * kind (by eye, or with optics: any non-thermal sight that magnifies), scaled by light, smoke on the line and the
 * observer's stress, the observer's contact gets the flag `marked`, `carrying` or `atPoint` — or loses it when he
 * can tell the man no longer is. Beyond that range he keeps what he knew. Flags are a man's own judgement: they are
 * not passed on in reports (a comrade who has not seen the armband himself may fire: an honest mistake). Who may be
 * fired at is decided on these flags, never on the target's real state. Nothing here is faction-specific: who wears
 * an emblem and which hulls are marked is data.
 */
import type { Catalog } from "./catalog";
import type { Contact, SoldierState } from "./components";
import { secondsToTicks, type EntityId } from "./ids";
import { onRoof } from "./mount";
import { smokePhysics, smokeTransmission } from "./smoke";
import type { SimState } from "./state";

/** The protection a target really has now (bits): an emblem on a man or a marked ambulance, a carrying party, a man
 *  at a marked rear point. */
export const PROT_MARKED = 1, PROT_CARRYING = 2, PROT_POINT = 4;

/** A contact he knows to be protected (recognised): not fired at, not shelled, no threat to take cover from. */
export function protectedContact(c: Contact): boolean {
  return c.marked === true || c.carrying === true || c.atPoint === true;
}

/** A contact nobody fires at: given up, down, or recognised as protected. */
export function spared(c: Contact): boolean {
  return c.surrendered === true || c.down === true || c.marked === true || c.carrying === true || c.atPoint === true;
}

/** Does this man wear a protective emblem (an item with `emblem`, at least one)? */
export function wearsEmblem(catalog: Catalog, state: SimState, id: EntityId): boolean {
  const box = state.container.get(id);
  if (!box) return false;
  for (const st of box.stacks) if (st.count > 0 && catalog.items[st.type]?.emblem === true) return true;
  return false;
}

/** Fired within the time that costs protection: a man's last shot that was not self-defence (M10.7b,
 *  `SoldierState.protLostTick`, conduct.ts), or any station of a hull. */
function firedLately(catalog: Catalog, state: SimState, id: EntityId): boolean {
  const P = catalog.medical?.protection;
  if (!P) return false;
  const since = state.tick - secondsToTicks(P.medicFiredLosesProtectionS);
  const s = state.soldier.get(id);
  if (s) return s.protLostTick !== undefined && s.protLostTick > since;
  const v = state.vehicle.get(id);
  if (v) for (const st of v.stations) for (const sw of st.weapons) if (sw.lastShotTick > since) return true;
  return false;
}

/** Whether `target` could carry protection at all (a cheap test before the rest; most men never can). */
export function mayBeProtected(catalog: Catalog, state: SimState, target: EntityId): boolean {
  const s = state.soldier.get(target);
  if (s) return s.carrying !== undefined || s.atNest !== undefined || wearsEmblem(catalog, state, target);
  const v = state.vehicle.get(target);
  return v !== undefined && catalog.vehicles[v.def]?.ambulance?.marked === true;
}

/** The protection `target` really has now (PROT_* bits; 0: none). */
export function protectionNow(catalog: Catalog, state: SimState, target: EntityId): number {
  const s = state.soldier.get(target);
  if (s) {
    if (!s.physiology.alive || (s.mount !== undefined && !onRoof(state, target))) return 0;
    if (firedLately(catalog, state, target)) return 0;
    let p = 0;
    if (wearsEmblem(catalog, state, target)) p |= PROT_MARKED;
    // (Review fix: a bearer walking empty-handed to the casualty, the carry's gather phase, is no carrying party yet.)
    if (s.carrying !== undefined && state.carry.get(s.carrying)?.phase !== "gather") p |= PROT_CARRYING;
    if (s.atNest !== undefined && state.rear.get(s.atNest)?.kind === "medical") p |= PROT_POINT;
    return p;
  }
  const v = state.vehicle.get(target);
  if (v && catalog.vehicles[v.def]?.ambulance?.marked === true && !firedLately(catalog, state, target)) return PROT_MARKED;
  return 0;
}

/** Does this observer look through optics that would show an emblem (a non-thermal sensor that magnifies)? */
export function hasOptics(catalog: Catalog, state: SimState, observer: EntityId): boolean {
  const D = catalog.spotting;
  const good = (kind: string | undefined) => { const k = kind === undefined ? undefined : D.sensors[kind]; return k !== undefined && k.thermal !== true && k.factor > 1; };
  const s = state.soldier.get(observer);
  if (!s) return false;
  if (s.mount !== undefined) {
    const v = state.vehicle.get(s.mount.vehicle), seat = v ? catalog.vehicles[v.def]?.seats[s.mount.seat] : undefined;
    return seat?.sensors?.some((sn) => good(sn.kind)) === true;
  }
  if (good(catalog.weapons[state.weapon.get(observer)?.weapon ?? ""]?.sights[0]?.kind)) return true;
  const box = state.container.get(observer);
  if (box) for (const st of box.stacks) if (st.count > 0 && good(catalog.items[st.type]?.sensor)) return true;
  return false;
}

/**
 * How far (m) this observer can tell protection of each kind right now, before smoke: the data's range by eye or
 * with optics, scaled by light (between `obscuredFactor` in the dark and 1 by day) and his stress.
 * `vehicle`: the emblem is a hull's (else an armband).
 */
export function recognitionRanges(catalog: Catalog, light: number, optics: boolean, stress: number, vehicle: boolean): { marked: number; carrying: number; point: number } {
  const P = catalog.medical!.protection, R = P.recognitionM;
  const lit = Math.min(1, Math.max(0, light));
  const k = (P.obscuredFactor + (1 - P.obscuredFactor) * lit) * Math.max(0, 1 - P.stressK * Math.min(1, Math.max(0, stress)));
  return {
    marked: k * (vehicle ? (optics ? R.vehicleOptics : R.vehicleEye) : (optics ? R.armbandOptics : R.armbandEye)),
    carrying: k * (optics ? R.carryOptics : R.carryEye),
    point: k * (optics ? R.pointOptics : R.pointEye),
  };
}

/** Smoke on the line scales a recognition range between `obscuredFactor` (opaque) and 1 (clear). */
export function smokeRecognitionFactor(catalog: Catalog, transmission: number): number {
  const o = catalog.medical!.protection.obscuredFactor;
  return o + (1 - o) * Math.min(1, Math.max(0, transmission));
}

/**
 * A sighting (contact system, M10.7a): update the observer's flags on contact `c` of `target`, seen this tick at
 * `range` from his eye (ex, ey, ez) to (tx, ty, tz). Within the recognition range of a kind he sets the flag if the
 * target has that protection and clears it if not; beyond, he keeps what he knew. A target that fired lately shows
 * it at any range he sees him from: every flag goes. Returns the PROT_* bits newly set (0: nothing new).
 */
export function recognise(catalog: Catalog, state: SimState, observer: SoldierState, obsId: EntityId, c: Contact, target: EntityId, range: number, ex: number, ey: number, ez: number, tx: number, ty: number, tz: number): number {
  if (catalog.medical === undefined) return 0;
  const had = protectedContact(c);
  if (!had && !mayBeProtected(catalog, state, target)) return 0;
  const now = protectionNow(catalog, state, target);
  if (now === 0 && firedLately(catalog, state, target)) { delete c.marked; delete c.carrying; delete c.atPoint; return 0; }
  const r = recognitionRanges(catalog, state.environment.light, hasOptics(catalog, state, obsId), Math.max(observer.mental.stress, observer.mental.suppression), state.vehicle.has(target));
  const far = Math.max(r.marked, r.carrying, r.point);
  if (range > far) return 0;
  if (state.smoke.length > 0) {
    const f = smokeRecognitionFactor(catalog, smokeTransmission(state, smokePhysics(catalog), ex, ey, ez, tx, ty, tz));
    r.marked *= f; r.carrying *= f; r.point *= f;
  }
  let fresh = 0;
  if (range <= r.marked) { if ((now & PROT_MARKED) !== 0) { if (c.marked !== true) fresh |= PROT_MARKED; c.marked = true; } else delete c.marked; }
  if (range <= r.carrying) { if ((now & PROT_CARRYING) !== 0) { if (c.carrying !== true) fresh |= PROT_CARRYING; c.carrying = true; } else delete c.carrying; }
  if (range <= r.point) { if ((now & PROT_POINT) !== 0) { if (c.atPoint !== true) fresh |= PROT_POINT; c.atPoint = true; } else delete c.atPoint; }
  return fresh;
}

/** The targets these men recognise as protected (null: none; most of the time). A crew or team decides together: one
 *  man telling the others "that's an ambulance" is enough. */
export function protectedTargets(state: SimState, men: readonly EntityId[]): Set<EntityId> | null {
  let out: Set<EntityId> | null = null;
  for (const m of men) {
    const s = state.soldier.get(m);
    if (s) for (const c of s.contacts) if (protectedContact(c)) (out ??= new Set()).add(c.target);
  }
  return out;
}

/**
 * Would fire at (x, y) be fire at protected people only? True when the known enemies within `radius` of it are all
 * spared (recognised as protected, down or given up) and at least one is recognised as protected.
 */
export function onlyProtectedAt(contacts: Iterable<Contact>, x: number, y: number, radius: number): boolean {
  const r2 = radius * radius;
  let prot = 0;
  for (const c of contacts) {
    const dx = c.x - x, dy = c.y - y;
    if (dx * dx + dy * dy > r2) continue;
    if (!spared(c)) return false;
    if (protectedContact(c)) prot++;
  }
  return prot > 0;
}

/**
 * Owner Q-7 (M10.7a): would these men refuse an order to fire at `contact` (if given) or at (x, y)? They refuse when
 * any of them recognises the named enemy as protected, or when every enemy they know within `radius` of the point is
 * spared and at least one is recognised as protected (fire there would be fire at a medic, an ambulance, bearers or
 * the Verwundetennest only).
 */
export function refusesFireAt(state: SimState, men: readonly EntityId[], x: number, y: number, contact: EntityId | undefined, radius: number): boolean {
  if (contact !== undefined) {
    const prot = protectedTargets(state, men);
    if (prot !== null && prot.has(contact)) return true;
  }
  const all: Contact[] = [];
  for (const m of men) { const s = state.soldier.get(m); if (s) for (const c of s.contacts) all.push(c); }
  return onlyProtectedAt(all, x, y, radius);
}
