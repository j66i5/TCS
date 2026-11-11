# State — handover note

_Last updated: 2026-11-11 (M0 done; M1 slices M1.1 and M1.2 done)._

## Current milestone
**M1 Map and movement** — slices **M1.1 terrain and generator** and **M1.2 navigation: done**. Next slice:
**M1.3 the individual soldier moving** (postures, speed from slope/surface/load, fatigue and heart rate,
movement lab).

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
- Tests: 139, all green (incl. 48 generated maps checked for validity and plausibility, map determinism, map
  file round trip, terrain damage save/load). 160 of 160 maps (40 seeds × 4 kinds) pass the strict validity
  check after the independent review's fixes. Benchmark ~200× real time.

## What is weak or missing (honest list)
- Soldiers now route around houses, but **houses are solid** (no entering through doors yet), **slope and
  fatigue do not slow them yet** (M1.3), and the team moves as loose parallel lines, not a formation (M1.4).
- Routes prefer roads only mildly (asphalt is 10 % quicker than grass); they do not yet look for cover (M1.4).
- **Industrial maps are the plainest**: sparse business-park lots with a few sheds and warehouses each.
- Wood edges and scrub still show a faint 4 m grid pattern when zoomed in close.
- The phone top bar wraps onto two rows.
- The map kinds' recipes are code (they name terrain IDs); terrain *properties* are data. See DECISIONS.md.
- German/Russian unit templates, roles and doctrine are still placeholders (low confidence).

## Blocked / needs the owner
1. **Enable GitHub Pages once**: *Settings → Pages → Source: GitHub Actions*, then re-run the latest CI run on
   `main` (or ask Claude). Until then https://j66i5.github.io/TCS/ does not exist.

## Answered by the owner (2026-11-11)
- First squads: German **Panzergrenadier dismounts of a Puma**; Russian **motor-rifle squad on a BMP**.
- Callsigns: German **"Gruppe {n}"** (squad) and **"Trupp {n}"** (team); Russian "Gruppa {n}" kept for now.
- Map look **naturalistic**; villages **mixed street/clustered**; default map **2 × 2 km**.

## Open questions for the owner
- Data to review when convenient: rank lists with NATO codes, name lists, female share in generated units.
