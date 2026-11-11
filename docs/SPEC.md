# Kickoff prompt: modern tactical combat simulation (working title TBD)

You are starting a new long-running project in an empty repository. This message is the project specification. Your first action is to save this entire message, unchanged, as `docs/SPEC.md`. It is the source of truth for every later session. Then carry out section 14 ("What to do in this first session") and nothing beyond it.

Read the whole document before doing anything. The extensions in section 9 are not to be built now, but the foundations in sections 4 to 7 must be shaped so that those extensions later slot in without rewrites. That is the main design constraint of this project.

---

## 1. Who you are working with

- The owner is one person with no programming or electronics experience. He decides design and priorities; you write all code.
- He works in short sessions, often from a phone through Claude Code cloud sessions, with a GitHub repository. A desktop is available only on some weekends. So every milestone must end in something he can open in a mobile browser via a URL.
- He wants blunt, honest reporting. If something is weak, slow, ugly or unfinished, say so plainly. Never report work as done without showing the evidence (command run and its output).
- He knows the subject matter (military organisation, medical evacuation chain) better than the software. Ask him domain questions; do not ask him software questions he cannot judge. For software decisions, choose, explain the choice in two or three plain sentences, and record it in `docs/DECISIONS.md`.
- A known failure mode of AI-written games is that the owner loses touch with his own project. To counter it, end every session with a short plain-language section "What was built and how it works" (no jargon without a one-line explanation), and keep `docs/HOW_IT_WORKS.md` current as a guided tour of the systems.

## 2. Vision

A real-time, top-down, 2D tactical combat simulation at platoon to company scale, set in the present day. It is inspired by the design philosophy of Sean O'Connor's *Firefight* and the *Close Combat* series: plain visuals, deep simulation. It is an independent work. Do not copy any code, art, maps, text, unit data files or the name from those games.

### Design pillars (in priority order)

1. **Every soldier is an individual.** Name, rank, role, weapon, ammunition by magazine, load, fatigue, heart rate, stress, wounds. The player commands squads and vehicles; the men decide how to carry out orders and whether they are able to.
2. **Every projectile is simulated.** Bullets, shells, grenades, fragments and missiles are objects flying through 3D space (x, y, height) with velocity, drag and gravity. Hits, penetration, ricochet and near-miss suppression come out of geometry, not out of to-hit tables.
3. **Behaviour emerges, it is not scripted.** A machine gunner running low calls for ammunition and a squad mate carrying spare belts brings it. A wounded man calls out and someone decides whether helping him is survivable. These come from general rules acting on individual state.
4. **Friction and uncertainty.** The player sees only what his men have spotted and reported. Orders take time. Fire support takes time and needs adjustment. Men under fire may not obey.
5. **Consequences persist.** Wounds, exhaustion, ammunition expenditure and losses carry forward (within a battle from the start, across battles once the campaign layer exists).
6. **Data over code.** Factions, weapons, ammunition, vehicles, organisation tables and doctrine are data files. Adding a faction must need no engine change.

### What this is not (for the foreseeable roadmap)

No 3D graphics, no base building, no resource harvesting, no hero units, no first-person control, no online accounts or servers, no monetisation. Readable, functional 2D visuals are the target; polish comes last.

## 3. Content rules

- Present-day setting. First two factions: **Germany (Bundeswehr)** and **Russia (Russian Ground Forces)**. More factions come later as data packs.
- Use only public, open sources for organisation and equipment (manufacturer data, official public websites, published reference works, reputable defence journalism, Wikipedia as a starting point). Record the source URL for every data entry. Never ask the owner for non-public information and never include any if offered; public sources only.
- All values are game abstractions chosen for plausible behaviour, not engineering data. Where sources disagree or are missing, pick a plausible value, and mark it `confidence: "low"`.
- Scenarios are fictional contingencies on fictional or generic terrain. No real persons, no real named units below a generic type, no depiction of real atrocities, no propaganda framing for either side. Both sides are modelled as competent professionals with different equipment, organisation and doctrine.
- Soldier names come from generated lists of common given names and surnames per faction.
- Violence is shown abstractly (symbols, status text). No gore.

## 4. Technology and architecture

### 4.1 Stack

- **TypeScript in strict mode**, built with Vite, tested with Vitest, rendered with PixiJS (WebGL 2D). Use the current stable versions; check them rather than assuming.
- Runs in a desktop or mobile browser. Deployed automatically to GitHub Pages from `main` by GitHub Actions, so each merged milestone is playable from a URL.
- Desktop packaging (for example Tauri) and app-store builds are later options; keep the code free of assumptions that would block them.
- Keep dependencies few. Every new dependency needs a line in `docs/DECISIONS.md` saying why.

Why this stack: you can run, test and verify everything from a terminal with no GUI editor; the simulation runs headless in Node for automated tests and batch balance runs; and the owner can play each build on his phone.

### 4.2 Package layout (a monorepo with workspaces)

