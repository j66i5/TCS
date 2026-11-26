/**
 * The app's shared state (D2, the `main.ts` split): the battle, the renderer and HUD, and what the player is doing
 * (the order mode, a plan, a gesture, the man whose box is open, the unit followed). `main.ts` builds one and the
 * modules beside it (orders, camera, panels, controls, keys, review, save, debug hooks) read and change it.
 * Nothing here reaches into the simulation except through orders (rule 3) and read-only views.
 */
import type { Strings } from "@tcs/data";
import type { BattleInput, BattleRecord, Controller, EntityId, Order, Sim } from "@tcs/sim";
import type { BattleRenderer, Overlay } from "@tcs/render";
import type { Aar, BriefingModel, FloorFollow, Handle, Hud, LastSeenBook, LosLine, OrderMode, Plan, PlanKind, RangingBook, UnitRules } from "@tcs/ui";

export type Pt = { x: number; y: number };
export type MoveOrder = Extract<Order, { kind: "move" }>;

/** A press being dragged on the map (the "controls" step, owner choices S1, S2, S9, S10, S11). */
export type Gesture =
  | { kind: "plan" }
  /** S1: dragging out from the selected unit; `plan` is the ghost (null while the pointer is still on the unit). */
  | { kind: "fromUnit"; planKind: PlanKind; plan: Plan | null; from: Pt; left: boolean; right?: Pt; clear?: true }
  /** S10: an active move's marker; `onUnit`: dropped now it would halt. */
  | { kind: "marker"; prev: MoveOrder; at: Pt; from: Pt; onUnit: boolean }
  /** S9: the facing handle; `angle` null until it was turned. */
  | { kind: "facing"; centre: Pt; angle: number | null; start: number; dist: number }
  /** S2: a fire order held; `onUnit`: back on the unit (release cancels). */
  | { kind: "fire"; at: Pt; onUnit: boolean; los: LosLine[] }
  /** S11: a point held for fire support (letting go opens the HE / smoke pop-up there). */
  | { kind: "support"; at: Pt; from: Pt }
  /** M10.5: the Verwundetennest's marker dragged (letting go moves it there: a `casualtyPoint` order to `unit`). */
  | { kind: "nest"; unit: EntityId; from: Pt; at: Pt }
  /** M11.3: the supply point's marker dragged (letting go moves it there: a `supplyPoint` order to `unit`). */
  | { kind: "supply"; unit: EntityId; from: Pt; at: Pt };

export interface App {
  readonly input: BattleInput;
  readonly sim: Sim;
  readonly strings: Strings;
  readonly renderer: BattleRenderer;
  hud: Hud;
  readonly overlay: Overlay;
  readonly playerSide: string;
  readonly ai: Controller[];
  /** Every order sent, the AI's included (debug hook). */
  readonly orderLog: Order[];
  readonly defaultFormation: string;
  readonly doctrineSpacing: number;
  /** The after-action record so far (D2): the review and the save use it. */
  record: BattleRecord;
  /** The after-action review (null until the HUD is built). */
  review: Aar | null;

  /** Review step 5: the battle's briefing (null until the HUD is built): the card, open or not, its model. */
  briefing: { isOpen(): boolean; mode(): "start" | "resume"; open(mode: "start" | "resume"): void; close(): void; model: BriefingModel } | null;

  speed: number;
  pace: string;
  orderMode: OrderMode;
  /** Gun and round of the next fire order to a vehicle (M7.3; null = the crew chooses). */
  nature: "ap" | "he" | "ab" | "mg" | null;
  plan: Plan | null;
  dragHandle: Handle | null;
  dragGapM: number;
  /** Undefined until the player picks one: then the faction's doctrine default applies. */
  formation: string | undefined;
  /** S6: the man whose detail box is open (one of the selected unit's men), or null. */
  inspected: EntityId | null;
  /** S14: the contour toggle (remembered on this device). */
  contoursOn: boolean;
  /** S5: the unit the camera follows (null: none). */
  following: EntityId | null;
  gesture: Gesture | null;
  /** S11: the point picked for fire support, while its pop-up is open (M8.6: or the line of a smoke screen). */
  supportAt: (Pt & { x2?: number; y2?: number }) | null;
  /** Review fix (S9): a turn sent and not yet under way (the radio delay): the handle stays where it was let go. */
  pendingTurn: { uid: EntityId; angle: number; tick: number } | null;
  /** Rules ordered for a unit and not yet in force there (shown as chosen meanwhile). */
  readonly pendingRules: Map<EntityId, Partial<UnitRules>>;
  /** The last move the player sent to each unit (its marker can be dragged, S10). */
  readonly activeMoves: Map<EntityId, MoveOrder>;
  /** M7.5d: the floor shown, and one picked on the switch this frame. */
  floorState: FloorFollow;
  floorPick: number | null;
  /** Screenshots (M7.5e): draw the enemy as he is, without Debug's grid and sight overlays. */
  revealAll: boolean;
  /** Claim victory was offered (the radio said so once; review 2026-11-24 problem 3). */
  claimOffered?: boolean;
  /** Debug sight overlay: the tick it was last drawn. */
  sightAt: number;
  /** S8 "last seen" pins and S11 ranging falls (from the side's own contacts and events). */
  readonly lastSeen: LastSeenBook;
  readonly rangingBook: RangingBook;
  /** The order bar's last contents (rebuilt only when the selected unit's capabilities change). */
  ordersShownFor: string | undefined;
  ordersKey: string;
}
