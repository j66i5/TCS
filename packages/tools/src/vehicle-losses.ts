/**
 * Kills by shooter for the batch report (M7.6b): each hull lost is counted once, credited to the last penetrating hit
 * on it (a shooter label), whatever hits it takes after (review fix: an abandoned hull penetrated again and then
 * destroyed was counted twice).
 */
export interface LossTally {
  /** A hit on a hull; `label` is its shooter's when it got through, else undefined. */
  hit(vehicle: number, label: string | undefined): void;
  /** A hull destroyed or abandoned (of type `type`): counted the first time only. */
  lost(vehicle: number, type: string): void;
  /** Hull type -> shooter label -> losses. */
  readonly killers: Record<string, Record<string, number>>;
}

export function lossTally(): LossTally {
  const lastPen = new Map<number, string>(), gone = new Set<number>();
  const killers: Record<string, Record<string, number>> = {};
  return {
    killers,
    hit(vehicle, label) { if (label !== undefined) lastPen.set(vehicle, label); },
    lost(vehicle, type) {
      if (gone.has(vehicle)) return;
      gone.add(vehicle);
      const k = (killers[type] ??= {}), who = lastPen.get(vehicle) ?? "none";
      k[who] = (k[who] ?? 0) + 1;
    },
  };
}
