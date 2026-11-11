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
