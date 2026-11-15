/**
 * The HUD's panels from the state (from the `main.ts` split, D2): the order bar, the unit sidebar and card, the
 * rules panel's status text and the score line. All read-only; all text from the string table.
 */
import { atRuleOf, fuelLitres, isOut, launcherOf, mortarTeams, teamRounds, navFor, supportLeft, ticksToSeconds, vehicleItems, type EntityId } from "@tcs/sim";
import { shownCallsigns } from "@tcs/render";
import { endPlan } from "./orders";
import { ambulanceRows, droneOrders, manDetail, ordersFor, unitCapabilities, unitMenRows, unitTiles, woundedRows, type TilePart, type UnitRules, type UnitTile } from "@tcs/ui";
import type { App } from "./app";
import { centreOn, startFollow } from "./camera";
import { droneMode, fmtClock, hqMode, localClock, selectedMen, selPart, sideColour, sideName, vehicleClassOf } from "./units";

/**
 * The order bar shows only what the selected unit can do now (M7.5a): its capabilities are read from the state
 * (checked every frame, cheap; the bar is rebuilt only when they change). Nothing selected: greyed. A vehicle crew
 * has its own orders and paces (M7.1c).
 */
export function syncOrders(a: App): void {
  const cap = unitCapabilities(a.sim.state, a.input.catalog, a.overlay.selectedUnit, hqMode(a));
  const key = `${droneMode(a) ? "drone|" : hqMode(a) ? "hq|" : ""}${a.overlay.selectedUnit}|${cap.kind}|${cap.hasLauncherRounds}|${cap.handGrenades + cap.rifleGrenades > 0}|${cap.handGrenades + cap.rifleGrenades > 1}|${cap.supportHe > 0}|${cap.supportSmoke > 0}|${cap.canMount}|${cap.canDismount}|${cap.hasSmokeDischargers}|${cap.natures.join()}`;
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

/** The unit sidebar (M7.5a): refreshed about four times a second and on every selection. */
export function refreshTiles(a: App): void {
  const tiles = unitTiles(a.sim.state, a.playerSide, a.input.catalog);
  a.hud.setTiles(tiles, a.overlay.selectedUnit, selPart(a));
  a.hud.setWounded(woundedRows(a.sim.state, a.playerSide), ambulanceRows(a.sim.state, a.playerSide));
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
  if (mt) {
    const l = launcherOf(a.sim.ctx, a.sim.state, uid);
    const rounds = l ? teamRounds(a.sim.state, uid, l.def.round) : 0;
    state += ` · ${a.strings.t("card.teamRow")}: ${a.strings.t(mt.guide ? "card.team.guiding" : `card.team.${mt.state}`, { rounds })}`;
  }
  // (The same callsign in two platoons: "1/Puma 2", as on the map; review fix.)
  hud.setCard({ callsign: shownCallsigns(a.sim.state.unit.entries()).get(uid) ?? tile.callsign, ...(hq ? { badge: a.strings.t("side.hq") } : {}), fit: tile.fit, total: tile.total, state, men });
  hud.setInspected(a.inspected);
  hud.showMan(a.inspected === null ? null : manDetail(a.sim.state, a.input.catalog, a.inspected));
}

/** Select a unit (or none) and refresh the order bar, sidebar and card. */
export function select(a: App, uid: EntityId | null, part?: TilePart): void {
  a.overlay.selectedUnit = uid;
  a.overlay.selectedDrone = part === "drone" ? uid : null; a.overlay.selectedOwn = part === "hq";
  syncOrders(a); refreshTiles(a);
}

/** S13: select a unit and centre on it (Tab), following it instead while the camera follows. */
export function selectAndCentre(a: App, uid: EntityId): void {
  endPlan(a); a.gesture = null;
  a.overlay.selectedUnit = uid; a.overlay.selectedDrone = null; a.overlay.selectedOwn = false;
  showCard(a);
  if (a.following !== null) startFollow(a, uid); else centreOn(a, uid);
  syncOrders(a); refreshTiles(a);
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
      + (veh.crewReaction !== null ? `\n${t("status.vehicle.reaction", { reaction: t(`reaction.${veh.crewReaction}`), why: veh.reactionWhy.map((k) => t(k)).join(", ") })}` : "");
    a.hud.setUnit({ fire: u.fireRule, maxEngageM: u.maxEngageM, onContact: u.onContact, ammo: u.ammoRule, at: atRuleOf(a.sim.ctx, st, uid), ...(a.pendingRules.get(uid) ?? {}) }, status);
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
  const nowRules: UnitRules = { fire: u.fireRule, maxEngageM: u.maxEngageM, onContact: u.onContact, ammo: u.ammoRule, at: atRuleOf(a.sim.ctx, st, uid) };
  const pend = a.pendingRules.get(uid);
  if (pend) {
    for (const k of Object.keys(pend) as (keyof UnitRules)[]) if (pend[k] === nowRules[k]) delete pend[k];
    if (Object.keys(pend).length === 0) a.pendingRules.delete(uid);
  }
  a.hud.setUnit({ ...nowRules, ...(a.pendingRules.get(uid) ?? {}) }, t("status.unit", { callsign: u.callsign, fit, wounded, down, state }));
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
