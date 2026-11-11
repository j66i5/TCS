# Roadmap

Milestones from SPEC section 11 with acceptance criteria and status. Each milestone is split into slices of
one session; slices are proposed at the start of each milestone. Every milestone ends with all checks
passing, a deployed build, updated documents and a plain-language summary for the owner.

Status: ✅ done · 🔨 in progress · ⏳ next · ⬜ not started

## Stage A — foundations

### M0 Bootstrap — ✅ done (merged; live once GitHub Pages is enabled, see STATE.md)
Repository, tooling, CI, deployment, documents, simulation loop with seeded randomness, serialisable state,
order interface, event stream, determinism test, headless runner, an app page showing a moving dot driven
by the simulation.

Acceptance:
- [ ] the deployed URL works on a phone — *waiting for the owner to enable GitHub Pages (STATE.md)*
- [x] the determinism test passes (`packages/tools/test/determinism.test.ts`, incl. mid-battle save)
- [x] the fixture-faction loader test exists (`packages/tools/test/fixture-faction.test.ts`)

Slices: M0.1 (this session) — everything above in one slice.

### M1 Map and movement — 🔨 in progress (M1.1 done)
Heightfield, terrain layers, procedural test maps, pathfinding, soldiers with postures and fatigue, squads in
formation, camera and zoom, first order (move).
Acceptance: a squad crosses a generated village map choosing covered routes; movement lab passes.

Proposed slices (to confirm at the start of M1):
1. ✅ **M1.1 Terrain model and generator** (2026-11-11) — heightfield, surface/vegetation/obstacle/building/road/water
   layers and materials as data; procedural generator for village, woodland edge, farmland, industrial;
   terrain drawn in the renderer; map format (JSON + heightmap image) with save/load. Destructible-terrain
   state stored as data.
2. ⏳ **M1.2 Navigation** — navigation grid with costs per movement mode (walk, run, sneak, crawl; wheeled and
   tracked reserved), A* pathfinding, spatial hash for neighbourhood queries, path debug overlay.
3. **M1.3 The individual soldier moving** — postures with change times; speed from mode, slope, surface and
   load mass; fatigue and heart rate rising and recovering (reading temperature from the environment);
   movement & fatigue lab with tables.
4. **M1.4 Squads in formation** — formations as data, men choosing covered positions near their slot,
   waypoint chains with a mode per leg, camera zoom levels (close / tactical / overview). Acceptance demo:
   squad crosses the village on covered routes; screenshots.

Owner decision (2026-11-11): first squads are German Panzergrenadier dismounts of a Puma and a Russian
motor-rifle squad on a BMP; German callsigns "Gruppe {n}" / "Trupp {n}".

### M2 Ballistics and wounds — ⬜
Projectiles, materials and penetration, fragments, body zones, armour, wound records with simple physiology,
small arms and grenades for both factions.
Acceptance: firing range, cover and fragmentation labs produce plausible tables; performance floor holds
with 20,000 projectiles.

### M3 Spotting and knowledge — ⬜
Line of sight, detection, per-soldier contacts, sharing, fog of war in the renderer.
Acceptance: spotting lab passes; the player view shows only reported contacts.

### M4 Soldier and squad behaviour — ⬜
Suppression, morale, cover use, fire discipline, ammunition sharing, casualty reaction, drills, doctrine
profiles.
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
also: pull the medical system forward or not).

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
