/**
 * MORALE LAB (morale rework 2026-11-15): set pieces that check the shape of the morale model against its acceptance
 * targets. A squad of eight German riflemen lies prone in a line 5 m apart, its leader in the middle; they hold their
 * fire. Each trial draws the men's skills from their quality (core/qualities.json) and their nerve from the battle
 * seed, so the rows differ only by quality, experience and leadership (never by faction).
 *
 *   losses     light fire (a Russian rifle team at 400 m) for 90 s; the leader falls at 30 s, two men at 45 s and 60 s.
 *              Is the squad shaken or worse 30 s after the third loss? (target: >= 70 % for regulars; conscripts
 *              more often, veterans less)
 *   fire       a PKP at 200 m for 120 s, the leader falls at 40 s: share of man-time panicked (target: conscripts at
 *              least 1.5 x veterans)
 *   recovery   no fire; every man but the leader starts shaken (morale 0.5) or panicked (0.15): median seconds until
 *              steady (shaken) or until at most shaken (panicked), with the leader present (he rallies) and without
 *              (target: shaken -> steady <= 3 min with the leader, <= 6 min without; panicked -> shaken <= 2 min
 *              with a rally, <= 5 min without)
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import {
  createRng, createSim, DEFAULT_COMMS, EventSink, flatMap, moraleKicks, nextNormal, refreshStatus, resolveOf, step, submitOrder,
  type BattleInput, type Catalog, type EntityId, type Sim, type SoldierRecord,
} from "@tcs/sim";

const QUALITIES = ["conscript", "regular", "veteran"] as const;

function man(catalog: Catalog, personId: string, quality: string, seed: number, i: number, weapon: string, mag: string, count = 6): SoldierRecord {
  const q = catalog.qualities[quality]!, rng = createRng(seed * 1000 + i);
  const skill = (k: string) => Math.min(1, Math.max(0, (q.skills[k]?.mean ?? 0.5) + (q.skills[k]?.sd ?? 0) * nextNormal(rng, "lab")));
  return {
    personId, given: "Lab", family: personId, rank: "r", role: "rifleman", weapon, fatigue: 0, stress: 0, wounds: [], status: "fit",
    skills: { marksmanship: skill("marksmanship"), fieldcraft: skill("fieldcraft"), leadership: skill("leadership"), experience: skill("experience"), medical: 0.2 },
    load: [{ type: mag, count, charge: catalog.items[mag]?.chargeCapacity ?? 30 }],
  };
}

interface Setup { sim: Sim; blue: EntityId[]; leader: EntityId | null; unit: EntityId }

function build(catalog: Catalog, quality: string, seed: number, fire: "none" | "team" | "mg", rangeM: number, withLeader = true): Setup {
  const map = flatMap("morale", rangeM + 120, 140, 4);
  const tx = 30, ty = 70;
  const blue = Array.from({ length: 8 }, (_, i) => man(catalog, `b${i}`, quality, seed, i, "de-g36", "de-g36-mag"));
  const firers = fire === "mg" ? [man(catalog, "f0", "regular", seed, 50, "ru-pkp", "ru-pkp-belt", 6)] : fire === "team" ? [0, 1, 2].map((i) => man(catalog, `f${i}`, "regular", seed, 60 + i, "ru-ak74m", "ru-ak74-mag", 12)) : [];
  const input: BattleInput = {
    map, catalog, seed, orders: [],
    rules: { timeLimitSeconds: 900, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "simple", physiologyParams: {}, objectives: [] },
    forces: [
      { side: "blue", faction: "de", units: [{ key: "b", callsign: "B", echelon: "squad", leaderIndex: withLeader ? 3 : -1, subunits: [], members: blue, quality }], placements: blue.map((m, i) => ({ personId: m.personId, x: tx, y: ty - 17.5 + 5 * i, heading: 0 })) },
      { side: "red", faction: "ru", units: [{ key: "f", callsign: "F", echelon: "team", leaderIndex: 0, subunits: [], members: firers.length > 0 ? firers : [man(catalog, "f0", "regular", seed, 70, "ru-ak74m", "ru-ak74-mag", 1)] }], placements: (firers.length > 0 ? firers : [{ personId: "f0" }]).map((m, i) => ({ personId: m.personId, x: tx + rangeM, y: ty - 3 + 3 * i, heading: Math.PI })) },
    ],
  };
  const sim = createSim(input);
  const ids = [...sim.state.identity.entries()];
  const b = ids.filter(([, i]) => i.side === "blue").map(([id]) => id);
  for (const [id] of ids) sim.state.soldier.req(id).posture = "prone";
  const unit = sim.state.identity.req(b[0]!).unit;
  submitOrder(sim, { tick: 0, issuer: "blue", target: unit, kind: "rules", fire: "hold" });
  // Red fires only when the trial says so.
  const red = ids.find(([, i]) => i.side === "red")!;
  if (fire === "none") submitOrder(sim, { tick: 0, issuer: "red", target: sim.state.identity.req(red[0]).unit, kind: "rules", fire: "hold" });
  return { sim, blue: b, leader: sim.state.unit.req(unit).leader, unit };
}

/** Kill a man now (as a fatal hit would), with the morale blows of his fall. */
function kill(sim: Sim, id: EntityId): void {
  const s = sim.state.soldier.req(id);
  s.physiology.alive = false; s.physiology.consciousness = 0;
  const sink = new EventSink();
  refreshStatus(sim.ctx, sim.state, sink, id);
  moraleKicks(sim.ctx, sim.state, sink.events);
}

