/**
 * ARTILLERY LAB (M8.4): the heavy off-map shells against the mortar bombs, and airburst against impact. A shell
 * bursts among men in a ring (helmet and vest, facing it; the fragmentation lab's harness): on impact on open ground,
 * or `airburstHeightM` over it (the faction's artillery fuse); and the same over a closed one-storey house with the
 * men inside under its roof (impact on the roof, or the airburst over the ground).
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import type { Posture } from "@tcs/sim";
import { burstCase, type FragRow } from "./fragmentation";

export interface ArtilleryRow extends FragRow { label: string; burst: "impact" | "airburst"; where: "open" | "house" }

export function artilleryLab(data: DataSet, seeds = 6): ArtilleryRow[] {
  const cat = buildCatalog(data, ["de", "ru"]);
  const rows: ArtilleryRow[] = [];
  const shells: [string, string, string][] = [["de-120-he", "ru", "de"], ["de-155-he", "ru", "de"], ["ru-82-he", "de", "ru"], ["ru-152-he", "de", "ru"]];
  for (const [ammo, target, owner] of shells) {
    const art = cat.factions[owner]!.artillery!;
    const air = art.airburstHeightM ?? 8;
    const heavy = ammo === art.heAmmo;
    for (const distanceM of [10, 25, 50]) {
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
    "", "| round | burst | where | posture | distance m | men | wounded | fragment wounds per man | down at once |", "|---|---|---|---|---:|---:|---:|---:|---:|",
    ...rows.map((r) => `| ${r.label} | ${r.burst} | ${r.where} | ${r.posture} | ${r.distanceM} | ${r.men} | ${pct(r.wounded, r.men)} | ${r.woundsPerMan.toFixed(2)} | ${pct(r.downAtOnce, r.men)} |`),
  ].join("\n");
}
