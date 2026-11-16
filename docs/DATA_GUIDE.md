# Data guide

How to add or change game data without touching engine code. All data lives in `packages/data/`:

```
packages/data/
  core/                       shared by all factions
    movement-modes.json       foot paces (walk, run, sneak, crawl) and vehicle paces (drive-slow, drive, drive-fast; wdrive-* wheeled)
    qualities.json            conscript, regular, veteran (skill distributions)
    strings.en.json           interface text (English)
    terrain/
      materials.json          what walls are made of: density, penetration resistance, hardness
      surfaces.json           ground types: movement cost per movement class, noise, dust, colour
      vegetation.json         crops, scrub, woodland...: height, concealment, bullet stopping, movement, colour
      obstacles.json          wall/hedge/fence/embankment kinds: height, thickness, material, crossing
      buildings.json          building kinds: size ranges, storeys, wall material and thickness, roof colours
  factions/<id>/              one folder per faction ("de", "ru", ...)
    manifest.json             id, display name key, default quality, format version
    ranks.json                ranks with NATO code and seniority grade
    roles.json                roles (team leader, rifleman, ...)
    names.json                given names, family names, female share
    items.json                equipment items (magazines, grenades, kit) with mass
    units.json                unit templates (who is in a team/squad/platoon, with what load)
    doctrine.json             doctrine profile values
    vehicles.json             vehicle types (optional; M7)
    strings.en.json           names of ranks/roles/items, radio phrasing
  fixtures/factions/xf/       a made-up faction used by the tests; a good template to copy
```

After any change run:

```
npm run lint:data     # checks every file; lists errors and low-confidence entries
npm test              # the fixture faction and loader tests must stay green
```

## Rules for every entry

- **Public sources only.** Manufacturer data, official public websites, published references, reputable defence
  journalism, Wikipedia as a starting point. Never non-public information.
- Every entry has `"sources": ["https://..."]` and `"confidence": "high" | "medium" | "low"`.
- Values are **game abstractions**. If sources disagree or say nothing, choose a plausible value, set
  `"confidence": "low"` and say why in `"note"`. An entry without sources *must* be `low` *and* have a note.
- IDs are lower case with dashes (`team-leader`, `de-g95-mag`). **Item IDs are prefixed with the faction ID**,
  because items from all factions in a battle share one list.
- Every `nameKey` / `abbrKey` must exist in the faction's `strings.en.json` (or `core/strings.en.json`).

## Add a rank

In `factions/<id>/ranks.json`:

```json
{ "id": "feldwebel", "nameKey": "rank.de.feldwebel", "abbrKey": "rank.de.feldwebel.abbr",
  "natoCode": "OR-6", "grade": 8,
  "sources": ["https://de.wikipedia.org/wiki/Dienstgrade_der_Bundeswehr"], "confidence": "medium" }
```

`grade` orders seniority (used later for leadership succession). Then add `"rank.de.feldwebel": "Feldwebel"`
and `"rank.de.feldwebel.abbr": "Fw"` to `strings.en.json`.

## Add an item

In `factions/<id>/items.json`. Items that hold a charge (rounds in a magazine, litres in a can) give the
capacity, the mass of one unit of charge, and what the charge is made of:

```json
{ "id": "xf-mag", "nameKey": "item.xf-mag", "category": "magazine",
  "massKg": 0.1, "chargeCapacity": 20, "chargeMassKg": 0.012, "chargeItem": "xf-round",
  "sources": [], "confidence": "low", "note": "Made-up test fixture." }
```

`massKg` is the empty item. Categories are free text that systems search for generically (`magazine`,
`grenade`, `medical`, `armour`, `supply`).

## Add a unit template

In `factions/<id>/units.json`. A template lists its members (role, rank, load) and may contain sub-units by
template ID, so a platoon is a template whose `subunits` are squad templates:

```json
{ "id": "porter-gang", "echelon": "team", "callsign": "Gang {n}", "leaderIndex": 0,
  "members": [
    { "role": "boss", "rank": "boss", "load": [ { "item": "xf-mag", "count": 4, "charge": 20 } ] },
    { "role": "porter", "rank": "private", "load": [] }
  ],
  "subunits": [], "sources": [], "confidence": "low", "note": "..." }
```

`{n}` in the callsign becomes the unit's number. `leaderIndex` points into `members` (`-1` = none, e.g. a
platoon whose leader sits in a headquarters sub-unit). Quality (conscript/regular/veteran) is **not** part of
the template; it is chosen when a force is built.

## Change terrain

Terrain kinds live in `core/terrain/`. Movement costs are time multipliers per movement class
(`"foot"`, `"wheeled"`, `"tracked"`; `null` = impassable): woodland with `"foot": 1.25` means walking through
it takes 25 % longer than on open grass. `resistance` of a material is "millimetres of mild steel per
millimetre of material" and drives bullet penetration from M2; `concealmentPerM` of vegetation is the share
of a line of sight blocked per metre of it (M3). `colour` is how the renderer paints it. Changing values needs
no code. The map generator places specific kinds by ID (e.g. `"hedge"`, `"farmhouse"`), so removing or
renaming one of those IDs makes generation fail with a message naming the missing ID.

## Add ammunition

