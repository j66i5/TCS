/** Turns a validated DataSet into the Catalog the simulation runs with. */
import { canonicalJson, hashText, PI, type BodyDef, type Catalog, type FactionDef, type ItemTypeDef, type MedicalDef, type MovementModeDef, type RecoveryDef, type RepairDef, type SupplyDef, type PrisonersDef, type TerrainCatalog, type VehicleDef } from "@tcs/sim";
import type { MedicalT, VehicleT } from "./schemas";
import type { DataSet } from "./loader";

/** Build a catalog containing the given factions (and all core data). */
export function buildCatalog(data: DataSet, factionIds: string[]): Catalog {
  const items: Record<string, ItemTypeDef> = {};
  const factions: Catalog["factions"] = {};
  for (const fid of [...new Set(factionIds)].sort()) {
    const pack = data.factions[fid];
    if (!pack) throw new Error(`faction '${fid}' is not loaded (loaded: ${Object.keys(data.factions).join(", ")})`);
    factions[fid] = { id: fid, nameKey: pack.manifest.nameKey, doctrine: { ...pack.doctrine.values }, defaultFormation: pack.doctrine.defaultFormation };
    const medRoles: NonNullable<FactionDef["medicalRoles"]> = {};
    for (const r of Object.values(pack.roles).sort((a, b) => (a.id < b.id ? -1 : 1))) {
      if (r.medical) medRoles[r.id] = { level: r.medical.level, ...(r.medical.interventions ? { interventions: [...r.medical.interventions] } : {}) };
    }
    if (Object.keys(medRoles).length > 0) factions[fid]!.medicalRoles = medRoles;
    if (pack.doctrine.fireSupport) factions[fid]!.fireSupport = { ...pack.doctrine.fireSupport };
    if (pack.doctrine.artillery) factions[fid]!.artillery = { ...pack.doctrine.artillery };
    const codes: Record<string, string> = {};
    for (const r of Object.values(pack.ranks).sort((a, b) => (a.id < b.id ? -1 : 1))) if (r.natoCode !== undefined) codes[r.id] = r.natoCode;
    if (data.prisoners && Object.keys(codes).length > 0) factions[fid]!.natoCodes = codes;
    if (pack.doctrine.identityTag) { const g = pack.doctrine.identityTag; factions[fid]!.identityTag = { item: g.item, perMan: g.perMan, taken: g.taken }; }
    if (pack.doctrine.dismount) {
      factions[fid]!.dismountM = pack.doctrine.dismount.distanceM;
      if (pack.doctrine.dismount.urbanDistanceM !== undefined) factions[fid]!.dismountUrbanM = pack.doctrine.dismount.urbanDistanceM;
      if (pack.doctrine.dismount.afterward !== undefined) factions[fid]!.afterDismount = { kind: pack.doctrine.dismount.afterward, followM: pack.doctrine.dismount.followM ?? 150 };
    }
    for (const it of Object.values(pack.items)) {
      const d: ItemTypeDef = { id: it.id, massKg: it.massKg, category: it.category };
      if (it.chargeCapacity !== undefined) d.chargeCapacity = it.chargeCapacity;
      if (it.chargeMassKg !== undefined) d.chargeMassKg = it.chargeMassKg;
      if (it.chargeItem !== undefined) d.chargeItem = it.chargeItem;
      if (it.chargeKind !== undefined) d.chargeKind = it.chargeKind;
      if (it.stripperClips === true) d.stripperClips = true;
      if (it.sensor !== undefined) d.sensor = it.sensor;
      if (it.power !== undefined) d.power = { ...it.power };
      if (it.water === true) d.water = true;
      if (it.radio === true) d.radio = true;
      if (it.thermalCover !== undefined) d.thermalCover = it.thermalCover;
      if (it.rangefinder !== undefined) d.rangefinder = it.rangefinder;
      if (it.reactive !== undefined) d.reactive = { ...it.reactive };
      if (it.mortar !== undefined) d.mortar = { ...it.mortar };
      if (it.crewServed !== undefined) d.crewServed = { ...it.crewServed };
      if (it.drone !== undefined) d.drone = { ...it.drone, sensors: [...it.drone.sensors] };
      if (it.armour !== undefined) d.armour = it.armour.map((a) => ({ ...a }));
      if (it.tracerItem !== undefined && it.tracerEvery !== undefined) { d.tracerItem = it.tracerItem; d.tracerEvery = it.tracerEvery; }
      if (it.medical !== undefined) d.medical = { tags: [...it.medical.tags], timeFactor: it.medical.timeFactor, successFactor: it.medical.successFactor };
      if (it.emblem === true) d.emblem = true;
      if (it.prisonerKeeps === true) d.prisonerKeeps = true;
      if (it.documents === true) d.documents = true;
      items[it.id] = d;
    }
  }
  const movementModes: Catalog["movementModes"] = {};
  for (const m of Object.values(data.movementModes)) {
    const def: MovementModeDef = m.class === "foot"
      ? { id: m.id, class: m.class, speedMps: m.speedMps, posture: m.posture, exertion: m.exertion, vehiclePace: { ...m.vehiclePace } }
      : { id: m.id, class: m.class, speedFraction: m.speedFraction };
    movementModes[m.id] = def;
  }
  const qualities: Catalog["qualities"] = {};
  for (const q of Object.values(data.qualities)) qualities[q.id] = { id: q.id, skills: { ...q.skills }, morale: { ...q.morale } };
  // Weapons and ammunition of the factions taking part.
  const ammo: Catalog["ammo"] = {};
  const weapons: Catalog["weapons"] = {};
  const vehicles: Catalog["vehicles"] = {};
  for (const fid of Object.keys(factions)) {
    const pack = data.factions[fid]!;
    for (const a of Object.values(pack.ammunition)) ammo[a.id] = noProv(a) as Catalog["ammo"][string];
    for (const w of Object.values(pack.weapons)) weapons[w.id] = noProv(w) as Catalog["weapons"][string];
    for (const v of Object.values(pack.vehicles).sort((a, b) => (a.id < b.id ? -1 : 1))) vehicles[v.id] = vehicleDef(v);
  }
  if (!data.ballistics) throw new Error("core/ballistics.json is missing or invalid");
  const ballistics = noProv(data.ballistics) as Catalog["ballistics"];
  const ammoIds = Object.keys(ammo).sort();
  if (!data.shooting) throw new Error("core/shooting.json is missing or invalid");
  if (!data.wounds) throw new Error("core/wounds.json is missing or invalid");
  const wounds = {
    hitboxes: noProv(data.wounds.hitboxes), zones: noProv(data.wounds.zones), wounding: noProv(data.wounds.wounding),
    physiology: noProv(data.wounds.physiology), effects: noProv(data.wounds.effects),
  } as Catalog["wounds"];
  const shooting = { aim: noProv(data.shooting.aim), fire: noProv(data.shooting.fire), grenades: noProv(data.shooting.grenades) } as Catalog["shooting"];
  if (!data.spotting) throw new Error("core/spotting.json is missing or invalid");
  const spotting = noProv(data.spotting) as Catalog["spotting"];
  if (!data.behaviour) throw new Error("core/behaviour.json is missing or invalid");
  const behaviour = noProv(data.behaviour) as Catalog["behaviour"];
  const formations: Catalog["formations"] = {};
  for (const f of Object.values(data.formations)) formations[f.id] = { id: f.id, slots: f.slots.map(([a, b]) => [a, b] as [number, number]) };
  const medical = data.medical ? medicalCatalog(data.medical) : undefined;
  const repair = data.repair ? noProv(data.repair.repair) as RepairDef : undefined;
  const recovery = data.repair?.recovery ? noProv(data.repair.recovery) as RecoveryDef : undefined;
  const supply = data.supply ? noProv(data.supply.supply) as SupplyDef : undefined;
  const prisoners = data.prisoners ? noProv(data.prisoners.prisoners) as PrisonersDef : undefined;
  const body = { ...(prisoners ? { prisoners } : {}), ...(medical ? { medical } : {}), ...(repair ? { repair } : {}), ...(recovery ? { recovery } : {}), ...(supply ? { supply } : {}), items, movementModes, qualities, factions, terrain: terrainCatalog(data), body: bodyCatalog(data), formations, ballistics, shooting, wounds, spotting, behaviour, ammo, ammoIds, weapons, vehicles };
  return { fingerprint: hashText(canonicalJson(body)), ...body };
}

