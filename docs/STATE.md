# State — handover note

_Last updated: 2026-11-11 (M0, M1 and M2 done)._

## Current milestone
**M2 Ballistics and wounds is complete** (M2.1 projectile engine, M2.2 the shooter, M2.3 body, armour and wounds,
M2.4/M2.4b grenades and fragments, M2.5 squads and kit). Next milestone: **M3 Spotting and knowledge** (line of
sight, detection, per-soldier contacts, sharing, fog of war). Propose its slices and ask the owner before starting.

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
- Tests: 289, all green (incl. 48 generated maps checked for validity and plausibility, map determinism, map
  file round trip, terrain damage save/load). 160 of 160 maps (40 seeds × 4 kinds) pass the strict validity
  check after the independent review's fixes. Benchmark ~200× real time.

## What is weak or missing (honest list)
- **Wound values are untested guesses** (all `confidence: "low"`) until the owner has reviewed the casualty lab
  table. No first aid: a bleeding man is never treated (M10). Target movement is not in the aiming error yet
  (needs targets: M3/M4).
  Nobody reacts to being shot at or to casualties (M4); the only reaction is to a grenade landing nearby.
- **Grenade data is unverified**: the search tool declined most look-ups, so DM51, RGD-5, VOG-25 and the
  launchers are from memory of published figures (`confidence: "low"`). **Speed with fragments is at the
  limit**: nine grenades bursting in the same instant cost a stutter of about two frames (see DECISIONS.md). The AI never throws; grenades are not thrown back; a man running from a grenade runs in a straight line.
- Men do not check whether the ground blocks their line of fire (M3); prone men on rolling ground may fire
  into the ground in front of them.
- Soldiers only fire where ordered; the enemy team never shoots (choosing targets is M4).
- The phone top bar wraps onto three rows (interface work is M5).
- Research values come from search extracts, not from reading the pages; confidence medium at best.
- The 8× speed target with 20,000 projectiles is not demonstrated on this machine (about 5.5×).
- Soldiers route around houses, but **houses are solid** (no entering through doors yet). Stress does not yet raise heart rate (M4).
- Anti-tank launchers are carried weight only (M7); belts carried by other men cannot be handed over (M4);
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

## Open questions for the owner
- **Corrections to the two squads** (roles, ranks, weapons, ammunition) whenever the owner wishes.
- (Answered by choosing the research defaults:) squad tables wanted before M2.5: Panzergrenadier dismounts of a Puma and motor-rifle squad on a BMP — per
  man: role, rank, weapon; ammunition and grenades. Public-source research is in `docs/research/squads.md`
  (sources conflict on ranks, the German dismount weapon mix and whether the Russian squad has 8 or 9 men); the
  owner decides.
- Data to review when convenient: rank lists with NATO codes, name lists, female share in generated units.
