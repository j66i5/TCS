# State — handover note

_Last updated: 2026-11-12 (M7.5b Look done; M7.5a UI shell done; M7 Vehicles complete)._

## Current milestone
**M7.5 Look and interface** (plan `docs/plans/m7.5-look.md`), built unattended at the owner's request; the plan's
§7 design questions and the slice's own choices were decided with the recommended options **for the owner's
morning review** (DECISIONS.md "M7.5 design questions decided without the owner" and "M7.5a UI shell").
**M7.5a UI shell ✅:** the battle opens with nothing selected and the order bar greyed; the bar offers only what the
selected unit can do now (`unitCapabilities` → `ordersFor`); it docks to any edge by dragging its grip (remembered
per device), one row on a phone with rare buttons behind "⋯"; a unit sidebar of tiles (symbol, callsign, men fit,
state colour) selects units and opens into a detailed list (always open ≥ 1000 px); labels are placed without
overlaps (`render/src/labels.ts`), a squad beside its vehicle shares its label; zoomed out, vehicles are symbols
(stacked when close) and infantry symbols show only men on foot; appearance data (`appearance.json`, outside the
catalog) gives vehicle paint now and uniforms/palette for M7.5b. Presentation only: goldens untouched.
Screenshots: `npm run screenshot -- --scene ui`.
**M7.5b Look ✅:** zoom levels (`render/src/lod.ts`: symbols < 1.2 px/m, dots, pixel figures from 5, close from
16 with every roof lifted; 10 % hysteresis); the battle opens at 8 px/m on the lead squad; the camera never zooms
out past the whole map; ORIGINAL 16 × 16 pixel soldiers (11 frames, weapon variants, firing flash, launcher on the
back, wounded, down, dead, surrendered, captive; 16 pre-rotated facings; faction palette swap; blue/red outline);
the flat pixel map (flat palette, wobbled cell edges, seams, pixel tree crowns, rasterised roads/water/hedges,
contours only zoomed out, close detail tiles); buildings as floors under the men and roofs above them that fade
near own men or close up; one-row top bar with "⋯" and a compact status line (parent review). Old look behind
`?look=classic`. Presentation only: goldens untouched. Screenshots `npm run screenshot -- --scene look`.
Decisions for the morning review: DECISIONS.md "M7.5b Look". **Next: M7.5c Interiors** (map format v2, goldens
regenerated once with an equivalence proof).

