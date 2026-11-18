/** URL parameters the app turns into battle options (pure functions, tested in packages/app/test). */
import type { CarrierClass } from "@tcs/scenario";

/**
 * `?vehicles=0|1|tracked|wheeled` or `?vehicles=<blue>,<red>` (M7.6c): "0" the battle on foot; absent, "1" or
 * "tracked" the tracked carriers' platoons (as before); "wheeled" the wheeled carriers' platoons (the manifest's
 * `platoonTemplates`); two words set each side. Anything else: a warning and the tracked default. Class words,
 * not vehicle names (hard rule 8).
 */
export function carriersParam(v: string | null, warn: (msg: string) => void = () => undefined): { vehicles: boolean; carriers?: CarrierClass | [CarrierClass, CarrierClass] } {
  if (v === "0") return { vehicles: false };
  if (v === null || v === "" || v === "1" || v === "tracked") return { vehicles: true };
  const ok = (x: string | undefined): x is CarrierClass => x === "tracked" || x === "wheeled";
  const p = v.split(",");
  if (p.length === 1 && ok(p[0])) return { vehicles: true, carriers: p[0] };
  if (p.length === 2 && ok(p[0]) && ok(p[1])) return { vehicles: true, carriers: [p[0], p[1]] };
  warn(`vehicles=${v}: expected 0, 1, tracked, wheeled or <blue>,<red>; using tracked`);
  return { vehicles: true };
}

/**
 * `?tanks=0|1|both|attacker|defender` (M7.6b): the sides' tank sections (1, both: both sides; 0: none);
 * `&tankCrew=<blue section>,<red section>` (unit template ids, empty: the default's or the manifest's), e.g.
 * `tankCrew=,tankovaya-gruppa-t90m`. Absent (balance pass 3): `mounted`, the balanced mounted battle's sections
 * (`mountedTanks`, the batch's platoon-vehicles / platoon-ru-vehicles), or none (null: the battle on foot).
 */
export function tanksParam(v: string | null, crew: string | null, mounted: TankOpts | null = null): TankOpts {
  const tanks = v === "1" || v === "both" ? true : v === "attacker" || v === "defender" ? v : undefined;
  const parts = (crew ?? "").split(",");
  const named: [string | null, string | null] | undefined = crew ? [parts[0] || null, parts[1] || null] : undefined;
  if (tanks === undefined) {
    if (v === "0" || mounted === null || mounted.tanks === undefined) return {};
    return { tanks: mounted.tanks, ...(named ? { tankTemplates: named } : mounted.tankTemplates ? { tankTemplates: mounted.tankTemplates } : {}) };
  }
  return { tanks, ...(named ? { tankTemplates: named } : {}) };
}

export interface TankOpts { tanks?: true | "attacker" | "defender"; tankTemplates?: [string | null, string | null] }
