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
