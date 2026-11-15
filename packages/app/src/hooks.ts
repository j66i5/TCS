/**
 * `window.__tcs`: the hook for the headless screenshot script and for debugging in the browser console (from the
 * `main.ts` split, D2). The battle opens with nothing selected (M7.5a): an order through the hook with nothing
 * selected goes to (and selects) the first own unit. Orders still go through `issue` (rule 3); `hurt` and `carry`
 * are screenshot-only shortcuts, as before.
 */
import { buildAppearance, type DataSet } from "@tcs/data";
import { EventSink, indoorAt, navFor, refreshStatus, simHash, startCarry, supportLeft, type EntityId, type Wound } from "@tcs/sim";
import { enemyMenInSight, SIDE_COLOURS, worldToScreen } from "@tcs/render";
import { addPoint, centreOf, planToOrder, unitTiles } from "@tcs/ui";
import type { App } from "./app";
import { centredOn, startFollow, stopFollow, viewInsets } from "./camera";
import { activeMoveOf, placesOf, ridersIn, vehicleClassOf } from "./units";
import { clearAt, endPlan, facingHandle, forUnit, issue, now, occupyOrder, offerSupport, startPlan, SUPPORT_ROUNDS } from "./orders";
import { select, showCard, syncOrders } from "./panels";
import { showSpriteSheet } from "./sprite-sheet";
import { sightView } from "./view";

