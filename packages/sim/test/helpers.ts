/** Hand-built minimal inputs for sim unit tests (no data package needed). */
import {
  DEFAULT_COMMS, flatMap, type BattleInput, type Catalog, type SoldierRecord, type UnitInput,
} from "../src/index";

export const testCatalog: Catalog = {
  fingerprint: "test",
  items: {
    round: { id: "round", massKg: 0.012, category: "ammunition" },
    ball: { id: "ball", massKg: 0.012, category: "ammunition" },
    mag: { id: "mag", massKg: 0.1, category: "magazine", chargeCapacity: 30, chargeMassKg: 0.012, chargeItem: "ball" },
    brick: { id: "brick", massKg: 2, category: "supply" },
    tball: { id: "tball", massKg: 0.012, category: "ammunition" },
    belt: { id: "belt", massKg: 1, category: "magazine", chargeCapacity: 50, chargeMassKg: 0.012, chargeItem: "ball", tracerItem: "tball", tracerEvery: 5 },
    bomb: { id: "bomb", massKg: 0.4, category: "ammunition" },
    shard: { id: "shard", massKg: 0.0001, category: "ammunition" },
    shell: { id: "shell", massKg: 0.23, category: "ammunition" },
    tube: { id: "tube", massKg: 1.5, category: "launcher" },
    vest: { id: "vest", massKg: 8, category: "armour", armour: [{ zone: "chest", coverageFront: 1, coverageSide: 1, protectionSteelMm: 26 }, { zone: "abdomen", coverageFront: 1, coverageSide: 1, protectionSteelMm: 26 }] },
  },
  movementModes: {
    walk: { id: "walk", class: "foot", speedMps: 1.5, posture: "standing", exertion: 0.25 },
    run: { id: "run", class: "foot", speedMps: 3, posture: "standing", exertion: 0.85 },
    crawl: { id: "crawl", class: "foot", speedMps: 0.3, posture: "prone", exertion: 0.5 },
  },
  qualities: {},
  factions: {
    fa: { id: "fa", nameKey: "fa", doctrine: { preferredSpacingM: 5, coverPreference: 0 }, defaultFormation: "line" },
    fb: { id: "fb", nameKey: "fb", doctrine: { preferredSpacingM: 5, coverPreference: 0 }, defaultFormation: "line" },
  },
  ballistics: {
    gravityMps2: 9.80665, airDensityKgM3: 1.225, referenceTempC: 15, penetrationVelocityExponent: 1.5, penetrationDeflectionDeg: 6,
    ricochetSpeedRetention: [0.55, 0.9], ricochetScatterDeg: 6, minSpeedMps: 40, maxFlightSeconds: 18,
    blast: { severeScaledM: 3, injuryScaledM: 6, stunScaledM: 25, stunSeconds: 4, craterScaledM: 0.6, breachSteelMmScaled: 15, breachReachScaledM: 2.5, breachWidthScaledM: 2.5, shieldSteelMm: 5 },
    fragments: { bandDeg: [-3, 40], maxPerBurst: 6500, airburstAboveM: 0.3, clutterHeightM: 0.25, clutterStopPerM: 0.15 },
    bounce: { restitution: 0.35, tangentKeep: 0.6, softFactor: 0.6, vegetationFactor: 0.6, softBelowDensityKgM3: 1800, stopSpeedMps: 1.2 },
  },
  ammo: {
    bomb: { id: "bomb", calibre: "hand-grenade", kind: "fragmentation", projectileMassKg: 0.4, cartridgeMassKg: 0.4, diameterM: 0.057, drag: { a: 0.5, b: 0, max: 0.6 }, penetration: { steelMm: 0, atVelocityMps: 100 }, tracer: false, fuse: "time", guidance: "unguided", explosive: { fillingKg: 0.06, fragmentCount: 3000, fragmentAmmo: "shard", fragmentVelocityMps: [1000, 1400], fuseSeconds: 4 }, delivery: { method: "thrown" } },
    shard: { id: "shard", calibre: "fragment", kind: "fragment", projectileMassKg: 0.0001, cartridgeMassKg: 0.0001, diameterM: 0.003, drag: { a: 0.9, b: 0, max: 1 }, penetration: { steelMm: 1.5, atVelocityMps: 1000 }, tracer: false, fuse: "none", guidance: "unguided" },
    shell: { id: "shell", calibre: "40", kind: "fragmentation", projectileMassKg: 0.2, cartridgeMassKg: 0.23, diameterM: 0.04, drag: { a: 0.5, b: 0, max: 0.6 }, penetration: { steelMm: 0, atVelocityMps: 100 }, tracer: false, fuse: "impact", guidance: "unguided", explosive: { fillingKg: 0.032, fragmentCount: 300, fragmentAmmo: "shard", fragmentVelocityMps: [1000, 1400], armingSeconds: 0.25 }, delivery: { method: "launched", velocityMps: 76, launcher: "tube", maxRangeM: 350 } },
    tball: { id: "tball", calibre: "5.56x45", kind: "tracer", projectileMassKg: 0.004, cartridgeMassKg: 0.012, diameterM: 0.0057, drag: { a: 0.061, b: 193, max: 0.5 }, penetration: { steelMm: 2.5, atVelocityMps: 325 }, tracer: true, fuse: "none", guidance: "unguided" },
    ball: { id: "ball", calibre: "5.56x45", kind: "ball", projectileMassKg: 0.004, cartridgeMassKg: 0.012, diameterM: 0.0057, drag: { a: 0.061, b: 193, max: 0.5 }, penetration: { steelMm: 3.5, atVelocityMps: 325, breakupVelocityMps: 724 }, tracer: false, fuse: "none", guidance: "unguided" },
  },
  ammoIds: ["ball", "bomb", "shard", "shell", "tball"],
  weapons: {
    gun: {
      id: "gun", type: "machine-gun", calibre: "5.56x45", massKg: 9, feed: { magazine: "belt" }, fireModes: ["auto"], cyclicRpm: 720,
      dispersionMrad: 0.8, reloadSeconds: 6, setupSeconds: 0, jamProbability: 0, sights: [{ kind: "telescopic", magnification: 4 }], ammo: { ball: 900, tball: 900 },
      sustained: { burstRounds: 5, intervalS: 2, recoilFactor: 0.3 },
    },
    rifle: {
      id: "rifle", type: "rifle", calibre: "5.56x45", massKg: 3.6, feed: { magazine: "mag" }, fireModes: ["semi", "auto"], cyclicRpm: 750,
      dispersionMrad: 0.4, reloadSeconds: 3, setupSeconds: 0, jamProbability: 0, sights: [{ kind: "iron", magnification: 1 }], ammo: { ball: 920 },
    },
  },
  shooting: {
    aim: {
      baseMrad: 1.13, skillSlope: 2, minSkillFactor: 0.3, postureFactor: { prone: 1, crouching: 1.5, standing: 2.2 }, fatigueK: 1.5,
      heartRateK: 0.6, heartRateCalmBpm: 100, suppressionK: 3, rapidFactor: 1.6, burstGrowth: 0.8, sightFactor: { iron: 1, telescopic: 0.7 }, rangeErrorFraction: 0.12, settleK: 0.6, settleTauS: 2, bracedFactor: 0.8,
    },
    fire: {
      bands: [{ maxRangeM: 30, mode: "burst", intervalS: 1, burstRounds: 3 }, { maxRangeM: 100, mode: "rapid", intervalS: 1, burstRounds: 1 }, { maxRangeM: 1e5, mode: "aimed", intervalS: 2.5, burstRounds: 1 }],
      fullRateSeconds: 30, trickleIntervalS: 10, trickleSeconds: 60, incomingRadiusM: 30, topUpBelowFraction: 0.7, incomingReachM: 800, topUpAfterSeconds: 5, clearStoppageSeconds: 4, aimPointHeightM: 0.9, safetyConeDeg: 4,
    },
    grenades: { throwRangeM: { standing: 30, crouching: 20, prone: 15 }, throwElevationDeg: 40, throwErrorFraction: 0.07, throwErrorMinM: 0.6, throwSeconds: 2.5, launchErrorFraction: 0.05, launchErrorMinM: 1, launchSeconds: 4, minSafeDistanceM: 8, throwAnglesDeg: [40, 25, 12, 60], throwPowerMargin: 1.15, carrySeconds: 0.25, staggerSeconds: 0.6, reactRadiusM: 10, runRadiusM: 3, reactDelaySeconds: 0.4 },
  },
  formations: {
    line: { id: "line", slots: [[0, 0], [-1, 0], [1, 0], [-2, 0], [2, 0]] },
    wedge: { id: "wedge", slots: [[0, 0], [-0.71, 0.71], [0.71, 0.71], [-1.42, 1.42], [1.42, 1.42]] },
    file: { id: "file", slots: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]] },
  },
  terrain: {
    materials: {
      brick: { id: "brick", densityKgM3: 1900, resistance: 0.12, ricochetAngleDeg: 11, breaksBullets: true },
      soil: { id: "soil", densityKgM3: 1600, resistance: 0.07, ricochetAngleDeg: 8, breaksBullets: true },
      wood: { id: "wood", densityKgM3: 550, resistance: 0.016, ricochetAngleDeg: 11, breaksBullets: true },
      steel: { id: "steel", densityKgM3: 7850, resistance: 1, ricochetAngleDeg: 15, breaksBullets: false },
    },
    surfaces: {
      grass: { id: "grass", moveCost: { foot: 1, wheeled: 1.4, tracked: 1.1 }, noise: 0.2, dust: 0.1, colour: "#6f8f4a", material: "soil" },
      water: { id: "water", moveCost: { foot: null, wheeled: null, tracked: null }, noise: 0, dust: 0, colour: "#36576b", material: "soil" },
    },
    vegetation: { wood: { id: "wood", heightM: 15, concealmentPerM: 0.06, stoppingPerM: 0.004, moveCost: { foot: 1.25, wheeled: null, tracked: 3 }, colour: "#2f4a26" } },
    obstacles: { wall: { id: "wall", heightM: 2, thicknessM: 0.25, material: "brick", seeThrough: 0, footCrossTimeS: 6, wheeledCrossable: false, trackedCrossable: true, colour: "#8a5a44" } },
    buildings: { house: { id: "house", widthM: [8, 12], depthM: [8, 11], storeys: [1, 2], storeyHeightM: 2.8, wallMaterial: "brick", wallThicknessM: 0.3, roofColours: ["#8c4a3b"], roofMaterial: "wood", roofThicknessM: 0.06 } },
  },
  wounds: {"hitboxes": {"standing": {"widthM": 0.5, "depthM": 0.25, "heightM": 1.75, "along": "height", "bands": [{"zone": "leg", "from": 0, "to": 0.46, "halfWidthM": 0.2}, {"zone": "pelvis", "from": 0.46, "to": 0.54, "halfWidthM": 0.18}, {"zone": "abdomen", "from": 0.54, "to": 0.66, "halfWidthM": 0.17, "armsToM": 0.25}, {"zone": "chest", "from": 0.66, "to": 0.85, "halfWidthM": 0.17, "armsToM": 0.25}, {"zone": "neck", "from": 0.85, "to": 0.885, "halfWidthM": 0.06}, {"zone": "head", "from": 0.885, "to": 1, "halfWidthM": 0.09}]}, "crouching": {"widthM": 0.5, "depthM": 0.45, "heightM": 1.1, "along": "height", "bands": [{"zone": "leg", "from": 0, "to": 0.32, "halfWidthM": 0.22}, {"zone": "pelvis", "from": 0.32, "to": 0.42, "halfWidthM": 0.18}, {"zone": "abdomen", "from": 0.42, "to": 0.56, "halfWidthM": 0.17, "armsToM": 0.25}, {"zone": "chest", "from": 0.56, "to": 0.8, "halfWidthM": 0.17, "armsToM": 0.25}, {"zone": "neck", "from": 0.8, "to": 0.84, "halfWidthM": 0.06}, {"zone": "head", "from": 0.84, "to": 1, "halfWidthM": 0.09}]}, "prone": {"widthM": 0.5, "depthM": 1.75, "heightM": 0.3, "along": "length", "bands": [{"zone": "head", "from": 0, "to": 0.13, "halfWidthM": 0.09}, {"zone": "neck", "from": 0.13, "to": 0.16, "halfWidthM": 0.06}, {"zone": "chest", "from": 0.16, "to": 0.35, "halfWidthM": 0.17, "armsToM": 0.25}, {"zone": "abdomen", "from": 0.35, "to": 0.46, "halfWidthM": 0.17, "armsToM": 0.25}, {"zone": "pelvis", "from": 0.46, "to": 0.54, "halfWidthM": 0.18}, {"zone": "leg", "from": 0.54, "to": 1, "halfWidthM": 0.2}]}}, "zones": {"head": {"severityBase": 0.8, "severitySpread": 0.2, "fatalAt": 0.62, "unconsciousAt": 0.35, "bleedLps": 0.004, "compressible": true, "airway": true, "breathing": false}, "neck": {"severityBase": 0.65, "severitySpread": 0.25, "fatalAt": 0.72, "unconsciousAt": 0.9, "bleedLps": 0.03, "compressible": true, "airway": true, "breathing": false}, "chest": {"severityBase": 0.62, "severitySpread": 0.2, "fatalAt": 0.74, "unconsciousAt": 0.95, "bleedLps": 0.012, "compressible": false, "airway": false, "breathing": true}, "abdomen": {"severityBase": 0.52, "severitySpread": 0.2, "fatalAt": 0.86, "unconsciousAt": 0.97, "bleedLps": 0.008, "compressible": false, "airway": false, "breathing": false}, "pelvis": {"severityBase": 0.52, "severitySpread": 0.2, "fatalAt": 0.86, "unconsciousAt": 0.97, "bleedLps": 0.014, "compressible": false, "airway": false, "breathing": false}, "arm": {"severityBase": 0.3, "severitySpread": 0.15, "fatalAt": 2, "unconsciousAt": 2, "bleedLps": 0.006, "compressible": true, "airway": false, "breathing": false}, "leg": {"severityBase": 0.36, "severitySpread": 0.15, "fatalAt": 2, "unconsciousAt": 2, "bleedLps": 0.014, "compressible": true, "airway": false, "breathing": false}}, "wounding": {"referenceEnergyJ": 1000, "energyExponent": 0.3, "energyFactorMin": 0.45, "energyFactorMax": 1.25, "bleedFloor": 0.12, "bleedPower": 3, "bluntSeverity": 0.12, "knockdownSeconds": 4, "flagSeverity": 0.5, "throughArmChance": 0.6, "throughArmEnergy": 0.7, "fragment": {"minEnergyJ": 3, "referenceEnergyJ": 90, "exponent": 0.5, "factorMin": 0.15, "factorMax": 1.1}, "blast": {"severityInjury": 0.2, "severitySevere": 0.75, "bleedLps": 0.004}, "exit": {"limb": 0.7, "trunk": 0.3}}, "physiology": {"bloodVolumeL": 5.0, "unconsciousLossFraction": 0.38, "deathLossFraction": 0.52, "shockStartFraction": 0.15, "clotBelowLps": 0.002, "clotTauS": 240, "breathingShockPerS": 0.0022, "airwayShockPerS": 0.0033, "painDecayPerS": 0.0004, "stepSeconds": 0.5, "painCollapseAt": 0.95}, "effects": {"legNoWalkSeverity": 0.45, "armNoFightSeverity": 0.5, "painNoFightAt": 0.6, "painPerWoundK": 0.5, "moveSeverityK": 1.2, "aimSeverityK": 3.0, "aimPainK": 1.0, "minMoveFactor": 0.15}},
  body: {
    postures: { standing: { heightM: 1.75, speedFactor: 1, muzzleHeightM: 1.45 }, crouching: { heightM: 1.1, speedFactor: 0.6, muzzleHeightM: 0.95 }, prone: { heightM: 0.4, speedFactor: 0.25, muzzleHeightM: 0.25 } },
    transitions: {
      values: { "standing>crouching": 0.5, "crouching>standing": 0.6, "standing>prone": 1, "prone>standing": 1.5, "crouching>prone": 0.7, "prone>crouching": 1 },
      freeLoadKg: 10, slowdownPerKg: 0.02,
    },
    // Neutral movement factors so the order tests keep exact speeds (no load, flat ground).
    movement: { slopeK: 3.5, slopeOffset: 0.05, loadFreeKg: 10, loadSpeedPerKg: 0.006, minLoadSpeedFactor: 0.5, fatigueSpeedPenalty: 0.35, noRunFatigue: 0.9, hardPaceExertion: 0.6, exhaustedSpeedFactor: 0.5, slopeLookAheadM: 2, runAgainFatigue: 0.6 },
    physiology: {
      bodyMassKg: 80, loadExertionK: 0.8, slopeExertionK: 4, sustainable: 0.35, fatigueGainPerS: 0.0062, recoveryPerS: 0.0067,
      hrRestBpm: 70, hrMaxBpm: 190, hrRiseTauS: 20, hrFallTauS: 45, heatThresholdC: 25, heatPerC: 0.03,
      postureChangeExertion: 0.3, hrExertionWeight: 0.85, hrFatigueWeight: 0.25, exhaustedExertionFactor: 0.5,
    },
  },
};

