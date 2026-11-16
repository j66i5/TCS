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
import type { Behaviour, SurrenderReason, VehicleStatus } from "./components";
import type { DefId, EntityId, SideId } from "./ids";
import type { OrderKind, OrderRejectReason } from "./orders";
import type { BodyZone, WoundMechanism } from "./wounds";

export type SimEvent =
  | { kind: "order.received"; tick: number; seq: number; issuer: SideId; target: EntityId; orderKind: OrderKind; deliverTick: number }
  | { kind: "order.rejected"; tick: number; seq: number; issuer: SideId; target: EntityId; reason: OrderRejectReason }
  | { kind: "order.delivered"; tick: number; seq: number; target: EntityId; orderKind: OrderKind }
  /** The men hesitate over an order (D4b): it is carried out at `deliverTick` instead, unless replaced first. */
  | { kind: "order.hesitating"; tick: number; seq: number; target: EntityId; orderKind: OrderKind; deliverTick: number }
  | { kind: "radio"; tick: number; side: SideId; from: EntityId; key: string; params: Record<string, string | number> }
  | { kind: "unit.arrived"; tick: number; unit: EntityId }
  /** M11.1: a unit arriving late (a wave) has entered the battle. */
  | { kind: "unit.entered"; tick: number; unit: EntityId; side: SideId }
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
  /** `drone` (M9.4a): the observer is a drone's camera (its entity), not a man. */
  | { kind: "spotted"; tick: number; observer: EntityId; target: EntityId; side: SideId; rangeM: number; drone?: true }
  | { kind: "explosion"; tick: number; x: number; y: number; z: number; ammo: DefId; owner: EntityId; stunRadiusM: number }
  /** A grenade with a running fuse has struck the ground (or a wall or roof) at this point; it will burst at burstTick. */
  | { kind: "grenade.landed"; tick: number; x: number; y: number; z: number; ammo: DefId; burstTick: number }
  | { kind: "grenade.launched"; tick: number; soldier: EntityId; ammo: DefId; method: "thrown" | "launched" | "direct"; x: number; y: number }
  | { kind: "terrain.breached"; tick: number; x: number; y: number; owner: "obstacle" | "building"; id: number }
  | { kind: "hit"; tick: number; target: EntityId; zone: BodyZone; armour: "none" | "penetrated" | "stopped"; ammo: DefId; owner: EntityId }
  | { kind: "wound"; tick: number; soldier: EntityId; woundId: number; zone: BodyZone; mechanism: WoundMechanism; severity: number }
  | { kind: "casualty"; tick: number; soldier: EntityId; status: "incapacitated" | "killed" }
  /** A treatment was finished (M10.2): who treated whom, which intervention (core/medical.json id) on which wound,
   *  with what training (`skill`: self, buddy, firstResponder, medic), and whether it worked. */
  | { kind: "medical.treated"; tick: number; casualty: EntityId; by: EntityId; intervention: DefId; wound: number; success: boolean; skill: string }
  /** M10.3a: a man leaves the fight to go to a casualty (`assigned`), or goes back (`reason`: done, handed over to a
   *  first responder, nothing he can do, gave up, unable, casualty dead or gone). */
  | { kind: "medical.carer"; tick: number; casualty: EntityId; by: EntityId; responder: boolean; assigned: boolean; reason?: string }
  /** A casualty was triaged (M10.3b): the tag given (`cat`, 1 = T1 immediate .. 3 = T3 minimal), the true category
   *  at that moment (`actual`; differs when the tag is wrong), by whom, with what training, under fire or not. */
  | { kind: "medical.triaged"; tick: number; casualty: EntityId; by: EntityId; cat: number; actual: number; skill: string; underFire: boolean }
  /** A one-man drag to cover (M10.3b): started (`done` false, with the distance) or ended (`done` true; `reason`
   *  when it was cut short). */
  | { kind: "medical.dragged"; tick: number; casualty: EntityId; by: EntityId; done: boolean; distanceM: number; reason?: string; /** He was in fact dead (his comrades did not know it yet; owner request 2026-11-15). */ deadNow?: true }
  /**
   * A carrying party (M10.4a): `phase` start (set off, with the way's length), hold (took cover under fire), resume,
   * rest, done (with `reason`: arrived, dead, gone, carriers-lost, no-way, gave-up, ordered) and the metres carried.
   */
  | { kind: "medical.carried"; tick: number; payload: EntityId; by: EntityId; method: DefId; carriers: number; phase: "start" | "hold" | "resume" | "rest" | "done"; distanceM: number; reason?: string }
  /** The Verwundetennest (M10.5, rear point `point` of top unit `unit`): sited, or moved (`reason`: threatened, drift,
   *  ordered by the player), now at (x, y). */
  | { kind: "medical.nest"; tick: number; side: SideId; point: EntityId; unit: EntityId; x: number; y: number; reason: "sited" | "threatened" | "drift" | "ordered" }
  /** A casualty on his way to the Verwundetennest (M10.5): `phase` tasked (bearers sent by `by`, `bearers` men),
   *  walks (he goes himself), arrived; returned: fit to fight again after care there, back to his squad (returned to
   *  duty). `ordered`: the player's `evacuate` order. */
  | { kind: "medical.evac"; tick: number; casualty: EntityId; point: EntityId; phase: "tasked" | "walks" | "arrived" | "returned"; by?: EntityId; bearers?: number; ordered?: boolean }
  /**
   * An ambulance run (M10.6a; `vehicle` an off-map asset): `phase` called (by the platoon `unit` for its nest `point`;
   * `ordered`: the player's `callAmbulance`; `dueS`: seconds until it comes onto the map), entered (it is on the map),
   * arrived (at the nest), loaded (`casualty` is aboard), departed (`aboard` men), away (off the map with them),
   * noRoute (it found no way and tries again), lost (stranded on the map: no driver, immobilised or destroyed),
   * cancelled (stood down when it was due: nobody waiting at the nest or on the way there; it waits for the next call).
   */
  | { kind: "medical.ambulance"; tick: number; side: SideId; vehicle: EntityId; phase: "called" | "entered" | "arrived" | "loaded" | "departed" | "away" | "noRoute" | "lost" | "cancelled"; point?: EntityId; unit?: EntityId; casualty?: EntityId; aboard?: number; dueS?: number; ordered?: boolean }
  /** A casualty left the battle in an ambulance that drove off the map (M10.6a): evacuated from then on. */
  /** A man recognised an enemy as protected (M10.7a): newly flagged on his own contact — an emblem (`marked`: an
   *  armband or a marked ambulance), a carrying party, a man at a marked Verwundetennest — at `rangeM`. */
  | { kind: "protection.recognised"; tick: number; side: SideId; observer: EntityId; target: EntityId; marked: boolean; carrying: boolean; atPoint: boolean; rangeM: number }
  /** Laws of war (M10.7b, conduct.ts; never shown live, owner answer 7: the review only). `by` (of `side`) fired at
   *  `target`, who was protected: `misidentified` (he had not recognised it) or `deliberate` (he had). `protection`:
   *  an emblem or marked ambulance ("medical"), a carrying party, a man at the Verwundetennest, or a man giving up
   *  (deliberate only). Circumstances: range (m), light (0..1), the share of light smoke let through on the line, his
   *  stress or suppression (the higher), whether it was the player's or an AI order, and the hull he fired from. */
  | { kind: "law.breach"; tick: number; side: SideId; by: EntityId; target: EntityId; cause: "misidentified" | "deliberate"; protection: "medical" | "carrying" | "point" | "surrendered"; rangeM: number; light: number; smoke: number; stress: number; ordered: boolean; vehicle?: EntityId }
  /** A protected man or marked ambulance hit by fire of `side` (Q-8: incidental hits are a separate list in the review):
   *  `aimed` when the fire was at him; `fragment` a fragment's hit. Never shown live. */
  | { kind: "law.hit"; tick: number; side: SideId; by: EntityId; target: EntityId; protection: "medical" | "carrying" | "point" | "surrendered" | "wounded" | "prisoner"; aimed: boolean; fragment: boolean }
  | { kind: "medical.evacuated"; tick: number; side: SideId; casualty: EntityId; vehicle: EntityId; woundedTick: number; via?: "ambulance" | "vehicle" }
  /**
   * A combat vehicle's rear run (M10.6b, owner Q-9): `phase` started (for the platoon `unit`'s nest `point`; `ordered`:
   * the player's `rearRun`), arrived (at the nest), loaded (`casualty` aboard), departed (`aboard` men), away (off the
   * map, `aboard` handed over), returned (back on the map), back (where it was sent: the run is over), cancelled
   * (nobody to take, or an order ended it), lost (it can no longer drive).
   */
  | { kind: "medical.rearRun"; tick: number; side: SideId; vehicle: EntityId; phase: "started" | "arrived" | "loaded" | "departed" | "away" | "returned" | "back" | "cancelled" | "lost"; point?: EntityId; unit?: EntityId; casualty?: EntityId; aboard?: number; ordered?: boolean }
  /**
   * A wounded man's outcome beyond the battle is settled (M10.6b): he reaches Role 1 (`by` own) or the captor's aid
   * post at `role1Tick` (`inTime`: within `chain.role1S` of his first wound); `recoveryDays`; `diedOfWoundsTick` if he dies of his wounds; `cat` his triage tag then;
   * `woundedTick` his first wound.
   */
  | { kind: "medical.role1"; tick: number; casualty: EntityId; side: SideId; by: "own" | "captor"; role1Tick: number; woundedTick: number; inTime: boolean; recoveryDays: number; diedOfWoundsTick?: number; cat?: 1 | 2 | 3 }
  /** The end-of-battle settlement of a wounded man (M10.6b, owner Q-1e/Q-10): evacuated by his side (it holds the
   *  ground), captured (`holder` holds it), already a prisoner, or stays with his unit (walking wounded). */
  | { kind: "medical.settled"; tick: number; casualty: EntityId; side: SideId; outcome: "evacuated" | "captured" | "prisoner" | "stays"; holder?: SideId }
  /** A man down whose state his side did not know was checked by a comrade (owner request 2026-11-15): `dead` what
   *  the check found; `dragged` he had been dragged to cover before the check. */
  | { kind: "medical.checked"; tick: number; casualty: EntityId; by: EntityId; dead: boolean; dragged: boolean }
  /** A comrade took a dead man's identity tag (owner request 2026-11-15): `count` of `item` moved (transferItems). */
  | { kind: "medical.tagTaken"; tick: number; casualty: EntityId; by: EntityId; side: SideId; item: DefId; count: number }
  /** A conscious casualty who cannot walk crawls to cover (owner request 2026-11-15), a way of `distanceM`. */
  | { kind: "medical.crawled"; tick: number; casualty: EntityId; distanceM: number }
  /** `vehicle`: fired from a vehicle's station (M7.3); the shooter is its operator (the gunner). */
  | { kind: "shot.fired"; tick: number; shooter: EntityId; x: number; y: number; z: number; dirX: number; dirY: number; weapon: DefId; ammo: DefId; vehicle?: EntityId; /** M8.3b: a mortar (high-angle, no flat line of fire) heard out to `loudM` (default: the contacts' hearing range). */ indirect?: true; loudM?: number }
  | { kind: "weapon.reloaded"; tick: number; soldier: EntityId; rounds: number }
  | { kind: "weapon.jammed"; tick: number; soldier: EntityId }
  /** M11.6 batteries: the battery in a man's powered device (`device`, an item id) has gone flat (once per battery);
   *  he changed it (`battery` fitted with `whIn` Wh; the old one went back into his load with `whOut` Wh, 0 if the
   *  device had none). No radio message: a flat radio sends nothing. */
  | { kind: "power.flat"; tick: number; soldier: EntityId; device: DefId; side: SideId }
  | { kind: "power.swapped"; tick: number; soldier: EntityId; device: DefId; battery: DefId; whOut: number; whIn: number }
  /** M11.6: he drank `ml` millilitres from his canteen (`item`; battles of 2 h or more). */
  | { kind: "water.drunk"; tick: number; soldier: EntityId; side: SideId; item: DefId; ml: number }
  | { kind: "fire.ceased"; tick: number; unit: EntityId; reason: "ordered" | "no-target" | "ammunition" | "moved" | "unable" }
  /** A leader rallied a man of his unit (morale rework 2026-11-15): his shock eased, a runner stopped. */
  | { kind: "morale.rally"; tick: number; leader: EntityId; soldier: EntityId }
  | { kind: "behaviour.changed"; tick: number; soldier: EntityId; from: Behaviour; to: Behaviour }
  /** A man has given up (M6.6). `side` is his own. */
  | { kind: "surrendered"; tick: number; soldier: EntityId; side: SideId; reason: SurrenderReason }
  /** A surrendered man sets off, hands up, to give himself up to the enemy soldier `to` (null: toward where he
   *  knows the enemy is). `side` is his own. */
  | { kind: "surrender.walk"; tick: number; soldier: EntityId; side: SideId; to: EntityId | null }
  /** A surrendered man under fire crawls out of the line of fire to cover (owner request 2026-11-15). */
  | { kind: "surrender.crawl"; tick: number; soldier: EntityId; side: SideId; distanceM: number }
  /** A surrendered man has been taken prisoner by the enemy soldier `by`. `side` is the prisoner's. */
  | { kind: "captured"; tick: number; soldier: EntityId; side: SideId; by: EntityId }
  | { kind: "posture.changed"; tick: number; soldier: EntityId; posture: "standing" | "crouching" | "prone" }
  | { kind: "items.transferred"; tick: number; from: EntityId; to: EntityId; item: DefId; count: number }
  /** M11.1: items gone from the battle other than by being fired (`count` items of `item` held by `holder`; the
   *  ammunition in them: `rounds` of `ammo`). The conservation guard reads it (ledger.ts). */
  | { kind: "items.destroyed"; tick: number; holder: EntityId; item: DefId; count: number; ammo?: DefId; rounds?: number; cause: string }
  /** M11.1: items that came into the battle from off the map (`count` items of `item` to `holder`; the ammunition in
   *  them: `rounds` of `ammo`). */
  | { kind: "items.delivered"; tick: number; holder: EntityId; item: DefId; count: number; ammo?: DefId; rounds?: number }
  /** M11.1: a man loaded `rounds` loose rounds into a magazine (refillMagazines). */
  | { kind: "items.refilled"; tick: number; soldier: EntityId; item: DefId; rounds: number }
  | { kind: "action.started"; tick: number; actor: EntityId; action: string; durationTicks: number }
  | { kind: "action.completed"; tick: number; actor: EntityId; action: string }
  | { kind: "action.interrupted"; tick: number; actor: EntityId; action: string; reason: string }
  | { kind: "battle.ended"; tick: number; reason: BattleEndReason; /** The side that lost by breaking or being wiped out. */ loser?: SideId }
  | { kind: "support.smoke"; tick: number; x: number; y: number; radiusM: number; side: SideId }
  /** A hand smoke grenade starts to smoke (D1). */
  | { kind: "smoke.grenade"; tick: number; x: number; y: number; radiusM: number; ammo: DefId; owner: EntityId }
  /** A ranging round of a fire mission has landed (step fire-support): where (x, y), the point called (tx, ty), how
   *  far off it fell (m), whether the man who called it saw it fall (then the next rounds come closer), ranging
   *  rounds still to come. */
  /** M8.2a call-for-fire chain: a mission begins (how the point was located, the first round's aiming error per
   *  axis, seconds until it lands); a round leaves the tube ("shot", seconds of flight); a round lands in `inS`
   *  ("splash"). */
  | { kind: "support.call"; tick: number; side: SideId; caller: EntityId; x: number; y: number; ammo: "he" | "smoke" | "illum"; method: "estimate" | "laser" | "registered" | "drone" | "air"; errorM: number; firstS: number; /** M8.4 */ asset?: "artillery"; dangerClose?: true }
  /** M8.6: a round of a fire mission lands (for the review's tally: which asset, which kind). */
  | { kind: "support.round"; tick: number; side: SideId; asset: "mortar" | "artillery"; ammo: "he" | "smoke" | "illum"; x: number; y: number; /** M11.1: an off-map round's item (absent: an on-map tube's round, counted at its shot). */ item?: DefId; /** M9.6: how the mission's target was located. */ method?: "estimate" | "laser" | "registered" | "drone" | "air" }
  /** M8.4: an illumination flare is ejected over (x, y); it burns `burnS` (its light: flares.ts, M9.6). */
  | { kind: "support.illum"; tick: number; x: number; y: number; side: SideId; burnS: number }
  | { kind: "support.shot"; tick: number; side: SideId; caller: EntityId; x: number; y: number; flightS: number }
  | { kind: "support.splash"; tick: number; side: SideId; caller: EntityId; x: number; y: number; inS: number }
  /** M8.3a on-map mortars: a team starts setting up its tube (ready at `readyTick`), is ready, has packed up to move;
   *  a tube fires a round (where from, where it is aimed, which round, seconds of flight). */
  /** M9.4a reconnaissance quadcopters: launched (its operator flies it), landed and recovered by a man, lost (empty
   *  battery, or nobody there when it came home). */
  | { kind: "drone.launched"; tick: number; drone: EntityId; operator: EntityId; side: SideId; /** M9.6: the drone's item type. */ item?: DefId; /** M11.6: its battery's charge at launch, Wh. */ wh?: number }
  | { kind: "drone.landed"; tick: number; drone: EntityId; side: SideId; by: EntityId; /** M11.6: its battery's charge at landing, Wh. */ wh?: number }
  | { kind: "drone.lost"; tick: number; drone: EntityId; side: SideId; reason: "battery" | "noOperator" | "shot"; /** M9.6: the man whose round brought it down (reason "shot"). */ by?: EntityId }
  | { kind: "mortar.setup"; tick: number; unit: EntityId; readyTick: number }
  | { kind: "mortar.ready"; tick: number; unit: EntityId }
  | { kind: "mortar.packed"; tick: number; unit: EntityId }
  /** A dismounted missile team (M9.3b) sets up its launch post, is ready, packs up. */
  | { kind: "missileTeam.setup"; tick: number; unit: EntityId; readyTick: number }
  | { kind: "missileTeam.ready"; tick: number; unit: EntityId }
  | { kind: "missileTeam.packed"; tick: number; unit: EntityId }
  | { kind: "mortar.fired"; tick: number; side: SideId; unit: EntityId; gunner: EntityId; x: number; y: number; tx: number; ty: number; ammo: DefId; flightS: number }
  | { kind: "support.ranging"; tick: number; side: SideId; caller: EntityId; x: number; y: number; tx: number; ty: number; ammo: "he" | "smoke" | "illum"; seen: boolean; missM: number; left: number; /** M8.2b: who read the fall (a man, a vehicle sight; a drone from M9.5). */ observer?: EntityId; observerKind?: "man" | "vehicle" | "drone" | "air" }
  /**
   * A projectile struck a vehicle (M7.1c: every round stops at the hull). Rounds below 12.7 mm are aggregated:
   * one event per vehicle per tick with `rounds` = how many (first round's ammo, owner and point).
   */
  | {
      kind: "vehicle.hit"; tick: number; vehicle: EntityId; x: number; y: number; z: number;
      face: "front" | "side" | "rear" | "top"; zone: "hull" | "turret";
      result: "ricochet" | "stopped" | "penetrated" | "intercepted"; ammo: DefId; owner: EntityId; rounds: number; components: number[];
      /** M7.6a: an add-on tile on that face was used up by this hit (its item). */
      era?: DefId;
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
  /** Field repair (M11.7a): a crew started, stopped (`why`: hit, underFire, moving, burning, bailOut, unable,
   *  ordered), resumed, finished (`status` afterwards; `parts` used up) or failed (beyond the crew) a repair of
   *  component `component` (kind `part`); `etaS`: work left at the start (s). */
  | {
      kind: "vehicle.repair"; tick: number; vehicle: EntityId; component: number; part: string;
      phase: "started" | "interrupted" | "resumed" | "done" | "failed"; why?: string; status?: VehicleStatus; etaS?: number; ordered?: true;
      parts?: { item: DefId; count: number }[];
    }
  /** Recovery (M11.7b): recovery vehicle `vehicle` of `side` for hull `target`: called (comes on in about `dueS`),
   *  entered the map, waiting short of a hull under fire, arrived at it, hooked it up, departed with it, away off the
   *  map, lost (stranded), cancelled (`why`: notNeeded, underFire, noRoute), noRoute. */
  | {
      kind: "vehicle.recovery"; tick: number; side: SideId; vehicle: EntityId; target: EntityId;
      phase: "called" | "entered" | "waiting" | "arrived" | "hookedUp" | "departed" | "away" | "lost" | "cancelled" | "noRoute";
      dueS?: number; ordered?: true; why?: string;
    }
  /** End-of-battle settlement of a hull (M11.7b): recovered by its side, captured (`by`), or lost (destroyed). */
  | { kind: "vehicle.settled"; tick: number; vehicle: EntityId; side: SideId; state: "towed" | "recovered" | "captured" | "lost"; by?: SideId }
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
  | { kind: "vehicle.smoke"; tick: number; vehicle: EntityId; x: number; y: number ; /** M11.1: the grenades of the salvo (they left the container at the order). */ item?: DefId; count?: number }
  /** A vehicle station's decision changed (M7.3; debug overlay): its target (if any) and the reasons (string keys). */
  | { kind: "vehicle.decision"; tick: number; vehicle: EntityId; station: number; target: EntityId | null; x: number; y: number; nature: "ap" | "he" | "mg" | "atgm" | null; keys: string[] }
  /** A guided missile's flight ended (owner 2026-11-13): it struck its target vehicle ("hit"), burst elsewhere or
   *  flew off the map ("miss"), or its gunner lost it ("lost": `reason` key; it flies on unguided). */
  | { kind: "missile.ended"; tick: number; vehicle: EntityId; station: number; ammo: DefId; target: EntityId; result: "hit" | "miss" | "lost"; reason?: string; team?: undefined; gunner?: undefined }
  /** M9.3b: the same for a missile guided from a team's tripod: the team and its gunner instead of a vehicle. */
  | { kind: "missile.ended"; tick: number; team: EntityId; gunner: EntityId; ammo: DefId; target: EntityId; result: "hit" | "miss" | "lost"; reason?: string; vehicle?: undefined; station?: undefined }
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
