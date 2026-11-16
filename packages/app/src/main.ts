/**
 * The browser app: wires data -> scenario -> simulation -> renderer + UI.
 *
 * Real time lives ONLY here. Each animation frame adds elapsed wall time to an accumulator and runs
 * as many fixed 1/60 s simulation steps as fit; the renderer interpolates between the last two.
 * Player input becomes ORDERS submitted to the simulation, exactly like an AI or a replay would.
 *
 * D2 split: the shared state is `App` (app.ts); orders, camera, panels, map gestures, keys, map views, the review,
 * save and load and the debug hooks live in the modules beside this file.
 */
import { buildAppearance, formatErrors, Strings } from "@tcs/data";
import { buildScenario, demoBattle, holdBattle, MAP_KINDS, vehicleBattle, withoutRecovery, type MapKind } from "@tcs/scenario";
import { commanderController, vehicleWanderController, waveCommanders, wanderController } from "@tcs/ai";
import {
  DT, environmentAt, isOffMapMan, navFor, newBattleRecord, parseTimeOfDay, recordEvents, sideKnowledge, simHash, step, ticksToSeconds,
  type EntityId, type SimEvent,
} from "@tcs/sim";
import { BattleRenderer, LOD_SYMBOLS, OPENING_SCALE, VehicleDebug, type Look, type Overlay } from "@tcs/render";
import { ageLabel, cacheMarkers, centreOf, createAar, createHud, intentLines, LastSeenBook, linesShown, nestMarkers, RangingBook, repaceMove, rulesOrder, unitTiles } from "@tcs/ui";
import { loadBundledData } from "./data";
import type { App } from "./app";
import { centredOn, centreOn, centreOnDrone, droneCentred, followStep, keepSelectedClear, startFollow, stopFollow } from "./camera";
import { attachControls, gestureOverlay, planOverlay } from "./controls";
import { installHooks } from "./hooks";
import { attachPerfOverlay, FramePerf } from "./perf";
import { attachKeys } from "./keys";
import { carriersParam } from "./params";
import { endPlan, forUnit, goPlan, issue, issueAi, now, resupply, setFormation, takeKit, undoPlanPoint } from "./orders";
import { refreshTiles, showCard, showObjectives, settlePendingRules, showUnit, syncOrders } from "./panels";
import { reviewModel } from "./review";
import { loadOrCreate, reloadSaved, saveNow } from "./save";
import { activeMoveOf, ambulanceCaller, droneMode, isHqUnit, placesOf, selPart, sideColour, unitSoldierIds, vehicleClassOf } from "./units";
import { attachFloors, sightView, updatePins } from "./view";

