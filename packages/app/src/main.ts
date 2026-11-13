/**
 * The browser app: wires data -> scenario -> simulation -> renderer + UI.
 *
 * Real time lives ONLY here. Each animation frame adds elapsed wall time to an accumulator and runs
 * as many fixed 1/60 s simulation steps as fit; the renderer interpolates between the last two.
 * Player input becomes ORDERS submitted to the simulation, exactly like an AI or a replay would.
 */
import { buildAppearance, formatErrors, lookOf, Strings, type Appearance } from "@tcs/data";
import { buildScenario, demoBattle, MAP_KINDS, vehicleBattle, type MapKind } from "@tcs/scenario";
import { commanderController, vehicleWanderController, wanderController } from "@tcs/ai";
import {
  battleScore, isOut, loadGame, rosterStatus, saveGame, supportLeft, type SaveGame,
  eyeHeightM, fuelLitres, heightAt, hullObb, pointInObb, sideKnowledge, sight,
  buildSpatialHash, createSim, DT, navFor, queryRadius, simHash, step, submitOrder, ticksToSeconds,
  tallyExpenditure, vehicleItems, atRuleOf, floorOf, indoorAt, unitSoldiers, standZ,
  type EntityId, type Expenditure, type Order, type Sim, type SimEvent,
} from "@tcs/sim";
import { BattleRenderer, CELL, FRAMES, OPENING_SCALE, SIDE_COLOURS, VehicleDebug, composeFrame, outlineMask, paletteFor, rotateFrame, worldToScreen, type FrameId, type GestureOverlay, type Overlay } from "@tcs/render";
import { createAar, createFloorSwitch, followFloor, unitFloor, type FloorFollow, ordersFor, paceToWaypoint, unitCapabilities, unitTiles, type AarModel, addPoint, attachInput, createHud, dragTo, hitHandle, markerGeometry, newPlan, planToOrder, slotSpan, undoPoint, type Handle, type OrderMode, type Plan, type PlanKind, type UnitRules,
  centreOf, facingHandleAt, inPlacePoint, losPreview, modeAfterOrder, onUnitAt, retargetMove, type Eye, type LosLine } from "@tcs/ui";
import { loadBundledData } from "./data";

const MAX_STEPS_PER_FRAME = 240; // never spiral: drop time instead