In `factions/<id>/ammunition.json`. One entry per kind of round; it automatically also becomes a counted item
(one round, with the cartridge mass), so magazines can hold it.

```json
{ "id": "de-556-dm11", "nameKey": "ammo.de-556-dm11", "calibre": "5.56x45", "kind": "ball",
  "projectileMassKg": 0.004, "cartridgeMassKg": 0.0123, "diameterM": 0.0057,
  "drag": { "a": 0.061, "b": 193, "max": 0.5 },
  "penetration": { "steelMm": 3.5, "atVelocityMps": 425 },
  "tracer": false, "fuse": "none", "guidance": "unguided",
  "sources": ["https://..."], "confidence": "medium", "note": "..." }
```

- `drag`: the air-resistance coefficient is `a + b / speed`, capped at `max`. To fit a new bullet, take a
  published table of speed at 100, 200, 300 ... m, adjust `a` and `b`, and compare with `npm run lab -- cover`
  (flight table) until the speeds match.
- `penetration`: a published "x mm of mild steel at y m" figure, entered as the thickness and the bullet's speed
  at that distance. The game scales it with speed.
- `kind`, `fuse`, `guidance`: from fixed lists (ball, armour-piercing, tracer, high-explosive, fragmentation,
  shaped-charge ... / none, impact, time ... / unguided, command-wire ...). Explosive rounds add an `explosive`
  block (used from M2.4).
- Tracers: `"tracer": true` and `"tracerBurnoutM"`.
- Wire-guided missiles (owner 2026-11-13; a simple model until M9): `"guidance": "command-wire"` and a `guided`
  block — `cruiseMps` (the missile's speed), `accelMps2` (from the launcher's velocity up to it), `turnRateDegS`,
  `minRangeM` and `maxRangeM` (the wire), `trackErrorMrad` (the gunner's tracking error, one standard deviation at
  skill 0.5) wandering with `trackTauS`, `lookaheadS` (how far ahead on the sight line it is steered) and
  `lostKickMrad` (how hard it is thrown off when the gunner loses it). Give it an `explosive` block with
  `selfDestructSeconds` (end of the wire) and a shaped-charge `kind` with `penetration.steelMm` (published mm RHA x
  1.25). The launcher is a station weapon (`type` `"launcher"`, `reloadSeconds` = time to put the next missile on,
  halted; its `ammo` velocity = the launch speed) fed by an item with `chargeItem` the missile and `chargeCapacity`
  1 (`feedKind` `single`, `ready` `{ count: 1, charge: 1 }`); spare missiles go in `stowed`. Check with
  `npm run lab -- missile`.

## Add a weapon

In `factions/<id>/weapons.json`:

```json
{ "id": "de-g36", "nameKey": "weapon.de-g36", "type": "rifle", "calibre": "5.56x45", "massKg": 3.63,
  "feed": { "magazine": "de-g36-mag" }, "fireModes": ["semi", "auto"], "cyclicRpm": 750,
  "dispersionMrad": 0.4, "reloadSeconds": 3.0, "setupSeconds": 0, "jamProbability": 0.0002,
  "sights": [ { "kind": "magnified", "magnification": 3 } ],
  "ammo": { "de-556-dm11": 920, "de-556-dm21": 920 },
  "sources": ["https://..."], "confidence": "medium" }
```

`ammo` lists what the weapon fires with the muzzle velocity from this barrel (m/s). The magazine is an item in
`items.json` whose `chargeItem` is one of those ammunition IDs. `dispersionMrad` is the weapon's own scatter
(one standard deviation; 1 mrad = 10 cm at 100 m). The loader checks all these links.

A **machine gun** adds `"sustained": { "burstRounds": 5, "intervalS": 2.5, "recoilFactor": 0.3 }` (it then
fires that burst at every range; `recoilFactor` is how much of a rifle's climb within a burst it shows) and is
fed from a belt: an item like a magazine with, optionally, `"tracerItem": "<tracer ammunition id>"` and
`"tracerEvery": 5`. Sight kinds: `iron`, `reflex`, `magnified`, `telescopic`, `night`, `thermal`; how much each
helps is `aim.sightFactor` in `core/shooting.json`.

The squad the game starts with is named in the faction's `manifest.json`: `"demoTemplate": "<unit template id>"`.

## Sensors (what a man looks through)

`core/spotting.json` lists `sensors` by kind: `factor` (how much easier he spots beyond `fromM` metres) and
`nightLight` (the light level it gives at least: 0.5 for night vision, 1 for thermal). A weapon sight's `kind`
is looked up there; an item gets a sensor with `"sensor": "night"` (for example a night-vision goggle in a
man's load). Every man also has `eye`. Optional per sensor (M7.3): `smokeFactor` (share of the view kept
through ordinary smoke; 0 = blinded, thermal 0.5), `maxRangeM`, `fogFloorM` (sees at least this far in fog) and
`rainFactor`. The `vehicles` block sets how vehicles are seen and heard (reference area, tracking, drift and
forgetting of vehicle contacts, engine-noise factors).

## Change what stops a bullet

`core/terrain/materials.json`: `resistance` is millimetres of mild steel per millimetre of the material
(brick 0.10 means 11 cm of brick is worth 11 mm of steel); `ricochetAngleDeg` is the largest angle from the
surface at which bullets still glance off. `npm run lab -- cover` shows the effect on typical walls.

## Add armour (helmet, vest)

Armour is an ordinary item in `factions/<id>/items.json` with an `armour` list. Each line says which body zone
it covers (`head`, `neck`, `chest`, `abdomen`, `pelvis`, `arm`, `leg`), what share of that zone it covers seen
from the front/back and from the side (0–1), and how much it stops in millimetres of mild steel (the same
measure as walls and bullets):

```json
{ "id": "de-vest", "nameKey": "item.de-vest", "category": "armour", "massKg": 9.5,
  "armour": [
    { "zone": "chest",   "coverageFront": 0.75, "coverageSide": 0.15, "protectionSteelMm": 26 },
    { "zone": "chest",   "coverageFront": 0.2,  "coverageSide": 0.6,  "protectionSteelMm": 1.5 },
    { "zone": "abdomen", "coverageFront": 0.35, "coverageSide": 0.05, "protectionSteelMm": 26 }
  ],
  "sources": ["https://..."], "confidence": "medium", "note": "..." }
```

A man wears what is in his load (unit template `load`). A bullet's own figure (`penetration.steelMm`, scaled
with its speed) is compared with the protection at the spot struck. `npm run lab -- casualty` shows the effect.

