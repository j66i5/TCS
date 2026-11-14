# State — handover note

_Last updated: 2026-11-14 (M10.2 interventions, self-aid and buddy aid, roadmap-detail slice 4). The long session-by-session
history that stood here until today is kept in `docs/history/STATE-until-2026-11-14.md`; every change is also in
DECISIONS.md under its date._

## Where we are
- **Current milestone: M10 Medical** (SPEC 9.1, pulled forward by the owner), plan `docs/plans/roadmap-detail.md`
  Phase 1, slices 2-17; ROADMAP lists them. **Done: slices 2 (M10.0), 3 (M10.1: `core/medical.json`, kits
  as counted items, medical roles, the "medical" physiology model as the default, state schema 18) and 4 (M10.2:
  the generic `treat` action, MARCH order from `care.order`, self-aid, buddy aid within 3 m, `medical.treated`,
  `--no-medical`, `lab -- treatment`); slices 5 (D1 hand smoke) and 12 (ambulance hulls) came from parallel
  sessions and are merged.** **Next: slice 6, M10.3a who helps (carers and first responders); it starts with a
  profiler pass if bench-vehicles measured below 9×.** Slice 13 needs slice 12 (merged).
- **Every owner question for M10 is already answered** (DECISIONS.md 2026-11-14: "Owner answers for the medical
  system", "Owner answers: M7.5e follow-ups, round A and medical round 1", "Owner answers: medical rounds 2 and 3").
  Those answers override any option still listed in the plan. In short: the full chain from self-aid to an aid
  station off the map; research defaults for the numbers (medium at most), reviewed by the owner after playing;
  DE one Einsatzersthelfer B per Gruppe plus a Sanitäter in the Zug HQ, RU one rifleman-medic per platoon; Russian
  rubber tourniquet and powder ×1.4 time, ×0.8 success; realistic ambulance delays (10-15 min plus drive time) and
  an end-of-battle roll; helpers in contact: the first responder plus at most one comrade per casualty; triage tag
  on the map and the card; a Wounded sidebar tab; bearers are riflemen tasked by the platoon leader; new Boxer
  ambulance and BMM hulls; an order to fire at a recognised protected target is **refused** (the men will not fire;
  a short radio note says why); incidental hits on protected people get their own list in the review; breaches
  are shown only in the review; air evacuation later.
- **Order after M10** (owner): a debt slot (D3 phone pass, D4 infantry tactics with 3-5 s rushes of 15-20 m), then
  M8 → M9 → M7.6 (tanks, wheeled carriers, Jäger/BTR platoons) → M11 (minimum, after measuring ammunition use) →
  M12 → M13. One short debt slot after every milestone.
- **Balance batches:** 1200 s routinely, 2400 s at milestone ends (owner). For speed (owner): 10 seeds before and
  after, only the scenarios a slice affects; `npm run check` once at the end of a slice, alone; `npm run test:perf`
  only when a slice adds per-tick per-man work; screenshots only for visible changes.

**M8 Indirect fire and smoke — built in a parallel session (branch `claude/m8-smoke-fires`, PRs #42 merged, #50
open; DECISIONS "M8.1" … "M8.6", plan Phase 3 slices 21-28).** Smoke clouds are volumes (height, build-up, fade,
drift and plumes in wind; `sim/src/smoke.ts`); the call for fire runs request, processing, shot, flight, splash, with
the first-round error by location method and planned targets; observers (men, vehicle sights; drone kind reserved)
correct by skill; on-map mortar teams (DE 120 mm, RU 2B14 / 2B11: set-up, range band, rounds as items, heard and
seen, slowed by losses and suppression; `platoon-mortars`); off-map PzH 2000 / 2S19 batteries (opt-in: airburst,
danger close 600 m, illumination as data, abstract counter-battery); the AI lays screens across the line and calls
the guns beyond danger close; the fire support pop-up per asset with screens by drag and "splash N s". Labs `smoke`,
`indirect`, `artillery`. Open: M8.5's balance, observer siting and the Russian mounted attack (A4) wait for D4;
planned targets by the player need a deployment phase; the owner's phone play-test of the pop-up. Debt slot after
M8 (slice 29): `?look=classic` deleted, perf re-baselined, `docs/research/low-confidence.md` (264 entries).
**Drones (2026-11-14, roadmap-detail slice 34 "M9.4a", same branch; DECISIONS "M9.4a").** One quadcopter at each
platoon HQ (DE Funker, RU commander): launched by the `drone` order into an entity with its own battery, a busy
operator, cameras that search the ground below, a feed over the radio with the usual delay, a sidebar tile where
Move means fly and Halt brings it home. `npm run lab -- drone`, `--scene drone`, scenario `bench-drones`. The AI
does not fly it yet. Next: M9.4b counter-drone and AI use, M9.5 drone-observed fire.

**Hand smoke grenades (2026-11-14, roadmap-detail slice 5 "D1", parallel session; DECISIONS "D1").** DM45 and
RDG-2 as counted items (one per squad man), thrown by the grenade action, smoke as the existing concealment; "Smoke
grenade" in the Fire tray; units screen themselves on a withdrawal and on a move under fire; hook
`screenCasualty` for the medical line's drag (not called yet). `npm run lab -- smoke`, `--scene smoke`.
## Baselines (2026-11-14, before medical)
- **Attacker wins, 20 seeds × 1200 s** (M7.5e follow-ups, DECISIONS "slice s0-clear"): village (platoon) 5/20,
  mounted village (platoon-vehicles) 5/20; farmland 10/20 (M7.5e polish); Russian mounted attack 0/10 (900 s,
  waits for M8.5 mortars and M9.3 missiles, owner A4). **After M10.1** (10 seeds × 1200 s): village 0/10 (20 seeds:
  1/20; men with broken legs may be why), mounted village 6/10, platoon-ru 6/10: watch in M10.8.
- **Performance** (this container, `npm run test:perf -- --silent=false` alone, two runs): bench 16× / 19×,
  spotting 9.7× / 9.3×, **bench-vehicles 8.8× / 9.6×** (floor 8×; below 9× once, so slice 6 starts with a profiler
  pass), bench-combined 3.7× / 3.9× (floor 3×), 20,000 projectiles 3.8× / 4.3×, render 1.2 ms per frame. The
  hull-hit variant flakes (known noise).
- **Test time:** `npm test` 201 s → 160 s (shared map cache, `isolate: false` for sim and data, two redundant
  re-runs trimmed; the plan's 120 s is not met: long battle tests). `npm run test:quick` (sim, data, render, ui;
  514 tests) 29 s: use it while working, `npm run check` alone at the end of a slice (5 min 55 s, green).
- **Merged from the parallel sessions (2026-11-14):** slice 5 D1 hand smoke grenades (DM45, RDG-2, one per squad
  man, "Smoke grenade" in the Fire tray, `npm run lab -- smoke`, `--scene smoke`, hook `screenCasualty` for the
  medical drag) and slice 12 M10.6-data wheeled ambulance hulls (Boxer ambulance `de-boxer-san`, BMM `ru-bmm`,
  xf `xf-litter-cart`; `--scene ambulances`; no ambulance behaviour yet: slice 13).

**Guided missiles on vehicles (2026-11-14, roadmap-detail slice 32 "M9.3a", parallel session; DECISIONS "M9.3a").**
Guidance kinds wire / beam riding / fire-and-forget (seeker, flies on to the last point seen, top attack); the Puma's
MELLS Spike LR (2 ready, reloaded from the roof by an exposed crewman); launch warning and smoke; xf beam dart.
`npm run lab -- missile` has rows per kind. Next on this line: M9.3b dismounted missile teams (Metis-M at company
level), then the drones.

**Sensor physics (2026-11-14, roadmap-detail slice 31 "M9.2", parallel session; DECISIONS "M9.2").** Thermal
sensors see heat (men, hot and cooled hulls, firing, burning; heat comes through vegetation better; thermal blankets),
a man's sight and goggles help only within their arc; thermal weapon sights as items (DE one per Trupp, RU one per
platoon; low); goggle numbers kept as built; batteries reserved. `npm run lab -- thermal`. Next on this line: M9.3a
guided missiles on vehicles (if the coordinator keeps this line on M9).

