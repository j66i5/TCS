/**
 * The HUD's panels from the state (from the `main.ts` split, D2): the order bar, the unit sidebar and card, the
 * rules panel's status text and the score line. All read-only; all text from the string table.
 */
import { atRuleOf, fuelLitres, isOut, launcherOf, aglRoundsLeft, mortarTeams, teamRounds, navFor, repairWorkers, supportLeft, ticksToSeconds, vehicleItems, workRate, type EntityId } from "@tcs/sim";
import { shownCallsigns } from "@tcs/render";
import { endPlan } from "./orders";
import { ambulanceRows, droneOrders, manDetail, prisonerCardText, prisonerSummary, ordersFor, unitCapabilities, unitMenRows, unitTiles, vehicleFuel, vehicleGuns, woundedRows, settleRules, type TilePart, type UnitRules, type UnitTile } from "@tcs/ui";
import type { App } from "./app";
import { centreOn, startFollow } from "./camera";
import { ambulanceCallerName, droneMode, fmtClock, hqMode, localClock, selectedMen, selPart, sideColour, sideName, vehicleClassOf } from "./units";

/**
 * The order bar shows only what the selected unit can do now (M7.5a): its capabilities are read from the state
 * (checked every frame, cheap; the bar is rebuilt only when they change). Nothing selected: greyed. A vehicle crew
 * has its own orders and paces (M7.1c).
 */
export function syncOrders(a: App): void {
  const cap = unitCapabilities(a.sim.state, a.input.catalog, a.overlay.selectedUnit, hqMode(a));
  const key = `${droneMode(a) ? "drone|" : hqMode(a) ? "hq|" : ""}${a.overlay.selectedUnit}|${cap.kind}|${cap.hasLauncherRounds}|${cap.handGrenades + cap.rifleGrenades > 0}|${cap.handGrenades + cap.rifleGrenades > 1}|${cap.supportHe > 0}|${cap.supportSmoke > 0}|${cap.canMount}|${cap.canDismount}|${cap.hasSmokeDischargers}|${cap.natures.join()}|${cap.canRepair === true}|${cap.canRecover === true}|${cap.recoverLeft ?? 0}|${cap.kitSource ?? ""}|${cap.supplySource ?? ""}|${cap.bearers === true}`;
  const shownFor = `${selPart(a) ?? ""}${a.overlay.selectedUnit}`;
  if (a.ordersShownFor === shownFor && key === a.ordersKey) return;
  const changedUnit = a.ordersShownFor !== undefined && a.ordersShownFor !== shownFor;
  a.ordersShownFor = shownFor; a.ordersKey = key;
  // (M9.4a: the drone: Move (fly there) and Halt (home) only.)
  const set = droneMode(a) ? droneOrders() : ordersFor(cap, a.input.catalog.movementModes);
  a.hud.setOrders(set);
  // The order mode on show must be one the unit has (a squad without grenades: back to Move); a new unit
  // starts with Move.
  if ((changedUnit && a.orderMode !== "move") || !set.modes.includes(a.orderMode)) { a.orderMode = "move"; a.hud.setOrderMode("move"); }
  if (changedUnit && a.plan) endPlan(a);
  if (a.overlay.debug) a.renderer.setNavOverlay(navFor(a.sim.ctx, vehicleClassOf(a, a.overlay.selectedUnit) ?? "foot").grid);
}

/** The unit sidebar (M7.5a): refreshed about four times a second and on every selection. `reveal`: an explicit
 *  selection (map tap, Tab, hook, Wounded tab), whose tile's folded platoon opens even if it was selected already
 *  (owner 2026-11-20, review fix). */
export function refreshTiles(a: App, reveal = false): void {
  const tiles = unitTiles(a.sim.state, a.playerSide, a.input.catalog);
  if (reveal && a.overlay.selectedUnit !== null) a.hud.revealTile(a.overlay.selectedUnit, selPart(a));
  a.hud.setTiles(tiles, a.overlay.selectedUnit, selPart(a));
  const amb = ambulanceRows(a.sim.state, a.playerSide), caller = amb.ready > 0 ? ambulanceCallerName(a) : undefined;
  a.hud.setWounded(woundedRows(a.sim.state, a.playerSide), caller !== undefined ? { ...amb, caller } : amb);
  showCard(a, tiles);
}

