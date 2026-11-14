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
- Armour figures from sources in mm RHA are multiplied by `rhaToMildSteel` (core/ballistics.json, 1.25) to the
  mild-steel scale the simulation uses; the `armour-steel` material has the same resistance.

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
