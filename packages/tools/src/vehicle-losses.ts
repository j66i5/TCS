/**
 * Kills by shooter for the batch report (M7.6b): each hull lost is counted once, credited to the last penetrating hit
 * on it (a shooter label), whatever hits it takes after (review fix: an abandoned hull penetrated again and then
 * destroyed was counted twice). Balance pass 6: hulls degraded by hits that did not get through (a cannon round stopped
 * or glancing off, a high-explosive burst on the armour), and the parts those hits wrecked.
 */
export interface LossTally {
  /** A hit on a hull; `label` is its shooter's when it got through, else undefined. */
  hit(vehicle: number, label: string | undefined): void;
  /** A hull destroyed or abandoned (of type `type`): counted the first time only. */
  lost(vehicle: number, type: string): void;
  /** Hull type -> shooter label -> losses. */
  readonly killers: Record<string, Record<string, number>>;
  /** Balance pass 6: a hit on a hull of type `type` that did not get through but damaged parts; `out`: the kinds of
   *  those it wrecked (each part of a hull counted once). */
  outside(vehicle: number, type: string, out: readonly { part: number; kind: string }[]): void;
  /** Hull type -> hulls with a part damaged by hits that did not get through, such hits, parts wrecked by kind. */
  readonly degraded: Record<string, { hulls: number; hits: number; out: Record<string, number> }>;
}

export function lossTally(): LossTally {
  const lastPen = new Map<number, string>(), gone = new Set<number>();
  const killers: Record<string, Record<string, number>> = {};
  const degraded: Record<string, { hulls: number; hits: number; out: Record<string, number> }> = {};
  const touched = new Set<number>(), wrecked = new Set<string>();
  return {
    killers, degraded,
    outside(vehicle, type, out) {
      const d = (degraded[type] ??= { hulls: 0, hits: 0, out: {} });
      d.hits++;
      if (!touched.has(vehicle)) { touched.add(vehicle); d.hulls++; }
      for (const o of out) { const key = `${vehicle}:${o.part}`; if (wrecked.has(key)) continue; wrecked.add(key); d.out[o.kind] = (d.out[o.kind] ?? 0) + 1; }
    },
    hit(vehicle, label) { if (label !== undefined) lastPen.set(vehicle, label); },
    lost(vehicle, type) {
      if (gone.has(vehicle)) return;
      gone.add(vehicle);
      const k = (killers[type] ??= {}), who = lastPen.get(vehicle) ?? "none";
      k[who] = (k[who] ?? 0) + 1;
    },
  };
}
