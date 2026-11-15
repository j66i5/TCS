# State — handover note

_Last updated: 2026-11-15 (M10.6b combat vehicles' rear run, Role 1, settlement, roster; roadmap-detail slice 14). The long session-by-session
history that stood here until today is kept in `docs/history/STATE-until-2026-11-14.md`; every change is also in
DECISIONS.md under its date._

## Where we are
- **Current milestone: M10 Medical** (SPEC 9.1, pulled forward by the owner), plan `docs/plans/roadmap-detail.md`
  Phase 1, slices 2-17; ROADMAP lists them. **Done: slices 2 (M10.0), 3 (M10.1: `core/medical.json`, kits
  as counted items, medical roles, the "medical" physiology model as the default, state schema 18) and 4 (M10.2:
  the generic `treat` action, MARCH order from `care.order`, self-aid, buddy aid within 3 m, `medical.treated`,
  `--no-medical`, `lab -- treatment`) and 6 (M10.3a: carers — the first responder for urgent casualties plus at most
  one willing comrade, `care` intent, doctrine `casualtyCarePriority`, `medical.carer` events, batch "Carers"
  line) and 7 (M10.3b: triage tags T1-T3 by the man who treats, sometimes wrong; the tag on the map and the card;
  under fire a casualty is got into cover — he walks or is dragged — and care goes on there; "Medic!" and "Man down,
  treating" on the radio; batch "Triage, care under fire" line with preventable deaths) and 8 (M10.4a: a generic
  `carry` store, state schema 19; seven carry methods from data incl. the four-man litter (Sanitaeter's
  `de-litter`); the leader walks the way, the rest follow his trail; rests, cover under fire, carriers fire only in
  self-defence; the M10.3b drag is a carrying party now; `npm run lab -- carry`) and 9 (M10.4b: a squad getting in
  carries its wounded from up to 150 m to the ramp and lifts them in; lying and sitting places, ambulance layouts;
  `dismount` with `wounded` carries them out; "carried" and "stretcher" sprite frames; `bench-medical` perf case,
  floor 8×; `--scene medical`); slices 5 (D1 hand smoke) and 12 (ambulance hulls) came from parallel sessions and
  are merged, and so is M8 (fire support, from main). Slice 10 (D2) is done: one battle record folded from the
  events (`sim/src/record.ts`) feeds the review, the save and the batch report; the review has Battle, Medical and
  Conduct tabs (the last two empty until M10.8); `app/src/main.ts` is cut to about 330 lines, the rest in modules
  beside it (`app.ts` holds the shared app state). Slice 11 (M10.5) is done: a generic rear-point store (`rear`,
  state schema 20) holds each platoon's Verwundetennest (`systems/nest.ts`): sited 150 m behind the platoon away from
  the known enemy on ground wheeled vehicles reach, moved when threatened; the platoon leader tasks two riflemen as
  bearers, walking wounded walk, T1 first; the platoon's medic triages again and treats there; men fit again return
  to duty; orders `casualtyPoint` (drag the red-cross marker) and `evacuate` (Back in the sidebar's Wounded tab); the
  AI commander counts carriers as committed; batch "Verwundetennest" line; `--scene nest`. Slice 13 (M10.6a) is
  done: off-map entity state — an asset is an ordinary vehicle with its crew from tick 0 carrying
  `VehicleState.offMap`, created after every force, parked at `OFF_MAP_PARK` and skipped by every vehicle loop while
  off the map (architecture test; `offmap.ts`), its crew (`Unit.asset`) nobody's to order and outside the side's
  strength, results and score; generated battles give each side its faction's ambulances (manifest `ambulance`: DE
  two Boxer, RU two BMM; `ScenarioDef.ambulances`); a platoon with casualties at its nest calls one (automatic, or
  the player's `callAmbulance`: "Call ambulance" in the Wounded tab), it comes on at the edge behind the nest after
  10-15 min (stood down if nobody waits by then), drives there, loads T1 first within its layouts, backs off, leaves
  the map; its wounded are "evacuated" (roster status; their condition is kept until M10.6b); `systems/evacuation.ts`,
  `medical.ambulance` / `medical.evacuated` events, battle record version 3, batch "Ambulances" line,
  `npm run lab -- medevac`, `--scene medevac`. Slice 14 (M10.6b) is done: a generic rear run
  (`VehicleState.rearRun`, `systems/rearrun.ts`): an idle combat vehicle takes the nest's men off the map when a T1
  (or three men) wait and no ambulance is near, one per platoon, back after 15 min; a hull with wounded aboard that
  stands idle goes too; the player's `rearRun` ("Take wounded back" on the order bar); Role 1 outcome at hand-over and
  the end-of-battle settlement (`systems/aftercare.ts`: died of wounds, recovery days; the side holding the ground
  evacuates, else captured); `SoldierRecord.recoveryDays` / `diedOfWoundsTick` (status "killed"),
  `SideResult.diedOfWounds`; battle record version 5; batch "Rear runs and Role 1"; `--scene rearrun`.** **Next:
  slice 15, M10.7a (recognition and respect); the refused fire order at a recognised protected target (owner Q-7)
  comes with it and slice 16.** Merged origin/main (men down, identity tags, prisoners' care) before slice 14.
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
- **D4a done (2026-11-15, parallel session; DECISIONS "D4a"):** the AI attack keeps a reserve (committed when the
  assault falters), its base of fire bounds forward or its men step aside when own men mask it, and shifts fire to
  depth; rushes are 16 m. Batch line "Attack (D4a)". Open: "support masked" fell 35 %, not the 50 % asked. **Next:
  D4b** (fire distribution, low aim at heard/reported men, ambush and defend-an-arc orders, hesitation).
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
AI keeps its drones up 220 m short of the enemy at 120 m (M9.4b); men see and hear enemy drones (in `seen`, not
contacts), call them out and fire at those within 200 m (abstract hit box, `droneHitChance`). M9.5: a call is
located by the drone (or an off-map reconnaissance drone, `?air=blue`) when that is better, and drones read the falls.
M9.6 (2026-11-15): flares give light; AI night drills (illumination calls, night attack distances, night
fire discipline); men hide from enemy drones; review rows (drones, enemies found by drone, fire missions by location
method); batches day and night reported, not re-tuned (no agreed band). Open: the owner's play-test.

**Main battle tanks: data and labs (2026-11-14, roadmap-detail slice 39 "M7.6a", parallel session; DECISIONS
"M7.6a").**
- New tanks: Leopard 2A7V (4 crew, loader, 42 rounds) and T-90M / T-72B3M (3 crew, carousel autoloader, Refleks-M
  through the gun as its own weapon entry).
- New data and engine pieces:
  - weapon type `tank-gun` and `startLoaded`;
  - `missileBeyondM` per weapon;
  - materials `composite-heavy` and `composite-cast`;
  - explosive reactive tiles as counted items, one item id per face (`reactive` item block,
    `armour.tiles[].coverage`, used up per hit met, a tandem's main jet beats most of a tile);
  - the crew's armour judgement (`faceNeed`) counts the tiles it expects.
- The fixture's `xf-tortoise` covers all of this for rule 8.
- Tanks are in no battle scenario yet. Only the labs, `--scene tanks` and the app's
  `?scenario=vehicles&crew=leopard2a7v-besatzung,t90m-ekipazh` use them. The default vehicle crews skip vehicles
  without passenger seats.
- Lab rows: `armour` (tiles full and spent), `antitank` (PzF3 against the T-90M, RPG-7 against the Leopard),
  `gunnery` (4 km field), `drive` and `missile` (Refleks).
- Existing battles are unchanged: the goldens moved only by the fingerprint.
- **Next: slice 40 (M7.6b)**: AI use with infantry, a tank scenario, the vehicle batch, tank perf.

**Hand smoke grenades (2026-11-14, roadmap-detail slice 5 "D1", parallel session; DECISIONS "D1").** DM45 and
RDG-2 as counted items (one per squad man), thrown by the grenade action, smoke as the existing concealment; "Smoke
grenade" in the Fire tray; units screen themselves on a withdrawal and on a move under fire; hook
`screenCasualty` for the medical line's drag (not called yet). `npm run lab -- smoke`, `--scene smoke`.
**Men down, identity tags, crawling, prisoners' care (owner requests 2026-11-15; DECISIONS of that date).** A dead
man is "down, state unknown" to his comrades until one checks him (they come and drag him into cover meanwhile);
then his identity tag (DE half Erkennungsmarke, RU lichny znak; faction data) is taken when it is quiet; casualties
who cannot walk crawl into cover; surrendered men under fire crawl out of the line of fire; prisoners are treated by
the side holding them, carers sent by urgency first. The surrendered-under-fog report: sight checked, the stale
white flag now fades with its marker.
## Baselines (2026-11-14, before medical)
- **Attacker wins, 20 seeds × 1200 s** (M7.5e follow-ups, DECISIONS "slice s0-clear"): village (platoon) 5/20,
  mounted village (platoon-vehicles) 5/20; farmland 10/20 (M7.5e polish); Russian mounted attack 0/10 (900 s,
  waits for M8.5 mortars and M9.3 missiles, owner A4). **After M10.1** (10 seeds × 1200 s): village 0/10 (20 seeds:
  1/20; men with broken legs may be why), mounted village 6/10, platoon-ru 6/10: watch in M10.8.
- **After M10.3a** (10 seeds × 1200 s, care on): village 0/10, mounted village 6/10, platoon-ru 6/10; median time to
  first treatment 67-157 s; the side with carers fires about a quarter to a third fewer rounds.
- **After M10.3b** (10 seeds × 1200 s, `--no-medical` → care on): preventable deaths (died of wounds after a
  life-threatening need) per battle blue/red: platoon 3.8/2.6 → 1.4/2.6, mounted village 2.9/3.4 → 2.0/3.1,
  platoon-ru 2.5/1.6 → 1.3/1.0 (−32 % overall; the plan's −40 % met for the German side on foot and the Russian
  attack, not for the Russian defenders). Attacker wins with care: village 4/10, mounted village 5/10, platoon-ru
  6/10.
- **After M10.4a** (10 seeds × 1200 s, care on): attacker wins village 2/10, mounted village 3/10, platoon-ru 5/10
  (before the slice 4/10, 5/10, 6/10: noise; carrying is only used for drags to cover so far). `lab -- carry`: every
  method within 10 % of the data on flat, slope, house and stairs.
- **After M10.4b** (10 seeds × 1200 s, care on; mounted battles only, the others do not mount): see DECISIONS
  "M10.4b" for the before/after table.
- **Performance** (this container, `npm run test:perf -- --silent=false` alone, two runs): bench 16× / 19×,
  spotting 9.7× / 9.3×, **bench-vehicles 8.8× / 9.6×** (floor 8×), bench-combined 3.7× / 3.9× (floor 3×), 20,000
  projectiles 3.8× / 4.3×, render 1.2 ms per frame. The hull-hit variant flakes (known noise). After M10.3a: bench
  19× / 17×, spotting 10.8× / 8.9×, bench-vehicles 10.6× / 8.4×, bench-combined 4.0× / 4.0×; the profiler pass
  (DECISIONS M10.3a) found path finding (19 %) and movement (10 %) on top, medical not visible.
- **Test time:** `npm test` 201 s → 160 s (shared map cache, `isolate: false` for sim and data, two redundant
  re-runs trimmed; the plan's 120 s is not met: long battle tests). `npm run test:quick` (sim, data, render, ui;
  514 tests) 29 s: use it while working, `npm run check` alone at the end of a slice (5 min 55 s, green).
- **Merged from the parallel sessions (2026-11-14):** slice 5 D1 hand smoke grenades (DM45, RDG-2, one per squad
  man, "Smoke grenade" in the Fire tray, `npm run lab -- smoke`, `--scene smoke`, hook `screenCasualty` for the
  medical drag) and slice 12 M10.6-data wheeled ambulance hulls (Boxer ambulance `de-boxer-san`, BMM `ru-bmm`,
  xf `xf-litter-cart`; `--scene ambulances`; no ambulance behaviour yet: slice 13).

**Dismounted missile teams (2026-11-14, roadmap-detail slice 33 "M9.3b", parallel session; DECISIONS "M9.3b").**
A Russian Metis-M team (`raschet-metis`: 9P151 launch post, four 9M131, crew of 3) as a unit of its own, opt-in per
scenario with `missileTeams: true` (on in `platoon-vehicles`, `platoon-ru-vehicles`, the app's mounted battle
unless `?missiles=0`; new `bench-missile-team`). Crew-served life shared with the mortars (`crewServed` item block:
packed / setting / ready, pack on move, auto-deploy, post taken over); `systems/missile-team.ts` fires on its own
(anti-tank rule) or on a fire "at" order, guided by missiles.ts from the stored sight point (gunner pinned while
guiding, moves wait). AI: overwatch post (`siteOverwatch`), moves on after each launch, attacker's carriers wait for
it only while it can be set up within 90 s; the attacker's team starts in dead ground. `npm run lab -- missile-team`.
Open (owner): in `platoon-ru-vehicles` the team sets up but fires almost never (Pumas on a reverse slope; Russian
wins 2 -> 0 of 10) — closer posts or a forward move are a tuning question. Fast crossing hulls (>= 10 m/s) beyond
500 m are always missed (shared guidance lag). Not done: a German ground team, tripod sprite, Deploy/Pack buttons.

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
- **Medical care ends at the platoon's Verwundetennest so far:** a man treats himself, a free comrade within 3 m
  treats him (M10.2), or a carer runs over (M10.3a) and under fire gets him into cover within 15 m (M10.3b); squads
  take their wounded into their vehicles (M10.4b); bearers carry casualties back to the nest, where the medic sees to
  them (M10.5), but nobody evacuates them further yet (M10.6); a platoon shot to pieces has nobody left to carry
  (the share reaching the nest by 2400 s is below the plan's 60 % for defenders, see DECISIONS M10.5); the Russians
  have no medic on the map, so their tags are seldom put right; the player has no button yet for "get out with the
  wounded" (an order flag; not in the Wounded tab either: D3); carriers' extra
  tiredness from the load is not modelled (the data's rests stand for it). The Russian defenders' casualties gain little from care (one rifleman-medic per platoon; men
  in houses are not dragged): watch in M10.5 (the medic) and M10.8. Only 54-86 % of the
  casualties who live past 2 minutes get any care in 10-seed batches (plan target 70 %): carers are hit on the way,
  and under fire few are willing; tuning waits for M10.8. Wound values
  are game values (low) reviewed once by the owner (2026-11-11); the medical numbers (`core/medical.json`, mostly
  low, a few medium) wait for his review after M10.8.
- **Attacks rarely win in villages** (5/20) and the Russian mounted attack never does (0/10): accepted for now;
  re-tuning only in the named balance slices (M10.8, D4, M8.5, M9.6).
- **Performance headroom is small:** bench-vehicles sits close to its 8× floor; every medical slice marked [perf]
  measures it alone twice.
- **Phone smoothness unmeasured on a real phone** (the container's software renderer is far slower). D3 built the
  `?perf=1` read-out (Copy sends the numbers) and `npm run phoneperf`; the owner's numbers decide the sim-in-a-worker
  question.
- **Pre-interiors goldens** (`packages/tools/golden/no-interiors/`, six files) have been skipped since 2026-11-13
  (the data changed). The plan proposes deleting them; they are kept untouched until the owner says so (see
  "Open questions").
- Data from search extracts only (web pages cannot be opened here): confidence medium at most, many values low.
- D3 (2026-11-15) closed the UI leftovers (gun on the card, list over the card, no-line-of-fire warning, drag
  ghosts, casualties in the flat look) and moved the roof atlas into a worker; F2 probe (`npm run probe`) and F3 4 km
  numbers in DECISIONS "D3". Open: "get out with the wounded" button.

## Live build
https://j66i5.github.io/TCS/ — deployed automatically from `main` after every merge.

## Open questions for the owner

- M9 owner round answered 2026-11-14 (DECISIONS "Owner answers: M9 round"): night look and goggles as built. Low-confidence M9.1/M9.2 values: thermal heats, sight arcs, who
  carries thermal sights (DE marksman per Trupp, RU platoon commander), blankets issued to nobody; M9.1: the sun table (one date), full-moon light 0.12, flash light 0.8, tracers x3.
- **Pre-interiors goldens:** delete the six skipped files in `packages/tools/golden/no-interiors/` (they have tested
  nothing since 2026-11-13; the plan recommends deleting, and updating the CLAUDE.md note), or keep them?
- Data reviews whenever convenient (lists in the earlier STATE, `docs/history/STATE-until-2026-11-14.md`, "Open
  questions"): Konkurs-M values, vehicle data of M7.1b-M7.4b, behaviour game values, squad tables, ranks and names.
- Realistic ranks (2026-11-15, DECISIONS "Realistic ranks per role", low/medium, search extracts only): one rank per
  slot; DE Puma Kommandant Feldwebel and HQ Puma (Zugtruppfuehrer) Hauptfeldwebel, Sanitaeter Stabsunteroffizier,
  marksman Oberstabsgefreiter (new rank, insignia positions inferred); RU first squad leader = deputy (starshiy
  serzhant). Zugfuehrer Leutnant or Oberleutnant?
- After M10.8: the medical numbers table (keep, adjust named values, or faster care for gameplay).
- D1 (low confidence, for review): the DM45's cloud (10 m, 60 s), smoke grenades per man (one), the screen rules
  (15 m, once a minute, on withdrawals and moves under fire).
- M7.6a tanks (low confidence, for review):
  - Armour: Leopard turret front 850 mm and hull front 640 mm of heavy composite. The T-90M is 550 / 480 mm and the
    T-72B3M 430 / 420 mm of cast armour with filler; hull sides are 80 mm steel.
    - With these values DM63A1 at 2 km gets through the Leopard's own hull front (850 against 800), and 3BM60
      does so from about 1 km.
    - The crew's armour judgement uses hull plates only (as before), so a turret-front hit can be misjudged.
  - Reactive tiles:
    - add values: Relikt +344 / +750 / +312, Kontakt-5 +250 / +625 / +62, trigger 150 mm;
    - coverage and tiles fitted per face, e.g. T-90M turret front 0.85 of 26.
  - Loading and refill: 6 s with 2.5 times that without the loader; autoloader 7 / 7.5 s; refill of the ready rack
    120 s (Leopard) and 240 s (T-90M / T-72B3M).
  - Rounds:
    - 3OF26 is from memory: the search for it was refused.
    - Refleks-M flight: 280 m/s launch, 300 m/s cruise, turn rate.
    - 3BM42 as the T-72B3M's round: its newer autoloader may take 3BM59/60.
    - DM63A1 penetration 680 mm RHA at 2 km.
  - Mobility: reverse speeds (Leopard 31 km/h; T-90M 4.8 and T-72B3M 4.2 km/h on one gear) and pivot rates
    (30 / 20 deg/s).
  - Gunnery: armour-piercing hits 100 % at 3 km on a still hull side-on, which may be too good.
  - Crew personal weapons: a G36 or AK-74M with two magazines (the real MP7 / P8 are not in the data).
  - The 2A8 and Trophy wait for M14.5.
- M10.6-data (low confidence, for review): Boxer ambulance and BMM armour, components, gear bands, reverse speeds,
  steering, ramp and loading times, extinguishers, signatures; the medic's rank and load.
