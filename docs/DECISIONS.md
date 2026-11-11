# Decisions

Dated entries, one paragraph each: decision, reason, alternatives rejected. Newest at the bottom.
A changed golden-replay hash must be explained here (or it is a bug).

## 2026-11-11 — Owner answers to the first-session questions
Working title **TCS** (kept from the repository name). Interface language **English first**; German can be
added as a translation file because all text already goes through string tables. Scenario flavour:
**fictional Central/Eastern European region** (villages, farmland, forest edges, small industry; fictional
place names). Repository **public with no licence**: everyone can read the code, but all rights are reserved,
so others may not legally reuse it (GitHub's terms still allow viewing and forking on GitHub). Medical
system: **decide at the M6 review** whether to pull it forward; the foundations already allow it.

## 2026-11-11 — Toolchain and versions
Checked on npm on 2026-11-11: Vite 8.3.8, Vitest 5.1.0, PixiJS 8.22.0, ESLint 10.14.0, typescript-eslint
8.72.2, zod 4.6.7, tsx 4.23.15, Node 22 (Vitest 5 needs ≥ 22.12). **TypeScript 6.0.3, not 7.0.2**: TypeScript 7
(the new native compiler) is the latest release, but typescript-eslint supports only TypeScript < 6.1, so
linting would break. Revisit when typescript-eslint supports 7. Rejected: dropping type-aware lint tooling to
use TS 7 now.

## 2026-11-11 — Fixed timestep of 60 Hz
The simulation advances in ticks of 1/60 s. Fast enough that a 900 m/s bullet moves 15 m per tick (swept
segment tests handle thin walls), and the renderer can show smooth motion on 60 Hz screens. Rejected: 30 Hz
(coarser projectile steps), 120 Hz (doubles the cost for little gain). Systems that need less frequent updates
(AI, spotting, comms) run on staggered sub-schedules.

## 2026-11-11 — Random numbers: sfc32 per named stream
Each named stream is an sfc32 generator seeded from FNV-1a(name) mixed with the battle seed via splitmix32 and
warmed up. Pure 32-bit integer arithmetic, so identical on every JavaScript engine; 128-bit state serialises
as four numbers. Streams are created lazily (creation depends only on seed and name, so it does not affect
results). Normal samples use the sum of 12 uniforms to avoid transcendental maths. Rejected: one global
generator (any new random call would shift every other system's results), xoshiro128** (equally good; sfc32
is simpler).

## 2026-11-11 — State hash: canonical JSON + 64-bit non-cryptographic hash
The determinism hash serialises the state, sorts object keys, and hashes the string with a two-lane 32-bit
multiply hash (cyrb53-style, 64 bits shown as 16 hex digits). Cheap enough to run every few seconds in tests
and on demand in the app. Not cryptographic; it only needs to detect accidental differences. Rejected:
hashing typed arrays directly (no typed arrays in state yet), SHA-256 (needs async WebCrypto or a dependency).

## 2026-11-11 — Component stores with ID-ordered iteration
Component stores are `Map`-backed but wrapped in `Store<T>`, which guarantees ascending entity-ID iteration,
including after a component is removed and re-added. Plain `Map`s iterate in insertion order, which would
differ between a live run and the same state loaded from a save — a silent determinism bug. Projectiles and
fragments will use typed-array pools in M2 (SPEC 4.3 rule 6). Rejected: arrays indexed by entity ID (sparse
and awkward to serialise), classes per entity type (deep hierarchies, SPEC forbids).

## 2026-11-11 — Packages export TypeScript source; per-package type checks
Workspace packages point `exports` at `src/index.ts` and are compiled on the fly by Vite, Vitest and tsx.
No build step per package keeps the setup small. Each package is type-checked with its own `tsconfig.json`;
`sim`, `data`, `ai`, `scenario`, `campaign` get no DOM and no Node type definitions, so using `window`,
`document`, `process` or `fs` there is a compile error. Rejected: TypeScript project references (require
declaration emit and add configuration for no benefit at this size).

## 2026-11-11 — Dependency: zod (data validation)
Data files are validated with zod 4: one schema definition gives validation, readable error paths and the
TypeScript types. Only `data` (and through it `scenario`/`app`) uses it; `sim` stays dependency-free.
Rejected: Ajv + JSON Schema (types would need a second definition or a code generator), hand-written
validators (more code, worse messages).

## 2026-11-11 — Dependency: pixi.js (rendering)
PixiJS 8 as required by SPEC 4.1. WebGL renderer requested explicitly; `render` only reads state.

## 2026-11-11 — Development dependencies
`typescript`, `vite`, `vitest`, `eslint`, `@eslint/js`, `typescript-eslint`, `globals` (ESLint browser/Node
globals), `@types/node`, `tsx` (runs the TypeScript command-line tools without a build step). Playwright is
**not** a dependency: it is pre-installed in the development container and only used by the screenshot
script, which CI does not run. `npm audit` reports a moderate advisory in `minimatch` pulled in by the lint
toolchain only (never shipped to the browser); accepted until typescript-eslint updates.

## 2026-11-11 — Coordinates and units
Metres, seconds, kilograms, radians inside the simulation. x grows east, y grows south (like the screen),
origin at the map's north-west corner, z is height above ground. Heading 0 = east, π/2 = south. Conversions
to km/h, mils, rounds per minute, etc. happen only in the UI.

## 2026-11-11 — Order timing and delivery
An order carries the tick it is issued at and is processed during that tick (orders for a past tick are
rejected as `late`). The app issues orders for the current tick. Delivery delay comes from the comms model;
the foundations use a constant 1 s (`rules.comms.orderDelaySeconds`). An order to a unit that is out of
contact is lost in the foundations (M14 adds runners and retries). Orders with the same tick are processed in
submission order, so a recorded stream replays exactly.

## 2026-11-11 — Items: faction-prefixed IDs, charge for partly used items
Item IDs must be globally unique across loaded packs, so they are prefixed with the faction ID
(`de-g95-mag`). A magazine with 12 of 30 rounds is a stack with `charge: 12`; stacks of the same type and
charge merge. Rejected: per-item entities (thousands of entities for cartridges), namespacing IDs
automatically in the loader (harder to read in data files).

## 2026-11-11 — M0 movement: men keep their offsets
In M0 a move order sends every man to the destination plus his current offset from the leader, in straight
lines at the movement mode's speed. This is a placeholder: M1 replaces it with formations, pathfinding and
individual cover-seeking. Documented so nobody mistakes it for the design.

## 2026-11-11 — Placeholder data flagged, not invented
The German and Russian packs contain ranks, name lists and radio phrasing with sources, but the unit
templates (`demo-team`), roles and doctrine values are **placeholders** marked `confidence: "low"`; doctrine
values are identical for both sides until M4. Researched organisation tables come with M1/M2 and need the
owner's review. Russian names are transliterated into Latin script; female family-name endings (Ivanov →
Ivanova) are a data field (`familyFemaleSuffix`), not code. Source URLs could not be opened from the
development container (its network blocks Wikipedia); they were recorded from knowledge and must be
spot-checked.

