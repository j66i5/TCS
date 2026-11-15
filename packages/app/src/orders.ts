/**
 * The player's orders (from the `main.ts` split, D2): plans, the order sent for a gesture or a tap, and the order
 * log. Every order goes to the simulation through `submitOrder` (rule 3), the player's marked as his.
 */
import {
  clearable, eyeHeightM, fireOptions, heightAt, indoorAt, isOffMap, isOut, OWN_ORDER_KINDS, sideKnowledge, standZ, submitOrder, ticksToSeconds,
  type EntityId, type Order,
} from "@tcs/sim";
import { worldToScreen } from "@tcs/render";
import {
  addPoint, centreOf, facingHandleAt, inPlacePoint, losPreview, modeAfterOrder, newPlan, ordersFor, paceToWaypoint,
  planToOrder, playerOrder, shapeOf, slotSpan, turnFormation, undoPoint, type Eye, type LosLine, type Plan, type PlanKind,
} from "@tcs/ui";
import type { App, Pt } from "./app";
import { activeMoveOf, hqMode, inMap, markerFor, unitCentre, unitMen, unitPlaces, selectedMen, slotsOf, vehicleClassOf } from "./units";

/** Rounds per fire support mission from the pop-up (the ranging rounds come on top, from the same stock); a smoke
 *  screen (M8.6) 6 rounds. */
export const SUPPORT_ROUNDS = { he: 4, smoke: 2, illum: 1 } as const;
const SCREEN_ROUNDS = 6;
/** A held press dragged this far (m) from where it started is a smoke screen's line (M8.6). */
export const SCREEN_MIN_M = 30;

/** Logs an order and sends it to the sim; the last move sent to a unit is kept (its marker can be dragged, S10). */
export function send(a: App, order: Order): void {
  a.orderLog.push(order);
  submitOrder(a.sim, order);
  if (order.issuer !== a.playerSide) { /* the AI's orders */ } else if (order.kind === "move") a.activeMoves.set(order.target, order);
  else if (order.kind === "halt" || order.kind === "assault" || order.kind === "withdraw" || order.kind === "occupy" || order.kind === "mount" || order.kind === "dismount") a.activeMoves.delete(order.target);
}

/** The AI commander's orders go to the sim unchanged, as in headless, batch and golden runs. */
export function issueAi(a: App, order: Order): void { send(a, order); }

/** The player's gestures and debug hooks: marked as the player's, moves into a building go to the floor on screen. */
export function issue(a: App, order: Order): void {
  // (Owner 2026-11-15: the headquarters selected on its own: the order reaches its own men only, not the squads.)
  if (hqMode(a) && order.target === a.overlay.selectedUnit && OWN_ORDER_KINDS.includes(order.kind)) order = { ...order, own: true };
  send(a, playerOrder(order, a.floorState.shown, (x, y) => {
    const bi = indoorAt(a.sim.ctx, x, y);
    return bi >= 0 ? a.input.map.buildings[bi]!.storeys - 1 : -1;
  }));
}

/** An order for the selected unit now (`kind` and its fields). */
export function now(a: App, target: EntityId): { tick: number; issuer: string; target: EntityId } {
  return { tick: a.sim.state.tick, issuer: a.playerSide, target };
}

/** A planned move for a vehicle: "reverse" legs drive the slowest pace backwards; no formation. */
export function forUnit(a: App, o: Order): Order {
  const cls = vehicleClassOf(a, o.target);
  if (cls === null || o.kind !== "move") return o;
  const set = ordersFor(cls, a.input.catalog.movementModes);
  return { tick: o.tick, issuer: o.issuer, target: o.target, kind: "move", waypoints: o.waypoints.map((w) => ({ x: w.x, y: w.y, ...paceToWaypoint(w.mode, set) })), ...(o.facing !== undefined ? { facing: o.facing } : {}) };
}

/** The frontage of the selected unit in formation `f` (at the doctrine's spacing). */
const frontage = (a: App, f: string) => Math.max(4, slotSpan(slotsOf(a, f), Math.max(1, unitMen(a).length)) * a.doctrineSpacing);

