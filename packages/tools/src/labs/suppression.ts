/**
 * SUPPRESSION LAB (M4.1): what a given volume of fire does to a group of men. Four German riflemen lie (or
 * stand) in a line 5 m apart; Russian fire comes in at the middle of the line from a given range: one rifle,
 * a fire team of three rifles, or a PKP machine gun. Each case is run over several seeds; the table shows how
 * soon the first man is pinned, how many are pinned after 30 s, their mean suppression and stress after 60 s.
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import { createSim, DEFAULT_COMMS, flatMap, step, submitOrder, type BattleInput, type Catalog, type Posture, type SoldierRecord } from "@tcs/sim";

export interface SupCase { name: string; firers: "rifle" | "team" | "mg"; rangeM: number; posture: Posture; seeds?: number }
export interface SupRow extends SupCase { runs: number; shotsPerMin: number; firstPinS: number | null; pinned30: number; meanSup60: number; meanStress60: number; hit: number }

function man(personId: string, weapon: string, mag: string, catalog: Catalog, count = 6): SoldierRecord {
  return { personId, given: "Lab", family: personId, rank: "r", role: "rifleman", skills: { marksmanship: 0.5, experience: 0.5 }, weapon, fatigue: 0, stress: 0, wounds: [], status: "fit", load: [{ type: mag, count, charge: catalog.items[mag]?.chargeCapacity ?? 30 }] };
}

export function supCase(catalog: Catalog, c: SupCase): SupRow {
  const seeds = c.seeds ?? 8, secs = 60;
  let shots = 0, pinned30 = 0, sup60 = 0, stress60 = 0, hit = 0;
  const firsts: number[] = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const map = flatMap("sup", c.rangeM + 100, 120, 4);
    const tx = 30, ty = 60;
    const targets = [0, 1, 2, 3].map((i) => man(`t${i}`, "de-g36", "de-g36-mag", catalog));
    const firers = c.firers === "mg" ? [man("f0", "ru-pkp", "ru-pkp-belt", catalog, 4)] : (c.firers === "team" ? [0, 1, 2] : [0]).map((i) => man(`f${i}`, "ru-ak74m", "ru-ak74-mag", catalog, 10));
    const input: BattleInput = {
      map, catalog, seed, orders: [],
      rules: { timeLimitSeconds: secs + 10, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "simple", physiologyParams: {}, objectives: [] },
      forces: [
        { side: "blue", faction: "de", units: [{ key: "t", callsign: "T", echelon: "team", leaderIndex: 0, subunits: [], members: targets }], placements: targets.map((m, i) => ({ personId: m.personId, x: tx, y: ty - 7.5 + 5 * i, heading: 0 })) },
        { side: "red", faction: "ru", units: [{ key: "f", callsign: "F", echelon: "team", leaderIndex: 0, subunits: [], members: firers }], placements: firers.map((m, i) => ({ personId: m.personId, x: tx + c.rangeM, y: ty - 3 + 3 * i, heading: Math.PI })) },
      ],
    };
    const sim = createSim(input);
    const ids = [...sim.state.identity.entries()];
    const blue = ids.filter(([, i]) => i.side === "blue").map(([id]) => id);
    const red = ids.find(([, i]) => i.side === "red")!;
    for (const id of blue) sim.state.soldier.req(id).posture = c.posture;
    for (const [id, i] of ids) if (i.side === "red") sim.state.soldier.req(id).posture = "prone";
    // The men under fire hold their fire (this lab measures what the fire does to them, not a firefight).
    submitOrder(sim, { tick: 0, issuer: "blue", target: sim.state.identity.req(blue[0]!).unit, kind: "rules", fire: "hold" });
    let first: number | null = null;
    for (let k = 0; k < secs * 60; k++) {
      // The order is renewed every 10 s (a fire order at a point otherwise slows to a trickle and ends).
      if (k % 600 === 0) submitOrder(sim, { tick: k, issuer: "red", target: sim.state.identity.req(red[0]).unit, kind: "fire", x: tx, y: ty, heightM: 0.5 });
      for (const e of step(sim)) {
        if (e.kind === "shot.fired") shots++;
        if (e.kind === "behaviour.changed" && e.to === "pinned" && first === null) first = e.tick / 60;
        if (e.kind === "hit") hit++;
      }
      if (k === 30 * 60) pinned30 += blue.filter((id) => sim.state.soldier.req(id).mental.behaviour === "pinned").length;
    }
    for (const id of blue) { const m = sim.state.soldier.req(id).mental; sup60 += m.suppression; stress60 += m.stress; }
    if (first !== null) firsts.push(first);
  }
  firsts.sort((a, b) => a - b);
  return { ...c, runs: seeds, shotsPerMin: shots / seeds, firstPinS: firsts.length * 2 > seeds ? firsts[Math.floor(seeds / 2)] ?? null : null, pinned30: pinned30 / (seeds * 4), meanSup60: sup60 / (seeds * 4), meanStress60: stress60 / (seeds * 4), hit: hit / seeds };
}

export const SUP_CASES: SupCase[] = [
  { name: "one rifle", firers: "rifle", rangeM: 200, posture: "prone" },
  { name: "fire team (3 rifles)", firers: "team", rangeM: 200, posture: "prone" },
  { name: "fire team (3 rifles)", firers: "team", rangeM: 400, posture: "prone" },
  { name: "PKP machine gun", firers: "mg", rangeM: 200, posture: "prone" },
  { name: "PKP machine gun", firers: "mg", rangeM: 400, posture: "prone" },
  { name: "PKP machine gun", firers: "mg", rangeM: 600, posture: "prone" },
];

export function suppressionLab(data: DataSet): SupRow[] {
  const cat = buildCatalog(data, ["de", "ru"]);
  return SUP_CASES.map((c) => supCase(cat, c));
}

export function suppressionLabMarkdown(rows: SupRow[]): string {
  const out = ["Four German riflemen prone in a line 5 m apart, Russian fire at the middle of the line for 60 s; 8 runs per row (median, means).", "",
    "| fire | range m | rounds per run | first man pinned (median s) | pinned at 30 s | mean suppression at 60 s | mean stress at 60 s | hits per run |", "|---|---:|---:|---:|---:|---:|---:|---:|"];
  for (const r of rows) out.push(`| ${r.name} | ${r.rangeM} | ${r.shotsPerMin.toFixed(0)} | ${r.firstPinS === null ? "not in most runs" : r.firstPinS.toFixed(1)} | ${Math.round(r.pinned30 * 100)} % | ${r.meanSup60.toFixed(2)} | ${r.meanStress60.toFixed(2)} | ${r.hit.toFixed(1)} |`);
  return out.join("\n");
}
