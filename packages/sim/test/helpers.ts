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
  movementModes: { walk: { id: "walk", speedMps: 1.5 }, run: { id: "run", speedMps: 3 } },
  qualities: {},
  factions: { fa: { id: "fa", nameKey: "fa", doctrine: {} }, fb: { id: "fb", nameKey: "fb", doctrine: {} } },
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
