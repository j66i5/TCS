/**
 * Armour lab (M7.4a, plan §15 / C43; M7.6a tanks): which rounds get through which plate of a vehicle, struck square
 * on the face along a level path (the top: from straight above). The plate test is the one the simulation uses
 * (`plateNeed`); reference rounds are published penetration figures converted to mild-steel equivalent mm
 * (RHA x 1.25), at the range named. Rounds not issued in the game (23, 14.5, 12.7, 7.62 mm AP, PG-7VR, Kornet)
 * are defined here only, to check the plates against the published protection claims.
 *
 * M7.6a: a face with an add-on tile is shown with the tile there ("full": a reactive tile's mm for the round's kind
 * added when it sets the tile off — a kinetic round only at or above the trigger —, a legacy tile's factor for a
 * shaped charge) and with the tiles used up ("spent"); other faces "none".
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import { buildVehicleRT, plateNeed, reactiveAdd, tileFor, type Catalog } from "@tcs/sim";

export type ArmourKind = "kinetic" | "shaped" | "tandem";
export interface ArmourRound { id: string; label: string; mildMm: number; kind: ArmourKind; shaped: boolean }

const CATALOGS = new WeakMap<DataSet, { c: Catalog; rt: ReturnType<typeof buildVehicleRT> }>();
function cat(data: DataSet): { c: Catalog; rt: ReturnType<typeof buildVehicleRT> } {
  let x = CATALOGS.get(data);
  if (!x) { const c = buildCatalog(data, ["de", "ru"]); x = { c, rt: buildVehicleRT(c) }; CATALOGS.set(data, x); }
  return x;
}

/** A kinetic round's penetration at `fromM` scaled to `toM` by the speed its drag gives there (the sim's
 *  (v / v_ref)^exponent rule; constant drag coefficient). */
function speedScaled(c: Catalog, ammo: string, fromM: number, toM: number): number {
  const a = c.ammo[ammo]!;
  const k = (Math.PI * a.diameterM * a.diameterM) / 4 / (2 * a.projectileMassKg) * c.ballistics.airDensityKgM3 * a.drag.a;
  return a.penetration.steelMm * Math.pow(Math.exp(-k * (toM - fromM)), c.ballistics.penetrationVelocityExponent);
}

/** Reference rounds (mm mild-steel equivalent at the range named). */
export function referenceRounds(data: DataSet): ArmourRound[] {
  const { c } = cat(data);
  const r = c.ballistics.rhaToMildSteel;
  const rd = (id: string, label: string, mildMm: number, kind: ArmourKind): ArmourRound => ({ id, label, mildMm, kind, shaped: kind !== "kinetic" });
  const pen = (id: string) => c.ammo[id]!.penetration.steelMm;
  return [
    rd("de-30x173-pmc287", "30 mm PMC287 APFSDS at 1000 m", pen("de-30x173-pmc287"), "kinetic"),
    rd("ru-30x165-3ubr8", "30 mm 3UBR8 APDS at 1500 m", pen("ru-30x165-3ubr8"), "kinetic"),
    rd("lab-23mm-ap", "23 mm AP at 500 m (25 mm RHA)", 25 * r, "kinetic"),
    rd("lab-14_5mm-b32", "14.5 mm B-32 at 500 m (32 mm RHA)", 32 * r, "kinetic"),
    rd("lab-12_7mm-b32", "12.7 mm B-32 at 500 m (20 mm RHA)", 20 * r, "kinetic"),
    rd("lab-762-b32", "7.62 mm B-32 at 75 m (12 mm RHA)", 12 * r, "kinetic"),
    rd("ru-pg7vl", "PG-7VL (RPG-7)", pen("ru-pg7vl"), "shaped"),
    rd("de-pzf3-dm12", "Panzerfaust 3 DM12", pen("de-pzf3-dm12"), "shaped"),
    // M7.6a: tank rounds and the anti-tank missiles.
    rd("de-120-dm63a1", "120 mm DM63A1 at 2000 m", pen("de-120-dm63a1"), "kinetic"),
    rd("ru-125-3bm60", "125 mm 3BM60 at 2000 m", pen("ru-125-3bm60"), "kinetic"),
    rd("ru-125-3bm60-1000", "125 mm 3BM60 at 1000 m (speed-scaled)", speedScaled(c, "ru-125-3bm60", 2000, 1000), "kinetic"),
    rd("ru-125-3bm42", "125 mm 3BM42 at 2000 m", pen("ru-125-3bm42"), "kinetic"),
    rd("lab-pg7vr", "PG-7VR (RPG-7, tandem; 650 mm RHA)", 650 * r, "tandem"),
    rd("ru-9m113m", "9M113M Konkurs-M", pen("ru-9m113m"), "tandem"),
    rd("ru-9m131", "9M131 Metis-M", pen("ru-9m131"), "tandem"),
    rd("de-spike-lr", "Spike LR (top attack)", pen("de-spike-lr"), "tandem"),
    rd("lab-9m133", "9M133 Kornet (1100 mm RHA)", 1100 * r, "tandem"),
    rd("ru-9m119m", "9M119M Refleks-M", pen("ru-9m119m"), "tandem"),
  ];
}

