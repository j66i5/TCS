# M7 Vehicles: architecture and slice plan (Puma, BMP-2, Panzerfaust 3, RPG-7), revision 2

This plan is for the implementing engineer to follow as written. It keeps the base of design 3 ("hot paths and invariants first") and deals with all 68 critic points. Every WRONG and MISSING point is fixed in the section it concerns, and every RISK point has a mitigation in §17. Each fix carries its critic number as **[Cn]**. File and symbol names were checked against the code on 2026-11-12. Line numbers have moved since M6.6, so the plan names symbols, not lines.

**Progress (kept current):** M7.1a ✅, M7.1b ✅, M7.1c ✅, M7.2 ✅, M7.3 ✅, M7.4a ✅, **M7.4b ✅** (2026-11-12) —
**M7 done**. What was decided where the plan was open, and what moved on, is in DECISIONS.md ("M7.2 part 1/2/3",
"M7.3", "M7.4a", "M7.4b"). Still open after M7: Uint8/Uint16 vehicle grids (Float32 kept), the APS pre-check in the
hot loop (the fixture's APS acts in the hit resolution instead), a failed intercept re-added next tick (it strikes at
once), spall-free "path only" not needed. Next: M7.5 Look and interface.

**Current facts the plan depends on (checked):**
- `STATE_SCHEMA_VERSION = 15` (`packages/sim/src/state.ts`). `STORE_KEYS = identity, transform, mover, soldier, unit, container, action, weapon, fire`.
- `step()` system order is in `packages/sim/src/sim.ts`. `surrenderSystem` runs before `decisionSystem`.
- `projectileSystem` (`systems/ballistics.ts`):
  - returns early with `if (P.count === 0) return;` before it fills the SoldierGrid; `SG.sideOf` is filled in the same loop;
  - its coarse loop reads `wallNear[kk]` and `solNear[kk]` as two separate loads;
  - `if (am.explosive) { nearSoldier = false; nearVeg = false; }` turns the body test off for every explosive round;
  - `settle(…, surface: "ground" | "obstacle" | "building")`.
- `removeProjectile` swaps the last row into the freed slot (`projectiles.ts`).
- `incomingFireSystem` and one more fire loop return early with `if (state.fire.size === 0) return;` (`systems/fire.ts`).
- `friendInLine` loops `unitSoldiers(top)`.
- `syncTerrainDamage` does `ctx.nav = {}` (`systems/explosions.ts`).
- `buildNavGrid` hard-codes the vehicle hole width with `cls !== "foot" && b.widthM < 3`. `exposureMap` reads walls and buildings within `COVER_NEAR_M = 4 m`, and cover grids multiply the cost by that exposure.
- `TerrainState.breaches = {owner: "obstacle"|"building", id, part, offsetM, widthM, tick}[]`. `applyBreaches` adds each breach as a `"door"` opening to its segment (`ballistics.ts`).
- `buildDropTable(catalog, ammoId, v0, maxRangeM = 1500)` exists, but `dropAt` caches by `${ammoId}@${v0}` and always builds with the 1500 m default.
- `noProv` in `packages/data/src/catalog.ts` strips provenance at the top level only. `buildCatalog` copies `posture` and `exertion` of every movement mode unconditionally.
- `Unit` holds `fireRule, maxEngageM, onContact, ammoRule, underFireTick, ceaseFireTick, contactTick, moveTick, orderTick, drill, broken`. `Drill = {kind: "assault"|"withdraw"|"rout", x, y, groups, mover, phaseTick, final}`.
- `Controller.think(view: SimView, tick)` receives no events.
- `simpleComms.update` sets every unit's `link = "radio"` each second.
- `applyOrder` returns `boolean | "unable"`. `deliverOrders` maps that result to `radio.ack.*`, `radio.unable` or `radio.noRoute`.
- `Environment = {timeOfDaySeconds, light, windX, windY, rain, visibilityM, temperatureC}`.
- Unit templates list sub-units as an array of template ids (`subunits: ["motor-rifle-squad", …]`). The ru `motor-rifle-platoon` is a platoon commander plus 3 squads of 6 men.
- `willingnessToDismount` is 0.5 in both `factions/de/doctrine.json` and `factions/ru/doctrine.json`.
- Obstacle defs with `wheeledCrossable` / `trackedCrossable` are built in `sim/test/helpers.ts` and `sim/test/grenades.test.ts`.
- The architecture test allows `ai` to import only `sim`, and it scans `sim, ai, render, ui` for faction literals.
- `docs/ARCHITECTURE.md` foundation table has the row "9.2 | Vehicles have fuel and component states | — | ⬜ M7 | —".
- `npm test` excludes `**/perf*.test.ts`. `test:perf` names `perf.test.ts` and `perf-projectiles.test.ts`.
- Existing data ids:
  - weapons `de-g36, de-mg5, de-g28, de-g95a1, ru-ak74m, ru-pkp, ru-ak12` (there is no MG4);
  - materials `steel, sheet-metal, wire-mesh, concrete, reinforced-concrete, brick, stone, wood, soil, hedge, glass, water`;
  - movement modes `walk, run, sneak, crawl, wheeled, tracked`;
  - obstacles `brick-wall, stone-wall, concrete-wall, wooden-fence, wire-fence, hedge, embankment`;
  - inert items `de-pzf3`, `ru-rpg7`, `ru-pg7vl`.
- `state.smoke` = `{x, y, radiusM, startTick, untilTick}[]`. `Contact` = `{target, x, y, errM, kind, tick, reportedTick, surrendered?}`. `SoldierState.captive` exists.

---

## 1. Overview and invariants

**What a vehicle is.** A vehicle is an entity **V**. It has a `transform` (hull pose), a `container` and one entry in a new store `vehicle`. The container holds stowed belts, fuel, smoke charges, extinguisher charges and any reserved add-on or APS items (rule 9). **V has no Identity, Mover, SoldierState, WeaponState or FireTask.** So every existing loop over `identity`, `soldier`, `mover`, `weapon` or `fire` ignores it by construction.

**The vehicle is a roster asset, not a unit property [C30].** Vehicle records live at force level, in `ForceInput.vehicles`. The crew unit points to its vehicle by `vehicleId`. If the crew is killed or the campaign reassigns it, the vehicle record (identity, damage, load) still comes out in `ForceResult.vehicles`.