const MAX_STEPS_PER_FRAME = 240; // never spiral: drop time instead
/** The chosen map look (plan "photo"), remembered per browser. */
const LOOK_KEY = "tcs.ui.look";
/** S14: the contour toggle, remembered on this device. */
const CONTOURS_KEY = "tcs.ui.contours";

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
  // M7.6d: &assault=1: red's platoon is its assault group (on foot) with its AGS team, red attacking unless
  // &attacker= says otherwise.
  const assault = params.get("assault") === "1";
  const attacker = params.get("attacker") === "red" || (assault && params.get("attacker") === null) ? "red" : "blue";
  // The platoon battle starts with its vehicles (attacker mounted) by default since M7.4a (owner Q26: vehicles
  // can now be knocked out and the Panzerfaust and RPG work); &vehicles=0 gives the battle on foot.
  // M7.6c: &vehicles=wheeled (or tracked, or <blue>,<red>) picks the carrier class of each side's platoon.
  const vp = carriersParam(params.get("vehicles"), (m) => console.warn(m));
  const withVehicles = vp.vehicles;
  const limit = Number(params.get("limit") ?? 2400) || 2400;
  // ?scenario=vehicles (M7.1c): IFV platoons with their squads on foot; vehicles appear nowhere else yet.
  const input = scenario === "demo"
    ? demoBattle(data, { seed, factions, timeLimitSeconds: 3600, mapKind, mapSeed: seed })
    : scenario === "hold"
    // M11.1 ?scenario=hold: hold the village against three waves (60 min); &attacker=blue swaps the sides.
    ? holdBattle(data, { seed, factions, defender: params.get("attacker") === "blue" ? "red" : "blue", ...(params.get("limit") ? { timeLimitSeconds: limit } : {}) })
    : scenario === "vehicles"
    ? vehicleBattle(data, { seed, factions, mapKind: mapKind ?? "farmland", timeLimitSeconds: limit, ...(vp.carriers ? { carriers: vp.carriers } : {}), ...crewParam(params.get("crew")), ...(params.get("recovery") === "1" ? { recovery: true } : {}) })
    : buildScenario(data, { kind: "platoon-attack", seed, mapKind: mapKind ?? "village", factions, attacker, timeLimitSeconds: limit, ...(withVehicles ? { vehicles: true } : {}), ...(vp.carriers ? { carriers: vp.carriers } : {}), ...(params.get("mortars") === "1" ? { mortars: true } : {}), ...(withVehicles && params.get("missiles") !== "0" ? { missileTeams: true } : {}), ...(params.get("artillery") === "1" ? { artillery: true } : {}), ...(params.get("air") ? { airRecon: params.get("air")!.split(",").filter((x) => x === "blue" || x === "red") } : {}), ...tanksParam(params.get("tanks"), params.get("tankCrew")), ...(assault ? { assaultGroup: "red" as const, aglTeams: attacker === "red" ? "attacker" as const : "defender" as const } : {}) });
  // ?time=HH:MM (M9.1): the battle at that local time, the light following the clock; &moon=0..1 (default a half moon).
  const timeOfDay = parseTimeOfDay(params.get("time"));
  if (timeOfDay !== null) input.environment = environmentAt(input.catalog, timeOfDay, Number(params.get("moon") ?? 0.5));
  // ?repair=0 (M11.7a): no field repair by the crews.
  if (params.get("repair") === "0") input.rules.repair = false;
  // ?recovery=0 (M11.7b): no recovery vehicles; ?recovery=1: the vehicles scenario gets them too.
  if (params.get("recovery") === "0") withoutRecovery(input);
  // ?ai=0: no enemy controller (screenshots: a scene the enemy must not walk into).
  const ai = params.get("ai") === "0" ? [] : scenario === "demo" ? [wanderController(enemySide, seed + 1000, input.map, 30)]
    : scenario === "vehicles" ? [vehicleWanderController(enemySide, seed + 1000, input.map, 60)]
    : scenario === "hold" && input.forces.find((f) => f.side === enemySide)?.posture === "attack" ? [waveCommanders(enemySide, input)]
    : [commanderController(enemySide, input)];
  // Load: the save is kept with the URL it was made under (the same URL rebuilds the same battle).
  const loaded = loadOrCreate(input, ai, params.get("load") === "1");
  const sim = loaded.sim;

  const renderer = await BattleRenderer.create(mapRoot);
  renderer.groundFloorLabel = strings.t("ui.floor.ground");
  // The look (plan "photo"): the photo map by default; `?look=flat` (or its old name `pixel`) the M7.5b flat pixel
  // map. Remembered per browser (a URL parameter wins; a remembered "classic", deleted after M8, falls back to photo).
  const lookOfParam = (v: string | null): Look | null => (v === "photo" ? "photo" : v === "flat" || v === "pixel" ? "flat" : null);
  let stored: string | null = null;
  try { stored = localStorage.getItem(LOOK_KEY); } catch { /* not remembered */ }
  const look: Look = lookOfParam(params.get("look")) ?? lookOfParam(stored) ?? "photo";
  try { if (params.get("look")) localStorage.setItem(LOOK_KEY, look); } catch { /* not remembered */ }
  renderer.setLook(look);
  // How the factions look (M7.5a): outside the catalog, so it never touches the battle.
  const appearance = buildAppearance(data, sim.state.sides.map((x) => x.faction));
  renderer.setAppearance(appearance);
  renderer.setMap(input.map, input.catalog);
  // The battle opens with nothing selected (M7.5a): the order bar is greyed until a unit is picked.
  const overlay: Overlay = { playerSide, selectedUnit: null, debug: false };
  const kinds = [...MAP_KINDS, "flat"];
  const playerFaction = sim.state.sides.find((s) => s.id === playerSide)?.faction ?? "";
  const defaultFormation = input.catalog.factions[playerFaction]?.defaultFormation ?? Object.keys(input.catalog.formations)[0] ?? "";
  const a: App = {
    input, sim, strings, renderer, overlay, playerSide, ai, orderLog: [], defaultFormation,
    hud: null as unknown as App["hud"],
    doctrineSpacing: input.catalog.factions[playerFaction]?.doctrine["preferredSpacingM"] ?? 10,
    record: loaded.record ?? newBattleRecord(sim.state.sides.map((x) => x.id)), review: null,
    speed: 1, pace: "walk", orderMode: "move", nature: null, plan: null, dragHandle: null, dragGapM: 3, formation: undefined,
    inspected: null, contoursOn: false, following: null, gesture: null, supportAt: null, pendingTurn: null,
    pendingRules: new Map(), activeMoves: new Map(), floorState: { shown: 0, unit: null, unitFloor: null, manual: false }, floorPick: null,
    revealAll: false, sightAt: -1, lastSeen: new LastSeenBook(), rangingBook: new RangingBook(), ordersShownFor: undefined, ordersKey: "",
  };
  const vehicleDebug = new VehicleDebug();
  const orderFor = (kind: "halt" | "mount" | "dismount" | "discharge" | "ceaseFire" | "rearRun" | "repair" | "callRecovery") => { if (overlay.selectedUnit !== null) issue(a, { ...now(a, overlay.selectedUnit), kind }); };
  const hud = a.hud = createHud(hudRoot, strings, {
    formations: Object.keys(input.catalog.formations).sort(),
    defaultFormation,
    mapLabel: `${strings.t(`map.${mapKind ?? "flat"}`)} ${seed}`,
    onNextMap: () => {
      const next = kinds[(kinds.indexOf(mapKind ?? "flat") + 1) % kinds.length]!;
      const q = new URLSearchParams(location.search);
      q.set("map", next);
      location.search = q.toString();
    },
    onSpeed: (v) => { a.speed = v; },
    onOrderMode: (m) => { a.orderMode = m; a.gesture = null; if (a.plan && a.plan.kind !== m) endPlan(a); },
    onHalt: () => {
      endPlan(a); a.gesture = null;
      // (M9.4a: the drone selected: Halt brings it home to land.)
      if (overlay.selectedUnit !== null && droneMode(a)) issue(a, { ...now(a, overlay.selectedUnit), kind: "drone", op: "home" });
      else orderFor("halt");
    },
    onMount: () => { endPlan(a); orderFor("mount"); },
    onDismount: () => { endPlan(a); orderFor("dismount"); },
    // Vehicles (M7.3): smoke screen now; the gun and round of the next fire order.
    onDischarge: () => { endPlan(a); orderFor("discharge"); },
    onRearRun: () => { endPlan(a); orderFor("rearRun"); },
    onRepair: () => { endPlan(a); orderFor("repair"); },
    // M11.7b: a recovery vehicle for the selected crew's disabled hull (or the one it bailed out of).
    onRecover: () => { endPlan(a); orderFor("callRecovery"); },
    onTakeKit: () => { endPlan(a); takeKit(a); },
    onResupply: () => { endPlan(a); resupply(a); },
    onNature: (n) => { a.nature = n; },
    onCeaseFire: () => orderFor("ceaseFire"),
    onPace: (m) => { a.pace = m; },
    // S3: a pace chip while the unit carries out a move the player gave it: the rest of the move at that pace.
    onPaceChosen: (p) => {
      const uid = overlay.selectedUnit, mv = activeMoveOf(a, uid);
      if (uid === null || !mv || a.plan) return;
      const at = centreOf(placesOf(a, uid));
      if (at) issue(a, forUnit(a, repaceMove(mv, at, p, sim.state.tick)));
    },
    // S6: a man's row on the card: his box (again: closed).
    onInspect: (m) => { a.inspected = m === null || m === a.inspected ? null : m; showCard(a); },
    onCardResize: () => { showCard(a); keepSelectedClear(a); },
    onFormation: (f) => setFormation(a, f),
    onUndo: () => undoPlanPoint(a),
    onGo: () => goPlan(a),
    onCancel: () => { endPlan(a); a.orderMode = "move"; hud.setOrderMode("move"); },
    onRules: (r) => {
      const uid = overlay.selectedUnit;
      if (uid === null) return;
      // Shown as ordered until the unit has it (radio delay; while paused it waits).
      a.pendingRules.set(uid, { ...(a.pendingRules.get(uid) ?? {}), ...r });
      // (D4b: the Ambush chip lays a real ambush; a fire rule ends one.)
      issue(a, rulesOrder(now(a, uid), r));
    },
    onPosture: (p) => { if (overlay.selectedUnit !== null) issue(a, { ...now(a, overlay.selectedUnit), kind: "posture", posture: p }); },
    onSave: () => saveNow(a),
    onLoad: () => reloadSaved(a),
    onLayout: () => { renderer.setHudInsets(hud.insets()); },
    // S5: a tile tap selects the unit and centres the camera on it; on the unit already selected and centred, it
    // unselects (as before). A press held on a tile follows the unit; the badge (or any pan) stops following.
    onSelectUnit: (u, part) => {
      endPlan(a); a.gesture = null;
      // (M9.4a: the unit's drone tile selects its drone: Move means fly, Halt brings it home. Owner 2026-11-15: the
      // HQ tile selects the platoon's own men alone; the platoon's tile the whole platoon.)
      const drone = part === "drone";
      const same = overlay.selectedUnit === u && part === selPart(a);
      if (same && (drone ? droneCentred(a, u) : centredOn(a, u))) { overlay.selectedUnit = null; overlay.selectedDrone = null; overlay.selectedOwn = false; stopFollow(a); }
      // (The card first: centring keeps the unit clear of it.)
      else {
        overlay.selectedUnit = u; overlay.selectedDrone = drone ? u : null; overlay.selectedOwn = part === "hq"; showCard(a);
        if (drone) centreOnDrone(a, u); else centreOn(a, u);
        if (a.following !== null && a.following !== u) stopFollow(a);
      }
      syncOrders(a); refreshTiles(a);
    },
    onFollowUnit: (u) => { endPlan(a); a.gesture = null; overlay.selectedUnit = u; overlay.selectedDrone = null; overlay.selectedOwn = false; startFollow(a, u); syncOrders(a); refreshTiles(a); },
    onStopFollow: () => stopFollow(a),
    // M10.5 Wounded tab: a row selects the man's unit and opens his box, the camera on him; "Back" orders him to the
    // Verwundetennest (the order goes to the man himself).
    onWoundedMan: (m) => {
      const uid = sim.state.identity.get(m)?.unit;
      if (uid === undefined) return;
      endPlan(a); a.gesture = null;
      overlay.selectedUnit = uid; overlay.selectedDrone = null; overlay.selectedOwn = isHqUnit(sim, uid); a.inspected = m; showCard(a);
      const t = sim.state.transform.get(m);
      if (t) { stopFollow(a); renderer.focusScale(t.x, t.y, Math.max(renderer.camera.scale, OPENING_SCALE), hud.insets()); }
      syncOrders(a); refreshTiles(a);
    },
    onEvacuate: (m) => { issue(a, { ...now(a, m), kind: "evacuate" }); refreshTiles(a); },
    // M10.6a: the selected unit's platoon calls an ambulance (none selected: the platoon with wounded at its nest).
    onCallAmbulance: () => { const u = ambulanceCaller(a); if (u !== null) { issue(a, { ...now(a, u), kind: "callAmbulance" }); refreshTiles(a); } },
    onContours: (on) => {
      a.contoursOn = on;
      renderer.setContoursAlways(on);
      try { localStorage.setItem(CONTOURS_KEY, on ? "1" : "0"); } catch { /* private window: not remembered */ }
    },
    sideColour: sideColour(a, playerSide),
    onDebug: (on) => {
      overlay.debug = on;
      // Debug view shows the navigation grid soldiers plan their routes on.
      // (A vehicle selected: its class's grid, with the clearance, M7.1c.)
      renderer.setNavOverlay(on ? navFor(sim.ctx, vehicleClassOf(a, overlay.selectedUnit) ?? "foot").grid : null);
      // ... and what the selected unit's leader can see (refreshed every 2 s of game time).
      renderer.setSightOverlay(on ? sightView(a) : null);
      a.sightAt = sim.state.tick;
    },
  });
  // Rank insignia on the unit card (the "insignia" step): appearance data, outside the catalog.
  hud.setInsignia(appearance.insignia);

  try { if (localStorage.getItem(CONTOURS_KEY) === "1") hud.setContours(true); } catch { /* not remembered */ }
  // Fit the map into the area not covered by the top bar, the order bar and the unit sidebar (M7.5a).
  const insets = hud.insets();
  renderer.setHudInsets(insets);
  // M7.5b (owner answer 1): the battle opens zoomed in on the player's lead unit (his first squad; its vehicle
  // while it rides), at true scale.
  // mounted: ok the start view centres on every own man, aboard or not
  // (Not the men off the map, M10.6a: the ambulances' crews wait far outside it.)
  const own = [...sim.state.identity.entries()].filter(([id, i]) => i.side === playerSide && !isOffMapMan(sim.state, sim.state.soldier.get(id))).map(([id]) => sim.state.transform.req(id));
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
  if (leadAt) {
    renderer.focusScale(leadAt.x, leadAt.y, OPENING_SCALE, insets);
    // The opening view's tiles first (photo: painted in workers; shown anyway after 3 s).
    await Promise.race([renderer.primeDetail(), new Promise<void>((r) => setTimeout(r, 3000))]);
  } else if (own.length > 0 && input.map.widthM > 600) {
    const ox = own.reduce((s, t) => s + t.x, 0) / own.length, oy = own.reduce((s, t) => s + t.y, 0) / own.length;
    // Look from the team toward the map centre, 600 m across.
    renderer.focus(ox + 0.4 * (input.map.widthM / 2 - ox), oy + 0.4 * (input.map.heightM / 2 - oy), 600, insets);
  } else {
    renderer.fitToMap(input.map, insets);
  }

  const updateFloors = attachFloors(a, hudRoot);
  attachControls(a, mapRoot);
  const keyPan = attachKeys(a);
  if (loaded.failed) hud.radio(strings.t("app.loadFailed"), 0, "#ffb4b4");

  // ---- Events (rule 5): the renderer's effects, the battle record (the review's source, D2), the radio log.
  const handleEvents = (events: SimEvent[]) => {
    renderer.onEvents(events, sim.state, overlay);
    vehicleDebug.onEvents(events);
    recordEvents(a.record, events, sim.state, input.catalog);
    for (const e of events) {
      if (e.kind === "support.ranging" && e.side === playerSide) a.rangingBook.add(e);
      if (e.kind === "radio" && e.side === playerSide) {
        const faction = sim.state.identity.get(e.from)?.faction;
        // (Review fix: a refusal stands out from routine traffic.)
        // (M11.7a: a parameter named `...Key` is a string key itself: `partKey` gives `part`, in words.)
        const params: Record<string, string | number> = { ...e.params };
        for (const [k, v] of Object.entries(e.params)) if (k.endsWith("Key") && typeof v === "string") params[k.slice(0, -3)] = strings.t(v, {}, faction);
        hud.radio(strings.t(e.key, params, faction), ticksToSeconds(e.tick), e.key === "radio.refuseProtected" ? "#ffb4b4" : sideColour(a, e.side));
      } else if (e.kind === "order.delivered" && (e.orderKind === "rules" || e.orderKind === "ambush")) {
        settlePendingRules(a, e.target, e.orderKind); // (D4b: an ambush delivered and sprung at once leaves the chip)
      } else if (e.kind === "order.rejected" && e.issuer === playerSide && e.reason !== "superseded") {
        // (A superseded order, D4b, was replaced by the player's own newer one: nothing to tell him.)
        hud.radio(strings.t("order.rejected", { reason: e.reason }), ticksToSeconds(e.tick), "#ffb4b4");
      }
    }
  };
  /** Advance the simulation by one tick: AI thinks, renderer remembers positions, step, events out. */
  const stepOnce = () => {
    for (const c of ai) for (const o of c.think(sim.state, sim.state.tick)) issueAi(a, o);
    renderer.capturePrevious(sim.state);
    handleEvents(step(sim));
  };

  a.review = createAar(hudRoot, strings, {
    onHeat: (on) => { overlay.heat = on ? { shots: a.record.heatShots, falls: a.record.heatFalls } : null; },
    onClose: () => { /* the map stays; the battle is over */ },
  });
  let aarShown = false;
  const showAar = () => { aarShown = true; a.speed = 0; a.review!.show(reviewModel(a)); };
  // D3: frame timing (real time only; `__tcs.perf()` always, the read-out with ?perf=1, which never hashes the state).
  const perfMode = params.get("perf") === "1";
  const perf = new FramePerf(renderer, look, () => a.speed);
  if (perfMode) attachPerfOverlay(hudRoot, perf, strings);
  installHooks(a, data, stepOnce, (reset) => perf.report(reset));

  let knownTick = -1, statusAt = 0, tilesAt = -1e9;
  let sightFor: EntityId | null = null, sightReal = -1e9;
  let acc = 0;
  let last = performance.now();
  let frames = 0, fpsT0 = last, fps = 0, ticksAtT0 = sim.state.tick, simRate = 0, hash = perfMode ? "" : simHash(sim);
  renderer.app.ticker.add(() => {
    const t = performance.now();
    const realMs = t - last;
    acc += Math.min(0.25, realMs / 1000) * a.speed;
    // Game time the 0.25 s clamp throws away (ms), for the perf read-out.
    let droppedMs = Math.max(0, realMs - 250) * a.speed;
    last = t;
    let steps = 0;
    while (acc >= DT && steps < MAX_STEPS_PER_FRAME) { stepOnce(); acc -= DT; steps++; }
    if (steps === MAX_STEPS_PER_FRAME) { droppedMs += acc * 1000; acc = 0; }
    const tSim = performance.now();
    let knowMs = 0;
    // Refreshed every 2 s of game time, when the selection changes (also while paused), at most once a second
    // of real time (a few thousand sight checks each).
    if (overlay.debug && (sim.state.tick - a.sightAt >= 120 || overlay.selectedUnit !== sightFor) && t - sightReal >= 1000) {
      a.sightAt = sim.state.tick; sightFor = overlay.selectedUnit; sightReal = t;
      renderer.setSightOverlay(sightView(a));
    }
    // Fog of war: the enemy is drawn only as the player's side knows him (Debug shows him as he is).
    // (Worked out once per tick, not every frame: it only changes when the simulation steps.)
    if (overlay.debug || a.revealAll) { overlay.known = null; knownTick = -1; }
    else if (knownTick !== sim.state.tick) {
      const k0 = performance.now();
      // mounted: ok sideKnowledge never lists men aboard
      overlay.known = sideKnowledge(sim.ctx, sim.state, playerSide); knownTick = sim.state.tick;
      knowMs = performance.now() - k0;
    }
    // S8: "last seen" pins (Debug shows the enemy as he is: no pins); S7: one line per own unit on the move.
    if (overlay.known) {
      updatePins(a, overlay.known);
      overlay.pins = a.lastSeen.pins().map((p) => { const l = ageLabel((sim.state.tick - p.seenTick) / 60); return { ...p, label: strings.t(l.key, l.params) }; });
    } else overlay.pins = null;
    overlay.intents = overlay.debug ? null : linesShown(intentLines(sim.state, playerSide, overlay.selectedUnit, a.rangingBook.falls), renderer.zoomLevel() === LOD_SYMBOLS)
      .map((l) => (l.splashS !== undefined ? { ...l, label: strings.t("support.splash", { s: l.splashS }) } : l));
    a.rangingBook.prune(sim.state.tick);
    // Vehicle debug overlay (M7.3): turret lay, the station's target and reasons, track speeds.
    {
      const vid = overlay.debug && overlay.selectedUnit !== null ? sim.state.unit.get(overlay.selectedUnit)?.vehicle : undefined;
      overlay.vehicleDebug = vid === undefined ? null : { vehicle: vid, ...vehicleDebug.view(sim.state, vid, strings) };
    }
    // M10.5: the side's Verwundetennester (one being dragged: its ghost where it would go).
    { const gs = a.gesture; overlay.nests = nestMarkers(sim.state, playerSide).map((n) => ({ x: n.x, y: n.y, count: n.count, drag: gs?.kind === "nest" && gs.unit === n.unit ? gs.at : null })); }
    // M11.3: the caches the side knows of (its supply point being dragged: its ghost where it would go).
    { const gs = a.gesture; overlay.caches = cacheMarkers(sim.state, a.input.catalog, playerSide).map((m) => ({ x: m.x, y: m.y, side: m.side, own: m.own, point: m.point, rounds: m.rounds, fill: m.fill, empty: m.empty, burning: m.burning, burnt: m.burnt, drag: gs?.kind === "supply" && m.point && gs.unit === m.unit ? gs.at : null })); }
    planOverlay(a);
    overlay.gesture = gestureOverlay(a);
    syncOrders(a);
    if (t - tilesAt >= 250) { tilesAt = t; refreshTiles(a); }
    updateFloors();
    keyPan(t);
    followStep(a);
    const d0 = performance.now();
    renderer.draw(sim.state, input.map, Math.min(1, acc / DT), overlay);
    const drawMs = performance.now() - d0;
    if (t - statusAt >= 500) { statusAt = t; showUnit(a); showObjectives(a); }
    if (sim.state.ended && !aarShown) showAar();
    frames++;
    if (t - fpsT0 >= 1000) {
      fps = (frames * 1000) / (t - fpsT0);
      simRate = ticksToSeconds(sim.state.tick - ticksAtT0) / ((t - fpsT0) / 1000);
      if (overlay.debug && !perfMode) hash = simHash(sim);
      frames = 0; fpsT0 = t; ticksAtT0 = sim.state.tick;
    }
    hud.update({ simSeconds: ticksToSeconds(sim.state.tick), tick: sim.state.tick, fps, simRate, hash, entities: sim.state.nextEntityId - 1 });
    const tEnd = performance.now();
    perf.frameDone(t, realMs, tSim - t, knowMs, tEnd - tSim - knowMs - drawMs, drawMs, steps, droppedMs);
  });
}

