# State — handover note

_Last updated: 2026-11-11, end of session 1 (M0 Bootstrap)._

## Current milestone
**M0 Bootstrap — code complete.** One step is still needed from the owner before the build can go live
(see "Blocked" below). Next milestone: **M1 Map and movement** (slices proposed in ROADMAP.md).

## What works (with evidence in the session report)
- Monorepo with 9 packages (`sim`, `data`, `ai`, `scenario`, `campaign`, `render`, `ui`, `app`, `tools`);
  dependency direction enforced by ESLint and by a test.
- Deterministic simulation core: 60 Hz fixed tick, seeded RNG with named streams, serialisable state with
  a 64-bit hash, orders (inbox → comms delay → delivery), event stream, counted items in containers with
  generic transfer, interruptible timed actions, wound/physiology interfaces (types only), comms interface,
  battle-as-a-function with roster records in and out.
- Data: validating loader with readable errors, data linter, string tables; core data; German and Russian
  skeleton packs (ranks, names, radio phrasing; placeholder team template and doctrine); made-up fixture
  faction `xf`.
- Tools: headless runner, batch runner with Markdown/JSON reports, golden replays, screenshot script.
- Tests: 61, all green — determinism (incl. continuing from a mid-battle save), 2 golden replays, fixture
  faction battle, architecture guards, performance floor (304 soldiers: ~460× real time, movement only), data
  loader errors, items, orders, actions, camera.
- App: map with the German team (blue) and the Russian team (red); tap to move the blue team (walk/run
  toggle), pause / 1× / 4×, radio log, debug counters (FPS, sim rate, tick, state hash); pinch/drag/wheel camera.
- Independent review found 6 problems (save/load with queued orders, NaN in saves, simulation randomness not
  exercised, controllers could write state, AI memory not saved, saves not tied to their data); all fixed with
  tests (DECISIONS.md, last entry).
- CI on every push; deployment job from `main` to GitHub Pages; Stop hook; four project skills; reviewer agent.

## What is weak or missing (honest list)
- Nothing tactical yet: flat empty map, no terrain, no shooting, no spotting (both sides see everything), AI is
  "walk to a random point every 30 s". This is expected for M0.
- Unit templates, roles and doctrine for Germany and Russia are placeholders (4-man "demo team", identical
  neutral doctrine), flagged `confidence: low` and listed as warnings by `npm run lint:data`.
- Data source URLs were written from knowledge; the container cannot reach Wikipedia to verify them.
- The phone layout puts the buttons on two rows; the waypoint lines (one per man) are cluttered. Cosmetic.
- The performance floor (8× real time) is loose; it becomes meaningful when projectiles arrive in M2.
- Environment (time of day, weather, temperature) exists in state but no system reads it yet. M1 movement and
  fatigue must read it (SPEC 9.7).

## Blocked / needs the owner
1. **Enable GitHub Pages once**: repository *Settings → Pages → Build and deployment → Source: "GitHub Actions"*.
   Without this the deploy job fails and https://j66i5.github.io/TCS/ does not exist.
2. After enabling Pages: re-run the latest "CI" run on `main` (Actions tab → Re-run all jobs), or ask Claude to.
   The M0 pull request is merged; the deploy job failed only because Pages is not enabled yet.

## Next
Start M1 with slice **M1.1 Terrain model and generator** (see ROADMAP.md), after the owner answers the
questions below.

## Answered by the owner (2026-11-11)
- First squads: German **Panzergrenadier dismounts of a Puma**; Russian **motor-rifle squad on a BMP**.
- Callsigns: German **"Gruppe {n}"** (squad) and **"Trupp {n}"** (team); Russian "Gruppa {n}" kept for now.

## Open questions for the owner
- Data to review when convenient: German and Russian rank lists with NATO codes (`ranks.json`), name lists,
  female share in generated combat units (5 % German, 1 % Russian — rough game values).
- Start M1 (slice M1.1 terrain model and generator) in the next session?