## 2026-11-11 — Performance floor: 8× real time on the benchmark
`npm test` fails if the headless benchmark (304 soldiers, 2 × 2 km, everyone moving) runs slower than 8×
real time. Measured 463× on the development container: the floor is deliberately loose for shared CI machines
and because M0 has only movement. The benchmark gains projectiles in M2 (20,000 live projectiles), and the
floor will be re-baselined then.

## 2026-11-11 — Deployment: GitHub Actions → GitHub Pages from main
CI runs typecheck, lint, data lint, all tests (including determinism, golden replays, architecture guards and
the performance floor) and a production build on every push and pull request; pushes to `main` deploy the
build to GitHub Pages only if all of that passed. The site is built with base path `/<repo>/`. Requires the
one-time repository setting *Pages → Source: GitHub Actions*.

## 2026-11-11 — Stop hook with an explicit escape hatch
`.claude/settings.json` runs `.claude/hooks/stop-check.sh` when a Claude Code session tries to end; it runs
the typecheck and the tests and blocks the stop (exit code 2) if either fails. For failures outside the code
(e.g. no network for `npm ci`), creating `.claude/allow-red-stop` with a reason allows one stop and must be
reported to the owner. Rejected: a hook without an escape (can trap a session in a loop when the cause is
environmental).

