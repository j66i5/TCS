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
interface Controller { side: SideId; think(view: SimState, tick: number): Order[] }
```

The roster format (`SoldierRecord`, `UnitInput`) is separate from battle state: the campaign stores
records, a battle turns them into entities (`setup.ts: buildInitialState`) and back
(`soldierRecordFromState`, `unitsFromState`). `continueBattle(sim, input)` runs a loaded save to the end.

Controllers (AI commanders, scripted tests, later network peers) only return orders; `runBattle` records
every order it submits, so an AI-vs-AI battle is reproducible from `result.orders` alone.

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
  version). `deserializeState` rebuilds. `hashState` = 64-bit hash of the canonical (key-sorted) JSON.
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

Life cycle: `submitOrder` puts it in `state.inbox` (deep-copied, numbered `seq`) → at its tick it is
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

## 11. Wounds and physiology (rule 10) — `sim/src/wounds.ts`

```ts
interface Wound { id; zone: BodyZone; mechanism; severity; bleedingLps; compressible;
                  airway; breathing; consciousness; tickInflicted; source?; treatments: TreatmentRecord[] }
interface Physiology { bloodVolumeL; shock; consciousness; pain; alive }
interface PhysiologyModel {
  id; step(physiology, wounds, dtSeconds, params): void;   // data-driven rates in params
  capabilities(physiology, wounds): { walk; useArms; fight; speak };
}
```

🟡 Types exist and every soldier carries `wounds[]` and `physiology`; a casualty stays a soldier entity
(entities are never deleted). The simple model and wound creation arrive in M2; the medical system (M10)
replaces the model's contents, not this interface. `BattleRules.physiologyModel/physiologyParams` select it.

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
constant delay from `rules.comms.orderDelaySeconds` (default 1 s). Command & EW (M14) supplies a richer model.

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

## 16. Map (SPEC 6.1) — `sim/src/map.ts`

`MapDef { id, widthM, heightM (≤ 4000), cellSizeM, heights[], layers{} }`. M0 maps are flat; M1 fills the
heightfield and terrain layers and adds the generator and the reserved importer interface.

---

## 17. Foundation requirements of the extensions, and their guards

This table is kept current. "Guard" names the test that fails if the requirement is broken.

| SPEC | Requirement | Where | Status | Guard |
|---|---|---|---|---|
| 4.3.1 | Deterministic, fixed timestep, same input ⇒ identical state | sim.ts, rng.ts, store.ts | ✅ | `tools/test/determinism.test.ts`, `tools/test/golden.test.ts`, `sim/test/rng.test.ts` |
| 4.3.1 | Named RNG sub-streams isolate systems | rng.ts | ✅ | `sim/test/rng.test.ts` "isolates streams" |
| 4.3.2 | Transcendental maths only in sim/math | math.ts | ✅ | `architecture.test.ts`, ESLint |
| 4.3.3 | Orders are the only external input | orders.ts, run.ts | ✅ | `sim/test/orders.test.ts`; replay test in determinism.test.ts |
| 4.3.4 | Whole state serialisable; save/load continues identically | state.ts | ✅ | `sim/test/state.test.ts`; determinism "mid-battle save" |
| 4.3.5 | Event stream for all consumers | events.ts | ✅ (M0 kinds) | `sim/test/orders.test.ts` |
| 4.3.6 | Entities as IDs, component stores, typed-array pools for projectiles | store.ts | 🟡 pools in M2 | `sim/test/state.test.ts` (ordering) |
| 4.3.7 | SI units inside the sim | all sim types | ✅ by convention | review |
| 4.3.8 | No faction in code; fixture faction runs a battle | data, scenario | ✅ | `tools/test/fixture-faction.test.ts`, `architecture.test.ts` |
| 4.3.9 | Counted items in containers, generic transfer | items.ts | ✅ | `sim/test/items.test.ts` |
| 4.3.10 | Wounds are records; casualties persist as entities | wounds.ts, components.ts | 🟡 M2 | (M2: casualty lab) |
| 4.3.11 | Battle is a function; roster in/out | battle.ts, run.ts, setup.ts | ✅ | `fixture-faction.test.ts` (forcesOut), determinism.test.ts |
| 4.3.12 | Player text through string table | strings.ts, events carry keys | ✅ | `fixture-faction.test.ts` (radio phrasing) |
| 4.4 | Performance floor (headless ≥ 8× real time on benchmark) | perf.test.ts | ✅ (movement only) | `tools/test/perf.test.ts` |
| 9.1 | Time-stepped physiology with data-driven rates behind a swappable model | wounds.ts | 🟡 M2 | — |
| 9.1 | Actions with duration that can be interrupted | actions.ts | ✅ | `sim/test/orders.test.ts` "actions with duration" |
| 9.1 | Skills per soldier | SoldierState.skills, force builder | ✅ | `fixture-faction.test.ts` |
| 9.1 | Carrying as a movement mode involving several soldiers | — | ⬜ M4/M10 | — |
| 9.1 | Event entries for every medical event | events.ts | ⬜ M2/M10 | — |
| 9.2 | Containers on any entity (crates, depots, vehicles) | items.ts | ✅ | `sim/test/items.test.ts` |
| 9.2 | Weapons consume specific item types; no free ammunition | — | ⬜ M2 | (M2: firing range lab) |
| 9.2 | Vehicles have fuel and component states | — | ⬜ M7 | — |
| 9.3 | Roster format separate from battle state | battle.ts | ✅ | `fixture-faction.test.ts` |
| 9.3 | AI able to play both sides unattended; headless batch runner | ai, tools/cli/batch.ts | ✅ (trivial AI) | `determinism.test.ts`, `npm run batch` |
| 9.3 | Procedural scenario generator | scenario/demo.ts | 🟡 M6 | — |
| 9.3 | Persistent map damage stored as data | map.ts layers | ⬜ M1/M2 | — |
| 9.4 | Data packs validated with readable errors | data/loader.ts | ✅ | `data/test/loader.test.ts` |
| 9.5 | All order delivery and contact sharing via comms interface | comms.ts | ✅ orders / 🟡 contacts M3 | `sim/test/orders.test.ts` "delayed by the comms model" |
| 9.6 | No dependence on frame rate, device or wall clock | sim purity | ✅ | `architecture.test.ts`, tsconfig of sim |
| 9.7 | Environment state exists and is read by spotting, ballistics, movement, fatigue | environment.ts | 🟡 state exists; no system reads it yet (movement must from M1) | — |
| 9.8 | Map format and event stream as specified | map.ts, events.ts | 🟡 map layers M1 | — |
