/**
 * NIGHT LAB (M9.1, roadmap-detail slice 30): the spotting lab's situations by light — noon, dusk, a full-moon and a
 * moonless night — for an observer with eyes and his rifle optic, and with night-vision goggles; plus the light table
 * itself. A man standing still is lost at night; a man firing is seen far further than a still one (the muzzle flash
 * lights him); goggles bring back much of the day.
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import { lightAt, type Catalog } from "@tcs/sim";
import { spotCase, type SpotCase, type SpotRow } from "./spotting";

export interface NightCase { label: string; timeOfDay: number; moon: number }
export const NIGHT_TIMES: NightCase[] = [
  { label: "noon", timeOfDay: 12 * 3600, moon: 0.5 },
  { label: "dusk 18:15", timeOfDay: 18.25 * 3600, moon: 0.5 },
  { label: "night, full moon", timeOfDay: 0, moon: 1 },
  { label: "night, no moon", timeOfDay: 0, moon: 0 },
];

const TARGETS: Omit<SpotCase, "name">[] = [
  { rangeM: 100, posture: "standing", action: "still" },
  { rangeM: 300, posture: "standing", action: "still" },
  { rangeM: 300, posture: "standing", action: "fire" },
  { rangeM: 600, posture: "standing", action: "fire" },
];

export interface NightRow extends SpotRow { time: string; light: number }

export function nightLab(data: DataSet, seeds = 30): { rows: NightRow[]; table: { hour: number; light: number; lightFullMoon: number }[] } {
  const cat: Catalog = buildCatalog(data, ["de", "ru"]);
  const rows: NightRow[] = [];
  let base = 5000;
  for (const t of NIGHT_TIMES) {
    for (const nvg of [false, true]) {
      if (nvg && t.label === "noon") continue;
      for (const g of TARGETS) {
        const name = `${g.posture}, ${g.action === "fire" ? "firing" : "still"}, open${nvg ? ", observer with goggles" : ""}`;
        const r = spotCase(cat, { ...g, name, timeOfDay: t.timeOfDay, moon: t.moon, nvg, seeds, seedBase: base });
        base += 100;
        rows.push({ ...r, time: t.label, light: lightAt(cat, t.timeOfDay, t.moon) });
      }
    }
  }
  // M9.6: a still man at 300 m on a moonless night (23:00), without and under a 120 mm illumination flare burning
  // 400 m up over a point 100 m beyond him (held steady: no descent).
  const illum = cat.factions["de"]?.fireSupport?.illumAmmo;
  const il = illum !== undefined ? cat.ammo[illum]?.illum : undefined;
  for (const lit of [false, true]) {
    if (lit && !il) continue;
    const g = TARGETS[1]!;
    const name = `standing, still, open${lit ? `, under a flare (${illum}, 400 m up, 100 m beyond him)` : ", no flare"}`;
    const r = spotCase(cat, { ...g, name, timeOfDay: 23 * 3600, moon: 0, seeds, seedBase: base, ...(lit && il ? { flare: { candela: il.candela, heightM: 400, beyondM: 100 } } : {}) });
    base += 100;
    rows.push({ ...r, time: "23:00, no moon", light: lightAt(cat, 23 * 3600, 0) });
  }
  const table = Array.from({ length: 25 }, (_, h) => ({ hour: h, light: lightAt(cat, h * 3600, 0), lightFullMoon: lightAt(cat, h * 3600, 1) }));
  return { rows, table };
}

export function nightLabMarkdown(r: ReturnType<typeof nightLab>): string {
  const pct = (a: number, b: number) => `${Math.round((100 * a) / b)} %`;
  const out = ["Light by local time (no moon / full moon):", "", "| hour | light | full moon |", "|---:|---:|---:|"];
  for (const x of r.table) out.push(`| ${x.hour} | ${x.light.toFixed(2)} | ${x.lightFullMoon.toFixed(2)} |`);
  out.push("", "Time to spot one enemy (observer standing, G36 with its optic; each row up to 120 s):", "",
    "| time | light | target | range m | spotted in 120 s | median s | within 30 s |", "|---|---:|---|---:|---:|---:|---:|");
  for (const x of r.rows) out.push(`| ${x.time} | ${x.light.toFixed(2)} | ${x.name} | ${x.rangeM} | ${pct(x.spotted, x.runs)} | ${x.medianS === null ? "–" : x.medianS >= (x.maxSeconds ?? 120) ? "over 120" : x.medianS.toFixed(1)} | ${pct(x.within30, x.runs)} |`);
  return out.join("\n");
}
