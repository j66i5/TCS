# Architecture

This document describes the systems of TCS, their interfaces, and the guarantees the later extensions
(SPEC section 9) depend on. **Interfaces first**: the shapes below are the contracts; implementations
behind them may change. Source of truth for each interface is the file named next to it.

Status legend used throughout: ✅ implemented and guarded by a test · 🟡 interface exists, implementation
arrives in a later milestone · ⬜ not yet started (reserved).

## 1. Package graph

```
            ┌──────────────── app (browser) ───────────────┐
            │                                               │
           ui ──► render ──┐                                │
            │              │                                │
            └──► data ◄────┤◄── scenario ◄── campaign       │
                  │        │        │                       │
                  ▼        ▼        ▼                       │
                 sim ◄──── ai ◄─────┴──── tools (Node) ─────┘
```

| package | may import | role |
|---|---|---|
| `sim` | nothing | Pure deterministic simulation. No DOM, no Node, no wall clock, no `Math.random`. |
| `data` | sim | JSON data + zod schemas, validating loader, linter, string tables, catalog builder. |
| `ai` | sim | Controllers that read state and issue **orders** (M0: a trivial wander controller). |
| `scenario` | sim, data | Force builder (roster from unit templates), demo/test battles; generator in M6. |
| `campaign` | sim, data, scenario | Empty until M12. |
| `render` | sim, data | PixiJS renderer. Reads state + events, never writes state. |
| `ui` | sim, data, render | Touch/mouse input, HUD. Emits intents; the app turns them into orders. |
| `app` | all but tools/campaign | Browser wiring; owns real time. |
| `tools` | sim, data, scenario, ai, campaign | Headless runner, batch runner, golden replays, data linter, screenshots. |

Guards: `packages/tools/test/architecture.test.ts` (import scan, sim purity, maths routing, no faction
literals) and ESLint `no-restricted-imports` / `no-restricted-properties` / `no-restricted-globals` in
`eslint.config.js`. `sim` is also type-checked with `lib: ["ES2022"]` and `types: []`, so any DOM or Node
API is a compile error.

Packages export their TypeScript source directly (`"exports": "./src/index.ts"`); there is no per-package
build step. Vite (app), Vitest (tests) and tsx (CLI tools) compile on the fly.

## 2. The battle as a function (SPEC 4.3 rule 11) — `sim/src/battle.ts`, `sim/src/run.ts`

```ts
runBattle(input: BattleInput, opts?: RunOptions): BattleResult

interface BattleInput {
  map: MapDef;            // terrain (M0: flat)
  catalog: Catalog;       // static rulebook built from data
  forces: ForceInput[];   // per side: faction, unit tree of roster records, placements
  rules: BattleRules;     // time limit, comms model + params, physiology model + params, objectives (M6)
  seed: number;
  orders: Order[];        // the order stream
  environment?: Environment;
}
interface BattleResult {
  seed; catalogFingerprint; endTick; durationSeconds; endReason; finalStateHash;
  sides: SideResult[];                // start / fit / wounded / killed per side
  forcesOut: { side; faction; units: UnitInput[] }[];  // roster records with updated condition and load
  orders: Order[];                    // full stream incl. orders produced by controllers
  eventCounts;
}
interface Controller {
  side: SideId;
  think(view: SimView, tick: number): Order[];   // read-only view; orders for this tick only
  saveState?(): unknown; loadState?(data: unknown): void;  // controller memory for save games
}
saveGame(sim, controllers): SaveGame;  loadGame(input, save, controllers): Sim
```

The roster format (`SoldierRecord`, `UnitInput`) is separate from battle state: the campaign stores
records, a battle turns them into entities (`setup.ts: buildInitialState`) and back
(`soldierRecordFromState`, `unitsFromState`). `continueBattle(sim, input)` runs a loaded save to the end.

Controllers (AI commanders, scripted tests, later network peers) only return orders; `runBattle` records
every order it submits, so an AI-vs-AI battle is reproducible from `result.orders` alone. A save game is the
serialised state plus each controller's memory; saves record the data fingerprint and refuse to load
against different data. Outside code sees the state as `SimView` (deeply read-only type).

## 3. Simulation state (SPEC 4.3 rules 4, 6) — `sim/src/state.ts`, `components.ts`, `store.ts`

```ts
interface SimState {
  tick; rng: RngState; nextEntityId; nextOrderSeq; environment: Environment;
  sides: { id: SideId; faction: DefId }[];
  inbox: InboxOrder[];        // submitted orders whose tick has not come yet
  pendingOrders: PendingOrder[]; // received orders travelling through comms
  ended: { tick; reason } | null;
  // component stores: entity id -> plain-data component
  identity: Store<Identity>;   // personId, name, rank, role, faction, side, unit
  transform: Store<Transform>; // x, y, z (m), heading (rad)
  mover: Store<Mover>;         // waypoints, current speed
  soldier: Store<SoldierState>;// skills, posture, physical, mental, physiology, wounds
  unit: Store<Unit>;           // callsign, side, echelon, parent/children, members, leader, comms state
  container: Store<Container>; // counted items (any entity: soldier, vehicle, crate, depot, casualty)
  action: Store<Action>;       // current timed action
}
```

- Entities are numeric IDs, never reused. Components are plain data; systems are functions over stores.
- `Store<T>` always iterates in ascending entity ID. A plain `Map` iterates in insertion order, which differs
  between a live state (component removed and re-added) and the same state after load — a silent
  determinism bug. All stores go through the wrapper.
- `serializeState` → `SerializedState` (plain JSON; stores as sorted `[id, component]` arrays, with a schema
  version and the catalog fingerprint). It refuses NaN/Infinity (naming the field) and normalises -0 to 0. `deserializeState` rebuilds. `hashState` = 64-bit hash of the canonical (key-sorted) JSON.
- High-count objects (projectiles, fragments) will live in typed-array pools with no per-tick allocation
  (rule 6). 🟡 Arrives with ballistics in M2; the pool will serialise into `SerializedState` the same way.

Coordinates: metres; x grows east, y grows south, origin at the north-west corner; z is height above
ground. Heading in radians, 0 = east, π/2 = south. SI units everywhere inside the simulation (rule 7).

## 4. Time and the tick (SPEC 4.3 rule 1) — `sim/src/sim.ts`

Fixed timestep: 60 ticks per second (`TICK_HZ`, `DT = 1/60`). `step(sim)` advances one tick and returns
that tick's events. Order of work inside a tick (fixed and documented; new systems slot in at the comment):

1. every 60th tick: `comms.update` (recompute unit comm states)
2. `receiveOrders` — orders whose tick has come: validate → comms delay → pending
3. `deliverOrders` — pending orders whose delay elapsed: apply, acknowledge, radio
4. `actionSystem` — timed actions: interrupt or complete
5. `movementSystem`
6. *(M1+: fatigue, spotting, AI, ballistics, physiology …)*
7. clock (`environment.timeOfDaySeconds`), `tick++`, end conditions

Real time exists only in `packages/app` (an accumulator that runs as many fixed steps as elapsed wall time
allows, capped per frame) and in the tools' wall-clock measurements.

## 5. Randomness (rule 1) — `sim/src/rng.ts`

All randomness comes from `state.rng`: a battle seed plus **named sub-streams** (`"ballistics"`,
`"spotting"`, `"ai/soldier/17"`, …). Each stream is an sfc32 generator whose start state depends only on
`(seed, name)`, so an extra draw in one system never shifts another system's numbers. Streams are created
lazily and serialised with the state. API: `nextU32/nextFloat/nextRange/nextInt/chance/nextNormal/pick`.
Normal samples use a 12-uniform sum (no transcendental maths). Controllers outside the sim use their own
`createRng` instances and never touch `state.rng`.

## 6. Maths (rule 2) — `sim/src/math.ts`

The only file in `sim` allowed to call `Math.sin/cos/sqrt/pow/exp/…` or use `**`. Swappable for a
software implementation when lockstep multiplayer needs bit-identical results across browsers.

## 7. Orders (rule 3) — `sim/src/orders.ts`, `sim/src/systems/orders.ts`

```ts
type Order = { tick: number; issuer: SideId; target: EntityId } & OrderBody;
type OrderBody = { kind: "move"; waypoints: Waypoint[] } | { kind: "halt" };   // more in M5
interface Waypoint { x; y; mode: DefId /* movement mode */; posture?: Posture }
```

Life cycle: `submitOrder` puts it in `state.inbox` (deep-copied, numbered `seq`). Only orders for the
**current** tick may be submitted (future ticks throw; the caller holds them), so the inbox is empty between
ticks and a save never contains orders the stream will feed again. During the step it is
validated (`late`, `unknown-target`, `not-your-unit`, `invalid-params`, `battle-ended`) → the CommsModel
gives a delay → `pendingOrders` → delivered: applied, `order.delivered` event, and the unit leader's radio
acknowledgement (`radio.ack.<kind>`). Orders with the same tick are processed in submission order.

Human input, AI controllers, replays (`BattleInput.orders`) and, later, network peers and the campaign
auto-resolver all use this one path. Nothing else outside `sim` writes simulation state.

## 8. Events (rule 5) — `sim/src/events.ts`

```ts
type SimEvent =
  | order.received | order.rejected | order.delivered
  | radio { side, from, key, params }      // text via string table, never in the event
  | unit.arrived
  | items.transferred
  | action.started | action.completed | action.interrupted
  | battle.ended
  // M2+: shot.fired, impact, wound, near-miss, explosion, vehicle.hit, spotted, contact.shared, ...
```

