/**
 * Field repair (M11.7a): what a crew can fix on its own hull, who works at it and where he stands. Pure helpers
 * (the drill itself is systems/repair.ts); the UI and the AI read them too. Data: core/repair.json (tasks, quiet
 * rule, work rate) and each vehicle's `repair` block (tool kit, parts per task). No faction appears here.
 */
import type { Catalog, ComponentKind, RepairTaskDef, StationKind, VehicleDef } from "./catalog";
import type { SoldierState, Transform, VehicleState } from "./components";
import type { SimContext } from "./context";
import type { DefId, EntityId } from "./ids";
import { isAble } from "./impair";
import { indoorAt } from "./interior-nav";
import { countItems } from "./items";
import { atan2, cos, sin } from "./math";
import { REPAIR_INSIDE, REPAIR_OUTSIDE } from "./mount";
import type { Container } from "./items";
import type { DeepReadonly, SimState, SimView } from "./state";

/** Why a crew cannot repair anything now: nothing to fix, the parts or the tool kit missing, beyond the crew. */
export type RepairRefusal = "nothing" | "noParts" | "beyondCrew";
/** The task a crew would do next: component index `k`, its kind, the task, the parts it uses up. */
export interface RepairPick { k: number; kind: ComponentKind; task: RepairTaskDef; parts: { item: DefId; count: number }[] }

const MOBILITY: readonly ComponentKind[] = ["engine", "transmission", "track", "wheels"];

/** Can the crew fix this kind on this hull at all (a task in core/repair.json and in the hull's `repair` block)? */
function crewTask(catalog: Catalog, def: VehicleDef, kind: ComponentKind): RepairTaskDef | undefined {
  const t = catalog.repair?.tasks[kind];
  return t !== undefined && def.repair?.parts[kind] !== undefined ? t : undefined;
}

/**
 * The next repair task of a hull (core/repair.json `order`: mobility first), or why there is none. A component is a
 * task when it is below the task's `restoreTo` and at least its `minCondition`, has not failed a repair this battle
 * (`repairBeyond`), and the parts and the tool kit are aboard. A mobility task is skipped while another mobility
 * kill the crew cannot fix is present (an engine at 0: the hull would stay immobile; plan B1). A hull without
 * components or without a `repair` block has nothing to do (fixture carts, lab targets frozen with all parts whole).
 */
export function repairTaskFor(catalog: Catalog, state: SimView, vid: EntityId, v: DeepReadonly<VehicleState>, def: VehicleDef): RepairPick | RepairRefusal {
  const R = catalog.repair, comps = def.components, rep = def.repair;
  if (!R || !comps || !rep) return "nothing";
  const beyond = v.repairBeyond ?? [];
  let mobilityLost = false;
  for (let k = 0; k < comps.length; k++) {
    const kind = comps[k]!.kind;
    if (!MOBILITY.includes(kind) || (v.comp[k] ?? 1) > 0) continue;
    const t = crewTask(catalog, def, kind);
    if (t === undefined || beyond.includes(k) || t.minCondition > 0) mobilityLost = true;
  }
  const c = state.container.get(vid) as Container | undefined;
  const toolOk = rep.tool === undefined || (c !== undefined && countItems(c, rep.tool) > 0);
  let refusal: RepairRefusal = "nothing";
  for (const kind of R.order) {
    const task = crewTask(catalog, def, kind);
    if (task === undefined) continue;
    const parts = rep.parts[kind]!;
    for (let k = 0; k < comps.length; k++) {
      if (comps[k]!.kind !== kind) continue;
      const cond = v.comp[k] ?? 1;
      if (cond >= task.restoreTo) continue;
      if (cond < task.minCondition || beyond.includes(k) || (mobilityLost && MOBILITY.includes(kind))) { if (refusal === "nothing") refusal = "beyondCrew"; continue; }
      if (!toolOk || parts.some((p) => c === undefined || countItems(c, p.item) < p.count)) { refusal = "noParts"; continue; }
      return { k, kind, task, parts };
    }
  }
  if (refusal !== "nothing") return refusal;
  // Damage the crew cannot touch at all (the gun, the engine, the sights ...): beyond the crew.
  for (let k = 0; k < comps.length; k++) {
    if ((v.comp[k] ?? 1) >= 1) continue;
    const t = crewTask(catalog, def, comps[k]!.kind);
    if (t === undefined || (v.comp[k] ?? 1) < t.restoreTo) return "beyondCrew";
  }
  return "nothing";
}

