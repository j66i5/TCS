/**
 * `window.__tcs`: the hook for the headless screenshot script and for debugging in the browser console (from the
 * `main.ts` split, D2). The battle opens with nothing selected (M7.5a): an order through the hook with nothing
 * selected goes to (and selects) the first own unit. Orders still go through `issue` (rule 3); `hurt` and `carry`
 * are screenshot-only shortcuts, as before.
 */
import { buildAppearance, type DataSet } from "@tcs/data";
import { EventSink, ignite, indoorAt, isOffMap, isOutside, navFor, newCache, refreshStatus, simHash, startCarry, supportLeft, surrender, type EntityId, type Wound } from "@tcs/sim";
import { enemyMenInSight, SIDE_COLOURS, worldToScreen } from "@tcs/render";
import { addPoint, centreOf, planToOrder, unitTiles } from "@tcs/ui";
import type { App } from "./app";
import { centredOn, startFollow, stopFollow, viewInsets } from "./camera";
import { activeMoveOf, placesOf, ridersIn, vehicleClassOf } from "./units";
import { clearAt, endPlan, facingHandle, fetchAmmo, fireAtPoint, forUnit, issue, now, occupyOrder, offerSupport, resupply, sendBearers, startPlan, SUPPORT_ROUNDS, takeKit } from "./orders";
import { select, showCard, syncOrders } from "./panels";
import { showSpriteSheet } from "./sprite-sheet";
import { sightView } from "./view";
import type { PerfReport } from "./perf";