Events are outputs, not state; they are not saved. A loaded save produces the same future events.
Consumers: renderer (order markers), HUD radio log, tools (counts, `--events` dump). After-action review
and the campaign will consume the same stream.

## 9. Items and containers (rule 9) — `sim/src/items.ts`

```ts
interface ItemStack { type: DefId; count: number; charge?: number }   // charge: rounds in a magazine, litres...
interface Container { stacks: ItemStack[]; maxMassKg?: number }
transferItems(catalog, containers, { from, to, type, count, charge? }): { moved; shortfall? }
```

Every consumable is counted, has mass (`ItemTypeDef.massKg` + `charge × chargeMassKg`), and sits in a
container component that any entity can carry. A partly used magazine is a separate stack (`charge`).
One generic transfer moves items, respecting destination mass limits. Time is modelled by the action that
calls it (`actions.ts`, kind `transferItems`).

## 10. Actions with duration — `sim/src/actions.ts`

```ts
interface Action { kind: string; startTick; durationTicks; params }
interface ActionHandler { check(...): string | null /* interrupt reason */; complete(...): void }
startAction(state, events, actor, kind, durationTicks, params); interruptAction(...); actionSystem(...)
```

Reloading, handing over ammunition, first aid, setting up a weapon all become actions. Handlers are
registered per kind (generic, not per faction). Interrupts emit `action.interrupted` with a reason.

## 11. Wounds and physiology (rule 10) — `sim/src/wounds.ts`, `impair.ts`, `systems/wounds.ts`

```ts
interface Wound { id; zone: BodyZone; mechanism; severity; bleedingLps; compressible;
                  airway; breathing; consciousness; tickInflicted; source?; treatments: TreatmentRecord[] }
interface Physiology { bloodVolumeL; shock; consciousness; pain; respiratory; alive }
interface PhysiologyModel { id; step(physiology, wounds, dtSeconds, params): void }   // rates from data
```

✅ (M2.3) Every soldier carries `wounds[]`, `physiology`, `impair { move, aim, canWalk, canFight }`,
`stunnedUntilTick` and `casualty` ("none" | "incapacitated" | "killed"). A casualty stays a soldier entity
(entities are never deleted). `resolveBodyHit` (systems/wounds.ts) is the single place where a projectile
meets a body: armour items in the man's container (`ItemTypeDef.armour`: zone, coverage front/side,
protection in mm of steel), then either a "stopped" hit (knock-down, blunt wound) or a wound record.
`woundSystem` steps the selected `PhysiologyModel` (`BattleRules.physiologyModel`: `"simple"` or `"none"`;
parameters from `core/wounds.json` merged with `physiologyParams`) every `stepSeconds` and calls
`refreshStatus`, which recomputes `impair` and handles the transition to casualty (drop tasks, leader
succession, `casualty` and `radio.manDown` events). `isAble()` (alive and conscious) is the one test other
systems use. The medical system (M10) replaces the model's contents and adds treatments, not this interface.

## 12. Communication state (SPEC 6.5, 9.5) — `sim/src/comms.ts`

```ts
interface CommState { link: "voice" | "radio" | "none"; extraDelaySeconds }   // on every Unit
interface CommsModel {
  id; update(state, params): void;
  orderDelayTicks(state, params, order): number | null;          // null = cannot reach now
  contactShareDelayTicks(state, params, from, to): number | null; // used from M3
}
```

All order delivery already goes through `ctx.comms`. M0 model `simple`: every unit on the radio net,
delay `rules.comms.orderDelaySeconds` (default 1 s) plus a random 0–`orderDelayJitterSeconds` (default 1 s)
drawn from the simulation's `comms` random stream. Command & EW (M14) supplies a richer model.

## 13. Catalog and data (rule 8) — `sim/src/catalog.ts`, `packages/data`

The sim receives a `Catalog` (item types, movement modes, qualities, factions with doctrine values) with a
content `fingerprint`. It never branches on a faction or item ID. `@tcs/data` loads JSON files (any
`…/factions/<id>/` folder is a pack), validates them with zod, checks cross-references, and returns readable
errors (`factions/de/units.json: units[0].members[1].role: unknown role 'riflemann' (known: …)`). The data
linter adds provenance rules (sources or low confidence + note). See `DATA_GUIDE.md`.

## 14. Strings (rule 12) — `data/src/strings.ts`

`new Strings(data, lang).t(key, params, faction?)`. Lookup: faction table (language) → core table
(language) → faction English → core English → visible `[[key]]`. Radio messages are keys in events; each
faction may phrase them its own way.

## 15. Environment (SPEC 6.1, 9.7) — `sim/src/environment.ts`

`timeOfDaySeconds, light, windX/Y, rain, visibilityM, temperatureC` in state. M0 only advances the clock.

## 16. Map and terrain (SPEC 6.1) — `sim/src/map.ts`, `sim/src/terrain.ts`, `scenario/src/mapgen/`

```ts
interface MapDef {
  id; name; widthM; heightM (≤ 4000); cellSizeM (2..5); cols; rows;
  heights: Float32Array;          // (cols+1) x (rows+1) corner samples, metres
  surfacePalette: DefId[]; surface: Uint8Array;        // per cell
  vegetationPalette: DefId[]; vegetation: Uint8Array;  // per cell, 0 = none
  obstacles: { id; kind; points; heightM; thicknessM; material }[];   // walls, hedges, fences, embankments
  buildings: { id; kind; footprint; storeys; storeyHeightM; wallMaterial; wallThicknessM; openings[]; roofColour;
               interior?: { rooms[]; walls[]; stairs[] } }[];   // M7.5c, format 2; openings[].floor? (upper windows)
  roads: { id; points; widthM; surface }[];  water: { id; kind: "pond"|"stream"; points; widthM; depthM }[];
  meta: { generator; kind; seed; version };
}
```

- Kinds (surfaces, vegetation, obstacle kinds, building kinds, materials) are data in `core/terrain/`; the
  catalog carries them as `catalog.terrain`. `validateMap(map, terrain)` checks every ID at battle start.
- Queries: `heightAt` (bilinear), `slopeAt`, `cellIndex`, `surfaceAt`, `vegetationAt`,
  `cellMoveCost(map, terrain, cell, class)` (surface × vegetation; null = impassable), `buildingAt`,
  `pointInPolygon`. `buildMapIndex` → bucket grid of wall segments, `segmentsInRect` (in `ctx.mapIndex`).
- File format `MapFile` (`mapToFile`/`mapFromFile`): JSON, grids as base64 little-endian binary (proposed SPEC
  change, see DECISIONS.md). `mapFingerprint` hashes it; the state records it and `loadSim` checks it.
- Terrain damage: `state.terrain = { breaches[], craters[], vegetationLoss[] }` (saved, hashed).
- **Interiors (M7.5c)** — `sim/src/interior.ts`, `scenario/src/mapgen/interiors.ts`: `Room {id, floor, poly (convex),
  kind room|hall|stair}`, `InnerWall {id, floor, ax..by, thicknessM, material, doors[{offsetM, widthM, headM}]}`,
  `Stair {id, floor, room, x0..y1, widthM}`; the same partition on every floor; `Opening.floor?` for upper windows.
  `MAP_FORMAT_VERSION` 2; a map with no interior is written as format 1 byte for byte (`hasInteriors`), and
  `stripInteriors(map)` gives the map without them. Generated after every building on stream `mapgen/interiors`
  (`generateMap(..., { interiors })`, default true; MAPGEN_VERSION 2, 1 without). `validateMap` adds
  `interiorProblems` (floors with rooms, rooms convex inside the footprint, doorways on their walls, every room
  reachable from an exterior door via doorways and stairs); `checkMap`/`mapStats` report them.
- **Map index with interiors:** inner walls are appended to `MapIndex.segments` after every outer wall and obstacle
  (owner "building", part = outer wall count + wall index), from `nOuter` on, NOT in `buckets` (so every query
  that knew only outer walls sees exactly what it saw) but in `interiorBuckets` (`interiorSegmentsInRectInto`);
  `interiorOf` gives each building's range. `SegInfo.baseM` = an inner wall's floor height; openings of upper floors
  and inner doorways are stored with heights above the ground. `RoofRT.slabs` = floor heights between storeys
  (roof material and thickness, plan §7.9), `RoofRT.innerFrom/innerTo` its inner walls; bucket bit `NEAR_INTERIOR`.
- Generator: `generateMap(terrain, { kind: "village" | "woodland" | "farmland" | "industrial", seed, widthM,
  heightM, cellSizeM })`, deterministic; `checkMap` (geometry validity) and `mapStats` for tests and tuning.
  `TerrainImporter` is the reserved interface for real-terrain import.

---

## 16a. Navigation (SPEC 6.2) — `sim/src/nav.ts`, `navctx.ts`, `spatial.ts`

```ts
buildNavGrid(map, terrain, cls, cellM = 2): NavGrid   // cost per cell (0 = blocked), wall flags
navFor(ctx, cls): { grid, search }                    // lazily built per movement class; derived, not saved
findPath(search, sx, sy, gx, gy, { maxExpansions?, snapCells? }): { points, cost, expanded, goalX, goalY } | null
clearLine(nav, ax, ay, bx, by, maxCost): boolean; navCostAt(nav, x, y); nearestPassable(nav, x, y, r)
buildSpatialHash(state, cellM = 16); queryRadius(hash, state, x, y, r): EntityId[]   // ascending IDs
```

Routes are assigned when a move order is delivered (`systems/orders.ts`) and stored as mover waypoints
(state). Movement speed = mode speed / ground cost under the soldier. Weighted A* (x1.1), see DECISIONS.md.

