# Data guide

How to add or change game data without touching engine code. All data lives in `packages/data/`:

```
packages/data/
  core/                       shared by all factions
    movement-modes.json       walk, run, sneak, crawl (speeds)
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
man's load). Every man also has `eye`.

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
runs and how long it must be quiet to rally, stress after rallying). After a change run `npm run lab -- suppression` and compare the table.

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

Roofs: each building kind in `core/terrain/buildings.json` has `roofMaterial` and `roofThicknessM`.

## Add a vehicle

Not yet possible: the vehicle format arrives in **M7**.

## Add a whole faction

1. Copy `fixtures/factions/xf/` to `factions/<new-id>/`.
2. Set `manifest.json`: `id` must equal the folder name; remove `"fixture": true`; set `nameKey`,
   `defaultQuality`, sources.
3. Replace ranks, roles, names, items, units, doctrine and strings with researched values and sources.
4. `npm run lint:data` until there are no errors. The faction is now loadable; scenarios can use it by ID
   (for example `?factions=de,<new-id>` in the app URL once the scenario menu exists).

No code change is needed. If you find you need one, that is a bug in the engine — report it.

## Strings and radio phrasing

`strings.en.json` maps keys to text. `{name}` placeholders are filled in by the game, e.g.
`"radio.ack.move": "{callsign}: roger, moving."`. A faction's table overrides the core table, which is how each
side gets its own phrasing. Other languages: add `strings.de.json` etc. next to the English file.
