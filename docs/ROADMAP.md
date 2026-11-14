# Roadmap

Milestones from SPEC section 11 with acceptance criteria and status. Each milestone is split into slices of
one session; slices are proposed at the start of each milestone. Every milestone ends with all checks
passing, a deployed build, updated documents and a plain-language summary for the owner.

Status: ✅ done · 🔨 in progress · ⏳ next · ⬜ not started

## Stage A — foundations

### M0 Bootstrap — ✅ done (live at https://j66i5.github.io/TCS/)
Repository, tooling, CI, deployment, documents, simulation loop with seeded randomness, serialisable state,
order interface, event stream, determinism test, headless runner, an app page showing a moving dot driven
by the simulation.

Acceptance:
- [x] the deployed URL works on a phone — deploy job green on 2026-11-11; the owner to confirm on his phone
- [x] the determinism test passes (`packages/tools/test/determinism.test.ts`, incl. mid-battle save)
- [x] the fixture-faction loader test exists (`packages/tools/test/fixture-faction.test.ts`)

Slices: M0.1 (this session) — everything above in one slice.

### M1 Map and movement — ✅ done (M1.1–M1.4)
Heightfield, terrain layers, procedural test maps, pathfinding, soldiers with postures and fatigue, squads in
formation, camera and zoom, first order (move).
Acceptance: a squad crosses a generated village map choosing covered routes; movement lab passes.

Proposed slices (to confirm at the start of M1):
1. ✅ **M1.1 Terrain model and generator** (2026-11-11) — heightfield, surface/vegetation/obstacle/building/road/water
   layers and materials as data; procedural generator for village, woodland edge, farmland, industrial;
   terrain drawn in the renderer; map format (JSON + heightmap image) with save/load. Destructible-terrain
   state stored as data.
2. ✅ **M1.2 Navigation** (2026-11-11) — navigation grid with costs per movement mode (walk, run, sneak, crawl; wheeled and
   tracked reserved), A* pathfinding, spatial hash for neighbourhood queries, path debug overlay.
3. ✅ **M1.3 The individual soldier moving** (2026-11-11) — postures with change times; speed from mode, slope, surface and
   load mass; fatigue and heart rate rising and recovering (reading temperature from the environment);
   movement & fatigue lab with tables.
4. ✅ **M1.4 Squads in formation** (2026-11-11) — formations as data, men choosing covered positions near their slot,
   waypoint chains with a mode per leg, camera zoom levels (close / tactical / overview). Acceptance demo:
   squad crosses the village on covered routes; screenshots.

Owner decision (2026-11-11): first squads are German Panzergrenadier dismounts of a Puma and a Russian
motor-rifle squad on a BMP; German callsigns "Gruppe {n}" / "Trupp {n}".

### M2 Ballistics and wounds — ✅ done (M2.1–M2.5, 2026-11-11)
Projectiles, materials and penetration, fragments, body zones, armour, wound records with simple physiology,
small arms and grenades for both factions.
Acceptance: firing range, cover and fragmentation labs produce plausible tables; performance floor holds
with 20,000 projectiles.

Slices (planned 2026-11-11; owner decisions in DECISIONS.md):
1. ✅ **M2.1 Projectile engine** (2026-11-11) — weapon and ammunition data format (one researched rifle and its
   cartridge per side to start); projectiles in typed-array pools (no per-tick allocation); flight with drag
   and gravity; swept tests against ground, walls, hedges, buildings and vegetation; penetration by material and
   thickness with energy loss; ricochet by angle and hardness; impact events; tracer and faint-bullet drawing;
   **cover lab** (penetration by material and thickness); benchmark with 20,000 live projectiles and the
   performance floor re-baselined. No one is hurt yet: bullets pass through people.
2. ✅ **M2.2 The shooter** (2026-11-11) — weapon handling: fire modes, cyclic rate, rounds drawn from counted magazines, reload
   as an interruptible action, jams; aiming error from skill, fatigue, heart rate, posture, bracing, aiming
   time, target movement and range estimation, combined with weapon dispersion (no hit tables); a minimal
   "fire at point" order; muzzle flash and shot events; **firing range lab** (hit rates by range, posture,
   fatigue against target boards).