**Night and light (2026-11-14, roadmap-detail slice 30 "M9.1", parallel session; DECISIONS "M9.1").** Light follows
the clock in a battle with a sky (`?time=HH:MM&moon=`, tools `--time`): sun and moon table in `core/spotting.json`
`night`; muzzle flashes and gun flashes light the shooter at night, tracers show him more; the night look tints the
map and men, flashes, bursts and fires stay lit. Daylight battles unchanged (states identical to main). Owner M9
round still open: the night look took default (a). `npm run lab -- night`, `--scene night`. Next on this line: M9.2
sensor physics (thermal, goggle numbers).


## What works (short; details in HOW_IT_WORKS.md and ARCHITECTURE.md)
- **Foundations:** deterministic 60 Hz sim with named RNG streams, serialisable state and hash, orders through a
  comms model, events with string keys, counted items, interruptible actions, wound records with a simple
  physiology, battle as a function with roster records in and out, save games, data packs with a validating loader
  and lint, the `xf` fixture faction, headless / batch / golden / lab / screenshot tools, CI and Pages deploy.
- **Map:** procedural village, woodland edge, farmland and industrial maps (2 × 2 km), buildings with rooms,
  inner walls, doorways, stairs and upper floors; navigation for foot, wheeled and tracked; terrain damage.
