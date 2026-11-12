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
- Headless battle: `npm run headless -- --scenario demo --seed 1 --seconds 120 [--events] [--no-ai]`
- Generate a map and print stats/problems: `npm run map -- --kind village --seed 3` · all kinds: `npm run map -- --all --seeds 5`
- Sim labs (tables to `reports/`): `npm run lab -- movement` · `npm run lab -- cover` · `npm run lab -- range` · `npm run lab -- casualty` · `npm run lab -- fragmentation` · `npm run lab -- sight` · `npm run lab -- spotting` · `npm run lab -- suppression`
- Batch report: `npm run batch -- --scenario demo --runs 200 --seconds 120` (writes `reports/`)
- Golden replays (only for intended changes, log in DECISIONS.md): `npm run golden:update`
- Screenshots (phone + desktop, then LOOK at them): `npm run screenshot [-- --map farmland --seed 2]` → `screenshots/`
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
- Research cannot open web pages here (network), only search extracts: mark such data `confidence: "medium"` at most.
- The Stop hook (`.claude/hooks/stop-check.sh`) blocks ending the session on red checks; escape hatch documented in the script.
