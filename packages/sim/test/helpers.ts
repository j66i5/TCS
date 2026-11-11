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
  factions: { fa: { id: "fa", nameKey: "fa", doctrine: {} }, fb: { id: "fb", nameKey: "fb", doctrine: {} } },
  terrain: {
    materials: { brick: { id: "brick", densityKgM3: 1900, resistance: 0.08, hardness: 0.5 } },
    surfaces: {
      grass: { id: "grass", moveCost: { foot: 1, wheeled: 1.4, tracked: 1.1 }, noise: 0.2, dust: 0.1, colour: "#6f8f4a" },
      water: { id: "water", moveCost: { foot: null, wheeled: null, tracked: null }, noise: 0, dust: 0, colour: "#36576b" },
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
    movement: { slopeK: 3.5, slopeOffset: 0.05, loadFreeKg: 10, loadSpeedPerKg: 0.006, minLoadSpeedFactor: 0.5, fatigueSpeedPenalty: 0.35, noRunFatigue: 0.9 },
    physiology: {
      bodyMassKg: 80, loadExertionK: 0.8, slopeExertionK: 4, sustainable: 0.35, fatigueGainPerS: 0.0062, recoveryPerS: 0.0067,
      hrRestBpm: 70, hrMaxBpm: 190, hrRiseTauS: 20, hrFallTauS: 45, heatThresholdC: 25, heatPerC: 0.03,
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
