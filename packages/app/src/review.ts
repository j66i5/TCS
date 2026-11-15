/**
 * The after-action review's content (M6; D2 tabs), from the battle record (`@tcs/sim` record.ts) and the state at
 * the end. All text from the string table; the record itself holds keys and raw values only.
 */
import { battleScore, isAssetUnit, rosterStatus, ticksToSeconds, type EntityId, type TimelineEntry } from "@tcs/sim";
import type { AarModel } from "@tcs/ui";
import type { App } from "./app";
import { fmtClock, sideColour, sideName } from "./units";

/** One timeline line in words. */
export function timelineText(a: App, e: TimelineEntry): string {
  const t = a.strings.t.bind(a.strings);
  const side = e.side ? sideName(a, e.side) : "";
  switch (e.key) {
    case "timeline.casualty": return t(e.key, { side, name: e.name ?? "", callsign: e.callsign ?? "", status: t(`status.${e.status}`) });
    case "timeline.objective": { const o = a.input.rules.objectives.find((x) => x.id === e.objective); return t(e.key, { objective: o ? t(o.nameKey) : e.objective ?? "", side }); }
    case "timeline.ended": return t(e.key, { reason: t(`aar.reason.${e.reason}`, { loser: e.loser ? sideName(a, e.loser) : "" }) });
    default:
      if (e.vehicle !== undefined) return t(e.key, { vehicle: `${side} ${e.vehicle}` });
      return t(e.key, { side, name: e.name ?? "", callsign: e.callsign ?? "" });
  }
}

/** The review: result, casualties per side (with ammunition and vehicles), the timeline; Medical and Conduct tabs
 *  stay empty until M10.8 fills them. */
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
      `${sc.winner ? s.t("aar.winner", { side: sideName(a, sc.winner) }) : s.t("aar.draw")} ${reason !== "time-limit" && st.endLoser === null ? s.t("aar.reason.both") : s.t(`aar.reason.${reason}`, { loser: st.endLoser ? sideName(a, st.endLoser) : "" })}`,
      ...sc.scores.map((x) => s.t("aar.score", { side: sideName(a, x.side), objectives: x.objectivePoints, down: x.menDown, score: x.score })),
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
      // Ammunition used (M7.3, plan C4).
      const e = record.exp[sd.id];
      const spent: string[] = [];
      if (e) {
        spent.push(s.t("aar.expenditure"), s.t("aar.exp.smallArms", { n: e.smallArms }), s.t("aar.exp.grenades", { n: e.grenades }), ...(e.handSmoke > 0 ? [s.t("aar.exp.handSmoke", { n: e.handSmoke })] : []));
        for (const [ammo, n] of Object.entries(e.rockets).sort(([p], [q]) => (p < q ? -1 : 1))) spent.push(s.t("aar.exp.rockets", { ammo: s.t(`ammo.${ammo}`, {}, sd.faction), n }));
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
      // Vehicles (M7.4a): lost and immobilised.
      const vs = [...st.vehicle.values()].filter((v) => v.side === sd.id && v.offMap === undefined);
      const vline = vs.length > 0 ? [s.t("aar.vehicles", { side: sideName(a, sd.id), lost: vs.filter((v) => v.status === "destroyed" || v.status === "abandoned").length, immobilised: vs.filter((v) => v.status === "immobilised").length, start: vs.length })] : [];
      return { heading: s.t("aar.sideHead", { side: sideName(a, sd.id), down, total: men.length }), colour: sideColour(a, sd.id), rows: [...vline, ...rows.map((r) => r.text), ...spent] };
    }),
    timeline: record.timeline.map((e) => ({ time: fmtClock(ticksToSeconds(e.tick)), text: timelineText(a, e), colour: e.side ? sideColour(a, e.side) : "#ffd23d" })),
    // D2: the tabs M10.8 fills (times to care, evacuation, died of wounds; breaches of the laws of war).
    medical: st.sides.flatMap((sd) => {
      const rs = record.sides[sd.id], d = rs?.down;
      if (!rs || !d) return [];
      // M10.6b: rear runs, the end-of-battle settlement, Role 1 outcomes.
      const r1 = rs.role1, rec = [...r1.recoveryD].sort((x, y) => x - y);
      const more = [
        ...(rs.rear.started > 0 ? [s.t("aar.medical.rearRuns", { side: sideName(a, sd.id), runs: rs.rear.started, ordered: rs.rear.ordered, men: rs.rear.men })] : []),
        ...(rs.settled.evacuated + rs.settled.captured + rs.settled.prisoner > 0 ? [s.t("aar.medical.settled", { side: sideName(a, sd.id), evac: rs.settled.evacuated, captured: rs.settled.captured, prisoners: rs.settled.prisoner })] : []),
        ...(r1.men > 0 ? [s.t("aar.medical.role1", { side: sideName(a, sd.id), n: r1.men, t1: r1.t1, t1in: r1.t1InTime, dow: r1.dow, days: rec.length > 0 ? rec[Math.floor(rec.length / 2)]! : 0 })] : []),
      ];
      return [s.t("aar.medical.down", { side: sideName(a, sd.id), checked: d.checked, dead: d.checkedDead, dragged: d.deadDragged, tags: d.tagMen, crawled: d.crawled }),
        s.t("aar.medical.prisoners", { side: sideName(a, sd.id), treated: d.prisonersTreated, crawled: d.surrenderCrawled }), ...more];
    }),
    conduct: [],
  };
}