export function installHooks(a: App, data: DataSet, stepOnce: () => void, perf?: (reset?: boolean) => PerfReport): void {
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
    reviewTab: (t?: "battle" | "medical" | "conduct" | "logistics") => a.review?.tab(t) ?? null,
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
    /** The fire gesture's tap (review fix: what the player's tap does, with its warnings). */
    fireTap: (x: number, y: number) => fireAtPoint(a, { x, y }),
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
    select: (uid: EntityId | null, part?: "drone" | "hq") => select(a, uid, part),
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
    vehicles: () => [...sim.state.vehicle.entries()].filter(([, v]) => v.side === playerSide && !isOffMap(v)).map(([id, v]) => [id, v.unit]),
    /** Get in / get out (M7.2), for the selected unit. */
    mount: () => issue(a, { ...to(), kind: "mount" }),
    dismount: () => issue(a, { ...to(), kind: "dismount" }),
    rearRun: () => issue(a, { ...to(), kind: "rearRun" }),
    /** M11.7a: the selected crew's field repair now; damage a hull's components of a kind (screenshots, checks:
     *  the status follows as a hit would make it). */
    repair: () => issue(a, { ...to(), kind: "repair" }),
    isOutside: (id: EntityId) => isOutside(sim.state, id),
    damage: (vid: EntityId, kind: string, c: number) => {
      const v = sim.state.vehicle.get(vid), def = v ? sim.ctx.catalog.vehicles[v.def] : undefined;
      if (!v || !def?.components) return;
      def.components.forEach((x, k) => { if (x.kind === kind) v.comp[k] = c; });
      v.lastHitTick = sim.state.tick; // (as the hit that did it: the crew waits for the quiet period)
      if (c <= 0 && (kind === "track" || kind === "wheels" || kind === "engine" || kind === "transmission") && (v.status === "ok" || v.status === "disarmed")) { v.status = "immobilised"; v.drive.route = []; v.drive.arrived = true; }
    },
    /** M11.7b (screenshots, checks): call a recovery vehicle for the selected crew's hull (or hull `vid`); bring a
     *  called one on now (`hurry`: its delay is over); the side's recovery vehicles and their run phase. */
    callRecovery: (vid?: EntityId) => issue(a, { ...to(), kind: "callRecovery", ...(vid !== undefined ? { vehicle: vid } : {}) }),
    hurryRecovery: () => { for (const [, v] of sim.state.vehicle.entries()) if (v.offMap?.kind === "recovery" && v.offMap.phase === "called") v.offMap.enterTick = sim.state.tick; },
    recovery: () => [...sim.state.vehicle.entries()].filter(([, v]) => v.offMap?.kind === "recovery").map(([id, v]) => ({ id, side: v.side, phase: v.offMap!.phase, target: v.offMap!.target ?? null, hook: v.offMap!.hookDoneS ?? 0 })),
    /** M11.2: "Take enemy kit" for the selected unit (the nearest known enemy casualty or prisoner); the source, or null. */
    takeKit: () => takeKit(a),
    /** M11.3 (screenshots, checks): "Resupply" for the selected unit; the supply point of the selected unit's platoon
     *  at (x, y); the caches on the map; set cache `id` off (a fire beside it); what the side knows of caches. */
    resupply: () => resupply(a),
    fetchAmmo: () => fetchAmmo(a),
    sendBearers: () => sendBearers(a),
    supplyPoint: (x: number, y: number) => issue(a, { ...to(), kind: "supplyPoint", x, y }),
    caches: () => [...sim.state.cache.entries()].map(([id, c]) => ({ id, side: c.side, kind: c.kind, x: sim.state.transform.req(id).x, y: sim.state.transform.req(id).y, stacks: sim.state.container.get(id)?.stacks.length ?? 0, burning: c.cookoff !== undefined, burnt: c.burnt === true, known: c.known ?? [], carried: c.carried === true })),
    igniteCache: (id: EntityId) => { const S = a.input.catalog.supply; const c = sim.state.cache.get(id); if (S && c) ignite(sim.ctx, sim.state, new EventSink(), S, id, c, "fire"); },
    /** M11.5 (screenshots): hull `vid`'s stowed ammunition put into a new own cache 8 m beside it with the fuel cans that
     *  fill its tank from 15 %; the cache id. */
    rearmScene: (vid: EntityId) => {
      const v = sim.state.vehicle.req(vid), cat = a.input.catalog, def = cat.vehicles[v.def]!, k = sim.state.container.req(vid), t = sim.state.transform.req(vid);
      const ammo = (type: string, ch: number | undefined) => { const d = cat.items[type]; return ch !== undefined ? d?.chargeItem !== undefined && cat.ammo[d.chargeItem] !== undefined : cat.ammo[type] !== undefined; };
      const load = k.stacks.filter((x) => ammo(x.type, x.charge)).map((x) => ({ ...x }));
      k.stacks = k.stacks.filter((x) => !ammo(x.type, x.charge));
      for (const x of k.stacks) if (x.type === def.fuel.item) x.charge = Math.floor(def.fuel.capacityL * 0.15);
      const kind = cat.items[def.fuel.item]?.chargeKind;
      const can = Object.values(cat.items).filter((d) => d.category === "fuel-can" && d.chargeKind === kind).sort((p, q) => Number(!p.id.startsWith(`${v.faction}-`)) - Number(!q.id.startsWith(`${v.faction}-`)) || (p.id < q.id ? -1 : 1))[0];
      if (can) load.push({ type: can.id, count: Math.ceil((def.fuel.capacityL * 0.85) / can.chargeCapacity!), charge: can.chargeCapacity! });
      return newCache(sim.state, v.side, t.x + 8 * Math.sin(t.heading), t.y - 8 * Math.cos(t.heading), load);
    },
    resupplyOf: (vid: EntityId) => sim.state.vehicle.get(vid)?.resupply ?? null,
    knowCache: (id: EntityId, side: string) => { const c = sim.state.cache.get(id); if (c && !(c.known ?? []).includes(side)) c.known = [...(c.known ?? []), side].sort(); },
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
    /** D3: frame times split by part (p50/p95/max over 5 s and the whole buffer) and the device; `true` resets after reading. */
    perf: (reset?: boolean) => perf?.(reset) ?? null,
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
    /** M11.9a (screenshots, checks): man `id` gives up now (as a panicked man would). */
    giveUp: (id: EntityId) => surrender(sim.ctx, sim.state, new EventSink(), id, "panicked"),
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