/** A man's work rate (core/repair.json `skill`): 1 + k x (skill - ref), at least `minRate`; the driver x factor. */
export function workRate(catalog: Catalog, s: SoldierState | undefined, station: StationKind | undefined): number {
  const K = catalog.repair?.skill;
  if (!K || !s) return 1;
  const r = Math.max(K.minRate, 1 + K.k * ((s.skills[K.key] ?? K.ref) - K.ref));
  return station === "driver" ? r * K.driverFactor : r;
}

/** Is this man repairing this hull (either action)? */
export function repairingVehicle(state: SimState, id: EntityId): EntityId | null {
  if (state.action.size === 0) return null;
  const a = state.action.get(id);
  return a !== undefined && (a.kind === REPAIR_OUTSIDE || a.kind === REPAIR_INSIDE) ? Number(a.params["vehicle"]) : null;
}

/** Seat indices of the men at work on the hull's repair now. */
export function repairWorkers(state: SimState, vid: EntityId, v: VehicleState): number[] {
  const out: number[] = [];
  for (let k = 0; k < v.seats.length; k++) { const m = v.seats[k]; if (m !== null && m !== undefined && repairingVehicle(state, m) === vid) out.push(k); }
  return out;
}

/** Who goes (plan D3, A4, B2): outside the driver, then the loader, then the gunner (the commander stays at his
 *  post); inside the loader, the gunner, the commander, the driver. Only free, able men who can use their arms
 *  (and walk, for outside work); never a passenger. */
const OUTSIDE_ORDER: readonly StationKind[] = ["driver", "loader", "gunner"];
const INSIDE_ORDER: readonly StationKind[] = ["loader", "gunner", "commander", "driver"];
export function freeRepairMen(state: SimState, v: VehicleState, def: VehicleDef, outside: boolean, n: number): number[] {
  const out: number[] = [];
  for (const kind of outside ? OUTSIDE_ORDER : INSIDE_ORDER) {
    for (let k = 0; k < def.seats.length && out.length < n; k++) {
      if (def.seats[k]!.station !== kind) continue;
      const m = v.seats[k];
      if (m === null || m === undefined || state.action.has(m)) continue;
      const s = state.soldier.get(m);
      if (!isAble(s) || !s!.impair.canUseArms || (outside && !s!.impair.canWalk) || s!.evacuated !== undefined) continue;
      out.push(k);
    }
  }
  return out;
}

/**
 * Where a man repairing from outside stands (M11.7a, plan C2): on the ground beside the damaged component's side of
 * the hull (the sign of its box `r`), at its middle along the hull, two men a little apart (`slot`), facing it; if
 * that spot is inside a building, the other side; if that is too, behind the hull. Deterministic (the seat sync
 * calls it every tick).
 */
export function outsideSpot(ctx: SimContext, state: SimState, sid: EntityId, def: VehicleDef, t: Transform, mt: Transform): void {
  const a = state.action.get(sid);
  const comp = def.components?.[Number(a?.params["comp"] ?? -1)];
  const slot = Number(a?.params["slot"] ?? 0);
  const H = def.body.hull;
  const rMid = comp ? (comp.box.r[0] + comp.box.r[1]) / 2 : 0;
  let side = rMid > 0.2 ? 1 : rMid < -0.2 ? -1 : slot % 2 === 0 ? 1 : -1;
  const fMid = comp ? Math.min(Math.max((comp.box.f[0] + comp.box.f[1]) / 2, H.f[0] + 0.5), H.f[1] - 0.5) : 0;
  const halfW = Math.max(Math.abs(H.r[0]), Math.abs(H.r[1])) + 0.6;
  const c = cos(t.heading), s = sin(t.heading);
  let f = fMid + (slot === 0 ? -0.8 : 0.8), r = side * halfW;
  let x = t.x + c * f - s * r, y = t.y + s * f + c * r;
  if (indoorAt(ctx, x, y) >= 0) {
    side = -side; r = side * halfW;
    x = t.x + c * f - s * r; y = t.y + s * f + c * r;
    if (indoorAt(ctx, x, y) >= 0) { f = H.f[0] - 0.7; r = slot === 0 ? -0.6 : 0.6; x = t.x + c * f - s * r; y = t.y + s * f + c * r; }
  }
  mt.x = x; mt.y = y; mt.z = 0;
  mt.heading = atan2(t.y + s * fMid - y, t.x + c * fMid - x);
}
