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

### M4 Soldier and squad behaviour — ⏳ in progress
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
- **M4.4 Doctrine profiles and batch** — German / Russian doctrine values; batch: attack in the open against a
  prepared defence loses most of the time.
Acceptance: batch runs of squad against squad produce varied, believable outcomes; debug overlay explains
decisions; attackers in the open against a prepared defence lose most of the time.

### M5 Orders and interface — ⬜
Full order set, waypoints, standing rules, unit panels, radio log, time controls, touch controls.
Acceptance: the owner can fight a squad action on his phone without a manual.

### M6 Opposing commander and scenarios — ⬜
Objectives, scenario format and generator, commander AI for both postures, after-action review, save and load.
Acceptance: **first playable** — a generated platoon-level infantry battle, Germany against Russia, either
side playable, AI-versus-AI batch report available.

**Stop after M6 for a review with the owner** (is it fun, what is wrong, what to change before adding breadth;
also: pull the medical system forward or not; **owner asked to be reminded (2026-11-11): fog of war "only what
reached the squad leader"** instead of "what your men have reported" — see DECISIONS.md, M3.4).

## Stage B — combined arms and the modern layer
- **M7 Vehicles** — drive model, crews, armour, components, IFVs and carriers, mount/dismount, shoulder-fired
  anti-tank weapons; then main battle tanks. ⬜
- **M8 Indirect fire and smoke** — mortars, artillery process, smoke as concealment volume. ⬜
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
