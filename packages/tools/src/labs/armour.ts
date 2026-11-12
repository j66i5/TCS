/**
 * Armour lab (M7.4a, plan §15 / C43): which rounds get through which plate of the Puma and the BMP-2, struck
 * square on the face along a level path (the top: from straight above). The plate test is the one the
 * simulation uses (`plateNeed`); reference rounds are published penetration figures converted to mild-steel
 * equivalent mm (RHA x 1.25), at the range named. Rounds not issued in the game (23, 14.5, 12.7, 7.62 mm AP) are
 * defined here only, to check the plates against the published protection claims.
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import { buildVehicleRT, plateNeed } from "@tcs/sim";

export interface ArmourRound { id: string; label: string; mildMm: number; shaped: boolean }

/** Reference rounds (mm mild-steel equivalent at the range named). */
export function referenceRounds(data: DataSet): ArmourRound[] {
  const c = buildCatalog(data, ["de", "ru"]);
  const r = c.ballistics.rhaToMildSteel;
  return [
    { id: "de-30x173-pmc287", label: "30 mm PMC287 APFSDS at 1000 m", mildMm: c.ammo["de-30x173-pmc287"]!.penetration.steelMm, shaped: false },
    { id: "ru-30x165-3ubr8", label: "30 mm 3UBR8 APDS at 1500 m", mildMm: c.ammo["ru-30x165-3ubr8"]!.penetration.steelMm, shaped: false },
    { id: "lab-23mm-ap", label: "23 mm AP at 500 m (25 mm RHA)", mildMm: 25 * r, shaped: false },
    { id: "lab-14_5mm-b32", label: "14.5 mm B-32 at 500 m (32 mm RHA)", mildMm: 32 * r, shaped: false },
    { id: "lab-12_7mm-b32", label: "12.7 mm B-32 at 500 m (20 mm RHA)", mildMm: 20 * r, shaped: false },
    { id: "lab-762-b32", label: "7.62 mm B-32 at 75 m (12 mm RHA)", mildMm: 12 * r, shaped: false },
    { id: "ru-pg7vl", label: "PG-7VL (RPG-7)", mildMm: c.ammo["ru-pg7vl"]!.penetration.steelMm, shaped: true },
    { id: "de-pzf3-dm12", label: "Panzerfaust 3 DM12", mildMm: c.ammo["de-pzf3-dm12"]!.penetration.steelMm, shaped: true },
  ];
}

export interface ArmourRow { vehicle: string; part: "hull" | "turret"; face: string; round: string; need: number; can: number; through: boolean }

const FACES = ["front", "side", "rear", "top"] as const;

/** Square-on path direction (part frame f, r, u) for each face. */
function dirFor(face: number): [number, number, number] {
  return face === 0 ? [-1, 0, 0] : face === 1 ? [0, -1, 0] : face === 2 ? [1, 0, 0] : [0, 0, -1];
}

/** Does `mildMm` of penetration get through this plate along that path (can >= need)? */
export function plateThrough(data: DataSet, vehicle: string, part: "hull" | "turret", face: number, mildMm: number, shaped: boolean, dir?: [number, number, number]): { need: number; through: boolean } {
  const c = buildCatalog(data, ["de", "ru"]);
  const rt = buildVehicleRT(c)[vehicle]!;
  const [df, dr, du] = dir ?? dirFor(face);
  const p = plateNeed(rt.plates[(part === "turret" ? 4 : 0) + face] ?? null, face, 1, df, dr, du, c.ballistics.armour.losFloorCos);
  const need = shaped ? p.needS : p.needK;
  return { need, through: mildMm >= need };
}

export function armourLab(data: DataSet): ArmourRow[] {
  const rows: ArmourRow[] = [];
  const rounds = referenceRounds(data);
  for (const vehicle of ["de-puma", "ru-bmp2"]) {
    for (const part of ["hull", "turret"] as const) {
      for (let f = 0; f < 4; f++) {
        for (const rd of rounds) {
          const r = plateThrough(data, vehicle, part, f, rd.mildMm, rd.shaped);
          rows.push({ vehicle, part, face: FACES[f]!, round: rd.label, need: r.need, can: rd.mildMm, through: r.through });
        }
      }
    }
  }
  return rows;
}

export function armourLabMarkdown(rows: ArmourRow[]): string {
  const out = ["Plates struck square on (level path; the roof from above). Mild-steel-equivalent mm: need along the path (kinetic, or against a jet for the rockets) and the round's penetration.", ""];
  for (const vehicle of [...new Set(rows.map((r) => r.vehicle))]) {
    out.push(`## ${vehicle}`, "", "| Part / face | Round | Need | Can | Result |", "|---|---|---:|---:|---|");
    for (const r of rows.filter((x) => x.vehicle === vehicle)) out.push(`| ${r.part} ${r.face} | ${r.round} | ${r.need.toFixed(1)} | ${r.can.toFixed(1)} | ${r.through ? "**through**" : "stopped"} |`);
    out.push("");
  }
  return out.join("\n");
}