export function startPlan(a: App, kind: PlanKind): void {
  const f = a.formation ?? a.defaultFormation;
  a.plan = newPlan(kind, unitCentre(a), f, frontage(a, f));
  a.hud.setPlanning(kind);
}
export function endPlan(a: App): void { a.plan = null; a.dragHandle = null; a.hud.setPlanning(null); }
/** Undo the plan's last point; the last one undone closes the plan (review fix: an empty plan stayed open). */
export function undoPlanPoint(a: App): void { if (!a.plan) return; a.plan = undoPoint(a.plan); if (a.plan.points.length === 0) endPlan(a); }
/** A new formation picked in the plan bar: the plan takes it and its frontage. */
export function setFormation(a: App, f: string): void {
  a.formation = f;
  if (a.plan) a.plan = { ...a.plan, formation: f, frontageM: frontage(a, f) };
}

/** Send the planned route (the plan bar's Go, Enter). */
export function goPlan(a: App): void {
  if (a.plan && a.overlay.selectedUnit !== null) {
    const o = planToOrder(a.plan, a.playerSide, a.overlay.selectedUnit, a.sim.state.tick);
    if (o) issue(a, forUnit(a, o));
  }
  endPlan(a);
  a.orderMode = "move"; a.hud.setOrderMode("move");
}

/** After a one-tap order: back to Move unless the mode is locked on (S12). */
export function oneTapDone(a: App): void {
  const next = modeAfterOrder(a.orderMode, a.hud.modeLocked());
  if (next !== a.orderMode) { a.orderMode = next; a.hud.setOrderMode(next); }
}

const turnPending = (a: App, uid: EntityId): number | null =>
  a.pendingTurn && a.pendingTurn.uid === uid && a.sim.state.tick - a.pendingTurn.tick < 10 * 60 ? a.pendingTurn.angle : null;

/** S9: the facing handle of the selected unit while it stands (on foot outdoors, or a crewed hull); null else. */
export function facingHandle(a: App): { centre: Pt; handle: Pt; facing: number } | null {
  const uid = a.overlay.selectedUnit, st = a.sim.state;
  const u = uid === null ? undefined : st.unit.get(uid);
  if (u && a.pendingTurn?.uid === uid && u.moving) a.pendingTurn = null; // under way: the men show the turn now
  if (!u || uid === null || a.plan || u.moving || u.drill || u.boarding || u.broken || activeMoveOf(a, uid)) return null;
  if (a.orderMode !== "move" && a.orderMode !== "assault" && a.orderMode !== "withdraw") return null;
  const { men, hulls } = unitPlaces(a, uid);
  const scale = a.renderer.camera.scale;
  if (u.vehicle !== undefined) {
    const t = st.transform.get(u.vehicle), v = st.vehicle.get(u.vehicle);
    if (!t || !v || v.status !== "ok") return null;
    const c = { x: t.x, y: t.y };
    const h = turnPending(a, uid) ?? t.heading;
    return { centre: c, facing: h, handle: facingHandleAt(c, [], h, 30 / scale, 4) };
  }
  if (men.length === 0 || hulls.length > 0) return null; // riding: the vehicle turns, not the squad
  for (const m of men) if (indoorAt(a.sim.ctx, m.x, m.y) >= 0) return null; // indoors: Occupy faces the windows
  const c = centreOf(men)!;
  const lead = u.leader !== null ? st.transform.get(u.leader) : undefined;
  const facing = turnPending(a, uid) ?? lead?.heading ?? 0;
  return { centre: c, facing, handle: facingHandleAt(c, men, facing, 30 / scale) };
}

/** A plan for the selected unit from `from` to `to` (the ghost of S1 and S9). */
export function ghostPlan(a: App, kind: PlanKind, from: Pt, to: Pt, facing: number | null): Plan {
  const f = a.formation ?? a.defaultFormation;
  const p = addPoint(newPlan(kind, from, f, frontage(a, f)), to.x, to.y, a.pace);
  return facing === null ? p : { ...p, facing };
}

/** S9: the move that turns the unit where it stands (a vehicle: to its own spot; men: their middle stays). */
export function turnPlan(a: App, c: Pt, angle: number): Plan {
  if (vehicleClassOf(a, a.overlay.selectedUnit) !== null) return ghostPlan(a, "move", c, c, angle);
  // Review fix: the men keep the shape they stand in (a column turns as a column, a line as a line, at its
  // width) unless a formation was picked in the plan bar; the default one only when the shape says nothing.
  const fh = facingHandle(a);
  const men = unitPlaces(a, a.overlay.selectedUnit!).men;
  const sh = shapeOf(men, fh?.facing ?? angle);
  const f = a.formation ?? turnFormation(sh, (id) => a.input.catalog.formations[id] !== undefined, a.defaultFormation);
  const front = f === a.formation || sh.widthM < 2 ? frontage(a, f) : Math.max(4, sh.widthM);
  const at = (to: Pt): Plan => ({ ...addPoint(newPlan("move", c, f, front), to.x, to.y, a.pace), facing: angle });
  const g = markerFor(a, at(c));
  return at(g ? inPlacePoint(c, g.men) : c);
}

