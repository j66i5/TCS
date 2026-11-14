/**
 * Flat pixel map (M7.5b, plan m7.5 §4): re-exports only. The pure painter is `flat/paint.ts` (no Pixi, so a worker or
 * a test can run it); all the Pixi side (whole map, detail tiles, contour tiles) is `terrain-tiles.ts`, shared with
 * the photo look. Kept so older imports (`./terrain-flat`) keep working.
 */
export * from "./flat/paint";
export { basePpm } from "./terrain-tiles";
