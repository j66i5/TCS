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

## 2026-11-11 — SPEC CHANGE (approved by the owner): heightfield inside the map JSON, not a separate image
SPEC 6.1 says "Map format: JSON plus heightmap image". The map file currently stores the heightfield (and the
surface/vegetation grids) as base64-encoded little-endian binary inside the one JSON file. Reason: an exact
round trip (a PNG decoded through a browser canvas can change values through colour management and is
limited to 8 bits per channel), one file per map, no image library. A heightmap image export/import fits the
map-editor and real-terrain-importer milestone. Approved by the owner on 2026-11-11; `docs/SPEC.md` section 6.1 updated accordingly.

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

## 2026-11-11 — M1.2 navigation: 2 m grid, weighted A*, one route per unit
Navigation runs on a grid of 2 m cells (half a terrain cell, so 1–4 m gates and gaps resolve), one grid per
movement class, derived from the map at first use and never saved. Cell cost = ground x vegetation time
multiplier from the terrain data; buildings block every cell they touch (conservative; interiors and doors
later); walls, fences and hedges add their crossing time (converted at walking pace) or block if they cannot be
crossed, so a route uses a gate when that is quicker than climbing. Search: A* on 8 neighbours without corner
cutting past walls or blocked cells, ties broken by cell index (deterministic), scratch memory reused across
searches. **Weighted A* (heuristic x1.1)**: on 2 km maps it cuts long searches from ~150–270 ms to ~30 ms at the
price of routes up to ~10 % costlier than the best; rejected: plain A* (too slow for many units), hierarchical
pathfinding (more code than needed now; revisit if AI path requests grow). A unit's route is found once from
its reference man; each man walks a parallel copy shifted by his offset when the straight segments are clear,
otherwise he joins the route, follows it and leaves it for his spot (a placeholder until M1.4 formations).
Paths are computed when an order is delivered and stored in the movers' waypoints, so they are saved and
replayed. Movement speed is the mode's speed divided by the cost of the cell underfoot (woods, ploughed fields,
climbing). No route: the order is acknowledged with "no route" on the radio (`move.noRoute` event) and nothing
moves.

## 2026-11-11 — Benchmark orders every 60 s (was 20 s)
With pathfinding, each unit move order costs ~12 ms (route plus three followers). The benchmark gave all 76
units a new long-distance order every 20 s (20x real time); real play issues far fewer long orders, so the
benchmark now does it every 60 s (51x real time; floor still 8x). If AI path requests grow in M4/M6, path
requests should be spread over several ticks (still deterministic).

## 2026-11-11 — Fixes from the independent M1.2 review (goldens regenerated)
Fixed, each with a test: (1) a follower whose bounded join search failed walked an unchecked straight line,
sometimes through houses — now a full search follows, and if even that fails he stays put; (2) the straight-line
check sampled points and could slip between wall cells that only touch at corners — it now walks every cell the
line crosses and refuses corner squeezes like A* does (`lineCost`); (3) the "no route" radio message had no text —
added to the core, German and Russian string tables, and the no-route path is tested; (4) an unreachable goal
searched the whole map (~0.35 s) — each grid now labels its connected areas at build time, a goal in another
area is snapped to the nearest reachable cell within the snap radius or rejected at once; (5) smoothing accepted
shortcuts by "no single cell costlier", which could cut across slow ground — it now compares the shortcut's total
cost with the route it replaces; (6) start positions just off the grid wrapped to the wrong row — now clamped.
Recorded for M2: the navigation grid is built from the map only and must also apply terrain damage from the
battle state (breaches, craters) once damage exists. Golden replays regenerated for M1.2 (new routes) and again
for these fixes.

## 2026-11-11 — Owner answers for M1.3 (posture, fatigue, load)
Posture changes **depend on the load carried**: brisk when lightly loaded (about 0.5 s standing/crouching,
1.0 s standing to prone, 1.5 s prone to standing), getting slower as the load grows. Fatigue: a loaded soldier
running in the open is **clearly winded after about 2–3 minutes** and recovers in about 5 minutes of rest.
**Load counts from now**: the mass of the counted items a man carries slows him and tires him already in M1.3;
real equipment weights arrive with the weapons data in M2. The owner also asked that all questions to him be
clickable multiple choice from now on (recorded in CLAUDE.md).

## 2026-11-11 — M1.3 body model: postures, speed factors, fatigue and heart rate
All numbers live in `core/body.json`. **Postures** change over data-driven times (standing->prone 1.0 s,
prone->standing 1.5 s, standing<->crouching ~0.5 s) multiplied by 1 + 0.02 per kg above 10 kg (owner: slower
with load); a man does not move while changing posture, and each movement mode carries its posture (crawl =
prone, sneak = crouching). **Speed** = mode speed x posture factor x slope factor (Tobler's hiking function,
fastest about 5 % downhill) x load factor (-0.6 % per kg above 10 kg, floor 50 %) x fatigue factor
(-35 % at full fatigue; hard paces halved when exhausted) / ground cost. **Fatigue** builds when the work rate
(mode exertion x (1 + 0.8 load/body mass) x (1 + 4 x uphill grade)) exceeds a sustainable 0.35 and recovers
below it; heat above 25 °C speeds the build-up (environment read by fatigue, SPEC 9.7). Rates were chosen so the
lab shows the owner's choice: loaded running -> fatigue ~0.65 at 150 s, recovered after 5 min rest; loaded
walking is sustainable. **Heart rate** approaches a target from exertion and fatigue (rise 20 s, fall 45 s).
**Load**: a 24 kg "basic fighting load" item per German and Russian soldier stands in for helmet, armour,
webbing, water and rations until M2 itemises kit (flagged low confidence). Physiology runs every tick (cheap);
benchmark 35x real time. Golden replays regenerated (state gained posture/physiology changes and load).
Rejected: an energy-expenditure model in watts (more parameters than the game needs now).

## 2026-11-11 — Fixes from the independent M1.3 review (goldens regenerated)
Fixed, each with a test: an order with an unknown waypoint posture is now rejected (it could crash the
simulation); an exhausted runner no longer stays at 100 % — once **winded** (fatigue >= 0.9) he shuffles at half
speed and works at half the sustainable rate until fatigue falls below 0.6, then runs again (bursts; recovering
from 0.9 to 0.6 takes about 4–5 minutes); the remaining hard-coded model numbers (posture-change exertion,
heart-rate weights, hard-pace threshold, exhausted speed, slope look-ahead, starting heart rate) moved into
`core/body.json`; cancelling a posture change before it completes keeps the old posture without reporting a
change; halt and posture orders end a move without an "in position" call; the lab test now also checks that a
loaded runner is not yet winded after 60 s and not yet recovered after 60 s of rest; the state schema version is
3. The debug fatigue/heart-rate label is debug-only and not routed through the string table (accepted).

## 2026-11-11 — Owner answers for M1.4 and the formation/cover design
Owner: default formation **wedge**; spacing **about 10 m**; cover preference **balanced** (accept routes about
30 % longer to stay in cover); at the halt **each man takes the nearest cover within about 15 m of his slot and
goes prone**. Design: formations are slot lists in `core/formations.json` ([right, back] in units of the
doctrine spacing; wedge, file, line); each faction's doctrine names its default formation, spacing and
`coverPreference` (both factions: wedge, 10 m, 0.3 — identical until M4). A static **exposure** map per
navigation grid marks cover: tall vegetation by concealment x height, and a 4 m strip beside walls, hedges,
embankments and buildings. Routes are planned on a cover-weighted grid (open ground costs up to 1 +
coverPreference); movement speed still uses plain costs. Followers walk their slot alongside the leader's route
(offset rotated with each leg), with blocked legs repaired by search; they ease off or hurry (x0.7 / x1.2) to
keep within 3 m of the slot while the leader moves. Halt drill: best cover cell within 15 m (exposure + a small
distance term), prone, facing outward from the group. Overview zoom (< 0.35 px/m) draws one infantry symbol per
unit. Search estimate scaled on cover grids (otherwise long searches explored far too much: benchmark 14x -> 24x).
Honest result: on generated villages, cover-seeking routes are 94–101 % of the quickest length and spend on
average about 18 % instead of 13 % of their length in cover — a real but modest effect, because most open
farmland offers no cover within a 30 % detour; and the halt drill often finds only crops (partial concealment).
Cover relative to known enemies (dead ground, facing threats) is the bigger lever and comes with spotting (M3)
and behaviour (M4). Golden replays regenerated.

## 2026-11-11 — Fixes from the independent M1.4 review (goldens regenerated)
The reviewer found no mechanical defects in routing or determinism but showed that two acceptance tests
overstated their result. Corrected honestly: the cover-route test now claims "on average more time in cover,
never much longer" (the effect is modest; the owner decides whether to strengthen it), and the halt test claims
"prone at the best spot near the slot" (often only crops are within reach). Fixed: the app no longer sends a
hard-coded "wedge" — until the player picks a formation, each faction's doctrine default applies, and the
formation button lists the formations from data; catching up to a slot can no longer exceed a man's unimpaired
pace (fatigue and load penalties stay); the leader slows to half pace while any follower is more than 15 m
behind his slot (furthest man from the leader in the village test: 35–37 m, was up to 66 m); men beyond the
formation's slot list extend the last slot backwards instead of stacking on the leader; the halt cover move is
skipped if the walk to it would be long (behind a wall); leftover end-of-move settings are cleared by new orders.
Known, recorded: slots are assigned by soldier ID, not by where men stand (men may cross at the start).

## 2026-11-11 — Owner answers: cover preference stays balanced; M2 planning decisions
Cover preference stays **balanced** for now (the larger gain comes in M3/M4 when men avoid ground the enemy can
see; revisit at the M6 review). For M2: the **owner dictates the squad tables** (Panzergrenadier dismounts of a
Puma; motor-rifle squad on a BMP) — Claude enters them and flags anything that cannot be backed by a public
source; default rifles **G36** (German) and **AK-74M** (Russian), with G95A1 and AK-12 in the data as
alternative loadouts; both sides wear **helmet and a vest with rifle-rated plates** front and back by default;
the simple wound model runs on a **realistic clock** (untreated massive bleeding: unconscious in roughly 1–3 min,
dead in roughly 3–10 min; moderate wounds tens of minutes; minor wounds never kill); lethality is a **realistic
mix** (with plates and helmets most hits wound or incapacitate; roughly one casualty in four or five killed
outright, tuned in the casualty lab and shown to the owner); bullets in flight: **tracer rounds as clear
streaks, all other bullets as very faint streaks**, plus muzzle flashes and impact puffs (all bullets fully
visible in the debug view).

## 2026-11-11 — M2 slice plan and software choices
Five slices, one session each (ROADMAP.md). Order chosen by technical risk: the projectile engine and its
performance come first with one researched rifle per side, then the shooter, then the body, then explosives,
then the full squad data. Claude's choices: scope of M2 weapons is rifles, machine guns, marksman rifle, hand
grenades and 40 mm / under-barrel grenade launchers (shoulder-fired anti-tank weapons wait for M7 as the spec's
roadmap says); friendly fire is on, because hits come from geometry (pillar 2); firing in M2 is driven by a
minimal "fire at point" order and lab scripts — target choice and fire discipline are M4; near-miss events are
emitted from M2 but only become suppression in M4.