3. ✅ **M2.3 Body, armour and wounds** (2026-11-11) — hit zones with exposed area by posture and facing; helmet and plate
   coverage and protection levels as items; wound records (zone, mechanism, severity, bleeding); the simple
   time-stepped physiology on a realistic clock; capabilities (walk, use arms, fight, speak); casualties stay
   in the world as entities; friendly fire; **casualty lab** (wound distribution, killed/incapacitated/wounded
   mix, time to incapacitation) — table shown to the owner for review.
4. ✅ **M2.4 Grenades and fragments** (2026-11-11) — hand grenades (throw as an action), 40 mm and under-barrel grenade
   launchers; fuses; fragments spawned as projectiles with a velocity spread; blast by distance with shielding
   by obstacles; craters and wall breaches written to terrain damage (and read by navigation);
   **fragmentation lab** (casualty radius by posture and cover); 20,000-fragment benchmark.
5. ✅ **M2.5 Squads and kit data** (2026-11-11; G95A1 and AK-12 added in the M2 completion, anti-tank launchers carried only) — the owner's squad tables for the Puma Panzergrenadier dismounts and the BMP
   motor-rifle squad; rifles (G36 default, G95A1; AK-74M default, AK-12), machine guns, marksman rifles,
   grenade launchers, grenades, magazines and belts, helmets and plate carriers, each with sources and
   confidence; itemised loads replace the 24 kg placeholder; DATA_GUIDE sections for weapons and ammunition;
   demo: two real squads on a village map with a firing-range style shoot-out under scripted orders.

6. ✅ **M2 completion** (2026-11-11, owner request) — aiming time and bracing in the aiming error, bullets
   through bodies, G95A1 and AK-12, cover rows in the fragmentation lab, the scripted shoot-out. Not possible
   before M3/M4: target movement in the aiming error.

Needed from the owner: the two squad tables (roles, ranks, weapons; ammunition loads if he wants to set them)
before M2.5; review of the casualty lab table after M2.3.

### M3 Spotting and knowledge — ✅ done (M3.1–M3.4, 2026-11-11)
Line of sight, detection, per-soldier contacts, sharing, fog of war in the renderer.
Acceptance: spotting lab passes; the player view shows only reported contacts.

Slices (planned 2026-11-11; owner answers in DECISIONS.md):
1. ✅ **M3.1 Line of sight and line of fire** (2026-11-11) — 3D sight lines over the heightfield, walls (openings let sight
   through), roofs, vegetation concealment accumulating along the line; men do not fire into ground in front
   of them; line-of-sight lab; debug view of what the selected man can see.
2. ✅ **M3.2 Detection** (2026-11-11) — probabilistic per observer and target per interval from range, posture, movement,
   firing, concealment, light, sensor (data), look direction and stress; spotting lab with the owner's anchors.
3. ✅ **M3.3 Contacts and sharing** (2026-11-11) — per-soldier contacts (seen / heard, confidence, age), sharing by voice and
   radio through the comms model, call-outs in the radio log, fire orders at a contact.
4. ✅ **M3.4 Fog of war** (2026-11-11) — the player sees only what his men have reported, fading with age; debug shows all;
   screenshots.

### M4 Soldier and squad behaviour — ✅
Suppression, morale, cover use, fire discipline, ammunition sharing, casualty reaction, drills, doctrine
profiles. Slices (planned 2026-11-11, owner asleep — taken as recommended, for his review):
- **M4.1 Suppression and morale** ✅ — rounds cracking past or striking near a man raise his suppression; it
  worsens his aim, pins him (prone, stops, fires less) and raises stress; stress also from comrades falling,
  losing the leader, own wounds, damped by experience and a leader nearby; states steady / cautious / shaken /
  pinned / panicked; `npm run lab -- suppression`.
- **M4.2 Soldier decisions** ✅ — fire rules per unit (free / return / hold, `rules` order), own fire at seen
  enemies with target choice, cover from the known threat when under fire, ammunition hand-over (also belts),
  debug overlay of decisions. Casualty care (dragging, first aid) moved to the medical system.
- **M4.3 Squad drills** ✅ — reaction to contact, `assault` order (two halves bounding, one firing), `withdraw`
  order (bounding back under covering fire), all together onto the objective / rally point at the end; a unit
  breaks when half its men panic, runs back and rallies when quiet.
- **M4.4 Doctrine profiles and batch** ✅ — drill values from faction doctrine (`boundM`, `finalAssaultM`; the
  same for both sides until a public source gives a difference); attack lab (`npm run lab -- attack`): one squad
  across 300 m of open ground against a squad behind a wall fails every time; with a second squad firing in
  support it succeeds in about 40 %.