export type EraState = "none" | "full" | "spent";
export interface ArmourRow { vehicle: string; part: "hull" | "turret"; face: string; era: EraState; round: string; need: number; can: number; through: boolean }

const FACES = ["front", "side", "rear", "top"] as const;

/** Square-on path direction (part frame f, r, u) for each face. */
function dirFor(face: number): [number, number, number] {
  return face === 0 ? [-1, 0, 0] : face === 1 ? [0, -1, 0] : face === 2 ? [1, 0, 0] : [0, 0, -1];
}

/**
 * Does `mildMm` of penetration get through this plate along that path (can >= need)? `kind`: a boolean is the
 * old shaped flag (true = a single shaped charge). `era` "full": the face's tile is there and goes off.
 */
export function plateThrough(data: DataSet, vehicle: string, part: "hull" | "turret", face: number, mildMm: number, kind: boolean | ArmourKind, dir?: [number, number, number], era: EraState = "none"): { need: number; through: boolean } {
  const { c, rt } = cat(data);
  const k: ArmourKind = kind === true ? "shaped" : kind === false ? "kinetic" : kind;
  const [df, dr, du] = dir ?? dirFor(face);
  const p = plateNeed(rt[vehicle]!.plates[(part === "turret" ? 4 : 0) + face] ?? null, face, 1, df, dr, du, c.ballistics.armour.losFloorCos);
  let need = k === "kinetic" ? p.needK : p.needS;
  const tile = era === "full" ? tileFor(c.vehicles[vehicle]!, part, FACES[face]!) : undefined;
  if (tile) {
    const re = c.items[tile.item]?.reactive;
    if (tile.factor !== undefined) { if (k !== "kinetic") need *= tile.factor; }
    else if (re && (k !== "kinetic" || mildMm >= re.triggerSteelMm)) need += reactiveAdd(re, k);
  }
  return { need, through: mildMm >= need };
}

/** The default vehicles of the lab (M7.6a: the tanks too). */
export const ARMOUR_LAB_VEHICLES = ["de-puma", "ru-bmp2", "de-leopard2a7v", "ru-t90m", "ru-t72b3m"];

export function armourLab(data: DataSet, vehicles: string[] = ARMOUR_LAB_VEHICLES): ArmourRow[] {
  const { c } = cat(data);
  const rows: ArmourRow[] = [];
  const rounds = referenceRounds(data);
  for (const vehicle of vehicles) {
    const def = c.vehicles[vehicle]!;
    for (const part of ["hull", "turret"] as const) {
      if (part === "turret" && !def.body.turret) continue;
      for (let f = 0; f < 4; f++) {
        const eras: EraState[] = tileFor(def, part, FACES[f]!) ? ["full", "spent"] : ["none"];
        for (const era of eras) for (const rd of rounds) {
          const r = plateThrough(data, vehicle, part, f, rd.mildMm, rd.kind, undefined, era);
          rows.push({ vehicle, part, face: FACES[f]!, era, round: rd.label, need: r.need, can: rd.mildMm, through: r.through });
        }
      }
    }
  }
  return rows;
}

export function armourLabMarkdown(rows: ArmourRow[]): string {
  const out = [
    "Plates struck square on (level path; the roof from above). Mild-steel-equivalent mm: need along the path (kinetic, or against a jet for the rockets and missiles) and the round's penetration.",
    "Tiles: \"full\" = the face's reactive tile is there and goes off (a kinetic round only at or above its trigger), \"spent\" = used up; \"-\" = no tile on that face.",
    "",
  ];
  for (const vehicle of [...new Set(rows.map((r) => r.vehicle))]) {
    out.push(`## ${vehicle}`, "", "| Part / face | Tiles | Round | Need | Can | Result |", "|---|---|---|---:|---:|---|");
    for (const r of rows.filter((x) => x.vehicle === vehicle)) out.push(`| ${r.part} ${r.face} | ${r.era === "none" ? "-" : r.era} | ${r.round} | ${r.need.toFixed(1)} | ${r.can.toFixed(1)} | ${r.through ? "**through**" : "stopped"} |`);
    out.push("");
  }
  return out.join("\n");
}