**Interiors (M7.5c) — `sim/src/interior-nav.ts`.** Buildings stay blocked cells of the outdoor grid (outdoor routes
byte-identical). Per building a small graph (derived, `ctx.interiorNav`, rebuilt when a breach is added): two nodes
0.4 m either side of each inner doorway, one node inside each exterior door or hole in an outer wall (with the point
0.6 m outside), all nodes of one convex room joined; Dijkstra with index tie-breaks. `indoorAt(ctx, x, y)` (via the
roof buckets) says which building with an interior a point is in. `routeBetween(ctx, search, sx, sy, gx, gy, opts)`
has `findPath`'s result shape: outdoor to outdoor (or any vehicle class) = `findPath` exactly; otherwise the
cheapest combination of exit and entry (inside legs on the graph, the outside leg on the grid); an indoor goal is
never snapped. Every men's `findPath` call (orders, decisions, drills, surrender, grenades, boarding) goes through
it; an architecture test requires it (or an `// outdoor: ok` marker: vehicles in `drive.ts`). A move whose end is
indoors gives each man his own place (`indoorSpots`: windows first, 0.9 m grid, about one man per 2.5 m2, the
nearest rooms next) and route, no formation, crouching facing out; a unit leaving a building comes out on
personal routes to its formation slots. Indoors a man does not run outside to seek cover (`seekCover`).