export function rec(personId: string, load: SoldierRecord["load"] = []): SoldierRecord {
  return {
    personId, given: "A", family: personId, rank: "r", role: "x", skills: { marksmanship: 0.5 },
    fatigue: 0, stress: 0, wounds: [], load, status: "fit",
  };
}

export function team(key: string, n: number): UnitInput {
  return {
    key, callsign: key, echelon: "team", leaderIndex: 0,
    members: Array.from({ length: n }, (_, i) => rec(`${key}.${i}`, [{ type: "mag", count: 3, charge: 30 }])),
    subunits: [],
  };
}

export function testInput(seed = 1, seconds = 60): BattleInput {
  const a = team("a", 3);
  const b = team("b", 2);
  return {
    map: flatMap("t", 200, 200),
    catalog: testCatalog,
    forces: [
      { side: "blue", faction: "fa", units: [a], placements: a.members.map((m, i) => ({ personId: m.personId, x: 10, y: 10 + i * 5, heading: 0 })) },
      { side: "red", faction: "fb", units: [b], placements: b.members.map((m, i) => ({ personId: m.personId, x: 190, y: 10 + i * 5, heading: 0 })) },
    ],
    rules: { timeLimitSeconds: seconds, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 1, orderDelayJitterSeconds: 0 }, physiologyModel: "none", physiologyParams: {}, objectives: [] },
    seed,
    orders: [],
  };
}

/** testInput with every soldier carrying the test rifle (3 magazines of 30: one in the weapon, two spare). */
export function armedInput(seed = 1, seconds = 600): BattleInput {
  const input = testInput(seed, seconds);
  const arm = (u: UnitInput) => { for (const m of u.members) m.weapon = "rifle"; u.subunits.forEach(arm); };
  for (const f of input.forces) f.units.forEach(arm);
  return input;
}