## Change how wounds work

`core/wounds.json`: `hitboxes` (body outline per posture: bands with zone, from–to share of the height or
length, half width), `zones` (typical severity of a rifle wound, the severity that kills at once or knocks
out, worst-case bleeding in litres per second), `wounding` (knock-down seconds, energy scaling), `physiology`
(blood volume, the blood-loss shares for unconsciousness and death, clotting, the breathing clock) and
`effects` (when a man can no longer walk or use his rifle). After a change run `npm run lab -- casualty` and
compare the table.

## Field repair (M11.7a)

`core/repair.json` (optional; without it crews repair nothing): `repair.tasks` per component kind — `outside` (the
men work beside the hull, exposed) or inside, `men` (how many work at it), `manMin` (man-minutes at work rate 1),
`minCondition` / `restoreTo` (a component below `restoreTo` and at least `minCondition` is a task; done, it is back
at `restoreTo`), `chance` (it works; a failed task makes that component beyond the crew for the battle). `order`:
which damaged kind first (every task kind must be in it). `stepS`, `quietS`, `underFireS`, `enemyNearM`,
`suppressionStop`, `orderHitS`: when the crew starts, stops and refuses an order (see HOW_IT_WORKS). `skill`: work
rate per man 1 + `k` x (skill `key` - `ref`), at least `minRate`, the driver x `driverFactor`. `workshopDays`: days
in the workshop per component kind at condition 0 (campaign input). Search extracts only: `"medium"` at most.
After a change run `npm run lab -- repair`.

Recovery (M11.7b): the optional section `recovery` of `core/repair.json` (without it no recovery vehicle is ever
called): `delayMinS`-`delayMaxS` (the call to its coming on), `pace` / `nearPace` (movement modes), `approachM` (it
reverses this last stretch onto its spot), `gapM` (hitch to hull), `standTolM`, `waitShortM` / `hitS` /
`enemyNearM` / `quietS` / `giveUpS` (it waits short of a hull under fire), `edgeM`, `heldMaxS`, `retryS`,
`abandonedDays` (workshop days of an abandoned hull without damage). A faction's manifest
`recovery: { template, count }` names the crew template (its vehicle must have a `recovery` block) generated battles
put off the map for each side with vehicles of its own.

## Medical data (M10.1)

`core/medical.json`: `physiology` (rates of the "medical" body model: tension pneumothorax chance, onset and
time to death; head injury chance and lucid interval; fracture chance; burn fluid loss; fluids; hypothermia;
the tourniquet clock), `levels` (the skill each medical job treats with), `interventions` (one entry per
treatment: what it treats, whether it is allowed under fire, seconds and success by skill — `self`, `buddy`,
`firstResponder`, `medic`; a skill not listed cannot do it — the items it uses up by **tag**, and its effect),
`carry` (ways of moving a casualty), `chain` (the 10-1-2 time targets), `protection` (recognising protected
people, breach chances) and `triage`. Research comes from search extracts only, so nothing in medical data may
claim `"high"` confidence (the data lint refuses it). After a change run `npm run lab -- casualty`.

Medical items carry `"medical": { "tags": [...], "timeFactor": 1, "successFactor": 1 }`: an intervention uses
any item with its tag, and the factors make a worse item slower and less reliable (the Russian rubber tourniquet:
1.4 and 0.8). A red cross armband is an item with `"emblem": true`. A role with a medical job has
`"medical": { "level": "firstResponder" | "medic" | "stretcherBearer" | "ambulanceCrew", "interventions": [...] }`;
list `interventions` only when the national training is narrower than the level. A man's medical kit is counted
items in his load (the bag itself is an item for its empty mass).

`care` (M10.2) says how first aid is given: `stepS` (how often each wounded man is looked at), `buddyReachM` (a
comrade this close treats a man who cannot treat himself), `maxAttempts` (tries of one intervention on one wound),
`painTreatAt`, `skillRef` / `skillK` (a man's own medical skill moves the chance: × (1 + skillK × (skill −
skillRef))), `underFireSuppression` / `underFireSeconds` (what counts as under fire), `junctionalZones` (where a large
bleed needs packing) and `order` — the interventions in MARCH order; the first one the casualty needs and the helper
can do is done. Every id in `order` must be an intervention (the loader checks). After a change run
`npm run lab -- treatment`.

