/**
 * The after-action review's content (M6; D2 tabs), from the battle record (`@tcs/sim` record.ts) and the state at
 * the end. All text from the string table; the record itself holds keys and raw values only.
 */
import { battleScore, dryMen, isAssetUnit, medianOf, medicalSummary, MISSING_STEPS, rosterStatus, ticksToSeconds, type EntityId, type TimelineEntry } from "@tcs/sim";
import type { AarModel, AarSection } from "@tcs/ui";
import type { App } from "./app";
import { fmtClock, localClock, sideColour, sideName } from "./units";

/** The loser's and the winner's names for an end reason's line (the winner: the other side of a loser). */
function endNames(a: App, loser: string | null): { loser: string; winner: string } {
  const winner = loser === null ? null : a.sim.state.sides.find((x) => x.id !== loser)?.id ?? null;
  return { loser: loser ? sideName(a, loser) : "", winner: winner ? sideName(a, winner) : "" };
}

/** One timeline line in words. */
export function timelineText(a: App, e: TimelineEntry): string {
  const t = a.strings.t.bind(a.strings);
  const side = e.side ? sideName(a, e.side) : "";
  switch (e.key) {
    case "timeline.casualty": return t(e.key, { side, name: e.name ?? "", callsign: e.callsign ?? "", status: t(`status.${e.status}`) });
    case "timeline.objective": { const o = a.input.rules.objectives.find((x) => x.id === e.objective); return t(e.key, { objective: o ? t(o.nameKey) : e.objective ?? "", side }); }
    case "timeline.ended": return t(e.key, { reason: t(`aar.reason.${e.reason}`, endNames(a, e.loser ?? null)) });
    // (Review 2026-11-24 problem 3: a decided end announced or called off.)
    case "timeline.ending": case "timeline.endingCancelled":
      return t(`${e.key}.${e.reason}`, { winner: e.winner ? sideName(a, e.winner) : "", loser: e.loser ? sideName(a, e.loser) : "" });
    default:
      if (e.vehicle !== undefined) return t(e.key, { vehicle: `${side} ${e.vehicle}` });
      return t(e.key, { side, name: e.name ?? "", callsign: e.callsign ?? "" });
  }
}

/** Breach lines kept per side in the Conduct tab (the counts above them cover all). */
const CONDUCT_LINES_MAX = 30;

/** The review: result, casualties per side (with ammunition and vehicles), the timeline; the Medical and Conduct tabs
 *  (M10.8): times along the chain of care, deaths of wounds with timing and the missing step, breaches of the laws of
 *  war with their circumstances, for both sides. */