main().catch((e: unknown) => {
  const pre = document.createElement("pre");
  pre.className = "hud-error";
  pre.textContent = `Startup failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`;
  document.body.append(pre);
});

/** `&crew=<blue template>,<red template>` (M10.6-data): the vehicles scenario with other crew templates (data ids),
 *  e.g. the ambulance crews for `npm run screenshot -- --scene ambulances`. */
function crewParam(v: string | null): { crewTemplates?: [string, string] } {
  const parts = (v ?? "").split(",").filter((x) => x.length > 0);
  return parts.length === 2 ? { crewTemplates: [parts[0]!, parts[1]!] } : {};
}

/** `?tanks=1|attacker|defender` (M7.6b): the sides' tank sections (1: both); `&tankCrew=<blue section>,<red
 *  section>` (unit template ids, empty: the manifest's), e.g. `tankCrew=,tankovaya-gruppa-t90m`. */
function tanksParam(v: string | null, crew: string | null): { tanks?: true | "attacker" | "defender"; tankTemplates?: [string | null, string | null] } {
  const tanks = v === "1" || v === "both" ? true : v === "attacker" || v === "defender" ? v : undefined;
  if (tanks === undefined) return {};
  const parts = (crew ?? "").split(",");
  return { tanks, ...(crew ? { tankTemplates: [parts[0] || null, parts[1] || null] as [string | null, string | null] } : {}) };
}
