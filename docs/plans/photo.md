# Plan "photo" — reference index

The working plan for the photo map look (the map like a soft, low-resolution aerial photograph; original art only,
docs/ASSETS.md) was not committed with the code. Code comments cite its numbered decisions, sections and steps; this
file says what each reference means and where the decision that was actually built is written down
(`docs/DECISIONS.md`, entries dated 2026-11-13/14 headed "Photo map, step …" and "Photo look: review fixes").

## Decisions

| Reference | What it covers | Built as (DECISIONS.md) |
|---|---|---|
| decision 2 | One sun for every lit face and every shadow (west-north-west, about 40° up), `render/src/photo/light.ts` | step "polish" 2 |
| decision 3 | The map painters are pure: no Pixi, no DOM, no `Math.random`, no clock (architecture test), so they run in a worker and in Node | step "ground" 2 |
| decision 4 | Noise: integer hash and value noise keyed to world metres (or global pixel indices), so tiles join byte for byte | step "ground" 5 |
| decision 5 | The tile pyramid (`terrain-tiles.ts`): photo L0 strips over the flat placeholder, L1-L3 detail levels, device tiers, byte budget | step "ground" 3, "polish" 3; review fixes 2-4 |
| decision 6 | Painting in workers and the pure `TileQueue` (centre first, cancels, in-flight and upload caps) | step "ground" 4; review fix 1 |
| decision 9 | Readability caps on texture amplitudes (blotches, per-field tint, saturation) | step "ground" 5-6, "polish" 4 |
| decision 10 | Cast shadows and ambient darkening combined by maximum (no double darkening) | step "vegetation" 4, "built" 5 |
| decision 13 | Relief stays readable but quiet: hillshade capped, contours with a light north-west line | step "polish" 10; review fix 5 |

## Sections

| Reference | What it covers |
|---|---|
| section 2 | Band limiting: a pattern of period P is painted at a resolution only when it gets about three pixels a period (`band()` in `photo/noise.ts`), so nothing shimmers or makes moiré when zoomed out |

## Steps

The look was built in four steps, each with its own DECISIONS.md entry: **"ground"** (pyramid, worker, ground painter,
look switch), **"vegetation"** (crowns, hedges, orchards, scrub, cast shadows), **"built"** (roads, water, bridges,
walls, building shadows, roofs) and **"polish"** (units on the map, overlays, contours, defaults). A reference such as
`step "ground" 4` means item 4 of that step's list in the plan; the DECISIONS.md entry of the step has the version that
was built.
