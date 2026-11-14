/**
 * Order gestures on the map (the "controls" step, owner choices S1, S2, S4, S9, S10, S11, S12, S13), from the
 * `main.ts` split (D2): taps, drags and the right button become plans and orders; what a gesture shows each frame.
 */
import { indoorAt, ticksToSeconds, type EntityId } from "@tcs/sim";
import { worldToScreen, type GestureOverlay } from "@tcs/render";
import { addPoint, attachInput, centreOf, dragTo, hitHandle, ordersFor, planToOrder, retargetMove, unitCapabilities, type PlanKind } from "@tcs/ui";
import type { App, Pt } from "./app";
import { stopFollow } from "./camera";
import { clearAt, facingHandle, fireAtPoint, forUnit, ghostPlan, issue, losTo, now, occupyOrder, offerSupport, oneTapDone, SCREEN_MIN_M, startPlan, turnPlan } from "./orders";
import { refreshTiles, syncOrders } from "./panels";
import { activeMoveOf, droneMode, inMap, markerFor, nearestSoldier, onSelected, placesOf, ridersIn, vehicleAt, vehicleClassOf } from "./units";

const here = (a: App, uid: EntityId) => centreOf(placesOf(a, uid));

export function attachControls(a: App, mapRoot: HTMLElement): void {
  const { sim, renderer, hud, overlay, playerSide, input } = a;
  attachInput(mapRoot, {
    getCamera: () => renderer.camera,
    // Never further out than the whole map in the free area (M7.5b).
    setCamera: (c) => { renderer.camera = renderer.clampCamera(c, hud.insets()); },
    // S5: panning by hand stops the follow camera (a pinch or the wheel only zooms: it keeps following).
    onPan: () => stopFollow(a),
    // S13: the right button moves the selected unit from wherever it is pressed: let go where it should go (a click
    // without moving: there). The ghost marker follows the mouse; back on the unit: nothing is sent.
    onRightStart: (w) => {
      const uid = overlay.selectedUnit;
      if (uid === null || !sim.state.unit.has(uid) || a.plan || droneMode(a)) return false;
      hud.offerContext(null);
      const from = here(a, uid);
      if (!from) return false;
      const kind: PlanKind = a.orderMode === "assault" || a.orderMode === "withdraw" ? a.orderMode : "move";
      a.gesture = { kind: "fromUnit", planKind: kind, plan: inMap(a, w) && !onSelected(a, w) ? ghostPlan(a, kind, from, w, null) : null, from, left: true, right: { ...w } };
      return true;
    },
    onTap: (w) => {
      hud.offerContext(null);
      // Tap on one of your men: select his top-level unit. Elsewhere: plan or order for the selected unit.
      // Only own men can be selected (and hidden enemies must not stand in the way of a tap).
      // A tap on one of your vehicles selects its crew unit (M7.1c).
      // Tapping it again goes through the units riding in it, then back to its crew (M7.2).
      const hull = !a.plan ? vehicleAt(sim, w.x, w.y, 10 / renderer.camera.scale, playerSide) : null;
      if (hull !== null) {
        const cycle = [hull, ...ridersIn(sim, hull)];
        const k = overlay.selectedUnit === null ? -1 : cycle.indexOf(overlay.selectedUnit);
        overlay.selectedUnit = cycle[(k + 1) % cycle.length]!;
        a.inspected = null;
        refreshTiles(a);
        return;
      }
      const hit = nearestSoldier(sim, w.x, w.y, 12 / renderer.camera.scale + 1, overlay.debug ? null : playerSide);
      if (hit !== null && sim.state.identity.req(hit).side === playerSide && !a.plan) {
        // His own unit (his squad; the platoon's own men select the platoon). A man of the unit already selected:
        // his detail box (S6; again: closed).
        const his = sim.state.identity.req(hit).unit;
        if (his === overlay.selectedUnit) a.inspected = a.inspected === hit ? null : hit;
        else { overlay.selectedUnit = his; a.inspected = null; }
        overlay.selectedDrone = null;
        syncOrders(a); refreshTiles(a);
        return;
      }
      const uid = overlay.selectedUnit;
      if (uid === null) return;
      if (!inMap(a, w)) return;
      if (droneMode(a)) {
        // The drone (M9.4a): a tap sends it there (launched first if it is on the ground).
        issue(a, { ...now(a, uid), kind: "drone", op: "fly", x: w.x, y: w.y });
        return;
      }
      const mode = a.orderMode;
      if (mode === "grenade" || mode === "grenades" || mode === "smoke") {
        // "All grenades": every man who can reach the point throws or fires, a moment apart. "Smoke" (D1): one man
        // throws a hand smoke grenade there.
        issue(a, { ...now(a, uid), kind: "grenade", x: w.x, y: w.y, ...(mode === "grenades" ? { count: 50 } : {}), ...(mode === "smoke" ? { smoke: true } : {}) });
        oneTapDone(a);
        return;
      }
      if (mode === "occupy") {
        // Occupy (M7.5d): the tapped building's windows, those facing the nearest enemy the side knows first.
        const bi = indoorAt(sim.ctx, w.x, w.y);
        if (bi < 0) { hud.radio(a.strings.t("plan.tapBuilding"), ticksToSeconds(sim.state.tick), "#ffb4b4"); return; }
        issue(a, occupyOrder(a, uid, bi));
        oneTapDone(a);
        return;
      }
      if (mode === "clear") {
        // Clear (slice s0-clear): the squad's house-clearing drill on the tapped house.
        if (clearAt(a, uid, w.x, w.y)) oneTapDone(a);
        return;
      }
      if (mode === "support") {
        // Fire support (M6.5c; S11): a pop-up at the point offers HE or smoke; the unit's leader calls it, ranging
        // rounds land after a minute or more, then the battery fires together.
        offerSupport(a, w);
        return;
      }
      if (mode === "fire" || mode === "antitank") { fireAtPoint(a, w); return; }
      // Move / assault / withdraw: each tap adds a point to the plan; Go sends it.
      if (!a.plan) startPlan(a, mode);
      a.plan = addPoint(a.plan!, w.x, w.y, a.pace);
    },
    // Gestures (the "controls" step): a plan's handles first; then, with a unit selected, in Fire mode a held
    // press anywhere (S2); in Move / Assault / Withdraw the facing handle (S9), the active move's marker (S10) or
    // the unit itself (S1). Anything else pans the map as before.
    onDragStart: (w) => {
      a.gesture = null;
      hud.offerContext(null);
      if (a.plan) {
        const g = markerFor(a, a.plan);
        a.dragHandle = hitHandle(a.plan, g, w.x, w.y, 22 / renderer.camera.scale + 1);
        a.dragGapM = g?.resizeGapM ?? 3;
        if (a.dragHandle !== null) a.gesture = { kind: "plan" };
        return a.dragHandle !== null;
      }
      const uid = overlay.selectedUnit;
      if (uid === null || !sim.state.unit.has(uid) || droneMode(a)) return false;
      const mode = a.orderMode;
      if (mode === "fire" || mode === "antitank") {
        if (!inMap(a, w)) return false;
        const on = onSelected(a, w);
        a.gesture = { kind: "fire", at: { ...w }, onUnit: on, los: on ? [] : losTo(a, w) };
        return "hold"; // (touch: a quick swipe pans instead; review fix)
      }
      // S11: a press in Fire support mode holds a point (it can be slid to adjust); letting go offers HE or smoke.
      if (mode === "support") {
        if (!inMap(a, w)) return false;
        hud.offerSupport(null);
        a.gesture = { kind: "support", at: { ...w }, from: { ...w } };
        return "hold";
      }
      // Clear (slice s0-clear): drag the unit onto a house (the ghost of an assault follows the pointer).
      if (mode === "clear") {
        if (!onSelected(a, w)) return false;
        a.gesture = { kind: "fromUnit", planKind: "assault", plan: null, from: here(a, uid) ?? { ...w }, left: false, clear: true };
        return true;
      }
      if (mode !== "move" && mode !== "assault" && mode !== "withdraw") return false;
      const tolM = 22 / renderer.camera.scale + 1;
      const fh = facingHandle(a);
      if (fh && Math.hypot(fh.handle.x - w.x, fh.handle.y - w.y) <= tolM) { a.gesture = { kind: "facing", centre: fh.centre, angle: null, start: fh.facing, dist: Math.hypot(fh.handle.x - fh.centre.x, fh.handle.y - fh.centre.y) }; return true; }
      const mv = activeMoveOf(a, uid);
      const end = mv?.waypoints[mv.waypoints.length - 1];
      if (mv && end && Math.hypot(end.x - w.x, end.y - w.y) <= tolM) {
        a.gesture = { kind: "marker", prev: mv, at: { x: end.x, y: end.y }, from: here(a, uid) ?? { x: end.x, y: end.y }, onUnit: false };
        return true;
      }
      if (onSelected(a, w)) { a.gesture = { kind: "fromUnit", planKind: mode, plan: null, from: here(a, uid) ?? { ...w }, left: false }; return true; }
      return false;
    },
    onDrag: (w) => {
      const gs = a.gesture;
      if (!gs) return;
      if (gs.kind === "plan") { if (a.plan && a.dragHandle !== null) a.plan = dragTo(a.plan, a.dragHandle, w.x, w.y, { minFrontageM: 2, maxFrontageM: 200, resizeGapM: a.dragGapM }); return; }
      if (gs.kind === "fire") { gs.at = { ...w }; gs.onUnit = onSelected(a, w); gs.los = gs.onUnit || !inMap(a, w) ? [] : losTo(a, w); return; }
      if (gs.kind === "support") { if (inMap(a, w)) gs.at = { ...w }; return; }
      if (gs.kind === "facing") { if (Math.hypot(w.x - gs.centre.x, w.y - gs.centre.y) > 0.5) gs.angle = Math.atan2(w.y - gs.centre.y, w.x - gs.centre.x); return; }
      if (gs.kind === "marker") { gs.at = { ...w }; gs.onUnit = onSelected(a, w); return; }
      // From the unit: the ghost marker appears once the pointer has left the unit.
      gs.plan = onSelected(a, w) || !inMap(a, w) ? null : ghostPlan(a, gs.planKind, gs.from, w, null);
      if (gs.plan) gs.left = true;
    },
    onDragEnd: (how) => {
      const gs = a.gesture;
      a.gesture = null;
      a.dragHandle = null;
      const uid = overlay.selectedUnit;
      if (!gs || gs.kind === "plan" || how === "cancel" || uid === null) return false;
      // Released without moving: a tap as before (a press on the unit still selects it, in Fire mode it fires); only
      // a tap on the facing handle does nothing. (A right click: the move to that point, below.)
      if (how === "tap" && !(gs.kind === "fromUnit" && gs.right)) return gs.kind !== "facing";
      if (gs.kind === "fire") { if (!gs.onUnit && inMap(a, gs.at)) fireAtPoint(a, gs.at); return false; }
      if (gs.kind === "support") {
        // (M8.6: dragged out far enough, a smoke screen from where the press began to where it let go; else the point,
        // slid as before.)
        if (Math.hypot(gs.at.x - gs.from.x, gs.at.y - gs.from.y) >= SCREEN_MIN_M) offerSupport(a, gs.from, gs.at); else offerSupport(a, gs.at);
        return false;
      }
      if (gs.kind === "facing") {
        if (gs.angle === null) return false;
        const o = planToOrder(turnPlan(a, gs.centre, gs.angle), playerSide, uid, sim.state.tick);
        if (o) { issue(a, forUnit(a, o)); a.pendingTurn = { uid, angle: gs.angle, tick: sim.state.tick }; }
        a.activeMoves.delete(uid); // a turn on the spot has no marker to drag
        return false;
      }
      if (gs.kind === "marker") {
        if (gs.onUnit) { issue(a, { ...now(a, uid), kind: "halt" }); return false; }
        if (!inMap(a, gs.at)) return false;
        issue(a, forUnit(a, retargetMove(gs.prev, gs.at, here(a, uid) ?? gs.from, sim.state.tick)));
        return false;
      }
      if (!gs.plan) return false; // let go on the unit (or off the map): nothing is sent
      if (gs.clear) {
        const end = gs.plan.points.at(-1);
        if (end && clearAt(a, uid, end.x, end.y)) oneTapDone(a);
        return false;
      }
      const o = planToOrder(gs.plan, playerSide, uid, sim.state.tick);
      if (o) issue(a, forUnit(a, o));
      if (gs.planKind !== "move" && !gs.right) oneTapDone(a);
      // S4: a move dragged onto a building offers Occupy there (a context button at the drop point, a few seconds).
      const end = gs.plan.points.at(-1);
      const bi = end && gs.planKind === "move" && vehicleClassOf(a, uid) === null && ordersFor(unitCapabilities(sim.state, input.catalog, uid), input.catalog.movementModes).modes.includes("occupy") ? indoorAt(sim.ctx, end.x, end.y) : -1;
      if (end && bi >= 0) {
        const at = worldToScreen(renderer.camera, end.x, end.y);
        hud.offerContext({ icon: "occupy", key: "order.occupyHere", x: at.x, y: at.y, run: () => { if (overlay.selectedUnit === uid) issue(a, occupyOrder(a, uid, bi)); } });
      }
      return false;
    },
  });
}

