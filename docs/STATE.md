# State — handover note

_Last updated: 2026-11-11, session 1 (M0 done; M1 slice M1.1 done)._

## Current milestone
**M1 Map and movement** — slice **M1.1 terrain model and generator: done**. Next slice: **M1.2 navigation**
(navigation grid with costs per movement mode, A* pathfinding, spatial hash, path debug overlay).

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
- Tests: 88, all green (incl. 12 generated-map validity/plausibility checks, determinism of maps, map file
  round trip, terrain damage save/load). Benchmark 203× real time.

## What is weak or missing (honest list)
- **Soldiers ignore the terrain**: they still walk in straight lines, through houses, woods and ponds.
  Pathfinding is M1.2; slope, surface and fatigue effects on speed are M1.3.
- **Industrial maps are the plainest**: sparse business-park lots with a few sheds and warehouses each.
- Wood edges and scrub still show a faint 4 m grid pattern when zoomed in close.
- The phone top bar wraps onto two rows.
- The map kinds' recipes are code (they name terrain IDs); terrain *properties* are data. See DECISIONS.md.
- **Spec deviation awaiting approval**: heightfield stored inside the map JSON instead of a separate
  heightmap image (DECISIONS.md, "PROPOSED SPEC CHANGE").
- German/Russian unit templates, roles and doctrine are still placeholders (low confidence).

## Blocked / needs the owner
1. **Enable GitHub Pages once**: *Settings → Pages → Source: GitHub Actions*, then re-run the latest CI run on
   `main` (or ask Claude). Until then https://j66i5.github.io/TCS/ does not exist.

## Answered by the owner (2026-11-11)
- First squads: German **Panzergrenadier dismounts of a Puma**; Russian **motor-rifle squad on a BMP**.
- Callsigns: German **"Gruppe {n}"** (squad) and **"Trupp {n}"** (team); Russian "Gruppa {n}" kept for now.
- Map look **naturalistic**; villages **mixed street/clustered**; default map **2 × 2 km**.

## Open questions for the owner
- Approve the map-format change (heightfield inside the JSON file)?
- Data to review when convenient: rank lists with NATO codes, name lists, female share in generated units.