/** The medical data (M10.1) without provenance; lists become records keyed by id (sorted). */
export function medicalCatalog(m: MedicalT): MedicalDef {
  const byId = <T extends { id: string }>(list: T[]) => {
    const out: Record<string, unknown> = {};
    for (const x of [...list].sort((a, b) => (a.id < b.id ? -1 : 1))) out[x.id] = noProv(x);
    return out;
  };
  return {
    physiology: noProv(m.physiology) as MedicalDef["physiology"],
    levels: noProv(m.levels) as MedicalDef["levels"],
    interventions: byId(m.interventions) as MedicalDef["interventions"],
    carry: byId(m.carry) as MedicalDef["carry"],
    chain: noProv(m.chain) as MedicalDef["chain"],
    protection: noProv(m.protection) as MedicalDef["protection"],
    triage: noProv(m.triage) as MedicalDef["triage"],
    care: noProv(m.care) as MedicalDef["care"],
    ...(m.carers ? { carers: noProv(m.carers) as NonNullable<MedicalDef["carers"]> } : {}),
    ...(m.carrying ? { carrying: noProv(m.carrying) as NonNullable<MedicalDef["carrying"]> } : {}),
    ...(m.vehicleLoading ? { vehicleLoading: noProv(m.vehicleLoading) as NonNullable<MedicalDef["vehicleLoading"]> } : {}),
    ...(m.nest ? { nest: noProv(m.nest) as NonNullable<MedicalDef["nest"]> } : {}),
    ...(m.evacuation ? { evacuation: noProv(m.evacuation) as NonNullable<MedicalDef["evacuation"]> } : {}),
    ...(m.down ? { down: noProv(m.down) as NonNullable<MedicalDef["down"]> } : {}),
    ...(m.rearRun ? { rearRun: noProv(m.rearRun) as NonNullable<MedicalDef["rearRun"]> } : {}),
    ...(m.role1 ? { role1: noProv(m.role1) as NonNullable<MedicalDef["role1"]> } : {}),
  };
}

