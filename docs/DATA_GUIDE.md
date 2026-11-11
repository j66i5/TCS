# Data guide

How to add or change game data without touching engine code. All data lives in `packages/data/`:

```
packages/data/
  core/                       shared by all factions
    movement-modes.json       walk, run, sneak, crawl (speeds)
    qualities.json            conscript, regular, veteran (skill distributions)
    strings.en.json           interface text (English)
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

## Add a weapon or a vehicle

Not yet possible: the weapon and ammunition file format arrives with ballistics in **M2**, vehicles in **M7**.
This guide will gain those sections then. (Magazines and other carried items can already be added as items.)

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