/** S11: the fire support pop-up at a point (M8.6: per asset; with `end` dragged far enough, a smoke screen's line);
 *  the unit's leader calls the mission. */
export function offerSupport(a: App, w: Pt, end?: Pt): void {
  const uid = a.overlay.selectedUnit;
  if (uid === null || !inMap(a, w)) return;
  const line = end !== undefined && inMap(a, end) && Math.hypot(end.x - w.x, end.y - w.y) >= SCREEN_MIN_M ? end : undefined;
  const at = { x: w.x, y: w.y, ...(line ? { x2: line.x, y2: line.y } : {}) };
  a.supportAt = at;
  const sc = worldToScreen(a.renderer.camera, line ? (at.x + line.x) / 2 : at.x, line ? (at.y + line.y) / 2 : at.y);
  const st = a.sim.state;
  const faction = st.sides.find((x) => x.id === a.playerSide)?.faction ?? "";
  a.hud.offerSupport({
    x: sc.x, y: sc.y, assets: fireOptions(a.sim.ctx, st, a.playerSide, faction, at.x, at.y, line?.x, line?.y),
    ...(line ? { line: true } : {}), night: st.environment.light < 0.5,
    pick: (asset, ammo, opts) => {
      a.supportAt = null;
      if (a.overlay.selectedUnit !== uid || !st.unit.has(uid)) return;
      issue(a, {
        ...now(a, uid), kind: "callFire", x: at.x, y: at.y, ammo, rounds: line ? SCREEN_ROUNDS : SUPPORT_ROUNDS[ammo],
        ...(line ? { x2: line.x, y2: line.y } : {}), ...(asset === "artillery" ? { asset } : {}), ...(opts.airburst ? { fuse: "airburst" as const } : {}), ...(opts.dangerClose ? { dangerClose: true } : {}),
      });
      oneTapDone(a);
    },
    cancel: () => { if (a.supportAt === at) a.supportAt = null; },
  });
}

/** Fire (or anti-tank) at a point for the selected unit: at the contact marker under it, if any (M5). */
export function fireAtPoint(a: App, w: Pt): void {
  const uid = a.overlay.selectedUnit;
  if (uid === null) return;
  // A tap on (or near) an enemy marker fires at that contact: the men aim where they believe he is.
  // (Only a tap on the marker itself: a tap anywhere else is fire at that point.)
  // mounted: ok sideKnowledge never lists men aboard
  const known = sideKnowledge(a.sim.ctx, a.sim.state, a.playerSide);
  const hits = known
    .map((k) => ({ k, d: Math.hypot(k.x - w.x, k.y - w.y) }))
    .filter(({ d }) => d <= 20 / a.renderer.scale())
    .sort((p, q) => p.d - q.d);
  const near = hits.find((h) => !h.k.surrendered);
  // A tap on an enemy your men know has surrendered: no order (fire at that point would hit him).
  if (!near && hits.length > 0) { a.hud.radio(a.strings.t("order.surrenderedTarget"), ticksToSeconds(a.sim.state.tick), "#ffb4b4"); return; }
  // (A vehicle crew: with the gun and round chosen, else the crew's choice, M7.3.)
  // (Anti-tank, M7.4a: the best-placed man with a Panzerfaust or RPG fires one round at it.)
  const nat = a.orderMode === "antitank" ? { nature: "at" as const } : vehicleClassOf(a, uid) !== null && a.nature !== null ? { nature: a.nature } : {};
  if (near) issue(a, { ...now(a, uid), kind: "fire", x: near.k.x, y: near.k.y, contact: near.k.target, ...nat });
  else issue(a, { ...now(a, uid), kind: "fire", x: w.x, y: w.y, ...nat });
  oneTapDone(a);
}

/** S2: the sight lines from the selected unit's men (or its hull's sights) to the point: terrain, walls, roofs,
 *  woods and hulls the side knows — never an enemy it has not found. */