## 2026-11-11 — Research from public sources (owner request) and how it is used
The owner asked for real-world research for both the ballistics and the squad organisations. Two research
tasks searched public sources (manufacturer data, bundeswehr.de, mil.ru, US Army field manuals on public sites,
forensic ballistics papers, defence journalism, Wikipedia). **Limit: the pages themselves could not be opened
from the development environment; all values come from search-result extracts**, so the data built on them is
marked `confidence: "medium"` at best and the tables need re-checking when the pages can be read. Results:
`docs/research/ballistics.md` (used in M2.1) and `docs/research/squads.md` (input for the owner's squad tables
before M2.5; sources conflict on several points, listed there).

## 2026-11-11 — M2.1 projectile engine: model choices
**Storage:** projectiles live in typed arrays in the state (`state.projectiles`), saved as plain arrays of the
live rows; removal moves the last row into the gap (deterministic). Projectile height is absolute (same datum as
the terrain). **Flight:** drag with a speed-dependent coefficient Cd(v) = a + b/v (capped), fitted per bullet to
published downrange velocities — a constant coefficient could not match them (real drag rises as a bullet slows
toward the speed of sound); result within 3 % of the published 5.56 mm table at 100–500 m. Air density follows
temperature; drag is relative to the wind (zero for now). **Collisions:** each tick the straight path is tested
against the ground, wall segments (obstacles and building walls, with doors and windows open) and vegetation
(chance per metre of being stopped). A coarse 8 m grid of highest ground, highest vegetation and "wall nearby"
lets most bullets skip the tests. **Penetration:** each bullet has a published steel-penetration figure at a
speed (5.56 mm: 3.5 mm at ~425 m/s; 7N10: 16 mm at ~805 m/s), scaled by speed^1.5; each material has a
resistance in mm of steel per mm, set from published norms (brick, concrete, wood, sand); a wall struck at an
angle is thicker along the path; passing costs energy in proportion and deflects the bullet a little.
**Ricochet:** each material has a largest ricochet angle from forensic studies (concrete ~12°, wood ~11°, sheet
metal ~20°, soil ~8°, water ~7°); the chance falls linearly from grazing to that angle; 55–90 % of speed kept.
**Not yet:** people are not hit (M2.3), roofs are not modelled (M2.4), terrain damage is not created (M2.4).
Known simplifications: bullets do not break up at very close range (the US manual notes reduced penetration
under 25 m), and brick is set between the Russian norm (5.45 mm passes 10–12 cm) and the US finding (brick
veneer stops 5.56 mm). Rejected: constant drag coefficient; G1/G7 standard drag tables (more code, no visible
gain at these ranges); per-bullet objects (allocation, slower).

## 2026-11-11 — Performance with 20,000 live projectiles: 7x here, target 8x
The benchmark battle (304 soldiers) with 20,000 bullets kept in the air runs at about 7x real time on the
development container (6.8–7.4 over runs; 2.3 ms per tick, ~110 ns per bullet). The SPEC target is 8x on a
laptop, which is likely met on a current laptop but is not demonstrated here. The test floor is 3x, because CI
machines are roughly half as fast. Optimisations done: coarse rejection grid, wall tests only near walls, loop
constants and imported functions held in locals. Next options if needed (M2.4, when fragments multiply
projectiles): statistical level of detail for fragments far from anyone (allowed by the SPEC), and splitting the
loop by projectile kind.

## 2026-11-11 — Screenshot-only volley hook
To check projectile drawing before soldiers can shoot (M2.2), the app's debug object has `debugVolley`, used
only by the screenshot tool. It bypasses orders on purpose, is not reachable from the game's controls, and is to
be removed when the fire order exists. Recorded because it is an exception to "orders are the only input".

## 2026-11-11 — Fixes from the independent M2.1 review (goldens regenerated twice for M2.1)
The reviewer found no determinism, tunnelling or rule defects, but showed that the first calibration missed its
own anchors at the ranges the sources state (3.5 mm steel at 570–640 m; the 9.5 mm steel door at 100 m; 16 mm
at 100 m for 7N10) and that several lab rows sat within 2–3 % of flipping. Fixed: penetration anchors are now
set at the speed the bullet really has at the published range (with a small margin), and a **break-up rule**
was added: a soft-core bullet's penetration of masonry, concrete, soil and wood does not rise above its value
at a data-given impact speed (5.56 mm: its 200 m speed, after the US manual's "penetration peaks at 200 m, the
round breaks up at close range"). That reconciles the US findings (brick veneer, 5 cm concrete and sandbags
stop 5.56 mm up close) with the steel figures and with the Russian brick norm for steel-core 5.45 mm. Material
resistances were re-set accordingly (brick 0.12, concrete 0.26, wood 0.016 ...). The lab tests now check every
published figure at its stated range, and require the same result at −3 %, nominal and +3 % muzzle velocity;
the lab table fires rounds with ±2 % velocity spread and prints "marginal" where results are mixed. Also fixed:
the loader now rejects a weapon whose calibre differs from its ammunition, a feed item that is not a magazine,
a magazine whose per-round mass differs from the cartridge, a ball round flagged as tracer, and ammunition IDs
duplicated in items.json; the coarse ground and vegetation grids include neighbouring buckets (steep imported
terrain could otherwise be missed); vegetation impacts report the vegetation kind and a position inside the
vegetation; the renderer and controllers see projectile arrays read-only; tests added for wind drift,
vegetation stopping, ground ricochet and doors. Accepted and recorded: `launchProjectile` is exported for labs,
tests and the screenshot tool (in battles only weapon systems will call it, from M2.2); data files carry
customary units where the sources do (mm of steel, degrees, rounds per minute, milliradians), named with their
unit and converted when the battle tables are built. Golden replays were regenerated for M2.1 (new data files
and state shape) and again for these fixes (data values).

## 2026-11-11 — Owner answers for M2.2 (the shooter)
**Marksmanship:** a regular soldier, prone, rested and calm, firing aimed single shots, hits a man-sized
standing target about 50 % of the time at 300 m, and this depends on training level (conscripts worse,
veterans better). **Rate of fire:** depends on range (aimed single shots every 2–3 s beyond about 100 m, about
one shot a second closer, short bursts inside about 30 m). **Fire order:** lasts until cease fire, but with
**ammunition-management authority**: if the unit no longer expects an enemy it slows and then ceases fire by
itself. Until spotting exists (M3) "expects an enemy" is judged by incoming fire near the unit: 30 s at the
ordered rate, then one aimed shot per man every 10 s for 60 s, then cease fire and report; incoming fire
restores the full rate; each man stops when only the magazine in his weapon is left. **Magazines:** men top up
in lulls already now (swap a partly used magazine for a fuller one after a few seconds without firing).
Loads from the research: five G36 magazines per German rifleman, six AK-74 magazines (180 rounds) per Russian.

## 2026-11-11 — M2.2 the shooter: model choices
**Weapons and magazines:** each armed soldier has a weapon state (the magazine in the weapon is held there, not
in his load, while loaded). Every round fired comes out of that magazine; an empty magazine is exchanged for
his fullest spare by a timed reload action and the empty one is kept as an item; a stoppage (chance per round
from the weapon data) is cleared by another timed action. His carried load now includes the weapon and the
loaded magazine; the aggregate "basic fighting load" placeholder dropped from 24 to 18 kg. **Aiming error:**
one standard deviation in milliradians = base (1.13 at skill 0.5) x skill factor x posture (prone 1, crouching
1.5, standing 2.2) x fatigue x pulse x suppression x sight (magnified 0.85) x rapid fire (1.6) x recoil
growth within a burst, combined with the weapon's own dispersion; plus a per-target error in judging the range
(12 % at skill 0.5) that shifts the point of aim through a drop table. The base value was set so the firing
range lab shows the owner's benchmark; the 3x optic gives the G36 about 60 % at 300 m against 49 % for the
AK-74M with iron sights. Posture, fatigue, pulse and rate factors are game values for the owner to judge from
the lab table. **Fire order:** `fire` (point, optional aim height) and `ceaseFire`; rate-of-fire bands by range
and the ammunition-management clock are data (`core/shooting.json`). "Reason to keep firing" is, until M3,
only incoming enemy rounds striking within 30 m of the unit. **Safety:** a man does not fire when a member of
his own unit is in front of his muzzle within a 4-degree cone. **Not yet:** nobody is hit (M2.3); men do not
check whether the ground blocks their line of fire (prone men on rolling ground may shoot into the ground in
front of them; line of sight arrives in M3); rifle magazines hold ball only, so tracers appear with machine
guns in M2.5. The screenshot-only volley hook was removed; the app's debug object now only issues orders.
Golden replays regenerated (new data, weapons in state, schema v5).

## 2026-11-11 — Fixes from the independent M2.2 review (goldens regenerated)
The reviewer found no rule violations and confirmed ammunition conservation, determinism and that the range
lab measures real geometric hits. Fixed, each with a test: **incoming fire** now also counts enemy rounds fired
past the unit (within 30 m of a member, out to 800 m from the muzzle), not only rounds striking within 30 m —
before, two teams shooting at each other at 180 m both reported "no target" after 90 s; a unit on the slow rate
now answers within half a second instead of at its next slow shot. **Magazine top-up** happens only when the
man has no fire task and his magazine is below 70 % (before, men on the slow rate swapped a 29-round magazine
for a 30 after almost every shot). **Elevation** uses proper angles (aiming at a point far above him put rounds
metres high). A fire order to men without usable weapons is answered "unable"; a dead or unarmed man ends his
task with reason "unable", not "ammunition"; "low on ammunition" is reported once per unit. Shot events carry
the direction of fire. **Honest gaps recorded:** the aiming error does not yet include bracing on cover, time
spent aiming or target movement (they need cover and targets, M3/M4); nothing interrupts a reload yet except
losing the weapon (wounds will, M2.3) — an interrupted reload is tested to lose nothing; a man whose line of
fire is blocked by a comrade only waits (in file formation firing forward only the front man shoots); the range
lab holds fatigue and pulse constant by writing them directly (a lab harness, not gameplay).

## 2026-11-11 — Owner answers for M2.3 (body, armour, wounds)
**Helmets** stop fragments and glancing or very long-range rifle hits; a square rifle hit at normal combat
ranges penetrates. **A rifle round stopped by a plate** knocks the man down for a few seconds and leaves a
minor blunt injury (pain, no bleeding); then he carries on. **A wounded man who can still function carries on,
impaired** (slower, worse aim, cannot run or cannot use his rifle depending on where he is hit) until behaviour
arrives in M4; pain and blood loss can stop him later. Earlier decisions apply: helmet and rifle-rated plates
for both sides, a realistic bleeding clock, a realistic lethality mix.