**Upper floors (M7.5d).** `Transform.z` is a man's height above the ground (0 outdoors; k × storeyHeightM on floor k;
a seat's height aboard). `standZ(map, t[, x, y])` (`terrain.ts`) = `heightAt + t.z` is where every soldier height
starts (spotting eye and target point, muzzles in `fire.ts`, launcher, grenade origin and blast victims, surrender,
`coveredFrom`); an enemy man's floor goes into aim heights (`aimHeightAt`, launcher `aimHeight`). An architecture
test requires every `heightAt(` in `sim/src/systems` and `ai/src` to go through `standZ` or carry a
`// ground: ok` marker. `floorAtZ(b, z)` / `floorOf(ctx, x, y, z)` derive the floor. The interior graph appends,
after the M7.5c ground-floor nodes (so ground-floor routes are unchanged), the upper floors' doorways and breaches
and one node at the foot and one at the head of each flight of stairs, joined like a doorway (cost × 2.5).
`routeBetween(..., opts, { sz, gz })` takes the start's and goal's heights and, when either is above the ground
floor, returns `zs` (each point's height); `routeWaypoints(route, base)` turns a route into waypoints with
`Waypoint.z`. Movement climbs or descends evenly along a leg whose waypoint has a `z` (stairs: × 0.5 up, × 0.6
down); a leg without one keeps the height indoors and returns to the ground outdoors. Orders: `move.floor` (the
floor of the destination; `indoorSpots(ctx, bi, x, y, n, floor)` spreads men about one per 4.5 m² over rooms, then
floors) and `occupy {building, floor?, facing?}` (`systems/occupy.ts`: `windowPlaces` 0.5 m inside each window of
every floor, facing out, kneeling if the rifle clears the sill by 0.25 m, else standing; `occupyPlaces` picks those
facing `facing` first). No state schema bump: `Waypoint.z` and the new order are optional additions.
Render: men at true size from the close zoom; `BuildingLayers.upper` holds one plan per building and floor (built
when first shown); `Overlay.floor`; men indoors on another floor drawn at 35 % with a pixel badge. UI:
`ui/src/floors.ts` (`unitFloor`, `followFloor`, `createFloorSwitch`), Occupy order mode.

## 16b. Body model (SPEC 6.2, 6.4) — `sim/src/systems/body.ts`, `core/body.json`

`SoldierState.posture`, `postureTo`, `postureDoneTick`; `physical.fatigue` (0..1), `physical.heartRateBpm`.
`requestPosture`, `postureChangeSeconds(ctx, from, to, loadKg)`, `postureSystem`, `physiologySystem` (every
tick: exertion from mover mode, load, uphill grade; heat from `environment.temperatureC`), `loadKg` (from counted
items). Movement speed factors in `systems/movement.ts`. Order `{ kind: "posture", posture }`. Event
`posture.changed`. Lab: `tools/src/labs/movement.ts`.

## 16c. Projectiles and ballistics (SPEC 6.3) — `sim/src/projectiles.ts`, `ballistics.ts`, `systems/ballistics.ts`

```ts
interface ProjectilePool { count; x, y, z, vx, vy, vz: Float64Array; ammo: Uint16Array; owner, bornTick: Int32Array }
// state.projectiles; z is ABSOLUTE height; rows [0, count) are live; removal swaps in the last row
launchProjectile(ctx, state, ammoId, x, y, z, vx, vy, vz, owner)      // internal: weapon systems (M2.2)
projectileSystem(ctx, state, events)                                  // every tick, after physiology
event: { kind: "impact", x, y, z, surface: "ground"|"obstacle"|"building"|"vegetation",
         result: "stopped"|"penetrated"|"ricochet", material, ammo, owner }
```

Data: `core/ballistics.json` (gravity, air density, penetration exponent, ricochet/deflection parameters);
per faction `ammunition.json` (mass, diameter, drag {a, b, max}, penetration {steelMm, atVelocityMps}, tracer,
kind/fuse/guidance enums from SPEC 6.3, explosive block for M2.4) and `weapons.json` (type, calibre, feed
magazine, fire modes, cyclic rate, dispersion, reload/set-up times, jam chance, sights, muzzle velocity per
ammunition). Every ammunition entry is also a counted item (rule 9). `catalog.ammoIds` gives the index stored
per projectile. Derived per battle (`ctx.ballistics`, never saved): 8 m grids of highest ground, highest
vegetation and "wall nearby"; per wall segment height/thickness/material/openings; per material resistance and
ricochet threshold; per ammunition drag and penetration numbers. Lab: `tools/src/labs/cover.ts`.

## 16d. Weapons and fire (SPEC 6.3) — `sim/src/systems/fire.ts`, `actions.ts`, `core/shooting.json`

```ts
state.weapon: Store<WeaponState>   // { weapon, magazine: { item, rounds } | null, nextShotTick, burstLeft, burstIndex, jammed, lastShotTick, lowAmmoReported }
state.fire:   Store<FireTask>      // { x, y, heightM, reasonTick, rangeError }
orders:  { kind: "fire", x, y, heightM? } | { kind: "ceaseFire" }
events:  shot.fired | weapon.reloaded | weapon.jammed | fire.ceased { reason: "ordered"|"no-target"|"ammunition"|"moved" }
actions: "reload", "clearStoppage" (timed, interruptible)
fireSystem(ctx, state, events)  -> launchProjectile(...)        // before projectileSystem
incomingFireSystem(ctx, state, events)                          // after it: enemy impacts near a unit renew its reason to fire
aimErrorMrad(ctx, state, id, weapon, aimed); dropAt(ctx, ammoId, v0, rangeM) // drop tables cached in ctx
```

`SoldierRecord.weapon` carries the weapon in and out of battles; the loaded magazine returns to the load in the
battle result. Tick order: … movement, physiology, **fire**, projectiles, **incoming fire**. Lab:
`tools/src/labs/range.ts`.

## 16e. Bodies as targets (SPEC 6.4) — `sim/src/systems/ballistics.ts`, `core/wounds.json`

Each tick the projectile system fills a soldier grid (typed arrays in `ctx.ballistics.soldiers`, bucketed on
the 8 m ballistic grid with a "soldier near" flag per bucket; derived, never saved). A projectile whose path
touches a flagged bucket is tested against each nearby man's body bands in his own frame (forward, left, up):
`hitboxes[posture].bands` from data, upright bands by height, prone bands along the body. The nearest of
body / wall / ground wins. The owner of a projectile is skipped; side is never looked at (friendly fire is
physical). On a body hit the projectile is removed and `resolveBodyHit` is called with the round's
penetration capacity and kinetic energy. A projectile leaving the map flies to the edge first, so targets near
the edge can be struck.

## 16f. Explosives (SPEC 6.3) — `sim/src/systems/grenades.ts`, `systems/explosions.ts`, `systems/ballistics.ts`

- **Data:** `AmmoDef.explosive { fillingKg, fragmentCount, fragmentAmmo, fragmentVelocityMps, fuseSeconds?,
  armingSeconds? }` and `AmmoDef.delivery { method: "thrown" | "launched", velocityMps?, launcher?, maxRangeM? }`.
  Blast and fragment-band coefficients in `core/ballistics.json`; throw ranges and errors in
  `core/shooting.json` (`grenades`); fragment and blast wounding in `core/wounds.json`.
- **Order → action → projectile:** order `grenade {x, y}` picks one man (`grenadeOption`) and starts the
  interruptible action `"grenade"`; on completion one item is removed from his container and
  `launchProjectile` puts the munition into the pool on an arc solved by `arcRangeM` (same drag as the engine).
- **In the pool** an explosive projectile is flagged in `AmmoRT` (`explosive`, `fuseTicks`, `armTicks`): never
  "spent", no body test, rests with zero velocity after landing (time fuse), or bursts / duds on impact.
  Bursts found during the projectile pass are queued and run after it (`detonate`), because a burst adds
  fragments and the pool must not grow inside the pass.
- **`detonate`**: `explosion` event; blast per soldier in range (`applyBlast`, shielded by `lineBlocked`);
  fragments written straight into the pool from the named RNG stream `fragments`; crater and breaches pushed to
  `state.terrain` (`terrain.breached` event). Fragments (`AmmoRT.fragment`) are removed below the speed at
  which they can still wound, may strike their owner, wound by the fragment rule and emit no impact events.
- **Terrain damage is state; its effects are derived:** `syncTerrainDamage(ctx, state)` (after a breach, at
  creation and after loading) adds breaches to the wall table as openings, points `ctx.breaches` at the
  state's list and drops the cached navigation grids, which are rebuilt with the holes (`buildNavGrid(...,
  breaches)`).
- **Bounce:** `settle()` in the projectile system reflects a time-fuse grenade off the surface it struck
  (`ballistics.bounce` in data, softer per material and in vegetation) until it is slow enough to rest; each
  contact emits `grenade.landed { x, y, z, burstTick }`.
- **Arc choice:** `release()` tries the data's throw angles with `arcLanding` (walls via `lineBlocked`, roofs
  via `roofAt`; an arc is good only if it comes down near the point with nothing between), the launcher its
  flat then high arc; with no good arc nothing is released (`radio.grenadeBlocked`).
- **Reaction:** `grenadeReactionSystem` (after the projectile pass) turns `grenade.landed` into
  `SoldierState.evade { x, y, startTick, untilTick, run }` (plain state, saved); `evadeSystem` (before
  movement) runs the man away or drops him flat; movement and fire skip a man while he evades. The order
  `grenade` has `count`; actions are staggered by their duration. Actions owned by a system are registered
  with `registerActionHandler` (avoids an import cycle with `actions.ts`).
- **Ground clutter:** fragments below `fragments.clutterHeightM` are thinned per metre in the projectile pass.
- **Roofs:** `BallisticsCtx.roofs` (one per building: footprint, height, material, thickness from the
  building kind) with a per-bucket lowest-roof height for quick rejection; a projectile crossing a roof plane
  inside the footprint is stopped or pierced like a wall.

## 16g. Line of sight (SPEC 6.5) — `sim/src/los.ts`

`sight(ctx, x0, y0, z0, x1, y1, z1) -> { visibility, blockedBy, blockedAt, vegetationM }`: a pure query over
the map and the derived ballistics tables (wall segments with `seeThrough` and openings incl. breaches, roofs,
8 m buckets of highest ground and vegetation for quick rejection, vegetation concealment per palette entry).
No state, no randomness, so any system (fire, detection, AI, debug views) may call it. M7.5c: inside the roof loop,
for each building the line crosses, its floor slabs are tested like the roof plane and its inner walls (doorways
open) like walls — buildings the line does not cross cost nothing extra (village micro-benchmark: +0 %, test
`perf-sight.test.ts`). The projectile loop tests inner walls only in buckets with `NEAR_INTERIOR`, slabs with the
roofs; `lineBlocked` (blast, grenade arcs, backblast) tests inner walls and slabs; breaches also open inner walls. The fire system uses it
for the line of fire (`lineOfFireClear`, cached once a second on the `FireTask`).

## 16h. Detection (SPEC 6.5) — `sim/src/systems/spotting.ts`, `core/spotting.json`

Runs after wounds each tick; each able soldier scans every `scanSeconds`, staggered by ID. Per enemy in range:
one draw from the `spotting` stream, a rate from data (range, posture, movement/firing, look direction,
sensors from data — eye, weapon sight, carried items with a `sensor` —, skill, stress, light, fog), the line of
sight (M3.1) only if the draw could succeed and the man could take the target on. Output:
`SoldierState.seen` (target, first and last tick; at most `maxTracked`, nearest kept) and `spotted` events.
M3.3 builds contacts on top of it.

## 16i. Contacts and sharing (SPEC 6.5, 9.5) — `sim/src/systems/contacts.ts`

Runs after spotting. `SoldierState.contacts` (sorted by target: position, uncertainty, kind, tick,
reportedTick) from his `seen` list, from enemy `shot.fired` events within hearing range, and from
`state.contactReports` (pending reports with a delivery tick). All sharing goes through
`CommsModel.contactShareDelayTicks(from, to)` (null = no path), so the command and EW extension replaces one
function. Fire tasks may carry `contact` and follow it.

## 16j. Fog of war (SPEC 6.5, M3.4) — `sim/src/knowledge.ts`, renderer `Overlay.known`

`sideKnowledge(ctx, state, side)`: per enemy, the most certain contact any living man of the side holds now
(pure query). The app passes it to the renderer as `Overlay.known`; with it (and Debug off) the renderer draws
the enemy only from it. An AI commander (M6) is meant to plan on the same picture.

## 16k. Suppression and morale (SPEC 6.4, M4.1) — `sim/src/systems/morale.ts`, `core/behaviour.json`
The projectile system gathers suppression in the soldier grid: for each enemy round near a man (grid side
index per man, owner's side from `sideOf`), the point of its flight closest to him counts once (the tick whose
path holds it, or the impact if it ends first), scaled by the square root of its energy and by distance; it is
added to `mental.suppression` after the projectile pass. Bursts add suppression around them
(`suppressByBurst`, from `detonate`). `moraleSystem` runs after the wound system: it applies stress for this
tick's wound and casualty events, then every 0.5 s (staggered by ID) fades suppression and stress, grows stress
from suppression, and sets `mental.behaviour` with hysteresis, emitting `behaviour.changed`. Leader loss calls
`leaderLost` from the casualty path. Effects: movement holds a cowering man (route kept), the fire system scales
the interval by `fireRateFactor` (0 = no fire) and keeps a pinned man prone; aim and spotting already used
suppression. No new state fields: `mental` existed since M0.

## 16l. Soldier decisions (SPEC 8, M4.2) — `sim/src/systems/decisions.ts`
Runs after contacts. First it stamps `underFireTick` on the top unit of every man with suppression; then each
man every `decisions.stepSeconds` (staggered by ID): a giver on a `bringAmmo` intent walks over and starts the
generic `transferItems` action; a self-started fire task (`FireTask.self`) is kept at the full rate while its
contact is seen and dropped when lost; under fire he may seek cover (sight from the threat to candidate spots on
5 rings x 12 directions, then a short path search); halted and allowed by `Unit.fireRule` (+ `ceaseFireTick`)
he starts a self fire task at the best seen contact; out of spare he calls a giver. Ordered fire tasks are never
replaced. New state: `Unit.fireRule/underFireTick/ceaseFireTick`, `SoldierState.intent/coverTick`,
`FireTask.self` (schema 12). New order: `rules`.

## 16l2. Individual soldier AI (owner packages A–D, 2026-11-13)
Values: `core/behaviour.json` `soldier` (`BehaviourDef.soldier`), `core/shooting.json` `fire.aimHeightByPostureM`.
**A:** `Contact.posture` (seen posture; a sound keeps it) and `Contact.down` (seen lying hit, or seen within 2 s of
the fall by a staggered pass in `contactSystem`; passed on at once like `surrendered`; never cleared) are optional
plain fields (schema stays 17). `aimHeightAt(ctx, {z?, posture?})` aims by posture (foot and vehicle MG);
`FireTask.aimAuto` (optional) makes a contact task's `heightM` follow it in the line check. `reserveTargetOk`
(fire.ts) is the close-defence rule for a rifleman with no spare magazine (fire.ts stops him otherwise; decisions
pick only such targets). Long-range discipline multiplies the shot interval of self fire. `targetScore` +
`keepTargetFactor`/`keepTargetSeenSeconds` give target hysteresis in `decisionSystem`. Contacts marked `down` are
skipped by target choice, threats, drills, gunnery, launchers, surrender, armour reactions and the AI commander.
**B:** a cowering man (`isCowering`) in the decision loop may `crawlToCover` (waypoints in the `soldier.crawlMode`
movement mode, which movement lets a cowering man use), else, lying in the open (static exposure >=
`beatenOpenExposure`, not indoors), `crawlOutOfOpen`: hidden from `SoldierState.fireFrom` (optional; set by the
ballistics system's suppression pass, the suppression-weighted direction back along the rounds that passed him, kept
`decisions.underFireMemorySeconds`), else his `threatOf`, else his unit's (`unitThreat`), within `crawlSearchM`, else
`crawlSearchFarM` (or any nav cell below `beatenOpenExposure`); both at most every `crawlRetrySeconds`. `placesTaken`/`placeFree`
(decisions.ts) list the places men of a side hold or are going to; `seekCover`, `crawlToCover`, the halt drill
(`bestCoverNear(..., taken, sepM)`, nav.ts) and the drills' final rush and rally (`freeSpotNear`) keep
`soldier.minSpacingM`. `SoldierState.beaten` (optional) is set by `noteBeatenZone` (morale.ts) from the fire
support system for each enemy mortar burst; `leaveBeatenZone` runs for halted men in the open (`exposureAt` of the
static nav grid >= `beatenOpenExposure`) whose unit is not moving nor in an assault/withdraw drill.
**C:** `SoldierState.homePosture` (optional) is set on arrival (`Mover.endPosture`), by a posture order and by the
react-to-contact halt; `postureAndWatch` (decisions.ts) returns a man to it, lifts a blind prone man to a kneel
(one `coveredFrom` pair every `lookEverySeconds`), drops him when fired on, and sets the facing / rear watch;
`assignFireTask` takes `homePosture` as the lowest posture of a new fire task. `enteringHouse` (drills.ts) keeps
react-to-contact off a unit whose men are going indoors. `repositionForVehicle` (launcher.ts) runs when no seen
vehicle is in reach or the line from here is blocked; new `Intent.kind` "reposition" rate-limits it.
**D:** `ownGrenade` (decisions.ts; `SoldierState.grenadeTick` optional) starts the generic grenade action;
`throwPosture`/`throwPlan`/`findArc`/`throwArcExists` (grenades.ts) split the old `release`: the throw is from
the lowest posture whose range reaches, the arc search is pure and is used beforehand by own throws and grenade
orders (a man with no arc is not picked; nobody: `radio.grenadeBlocked`). A grenade order stops the men it picks;
`startPhase` does not move a man whose grenade action runs. `FireTask.onTheMove` (optional): assault movers within
`soldier.assaultFireM` of the objective, and the last rush, get contact fire tasks the fire system carries out while
they move (from the posture they move in), with `aimErrorMrad` x `assaultFireAimFactor`.

## 16l3. AI uses buildings (M7.5e, plan `docs/plans/m7.5e-ai-buildings.md`)
**Defence (AI, `ai/src/siting.ts`):** `siteDefence` takes the window places (`windowPlaces`) of houses within 40 m
of a group as candidates beside outdoor spots, each seen from its own height (`standZ` + the sill posture's eye) with
a wall cover term; caps (`SITING`): 60 % of a group inside, 2+ outside, 2 per room, 4 per house, outside men 8 m
clear of an occupied house, an upper window only if it sees 1.2x the best ground window, one man watching the back.
A window place is ordered as `occupy {building, windowIndex, mode}` (optional order fields).
**Leaving (sim, `systems/house.ts`, every side; `soldier.houseLeave`):** in each man's decision step (not in a
drill): a trap (`SoldierState.houseDanger {building, n, tick}`, marked by `detonate` for enemy bursts in or on the
house), an enemy seen inside, or the house cut off; the unit runs out to covered spots away from the threats and
`Unit.leftHouse {building, tick, reason}` keeps its rules out for 120 s; radio `radio.houseLeft*`.
**Clearing (sim, `systems/clear.ts`):** `assault {x, y, building}` starts drill kind `"clear"` (optional `Drill`
fields: `building, stage, stageTick, startTick, entry, rooms, room, thrower, throwAt, ...`): bounds onto the entry
door, stack beside it, a posted grenade (`grenades.postErrorM`, `throwArcExists` with `from`), the burst, three men in,
room by room (`roomOrder`: breadth first, ground floor first); values `drills.clear*`; radio `radio.clearing`,
`radio.houseCleared`.
**Commander (`ai/src/commander.ts`, `COMMANDER.clear`):** an assaulting squad first gets `assault {building}` for the
next house on its way in or by the objective with a known enemy (any in the main ring while it is defended);
`Memory.clearing/taken/held/houseSeen` are plain data; a squad that took a house in the main ring holds it with the
defence's siting. A squad that left a house is re-sited outdoors. On the approach (slice s0-clear, owner 2026-11-14):
a squad advancing to the support line or closing in first clears a house with a known enemy that overlooks its way
(`approachHouse`/`clearOnApproach`, `COMMANDER.clear.approach*`; advancing, not a house of the objective it is going
for; closing in, its line runs on to the objective; one at a time); a base of fire squad in a clear drill gets no fire orders.
**Player (slice s0-clear):** order mode `"clear"` in the Move tray (`ui/hud.ts`, `orders-for.ts`: squads only); the
app's `clearAt` (tap a house, or drag the unit onto it) sends `assault {x, y, building}` if `clearable`, else a radio
hint (`plan.cannotClear`).
Tools: batch "buildings" block, `npm run lab -- house defend|leave|clear`, scenario `house-clear` (golden
`house-clear-s1`), `npm run screenshot -- --scene buildings` (app hooks `clearAt`, `reveal`).

## 16m. Squad drills (SPEC 8, M4.3) — `sim/src/systems/drills.ts`
Runs after decisions, every `drills.stepSeconds`. `Unit.drill` holds a bounding drill (assault / withdraw:
two groups of soldier IDs, the group moving now, its start tick, the final rush) or a rout (rally point);
`Unit.broken` marks a broken unit. Orders `assault` / `withdraw` set the drill; every other order (except
`rules`) clears drills of the target unit and its sub-units (a rout is not cleared: routed men are filtered out
of every order). Phases: the movers get paths of one bound (each from his own position), the others halt and
get an ordered fire task at the objective (assault) or the known enemy (withdraw); the phase ends when no mover
has waypoints or after the timeout. Reaction to contact compares the top unit's `contactTick` (stamped by
decisions when fire starts after a quiet spell) with `Unit.moveTick`. Breaking: a top unit where half the able
men are `panicked` sets them `routed` (morale leaves routed men alone; fire factor 0; decisions skip them) and
sends them to a rally point away from the mean of their contacts; rally resets them to `cautious`.
Covering fire (overnight pick "covering-fire", 2026-11-14): `startPhase` gives the covering men their tasks first
(`coverFire`: a contact within `coverTargetM` with a clear, friend-free line from some posture via
`fire.lineOfFireTo`, else one into cover, else the objective, else the old `fireOnPosition`), then either sets
`Drill.waitFire` (assault, nobody covering has fired within `coverFiredS`) or calls `runBound`, which moves each
runner's bound end out of the covering men's cones. `stepDrill` re-tasks covering men with no shot every
`coverRetaskS` (and `sidestep`s them once a bound, `Drill.stepped`) and releases a waiting bound when a covering
man fires or after `coverWaitS` (the bound's clock starts then). Drill and ordered tasks carry `FireTask.suppress`
("drill" / "order"): the fire system accepts a line blocked within `suppressShortM` of the point (in the far half),
marks it `intoCover`, and spaces such shots (and a drill's point fire with no contact) at least `suppressIntervalS`.

## 16n. Orders and interface (SPEC 6.6, M5) — `ui/src/planner.ts`, `ui/src/hud.ts`, `ui/src/input.ts`, `app/src/main.ts`
The order planner is pure logic in the ui package (no DOM, unit-tested): a `Plan` (kind, route points with a
pace each, formation, facing, frontage) → `markerGeometry` (where each man will stand, laid out exactly as
`systems/orders.ts` lays them out: slots turned to the facing, spaced to the frontage), `hitHandle` /
`dragTo` (body, turn, width, earlier points), `planToOrder` (one `move` with `facing`/`frontageM`, or an
`assault`/`withdraw`). Input asks the app on every one-finger press whether it starts a drag (a handle under
the finger) before panning. The renderer draws `Overlay.plan`. The HUD's order bar, plan bar and rules panel
call back into the app, which turns everything into orders (`rules` carries only the changed rules). Unit
fields `maxEngageM`, `onContact`, `ammoRule` (schema 12, the M4 bump not yet released) feed decisions,
drills and the fire system.

**M7.5a UI shell** — `ui/src/orders-for.ts` (`unitCapabilities` → `ordersFor`, `boardingOf`), `ui/src/dock.ts`,
`ui/src/sidebar.ts`, `render/src/labels.ts`, `data/src/appearance.ts`. Capabilities are a pure read of the
`SimView` (launcher rounds, grenades, fire support left, boarding, dischargers, gun natures); the app rebuilds the
bar only when they change. The HUD owns layout: the order bar is a fixed strip `.hud-dock.dock-<edge>` (pure
`nearestEdge`, localStorage `tcs.ui.dock` behind try/catch), the sidebar sits on the other side, and
`hud.insets()` gives the free map area to the app (opening view) and to the renderer (`setHudInsets`, no labels
under the HUD). The renderer collects label requests during `draw` and places them at the end of the frame with
`placeLabels` (8 px occupancy grid, stamp-cleared, no allocation per frame beyond the placed list), drawing them
from its Text pool. The overview draws vehicle stacks and infantry symbols (men on foot only). Appearance
(`buildAppearance(data, factionIds)`) is built beside the catalog and never enters it (fingerprint test);
`renderer.setAppearance` takes it.

**M7.5b Look** — `render/src/lod.ts` (levels and hysteresis; men always at true size), `render/src/sprites/soldier-art.ts`
(frames as string grids, letters = palette slots), `render/src/sprites/atlas.ts` (pure `composeFrame` /
`rotateFrame` (Scale2x ×2 + nearest) / `outlineMask` / `paletteFor` / `frameKey`; `SoldierAtlas` builds cells
lazily into one `BufferImageSource` and re-uploads once per frame), `render/src/terrain-flat.ts` (pure
`paintRegion(map, colours, x, y, w, h, ppm)` → RGBA, no canvas: the base picture and the detail tiles; `FlatTerrain`
holds base, tiles (LRU) and the contour sprite), `render/src/buildings.ts` (`BuildingLayers`: floors Graphics in the
world layer, one roof Graphics per building in `roofLayer`; pure `roofShown(index, men, n, close)` over a 32 m
bucket grid). Stage order: world layer (map, tiles, contours, floors, debug overlays) → `menLayer` (screen-space
sprite pool, two per man: outline then figure) → `roofLayer` (follows the camera) → border → units Graphics (hulls,
rings, routes, markers) → labels. The renderer picks the frame from the `SimView` (casualty, captive, posture,
moved since `capturePrevious`), the firing frame from `shot.fired` events, the weapon look from `WeaponDef.type`.
`setLook("classic")` keeps the old terrain and discs. `clampCamera` keeps the map in the free area (the app's input
uses it). Tests `render/test/look.test.ts`, `perf-render.test.ts` (close zoom, roofs).

## 16o. Objectives, scenarios and the commander (M6)
`sim/src/systems/objectives.ts`: `BattleRules.objectives` (`ObjectiveDef`: area, points, first holder) and
`victory` (`casualtyPoints`, `endOnDefeat`); `state.objectives` holds holder / contested (in the order of the
rules), `state.endLoser` the side that lost early. Once a second: an objective changes hands when only one
side has standing (able, not routed) men inside (`objective.changed`); a side with nobody standing or with all
top units broken ends the battle (`battle.ended` with `loser`). `battleScore` (also in `BattleResult.scores`,
`winner`). `scenario/src/battle.ts`: `ScenarioDef` (plain data) → `buildScenario` (deterministic): map,
objectives at buildings on the defender's half, the platoons (manifest `platoonTemplate`) placed by squad.
`ai/src/commander.ts`: `commanderController(side, input)` — a Controller with plain-data memory (phase,
target, timers; saved with the game), reading only its own men's contacts and the public objective holders;
transcendental maths via sim/math. The app builds the after-action review from the events it receives
(`ui/src/aar.ts` lays it out) and draws objectives and the heat map through `Overlay.objectives` / `.heat`.

## 16p. Fire support (M6.5c) — `sim/src/systems/support.ts`
`rules.support` gives each side's rounds (HE, smoke); faction doctrine `fireSupport` the ammunition, delay,
spread, cadence and smoke size. A `callFire` order (does not end a drill) goes through the unit's leader or
whoever can still use the radio; `state.fireMissions` hold the rounds still to come, `state.smoke` the clouds
(schema 14). `supportSystem` runs before the projectile pass: rounds scatter on the `support` RNG stream; HE
calls `detonate` (owner = the caller, so own-side suppression rules hold); smoke adds a cloud
(`support.smoke`). Spotting multiplies visibility by `smokeTransmission` (exp(-k x metres of smoke along the
line; k in `core/spotting.json`). Smoke does not stop bullets.

## 16q. Surrender (M6.6) — `sim/src/systems/surrender.ts`
Runs after contacts and before decisions. `SoldierState.captive` (null → surrendered → captured) is the one
record; `impair.ts` predicates: `isConscious`, `isCaptive`, `isAble` (= conscious and not a prisoner: every
"may act" check), `isFit` (able, can walk and fight, not panicked/routed), `isOut` (casualty or prisoner: score,
commander, panels), `rosterStatus`. Knowledge: `Contact.surrendered` is set only by the observer's own sight in
`contactSystem`, carried by reports (passed on at once), never cleared; every target choice reads only that flag.
`fireSystem` stops a task whose contact is flagged. Capture by a fit enemy within `captureM` with a clear line;
the walk-over errand is an `Intent` of kind `takePrisoner` run by this system (orders clear it; `Unit.orderTick`
blocks new errands right after an order). Events `surrendered`, `captured`; schema 15.

## 16h. Vehicles (M7.1b) — `components.ts` (`VehicleState`), `mount.ts`, `systems/drive.ts`

A vehicle is an entity with a Transform, a Container (fuel tank item, stowed load) and an entry in the
`vehicle` store; it has no Identity, Mover, SoldierState or WeaponState, so soldier loops ignore it. It is a
roster asset at force level (`ForceInput.vehicles`, `forcesOut[].vehicles`), commanded through its crew unit
(`Unit.vehicle`, echelon "vehicle"); crewmen stay soldiers with `SoldierState.mount = {vehicle, seat}` and ride
in their seats (`vehicleSyncSystem`). `move`/`halt` orders to the crew unit set the drive route;
`vehicleDriveSystem` (after evading, before foot movement) runs the pure dynamics core `stepDriveDynamics` (per-
track speeds, gears, rain) and burns fuel from the tank item. Plan and later slices: `docs/plans/m7-vehicles.md`.
Schema 16.

## 16i. Passengers, getting in and out (M7.2) — `systems/boarding.ts`, `systems/orders.ts`

Orders `mount {vehicle?}` / `dismount` set `Unit.boarding` (a state record, not a drill). `boardingSystem` (after
the drills, every tick; nothing without vehicles) walks the men to the nearest exit, starts the timed actions
`mount` / `dismount` / `loadCasualty` (two men) one man per exit, holds the hull (`DriveState.holdForDismount`,
route kept) while men pass, and lets a fallen driver or gunner be replaced (`seatSwap` action). Only these
handlers and the battle setup write `VehicleState.seats` and `SoldierState.mount`. An order to a squad aboard is
kept as `Boarding.then` and applied without a second comms delay once it is out (`applyOrderNow`). The scenario
builder pairs squads and carriers from the templates' `carriage` (`UnitInput.carrierId` → `Unit.carrier`); the AI
reads `Unit.carrier`, `Unit.boarding`, `drive.arrived` and `lastHitTick` from its read-only view.

## 16j. Turrets, guns and vehicle senses (M7.3) — `systems/gunnery.ts`, `systems/spotting.ts`, `systems/contacts.ts`

Station weapons live only in `VehicleState.stations[i].weapons` (ready rounds per feed, counted; rule 9). Tick
order: `turretSystem` (after physiology: lays each station on its `task` with lead from the drop table's time of
flight and elevation with drop; traverse/elevation rates, limits, arc; a stabilised turret holds its bearing
against the hull's yaw; `laidTick`) → `fireSystem` → `stationFireSystem` (operator, feed switch, single-round
loading by the loader station, line of fire from the muzzle with `sight()` ignoring the own hull, `friendInLine`
over men on foot, bursts from the weapon's `sustained` data; every round through `launchShot` with
`shot.fired.vehicle`; due smoke salvos) → … → `projectileSystem` → `vehicleIncomingSystem` (hull hits stamp
`lastHitTick` and `underFireTick`/`contactTick` of the crew unit and its platoon; fire near a vehicle renews its
ordered tasks — the infantry `incomingFireSystem` returns early without fire tasks, plan C34) → … →
`decisionSystem` → `stationDecisionSystem` (1 Hz per vehicle, staggered: target choice from the crew's contacts,
nature AP/HE/MG, `station.why` keys, `vehicle.decision` events on change; halted refill of ready belts from
stowage through `transferItems`, action `reloadStation`). Fire control is the crew unit's own (`fireTop`): a
cease-fire to a squad never silences its IFV; to the platoon it reaches the vehicles (`stationCeaseFire`); "return
fire" answers fire on the crew or its platoon. Orders: `fire` (+`nature`), `discharge`; `not-applicable` for
orders a crew (or a foot unit, for smoke) cannot carry out.

Spotting: vehicles are targets (area of hull and turret boxes at the observer's aspect, aim points, the target's
own hull ignored); crewmen observe through their seats' sensors (arc, following hull or turret, range, fog floor,
rain), every fourth scan; men on foot look for vehicles every fourth scan (cost bounds; detection rates are per
second, so unchanged on average). Each sensor keeps `smokeFactor` of its view through ordinary smoke and none
through a multispectral cloud (`throughSmoke`). Contacts on vehicles carry `cls`, `vtype` (within the type's
`identifyM`), heading and velocity; shots from a station are heard as the vehicle; engines are heard every 2 s
(`engineRangeM`: idle/moving range × surface × rain × wind). Ammunition expenditure for the AAR and the batch
report is tallied from events (`tallyExpenditure`: vehicle rounds credited to the vehicle).

## 16k. Armour, damage and shoulder-fired anti-tank weapons (M7.4a) — `systems/armour.ts`, `systems/launcher.ts`, `flight.ts`

**Plates.** `VehicleDef.armour.plates` (one per part × face) become `VehicleRT` (`buildVehicleRT`, derived per
battle, never saved): mild-steel-equivalent mm per mm (`resistance`, `resistanceShaped`), slope, ricochet angle,
and `minNeedMm` (thinnest plate square on), copied per row into `VehicleGrid.minNeed`. **Hot loop**
(`projectileSystem`): at a hull or turret hit, a non-explosive round with `penSteelMm × 2.5 < minNeed` stops inline
as before (aggregated `vehicle.hit` per row and tick, no call); every other kinetic round, every shaped charge and
every armed impact-HE round is queued (`HQ`, stride 13: row, point, velocity, speed, ammo, owner, part, face, age)
— kinetic and shaped rounds are removed from the pool, HE still settles and bursts as before. Rockets: the
explosive branch applies the motor's push (`thrust` from tick `ignTicks` to `burnEndTicks`) and the self-destruct
(`selfDestructTicks`); `flight.ts` `flightStep` is the same arithmetic for aiming (tested equal). **After the loop**,
before the aggregated events and the bursts: `resolveVehicleHit` per queued hit — `plateNeed` (path thickness =
t / max(cos incidence, 0.05) × resistance), kinetic ricochet (heavy rounds re-added slowed) / penetrate if `can ≥
need` / stop; shaped: graze fuse failure, unarmed dud, else a burst queued just off the plate and the jet if
`penSteelMm ≥ needS`; HE: the blast breach rule on thin plates, external components (tracks) by filling. Inside
(owner Q11): `interior` walks the path through seat boxes (`resolveBodyHit`) and component boxes (condition −=
residual / toughness; −absorb), the jet losing `jetDecayMmPerM`; a kinetic round with enough left for the far
plate is re-added beyond it (`addProjectile`, only after the loop); then `behindArmour.spallCount` fragments in a
cone strike the first seat or component on their line. Stream `armour` (lazy). Events `vehicle.hit` (now with
`components`), `vehicle.component`, `vehicle.fire`, `vehicle.status`, `vehicle.destroyed`, `vehicle.abandoned`.

**Outcome** (`afterDamage`, `vehicleDamageSystem` after `projectileSystem`, every tick, returns at once without
vehicles): engine/track at 0 → `immobilised` (route cleared); gun at 0 → `disarmed`; ammunition `cookOffChance` →
`destroyed` at once; `fireChance` → `fire` (+ a smoke cloud), bail-out after `bailOnFireSeconds`, cook-off checks,
burnt out after `burnSeconds` → `destroyed`. Crew reaction (Q14/Q15): `bailOut` when burning, immobilised and
penetrated again (`wasImmobilised && pen`), immobilised and disarmed, or no crewman able; else `continue`. The
bail-out (`ramp.bailOutSeconds` later) moves every man aboard who can walk out (`getOut`, shared with dismount),
ends their units' boardings, sets `abandoned`. `destroyVehicle` burns everyone still aboard (`applyBurn`). Wrecks:
every contact on it gets `wreck: true` (Q8: both sides know at once), spotting/targeting skip it, the renderer
draws enemy wrecks under fog, `deriveWrecks` stamps it into the nav grids, `BattleResult.wrecks` lists it.
Points: `VictoryRules.vehiclePoints` (Q9) in `battleScore` (`SideScore.vehiclesLost/vehiclesImmobilised`).

**Launchers.** Ammunition with `delivery.method "direct"` (+ `launcher`, `dispersionMrad`, `aimSeconds`,
`backblastM`, `disposable`) is skipped by the grenade code. `Unit.atRule` (rules order `at`, cascading;
`atRuleOf` falls back to `behaviour.antitank.atRuleDefault`). `launcherDecision` (from `decisionSystem`, halted, fire
rule allows): a seen vehicle contact (or, with `vehiclesAndPositions`, a man in a house or with a machine gun)
within the round's range, clear line (target hull ignored), `backblastBlocked` (Q20 room rule, wall within
`wallBehindM` behind, own man in the 60° cone within `backblastM`) → action `fireLauncher` (`aimSeconds`); at its end
`fireRound`: contact position + velocity × time of flight, elevation from `aimSolution` (bisection over
`flightStep`), range error and angular error (stream `antitank`), the round removed (rule 9), `grenade.launched
{method: "direct"}`. Order `fire {nature: "at"}` → `orderLauncherShot` (best-placed man, once; keeps drills). Out of
rounds: a comrade within `handOverM` gets `bringAmmo` with `Intent.item`. Expenditure: `SideExpenditure.rockets`.

## 16l. Components, fire, crew reactions, cross-loading, AI anti-tank tasks (M7.4b) — `systems/armour.ts`, `mount.ts`, `ai/commander.ts`

**Components.** `ComponentKind` (data enum `COMPONENT_KINDS`): engine, transmission, track, turret-drive, stabiliser,
gun, coax, sights, radio, dischargers, extinguisher, ammo, fuel. `compCondition(v, def, kind)` (mount.ts) = the worst
of that kind, 1 if none listed (old data behaves as before). Effects where they act: `driveFactors` (drive.ts: engine
< 0.5 → half power; each track pulls with its condition); `mobile()` (engine, track or transmission at 0 →
immobilised); `turretSystem` (turret drive < 0.5 → ×0.25 traverse and elevation; stabiliser 0 → unstabilised);
`stationFireSystem` (stabiliser 0 → error as "none"; sights 0 → ×3); `weaponOut` / `pickFeed(…, v)` (gun 0 → the
cannon, coax 0 → the coaxial MG; both out → disarmed); `crewScan` (sights 0 → gunner/commander through
`vision-block`); `simpleComms.update(state, params, catalog)` (radio 0 → crew unit `link "none"`, and any unit
whose living men are all aboard that vehicle); `dischargeSmoke` (dischargers 0 → `radio.noSmoke`; any crew in a
vehicle that is not abandoned or destroyed may fire them).

**Fire.** `VehicleState.fire.intensity` 2 for an ammunition fire, `nextExtTick` (−1 = no try left). With a working
extinguisher component and a charge (`VehicleDef.extinguisher.item`, counted in the container) the crew waits:
`tryExtinguish` removes one charge, puts the fire out with `chance / intensity` (`vehicle.extinguished`,
`radio.fireOut`), else tries the next charge after `delaySeconds`; with none left it orders the bail-out
(`reaction.burning`). Without an extinguisher: bail-out at once, as in M7.4a.

**Crew reactions.** `crewReactionSystem` (after `moraleSystem`, staggered `reactionStepSeconds`): for a crewed
vehicle that is `ok`/`disarmed` with a driver and an able crewman, reasons `reaction.penetrated` (lastPenTick),
`reaction.disarmed`, and — unless `playerHold` (its last move/halt order carried `Order.player`, set by the app's
`issue`; `noteVehicleOrder` in drive.ts) — `reaction.panicked` (commander panicked; shaken is not enough) and
`reaction.atThreat` / `reaction.atClose` (the nearest enemy man on foot its crew saw in the last 10 s within
`atThreatM` that `canEngageAt` (gunnery.ts: an operator, a loaded unwrecked gun or MG in reach, the bearing in its
arc, the elevation within its limits, a clear line from the muzzle) says it cannot fire at; `atClose` when he has a
loaded launcher (`launcherRound`)) → `reverseOut`: smoke (turret swung to the threat if idle), `vehicleMove`
`reverseOutM` away from the man or from `threatAz` (the bearing the last heavy/penetrating hit came from), reverse
legs if the threat is ahead, ending facing it; held `reverseHoldSeconds`; `vehicle.reaction` event (debug overlay:
`VehicleDebug` keeps the last per vehicle, and shows `returnTo` and `playerHold`). A shaped-charge strike that
does not get through (`lastShapedHitTick`) is no reason (owner 2026-11-13). Without damage among the reasons the
vehicle keeps `returnTo` (where it stood; kept across a second reverse on the way back) and, when the hold ends with
no reason, drives back there (`reaction.returning`); `returnTo` goes on arrival, on damage and on any move/halt
order. Bail-out stays in `afterDamage`/`vehicleDamageSystem`.

**Crew on foot.** When the bail-out has run, the crew unit loses `vehicle`, gains `exVehicle`, and the hull's `unit`
becomes null: every order path (`orderApplies`, `vehicleClassOf`, `applyOrder`) then treats it as a foot unit.

**Cross-loading.** `vehicleSource` accepts, besides own halted vehicles, an `abandoned` hull of either side with
nobody able aboard (`emptyHull`); the man takes what fits his weapon through `takeFromVehicle` (`transferItems`,
`items.transferred` from the hull).

**Active protection and tiles (fixture only).** `VehicleDef.activeProtection` {item, detectM, standoffM,
interceptChance, cooldownSeconds}: in `resolveVehicleHit`'s shaped branch, before the fuse and plate, a charge
(container item) and the cooldown → draw: intercepted = one charge removed, the warhead bursts `standoffM` back
along its path, `vehicle.hit {result: "intercepted"}`, no jet; failed = the hit goes on as usual (simplification
of the plan's re-add next tick). `armour.tiles` {part, face, item, factor}: one item used up per armed shaped hit on
that face, `needS × factor`.

**AI** (`commander.ts`, every `atEverySeconds` after the ride): enemy vehicle contacts of its men (seen or
reported within `atContactSeconds`, not wrecks); each able man on foot with a loaded launcher (`launcherReady`,
from his own container) whose unit's `atRule` is not `hold`: a vehicle within his round's range → if
`backblastBlocked` (its own lazily built context) he is moved `atSidestepM` aside first, else `fire {nature: "at",
contact}` to him (rate `atRefireSeconds`); a halted vehicle up to `huntBeyondM` beyond → up to `huntersMax` hunters
sent to a point at `huntAtRangeShare` of their range (re-sent while stopped short, released after `huntSeconds`).
Ride: squads (and the HQ) get out at once when the crews know enemy men within `dismountThreatMenM` of the
carrier or have seen an enemy vehicle within `dismountThreatVehicleM`. Withdrawal: vehicles first reverse
`withdrawReverseM`. A following vehicle that is reversing out is left alone `reverseOutHoldSeconds`. Lost vehicles
are counted from the side's hulls (a bailed crew has none); bailed crews (`exVehicle`) are sent back to the start.

## 17. Foundation requirements of the extensions, and their guards

This table is kept current. "Guard" names the test that fails if the requirement is broken.

| SPEC | Requirement | Where | Status | Guard |
|---|---|---|---|---|
| 4.3.1 | Deterministic, fixed timestep, same input ⇒ identical state | sim.ts, rng.ts, store.ts | ✅ | `tools/test/determinism.test.ts`, `tools/test/golden.test.ts`, `sim/test/rng.test.ts` |
| 4.3.1 | Named RNG sub-streams isolate systems; sim RNG state survives save/replay | rng.ts, comms.ts (jitter) | ✅ | `sim/test/rng.test.ts`; `orders.test.ts` "delivery jitter"; determinism + golden tests (jitter draws every order) |
| 4.3.2 | Transcendental maths only in sim/math | math.ts | ✅ | `architecture.test.ts`, ESLint |
| 4.3.3 | Orders are the only external input | orders.ts, run.ts, `SimView` | ✅ | `determinism.test.ts` "controllers do not change simulation state"; read-only `SimView` type for controllers and renderer. (`startAction` is internal: no order starts an action until M4 adds ammunition hand-over.) |
| 4.3.4 | Whole state serialisable; save/load continues identically | state.ts, run.ts | ✅ | `sim/test/state.test.ts` (round trip, NaN, -0, data fingerprint); determinism "mid-battle save", "future orders", "AI-vs-AI resumes" |
| 4.3.5 | Event stream for all consumers | events.ts | ✅ (M0 kinds) | `sim/test/orders.test.ts` |
| 4.3.6 | Entities as IDs, component stores, typed-array pools for projectiles | store.ts, projectiles.ts | ✅ | `sim/test/state.test.ts` (ordering), `sim/test/ballistics.test.ts` "projectiles are battle state" |
| 4.3.7 | SI units inside the sim | all sim types | ✅ by convention | review |
| 4.3.8 | No faction in code; fixture faction runs a battle | data, scenario | ✅ | `tools/test/fixture-faction.test.ts`, `architecture.test.ts` |
| 4.3.9 | Counted items in containers, generic transfer | items.ts | ✅ | `sim/test/items.test.ts` |
| 4.3.10 | Wounds are records; casualties persist as entities | wounds.ts, components.ts | 🟡 M2 | (M2: casualty lab) |
| 4.3.11 | Battle is a function; roster in/out | battle.ts, run.ts, setup.ts | ✅ | `fixture-faction.test.ts` (forcesOut), determinism.test.ts |
| 4.3.12 | Player text through string table | strings.ts, events carry keys | ✅ | `fixture-faction.test.ts` (radio phrasing) |
| 4.4 | Performance floor (headless ≥ 8× real time on benchmark) | perf.test.ts, perf-projectiles.test.ts | 🟡 soldiers only: ✅ (~22×); with 20,000 projectiles ~7× here, floor 3× | `tools/test/perf.test.ts`, `tools/test/perf-projectiles.test.ts` |
| 9.1 | Time-stepped physiology with data-driven rates behind a swappable model | wounds.ts | 🟡 M2 | — |
| 9.1 | Actions with duration that can be interrupted | actions.ts | ✅ | `sim/test/orders.test.ts` "actions with duration" |
| 9.1 | Skills per soldier | SoldierState.skills, force builder | ✅ | `fixture-faction.test.ts` |
| 9.1 | Carrying as a movement mode involving several soldiers | — | ⬜ M4/M10 | — |
| 9.1 | Event entries for every medical event | events.ts | ⬜ M2/M10 | — |
| 9.2 | Containers on any entity (crates, depots, vehicles) | items.ts | ✅ | `sim/test/items.test.ts` |
| 9.2 | Weapons consume specific item types; no free ammunition | fire.ts, actions.ts (reload), setup.ts | ✅ | `sim/test/fire.test.ts` "every round comes out of a magazine", "empty magazine is changed ... and kept"; `data/test/loader.test.ts` |
| 9.2 | Vehicles have fuel and component states | components.ts (`VehicleState`), setup.ts, systems/drive.ts, systems/armour.ts | ✅ fuel M7.1b; components with immobilised/disarmed/fire M7.4a; full component table, extinguisher M7.4b | `sim/test/roster.test.ts` "forcesOut returns the vehicle record with fuel = in - burnt"; `tools/test/armour.test.ts`; `tools/test/components.test.ts` "component effects" |
| 6.7 | Physical drive model (tracked differential, wheeled radius) | systems/drive.ts, hulls.ts, nav.ts (`tracked:c1`) | ✅ dynamics, gears, rain, fuel M7.1b; navigation, follower, collisions, flattening M7.1c | `tools/test/lab-drive.test.ts`, `sim/test/drive.test.ts`, `sim/test/vehicles.test.ts`, `tools/test/vehicle-maps.test.ts`, `fixture-faction.test.ts` "xf-cart ... turn radius" |
| 4.3.5 | "vehicle hit" event | systems/ballistics.ts, systems/armour.ts | ✅ every hull hit yields `vehicle.hit` (aggregated below 12.7 mm) M7.1c; result ricochet/stopped/penetrated with components M7.4a | `sim/test/vehicles.test.ts` "rifle rounds stop at the hull and come out as one aggregated vehicle.hit per tick"; `tools/test/armour.test.ts` |
| 6.7 | Plates per facing, penetration, components | systems/armour.ts, ballistics.ts (`VehicleRT`) | ✅ M7.4a/b | `tools/test/lab-armour.test.ts`, `tools/test/armour.test.ts`, `tools/test/lab-antitank.test.ts`, `tools/test/components.test.ts` |
| 6.6 | Standing anti-tank rule | systems/launcher.ts (`atRuleOf`), rules order `at`, Rules panel | ✅ M7.4a | `tools/test/lab-antitank.test.ts` "standing anti-tank rule" |
| 4.4 | Scale with vehicles | perf.test.ts, perf-projectiles.test.ts, perf-render.test.ts | ✅ `bench-vehicles` ≥ 8× (M7.1c); `bench-combined` (300 men + 30 IFVs firing + 20,000 projectiles) ≥ 3× floor and close to the same load holding fire; render proxy < 4 ms (M7.3) | `tools/test/perf.test.ts`, `tools/test/perf-projectiles.test.ts` "30 parked hulls", "bench-combined"; `render/test/perf-render.test.ts` |
| 6.7 | Turret, sights, ammo racks | systems/gunnery.ts | ✅ M7.3 (penetration M7.4a) | `tools/test/lab-gunnery.test.ts`, `tools/test/gunnery.test.ts` (conservation, cease-fire routing C19, incoming fire C34, sling loader C10) |
| 6.7 | Smoke dischargers (APS slot reserved) | systems/gunnery.ts (`dischargeSmoke`), spotting.ts | ✅ smoke M7.3; APS and add-on tiles on the fixture M7.4b (recovery stays reserved) | `tools/test/gunnery.test.ts` "smoke dischargers"; `tools/test/vehicle-senses.test.ts` "thermal through smoke"; `tools/test/components.test.ts` "the charm intercepts…", "a shingle…" |
| 6.6/5.7 | Decision debug overlay | render/src/vehicle-debug.ts, `vehicle.decision` | ✅ station why M7.3; reaction why M7.4b | `render/test/debug-overlay.test.ts` "draws the station's why", "draws the crew's reaction" |
| — | Mounted-man invariants | architecture.test.ts A7, mounted-invariants.test.ts | ✅ source guard M7.1c (no file exempt since M7.2); runtime test M7.2 | `tools/test/architecture.test.ts` "men aboard vehicles are gated"; `tools/test/mounted-invariants.test.ts` |
| 6.7 | Crew seats, no driver no movement, passengers are soldiers | systems/boarding.ts, systems/drive.ts, mount.ts | ✅ M7.2 | `sim/test/mount.test.ts`; `sim/test/vehicles.test.ts` "no driver answers radio.noDriver" |
| 9.1 | Casualties loaded into a vehicle | systems/boarding.ts (`loadCasualty`) | 🟡 within 5 m of an exit, by two men (M7.2); carrying over distance M10 | `sim/test/mount.test.ts` "a casualty within 5 m of the exit is loaded by two men" |
| 9.2 | Vehicle-carried reserves, cross-loading | systems/boarding.ts (`takeFromVehicle`), systems/decisions.ts | ✅ refill from an own halted vehicle (M7.2); abandoned hulls of either side (M7.4b) | `sim/test/mount.test.ts` "refills from the halted carrier; items are conserved"; `tools/test/components.test.ts` "men take belts from an abandoned enemy hull" |
| 9.3 | Vehicles as roster data (force level, linked to crews by `vehicleId`) | battle.ts, setup.ts, run.ts | ✅ records in/out M7.1b; wrecks M7.4a; round trip M7.4b | `sim/test/roster.test.ts` "a vehicle whose crew unit is gone still comes out"; `tools/test/components.test.ts` "BattleResult.wrecks and ForceResult.vehicles round-trip" |
| 9.3 | Roster format separate from battle state | battle.ts | ✅ | `fixture-faction.test.ts` |
| 9.3 | AI able to play both sides unattended, and resume from a save; headless batch runner | ai, run.ts saveGame/loadGame, tools/cli/batch.ts | ✅ (trivial AI) | `determinism.test.ts` "AI-vs-AI battle saved halfway", `npm run batch` |
| 9.3 | Procedural scenario generator | scenario/demo.ts | 🟡 M6 | — |
| 9.3 | Persistent map damage stored as data | `state.terrain` (components.ts) | ✅ storage (damage is created from M2) | `sim/test/terrain.test.ts` "terrain damage is battle state" |
| 9.4 | Data packs validated with readable errors | data/loader.ts | ✅ | `data/test/loader.test.ts` |
| 9.5 | All order delivery and contact sharing via comms interface | comms.ts | ✅ orders / 🟡 contacts M3 | `sim/test/orders.test.ts` "delayed by the comms model" |
| 9.6 | No dependence on frame rate, device or wall clock | sim purity | ✅ | `architecture.test.ts`, tsconfig of sim |
| 9.7 | Environment state exists and is read by spotting, ballistics, movement (vehicles: rain → traction/rolling), fatigue, hearing | environment.ts, systems/body.ts, systems/drive.ts, systems/contacts.ts | 🟡 fatigue reads temperature ✅; vehicle movement reads rain ✅ (M7.1b); engine hearing reads rain and wind, vehicle sights read fog and rain ✅ (M7.3); ballistics reads wind and temperature | `sim/test/body.test.ts` "heat makes running more tiring"; `tools/test/lab-drive.test.ts` "rain slower than dry"; `tools/test/vehicle-senses.test.ts` "rain shortens engine hearing" |
| 9.8 | Map format and event stream as specified; importer interface | map.ts, mapgen/index.ts | ✅ (heightfield in JSON: proposed SPEC change) | `sim/test/terrain.test.ts` "map file format", `tools/test/mapgen.test.ts` |
| 6.2/4.4 | Pathfinding per movement class; spatial hashing for neighbourhood queries | nav.ts, spatial.ts | ✅ | `sim/test/nav.test.ts`, `tools/test/nav-maps.test.ts` |
| 6.1 | Generated maps identical on every device (part of battle input) | scenario/mapgen | ✅ | `mapgen.test.ts` "deterministic", `architecture.test.ts` scenario purity, ESLint |