export function losTo(a: App, w: Pt): LosLine[] {
  const uid = a.overlay.selectedUnit;
  if (uid === null) return [];
  const st = a.sim.state, map = a.input.map;
  const eyes: Eye[] = [];
  const hulls = new Set<EntityId>();
  const own = st.unit.get(uid)?.vehicle;
  if (own !== undefined) hulls.add(own);
  for (const m of selectedMen(a, uid)) {
    const s = st.soldier.get(m), t = st.transform.get(m);
    if (!s || !t || isOut(s) || s.physiology.consciousness < 0.5) continue;
    if (s.mount !== undefined) { hulls.add(s.mount.vehicle); continue; }
    eyes.push({ x: t.x, y: t.y, z: standZ(map, t) + eyeHeightM(a.sim.ctx, s.posture), ignore: -1 });
  }
  // A hull's sights: about 2.3 m above the ground (a low-confidence stand-in for its gunner's sight).
  for (const h of hulls) { const t = st.transform.get(h); if (t) eyes.push({ x: t.x, y: t.y, z: heightAt(map, t.x, t.y) + 2.3, ignore: h }); }
  // Hulls the side has seen or been told of (a heard engine gives no place to draw a line against).
  const knownHulls = new Set((a.overlay.known ?? []).filter((k) => k.cls === "vehicle" && k.kind !== "heard").map((k) => k.target));
  const unknownHull = (x: number, y: number): number => {
    let best = -1, bd = 7 * 7;
    for (const [vid, v] of st.vehicle.entries()) {
      const t = st.transform.get(vid);
      if (!t || isOffMap(v)) continue;
      const d = (t.x - x) ** 2 + (t.y - y) ** 2;
      if (d < bd) { bd = d; best = v.side !== a.playerSide && !knownHulls.has(vid) ? vid : -1; }
    }
    return best;
  };
  return losPreview(a.sim.ctx, eyes, w.x, w.y, heightAt(map, w.x, w.y) + 0.75, unknownHull);
}

/** The middle of building index `bi`'s footprint. */
function buildingCentre(a: App, bi: number): Pt {
  const b = a.input.map.buildings[bi]!;
  let cx = 0, cy = 0;
  const n = b.footprint.length / 2;
  for (let k = 0; k < n; k++) { cx += b.footprint[k * 2]!; cy += b.footprint[k * 2 + 1]!; }
  return { x: cx / n, y: cy / n };
}

/** An occupy order for building index `bi`: facing the nearest enemy the side knows, on the floor shown first. */
export function occupyOrder(a: App, target: EntityId, bi: number): Order {
  const b = a.input.map.buildings[bi]!;
  const { x: cx, y: cy } = buildingCentre(a, bi);
  // mounted: ok sideKnowledge never lists men aboard
  const known = sideKnowledge(a.sim.ctx, a.sim.state, a.playerSide);
  let best: Pt | null = null, bd = Infinity;
  for (const k of known) { const d = Math.hypot(k.x - cx, k.y - cy); if (!k.surrendered && d < bd) { bd = d; best = k; } }
  return {
    ...now(a, target), kind: "occupy", building: b.id,
    ...(a.floorState.shown > 0 ? { floor: Math.min(a.floorState.shown, b.storeys - 1) } : {}),
    ...(best ? { facing: Math.atan2(best.y - cy, best.x - cx) } : {}),
  };
}

/** Slice s0-clear: the clear drill (an assault with the building) on building index `bi`, or null (no way in). */
function clearOrder(a: App, target: EntityId, bi: number): Order | null {
  const b = a.input.map.buildings[bi]!;
  if (!clearable(a.sim.ctx, b.id)) return null;
  const c = buildingCentre(a, bi);
  return { ...now(a, target), kind: "assault", x: c.x, y: c.y, building: b.id };
}

/** Clear the house at (x, y) with unit `uid`: true if sent; else a hint in the radio log. */
export function clearAt(a: App, uid: EntityId, x: number, y: number): boolean {
  const bi = indoorAt(a.sim.ctx, x, y);
  const o = bi >= 0 ? clearOrder(a, uid, bi) : null;
  if (!o) { a.hud.radio(a.strings.t(bi >= 0 ? "plan.cannotClear" : "plan.tapClear"), ticksToSeconds(a.sim.state.tick), "#ffb4b4"); return false; }
  issue(a, o);
  return true;
}