export function reviewModel(a: App): AarModel {
  const { sim, strings: s, record } = a;
  const st = sim.state;
  const sc = battleScore(sim.ctx, st);
  const reason = st.ended?.reason ?? "time-limit";
  const callsignOf = (id: EntityId) => st.unit.get(st.identity.get(id)?.unit ?? -1)?.callsign ?? "";
  const zoneNames = (id: EntityId) => [...new Set(st.soldier.req(id).wounds.filter((w) => w.mechanism !== "blunt").map((w) => s.t(`zone.${w.zone}`)))].join(", ");
  return {
    title: s.t("aar.title"),
    summary: [
      `${sc.winner ? s.t("aar.winner", { side: sideName(a, sc.winner) }) : s.t("aar.draw")} ${(reason === "side-broken" || reason === "side-eliminated") && st.endLoser === null ? s.t("aar.reason.both") : s.t(`aar.reason.${reason}`, endNames(a, st.endLoser))}`,
      ...sc.scores.map((x) => s.t("aar.score", { side: sideName(a, x.side), objectives: x.objectivePoints, down: x.menDown, score: x.score })),
      // M9.6: the local time at the end and the light at the start and its lowest (a battle with a sky, M9.1).
      ...(st.environment.sky && record.review.light ? [s.t("aar.light", { time: localClock(st.environment.timeOfDaySeconds), start: Math.round(record.review.light.start * 100), min: Math.round(record.review.light.min * 100) })] : []),
    ],
    casualties: st.sides.map((sd) => {
      // mounted: ok the after-action roster counts every man
      // (Not the crews of off-map assets, M10.6a: an ambulance crew is not of the force.)
      const men = [...st.identity.entries()].filter(([, i]) => i.side === sd.id && !isAssetUnit(st, i.unit));
      const rows = men.map(([id, i]) => {
        const so = st.soldier.req(id);
        const rs = rosterStatus(so), hurt = so.wounds.some((w) => w.mechanism !== "blunt");
        const status = (rs === "surrendered" || rs === "captured") && hurt ? s.t(`status.${rs}Wounded`, { zones: zoneNames(id) })
          : rs === "wounded" ? (hurt ? s.t("status.wounded", { zones: zoneNames(id) }) : s.t("status.fit"))
          : rs === "evacuated" ? s.t("status.evacuated", { zones: zoneNames(id) }) : s.t(`status.${rs}`);
        const rank = { killed: 0, captured: 1, surrendered: 2, incapacitated: 3, evacuated: 4, wounded: 5, fit: 6, missing: 7 }[rs];
        return { order: rank, text: s.t("aar.man", { rank: s.t(`rank.${i.faction}.${i.rank}`, {}, i.faction), name: `${i.given} ${i.family}`, callsign: callsignOf(id), role: s.t(`role.${i.faction}.${i.role}`, {}, i.faction), status }) };
      }).sort((p, q) => p.order - q.order);
      const down = sc.scores.find((x) => x.side === sd.id)?.menDown ?? 0; // the same count as the score
      // Vehicles (M7.4a): lost and immobilised.
      const vs = [...st.vehicle.values()].filter((v) => v.side === sd.id && v.offMap === undefined);
      const vline = vs.length > 0 ? [s.t("aar.vehicles", { side: sideName(a, sd.id), lost: vs.filter((v) => v.status === "destroyed" || v.status === "abandoned").length, immobilised: vs.filter((v) => v.status === "immobilised").length, start: vs.length })] : [];
      // M9.6: drones, enemies found, fire missions by location method (rows only when non-zero).
      const rv = record.review.sides[sd.id], m9: string[] = [];
      if (rv) {
        const d = rv.drones, lost = d.lostBattery + d.lostNoOperator + d.shotDown;
        if (d.launched > 0) m9.push(s.t("aar.drones", { flown: d.launched, landed: d.landed, lost, shot: d.shotDown, battery: d.lostBattery, alone: d.lostNoOperator }));
        if (d.downedEnemy > 0) m9.push(s.t("aar.dronesDowned", { n: d.downedEnemy }));
        if (rv.found.total > 0) m9.push(s.t("aar.found", { n: rv.found.total, drone: rv.found.byDrone, pct: Math.round((100 * rv.found.byDrone) / rv.found.total) }));
        const calls = (["estimate", "laser", "registered", "drone", "air"] as const).filter((k) => (rv.calls[k] ?? 0) > 0).map((k) => s.t("aar.callsBy", { method: s.t(`support.method.${k}`), n: rv.calls[k] ?? 0 }));
        if (calls.length > 0) m9.push(s.t("aar.calls", { list: calls.join(", ") }));
      }
      return { heading: s.t("aar.sideHead", { side: sideName(a, sd.id), down, total: men.length }), colour: sideColour(a, sd.id), rows: [...vline, ...m9, ...rows.map((r) => r.text)] };
    }),
    timeline: record.timeline.map((e) => ({ time: fmtClock(ticksToSeconds(e.tick)), text: timelineText(a, e), colour: e.side ? sideColour(a, e.side) : "#ffd23d" })),
    medical: medicalLines(a),
    conduct: [...conductLines(a), ...prisonerLines(a)],
    logistics: logisticsLines(a),
  };
}

/** A duration for the review, with units so it does not read like a clock time (review fix): "45 s", "13 min 52 s",
 *  "3 h 4 min". */
function dur(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = Math.floor(sec % 60);
  return h > 0 ? `${h} h ${m} min` : m > 0 ? `${m} min ${x} s` : `${x} s`;
}

/** The Medical tab (M10.8, `medicalSummary`): per side (a coloured heading, review fix) the chain of care's times,
 *  deaths of wounds with timing and the missing step (indented), then the M10.5-M10.6b lines (men down, prisoners,
 *  rear runs, the settlement, Role 1). */