Before M7.5 (M7 summary):
**M7 Vehicles is done** (plan `docs/plans/m7-vehicles.md`; M7.1a–c, M7.2, M7.3, M7.4a, **M7.4b**) —
vehicles drive on routed paths (clearance grids, flattening fences and hedges, going round walls), yield to each
other, make their own men step aside and run over enemies (owner Q4), stop rounds and block sight; they are drawn
at true size and can be ordered (move, halt, reverse legs). **M7.2:** squads get in and out (Mount / Dismount
orders and buttons, one man per door at a time, the vehicle waiting; two men carry a wounded comrade in from near
the ramp; an order to a squad aboard is carried out after it gets out; men refill magazines from a stopped
vehicle; a crewman takes over a fallen driver's seat); the platoon battle can start mounted with **`&vehicles=1`**
(tools: `platoon-vehicles`, `platoon-ru-vehicles`): the attacker rides in from its edge and the AI gets its
squads out 300 m (German) / 400 m (Russian) short of the objectives, out of sight where it can, at once when a
vehicle is hit, and gets them back in when it withdraws. The default battle stays on foot until M7.4a (owner
Q26). **M7.3:** turrets lay and fire the 30 mm cannon (AP/HE) and the coaxial machine gun with counted ready
belts, refilled from stowage when halted (owner Q17: both vehicles, ~90 s); crews pick targets under their own
fire rules (a cease-fire to a squad does not silence its IFV); 30 mm HE bursts on a man it strikes (Q18); fire
orders with a choice of round, smoke dischargers; crews observe through seat sights, vehicles are spotted by
their visible area, heard by their engines (rain, wind), shown under fog as hull outlines with their type within
1.5 km (Q6); thermal sights see through ordinary smoke at half strength (Q7); after the dismount the AI's Pumas
overwatch and its BMP-2s follow 150 m behind, both supporting the assault by fire; AAR and batch count
ammunition by source; gunnery lab (`npm run lab -- gunnery`). **M7.4a:** armour plates per part and face
(Puma front stops 30 mm and — owner Q21 b — a single PG-7VL; BMP-2 stops rifle AP at the sides, nothing heavier),
penetration (kinetic by speed, shaped charges by jet, impact HE holes thin roofs and breaks tracks), damage inside
along the path plus a fragment cone (Q11: men wounded, engine/tracks/gun/ammunition/fuel damaged), immobilised /
disarmed / burning / destroyed (cook-off, burnt out) / abandoned; the crew fights on immobilised while hits bounce
off and bails out with its passengers when penetrated again or burning (Q14/Q15); wrecks known to both sides (Q8),
in the nav grids and the result; points 20 / 10 (Q9); Panzerfaust 3 and RPG-7 fired on order (the "Anti-tank"
button) or on their own per the unit's anti-tank rule (Q19, Rules panel; default "vehicles only"), not from a small
unbreached room, with a wall right behind or a comrade in the danger zone (Q20); rocket flight with motor and
self-destruct; armour and anti-tank labs (`npm run lab -- armour|antitank`). **The platoon battle now starts mounted
by default** (Q26; `&vehicles=0` for the battle on foot; tools `platoon`/`platoon-ru` stay infantry).
**M7.4b:** the full component table (transmission, turret drive, stabiliser, coax, sights, radio, dischargers,
extinguisher — each with its effect), extinguishers with counted charges, crews that reverse out behind smoke when
penetrated or struck by a rocket, crews that bailed out become foot units you can order, men take ammunition from
abandoned hulls of either side, the AI gives anti-tank tasks (shots at known vehicles in range, a step aside out of
the danger zone, two hunters after halted vehicles), gets out at once on an anti-tank threat and reverses out on
withdrawal; active protection and add-on tiles on the fixture; wrecks and vehicle records round-trip.
M7 deferred items: DECISIONS.md (M7.1c part 3,
M7.2 parts 1–3, M7.3, M7.4a, M7.4b).

## What works
- **M0 foundations** (see ARCHITECTURE.md): deterministic 60 Hz simulation, seeded RNG streams, serialisable
  state + hash, orders through a comms model with delay, event stream, counted items and transfer,
  interruptible actions, wound/physiology interfaces, battle-as-a-function, save games with controller memory,
  data packs with validating loader and linter, fixture faction, headless/batch/golden/screenshot tools, CI.
- **M1.1 terrain**:
  - Terrain data in `packages/data/core/terrain/` (materials, surfaces, vegetation, obstacle kinds, building
    kinds) with movement costs per class (foot/wheeled/tracked), concealment, bullet stopping, colours.
  - Map model: heightfield, surface and vegetation grids (4 m cells), walls/hedges/fences/embankments,
    buildings (material, thickness, storeys, doors, windows), roads, streams, ponds. Map file format with exact
    round trip; map fingerprint checked when a save is loaded; terrain damage stored in battle state.
  - Generator for four kinds: **village** (street or clustered, chosen by seed), **woodland edge**,
    **farmland**, **industrial**; 2 × 2 km default; 50–150 ms per map; all generated maps pass validity checks.
  - Naturalistic renderer: blended ground colours, tree crowns, orchards, hill shading, contour lines, roads,
    hedges, walls, fences, buildings with roofs and shadows.
  - App: `?map=village|woodland|farmland|industrial|flat&seed=N`, a map button that cycles kinds, start view
    centred on your team.
- **M1.2 navigation**: 2 m navigation grid from the terrain; routes go round houses, through gates (or over
  walls when that is quicker), along roads, around ponds; slower in woods and ploughed fields; "no route"
  reported by radio; debug view shows the grid (red blocked, orange walls, yellow slow) and routes. Long route
  on a 2 km map ~30 ms; unreachable goals rejected at once; benchmark ~42–51× real time. Independent review found 6 navigation defects (one put followers inside houses); all fixed with tests.
- **M1.3 body**: postures (standing/crouching/prone) that take time to change, slower with load; speed from
  pace, posture, slope (Tobler), load, fatigue and ground; fatigue and heart rate rise with effort, load, uphill
  and heat and recover at rest; movement lab (`npm run lab -- movement`) with checked bands; posture and 4-pace
  buttons; debug labels show fatigue and heart rate. (Loads are itemised since M2.5.)
- **M1.4 formations**: wedge/file/line from data; ~10 m spacing; routes prefer cover (balanced); followers keep
  their slot; at the halt each man takes the best cover within 15 m, goes prone and faces outward; formation
  button; zoomed far out, units show as infantry symbols. Cover effect is modest on open farmland (see
  DECISIONS.md).
- **M2.1 projectile engine**: bullets as real objects (typed arrays) with drag fitted to published velocity
  tables, gravity, air density from temperature; hits on ground, walls, hedges, house walls (doors and windows
  open), chance of being stopped in vegetation; penetration and ricochet per material from published norms;
  impact events; tracers drawn clearly, other bullets very faintly, impact puffs. Cover lab
  (`npm run lab -- cover`) reproduces the public figures for 5.56 and 5.45 mm (7.62 mm has no measured anchor). G36 + DM11/DM21 and AK-74M + 7N10/7T3 in the data.
  20,000 live bullets + 304 soldiers: about 5.5× real time here since bodies and roofs are tested (floor 3×, target 8×; see DECISIONS.md).
- Research files: `docs/research/ballistics.md` (used) and `docs/research/squads.md` (for the owner's review).
- **M2.2 the shooter**: soldiers carry a rifle and magazines (G36 x5, AK-74 x6); `fire` and `ceaseFire` orders;
  rounds counted out of magazines, reloads and stoppages as timed actions, empties kept, last magazine held
  back, top-up in lulls; rate of fire by range; aiming error from skill, posture, fatigue, pulse, sight and
  rate of fire; the unit slows and ceases fire by itself when nothing comes back; muzzle flashes; "tap: fire"
  and "cease fire" buttons. Firing range lab (`npm run lab -- range`): regular, prone, 300 m: G36 60 %,
  AK-74M 49 %.
- **M2.3 body, armour and wounds**: bullets strike bodies (zones by posture: legs, pelvis, abdomen, chest, arms,
  neck, head); helmet and vest are items with coverage and protection; a plate hit knocks the man down and
  bruises him; other hits make wound records (severity, bleeding, breathing/airway); a simple physiology runs the
  bleeding clock; the wounded carry on impaired (slower, crawl only, worse aim, cannot use the rifle); the
  unconscious and the dead stay on the map with their own symbols; the next man takes over a fallen leader and
  "man down" is reported; friendly fire is real. Casualty lab (`npm run lab -- casualty`): at 100 m from the
  front, plates save about half the men struck; of the wounded about 1 in 7 dies at once, 4 in 10 within the
  hour without care.
- **M2.4 grenades and fragments**: hand grenades (DM51, RGD-5) thrown as a timed action, 40 mm rounds from
  under-barrel launchers (AG36, GP-25); time and impact fuses, arming distance, duds; bursts with blast by
  distance (wound close in, stun to about 10 m, walls shield), thousands of fragments as real projectiles,
  craters, holes blown in thin walls (bullets and routes then pass); roofs stop or are pierced; a "tap: grenade"
  button; fragmentation lab (`npm run lab -- fragmentation`).
- **M2.4b (owner requests)**: grenades bounce and roll; the thrower picks a flat, lobbed or high throw that is
  clear (works indoors and through openings); small folds in the ground stop low fragments, so lying down
  protects more; an order can ask for several grenades, thrown a moment apart ("tap: all grenades"); men near a
  landing grenade drop flat, or run from it if it is within 3 m.
- **M2.5 squads and kit**: the demo and the app start with a German Puma dismount squad (G36, MG5, G28,
  Panzerfaust 3 carried, AG36) and a Russian BMP motor-rifle squad (AK-74M, PKP, RPG-7 carried, two GP-25), six
  men each, with itemised loads of 24-44 kg; machine guns fire five-round bursts from belts with a tracer every
  fifth round; the marksman rifle has a telescopic sight.
- **Scripted shoot-out** (`npm run headless -- --scenario shootout`): the two squads 250 m apart fire at each
  other under a fixed script; it is a golden replay and a test (about 1,000 rounds, both grenades, casualties).
- **M2 completion**: aiming time (first shots hurried) and bracing on cover in the aiming error; bullets go
  through a body, slowed, and can hit the man behind; G95A1 and AK-12 as data (not issued by default); cover
  rows in the fragmentation lab.
- **M3.1 line of sight**: sight lines over hills, walls (openings let sight through), see-through fences and
  hedges, roofs and vegetation (`npm run lab -- sight`); men no longer fire into a bank in front of them —
  they kneel or stand to fire over it, or hold fire and report "no line of fire"; Debug shows what the
  selected unit's leader can see.
- **M3.2 detection**: every man scans for enemies once a second; the chance depends on range, posture,
  movement, firing, what is in the way, where he looks, his optic and skill (`npm run lab -- spotting`:
  standing still at 300 m spotted in a median 9 s; lying still in crops at 100 m never in 40 runs; crawling
  there 9 s; firing 1 s). Debug draws who sees whom.
- **M3.3 contacts**: each man remembers what he has seen, heard (direction and a rough distance of shots) or
  been told of each enemy; he passes it on by voice nearby and by radio with a delay; the unit calls contacts
  out on the radio log; a fire order can name an enemy, and each man aims where he believes him to be.
- **M3.4 fog of war**: you see the enemy only as your men know him — solid diamonds where he is in sight,
  hollow ones where he was last seen or reported, rings for the sound of shots; old contacts fade; Debug shows
  everything. Tapping an enemy marker in fire mode fires at that contact.
- **M4.1 suppression and morale**: enemy rounds cracking past or striking near a man suppress him (bursts a lot);
  pinned men drop flat, stop and fire less (yellow ring), stress from fire, fallen comrades, a fallen leader and
  wounds, damped by experience and a leader nearby; shaken men fire less, panicked men lie flat and do not fire
  (red ring); suppression lab (`npm run lab -- suppression`).
- **M4.2 soldier decisions**: fire rules per unit (free / return / hold; `rules` order), men open fire on their
  own at enemies they see, run to cover from the known threat when under fire, hand over magazines and belts;
  Debug shows each man's decision as a line.
- **M4.3 squad drills**: units halt and go down on contact; `assault` and `withdraw` orders bound by halves
  with covering fire; a unit breaks when half its men panic, runs back and rallies.
- **M4.4 doctrine and attack lab**: drill values from faction doctrine; `npm run lab -- attack` shows an
  unsupported squad attack across the open failing every time, a supported one succeeding about 40 %.
- **M5.1/M5.2 orders and interface**: drag the formation marker (shape, facing arrow, width handle), routes
  with pace per leg, order bar with assault / withdraw / fire / grenades / halt / cease fire / posture, rules
  panel (fire, range limit, on contact, ammunition) with the unit's state; pause with orders; phone layout.
- **M6 first playable**: objectives and victory (held at the end minus losses; early loss when a side breaks or
  is wiped out), platoon templates, scenario format and generator (`buildScenario`), AI commander for defence
  and attack, app battle with side/attacker choice, save/load, after-action review (casualties, timeline, heat
  map), AI-versus-AI batches (`npm run batch -- --scenario platoon` / `platoon-ru`): the defender wins 20 of 20
  each way.
- **M7.2 passengers**: mount/dismount orders with exit queues and the hull holding; orders to a squad aboard
  (out first, owner Q12); casualty loading within 5 m of the ramp (Q25); `radio.noSeats`; seat swap after 20 s;
  refill from the vehicle's stowage (`transferItems`); intercom; surrender gated aboard; platoon templates with
  crews and `carriage` (four Pumas with the HQ in the fourth, Q1; three BMP-2s with the commander in the first,
  Q2); mounted start behind `&vehicles=1`; AI ride, dismount (doctrine distances, Q22), re-mount on withdrawal
  within 100 m (Q24), dismount near an objective it holds; mount lab (`npm run lab -- mount`); "+n" aboard by
  each hull, a second tap on a hull selects the squad riding in it.
- **M7.3 guns and senses**: `systems/gunnery.ts` (turret lay, station fire, target choice with `why` keys,
  refill, smoke), crew seat sensors and vehicle targets in spotting, vehicle contacts and engine hearing,
  `fire`(+`nature`)/`discharge` orders and `not-applicable`, expenditure tally, vehicle debug overlay, Gun/Smoke
  buttons; scenario `bench-combined`; `sight()` and the path search made faster (identical results).
- **M7.4a armour and anti-tank**: `systems/armour.ts` (plates, penetration, inside, outcome, bail-out, wrecks),
  `systems/launcher.ts` (Panzerfaust/RPG, `atRule`, back-blast), `flight.ts` (shared rocket flight), vehicle points,
  AAR vehicle lines and anti-tank expenditure, Rules panel "Anti-tank weapons", "Anti-tank" order button; mounted
  platoon battle by default. Batch (10 × 900 s): Germany attacks mounted red 7/10 (BMP-2s lost 2.4 of 3), Russia
  attacks mounted blue 10/10; infantry battles unchanged.
- **M7.4b components and reactions**: `crewReactionSystem`, extinguisher (`tryExtinguish`), `compCondition`,
  `weaponOut`, radio comms rule, `Unit.exVehicle`, cross-loading, APS/tiles (fixture `xf-wagon`), AI anti-tank tasks,
  batch crew columns, vehicle panel parts, `--scene vehicles` anti-tank screenshots. Batch (10 × 900 s): Germany
  attacks mounted red 6/10, anti-tank rounds 1.5 / 1.7 per battle (was 0.2 / 0); Russia attacks blue 10/10, 0.9 / 2.1
  (was 0 / 0.9); infantry unchanged. Schema 17.
- **M6.5 attack balance**: two platoons attack one; AI sneaks up, splits fire and assault, throws grenades,
  calls mortars; Mortar and Smoke orders for the player (rounds land after 75-90 s; smoke blocks sight).
- Tests: 559 (550 + 9 timing), all green (incl. 48 generated maps checked for validity and plausibility, map determinism, map
  file round trip, terrain damage save/load). 160 of 160 maps (40 seeds × 4 kinds) pass the strict validity
  check after the independent review's fixes. Benchmark (304 men moving, out of view) about 18× real time; 304 men in view of each other, all firing, about 14×.

## What is weak or missing (honest list)
- **Wound values are untested guesses** (all `confidence: "low"`) until the owner has reviewed the casualty lab
  table. No first aid: a bleeding man is never treated (M10). Target movement is not in the aiming error yet
  (needs targets: M3/M4).
  Nobody reacts to being shot at or to casualties (M4); the only reaction is to a grenade landing nearby.
- **Grenade data is unverified**: the search tool declined most look-ups, so DM51, RGD-5, VOG-25 and the
  launchers are from memory of published figures (`confidence: "low"`). **Speed with fragments is at the
  limit**: nine grenades bursting in the same instant cost a stutter of about two frames (see DECISIONS.md). The AI never throws; grenades are not thrown back; a man running from a grenade runs in a straight line.
- Soldiers only fire where ordered; the enemy team never shoots (choosing targets is M4).
- The phone top bar wraps onto three rows (interface work is M5).
- Research values come from search extracts, not from reading the pages; confidence medium at best.
- The 8× speed target with 20,000 projectiles is not demonstrated on this machine (about 5.5×).
- Soldiers route around houses, but **houses are solid** (no entering through doors yet). Stress does not yet raise heart rate (M4).
- Anti-tank fire is still modest (about 1–2 rockets per side per 15-minute battle): the BMP-2s die early to the
  Pumas' cannon, and RPGs mostly meet the Puma's front, which stops them (owner Q21 b). Belts carried by other men
  cannot be handed over (M4);
  kit masses (water, webbing, ...) are typical values, not sourced.
- Routes prefer roads only mildly (asphalt is 10 % quicker than grass) and cover only modestly (balanced
  preference; see DECISIONS.md, M1.4) — the owner may choose to strengthen it.
- **Industrial maps are the plainest**: sparse business-park lots with a few sheds and warehouses each.
- Wood edges and scrub still show a faint 4 m grid pattern when zoomed in close.
- The map kinds' recipes are code (they name terrain IDs); terrain *properties* are data. See DECISIONS.md.
- The two squads are research defaults awaiting the owner's corrections; ranks per position are guesses;
  doctrine values are still placeholders (low confidence).

## Live build
https://j66i5.github.io/TCS/ — deployed automatically from `main` after every merge (first successful deploy
2026-11-11, after the owner enabled GitHub Pages with source "GitHub Actions").

## Answered by the owner (2026-11-11)
- First squads: German **Panzergrenadier dismounts of a Puma**; Russian **motor-rifle squad on a BMP**.
- Callsigns: German **"Gruppe {n}"** (squad) and **"Trupp {n}"** (team); Russian "Gruppa {n}" kept for now.
- Map look **naturalistic**; villages **mixed street/clustered**; default map **2 × 2 km**.

- M1.3: posture change time **depends on load**; fatigue **winded after 2–3 min running**, ~5 min to recover;
  **load slows and tires men from now**.

- M2 planning: owner **dictates the squad tables**; **G36** and **AK-74M** default rifles; **helmet + plates**;
  **realistic bleeding clock**; **realistic lethality mix**; **tracers clear, other bullets very faint**;
  cover preference stays **balanced**.

- M2.3: **helmets stop fragments, not rifle rounds**; a round stopped by a plate **knocks down and bruises**; a
  wounded man who still can **carries on, impaired**.

- M2.3 review: lethality **about right**; wounded who keep fighting **fine for now**.
- M2.4: Russian default hand grenade **RGD-5**; throw **about 30 m standing**; a close burst that does not wound
  **stuns briefly** (blast injury within a few metres). Fragmentation lab reviewed: **about right**.
- M2.4b: fix all four weak points; a man near a landing grenade **drops flat, or runs if it is very close**.
- M2.5 squads: **research defaults** for both sides (see DECISIONS.md), to be corrected by the owner afterwards.

- Prone throw **15 m**, grenade safety distance **8 m**.

## Next
**M3 Spotting and knowledge** — propose slices, ask the owner's questions, then start when he says so.

## Reminders for the owner
- (Answered at the M6 review, 2026-11-12: fog of war stays "what your men have reported"; medical after vehicles.)

## Open questions for the owner
- **Corrections to the two squads** (roles, ranks, weapons, ammunition) whenever the owner wishes.
- (Answered by choosing the research defaults:) squad tables wanted before M2.5: Panzergrenadier dismounts of a Puma and motor-rifle squad on a BMP — per
  man: role, rank, weapon; ammunition and grenades. Public-source research is in `docs/research/squads.md`
  (sources conflict on ranks, the German dismount weapon mix and whether the Russian squad has 8 or 9 men); the
  owner decides.
- Data to review when convenient: rank lists with NATO codes, name lists, female share in generated units.
- **New low-confidence data (M4):** `core/behaviour.json` (suppression, stress, decisions, drills — game values
  tuned with the suppression and attack labs) and the doctrine keys `boundM` / `finalAssaultM`, identical for
  Germany and Russia for lack of a public source on a difference.
- **New data (M7.4b), for review (game values):** the new component boxes of the Puma and BMP-2; extinguishers (Puma
  2 charges, 1 s, 70 %; BMP-2 2 charges, 2 s, 40 %); `core/behaviour.json` `crew` reaction values (1 s, recent hit
  3 s, reverse 60 m, hold 30 s, infantry threat 150 m); the AI's anti-tank values (COMMANDER in `ai/commander.ts`).
  Decided without the owner (DECISIONS.md "M7.4b"): a crew reverses out also when a rocket bounces off; a bailed-out
  crew becomes a foot unit; men may take ammunition from abandoned enemy hulls; the AI gets out on enemy men within
  400 m or an enemy vehicle within 600 m (not at any range).
- **New data (M7.4a), for review (game values unless marked):** armour plates of the Puma (owner Q21 b: front 150 /
  140 mm composite at 60°) and the BMP-2 (published thicknesses simplified, low); components (boxes, toughness,
  fire and cook-off chances); `core/ballistics.json` `armour` (LOS floor, graze fuse, jet decay 400 mm/m, spall
  damage, seat box); `core/behaviour.json` `antitank` (default rule, 6 s, range error 5 %, 2.5 mrad, room 60 m²,
  wall 2 m, hand-over 30 m) and `crew` (bail 2 s after fire, burn-out 120 s, cook-off 8 %/5 s, burns 0.7–1.0);
  PG-7VL and Panzerfaust 3 DM12 (penetration, speeds, masses medium from search extracts; motor, drag, dispersion
  low); PMC287/3UBR8 ricochet factors and spall. Decided without the owner: a crew also bails out when its vehicle
  can neither move nor fire, or when no crewman can act.
- **New data (M7.3), for review (all game values unless marked):** MK30-2 (200 rpm S), 2A42 (550 rpm S), coax
  MG5 / PKT; PMC287 (1405 m/s S; 106 mm RHA at 1000 m → 132.5 mild-steel mm), Puma impact HE (Q16), 3UBR8
  (1120 m/s S; 50 mm RHA at 1500 m → 62.5), 3UOF8 (960 m/s, 389 g S); belts (Puma 100 AP + 100 HE ready and as
  many stowed, coax 1000 + 1000; BMP-2 160 AP + 340 HE ready (S total 500), PKT 250 + 7 × 250 stowed (S 2000));
  smoke dischargers (Puma 4 × 4 of 76 mm, BMP-2 6 of 81 mm (S)); seat sights, arcs, sensor factors and smoke
  factors (`core/spotting.json`), vehicle signature (area from the boxes, ×4 moving, ×15 firing, type told
  within 1.5 km, engine 400/1200 m), `core/behaviour.json` `gunnery`, heavy-round wounding (≥ 12.5 mm,
  severity ≥ 0.85), doctrine `dismount.afterward` (DE overwatch, RU follow 150 m: research file, low). The
  driver does not search for the enemy (buttoned up, Q5).
- **New data (M7.2), for review:** `core/behaviour.json` `mounting` (reach, timings, 100 m re-mount and hold
  distances, refill of 3 magazines; game values, low); vehicle stowage (Puma 20 G36 magazines, 6 MG5 belts,
  4 G28 magazines; BMP-2 24 AK-74 magazines, 6 PKP belts; low); crews carry a rifle with 3 magazines, helmet and
  vest (low); `doctrine.json` `dismount.distanceM` Russia 400 m (medium), Germany 300 m (low, no published figure).
  Decided without the owner (plan's recommended options): Q13 a crewman (not a passenger) takes over a fallen
  driver or gunner after about 20 s; an order to a platoon with vehicles moves the vehicles (squads ride along).
- **New low-confidence data (M7.1b vehicles):** `factions/de/vehicles.json` (Puma) and `factions/ru/vehicles.json`
  (BMP-2): power, mass, top speed, crew/passenger counts and the BMP-2 turret rates are sourced (medium); hull
  boxes, gear bands, reverse speeds, braking, steering, fuel capacity and use, ramp times and station errors are
  game values (low), held in bands by `npm run lab -- drive`. Vehicle blocks of `core/terrain/surfaces.json`
  (rolling resistance, traction, rain factors) and `obstacles.json` (crossing per class, following the owner's
  answer: fences, hedges and wire flattened, brick and stone walls driven round). Crew templates
  `puma-besatzung` / `bmp2-ekipazh` and their roles and ranks. `rhaToMildSteel` 1.25 and materials
  `armour-steel`, `composite`.
