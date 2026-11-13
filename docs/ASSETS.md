# Assets

Every external asset (image, sound, font, map data) must be original or openly licensed and logged here
with its source, author and licence.

| asset | path | source | author | licence |
|---|---|---|---|---|
| *(none — all graphics are drawn in code)* | | | | |
| Unit symbols in the sidebar and overview (infantry frame with a cross, vehicle frame with a track oval, HQ mark) — M7.5a | `ui/src/sidebar.ts`, `render/src/renderer.ts` | original, drawn in code | Claude for the project | project |
| Faction uniform tones, vehicle paint, flat map palette (colours only) — M7.5a | `data/factions/*/appearance.json`, `data/core/appearance.json` | original colour choices | Claude for the project | project |
| Pixel soldier frames, 16 × 16 (stand, walk ×2, crouch ×2, prone, crawl, down, dead, surrendered, captive), weapon variants, muzzle flash, launcher tube, wound marks — M7.5b. Drawn for this project as string grids, not copied, traced or adapted from any game's sprites | `render/src/sprites/soldier-art.ts`, `render/src/sprites/atlas.ts` | original, drawn in code | Claude for the project | project |
| Flat pixel map style: field seams, furrows, crop rows, speckle, pixel tree crowns and shadows, rasterised roads, water, hedges, walls and fences; contour layer — M7.5b | `render/src/terrain-flat.ts` | original, generated in code | Claude for the project | project |
| Building floors (boards, walls with door gaps and windows) and roofs (shadow, ridge, tile rows, parapets) — M7.5b | `render/src/buildings.ts` | original, drawn in code | Claude for the project | project |
| Interiors on the floor plan (hall and stair-room shading, inner walls with doorway thresholds, stairs with steps and an arrow) and the Debug interior graph — M7.5c | `render/src/buildings.ts` | original, drawn in code | Claude for the project | project |
| Upper-floor plans (per floor, a shade lighter), the 3 × 5 pixel floor badge glyphs (G, 0–9) and the floor switch buttons — M7.5d | `render/src/buildings.ts`, `render/src/renderer.ts`, `ui/src/floors.ts` | original, drawn in code | Claude for the project | project |