/** Provenance keys: kept in the data set, never in the catalog (the simulation must not see them). */
const PROV_KEYS = new Set(["sources", "confidence", "note", "nameKey"]);

/** A deep copy without provenance at any depth (sources, confidence, note, nameKey). */
export function noProv(o: unknown): unknown {
  if (Array.isArray(o)) return o.map(noProv);
  if (o === null || typeof o !== "object") return o;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) if (!PROV_KEYS.has(k) && v !== undefined) out[k] = noProv(v);
  return out;
}

const kmh = (v: number) => v / 3.6;
const rad = (deg: number) => (deg * PI) / 180;

/** A vehicle type in SI units (km/h, degrees and kW converted here, SPEC 4.3 rule 7), without provenance. */
export function vehicleDef(v: VehicleT): VehicleDef {
  const d = v.drive, st = d.steering;
  const b = noProv(v.body) as VehicleDef["body"];
  return {
    id: v.id, class: v.class, body: b, massKg: v.mass.kg,
    drive: {
      powerW: d.powerKw * 1000, efficiency: d.efficiency, topSpeedMps: kmh(d.topSpeedKmh), reverseTopSpeedMps: kmh(d.reverseTopSpeedKmh), brakeMps2: d.brakeMps2,
      gearsMps: d.gears.map((g) => kmh(g.toKmh)), reverseGearsMps: d.reverseGears.map((g) => kmh(g.toKmh)), shiftSeconds: d.shiftSeconds,
      steering: st.kind === "tracked"
        ? { kind: "tracked", pivot: st.pivot, pivotRateRadS: rad(st.pivotRateDegS), maxLatAccelMps2: st.maxLatAccelMps2, slipCoeff: st.slipCoeff, turnResistance: st.turnResistance }
        : { kind: "wheeled", maxSteerRad: rad(st.maxSteerDeg), steerRateRadS: rad(st.steerRateDegS), maxLatAccelMps2: st.maxLatAccelMps2 },
      idleW: d.idleKw * 1000, litresPerKwh: d.litresPerKwh,
    },
    fuel: { ...v.fuel },
    seats: v.seats.map((s) => ({
      id: s.id, station: s.station, pos: [...s.pos] as [number, number, number], part: s.part, hatch: s.hatch,
      ...(s.sensors ? { sensors: s.sensors.map((x) => ({ kind: x.kind, ...(x.pos ? { pos: [...x.pos] as [number, number, number] } : {}), arcRad: rad(x.arcDeg), sideFactor: x.sideFactor, rearFactor: x.rearFactor, follows: x.follows, ...(x.lrf === undefined ? {} : { lrf: x.lrf }) })) } : {}),
    })),
    ramp: noProv(v.ramp) as VehicleDef["ramp"],
    stations: v.stations.map((s) => ({
      id: s.id, kind: s.kind, operator: s.operator, commanderOverride: s.commanderOverride,
      traverseRadS: rad(s.traverseDegS), elevateRadS: rad(s.elevateDegS), elevationRad: [rad(s.elevationDeg[0]), rad(s.elevationDeg[1])],
      ...(s.traverseArcDeg ? { traverseArcRad: [rad(s.traverseArcDeg[0]), rad(s.traverseArcDeg[1])] as [number, number] } : {}),
      stabiliser: s.stabiliser, baseErrorMrad: s.baseErrorMrad, movingMradPerMps: s.movingMradPerMps, layToleranceMrad: s.layToleranceMrad,
      rangefinder: s.rangefinder, readyRefillInBattle: s.readyRefillInBattle,
      ...(s.refillSeconds === undefined ? {} : { refillSeconds: s.refillSeconds }),
      weapons: noProv(s.weapons) as VehicleDef["stations"][number]["weapons"],
    })),
    stowed: noProv(v.stowed) as VehicleDef["stowed"],
    ...(v.cookOffAmmo === undefined ? {} : { cookOffAmmo: v.cookOffAmmo }),
    ...(v.armour ? { armour: { plates: v.armour.plates.map((p) => ({ ...p })), ...(v.armour.tiles ? { tiles: v.armour.tiles.map((t) => ({ ...t, fitted: v.stowed.find((x) => x.item === t.item)?.count ?? 0 })) } : {}) } } : {}),
    ...(v.extinguisher ? { extinguisher: { item: v.extinguisher.item, chance: v.extinguisher.chance, delaySeconds: v.extinguisher.delaySeconds } } : {}),
    ...(v.activeProtection ? { activeProtection: { item: v.activeProtection.item, detectM: v.activeProtection.detectM, standoffM: v.activeProtection.standoffM, interceptChance: v.activeProtection.interceptChance, cooldownSeconds: v.activeProtection.cooldownSeconds } } : {}),
    ...(v.components ? { components: noProv(v.components.parts) as NonNullable<VehicleDef["components"]> } : {}),
    ...(v.dischargers ? { dischargers: { item: v.dischargers.item, perSalvo: v.dischargers.perSalvo, salvos: v.dischargers.salvos, arcRad: rad(v.dischargers.arcDeg), rangeM: v.dischargers.rangeM, delaySeconds: v.dischargers.delaySeconds, cloudRadiusM: v.dischargers.cloudRadiusM, cloudSeconds: v.dischargers.cloudSeconds, cloudTopM: v.dischargers.cloudTopM } } : {}),
    ...(v.laserWarner ? { laserWarner: true } : {}),
    ...(v.repair ? { repair: noProv(v.repair) as NonNullable<VehicleDef["repair"]> } : {}),
    ...(v.recovery ? { recovery: { towMaxKg: v.recovery.towMaxKg, towMaxMps: v.recovery.towMaxSpeedKmh / 3.6, hookUpS: v.recovery.hookUpS, hookUpMen: v.recovery.hookUpMen } } : {}),
    ...(v.cargo ? { cargo: { kg: v.cargo.kg } } : {}),
    ...(v.ambulance ? { ambulance: { layouts: v.ambulance.layouts.map((l) => ({ lying: l.lying, sitting: l.sitting, lyingOutside: l.lyingOutside ?? 0 })), marked: v.ambulance.marked } } : {}),
    // A vehicle without signature data: plain defaults (its boxes give the area), aimed at the middle of its hull.
    signature: v.signature
      ? { sizeFactor: v.signature.sizeFactor, movingFactor: v.signature.movingFactor, firingFactor: v.signature.firingFactor, identifyM: v.signature.identifyM, noiseIdleM: v.signature.noiseIdleM, noiseMovingM: v.signature.noiseMovingM, aimPoints: v.signature.aimPoints.map((p) => [...p] as [number, number, number]) }
      : { sizeFactor: 1, movingFactor: 4, firingFactor: 15, identifyM: 1000, noiseIdleM: 300, noiseMovingM: 800, aimPoints: [[0, 0, (v.body.hull.u[0] + v.body.hull.u[1]) / 2]] },
  };
}