Acceptance: batch runs of squad against squad produce varied, believable outcomes; debug overlay explains
decisions; attackers in the open against a prepared defence lose most of the time.

### M5 Orders and interface — ✅
Full order set, waypoints, standing rules, unit panels, radio log, time controls, touch controls.
Slices (owner answers 2026-11-12):
- **M5.1 Orders in the simulation** ✅ — `rules` order with engagement range limit, stance on contact (go to
  ground / push on / fall back) and ammunition discipline; move orders carry facing and frontage (the
  formation is laid out at the destination).
- **M5.2 Interface** ✅ — draggable formation marker (shape of the formation, arrow to turn it, handle to
  widen it), multi-point routes with pace per leg, order bar (move, assault, withdraw, fire, grenade, all
  grenades, halt, cease fire, posture, rules), rules panel with the unit's state, pause / 1x / 2x / 4x with
  orders while paused, phone layout.
- **M5.3 Review and polish** ✅ — independent review, eight findings fixed; the owner tries it on his phone.
Acceptance: the owner can fight a squad action on his phone without a manual.

### M6 Opposing commander and scenarios — ✅ (reviewed by the owner 2026-11-12)
Objectives, scenario format and generator, commander AI for both postures, after-action review, save and load.
Slices (owner answers 2026-11-12):
- **M6.1 Objectives and victory** ✅ — objective areas held / contested; score = objectives held at the end
  minus 5 per man down; a side that breaks or is wiped out loses at once; winner in the battle result.
- **M6.2 Platoons and generator** ✅ — platoon templates (Germany: Zugfuehrer, Funker, three Schuetzentrupps;
  Russia: platoon commander, three squads); `ScenarioDef` (plain data) and `buildScenario`: platoon attack
  against a platoon holding two objectives on a generated map, either side attacking.
- **M6.3 Commander AI** ✅ — doctrinal and cautious, defence and attack (`@tcs/ai` `commanderController`).
- **M6.4 First playable** ✅ — the app starts the platoon battle (`?side=`, `?attacker=`, `?map=`, `?seed=`),
  the AI commands the other side; objectives and score on the map; save and load; after-action review
  (result, casualty lists, timeline, heat map); AI-versus-AI batch (`npm run batch -- --scenario platoon`).
Acceptance: **first playable** — a generated platoon-level infantry battle, Germany against Russia, either
side playable, AI-versus-AI batch report available.