/** The selected unit's card (S3, S6) and the open man's box: refreshed with the tiles and on every selection. */
export function showCard(a: App, tiles: UnitTile[] = unitTiles(a.sim.state, a.playerSide, a.input.catalog)): void {
  const uid = a.overlay.selectedUnit, hud = a.hud;
  // (Owner 2026-11-15: the headquarters selected on its own: its tile and its own men; badged HQ.)
  const hq = hqMode(a);
  const tile = uid === null ? undefined : tiles.find((x) => x.unit === uid && x.kind !== "drone" && (x.kind === "hqGroup") === hq);
  if (uid === null || !tile) { a.inspected = null; hud.setCard(null); hud.showMan(null); hud.setInspected(null); return; }
  const men = unitMenRows(a.sim.state, a.input.catalog, uid, hq);
  if (a.inspected !== null && !men.some((r) => r.id === a.inspected)) a.inspected = null;
  let state = tile.kind === "vehicle" ? a.strings.t(`vehicle.status.${tile.vehicleStatus ?? "ok"}`) : a.strings.t(`side.state.${tile.state}`);
  // A missile team (M9.3b): its launch post packed, setting up, ready (missiles left) or guiding one.
  const mt = a.sim.state.unit.get(uid)?.missileTeam;
  if (mt?.kind === "agl") {
    // (M7.6d: an automatic grenade launcher team: its gun packed, setting up, ready or firing, grenades left.)
    const rounds = aglRoundsLeft(a.sim.ctx, a.sim.state, uid);
    state += ` · ${a.strings.t("card.teamRow")}: ${a.strings.t(mt.burst ? "card.aglTeam.firing" : mt.state === "ready" ? "card.aglTeam.ready" : `card.team.${mt.state}`, { rounds })}`;
  } else if (mt) {
    const l = launcherOf(a.sim.ctx, a.sim.state, uid);
    const rounds = l ? teamRounds(a.sim.state, uid, l.def.round) : 0;
    state += ` · ${a.strings.t("card.teamRow")}: ${a.strings.t(mt.guide ? "card.team.guiding" : `card.team.${mt.state}`, { rounds })}`;
  }
  // (The same callsign in two platoons: "1/Puma 2", as on the map; review fix.)
  hud.setCard({ callsign: shownCallsigns(a.sim.state.unit.entries()).get(uid) ?? tile.callsign, ...(hq ? { badge: a.strings.t("side.hq") } : {}), fit: tile.fit, total: tile.total, state, men, guns: vehicleGuns(a.sim.state, a.input.catalog, uid), ...((f) => (f ? { fuel: f } : {}))(vehicleFuel(a.sim.state, a.input.catalog, uid)), ...(a.sim.state.unit.get(uid)?.supplyAsk?.pending === true ? { supplyAsk: true } : {}), ...((t) => (t !== null ? { prisoners: t } : {}))(prisonerCardText(a.strings, prisonerSummary(a.sim.state, uid))) });
  hud.setInspected(a.inspected);
  hud.showMan(a.inspected === null ? null : manDetail(a.sim.state, a.input.catalog, a.inspected));
}

/** Select a unit (or none) and refresh the order bar, sidebar and card. */
export function select(a: App, uid: EntityId | null, part?: TilePart): void {
  a.overlay.selectedUnit = uid;
  a.overlay.selectedDrone = part === "drone" ? uid : null; a.overlay.selectedOwn = part === "hq";
  syncOrders(a); refreshTiles(a, true);
}

/** S13: select a unit and centre on it (Tab), following it instead while the camera follows. */
export function selectAndCentre(a: App, uid: EntityId): void {
  endPlan(a); a.gesture = null;
  a.overlay.selectedUnit = uid; a.overlay.selectedDrone = null; a.overlay.selectedOwn = false;
  showCard(a);
  if (a.following !== null) startFollow(a, uid); else centreOn(a, uid);
  syncOrders(a); refreshTiles(a, true);
}

/** A unit's rules as the sim has them now (the card's fire row and the Rules panel). */
function rulesNow(a: App, uid: EntityId): UnitRules | null {
  const u = a.sim.state.unit.get(uid);
  if (!u) return null;
  return { fire: u.fireRule, maxEngageM: u.maxEngageM, onContact: u.onContact, ammo: u.ammoRule, at: atRuleOf(a.sim.ctx, a.sim.state, uid), ambush: u.ambush?.rangeM ?? 0, supply: u.supplyRule ?? "auto", prisoners: u.prisonerRule ?? "auto" };
}

/**
 * Settle the rules shown as ordered for a unit (D4b, F7): on every delivered order of `kind` to it (`rules`, `ambush`),
 * selected or not, a crew too, and whenever its card is shown. A unit gone drops them.
 */
export function settlePendingRules(a: App, uid: EntityId, kind?: string): void {
  const pend = a.pendingRules.get(uid);
  if (!pend) return;
  const now = rulesNow(a, uid);
  if (now === null || !settleRules(pend, now, kind)) a.pendingRules.delete(uid);
}

/**
 * Field repair lines of a vehicle's card (M11.7a): the task under way (share done, minutes left, "paused" while the
 * men are not at it), the spares aboard (tool kit and parts its tasks use), parts beyond the crew. "" without
 * repair data.
 */