```
packages/
  sim/        Pure simulation. No DOM, no PixiJS, no Node APIs, no wall-clock time, no Math.random.
  data/       JSON data files plus schemas and loaders (factions, weapons, ammo, vehicles, TO&E, terrain types, doctrine).
  ai/         Soldier, squad and commander decision-making. Depends on sim interfaces only.
  scenario/   Scenario format, validation, procedural scenario and map generation.
  campaign/   Empty at first. Persistent roster and operational layer (section 9.3).
  render/     PixiJS renderer. Reads simulation state and events, never writes simulation state.
  ui/         Input, panels, menus, order interface. Emits orders only.
  app/        The browser application that wires everything together.
  tools/      Headless runner, batch runner, balance reports, data linter, replay tools.
docs/         SPEC.md, ARCHITECTURE.md, ROADMAP.md, STATE.md, DECISIONS.md, HOW_IT_WORKS.md, DATA_GUIDE.md
```

Enforce the dependency direction with a lint rule or a test: `sim` imports nothing from `render`, `ui` or `app`.

### 4.3 Hard architectural rules

These exist because the extensions depend on them. If you believe one must be broken, stop and explain before doing so.

1. **Deterministic simulation.** Fixed timestep (start at 60 Hz, record the decision). Same initial state + same seed + same order stream gives a bit-identical state every time. All randomness comes from a seeded generator with named sub-streams (ballistics, AI, spotting, wounds, and so on) so that adding a random call in one system does not shift results in another.
2. **Route transcendental maths through one module** (`sim/math`): sine, cosine, square root, powers, exponentials. Inside one JavaScript engine they are repeatable, but they are not guaranteed identical across engines. A single module lets it be swapped for a fully deterministic implementation when lockstep multiplayer arrives.
3. **Orders are the only way to change the simulation from outside.** An order is a plain serialisable record with a tick number, an issuer and a target. Human input, the AI commander, replays, network play and the campaign auto-resolver all use this one interface.
4. **The whole simulation state is serialisable** to a plain data structure and back. This gives save and load, snapshots, a state hash for determinism tests, and battle results that the campaign can store.
5. **The simulation emits an event stream** (shot fired, impact, wound, spotted, radio message, order acknowledged, vehicle hit, and so on). Renderer, sound, the radio log, the after-action review and the campaign all consume events. They never reach into simulation internals.
6. **Data-oriented design.** Entities are numeric IDs. State lives in component stores. High-count objects (projectiles, fragments) live in typed arrays with no per-tick allocation. Do not default to deep class hierarchies; systems are functions over stores.
7. **SI units everywhere inside the simulation**: metres, seconds, kilograms, radians. Convert only at the UI edge.
8. **Everything about a faction is data.** No `if (faction === "DE")` anywhere in code. A test must load a third, made-up fixture faction and run a battle with it to prove this.
9. **Inventory is real.** Every consumable (each magazine, belt, grenade, rocket, tourniquet, bandage, battery, litre of fuel) is a counted item with mass, held in a container (soldier, vehicle, crate, depot). One generic transfer action moves items between containers. Logistics and medicine later build on this without changes.
10. **A wound is a record, not a hit-point subtraction** (section 6.4). A casualty remains an entity in the world that can be treated, carried, loaded and evacuated.
11. **A battle is a function**: (map, forces, scenario rules, seed, order stream) to (result record). The forces going in and the result coming out are defined independently of the battle internals, so the campaign layer can feed and read battles, and can run AI-versus-AI battles headless.
12. **Player-facing text goes through a string table** from the first day, including radio messages, so languages can be added.

### 4.4 Performance budget

Target scale for the foundations: up to 300 soldiers, 30 vehicles and 20,000 live projectiles and fragments on a 2 km by 2 km map (format must allow up to 4 km by 4 km), at real-time speed on a mid-range phone and at least 8 times real-time headless on a laptop. Add a benchmark scenario and a performance test that fails when the headless rate falls below an agreed floor. Use spatial hashing for neighbourhood queries. Fragments may use a statistical level-of-detail beyond a distance where no entity can be hit, but direct-fire projectiles are always simulated individually.

## 5. Verification: how you check your own work

You cannot see the game. Build the means to check it and use them every session.

