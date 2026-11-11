/**
 * LINE-OF-SIGHT LAB (SPEC 6.5, M3.1): what an observer can see of a man, in typical situations.
 * One observer, one target point; `visibility` is the share of the view that survives (0..1), "blocked" says
 * what stopped it. No randomness: detection (M3.2) turns visibility into a chance of being seen.
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import {
  createContext, DEFAULT_COMMS, eyeHeightM, flatMap, heightAt, sight, type BattleInput, type Catalog, type MapDef, type Posture, type SimContext,
} from "@tcs/sim";

export interface SightRow { situation: string; rangeM: number; visibility: number; blockedBy: string; vegetationM: number }

function ctxFor(catalog: Catalog, map: MapDef): SimContext {
  const input: BattleInput = {
    map, catalog, seed: 1, orders: [], forces: [],
    rules: { timeLimitSeconds: 60, commsModel: "simple", comms: { ...DEFAULT_COMMS }, physiologyModel: "none", physiologyParams: {}, objectives: [] },
  };
  return createContext(input);
}

/** A 700 x 100 m flat strip; `prep` adds the feature. Observer at x = 20, target at x = 20 + range. */
function strip(catalog: Catalog, prep?: (m: MapDef) => void): MapDef {
  const m = flatMap("sight", 700, 100, 4);
  prep?.(m);
  return m;
}
/** Vegetation of kind `id` over the x range [x0, x1). */
function veg(m: MapDef, id: string, x0: number, x1: number): void {
  let k = m.vegetationPalette.indexOf(id);
  if (k < 0) { m.vegetationPalette.push(id); k = m.vegetationPalette.length - 1; }
  for (let r = 0; r < m.rows; r++) for (let c = Math.floor(x0 / m.cellSizeM); c < Math.ceil(x1 / m.cellSizeM); c++) m.vegetation[r * m.cols + c] = k + 1;
}
/** A smooth ridge across the strip, `h` metres high, centred at x = cx, `w` metres wide at its base. */
function ridge(m: MapDef, cx: number, h: number, w: number): void {
  for (let r = 0; r <= m.rows; r++) for (let c = 0; c <= m.cols; c++) {
    const d = Math.abs(c * m.cellSizeM - cx) / (w / 2);
    if (d < 1) m.heights[r * (m.cols + 1) + c] = h * 0.5 * (1 + Math.cos(Math.PI * d));
  }
}

/** Height of the point looked at on a man in this posture: the middle of what shows. */
export const TARGET_POINT_M: Record<Posture, number> = { standing: 1.2, crouching: 0.75, prone: 0.2 };

function look(ctx: SimContext, range: number, observer: Posture, target: Posture, situation: string): SightRow {
  const x0 = 20, y = 50, x1 = 20 + range;
  const z0 = heightAt(ctx.map, x0, y) + eyeHeightM(ctx, observer);
  const z1 = heightAt(ctx.map, x1, y) + TARGET_POINT_M[target];
  const s = sight(ctx, x0, y, z0, x1, y, z1);
  return { situation, rangeM: range, visibility: s.visibility, blockedBy: s.blockedBy ?? "", vegetationM: s.vegetationM };
}