function repairLines(a: App, vid: EntityId): string {
  const st = a.sim.state, cat = a.input.catalog, t = a.strings.t.bind(a.strings);
  const v = st.vehicle.get(vid), def = v ? cat.vehicles[v.def] : undefined;
  if (!v || !def?.repair || !def.components || cat.repair === undefined) return "";
  let out = "";
  const rep = v.repair;
  if (rep) {
    const kind = def.components[rep.comp]?.kind ?? "";
    const men = repairWorkers(st, vid, v);
    let rate = 0;
    for (const k of men) rate += workRate(cat, st.soldier.get(v.seats[k]!), def.seats[k]!.station);
    if (rate <= 0) rate = cat.repair.tasks[kind as keyof typeof cat.repair.tasks]?.men ?? 1;
    out += `\n${t("status.vehicle.repair", { part: t(`vehicle.comp.${kind}`), pct: Math.floor((100 * rep.doneManS) / rep.needManS), min: Math.max(1, Math.ceil((rep.needManS - rep.doneManS) / rate / 60)), paused: rep.working ? "" : t("status.vehicle.repairPaused") })}`;
  }
  const items = [...new Set([...(def.repair.tool !== undefined ? [def.repair.tool] : []), ...Object.values(def.repair.parts).flatMap((ps) => (ps ?? []).map((p) => p.item))])];
  if (items.length > 0) out += `\n${t("status.vehicle.spares", { list: items.map((it) => `${t(`item.${it}`, {}, v.faction)} ${vehicleItems(st, vid, it)}`).join(", ") })}`;
  for (const k of v.repairBeyond ?? []) out += `\n${t("status.vehicle.beyond", { part: t(`vehicle.comp.${def.components[k]?.kind ?? ""}`) })}`;
  return out;
}

/** The recovery line of a vehicle's card (M11.7b): a recovery vehicle called for it (minutes to come), coming,
 *  waiting short of fire, hooking up (share), the hull under tow or towed away. "" otherwise. */
function recoveryLine(a: App, vid: EntityId): string {
  const st = a.sim.state, t = a.strings.t.bind(a.strings);
  const v = st.vehicle.get(vid);
  if (!v) return "";
  if (v.towAway === true) return `\n${t("status.vehicle.recovery.towed")}`;
  const r = v.recoveryBy !== undefined ? st.vehicle.get(v.recoveryBy) : undefined, o = r?.offMap;
  if (!r || !o) return "";
  if (v.towedBy !== undefined || o.phase === "towing") return `\n${t("status.vehicle.recovery.towing")}`;
  if (o.phase === "called") return `\n${t("status.vehicle.recovery.called", { min: Math.max(1, Math.ceil(ticksToSeconds((o.enterTick ?? st.tick) - st.tick) / 60)) })}`;
  if (o.phase === "inbound") return `\n${t("status.vehicle.recovery.inbound")}`;
  if (o.phase === "waiting") return `\n${t("status.vehicle.recovery.waiting")}`;
  if (o.phase === "hookUp") { const need = a.input.catalog.vehicles[r.def]?.recovery?.hookUpS ?? 1; return `\n${t("status.vehicle.recovery.hookUp", { pct: Math.min(100, Math.floor((100 * (o.hookDoneS ?? 0)) / need)) })}`; }
  return "";
}

