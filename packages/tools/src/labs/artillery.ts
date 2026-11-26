/**
 * ARTILLERY LAB (M8.4): the heavy off-map shells against the mortar bombs, and airburst against impact. A shell
 * bursts among men in a ring (helmet and vest, facing it; the fragmentation lab's harness): on impact on open ground,
 * or `airburstHeightM` over it (the faction's artillery fuse); and the same over a closed one-storey house with the
 * men inside under its roof (impact on the roof, or the airburst over the ground).
 * Balance pass 6: 24 seeds by default (6 gave 96 men a row: 2 % against 5 % of prone men at 25 m was two men against
 * five, read by the 2026-11-24 review as "air burst no better"), a 15 m ring, and the fragment strikes per man next
 * to "wounded" (which the blast pins at 100 % at 10 m whatever the fragments do).
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import type { Posture } from "@tcs/sim";
import { burstCase, type FragRow } from "./fragmentation";

export interface ArtilleryRow extends FragRow { label: string; burst: "impact" | "airburst"; where: "open" | "house" }

export function artilleryLab(data: DataSet, seeds = 24): ArtilleryRow[] {
  const cat = buildCatalog(data, ["de", "ru"]);
  const rows: ArtilleryRow[] = [];
  const shells: [string, string, string][] = [["de-120-he", "ru", "de"], ["de-155-he", "ru", "de"], ["ru-82-he", "de", "ru"], ["ru-152-he", "de", "ru"]];
  for (const [ammo, target, owner] of shells) {
    const art = cat.factions[owner]!.artillery!;
    const air = art.airburstHeightM ?? 8;
    const heavy = ammo === art.heAmmo;
    for (const distanceM of [10, 15, 25, 50]) {
      for (const posture of ["standing", "prone"] as Posture[]) {
        rows.push({ ...burstCase(cat, { ammo, targetFaction: target, posture, distanceM, seeds }), label: ammo, burst: "impact", where: "open" });
        if (heavy) rows.push({ ...burstCase(cat, { ammo, targetFaction: target, posture, distanceM, seeds, burstZ: air }), label: ammo, burst: "airburst", where: "open" });
      }
      if (heavy && distanceM <= 25) {
        rows.push({ ...burstCase(cat, { ammo, targetFaction: target, posture: "prone", distanceM, seeds, house: true, burstZ: 2.85 }), label: ammo, burst: "impact", where: "house" });
        rows.push({ ...burstCase(cat, { ammo, targetFaction: target, posture: "prone", distanceM, seeds, house: true, burstZ: air }), label: ammo, burst: "airburst", where: "house" });
      }
    }
  }
  return rows;
}

export function artilleryLabMarkdown(rows: ArtilleryRow[]): string {
  const pct = (a: number, b: number) => (b > 0 ? `${Math.round((100 * a) / b)} %` : "–");
  return [
    "Shells and bombs bursting among men in a ring (helmet and vest). Open: flat ground. House: a closed one-storey brick house round the burst point, the men lying inside under its roof (impact on the roof, or the airburst over the ground).",
    "", "How to read it (balance pass 6): \"wounded\" counts blast as well as fragments, so within about 10 m of a heavy shell it is 100 % for every fuse and says nothing about the fragments; compare the fuses by \"fragment strikes per man\" (wounds plus fragments stopped by helmet or vest) and at 15 m and beyond. A row of fewer than about 300 men cannot separate 2 % from 5 %: run `npm run lab -- artillery 24` or more.",
    "", "| round | burst | where | posture | distance m | men | wounded | fragment strikes per man | fragment wounds per man | down at once |", "|---|---|---|---|---:|---:|---:|---:|---:|---:|",
    ...rows.map((r) => `| ${r.label} | ${r.burst} | ${r.where} | ${r.posture} | ${r.distanceM} | ${r.men} | ${pct(r.wounded, r.men)} | ${(r.woundsPerMan + r.stoppedPerMan).toFixed(2)} | ${r.woundsPerMan.toFixed(2)} | ${pct(r.downAtOnce, r.men)} |`),
  ].join("\n");
}
