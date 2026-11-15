/**
 * Add-on armour tiles (M7.4b; reactive tiles M7.6a): pure lookups shared by the hit resolution (systems/armour.ts)
 * and the crew's judgement of what its rounds can get through (systems/gunnery.ts).
 */
import type { ReactiveDef, VehicleDef, VehicleTile } from "./catalog";

/** The add-on tile row on a part and face, if any. */
export function tileFor(def: VehicleDef, part: "hull" | "turret", face: "front" | "side" | "rear" | "top"): VehicleTile | undefined {
  const tiles = def.armour?.tiles;
  if (!tiles) return undefined;
  for (let k = 0; k < tiles.length; k++) { const t = tiles[k]!; if (t.part === part && t.face === face) return t; }
  return undefined;
}

/** What a reactive tile adds (mild-steel mm) to the need against a round of this kind. */
export function reactiveAdd(r: ReactiveDef, kind: "kinetic" | "shaped" | "tandem"): number {
  return kind === "kinetic" ? r.addKineticMm : kind === "tandem" ? r.addTandemMm : r.addShapedMm;
}