## 2026-11-11 — Golden replays recorded from controllers, replayed without them
`npm run golden:update` runs each golden scenario with its AI controllers, stores the resulting order stream
and state hashes every 10 s plus the catalog fingerprint. The test replays the stored orders without the
controllers. This checks determinism and that a recorded stream reproduces a live battle. Initial goldens:
`demo-s1` (DE vs RU, 120 s) and `fixture-s7` (fixture faction vs DE, 90 s).

## 2026-11-11 — Fixes from the independent M0 review (goldens regenerated)
An independent reviewer found six problems; all fixed, each with a test.
(1) **Orders may only be submitted for the current tick**; a future-tick order throws, and `createSim` no
longer pre-queues the input stream (`runBattle`/`continueBattle` feed it tick by tick). Before, a save taken
while orders waited in the inbox was continued with those orders fed a second time, so the battle diverged.
Holding future orders (lockstep input delay, scheduled AI plans) is the caller's job. (2) **Saving refuses
NaN/Infinity** and names the field; before, JSON silently turned NaN into `null`. `-0` is normalised to `0`
and `sim/math.atan2` never returns `-0`, so a save round trip is exact. (3) **The simulation now uses its own
randomness**: order delivery gets a random extra delay of 0-1 s (`comms.orderDelayJitterSeconds`, stream
`comms`), so every determinism, replay and save test now also covers RNG state. (4) **Controllers see a
read-only view** (`SimView`, a deep read-only type) and a test checks that thinking never changes the state
hash. (5) **Controllers can save their memory** (`saveState`/`loadState`; `saveGame`/`loadGame`), and an
AI-versus-AI battle saved halfway now resumes identically (tested). (6) **Saves record the data fingerprint**
and refuse to load against different data. Golden replays were regenerated because the state gained the
`catalogFingerprint` field and delivery times changed with the jitter. Rejected for (1): matching saved inbox
orders against the stream (fragile when identical orders are legitimately repeated).

## 2026-11-11 — Owner answers: first squads and callsigns
First German squad to model: **Panzergrenadier dismounts of a Puma** (leads naturally into the vehicle
milestone). First Russian squad: **motor-rifle squad on a BMP** (the mirror of the German choice). Callsigns:
German units use **"Gruppe {n}"** for the squad and **"Trupp {n}"** for the team; the Russian placeholder
"Gruppa {n}" stays for now. Organisation tables will be researched from public sources in M1/M2 and shown to
the owner for review before they are fixed.

## 2026-11-11 — Owner answers for M1.1 (map look, villages, size)
Map look **naturalistic** (soft, varied colours with texture, hill shading, faint contour lines) rather than
topographic. Villages: **a mix chosen by the seed** — street villages (houses along one road with long plots
behind) and clustered villages (around a square with a church, lanes radiating). Default test-map size
**2 x 2 km** (company scale; maps up to 4 x 4 km remain possible).

## 2026-11-11 — Terrain model: grids plus vectors, all kinds as data
The map is a heightfield (samples at cell corners, 4 m cells by default) plus two byte grids (surface,
vegetation) and vector layers (linear obstacles, buildings with wall material/thickness/doors/windows/storeys,
roads, water). Surface, vegetation, obstacle and building kinds and materials are data files in
`core/terrain/` with movement costs per movement class (foot, wheeled, tracked), concealment and bullet
stopping (used from M2/M3), and display colours. Grids keep cell queries O(1); vectors keep walls and
buildings exact for line-of-sight and penetration later. A spatial bucket index of wall segments is derived
at battle start (not saved). Terrain damage (breaches, craters, thinned vegetation) is SimState, so it saves,
replays and can persist into the campaign. Rejected: everything as grids (walls would be 4 m thick), everything
as vectors (vegetation and surfaces would need polygon tests on every query).