function runFor(sim: Sim, seconds: number, each?: (sec: number) => void, fireAt?: () => void): void {
  for (let k = 0; k < seconds * 60; k++) {
    if (fireAt && k % 600 === 0) fireAt();
    step(sim);
    if (each && sim.state.tick % 60 === 0) each(sim.state.tick / 60);
  }
}

function fireOrder(st: Setup, x: number, y: number): () => void {
  const red = [...st.sim.state.identity.entries()].find(([, i]) => i.side === "red")!;
  return () => submitOrder(st.sim, { tick: st.sim.state.tick, issuer: "red", target: st.sim.state.identity.req(red[0]).unit, kind: "fire", x, y, heightM: 0.5 });
}

export interface LossRow { quality: string; trials: number; shakenOrWorse: number; meanMorale: number; brokenShare: number }
export function lossesTrial(catalog: Catalog, quality: string, trials: number): LossRow {
  let hit = 0, sumM = 0, n = 0, broken = 0;
  for (let seed = 1; seed <= trials; seed++) {
    const st = build(catalog, quality, seed, "team", 400);
    const others = st.blue.filter((m) => m !== st.leader);
    const shoot = fireOrder(st, 30, 70);
    let t = 0;
    runFor(st.sim, 90, (sec) => {
      t = sec;
      if (sec === 30 && st.leader !== null) kill(st.sim, st.leader);
      if (sec === 45) kill(st.sim, others[0]!);
      if (sec === 60) kill(st.sim, others[others.length - 1]!);
    }, shoot);
    void t;
    const mo = st.sim.state.unit.req(st.unit).morale;
    if (mo.state !== "steady") hit++;
    if (mo.state === "broken" || st.sim.state.unit.req(st.unit).broken) broken++;
    for (const m of st.blue) { const s = st.sim.state.soldier.req(m); if (s.physiology.alive) { sumM += s.mental.morale; n++; } }
  }
  return { quality, trials, shakenOrWorse: hit / trials, meanMorale: n > 0 ? sumM / n : 0, brokenShare: broken / trials };
}

export interface FireRow { quality: string; trials: number; panicShare: number; pinnedShare: number; shakenShare: number; meanMorale: number }
export function fireTrial(catalog: Catalog, quality: string, trials: number): FireRow {
  let panic = 0, pinned = 0, shaken = 0, samples = 0, sumM = 0;
  for (let seed = 1; seed <= trials; seed++) {
    const st = build(catalog, quality, seed, "mg", 200);
    runFor(st.sim, 120, (sec) => {
      if (sec === 40 && st.leader !== null) kill(st.sim, st.leader);
      for (const m of st.blue) {
        const s = st.sim.state.soldier.req(m);
        if (!s.physiology.alive || s.casualty !== "none") continue;
        samples++; sumM += s.mental.morale;
        const b = s.mental.behaviour;
        if (b === "panicked" || b === "routed") panic++;
        else if (b === "pinned") pinned++;
        else if (b === "shaken") shaken++;
      }
    }, fireOrder(st, 30, 70));
  }
  return { quality, trials, panicShare: panic / Math.max(1, samples), pinnedShare: pinned / Math.max(1, samples), shakenShare: shaken / Math.max(1, samples), meanMorale: sumM / Math.max(1, samples) };
}

