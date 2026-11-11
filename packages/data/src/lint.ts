/**
 * Data linter: loader errors plus provenance and plausibility rules (SPEC 7).
 * Run with `npm run lint:data`.
 */
import { loadDataSet, type DataError, type DataSet } from "./loader";

interface Prov { sources: string[]; confidence: string; note?: string | undefined; id?: string }

export function lintDataSet(files: Record<string, unknown>): { data: DataSet | null; errors: DataError[] } {
  const { data, errors } = loadDataSet(files);
  if (!data) return { data, errors };
  const check = (file: string, path: string, p: Prov, fixture: boolean) => {
    if (p.sources.length === 0 && !fixture) {
      if (p.confidence !== "low") {
        errors.push({ file, path, message: "no sources: either add a source URL or mark confidence 'low' with a note", severity: "error" });
      } else if (!p.note) {
        errors.push({ file, path, message: "no sources and no note: explain where the value comes from (e.g. 'game-design value')", severity: "error" });
      }
    }
    if (p.confidence === "low" && !fixture) {
      errors.push({ file, path, message: "confidence is low (needs review)", severity: "warning" });
    }
  };
  Object.values(data.movementModes).forEach((m) => check("core/movement-modes.json", m.id, m, false));
  Object.values(data.qualities).forEach((m) => check("core/qualities.json", m.id, m, false));
  Object.values(data.formations).forEach((m) => check("core/formations.json", m.id, m, false));
  if (data.ballistics) check("core/ballistics.json", "ballistics", data.ballistics, false);
  if (data.wounds) for (const k of ["hitboxes", "zones", "wounding", "physiology", "effects"] as const) check("core/wounds.json", k, data.wounds[k], false);
  if (data.wounds) for (const posture of ["standing", "crouching", "prone"] as const) {
    const h = data.wounds.hitboxes[posture];
    for (const b of h.bands) {
      if (!(b.from < b.to)) errors.push({ file: "core/wounds.json", path: `hitboxes.${posture}`, message: `hitboxes.${posture}: band '${b.zone}' must have from < to`, severity: "error" });
      if (b.armsToM !== undefined && b.armsToM <= b.halfWidthM) errors.push({ file: "core/wounds.json", path: `hitboxes.${posture}`, message: `hitboxes.${posture}: band '${b.zone}' armsToM must exceed halfWidthM`, severity: "error" });
      if (Math.max(b.halfWidthM, b.armsToM ?? 0) > h.widthM / 2 + 1e-9) errors.push({ file: "core/wounds.json", path: `hitboxes.${posture}`, message: `hitboxes.${posture}: band '${b.zone}' is wider than the outline`, severity: "error" });
    }
  }
  if (data.shooting) {
    check("core/shooting.json", "aim", data.shooting.aim, false);
    check("core/shooting.json", "fire", data.shooting.fire, false);
  }
  if (data.body) {
    for (const p of data.body.postures) check("core/body.json", `postures.${p.id}`, p, false);
    check("core/body.json", "transitions", data.body.transitions, false);
    check("core/body.json", "movement", data.body.movement, false);
    check("core/body.json", "physiology", data.body.physiology, false);
  }
  for (const [file, rec] of Object.entries(data.terrain)) {
    Object.values(rec as Record<string, Prov & { id: string }>).forEach((m) => check(`core/terrain/${file}.json`, m.id, m, false));
  }
  for (const pack of Object.values(data.factions)) {
    const fx = pack.manifest.fixture === true;
    const d = pack.dir;
    check(`${d}/manifest.json`, "manifest", pack.manifest, fx);
    check(`${d}/names.json`, "names", pack.names, fx);
    check(`${d}/doctrine.json`, "doctrine", pack.doctrine, fx);
    Object.values(pack.ranks).forEach((x) => check(`${d}/ranks.json`, x.id, x, fx));
    Object.values(pack.roles).forEach((x) => check(`${d}/roles.json`, x.id, x, fx));
    Object.values(pack.items).forEach((x) => check(`${d}/items.json`, x.id, x, fx));
    Object.values(pack.units).forEach((x) => check(`${d}/units.json`, x.id, x, fx));
    Object.values(pack.weapons).forEach((x) => check(`${d}/weapons.json`, x.id, x, fx));
    // Plausibility beyond the schema.
    for (const u of Object.values(pack.units)) {
      if (u.members.length > 60) errors.push({ file: `${d}/units.json`, path: u.id, message: `${u.members.length} direct members is implausible; use subunits`, severity: "warning" });
    }
    const names = new Set(pack.names.family);
    if (names.size < pack.names.family.length) errors.push({ file: `${d}/names.json`, path: "family", message: "duplicate family names", severity: "warning" });
  }
  return { data, errors };
}
