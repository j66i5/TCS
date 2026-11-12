/**
 * The browser app: wires data -> scenario -> simulation -> renderer + UI.
 *
 * Real time lives ONLY here. Each animation frame adds elapsed wall time to an accumulator and runs
 * as many fixed 1/60 s simulation steps as fit; the renderer interpolates between the last two.
 * Player input becomes ORDERS submitted to the simulation, exactly like an AI or a replay would.
 */
import { buildAppearance, formatErrors, Strings } from "@tcs/data";
import { buildScenario, demoBattle, MAP_KINDS, vehicleBattle, type MapKind } from "@tcs/scenario";
import { commanderController, vehicleWanderController, wanderController } from "@tcs/ai";
import {
  battleScore, isOut, loadGame, rosterStatus, saveGame, supportLeft, type SaveGame,
  eyeHeightM, fuelLitres, heightAt, hullObb, pointInObb, sideKnowledge, sight,
  buildSpatialHash, createSim, DT, navFor, queryRadius, simHash, step, submitOrder, ticksToSeconds,
  tallyExpenditure, vehicleItems, atRuleOf,
  type EntityId, type Expenditure, type Order, type Sim, type SimEvent,
} from "@tcs/sim";
import { BattleRenderer, SIDE_COLOURS, VehicleDebug, type Overlay } from "@tcs/render";
import { createAar, ordersFor, paceToWaypoint, unitCapabilities, unitTiles, type AarModel, addPoint, attachInput, createHud, dragTo, hitHandle, markerGeometry, newPlan, planToOrder, slotSpan, undoPoint, type Handle, type OrderMode, type Plan, type PlanKind, type UnitRules } from "@tcs/ui";
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
  renderer.setMap(input.map, input.catalog);
  // How the factions look (M7.5a): outside the catalog, so it never touches the battle.
  renderer.setAppearance(buildAppearance(data, sim.state.sides.map((x) => x.faction)));
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
  const planMarker = () => plan && plan.kind === "move" ? markerGeometry(plan, slotsOf(plan.formation), Math.max(1, unitMen().length), doctrineSpacing, HANDLE_PX / renderer.camera.scale) : null;
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
    onOrderMode: (m) => { orderMode = m; if (plan && plan.kind !== m) endPlan(); },
    onHalt: () => { endPlan(); if (overlay.selectedUnit !== null) issue({ tick: sim.state.tick, issuer: playerSide, target: overlay.selectedUnit, kind: "halt" }); },
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
    onSelectUnit: (u) => { endPlan(); overlay.selectedUnit = overlay.selectedUnit === u ? null : u; syncOrders(); refreshTiles(); },
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
  // Start in the tactical view: about 500 m across, centred between your team and the map centre.
  // mounted: ok the start view centres on every own man, aboard or not
  const own = [...sim.state.identity.entries()].filter(([, i]) => i.side === playerSide).map(([id]) => sim.state.transform.req(id));
  if (own.length > 0 && input.map.widthM > 600) {
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
    orderLog.push(order);
    submitOrder(sim, order);
  };

  attachInput(mapRoot, {
    getCamera: () => renderer.camera,
    setCamera: (c) => { renderer.camera = c; },
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
        return;
      }
      if (orderMode === "mortar" || orderMode === "smoke") {
        // Mortar fire (M6.5c): the unit's leader calls it; it lands after a minute or more.
        issue({ tick: sim.state.tick, issuer: playerSide, target: overlay.selectedUnit, kind: "callFire", x: w.x, y: w.y, ammo: orderMode === "mortar" ? "he" : "smoke", rounds: orderMode === "mortar" ? 4 : 2 });
        return;
      }
      if (orderMode === "fire" || orderMode === "antitank") {
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
        return;
      }
      // Move / assault / withdraw: each tap adds a point to the plan; Go sends it.
      if (!plan) startPlan(orderMode);
      plan = addPoint(plan!, w.x, w.y, pace);
    },
    onDragStart: (w) => {
      if (!plan) return false;
      const g = planMarker();
      dragHandle = hitHandle(plan, g, w.x, w.y, 22 / renderer.camera.scale + 1);
      dragGapM = g?.resizeGapM ?? 3;
      return dragHandle !== null;
    },
    onDrag: (w) => { if (plan && dragHandle !== null) plan = dragTo(plan, dragHandle, w.x, w.y, { minFrontageM: 2, maxFrontageM: 200, resizeGapM: dragGapM }); },
    onDragEnd: () => { dragHandle = null; },
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
    fireNature: (x: number, y: number, n: "ap" | "he" | "mg") => issue({ tick: sim.state.tick, issuer: playerSide, target: sel(), kind: "fire", x, y, nature: n }),
    focus: (x: number, y: number, widthM: number) => renderer.focus(x, y, widthM, hud.insets()),
    renderer,
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
    if (defs.length === 0) { hud.setScore(""); return; }
    const left = Math.max(0, input.rules.timeLimitSeconds - ticksToSeconds(sim.state.tick));
    const sup = sim.state.support.some((x) => x.side === playerSide);
    const supText = sup ? [strings.t("score.support", { he: supportLeft(sim.state, playerSide, "he"), smoke: supportLeft(sim.state, playerSide, "smoke") })] : [];
    hud.setScore([...supText, ...defs.map((o, i) => { const st = sim.state.objectives[i]; return strings.t("score.line", { objective: strings.t(o.nameKey), holder: st?.holder ? sideName(st.holder) : strings.t("score.nobody"), contested: st?.contested ? strings.t("score.contested") : "" }); }), strings.t("score.time", { left: fmtClock(left) })].join(" · "));
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
    syncOrders();
    if (now - tilesAt >= 250) { tilesAt = now; refreshTiles(); }
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
