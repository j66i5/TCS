---
name: add-data-entry
description: Add or change faction data in TCS (weapons, ammunition, items, ranks, roles, unit templates, vehicles, doctrine, names, strings) with public sources and confidence. Use whenever editing packages/data.
---
# Add a data entry

Rules (SPEC 3 and 7):
- Public, open sources only (manufacturer data, official public websites, published references, reputable
  defence journalism, Wikipedia as a starting point). Never ask the owner for non-public information and never
  include any if offered.
- Every entry has `sources` (URLs) and `confidence` ("high" | "medium" | "low"). Values are game abstractions;
  where sources disagree or are missing, choose a plausible value, set `confidence: "low"`, and explain in `note`.
- IDs are lower-case with dashes; item IDs are globally unique, so prefix them with the faction ID (`de-...`).
- Every `nameKey` / `abbrKey` needs an entry in the faction's `strings.en.json` (or `core/strings.en.json`).
- No code changes for data. If an engine change seems necessary to express the data, stop and explain why.

Steps:
1. Read `docs/DATA_GUIDE.md` for the file you are editing.
2. Edit the JSON under `packages/data/factions/<id>/` (or `core/`).
3. `npm run lint:data` - fix every error; review warnings.
4. `npm test` - the fixture-faction and loader tests must stay green. If a golden replay's catalog fingerprint
   changes, the change is intended: record it in `docs/DECISIONS.md` and run `npm run golden:update`.
5. List new low-confidence entries in `docs/STATE.md` under "Open questions for the owner" so he can review them.