export interface RecoveryRow { start: "shaken" | "panicked"; leader: boolean; trials: number; medianS: number | null; within: number; rallies: number }
export function recoveryTrial(catalog: Catalog, start: "shaken" | "panicked", leader: boolean, trials: number): RecoveryRow {
  const times: number[] = [];
  let men = 0, rallies = 0;
  const limit = 600, goal = start === "shaken" ? 180 : 120;
  for (let seed = 1; seed <= trials; seed++) {
    const st = build(catalog, "regular", seed, "none", 300, leader);
    const target = start === "shaken" ? 0.5 : 0.15;
    const done = new Map<EntityId, number>();
    const others = st.blue.filter((m) => m !== st.leader);
    for (const m of others) {
      const s = st.sim.state.soldier.req(m);
      const r = resolveOf(st.sim.ctx, st.sim.state, m, s);
      s.mental.stress = Math.max(0, 1 - target / r);
      s.mental.why[0] = s.mental.stress;
      s.mental.morale = target;
      s.mental.behaviour = start;
      if (start === "panicked") s.mental.panicTick = 0;
    }
    men += others.length;
    for (let k = 0; k < limit * 60; k++) {
      for (const e of step(st.sim)) if (e.kind === "morale.rally") rallies++;
      if (st.sim.state.tick % 60 !== 0) continue;
      for (const m of others) {
        if (done.has(m)) continue;
        const b = st.sim.state.soldier.req(m).mental.behaviour;
        if (start === "shaken" ? b === "steady" : b === "steady" || b === "shaken") done.set(m, st.sim.state.tick / 60);
      }
      if (done.size === others.length) break;
    }
    for (const m of others) times.push(done.get(m) ?? Infinity);
  }
  times.sort((a, b) => a - b);
  const med = times[Math.floor(times.length / 2)]!;
  return { start, leader, trials, medianS: Number.isFinite(med) ? med : null, within: times.filter((t) => t <= goal).length / Math.max(1, men), rallies: rallies / trials };
}

export interface MoraleLab { losses: LossRow[]; fire: FireRow[]; recovery: RecoveryRow[] }
export function moraleLab(data: DataSet, trials = 12): MoraleLab {
  const cat = buildCatalog(data, ["de", "ru"]);
  return {
    losses: QUALITIES.map((q) => lossesTrial(cat, q, trials)),
    fire: QUALITIES.map((q) => fireTrial(cat, q, trials)),
    recovery: [recoveryTrial(cat, "shaken", true, trials), recoveryTrial(cat, "shaken", false, trials), recoveryTrial(cat, "panicked", true, trials), recoveryTrial(cat, "panicked", false, trials)],
  };
}

const pc = (x: number) => `${Math.round(x * 100)} %`;
export function moraleLabMarkdown(r: MoraleLab): string {
  const out = [
    "A squad of eight German riflemen prone in a line 5 m apart, leader in the middle, holding fire; skills drawn from the quality, nerve from the seed.", "",
    "## Losses under light fire", "",
    "A Russian rifle team at 400 m fires at the squad for 90 s; the leader falls at 30 s, two men at 45 s and 60 s. Squad state 30 s after the third loss (target: shaken or worse in at least 70 % of trials for regulars; conscripts more, veterans less).", "",
    "| quality | trials | squad shaken or worse | squad broken | mean morale of the living |", "|---|---:|---:|---:|---:|",
    ...r.losses.map((x) => `| ${x.quality} | ${x.trials} | ${pc(x.shakenOrWorse)} | ${pc(x.brokenShare)} | ${x.meanMorale.toFixed(2)} |`), "",
    "## Heavy fire", "",
    "A PKP at 200 m fires at the squad for 120 s; the leader falls at 40 s. Share of the able men's time in each state (target: panicked time of conscripts at least 1.5 x that of veterans).", "",
    "| quality | trials | panicked | pinned | shaken | mean morale |", "|---|---:|---:|---:|---:|---:|",
    ...r.fire.map((x) => `| ${x.quality} | ${x.trials} | ${pc(x.panicShare)} | ${pc(x.pinnedShare)} | ${pc(x.shakenShare)} | ${x.meanMorale.toFixed(2)} |`), "",
    "## Recovery once the fire has stopped", "",
    "No fire; every man but the leader starts shaken (morale 0.5) or panicked (0.15). Regulars. Median seconds until steady (from shaken) or at most shaken (from panicked); share of men there within the target (3 min from shaken, 2 min from panicked). Without a leader there is no rally.", "",
    "| start | leader | trials | median s | within target | rallies per trial |", "|---|---|---:|---:|---:|---:|",
    ...r.recovery.map((x) => `| ${x.start} | ${x.leader ? "present" : "none"} | ${x.trials} | ${x.medianS === null ? "> 600" : x.medianS.toFixed(0)} | ${pc(x.within)} | ${x.rallies.toFixed(1)} |`),
  ];
  return out.join("\n");
}