**Stop after M6 for a review with the owner** (is it fun, what is wrong, what to change before adding breadth;
also: pull the medical system forward or not; **owner asked to be reminded (2026-11-11): fog of war "only what
reached the squad leader"** instead of "what your men have reported" — see DECISIONS.md, M3.4).

### M6.5 Attack balance — ✅ partly (owner, M6 review; Russian attack still 0 of 10, owner to decide)
The AI attack never succeeded against the AI defence (40 of 40). All three remedies:
- **M6.5a More attackers** — two platoons attack one (scenario generator; the AI commander leads both).
- **M6.5b Better attack tactics** — covered approach routes, crawling the last stretch, fire support closer and
  at known enemies, grenades at close range.
- **M6.5c Support fire** — mortars and smoke pulled forward from M8 (indirect fire process, smoke as a
  concealment volume).
Acceptance: AI-versus-AI attacks succeed some of the time (neither side wins every battle); the player can
call mortar fire and smoke. **Result:** the German attack now wins 2 of 10 (was 0 of 20); the Russian attack
still 0 of 10 (its 82 mm mortar is far lighter than the German 120 mm) — for the owner's review.

### M6.6 Surrender — ✅ (owner request 2026-11-12)
Wounded men who can no longer fight, and panicked or fleeing men, give up when a known enemy is close; enemies
hold fire once they see it; prisoners are taken (a quiet enemy walks over); surrender costs like a casualty;
white flags on the map; the after-action review lists surrendered and captured men.

## Stage B — combined arms and the modern layer
- **M7 Vehicles** — drive model, crews, armour, components, IFVs and carriers, mount/dismount, shoulder-fired
  anti-tank weapons. ✅ (2026-11-12; M7.1a–c, M7.2, M7.3, M7.4a, M7.4b — plan `docs/plans/m7-vehicles.md`).
  Main battle tanks, wheeled carriers and IFV missiles later (owner: not in M7).
- **M7.5 Look and interface** (owner request 2026-11-12, after M7) — 🔨 (plan `docs/plans/m7.5-look.md`; **M7.5a UI
  shell ✅** 2026-11-12: greyed order bar docking to any edge, unit sidebar, relevant actions only, labels that
  never overlap, overview vehicle symbols, appearance data; **M7.5b look ✅** 2026-11-12: zoom levels, opening
  zoomed in, original pixel soldiers, flat pixel map, contours only far, roofs that fade; **M7.5c interiors ✅**
  2026-11-13: rooms, inner walls, doorways, stairs and upper windows in every building, sight/bullets/blast with
  inner walls and floors, squads ordered into, out of and between rooms; **M7.5d upper floors ✅** 2026-11-13:
  stairs, heights, floor switch, Occupy order, men at true size close in. **M7.5 complete**; **M7.5e AI uses
  buildings — built, partly met (owner to accept)** 2026-11-14, plan `docs/plans/m7.5e-ai-buildings.md`: the AI
  defence holds houses with a mixed spread, men leave a house that is a trap, has the enemy inside or is cut off;
  the AI attacker can clear a house room by room and hold what it takes (shown in the lab and in some battles), but
  the plan's step-3 battle targets for the attacker (houses taken, time indoors, grenades into houses, holding a
  house of the main ring at the end) are not met — see DECISIONS.md; scenario `house-clear`, `--scene buildings`;
  follow-ups (owner answers 2026-11-14) ✅: a **Clear** button in the Move tray, and the AI attacker clears houses
  with a known, well-placed enemy on its approach too)
  - The order bar is always visible (no unit needs to be selected first) and can be dragged to where the
    player wants it.
  - A sidebar lists every unit of the player's side; tapping an entry selects the unit.
  - Only the actions that make sense for the selected unit are offered (a vehicle: its orders; a squad: its
    orders; nothing a unit cannot do).
  - Soldiers are drawn as small top-down pixel-art figures (our own original art: posture, facing, weapon,
    firing, wounded, down, surrendered).
  - True scale between house, soldier and map: a man is about 0.5 m across, a door about 1 m, a room a few
    metres; zoom levels chosen so that this reads correctly.
  - Building interiors: rooms, inner walls and doors that men move through, see through and fight in.
  - A cleaner, flatter map style in the manner of classic top-down pixel wargames (original art, not a copy of
    any existing game's graphics); less clutter.
  Owner's design answers (2026-11-12, DECISIONS.md): true scale close / unit symbols far, opening zoomed in;
  faction uniform tones plus a blue or red marker; flat pixel map (no blending or hill shading, contours only
  when zoomed out); roofs fade when own men are inside or near, or when zoomed in close; **all floors with
  stairs** and a floor switch (men fire from upstairs windows); order bar greyed until a unit is selected; the
  bar docks to any of the four edges; the unit sidebar is a slim strip of tiles that expands.
  Acceptance: the owner finds it clearer and better looking on his phone; nothing about how the simulation
  resolves fights changes except where interiors and upper floors add walls, stairs and firing positions.
- **M8 Indirect fire and smoke** — mortars, artillery process, smoke as concealment volume. 🔶
  Slices from `docs/plans/roadmap-detail.md` Phase 3:
  1. ✅ **M8.1 Smoke volume v2** (2026-11-14) — cloud height, wind drift and plumes, build-up and fade in data, the
     renderer drawing the sim's shapes, smoke screen along a line (`callFire` x2/y2), `lab -- smoke`, perf with 30
     clouds.
- **M9 Modern layer one** — sensors and night, guided anti-tank weapons, reconnaissance drones,
  drone-adjusted fire. ⬜

## Stage C — depth (order may change after the M6 review)
- **M10 Medical system** (SPEC 9.1) ⬜
- **M11 Logistics** (SPEC 9.2) ⬜
- **M12 Persistent roster and linked battles** (SPEC 9.3 stage one) ⬜
- **M13 Dynamic campaign** (SPEC 9.3 stage two) ⬜

## Stage D — breadth
- **M14 Modern layer two** — attack drones, loitering munitions, electronic warfare, active protection,
  command and control (SPEC 9.5). ⬜
- **M15+** — weather and seasons, more factions, editors, real terrain, sound, multiplayer, packaging. ⬜