## 2026-11-11 — M2.3 body, armour and wounds (goldens regenerated, state schema v6)
**Body outline** (`core/wounds.json`): per posture a box of bands — legs, pelvis, abdomen, chest (arms beside
the trunk), neck, head; upright bands by height, prone bands along the body with the head toward his facing.
A projectile's path is tested against each band of every man near it (soldiers are bucketed on the 8 m grid
each tick; a round never strikes the man who fired it); the band it enters first is the zone struck; space
beside the head or neck is a miss. A round that strikes an arm from the side goes on into the trunk 6 times in
10. **The round stays in the body** (no shoot-through to the man behind; recorded as a gap). **Armour** is an
item with, per zone, a covered share from the front and from the side and a protection in millimetres of
steel; whether the spot struck is covered is a random draw against that share (coverage is a share, not plate
geometry). Plates 26 mm (no rifle in the data pierces them), soft armour 1.5 mm, helmet 2.5 mm with a random
glancing factor — in the lab helmets stop almost no rifle rounds out to 300 m, which is the owner's decision.
A prone man struck along his length is treated as not behind his plate. **Stopped by armour:** hit event,
knocked down (prone, 4 s unable to move or fire), a blunt wound of severity 0.12 with pain and no bleeding.
**Through or beside armour:** a wound record — severity drawn per zone and scaled gently with remaining energy
(power 0.3 of energy / 1000 J), bleeding = the zone's worst rate x severity x a vessel factor (most wounds far
below the worst case), breathing/airway flags for chest/neck/head above severity 0.5; a severity above the
zone's fatal threshold kills at once, above its knock-out threshold he is unconscious. **Simple physiology**
on a 0.5 s clock: blood lost at the wounds' rates (bleeds under 0.12 l/min clot by themselves), unconscious at
about 34 % blood loss, dead at 52 %; an untreated breathing or airway wound kills in about 5–8 minutes; pain
fades slowly. Nobody treats anyone yet (M10). **Effects (owner: carries on, impaired):** leg wounds slow him and
above severity 0.45 he can only crawl; arm wounds and pain worsen his aim; an arm wound above 0.5 or pain above
0.6 stops him using his rifle (pain fades, so he may fight again); blood loss slows him. **Casualties** stay
entities where they fell (killed or unconscious), take no orders, are skipped when routes and fire tasks are
given; if the leader falls the next able man leads, and a comrade reports "man down". Battle records come back
with status wounded / incapacitated / killed and the wound list. **Friendly fire** is physical: a round does not
know sides (the existing 4-degree safety check still stops men firing through their own unit).
**Casualty lab** (`npm run lab -- casualty`, test `lab-casualty.test.ts`): see the table in the M2.3 report;
headline — struck from the front at 100 m with plates, about half the men are saved by the plate; of those
wounded about 1 in 7 dies at once and about 4 in 10 within the hour without care; without armour about 3 in 10
die at once. All values are `confidence: "low"` game abstractions for the owner's review.
**Bug found and fixed on the way:** a projectile whose step would end outside the map was deleted before its
collision tests, so nothing within one step (about 13 m) of the map edge could be hit; it now flies to the edge,
may strike on the way, and is then removed. **Placeholder load:** `basic-load` is now 8 kg; helmet and vest are
separate items (total load about the same as before). **Gaps recorded:** no organs or bones, only zones; no
exit wounds or shoot-through; armour never degrades; nobody reacts to being shot at or to casualties (M4); no
first aid (M10); the enemy still fires only when ordered (M4).

## 2026-11-11 — Fixes from the independent M2.3 review (goldens regenerated)
The reviewer found no determinism, save/load or hard-rule violations and confirmed the casualty lab measures
what it claims. Fixed, each with a test: **a unit stayed "firing" forever** when its last firing man fell (now
the fire ends with reason "unable"); **a dead or unconscious man fed into the next battle came back to life**
(the roster record now carries his physiology, and status killed/incapacitated is honoured on the way in);
**left and right were swapped** in wound records; **a wiped-out unit reported "in position"**; **leader
succession** looked only at the unit's own men, not its sub-teams; **a knocked-down man** could still change
posture, reload or top up (now none of these until it has passed; a reload in progress is broken off);
**without a physiology model** pain never faded (now it does; nothing bleeds in that mode). Added: `canUseArms`
and `canSpeak` (a man with a wounded airway does not report; someone else does), an armour item for the
fixture faction, data checks on the body outline, the body search margin now derived from the outline.
**Recorded, not changed:** the "coming round" path cannot happen in this model (nothing restores consciousness
before M10); the 20,000-projectile benchmark now wounds its own marching soldiers, so it measures a force under
fire rather than a clean march (still above the floor).

## 2026-11-11 — Owner review of the M2.3 casualty lab, and answers for M2.4
**Casualty lab reviewed:** lethality "about right, keep it"; share of wounded who keep fighting "fine for now"
(M4 adds fear and men choosing to stop). **M2.4:** Russian default hand grenade **RGD-5** (German DM51 with
fragmentation sleeve); a regular soldier in full kit throws **about 30 m standing** (about 20 m crouching,
10-12 m prone; training scales it), landing within a few metres of the aim point; **a close burst that does
not wound** injures by blast within a few metres and **stuns for a few seconds out to about 10 m**.

## 2026-11-11 — M2.4 grenades, fragments, blast, roofs, terrain damage (goldens regenerated)
**Munitions as data:** a grenade is an ammunition entry with an `explosive` block (filling, fragment count,
the ammunition entry describing one fragment, fragment speed range, time fuse seconds or arming time) and a
`delivery` (thrown, or launched from a launcher item at a muzzle velocity). It is a counted item like every
round. In the data: DM51 with sleeve and RGD-5 (thrown, time fuse), a 40 mm x 46 HE round with the AG36 and the
VOG-25 with the GP-25 (launched, impact fuse with arming distance). **Sources:** the research session's search
tool declined three of the four look-ups (its own content rules), so DM51, RGD-5, VOG-25 and both launchers
are entered from general published figures as remembered, `confidence: "low"`, no source URL, to be verified;
the 40 mm round has sources (medium). Fragment sizes, counts for the 40 mm rounds and all fragment penetration
values are game values. **Order and action:** new order `grenade` at a point: one man acts — the nearest who
can throw that far (owner: about 30 m standing, 20 m crouching, 11 m prone, scaled by training), else the
nearest with a launcher and a round (beyond arming distance, within 350 m); nobody throws nearer than 12 m.
Preparing takes 2.5 s (throw) or 4 s (launcher) as an interruptible action; the item leaves the load when it is
released. Landing error: 0.6 m + 7 % of the distance (launcher 1 m + 5 %), scaled by training. **Flight:** the
normal projectile engine. A time-fuse grenade stops where it lands (no bounce or roll), drops at the foot of
a wall it strikes, passes through windows and doors, and bursts when the fuse runs out (also in the air). An
impact-fuse round bursts on ground, wall or roof if armed, else is a dud. Grenades do not wound by striking.
**Burst:** (1) blast by distance, radii = coefficient x cube root of the filling — for 60 g: blast wound within
2.3 m (fatal within about 1.2 m), stunned 1-4 s out to 9.8 m (owner decision); a wall between burst and man
shields him completely (walls of 5 mm steel-equivalent or more; see the review fixes). (2) Fragments are real
projectiles; from a burst on the ground only those leaving between 3 degrees below and 40 degrees above the
horizon are simulated (about 35 % of the count; the rest go into the ground or the sky). A
fragment below 3 J does not wound and is removed; severity grows with the square root of its energy relative
to 90 J (retuned after the review fix to fragment energy); armour is tested as for bullets (helmets and soft armour stop most small fragments — owner decision).
Fragments can hit the thrower. They cause no impact events (thousands per burst). (3) A crater (record only,
too small to matter for movement), and a breach in any wall within reach whose steel-equivalent thickness is
below 15 mm x cube root of the filling: a hand grenade holes a wooden fence, not a brick wall. Breaches are
state: bullets, blast and routes pass through them, also after a save (routes only through holes in walls, fences
and hedges: buildings stay solid for movement until interiors exist). **Many wounds:** every further wound
adds half its severity to the pain; at pain 0.95 a man collapses until it eases (new; also applies to several
bullet wounds). **Knock-down now takes 0.3 s** (a man does not drop before the fragments of the same burst
arrive). **Roofs:** every building has a flat roof at wall height with a material and thickness per building
kind; it stops or is pierced like a wall (no ricochet); grenades rest or burst on it. No floors between storeys.
**Air drag** is now integrated exactly for speed (v / (1 + a)), because light fragments lose most of their
speed within one tick; bullets change by less than a thousandth (range and cover lab bands unchanged).
**Fragmentation lab** (`npm run lab -- fragmentation`; figures after the review fixes below): DM51 standing men
wounded 100 % at 5 m, 94 % at 10 m, 48 % at 20 m, 5 % at 30 m; down at once 66 % at 5 m; lying down cuts wounds
per man about five-fold; RGD-5,
40 mm and VOG-25 wound about a third to a half at 5 m; behind a brick wall nobody is touched.
**Performance:** bullets: 20,000 live + 304 soldiers 5-6x real time here (floor 3x; was about 7x before bodies
and roofs were tested). Fragments: a volley of nine sleeve grenades in one tick (20,000 fragments at once)
every second runs at 26x real time, longest single tick about 30 ms. Keeping 20,000 fragments in the air ALL
the time needs about 450 bursts a second and ran at about 2x real time — measured once, not a test, far
beyond any battle in scope. **Gaps recorded:** no bounce or roll; no cooking off or throwing back; ground is
perfectly smooth, so prone men are not shielded by small folds; men do not take cover from a grenade (M4);
the launcher is an item, not a weapon with its own state; one grenade per order; the AI never uses grenades.