1. `typecheck`, `lint`, `test` scripts. Put the exact commands in `CLAUDE.md`.
2. **Determinism test**: run a reference scenario twice with the same seed and orders, compare state hashes at intervals. Run it again from a mid-battle save and confirm the same end state.
3. **Golden replays**: stored order streams with expected end-state hashes. A changed hash must be either a bug or an intended change recorded in `docs/DECISIONS.md`.
4. **Sim lab scenarios** (small, scripted, headless): a firing range (hit rates by range, posture and stress), a cover test (penetration by material and thickness), an armour test (penetration and ricochet by angle), a fragmentation test, a spotting test, a movement and fatigue test, a casualty test. Each prints a table and has assertions on plausible bands.
5. **Batch balance runs**: run a scenario a few hundred times with different seeds and write a report (win rates, casualties, ammunition used, duration) to `reports/`. Use this to tune and to catch regressions in behaviour.
6. **Visual self-check**: a script that starts the app in a headless browser, loads a scenario, advances the simulation and saves screenshots. Look at the screenshots yourself before reporting a visual feature as working.
7. **Debug overlays** in the app, switchable: lines of sight, projectile traces, suppression values, AI state per soldier, spotting knowledge, pathfinding grid, performance counters.
8. **Continuous integration** runs typecheck, lint, tests, the determinism test and the performance floor on every push. Deployment happens only when it passes.
9. Set up a Stop hook (or equivalent) so a session cannot end with a failing typecheck or failing tests. Check the current Claude Code documentation for the exact configuration format.
10. For each milestone, have a fresh reviewer subagent compare the change against this specification and the milestone's acceptance criteria. Ask it to report gaps that affect correctness or break an architectural rule, and to skip style.

When you report, give evidence: the commands, their output, the report tables, the screenshots.

## 6. Simulation foundations

### 6.1 World and map