/** Terrain definitions without provenance fields (sources, confidence, notes stay in the data set). */
export function terrainCatalog(data: DataSet): TerrainCatalog {
  const strip = <T extends { sources: unknown; confidence: unknown; note?: unknown; nameKey: unknown }>(rec: Record<string, T>) => {
    const out: Record<string, Omit<T, "sources" | "confidence" | "note" | "nameKey">> = {};
    for (const [k, v] of Object.entries(rec).sort(([a], [b]) => (a < b ? -1 : 1))) {
      out[k] = noProv(v) as Omit<T, "sources" | "confidence" | "note" | "nameKey">;
    }
    return out;
  };
  const t = data.terrain;
  return {
    materials: strip(t.materials),
    surfaces: strip(t.surfaces),
    vegetation: strip(t.vegetation),
    obstacles: strip(t.obstacles),
    buildings: strip(t.buildings) as TerrainCatalog["buildings"],
  };
}

/** Body parameters without provenance fields. */
export function bodyCatalog(data: DataSet): BodyDef {
  const b = data.body;
  if (!b) throw new Error("core/body.json is missing or invalid");
  const strip = <T extends object>(o: T) => {
    const { sources: _s, confidence: _c, note: _n, ...rest } = o as T & { sources?: unknown; confidence?: unknown; note?: unknown };
    return JSON.parse(JSON.stringify(rest)) as Omit<T, "sources" | "confidence" | "note">;
  };
  const postures = {} as BodyDef["postures"];
  for (const p of b.postures) postures[p.id] = { heightM: p.heightM, speedFactor: p.speedFactor, muzzleHeightM: p.muzzleHeightM };
  return { postures, transitions: strip(b.transitions), movement: strip(b.movement), physiology: noProv(b.physiology) as BodyDef["physiology"] };
}