## 2026-11-11 — Fixes from the independent M2.4 review (goldens regenerated)
The reviewer found no determinism, save/load or hard-rule violations (75 mid-battle saves reloaded
identically). Fixed, each with a test: **an impact round bursting on a roof lost all its fragments** (the burst
now sits just off the surface it struck); **fragment energy** was taken at the end of the tick, so a steel ball
striking at 1.5 m arrived with a quarter of its true energy — speed is now taken where the projectile strikes
(bodies, walls, roofs, ground), a fragment is "spent" by its speed at the start of the tick, and fragment
wounding was retuned (reference 90 J); **a grenade thrown indoors stuck under the ceiling** (it now falls to the
floor); **a burst above the ground** (fuse ran out in flight, round striking a wall or ceiling) threw no
fragments downward (it now does); **steep fire could skip the roof of a small house** when one tick's flight
started and ended outside it (all roofs along the path are tested); **a plank fence, wire mesh or hedge
shielded completely from blast** (only walls of 5 mm steel-equivalent or more shield now); **a man ordered to
move or change posture while preparing** threw anyway, from the new posture at the old range (the action is
now broken off and he keeps the grenade; a throw is never longer than he can reach when he lets go); **a
grenade aimed at the map edge could vanish** (it comes down at the edge); a 1 m breach no longer opens a wall
to wheeled or tracked movement or clears a cell another wall runs through.
**Performance, stated plainly:** the reviewer is right that the old test would have passed even with very
slow fragment ticks. The test now also asserts the ticks that actually carry the fragments. Measured here:
nine sleeve grenades in one tick (20,000 fragments) every second = 28x real time on average; the three ticks
after each volley take about 4.5 ms each (3.7x real time here, 2.9x in the reviewer's run), the longest single
tick 27-38 ms (a visible stutter of two frames). So **the 3x floor is met on average and is at the limit, not
safely met, during the fraction of a second in which 20,000 fragments are in the air**; asserted in the test:
those ticks keep up with real time and no tick exceeds 120 ms. Bullets: 20,000 live, 4.3-5.8x (floor 3x).
**Still open (recorded):** the lob angle is fixed at 40 degrees, so throws indoors usually hit the ceiling and
drop short; roofs do not shield from blast; blast is applied before the same burst's breach; the fixture
faction exercises the thrown path only; at 2 m the lab's "fragment wounds per man" is understated for men
already killed by blast.

## 2026-11-11 — Bullet speed test failed once on GitHub (2.6x), fixed without lowering the floor
One of the two CI runs of the M2.4 pull request measured the 20,000-bullet benchmark at 2.6x real time (floor
3x): bodies, roofs and exact drag had reduced the margin from about 7x to about 4.5x here, and the build machine
runs the other test files at the same time. Done: the roof flag is only looked up next to walls, and bullets
use a series for the drag factor instead of two divisions (identical to 1e-7; goldens regenerated) — 5.5x here
now; and the benchmark takes the fastest of three 100-tick windows, because other work on the same cores can
only slow a window down. The floor stays 3x.

## 2026-11-11 — Owner review of the M2.4 fragmentation lab; squad choices for M2.5
**Fragmentation lab reviewed:** "about right, keep it". **M2.5 squads:** the research defaults, to be corrected
by the owner afterwards — German Puma dismounts (6): Truppfuehrer (G36), MG gunner (MG5), Panzerfaust gunner
(Pzf 3 + G36), marksman (G28), two riflemen (G36, one with AG36); Russian BMP dismounts (6): squad leader
(AK-74M), machine gunner (PKP), grenadier (RPG-7 + AK), assistant grenadier (AK), senior rifleman (AK + GP-25),
rifleman (AK + GP-25). **Before M2.5 the owner wants M2.4 weak points fixed first.**

## 2026-11-11 — Owner: M2.4 weak points to fix before M2.5 (slice "M2.4b")
All four offered: grenades **bounce and roll**; the thrower **chooses a flat or high throw** to clear a
ceiling, pass an opening or drop over a wall; **rough ground shelters prone men** from low fragments;
**several grenades per order**, thrown a moment apart. And a first reaction ahead of M4: a man who has a
grenade land near him **drops flat, or runs from it if it is very close**.

## 2026-11-11 — M2.4b: bounce, chosen arcs, rough ground, several grenades, reaction (state schema v7, goldens regenerated)
**Bounce and roll:** a time-fuse grenade striking ground, wall, roof or ceiling keeps 35 % of its speed off the
surface and 60 % along it, both x 0.6 on soft ground (surface material lighter than 1,800 kg/m3) and x 0.6 again
in vegetation; below 1.2 m/s it lies still. Rolling is the series of ever lower bounces; a grenade at rest does
not start rolling down a slope. The thrower aims short by 0.25 s of the landing speed, so throws land on the
point on average (measured: 0.1 m mean overshoot at 25 m). **Chosen arc:** the thrower can throw 15 % harder
than a full-range lob needs and tries 40, 25, 12 and 60 degrees in that order, taking the first whose path is
clear of walls and roofs until a metre short of the point (doors, windows and breaches count as clear); if none
is clear he lobs anyway. A launcher uses the flat arc, or the high one if the flat one is blocked. Indoors
this gives a flat throw under the ceiling (8+ of 10 throws now land within 5 m of a point 14 m down a room;
before, all struck the ceiling). His landing error can still miss a window. **Rough ground:** the heightfield
is smooth, so fragments (only fragments, not bullets — bullets wait for line of fire in M3) flying lower than
25 cm are stopped with 15 % per metre at ground level, falling to zero at 25 cm. Fragmentation lab now: DM51,
prone men wounded 78 % at 5 m, 18 % at 10 m, 2 % at 20 m (before 88 / 30 / 9 %); standing 100 / 91 / 28 %.
**Several grenades:** the order has `count` (default 1); the best-placed men act, throwers first, each 0.6 s
after the one before; the app's tap button has "1 grenade" and "all grenades". **Reaction (owner: drop flat,
or run if very close):** when a grenade with a running fuse lands, every able man within 10 m who is not
behind a solid wall reacts after 0.4 s — within 3 m he runs straight away from it at the fastest pace and
dives about 1.4 s before the burst, otherwise he drops flat at once; he does nothing else until a third of a
second after the burst, then carries on with his task. Both sides, including the thrower's. Everyone notices
the grenade (who sees what is M3). This is the first self-initiated behaviour; M4 will absorb it.
**Not done / still open:** grenades are not thrown back or kicked away; a runner does not look for cover, he
just runs away in a straight line and stops at an obstacle; the performance of big volleys is unchanged per
burst (staggering only spreads them).

## 2026-11-11 — Fixes from the independent M2.4b review (goldens regenerated)
No rule, save/load or determinism problems (4,000 bounced grenades: none through a wall, none gaining speed,
none resting in mid-air; 33 mid-action saves replayed identically). Fixed, each with a test:
**a launcher round fired on the high arc vanished** (the flight outlasted the 12 s limit, or no high shot
could reach so near a point): the longest flight is now 18 s, an impact-fuse round still flying then destroys
itself instead of disappearing, and an arc is only accepted if it really comes down at the point.
**"Over the wall" mostly fell short** of a wall just in front of the point: an arc now counts only if it comes
down unobstructed near the point with no wall between; the thrower first tries aiming a little short (for the
roll), then straight at the point (14+ of 20 throws now land beyond a wall 1.5 m in front of the point, before
about 3). **No blind throws:** if no arc is good (closed room, lintel in the way) the man does not throw, keeps
the grenade and reports "no clear throw" — before, he lobbed into his own ceiling and was wounded 29 times in
30. **A second grenade was ignored** by a man already reacting to the first: a nearer threat now takes over
(also the same grenade rolling toward him), and he stays down until the later burst is over. **Men behind a
brick wall ran when a grenade struck that wall** (the contact was reported on the wall line): it is reported
just off the wall on the thrower's side. **After running, a man walked straight back to his old route**,
through a house if one was in the way: he now finds a way back and leaves his formation slot. A man who is
evading is not picked for a new grenade order, and whatever he is doing with his hands is broken off. **The
thrower drops flat after throwing** (his own fragments reach further than he throws; added because the
review saw throwers wounded at every short distance).
**Recorded, not changed:** a posture order given while a man is diving is lost; ground clutter also applies
on roads and floors; the arc solver ignores wind (a 10 m/s head wind costs about 1.5 m); on slopes steeper
than 60 degrees a grenade keeps skipping until it bursts; a regular lying prone cannot throw at all (11 m
range against the 12 m safety distance) — the owner may want to change one of the two numbers.

## 2026-11-11 — Owner: prone throw and safety distance; start M2.5
A regular lying prone throws **15 m** (was 11) and the safety distance is **8 m** (was 12), so prone men can
throw. M2.5 starts with the research-default squads chosen earlier.

## 2026-11-11 — M2.5 squads and kit data (goldens regenerated)
**Squads (owner: research defaults, he corrects them afterwards):** unit templates `pzgren-schuetzentrupp`
(Truppfuehrer G36, MG-Schuetze MG5, Panzerfaustschuetze G36 + Panzerfaust 3, marksman G28, grenadier G36 + AG36,
Panzergrenadier G36) and `motor-rifle-squad` (squad leader AK-74M, machine gunner PKP, grenadier AK-74M + RPG-7,
assistant grenadier, senior rifleman AK-74M + GP-25, rifleman AK-74M + GP-25). Ranks per position are guesses.
A faction's manifest names its `demoTemplate`; the demo scenario and the app start with these squads. The old
four-man `demo-team` stays for the speed benchmark (304 soldiers, comparable with earlier figures) and tests.
**Weapons:** MG5 (11.6 kg, 720 rounds/min, 815 m/s; published), PKP (650 rounds/min, belts of 100; mass and
velocity from memory), G28 (20-round magazine, 3-20x scope, 1.5 MOA; mass and velocity from memory); 7.62 x 51
and 7.62 x 54 R ball and tracer with drag fitted to typical published velocities (low confidence).
**New in the engine, all data-driven:** a weapon may have `sustained { burstRounds, intervalS, recoilFactor }`
— it then fires that burst at every range, without the rapid-fire penalty and with only a share of a rifle's
climb within a burst (bipod); a belt item may name a `tracerItem` every `tracerEvery` rounds; sight kind
`telescopic` (aim factor 0.7 against 0.85 for the 3x and 4x sights). **Itemised loads** replace the placeholder
in the squads: water, rations, first-aid kit, webbing and pack, night-vision goggle (typical masses, not
sourced), radio for the leader, helmet, vest, weapon, ammunition, grenades. Loads come out at 24-44 kg (the
Panzerfaust man is heaviest). Machine-gun ammunition follows the cited norms (480 rounds German from the
"500" quote, 600 Russian), partly carried by other men; rifle rounds 150 per German rifleman (five magazines
quoted) and 180 per Russian. **Firing range lab** (regular, prone): MG5 per round 33 % at 300 m, 13 % at 500 m;
PKP 26 % and 9 %; G28 71 % and 41 % (G36: 60 % and 35 %).
**Not modelled yet:** Panzerfaust 3 and RPG-7 are carried weight only (anti-tank weapons fire from M7, with
vehicles); belts carried by other men cannot be handed to the gunner (ammunition sharing, M4); the marksman is
an ordinary regular with a better rifle (no selection for skill); barrel changes and overheating; the
assistant does not help the gunner; G95A1 and AK-12 were not added (the owner chose G36 and AK-74M as defaults).