async function main(): Promise<void> {
  const hudRoot = document.getElementById("hud")!;
  const mapRoot = document.getElementById("map")!;
  const { data, errors } = loadBundledData();
  if (!data) {
    hudRoot.textContent = `Data failed to load:\n${formatErrors(errors)}`;
    return;
  }
  const strings = new Strings(data, "en");
  const params = new URLSearchParams(location.search);
  const seed = Number(params.get("seed") ?? 1) >>> 0;
  const factions = (params.get("factions") ?? "de,ru").split(",") as [string, string];
  const mapParam = params.get("map") ?? "village";
  const mapKind = (MAP_KINDS as readonly string[]).includes(mapParam) ? (mapParam as MapKind) : undefined;

  // M6 first playable: the generated platoon battle (?scenario=demo for the old one-squad sandbox).
  // ?side=blue|red picks your side, ?attacker=blue|red who attacks; the AI commands the other side.
  const scenario = params.get("scenario") ?? "platoon";
  const playerSide = params.get("side") === "red" ? "red" : "blue";
  const enemySide = playerSide === "blue" ? "red" : "blue";
  const attacker = params.get("attacker") === "red" ? "red" : "blue";
  // The platoon battle starts with its vehicles (attacker mounted) by default since M7.4a (owner Q26: vehicles
  // can now be knocked out and the Panzerfaust and RPG work); &vehicles=0 gives the battle on foot.
  const withVehicles = params.get("vehicles") !== "0";
  // ?scenario=vehicles (M7.1c): IFV platoons with their squads on foot; vehicles appear nowhere else yet.
  const input = scenario === "demo"
    ? demoBattle(data, { seed, factions, timeLimitSeconds: 3600, mapKind, mapSeed: seed })
    : scenario === "vehicles"
    ? vehicleBattle(data, { seed, factions, mapKind: mapKind ?? "farmland", timeLimitSeconds: Number(params.get("limit") ?? 2400) || 2400 })
    : buildScenario(data, { kind: "platoon-attack", seed, mapKind: mapKind ?? "village", factions, attacker, timeLimitSeconds: Number(params.get("limit") ?? 2400) || 2400, ...(withVehicles ? { vehicles: true } : {}) });
  const ai = scenario === "demo" ? [wanderController(enemySide, seed + 1000, input.map, 30)]
    : scenario === "vehicles" ? [vehicleWanderController(enemySide, seed + 1000, input.map, 60)]
    : [commanderController(enemySide, input)];
  // Load: the save is kept with the URL it was made under (the same URL rebuilds the same battle).
  const SAVE_KEY = "tcs.save";
  let sim: Sim = createSim(input);
  type AarRecord = { timeline: { tick: number; text: string; colour: string }[]; heatShots: number[]; heatFalls: number[]; exp?: Expenditure };
  let loadedRecord = null as AarRecord | null;
  let loadFailed = false;
  if (params.get("load") === "1") {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (raw) {
        const blob = JSON.parse(raw) as { save: SaveGame; record?: AarRecord };
        sim = loadGame(input, blob.save, ai);
        loadedRecord = blob.record ?? null;
      }
    } catch { loadFailed = true; sim = createSim(input); } // e.g. made with other data: a fresh battle, and we say so
  }
  const orderLog: Order[] = [];

  const renderer = await BattleRenderer.create(mapRoot);
  renderer.groundFloorLabel = strings.t("ui.floor.ground");
  // The look (M7.5b): the flat pixel map and pixel soldiers; `?look=classic` keeps the look before it.
  const look = params.get("look") === "classic" ? "classic" : "pixel";
  renderer.setLook(look);
  // How the factions look (M7.5a): outside the catalog, so it never touches the battle.
  renderer.setAppearance(buildAppearance(data, sim.state.sides.map((x) => x.faction)));
  renderer.setMap(input.map, input.catalog);
  // The battle opens with nothing selected (M7.5a): the order bar is greyed until a unit is picked.
  const overlay: Overlay = { playerSide, selectedUnit: null, debug: false };

  let speed = 1;
  let pace = "walk";
  /** Rules ordered for a unit and not yet in force there (shown as chosen meanwhile). */
  const pendingRules = new Map<EntityId, Partial<UnitRules>>();
  let orderMode: OrderMode = "move";
  /** Gun and round of the next fire order to a vehicle (M7.3; null = the crew chooses). */
  let nature: "ap" | "he" | "mg" | null = null;
  const vehicleDebug = new VehicleDebug();
  let plan: Plan | null = null;
  let dragHandle: Handle | null = null;
  /** Undefined until the player picks one: then the faction's doctrine default applies. */
  let formation: string | undefined;
  const kinds = [...MAP_KINDS, "flat"];
  const playerFaction = sim.state.sides.find((s) => s.id === playerSide)?.faction ?? "";
  const defaultFormation = input.catalog.factions[playerFaction]?.defaultFormation ?? Object.keys(input.catalog.formations)[0] ?? "";
  const doctrineSpacing = input.catalog.factions[playerFaction]?.doctrine["preferredSpacingM"] ?? 10;
  /** Able men of the selected unit, and where they are on average. */
  const unitMen = () => overlay.selectedUnit === null ? [] : unitSoldierIds(sim, overlay.selectedUnit).filter((m) => { const s = sim.state.soldier.get(m); return s !== undefined && !isOut(s); });
  const unitCentre = () => {
    const men = unitMen();
    if (men.length === 0) return { x: 0, y: 0 };
    let x = 0, y = 0;
    for (const m of men) { const p = sim.state.transform.req(m); x += p.x; y += p.y; }
    return { x: x / men.length, y: y / men.length };
  };
  const slotsOf = (f: string) => input.catalog.formations[f]?.slots ?? [[0, 0]];
  const startPlan = (kind: PlanKind) => {
    const f = formation ?? defaultFormation, n = Math.max(1, unitMen().length);
    plan = newPlan(kind, unitCentre(), f, Math.max(4, slotSpan(slotsOf(f), n) * doctrineSpacing));
    hud.setPlanning(kind);
  };
  const endPlan = () => { plan = null; dragHandle = null; hud.setPlanning(null); };
  /** Handles stay this far (on screen) from the marker's centre, so a finger can grab the marker itself. */
  const HANDLE_PX = 46;
  /** The formation marker (a move only: an assault or withdrawal ends spread round its point). */
  const markerFor = (p: Plan | null) => p && p.kind === "move" ? markerGeometry(p, slotsOf(p.formation), Math.max(1, unitMen().length), doctrineSpacing, HANDLE_PX / renderer.camera.scale) : null;
  const planMarker = () => markerFor(plan);
  let dragGapM = 3;
  const hud = createHud(hudRoot, strings, {
    formations: Object.keys(input.catalog.formations).sort(),
    defaultFormation,
    mapLabel: `${strings.t(`map.${mapKind ?? "flat"}`)} ${seed}`,
    onNextMap: () => {
      const next = kinds[(kinds.indexOf(mapKind ?? "flat") + 1) % kinds.length]!;
      const q = new URLSearchParams(location.search);
      q.set("map", next);
      location.search = q.toString();
    },
    onSpeed: (v) => { speed = v; },
    onOrderMode: (m) => { orderMode = m; gesture = null; if (plan && plan.kind !== m) endPlan(); },
    onHalt: () => { endPlan(); gesture = null; if (overlay.selectedUnit !== null) issue({ tick: sim.state.tick, issuer: playerSide, target: overlay.selectedUnit, kind: "halt" }); },
    onMount: () => { endPlan(); if (overlay.selectedUnit !== null) issue({ tick: sim.state.tick, issuer: playerSide, target: overlay.selectedUnit, kind: "mount" }); },
    onDismount: () => { endPlan(); if (overlay.selectedUnit !== null) issue({ tick: sim.state.tick, issuer: playerSide, target: overlay.selectedUnit, kind: "dismount" }); },
    // Vehicles (M7.3): smoke screen now; the gun and round of the next fire order.
    onDischarge: () => { endPlan(); if (overlay.selectedUnit !== null) issue({ tick: sim.state.tick, issuer: playerSide, target: overlay.selectedUnit, kind: "discharge" }); },
    onNature: (n) => { nature = n; },
    onCeaseFire: () => {
      if (overlay.selectedUnit !== null) issue({ tick: sim.state.tick, issuer: playerSide, target: overlay.selectedUnit, kind: "ceaseFire" });
    },
    onPace: (m) => { pace = m; },
    onFormation: (f) => {
      formation = f;
      if (plan) { const n = Math.max(1, unitMen().length); plan = { ...plan, formation: f, frontageM: Math.max(4, slotSpan(slotsOf(f), n) * doctrineSpacing) }; }
    },
    onUndo: () => { if (plan) plan = undoPoint(plan); },
    onGo: () => {
      if (plan && overlay.selectedUnit !== null) {
        const o = planToOrder(plan, playerSide, overlay.selectedUnit, sim.state.tick);
        if (o) issue(forUnit(o));
      }
      endPlan();
      orderMode = "move"; hud.setOrderMode("move");
    },
    onCancel: () => { endPlan(); orderMode = "move"; hud.setOrderMode("move"); },
    onRules: (r) => {
      if (overlay.selectedUnit === null) return;
      // Shown as ordered until the unit has it (radio delay; while paused it waits).
      pendingRules.set(overlay.selectedUnit, { ...(pendingRules.get(overlay.selectedUnit) ?? {}), ...r });
      issue({ tick: sim.state.tick, issuer: playerSide, target: overlay.selectedUnit, kind: "rules", ...(r.fire ? { fire: r.fire } : {}), ...(r.maxEngageM !== undefined ? { maxEngageM: r.maxEngageM } : {}), ...(r.onContact ? { onContact: r.onContact } : {}), ...(r.ammo ? { ammo: r.ammo } : {}), ...(r.at ? { at: r.at } : {}) });
    },
    onPosture: (p) => {
      if (overlay.selectedUnit !== null) issue({ tick: sim.state.tick, issuer: playerSide, target: overlay.selectedUnit, kind: "posture", posture: p });
    },
    onSave: () => {
      try {
        // The after-action record so far goes with the save (the timeline and heat map cover the whole battle).
        localStorage.setItem(SAVE_KEY, JSON.stringify({ url: location.search, save: saveGame(sim, ai), record: { timeline, heatShots, heatFalls, exp } }));
        hud.radio(strings.t("app.saved"), ticksToSeconds(sim.state.tick), "#d8e0c8");
      } catch { hud.radio(strings.t("app.saveFailed"), ticksToSeconds(sim.state.tick), "#ffb4b4"); }
    },
    onLoad: () => {
      let raw: string | null;
      try { raw = localStorage.getItem(SAVE_KEY); } catch { raw = null; }
      if (!raw) { hud.radio(strings.t("app.noSave"), ticksToSeconds(sim.state.tick), "#ffb4b4"); return; }
      const q = new URLSearchParams((JSON.parse(raw) as { url: string }).url);
      q.set("load", "1");
      location.search = q.toString();
    },
    onLayout: () => { renderer.setHudInsets(hud.insets()); },
    onSelectUnit: (u) => { endPlan(); gesture = null; overlay.selectedUnit = overlay.selectedUnit === u ? null : u; syncOrders(); refreshTiles(); },
    sideColour: `#${(SIDE_COLOURS[Math.max(0, sim.state.sides.findIndex((x) => x.id === playerSide))] ?? 0xffffff).toString(16).padStart(6, "0")}`,
    onDebug: (on) => {
      overlay.debug = on;
      // Debug view shows the navigation grid soldiers plan their routes on.
      // (A vehicle selected: its class's grid, with the clearance, M7.1c.)
      renderer.setNavOverlay(on ? navFor(sim.ctx, vehicleClassOf(overlay.selectedUnit) ?? "foot").grid : null);
      // ... and what the selected unit's leader can see (refreshed every 2 s of game time).
      renderer.setSightOverlay(on ? sightView() : null);
      sightAt = sim.state.tick;
    },
  });

  // Fit the map into the area not covered by the top bar, the order bar and the unit sidebar (M7.5a).
  const insets = hud.insets();
  renderer.setHudInsets(insets);
  // M7.5b (owner answer 1): the battle opens zoomed in on the player's lead unit (his first squad; its vehicle
  // while it rides), at true scale. The classic look keeps the old start: about 600 m across.
  // mounted: ok the start view centres on every own man, aboard or not
  const own = [...sim.state.identity.entries()].filter(([, i]) => i.side === playerSide).map(([id]) => sim.state.transform.req(id));
  const leadAt = (() => {
    const tiles = unitTiles(sim.state, playerSide, input.catalog);
    const lead = tiles.find((t) => t.kind === "infantry") ?? tiles[0];
    if (!lead) return null;
    let x = 0, y = 0, n = 0;
    for (const m of unitSoldierIds(sim, lead.unit)) {
      const s = sim.state.soldier.get(m);
      const t = s?.mount !== undefined ? sim.state.transform.get(s.mount.vehicle) : sim.state.transform.get(m);
      if (t) { x += t.x; y += t.y; n++; }
    }
    if (n === 0) { const v = sim.state.unit.get(lead.unit)?.vehicle; const t = v === undefined ? undefined : sim.state.transform.get(v); return t ? { x: t.x, y: t.y } : null; }
    return { x: x / n, y: y / n };
  })();
  if (look === "pixel" && leadAt) {
    renderer.focusScale(leadAt.x, leadAt.y, OPENING_SCALE, insets);
    renderer.primeDetail();
  } else if (own.length > 0 && input.map.widthM > 600) {
    const ox = own.reduce((a, t) => a + t.x, 0) / own.length, oy = own.reduce((a, t) => a + t.y, 0) / own.length;
    // Look from the team toward the map centre, 600 m across.
    renderer.focus(ox + 0.4 * (input.map.widthM / 2 - ox), oy + 0.4 * (input.map.heightM / 2 - oy), 600, insets);
  } else {
    renderer.fitToMap(input.map, insets);
  }

  /** The order bar for the selected unit: a vehicle crew has its own orders and paces (M7.1c). */
  let ordersShownFor: EntityId | null | undefined;
  const vehicleClassOf = (uid: EntityId | null) => {
    const vid = uid === null ? undefined : sim.state.unit.get(uid)?.vehicle;
    const v = vid === undefined ? undefined : sim.state.vehicle.get(vid);
    return v ? input.catalog.vehicles[v.def]?.class ?? null : null;
  };
  /**
   * The order bar shows only what the selected unit can do now (M7.5a): its capabilities are read from the state
   * (checked every frame, cheap; the bar is rebuilt only when they change). Nothing selected: greyed.
   */
  let ordersKey = "";
  const syncOrders = () => {
    const cap = unitCapabilities(sim.state, input.catalog, overlay.selectedUnit);
    const key = `${overlay.selectedUnit}|${cap.kind}|${cap.hasLauncherRounds}|${cap.handGrenades + cap.rifleGrenades > 0}|${cap.handGrenades + cap.rifleGrenades > 1}|${cap.supportHe > 0}|${cap.supportSmoke > 0}|${cap.canMount}|${cap.canDismount}|${cap.hasSmokeDischargers}|${cap.natures.join()}`;
    if (ordersShownFor === overlay.selectedUnit && key === ordersKey) return;
    const changedUnit = ordersShownFor !== undefined && ordersShownFor !== overlay.selectedUnit;
    ordersShownFor = overlay.selectedUnit; ordersKey = key;
    const set = ordersFor(cap, input.catalog.movementModes);
    hud.setOrders(set);
    // The order mode on show must be one the unit has (a squad without grenades: back to Move); a new unit
    // starts with Move.
    if ((changedUnit && orderMode !== "move") || !set.modes.includes(orderMode)) { orderMode = "move"; hud.setOrderMode("move"); }
    if (changedUnit && plan) endPlan();
    if (overlay.debug) renderer.setNavOverlay(navFor(sim.ctx, vehicleClassOf(overlay.selectedUnit) ?? "foot").grid);
  };
  /** The unit sidebar (M7.5a): refreshed about four times a second and on every selection. */
  let tilesAt = -1e9;
  const refreshTiles = () => { hud.setTiles(unitTiles(sim.state, playerSide, input.catalog), overlay.selectedUnit); };
  /** A planned move for a vehicle: "reverse" legs drive the slowest pace backwards; no formation. */
  const forUnit = (o: Order): Order => {
    const cls = vehicleClassOf(o.target);
    if (cls === null || o.kind !== "move") return o;
    const set = ordersFor(cls, input.catalog.movementModes);
    return { tick: o.tick, issuer: o.issuer, target: o.target, kind: "move", waypoints: o.waypoints.map((w) => ({ x: w.x, y: w.y, ...paceToWaypoint(w.mode, set) })), ...(o.facing !== undefined ? { facing: o.facing } : {}) };
  };
  const issue = (order: Order) => {
    // The player's own order (a vehicle holds a move or halt against close enemy men, owner 2026-11-13).
    order = { ...order, player: true };
    // A move into a building goes to the floor on screen (M7.5d floor switch).
    if (order.kind === "move" && order.floor === undefined && floorState.shown > 0) {
      const last = order.waypoints[order.waypoints.length - 1];
      const bi = last ? indoorAt(sim.ctx, last.x, last.y) : -1;
      if (bi >= 0) order = { ...order, floor: Math.min(floorState.shown, input.map.buildings[bi]!.storeys - 1) };
    }
    orderLog.push(order);
    submitOrder(sim, order);
    // The last move sent to a unit (its marker can be dragged, S10); any other movement order ends it.
    if (order.issuer !== playerSide) { /* the AI's orders */ } else if (order.kind === "move") activeMoves.set(order.target, order);
    else if (order.kind === "halt" || order.kind === "assault" || order.kind === "withdraw" || order.kind === "occupy" || order.kind === "mount" || order.kind === "dismount") activeMoves.delete(order.target);
  };

  // ---- order gestures on the map (the "controls" step, owner choices S1, S2, S9, S10, S12)
  type MoveOrder = Extract<Order, { kind: "move" }>;
  const activeMoves = new Map<EntityId, MoveOrder>();
  type Pt = { x: number; y: number };
  type Gesture =
    | { kind: "plan" }
    /** S1: dragging out from the selected unit; `plan` is the ghost (null while the pointer is still on the unit). */
    | { kind: "fromUnit"; planKind: PlanKind; plan: Plan | null; from: Pt; left: boolean }
    /** S10: an active move's marker; `onUnit`: dropped now it would halt. */
    | { kind: "marker"; prev: MoveOrder; at: Pt; from: Pt; onUnit: boolean }
    /** S9: the facing handle; `angle` null until it was turned. */
    | { kind: "facing"; centre: Pt; angle: number | null; start: number; dist: number }
    /** S2: a fire order held; `onUnit`: back on the unit (release cancels). */
    | { kind: "fire"; at: Pt; onUnit: boolean; los: LosLine[] };
  let gesture: Gesture | null = null;
  /** The selected unit's men on foot and the hulls it is in or crews (alive men only). */
  const unitPlaces = (uid: EntityId | null): { men: Pt[]; hulls: EntityId[] } => {
    const men: Pt[] = [], hulls: EntityId[] = [];
    if (uid === null) return { men, hulls };
    const own = sim.state.unit.get(uid)?.vehicle;
    if (own !== undefined && sim.state.vehicle.has(own)) hulls.push(own);
    for (const m of unitSoldierIds(sim, uid)) {
      const s = sim.state.soldier.get(m);
      if (!s || isOut(s)) continue;
      if (s.mount !== undefined) { if (!hulls.includes(s.mount.vehicle)) hulls.push(s.mount.vehicle); continue; }
      const t = sim.state.transform.get(m);
      if (t) men.push({ x: t.x, y: t.y });
    }
    return { men, hulls };
  };
  const placesOf = (uid: EntityId | null): Pt[] => {
    const { men, hulls } = unitPlaces(uid);
    return [...men, ...hulls.map((h) => sim.state.transform.get(h)).filter((t) => t !== undefined).map((t) => ({ x: t.x, y: t.y }))];
  };
  /** Is the world point on the selected unit (one of its men, or a hull it is in)? */
  const onSelected = (w: Pt): boolean => {
    const { men, hulls } = unitPlaces(overlay.selectedUnit);
    const tol = 16 / renderer.camera.scale + 0.8;
    if (onUnitAt(men, w.x, w.y, tol)) return true;
    for (const h of hulls) {
      const v = sim.state.vehicle.get(h), t = sim.state.transform.get(h), def = v ? input.catalog.vehicles[v.def] : undefined;
      if (def && t && pointInObb(hullObb(def, t.x, t.y, t.heading), w.x, w.y, tol)) return true;
    }
    return false;
  };
  /** The move a unit is carrying out (or that is on its way to it), if the player sent it. */
  const activeMoveOf = (uid: EntityId | null): MoveOrder | null => {
    if (uid === null) return null;
    const o = activeMoves.get(uid);
    if (!o) return null;
    const u = sim.state.unit.get(uid);
    const waiting = sim.state.inbox.some((p) => p.order.target === uid && p.order.kind === "move") || sim.state.pendingOrders.some((p) => p.order.target === uid && p.order.kind === "move");
    if (!u || (!u.moving && !waiting)) { activeMoves.delete(uid); return null; }
    return o;
  };
  /** S9: the facing handle of the selected unit while it stands (on foot outdoors, or a crewed hull); null else. */
  const facingHandle = (): { centre: Pt; handle: Pt; facing: number } | null => {
    const uid = overlay.selectedUnit;
    const u = uid === null ? undefined : sim.state.unit.get(uid);
    if (!u || uid === null || plan || u.moving || u.drill || u.boarding || u.broken || activeMoveOf(uid)) return null;
    if (orderMode !== "move" && orderMode !== "assault" && orderMode !== "withdraw") return null;
    const { men, hulls } = unitPlaces(uid);
    const scale = renderer.camera.scale;
    if (u.vehicle !== undefined) {
      const t = sim.state.transform.get(u.vehicle), v = sim.state.vehicle.get(u.vehicle);
      if (!t || !v || v.status !== "ok") return null;
      const c = { x: t.x, y: t.y };
      return { centre: c, facing: t.heading, handle: facingHandleAt(c, [], t.heading, 30 / scale, 4) };
    }
    if (men.length === 0 || hulls.length > 0) return null; // riding: the vehicle turns, not the squad
    for (const m of men) if (indoorAt(sim.ctx, m.x, m.y) >= 0) return null; // indoors: Occupy faces the windows
    const c = centreOf(men)!;
    const lead = u.leader !== null ? sim.state.transform.get(u.leader) : undefined;
    const facing = lead?.heading ?? 0;
    return { centre: c, facing, handle: facingHandleAt(c, men, facing, 30 / scale) };
  };
  /** A plan for the selected unit from `from` to `to` (the ghost of S1 and S9). */
  const ghostPlan = (kind: PlanKind, from: Pt, to: Pt, facing: number | null): Plan => {
    const f = formation ?? defaultFormation, n = Math.max(1, unitMen().length);
    const p = addPoint(newPlan(kind, from, f, Math.max(4, slotSpan(slotsOf(f), n) * doctrineSpacing)), to.x, to.y, pace);
    return facing === null ? p : { ...p, facing };
  };
  /** S9: the move that turns the unit where it stands (a vehicle: to its own spot; men: their middle stays). */
  const turnPlan = (c: Pt, angle: number): Plan => {
    if (vehicleClassOf(overlay.selectedUnit) !== null) return ghostPlan("move", c, c, angle);
    const g = markerFor(ghostPlan("move", c, c, angle));
    const p = g ? inPlacePoint(c, g.men) : c;
    return ghostPlan("move", c, p, angle);
  };
  /** After a one-tap order: back to Move unless the mode is locked on (S12). */
  const oneTapDone = () => {
    const next = modeAfterOrder(orderMode, hud.modeLocked());
    if (next !== orderMode) { orderMode = next; hud.setOrderMode(next); }
  };
  const inMap = (w: Pt) => w.x >= 0 && w.y >= 0 && w.x <= input.map.widthM && w.y <= input.map.heightM;
  /** Fire (or anti-tank) at a point for the selected unit: at the contact marker under it, if any (M5). */
  const fireAtPoint = (w: Pt) => {
    if (overlay.selectedUnit === null) return;
    // A tap on (or near) an enemy marker fires at that contact: the men aim where they believe he is.
    // (Only a tap on the marker itself: a tap anywhere else is fire at that point.)
    // mounted: ok sideKnowledge never lists men aboard
    const known = sideKnowledge(sim.ctx, sim.state, playerSide);
    const hits = known
      .map((k) => ({ k, d: Math.hypot(k.x - w.x, k.y - w.y) }))
      .filter(({ d }) => d <= 20 / renderer.scale())
      .sort((a, b) => a.d - b.d);
    const near = hits.find((h) => !h.k.surrendered);
    // A tap on an enemy your men know has surrendered: no order (fire at that point would hit him).
    if (!near && hits.length > 0) { hud.radio(strings.t("order.surrenderedTarget"), ticksToSeconds(sim.state.tick), "#ffb4b4"); return; }
    // (A vehicle crew: with the gun and round chosen, else the crew's choice, M7.3.)
    // (Anti-tank, M7.4a: the best-placed man with a Panzerfaust or RPG fires one round at it.)
    const nat = orderMode === "antitank" ? { nature: "at" as const } : vehicleClassOf(overlay.selectedUnit) !== null && nature !== null ? { nature } : {};
    if (near) issue({ tick: sim.state.tick, issuer: playerSide, target: overlay.selectedUnit, kind: "fire", x: near.k.x, y: near.k.y, contact: near.k.target, ...nat });
    else issue({ tick: sim.state.tick, issuer: playerSide, target: overlay.selectedUnit, kind: "fire", x: w.x, y: w.y, ...nat });
    oneTapDone();
  };
  /** S2: the sight lines from the selected unit's men (or its hull's sights) to the point: terrain, walls, roofs,
   *  woods and hulls the side knows — never an enemy it has not found. */
  const losTo = (w: Pt): LosLine[] => {
    const uid = overlay.selectedUnit;
    if (uid === null) return [];
    const eyes: Eye[] = [];
    const hulls = new Set<EntityId>();
    const own = sim.state.unit.get(uid)?.vehicle;
    if (own !== undefined) hulls.add(own);
    for (const m of unitSoldierIds(sim, uid)) {
      const s = sim.state.soldier.get(m), t = sim.state.transform.get(m);
      if (!s || !t || isOut(s) || s.physiology.consciousness < 0.5) continue;
      if (s.mount !== undefined) { hulls.add(s.mount.vehicle); continue; }
      eyes.push({ x: t.x, y: t.y, z: standZ(input.map, t) + eyeHeightM(sim.ctx, s.posture), ignore: -1 });
    }
    // A hull's sights: about 2.3 m above the ground (a low-confidence stand-in for its gunner's sight).
    for (const h of hulls) { const t = sim.state.transform.get(h); if (t) eyes.push({ x: t.x, y: t.y, z: heightAt(input.map, t.x, t.y) + 2.3, ignore: h }); }
    const knownHulls = new Set((overlay.known ?? []).filter((k) => k.cls === "vehicle").map((k) => k.target));
    const unknownHull = (x: number, y: number): number => {
      let best = -1, bd = 7 * 7;
      for (const [vid, v] of sim.state.vehicle.entries()) {
        const t = sim.state.transform.get(vid);
        if (!t) continue;
        const d = (t.x - x) ** 2 + (t.y - y) ** 2;
        if (d < bd) { bd = d; best = v.side !== playerSide && !knownHulls.has(vid) ? vid : -1; }
      }
      return best;
    };
    return losPreview(sim.ctx, eyes, w.x, w.y, heightAt(input.map, w.x, w.y) + 0.75, unknownHull);
  };

  /** An occupy order for building index `bi`: facing the nearest enemy the side knows, on the floor shown first. */
  const occupyOrder = (target: EntityId, bi: number): Order => {
    const b = input.map.buildings[bi]!;
    let cx = 0, cy = 0;
    const n = b.footprint.length / 2;
    for (let k = 0; k < n; k++) { cx += b.footprint[k * 2]!; cy += b.footprint[k * 2 + 1]!; }
    cx /= n; cy /= n;
    // mounted: ok sideKnowledge never lists men aboard
    const known = sideKnowledge(sim.ctx, sim.state, playerSide);
    let best: { x: number; y: number } | null = null, bd = Infinity;
    for (const k of known) { const d = Math.hypot(k.x - cx, k.y - cy); if (!k.surrendered && d < bd) { bd = d; best = k; } }
    return {
      tick: sim.state.tick, issuer: playerSide, target, kind: "occupy", building: b.id,
      ...(floorState.shown > 0 ? { floor: Math.min(floorState.shown, b.storeys - 1) } : {}),
      ...(best ? { facing: Math.atan2(best.y - cy, best.x - cx) } : {}),
    };
  };

  // ---- floor switch (M7.5d): follows the selected unit's floor; shown when it is indoors or a house is opened up.
  let floorState: FloorFollow = { shown: 0, unit: null, unitFloor: null, manual: false };
  let floorPick: number | null = null;
  const floorSwitch = createFloorSwitch(hudRoot, strings.t("ui.floor"), strings.t("ui.floor.ground"), (f) => { floorPick = f; });
  const updateFloors = () => {
    const uid = overlay.selectedUnit;
    let fl: number | null = null, count = 1;
    if (uid !== null && sim.state.unit.has(uid)) {
      const floors: number[] = [];
      for (const m of unitSoldiers(sim.state, uid)) {
        const ms = sim.state.soldier.get(m), t = sim.state.transform.get(m);
        if (!ms || !t || ms.mount !== undefined || !ms.physiology.alive) continue;
        const bi = indoorAt(sim.ctx, t.x, t.y);
        if (bi < 0) { floors.push(-1); continue; }
        floors.push(floorOf(sim.ctx, t.x, t.y, t.z));
        count = Math.max(count, input.map.buildings[bi]!.storeys);
      }
      fl = unitFloor(floors);
    }
    // Zoomed in close (roofs lifted): the tallest building with an interior in view.
    const cam = renderer.camera;
    if ((renderer.zoomLevel() ?? 0) >= 3) {
      const hw = renderer.app.screen.width / cam.scale / 2, hh = renderer.app.screen.height / cam.scale / 2;
      for (const b of input.map.buildings) {
        if (!b.interior || b.storeys <= count) continue;
        const x = b.footprint[0]!, y = b.footprint[1]!;
        if (Math.abs(x - cam.x) < hw + 20 && Math.abs(y - cam.y) < hh + 20) count = b.storeys;
      }
    }
    floorState = followFloor(floorState, uid, fl, floorPick, count - 1);
    floorPick = null;
    floorSwitch.set(count, floorState.shown);
    overlay.floor = count > 1 ? floorState.shown : 0;
  };

  attachInput(mapRoot, {
    getCamera: () => renderer.camera,
    // Never further out than the whole map in the free area (M7.5b).
    setCamera: (c) => { renderer.camera = renderer.clampCamera(c, hud.insets()); },
    onTap: (w) => {
      // Tap on one of your men: select his top-level unit. Elsewhere: plan or order for the selected unit.
      // Only own men can be selected (and hidden enemies must not stand in the way of a tap).
      // A tap on one of your vehicles selects its crew unit (M7.1c).
      // Tapping it again goes through the units riding in it, then back to its crew (M7.2).
      const hull = !plan ? vehicleAt(sim, w.x, w.y, 10 / renderer.camera.scale, playerSide) : null;
      if (hull !== null) {
        const cycle = [hull, ...ridersIn(sim, hull)];
        const k = overlay.selectedUnit === null ? -1 : cycle.indexOf(overlay.selectedUnit);
        overlay.selectedUnit = cycle[(k + 1) % cycle.length]!;
        refreshTiles();
        return;
      }
      const hit = nearestSoldier(sim, w.x, w.y, 12 / renderer.camera.scale + 1, overlay.debug ? null : playerSide);
      if (hit !== null && sim.state.identity.req(hit).side === playerSide && !plan) {
        // His own unit (his squad; the platoon's own men select the platoon).
        overlay.selectedUnit = sim.state.identity.req(hit).unit;
        refreshTiles();
        return;
      }
      if (overlay.selectedUnit === null) return;
      if (w.x < 0 || w.y < 0 || w.x > input.map.widthM || w.y > input.map.heightM) return;
      if (orderMode === "grenade" || orderMode === "grenades") {
        // "All grenades": every man who can reach the point throws or fires, a moment apart.
        issue({ tick: sim.state.tick, issuer: playerSide, target: overlay.selectedUnit, kind: "grenade", x: w.x, y: w.y, ...(orderMode === "grenades" ? { count: 50 } : {}) });
        oneTapDone();
        return;
      }
      if (orderMode === "occupy") {
        // Occupy (M7.5d): the tapped building's windows, those facing the nearest enemy the side knows first.
        const bi = indoorAt(sim.ctx, w.x, w.y);
        if (bi < 0) { hud.radio(strings.t("plan.tapBuilding"), ticksToSeconds(sim.state.tick), "#ffb4b4"); return; }
        issue(occupyOrder(overlay.selectedUnit, bi));
        oneTapDone();
        return;
      }
      if (orderMode === "mortar" || orderMode === "smoke") {
        // Mortar fire (M6.5c): the unit's leader calls it; it lands after a minute or more.
        issue({ tick: sim.state.tick, issuer: playerSide, target: overlay.selectedUnit, kind: "callFire", x: w.x, y: w.y, ammo: orderMode === "mortar" ? "he" : "smoke", rounds: orderMode === "mortar" ? 4 : 2 });
        oneTapDone();
        return;
      }
      if (orderMode === "fire" || orderMode === "antitank") { fireAtPoint(w); return; }
      // Move / assault / withdraw: each tap adds a point to the plan; Go sends it.
      if (!plan) startPlan(orderMode);
      plan = addPoint(plan!, w.x, w.y, pace);
    },
    // Gestures (the "controls" step): a plan's handles first; then, with a unit selected, in Fire mode a held
    // press anywhere (S2); in Move / Assault / Withdraw the facing handle (S9), the active move's marker (S10) or
    // the unit itself (S1). Anything else pans the map as before.
    onDragStart: (w) => {
      gesture = null;
      if (plan) {
        const g = planMarker();
        dragHandle = hitHandle(plan, g, w.x, w.y, 22 / renderer.camera.scale + 1);
        dragGapM = g?.resizeGapM ?? 3;
        if (dragHandle !== null) gesture = { kind: "plan" };
        return dragHandle !== null;
      }
      const uid = overlay.selectedUnit;
      if (uid === null || !sim.state.unit.has(uid)) return false;
      if (orderMode === "fire" || orderMode === "antitank") {
        if (!inMap(w)) return false;
        const on = onSelected(w);
        gesture = { kind: "fire", at: { ...w }, onUnit: on, los: on ? [] : losTo(w) };
        return true;
      }
      if (orderMode !== "move" && orderMode !== "assault" && orderMode !== "withdraw") return false;
      const tolM = 22 / renderer.camera.scale + 1;
      const fh = facingHandle();
      if (fh && Math.hypot(fh.handle.x - w.x, fh.handle.y - w.y) <= tolM) { gesture = { kind: "facing", centre: fh.centre, angle: null, start: fh.facing, dist: Math.hypot(fh.handle.x - fh.centre.x, fh.handle.y - fh.centre.y) }; return true; }
      const mv = activeMoveOf(uid);
      const end = mv?.waypoints[mv.waypoints.length - 1];
      if (mv && end && Math.hypot(end.x - w.x, end.y - w.y) <= tolM) {
        gesture = { kind: "marker", prev: mv, at: { x: end.x, y: end.y }, from: centreOf(placesOf(uid)) ?? { x: end.x, y: end.y }, onUnit: false };
        return true;
      }
      if (onSelected(w)) { gesture = { kind: "fromUnit", planKind: orderMode, plan: null, from: centreOf(placesOf(uid)) ?? { ...w }, left: false }; return true; }
      return false;
    },
    onDrag: (w) => {
      const gs = gesture;
      if (!gs) return;
      if (gs.kind === "plan") { if (plan && dragHandle !== null) plan = dragTo(plan, dragHandle, w.x, w.y, { minFrontageM: 2, maxFrontageM: 200, resizeGapM: dragGapM }); return; }
      if (gs.kind === "fire") { gs.at = { ...w }; gs.onUnit = onSelected(w); gs.los = gs.onUnit || !inMap(w) ? [] : losTo(w); return; }
      if (gs.kind === "facing") { if (Math.hypot(w.x - gs.centre.x, w.y - gs.centre.y) > 0.5) gs.angle = Math.atan2(w.y - gs.centre.y, w.x - gs.centre.x); return; }
      if (gs.kind === "marker") { gs.at = { ...w }; gs.onUnit = onSelected(w); return; }
      // From the unit: the ghost marker appears once the pointer has left the unit.
      gs.plan = onSelected(w) || !inMap(w) ? null : ghostPlan(gs.planKind, gs.from, w, null);
      if (gs.plan) gs.left = true;
    },
    onDragEnd: (how) => {
      const gs = gesture;
      gesture = null;
      dragHandle = null;
      const uid = overlay.selectedUnit;
      if (!gs || gs.kind === "plan" || how === "cancel" || uid === null) return false;
      // Released without moving: a tap as before (a press on the unit still selects it, in Fire mode it fires); only
      // a tap on the facing handle does nothing.
      if (how === "tap") return gs.kind !== "facing";
      if (gs.kind === "fire") { if (!gs.onUnit && inMap(gs.at)) fireAtPoint(gs.at); return false; }
      if (gs.kind === "facing") {
        if (gs.angle === null) return false;
        const o = planToOrder(turnPlan(gs.centre, gs.angle), playerSide, uid, sim.state.tick);
        if (o) issue(forUnit(o));
        activeMoves.delete(uid); // a turn on the spot has no marker to drag

        return false;
      }
      if (gs.kind === "marker") {
        if (gs.onUnit) { issue({ tick: sim.state.tick, issuer: playerSide, target: uid, kind: "halt" }); return false; }
        if (!inMap(gs.at)) return false;
        issue(forUnit(retargetMove(gs.prev, gs.at, centreOf(placesOf(uid)) ?? gs.from, sim.state.tick)));
        return false;
      }
      if (!gs.plan) return false; // let go on the unit (or off the map): nothing is sent
      const o = planToOrder(gs.plan, playerSide, uid, sim.state.tick);
      if (o) issue(forUnit(o));
      if (gs.planKind !== "move") oneTapDone();
      return false;
    },
  });

  const sideColour = (side: string) => {
    const i = sim.state.sides.findIndex((s) => s.id === side);
    return `#${(SIDE_COLOURS[i] ?? 0xffffff).toString(16).padStart(6, "0")}`;
  };
  // ---- After-action record (M6): built from the events as they come (UI consumes events, rule 5).
  const sideIdx = (side: string) => Math.max(0, sim.state.sides.findIndex((x) => x.id === side));
  const sideName = (side: string) => { const f = sim.state.sides.find((x) => x.id === side)?.faction ?? ""; return strings.t(`faction.${f}`, {}, f); };
  const heatShots: number[] = [...(loadedRecord?.heatShots ?? [])], heatFalls: number[] = [...(loadedRecord?.heatFalls ?? [])];
  const timeline: { tick: number; text: string; colour: string }[] = [...(loadedRecord?.timeline ?? [])];
  // Ammunition used per side (M7.3): vehicle rounds credited to the vehicle, from the events.
  const exp: Expenditure = loadedRecord?.exp ?? {};
  if (loadFailed) hud.radio(strings.t("app.loadFailed"), 0, "#ffb4b4");
  const callsignOf = (id: EntityId) => sim.state.unit.get(sim.state.identity.get(id)?.unit ?? -1)?.callsign ?? "";
  let aarShown = false;
  const objName = (id: string) => { const o = input.rules.objectives.find((x) => x.id === id); return o ? strings.t(o.nameKey) : id; };
  const handleEvents = (events: SimEvent[]) => {
    renderer.onEvents(events, sim.state, overlay);
    vehicleDebug.onEvents(events);
    tallyExpenditure(exp, events, sim.state, input.catalog);
    for (const e of events) {
      if (e.kind === "shot.fired") { if (heatShots.length < 300000) heatShots.push(e.x, e.y, sideIdx(sim.state.identity.get(e.shooter)?.side ?? "")); continue; }
      if (e.kind === "casualty") {
        const t = sim.state.transform.get(e.soldier), id = sim.state.identity.get(e.soldier);
        if (t && id) {
          heatFalls.push(t.x, t.y, sideIdx(id.side));
          timeline.push({ tick: e.tick, colour: sideColour(id.side), text: strings.t("timeline.casualty", { side: sideName(id.side), name: id.family, callsign: callsignOf(e.soldier), status: strings.t(`status.${e.status}`) }) });
        }
      } else if (e.kind === "surrendered" || e.kind === "captured") {
        const id = sim.state.identity.get(e.soldier);
        if (id) timeline.push({ tick: e.tick, colour: sideColour(id.side), text: strings.t(`timeline.${e.kind}`, { side: sideName(id.side), name: id.family, callsign: callsignOf(e.soldier) }) });
      } else if (e.kind === "objective.changed" && e.holder !== null) {
        timeline.push({ tick: e.tick, colour: sideColour(e.holder), text: strings.t("timeline.objective", { objective: objName(e.objective), side: sideName(e.holder) }) });
      } else if (e.kind === "radio" && (e.key === "radio.broken" || e.key === "radio.rallied" || e.key === "radio.objectiveTaken")) {
        const k = e.key === "radio.broken" ? "timeline.broken" : e.key === "radio.rallied" ? "timeline.rallied" : "timeline.taken";
        timeline.push({ tick: e.tick, colour: sideColour(e.side), text: strings.t(k, { side: sideName(e.side), callsign: String(e.params["callsign"] ?? "") }) });
      } else if ((e.kind === "vehicle.hit" && e.result === "penetrated") || e.kind === "vehicle.status" || e.kind === "vehicle.fire" || e.kind === "vehicle.destroyed" || e.kind === "vehicle.abandoned" || e.kind === "vehicle.extinguished" || (e.kind === "vehicle.reaction" && e.reaction === "reverseOut")) {
        // Vehicles hit, immobilised, burning, destroyed, abandoned (M7.4a); wrecks go on the heat map.
        const v = sim.state.vehicle.get(e.vehicle);
        if (v) {
          // (Its crew's callsign, remembered: a crew that bailed out no longer belongs to the hull, M7.4b.)
          const name = v.unit !== null ? sim.state.unit.get(v.unit)?.callsign ?? v.vehicleId : [...sim.state.unit.values()].find((x) => x.exVehicle === e.vehicle)?.callsign ?? v.vehicleId;
          const key = e.kind === "vehicle.hit" ? "aar.vehicle.hit" : e.kind === "vehicle.status" ? `aar.vehicle.${e.status}` : e.kind === "vehicle.fire" ? "aar.vehicle.fire" : e.kind === "vehicle.destroyed" ? "aar.vehicle.destroyed" : e.kind === "vehicle.extinguished" ? "aar.vehicle.extinguished" : e.kind === "vehicle.reaction" ? "aar.vehicle.reversedOut" : "aar.vehicle.abandoned";
          timeline.push({ tick: e.tick, colour: sideColour(v.side), text: strings.t(key, { vehicle: `${sideName(v.side)} ${name}` }) });
          const t = sim.state.transform.get(e.vehicle);
          if (t && (e.kind === "vehicle.destroyed" || e.kind === "vehicle.abandoned")) heatFalls.push(t.x, t.y, sideIdx(v.side));
        }
      } else if (e.kind === "battle.ended") {
        timeline.push({ tick: e.tick, colour: "#ffd23d", text: strings.t("timeline.ended", { reason: strings.t(`aar.reason.${e.reason}`, { loser: e.loser ? sideName(e.loser) : "" }) }) });
      }
      if (e.kind === "radio" && e.side === playerSide) {
        const faction = sim.state.identity.get(e.from)?.faction;
        hud.radio(strings.t(e.key, e.params, faction), ticksToSeconds(e.tick), sideColour(e.side));
      } else if (e.kind === "order.rejected" && e.issuer === playerSide) {
        hud.radio(strings.t("order.rejected", { reason: e.reason }), ticksToSeconds(e.tick), "#ffb4b4");
      }
    }
  };

  /** Advance the simulation by one tick: AI thinks, renderer remembers positions, step, events out. */
  /** Debug: what the selected unit's leader can see of a kneeling man, within 400 m, every 10 m. */
  const sightView = () => {
    const uid = overlay.selectedUnit;
    const u = uid === null ? undefined : sim.state.unit.get(uid);
    // The leader, or the first of the unit's men who is alive and conscious.
    const able = (id: EntityId) => { const x = sim.state.soldier.get(id); return x !== undefined && x.physiology.alive && x.physiology.consciousness >= 0.5; };
    const leader = u?.leader ?? u?.members.find(able);
    const t = leader === undefined ? undefined : sim.state.transform.get(leader);
    const s = leader === undefined ? undefined : sim.state.soldier.get(leader);
    if (!t || !s) return null;
    const R = 400, cellM = 10, n = (2 * R) / cellM;
    const x0 = t.x - R, y0 = t.y - R;
    const ez = heightAt(input.map, t.x, t.y) + eyeHeightM(sim.ctx, s.posture);
    const vis = new Uint8Array(n * n).fill(255); // beyond the radius: not tinted (not looked at)
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      const x = x0 + (c + 0.5) * cellM, y = y0 + (r + 0.5) * cellM;
      if (x < 0 || y < 0 || x >= input.map.widthM || y >= input.map.heightM || (x - t.x) ** 2 + (y - t.y) ** 2 > R * R) continue;
      const v = sight(sim.ctx, t.x, t.y, ez, x, y, heightAt(input.map, x, y) + 0.75).visibility;
      vis[r * n + c] = Math.max(0, Math.min(255, Math.round(v * 255)));
    }
    return { vis, cols: n, rows: n, cellM, x0, y0 };
  };
  let knownTick = -1;
  let sightAt = -1, sightFor: EntityId | null = null, sightReal = -1e9;
  const stepOnce = () => {
    for (const c of ai) for (const o of c.think(sim.state, sim.state.tick)) issue(o);
    renderer.capturePrevious(sim.state);
    handleEvents(step(sim));
  };

  // Hook for the headless screenshot script and for debugging in the browser console. The battle opens with nothing
  // selected (M7.5a): an order through the hook with nothing selected goes to (and selects) the first own unit.
  const sel = (): EntityId => {
    if (overlay.selectedUnit === null) { overlay.selectedUnit = [...sim.state.unit.entries()].find(([, u]) => u.side === playerSide && u.parent === null)?.[0] ?? null; syncOrders(); }
    return overlay.selectedUnit as EntityId;
  };
  (window as unknown as { __tcs: unknown }).__tcs = {
    sim,
    orderLog,
    stepTicks: (n: number) => { for (let i = 0; i < n; i++) stepOnce(); },
    grenadeAt: (x: number, y: number, count = 1) => issue({ tick: sim.state.tick, issuer: playerSide, target: sel(), kind: "grenade", x, y, count }),
    /** M7.5d: occupy the building at (x, y) with the selected unit; the floor switch; the floor shown. */
    occupyAt: (x: number, y: number) => { const bi = indoorAt(sim.ctx, x, y); if (bi >= 0) issue(occupyOrder(sel(), bi)); },
    setFloor: (f: number) => { floorPick = f; },
    floorShown: () => floorState.shown,
    fireAt: (x: number, y: number) => issue({ tick: sim.state.tick, issuer: playerSide, target: sel(), kind: "fire", x, y }),
    /** Plan a move through these points (screenshots): the marker is shown until go(). */
    planMove: (pts: { x: number; y: number; mode?: string }[], facing?: number, frontageM?: number) => {
      sel();
      startPlan("move");
      for (const p of pts) plan = addPoint(plan!, p.x, p.y, p.mode ?? pace);
      if (facing !== undefined) plan = { ...plan!, facing };
      if (frontageM !== undefined) plan = { ...plan!, frontageM };
    },
    cancelPlan: () => { endPlan(); },
    go: () => { if (plan && overlay.selectedUnit !== null) { const o = planToOrder(plan, playerSide, overlay.selectedUnit, sim.state.tick); if (o) issue(forUnit(o)); } endPlan(); },
    /** Select a unit (screenshots: a vehicle's crew unit). */
    select: (uid: EntityId | null) => { overlay.selectedUnit = uid; syncOrders(); refreshTiles(); },
    /** M7.5a screenshots: dock the order bar, open the sidebar's list, the order set shown, the free area. */
    dock: (e: "top" | "bottom" | "left" | "right") => hud.setDock(e),
    expandSidebar: (on: boolean) => hud.setSidebarExpanded(on),
    orderSet: () => hud.orderSet(),
    insets: () => hud.insets(),
    /** Own top-level units and all own units (sidebar order). */
    units: () => unitTiles(sim.state, playerSide, input.catalog).map((t) => ({ unit: t.unit, callsign: t.callsign, kind: t.kind, depth: t.depth })),
    /** Own vehicles: [entity, crew unit] (screenshots). */
    vehicles: () => [...sim.state.vehicle.entries()].filter(([, v]) => v.side === playerSide).map(([id, v]) => [id, v.unit]),
    /** Get in / get out (M7.2), for the selected unit. */
    mount: () => issue({ tick: sim.state.tick, issuer: playerSide, target: sel(), kind: "mount" }),
    dismount: () => issue({ tick: sim.state.tick, issuer: playerSide, target: sel(), kind: "dismount" }),
    /** Own units riding in a vehicle (its crew unit given): screenshots. */
    riders: (crew: EntityId) => ridersIn(sim, crew),
    showRules: () => hud.showRules(),
    assault: (x: number, y: number) => issue({ tick: sim.state.tick, issuer: playerSide, target: sel(), kind: "assault", x, y }),
    posture: (p: "standing" | "crouching" | "prone") => issue({ tick: sim.state.tick, issuer: playerSide, target: sel(), kind: "posture", posture: p }),
    setDebug: (on: boolean) => { overlay.debug = on; renderer.setNavOverlay(on ? navFor(sim.ctx, vehicleClassOf(overlay.selectedUnit) ?? "foot").grid : null); renderer.setSightOverlay(on ? sightView() : null); sightAt = sim.state.tick; },
    tap: (x: number, y: number) => issue({ tick: sim.state.tick, issuer: playerSide, target: sel(), kind: "move", waypoints: [{ x, y, mode: pace }], ...(formation ? { formation } : {}) }),
    setSpeed: (v: number) => { speed = v; },
    /** Vehicles (M7.3): smoke screen, and the gun and round of the next fire order (screenshots). */
    discharge: () => issue({ tick: sim.state.tick, issuer: playerSide, target: sel(), kind: "discharge" }),
    halt: () => issue({ tick: sim.state.tick, issuer: playerSide, target: sel(), kind: "halt" }),
    fireNature: (x: number, y: number, n: "ap" | "he" | "mg" | "at", contact?: number) => issue({ tick: sim.state.tick, issuer: playerSide, target: sel(), kind: "fire", x, y, nature: n, ...(contact !== undefined ? { contact } : {}) }),
    focus: (x: number, y: number, widthM: number) => renderer.focus(x, y, widthM, hud.insets()),
    /** M7.5b screenshots: centre at a zoom (px/m); the zoom level shown; a roof's alpha. */
    focusScale: (x: number, y: number, scale: number) => { renderer.focusScale(x, y, scale, hud.insets()); renderer.primeDetail(); },
    zoomLevel: () => renderer.zoomLevel(),
    /** M7.5b screenshots: every soldier frame of both sides (with variants) as a sheet over the map; false hides it. */
    showSprites: (on: boolean) => showSpriteSheet(on, sim.state.sides.map((x) => ({ faction: x.faction, colour: SIDE_COLOURS[sim.state.sides.indexOf(x)] ?? 0xffffff })), buildAppearance(data, sim.state.sides.map((x) => x.faction))),
    roofAlpha: (i: number) => renderer.roofAlpha(i),
    renderer,
    /** The "controls" step (screenshots, checks): a world point on the screen (CSS px), and the gestures' state. */
    toScreen: (x: number, y: number) => worldToScreen(renderer.camera, x, y),
    controls: () => {
      const gs = gesture;
      return {
        mode: orderMode, locked: hud.modeLocked(), gesture: gs?.kind ?? null,
        los: gs?.kind === "fire" ? gs.los.map((l) => (l.clear ? "clear" : "blocked")) : null,
        marker: activeMoveOf(overlay.selectedUnit)?.waypoints.at(-1) ?? null,
        facing: facingHandle(), centre: centreOf(placesOf(overlay.selectedUnit)),
      };
    },
    hash: () => simHash(sim),
    ready: true,
  };

  /** The selected unit's rules and state for the rules panel. */
  let statusAt = 0;
  const showUnit = () => {
    const uid = overlay.selectedUnit;
    const u = uid === null ? undefined : sim.state.unit.get(uid);
    if (!u || uid === null) { hud.setUnit(null, ""); return; }
    const veh = u.vehicle !== undefined ? sim.state.vehicle.get(u.vehicle) : undefined;
    if (veh && u.vehicle !== undefined) {
      const def = input.catalog.vehicles[veh.def];
      const crew = veh.seats.filter((x, i) => x !== null && def?.seats[i]?.station !== "passenger" && !isOut(sim.state.soldier.req(x))).length;
      const pax = veh.seats.filter((x, i) => x !== null && def?.seats[i]?.station === "passenger").length;
      const seats = def ? def.seats.filter((q) => q.station === "passenger").length : 0;
      const status = strings.t("status.vehicle", { callsign: u.callsign, status: strings.t(`vehicle.status.${veh.status}`), speed: Math.round(Math.abs(veh.drive.speed) * 3.6), fuel: def ? Math.round(fuelLitres(sim.state, u.vehicle, def)) : 0, crew })
        + (seats > 0 ? `, ${strings.t("status.passengers", { n: pax, seats })}` : "")
        // Ammunition (M7.3): ready per weapon, stowed belts, smoke grenades.
        + (def && veh.stations.length > 0 ? `\n${strings.t("status.vehicle.ammo", {
          ready: veh.stations.flatMap((st) => st.weapons.map((w) => `${strings.t(`weapon.${w.weapon}`, {}, veh.faction)} ${w.feeds.map((f) => f.rounds).join("/")}`)).join(", "),
          stowed: [...new Set(veh.stations.flatMap((st) => st.weapons.flatMap((w) => w.feeds.map((f) => f.item))))].map((it) => (sim.state.container.get(u.vehicle!)?.stacks ?? []).filter((x) => x.type === it).reduce((n, x) => n + (x.charge ?? 0) * x.count, 0)).join("/"),
          smoke: def.dischargers ? vehicleItems(sim.state, u.vehicle, def.dischargers.item) : 0,
        })}` : "")
        // Components (M7.4b, plan C3): every damaged part with its condition; extinguisher charges; the crew's reaction.
        + (def?.components ? `\n${strings.t("status.vehicle.parts", {
          parts: def.components.map((c, k) => ({ c, x: veh.comp[k] ?? 1 })).filter((p) => p.x < 1).map((p) => `${strings.t(`vehicle.comp.${p.c.kind}`)} ${Math.round(p.x * 100)} %`).join(", ") || strings.t("status.vehicle.partsOk"),
          ext: def.extinguisher ? vehicleItems(sim.state, u.vehicle, def.extinguisher.item) : 0,
        })}` : "")
        + (veh.crewReaction !== null ? `\n${strings.t("status.vehicle.reaction", { reaction: strings.t(`reaction.${veh.crewReaction}`), why: veh.reactionWhy.map((k) => strings.t(k)).join(", ") })}` : "");
      hud.setUnit({ fire: u.fireRule, maxEngageM: u.maxEngageM, onContact: u.onContact, ammo: u.ammoRule, at: atRuleOf(sim.ctx, sim.state, uid), ...(pendingRules.get(uid) ?? {}) }, status);
      return;
    }
    const men = unitSoldierIds(sim, uid);
    let fit = 0, wounded = 0, down = 0;
    const states = new Map<string, number>();
    for (const m of men) {
      const s = sim.state.soldier.req(m);
      if (isOut(s)) { down++; continue; } // (prisoners count as lost)
      if (s.wounds.some((w) => w.mechanism !== "blunt")) wounded++; else fit++;
      states.set(s.mental.behaviour, (states.get(s.mental.behaviour) ?? 0) + 1);
    }
    const state = u.broken ? strings.t("behaviour.broken") : [...states.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${strings.t(`behaviour.${k}`)}`).join(", ");
    const now: UnitRules = { fire: u.fireRule, maxEngageM: u.maxEngageM, onContact: u.onContact, ammo: u.ammoRule, at: atRuleOf(sim.ctx, sim.state, uid) };
    const pend = pendingRules.get(uid);
    if (pend) {
      for (const k of Object.keys(pend) as (keyof UnitRules)[]) if (pend[k] === now[k]) delete pend[k];
      if (Object.keys(pend).length === 0) pendingRules.delete(uid);
    }
    hud.setUnit({ ...now, ...(pendingRules.get(uid) ?? {}) }, strings.t("status.unit", { callsign: u.callsign, fit, wounded, down, state }));
  };

  const aar = createAar(hudRoot, strings, {
    onHeat: (on) => { overlay.heat = on ? { shots: heatShots, falls: heatFalls } : null; },
    onClose: () => { /* the map stays; the battle is over */ },
  });
  const zoneNames = (id: EntityId) => [...new Set(sim.state.soldier.req(id).wounds.filter((w) => w.mechanism !== "blunt").map((w) => strings.t(`zone.${w.zone}`)))].join(", ");
  const showAar = () => {
    aarShown = true;
    speed = 0;
    const sc = battleScore(sim.ctx, sim.state);
    const reason = sim.state.ended?.reason ?? "time-limit";
    const model: AarModel = {
      title: strings.t("aar.title"),
      summary: [
        `${sc.winner ? strings.t("aar.winner", { side: sideName(sc.winner) }) : strings.t("aar.draw")} ${reason !== "time-limit" && sim.state.endLoser === null ? strings.t("aar.reason.both") : strings.t(`aar.reason.${reason}`, { loser: sim.state.endLoser ? sideName(sim.state.endLoser) : "" })}`,
        ...sc.scores.map((x) => strings.t("aar.score", { side: sideName(x.side), objectives: x.objectivePoints, down: x.menDown, score: x.score })),
      ],
      casualties: sim.state.sides.map((sd) => {
        // mounted: ok the after-action roster counts every man
        const men = [...sim.state.identity.entries()].filter(([, i]) => i.side === sd.id);
        const rows = men.map(([id, i]) => {
          const s = sim.state.soldier.req(id);
          const st = rosterStatus(s), hurt = s.wounds.some((w) => w.mechanism !== "blunt");
          const status = (st === "surrendered" || st === "captured") && hurt ? strings.t(`status.${st}Wounded`, { zones: zoneNames(id) })
            : st === "wounded" ? (hurt ? strings.t("status.wounded", { zones: zoneNames(id) }) : strings.t("status.fit")) : strings.t(`status.${st}`);
          const rank = { killed: 0, captured: 1, surrendered: 2, incapacitated: 3, wounded: 4, fit: 5, missing: 6 }[st];
          return { order: rank, text: strings.t("aar.man", { rank: strings.t(`rank.${i.faction}.${i.rank}`, {}, i.faction), name: `${i.given} ${i.family}`, callsign: callsignOf(id), role: strings.t(`role.${i.faction}.${i.role}`, {}, i.faction), status }) };
        }).sort((a, b) => a.order - b.order);
        const down = sc.scores.find((x) => x.side === sd.id)?.menDown ?? 0; // the same count as the score
        // Ammunition used (M7.3, plan C4).
        const e = exp[sd.id];
        const spent: string[] = [];
        if (e) {
          spent.push(strings.t("aar.expenditure"), strings.t("aar.exp.smallArms", { n: e.smallArms }), strings.t("aar.exp.grenades", { n: e.grenades }));
          for (const [ammo, n] of Object.entries(e.rockets).sort(([a], [b]) => (a < b ? -1 : 1))) spent.push(strings.t("aar.exp.rockets", { ammo: strings.t(`ammo.${ammo}`, {}, sd.faction), n }));
          for (const [vid, v] of Object.entries(e.vehicles).sort(([a], [b]) => (a < b ? -1 : 1))) {
            const call = [...sim.state.vehicle.values()].find((x) => x.vehicleId === vid);
            const name = call && call.unit !== null ? sim.state.unit.get(call.unit)?.callsign ?? vid : vid;
            for (const [ammo, n] of Object.entries(v.cannon)) spent.push(strings.t("aar.exp.cannon", { vehicle: name, ammo: strings.t(`ammo.${ammo}`, {}, sd.faction), n }));
            for (const [ammo, n] of Object.entries(v.missiles)) spent.push(strings.t("aar.exp.cannon", { vehicle: name, ammo: strings.t(`ammo.${ammo}`, {}, sd.faction), n }));
            if (v.coax > 0) spent.push(strings.t("aar.exp.coax", { vehicle: name, n: v.coax }));
            if (v.smoke > 0) spent.push(strings.t("aar.exp.smoke", { vehicle: name, n: v.smoke }));
          }
        }
        // Vehicles (M7.4a): lost and immobilised.
        const vs = [...sim.state.vehicle.values()].filter((v) => v.side === sd.id);
        const vline = vs.length > 0 ? [strings.t("aar.vehicles", { side: sideName(sd.id), lost: vs.filter((v) => v.status === "destroyed" || v.status === "abandoned").length, immobilised: vs.filter((v) => v.status === "immobilised").length, start: vs.length })] : [];
        return { heading: strings.t("aar.sideHead", { side: sideName(sd.id), down, total: men.length }), colour: sideColour(sd.id), rows: [...vline, ...rows.map((r) => r.text), ...spent] };
      }),
      timeline: timeline.map((t) => ({ time: fmtClock(ticksToSeconds(t.tick)), text: t.text, colour: t.colour })),
    };
    aar.show(model);
  };
  /** Objectives on the map and the score line. */
  const showObjectives = () => {
    const defs = input.rules.objectives;
    overlay.objectives = defs.map((o, i) => ({ x: o.x, y: o.y, radiusM: o.radiusM, holder: sim.state.objectives[i]?.holder ?? null, contested: sim.state.objectives[i]?.contested ?? false, label: strings.t(o.nameKey) }));
    if (defs.length === 0) { hud.setScore([]); return; }
    const left = Math.max(0, input.rules.timeLimitSeconds - ticksToSeconds(sim.state.tick));
    const sup = sim.state.support.some((x) => x.side === playerSide);
    // Compact (M7.5b, parent review): each objective with a marker in its holder's side colour (grey: nobody; the
    // holder's full name as a tooltip), the time left, the mortar rounds left (HE/smoke).
    hud.setScore([
      ...defs.map((o, i) => {
        const st = sim.state.objectives[i];
        return { text: strings.t("score.objective", { objective: strings.t(o.nameKey) }) + (st?.contested ? strings.t("score.contestedMark") : ""), colour: st?.holder ? sideColour(st.holder) : "#8a8a8a", title: st?.holder ? sideName(st.holder) : strings.t("score.nobody") };
      }),
      { text: strings.t("score.time", { left: fmtClock(left) }) },
      ...(sup ? [{ text: strings.t("score.supportShort", { he: supportLeft(sim.state, playerSide, "he"), smoke: supportLeft(sim.state, playerSide, "smoke") }), title: strings.t("score.support", { he: supportLeft(sim.state, playerSide, "he"), smoke: supportLeft(sim.state, playerSide, "smoke") }) }] : []),
    ]);
  };

  /** What the gestures show this frame (S1, S2, S9, S10). */
  const gestureOverlay = (): GestureOverlay | null => {
    const uid = overlay.selectedUnit;
    if (uid === null) return null;
    const gs = gesture, out: GestureOverlay = {};
    const here = () => centreOf(placesOf(uid));
    if (gs?.kind === "fire") {
      out.los = gs.los;
      out.target = gs.onUnit ? null : gs.at;
      if (gs.onUnit) out.cancelAt = here();
    } else if (gs?.kind === "marker") {
      out.marker = gs.onUnit ? null : { x: gs.at.x, y: gs.at.y, from: here(), dragging: true };
      if (gs.onUnit) out.cancelAt = here();
    } else if (gs?.kind === "fromUnit") {
      if (gs.left && !gs.plan) out.cancelAt = here();
    } else if (gs?.kind === "facing") {
      const a = gs.angle ?? gs.start;
      out.facing = { centre: gs.centre, handle: { x: gs.centre.x + Math.cos(a) * gs.dist, y: gs.centre.y + Math.sin(a) * gs.dist }, dragging: true };
    }
    if (!plan && gs?.kind !== "marker") {
      const end = activeMoveOf(uid)?.waypoints.at(-1);
      if (end) out.marker = { x: end.x, y: end.y, from: null, dragging: false };
    }
    if (!gs) { const fh = facingHandle(); if (fh) out.facing = { centre: fh.centre, handle: fh.handle, dragging: false }; }
    return out;
  };

  let acc = 0;
  let last = performance.now();
  let frames = 0, fpsT0 = last, fps = 0, ticksAtT0 = sim.state.tick, simRate = 0, hash = simHash(sim);
  renderer.app.ticker.add(() => {
    const now = performance.now();
    acc += Math.min(0.25, (now - last) / 1000) * speed;
    last = now;
    let steps = 0;
    while (acc >= DT && steps < MAX_STEPS_PER_FRAME) { stepOnce(); acc -= DT; steps++; }
    if (steps === MAX_STEPS_PER_FRAME) acc = 0;
    // Refreshed every 2 s of game time, when the selection changes (also while paused), at most once a second
    // of real time (a few thousand sight checks each).
    if (overlay.debug && (sim.state.tick - sightAt >= 120 || overlay.selectedUnit !== sightFor) && now - sightReal >= 1000) {
      sightAt = sim.state.tick; sightFor = overlay.selectedUnit; sightReal = now;
      renderer.setSightOverlay(sightView());
    }
    // Fog of war: the enemy is drawn only as the player's side knows him (Debug shows him as he is).
    // (Worked out once per tick, not every frame: it only changes when the simulation steps.)
    if (overlay.debug) { overlay.known = null; knownTick = -1; }
    // mounted: ok sideKnowledge never lists men aboard
    else if (knownTick !== sim.state.tick) { overlay.known = sideKnowledge(sim.ctx, sim.state, playerSide); knownTick = sim.state.tick; }
    // Vehicle debug overlay (M7.3): turret lay, the station's target and reasons, track speeds.
    {
      const vid = overlay.debug && overlay.selectedUnit !== null ? sim.state.unit.get(overlay.selectedUnit)?.vehicle : undefined;
      overlay.vehicleDebug = vid === undefined ? null : { vehicle: vid, ...vehicleDebug.view(sim.state, vid, strings) };
    }
    overlay.plan = plan ? { kind: plan.kind, from: plan.from, points: plan.points, marker: planMarker() } : null;
    overlay.gesture = gestureOverlay();
    if (!plan && gesture && (gesture.kind === "fromUnit" || (gesture.kind === "facing" && gesture.angle !== null) || (gesture.kind === "marker" && !gesture.onUnit))) {
      // The ghost marker (S1, S9, S10): where the men will stand, no handles.
      const gp = gesture.kind === "fromUnit" ? gesture.plan
        : gesture.kind === "facing" ? (vehicleClassOf(overlay.selectedUnit) === null ? turnPlan(gesture.centre, gesture.angle!) : null)
        : ghostPlan("move", gesture.from, gesture.at, null);
      overlay.plan = gp ? { kind: gp.kind, from: gp.from, points: gesture.kind === "facing" ? [] : gp.points, marker: vehicleClassOf(overlay.selectedUnit) === null ? markerFor(gp) : null, ghost: true } : null;
    }
    syncOrders();
    if (now - tilesAt >= 250) { tilesAt = now; refreshTiles(); }
    updateFloors();
    renderer.draw(sim.state, input.map, Math.min(1, acc / DT), overlay);
    if (now - statusAt >= 500) { statusAt = now; showUnit(); showObjectives(); }
    if (sim.state.ended && !aarShown) showAar();
    frames++;
    if (now - fpsT0 >= 1000) {
      fps = (frames * 1000) / (now - fpsT0);
      simRate = ticksToSeconds(sim.state.tick - ticksAtT0) / ((now - fpsT0) / 1000);
      if (overlay.debug) hash = simHash(sim);
      frames = 0; fpsT0 = now; ticksAtT0 = sim.state.tick;
    }
    hud.update({ simSeconds: ticksToSeconds(sim.state.tick), tick: sim.state.tick, fps, simRate, hash, entities: sim.state.nextEntityId - 1 });
  });
}

/** The crew unit of the side's vehicle whose hull (grown by `tolM`) holds the point, or null. */
function vehicleAt(sim: Sim, x: number, y: number, tolM: number, side: string): EntityId | null {
  for (const [vid, v] of sim.state.vehicle.entries()) {
    if (v.side !== side || v.unit === null) continue;
    const def = sim.ctx.catalog.vehicles[v.def], t = sim.state.transform.get(vid);
    if (def && t && pointInObb(hullObb(def, t.x, t.y, t.heading), x, y, tolM)) return v.unit;
  }
  return null;
}

/** The units (not the crew) with men riding in the vehicle crewed by `crew`, ID order (M7.2). */
function ridersIn(sim: Sim, crew: EntityId): EntityId[] {
  const vid = sim.state.unit.get(crew)?.vehicle;
  const v = vid === undefined ? undefined : sim.state.vehicle.get(vid);
  if (!v) return [];
  const out = new Set<EntityId>();
  for (const o of v.seats) { const u = o === null ? undefined : sim.state.identity.get(o)?.unit; if (u !== undefined && u !== crew) out.add(u); }
  return [...out].sort((a, b) => a - b);
}

function nearestSoldier(sim: Sim, x: number, y: number, radius: number, side: string | null): EntityId | null {
  const ids = queryRadius(buildSpatialHash(sim.state), sim.state, x, y, radius);
  let best: EntityId | null = null;
  let bestD = Infinity;
  for (const id of ids) {
    if (side !== null && sim.state.identity.get(id)?.side !== side) continue;
    // Men aboard are not tapped (the hull is; tapping it again selects the units riding in it).
    if (sim.state.soldier.get(id)?.mount !== undefined) continue;
    const t = sim.state.transform.req(id);
    const d = (t.x - x) ** 2 + (t.y - y) ** 2;
    if (d < bestD) { bestD = d; best = id; }
  }
  return best;
}

/**
 * The soldier sprite sheet (M7.5b, screenshots): per side, every frame facing east, then the variants (machine gun
 * firing, marksman with a launcher wounded) and a turn through the 16 facings, at 3x on a grass-coloured canvas.
 */
function showSpriteSheet(on: boolean, sides: { faction: string; colour: number }[], app: Appearance): void {
  document.getElementById("sprite-sheet")?.remove();
  if (!on) return;
  const Z = 3, frames = Object.keys(FRAMES) as FrameId[];
  const rows: { side: number; frame: FrameId; facing: number; v: { weapon: "rifle" | "mg" | "marksman"; launcher: boolean; firing: boolean; wounded: boolean } }[] = [];
  sides.forEach((_, si) => {
    for (const v of [{ weapon: "rifle", launcher: false, firing: false, wounded: false }, { weapon: "mg", launcher: false, firing: true, wounded: false }, { weapon: "marksman", launcher: true, firing: false, wounded: true }] as const) {
      for (const f of frames) rows.push({ side: si, frame: f, facing: 0, v });
    }
    for (let k = 0; k < 16; k++) rows.push({ side: si, frame: k % 2 ? "walk1" : "prone", facing: k, v: { weapon: "rifle", launcher: false, firing: false, wounded: false } });
  });
  const perRow = frames.length, cols = 16;
  const W = cols * CELL * Z, lines = Math.ceil(rows.length / perRow) + 2;
  const cv = document.createElement("canvas");
  cv.id = "sprite-sheet";
  cv.width = W; cv.height = lines * CELL * Z;
  Object.assign(cv.style, { position: "fixed", left: "0", top: "0", zIndex: "50", width: "100vw", imageRendering: "pixelated", background: "#6a8648" });
  const g = cv.getContext("2d")!;
  g.fillStyle = "#6a8648"; g.fillRect(0, 0, cv.width, cv.height);
  let line = 0, col = 0, last = -1;
  rows.forEach((r, i) => {
    const group = r.facing > 0 || (r.frame === "prone" && i > 0 && rows[i - 1]!.facing > 0) ? 1 : 0;
    const key = r.side * 10 + (r.v.weapon === "rifle" ? 0 : r.v.weapon === "mg" ? 1 : 2) * 2 + group;
    if (key !== last && col > 0) { line++; col = 0; }
    last = key;
    const pal = paletteFor(lookOf(app, sides[r.side]!.faction));
    const cell = rotateFrame(composeFrame({ frame: r.frame, ...r.v }), r.facing), out = outlineMask(cell);
    const ox = col * CELL * Z, oy = line * CELL * Z;
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      const l = cell[y * CELL + x]!;
      const c = l ? pal[l]! : out[y * CELL + x] ? sides[r.side]!.colour : -1;
      if (c < 0) continue;
      g.fillStyle = `#${c.toString(16).padStart(6, "0")}`;
      g.fillRect(ox + x * Z, oy + y * Z, Z, Z);
    }
    if (++col >= cols) { col = 0; line++; }
  });
  document.body.append(cv);
}

/** mm:ss of game time. */
function fmtClock(s: number): string {
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

/** All soldiers of a unit and its sub-units. */
function unitSoldierIds(sim: Sim, unit: EntityId): EntityId[] {
  const u = sim.state.unit.get(unit);
  if (!u) return [];
  return [...u.members, ...u.children.flatMap((c) => unitSoldierIds(sim, c))];
}


main().catch((e: unknown) => {
  const pre = document.createElement("pre");
  pre.className = "hud-error";
  pre.textContent = `Startup failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`;
  document.body.append(pre);
});
