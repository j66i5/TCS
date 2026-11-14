/**
 * THE EVENT STREAM (SPEC 4.3 rule 5).
 *
 * Each tick returns the events that happened in it. The renderer, sound, the radio log, the after-action
 * review, the campaign and the tools consume events; they never reach into simulation internals to find
 * out what happened. Events are outputs, not state: they are not saved, and a loaded save produces the
 * same future events as the original run.
 *
 * Text is never put in events. Radio messages carry a string-table key and parameters, so the UI can
 * render them in any language and in the faction's own phrasing (SPEC 4.3 rule 12).
 */
import type { Behaviour, SurrenderReason } from "./components";
import type { DefId, EntityId, SideId } from "./ids";
import type { OrderKind, OrderRejectReason } from "./orders";
import type { BodyZone, WoundMechanism } from "./wounds";

export type SimEvent =
  | { kind: "order.received"; tick: number; seq: number; issuer: SideId; target: EntityId; orderKind: OrderKind; deliverTick: number }
  | { kind: "order.rejected"; tick: number; seq: number; issuer: SideId; target: EntityId; reason: OrderRejectReason }
  | { kind: "order.delivered"; tick: number; seq: number; target: EntityId; orderKind: OrderKind }
  | { kind: "radio"; tick: number; side: SideId; from: EntityId; key: string; params: Record<string, string | number> }
  | { kind: "unit.arrived"; tick: number; unit: EntityId }
  | { kind: "move.noRoute"; tick: number; target: EntityId }
  | {
      kind: "impact"; tick: number; x: number; y: number; z: number;
      surface: "ground" | "obstacle" | "building" | "vegetation" | "vehicle";
      result: "stopped" | "penetrated" | "ricochet";
      /** Material ID struck; for surface "vegetation" the vegetation kind's ID. */
      material: DefId; ammo: DefId; owner: EntityId;
    }
  /** dirX, dirY: horizontal unit direction of the shot. */
  /** A projectile struck a soldier. armour: none worn there / penetrated / stopped the round. */
  /** An observer has spotted an enemy he was not already watching. */
  | { kind: "spotted"; tick: number; observer: EntityId; target: EntityId; side: SideId; rangeM: number }
  | { kind: "explosion"; tick: number; x: number; y: number; z: number; ammo: DefId; owner: EntityId; stunRadiusM: number }
  /** A grenade with a running fuse has struck the ground (or a wall or roof) at this point; it will burst at burstTick. */
  | { kind: "grenade.landed"; tick: number; x: number; y: number; z: number; ammo: DefId; burstTick: number }
  | { kind: "grenade.launched"; tick: number; soldier: EntityId; ammo: DefId; method: "thrown" | "launched" | "direct"; x: number; y: number }
  | { kind: "terrain.breached"; tick: number; x: number; y: number; owner: "obstacle" | "building"; id: number }
  | { kind: "hit"; tick: number; target: EntityId; zone: BodyZone; armour: "none" | "penetrated" | "stopped"; ammo: DefId; owner: EntityId }
  | { kind: "wound"; tick: number; soldier: EntityId; woundId: number; zone: BodyZone; mechanism: WoundMechanism; severity: number }
  | { kind: "casualty"; tick: number; soldier: EntityId; status: "incapacitated" | "killed" }
  /** `vehicle`: fired from a vehicle's station (M7.3); the shooter is its operator (the gunner). */
  | { kind: "shot.fired"; tick: number; shooter: EntityId; x: number; y: number; z: number; dirX: number; dirY: number; weapon: DefId; ammo: DefId; vehicle?: EntityId }
  | { kind: "weapon.reloaded"; tick: number; soldier: EntityId; rounds: number }
  | { kind: "weapon.jammed"; tick: number; soldier: EntityId }
  | { kind: "fire.ceased"; tick: number; unit: EntityId; reason: "ordered" | "no-target" | "ammunition" | "moved" | "unable" }
  | { kind: "behaviour.changed"; tick: number; soldier: EntityId; from: Behaviour; to: Behaviour }
  /** A man has given up (M6.6). `side` is his own. */
  | { kind: "surrendered"; tick: number; soldier: EntityId; side: SideId; reason: SurrenderReason }
  /** A surrendered man has been taken prisoner by the enemy soldier `by`. `side` is the prisoner's. */
  | { kind: "captured"; tick: number; soldier: EntityId; side: SideId; by: EntityId }
  | { kind: "posture.changed"; tick: number; soldier: EntityId; posture: "standing" | "crouching" | "prone" }
  | { kind: "items.transferred"; tick: number; from: EntityId; to: EntityId; item: DefId; count: number }
  | { kind: "action.started"; tick: number; actor: EntityId; action: string; durationTicks: number }
  | { kind: "action.completed"; tick: number; actor: EntityId; action: string }
  | { kind: "action.interrupted"; tick: number; actor: EntityId; action: string; reason: string }
  | { kind: "battle.ended"; tick: number; reason: BattleEndReason; /** The side that lost by breaking or being wiped out. */ loser?: SideId }
  | { kind: "support.smoke"; tick: number; x: number; y: number; radiusM: number; side: SideId }
  /** A ranging round of a fire mission has landed (step fire-support): where (x, y), the point called (tx, ty), how
   *  far off it fell (m), whether the man who called it saw it fall (then the next rounds come closer), ranging
   *  rounds still to come. */
  /** M8.2a call-for-fire chain: a mission begins (how the point was located, the first round's aiming error per
   *  axis, seconds until it lands); a round leaves the tube ("shot", seconds of flight); a round lands in `inS`
   *  ("splash"). */
  | { kind: "support.call"; tick: number; side: SideId; caller: EntityId; x: number; y: number; ammo: "he" | "smoke"; method: "estimate" | "laser" | "registered"; errorM: number; firstS: number }
  | { kind: "support.shot"; tick: number; side: SideId; caller: EntityId; x: number; y: number; flightS: number }
  | { kind: "support.splash"; tick: number; side: SideId; caller: EntityId; x: number; y: number; inS: number }
  | { kind: "support.ranging"; tick: number; side: SideId; caller: EntityId; x: number; y: number; tx: number; ty: number; ammo: "he" | "smoke"; seen: boolean; missM: number; left: number }
  /**
   * A projectile struck a vehicle (M7.1c: every round stops at the hull). Rounds below 12.7 mm are aggregated:
   * one event per vehicle per tick with `rounds` = how many (first round's ammo, owner and point).
   */
  | {
      kind: "vehicle.hit"; tick: number; vehicle: EntityId; x: number; y: number; z: number;
      face: "front" | "side" | "rear" | "top"; zone: "hull" | "turret";
      result: "ricochet" | "stopped" | "penetrated" | "intercepted"; ammo: DefId; owner: EntityId; rounds: number; components: number[];
    }
  /** A penetrating hit damaged a component (M7.4a): its condition now (0 = wrecked). */
  | { kind: "vehicle.component"; tick: number; vehicle: EntityId; component: number; condition: number }
  /** A vehicle caught fire (M7.4a). */
  | { kind: "vehicle.fire"; tick: number; vehicle: EntityId }
  /** Its extinguisher put a fire out (M7.4b). */
  | { kind: "vehicle.extinguished"; tick: number; vehicle: EntityId }
  /** A crew's reaction to damage or danger (M7.4b): what it does and why (string keys; debug overlay). */
  | { kind: "vehicle.reaction"; tick: number; vehicle: EntityId; reaction: "reverseOut" | "continue" | "bailOut"; keys: string[] }
  /** A vehicle can no longer move ("immobilised") or fire ("disarmed") (M7.4a). */
  | { kind: "vehicle.status"; tick: number; vehicle: EntityId; status: "immobilised" | "disarmed" }
  /** A vehicle is destroyed (M7.4a): its ammunition blew up, or it burnt out. */
  | { kind: "vehicle.destroyed"; tick: number; vehicle: EntityId; cause: "cookOff" | "burnt" }
  /** Its crew (and passengers) bailed out, or its crew is out of action (M7.4a, owner Q14/Q15). */
  | { kind: "vehicle.abandoned"; tick: number; vehicle: EntityId; reason: string }
  /** A vehicle drove over (and, if it flattens it, through) a wall, fence or hedge. */
  | { kind: "vehicle.crossed"; tick: number; vehicle: EntityId; obstacle: number }
  /** A vehicle ran over a man. */
  | { kind: "vehicle.ranOver"; tick: number; vehicle: EntityId; soldier: EntityId }
  /** A man got into (or out of) a vehicle seat (M7.2); a unit's boarding is complete. */
  | { kind: "soldier.mounted"; tick: number; soldier: EntityId; vehicle: EntityId; seat: number }
  | { kind: "soldier.dismounted"; tick: number; soldier: EntityId; vehicle: EntityId; seat: number }
  | { kind: "unit.mounted"; tick: number; unit: EntityId; vehicle: EntityId }
  | { kind: "unit.dismounted"; tick: number; unit: EntityId; vehicle: EntityId }
  /** A crewman took over the seat of a fallen one (M7.2); the casualty stays aboard in the seat he left. */
  | { kind: "vehicle.seatSwap"; tick: number; vehicle: EntityId; seat: number; soldier: EntityId; casualty: EntityId }
  /** A vehicle's smoke dischargers fired (M7.3): the screen's centre. */
  | { kind: "vehicle.smoke"; tick: number; vehicle: EntityId; x: number; y: number }
  /** A vehicle station's decision changed (M7.3; debug overlay): its target (if any) and the reasons (string keys). */
  | { kind: "vehicle.decision"; tick: number; vehicle: EntityId; station: number; target: EntityId | null; x: number; y: number; nature: "ap" | "he" | "mg" | "atgm" | null; keys: string[] }
  /** A guided missile's flight ended (owner 2026-11-13): it struck its target vehicle ("hit"), burst elsewhere or
   *  flew off the map ("miss"), or its gunner lost it ("lost": `reason` key; it flies on unguided). */
  | { kind: "missile.ended"; tick: number; vehicle: EntityId; station: number; ammo: DefId; target: EntityId; result: "hit" | "miss" | "lost"; reason?: string }
  | { kind: "objective.changed"; tick: number; objective: string; holder: SideId | null; from: SideId | null };

export type SimEventKind = SimEvent["kind"];

export type BattleEndReason = "time-limit" | "side-eliminated" | "side-broken" | "scenario";

/** Collects events during a tick. */
export class EventSink {
  readonly events: SimEvent[] = [];
  emit(e: SimEvent): void {
    this.events.push(e);
  }
}
