/** Hand-built minimal inputs for sim unit tests (no data package needed). */
import {
  DEFAULT_COMMS, flatMap, type BattleInput, type Catalog, type SoldierRecord, type UnitInput,
} from "../src/index";

export const testCatalog: Catalog = {
  fingerprint: "test",
  items: {
    round: { id: "round", massKg: 0.012, category: "ammunition" },
    mag: { id: "mag", massKg: 0.1, category: "magazine", chargeCapacity: 30, chargeMassKg: 0.012, chargeItem: "round" },
    brick: { id: "brick", massKg: 2, category: "supply" },
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
    ricochetSpeedRetention: [0.55, 0.9], ricochetScatterDeg: 6, minSpeedMps: 40, maxFlightSeconds: 12,
  },
  ammo: {
    ball: { id: "ball", calibre: "5.56x45", kind: "ball", projectileMassKg: 0.004, cartridgeMassKg: 0.012, diameterM: 0.0057, drag: { a: 0.061, b: 193, max: 0.5 }, penetration: { steelMm: 3.5, atVelocityMps: 325, breakupVelocityMps: 724 }, tracer: false, fuse: "none", guidance: "unguided" },
  },
  ammoIds: ["ball"],
  weapons: {},
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
    buildings: { house: { id: "house", widthM: [8, 12], depthM: [8, 11], storeys: [1, 2], storeyHeightM: 2.8, wallMaterial: "brick", wallThicknessM: 0.3, roofColours: ["#8c4a3b"] } },
  },
  body: {
    postures: { standing: { heightM: 1.75, speedFactor: 1 }, crouching: { heightM: 1.1, speedFactor: 0.6 }, prone: { heightM: 0.4, speedFactor: 0.25 } },
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