export function medicalLines(a: App): AarSection[] {
  const { sim, strings: s, record } = a;
  const st = sim.state, sum = medicalSummary(record);
  const time = (xs: number[]) => { const m = medianOf(xs); return m === null ? s.t("aar.medical.none") : dur(m); };
  return st.sides.flatMap((sd) => {
    const rs = record.sides[sd.id], d = rs?.down, m = sum[sd.id];
    if (!rs || !d || !m) return [];
    const rows: AarSection["rows"] = [];
    const line = (text: string, sub = false) => rows.push(sub ? { text, sub: true } : { text });
    if (m.wounded > 0) {
      const inBattle = m.deaths.filter((x) => !x.after).length;
      line(s.t("aar.medical.summary", { wounded: m.wounded, outright: m.killedOutright, dow: inBattle, after: m.deaths.length - inBattle }));
      // (Review fix: "evacuated during the battle", and only when someone was; the settlement line counts the end.)
      line(s.t("aar.medical.times", { care: time(m.firstCareS), cared: m.firstCareS.length, nest: time(m.nestS), nested: m.nestS.length })
        + (m.evacS.length > 0 ? s.t("aar.medical.timesEvac", { evac: time(m.evacS), evacuated: m.evacS.length }) : ""));
      const prev = MISSING_STEPS.filter((k) => m.steps[k] > 0).map((k) => s.t("aar.medical.stepCount", { step: s.t(`aar.medical.step.${k}`), n: m.steps[k] }));
      const total = MISSING_STEPS.reduce((n, k) => n + m.steps[k], 0);
      line(total > 0 ? s.t("aar.medical.preventable", { n: total, list: prev.join(", ") }) : s.t("aar.medical.noPreventable"));
      for (const x of m.deaths) {
        line(s.t(x.after ? "aar.medical.deathAfter" : "aar.medical.death", {
          name: x.name, callsign: x.callsign, at: fmtClock(x.woundS), after: dur(x.afterS),
          step: x.step === null ? s.t("aar.medical.step.none") : s.t(`aar.medical.step.${x.step}`),
        }), true);
      }
    }
    // M10.6b: rear runs, the end-of-battle settlement, Role 1 outcomes.
    const r1 = rs.role1, rec = [...r1.recoveryD].sort((x, y) => x - y);
    // (Lines with nothing in them are left out.)
    if (d.checked + d.deadDragged + d.tagMen + d.crawled > 0) line(s.t("aar.medical.down", { checked: d.checked, dead: d.checkedDead, dragged: d.deadDragged, tags: d.tagMen, crawled: d.crawled }));
    if (d.prisonersTreated + d.surrenderCrawled > 0) line(s.t("aar.medical.prisoners", { treated: d.prisonersTreated, crawled: d.surrenderCrawled }));
    if (rs.rear.started > 0) line(s.t("aar.medical.rearRuns", { runs: rs.rear.started, ordered: rs.rear.ordered, men: rs.rear.men }));
    if (rs.settled.evacuated + rs.settled.captured + rs.settled.prisoner > 0) line(s.t("aar.medical.settled", { evac: rs.settled.evacuated, captured: rs.settled.captured, prisoners: rs.settled.prisoner }));
    if (r1.men > 0) line(s.t("aar.medical.role1", { n: r1.men, t1: r1.t1, t1in: r1.t1InTime, dow: r1.dow, days: rec.length > 0 ? rec[Math.floor(rec.length / 2)]! : 0 }));
    return rows.length > 0 ? [{ heading: sideName(a, sd.id), colour: sideColour(a, sd.id), rows }] : [];
  });
}

/** The Conduct tab (M10.8): per side (by the side that fired; a coloured heading) breaches by cause, refused orders
 *  (owner Q-7), hits on protected people aimed and incidental as separate lists (Q-8), then each breach with its
 *  circumstances (indented). Empty when nothing happened on either side (the tab then says so). */