**Command.** A vehicle is commanded through an ordinary `Unit`, the crew unit:
- echelon `"vehicle"` and the new field `Unit.vehicle: V`;
- members are the crew soldiers, in station order commander, gunner, driver;
- it is a child of the platoon for organisation (radio, roster, the AI's pairing, the "side broken" count).

**Fire control is the crew unit's own [C19].** A new helper `fireTop(state, unit)` returns the crew unit itself for crew units and `topUnit` for everyone else. Every place that today reads `topUnit(u).underFireTick`, `ceaseFireTick`, `fireRule` or `maxEngageM` for fire decisions reads `fireTop` instead (decisions.ts, fire.ts, drills.ts). The effects are:
- A ceaseFire to a squad never silences an IFV.
- A ceaseFire or rules order addressed to the platoon reaches its vehicle children explicitly, through the order split in §11. That split applies `fireRule`, `onContact` and `atRule`, but keeps the vehicle's own `maxEngageM` unless the order is addressed to the vehicle unit itself. So the platoon's 300 m does not bind the 30 mm.
- Hits on the hull stamp both the crew unit and the platoon top unit's `underFireTick` and `contactTick`. The platoon still knows it is under fire.
- Contact sharing and `friendInLine` stay platoon-wide (with the mounted gate, §7).

**Mounted men stay soldiers.**
- They get one optional field, `SoldierState.mount = {vehicle, seat}`, which is absent when not mounted.
- They keep their Transform (copied from the seat every tick) and their `Identity.unit`.
- Two helpers in the new `packages/sim/src/mount.ts`, `isMounted(s)` and `isExposed(s)`, gate every soldier loop.
- The guard is twofold [C28, C52]: a widened source scan (A7, §15 M7.1c) and a runtime test (`mounted-invariants`, §15 M7.2).

**Invariants (all mandatory):**
1. **Determinism (rule 1).**
   - Everything history-dependent lives in state: per-track speeds, yaw rate, gear, shift timer, stuck/yield timers, laid tick, fire timer, crossing, fuel accumulator, boarding queues.
   - Derived tables are rebuilt from state at fixed points of the tick and after `loadSim`: the VehicleGrid, the vehicle bits of the near byte, the wreck stamps in the nav grids, the per-type `VehicleRT`.
   - Stores are iterated in ID order. State has no `Record`/`Map` keyed by id: arrays only.
   - The new RNG streams `armour`, `station` and `antitank` are created lazily, so vehicle-free battles draw exactly as today.
2. **Maths (rule 2).** sin, cos, sqrt, atan2, pow and exp only through `sim/math.ts`.
3. **Orders (rule 3).** Every new action (reverse, mount, dismount, discharge) is an order kind through `submitOrder`. **No lab or test hook writes drive state from outside [C18, C56].** Labs drive vehicles with `move` orders from a scripted controller. Pure dynamics tests call the exported pure function `stepDriveDynamics(def, drive, cmd, surface, dt)`, which works on a local copy and is never wired into `step()`.
4. **Serialisable state (rule 4).** Plain data only. Schema 15 → 16 in M7.1b declares every vehicle field known today. A later slice that must change shape (the ABM fuse column, a VHQ outcome field) bumps again and logs it in DECISIONS.md. That is expected, not exceptional [C64].
5. **Events (rule 5).** Render, UI and tools learn of vehicle actions only through events (`vehicle.hit`, `vehicle.component`, `vehicle.destroyed`, `soldier.mounted`, …). The **AI controller** reads `SimView` plain state as it does today, because `Controller.think` gets no events [C35]. The fields it reads are listed in §12. The architecture rule "render/UI/tools consume events, never internals" is unchanged.
6. **Projectile pool (rule 6).** No pool rows are added inside the projectile loop. Hull hits, APS intercepts and over-penetrations are queued and resolved after the loop. Rows are added after the loop, like bursts [C44].
7. **Units (rule 7).** SI inside the sim. `*Kmh` and `*Deg` appear only where the schema names them, and `buildCatalog` converts them.
8. **No faction in code (rule 8).** Station kinds (`commander | gunner | driver | loader | passenger`) are generic code keys. The architecture test is widened to `de-`/`ru-`/`xf-` prefixed ids and to `packages/scenario`. The fixture `xf` gets a deliberately unlike vehicle.
9. **Counted items (rule 9). One source of truth per consumable [C25, C49].**
   - Ready belts live in station feeds, moved to and from the container by `transferItems`.
   - Fuel is the tank item's charge in litres. `fuelAccL` is only the sub-litre remainder not yet removed, never a second count.
   - Smoke, extinguisher, reactive-tile and APS charges are counted **only** in V's container, tagged per face by item id. VehicleState stores no copy of these counts.
   - Conservation tests cover each.
10. **Wounds (rule 10).** Crew and passengers are wounded through `resolveBodyHit`, `applyBlast` and the new `applyBurn`. A casualty stays in his seat as an entity.
11. **Battle input and result (rule 11).** `VehicleRecord`s go in at force level and come out at force level (§2.5), together with wrecks and captured equipment as data (§2.5).
12. **Strings (rule 12).** Every new text is a key in `core/strings.en.json`, with an `xf` override for one new key.
13. **Projectile owner.** The owner of every round a vehicle fires is the **gunner soldier**. Every side lookup through Identity, `SG.sideOf`, fog and the heat map therefore keep working. `shot.fired` and `vehicle.hit` gain an optional `vehicle` field. Hearing, contacts, the AAR's expenditure split and the own-hull skip use `vehicle` / `platformOf(owner)`.
14. **Hot loop.** Vehicles cost one bit in a byte the loop already reads. Rounds that cannot beat the thinnest plate exit inline with no function call.

**Single penetration scale.**
- Everything is in **mild-steel-equivalent mm** (the `steel` material is resistance 1.0).
- `core/ballistics.json` gets `"rhaToMildSteel": 1.25` (game value, low). Every published RHA figure is multiplied by it in the data, with a note.
- The new material `armour-steel` has resistance 1.25. A test asserts that the two numbers are equal.
- **Penetration is `can ≥ need`** [C43]. Converted figures are kept to the decimal (106 RHA → 132.5, not 132). A published "x mm RHA at angle" round against the same plate is then decided exactly at the published boundary.

---

## 2. State and components (schema 16, M7.1b)

### 2.1 New store `vehicle`
Add the store to `SimState`, `STORE_KEYS`, `createState` and `deserializeState`. Set `STATE_SCHEMA_VERSION = 16`.

```ts
// packages/sim/src/components.ts
export type VehicleStatus = "ok" | "immobilised" | "disarmed" | "abandoned" | "destroyed";
export type StationKind = "commander" | "gunner" | "driver" | "loader" | "passenger";

// Waypoint gains a per-leg flag [C20]: Waypoint {x, y, mode, reverse?: true}

export interface DriveState {
  // Tracked: per-track ground speeds (signed m/s, + forward). Body speed and yaw rate derive from them [C15].
  trackL: number; trackR: number;
  speed: number;            // signed m/s along heading (= (L+R)/2 tracked; integrated for wheeled)
  yawRate: number;          // rad/s (+ = clockwise on screen; heading 0 = east, PI/2 = south)
  gear: number;             // >=1 forward, <=-1 reverse, 0 neutral
  shiftUntilTick: number;
  steer: number;            // wheeled only: wheel angle rad (0 for tracked)
  throttle: number; brake: number;   // 0..1, last commanded (labs, debug)
  route: Waypoint[]; routeIdx: number;  // reverse is per leg (Waypoint.reverse)
  endHeading: number | null;
  arrived: boolean;
  holdForDismount: boolean;
  stuckTicks: number; replans: number;
  progressX: number; progressY: number; progressTick: number;
  yieldTo: EntityId | null; yieldSinceTick: number;
  crossing: { obstacle: number; part: number; untilTick: number; capMps: number } | null;
  fuelAccL: number;         // sub-litre remainder only; the litres themselves are the tank item's charge
  backX: number; backY: number;     // last pose hidden from known threats (reverse-out target)
}

export interface VehicleWeaponState {
  weapon: DefId;
  feeds: { item: DefId; rounds: number }[];  // ready belts/racks; index = def feed index
  feed: number;
  switchUntilTick: number;
  nextShotTick: number; burstLeft: number; burstIndex: number;
  loadedRound: boolean;     // single-round feeds (tank guns, later): a round is in the chamber [C10]
  jammed: boolean; lastShotTick: number;
  lowAmmoReported: boolean[];
}

export interface StationState {
  azimuth: number; elevation: number;   // relative to hull, rad
  azCmd: number; elCmd: number;
  laidTick: number;
  weapons: VehicleWeaponState[];
  task: FireTask | null;
  taskWeapon: number; taskFeed: number;
  scanAz: number;
  why: { tick: number; keys: string[] };  // last decision + top reasons (string keys) for the debug overlay [C2]
}

export interface Boarding {               // mount/dismount state, NOT a Drill [C68]
  kind: "mount" | "dismount" | "bailOut";
  vehicle: EntityId;
  startTick: number;
  queue: EntityId[];                     // men still to pass an exit, ascending id
  then: OrderBody | null;                // order to carry out after getting out
  rampOpenTick: number;                  // -1 = not open yet
}

export interface VehicleState {
  def: DefId; vehicleId: string;
  side: SideId; faction: DefId;
  unit: EntityId | null;                 // crew unit (null if no crew unit, e.g. an abandoned hull) [C30]
  seats: (EntityId | null)[];
  drive: DriveState;
  stations: StationState[];
  comp: number[];                        // condition 0..1, index = def.components
  status: VehicleStatus;
  fire: { startTick: number; nextCheckTick: number; intensity: number } | null;
  smokeReadyTick: number;
  pendingSmokeTick: number;
  crewReaction: "continue" | "reverseOut" | "bailOut" | null; reactionTick: number;
  reactionWhy: string[];                 // trigger keys of the current reaction [C2]
  lastHitTick: number; lastPenTick: number; hitsThisTick: number;
  seatSwap: { seat: number; actor: EntityId; untilTick: number } | null;  // debug overlay [C2]
  hatches: "closed";                     // reserved ("open" = commander head-out, later)
  aps: { nextReadyTick: number } | null; // reserved; charges are container items only [C25]
  recovery: { state: "none" } | null;    // reserved
  capturedBy: SideId | null;             // reserved: set when the other side holds an abandoned hull (campaign) [C8]
}
```

`VehicleState.addOn` (the earlier copy of the reactive tiles) is **removed** [C25, C49]. Tiles per face are derived from container items (`def.armour.addOnSlots[i].item`) with `countItems`.

### 2.2 Additions to existing types
All are optional (`toPlain` drops `undefined`), so infantry hashes change only through the schema version and the fingerprint.
- `SoldierState.mount?: { vehicle: EntityId; seat: number }`, **absent** when not mounted.
- `Unit.vehicle?: EntityId` (crew unit), `Unit.carrier?: EntityId` (a foot squad's own vehicle), `Unit.boarding?: Boarding` [C68]. `Drill.kind` is **unchanged**. `clearDrills` also clears `boarding` (except `bailOut`), and a new order cancels boarding the same way.
- `Unit.atRule?: "vehicles" | "vehiclesAndPositions" | "hold"` [C1]. This is the SPEC 6.6 standing rule "when to use anti-tank weapons". Absent means the faction default from `core/behaviour.json` (`"vehicles"`). It cascades like the other rules.
- `Contact` gains `cls?: "vehicle"`, `vtype?: DefId`, `heading?: number`, `vx?: number`, `vy?: number`, `wreck?: true`. `KnownEnemy` gets the same fields.
- `Waypoint.reverse?: true` [C20].
- `OrderBody` `rules` gains `atRule?`.

### 2.3 Helpers (`packages/sim/src/mount.ts`, new)
- `isMounted(s)`; `isExposed(s) = isAble(s) && !s.mount`.
- `platformOf(state, id)`: the vehicle of a mounted man, else `id`.
- `sideOfEntity(state, id)`: the identity side, else the vehicle side.
- `stationSeat(def, kind)`, `occupant(state, v, kind)`.
- `footSoldiers(state, unit)` = `unitSoldiers` minus mounted men.
- `fireTop(state, unit)` (§1).
- `vehicleItems(state, v, itemId)`: a counted read of the container.

`unitSoldiers` keeps meaning "everyone" (radio, succession, roster). Its fire-related callers are gated (§6, §7).

### 2.4 Derived, never saved (`ctx`)
- **`ctx.ballistics.vehicles: VehicleGrid`.** Typed arrays per row, sized to the vehicle count:
  - `id`, `x`, `y`, `gz`, `ch`, `sh` (**post-drive** hull cos/sin);
  - `x0`, `y0`, `ch0`, `sh0` (**pre-drive** pose of this tick) [C33];
  - `ct`, `st` (turret world cos/sin), `dx`, `dy` (this tick's displacement), `pitch`, `rt`, `side`, `apsR` (APS detection radius, 0 = none);
  - `bucketHead` / `next` per-bucket lists, and `touched`.
- **`ctx.ballistics.near: Uint8Array`** per 8 m bucket. It **replaces** `nearWall` and `SoldierGrid.near`:
  - bit0 = static wall;
  - bit1 = soldier this tick;
  - bit2 = vehicle this tick (a hull, or the APS radius when set).
  Per-tick bits are cleared through their own touched lists.
- `ctx.mountedRow: Int32Array` (entity id → vehicle row, or −1).
- **`ctx.vehicleRT: VehicleRT[]`** per type: hull and turret boxes; plates (mild-equivalent mm kinetic and shaped, normal, sinCrit); `minNeedMm`; component and seat boxes; aim points; projected-area table per aspect (§10).
- `ctx.nav` keys `tracked:c1` and `wheeled:c1`. Wreck stamps are tracked by `ctx.navObstacleKey`.
- `ctx.aiSight` is **not** in ctx. The AI keeps its own lazily built context (§12).

### 2.5 Battle input and roster (`packages/sim/src/battle.ts`; every field optional)
```ts
export interface VehicleRecord {
  vehicleId: string; type: DefId;
  load: ItemStack[];            // container contents only (stowed, fuel, smoke, extinguisher, reserved add-ons), in and out
  ready?: { item: DefId; rounds: number }[][];  // rounds on the ready belts per station weapon and feed, in and out (M7 review: not added into load)
  components?: number[];
  status?: VehicleStatus;
  capturedBy?: SideId | null;   // reserved [C8]
  recovery?: null;
}
ForceInput.vehicles?: VehicleRecord[];                    // roster assets of the force [C30]
ForceInput.vehiclePlacements?: { vehicleId: string; x: number; y: number; heading: number }[];
UnitInput.vehicleId?: string;                             // crew unit -> its vehicle
Placement.mountedIn?: string; Placement.seat?: number;    // seat index; also used for crew seat overrides [C39]
ForceResult.vehicles?: VehicleRecord[];                   // every vehicle of the force, whatever happened to its crew
SideResult.vehicles?: { start; ok; immobilised; disarmed; abandoned; destroyed; captured };
BattleResult.wrecks?: { vehicleId: string; type: DefId; side: SideId; x: number; y: number; heading: number; status: VehicleStatus }[]; // persistent map damage as data [C8]
```
- **Setup.**
  - `setupBattle` creates every V of `ForceInput.vehicles` from `vehiclePlacements`: container from `load`, `VehicleState` with weapons from data.
  - `addUnit` links a crew unit through `vehicleId` and seats its crew in station order. `Placement.seat` overrides the order; it is filled by the scenario builder from `MemberSlot.seat` [C39].
  - Men with `mountedIn` are seated after all units exist. If seats are exceeded, setup throws a placement-style error.
  - A vehicle with no crew unit is legal: a parked or abandoned hull.
- **Output.** `vehicleRecordFromState` (setup.ts) returns the container as `load` and the ready belts as `ready` (M7 review: one contract in and out, so a record round-trips unchanged and no round is counted twice). `forcesOut` returns `ForceResult.vehicles`, one per V of that side.
  - Abandoned vehicles stay in their own side's list with `status: "abandoned"`.
  - `capturedBy` is reserved: the campaign decides capture from `BattleResult` and who held the ground. M7 never sets it.
  - Destroyed, abandoned and long-immobilised vehicles (`isWreck`: immobilised and not penetrated for more than 30 s) are also listed in `BattleResult.wrecks`, so the campaign can carry map damage forward (SPEC 9.3) [C8].
  - `summarize` (run.ts) fills `SideResult.vehicles`.

### 2.6 Events (`packages/sim/src/events.ts`; keys only)
- `impact.surface` gains `"vehicle"`. `shot.fired` gains `vehicle?: EntityId`. `grenade.launched.method` gains `"direct"`.
- **`vehicle.hit {vehicle, x, y, z, face, zone, result: "ricochet"|"stopped"|"penetrated"|"intercepted", ammo, owner, rounds, components: number[]}`.**
  - Emitted for **every** hit, so it is the SPEC 4.3.5 core event [C24].
  - Rounds below 12.7 mm are aggregated: one `vehicle.hit` per vehicle per tick after the loop, with `rounds = n`, `result: "stopped"`, and the first round's ammo and owner (counted in the per-row `hitsThisTick`).
  - Rounds of 12.7 mm and up, explosives and shaped charges get one event each.
- `vehicle.component {vehicle, component, condition}`, `vehicle.fire {vehicle, state}`, `vehicle.destroyed {vehicle, cause}`, `vehicle.abandoned {vehicle}`, `vehicle.smoke {vehicle, x, y}`, `vehicle.crossed {vehicle, obstacle}`, `vehicle.decision {vehicle, kind, keys}` (debug overlay feed, emitted on change only) [C2].
- `soldier.mounted` / `soldier.dismounted {soldier, vehicle, seat}`; `unit.mounted` / `unit.dismounted {unit, vehicle}`.
- `unit.arrived` is reused for vehicles.

---

## 3. Data

### 3.1 `factions/<id>/vehicles.json` (optional file)
- **Loading.** Parsed in `loadFaction`'s optional-files block. It produces `FactionPack.vehicles` through `indexById`. Ids are prefixed and unique.
- **Catalog.** `Catalog.vehicles` (data `catalog.ts` and sim `catalog.ts` → `VehicleDef`) holds the taking-part factions only.
- **Provenance.** `noProv` becomes **deep**: it strips `sources`, `confidence`, `note` and `nameKey` recursively. Every block uses `withProv`. All blocks are `.strict()`, and reserved blocks are declared now.

**Schema `VehicleSchema`** (SI unless named):
```
id, nameKey, class: MovementClass,
body {lengthM, widthM, heightM, groundClearanceM,
      hull {f,r,u}, turret? {pivotF, f, r, u, barrelM, trunnionU},
      trackContactM?, trackGaugeM?, wheelbaseM?} (withProv)
massKg (withProv)
drive {powerKw, efficiency, topSpeedKmh, reverseTopSpeedKmh, brakeMps2,
       gears [{toKmh}], reverseGears [{toKmh}], shiftSeconds,
       steering: {kind:"tracked", pivot, pivotRateDegS, maxLatAccelMps2, slipCoeff, turnResistance}
               | {kind:"wheeled", maxSteerDeg, steerRateDegS, maxLatAccelMps2},
       idleKw, litresPerKwh} (withProv)
fuel {item, capacityL}
seats [{id, station: StationKind, pos:[f,r,u], part, sensors?: [{kind, pos?, arcDeg, sideFactor, rearFactor, follows, lrf?}], hatch}]
ramp {exits, openSeconds, mountSecondsPerMan, dismountSecondsPerMan, bailOutSeconds, seatSwapSeconds, loadCasualtySeconds} (withProv)
stations [{id, kind:"turret"|"mount", operator: StationKind, commanderOverride,
           traverseDegS, elevateDegS, elevationDeg, traverseArcDeg?, stabiliser, baseErrorMrad, movingMradPerMps,
           layToleranceMrad, rangefinder, readyRefillInBattle,
           weapons [{weapon, coax, muzzle, feeds:[{item, ready:{count, charge}}], switchSeconds, engageRangeM,
                     feedKind: "belt"|"single"|"autoloader",          // [C10]
                     loaderStation?: StationKind, roundLoadSeconds?, noLoaderFactor?}]}] (withProv)
stowed [{item, count, charge?}]
dischargers? {item, perSalvo, salvos, arcDeg, rangeM, delaySeconds, component}
armour {plates [...], addOnSlots [{face, item, perFace}]} (withProv)   // tiles counted only as container items
components [{id, kind, part, box, external, toughnessMm, absorbMm, fireChanceKE?, fireChanceCE?, cookOffChanceKE?, cookOffChanceCE?,
             chargeItem?}] (withProv)   // extinguisher: its charges item [C12]
cookOffAmmo
signature {sizeFactor, movingFactor, firingFactor, identifyM, noiseIdleM, noiseMovingM, aimPoints} (withProv)
activeProtection?: null | {item, detectM, interceptChance, cooldownSeconds, standoffM}   // reserved
recovery?: null
```

**Loader semantics for later tanks [C10].** A weapon with `feedKind: "single"` fires one round per `roundLoadSeconds`. The round comes from the ready rack into `loadedRound`. The reload needs an able occupant of `loaderStation`; without one the time is multiplied by `noLoaderFactor`, or the gun cannot be reloaded if that field is absent. `"autoloader"` needs no loader. Puma and BMP-2 use `"belt"`. The loader validates the fields now, and the `xf` fixture has one single-feed weapon so the path is exercised by a test (§3.5). Behaviour for tanks is otherwise not tuned in M7.

**Loader cross-checks** (each has a clone-and-break case in `packages/data/test/loader.test.ts`):
- weapons exist; each feed item has a `chargeItem` the weapon fires, of matching calibre;
- stowed items are known; exactly one `driver` seat; sensor kinds exist; plate materials exist;
- every hull face has a plate (lint warning); component boxes lie inside their part;
- the discharger item is smoke ammunition; the fuel item has a charge in litres; a component's `chargeItem` exists; add-on slot items exist;
- `cookOffAmmo` exists and has a fragment entry; `nameKey` passes `needKey`;
- `loaderStation` names an existing station kind on that vehicle;
- for templates: `template.vehicle` exists; crew members ≤ crew stations; each `member.seat` exists and is used once; `carriage` (below) indices are valid; carried squad sizes ≤ passenger seats (a **warning** in the loader and an **error** in the scenario builder).

**Lint:** provenance per vehicle and per block; a warning for power-to-weight outside 8–40 kW/t.

### 3.2 Puma (`factions/de/vehicles.json`, id `de-puma`)
S = sourced (medium); G = game value (low, with a note).

| Block | Values |
|---|---|
| body | 7.6 × 4.0 × 3.6 m (S, level C). Hull f ±3.8, r ±2.0, u 0.45–2.45 (G). Turret pivotF 0.4, f −1.2..1.4, r ±1.15, u 2.45–3.3, barrel 3.0, trunnionU 2.85 (G). trackContact 4.9, gauge 3.0 (G) |
| mass | 43,000 kg (S) |
| drive | 800 kW (S), efficiency 0.75 (G), 70 km/h (S), reverse 30 (G). Gears 8/15/25/38/52/70, reverse 12/30 (G), shift 0.4 s, brake 6.0 m/s² (G). Tracked, pivot yes, 40°/s, latAccel 3.5, slipCoeff 0.1, turnResistance 0.5 (G). idle 40 kW, 0.28 L/kWh (G) |
| fuel | `de-puma-diesel`, 900 L (G) |
| seats | cmd (hull; `vehicle-day` + `vehicle-thermal`, arc 360, follows own, lrf), gnr (follows station, lrf), drv (`vision-block`, arc 90), p1–p6 (S: 3 + 6) |
| ramp | rear exit [−4.0, 0], open 3 s, mount 2.0, dismount 1.2 s/man, bail-out 6 s, seat swap 20 s, load casualty 15 s (G) |
| station `turret` | operator gunner, commanderOverride. 60°/s, 40°/s, −10..+45° (G). Two-plane, base 0.3 mrad, moving 0.3, tolerance 2 (G). LRF. readyRefillInBattle false (G; Q17) |
| weapons | `de-mk30-2` belt, 200 rpm (S), feeds `de-30x173-belt-ke` 100 + `de-30x173-belt-he` 100 (S total, split G), engage 2000 m (G). Coax `de-mg5-coax` with `de-mg5-belt`, 1000 ready, engage 800 m |
| stowed | 200 × 30 mm (100 KE / 100 HE G), coax 1000 (G), 16 × `de-76mm-smoke`, 2 × `de-puma-extinguisher-charge` (G) [C12] |
| dischargers | `de-76mm-smoke`, 4 per salvo, 4 salvos, arc 90°, 35 m, delay 1.5 s (G) |
| armour (G) | As revision 1 (hull front upper composite 45 @60°, lower 45 @55°, sides 30, skirt 10 spaced 0.6, rear 25, top 20, bottom 20; turret front 50 @55°, sides 25, top 15). addOnSlots [] |
| components (G) | As revision 1; extinguisher `chargeItem: de-puma-extinguisher-charge` |
| signature (G) | sizeFactor 1.0 (geometry gives the area; this only adds camouflage or shape) [C57], moving 4, firing 15, identifyM 1500, noise 400/1200, aim points [0,0,1.45], [0.4,0,3.2] |
| cookOffAmmo | `core-vehicle-cookoff` |
| activeProtection / recovery | null / null |

### 3.3 BMP-2 (`factions/ru/vehicles.json`, id `ru-bmp2`)
| Block | Values |
|---|---|
| body | 6.72 × 3.15 × 2.45 m (G, not in research). Hull u 0.42–1.9, turret u 1.9–2.45 (G) |
| mass | 14,000 kg (S) |
| drive | 225 kW (S), 0.75 (G), 65 km/h (S), reverse 12 (G). Gears 7/14/24/36/50/65, reverse 12. Pivot 45°/s. **brakeMps2 6.5** (G) [C61]. Fuel 460 L (G) |
| seats | cmd and gnr in the turret (S), drv front-left, 7 passengers (S), two rear door exits [−3.5, ±0.6]. Gunner `vehicle-day` + `vehicle-night-ir` (G), commander `vehicle-day` arc 360 (G) |
| station | 35°/s (S), 6.0°/s (S), −5..+74° (S), two-plane (S), base 0.6, moving 0.8 (G), no LRF, readyRefillInBattle true (G) |
| weapons | `ru-2a42` belt (550 cyclic S), `ru-30x165-belt-ap` 160 + `ru-30x165-belt-he` 340 (S total, split low). Coax `ru-pkt` with `ru-pkt-belt` (250), 2000 total (S) |
| stowed | coax spares (G), 6 × `ru-81mm-smoke` (G) |
| dischargers | `ru-81mm-smoke`, 6 per salvo, 1 salvo, arc 90°, 30 m (G) |
| armour (G) | As revision 1 |
| components (G) | As Puma, without an extinguisher; fuel in the rear doors |
| signature (G) | sizeFactor 1.0, moving 4, firing 15, identifyM 1500, noise 400/1200, aim points [0,0,1.2], [0,0,2.35] |

### 3.4 Ammunition, weapons, items, core data
- **Weapons.**
  - `WeaponSchema.type` gains `"autocannon"`. Optional `feeds?: [{magazine}]`, `engageRangeM`.
  - New weapons: `de-mk30-2`, `de-mg5-coax`, `ru-2a42`, `ru-pkt`.
  - `ru-rpg7` stays a launcher item (the delivery-method path, §9).
- **Ammunition** (new `AmmoSchema` optional fields):
  - `propulsion {ignitionSeconds, burnSeconds, accelMps2}`;
  - `explosive.selfDestructSeconds`;
  - `explosive.burstOnBody?: boolean` (default false) [C53];
  - `ricochetFactor`;
  - `behindArmour {spallCount, spallConeDeg, spallEnergyJ, overpressureKg?}`;
  - `delivery.method "direct"` with `dispersionMrad, aimSeconds, reloadSeconds, disposable, backblastM`.
  - Limits to verify and raise if needed [C67]: `velocityMps` (to 2000), `projectileMassKg` (DM12 warhead ≈ 3–4 kg, fits ≤ 100), `diameterM` (0.11, fits ≤ 0.5), `cartridgeMassKg` (12.9, fits ≤ 200).

  | id | kind | key values |
  |---|---|---|
  | `de-30x173-pmc287` | kinetic-penetrator | 1405 m/s (S); **steelMm 132.5** (106 RHA LOS × 1.25) at the 1000 m speed [C43]; ricochetFactor 0.4 |
  | `de-30x173-he` | HE impact | 1050 m/s (G); 0.05 kg (G); fragmentCount 30; `burstOnBody: true` (Q18) |
  | `ru-30x165-3ubr8` | APDS | 1120 m/s (S); **steelMm 62.5** (50 LOS RHA × 1.25) at 1500 m [C43] |
  | `ru-30x165-3uof8` | HE | 960 m/s (S); 0.049 kg (low); fragmentCount 30; `burstOnBody: true` |
  | `de-76mm-smoke`, `ru-81mm-smoke` | smoke | discharger grenades (G) |
  | `ru-pg7vl` | shaped-charge | **moved** from ru/items.json (§9) |
  | `de-pzf3-dm12` | shaped-charge | §9 |
  | `core-vehicle-cookoff` | explosive | 5 kg (G), fragment entry |
  | lab references | — | `lab-23mm-ap`, `lab-14_5mm-b32`, `lab-12_7mm-b32`, `lab-762-b32`; defined in the armour lab only |

- **Items:**
  - belts `de-30x173-belt-ke`, `de-30x173-belt-he`, `ru-30x165-belt-ap`, `ru-30x165-belt-he`, `ru-pkt-belt`;
  - fuel `de-puma-diesel`, `ru-bmp2-diesel` (charge = litres, chargeMassKg 0.84);
  - `de-puma-extinguisher-charge` (counted; G) [C12];
  - `de-pzf3-firing-unit`.
  - Reactive tiles and APS charges have **no real-faction items in M7**. They are exercised only by the fixture items `xf-shingle` (add-on tile) and `xf-charm` (APS charge) [C12]. Rule-9 conservation tests for tiles and charges run on the fixture.
- **Materials:** `armour-steel` (1.25 / 1.25, ricochet 20°), `composite` (1.6 / 2.5, G), `aluminium-armour` (0.45, reserved), `slat` (reserved, `fuseShortChance`). `MaterialSchema.resistanceShaped` is optional.
- **Surfaces:** optional `vehicle {rolling, traction, lateral, capKmh?, wetTractionFactor, wetRollingFactor}` (G). Values as revision 1, with wet factors (grass 0.8/1.2, ploughed 0.7/1.4, mud 0.6/1.5, asphalt 0.85/1.0) [C13].
- **Obstacles:** `vehicle {tracked: {crossCostCells, capKmh, flattens} | null, wheeled: … | null}` replaces the two booleans. The test fixtures `sim/test/helpers.ts` and `sim/test/grenades.test.ts` are updated in the same commit [C41].
- **Movement modes [C42]:** `MovementModeSchema` becomes a discriminated union on `class`:
  - foot: `{class: "foot", speedMps, posture, exertion, vehiclePace: {tracked, wheeled}}` [C37];
  - vehicle: `{class: "tracked"|"wheeled", speedFraction}`.
  - Paces: `drive-slow` 0.3, `drive` 0.7, `drive-fast` 1.0, plus `wdrive-*`. The placeholders `wheeled`/`tracked` are removed.
  - `buildCatalog` builds the union; the sim type `MovementModeDef` is a union.
  - Foot code (`systems/body.ts`, `movement.ts`, `orders.ts`, `planner`) reads modes through `footMode(catalog, id)`, which narrows and throws on a vehicle pace. A typecheck pass shows every caller.
  - Foot modes map to vehicle paces: walk/sneak/crawl → drive-slow, run → drive.
- **Spotting sensors** (`core/spotting.json`) gain a per-sensor `smokeFactor` (transmission through a standard smoke cloud) [C14]:
  - eyes and `vehicle-day` 0;
  - `vehicle-night-ir` 0;
  - `vehicle-thermal` 0.5 (G, conventional smoke, not multispectral);
  - `vision-block` 0.
  - Other values as revision 1. Each smoke item gets an optional `multispectral: boolean` (false for both discharger rounds).
- **Behaviour** (`core/behaviour.json`, G): `crew {reverseStress, bailStress, bailOnFireSeconds, atThreatM}`, `armourSuppression 0.15`, `vehicleLossStress`, heavy suppression, `atRuleDefault: "vehicles"` [C1], `dismountHoldM 100` [C29].
- **Wounds:** a `seated` hitbox, the `heavy` rule, burn wounding.
- **Ballistics:** `rhaToMildSteel 1.25`; spall table; jet decay.
- **Units [C39]:**
  - `UnitTemplateSchema` gains `vehicle?: Id` (crew templates). Parent templates gain `carriage?: [{crew: number, carries: number[]}]`, indices into the parent's own `subunits`. A reusable crew template never names siblings.
  - `MemberSlot.seat?: Id` is resolved by the scenario builder into `Placement.seat`.
  - New crew templates `de: puma-besatzung`, `ru: bmp2-ekipazh`; new roles (de `kommandant`, `richtschuetze`, `fahrer`; ru `komandir-mashiny`, `operator-navodchik`, `mekhanik-voditel`).
  - Platoon templates gain crew sub-units and `carriage` in M7.2 after the seat answers (Q1, Q2).
- **Strings:** `vehicle.de.puma`, `vehicle.ru.bmp2`, `ammo.ru-pg7vl` (new key after the move) [C67].

### 3.5 Fixture faction `xf`
`fixtures/factions/xf/vehicles.json` → `xf-cart`:
- **wheeled** (wheelbase 3.2 m, max steer 35°, no pivot);
- 2 crew (`carter` = driver, `slinger` = gunner) with no commander station;
- 4 passenger seats;
- one `mount` station, arc −60..+60°, stabiliser `none`;
- weapon `xf-sling` with `feedKind: "single"`, `loaderStation: "passenger"`, `roundLoadSeconds 4`, `noLoaderFactor 3` [C10], firing `xf-bolt` from rack item `xf-bolt-rack`;
- no dischargers;
- `addOnSlots [{face: "front", item: "xf-shingle", perFace: 4}]` with 4 shingles stowed [C12];
- `activeProtection {item: "xf-charm", detectM 15, interceptChance 0.5, cooldownSeconds 5, standoffM 6}` with 2 charms stowed.

New roles, templates `cart-crew` and `cart-band` (with `carriage`), and `manifest.platoonTemplate = "cart-band"`. `porter-gang` and `porter-band` stay untouched. The exact item list in `fixture-faction.test.ts` is extended. `radio.ack.mount` gets an xf override. Launcher `xf-tube` and round `xf-tube-round` are added.

---

## 4. Drive model (`packages/sim/src/systems/drive.ts`, `vehicleDriveSystem`)

Per vehicle, in ID order, dt = 1/60. Maths through `sim/math.ts`. No allocation. The dynamics core is the pure `stepDriveDynamics` (§1 invariant 3).

1. **Can it drive.** An able, non-captive driver; engine, transmission and tracks/wheels > 0; fuel charge > 0; status `ok` or `disarmed`. Otherwise throttle 0, brake 1. Engine < 0.5 → P × 0.5.
2. **Terrain and weather [C13].**
   - Four contact corners → pitch, roll, z (kinematic, recomputed in `rebuildVehicleGrid`).
   - Surface `vehicle` block under the hull: Crr, μ, μ_lat, cap.
   - **Wetness** `w = clamp(env.rain·1.0, 0, 1)` scales μ by `lerp(1, wetTractionFactor, w)` and Crr by `lerp(1, wetRollingFactor, w)`.
   - Vegetation multiplier from `cellMoveCost(…, def.class)`.
   - The ARCHITECTURE 9.7 row is extended: "movement (vehicles: rain → traction/rolling)".
3. **Longitudinal (per track for tracked, body for wheeled) [C15].**
   - Body: `P = powerKw·1000·efficiency·engineFactor − P_turn` (≥ 0.2·P). `vEff = max(|v|, gear.lowerMps, 1.0)`. `F_eng = throttle·P/vEff` (0 while shifting). `F_res`, `F_grade`, `F_brk` as revision 1.
   - **Tracked:** the follower commands a body speed v* and a yaw rate ω*. Target track speeds are `vL* = v* + ω*·B/2` and `vR* = v* − ω*·B/2` (B = gauge; + yaw = clockwise, so a faster left track turns right). Each track gets half the engine force, bounded by its own traction `μ·m·g·cos(pitch)/2`. Its force is multiplied by its track component when that is < 1, so a damaged track pulls the hull toward its side naturally (no ad-hoc pull). Each track speed integrates toward its target under `(F_track − F_res/2 − F_brk/2 − F_grade/2)/(m/2)`.
   - **Turn resistance:** a moment `M_r = turnResistance·μ_lat·m·g·L/4` acts against the track speed difference. A turn needs the outer track to push and the inner to brake, and the power share `P_turn = M_r·|ω|` comes out of P. This replaces the Merritt shortcut and keeps its effect: a heavy hull turns slower in ploughed land.
   - **Body motion:** `v = (vL + vR)/2` and `ω = (vL − vR)/(B·(1 + slipCoeff))`. Pivot: vL* = −vR*, allowed only if `steering.pivot`. Caps: |ω| ≤ pivotRate, |ω| ≤ maxLatAccel/max(|v|, 0.5).
   - A track at 0 → immobilised (status). A thrown track mid-turn spins the hull about the other track, which is accepted and shown in the drive lab.
4. **Gears.** As revision 1 (up/down thresholds, shift time, forward ↔ reverse at |v| < 0.3).
5. **Wheeled.** Steer angle toward atan(wheelbase·κ) at steerRate, |δ| ≤ maxSteer, ω = v·tan δ/wheelbase, lateral cap. A heading error above 100° → three-point manoeuvre.
6. **Integrate.** heading += ω·dt. Proposed pose; collision checks (§5); blocked → keep the pose, both track speeds 0, stuckTicks++. Otherwise write the transform.
7. **Fuel (rule 9).** `fuelAccL += (idleKw + Σ|F_track·v_track|/efficiency/1000)·litresPerKwh·dt/3600`. Whole litres leave the tank item's charge (the only count).
8. **Halt** clears the route and brakes until |v| < 0.05. `holdForDismount` keeps the brake on.
9. **Reverse is per leg** [C20]. The follower reads `route[routeIdx].reverse`. The `move` order's `reverse: true` sets the flag on every waypoint; the planner can set it per leg.

**Simplifications (DECISIONS.md):** rigid 2.5D body; constant power per gear band; track slip lumped into `slipCoeff`; no bogging, no swimming; vehicle-vehicle contact by yielding. Because steering now runs through per-track speeds, there is no SPEC deviation to log for it [C15].

**Drive lab bands** (`packages/tools/src/labs/drive.ts`, driven by `move` orders from a scripted controller [C18]):
- 0–50 km/h on asphalt: Puma 8–14 s, BMP-2 7–12 s;
- top speed within 5 %;
- asphalt > grass > ploughed > mud, and dry > rain on each;
- **braking from 50 km/h 12–25 m, from 70 km/h 28–45 m** (widened; computed Puma 50 km/h ≈ 16 m) [C61];
- pivot 90° 2–4 s; reverse top = data; 20 % slope > 0;
- one track at 0.3 → the hull drifts toward that side on a straight order, and the follower compensates within 2 m over 100 m;
- xf-cart turning circle ≥ 2·minRadius;
- no driver → no movement.

---

## 5. Navigation, path following and collisions

**Grids.**
- `buildNavGrid(map, terrain, cls, cellM, coverWeight, breaches, clearanceCells = 0, obstacles = [])`:
  - **Breach cells are marked first and exempt from dilation** [C50]. Hard-blocked cells (cost 0, buildings, deep water) are then dilated by `clearanceCells` before `labelRegions`. Crossable wall cells are not dilated.
  - `exposureMap` is skipped when cls ≠ foot.
  - A breach counts as vehicle-passable if `widthM ≥ hullWidth + 0.5` for the class's widest vehicle. This replaces the hard-coded `< 3`. Its cells are not dilated, so the hole stays open in the grid.
  - Linear obstacles take `vehicle[cls].crossCostCells`.
- `navFor(ctx, cls, coverW, clearance)` keys `tracked:c1`, `wheeled:c1`; the cell size comes from the grid.
- **Memory [C11, C31].**
  - Vehicle grids store cost as `Uint8Array` (quantised 0–255) and region labels as `Uint16Array`, never a second float grid. Wall and foot-only arrays are omitted for vehicle classes.
  - Budget per vehicle grid: ≈ 1.6 MB at 1200 × 900 m, ≈ 5 MB at 2 × 2 km, ≈ 20 MB at 4 × 4 km (2 m cells).
  - `nav-maps.test.ts` asserts byte size and build time at 2 × 2 km. 4 × 4 km is logged in the batch report. If 4 km maps arrive (not in M7), vehicle grids move to 4 m cells (`tracked:c1@4`), allowed by the "cell size from the grid" rule.
- **Local patch (M7.1c).** `patchNavGrids(ctx, rect)` replaces `ctx.nav = {}` in `syncTerrainDamage` [C38]:
  - It works on the rect grown by `COVER_NEAR_M` (4 m) + clearance + 1 cell.
  - It recomputes, in that order: hard-block, dilation, wall, **exposure** (foot grids, the same `exposureMap` kernel restricted to the rect), **cover-weighted cost**, then relabels regions (O(N) flood).
  - Test: the result equals a full rebuild cell for cell (cost, wall, exposure, region) after a breach and after a wreck stamp.
- **Wrecks [C54].**
  - Vehicles that are `destroyed`, `abandoned`, or `immobilised` for more than 30 s are stamped as hull rectangles: **cost 0 (blocked) in every grid, foot included**, with `wall = 1` on the ring of cells around the hull in foot grids, so men take cover next to wrecks through `exposureMap`.
  - The planner and the men-vs-hull slide therefore agree.
  - The list is derived from the vehicle store in ID order and re-derived in `syncTerrainDamage` and after load. `BattleResult.wrecks` carries it out (§2.5).
- **Planning.** `routeThrough(ctx, x, y, wps, 0)` with the vehicle's class, only at order delivery and on a stuck re-plan (one re-plan per tick, ID-ordered queue).
- **Wheeled.** `wheeled:c1` exists for the fixture; real maps barely allow wheeled routes, which is accepted for M7.

**Follower (pure pursuit).**
- Look-ahead L = clamp(4 + 0.8|v|, 4, 20) m. Heading error e uses h + π on reverse legs.
- Tracked, |e| > 60°: v* = 0 and pivot until |e| < 10°. Otherwise ω* = 2·v·sin(e)/L.
- v* = min(pace cap, √(maxLat/κ_ahead), √(2·0.6·brake·dEnd), √(2·0.6·brake·dObstacle)). P-controller with a 0.2 m/s deadband.
- **Arrival.** dEnd < 1.5 m, |v| < 0.3 → pivot to `endHeading` (±3°) → `drive.arrived = true`.
- **Stuck.** < 0.5 m progress in 3 s → re-plan; after 3 re-plans → `move.noRoute`, `radio.noRoute`.

**Unit arrival for parents [C36].** `movementSystem`'s arrival block uses the new `unitArrived(state, uid)`:
- every **foot** man of the unit and its descendants (`footSoldiers`) has an empty mover;
- every vehicle child has `drive.arrived` (or no route);
- no descendant has `boarding` pending with a `then` order.
Mounted men are ignored, so a platoon whose children drive arrives when its last hull and its last foot man are in.

**Vehicle vs terrain.**
- Each tick the proposed pose's 8 outline points are tested against **true building polygons** (`buildingAt`/`pointInPolygon`) and deep water. They are **not** tested against the grown hard-blocked cells, which would stall turns near buildings [C62].
- Wall segments under the hull come from the allocation-free `segmentsInRectInto` (ascending id order, §15 M7.1a).
- An uncrossable wall blocks. A crossable one sets `drive.crossing` with a speed cap.
- **Flattening [C17, C40].** If `flattens`, the crossing computes the breach in the real schema:
  - `owner: "obstacle"`, `id` = obstacle index, `part` = segment index;
  - `offsetM` = distance along the segment from its start to the hull centre-line crossing point;
  - `widthM = min(hullWidth/max(|sin θ|, 0.3), 3·hullWidth)`, where θ is the angle between heading and segment;
  - `tick`.
  - It pushes into `state.terrain.breaches`, emits `terrain.breached` and calls `patchNavGrids`.
  - `applyBreaches` turns it into a `"door"` opening, so **a flattened hedge or fence becomes see-through and shoot-through over that width**. This is intended (the obstacle is gone there) and logged in DECISIONS.md.
  - A crossing of an already-breached part over the same offset adds nothing.
- **Corner-sweep guard.** A pivot that would swing a corner into a building is refused; creep 1 m first.

**Vehicle vs vehicle.** OBBs in ID order; the corridor ahead is the stopping distance + 3 m; SAT after an AABB reject. The closer yields; on a tie the higher ID yields. After 3 s, re-plan with that hull as a temporary blocked overlay. Goal slots 12 m apart.

**Vehicle vs men.** Corridor scan over exposed men:
- able men evade (existing `evadeSystem`/`rejoinRoute`);
- unable or prone men → the vehicle stops and re-plans after 3 s around a 2 m disc;
- enemies are treated the same (Q4).

**Men vs vehicle.** `movementSystem` builds the hull list from post-drive state, wrecks included, inflated by 0.4 m. A man inside slides along the tangent; blocked for 1 s → `rejoinRoute`. This is consistent with the wreck stamps [C54].

**Sight and fire through hulls [C60].**
- `sight()` gets optional `ignoreA` / `ignoreB`.
- The vehicle test is **independent of the sample loop**. When `vehicles.count > 0`, it walks the line's 8 m buckets with a DDA from start to end and reads bit2 of `near`. Only flagged buckets' rows get the segment-vs-OBB slabs, deduplicated by a per-call stamp. If the result is nearer than the current `tBlock`, it sets `blockedBy = "vehicle"`.
- The test runs after the sample loop with `tMax = tBlock`, so a wall in front already bounds it.
- M7.1a removes the roof allocations in `sight()` (`new Set`, `ts[]` per roof) through scratch arrays, so `sight()` becomes fully allocation-free.
- `lineBlocked` tests hull boxes too.
- ARCHITECTURE section 16g: "sight reads ctx tables derived from state at fixed points".

---

## 6. Seats, crew, mount and dismount

**Seating.**
- Crew are seated at setup in station order (`Placement.seat` overrides). Passengers are seated by `mountedIn`.
- `VehicleState.seats` and `SoldierState.mount` are written only by setup and by the action handlers `mount`, `dismount`, `bailOut`, `seatSwap` and `loadCasualty`.
- `vehicleSyncSystem` copies seat transforms after the drive.

**No driver = no movement.** `move`/`reverse` with no able driver → unable, `radio.noDriver`.

**Seat swap.** Next crewman by priority; the casualty moves to the freed or a free seat and stays aboard (rule 10). `VehicleState.seatSwap` records it for the debug overlay. Passengers fill crew stations only per Q13.

**Orders.**
- `{kind: "mount", vehicle}` to a foot squad or a man. At delivery, fewer free seats than men to board → unable, `radio.noSeats` (partial mount: Q-default no).
- `{kind: "dismount"}`: to a squad, that squad gets out; to a vehicle unit, all passengers.

**Mount (`Unit.boarding = {kind: "mount", …}`, stepped by `boardingSystem` inside `drillSystem`'s slot) [C68]:**
1. *Approach.* Each exposed man `sendTo` the nearest exit; re-plan if the hull moves more than 3 m.
2. *Board.* Within 2.5 m of the exit and the vehicle halted → interruptible action `mount`, one man per exit, ascending ID. The ramp opens once. `check()`: vehicle exists, not burning, halted, seat free. `complete()`: set mount and seat; clear mover, fire task, evade, intent, errand; emit `soldier.mounted`.
3. **Casualties [C7].**
   - Members who cannot walk are **loaded** if the unit has at least two able men within 30 m. A two-man action `loadCasualty` (`loadCasualtySeconds`) carries him from within 5 m of the exit into a passenger seat. This is the SPEC 9.1 "loading into a vehicle" step without M10's carrying over distance.
   - Casualties beyond 5 m of an exit, or with no carriers, stay where they are. They are left in their unit, marked by the existing casualty state, and **excluded from `unitArrived`, `drill.then`, the AI pairing and boarding completion**.
   - The unit is complete when every able man is aboard and every loadable casualty is loaded, or after 60 s. Q25 lets the owner choose otherwise.
4. `unit.mounted`, `radio.mounted`.

**Dismount (`boarding.kind = "dismount"`).**
- `holdForDismount` first, then the action `dismount` per exit.
- `complete()`: man at `nearestPassable` of a fan 3–8 m out, crouching, heading = hull + π; `soldier.dismounted`.
- Casualties aboard stay aboard (rule 10); M10 brings unloading.
- When the last able man is out: `unit.dismounted`, `radio.dismounted`, laid-out arc. `boarding.then` is applied if present.

**Bail-out (M7.4b).** `boarding.kind = "bailOut"` for every occupant: all exits, bailOutSeconds. Unconscious men stay inside. Burn wounds accrue inside a burning hull.

**Resupply from the vehicle and from abandoned hulls [C6].**
- `stepBringAmmo` / `shareAmmo` gain a **container source**: the own carrier's container (or any own-side vehicle's), when the vehicle is halted and the man is exposed within 5 m of an exit. It uses the existing transfer action and `transferItems` (rule 9). Rifle magazines, MG belts and rockets loaded as stowage (data, G) count.
- **Cross-loading from abandoned vehicles:** the same source accepts any `abandoned` hull of either side within 5 m, with no crew aboard, and emits `item.taken {from: vehicle}`.
- Test in M7.2: "a dismounted squad refills magazines from its halted carrier; item totals are conserved". M7.4b test: "men take belts from an abandoned enemy hull".

**Comms [C63].**
- `contactShareDelayTicks`: same vehicle → 0 (intercom); inside ↔ outside → radio delay.
- `simpleComms.update` sets `link = "none"` for a crew unit whose vehicle's radio component is 0, and for passengers' units only while **all** their men are aboard a vehicle with radio 0. It no longer overwrites the radio component's effect.

**What "mounted" means to every existing system** (enforced by A7 and the `mounted-invariants` test):

| System / file | Mounted man |
|---|---|
| movement | skipped; Transform from `vehicleSyncSystem` |
| posture, morale prone request, `knockDown`, `applyBlast` knock-flat | ignored while mounted; crouching on dismount |
| evade / grenade reaction | skipped |
| fire (`assignFireTask`, `fireSystem` incl. its **lull reload loop over `state.weapon`**) [C52] | personal weapon refused; no reload actions; crew act only through the station |
| `friendInLine` [C51] | **mounted men never block** (they are behind armour); station fire also skips its own occupants |
| low-ammo reports, `leaderLost` (morale) [C52] | low-ammo for mounted men suppressed; leader loss unchanged (still a casualty) |
| grenades | refused |
| decisions (`seekCover`, own fire, `shareAmmo`, `stepBringAmmo`) | skipped as giver and taker (the container source is the exception, §6) |
| drills (`drillGroups`, `breakUnit`, react-to-contact, `sendTo`) | `footSoldiers` only; routed passengers stay aboard |
| spotting | never a target; passengers do not observe; crew observe through seat sensors |
| contacts / hearing / `knowledge.ts` [C52] | hear nothing outside; `sideKnowledge` never lists a mounted man |
| ballistics soldier fill | not a body row, but kept in `SG.sideOf` |
| explosions, `suppressByBurst` | skipped |
| wounds / physiology / morale stress | unchanged |
| surrender | not while aboard |
| objectives / end of battle [C29] | `standing` (hold/contest) counts foot men only (Q10). **Side presence and "side broken"** count mounted men as present and able. A side with men only inside vehicles is not wiped out |
| orders | as revision 1 (mounted squad: dismount then the order, via `boarding.then`) |
| AI commander (`packages/ai`) [C28] | uses `footSoldiers`/`isMounted` from sim; never orders mounted men to walk |
| renderer / app (`pickAt`) [C28] | not drawn, not tappable |
| roster | normal records |

---

## 7. Turret, weapons, ammunition racks, fire control, own fire, smoke

**Where the state lives.** Station weapons live only in `VehicleState.stations[i].weapons`.

**Helpers split out of fire.ts (M7.1a, behaviour unchanged):** `pickRound`, `launchShot`, `burstCadence`.

**`dropAt` and drop tables [C48].**
- The cache key becomes `${ammoId}@${v0}@${maxRangeM}`, and `dropAt` takes `maxRangeM` and builds with it. 1500 m stays the default for infantry, so the infantry tables are identical.
- `buildDropTable` returns `{drop: Float32Array; tof: Float32Array}`. The existing callers read `.drop`.
- This lands in M7.1a; the goldens stay unchanged.

**`turretSystem`.**
- Lay from the task: bearing plus lead; elevation plus `dropAt(ammo, v0, range, weapon range)`.
- Traverse at traverseDegS (turret-drive < 0.5 → × 0.25); elevation limits; arc.
- Stabilised: subtract the hull yaw change.
- `laidTick` within tolerance. Commander override.
- Every change of target or lay state writes `station.why` (keys such as `why.target.threat`, `why.target.nearest`, `why.nature.vehicle`, `why.lay.slewing`) [C2].

**`stationFireSystem`.** Conditions:
- an able operator (commander as fallback after 3 s);
- gun > 0;
- feed rounds and switch time;
- **single feeds:** `loadedRound` (reload per §3.1, with or without a loader) [C10];
- laid;
- line of fire clear from the muzzle via `sight()` ignoring the own vehicle;
- `friendInLine` over **exposed** men with the height test [C51];
- `fireAllowed(fireTop(unit))` [C19].
Firing on the move is allowed.

**Error, muzzle, lead.** As revision 1. Lead uses the drop table's `tof`.

**Ammunition (rule 9).** Feeds, nature switch, `reloadStation` (allowed per Q17), low-ammo per feed. Conservation: rounds fired = ready decrease + stowed decrease.

**Target choice (`stationDecision`, 1 Hz per vehicle, staggered).**
- Candidates within `engageRangeM` and `fireTop(unit).maxEngageM`. Vehicles are targets. Scoring by the `pickTarget` terms. Nature: vehicle → kinetic, groups/buildings → HE at ground level, single men within 400 m → coax.
- Hull hits stamp `underFireTick`/`contactTick` on the crew unit and the platoon top.
- Writes `station.why` and emits `vehicle.decision` on change [C2].

**`incomingFireSystem` [C34].** The early return becomes `if (state.fire.size === 0 && state.vehicle.size === 0) return;`. Station tasks are renewed inside it, in a second loop over the vehicle store. The other `fire.size === 0` early return in fire.ts is checked for the same need.

**Smoke dischargers.**
- Order `{kind: "discharge"}`: the component must be > 0 and `perSalvo` items must be in the container.
- Clouds are pushed onto `state.smoke` with `multispectral` copied from the item [C14].
- Spotting multiplies each sensor's visibility through smoke by its `smokeFactor` (0 = blocked).

**ABM/KETF.** Default: impact HE (Q16); air-burst needs a schema bump.

---

## 8. Armour, penetration, components, crew effects, reactions, destruction

**Hot loop (`projectileSystem`).**
1. *Coarse.* Read `near[kk]` once: bit0 wall, bit1 soldier, bit2 vehicle. The explosive flag clears nearSoldier **unless `am.burstOnBody`** [C53], so existing VOG-25 and 82 mm rounds are unchanged. It never clears nearVehicle.
2. *APS pre-check (reserved; only rows with `apsR > 0`) [C16].*
   - For a round with `am.thrust > 0` in a flagged bucket, before any hull test: if the segment passes within `apsR` (detectM) of the hull centre this tick, the round is queued in `APSQ` (stride 6: row, x, y, z, ammo, owner) at the closest-approach point and **removed** from the pool. There is no plate contact, no `settle` and no DET entry for it.
   - After the loop, `resolveAps` checks charges (container, `xf-charm`) and cooldown, and draws `interceptChance` (stream `armour`).
     - **Intercepted:** one charge removed; the round's warhead bursts at `standoffM` along its path (DET queue: blast and fragments, no jet onto the hull); `vehicle.hit {result: "intercepted"}`.
     - **Failed:** the round is re-added after the loop at the same position and velocity (pool growth after the loop, like bursts), flagged `apsTried` in a scratch per-row bitset so it is not tested twice. It hits normally next tick.
3. *Narrow (flagged rounds only).*
   - For each vehicle row in the touched buckets (deduplicated by a stamp), the origin and direction are moved into the **pre-drive** hull frame [C33]:
     - `o = (x0 − row.x0, y0 − row.y0)` rotated by `(ch0, sh0)`;
     - the relative direction is `d − (row.dx, row.dy)`.
     The yaw change within one tick (≤ 0.75° at 45°/s) is ignored and logged as a simplification.
   - Three slabs per box, record the face, then the turret box. The nearest entry gives `tVeh`.
   - Skip the own platform for rounds younger than 10 ticks.
4. `tVeh` joins `tEnd` and the branch chain; ground and walls that come first still win.
5. *Inline early-out.* For non-shaped, non-explosive rounds, `can = penSteelMm·(v/penV)^1.5` is computed only after a hull entry was found. It uses a 256-entry `(v/penV)^1.5` lookup in AmmoRT, so there is no `pow` call [C66]. If `can < minNeedMm`: ricochet or stop, emit `impact {surface: "vehicle"}` (fragments silent), `hitsThisTick[row]++`, and add suppression to that row's accumulator. **No function call** apart from the existing `events.emit` pattern for impacts.
6. *Explosive rounds* → `settle()` with the face normal and surface `"vehicle"` (the type widened, §8 HE contact). Shaped-charge rounds also go to `VHQ` (jet).
7. *Everything else* is queued in `VHQ` (stride 12) and **removed from the pool in the loop** [C44].

`DET` widens to stride 9 (+ vx, vy, vz, vehicle row).

**After the loop, in this order:** APS resolution → bursts (DET) → `resolveVehicleHit` per `VHQ` entry → re-add APS failures and exiting rounds with `addProjectile` [C44]. The aggregated small-arms `vehicle.hit` events are emitted per row [C24].

**`settle()` on a hull [C55].** The surface type gains `"vehicle"`. A non-impact-fused round that would come to rest on a hull (a hand grenade, a time-fused grenade) is **not left on the roof**. It is placed on the ground at the nearest point outside the hull footprint (+ 0.3 m), with zero velocity, and keeps its fuse. Impact-fused rounds burst at the plate.

**`resolveVehicleHit` (systems/armour.ts):**
1. *Plate:* lookup by part, face, zone; normal tilted by slope and pitch; `needK`, `needS`.
2. *Kinetic:* ricochet if `cosInc < sinCrit·rf` (chance); else **penetrate if `can ≥ needK`** [C43] with residual, exit speed and deflection; else stopped.
3. *Shaped charge:*
   - grazing fuse failure; slat (`fuseShortChance`);
   - reactive tile on that face: consume one container item of the face's slot item and multiply `needS` by the factor (fixture only) [C12, C25];
   - otherwise `can = penSteelMm` (no velocity scaling, no ricochet); penetrate if `can ≥ needS`; the jet decays inside.
4. *HE contact:* the breach rule against thin plates; external components damaged by distance.
5. *Interior walk:* component and seat boxes in t order. Components lose condition. A seated man → `resolveBodyHit` (seated hitbox). At the far plate, an exiting kinetic round is **queued for re-adding** beyond the hull exit (`clipT1 + 0.05 + |v_veh|·dt·2`), not written into an old row [C44].
6. *Spall* cone (stream `armour`); shaped penetration also applies `applyBlast` (overpressure).
7. *Events and stress.* `vehicle.hit`, then `vehicle.component`s. `underFireTick`/`contactTick` on the crew unit and the platoon top. Crew suppression.

**Component effects** (`vehicleDamageSystem`):

| Component | Effect |
|---|---|
| engine | < 0.5 → P × 0.5; 0 → immobilised |
| transmission | 0 → immobilised |
| track | force × condition (natural pull, §4); 0 → immobilised |
| turret-drive | < 0.5 → manual × 0.25 |
| stabiliser | 0 → stabilisation off |
| gun / coax | 0 → that weapon out; all out → `disarmed` |
| sights | 0 → that seat falls back to `vision-block`, gunner error × 3 |
| radio | 0 → crew unit off the net (comms update reads it, §6) |
| dischargers | 0 → no smoke |
| fuel | hit → fire chance |
| ammo-ready / ammo-stowed | fire + cook-off chance; damaged belts' rounds removed from the container |
| extinguisher | 0 → no automatic extinguishing |

**Fire and catastrophic loss.**
- Fire intensity grows. The extinguisher fires one `chargeItem` from the container (counted) with the data chance.
- Otherwise the crew bail out after bailOnFireSeconds.
- Cook-off (time or roll) → `detonate(cookOffAmmo)`; occupants get `applyBlast` + `applyBurn`; status `destroyed`; `vehicle.destroyed`; wreck stamp; smoke while burning.

**Crew reactions** (`crewReactionSystem`, 1 Hz, staggered; triggers written to `reactionWhy`, `vehicle.decision` emitted) [C2, C21]:
- `bailOut`:
  - fire not out within bailOnFireSeconds;
  - an ammo hit with cook-off risk;
  - **immobilised and penetrated again** (a non-penetrating hit on an immobilised hull does *not* trigger bail-out);
  - commander panicked;
  - two penetrations within 30 s.
  Passengers leave with the crew; status `abandoned`.
- `reverseOut`: penetration without mobility kill; a known AT contact within atThreatM while the fire rule isn't free; firepower kill while mobile; commander shaken.
- `continue`: everything else, **including immobilised with a working gun under non-penetrating fire**.
Q14 and Q15 are worded to match (§16).

**Heavy projectiles.** The `wounds.json` `heavy` rule applies. Impact HE with `burstOnBody` bursts on a body hit (Q18). Only the new 30 mm HE carries the flag; existing infantry rounds keep today's behaviour [C53].

**Mortars.** A scattered point inside a hull footprint bursts on the roof.

**Stated simplifications:** box outline; 1/cos line of sight with a 20× floor; composite as two resistances; linear jet decay; statistical spall; fire and cook-off as probabilities; no plate weakening; yaw within a tick ignored in the hull test.

---

## 9. Panzerfaust 3 and RPG-7

**Data.**
- `ru-pg7vl` **moves** to ru/ammunition.json with the same id, so ru/units.json loads stay valid.
  - The loader derives `nameKey ammo.ru-pg7vl` (new string), category `ammunition` (was `anti-tank`) and mass = cartridgeMassKg [C67].
  - The UI and AAR groupings that read `category` are checked: the HUD item list, the AAR expenditure and `squads.test` mass bands. Any that grouped by `anti-tank` move to "delivery.method === direct".
  - Values as revision 1: 625 mild mm, 115 m/s, thrust to ≈ 300 m/s, self-destruct 4.5 s, filling 0.7 kg, effective range 300 m.
- `de-pzf3` is replaced in the loads by `de-pzf3-firing-unit` + `de-pzf3-dm12` (values as revision 1). The total stays 15.2 kg. de/units.json is updated in the same commit.

**Flight.** One integrator, `advanceFlight` in `packages/sim/src/flight.ts`, used by the hot loop (inlined, only for `am.thrust > 0`), `buildDropTable` (with `tof`) and the arc functions. Per-ammo `selfDestructTicks`. Test: the three agree within 0.5 m at 300 m.

**Firing.**
- `grenadeOption` skips method `"direct"`.
- Action `fireLauncher` (systems/launcher.ts):
  - `check()`: target known, line of fire, the back-blast rule (Q20), range, not pinned, **`atRule` allows this target** [C1]:
    - `vehicles` → vehicle contacts only;
    - `vehiclesAndPositions` → also building or MG-nest contacts;
    - `hold` → only on an explicit order.
  - `complete()`: aim, error, launch (owner = the man), remove the round (and the tube if disposable), `grenade.launched {method: "direct"}`.
- **Who fires:** an explicit fire order (any `atRule` except none); own decision per `atRule`; the AI through orders.
- **Hand-over:** the generalised item-wanted rule (§6).
- **Effect:** the shaped branch on hulls, otherwise `settle`/`detonate`.

---

## 10. Spotting, contacts and fog of war

**Targets.**
- Exposed men, plus one row per not-destroyed vehicle.
- **Size [C57]:** the projected visible area of hull and turret boxes at the observer's aspect (from the `VehicleRT` aspect table), divided by 0.7 m², times `signature.sizeFactor` (default 1; it does not count geometry twice). Puma side-on ≈ (7.6×2.0 + 2.6×0.85)/0.7 ≈ 25, front ≈ (4.0×2.0 + 2.3×0.85)/0.7 ≈ 14, hull-down side turret only ≈ 3.
- Motion and firing factors; visibility as the best aim point through `sight()` with ignores; range cap 3000 m for vehicle sensors.
- `targetAlive`. `maxTracked` 6 men + 2 vehicle slots.

**Observers.**
- Exposed men; crew through seat sensors; passengers do not observe.
- Smoke per sensor `smokeFactor` (thermal partly sees through conventional smoke) [C14].
- **Weather [C13]:** fog (`visibilityM`) caps every optical sensor. Thermal is capped at `max(visibilityM, 0.6 × sensor range)` (G). Rain multiplies thermal by 0.85 (G).

**Contacts.**
- Vehicle fields; drift 6 m/s; forget after 300 s; wrecks kept.
- Hearing:
  - (a) `shot.fired` with `vehicle` → a contact on the vehicle;
  - (b) engines every 2 s within `noise*M × SurfaceDef.noise × weatherNoise`, where `weatherNoise = 1 − 0.4·rain` and downwind ×1.2 / upwind ×0.8 from `windX/Y` (G) [C13];
  - mounted listeners hear nothing outside.
- Generalised target checks; radio keys.

**Knowledge and fog.** As revision 1. The renderer draws enemy vehicles only from `Overlay.known`.

**Suppression.** A vehicle is one listener for its crew; calibre scaling; 30 mm HE through `suppressByBurst`.

---

## 11. Orders, units, scenario and battle input, roster

**OrderBody:** `move` (+ per-waypoint `reverse`; `reverse?: true` sets all legs) [C20], `halt`, `fire` (+ `nature?`, `weapon?`), `ceaseFire`, `rules` (+ `atRule?`) [C1], `callFire`, `mount`, `dismount`, `discharge`. New reject reason `"not-applicable"`.

**Validation.**
- A vehicle id resolves to its crew unit.
- **move:** after the parent split, every waypoint mode's class must equal the receiving unit's class. A vehicle child that receives a foot-mode move from a platoon or the AI gets the mode's `vehiclePace[def.class]` (walk → drive-slow, run → drive) [C37]. A move addressed **directly** to a vehicle unit in a foot mode is `not-applicable`.
- `orderApplies(kind, unitKind, mounted)` table as revision 1.

**`applyOrder` return type [C65].** It widens to `boolean | "unable" | { unable: StringKey }`. `deliverOrders` maps `{unable: k}` to radio key `k` (`radio.noDriver`, `radio.immobilised`, `radio.noSeats`, `radio.noSmoke`). Existing returns are unchanged.

**`applyOrder` vehicle branch:**
- move → route on the class grid, `endHeading`;
- halt → brake;
- fire → `assignStationTask`; ceaseFire → clears it;
- discharge, dismount;
- rules → its own unit (§1).

**Parent split [C19, C37]:**
- foot men via `footSoldiers`;
- vehicle children get move (own route, slot, mapped pace), and rules (fireRule/onContact/atRule; `maxEngageM` only when the order names the vehicle unit);
- ceaseFire reaches vehicle children only when addressed to the platoon or to them;
- posture is skipped.

**Drills.** React-to-contact for a moving crew unit maps `onContact` (ground = halt and engage, push = drive on firing, back = reverse out). `drillGroups`/`breakUnit` ignore crew units and mounted men.

**Strings:** as revision 1, plus `radio.noSmoke`, `rules.at.vehicles|vehiclesAndPositions|hold`, the `why.*` and `reaction.*` debug keys, `vehicle.comp.<kind>` for all component kinds, and the AAR expenditure keys.

**Scenario (packages/scenario):**
- `ScenarioDef.vehicles?: boolean`.
- **Deployment on main [C26]:** `platoon`/`platoon-ru` stay infantry **by default until M7.4a lands**, when vehicles can be killed and the shoulder-fired AT works. From M7.2 the vehicle start is reachable through the URL option `&vehicles=1` and the tools scenarios. The owner note in M7.2/M7.3 says so. The default flips in M7.4a after a fresh baseline.
- `buildForce`/`buildUnit`: a template with `vehicle` → a fresh `VehicleRecord` in `ForceInput.vehicles` (vehicleId = unit key) and `UnitInput.vehicleId`. `carriage` on the parent template pairs crews and squads (`Unit.carrier`). `MemberSlot.seat` → `Placement.seat`. Nothing is drawn from the names or skills streams for the vehicle itself.
- **Attacker:** vehicles at the edge (8 % in) via `freeHullSpot`, preferring roads, 15 m apart. Carried men get `mountedIn`/`seat`. The HQ rides per Q1 (de) and Q2b (ru) [C9].
- **Defender:** men in the rings; each IFV 60–120 m behind the main objective, crew only.
- Map size 1200 × 900 (Q23).
- **Score:** `VictoryRules.vehiclePoints`; `battleScore` per Q9.

**Tools scenarios:** `vehicles`, `vehicles-fixture`, `bench-vehicles` (30 IFVs + ~300 men), **`bench-combined`** (300 men + 30 IFVs + a 20,000-projectile load from scripted fire) [C11, C32]. CLAUDE.md's scenario list is updated.

---

## 12. AI commander (packages/ai/src/commander.ts)

**Inputs the AI polls (no events; invariant 5) [C35].** From `SimView`:
- `vehicle` store: `drive.arrived`, `drive.route.length`, `status`, `lastHitTick`, `lastPenTick`, `seats` (aboard count), `crewReaction`;
- `unit.boarding` (null = done);
- `Unit.carrier`;
- `sideKnowledge` contacts with `cls`/`vtype`.
Its memory keeps last-seen ticks to detect changes ("a hit since my last think" = `lastHitTick > memory.lastHitSeen`).

**Sight for the dismount point [C58].** The commander builds its own context once, lazily, through the exported `createContext`. It is cached in the controller instance, never in its saved memory, and rebuilt after load. `ai → sim` is already allowed by the architecture test; the plan confirms `createContext` is exported from the sim index. The candidate search (≤ 8 `sight` calls) runs once per ride phase, not per think.

**Split** foot / vehicles, paired by `Unit.carrier`. Mounted HQ men are never ordered to walk. Vehicle losses go into memory as a separate withdraw trigger (2 of 3).

**Attack phases:** `start` → `ride` → `dismount` → `advance` → `recon` → `assault/second` → `hold`.
- **ride.**
  - Dismount distance `D = 300 + (1 − willingnessToDismount)·500` m. **Both factions currently have 0.5, so both dismount at 550 m** [C22]. A difference between the sides needs sourced doctrine data through `add-data-entry` (Q22).
  - The point is the last route point at ≥ D out of sight of the objective centre, with 12 m slots.
  - Vehicle units get their own rules (return fire, maxEngageM = engageRangeM).
- **dismount.** When `drive.arrived`, or at once when `lastHitTick` advanced, an AT/rocket contact is known within 400 m, or an enemy vehicle is seen. Order dismount, then wait until `boarding` is null (30 s cap).
- **base of fire:** hull-down support spots; fire orders (HE at men, AP at vehicles); shift or stop at 80 m from own assaulting squads.
- **hold [C29]:** a squad still aboard within `dismountHoldM` of an objective it is to hold is ordered to dismount, so mounted men never sit next to an objective uncounted.
- **withdraw:** vehicles reverse covering; re-mount per Q24.

**Defence:** fire free; vehicle units get their own rules; alternate spot 100 m back; counterattack support.

**Contact classes:** no grenades, rifle base of fire or mortar counting against vehicle contacts. Vehicle contacts drive AT (per `atRule`) and station tasks.

---

## 13. Rendering and UI (minimal; M7.5 replaces the look)

**Renderer:**
- `drawVehicles` (hull, turret, barrel, selection, callsign + "+n", status marks, minimum 10 px, overview symbols); the soldier loop skips mounted men; interpolation of heading and turret.
- Projectile style from delivery; `onEvents` for `vehicle.hit` (aggregated hits draw one spark cluster), `vehicle.smoke`, `vehicle.destroyed`.
- Routes, with reverse legs in their own colour from `Waypoint.reverse` [C20]; `drawPlan`; `drawKnown`.
- **Debug overlay [C2]**, shown when a vehicle is selected with debug on:
  - the `tracked:c1` grid, look-ahead point and corridor;
  - **turret lay**: azimuth/command arc, laid or not, `laidTick` age;
  - **station decision**: target line, nature, top `why` keys (translated);
  - **crew reaction**: state and `reactionWhy` keys;
  - **seat-swap** progress;
  - per-track speeds.
  It is fed by `vehicle.decision` events plus the selected unit's render snapshot (render reads events and the overlay snapshot, never internals).
- **Render cost [C11]:** `drawVehicles` uses the per-type outline cache and one path per side colour. `render/test/perf-render.test.ts` (timing, run with `test:perf`) draws 30 hulls + 300 men + 2000 tracers into an OffscreenCanvas mock and asserts < 4 ms per frame on CI as a proxy. Phone screenshots of `bench-vehicles` are reviewed.

**App/UI:**
- `pickAt`, `ordersFor`, `Hud.setOrders` as revision 1.
- The Rules panel adds the **anti-tank rule** (vehicles only / vehicles and positions / only on order) [C1].
- **`showUnit` for a vehicle [C3]:** hull status; **every component's condition** (engine, transmission, left/right track, turret drive, stabiliser, gun, coax, gunner/commander sight, radio, dischargers, extinguisher, fuel, ammo racks) as word + bar; rounds ready per feed and stowed; smoke salvos; extinguisher charges; fuel litres; crew per seat with wound state; passengers n/seats.
- **AAR and timeline [C4]:**
  - lines for vehicle hit, immobilised, burning, destroyed, bailed out; a vehicles block per side; wrecks on the heat map;
  - **ammunition expenditure per side split by source**: `shot.fired` with `vehicle` → cannon (per nature) and coax, credited to the vehicle, not the gunner's personal tally; `grenade.launched {method: "direct"}` → rockets per type; `vehicle.smoke` → smoke salvos; extinguisher charges.
  - The batch CLI gets the same columns (M7.3, M7.4b).
- `window.__tcs` gains `select`, `mount`, `dismount`, `reverse`, `discharge`.
- Screenshot scenes as revision 1, plus the vehicle panel and the debug overlay.
- Old browser saves fall back via `app.loadFailed` at each schema bump; the owner is told.

---

## 14. Tick order and performance budget

**`step()`:**
1. comms update (reads radio components)
2. `rebuildVehicleGrid(ctx, state)` A (pre-drive pose = current; dx = dy = 0)
3. `receiveOrders`, `deliverOrders`
4. `actionSystem` (mount, dismount, loadCasualty, bailOut, seatSwap, reloadStation, fireLauncher, …)
5. `postureSystem`
6. `evadeSystem`
7. `vehicleDriveSystem`
8. `vehicleSyncSystem` + `rebuildVehicleGrid` B (post-drive pose; keeps the pre-drive pose as `x0, y0, ch0, sh0` and `dx, dy`) [C33]
9. `movementSystem` (exposed men; hull slide incl. wrecks; `unitArrived`)
10. `physiologySystem`
11. `turretSystem`
12. `fireSystem`
13. `stationFireSystem` (+ due smoke)
14. `supportSystem`
15. `projectileSystem`: fill, near byte, APS pre-check, narrow test, early-out, `VHQ`; after the loop: APS → bursts → `resolveVehicleHit` → re-adds
16. `vehicleDamageSystem`
17. `grenadeReactionSystem`; `incomingFireSystem` (vehicle-aware early return)
18. `woundSystem`
19. `moraleSystem`
20. `crewReactionSystem`
21. `spottingSystem`; `contactSystem`
22. `surrenderSystem`
23. `decisionSystem` (+ launcher, + `stationDecision`, + container resupply)
24. `drillSystem` (+ `boardingSystem`, vehicle react-to-contact)
25. `objectiveSystem`

`loadSim` runs `syncTerrainDamage` (breaches + wreck stamps) and `rebuildVehicleGrid`. **Why it holds:** as revision 1, plus the pre-drive pose for the hull test.

**Budget** (300 men + 30 vehicles + 20,000 projectiles; SPEC 8×; current bullet bench 4.3–5.8× against a 3× floor):

| Cost | Estimate |
|---|---|
| Projectiles | one byte read instead of two; flagged rounds ≈ 10 dot products + 6 clips per nearby hull; `can` via lookup, no `pow`; early-out with no call |
| APS | rows with `apsR > 0` only (none in real data) |
| Drive | per track 2 force updates; ≈ tens of µs/tick |
| Spotting | gain from mounted men leaving the O(n²) scan; vehicle DDA in `sight()` only when vehicles exist, bucket bit first |
| Nav | Uint8/Uint16 vehicle grids (≈ 1.6 MB at 1200 × 900, ≈ 5 MB at 2 × 2 km); local patches |
| Render | outline cache; < 4 ms proxy test |

**Perf tests** (timing files only; run alone):
- `perf.test.ts`: `bench-vehicles` ≥ 8×; "ten IFVs firing HE" ≥ 8×; **`bench-combined` (300 + 30 + 20,000) ≥ 3× floor, recorded against the SPEC 8× target, and ≤ 5 % slower than the same load with the vehicles parked out of the fire** [C32].
- `perf-projectiles.test.ts`:
  - bullet-mix ids **and the fragment-storm sleeve id are pinned** [C59];
  - variant with 30 parked hulls (M7.1c, before cannon HE) within 5 % of the no-vehicle figure [C66];
  - variant with hull hits (M7.4a).
- `render/test/perf-render.test.ts` [C11].
- Baselines and after numbers go to DECISIONS.md.

---

## 15. Slices

**Every slice:**
- ends with `npm run check` green (timing tests alone), `npm run lint:data`, screenshots looked at, `finish-milestone`;
- **every commit is green on its own and runs at most one `golden:update`, each with a DECISIONS.md line** [C46];
- before each update, compares the headless event counts and casualties of `demo-s1`, `shootout-s1` and `fixture-s7` against main. They must be identical apart from hashes, except where intended and logged.

**Foundation table rows** (`docs/ARCHITECTURE.md`) are added or turned green as named below [C5]:

| Req | Guard | Turns green in |
|---|---|---|
| 9.2 Vehicles have fuel and component states | `sim/test/roster.test.ts` "forcesOut returns fuel = in − burnt"; `sim/test/armour.test.ts` "component damage changes drive/fire as the table says" | fuel M7.1b (🟡), components M7.4b (✅) |
| 6.7 Physical drive model (tracked differential, wheeled radius) | `tools/test/lab-drive.test.ts`, `sim/test/drive.test.ts` | M7.1b/c |
| 6.7 Crew seats, no driver no movement, passengers soldiers | `sim/test/mount.test.ts`, `sim/test/orders.test.ts` "no driver → unable" | M7.2 |
| 6.7 Turret, sights, ammo racks | `tools/test/lab-gunnery.test.ts`, `shootout.test.ts` conservation | M7.3 |
| 6.7 Plates per facing, penetration, components | `tools/test/lab-armour.test.ts`, `sim/test/armour.test.ts` | M7.4a/b |
| 6.7 APS slot, smoke dischargers, recovery reserved | `fixture-faction.test.ts` "xf charm intercepts and is counted"; `support.test.ts` smoke | M7.4a / M7.3 |
| 4.3.5 "vehicle hit" event | `sim/test/armour.test.ts` "every hull hit yields a vehicle.hit (aggregated below 12.7 mm)" | M7.1c |
| 4.4 Scale with vehicles | `perf.test.ts` `bench-vehicles`, `bench-combined`; `perf-render.test.ts` | M7.1c / M7.3 |
| Mounted-man invariants | `architecture.test.ts` A7; `tools/test/mounted-invariants.test.ts` | M7.1c / M7.2 |
| 9.1 Casualties loaded into a vehicle | `sim/test/mount.test.ts` "a casualty within 5 m of the exit is loaded by two men" | M7.2 |
| 9.2 Vehicle-carried reserves, cross-loading | `sim/test/mount.test.ts` "squad refills from its carrier"; `armour.test.ts` "belts taken from an abandoned hull" | M7.2 / M7.4b |
| 9.3 Wrecks and vehicles as roster data | `roster.test.ts` "BattleResult.wrecks and ForceResult.vehicles round-trip" | M7.4b |
| 9.7 Environment read by vehicle movement and hearing | `lab-drive.test.ts` "rain lowers traction"; `contacts.test.ts` "rain shortens engine hearing" | M7.1b / M7.3 |
| 6.6 Standing AT rule | `sim/test/launcher.test.ts` "atRule hold: no own launcher fire" | M7.4a |
| 6.6/5.7 Decision debug overlay | `render/test/debug-overlay.test.ts` "station why + reaction why drawn from events" | M7.3 / M7.4b |

### M7.1 Vehicle entity, data, drive, navigation, move/halt/reverse, hulls as obstacles, drawing (three commits)

**M7.1a Refactor, behaviour unchanged (no golden update).**
- Files: `packages/sim/src/{ballistics,terrain,los}.ts`, `systems/{ballistics,explosions,fire}.ts`, `packages/tools/test/perf-projectiles.test.ts`.
- Steps:
  1. Merged `near` byte.
  2. `segmentsInRectInto` returning **strictly ascending segment ids** (the scratch stamp collects, then a small in-place insertion sort over the found ids) [C47]; used by `sight`, `detonate`.
  3. Allocation-free roof handling in `sight()` [C60].
  4. Fire helpers split.
  5. `dropAt` range-aware cache key and `{drop, tof}` return [C48].
  6. Pin bullet and fragment-storm ammo ids [C59].
  7. Perf before/after.
- Tests:
  - goldens pass unchanged;
  - `terrain.test.ts` "segmentsInRectInto returns **the same ids in the same order** as segmentsInRect" on 4 map kinds [C47];
  - perf ≥ previous − 3 %.

**M7.1b Data, state and drive (one golden update).**
- Files: `packages/data/src/{schemas,loader,catalog,lint}.ts`, `factions/{de,ru}/vehicles.json`, `fixtures/factions/xf/vehicles.json`, `core/terrain/{surfaces,obstacles,materials}.json`, `core/movement-modes.json`, `core/{ballistics,behaviour,spotting}.json`, `core/strings.en.json`, `packages/sim/src/{catalog,components,state,battle,setup,run,sim,mount,events}.ts`, `systems/{drive (new),body,movement}.ts` (`footMode`) [C42], **`packages/sim/test/helpers.ts` and `packages/sim/test/grenades.test.ts` (obstacle `vehicle` block)** [C41], `packages/ui/src/planner.ts` (`footMode`), `packages/tools/src/labs/drive.ts` (new, scripted-controller orders), `cli/lab.ts`, `docs/DATA_GUIDE.md`, `docs/ARCHITECTURE.md` (rows above).
- Steps:
  1. Schemas, loader checks, deep `noProv`, `Catalog.vehicles`, movement-mode union.
  2. `VehicleState` and the optional fields; schema 16.
  3. Force-level `VehicleRecord` in and out.
  4. Setup creates V and seats crew.
  5. `vehicleDriveSystem` with per-track dynamics. Driven in this commit only by a **`move` order to a crew unit through a minimal vehicle branch in `applyOrder`** (route straight to the waypoints on the foot grid's hard blocks; the full nav lands in M7.1c). There is no lab hook [C18, C56].
  6. Fuel litres; rain factors.
  7. `rhaToMildSteel` test.
- Tests:
  - loader clone-and-break cases (as revision 1, plus `loaderStation`, `chargeItem`, `carriage`);
  - `lab-drive.test.ts` bands (§4);
  - `fixture-faction.test.ts` "xf-cart loads and keeps its turn radius";
  - `determinism.test.ts` "a vehicle-only run driven by move orders is identical twice and through a JSON save mid-pivot";
  - `roster.test.ts` "forcesOut returns the vehicle record with fuel = in − burnt; a vehicle whose crew unit is gone still comes out" [C30];
  - `catalog.test.ts` "no provenance key at any depth";
  - `drive.test.ts` "stepDriveDynamics is pure (input unchanged)".

**M7.1c Navigation, orders, collisions, sight/bullets vs hulls, drawing (one golden update, adds `vehicles-s1`, `fixture-cart-s3`).**
- Files: as revision 1, plus `packages/sim/src/comms.ts` (radio component), `packages/render/test/perf-render.test.ts`, `packages/tools/test/architecture.test.ts` (A7 wide).
- Steps:
  1. Compact clearance grids; breach exemption from dilation; obstacle costs.
  2. `patchNavGrids` with the exposure ring; wreck stamping (cost 0 in all grids).
  3. Order validation by class with pace mapping; `orderApplies`; widened `applyOrder` return; move (per-leg reverse) and halt; `unitArrived`; parent split with `fireTop`.
  4. Follower, corner guard, yield, corridor evade, hull slide; outline vs true polygons.
  5. `rebuildVehicleGrid` A/B with the pre-drive pose; near-byte bit; `sight` DDA and `lineBlocked` hull test; projectiles **stop** at hulls; aggregated `vehicle.hit`.
  6. Crew gates in every loop, including the `state.weapon` lull reload and `friendInLine`.
  7. Drawing, `pickAt`, `ordersFor`, paces, plan outline, debug overlay (nav + track speeds).
  8. Scenarios `vehicles`, `vehicles-fixture`, `bench-vehicles`.
  9. **A7 widened [C28, C52]:** scans `packages/sim/src/**` (not only systems), `packages/ai/src/**`, `packages/render/src/**` and `packages/app/src/**` for:
     - loops over `state.soldier`, `state.identity`, `state.mover`, `state.weapon`, `state.fire`;
     - calls of `unitSoldiers(`, `allMembers(`, `sideKnowledge(`.
     Each needs a mount gate (`isMounted`/`isExposed`/`footSoldiers`) or a `// mounted: ok <reason>` marker. Faction-literal scan extended to `packages/scenario`.
- Tests:
  - `nav-maps.test.ts`: routes kept on every kind × seeds 1–8; "a scripted Puma drive never overlaps a building or deep water"; **"village stall rate < 5 % of 100 random routed moves"** [C62]; **"vehicle grid bytes and build time at 2 × 2 km within budget"** [C31].
  - `nav.test.ts`: "patchNavGrids equals a full rebuild (cost, wall, exposure, region) after a breach, a flattening and a wreck stamp" [C38]; "a hull-width breach in a brick wall stays open in tracked:c1" [C50]; "a flattening crossing at 45° writes a breach with id/part/offset and width ≈ hull/sin" [C17, C40].
  - `orders.test.ts`: as revision 1; "a platoon move in walk gives its vehicle children drive-slow" [C37]; "a ceaseFire to a squad does not stop its platoon's IFV; to the platoon it does" [C19]; "a platoon rules order with 300 m does not cap the vehicle's range" [C19]; "a platoon with a driving IFV arrives only when the hull has arrived" [C36]; "no driver answers radio.noDriver" [C65].
  - `drive.test.ts`: as revision 1, plus "a man routes round a wreck without looping" [C54]; "a grenade landing on a hull ends on the ground beside it" [C55].
  - `ballistics.test.ts`: "a 1400 m/s round never passes through a moving hull, and hits it where a slow-moving reference says (≤ 0.05 m)" [C33]; rifle bullets stop; hull-down hit only on the turret; "rifle hits produce one aggregated vehicle.hit per tick" [C24].
  - `los.test.ts`: "a man behind a hull is unseen, also when the line's samples skip the hull's bucket" [C60]; blast shielding.
  - `fire.test.ts`: "a seated gunner's rifle starts no reload" [C52]; "riflemen fire past a friendly IFV with passengers aboard" [C51].
  - `comms.test.ts`: "radio component 0 keeps the crew unit off the net after update" [C63].
  - `perf.test.ts` `bench-vehicles` ≥ 8×; `perf-projectiles` 30 parked hulls within 5 %; `perf-render` < 4 ms.
  - `ui/test/orders-for.test.ts`, planner, marker-vs-sim as revision 1. `architecture.test.ts` A7 wide.
- Lab: `npm run lab -- drive`.
- Acceptance: as revision 1. Vehicles appear only in `?scenario=vehicles` and the tools scenarios.

### M7.2 Passengers, mount and dismount, mounted start (opt-in), AI ride and dismount — ✅ done
- **Files:** as revision 1, plus `systems/boarding.ts` (new: mount, dismount, loadCasualty, seatSwap handlers, `boardingSystem`), `systems/decisions.ts` (container resupply), `comms.ts`, `packages/sim/src/knowledge.ts` (gate).
- **Steps:**
  1. Owner answers to Q1, Q2, Q9, Q10, Q12, Q25 first.
  2. **Record a fresh platoon / platoon-ru infantry baseline (10 × 900 s each).**
  3. `mount`/`dismount` orders; `Unit.boarding`; timed actions with exit queues; `boarding.then`; `loadCasualty`; `seatSwap`; `noDriver`; intercom.
  4. Passenger gates (the §6 table); objective/side-presence rule [C29].
  5. Crew templates; `carriage`; roles; record generation; seat path via `Placement.seat`.
  6. Mounted attacker start and defender IFVs behind, **behind `ScenarioDef.vehicles` and the app's `&vehicles=1`** (default off on main) [C26].
  7. AI split and ride/dismount by polled state [C35].
  8. "+n aboard", Mount mode, tap cycle.
  9. Batch columns: vehicles lost/immobilised, dismount time.
  10. Container resupply.
- **Tests:**
  - `mount.test.ts`: as revision 1, plus "a casualty within 5 m is loaded by two men; one beyond stays and does not block completion" [C7]; "squad refills from its carrier, items conserved" [C6].
  - `mounted-invariants.test.ts`: as revision 1, plus "seated men are absent from sideKnowledge, never get a reload action, never block friendInLine, and the AI never orders them to walk" [C28, C52].
  - `objectives.test.ts`: "a side whose men are all aboard is not broken and does not hold" [C29].
  - `determinism.test.ts`: save mid-dismount, mid-mount and mid-loadCasualty.
  - `scenario-platoon.test.ts` (with `vehicles: true`): as revision 1, plus "the ru platoon commander is seated per the Q2 answer" [C9].
  - `commander.test.ts`: "AI rides, dismounts on arrival and at once on a hull hit (polled lastHitTick)"; "a mounted squad near its hold objective dismounts".
  - `fixture-faction.test.ts`; `lab-mount.test.ts`.
- **Acceptance:** with `&vehicles=1`, platoon battles start mounted. The owner note states that the vehicles cannot fire or be damaged yet and that the default stays infantry until M7.4a.

### M7.3 Turret, 30 mm and coax with counted ammunition, sights and vehicle spotting, fire orders and own fire, smoke dischargers — ✅ done
- **Files:** as revision 1, plus `render/test/debug-overlay.test.ts`, `packages/tools/src/cli/batch.ts` (expenditure columns).
- **Steps:**
  1. Weapons, ammunition, belts, smoke items.
  2. Turret and station fire; single-feed/loader path on the fixture [C10]; lead from `tof`; HE at ground level; `burstOnBody` (Q18).
  3. Fire/ceaseFire/discharge; `stationDecision` with `why`; `incomingFireSystem` vehicle-aware [C34]; hull hits feed `underFireTick`.
  4. Vehicle target rows with geometric size [C57]; seat sensors; per-sensor smoke and weather [C13, C14]; contacts; engine hearing with rain and wind; fog symbols.
  5. Heavy-projectile wounding; calibre suppression.
  6. AI base of fire; defender cannon rules.
  7. AAR and batch expenditure split by `shot.fired.vehicle` [C4].
  8. `bench-combined` scenario and perf test [C32].
  9. Plates still a single early-out.
- **Tests:**
  - as revision 1, plus `turret.test.ts` "station fire restarts with no infantry fire task (incomingFire early return)" [C34];
  - `fixture-faction.test.ts` "xf sling fires one bolt per load; slower with no passenger loader" [C10];
  - `contacts.test.ts` "rain shortens engine hearing";
  - `spotting.test.ts` "a thermal sight sees a hull through conventional smoke at half strength; eyes do not" [C14];
  - `aar.test.ts` "cannon rounds are credited to the vehicle, not the gunner" [C4];
  - `debug-overlay.test.ts` "station why drawn" [C2];
  - `ballistics.test.ts` "VOG-25 behaviour unchanged (no burst on body)" [C53].
- **Acceptance:** as revision 1; still opt-in on main.

### M7.4a Armour and penetration, Panzerfaust 3 and RPG-7, simple damage outcome (the shoulder-fired AT the owner named lands here) [C27] — ✅ done
- **Files:** `core/terrain/materials.json`, `core/{ballistics,wounds}.json`, `factions/*/vehicles.json` (plates), `factions/ru/{items,ammunition}.json` (`ru-pg7vl` move), `factions/de/{items,ammunition,units}.json`, `packages/data/src/schemas.ts`, `packages/sim/src/flight.ts` (new), `ballistics.ts` (`VehicleRT` plates, AmmoRT shaped/thrust/lookup), `systems/ballistics.ts` (`VHQ`, APS pre-check, thrust, self-destruct, re-adds), `systems/armour.ts` (new: `resolveVehicleHit` with plate test and a **simple outcome table** on penetration: crew wound draws via seat boxes along the path, a component hit by path, a fire chance), `systems/launcher.ts` (new), `context.ts`, `packages/scenario/src/battle.ts` (points, `vehicles` default on), UI strings and rules panel for `atRule`.
- **Steps:**
  1. Materials, plates, `VehicleRT`.
  2. `VHQ`, kinetic and shaped resolution, HE contact, path-only interior, APS slot (fixture).
  3. Shared integrator with thrust; `fireLauncher`; `atRule`; hand-over.
  4. Vehicle points.
  5. **Fresh baseline, then the platoon scenarios' `vehicles` default turns on** [C26].
- **Tests:**
  - **`lab-armour.test.ts` [C43]:**
    - "PMC287 at the 1000 m speed defeats 53 mm armour steel at 60° (can ≥ need at nominal) and is stopped by 1.03 × 53 mm";
    - "3UBR8 at the 1500 m speed defeats 25 mm at 60° and is stopped by 1.03 × 25 mm";
    - "Puma front stops PMC287 at 1000 m at +3 % velocity; sides stop 14.5 mm";
    - "BMP-2 front stops 23 mm AP at 500 m; sides stop 7.62 AP at 75 m, not 12.7 mm";
    - Pzf 3 / PG-7VL per Q21; ricochet only at grazing angles.
  - `lab-antitank.test.ts` as revision 1.
  - `flight.test.ts`.
  - `ballistics.test.ts` **"no addProjectile during the loop phase (debug counter `ctx.ballistics.loopAdds === 0`), with hull hits, APS intercepts and over-penetrations"**. Bursts after the loop are allowed [C45].
  - `fixture-faction.test.ts` "xf charm intercepts a rocket before the hull (no jet on the plate), the charge is removed from the container; a failed intercept hits next tick" [C16]; "an xf shingle is consumed on a shaped hit" [C12].
  - `launcher.test.ts` "atRule hold: no own launcher fire; vehiclesAndPositions: fires at an MG nest" [C1]; `grenades.test.ts` rockets never thrown; `squads.test.ts` loads 22–45 kg; "ru-pg7vl string and AAR grouping still present" [C67].
  - `determinism.test.ts` "save every 37 ticks with a rocket in flight".
  - `perf-projectiles.test.ts` hull-hit variant within 5 %.
- **Acceptance:** IFVs can be penetrated and knocked out by the simple outcome. AT men fire Pzf 3 and RPG-7 on order and per `atRule`. Platoon battles start mounted by default.

### M7.4b Components, fire and cook-off, crew reactions, AI anti-tank use, wrecks as data, batch report — ✅ done
- **Files:** `core/behaviour.json`, `factions/*/vehicles.json` (components tuned), `systems/armour.ts` (full interior walk, spall, `vehicleDamageSystem`, `crewReactionSystem`), `systems/{wounds (applyBurn), explosions, support, decisions}.ts`, `packages/sim/src/{battle,setup,run}.ts` (`BattleResult.wrecks`, `ForceResult.vehicles`), `packages/ai/src/commander.ts`, `packages/render/src/renderer.ts`, `packages/app/src/main.ts`, `packages/ui/src/aar.ts`, `packages/tools/src/labs/{armour,antitank,attack}.ts`, `packages/tools/src/cli/batch.ts`, `docs/STATE.md`.
- **Steps:**
  1. Full interior walk and spall.
  2. Component effects, fire, extinguisher charges, cook-off, wrecks.
  3. Crew reactions and passenger bail-out with `reactionWhy`.
  4. Cross-loading from abandoned hulls [C6].
  5. AI dismount on AT threat, reverse out, AT tasks.
  6. Wrecks and vehicle records as battle output [C8].
  7. AAR, timeline, batch.
- **Tests:**
  - `armour.test.ts`: as revision 1, plus "component damage changes drive/fire as the table says"; "immobilised + non-penetrating hit → continue; + penetration → bail out" [C21]; "belts taken from an abandoned enemy hull, conserved" [C6]; "extinguisher charges counted" [C12].
  - `roster.test.ts` "BattleResult.wrecks and ForceResult.vehicles round-trip" [C8].
  - `debug-overlay.test.ts` "reaction why drawn" [C2].
  - `determinism.test.ts` "save every 37 ticks with a burning vehicle".
  - `lab-attack.test.ts`.
- **Batch:** platoon / platoon-ru 10 × 900 s each way vs the M7.2 infantry baseline, the M7.4a figures and M6.5, with expenditure columns.
- **Acceptance:** as revision 1 M7.4.

---

## 16. Questions for the owner
Each is asked as multiple choice with the recommended option first, through the clickable question tool. Ask 1–4, 9, 10, 12 and 25 at the start of M7.2, and the rest at the start of the slice that needs them.

1. **German platoon seats** (20 men, three Pumas seat 18):
   - (a) a fourth Puma carries the platoon leader and his radio operator (recommended);
   - (b) the platoon leader commands one of the three Pumas and the radio operator takes a passenger seat.
   The earlier option "the two men walk" is dropped: it breaks your decision that the attacker rides in [C23].
2. **Russian squad leader and platoon commander [C9]:**
   - (a) fixed three-man BMP-2 crews; each squad leader rides in the back with his squad, and the platoon commander rides in the back of the first BMP-2 (7 seats: 6 + 1) (recommended; matches "3 crew + 7 seats");
   - (b) the platoon commander commands the first BMP-2 (as is common practice) and its commander rides in the back;
   - (c) each squad leader commands his BMP-2 and gets out with his squad, leaving gunner and driver aboard.
3. **IFVs and walls:**
   - (a) flatten fences, hedges and wire (they then become gaps you can see and shoot through), and use gates and roads around brick and stone walls (recommended);
   - (b) drive through anything except concrete and leave walls standing;
   - (c) roads, tracks and gates only.
4. **Men in a vehicle's path:**
   - (a) vehicles stop or steer around anyone, and men step aside (recommended);
   - (b) vehicles may run over enemy soldiers.
5. **Hatches:**
   - (a) buttoned up in M7 (recommended);
   - (b) commander head-out.
6. **Enemy vehicle type under fog:**
   - (a) shown once seen within about 1.5 km (recommended);
   - (b) "vehicle" until close.
7. **Thermal sights and smoke [C14]:**
   - (a) ordinary smoke blinds eyes and day sights fully, while thermal sights still see a vehicle through it at reduced strength; that is how it works in reality and what the SPEC asks (recommended);
   - (b) smoke blocks every sight equally. Simpler, but it changes the SPEC ("night and smoke interact differently with each sensor type") and would be logged as a SPEC change.
8. **Wrecks:**
   - (a) both sides see a wreck at once (recommended);
   - (b) only after it was seen.
9. **Points:**
   - (a) destroyed or abandoned IFV 20, immobilised 10 (recommended);
   - (b) nothing.
10. **Holding objectives:**
    - (a) only men on foot hold or contest. Men aboard still count as present, so a side is not "wiped out" while they ride, and the AI gets them out near an objective it holds (recommended);
    - (b) men inside count too.
11. **What a penetrating hit does inside:**
    - (a) path plus fragment cone (recommended);
    - (b) a simple chance for everyone.
12. **Orders to a squad still aboard:**
    - (a) get out first, then carry it out (recommended);
    - (b) "unable" until Dismount.
13. **Driver or gunner killed:**
    - (a) a crewman takes over after about 20 s (recommended);
    - (b) a passenger may too;
    - (c) nobody.
14. **Bailing out [C21]:**
    - (a) the crew get out when the vehicle burns, or when it is immobilised and then **penetrated** again; passengers get out with them (recommended);
    - (b) passengers get out at the first penetration;
    - (c) crews never bail out.
15. **A crew that cannot drive but can shoot [C21]:**
    - (a) stays and fights while hits bounce off; it bails out if it is penetrated again or burns (recommended, same rule as 14a);
    - (b) always bails out.
16. **Puma second ammunition:**
    - (a) impact HE in M7, air-burst later (recommended);
    - (b) air-burst in M7.3.
17. **Refilling ready ammunition in battle:**
    - (a) BMP-2 can, the Puma's unmanned turret cannot (recommended);
    - (b) both, halted, about 90 s;
    - (c) neither.
18. **A 30 mm high-explosive round that hits a man directly:**
    - (a) it bursts on him (recommended; only the new cannon rounds, rifle grenades and mortars stay as they are);
    - (b) it passes through and bursts behind him.
19. **Default anti-tank rule for new units [C1]** (each unit can change it in its Rules panel):
    - (a) use Panzerfaust and RPG on their own only against vehicles; you may order a shot at a building (recommended);
    - (b) on their own against vehicles, houses and machine-gun nests;
    - (c) only when ordered.
20. **Firing from a room:**
    - (a) not allowed unless breached or large (recommended);
    - (b) allowed with injury behind;
    - (c) freely.
21. **Puma front against an RPG-7:**
    - (a) a single PG-7VL can penetrate it anywhere (recommended);
    - (b) the front stops it.
22. **Where the AI attacker gets out [C22]:**
    - (a) about 550 m short of the objective, out of sight of known enemies. Both armies' doctrine data currently give the same value; a difference between them needs sourced doctrine research first (recommended);
    - (b) research and set different doctrine values for each side now;
    - (c) always close (200–300 m).
23. **Map size:**
    - (a) keep 1200 × 900 m in M7 (recommended);
    - (b) 2000 × 1500 m.
24. **Re-mounting during a withdrawal:**
    - (a) squads within 100 m get back in (recommended);
    - (b) separately.
25. **Wounded men when a squad mounts [C7]:**
    - (a) two comrades load a wounded man near the vehicle (within a few metres); wounded farther away stay where they are until medical evacuation arrives in a later milestone (recommended);
    - (b) the squad waits and carries every wounded man to the vehicle (slower; needs the M10 carrying first);
    - (c) wounded are always left behind.
26. **Vehicle battles on the published game before the IFVs can be damaged [C26]:**
    - (a) keep them behind a URL switch until Panzerfaust and RPG work (M7.4a) (recommended);
    - (b) switch them on as soon as the mounted start works (M7.2), with invulnerable carriers for two slices.

---

## 17. Risks and mitigations

- **Performance headroom is thin** (bullets 4.3–5.8× vs 8×). Mitigations:
  - near-byte refactor alone first, with numbers;
  - early-out with no call; `can` by lookup;
  - 30-parked-hull variant in M7.1c before cannon HE [C66];
  - `bench-combined` (300 + 30 + 20,000) with a 5 % gate against parked vehicles, so a combined regression cannot pass by splitting the load [C32];
  - the fragment-storm sleeve pinned [C59];
  - a 5 % projectile-bench regression blocks a slice.
- **Mounted-man leaks** [C28, C52]:
  - A7 scans all of sim/src, ai, render and app, for soldier, identity, mover, weapon and fire loops and for `unitSoldiers`/`sideKnowledge` calls;
  - the runtime `mounted-invariants` test covers reload, `friendInLine`, knowledge and AI walking;
  - every new system must pass both.
- **Owner/platform semantics.** `platformOf` and `shot.fired.vehicle` are used consistently. Fog, contact and AAR tests cover them.
- **Determinism of derived tables.** Rebuild points fixed. The pre-drive pose is kept in the grid [C33]. Save-every-37-ticks tests.
- **Golden churn.** At most one update per commit, each logged, with an event-count comparison first [C46].
- **Data quality.** Game values are listed in STATE.md and constrained by the labs. The drive bands were widened where the given data sits on an edge, and BMP-2 brake was added [C61].
- **One-scale mistakes.** `rhaToMildSteel` test; `can ≥ need`; decimal-exact conversions; boundary tests at ±3 % thickness [C43].
- **Navigation stalls near buildings** [C62]:
  - the outline is tested against true polygons, not grown cells;
  - the village stall-rate test (< 5 %);
  - if it fails: clearance c2 on open ground with c1 on road cells (a per-cell clearance map). That is a contained change in `buildNavGrid`.
- **Nav memory and rebuild cost at large maps** [C31]:
  - Uint8/Uint16 vehicle grids; size and build-time test at 2 × 2 km;
  - 4 m vehicle cells if 4 km maps come;
  - local patches only;
  - the patch region is bounded (breach rect + 4 m + clearance), so its cost does not grow with map size.
- **Breach rebuild hitches** until `patchNavGrids` lands in M7.1c, before any flattening.
- **Balance upheaval.** Infantry baseline recorded in M7.2; vehicles default-off until M7.4a; batch after M7.4a and M7.4b.
- **Top-unit coupling** [C19, C63]:
  - `fireTop` separates crew fire control from the platoon;
  - order-split tests for ceaseFire and rules;
  - comms update reads the radio component.
- **M7.4 overrun** [C27]:
  - M7.4 is split. M7.4a delivers armour, penetration, a simple outcome and the Pzf 3/RPG-7 the owner named. M7.4b adds component detail, reactions, AI AT and the batch.
  - If M7.4b overruns, cut in order: spall cone → path only; fire → immediate outcome table; gears → one band; AI AT tasks → player-ordered only.
- **Schema churn** [C64]. Schema 16 declares what is known; expect a bump for ABM or VHQ outcome fields. Each bump is logged, and the owner is told that old browser saves stop loading (`app.loadFailed`).
- **Invulnerable carriers on main** [C26]. Default-off until M7.4a (Q26); opt-in URL switch for testing.
- **Seat and crew data** block M7.2 until Q1, Q2, Q12 and Q25 are answered.
- **Roster coupling** [C30]. Vehicles are force-level assets in `ForceInput`/`ForceResult.vehicles`, linked to crews by `vehicleId`. A dead or reassigned crew does not lose the vehicle record. The campaign's replacement rules (SPEC 9.3) can reassign crews without touching vehicle records.
- **Objective and presence edge cases** [C29]. Foot-only holding, mounted presence for the side-broken rule, AI dismount near hold objectives, and a test.
- **APS ordering** [C16]. The pre-check removes a rocket before the plate. A failed intercept re-adds it after the loop. The fixture test proves no jet is queued on an intercepted round.
- **Pool row invalidation** [C44, C45]. Hits are removed in the loop and re-adds happen after it; the loop-only `loopAdds` counter is the guard.
- **Flattened obstacles become openings** [C40]. Intended and logged. The owner's Q3 text says so.
- **ru-pg7vl move side effects** [C67]. String key, category and mass change; AAR and HUD groupings are checked; tests on loads and strings.
- **AI context cost** [C58]. Built once per controller, lazily, not saved; candidate sight search once per ride phase.
- **Boarding state** [C68]. Kept out of `Drill`, so the assault, withdraw and rout code paths and their switches are untouched. `clearDrills` and new orders clear it explicitly (tested).
- **Scope creep.** ABM, reactive tiles, APS and recovery remain slots (APS and tiles exercised only by the fixture) unless the owner asks.
- **M7.5 follows directly.** Drawing and HUD changes stay self-contained. Vehicle nav depends neither on the shared building block nor on the 2 m foot cell.

Files consulted for this revision (read only, nothing modified):
- /home/user/TCS/packages/sim/src/components.ts
- /home/user/TCS/packages/sim/src/battle.ts
- /home/user/TCS/packages/sim/src/systems/fire.ts
- /home/user/TCS/packages/sim/src/systems/ballistics.ts
- /home/user/TCS/packages/sim/src/ballistics.ts
- /home/user/TCS/packages/sim/src/projectiles.ts
- /home/user/TCS/packages/sim/src/comms.ts
- /home/user/TCS/packages/sim/src/environment.ts
- /home/user/TCS/packages/data/factions/{de,ru}/doctrine.json
- /home/user/TCS/packages/data/factions/ru/units.json
- /home/user/TCS/packages/tools/test/architecture.test.ts
- /home/user/TCS/docs/SPEC.md
- /home/user/TCS/docs/ARCHITECTURE.md