/** The selected unit's rules and state for the rules panel. */
export function showUnit(a: App): void {
  const uid = a.overlay.selectedUnit, st = a.sim.state, t = a.strings.t.bind(a.strings), cat = a.input.catalog;
  const u = uid === null ? undefined : st.unit.get(uid);
  if (!u || uid === null) { a.hud.setUnit(null, ""); return; }
  const veh = u.vehicle !== undefined ? st.vehicle.get(u.vehicle) : undefined;
  if (veh && u.vehicle !== undefined) {
    const vid = u.vehicle;
    const def = cat.vehicles[veh.def];
    const crew = veh.seats.filter((x, i) => x !== null && def?.seats[i]?.station !== "passenger" && !isOut(st.soldier.req(x))).length;
    const pax = veh.seats.filter((x, i) => x !== null && def?.seats[i]?.station === "passenger").length;
    const seats = def ? def.seats.filter((q) => q.station === "passenger").length : 0;
    const status = t("status.vehicle", { callsign: u.callsign, status: t(`vehicle.status.${veh.status}`), speed: Math.round(Math.abs(veh.drive.speed) * 3.6), fuel: def ? Math.round(fuelLitres(st, vid, def)) : 0, crew })
      + (seats > 0 ? `, ${t("status.passengers", { n: pax, seats })}` : "")
      // Ammunition (M7.3): ready per weapon, stowed belts, smoke grenades.
      + (def && veh.stations.length > 0 ? `\n${t("status.vehicle.ammo", {
        ready: veh.stations.flatMap((sn) => sn.weapons.map((w) => `${t(`weapon.${w.weapon}`, {}, veh.faction)} ${w.feeds.map((f) => f.rounds).join("/")}`)).join(", "),
        stowed: [...new Set(veh.stations.flatMap((sn) => sn.weapons.flatMap((w) => w.feeds.map((f) => f.item))))].map((it) => (st.container.get(vid)?.stacks ?? []).filter((x) => x.type === it).reduce((n, x) => n + (x.charge ?? 0) * x.count, 0)).join("/"),
        smoke: def.dischargers ? vehicleItems(st, vid, def.dischargers.item) : 0,
      })}` : "")
      // Components (M7.4b, plan C3): every damaged part with its condition; extinguisher charges; the crew's reaction.
      + (def?.components ? `\n${t("status.vehicle.parts", {
        parts: def.components.map((c, k) => ({ c, x: veh.comp[k] ?? 1 })).filter((p) => p.x < 1).map((p) => `${t(`vehicle.comp.${p.c.kind}`)} ${Math.round(p.x * 100)} %`).join(", ") || t("status.vehicle.partsOk"),
        ext: def.extinguisher ? vehicleItems(st, vid, def.extinguisher.item) : 0,
      })}` : "")
      + repairLines(a, vid)
      + recoveryLine(a, vid)
      + (veh.crewReaction !== null ? `\n${t("status.vehicle.reaction", { reaction: t(`reaction.${veh.crewReaction}`), why: veh.reactionWhy.map((k) => t(k)).join(", ") })}` : "");
    settlePendingRules(a, uid);
    a.hud.setUnit({ ...rulesNow(a, uid)!, ...(a.pendingRules.get(uid) ?? {}) }, status);
    return;
  }
  let fit = 0, wounded = 0, down = 0;
  const states = new Map<string, number>();
  for (const m of selectedMen(a, uid)) {
    const s = st.soldier.req(m);
    if (isOut(s)) { down++; continue; } // (prisoners count as lost)
    if (s.wounds.some((w) => w.mechanism !== "blunt")) wounded++; else fit++;
    states.set(s.mental.behaviour, (states.get(s.mental.behaviour) ?? 0) + 1);
  }
  const state = u.broken ? t("behaviour.broken") : [...states.entries()].sort((p, q) => q[1] - p[1]).map(([k, n]) => `${n} ${t(`behaviour.${k}`)}`).join(", ");
  settlePendingRules(a, uid);
  a.hud.setUnit({ ...rulesNow(a, uid)!, ...(a.pendingRules.get(uid) ?? {}) }, t("status.unit", { callsign: u.callsign, fit, wounded, down, state }));
}

/** Objectives on the map and the score line. */
export function showObjectives(a: App): void {
  const defs = a.input.rules.objectives, st = a.sim.state, t = a.strings.t.bind(a.strings), side = a.playerSide, cat = a.sim.ctx.catalog;
  a.overlay.objectives = defs.map((o, i) => ({ x: o.x, y: o.y, radiusM: o.radiusM, holder: st.objectives[i]?.holder ?? null, contested: st.objectives[i]?.contested ?? false, label: t(o.nameKey) }));
  if (defs.length === 0) { a.hud.setScore([]); return; }
  const left = Math.max(0, a.input.rules.timeLimitSeconds - ticksToSeconds(st.tick));
  const sup = st.support.some((x) => x.side === side) || mortarTeams(st, side).length > 0;
  const he = supportLeft(st, side, "he", cat), smoke = supportLeft(st, side, "smoke", cat);
  // Compact (M7.5b, parent review): each objective with a marker in its holder's side colour (grey: nobody; the
  // holder's full name as a tooltip), the time left, the mortar rounds left (HE and smoke, named). The time and
  // the rounds come first (review fix: at the end of the line they were cut off on a phone); the objectives'
  // names may run out of room, their coloured marks stay.
  a.hud.setScore([
    { text: t("score.time", { left: fmtClock(left) }) },
    // Night and light (M9.1): with a sky, the local time and how light it is.
    ...(st.environment.sky ? [{ text: t("score.localTime", { time: localClock(st.environment.timeOfDaySeconds) }), title: t("score.light", { pct: Math.round(st.environment.light * 100) }) }] : []),
    ...(sup ? [{ text: t("score.supportShort", { he, smoke }), title: t("score.support", { he, smoke }) }] : []),
    ...defs.map((o, i) => {
      const os = st.objectives[i];
      return { text: t("score.objective", { objective: t(o.nameKey) }) + (os?.contested ? t("score.contestedMark") : ""), colour: os?.holder ? sideColour(a, os.holder) : "#8a8a8a", title: os?.holder ? sideName(a, os.holder) : t("score.nobody") };
    }),
  ]);
}
