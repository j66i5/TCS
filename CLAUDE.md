# TCS — working notes for Claude

Read `docs/STATE.md` (handover) and the current milestone in `docs/ROADMAP.md` first. `docs/SPEC.md` is the
source of truth. Use the project skills: `start-milestone`, `finish-milestone`, `balance-report`, `add-data-entry`.

**Owner preference:** ask the owner every question as clickable multiple choice (the AskUserQuestion tool),
recommended option first — never as a typed list in the chat.

## Commands
- Install: `npm ci` (Node >= 22.12)
- Dev server: `npm run dev` (Vite, http://localhost:5173)
- Full check (what CI runs, minus build): `npm run check`
- Typecheck / lint / data lint: `npm run typecheck` · `npm run lint` · `npm run lint:data` (`-- --table`: writes `docs/research/low-confidence.md`)
- All tests except timing: `npm test` · timing tests alone: `npm run test:perf` · single file: `npx vitest run packages/sim/test/orders.test.ts`
- Determinism only: `npm run test:determinism`
- Headless battle: `npm run headless -- --scenario demo --seed 1 --seconds 120 [--events] [--no-ai]` [--time HH:MM --moon 0..1] (scenarios: demo, demo-flat, shootout, platoon, platoon-ru, demo-fixture, bench, vehicles, vehicles-fixture, bench-vehicles, platoon-vehicles, platoon-ru-vehicles, platoon-mortars, platoon-ru-mortars, platoon-artillery, bench-combined, bench-drones, bench-missile-team, platoon-vehicles-tanks, platoon-ru-vehicles-tanks, platoon-vehicles-tanks-both, bench-tanks, village-occupy, platoon-vehicles-wheeled, platoon-ru-vehicles-wheeled, platoon-vehicles-mixed) [--carriers tracked|wheeled[,tracked|wheeled]] (M7.6c: the carrier class per side of the mounted platoon scenarios)
- App URL options: `?scenario=platoon|demo|vehicles&side=blue|red&attacker=blue|red&map=village|farmland|woodland|industrial|flat&seed=N&limit=<s>&vehicles=0&look=photo|flat|pixel&crew=<blue crew template>,<red crew template>&time=HH:MM&moon=0..1` (time: the battle at that local time, light from the clock, M9.1) (crew: vehicles scenario only; tanks: `crew=leopard2a7v-besatzung,t90m-ekipazh` (or `t72b3m-ekipazh`), their squads then walk; `mortars=1`: on-map mortar sections instead of off-map rounds; `artillery=1`: an off-map 155/152 mm allotment too; `air=blue[,red]`: an off-map reconnaissance drone for those sides, M9.5; `missiles=0`: the mounted battle without its Metis-M team, M9.3b; `tanks=1|attacker|defender[&tankCrew=<blue section>,<red section>]`: a two-tank section per side, M7.6b; `perf=1`: the frame-time read-out, D3) (photo is the default; pixel = flat; remembered in localStorage `tcs.ui.look`) (the app's platoon battle starts mounted; vehicles=0 = on foot; M7.6c: `vehicles=tracked|wheeled|<blue>,<red>` picks each side's platoon by carrier class (Jägerzug in GTK Boxers, BTR platoon in BTR-82A), also the vehicles scenario's crews; tools scenarios platoon/platoon-ru stay infantry)
- Generate a map and print stats/problems: `npm run map -- --kind village --seed 3` · all kinds: `npm run map -- --all --seeds 5` · 4 km with navigation grids, times and memory: `NODE_OPTIONS=--expose-gc npm run map -- --kind village --size 4000 --nav [--seeds 3]`
- Phone proxy (report only, software GL here): `npm run phoneperf [-- --look photo,flat --dpr 2.625 --throttle 4 --seconds 10 --no-build --url <server>]` → `reports/phoneperf-<stamp>.md` · cross-browser hash probe (report only; CI job `probe`): `npm run probe [-- --diff]` → `reports/probe-<stamp>.md`
- Sim labs (tables to `reports/`): `npm run lab -- movement` · `npm run lab -- cover` · `npm run lab -- range` · `npm run lab -- casualty` · `npm run lab -- fragmentation` · `npm run lab -- sight` · `npm run lab -- spotting` · `npm run lab -- suppression` · `npm run lab -- attack` · `npm run lab -- drive` · `npm run lab -- smoke [seeds]` · `npm run lab -- night` · `npm run lab -- thermal` · `npm run lab -- drone [seeds]` (hand smoke and smoke volumes) · `npm run lab -- indirect [seeds]` · `npm run lab -- artillery [seeds]` · `npm run lab -- mount` · `npm run lab -- gunnery` · `npm run lab -- armour` · `npm run lab -- antitank [trials]` · `npm run lab -- missile` (M7.6a: armour, antitank, gunnery, drive and missile have tank rows: Leopard 2A7V, T-90M, T-72B3M; armour shows reactive tiles full and spent; M7.6c: drive, gunnery, mount, armour and antitank have GTK Boxer and BTR-82A rows) · `npm run lab -- missile-team [trials]` · `npm run lab -- house defend|leave [trials]`
- Batch report: `npm run batch -- --scenario demo --runs 200 --seconds 120 [--time 23:00 --moon 0]` (writes `reports/`)
- Golden replays (only for intended changes, log in DECISIONS.md): `npm run golden:update`
- Screenshots (phone + desktop, then LOOK at them): `npm run screenshot [-- --map farmland --seed 2]` (vehicles, gunnery, armour, antitank: `-- --scene vehicles`; order bar, docks, sidebar, labels: `-- --scene ui`; look pairs (photo/flat), roofs, sprite sheet: `-- --scene look`; rooms: `-- --scene interiors`; upper floors: `-- --scene floors`; BMP-2 missile: `-- --scene missile`; ambulances (Boxer, BMM: wheels, red cross): `-- --scene ambulances`; tanks (Leopard 2A7V vs T-90M close up in both looks, firing, debug overview): `-- --scene tanks`; tanks in the platoon battle (posts, firing): `-- --scene tanks-battle`; wheeled carriers (GTK Boxer, BTR-82A close up, firing, the wheeled platoon battle, dismount): `-- --scene wheeled`; hand smoke (Fire tray, cloud): `-- --scene smoke`; the platoon's drone (tile, flight, feed, home): `-- --scene drone`; smoke plumes in wind: `-- --scene plumes`; photo vs flat map at four zooms plus men on foot (shadows, rims, overlays): night (noon, dusk, night; photo and flat): `-- --scene night`; ambulances (Boxer, BMM): `-- --scene ambulances`; `-- --scene photo [--map woodland]`) → `screenshots/`
- Production build: `npm run build` (set `TCS_BASE=/TCS/` for the Pages path)
- Deploy: merge to `main`; GitHub Actions (`.github/workflows/ci.yml`) checks, builds and deploys to Pages.

## Hard rules (SPEC 4.3) — one line each
1. Deterministic sim: fixed 60 Hz, seeded RNG with named streams (`sim/rng.ts`), no `Math.random`, no wall clock.
2. Transcendental maths (sin, cos, sqrt, pow, exp, `**`) only via `sim/math.ts`.
3. Orders are the only external input to the sim (`submitOrder`).
4. Whole state serialisable (`serializeState`/`deserializeState`/`hashState`); components are plain data.
5. Sim emits events; render/UI/tools consume events, never internals.
6. Entities are numeric IDs, state in `Store`s (ID-ordered); projectiles in typed arrays (M2).
7. SI units inside the sim (m, s, kg, rad); convert at the UI edge.
8. No faction in code (no `"de"`/`"ru"` literals in sim/ai/render/ui); fixture faction `xf` must keep working.
9. Every consumable is a counted item in a container; one generic `transferItems`.
10. Wounds are records; casualties remain entities.
11. Battle = `runBattle(BattleInput) -> BattleResult`; roster records in and out.
12. Player-facing text via string tables (`Strings.t`); events carry keys, not text.

## Gotchas
- TypeScript is pinned to 6.0.x: typescript-eslint does not support TS 7 yet.
- `sim`, `data`, `ai`, `scenario`, `campaign` have no DOM/Node types on purpose: a type error there may mean you used a forbidden API.
- Iterate stores, never raw `Map`s of entities: insertion order breaks determinism after save/load.
- Changing any data file changes the catalog fingerprint and fails the golden test — intended changes need `npm run golden:update` + a DECISIONS.md line.
- Playwright is pre-installed in the cloud container, not a project dependency; load it via `createRequire`.
- Wikipedia and most of the web are blocked from the container; data source URLs cannot be fetched here.
- `packages/scenario` (map generation) follows the sim's determinism lint rules: maps are battle input.
- New data folders must also be bundled by the app (`packages/app/src/data.ts` glob); a test checks core/** and factions/**.
- Hot loops (projectiles): copy imported functions/constants into locals first — module getters cost ~15 % in tsx/vitest.
- Timing tests (`perf*.test.ts`) fail if another heavy command runs at the same time; run `npm run check` alone.
- `bench-vehicles` sits close to its 8× floor: new per-tick work in spotting, contacts or vehicles needs a perf check. The parked-hulls perf test is noisy (+9 to +29 % on one build): rerun alone before calling it a regression.
- A crew that bails out loses `Unit.vehicle` (gets `exVehicle`): count a side's vehicles from `state.vehicle`, not its crews. Labs shooting at a crewed hull must hold it still (penetrated crews reverse out).
- A carrier crew template is chosen from the manifest platoon's carriage (`crewTemplateOf`, M7.6c), not by id order; `platoonTemplates {tracked, wheeled}` falls back to `platoonTemplate`. Adding ammunition shifts `catalog.ammoIds`, so state hashes with projectiles in flight change (projectile ammo is an index): compare event streams, or map the index to ids.
- Men on foot look for vehicles only every fourth scan: any "seen within" window for vehicles must be at least ~5 s.
- Research cannot open web pages here (network), only search extracts: mark such data `confidence: "medium"` at most.
- The battle opens with nothing selected; `__tcs` debug-hook orders go to the first own unit then, `__tcs.select(null)` deselects. The order-bar dock is remembered in localStorage `tcs.ui.dock`.
- Appearance data (`appearance.json`) is outside the catalog fingerprint: colour changes need no `golden:update`.
- Zoom levels live in `render/src/lod.ts` (symbols < 1.2, dots, figures from 8 (always true scale), close >= 16 px/m); soldier art is string grids in `render/src/sprites/soldier-art.ts` (preview via `composeFrame`/`rotateFrame` to PNG in Node).
- Batch, headless and `npm run map` take `--no-interiors` (pre-interiors map, for comparisons). `packages/tools/golden/no-interiors/*.json` are pre-interiors goldens replayed with interiors off: never regenerate them.
- Every route for men goes through `routeBetween`; a raw `findPath` needs an `// outdoor: ok` marker (architecture test). Inner walls live in `MapIndex.segments` from `nOuter` on, not in `buckets` (use `interiorSegmentsInRectInto`).
- Every soldier height goes through `standZ`; a bare `heightAt` in `sim/src/systems` or `ai/src` needs `// ground: ok` (architecture test). Routes to upper floors need heights: `routeBetween(..., {sz, gz})` + `routeWaypoints`, never hand-built waypoints. Debug hooks `__tcs.occupyAt(x, y)`, `setFloor(f)`, `floorShown()`.
- Photo map tiles paint in a worker (`render/src/photo/worker.ts`); tests and Node use the same painter on the main thread. Screenshots must wait for `__tcs.tilesPending() === 0`. Painters in `render/src/photo/` and `flat/paint.ts` stay pure (no Pixi/DOM/random/clock; architecture test); copy imported functions and constants into locals in their pixel loops.
- Photo-only unit extras (contact shadows, rims, hull shadows, scorch, under-strokes, veil, grain) are keyed on `look === "photo"` in `renderer.ts`: flat must stay byte-identical (compare `--scene look` shots).
- Night (M9.1): `light` follows the clock only when `environment.sky` is set (`environmentAt`); without it (every golden) nothing changes. The renderer tints map, roofs and men by `state.environment.light`; at light 1 nothing night-related is drawn.
- Sensors (M9.2): a sensor kind may be `thermal` (sees heat: per-target `heat` in spotting.ts, vegetation thinned as visibility^exponent) and have `arcDeg` (a man's sight/goggle helps only within it). `SENSOR_HEAT` in spotting.ts is set by each sensor function: read it right after the call.
- Drones (M9.4): an enemy drone a man sees lives in his `seen`, never in his contacts; men look for drones every fourth scan, so "sees it" windows use `DRONE_SEEN_S` (6 s). A drone's operator is busy with the open-ended action `flyDrone`. M9.6: men hide from enemy drones (`SoldierState.droneHide`, `behaviour.soldier.droneHide`); flares light targets per target (`sim/flares.ts`); AI night drills are gated on `light < COMMANDER.night.belowLight`; `tallyReview` (sim/review.ts) feeds the review and batch lines.
- HUD z-order: sidebar 1, dock 2, panels above, perf read-out 4, review 5, errors 6.
- D3: `__tcs.perf(reset?)` returns the frame split (always installed); perf mode never computes the state hash. Unit tests named `perf*.test.ts` are timing tests (excluded from `npm test`). The roof atlas paints in `render/src/photo/roof-worker.ts` (synchronous without workers); `tilesPending()` counts it.
- The Stop hook (`.claude/hooks/stop-check.sh`) blocks ending the session on red checks; escape hatch documented in the script.