## Change how fire frightens men

`core/behaviour.json` (M4): `suppression` (near-miss radius, suppression per round and the energy it is scaled
to, bursts, how fast it fades), `stress` (growth under suppression, blows from a comrade falling, the leader
lost, an own wound; damping by experience and a leader nearby; how fast it fades under light fire), `states`
(the suppression that pins and releases, the stress for cautious / shaken / panicked and for calming down) and
`effects` (rate-of-fire factors), `decisions` (the default fire rule, engagement ranges by weapon, what counts
as being under fire and for how long, cover search radius and how often, ammunition sharing range, spare kept,
hand-over time), `drills` (reaction to contact on or off, bound length, the last stretch rushed together,
how long a bound may take, spread on the objective, the share of panicked men that breaks a unit, how far it
runs and how long it must be quiet to rally, stress after rallying; covering fire, overnight pick 2026-11-14: how far
short of the point a drill's or an order's rounds may go into cover `suppressShortM` and how often they are fired
there `suppressIntervalS`, how far round the objective a covering man looks for an enemy he can hit
`coverTargetM`, how often a man with no shot looks again `coverRetaskS` and whether he moves aside for one
`sidestep`, how far runners keep out of covering lines `laneClearM` / `laneShiftMaxM`, and "no move without fire"
`coverFiredS` / `coverWaitS`, 0 = off). After a change run `npm run lab -- suppression` and compare the table.
Men aboard a vehicle (owner 2026-11-13): `stress.fromOwnVehiclePenetrated` and `stress.fromOwnVehicleStruck` (a
cannon round, heavy bullet or burst that does not get through) are their only blows from outside besides a
comrade or leader falling inside the same vehicle. `gunnery.missile*` (owner 2026-11-13): the range beyond which a
crew prefers its guided missile at a vehicle (`missileBeyondM`), the speed below which it counts as halted for
firing and reloading one (`missileHaltedMps`), how often the gunner's sight line is checked
(`missileSightSeconds`), the share of the view below which he loses the target (`missileSeenFloor`), and his chance
of losing the missile when his own hull is struck (`missileHitLoseChance`).

## Add a grenade or launcher round

Two entries in `factions/<id>/ammunition.json`: the munition and one of its fragments.

```json
{ "id": "xf-bomb", "nameKey": "ammo.xf-bomb", "calibre": "hand-grenade", "kind": "fragmentation",
  "projectileMassKg": 0.4, "cartridgeMassKg": 0.4, "diameterM": 0.06,
  "drag": { "a": 0.5, "b": 0, "max": 0.6 }, "penetration": { "steelMm": 0, "atVelocityMps": 100 },
  "tracer": false, "fuse": "time", "guidance": "unguided",
  "explosive": { "fillingKg": 0.08, "fragmentCount": 800, "fragmentAmmo": "xf-shard",
                 "fragmentVelocityMps": [800, 1200], "fuseSeconds": 4 },
  "delivery": { "method": "thrown" },
  "sources": ["https://..."], "confidence": "medium" },
{ "id": "xf-shard", "nameKey": "ammo.xf-shard", "calibre": "fragment", "kind": "fragment",
  "projectileMassKg": 0.0002, "cartridgeMassKg": 0.0002, "diameterM": 0.004,
  "drag": { "a": 0.9, "b": 0, "max": 1 }, "penetration": { "steelMm": 2, "atVelocityMps": 1000 },
  "tracer": false, "fuse": "none", "guidance": "unguided", "sources": [], "confidence": "low", "note": "..." }
```

- `fillingKg` sets the blast (radii grow with its cube root); `fragmentCount` and the fragment entry set who is
  hit how far away. Give the men the grenade in their `load` like any item (`{ "item": "xf-bomb", "count": 2 }`).
- A launcher round has `"fuse": "impact"`, `"armingSeconds"` instead of `fuseSeconds`, and
  `"delivery": { "method": "launched", "velocityMps": 76, "launcher": "<item id>", "maxRangeM": 350 }`; the
  launcher itself is an item in `items.json` (category `launcher`) that the man must carry.
- `npm run lab -- fragmentation` shows the effect by distance; add the new munition to the list in
  `packages/tools/src/labs/fragmentation.ts` to see it there.
- A hand smoke grenade (D1) has `"kind": "smoke"`, no `explosive`, `"delivery": { "method": "thrown" }` and
  `"smoke": { "fuseSeconds": 2, "radiusM": 10, "seconds": 60 }`: after the fuse it smokes where it lies, a cloud of
  that radius (growing over `spotting.smokeBuildSeconds`) for that long; it never wounds. Men carry it in their
  `load` like any grenade. A fragmentation grenade order never takes it; the player's "Smoke grenade" order and the
  units' own screens (`core/behaviour.json` `smoke`: on a withdrawal, on a move under fire) do.
  `npm run lab -- smoke` measures the cloud (add the munition to the list in `packages/tools/src/labs/smoke.ts`).

