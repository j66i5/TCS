# State — handover note

_Last updated: 2026-11-14 (M10.0 kick-off and clean slate, roadmap-detail slice 2). The long session-by-session
history that stood here until today is kept in `docs/history/STATE-until-2026-11-14.md`; every change is also in
DECISIONS.md under its date._

## Where we are
- **Current milestone: M10 Medical** (SPEC 9.1, pulled forward by the owner), plan `docs/plans/roadmap-detail.md`
  Phase 1, slices 2-17; ROADMAP lists them. **Done: slice 2 (M10.0).** **Next: slice 3, M10.1 medical data and the
  new physiology.** Slice 5 (D1 hand smoke grenades) and slice 12 (Boxer ambulance / BMM hulls) are built on their
  own branches by other sessions and merged into `main`; slice 13 needs slice 12 merged first.
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

## Baselines (2026-11-14, before medical)
- **Attacker wins, 20 seeds × 1200 s** (M7.5e follow-ups, DECISIONS "slice s0-clear"): village (platoon) 5/20,
  mounted village (platoon-vehicles) 5/20; farmland 10/20 (M7.5e polish); Russian mounted attack 0/10 (900 s,
  waits for M8.5 mortars and M9.3 missiles, owner A4).
- **Performance** (this container, `npm run test:perf -- --silent=false` alone, two runs): bench 16× / 19×,
  spotting 9.7× / 9.3×, **bench-vehicles 8.8× / 9.6×** (floor 8×; below 9× once, so slice 6 starts with a profiler
  pass), bench-combined 3.7× / 3.9× (floor 3×), 20,000 projectiles 3.8× / 4.3×, render 1.2 ms per frame. The
  hull-hit variant flakes (known noise).
- **Test time:** `npm test` 201 s → 160 s (shared map cache, `isolate: false` for sim and data, two redundant
  re-runs trimmed; the plan's 120 s is not met: long battle tests). `npm run test:quick` (sim, data, render, ui;
  514 tests) 29 s: use it while working, `npm run check` alone at the end of a slice (5 min 55 s, green).

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
- **No medical care yet:** a wounded man is never treated, carried or evacuated (M10, now). Wound values are
  game values (low) reviewed once by the owner (2026-11-11).
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
- **Pre-interiors goldens:** delete the six skipped files in `packages/tools/golden/no-interiors/` (they have tested
  nothing since 2026-11-13; the plan recommends deleting, and updating the CLAUDE.md note), or keep them?
- Data reviews whenever convenient (lists in the earlier STATE, `docs/history/STATE-until-2026-11-14.md`, "Open
  questions"): Konkurs-M values, vehicle data of M7.1b-M7.4b, behaviour game values, squad tables, ranks and names.
- After M10.8: the medical numbers table (keep, adjust named values, or faster care for gameplay).
