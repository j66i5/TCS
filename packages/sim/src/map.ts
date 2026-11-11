/**
 * Map definition (SPEC 6.1). M0 uses a flat map with no terrain. The format already carries the
 * heightfield and terrain layers so M1 fills them in without changing the shape.
 *
 * Coordinates: metres. x grows east, y grows south (screen-like), z is height above the ground.
 * Origin is the north-west corner. Maps up to 4000 m x 4000 m must be supported.
 */
export interface MapDef {
  id: string;
  widthM: number;
  heightM: number;
  /** Heightfield cell size in metres (2..5). */
  cellSizeM: number;
  /**
   * Terrain heights in metres, row-major, (widthM/cellSizeM + 1) x (heightM/cellSizeM + 1) samples.
   * Empty array = flat at 0 m (M0). Stored as a separate image in the map file format later.
   */
  heights: number[];
  /** Reserved for M1: surface, vegetation, obstacles, buildings, roads, water. */
  layers: Record<string, unknown>;
}

export const MAX_MAP_SIZE_M = 4000;

export function flatMap(id: string, widthM: number, heightM: number, cellSizeM = 4): MapDef {
  if (widthM > MAX_MAP_SIZE_M || heightM > MAX_MAP_SIZE_M) throw new Error("map too large");
  return { id, widthM, heightM, cellSizeM, heights: [], layers: {} };
}