Roofs: each building kind in `core/terrain/buildings.json` has `roofMaterial` and `roofThicknessM`.

## Add a mortar (on the map, M8.3)

An on-map mortar is a **tube item** carried by its gunner, **rounds** carried by the crew, a **team** template and,
for generated battles, a **section** template named in the manifest. Off-map fire support (the battery a platoon
calls, `doctrine.json` `fireSupport`) stays as it is; a side with mortar teams calls them first.

1. **Rounds** in `factions/<id>/ammunition.json`: an HE round with an `explosive` block (and its fragment entry, as
   for a grenade above) and a smoke round (`"kind": "smoke"`), both with the tube's `calibre` (e.g.
   `"120mm-mortar"`). Every ammunition entry is a counted item too (rule 9): the crew carry them in their `load`.
2. **The tube** in `factions/<id>/items.json` (category `crew-served`):

```json
{ "id": "xf-tube", "nameKey": "item.xf-tube", "category": "crew-served", "massKg": 42,
  "mortar": { "calibre": "82mm-mortar", "he": "xf-82-he", "smoke": "xf-82-smoke",
              "minRangeM": 85, "maxRangeM": 4270, "setupSeconds": 60, "packSeconds": 30, "roundSeconds": 4,
              "crew": 4, "crewMin": 2, "aimErrorM": 15, "dispersionPerKmM": 10, "processingSeconds": 25,
              "flightBaseSeconds": 8, "flightPerKmSeconds": 6, "hearingRangeM": 3000 },
  "sources": ["https://..."], "confidence": "medium", "note": "..." }
```

   - `minRangeM`/`maxRangeM`: a call outside this band goes to another tube or the off-map battery; with neither
     it is refused ("out of range").
   - `setupSeconds` (x crew / men at the tube when short-handed), `packSeconds` (a move waits for it).
   - `roundSeconds`: seconds per round at the sustained rate with the full `crew`; each missing, pinned (x0.35) or
     shaken (x0.7) man slows it; below `crewMin` men (able, not panicked, within 20 m) the tube stops.
   - `aimErrorM` is the tube's own first-round error (as `fireSupport.rangingErrorM` for the battery); the location
     error and the ranging and adjustment rules come from the faction's `fireSupport` (`locationError`, `adjust`,
     `rangingRounds`, `rangingCorrection`, `requestSeconds`, `splashSeconds`).
   - `dispersionPerKmM`: each round's scatter, one standard deviation per axis, per km of range.
   - `processingSeconds`: the crew computing and laying after the call; then each round flies
     `flightBaseSeconds + flightPerKmSeconds` x km.
   - `hearingRangeM`: how far the enemy hears it fire (contacts; rifles 1,500 m); the gunner also counts as firing
     for the enemy's spotting (the flash).
   The loader checks that `he` is an explosive and `smoke` a smoke round of this faction, both of the `calibre`.
3. **Roles** in `roles.json` (e.g. `mortar-leader`, `mortar-gunner`, `mortar-loader`, with strings).
4. **A team** in `units.json` (one tube): the gunner's `load` holds the tube (`{ "item": "xf-tube", "count": 1 }`),
   the others the rounds (`{ "item": "xf-82-he", "count": 12 }`, smoke rounds). Any unit whose men carry a tube is a
   mortar team; a unit with no men of its own whose sub-units are all teams is a mortar section (the AI commander
   does not manoeuvre it).
5. **A section** (`"echelon": "section"`, `"leaderIndex": -1`, `"members": []`, `"subunits"`: the teams) and
   `"mortarTemplate": "<section id>"` in `manifest.json`: generated battles with `mortars: true` (tools scenarios
   `platoon-mortars`, `platoon-ru-mortars`; app `?mortars=1`) put it behind the side's line instead of the off-map
   allotment.

Check with `npm run lint:data`, `npx vitest run packages/tools/test/mortars.test.ts` and
`npx vitest run packages/tools/test/mortars-signature.test.ts`, and a batch of `platoon-mortars`.

## Add a tank section (M7.6b)

A tank section is **a unit template with no men of its own** (`"echelon": "section"`, `"leaderIndex": -1`,
`"members": []`) whose `"subunits"` are all **vehicle crews** (templates with `"vehicle"`) of vehicles with **no
passenger seats** (tanks), e.g. DE `panzer-halbzug` (two `leopard2a7v-besatzung`), RU `tankovaya-gruppa` (two
`t72b3m-ekipazh`; `tankovaya-gruppa-t90m` for the T-90M), the fixture's `tortoise-pair`. Name it in `manifest.json`
as `"tankSectionTemplate": "<section id>"`: generated battles with `tanks: true | "attacker" | "defender"` (tools
scenarios `platoon-vehicles-tanks`, `platoon-ru-vehicles-tanks`, `platoon-vehicles-tanks-both`; app `?tanks=1`,
`?tanks=attacker`, `&tankCrew=<blue section>,<red section>`) add it as a unit of its own; the AI commander recognises
it from the data alone (crews of vehicles that carry no one) and runs it in overwatch (`ai/src/tanks.ts`).

The loader checks (errors): the template exists; it has no members and at least one sub-unit; every sub-unit is a
vehicle crew; none of their vehicles has a passenger seat. Check with `npm run lint:data` and
`npx vitest run packages/tools/test/scenario-tanks.test.ts packages/tools/test/tanks-ai.test.ts`.