- **Fighting:** real projectiles (drag, penetration, ricochet), aiming error from skill, posture, fatigue, pulse;
  body zones, helmets and plates; grenades and fragments; under-barrel launchers; machine guns; anti-tank rockets;
  BMP-2 Konkurs-M missile; mortars and smoke with ranging rounds.
- **Senses:** line of sight over terrain, walls, roofs and woods; probabilistic detection; contacts seen, heard
  and reported (by voice and radio through the comms model); fog of war (enemy men in sight drawn as figures).
- **Behaviour:** suppression, stress and morale; soldier decisions (fire, cover, ammunition hand-over, grenades,
  close combat); squad drills (react to contact, bound, assault, withdraw, break and rally); surrender and
  prisoners; houses (defend with a mixed spread, leave a trap, clear room by room); AI commander for attack and
  defence (siting, fall-back, covering fire, assault tempo, clearing on the approach).
- **Vehicles:** Puma and BMP-2 with drive model, crews, mount and dismount, turrets and guns, armour and
  components, fires and bail-outs, cross-loading, casualties loaded within 5 m of the ramp.
- **Interface:** Firefight-style order bar, unit card and men's box, drag-to-move, LOS preview, facing handle,
  unit sidebar, floor switch, Clear and Occupy, fire support pop-up, keyboard, photo-like map (flat and classic
  looks too), after-action review, save and load; phone layout.

## What is weak or missing (honest list)
- **Medical care is only first aid so far:** a man treats himself, or a free comrade within 3 m treats him
  (M10.2); nobody walks over to a casualty further away (M10.3a), carries or evacuates him (M10.4-10.6). Wound values
  are game values (low) reviewed once by the owner (2026-11-11); the medical numbers (`core/medical.json`, mostly
  low, a few medium) wait for his review after M10.8.
- **Attacks rarely win in villages** (5/20) and the Russian mounted attack never does (0/10): accepted for now;
  re-tuning only in the named balance slices (M10.8, D4, M8.5, M9.6).
- **Performance headroom is small:** bench-vehicles sits close to its 8× floor; every medical slice marked [perf]
  measures it alone twice.
- **Phone smoothness unmeasured on a real phone** (the container's software renderer is far slower); D3.
- **Pre-interiors goldens** (`packages/tools/golden/no-interiors/`, six files) have been skipped since 2026-11-13
  (the data changed). The plan proposes deleting them; they are kept untouched until the owner says so (see
  "Open questions").
- Data from search extracts only (web pages cannot be opened here): confidence medium at most, many values low.
- Leftovers from the UI work for D3: vehicle gun and ammunition on the card, the phone's unit list overlapping the
  card, a release-time "no line of fire" warning, drag ghosts piling up, casualties hard to read in the pixel look;
  the roof atlas paints on the main thread.
- `main.ts` in the app is long (cut in D2, slice 10).

## Live build
https://j66i5.github.io/TCS/ — deployed automatically from `main` after every merge.

## Open questions for the owner

- M9 owner round answered 2026-11-14 (DECISIONS "Owner answers: M9 round"): night look and goggles as built. Low-confidence M9.1/M9.2 values: thermal heats, sight arcs, who
  carries thermal sights (DE marksman per Trupp, RU platoon commander), blankets issued to nobody; M9.1: the sun table (one date), full-moon light 0.12, flash light 0.8, tracers x3.
- **Pre-interiors goldens:** delete the six skipped files in `packages/tools/golden/no-interiors/` (they have tested
  nothing since 2026-11-13; the plan recommends deleting, and updating the CLAUDE.md note), or keep them?
- Data reviews whenever convenient (lists in the earlier STATE, `docs/history/STATE-until-2026-11-14.md`, "Open
  questions"): Konkurs-M values, vehicle data of M7.1b-M7.4b, behaviour game values, squad tables, ranks and names.
- After M10.8: the medical numbers table (keep, adjust named values, or faster care for gameplay).
- D1 (low confidence, for review): the DM45's cloud (10 m, 60 s), smoke grenades per man (one), the screen rules
  (15 m, once a minute, on withdrawals and moves under fire).
- M10.6-data (low confidence, for review): Boxer ambulance and BMM armour, components, gear bands, reverse speeds,
  steering, ramp and loading times, extinguishers, signatures; the medic's rank and load.