export function sightLab(data: DataSet): SightRow[] {
  const cat = buildCatalog(data, ["de"]);
  const rows: SightRow[] = [];
  const open = ctxFor(cat, strip(cat));
  for (const range of [100, 300, 600]) for (const t of ["standing", "prone"] as Posture[]) rows.push(look(open, range, "standing", t, `open field, observer standing, target ${t}`));
  const crops = ctxFor(cat, strip(cat, (m) => veg(m, "crops", 60, 700)));
  for (const t of ["standing", "crouching", "prone"] as Posture[]) rows.push(look(crops, 100, "standing", t, `target in crops (1 m, from 40 m in front of the observer), target ${t}`));
  rows.push(look(crops, 100, "prone", "standing", "target standing in crops, observer prone at the edge"));
  const grass = ctxFor(cat, strip(cat, (m) => veg(m, "tall-grass", 0, 700)));
  rows.push(look(grass, 100, "standing", "prone", "both in tall grass (0.7 m), observer standing, target prone"));
  rows.push(look(grass, 100, "prone", "prone", "both in tall grass, both prone"));
  const wood = ctxFor(cat, strip(cat, (m) => veg(m, "woodland", 100, 700)));
  for (const range of [90, 110, 130, 180]) rows.push(look(wood, range, "standing", "standing", `into woodland starting 80 m from the observer (${range - 80} m deep)`));
  const scrub = ctxFor(cat, strip(cat, (m) => veg(m, "scrub", 80, 90)));
  rows.push(look(scrub, 150, "standing", "standing", "10 m of scrub in between"));
  const hedge = ctxFor(cat, strip(cat, (m) => { m.obstacles.push({ id: 1, kind: "hedge", points: [80, 0, 80, 100], heightM: 2, thicknessM: 1.5, material: "hedge" }); }));
  rows.push(look(hedge, 150, "standing", "standing", "a 2 m hedge in between"));
  const fence = ctxFor(cat, strip(cat, (m) => { m.obstacles.push({ id: 1, kind: "wire-fence", points: [80, 0, 80, 100], heightM: 2, thicknessM: 0.01, material: "wire-mesh" }); }));
  rows.push(look(fence, 150, "standing", "standing", "a wire fence in between"));
  const wall = ctxFor(cat, strip(cat, (m) => { m.obstacles.push({ id: 1, kind: "stone-wall", points: [80, 0, 80, 100], heightM: 1.1, thicknessM: 0.5, material: "stone" }); }));
  for (const t of ["standing", "crouching", "prone"] as Posture[]) rows.push(look(wall, 61, "standing", t, `target ${t} right behind a 1.1 m wall`));
  const crest = ctxFor(cat, strip(cat, (m) => ridge(m, 170, 4, 120)));
  for (const t of ["standing", "prone"] as Posture[]) rows.push(look(crest, 300, "standing", t, `beyond a 4 m crest (crest at 150 m, target at 300 m), target ${t}`));
  rows.push(look(crest, 150, "standing", "prone", "on the 4 m crest itself, target prone"));
  const house = (openings: boolean) => ctxFor(cat, strip(cat, (m) => {
    m.buildings.push({ id: 1, kind: "house", footprint: [100, 40, 110, 40, 110, 60, 100, 60], storeys: 1, storeyHeightM: 2.8, wallMaterial: "brick", wallThicknessM: 0.3, roofColour: "#8c4a3b",
      openings: openings ? [{ wall: 1, offsetM: 10, widthM: 1.2, kind: "window", sillM: 0.9, headM: 2.1 }, { wall: 3, offsetM: 10, widthM: 1.2, kind: "window", sillM: 0.9, headM: 2.1 }] : [] });
  }));
  rows.push(look(house(false), 120, "standing", "standing", "a house without windows in between"));
  rows.push(look(house(true), 120, "standing", "standing", "a house in between, windows in line on both sides"));
  rows.push(look(house(false), 85, "standing", "standing", "target standing inside a closed house"));
  return rows;
}

export function sightLabMarkdown(rows: SightRow[]): string {
  const out = ["Observer at 0 m, eye height by posture; the point looked at is the middle of the target's body as it shows (standing 1.2 m, kneeling 0.75 m, prone 0.2 m).", "",
    "| situation | range m | visibility | blocked by | vegetation m |", "|---|---:|---:|---|---:|"];
  for (const r of rows) out.push(`| ${r.situation} | ${r.rangeM} | ${(r.visibility * 100).toFixed(r.visibility < 0.01 && r.visibility > 0 ? 2 : 0)} % | ${r.blockedBy || "–"} | ${r.vegetationM.toFixed(0)} |`);
  return out.join("\n");
}
