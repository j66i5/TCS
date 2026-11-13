# TCS — working notes for Claude

Read `docs/STATE.md` (handover) and the current milestone in `docs/ROADMAP.md` first. `docs/SPEC.md` is the
source of truth. Use the project skills: `start-milestone`, `finish-milestone`, `balance-report`, `add-data-entry`.

**Owner preference:** ask the owner every question as clickable multiple choice (the AskUserQuestion tool),
recommended option first — never as a typed list in the chat.

## Commands
- Install: `npm ci` (Node >= 22.12)
- Dev server: `npm run dev` (Vite, http://localhost:5173)
- Full check (what CI runs, minus build): `npm run check`
- Typecheck / lint / data lint: `npm run typecheck` · `npm run lint` · `npm run lint:data`
- All tests except timing: `npm test` · timing tests alone: `npm run test:perf` · single file: `npx vitest run packages/sim/test/orders.test.ts`
- Determinism only: `npm run test:determinism`
- Headless battle: `npm run headless -- --scenario demo --seed 1 --seconds 120 [--events] [--no-ai]` (scenarios: demo, demo-flat, shootout, platoon, platoon-ru, demo-fixture, bench, vehicles, vehicles-fixture, bench-vehicles, platoon-vehicles, platoon-ru-vehicles, bench-combined, village-occupy)
- App URL options: `?scenario=platoon|demo|vehicles&side=blue|red&attacker=blue|red&map=village|farmland|woodland|industrial|flat&seed=N&limit=<s>&vehicles=0&look=photo|flat|pixel|classic` (photo is the default; pixel = flat; remembered in localStorage `tcs.ui.look`) (the app's platoon battle starts mounted; vehicles=0 = on foot; tools scenarios platoon/platoon-ru stay infantry)
- Generate a map and print stats/problems: `npm run map -- --kind village --seed 3` · all kinds: `npm run map -- --all --seeds 5`
- Sim labs (tables to `reports/`): `npm run lab -- movement` · `npm run lab -- cover` · `npm run lab -- range` · `npm run lab -- casualty` · `npm run lab -- fragmentation` · `npm run lab -- sight` · `npm run lab -- spotting` · `npm run lab -- suppression` · `npm run lab -- attack` · `npm run lab -- drive` · `npm run lab -- mount` · `npm run lab -- gunnery` · `npm run lab -- armour` · `npm run lab -- antitank [trials]` · `npm run lab -- missile`
- Batch report: `npm run batch -- --scenario demo --runs 200 --seconds 120` (writes `reports/`)
- Golden replays (only for intended changes, log in DECISIONS.md): `npm run golden:update`
- Screenshots (phone + desktop, then LOOK at them): `npm run screenshot [-- --map farmland --seed 2]` (vehicles, gunnery, armour, antitank: `-- --scene vehicles`; order bar, docks, sidebar, labels: `-- --scene ui`; look pairs, roofs, sprite sheet: `-- --scene look`; rooms: `-- --scene interiors`; upper floors: `-- --scene floors`; BMP-2 missile: `-- --scene missile`; photo vs flat map at four zooms: `-- --scene photo [--map woodland]`; `?look=classic` = old look) → `screenshots/`
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
- Men on foot look for vehicles only every fourth scan: any "seen within" window for vehicles must be at least ~5 s.
- Research cannot open web pages here (network), only search extracts: mark such data `confidence: "medium"` at most.
- The battle opens with nothing selected; `__tcs` debug-hook orders go to the first own unit then, `__tcs.select(null)` deselects. The order-bar dock is remembered in localStorage `tcs.ui.dock`.
- Appearance data (`appearance.json`) is outside the catalog fingerprint: colour changes need no `golden:update`.
- Zoom levels live in `render/src/lod.ts` (symbols < 1.2, dots, figures from 8 (always true scale), close >= 16 px/m); soldier art is string grids in `render/src/sprites/soldier-art.ts` (preview via `composeFrame`/`rotateFrame` to PNG in Node).
- Batch, headless and `npm run map` take `--no-interiors` (pre-interiors map, for comparisons). `packages/tools/golden/no-interiors/*.json` are pre-interiors goldens replayed with interiors off: never regenerate them.
- Every route for men goes through `routeBetween`; a raw `findPath` needs an `// outdoor: ok` marker (architecture test). Inner walls live in `MapIndex.segments` from `nOuter` on, not in `buckets` (use `interiorSegmentsInRectInto`).
- Every soldier height goes through `standZ`; a bare `heightAt` in `sim/src/systems` or `ai/src` needs `// ground: ok` (architecture test). Routes to upper floors need heights: `routeBetween(..., {sz, gz})` + `routeWaypoints`, never hand-built waypoints. Debug hooks `__tcs.occupyAt(x, y)`, `setFloor(f)`, `floorShown()`.
- Photo map tiles paint in a worker (`render/src/photo/worker.ts`); tests and Node use the same painter on the main thread. Screenshots must wait for `__tcs.tilesPending() === 0`. Painters in `render/src/photo/` and `flat/paint.ts` stay pure (no Pixi/DOM/random/clock; architecture test); copy imported functions and constants into locals in their pixel loops.
- HUD z-order: sidebar 1, dock 2, panels above, review 5, errors 6.
- The Stop hook (`.claude/hooks/stop-check.sh`) blocks ending the session on red checks; escape hatch documented in the script.
