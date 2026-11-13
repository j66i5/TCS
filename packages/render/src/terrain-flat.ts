/**
 * Flat pixel map (M7.5b, plan m7.5 §4): the pure painter lives in `flat/paint.ts` (no Pixi, so a worker or a test
 * can run it); this file keeps the Pixi side. The tiles (whole map, detail tiles, contour tiles) are in
 * `terrain-tiles.ts`, shared with the photo look.
 */
export * from "./flat/paint";
export { basePpm } from "./terrain-tiles";