export function conductLines(a: App): AarSection[] {
  const { sim, strings: s, record } = a;
  const out: AarSection[] = [];
  for (const sd of sim.state.sides) {
    const c = record.sides[sd.id]?.conduct;
    if (!c) continue;
    const hits = Object.entries(c.hits).sort(([p], [q]) => (p < q ? -1 : 1));
    const misuse = c.misuse ?? [];
    if (c.misidentified + c.deliberate + c.refused + hits.length + misuse.length === 0) continue;
    const rows: AarSection["rows"] = [];
    // (Review fix: "under orders" counts breaches of either cause, and the line says so.)
    const ordered = c.breaches.filter((b) => b.ordered).length;
    rows.push({ text: s.t("aar.conduct.summary", { mis: c.misidentified, del: c.deliberate, ordered, refused: c.refused }) });
    const list = (aimed: boolean) => hits.filter(([, h]) => (aimed ? h.aimed : h.incidental) > 0).map(([k, h]) => s.t("aar.conduct.hitKind", { kind: s.t(`aar.conduct.prot.${k}`), n: aimed ? h.aimed : h.incidental })).join(", ") || s.t("aar.medical.none");
    if (hits.length > 0) rows.push({ text: s.t("aar.conduct.hits", { aimed: list(true), incidental: list(false) }) });
    for (const b of c.breaches.slice(0, CONDUCT_LINES_MAX)) {
      rows.push({ sub: true, text: s.t("aar.conduct.breach", {
        time: fmtClock(ticksToSeconds(b.tick)), by: b.by, callsign: b.callsign, target: b.target, prot: s.t(`aar.conduct.prot.${b.protection}`),
        range: b.rangeM, cause: s.t(`aar.conduct.cause.${b.cause}`), light: Math.round(b.light * 100), stress: Math.round(b.stress * 100),
        // (Review fix: smoke only when there was some on the line, as how much of the view it let through.)
        smoke: b.smoke < 0.995 ? s.t("aar.conduct.smoke", { pct: Math.round(b.smoke * 100) }) : "",
        extra: [b.ordered ? s.t("aar.conduct.ordered") : "", b.vehicle ? s.t("aar.conduct.fromVehicle") : ""].filter((x) => x !== "").join(""),
      }) });
    }
    // M11.4b (owner): ammunition carried in an ambulance, a breach of the law of war.
    for (const m of misuse.slice(0, CONDUCT_LINES_MAX)) rows.push({ sub: true, text: s.t("aar.conduct.misuse", { callsign: m.vehicle, time: fmtClock(ticksToSeconds(m.tick)) }) });
    const more = c.misidentified + c.deliberate - Math.min(c.breaches.length, CONDUCT_LINES_MAX);
    if (more > 0) rows.push({ sub: true, text: s.t("aar.conduct.more", { n: more }) });
    out.push({ heading: sideName(a, sd.id), colour: sideColour(a, sd.id), rows });
  }
  return out;
}

/** The Conduct tab's Prisoners block (M11.9c, plan 4.12): per side, the prisoners it HELD (a heading per side): taken by
 *  group, searched and what was taken, escorts and guard minutes, wounded prisoners treated, carried and evacuated,
 *  handed to the military police and taken away, escapes, still held at the end, seconds under fire at a collection
 *  point, exposures (a breach) and hits on them. Nothing for a side that held nobody. */
export function prisonerLines(a: App): AarSection[] {
  const { sim, strings: s, record } = a;
  const out: AarSection[] = [];
  for (const sd of sim.state.sides) {
    const p = record.sides[sd.id]?.pow;
    if (!p) continue;
    const taken = p.taken.officer + p.taken.nco + p.taken.man;
    if (taken + p.settled + p.heldEnd + p.escapes + p.evacuated + p.medEvac + p.hitsAimed + p.hitsIncidental === 0) continue;
    const rows: AarSection["rows"] = [];
    const mean = p.walkS.length > 0 ? Math.round(p.walkS.reduce((x, y) => x + y, 0) / p.walkS.length) : 0;
    rows.push({ text: s.t("aar.pow.taken", { n: taken, officers: p.taken.officer, ncos: p.taken.nco, men: p.taken.man, end: p.settled }) });
    if (p.searched > 0) rows.push({ text: s.t("aar.pow.searched", { n: p.searched, weapons: p.weapons, rounds: p.rounds, documents: p.documents }) });
    if (p.escorts + p.dutyS > 0) rows.push({ text: s.t("aar.pow.escorts", { n: p.escorts, walk: mean, held: p.walkS.length, min: Math.round(p.dutyS / 6) / 10 }) });
    if (p.treated + p.carried + p.medEvac > 0) rows.push({ text: s.t("aar.pow.wounded", { treated: p.treated, carried: p.carried, evac: p.medEvac }) });
    if (p.mp + p.evacuated > 0) rows.push({ text: s.t("aar.pow.mp", { boarded: p.mp, evac: p.evacuated }) });
    rows.push({ text: s.t("aar.pow.escapes", { tried: p.escapes, escaped: p.escaped, recaptured: p.recaptured, held: p.heldEnd }) });
    rows.push({ text: s.t("aar.pow.law", { fire: p.underFireS, exposures: p.exposures, aimed: p.hitsAimed, incidental: p.hitsIncidental }) });
    out.push({ heading: s.t("aar.pow.heading", { side: sideName(a, sd.id) }), colour: sideColour(a, sd.id), rows });
  }
  return out;
}