## 2026-11-11 — Fixes from the independent M2.5 review (goldens regenerated)
No rule, determinism or save/load problems. Fixed: **7.62 mm penetrated less than 5.56/5.45 mm at every
range** (a 41 cm log wall stopped the MG5 where the G36 went through): both 7.62 mm ball rounds are re-anchored
somewhat above the small calibres (steel-core LPS highest), as game values without a measured anchor, and the
cover lab test now asserts the ordering. **Machine gunners stopped with a full last belt** (the "keep the last
magazine" rule, made for rifles): a belt-fed gun reports low ammunition when the last belt goes in and then
fires it; belts are not swapped in lulls. **The scripted shoot-out the roadmap promised was missing**: scenario
`shootout` (the two squads 250 m apart on farmland; prone, fire, one grenade each, cease fire at 150 s) with a
test and a golden replay — in 180 s about 1,030 rounds (MG5 240, PKP 235, G28 60), two grenades, a handful of
hits on prone men. Loader now rejects a belt whose tracer the weapon has no muzzle velocity for (and the
engine falls back to ball instead of silently not firing), and an unknown `demoTemplate`. The sim's
faction-neutral test catalog has a belt-fed gun with a telescopic sight, so sustained fire, belt tracers and
the last-belt rule are tested without real factions. Prone throw (15 m) and the 8 m safety distance are pinned
by a test. Corrections to earlier text: the Russian RPG gunner carries 4 magazines (120 rounds), the others
180; the bullet benchmark is at about 5.5x, not 7x.
**For the owner to know:** with the 8 m safety distance, a prone squad throwing 8-14 m on open ground has
about one of its own men wounded per throw (the reviewer's probe: 7-18 own wounded in 12 throws) — it follows
from the numbers chosen and the fragmentation table, and argues for throwing from behind cover.
**Recorded:** a belt is a container of ball rounds in which every fifth is fired as a tracer (totals are
conserved; tracers are not separate counted items); inside 30 m the machine gun's fixed burst interval gives
it a lower rate than a rifle's close-range bursts.

## 2026-11-11 — M2 completion ("all remaining M2 points", owner request; state schema v8, goldens regenerated)
What M2 still owed, by the roadmap's own text and the gaps recorded on the way:
**Aiming error (M2.2 listed more terms than were built).** *Time spent aiming:* the first shots at a new point
are hurried — the error starts 60 % larger and the excess fades with a 2 s time constant; a renewed order at
the same point (within 3 m) does not restart it. *Bracing:* a man kneeling or standing within cover's reach (a
wall, hedge, tree: the navigation grid's exposure 0.25 or less) rests his weapon and has 20 % less error; prone
men and bipod guns are steady already. *Range estimation* was already in. ***Target movement is still not in
the error***: fire is at a point until there are targets to track (M3 contacts, M4 engagement) — it is the one
term of the list that cannot be built honestly yet.
**Bullets go through bodies.** A bullet not stopped by armour leaves the body outline where its path does and
flies on with 70 % of its speed after a limb, 30 % after the trunk or head (x the square root of what the
armour left it); it can wound the man behind. A round stopped by a plate, and every fragment, stays. A path
that ends inside the outline within the tick (along a prone man) also stays.
**Rifles:** G95A1 (16.5 in barrel published; mass, rate and velocity from memory of HK416 figures) and AK-12
(3.5 kg, 415 mm, 650 rounds/min published; AK-74 magazines) exist as data, low confidence, not issued in the
default squads (owner: G36 and AK-74M are the defaults). At 300 m they shoot within a few points of the defaults.
**Fragmentation lab, cover rows** (the roadmap says "by posture and cover"): at 5 m from a DM51 a chest-high
brick wall protects a kneeling man completely and a standing man mostly (43 % wounded, 0.5 wounds per man
against 9); a wooden fence or a hedge hardly helps (99-100 % wounded).
**Still open at the end of M2, by design or by dependency:** target movement in the aiming error (M3/M4);
anti-tank launchers are carried only (M7); belts cannot be handed over (M4); grenades are not thrown back; no
first aid (M10); the enemy acts only on orders (M4); SPEC's 8x speed with 20,000 projectiles is not reached
(5.5x; floor 3x); DM51, RGD-5, VOG-25, PKP, G28, G95A1 figures partly unverified.

## 2026-11-11 — Fixes from the independent review of the M2 completion
No determinism, save/load or rule problems. Fixed, each with a test: **a round leaving a body skipped a wall,
roof or ground right behind the man** (a man with his back to a steel wall let rounds through it): the round
now flies on only if nothing lies between where it struck and where it comes out. **One bullet could wound the
same running man two or three times** (it restarted 5 cm beyond him, and he ran 6 cm per tick): the restart
point now allows for his speed. **Bracing was broader than stated** (up to 5 m from any obstacle, also a
see-through wire fence, also anywhere in woodland): it now needs a wall, fence, hedge, house wall or trees
within arm's reach (his 2 m cell or the next); the direction of fire and the height of the thing are still not
looked at. **The casualty lab had shifted** (the targets were struck by the first, hurried shots, so fewer
chest hits): the lab now lets its riflemen take their time, and the table the owner reviewed is back (plates
save 50 %, 13 % killed outright, 44 % dead within the hour without care; 28 % killed outright without armour).
Stale lines in STATE, HOW_IT_WORKS and a code header corrected.
**Recorded:** after a wall is breached, the next shot rebuilds the navigation grid inside the fire step (about
60-90 ms once on a 2 x 2 km map, a visible stutter; it was already paid by the next route); rear plates are not
checked for a round that entered beside the front plate; the aiming-time clock runs from the order, so a man
who first spends seconds changing posture fires his first shot nearly settled; the range lab has no
first-shot or braced rows (the terms are tested directly).

## 2026-11-11 — Timing tests run on their own
The bullet benchmark failed once more on GitHub (2.9x against the 3x floor) while the other run of the same
commit passed: the timing test shared the build machine's cores with the other test files. `npm test` now
leaves out `perf*.test.ts`; `npm run test:perf` runs both timing files one after the other, alone, as its own
step in `npm run check` and in CI. The floor stays 3x.

## 2026-11-11 — M3 plan and owner answers
**Slices:** M3.1 line of sight and line of fire (3D over the heightfield, walls with openings, roofs,
vegetation thinning the view; men do not fire into a bank in front of them; lab and debug view); M3.2
detection (per observer and target on a schedule; range, posture, movement, firing, concealment, light, optic,
look direction, stress; spotting lab); M3.3 contacts and sharing (per-man contacts with confidence and age,
sound contacts, shouting and radio through the comms model, call-outs, fire at a contact); M3.4 fog of war
(the player sees only reported contacts, fading; debug shows all). **Owner answers:** a regular looking the
right way spots a man **standing still in the open at 300 m in about 5-15 s**; a man **lying still in long
grass or crops at 100 m is very hard to spot until he moves or fires**; a rifle shot gives everyone in earshot
**the direction at once, his position only if he is seen** (flash, dust); the player sees **what his men have
reported**, with the delay that takes, and old contacts fade.

## 2026-11-11 — M3.1 line of sight and line of fire (state schema v9, goldens regenerated)
**Line of sight** (`sim/src/los.ts`, `sight(ctx, from, to)`): a pure query, heights absolute. The ground
blocks (sampled every half cell; whole 8 m buckets whose ground and vegetation lie a metre or more below the
line are skipped); a wall blocks unless the line passes a door, window or breach; an obstacle kind's
`seeThrough` (wire fence 0.95, wooden fence 0.5, hedge 0.1) lets a share through; a roof blocks a line that
crosses its plane over the footprint; vegetation the line passes through below its top thins the view by
exp(-concealment per metre x metres). The result is a visibility 0..1, what blocked it and where. The last
0.3 m at each end are not tested against the ground (eyes and targets close to it). Detection (M3.2) will
turn visibility into a chance. **Line-of-sight lab** (`npm run lab -- sight`): open ground clear at every
range; a man lying in crops at 100 m 0.14 % visible, kneeling 3 %, standing 100 %; both prone in tall grass
0.03 %; woodland 52 % after 10 m, 0.2 % after 100 m; a hedge 10 %, a wire fence 95 %; a 1.1 m wall hides a
kneeling man; dead ground beyond a 4 m crest; a house blocks unless windows line up. Speed: about 4 microseconds
per random line of up to 400 m on a village map. **Line of fire:** once a second, before a shot or a burst,
a man checks the line from his muzzle to the point he is told to fire at; if the ground, a wall or a roof
blocks it short of the last 5 m before the point he rises to a kneel or to his feet if that clears it, otherwise he
holds his fire and the unit reports "no line of fire" once per fire order (closes the M2 gap of prone men
firing into a bank). **Consequence found at once:** in the scripted shoot-out on generated farmland the two
squads 250 m apart were in each other's dead ground and both sides correctly held their fire; the demonstration
scenario now uses an open flat field ("firing-range style", as the roadmap says). **Debug view:** with Debug
on, the ground the selected unit's leader cannot see a kneeling man on (within 400 m) is darkened, partly
seen ground tinted; refreshed every 2 s of game time. **Not yet:** smoke (M8); light and night (M9); the
line of fire does not consider friends beyond the 4-degree safety cone or the target's own cover; men do not
move sideways to get a line of fire.

## 2026-11-11 — Fixes from the independent M3.1 review (state schema v9 kept: new fields added before any release)
No rule, determinism or save/load problems; sight() is symmetric in every case tried. Fixed, each with a test:
**a prone order while a man was rising to fire over a bank made him fire into it** (the line-of-fire result was
cached without the posture it was worked out for; it is now redone whenever his posture differs); **men who
rose never went back down**: he now tries the posture he was in when the fire order came (or a later posture
order) first, so with a new point that does not need it he lies down again — a posture order while firing
sets that base posture, and he still rises over a bank if that is the only way to fire; **the 85 % rule let
long-range fire go into a crest or a house up to 60 m short of the point**: only the last 5 m before the point
count as "what he fires at"; **a crest one height point wide could slip between samples**: the ground is now
sampled at every crossing of the height grid and half-way between, and vegetation is charged by the exact
length below its top; a line through a roof's corner no longer breaks the roof test; **the machine gun kept
its bipod steadiness when the gunner knelt**: bipod only when lying or with something to rest it on.
Debug view: refreshed also when the selection changes (and while paused), at most once a second of real
time; a dead leader's view is not shown. The Stop hook runs the timing tests on their own, like CI.
Wording corrected: in the farmland shoot-out both sides held their fire, not one.
**Recorded:** walls are lines without thickness for sight (a line exactly along a wall is clear); a line
exactly along a house face touches the ends of its side walls; sight() allocates a little per call (Sets,
arrays) — to watch when detection makes many checks per second.

## 2026-11-11 — M3.2 detection (state schema v10, goldens regenerated)
**Model** (`sim/src/systems/spotting.ts`, numbers in the new `core/spotting.json`): every able soldier scans
once a second (staggered); for each enemy within 1,200 m the chance to see him in this scan is
1 - exp(-rate x 1 s), rate = 0.07/s x (300 m / range)^2 x exposed size (standing 1, kneeling 0.55, prone 0.2) x
movement (x4 moving, x6 running) or firing within 2 s (x15) x visibility along the line of sight (M3.1) x where
he looks (within 60 degrees of his facing x1, to 110 degrees x0.3, behind x0.05) x optic beyond 150 m (x1.4) x
skill (observation, else marksmanship) x stress x light. Ground, walls and roofs hide a man completely;
vegetation thins the view, but a man moving through it shows at least 15 % of himself (plants move) and a man
firing at least 50 % (flash, dust). One random draw per observer, target and scan, always, from the
"spotting" stream; the sight check is skipped when the draw could not succeed even with a perfect view. A man
already seen is kept with 20 times the rate, forgotten after 6 s unseen, and a man tracks at most 6 enemies at
once (the nearest). Result: `SoldierState.seen` (plain data) and a `spotted` event per new sighting. Debug
shows a thin line from each man to every enemy he has in sight.
**Spotting lab** (`npm run lab -- spotting`, 40 runs per row, regular observer standing): standing still in the
open at 100 / 300 / 600 m: median 2 / 9 / 35 s (owner: 5-15 s at 300 m); walking across at 300 m 3 s; kneeling
13 s; prone 7 s at 100 m, 36 s at 300 m; observer looking away: 53 % within 2 minutes; **lying still in crops at
100 m: never in 40 runs (owner: very hard)**; crawling there 9 s; firing from there 1 s; prone in tall grass
78 s. **Speed:** 304 men in plain view of each other 300 m apart: about 25x real time (21x with everyone firing,
after the review fix; timing test, floor 8x). The ordinary benchmark (304 men on the move, sides out of view) is about 18x — route-finding dominates; the
"~200x" in STATE was stale since M1.4.
**Not yet:** the observer's facing is fixed (he does not scan around: M4); stress is in the formula but not yet
raised by anything; night, smoke, rain and fog (M8/M9) only through `light` and `visibilityM`, which stay at
daylight (fog is read since the review fix); sound contacts and sharing are M3.3.

## 2026-11-11 — Fixes from the independent M3.2 review (goldens regenerated)
No determinism, save/load or rule problems (one draw per pair confirmed). Fixed, each with a test:
**a man moving or firing was "seen" through any depth of vegetation** (the floor of 15 % / 50 % replaced the
visibility of the whole line, so a man firing behind 200 m of woodland was spotted in a second): the floor now
applies only to what shows above him — the line to the top of the vegetation he is in must be clear, and its
own visibility scales the floor; a wood between hides him. **304 men firing in view ran at 5x real time**
(firing pushed most draws past the quick upper bound): a man who already tracks his maximum of enemies does
not look at one farther than all of them (it could not be taken on anyway) — the timing test now has everyone
firing: about 21x. **Sensors were not data** (SPEC 6.5): `core/spotting.json` now has `sensors` by kind —
eye, iron, reflex, magnified (x1.4 beyond 150 m), telescopic (x1.7), night (light counts as at least 0.5),
thermal (x1.5, sees as by day); every man has his eyes, his weapon's sight adds its kind, an item with a
`sensor` adds that (the night-vision goggles in both factions' kit, `"sensor": "night"`); the best applies.
**Fog:** nothing is seen beyond the environment's `visibilityM` (DECISIONS had claimed it was read; now it
is). **Men lost track of a man lying still in plain view at 300 m and "spotted" him again and again**: the keep
rate is now 200 times the detection rate. **A man running from a grenade counted as standing still**: his
speed is recorded while he runs. Lab: the iron-sights row no longer shares random draws with the optic row
(and a 200-run test shows the optic helps); "never in crops" is stated as what it is — his visibility there
(0.12 %) is below the 0.2 % floor at which anything can be seen; the looking-away row is checked by its share
within 30 s, not by a capped median.
**Recorded:** a grenade throw does not count as firing for being spotted; the "spotted" event is per new
sighting, so a man passing from one observer's six tracked enemies to another's can appear several times.

## 2026-11-11 — M3.3 contacts and sharing (state schema v11, goldens regenerated)
**Contacts** (`sim/src/systems/contacts.ts`, numbers in `core/spotting.json` `contacts`): every soldier keeps a
list of what he knows of each enemy — position, uncertainty, kind (seen / heard / reported) and when it was
true. **Seen:** each scan that confirms an enemy gives his position (1 m + 1 % of range). **Heard** (owner:
direction at once, position only if seen): an enemy shot within 1,500 m gives every able listener the
direction with an 8-degree error and a distance guess with 35 % error (uncertainty 35 % of the range), at most
once every 2 s per shooter, not if he sees the shooter already. **Age:** the uncertainty grows 1 m per second;
a contact is forgotten after 2 minutes, and at once if he saw that man die. **Sharing** through the CommsModel
(`contactShareDelayTicks`, now implemented): a man passes on to the other men of his top-level unit what he
sees (again every 10 s while he sees him) or newly hears — within the voice range (40 m) after the 1 s it takes
to say it, otherwise by radio after 1 s + the radio delay (5 s), if both are on the net; reported positions are
5 m less certain; reports are not passed on again, and nobody is told what he already knows. **Call-outs:** a
unit calls a new contact out on the radio log ("enemy, 300 m, bearing 90" / "shots from bearing 85"), at most
every 8 s. **Fire at a contact:** a fire order may name an enemy; each man fires where he believes him to be
(his contact, else a comrade's, else the point given) and follows his contact as it changes (target movement in
the aiming error is still to come). **Speed:** 304 men firing at each other in view about 14x real time (floor
8x); the first version sent 13,000 redundant reports — men telling comrades what they had heard themselves.
**Not yet:** contacts are not shared between top-level units (a platoon's squads are one top unit; separate
squads are not linked until a commander layer exists, M6); sound contacts do not distinguish weapons; the
player's view is still everything (M3.4).

## 2026-11-11 — Fixes from the independent M3.3 review
No determinism, save/load or rule problems; nothing grows without bound over 20 minutes. Fixed, each with a
test: **a man who had heard a shooter never learnt his exact position from the comrade beside him who saw him**
(a fresher guess from the sound always won over an older but exact report, and the repeat reports were
suppressed because the listener "already knew"): a contact is now replaced only by what is more certain now
(its uncertainty plus how far the man may have moved since), a sighting always wins, a sound adds nothing to
a man who already knows the shooter better than a sound could tell, and a comrade is told unless he already
knows at least as well. **A man who cannot speak** (airway wound) no longer passes contacts on or calls them
out. **Fire at a contact** uses only each man's own contact, else the point given (no reading of a comrade's
knowledge outside the comms model), and a dead enemy is rejected. Tests now check what they claim (voice in
about a second, bearing error, rough distance, forgetting after fog comes down, the reviewer's case).
**Recorded:** a heard contact keeps a position guess (the direction, and a distance guessed with 35 % error) —
the owner's answer was "direction at once, position only if seen"; the guess is shown and used as uncertain
(M3.4 will draw it as a direction), and a fire order at a heard-only contact is fire in that direction;
a fire order may still name an enemy the side has never detected (to close with M3.4's player view); a man
drops a seen contact when the target dies even if he did not see it; reports already on their way arrive even
if the radio was lost meanwhile (cannot happen with the simple comms model; M14).

## 2026-11-11 — M3.4 fog of war (M3 complete)
**The player sees what his men know** (owner: what they have reported, with the delay that takes; old contacts
fade): `sideKnowledge(ctx, state, side)` (`sim/src/knowledge.ts`) is the union of the side's living men's
contacts — for each enemy the most certain one now. The app computes it every frame and the renderer, unless
Debug is on, draws no enemy soldier, enemy muzzle flash, hit on an enemy or enemy unit symbol; instead each
known enemy is a diamond — solid where a man is in sight now, hollow where he was last seen or reported, with a
circle for how far off that may be — and a heard contact a dashed ring with a cross at the guessed place.
Contacts fade out over two minutes. Debug shows the enemy as he is. A fire tap on or near an enemy marker
fires at that contact (each man aims where he believes the enemy is). Tracers and impact puffs stay visible
(they are seen in reality). **Acceptance (M3):** the spotting lab passes; the player view shows only reported
contacts — tested on `sideKnowledge`, checked by eye on screenshots (the renderer itself has no unit test).
**Recorded:** the player's picture is the union over all his men (a man's own contacts count at once, without
the delay of reporting them to the leader) — the owner chose "what your men have reported" over "only what
reached the leader"; enemy casualties are shown only as contacts; the heard ring is centred on the guessed
point, not drawn as a bearing line.

## 2026-11-11 — Owner: remind him of the "only what reached the leader" fog-of-war option after M6
Recorded in ROADMAP (M6 review) and STATE (reminders). It is a rendering choice on top of the same contact
model: the leader's contacts instead of the union of the side's.

## 2026-11-11 — Fixes from the independent M3.4 review (M3 complete)
No rule violations. Fixed: **enemy bullets were drawn as faint streaks from the muzzle** (pointing at hidden
shooters) and **enemy grenades in flight were drawn** — under fog only burning enemy tracers are drawn; **a
fire tap on a marker could be rejected** (dead enemy, or a heard guess off the map), which revealed what the
men did not know — the simulation now ignores such a contact and fires at the point, and heard guesses stay
on the map; **the marker's pick radius was the contact's uncertainty** (up to 200 m), swallowing ordinary
fire taps — now only a tap on the marker itself (20 px); **hidden enemies could stand in the way of selecting
your own men**; **the side's picture was recomputed every frame** (2 ms with 304 men) — once per tick now;
only conscious men's knowledge counts; fog filtering no longer depends on the first frame. The screenshot tool
has a fog-of-war picture, and its casualty picture uses Debug (the symbols it checks).
**Recorded:** one colour for all enemy contacts (fine with two sides); rarely a hollow marker for a man also in
sight from farther away (the more certain, older sighting wins); the renderer path itself has no unit test —
evidence is the screenshot pair "3-casualties" (Debug) / "3b-fog-of-war".

## 2026-11-11 — M4 slices and M4.1 suppression and morale (owner asleep: provisional, for his review)
The owner asked to work through to M6 overnight. Decisions that are his are taken as recommended and listed
here as **provisional**: (1) M4 slices: 4.1 suppression and morale, 4.2 soldier decisions, 4.3 squad drills,
4.4 doctrine profiles and batch. (2) Suppression numbers (core/behaviour.json, confidence low, game values tuned
with the new suppression lab): an enemy round within 4 m adds up to 0.3 (energy-scaled, half at 4 m), fades
0.1/s; pinned at 0.6 until below 0.35. Result: machine gun pins in 1-2 s at 200 m, ~8 s at 600 m; fire team ~6 s
at 200 m; one aimed rifle rarely. (3) Stress: grows 0.02/s x suppression; comrade down within 60 m +0.15, leader
lost +0.2, own wound +0.25 x severity; experience damps (x(1 - 0.6 x exp)), leader within 30 m x0.7; fades
0.01/s under light fire. Shaken at 0.55 (fires at 0.7 the rate), panicked at 0.85 (flat, no fire) until under
0.7. In the scripted shoot-out the two men in each machine gun's beaten zone are pinned at ~20 s and panic after
~90 s of continuous fire. (4) Own rounds never suppress; fragments do not count as near misses (the burst does).
**Recorded:** routing (running away) is left to M4.3 with the drills; the shoot-out test now expects the marksman
(pinned in the beaten zone) to fire fewer rounds; the fire-rate test that checks the ammunition clock keeps its
men calm. The rings on the map (yellow pinned, red panicked) show own men only under fog of war.

## 2026-11-12 — M4.2 soldier decisions (owner asleep: provisional, for his review)
(1) Fire rules per unit: free / return / hold; **default "return"** (fire on your own only once fired upon,
remembered 30 s); a cease-fire order holds until fired upon again. (2) Own engagement ranges: rifle 400 m,
sight of 4x or more 600 m, machine gun 800 m; target choice: nearest, x0.35 if a machine gun firing, x0.6 if a
rifle firing, x1.3 if lying down. (3) Under fire (suppression 0.1+) a halted man not covered from the threat
he knows runs to cover within 15 m (sight from the threat at 1 m to him lying), preferring a spot he can fire
from kneeling; at most every 20 s. Pinned men do not move (they stay flat where they are). (4) Ammunition:
a comrade within 30 m with more than 2 spare (or carrying them for another's weapon) brings one, coming up
behind, 3 s hand-over. (5) Casualty care (drag, first aid) waits for the medical system (owner's M6 question).
**Recorded:** the sim test catalog defaults to "hold" so the older tests keep passive targets; the scripted
shoot-out now sets "hold" with its cease-fire; the machine-gun range test sets "hold" on both sides; the
shoot-out ammunition check counts every magazine and belt (men now hand them over). On the 2 km demo map the
wandering squads rarely meet; the attack-versus-defence batch comes with M4.4.

## 2026-11-12 — Owner confirmed the provisional M4.1/M4.2 choices
Suppression strength as tuned (machine gun pins in 1-2 s at 200 m, ~8 s at 600 m; fire team ~6 s; one rifle
rarely) — keep. Default fire rule "return" — keep. Panicked men cower now; a broken unit routs (runs back) in
M4.3 when several panic. Casualty care stays with the medical system; decide at the M6 review whether to pull it
forward. These are no longer provisional.

## 2026-11-12 — M4.3 squad drills (owner said "go ahead"; values are game values, confidence low)
Following the owner's answers (panicked men cower; a broken unit runs back): reaction to contact on by default
(a moving unit fired upon after a 30 s quiet spell halts and goes down); assault and withdraw are orders, two
halves (two teams, else alternate men), bounds of 30 m, final 25 m (assault) / 30 m (withdraw) together, 40 s
per bound at most, 4 m spread at the end; a top unit breaks when half its able men panic, runs 150 m from the
mean of its known contacts, ignores orders ("unable"), rallies after 30 s without fire at the rally point with
stress x0.6. **Recorded:** the morale test of one pinned man turns reaction to contact off (it would halt his
whole unit); assault and withdraw are not yet on the app's buttons (M5 order interface).

## 2026-11-12 — M4.4 doctrine profiles and the attack lab
Doctrine gets `boundM` (30) and `finalAssaultM` (25) for both factions — **the same values for Germany and
Russia**: no public source was at hand for a difference (confidence low; owner to review; the fixture faction
uses 20/15 to prove the values are read from data). Attack lab: one squad over 300 m of open ground against a
squad behind a 0.7 m field-stone wall (fire rule free, prone) fails 10/10; against the defenders lying in the
open, 10/10 too (they are harder to hit than men kneeling behind the wall to fire over it); two squads, one
supporting by fire from the start line, succeed 4/10. M4 acceptance ("attackers in the open against a prepared
defence lose most of the time"; "varied outcomes") holds. **Bug fixed on the way:** a man ordered down who
opened fire while still going down took "standing" as the lowest posture to fire from, and stood up to fire;
he now takes the posture he is going to. Covering fire in a bounding drill now goes at the enemies each man
knows near the objective (else the point), so it spreads over the position.

## 2026-11-12 — M4 independent review: findings and fixes
All hard rules held. Ten findings fixed: (1) a bounding drill that lost one half turned into a single charge
over the whole distance — survivors now split again and keep bounding (a lone man bounds alone); (2) a second
comrade was sent with ammunition while the first was still handing it over — a running hand-over counts as
"on his way", and a giver turns back if the man has spare again; (3) an order to a squad was overridden by its
platoon's drill — ordered men leave any drill above them (an order to one man takes him out of his unit's
drill); (4) assault / withdraw to a single man set off his whole unit — now rejected (invalid-params); (5) cover
search gave up when the best spot needed a long detour — up to six candidates are tried in order; (6) rallying
emitted one event (possibly for soldier -1) — now one per man; (7) bounds could overshoot the start of the
final rush when boundM > finalAssaultM — limited; (8) the final rush had no time limit (pinned men kept their
paths) — ends after twice the bound time; (9) own-side bursts suppressed men and so lifted cease-fires and set
off reactions to contact — own bursts no longer suppress (the blast still stuns and wounds); (10) stale intents
on the debug overlay — cleared when cover is reached or own fire is replaced by an order. Debug now shows the
unit's drill on the leader's label; screenshot `7-assault-debug` is the overlay evidence.
**Recorded (weak points):** defenders lying in the open are almost never hit by an unsupported attack (prone men
at 300 m are small targets and the attackers break within ~45 s); the supported attack succeeds 4/5 with
Germany attacking and 1/5 with Russia (weapons and optics differ: G36 3x optic, MG5) — a finding for the
owner's review, not tuned away.

## 2026-11-12 — M5 owner answers (orders and interface)
1. **Order input:** "drag targets around, like in the firefight game": the move target is a draggable marker in
   the shape of the unit's formation — a bar for a line, a wedge for a wedge, and so on — with an arrow for the
   facing, resizable (frontage); changing the formation changes its shape.
2. **Waypoints:** multi-point path, pace per leg (walk, run, sneak, crawl).
3. **Time:** pause any time and give orders while paused (they take the radio delay once time runs).
4. **Standing rules on the unit panel:** fire rule (free / return / hold), engagement range limit, stance on
   contact (go to ground / push on / fall back), ammunition discipline (conserve / normal / maximum).

## 2026-11-12 — M5.1 / M5.2 orders and interface
Implemented the owner's answers. Details decided here (game values / interface choices): the formation marker's
width is the distance between the outermost men (a file keeps the doctrine spacing); with a laid-out formation
each man looks for cover only within 4 m of his place (15 m otherwise), so the shape holds; engagement range
choices any / 400 / 200 / 100 m; ammunition discipline stretches the pause between shots or bursts x1.8
(conserve) or x0.6 (maximum); "fall back" on contact withdraws 100 m from the known enemy by bounds; "push on"
does not stop. Grenade and all-grenades stay separate buttons. The old one-tap move remains only as a debug hook.

## 2026-11-12 — M5 independent review: findings and fixes
No hard rule broken; the marker geometry matches how the simulation lays men out (now tested end to end on a
wedge from the data). Fixed: (1) the rules panel and the plan bar could never be hidden (CSS display overrode
`hidden`) — a global `[hidden]` rule; (2) at the normal zoom a finger on the marker grabbed the turn handle —
handles now sit a fixed 46 px from the centre and the nearest part under the finger wins; (3) a range limit did
not stop fire the men had already opened on their own beyond it — it does now; (4) the rules panel jumped back
to the old value until the order arrived (all through a pause) — ordered values are shown until in force;
(5) Halt and cease fire were scrolled off the phone screen — the order bar wraps onto two rows; (6) assault and
withdraw showed a formation marker the drill does not keep — now only the point and a ring; (8) tests added:
input (tap / pan / handle drag / pinch with a stand-in element), marker vs simulation (wedge from data), range
limit set mid-engagement. Minor: "fall back" with no enemy placed falls back the way the unit came; a file has
no width handle. **Recorded for the owner (7):** every move given in the interface lays the formation out as
the marker shows (cover within 4 m, facing the arrow) — the M1.4 halt drill (cover within 15 m, facing outward)
is no longer used from the interface; it follows from "drag the formation marker", to confirm at the review.
The test typecheck now includes the DOM library (the ui tests use DOM types; the packages' own configs still
keep DOM out of sim, data, ai, scenario, campaign). Golden replays were regenerated in M5.1 for the new
behaviour data (ammunition discipline, fall-back distance: catalog fingerprint); the review fixes left them
unchanged.

## 2026-11-12 — M6 owner answers (first playable)
1. **Size:** platoon against platoon (about 3 squads a side), one side attacks, the other defends.
2. **Victory:** objectives held at the end plus losses: points for objectives held when time runs out, minus a
   share for casualties; a side that breaks or is wiped out loses early.
3. **Enemy commander:** doctrinal and cautious — reconnoitres, uses fire support and bounding, pulls back badly
   hurt units; plays by its faction's doctrine values.
4. **After-action review:** result and casualty list, timeline of events, heat map (where fire came from and
   where men fell). (No replay viewer for now.)

## 2026-11-12 — M6 first playable: implementation decisions and the AI-versus-AI result
Taken while implementing the owner's M6 answers (game values, for his review): 40-minute battles; main
objective 100 points, second 50, each man down -5; the generator puts the objectives at buildings on the
defender's half and the attacker ~500 m away; platoon templates are research defaults (confidence low; the
German platoon has a Zugfuehrer and a Funker, the Russian a platoon commander, each with three squads). The AI
commander: defence fires at will out to 300 m; attack support line 300 m from the objective, recon up to 60 s,
base of fire at the enemy its men know near the objective, assaults re-issued every 30 s while a squad is at
half strength, withdrawal past the doctrine's casualty tolerance (30 %). Selecting one of your men now selects
his own squad (the platoon's own men select the platoon).
**AI-versus-AI batch (20 battles each way, 40 min):** the defending platoon won every battle, whichever side
attacked (German attack: attackers ~12 of 20 down, defenders ~2; Russian attack: attackers ~11 of 19 down,
defenders ~4). Moving the support line to 250, 200 or 400 m changed nothing. An even platoon attacking a dug-in
platoon across open ground fails — believable, but it makes defending against the AI dull. **Question for the
owner at the M6 review** (with options: give the attacker more men, e.g. two platoons against one; add support
fire — mortars and smoke are M8; or teach the AI better approach routes).

## 2026-11-12 — M6 independent review: findings and fixes
All hard rules held. Fixed: (1) the base of fire fired at the objective's centre (a building) instead of the
enemy — now at the enemy its men know near the objective (fixed before the review saw it); (2) the commander
counted routed men as losses, so a panicking squad broke off the whole attack — losses now count only men
killed or out; (3) the attacker ignored an objective retaken by a counterattack — it goes back for it, and
holding what it took it no longer withdraws; a test now runs the attacker through all its phases against an
absent defence; (4) both sides defeated in the same second: blue always lost — now neither loses by default
(the score decides); (5) tests for "side broken" and for routed men not taking objectives; (6) a loaded game's
after-action timeline and heat map started at the load — they are saved with the game; (7) the defending squads
started outside the main objective's ring and the two objectives could overlap — squads now inside the ring,
objectives at least 90 m apart; (9) an English text outside the string table; a failed load now says so.
**Recorded (8):** the commanders know who holds each objective without seeing it — holders are public (shown
to the player too), intended. **Balance (for the owner):** the AI attack still fails against the AI defence;
even against a single defending squad left, the attacking platoon is pinned at ~350 m and breaks off.

## 2026-11-12 — Owner's M6 review answers
1. **Attack balance: all three** — (a) the attacker gets more men (two platoons against one), (b) better AI
   attack tactics (covered approach routes, crawling the last stretch, closer fire support, grenades), (c)
   support fire brought forward from M8: mortars and smoke. Planned as **M6.5 Attack balance** before M7.
2. **Fog of war:** keep "what your men have reported" (the M3 reminder is closed).
3. **Medical system:** after vehicles, as planned.
4. **Formation marker:** keep the laid-out formation for every move (the M5 change is confirmed).

## 2026-11-12 — M6.5 attack balance (owner's M6 review: "do 1, 2 and 3")
(a) The generator gives the attacker two platoons; the commander leads every platoon's squads. (b) Better AI
attack: walk, then sneak the last 200 m to the support line; half the squads (each at another known enemy)
fire while the others assault; grenades at enemies within 35 m (never with a friend within 15 m of the burst);
mortar fire called while it reconnoitres, the assault going in as it lands; a grenade order no longer ends the
squad's drill. (c) Mortars and smoke from M8: German 120 mm (filling a game value, confidence low), Russian
82 mm (0.4 kg TNT from manufacturer listings, medium); delay 90 / 75 s, spread 30 / 25 m, cadence 6 / 4 s,
smoke 35 m for 150 s / 25 m for 120 s (game values); allotment attacker 24 HE + 12 smoke, defender 12 + 4; smoke
cuts the view by exp(-0.15/m). **Result (10 battles each way):** German attack wins 2 of 10 (defenders lose
~13 of 20, attackers ~20 of 40); Russian attack 0 of 10 (attackers ~20 of 40, defenders ~12 of 20). The
Russian attack's weaker mortar is the main difference; left for the owner rather than tuned without sources.

## 2026-11-12 — M6.5 independent review: findings and fixes
Fixed: (1) **rule 9** — mortar rounds were a per-side number; now each side's mortar section is an off-map
entity whose container holds its HE and smoke rounds as counted items (new smoke-round ammunition per faction,
`fireSupport.smokeAmmo`), and a call takes rounds out of it (logistics can later own them); (3) the loader
checks that `fireSupport.heAmmo` is an explosive and `smokeAmmo` a smoke round of the faction; (4) the AI calls
no high explosive within 150 m of an objective its own squads are assaulting (they will be there when the rounds
land); (5) its friend checks count wounded men lying near the target; (6) it calls through the first platoon
that can still use the radio; (7) a routed leader cannot call fire, and an order to one man uses only him;
(9) the smoke build-up time is data (`spotting.smokeBuildSeconds`). A test now checks the attacker calls mortar
fire before it first assaults, and smoke. Golden replays regenerated (new data: catalog fingerprint; schema 14).
**Recorded:** (2) acceptance is met one way only (German attack 2 of 10, Russian 0 of 10) — for the owner;
(8) calling fire needs no observer with sight of the target: a simplification until the indirect-fire process
of M8; the renderer draws smoke growth with a fixed 10 s (display only).

## 2026-11-12 — Owner: "more Russian rounds"
The owner chose more rounds for the Russian side (rather than a heavier mortar or more AI work). Faction
`fireSupport.roundsFactor` scales the rounds a generated battle gives the faction: Russia x2 (48 HE + 24 smoke
attacking, 24 + 8 defending), Germany x1 (game values). Alone this changed nothing (the AI never ran out), so
the AI now fires a quarter of its remaining HE per mission (at least 6). **Result (10 battles each way):**
Russian attack still 0 of 10 (defenders now lose ~12 of 20, attackers ~12 of 40); German attack 1 of 10 (2 of
10 before: within the spread of 10 battles). Golden replays regenerated (catalog fingerprint).

## 2026-11-12 — Owner: surrender (especially of downed men)
Owner request: "Include surrendering, especially for downed men". Answers (all the recommended options):
1. **Who:** a man who is wounded and can no longer fight or walk (but conscious) surrenders when an enemy he
   knows of is close (~50 m) and no fit comrade is near (~30 m); a panicked or fleeing (routed) man also
   surrenders when caught with an enemy within ~30 m.
2. **Effect:** he stops fighting; enemies who see him stop firing at him (until someone has seen the surrender
   he can still be shot); when an enemy soldier reaches him (a few metres) he is taken prisoner.
3. **Score / review:** a surrendered or captured man costs his side the same as a casualty (5 points); the
   after-action review lists him as surrendered / captured, and the timeline shows it.
4. **Factions:** the same rule for both sides; willingness from the man's state (wounds, stress, being alone)
   with one data value set for all — no unsourced faction difference.

## 2026-11-12 — M7 owner answers (vehicles)
1. **Scope:** the Puma and the BMP-2 only (the two tracked infantry fighting vehicles of the existing squads).
   Wheeled carriers (Boxer, BTR-82A), the BMP-3 and main battle tanks are NOT part of M7 for now.
2. **Command:** a vehicle is its own unit: tap it and give it orders like a squad (move, fire at, halt, reverse,
   smoke); its crew drives and shoots on its own under the same fire rules. Squads get Mount and Dismount orders.
3. **IFV missiles** (MELLS/Spike on the Puma, Konkurs on the BMP-2): wait for M9 (guided weapons). M7 has the
   guns, the machine guns and the shoulder-fired Panzerfaust 3 / RPG-7.
4. **Battle start:** the attacker's platoons ride in their IFVs from the map edge and dismount where the player
   or the AI decides; the defender's men are in position on foot with their IFVs behind them in support.

## 2026-11-12 — Owner request: look and interface after M7
"After M7 is done, beautify the game": the order bar permanently visible and draggable without selecting a unit
first; a sidebar with every unit to select; soldiers as pixel characters; building interiors; true scale
between house, soldier and map; a map style closer to the classic top-down pixel wargame he named; a decluttered
interface (only the relevant actions for each unit). Planned as **M7.5 Look and interface** (ROADMAP).
**Recorded:** the pixel soldiers and the map style will be our own original art in that genre's manner (small
top-down figures, flat readable terrain), not a copy of that game's sprites or look. The design questions (how
big the figures are at each zoom, how interiors are shown, where the sidebar sits on a phone) are asked when
the milestone starts.

## 2026-11-12 — M7.5 owner answers (look and interface)
1. **Figures and scale:** true scale when zoomed in (pixel figures at true size next to houses and vehicles);
   zoomed out, each squad or vehicle becomes a small symbol. The battle opens zoomed in on the player's men.
2. **Sides:** each faction in its own uniform tones, plus a thin blue or red outline or marker.
3. **Map look:** flat pixel style — flat muted ground colours, crisp pixel edges, simple tree and roof shapes,
   thin dark outlines, no blending or hill shading; contour lines only when zoomed out.
4. **Roofs:** drawn as now; a building's roof fades away when the player's men are inside or next to it, or
   when zoomed in close, showing rooms, inner walls and doors.
5. **Interiors:** ALL floors with stairs (not only the ground floor): upper floors, stairs, a floor switch on
   the map; men can fire from upstairs windows. (The owner chose the larger option.)
6. **Order bar with nothing selected:** visible but greyed out until a unit is selected.
7. **Dragging the order bar:** it docks to an edge — top, bottom, left or right — as a full-width or
   full-height strip.
8. **Unit sidebar:** a slim strip on the left with one small tile per unit (symbol, callsign, men fit, a colour
   for its state); a tap on a tile selects; a tap on the strip's head opens the full list with details; open
   all the time on a wide screen.

## 2026-11-12 — Owner: no path trace for every soldier
"Stop showing traces for every individual soldier's path." In play the map now draws one route line only: the
way of the selected unit's leader (and of its sub-units' leaders); the order marker at the destination stays.
Debug still shows every man's own path. Screenshot `1a-moving` shows it.

## 2026-11-12 — Owner: three more surrender answers
1. **Who counts as downed:** any conscious wounded man who can no longer FIGHT (whether or not he can still
   walk) gives up when an enemy he knows of is within ~50 m and no fit comrade is within ~30 m. (Measured over
   three AI platoon battles: 11 of 177 men could neither walk nor fight, 32 could not do at least one.)
2. **Taking prisoners:** when things are quiet (his unit not under fire), ONE fit enemy within ~50 m who has
   seen the surrender walks over, takes the man prisoner and returns to where he was.
3. **Morale:** a comrade giving up adds no stress to the men near him (no chains of surrenders); a leader
   giving up still shakes his unit, as losing a leader always does.
Defaults kept without asking (to confirm if he wishes): the surrender is recognised at any distance at which
the man is seen; a man who surrendered but was never reached stays "surrendered" in the roster.

## 2026-11-12 — Surrender (M6.6): implementation and game values
Built on the owner's answers (entries above). **Who:** a conscious wounded man who can no longer fight
(whether or not he can walk) gives up when an enemy he knows of is within 50 m and no fit comrade (able, can
walk and fight, not panicked or routed) is within 30 m; a panicked or routed man when such an enemy is within
30 m. "An enemy he knows of" = one of his own contacts, seen or reported (a sound alone does not count), no
older than 10 s, not himself known to have given up, not himself down. Checked once a second, no random draw.
**Effect:** `captive` (surrendered, then captured; never back) — he takes no orders, does not fire or report,
the lead passes on; `isAble` is false for him everywhere. Enemies hold fire only once THEY have seen it: the
flag on their own contact (set by their own sight, passed on at once with reports, never cleared) — target
choice never reads his real state (own fire, ordered fire with a contact, drills' covering fire, the AI
commander's fire, grenades and mortar aim, the player's fire tap which refuses with a message). Area fire
(fire at a point, mortars, grenades, strays) can still hit him. **Prisoners:** a fit enemy within 3 m with a
clear line takes him; when quiet (his unit not fired upon for 10 s, no order to his unit for 10 s, no drill)
one fit enemy within 50 m who has seen the surrender walks over and returns afterwards; any order ends the
errand; given up after 120 s. **Cost:** like a casualty (5 points, counted once); a side whose last men gave
up is out. The roster records "surrendered" / "captured" (such a record placed in a battle is a prisoner from
the start); the battle result counts them separately. No stress to comrades; a leader giving up still shakes
his unit. A broken unit whose runners all gave up stays broken.
**Check:** with the four distances set to 0 the platoon (10 x 900 s), platoon-ru (10 x 900 s) and demo
(50 x 120 s) batches are identical to main battle for battle (no change when nobody surrenders). With the
owner's values: 0.4 / 0.1 men per side surrendered or taken in a German attack, 0.0 / 0.2 in a Russian attack;
winners unchanged (defender 10 of 10 both ways), casualties within 0.3. Golden replays regenerated (catalog
fingerprint; schema 15). Data values (core/behaviour.json `surrender`) are game values, confidence low.

## 2026-11-12 — M7 architecture plan and owner answers (vehicles, second round)
The architecture and slice plan is `docs/plans/m7-vehicles.md` (M7.1a–c, M7.2, M7.3, M7.4a/b). Owner answers
(plan §16 numbers):
- Q3 **walls:** vehicles flatten fences, hedges and wire (leaving a gap) and go round brick and stone walls.
- Q4 **men in the path:** vehicles avoid their own men (men step aside) but **may run over enemy soldiers**
  (the owner chose this over the recommended "stop or steer for everyone").
- Q1 **German seats:** a fourth Puma carries the platoon leader and radio operator.
- Q2 **Russian seats:** fixed three-man BMP-2 crews; squad leaders ride in the back with their squads; the
  platoon commander rides in the back of the first BMP-2.
- Q12 **orders to a squad aboard:** it gets out first, then carries the order out.
- Q9 **points:** destroyed or abandoned IFV 20, immobilised 10.
- Q10 **objectives:** men inside vehicles count too when holding or contesting (owner chose this over
  "only men on foot").
- Q26 **publishing:** vehicle battles stay behind `&vehicles=1` until Panzerfaust/RPG work (M7.4a).
- Q25 **wounded when mounting:** two comrades load a wounded man within a few metres of the vehicle; others stay.
- Q22 **where the AI gets out:** research doctrine per side now and set sourced values (not one shared 550 m).
- Q24 **withdrawal:** squads within about 100 m of their IFV get back in.
The remaining plan questions (5–8, 11, 13–21, 23) are asked at the start of the slice that needs them.
