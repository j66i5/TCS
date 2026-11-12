/**
 * VEHICLE DEBUG OVERLAY (M7.3, plan C2): for the selected vehicle with Debug on — the turret's lay (azimuth,
 * ordered azimuth, laid or slewing and for how long), each station's target and why it chose it (string keys
 * from `vehicle.decision` events, translated), and the track speeds. Fed by events and the render snapshot of
 * the selected vehicle; pure, so it is tested without a canvas.
 */
import type { Strings } from "@tcs/data";
import type { EntityId, SimEvent, SimView } from "@tcs/sim";

export interface VehicleDebugView {
  /** Lines of text, top to bottom. */
  lines: string[];
  /** Where each station is aiming (the target line is drawn from the vehicle to it). */
  targets: { x: number; y: number }[];
}

const deg = (r: number) => Math.round((r * 180) / Math.PI);

export class VehicleDebug {
  /** Last decision per vehicle and station (from events). */
  private last = new Map<string, { tick: number; target: EntityId | null; x: number; y: number; nature: string | null; keys: string[] }>();

  onEvents(events: readonly SimEvent[]): void {
    for (const e of events) {
      if (e.kind !== "vehicle.decision") continue;
      this.last.set(`${e.vehicle}:${e.station}`, { tick: e.tick, target: e.target, x: e.x, y: e.y, nature: e.nature, keys: [...e.keys] });
    }
  }

  view(state: SimView, vid: EntityId, s: Strings): VehicleDebugView {
    const v = state.vehicle.get(vid);
    const out: VehicleDebugView = { lines: [], targets: [] };
    if (!v) return out;
    v.stations.forEach((st, si) => {
      const lay = st.task === null ? s.t("why.hold.noTarget") : st.laidTick >= 0 ? s.t("why.lay.laid", { seconds: Math.round((state.tick - st.laidTick) / 60) }) : s.t("why.lay.slewing");
      out.lines.push(s.t("debug.vehicle.turret", { az: deg(st.azimuth), cmd: deg(st.azCmd), lay }));
      const d = this.last.get(`${vid}:${si}`);
      const keys = d ? d.keys : st.why.keys;
      if (keys.length > 0) out.lines.push(keys.map((k) => s.t(k)).join("; "));
      if (d?.nature) out.lines.push(s.t("debug.vehicle.target", { nature: s.t(`why.nature.${d.nature}`) }));
      if (st.task) out.targets.push({ x: st.task.x, y: st.task.y });
      st.weapons.forEach((w) => out.lines.push(s.t("debug.vehicle.ammo", { weapon: s.t(`weapon.${w.weapon}`, {}, v.faction), rounds: w.feeds.map((f) => f.rounds).join(" / ") })));
    });
    out.lines.push(s.t("debug.vehicle.tracks", { l: v.drive.trackL.toFixed(1), r: v.drive.trackR.toFixed(1) }));
    return out;
  }
}
