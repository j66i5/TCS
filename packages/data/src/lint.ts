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
    check("core/shooting.json", "grenades", data.shooting.grenades, false);
  }
  if (data.behaviour) check("core/behaviour.json", "behaviour", data.behaviour, false);
  // Medical data (M10.1): researched from search extracts only (web pages cannot be opened here), so nothing in it
  // may claim more than "medium" confidence.
  const notHigh = (file: string, path: string, p: Prov) => {
    if (p.confidence === "high") errors.push({ file, path, message: "medical and repair data come from search extracts only: confidence 'medium' at most", severity: "error" });
  };
  // Field repair (M11.7a): search extracts only.
  if (data.repair) { check("core/repair.json", "repair", data.repair.repair, false); notHigh("core/repair.json", "repair", data.repair.repair); }
  if (data.medical) {
    const m = data.medical, f = "core/medical.json";
    for (const [k, b] of [["physiology", m.physiology], ["levels", m.levels], ["chain", m.chain], ["protection", m.protection], ["triage", m.triage]] as const) { check(f, k, b, false); notHigh(f, k, b); }
    if (m.evacuation) { check(f, "evacuation", m.evacuation, false); notHigh(f, "evacuation", m.evacuation); }
    if (m.rearRun) { check(f, "rearRun", m.rearRun, false); notHigh(f, "rearRun", m.rearRun); }
    if (m.role1) {
      check(f, "role1", m.role1, false); notHigh(f, "role1", m.role1);
      const bands = m.role1.recovery.bands;
      if (bands[bands.length - 1]!.upTo < 1) errors.push({ file: f, path: "role1.recovery.bands", message: "the last band must reach severity 1", severity: "error" });
      for (const b of bands) if (b.minD > b.maxD) errors.push({ file: f, path: "role1.recovery.bands", message: `band up to ${b.upTo}: minD above maxD`, severity: "error" });
    }
    for (const v of m.interventions) { check(f, `interventions.${v.id}`, v, false); notHigh(f, `interventions.${v.id}`, v); }
    for (const c of m.carry) { check(f, `carry.${c.id}`, c, false); notHigh(f, `carry.${c.id}`, c); }
    // Every tag a treatment uses up should be carried by some item of some real faction.
    const tags = new Set<string>();
    for (const pack of Object.values(data.factions)) if (pack.manifest.fixture !== true) for (const it of Object.values(pack.items)) for (const t of it.medical?.tags ?? []) tags.add(t);
    for (const v of m.interventions) for (const c of v.consumes) if (!tags.has(c.tag)) errors.push({ file: f, path: `interventions.${v.id}.consumes`, message: `no faction's item carries the tag '${c.tag}'`, severity: "warning" });
  }
  if (data.spotting) {
    check("core/spotting.json", "spotting", data.spotting, false);
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
    // Ambulances off the map (M10.6a): the template must crew an ambulance.
    const amb = pack.manifest.ambulance;
    if (amb) {
      const vt = pack.units[amb.template]?.vehicle;
      if (vt === undefined || pack.vehicles[vt]?.ambulance === undefined) errors.push({ file: `${d}/manifest.json`, path: "ambulance.template", message: `'${amb.template}' is not the crew of an ambulance`, severity: "error" });
    }
    check(`${d}/names.json`, "names", pack.names, fx);
    check(`${d}/doctrine.json`, "doctrine", pack.doctrine, fx);
    Object.values(pack.ranks).forEach((x) => check(`${d}/ranks.json`, x.id, x, fx));
    Object.values(pack.roles).forEach((x) => { check(`${d}/roles.json`, x.id, x, fx); if (x.medical) notHigh(`${d}/roles.json`, x.id, x); });
    Object.values(pack.items).forEach((x) => { check(`${d}/items.json`, x.id, x, fx); if (x.medical || x.emblem) notHigh(`${d}/items.json`, x.id, x); });
    Object.values(pack.units).forEach((x) => check(`${d}/units.json`, x.id, x, fx));
    Object.values(pack.weapons).forEach((x) => check(`${d}/weapons.json`, x.id, x, fx));
    // Vehicles (M7): provenance per vehicle and per block; power-to-weight within what tracked and wheeled
    // fighting vehicles have (8-40 kW/t).
    for (const v of Object.values(pack.vehicles)) {
      check(`${d}/vehicles.json`, v.id, v, fx);
      for (const [k, b] of [["body", v.body], ["mass", v.mass], ["drive", v.drive], ["ramp", v.ramp]] as const) check(`${d}/vehicles.json`, `${v.id}.${k}`, b, fx);
      v.stations.forEach((sn) => check(`${d}/vehicles.json`, `${v.id}.stations.${sn.id}`, sn, fx));
      // M7.6a: the armour and the components carry their own provenance (game values, mostly low).
      if (v.armour) check(`${d}/vehicles.json`, `${v.id}.armour`, v.armour, fx);
      if (v.components) check(`${d}/vehicles.json`, `${v.id}.components`, v.components, fx);
      // M11.7a: repair data comes from search extracts only (confidence 'medium' at most).
      if (v.repair) {
        check(`${d}/vehicles.json`, `${v.id}.repair`, v.repair, fx); notHigh(`${d}/vehicles.json`, `${v.id}.repair`, v.repair);
        for (const k of Object.keys(v.repair.parts)) if (data.repair && data.repair.repair.tasks[k as keyof typeof data.repair.repair.tasks] === undefined) errors.push({ file: `${d}/vehicles.json`, path: `${v.id}.repair.parts.${k}`, message: `no crew task '${k}' in core/repair.json`, severity: "error" });
      }
      const kwPerT = v.drive.powerKw / (v.mass.kg / 1000);
      if (kwPerT < 8 || kwPerT > 40) errors.push({ file: `${d}/vehicles.json`, path: v.id, message: `${kwPerT.toFixed(1)} kW/t is outside the plausible 8-40 kW/t`, severity: "warning" });
    }
    // Plausibility beyond the schema.
    for (const u of Object.values(pack.units)) {
      if (u.members.length > 60) errors.push({ file: `${d}/units.json`, path: u.id, message: `${u.members.length} direct members is implausible; use subunits`, severity: "warning" });
    }
    const names = new Set(pack.names.family);
    if (names.size < pack.names.family.length) errors.push({ file: `${d}/names.json`, path: "family", message: "duplicate family names", severity: "warning" });
  }
  return { data, errors };
}