## Add a reconnaissance drone (M9.4a)

A quadcopter is an **airframe item** with a `drone` block and a **battery item** with a charge in Wh, both carried by
the man who flies it (a platoon's HQ member: put them in his `load`). No code: the `drone` order, the sidebar tile and
the cameras read the data.

```json
{ "id": "xf-quad", "nameKey": "item.xf-quad", "category": "drone", "massKg": 1.2,
  "drone": { "battery": "xf-quad-battery", "powerW": 120, "reserveShare": 0.15, "cruiseMps": 10, "climbMps": 4,
             "altitudeM": 100, "minAltitudeM": 20, "maxAltitudeM": 400, "launchSeconds": 45, "controlRangeM": 2000,
             "sensors": ["drone-day", "drone-thermal"], "footprintM": 250, "noiseM": 100, "areaM2": 0.15 } }
{ "id": "xf-quad-battery", "nameKey": "item.xf-quad-battery", "category": "battery", "massKg": 0.4,
  "chargeCapacity": 70, "chargeMassKg": 0 }
```

`sensors` are kinds in `core/spotting.json` `sensors` (add a new camera there); `footprintM` is the radius on the
ground its cameras search; `noiseM` and `areaM2` are for being heard and seen (M9.4b). The loader checks the battery
item (it must have a charge) and the heights (min <= usual <= max). How a man looks from above and what a tree canopy
leaves of him are in `core/spotting.json` `drone`.

## Night and light (M9.1)

`core/spotting.json` `night`: `sun` is a table of `[hour, light]` points (local time 0-24, light 0..1, interpolated);
`moonFullLight` the light of a full moon (scaled by the battle's `moon`); `flashLight` the light a man's muzzle
flash gives him at night for every observer; `vehicleFlashLight` the same for a firing vehicle; `tracerContrast` how much more a man firing tracers shows in full darkness. Sensors keep
their `nightLight` (the light they see by at least: goggles 0.5, thermal 1). A battle follows the clock only with
`environment.sky` (`environmentAt(catalog, seconds, moon)`; app `?time=`, tools `--time`). Check with
`npm run lab -- night`.

## Sensor physics (M9.2)

A sensor kind in `core/spotting.json` `sensors` may set `thermal: true` (it sees heat) and `arcDeg` (the half-angle
it covers from where a man looks; a sight or goggle, not his eyes). `thermal` gives heat relative to what the eye
sees: `man`, `vehicleCold` (halted longer than `hotSeconds`), `vehicleHot` (moving or moved within `hotSeconds`), `vehicleFiring`,
`vehicleBurning`, and `vegetationExponent` (visibility through vegetation for heat = visibility^exponent; the better of the best
sensor and the best thermal one counts). Items: a
thermal weapon sight is an item with `"sensor": "thermal"`; a thermal blanket has `thermalCover` (the share of a still
man's heat it lets through). Check with `npm run lab -- thermal`.

Powered devices (M11.6): an item with `power: { battery, hours, swapSeconds, onBelowLight? }` runs on `battery` (an item
of the same faction with `chargeCapacity` in Wh and no `chargeItem`; category "battery"); it draws `chargeCapacity /
hours` W; changing the battery takes `swapSeconds`; a night device is on only while the light is below `onBelowLight`
(set it to its sensor's `nightLight`, so the device is on whenever it helps: a device switched off gives nothing; a
device used by day too, such as a thermal sight, has no `onBelowLight`: always on).
Every load that carries a device lists its batteries too (devices x (1 fitted + spares), with `charge` = full); setup
fits the fullest. Water items have `water: true` and a charge in ml (`chargeCapacity` 2000). Core
`behaviour.soldier.power`: `installedMin` (the fitted battery's share of full at the start is drawn from [installedMin,
1]), `swapBelowShare` (a lull change below that share) and `lullSpareShare` (a lull change only for a spare holding at
least that share of full, and a quarter of full more than the fitted one). A man-portable radio has `radio: true` (M11.6 stage 2): a unit on foot whose radios
(or, with none of its own, its parent's) are all flat is off the net. A powered item with a `sensor` (goggle, thermal
sight) gives its sensor only while its battery has charge (stage 3): give lab or test loads a battery with the device.
Water (stage 4): optional `core/body.json` `physiology.hydration` (`fromBattleS`: men lose water only in battles of at
least that limit; `lossBaseLph` + `lossExertLph` x exertion, times the heat factor; `deficitMaxL` = hydration 0;
effects from `effectFromL` to `deficitMaxL`; `drinkBelow`, `sipMl`, `drinkSuppressionMax`; `fatigueGainK`, `recoveryK`,
`aimK`). Absent: hydration never changes.

## Guided missiles (M9.3a)

A guided round's `guidance` picks its kind: `command-wire` (the gunner guides it by wire to the end of `maxRangeM`),
`command-beam` (by beam: the same, no wire), `fire-and-forget-direct` / `fire-and-forget-top-attack` (its seeker,
`guided.seekerSmokeFactor`; top attack adds `guided.topAttack {climbM, diveAtM, launchElevationDeg}`). A vehicle
launcher weapon with `reloadOutside: true` is reloaded by a crewman on the roof; a vehicle with `laserWarner: true`
notices beam riders. Check with `npm run lab -- missile`.

## Add a vehicle

Vehicle types live in `factions/<id>/vehicles.json` (optional file; M7). Units are SI except where the field name
says otherwise (`*Kmh`, `*Deg`, `*Kw` are converted when the catalog is built). Every block with numbers carries
its own `sources`/`confidence`/`note` (`body`, `mass`, `drive`, `ramp`, each station). Hull coordinates are
metres: `f` forward (+) / back, `r` right (+) / left, `u` up from the ground.

- `class`: `"tracked"` or `"wheeled"`; `drive.steering.kind` must match. Tracked vehicles need
  `body.trackGaugeM` and `body.trackContactM`, wheeled ones `body.wheelbaseM`.
- `mass.kg`; `drive`: engine `powerKw`, drive-train `efficiency`, `topSpeedKmh` and `reverseTopSpeedKmh` (the
  last gear band must end there), `brakeMps2`, gear bands `gears`/`reverseGears` (`toKmh`, rising), `shiftSeconds`,
  steering (tracked: `pivot`, `pivotRateDegS`, `maxLatAccelMps2`, `slipCoeff`, `turnResistance`; wheeled:
  `maxSteerDeg`, `steerRateDegS`, `maxLatAccelMps2`), `idleKw` and `litresPerKwh` (fuel use).
- `fuel`: `{ "item": "<tank item>", "capacityL": 900 }`. The tank is an item in `items.json` (category `fuel`,
  `massKg` 0, `chargeCapacity` = litres, `chargeMassKg` = kg per litre); the litres in it are its charge, the
  only count of the fuel (rule 9). A new vehicle record starts with a full tank.
- `seats`: `{ id, station, pos: [f, r, u], part: "hull"|"turret", hatch }`; station is one of `commander`,
  `gunner`, `driver`, `loader`, `passenger`. Exactly one driver seat. Without a driver a vehicle does not move.
- `ramp` (exits and the time to open, get in and out), `stations` (turret or mount: traverse and elevation
  rates and limits, stabiliser, errors, weapons with their ready belts and `feedKind` `belt`/`single`/
  `autoloader`; a `single` feed needs `roundLoadSeconds`, and `loaderStation` must be a seat kind of the
  vehicle), `stowed` items. M7.3: a station weapon's `muzzle` is `[f, r, u]` in the turret's frame about its
  pivot (`u` from the ground); `readyRefillInBattle` with `refillSeconds` lets the crew refill ready belts from
  stowed belts of the same item while halted; seat `sensors` (`kind` from `core/spotting.json`, `pos`, `arcDeg`,
  `sideFactor`/`rearFactor` outside the arc, `follows` `"own"` (the hull) or `"station"` (the turret), `lrf`);
  `dischargers` (`item` smoke ammunition counted in `stowed`, `perSalvo`, `salvos`, `arcDeg`, `rangeM`,
  `delaySeconds`, `cloudRadiusM`, `cloudSeconds`); `signature` (`sizeFactor` on the area of the boxes,
  `movingFactor`, `firingFactor`, `identifyM` within which its type is told, engine `noiseIdleM`/`noiseMovingM`,
  `aimPoints` `[f, r, u]`). Ammunition may set `explosive.burstOnBody` (cannon HE bursting on a man struck) and
  `multispectral` (smoke that also blinds thermal sights). `armour` and `components` are reserved (M7.4).
- Crew: a unit template with `"echelon": "vehicle"` and `"vehicle": "<type>"`; each member may name his `seat`
  (default: crew seats in the order commander, gunner, loader, driver). A parent template may give
  `carriage: [{ "crew": <sub-unit index>, "carries": [<sub-unit indices>] }]` (M7.2).
- Ground: `core/terrain/surfaces.json` entries have a `vehicle` block (`rolling` resistance coefficient,
  `traction` and `lateral` friction, optional `capKmh`, and `wetTractionFactor`/`wetRollingFactor` applied in
  full rain); a surface without it cannot be driven on. Obstacles have `vehicle: { tracked, wheeled }`, each
  `null` (goes round) or `{ crossCostCells, capKmh, flattens }`.
- Paces: a move order to a crew names a vehicle pace or a foot pace (mapped by the foot pace's `vehiclePace`).
- Check it with `npm run lab -- drive` (acceleration, top speed, braking, pivot, ground and rain, slope, fuel;
  wheeled hulls: turn 90 degrees from a standstill and the turning circle instead of the pivot).
- Wheeled hulls (M10.6-data): `body.wheelbaseM` is the effective steering wheelbase of the one-track model (front
  axle group to rear axle group); turning radius = wheelbase / tan(`maxSteerDeg`). Component kind `wheels`: each
  side's running gear (box on that side); a damaged side pulls and grips less (0.4 + 0.6 x condition of the worse
  side), a wrecked side immobilises the hull like a wrecked track.
- Ambulances (M10.6-data): `ambulance: { layouts: [{ lying, sitting, lyingOutside? }], marked }` lists the patient
  layouts the hull can take (alternatives), and whether it carries the protective emblem (recognition, M10.7a);
  the `passenger` seats are the sitting places. A crew template whose vehicle has an `ambulance` block is never
  picked as the default crew of the vehicles scenario. The painted emblem is appearance data: a faction
  `appearance.json` may give `markings: { "<vehicle type>": "red-cross" }` (outside the catalog).
- Field repair (M11.7a): `repair: { tool?, parts: { <component kind>: [{ item, count }] } }` lists the crew tasks
  this hull's crew can do (each kind must be a task of `core/repair.json` and a component of the hull) and the
  counted items each task uses up from the container (`[]`: no part, e.g. the radio or a holed 8x8 wheel side).
  `tool` is the crew's tool kit: it must be aboard for any repair and is not used up. Every tool and part item
  must be stowed (at least the count one repair uses; the loader checks). Without a `repair` block the crew
  repairs nothing. Research comes from search extracts only: confidence `"medium"` at most (the lint refuses
  `"high"`).
- Recovery vehicle (M11.7b): `recovery: { towMaxKg, towMaxSpeedKmh, hookUpS, hookUpMen }`: it tows hulls up to that
  combat mass (heavier: refused), at no more than that speed; `hookUpMen` of its crew (not the driver first) work
  `hookUpS` outside to hook one up. Recovery vehicles are unarmed in the game (`stations: []`) and have no
  passenger seats, so they are never a scenario's default crew. Search extracts only: `"medium"` at most.
- Armour figures from sources in mm RHA are multiplied by `rhaToMildSteel` (core/ballistics.json, 1.25) to the
  mild-steel scale the simulation uses; the `armour-steel` material has the same resistance.
- Main battle tanks (M7.6a):
  - Main gun: weapon `type` `"tank-gun"` (mass up to 5000 kg). It counts as a cannon in gunnery and in the
    expenditure tally. Each round type is a single-round item (`chargeCapacity` 1, `chargeItem` = the ammunition)
    fed from the ready rack (`feeds[].ready`); the rest is in `stowed` and refilled by `refillSeconds`, halted.
  - Loading: `feedKind` `"single"` with `loaderStation: "loader"` and `roundLoadSeconds` (a man loads; without
    him `noLoaderFactor` times slower), or `"autoloader"` (needs `roundLoadSeconds`). `startLoaded: true`: a
    round of the first feed is in the breech when the battle starts (not on a belt).
  - Gun-launched missile: a second weapon entry on the same station and muzzle (type `"tank-gun"`), its round a
    guided ammunition. Its missiles are counted apart from the gun's. It is out when the `gun` or the `sights`
    component is wrecked. `missileBeyondM` (guided weapons only): the crew picks it against vehicles at or
    beyond this range (default `behaviour.gunnery.missileBeyondM`). Nearer, the crew picks it only where its
    armour-piercing round cannot get through and the missile can.
  - Armour: plates are line-of-sight equivalents (`slopeDeg` 0) of the core materials `composite-heavy` (western
    special armour: about RHA against long rods, 1.7 times against jets) or `composite-cast` (cast with filler).
    There is one plate per face, so no weak lower glacis or mantlet.
  - Reactive tiles: an item with a `reactive` block (`addKineticMm`, `addShapedMm`, `addTandemMm`: mild-steel mm
    added to the need; `triggerSteelMm`: the least kinetic penetration of a heavy round that sets one off).
    Fit it with an `armour.tiles` row `{ part, face, item, coverage }`, using one item id per face. The stowed
    count is the number fitted. A hit meets a live tile with chance `coverage * tiles left / fitted` and uses
    it up. A tandem charge's precursor sets the tile off, so its main jet meets `addTandemMm`. HE and artillery
    do not strip tiles yet (M14.5). The older `factor` rows (fixture `xf-shingle`) still work: a shaped charge
    only, every hit while tiles last. Each row has exactly one of `factor` or `coverage`.
  - A crew template whose vehicle has no `passenger` seat is never the default crew of the vehicles scenario,
    and in `?scenario=vehicles&crew=...` its squad has no carrier.
  - Check with `npm run lab -- armour` (tiles full and spent), `antitank`, `gunnery`, `missile` and `drive`.

## Add a whole faction

1. Copy `fixtures/factions/xf/` to `factions/<new-id>/`.
2. Set `manifest.json`: `id` must equal the folder name; remove `"fixture": true`; set `nameKey`,
   `defaultQuality`, sources.
3. Replace ranks, roles, names, items, units, doctrine and strings with researched values and sources.
4. `npm run lint:data` until there are no errors. The faction is now loadable; scenarios can use it by ID
   (for example `?factions=de,<new-id>` in the app URL once the scenario menu exists).

No code change is needed. If you find you need one, that is a bug in the engine — report it.

## Platoons for generated battles (M6)

Each faction's `manifest.json` names its `platoonTemplate` (in `units.json`: echelon "platoon", the platoon's
own men in `members`, its squads in `subunits`). Doctrine values used by the AI commander:
`casualtyToleranceBeforeWithdrawal` (share of men down before an attack is broken off). Objective names are
string keys (`objective.main`, `objective.second`).

## Strings and radio phrasing

`strings.en.json` maps keys to text. `{name}` placeholders are filled in by the game, e.g.
`"radio.ack.move": "{callsign}: roger, moving."`. A faction's table overrides the core table, which is how each
side gets its own phrasing. Other languages: add `strings.de.json` etc. next to the English file.