- Top-down 2D map with a heightfield (cell size 2 to 5 m), so the world is effectively 2.5D. Every entity and projectile has a height above ground.
- Terrain layers: surface type (movement cost per movement mode, noise, dust), vegetation (concealment, partial bullet stopping), linear and polygonal obstacles with height and material (walls, hedges, fences, embankments, vehicles as obstacles), buildings (wall segments with material and thickness, doors, windows, a `storeys` field reserved for multi-floor interiors later), roads, water.
- Materials define ballistic resistance, so the same penetration rules handle a wooden fence, a brick wall, a sandbag position and a car door.
- Terrain is destructible in a simple way from the start (walls breached, craters giving cover, vegetation thinned), stored as state so it saves and replays.
- Map format: JSON with the heightfield and terrain grids embedded as compact binary (base64); heightmap image export and import come with the map editor and real-terrain importer (changed 2026-11-11 with the owner's approval, see DECISIONS.md). Begin with a procedural map generator for test maps (village, woodland edge, open farmland, industrial area). Reserve an importer interface for real-world terrain from open elevation and map data (later).
- Environment state: time of day, light level, weather (wind, rain, fog), temperature. Foundations only need daylight and clear weather, but spotting, ballistics and fatigue read these values from the start.

### 6.2 Movement

- Pathfinding on a navigation grid with costs per movement mode (walk, run, sneak, crawl; wheeled; tracked). Squad movement in formations; men choose individual cover positions near their formation slot.
- Postures: standing, crouching, prone. Posture changes take time and affect silhouette, dispersion, speed and fatigue.
- Fatigue and heart rate rise with speed, load mass, slope and stress, and recover with rest. They feed aiming, movement speed, and morale.

### 6.3 Weapons and ballistics

- Weapon data: type, calibre, feed (magazine or belt size), fire modes, cyclic rate, mechanical dispersion, reload time, mass, sights and optics fitted, set-up time for crew-served weapons, jam probability.
- Ammunition data: mass, muzzle velocity per weapon, drag coefficient, penetrator type, explosive filling, fragment count and velocity distribution, fuse type, guidance type, tracer.
- Flight: each projectile integrates velocity with drag and gravity (wind later). Use swept segment tests each tick so fast projectiles cannot skip through thin objects.
- Aiming error comes from the shooter (skill, fatigue, heart rate, suppression, posture, bracing, time spent aiming, target movement, range estimation error) combined with weapon dispersion. There is no hit-chance table.
- Terminal effects: penetration against material thickness along the path with energy loss; ricochet depending on angle and material; fragments spawned as projectiles; blast as a distance-based effect with shielding by obstacles.
- Suppression: every projectile passing or impacting near a soldier adds stress scaled by calibre, proximity and explosion size. Suppression is the central infantry mechanic; tune it with the sim lab.
- Shell and warhead types to support in the data model from the start, even if implemented later: ball, armour-piercing, tracer, high explosive, fragmentation, shaped charge (single and tandem), kinetic penetrator, airburst (programmable), smoke, illumination, thermobaric.
- Guidance types to reserve in the data model: unguided, wire or beam command guidance, fire-and-forget with direct or top-attack flight profile, laser-guided, operator-flown (first-person-view drone).

### 6.4 Soldiers

Each soldier record holds:

- Identity: name, rank, role, faction, unit path (platoon, squad, team).
- Skills: marksmanship, fieldcraft, medical training level, leadership, experience. Faction and unit quality set the starting distribution.
- Physical state: fatigue, heart rate, hydration field reserved.
- Mental state: stress and suppression, morale, and a behavioural state (steady, cautious, pinned, shaken, panicked, routed, surrendered, incapacitated). Morale is influenced by leaders nearby, casualties seen, isolation, success, and being under effective fire.
- Load: a container of items with total mass (rule 9 in section 4.3). Body armour and helmet are items with coverage zones and a protection level.
- Body model: hit zones (head, neck, chest, abdomen, pelvis, each arm, each leg) with exposed area depending on posture and facing; armour coverage per zone.
- **Wounds**: a list of wound records. Each has zone, mechanism (bullet, fragment, blast, burn, crush), severity, bleeding rate, flags for airway, breathing and consciousness effects, time inflicted, and a treatment log. A physiological state (blood volume, shock level, consciousness, pain) is derived from the wounds and changes over time. In the foundations, the deterioration model can be simple, but it must be a time-stepped system with data-driven rates, because the medical extension (section 9.1) replaces its contents, not its interface.
- Functional effects: what the soldier can still do (walk, use arms, fight, speak) follows from wounds and physiology.
- Knowledge: what this soldier currently knows about enemy and friendly positions (section 6.5).

### 6.5 Spotting, knowledge and communication

- Line of sight is computed in 3D over the heightfield and obstacles, with concealment accumulating through vegetation and smoke.
- Detection is probabilistic per observer and target per interval: range, target posture, movement, firing (muzzle flash, sound, dust), concealment, light level, the observer's sensor (eye, magnified optic, night vision, thermal imager; each defined in data), where the observer is looking, and his stress.
- Each soldier holds his own contacts with a confidence and age. Contacts are shared within shouting distance quickly, and across the unit by radio with a delay. The player sees the union of what his side knows, with stale contacts fading. Sound contacts (direction only) are a contact type.
- Every unit has a communication state (in voice range of leader, on radio net, out of contact). Order delay and contact sharing depend on it. In the foundations this is a simple delay; the interface must allow the command and electronic-warfare extension (section 9.5) to make it richer.

### 6.6 Soldier and squad behaviour

This is the hardest part of the project and decides whether the game is good. Budget most iteration time here.

- Three layers: **soldier** (survive, fight, help), **team and squad** (drills and coordination), **order interpretation** (turning a player order into squad tasks).
- Use a deterministic utility-based or behaviour-tree approach with data-driven weights. Each soldier re-evaluates on a staggered schedule. Expose the current decision and its top reasons in a debug overlay.
- Soldier behaviours for the foundations: seek cover and concealment relative to known and suspected threats; choose posture; engage targets with sensible target choice and fire discipline; reload at sensible moments; call for and deliver ammunition; throw grenades and smoke when appropriate; call out and report contacts; react to a casualty (call out, decide on aid, drag to cover); obey, hesitate or refuse orders depending on mental state.
- Squad behaviours: formations; bounding movement with one element covering; reaction-to-contact drills; fire and manoeuvre under a base of fire; break contact with smoke; consolidate and redistribute ammunition after contact; leadership succession when the leader is hit.
- **Doctrine profiles are data**: preferred spacing, aggressiveness, willingness to dismount, casualty tolerance before withdrawal, reliance on supporting fire, drone use, evacuation priority. The two factions differ through profiles and organisation, not through code.
- Player orders for the foundations: move (normal, fast, sneak), assault, defend an arc, fire at a point or area (suppressive fire), hold fire, ambush, smoke, withdraw, mount and dismount, deploy crew-served weapon. Orders can be chained as waypoints with a stance per leg.
- Player-adjustable standing rules per unit (rules of engagement, reaction to contact, when to use anti-tank weapons) are worth having early; they cut micromanagement.

### 6.7 Vehicles

- Physical drive model: engine power, mass, gears, traction per surface, tracked steering by differential track speed or wheeled steering by turn radius. Vehicles accelerate, brake and turn plausibly.
- Crew positions (commander, gunner, driver, loader where present) are filled by individual soldiers with their own wounds and states. A vehicle without a driver does not move. Passengers are soldiers in seats.
- Armour model: plates per facing and zone with thickness, angle and type (steel, composite, reactive tiles as consumable items, slat). Penetration depends on the round, impact angle and plate. Reserve a slot for active protection systems (detect, intercept with limited charges).
- Internal components (engine, transmission, tracks or wheels, turret drive, gun, sights, ammunition stowage, fuel, radio) can be damaged separately, giving mobility kills, firepower kills, fires and catastrophic losses. Crew react (continue, reverse out, bail out).
- Turret and weapon stations: traverse and elevation rates, stabilisation, sights per crew member, ammunition by type in ready and stowed racks (items, per rule 9).
- Smoke dischargers. Recovery and repair states reserved for logistics.

### 6.8 Indirect fire and support

- On-map mortars and off-map artillery. A call for fire is a process: observer with line of sight or a drone feed, request over the net (delay), time of flight, adjustment rounds, fire for effect. Accuracy of the first round depends on how the target was located (map estimate, laser rangefinder, drone). This keeps the classic ranging mechanic but lets modern sensors shorten it.
- Mission types: high explosive, airburst, smoke, illumination. Limited allotments per scenario, counted as items at a firing unit so logistics can later own them.
- Reserve interfaces for counter-battery risk and for precision-guided rounds.

### 6.9 Scenarios, objectives, opposing commander

- Scenario file: map reference, environment, forces per side with deployment zones, objectives (terrain zones to hold, units to destroy or preserve, exit zones, time limits), victory point rules, reinforcements schedule, support allotments, seed.
- A procedural scenario generator (attack, defence, meeting engagement, ambush, withdrawal) is part of the foundations, because the dynamic campaign will depend on it.
- The opposing commander plans against objectives: assigns units to tasks (assault, support by fire, flank, reserve, defend), issues the same orders the player can issue, reassesses on events (heavy casualties, objective lost, new contact). It must be able to play either side and either posture, so AI-versus-AI batch runs work.
- After-action review: replay from the event stream with full information, casualty list, ammunition expenditure, timeline.

### 6.10 Interface

- Mobile-first touch controls with mouse and keyboard support: pan, pinch zoom, tap to select, drag to order, long-press for context orders.
- Zoom levels: close (individual men, postures, weapon arcs), tactical (squads and vehicles as symbols), overview (contour lines, objectives).
- Unit panel showing each man's status as in section 6.4; vehicle panel with crew and components.
- Radio log: timestamped messages from the event stream ("Contact, tree line, 300", "Man down", "Out of ammunition") in the faction's own phrasing through the string table.
- Time controls: pause with orders, slow, real time, fast.
- Graphics are simple vector shapes and symbols generated in code. No external art needed for the foundations. Any asset added later must be original or openly licensed, logged in `docs/ASSETS.md`.

## 7. Factions (as data)

Create `packages/data/factions/de` and `.../ru`. For each: organisation tables, weapons, ammunition, vehicles, sensors, equipment items, name lists, doctrine profile, string table for radio phrases. Research current public information and record sources. The lists below are a starting scope to verify, not facts to copy.

**Germany, first scope (infantry-centred):**
- A Panzergrenadier platoon (dismounts plus infantry fighting vehicles) and a Jäger platoon (light infantry, wheeled transport).
- Small arms and support weapons of the kinds currently issued: service rifle (current and incoming model), light and general-purpose machine guns, designated marksman rifle, under-barrel or standalone 40 mm grenade launcher, shoulder-fired anti-tank and multipurpose weapons, the man-portable anti-tank guided missile, hand and smoke grenades.
- Vehicles: the tracked infantry fighting vehicle, the wheeled armoured transport in infantry and ambulance variants, a main battle tank for the vehicle milestone.
- Support: 120 mm mortar, self-propelled 155 mm artillery off-map, small reconnaissance drones; loitering munitions if public sources confirm issue, otherwise flagged as optional.

**Russia, first scope:**
- A motor rifle platoon on tracked infantry fighting vehicles and one on wheeled armoured personnel carriers, plus a small assault-group organisation as used in current practice.
- Small arms and support weapons of the kinds currently issued: service rifles, squad and general-purpose machine guns, marksman rifle, under-barrel grenade launcher, automatic grenade launcher, reusable and disposable rocket launchers, thermobaric launcher, anti-tank guided missiles.
- Vehicles: the tracked and wheeled carriers, current main battle tank models for the vehicle milestone.
- Support: 82 mm and 120 mm mortars, self-propelled artillery off-map, reconnaissance drones, loitering munitions, first-person-view attack drones, electronic warfare assets.

Rules for faction data:
- Every file validates against a schema; a data linter in `tools/` checks references, units, required sources and plausible ranges.
- Each entry carries `sources` (URLs) and `confidence`.
- `docs/DATA_GUIDE.md` explains in plain language how to add a weapon, a vehicle, a unit and a whole faction, so the owner or a later contributor can do it without touching engine code.
- Quality and training levels are parameters of a unit template (for example conscript, regular, veteran), not hard-wired to a faction.

## 8. The modern layer

Features that separate this from a Second World War game. They are scheduled after the first playable infantry battle (section 11) but their data fields and interfaces exist from the start.

- **Sensors**: magnified day optics, night vision, thermal imagers on weapons and vehicles; laser rangefinders; battlefield surveillance radar reserved. Night and smoke interact differently with each sensor type.
- **Body armour and helmets** changing wound distribution towards limbs and junctions, which in turn makes the medical system matter.
- **Guided anti-tank weapons** with their engagement process: set-up, tracking time, flight time during which the operator is exposed (for command-guided types), top-attack profiles, minimum range, countermeasures (smoke, active protection).
- **Unmanned aircraft**: small reconnaissance quadcopters (a unit item with battery life, an operator who is busy while flying, a video feed that creates contacts), drone-observed artillery adjustment, first-person-view attack drones and loitering munitions as operator-flown or autonomous projectiles, drone-dropped munitions. Counter-measures: visual and acoustic detection, small-arms fire, jammers, nets and cages as vehicle armour items.
- **Electronic warfare**: jamming zones that degrade radio links, drone control and satellite navigation. Feeds the communication state from section 6.5.
- **Programmable airburst ammunition** for automatic cannon and grenade launchers.
- **Persistent observation**: the assumption that anything in the open is seen. Dispersion, concealment, overhead cover and signature management become player concerns. Doctrine profiles should reflect this.

## 9. Planned extensions and what the foundations owe them

Do not build these before their milestone. Do keep the listed foundation requirements true at all times; add a section to `docs/ARCHITECTURE.md` that tracks each requirement and the test that guards it.

### 9.1 Medical system

**Goal:** casualties become a tactical problem with a clock, as in reality, rather than a counter.

- Wound physiology: bleeding (compressible and non-compressible), airway, breathing (for example chest injuries), circulation and shock, head injury, burns, hypothermia risk, pain. State evolves over time; data-driven rates.
- Levels of care as a chain: self-aid, buddy aid, squad-level first responder with extended training, platoon medic, casualty collection point, protected evacuation vehicle, aid station off-map. Each level is a skill level plus equipment items plus time needed per intervention.
- Interventions as actions consuming items and time, performed under fire or in cover: tourniquet, pressure dressing, wound packing, airway positioning and adjuncts, chest seal, decompression (higher skill), fluids, pain relief, warming, splinting. Each has a success chance by skill and stress, and an effect on the physiology.
- Triage categories assigned by the treating soldier, visible to the player, sometimes wrong.
- Movement of casualties: walking wounded, one-man drag, two-man carry, stretcher teams of four, loading into a vehicle. Carriers are out of the fight and slow. Ground evacuation vehicles and, where the scenario allows, air evacuation as off-map assets with request procedure and delay.
- Outcomes: returned to duty, evacuated and recovering (duration feeds the campaign), died of wounds (timing matters), killed outright. Statistics in the after-action review: time to first intervention, time to evacuation, preventable deaths.
- Behaviour: men's willingness to expose themselves for a casualty depends on morale, bond and doctrine; enemy fire on casualty parties is possible; captured wounded are treated according to the capturing side's capacity.
- Faction differences come from data: training levels, kit contents, evacuation assets, doctrine priority.
- The owner will review the medical model for plausibility. Ask him before fixing treatment times and the chain of care.

**Foundation requirements:** wounds as records with time-stepped physiology; casualties as persistent, movable entities; items and generic transfer; actions with duration that can be interrupted; skills per soldier; carrying modelled as a movement mode involving several soldiers; event stream entries for every medical event.

### 9.2 Logistics

**Goal:** ammunition, fuel and equipment are finite and must be moved.

- Within a battle: individual loads, squad redistribution, vehicle-carried reserves, platoon and company supply points, resupply runs by vehicle or on foot, cross-loading from casualties and from abandoned vehicles, enemy weapon pick-up as an option.
- Consumables beyond ammunition: fuel, batteries (radios, night vision, drones, thermal sights), drone airframes, smoke, medical items, water and rations for long scenarios, reactive armour tiles and active protection charges.
- Vehicle recovery and field repair with time and parts; maintenance wear in the campaign.
- Supply vehicles and dumps are entities that can be attacked. Fire support allotments belong to firing units with their own stocks.
- Campaign level: supply lines as routes with capacity, interdiction by fire and drones, stockpiles per formation, replacement personnel and vehicles arriving over time.

**Foundation requirements:** rule 9 in section 4.3 (counted items in containers with mass); weapons consume specific item types; vehicles have fuel and component states; containers can be world entities; nothing in the simulation grants free ammunition or infinite support.

### 9.3 Persistent units and dynamic campaign

**Goal:** a campaign that generates its own battles from an evolving operational situation, with a force the player grows attached to.

- Stage one, persistent roster: the player's company carries over between linked battles. Soldiers keep names, experience, wounds, fatigue and stress history; vehicles keep damage. Replacements arrive green.
- Stage two, operational layer: a map of sectors (a graph or hex grid), each linked to a tactical map or generator parameters. Both sides have formations with rosters, supplies, posture and orders. Time advances in operational turns. Where opposing formations meet, a battle is generated from the situation (who is attacking, strengths, terrain, time of day, weather, support available, intelligence quality).
- Battles the player does not fight are resolved by running the real simulation headless with AI commanders on both sides (possibly at reduced detail), so results stay consistent with played battles.
- The enemy operational commander pursues objectives with limited resources and imperfect information; it must not rely on cheating or on mass frontal rushes. Its plans should be explainable in a debug view.
- Results feed back: ground gained or lost, casualties and their recovery times, ammunition and fuel consumed, equipment captured, damaged terrain persisting on the tactical map, enemy units remembered with their own losses.
- Intelligence, reconnaissance tasks, weather forecasts, civilian presence and rules of engagement are later additions with reserved hooks.

**Foundation requirements:** rule 11 in section 4.3 (battle as a function with defined inputs and result record); roster format separate from battle state; procedural scenario generator; AI able to play both sides unattended; headless batch runner; persistent map damage stored as data.

### 9.4 More factions and modding

Data packs in a folder with a manifest. A loader that validates and reports errors readably. The fixture faction test (rule 8) stays green forever. Later: user-made packs loaded from a file, scenario editor in the app.

### 9.5 Command, control and electronic warfare

Explicit radio nets and command hierarchy; order delay depending on net state and leader condition; leaders as casualties changing delays; runners and hand signals as fallbacks; jamming and direction-finding; a battle management system as an item that speeds contact sharing for the side that has it. **Foundation requirement:** all information sharing and order delivery already pass through the communication state interface in section 6.5.

### 9.6 Multiplayer

Deterministic lockstep exchanging only order streams, first over a simple relay. **Foundation requirements:** rules 1 to 3 in section 4.3; no simulation dependence on frame rate, device or wall-clock time.

### 9.7 Night, weather and seasons

Light levels, illumination rounds, sensor differences at night, rain and fog on spotting and sound, wind on ballistics and smoke, mud and snow on movement, cold and heat on fatigue. **Foundation requirement:** environment state exists and is read by spotting, ballistics, movement and fatigue from the start.

### 9.8 Real terrain import, editors, sound, packaging

Importer from open elevation and map data to the map format; map and scenario editors; positional sound driven by the event stream; desktop and store builds. **Foundation requirement:** map format and event stream as specified.

## 10. Repository conventions

- `CLAUDE.md`: short. Only the commands (install, dev server, single test file, full check, headless run, batch run, screenshot script, deploy), the hard rules from section 4.3 as one line each, and gotchas discovered along the way. Do not describe the file layout there; you can read the repository.
- `docs/STATE.md`: the handover note. Current milestone, what works, what is broken, what is next, open questions for the owner. Update it at the end of every session; read it at the start of every session.
- `docs/ROADMAP.md`: milestones with acceptance criteria and status.
- `docs/DECISIONS.md`: dated entries, one paragraph each: decision, reason, alternatives rejected.
- `docs/ARCHITECTURE.md`: the systems, their interfaces, and the extension requirements with their guarding tests.
- Project skills in `.claude/skills/` for recurring procedures: starting a milestone, finishing a milestone (checks, review, state update, plain-language summary), running a balance report, adding data entries with sources. Check the current Claude Code documentation for the format.
- Small commits with clear messages. Work on a branch per milestone slice and open a pull request; `main` stays deployable.
- Tests accompany every system. Prefer tests of behaviour through the public interface (orders in, events and state out) over tests of internals.

## 11. Roadmap

Each milestone ends with: all checks passing, a deployed build, updated documents, and a plain-language summary telling the owner exactly what to open and what to try. Split milestones into slices of one session each; propose the slices at the start of each milestone.

**Stage A: foundations**

- **M0 Bootstrap.** Repository, tooling, continuous integration, deployment, documents, the simulation loop with seeded randomness, serialisable state, order interface, event stream, determinism test, headless runner, an app page showing a moving dot driven by the simulation. Acceptance: the deployed URL works on a phone; the determinism test passes; the fixture-faction loader test exists.
- **M1 Map and movement.** Heightfield, terrain layers, procedural test maps, pathfinding, soldiers with postures and fatigue, squads in formation, camera and zoom, first order (move). Acceptance: a squad crosses a generated village map choosing covered routes; movement lab passes.
- **M2 Ballistics and wounds.** Projectiles, materials and penetration, fragments, body zones, armour, wound records with simple physiology, small arms and grenades for both factions. Acceptance: firing range, cover and fragmentation labs produce plausible tables; performance floor holds with 20,000 projectiles.
- **M3 Spotting and knowledge.** Line of sight, detection, per-soldier contacts, sharing, fog of war in the renderer. Acceptance: spotting lab passes; the player view shows only reported contacts.
- **M4 Soldier and squad behaviour.** Suppression, morale, cover use, fire discipline, ammunition sharing, casualty reaction, drills, doctrine profiles. Acceptance: batch runs of squad against squad produce varied, believable outcomes; debug overlay explains decisions; attackers in the open against a prepared defence lose most of the time.
- **M5 Orders and interface.** Full order set, waypoints, standing rules, unit panels, radio log, time controls, touch controls. Acceptance: the owner can fight a squad action on his phone without a manual.
- **M6 Opposing commander and scenarios.** Objectives, scenario format and generator, commander AI for both postures, after-action review, save and load. Acceptance: **first playable**, a generated platoon-level infantry battle, Germany against Russia, either side playable, AI-versus-AI batch report available.

Stop after M6 for a review with the owner: is it fun, what is wrong, what to change before adding breadth.

**Stage B: combined arms and the modern layer**

- **M7 Vehicles.** Drive model, crews, armour, components, infantry fighting vehicles and carriers, mount and dismount, shoulder-fired anti-tank weapons. Then main battle tanks.
- **M8 Indirect fire and smoke.** Mortars, artillery process, smoke as concealment volume.
- **M9 Modern layer one.** Sensors and night, guided anti-tank weapons, reconnaissance drones, drone-adjusted fire.

**Stage C: depth**

- **M10 Medical system** (section 9.1).
- **M11 Logistics** (section 9.2).
- **M12 Persistent roster and linked battles** (section 9.3, stage one).
- **M13 Dynamic campaign** (section 9.3, stage two).

**Stage D: breadth**

- **M14 Modern layer two**: attack drones, loitering munitions, electronic warfare, active protection, command and control (section 9.5).
- **M15+**: weather and seasons, more factions, editors, real terrain, sound, multiplayer, packaging.

The order inside stages C and D may change after the M6 review. The medical system may be pulled forward if the owner wants it; the foundations allow that.

## 12. How to work in each session

1. Read `CLAUDE.md`, `docs/STATE.md` and the current milestone in `docs/ROADMAP.md`.
2. Propose the slice for this session and its acceptance checks. For anything touching design (behaviour the player will notice, domain realism, priorities), ask the owner with multiple-choice questions. For pure software choices, decide and record.
3. Plan before coding when the slice touches several systems. Check the plan against section 4.3 and the foundation requirements in section 9.
4. Implement with tests. Run the checks as you go.
5. Before finishing: full check suite, determinism test, relevant sim labs or batch report, screenshots for visual changes, independent review against the specification.
6. Update `STATE.md`, `ROADMAP.md`, `DECISIONS.md`, `HOW_IT_WORKS.md`. Open or merge the pull request so the build deploys.
7. Report to the owner in plain language: what was built and how it works, evidence, what is weak or unfinished, what to try on the deployed build, and the questions you need answered next.

Be ambitious inside a slice: handle the edge cases, build the debug view, write the lab. Do not be ambitious across slices: never start the next milestone uninvited, and never add a feature from section 8 or 9 early because it seems easy.

When the specification is wrong or underspecified, say so and propose a change to `docs/SPEC.md` rather than silently diverging.

## 13. Risks to manage actively

- **The behaviour layer disappoints.** Mitigation: sim labs, batch reports, debug overlays, and time reserved in M4 and M6 for tuning. Report honestly when behaviour looks robotic or stupid in screenshots or logs.
- **Scope creep.** The roadmap is long. Nothing after M6 matters if M6 is not fun.
- **Performance on phones.** Measure from M2 onwards on the benchmark scenario; keep the renderer simple.
- **Data plausibility.** Sourced, linted, flagged for confidence; the owner reviews domain data.
- **Loss of determinism.** Guarded by tests in continuous integration from M0.
- **The owner losing track of his own project.** Plain-language summaries and `HOW_IT_WORKS.md`, every session.

## 14. What to do in this first session

1. Save this message as `docs/SPEC.md`.
2. Ask the owner these questions as multiple choice, with a recommended option first:
   - Working title for the project.
   - Language of the interface at the start (English, German, or both through the string table).
   - Scenario setting flavour (fictional region with generic European terrain, or another option he prefers).
   - Whether the repository should be public or private, and which licence to use if public.
   - Whether he wants the medical system pulled forward to directly after M6.
3. Check the current stable versions of the tools in section 4.1 and the current Claude Code documentation for hooks, skills and subagents, then write `docs/ARCHITECTURE.md` (interfaces first: state, orders, events, items and containers, wounds, communication state, battle input and result), `docs/ROADMAP.md`, `docs/DECISIONS.md`, `docs/STATE.md`, `docs/HOW_IT_WORKS.md`, `docs/DATA_GUIDE.md` and a short `CLAUDE.md`.
4. Carry out milestone M0 only.
5. Finish with the report described in section 12, step 7, including the URL of the deployed build.

---

## Appendix: prompts the owner can use in later sessions

These are for the owner to paste later. They are not instructions for the first session.

**Continue:**
> Read CLAUDE.md, docs/STATE.md and the current milestone in docs/ROADMAP.md. Propose the next slice and its acceptance checks, ask me any design questions as multiple choice, then build it following section 12 of docs/SPEC.md.

**After playing a build:**
> I played the current build. Observations: [what happened, what felt wrong, what was confusing]. Turn each into either a bug, a tuning task or a design question, show me the list with your recommendation for each, then fix the bugs and tuning tasks. Use the sim labs or a batch run to show before and after.

**Honest status check:**
> Without changing any code, review the project against docs/SPEC.md. Tell me bluntly: what is solid, what is fragile, which architectural rules or foundation requirements are at risk, and what you would fix before going on. Give evidence for each point.

**Changing the plan:**
> I want to change the design: [change]. Before doing anything, tell me which parts of docs/SPEC.md, the architecture and the roadmap this affects, what it costs, and what you recommend. Then update docs/SPEC.md and docs/DECISIONS.md once I agree.

**Explain it to me:**
> Explain how [system] works in this project in plain language, with one small example traced step by step from an order to the events it produces. Then update docs/HOW_IT_WORKS.md if it is out of date.