export function installHooks(a: App, data: DataSet, stepOnce: () => void): void {
  const { sim, hud, renderer, overlay, playerSide } = a;
  const sel = (): EntityId => {
    if (overlay.selectedUnit === null) { overlay.selectedUnit = [...sim.state.unit.entries()].find(([, u]) => u.side === playerSide && u.parent === null)?.[0] ?? null; syncOrders(a); }
    return overlay.selectedUnit as EntityId;
  };
  const to = () => now(a, sel());
  const setDebug = (on: boolean) => {
    overlay.debug = on;
    renderer.setNavOverlay(on ? navFor(sim.ctx, vehicleClassOf(a, overlay.selectedUnit) ?? "foot").grid : null);
    renderer.setSightOverlay(on ? sightView(a) : null);
    a.sightAt = sim.state.tick;
  };
  (window as unknown as { __tcs: unknown }).__tcs = {
    sim,
    orderLog: a.orderLog,
    /** D2: the battle record so far (the review's source; the batch tool keeps the same record). */
    record: () => a.record,
    /** D2: the review's tab (battle, medical, conduct) — read, or switch with an argument. */
    reviewTab: (t?: "battle" | "medical" | "conduct") => a.review?.tab(t) ?? null,
    stepTicks: (n: number) => { for (let i = 0; i < n; i++) stepOnce(); },
    grenadeAt: (x: number, y: number, count = 1) => issue(a, { ...to(), kind: "grenade", x, y, count }),
    smokeAt: (x: number, y: number) => issue(a, { ...to(), kind: "grenade", x, y, smoke: true }),
    /** M7.5d: occupy the building at (x, y) with the selected unit; the floor switch; the floor shown. */
    occupyAt: (x: number, y: number) => { const bi = indoorAt(sim.ctx, x, y); if (bi >= 0) issue(a, occupyOrder(a, sel(), bi)); },
    /** Clear the building at (x, y) with the selected unit, as the Clear button does (M7.5e screenshots; slice s0-clear). */
    clearAt: (x: number, y: number) => { clearAt(a, sel(), x, y); },
    setFloor: (f: number) => { a.floorPick = f; },
    reveal: (on: boolean) => { a.revealAll = on; overlay.reveal = on; },
    floorShown: () => a.floorState.shown,
    /** Fog of war (screenshots): the enemy men drawn as figures now (in sight of the player's side). */
    enemyInSight: () => [...enemyMenInSight(overlay.known)],
    fireAt: (x: number, y: number) => issue(a, { ...to(), kind: "fire", x, y }),
    /** Plan a move through these points (screenshots): the marker is shown until go(). */
    planMove: (pts: { x: number; y: number; mode?: string }[], facing?: number, frontageM?: number) => {
      sel();
      startPlan(a, "move");
      for (const p of pts) a.plan = addPoint(a.plan!, p.x, p.y, p.mode ?? a.pace);
      if (facing !== undefined) a.plan = { ...a.plan!, facing };
      if (frontageM !== undefined) a.plan = { ...a.plan!, frontageM };
    },
    cancelPlan: () => { endPlan(a); },
    go: () => { if (a.plan && overlay.selectedUnit !== null) { const o = planToOrder(a.plan, playerSide, overlay.selectedUnit, sim.state.tick); if (o) issue(a, forUnit(a, o)); } endPlan(a); },
    /** Select a unit (screenshots: a vehicle's crew unit). */
    select: (uid: EntityId | null) => select(a, uid),
    /** M7.5a screenshots: dock the order bar, open the sidebar's list, the order set shown, the free area. */
    dock: (e: "top" | "bottom" | "left" | "right") => hud.setDock(e),
    expandSidebar: (on: boolean) => hud.setSidebarExpanded(on),
    orderSet: () => hud.orderSet(),
    insets: () => hud.insets(),
    /** The free map area less the radio log and card (review fix; the follow camera and centring use it). */
    viewInsets: () => viewInsets(a),
    /** Own top-level units and all own units (sidebar order). */
    units: () => unitTiles(sim.state, playerSide, a.input.catalog).map((t) => ({ unit: t.unit, callsign: t.callsign, kind: t.kind, depth: t.depth })),
    /** Own vehicles: [entity, crew unit] (screenshots). */
    vehicles: () => [...sim.state.vehicle.entries()].filter(([, v]) => v.side === playerSide).map(([id, v]) => [id, v.unit]),
    /** Get in / get out (M7.2), for the selected unit. */
    mount: () => issue(a, { ...to(), kind: "mount" }),
    dismount: () => issue(a, { ...to(), kind: "dismount" }),
    /** M10.4b (screenshots, checks): get out and carry the wounded aboard out too. */
    dismountWounded: () => issue(a, { ...to(), kind: "dismount", wounded: true }),
    /** Own units riding in a vehicle (its crew unit given): screenshots. */
    riders: (crew: EntityId) => ridersIn(sim, crew),
    showRules: () => hud.showRules(),
    assault: (x: number, y: number) => issue(a, { ...to(), kind: "assault", x, y }),
    posture: (p: "standing" | "crouching" | "prone") => issue(a, { ...to(), kind: "posture", posture: p }),
    setDebug,
    tap: (x: number, y: number) => issue(a, { ...to(), kind: "move", waypoints: [{ x, y, mode: a.pace }], ...(a.formation ? { formation: a.formation } : {}) }),
    setSpeed: (v: number) => { hud.setSpeed(v); a.speed = v; },
    /** Vehicles (M7.3): smoke screen, and the gun and round of the next fire order (screenshots). */
    discharge: () => issue(a, { ...to(), kind: "discharge" }),
    halt: () => issue(a, { ...to(), kind: "halt" }),
    fireNature: (x: number, y: number, n: "ap" | "he" | "mg" | "at", contact?: number) => issue(a, { ...to(), kind: "fire", x, y, nature: n, ...(contact !== undefined ? { contact } : {}) }),
    focus: (x: number, y: number, widthM: number) => renderer.focus(x, y, widthM, hud.insets()),
    /** M7.5b screenshots: centre at a zoom (px/m); the zoom level shown; a roof's alpha. */
    focusScale: (x: number, y: number, scale: number) => { renderer.focusScale(x, y, scale, hud.insets()); void renderer.primeDetail(); },
    /** Photo terrain tiles still to paint or upload (screenshots wait for 0). */
    tilesPending: () => renderer.tilesPending(),
    terrainLevel: () => renderer.terrainLevel(),
    zoomLevel: () => renderer.zoomLevel(),
    /** M7.5b screenshots: every soldier frame of both sides (with variants) as a sheet over the map; false hides it. */
    showSprites: (on: boolean) => showSpriteSheet(on, sim.state.sides.map((x) => ({ faction: x.faction, colour: SIDE_COLOURS[sim.state.sides.indexOf(x)] ?? 0xffffff })), buildAppearance(data, sim.state.sides.map((x) => x.faction))),
    roofAlpha: (i: number) => renderer.roofAlpha(i),
    renderer,
    /** The "controls" step (screenshots, checks): a world point on the screen (CSS px), and the gestures' state. */
    toScreen: (x: number, y: number) => worldToScreen(renderer.camera, x, y),
    controls: () => {
      const gs = a.gesture;
      return {
        mode: a.orderMode, locked: hud.modeLocked(), gesture: gs?.kind ?? null,
        los: gs?.kind === "fire" ? gs.los.map((l) => (l.clear ? "clear" : "blocked")) : null,
        marker: activeMoveOf(a, overlay.selectedUnit)?.waypoints.at(-1) ?? null,
        facing: facingHandle(a), centre: centreOf(placesOf(a, overlay.selectedUnit)),
      };
    },
    /** M10.3b screenshots: wound a man (a bullet wound with these fields; `unconscious` knocks him out). */
    hurt: (id: EntityId, w: Partial<Wound>, unconscious = false) => {
      const s = sim.state.soldier.get(id);
      if (!s) return;
      s.wounds.push({ id: s.nextWoundId++, zone: "legL", mechanism: "bullet", severity: 0.4, bleedingLps: 0, compressible: true, airway: false, breathing: false, consciousness: unconscious, tickInflicted: sim.state.tick, treatments: [], ...w });
      if (unconscious) s.physiology.consciousness = 0;
      refreshStatus(sim.ctx, sim.state, new EventSink(), id);
    },
    /** M10.4b (screenshots, checks): `carriers` carry `payload` to (x, y) (a carry method by id, else the best). */
    carry: (payload: EntityId, carriers: EntityId[], x: number, y: number, method?: string) =>
      startCarry(sim.ctx, sim.state, new EventSink(), payload, carriers, { x, y, z: 0 }, method !== undefined ? { method } : {}) !== null,
    /** The "bar-card" step (screenshots, checks): the man box for a man (null closes), the card's state. */
    inspect: (id: EntityId | null) => { a.inspected = id; showCard(a); },
    card: () => ({ inspected: a.inspected, pace: a.pace, detailed: document.querySelector(".hud-card.detailed") !== null, rules: overlay.selectedUnit === null ? null : { fire: sim.state.unit.get(overlay.selectedUnit)?.fireRule, maxEngageM: sim.state.unit.get(overlay.selectedUnit)?.maxEngageM } }),
    /** The "map-feel" step (screenshots, checks): lines, pins, follow, contours, help, speed. */
    mapfeel: () => ({
      following: a.following, contours: a.contoursOn, help: hud.helpShown(), speed: hud.speed(), selected: overlay.selectedUnit, mode: a.orderMode, plan: a.plan !== null,
      intents: (overlay.intents ?? []).map((l) => ({ kind: l.kind, selected: l.selected })), pins: (overlay.pins ?? []).map((p) => ({ target: p.target, x: p.x, y: p.y, label: p.label })),
      centred: overlay.selectedUnit === null ? null : centredOn(a, overlay.selectedUnit), inspected: a.inspected,
    }),
    follow: (uid: EntityId | null) => { if (uid === null) stopFollow(a); else { startFollow(a, uid); select(a, uid); } },
    callFire: (x: number, y: number, ammo: "he" | "smoke" = "he") => issue(a, { ...to(), kind: "callFire", x, y, ammo, rounds: SUPPORT_ROUNDS[ammo] }),
    /** S11: open the fire support pop-up at a world point (as a press held there in the Fire support mode). */
    offerSupport: (x: number, y: number) => offerSupport(a, { x, y }),
    /** Step fire-support (screenshots, checks): the pop-up, the point held, the side's missions as their lines show. */
    support: () => ({
      popup: hud.supportShown(), at: a.gesture?.kind === "support" ? a.gesture.at : a.supportAt, mode: a.orderMode, he: supportLeft(sim.state, playerSide, "he", sim.ctx.catalog), smoke: supportLeft(sim.state, playerSide, "smoke", sim.ctx.catalog),
      missions: (overlay.intents ?? []).filter((l) => l.kind === "fire").map((l) => ({ x: l.x1, y: l.y1, phase: l.phase ?? null, falls: l.falls?.length ?? 0 })),
    }),
    moveUnit: (uid: EntityId, x: number, y: number) => issue(a, { ...now(a, uid), kind: "move", waypoints: [{ x, y, mode: "walk" }] }),
    hash: () => simHash(sim),
    ready: true,
  };
}