/** Weapon types in the order the Logistics tab lists them (`aar.wtype.*`). */
const WTYPES = ["rifle", "carbine", "marksman-rifle", "pistol", "light-machine-gun", "machine-gun", "grenade-launcher", "hand-grenade", "launcher", "missile", "grenade-machine-gun", "autocannon", "tank-gun", "smoke-launcher", "mortar", "artillery", "other"];

/** The Logistics tab (M11.8): per side (a coloured heading) ammunition fired by weapon type (the hulls', rockets' and
 *  fire support's details indented), delivered by bearers, vehicle runs and from off the map, taken from casualties
 *  and the enemy, captured and lost, requests for ammunition and how long they waited, men without a round at the
 *  end, fuel, re-arming; the M11.6-M11.7 rows (field repair, recovery, batteries, water). Lines with nothing in them
 *  are left out; a side with nothing at all too (the tab then says so). */
export function logisticsLines(a: App): AarSection[] {
  const { sim, strings: s, record } = a;
  const st = sim.state;
  const out: AarSection[] = [];
  for (const sd of st.sides) {
    const rows: AarSection["rows"] = [];
    const line = (text: string, sub = false) => rows.push(sub ? { text, sub: true } : { text });
    const sup = record.sides[sd.id]?.supply;
    // ---- fired, by weapon type, then the details of the M7.3 expenditure (hulls, rockets, fire support)
    const fired = sup?.fired ?? {};
    const types = [...WTYPES.filter((k) => (fired[k] ?? 0) > 0), ...Object.keys(fired).filter((k) => !WTYPES.includes(k) && (fired[k] ?? 0) > 0).sort()];
    if (types.length > 0) line(s.t("aar.logistics.fired", { list: types.map((k) => s.t("aar.logistics.firedType", { type: s.t(`aar.wtype.${k}`), n: fired[k] ?? 0 })).join(", ") }));
    // Ammunition used (M7.3, plan C4).
    const e = record.exp[sd.id];
    const spent: string[] = [];
    if (e) {
      if (e.handSmoke > 0) spent.push(s.t("aar.exp.handSmoke", { n: e.handSmoke }));
      for (const [ammo, n] of Object.entries(e.rockets).sort(([p], [q]) => (p < q ? -1 : 1))) spent.push(s.t("aar.exp.rockets", { ammo: s.t(`ammo.${ammo}`, {}, sd.faction), n }));
      // M7.6d: automatic grenade launchers on foot.
      for (const [ammo, n] of Object.entries(e.grenadeMg ?? {}).sort(([p], [q]) => (p < q ? -1 : 1))) spent.push(s.t("aar.exp.grenadeMg", { ammo: s.t(`ammo.${ammo}`, {}, sd.faction), n }));
      // M8.6: fire support rounds by asset and kind.
      for (const [k, n] of Object.entries(e.support ?? {}).sort(([p], [q]) => (p < q ? -1 : 1))) {
        const [asset, ammo] = k.split(":");
        spent.push(s.t("aar.exp.support", { asset: s.t(asset === "artillery" ? "support.artillery" : "support.mortar"), ammo: s.t(`support.${ammo}`), n }));
      }
      for (const [vid, v] of Object.entries(e.vehicles).sort(([p], [q]) => (p < q ? -1 : 1))) {
        // off-map: ok a lookup by name
        const call = [...st.vehicle.values()].find((x) => x.vehicleId === vid);
        const name = call && call.unit !== null ? st.unit.get(call.unit)?.callsign ?? vid : vid;
        for (const [ammo, n] of Object.entries(v.cannon)) spent.push(s.t("aar.exp.cannon", { vehicle: name, ammo: s.t(`ammo.${ammo}`, {}, sd.faction), n }));
        for (const [ammo, n] of Object.entries(v.missiles)) spent.push(s.t("aar.exp.cannon", { vehicle: name, ammo: s.t(`ammo.${ammo}`, {}, sd.faction), n }));
        if (v.coax > 0) spent.push(s.t("aar.exp.coax", { vehicle: name, n: v.coax }));
        if (v.smoke > 0) spent.push(s.t("aar.exp.smoke", { vehicle: name, n: v.smoke }));
      }
    }
    for (const x of spent) line(x, true);
    if (sup) {
      // ---- delivered
      const foot = sup.roundsDelivered ?? 0, veh = sup.roundsVehicle ?? 0, off = sup.roundsOffMap ?? 0;
      if ((sup.trips ?? 0) + (sup.vehicleRuns ?? 0) + (sup.deliveries ?? 0) + (sup.topUp ?? 0) > 0) line(s.t("aar.logistics.delivered", { foot, trips: sup.trips ?? 0, veh, runs: sup.vehicleRuns ?? 0, off, n: sup.deliveries ?? 0, topup: sup.topUp ?? 0 }));
      // ---- taken
      if ((sup.takenCasualty ?? 0) + (sup.takenEnemy ?? 0) + sup.roundsTaken > 0) line(s.t("aar.logistics.taken", { cas: sup.takenCasualty ?? 0, enemy: sup.takenEnemy ?? 0, cache: sup.roundsTaken, sent: sup.sent }));
      // ---- captured and lost
      if (sup.captured + sup.cookoffs + (sup.roundsLost ?? 0) > 0) line(s.t("aar.logistics.captured", { captured: sup.captured, rounds: sup.roundsCaptured, cookoffs: sup.cookoffs, destroyed: sup.roundsDestroyed, lost: sup.roundsLost ?? 0 }));
      // ---- requests and their waits
      const req = sup.requests ?? 0, waits = sup.waitS ?? [];
      if (req > 0) {
        const m = medianOf(waits);
        line(s.t("aar.logistics.requests", { n: req, answered: waits.length, wait: m === null ? s.t("aar.medical.none") : dur(m), open: sup.open ?? 0 }));
      }
      // ---- fuel and re-arming
      if ((sup.litresBurnt ?? 0) + (sup.litresRefuelled ?? 0) + (sup.litresDelivered ?? 0) > 0.5) line(s.t("aar.logistics.fuel", { burnt: Math.round(sup.litresBurnt ?? 0), refuelled: Math.round(sup.litresRefuelled ?? 0), delivered: Math.round(sup.litresDelivered ?? 0) }));
      if ((sup.rearms ?? 0) + (sup.roundsRestocked ?? 0) > 0) line(s.t("aar.logistics.rearm", { n: sup.rearms ?? 0, rounds: sup.roundsRearmed ?? 0, restocked: sup.roundsRestocked ?? 0 }));
    }
    // M11.7a: field repairs (a row only when a crew started one).
    const rp = record.sides[sd.id]?.repair;
    if (rp && rp.started > 0) line(s.t("aar.vehicles.repair", { done: rp.done, failed: rp.failed, stopped: rp.interrupted, parts: rp.parts }));
    // M11.7b: recovery (a row only when one was called or a hull was settled at the end).
    const rcv = record.sides[sd.id]?.recovery;
    if (rcv && rcv.called + rcv.recovered + rcv.captured > 0) line(s.t("aar.vehicles.recovery", { called: rcv.called, towed: rcv.towed, recovered: rcv.recovered, captured: rcv.captured, lost: rcv.lost }));
    // M11.6: batteries changed and gone flat, time off the net, water drunk (rows only when non-zero).
    const p = record.review.sides[sd.id]?.supply;
    if (p) {
      const sw = p.swaps.radio + p.swaps.sight + p.swaps.other + p.swaps.drone, fl = p.flat.radio + p.flat.sight + p.flat.other;
      if (sw + fl > 0) line(s.t("aar.batteries", { radio: p.swaps.radio, sight: p.swaps.sight, other: p.swaps.other, drone: p.swaps.drone, flatRadio: p.flat.radio, flatSight: p.flat.sight, flatOther: p.flat.other }));
      if (p.offNetS > 0) line(s.t("aar.offNet", { time: dur(p.offNetS) }));
      if (p.waterMl > 0) line(s.t("aar.water", { litres: (p.waterMl / 1000).toFixed(1) }));
    }
    if (rows.length === 0) continue;
    // ---- men without a round (now: the end of the battle when the review opens), always with something above it
    const dm = dryMen(sim.ctx.catalog, st, sd.id);
    rows.splice(types.length > 0 ? 1 : 0, 0, { text: s.t("aar.logistics.dry", { dry: dm.dry, armed: dm.armed }) });
    out.push({ heading: sideName(a, sd.id), colour: sideColour(a, sd.id), rows });
  }
  return out;
}
