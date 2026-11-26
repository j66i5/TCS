/**
 * What the player is told when an order is not accepted (review 2026-11-24 step 5, item 7): a sentence per reason
 * the simulation can give (`OrderRejectReason`), and a more exact one where the order's kind says what was wrong.
 * Pure: string keys out (rule 12). The `order.rejected` event carries no order kind; the app remembers the kind of
 * each order it sent by its sequence number.
 */
import type { OrderKind, OrderRejectReason } from "@tcs/sim";

/** Every reason: its general sentence's key, or null when nothing is said (the player's own newer order replaced
 *  it). A new reason in the simulation fails to compile here until it has a sentence. */
export const REJECT_KEYS: Record<OrderRejectReason, string | null> = {
  "late": "order.rejected.late",
  "unknown-target": "order.rejected.unknown-target",
  "not-your-unit": "order.rejected.not-your-unit",
  "invalid-params": "order.rejected.invalid-params",
  "not-applicable": "order.rejected.not-applicable",
  "battle-ended": "order.rejected.battle-ended",
  "no-comms": "order.rejected.no-comms",
  "superseded": null,
  "not-decided": "order.rejected.not-decided",
};

/** "This unit cannot do that": the sentence's suffix by order kind (`order.rejected.not-applicable.<suffix>`).
 *  The first group is what a vehicle crew or a unit without the kit is refused (`orderApplies`); "battle": the
 *  battle's data or rules have no such thing (no medical nest, no supply chain, no recovery vehicles...). */
export const REJECT_NOT_APPLICABLE: Partial<Record<OrderKind, string>> = {
  posture: "crew", withdraw: "crew", grenade: "crew", occupy: "crew", defendArc: "crew", assault: "crew",
  fire: "missile", discharge: "discharge", deploy: "deploy", drone: "drone",
  casualtyPoint: "battle", evacuate: "battle", callAmbulance: "battle", takeKit: "battle", supplyPoint: "battle", resupplyAt: "battle",
  bearers: "battle", prisonerPoint: "battle", escortPrisoners: "battle", releaseGuard: "battle", callMp: "battle", callDelivery: "battle",
  rearRun: "battle", repair: "battle", callRecovery: "battle",
};
/** "That order cannot be carried out like this": the suffix by order kind (`order.rejected.invalid-params.<suffix>`). */
export const REJECT_INVALID: Partial<Record<OrderKind, string>> = {
  move: "move", fire: "point", callFire: "point", grenade: "point", withdraw: "point", casualtyPoint: "point", supplyPoint: "point",
  prisonerPoint: "point", drone: "point", assault: "assault", occupy: "building",
  rearRun: "noVehicle", repair: "noVehicle", callRecovery: "noVehicle", takeKit: "kit", resupplyAt: "onFoot",
};

/** The sentence for a rejected order (its string key; the app gives `{unit}`); null: say nothing. */
export function rejectionText(reason: OrderRejectReason, kind: OrderKind | null): { key: string } | null {
  const base = REJECT_KEYS[reason];
  if (base === null) return null;
  const suffix = kind === null ? undefined : reason === "not-applicable" ? REJECT_NOT_APPLICABLE[kind] : reason === "invalid-params" ? REJECT_INVALID[kind] : undefined;
  return { key: suffix !== undefined ? `${base}.${suffix}` : base };
}

/** Every key `rejectionText` can return (tests: each has a string). */
export function rejectionKeys(): string[] {
  const out = new Set<string>();
  for (const k of Object.values(REJECT_KEYS)) if (k !== null) out.add(k);
  for (const x of Object.values(REJECT_NOT_APPLICABLE)) out.add(`${REJECT_KEYS["not-applicable"]}.${x}`);
  for (const x of Object.values(REJECT_INVALID)) out.add(`${REJECT_KEYS["invalid-params"]}.${x}`);
  return [...out].sort();
}