## 2026-11-11 — PROPOSED SPEC CHANGE: heightfield inside the map JSON, not a separate image
SPEC 6.1 says "Map format: JSON plus heightmap image". The map file currently stores the heightfield (and the
surface/vegetation grids) as base64-encoded little-endian binary inside the one JSON file. Reason: an exact
round trip (a PNG decoded through a browser canvas can change values through colour management and is
limited to 8 bits per channel), one file per map, no image library. A heightmap image export/import fits the
map-editor and real-terrain-importer milestone. **Needs the owner's agreement** before `docs/SPEC.md` is changed;
until then this entry records the deviation.

## 2026-11-11 — Map generation follows the simulation's determinism rules
A generated map is part of the battle input, so every device must produce the identical map from the same
seed (multiplayer, replays). The generator uses the seeded RNG with named streams, integer-hash value noise
with polynomial interpolation, and `sim/math` for trigonometry; ESLint and an architecture test apply the
sim's bans (no `Math.random`, no wall clock, no direct transcendental maths) to `packages/scenario`. Maps
carry a generator version, and saves record the map fingerprint and refuse a different map.

## 2026-11-11 — Generator uses terrain IDs by name
The generator refers to specific terrain data IDs ("woodland", "hedge", "farmhouse", "asphalt" ...). These
are terrain data, not factions, so rule 8 is not affected; a missing ID fails loudly with the ID's name.
Modding terrain kinds therefore works for appearance and properties, while adding a new *kind* of thing to
generated maps needs a generator change. A data-driven generator ("map styles" as data) is possible later if
the owner wants regional variety.

## 2026-11-11 — Renderer: terrain as one texture plus vectors in a world layer
The ground is one texture (up to 2048 px, 3 px per 4 m cell on a 2 km map) built once per map: per-cell
colours blended bilinearly between cell centres for soft edges, then tree crowns, orchard rows, scrub clumps,
patchy variation, hill shading (relief exaggerated 4x so gentle hills read) and contour lines (2.5 m and
10 m). Roads, water, walls, hedges and buildings are vector shapes in metres in a container the camera moves
and scales, so panning and zooming redraw nothing. Rejected: redrawing terrain every frame (too slow on
phones), per-tile textures (unnecessary at 2 km).

## 2026-11-11 — Demo and benchmark scenarios on generated maps; goldens regenerated
The headless `demo` scenario now runs on a generated 2 km village and the benchmark on generated farmland, so
golden replays and the performance floor exercise map loading. The flat map stays available as `demo-flat`.
Golden replays were regenerated (intended: new map, new terrain data in the catalog). Benchmark: 203x real
time (was 463x on the flat map; the difference is building the map index and fingerprint per battle).

## 2026-11-11 — Fixes from the independent M1.1 review (goldens regenerated)
The reviewer found that 9 of 160 generated maps (40 seeds x 4 kinds) broke the generator's own rules and that
the checks were too weak to notice more. Fixed: ponds are only placed where they touch no building or road
(several spots tried); industrial main road runs straight so lot fences no longer cross it; every road cuts a
gap in walls, fences and hedges it crosses, in whichever order they were added (railway embankments excepted);
building placement also tests the exact road outline, not just the 4 m cells; clustered villages lay their lanes
before the church; generator and validator use the same "reaches the map edge" tolerance. The validity check
(`checkMap`) is now strict: building corners (not only centres) against roads and water, walls/fences/hedges
crossing roads, and road-network connectivity by groups. Result: **160 of 160 maps valid**; the tests cover 12
seeds per kind. Map files and `validateMap` now reject grids that do not match the map size; the map
fingerprint uses canonical JSON. Hard-coded terrain IDs in the generator and renderer ("floor", water kinds,
woodland/orchard/scrub drawing) were reviewed and kept (see "Generator uses terrain IDs by name").