/** What the gestures show this frame (S1, S2, S9, S10, S11). */
export function gestureOverlay(a: App): GestureOverlay | null {
  const uid = a.overlay.selectedUnit;
  if (uid === null) return null;
  const st = a.sim.state, gs = a.gesture, out: GestureOverlay = {};
  // S11: the point held for fire support, or picked while its pop-up is open, joined to the unit's leader.
  // (M8.6: a press dragged out far enough, or a screen picked: the screen's line.)
  const sp: (Pt & { x2?: number; y2?: number }) | null = gs?.kind === "support"
    ? (Math.hypot(gs.at.x - gs.from.x, gs.at.y - gs.from.y) >= SCREEN_MIN_M ? { x: gs.from.x, y: gs.from.y, x2: gs.at.x, y2: gs.at.y } : gs.at)
    : a.supportAt;
  if (sp) {
    const lead = st.unit.get(uid)?.leader;
    const lt = lead !== null && lead !== undefined ? st.transform.get(lead) : undefined;
    out.support = { x: sp.x, y: sp.y, from: lt ? { x: lt.x, y: lt.y } : here(a, uid), ...(sp.x2 !== undefined && sp.y2 !== undefined ? { x2: sp.x2, y2: sp.y2 } : {}) };
  }
  if (gs?.kind === "fire") {
    out.los = gs.los;
    out.target = gs.onUnit ? null : gs.at;
    if (gs.onUnit) out.cancelAt = here(a, uid);
  } else if (gs?.kind === "marker") {
    out.marker = gs.onUnit ? null : { x: gs.at.x, y: gs.at.y, from: here(a, uid), dragging: true };
    if (gs.onUnit) out.cancelAt = here(a, uid);
  } else if (gs?.kind === "fromUnit") {
    if (gs.left && !gs.plan) out.cancelAt = here(a, uid);
  } else if (gs?.kind === "facing") {
    const ang = gs.angle ?? gs.start;
    out.facing = { centre: gs.centre, handle: { x: gs.centre.x + Math.cos(ang) * gs.dist, y: gs.centre.y + Math.sin(ang) * gs.dist }, dragging: true };
  }
  if (!a.plan && gs?.kind !== "marker") {
    const end = activeMoveOf(a, uid)?.waypoints.at(-1);
    if (end) out.marker = { x: end.x, y: end.y, from: null, dragging: false };
  }
  if (!gs) { const fh = facingHandle(a); if (fh) out.facing = { centre: fh.centre, handle: fh.handle, dragging: false }; }
  // S6: the man whose box is open (on foot: his ring; aboard: none).
  const im = a.inspected === null ? undefined : st.soldier.get(a.inspected);
  const it = a.inspected === null || im?.mount !== undefined ? undefined : st.transform.get(a.inspected);
  if (it) out.man = { x: it.x, y: it.y };
  return out;
}

/** The plan on the map this frame: the plan being made, or a gesture's ghost marker (S1, S9, S10; no handles). */
export function planOverlay(a: App): void {
  const ov = a.overlay, plan = a.plan, gesture = a.gesture;
  ov.plan = plan ? { kind: plan.kind, from: plan.from, points: plan.points, marker: markerFor(a, plan) } : null;
  if (!plan && gesture && (gesture.kind === "fromUnit" || (gesture.kind === "facing" && gesture.angle !== null) || (gesture.kind === "marker" && !gesture.onUnit))) {
    const onFoot = vehicleClassOf(a, ov.selectedUnit) === null;
    const gp = gesture.kind === "fromUnit" ? gesture.plan
      : gesture.kind === "facing" ? (onFoot ? turnPlan(a, gesture.centre, gesture.angle!) : null)
      : ghostPlan(a, "move", gesture.from, gesture.at, null);
    ov.plan = gp ? { kind: gp.kind, from: gp.from, points: gesture.kind === "facing" ? [] : gp.points, marker: onFoot ? markerFor(a, gp) : null, ghost: true } : null;
  }
}
