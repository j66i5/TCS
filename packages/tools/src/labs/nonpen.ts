/**
 * Armour lab, part "not penetrated" (balance pass 6): a cannon firing at a hull whose armour its armour-piercing
 * round cannot get through (or mostly cannot), at 800 m: what the stopped and glancing rounds break
 * (core/ballistics.json `armour.nonPenetrating`). Two modes:
 *   ordered   the player's order "fire armour-piercing at that vehicle": the crew aims at the hull;
 *   own       the crew's own choice with no missile aboard (taken out of its load): the degrading fire of
 *             behaviour.json `gunnery.degrade`, high explosive first, aimed at the turret.
 * The target holds its fire and is frozen where it stands (status immobilised, field repair off: a hull that could
 * drive would back away once disarmed); a frozen hull whose gun and coaxial machine gun are both out is left by its
 * crew ("left"), which a hull that can still drive is not. Flat 2400 x 1200 m field, 120 s a run.
 */
import { createSim, step, submitOrder, type EntityId } from "@tcs/sim";
import type { DataSet } from "@tcs/data";
import { duel } from "./gunnery";

export interface NonPenCase { label: string; factions: [string, string]; crews: [string, string]; aspect: "front" | "side"; /** Range, m (default 800). */ rangeM?: number }
export interface NonPenRow {
  label: string; aspect: "front" | "side"; mode: "ordered" | "own"; runs: number;
  /** Per run, means. */
  rounds: number; stopped: number; penetrated: number;
  /** Runs in which a part of that kind was at 0 at the end. */
  out: Record<string, number>;
  /** Mean stopped hits before the first sights-out / track- or wheel-out, over the runs it happened in (NaN: never). */
  hitsToSights: number; hitsToRunningGear: number;
  /** Mean seconds of fire until the first sight was wrecked, over the runs it happened in. */
  secondsToSights: number;
  /** Runs that ended with the target destroyed / burning / left by its crew; and with a crewman or rider hurt. */
  destroyed: number; fire: number; left: number; hurt: number;
  /** The crew's reasons seen in "own" mode. */
  why: string[];
}

export const NONPEN_CASES: NonPenCase[] = [
  { label: "BMP-2 (30 mm 2A42) at Puma", factions: ["ru", "de"], crews: ["bmp2-ekipazh", "puma-besatzung"], aspect: "front" },
  { label: "BTR-82A (30 mm 2A72) at Puma", factions: ["ru", "de"], crews: ["btr82a-ekipazh", "puma-besatzung"], aspect: "front" },
  { label: "BMP-2 (30 mm 2A42) at Leopard 2A7V", factions: ["ru", "de"], crews: ["bmp2-ekipazh", "leopard2a7v-besatzung"], aspect: "front" },
  { label: "BMP-2 (30 mm 2A42) at Leopard 2A7V", factions: ["ru", "de"], crews: ["bmp2-ekipazh", "leopard2a7v-besatzung"], aspect: "side" },
  { label: "Puma (30 mm MK30-2) at T-90M", factions: ["de", "ru"], crews: ["puma-besatzung", "t90m-ekipazh"], aspect: "front" },
  { label: "Puma (30 mm MK30-2) at T-72B3M", factions: ["de", "ru"], crews: ["puma-besatzung", "t72b3m-ekipazh"], aspect: "front" },
  // (Verification fix: close in, fire aimed at the turret's middle lands on the mantlet; the gun is what goes.)
  { label: "Puma (30 mm MK30-2) at T-90M, 500 m", factions: ["de", "ru"], crews: ["puma-besatzung", "t90m-ekipazh"], aspect: "front", rangeM: 500 },
  { label: "BMP-2 (30 mm 2A42) at Leopard 2A7V, 500 m", factions: ["ru", "de"], crews: ["bmp2-ekipazh", "leopard2a7v-besatzung"], aspect: "front", rangeM: 500 },
];

const RANGE_M = 800, SECONDS = 120;

export interface NonPenRun { rounds: number; stopped: number; penetrated: number; out: string[]; hitsToSights: number; hitsToRunningGear: number; secondsToSights: number; status: string; fire: boolean; hurt: boolean; why: string[]; damaged: Record<string, number> }

/** One run. */
export function nonPenRun(data: DataSet, cs: NonPenCase, mode: "ordered" | "own", seed: number, seconds = SECONDS, rangeM = cs.rangeM ?? RANGE_M): NonPenRun {
  const bx = 400, y = 600;
  const input = duel(data, cs.factions, { blue: { x: bx, y, heading: 0 }, red: { x: bx + rangeM, y, heading: cs.aspect === "front" ? Math.PI : Math.PI / 2 } }, undefined, 2400, cs.crews);
  input.seed = seed;
  input.rules = { ...input.rules, repair: false };
  // "own": no guided missile aboard (the cannon's own choice is what is measured).
  if (mode === "own") for (const rec of input.forces[0]!.vehicles ?? []) rec.load = rec.load.filter((l) => { const r = input.catalog.items[l.type]?.chargeItem ?? l.type; return input.catalog.ammo[r]?.guided === undefined; });
  const sim = createSim(input), st = sim.state;
  let bv: EntityId = -1, rv: EntityId = -1;
  for (const [vid, v] of st.vehicle.entries()) { if (v.side === "blue" && bv < 0) bv = vid; if (v.side === "red" && rv < 0) rv = vid; }
  const B = st.vehicle.req(bv), R = st.vehicle.req(rv);
  if (mode === "own") {
    // (The missile ready on its launcher too.)
    const bdef = input.catalog.vehicles[B.def]!;
    bdef.stations.forEach((sn, si) => sn.weapons.forEach((w, wi) => w.feeds.forEach((f, fi) => {
      if (input.catalog.ammo[input.catalog.items[f.item]?.chargeItem ?? ""]?.guided !== undefined) { const fs = B.stations[si]?.weapons[wi]?.feeds[fi]; if (fs) fs.rounds = 0; }
    })));
  }
  for (const [uid, u] of st.unit.entries()) if (u.parent === null) submitOrder(sim, { tick: st.tick, issuer: u.side, target: uid, kind: "rules", fire: u.side === "blue" && mode === "own" ? "free" : "hold" });
  step(sim);
  R.status = "immobilised";
  if (mode === "ordered") { const t = st.transform.req(rv); submitOrder(sim, { tick: st.tick, issuer: "blue", target: B.unit!, kind: "fire", x: t.x, y: t.y, contact: rv, nature: "ap" }); }
  const comps = input.catalog.vehicles[R.def]!.components ?? [];
  const run: NonPenRun = { rounds: 0, stopped: 0, penetrated: 0, out: [], hitsToSights: NaN, hitsToRunningGear: NaN, secondsToSights: NaN, status: "", fire: false, hurt: false, why: [], damaged: {} };
  for (let i = 0; i < seconds * 60; i++) for (const e of step(sim)) {
    if (e.kind === "shot.fired" && e.vehicle === bv) run.rounds++;
    else if (e.kind === "vehicle.hit" && e.vehicle === rv) { if (e.result === "penetrated") run.penetrated += e.rounds; else run.stopped += e.rounds; }
    else if (e.kind === "vehicle.component" && e.vehicle === rv) {
      const c = comps[e.component]!;
      run.damaged[c.id] = e.condition;
      if (e.condition <= 0) {
        if (c.kind === "sights" && Number.isNaN(run.hitsToSights)) { run.hitsToSights = run.stopped + 1; run.secondsToSights = i / 60; }
        if ((c.kind === "track" || c.kind === "wheels") && Number.isNaN(run.hitsToRunningGear)) run.hitsToRunningGear = run.stopped + 1;
      }
    }
    else if (e.kind === "vehicle.fire" && e.vehicle === rv) run.fire = true;
    else if (e.kind === "vehicle.decision" && e.vehicle === bv) for (const k of e.keys) if (!run.why.includes(k)) run.why.push(k);
  }
  comps.forEach((c, k) => { if ((R.comp[k] ?? 1) <= 0 && !run.out.includes(c.kind)) run.out.push(c.kind); });
  run.status = R.status;
  for (const m of R.seats) if (m !== null && m !== undefined && (st.soldier.get(m)?.wounds.length ?? 0) > 0) run.hurt = true;
  return run;
}

export function nonPenLab(data: DataSet, seeds = 6, cases: NonPenCase[] = NONPEN_CASES, modes: ("ordered" | "own")[] = ["ordered", "own"]): NonPenRow[] {
  const rows: NonPenRow[] = [];
  const mean = (xs: number[]) => { const v = xs.filter((x) => !Number.isNaN(x)); return v.length === 0 ? NaN : v.reduce((a, b) => a + b, 0) / v.length; };
  for (const cs of cases) for (const mode of modes) {
    const runs: NonPenRun[] = [];
    for (let s = 1; s <= seeds; s++) runs.push(nonPenRun(data, cs, mode, 100 + s));
    const out: Record<string, number> = {};
    for (const r of runs) for (const k of r.out) out[k] = (out[k] ?? 0) + 1;
    rows.push({
      label: cs.label, aspect: cs.aspect, mode, runs: seeds,
      rounds: mean(runs.map((r) => r.rounds)), stopped: mean(runs.map((r) => r.stopped)), penetrated: mean(runs.map((r) => r.penetrated)),
      out, hitsToSights: mean(runs.map((r) => r.hitsToSights)), hitsToRunningGear: mean(runs.map((r) => r.hitsToRunningGear)), secondsToSights: mean(runs.map((r) => r.secondsToSights)),
      destroyed: runs.filter((r) => r.status === "destroyed").length, fire: runs.filter((r) => r.fire).length, left: runs.filter((r) => r.status === "abandoned").length, hurt: runs.filter((r) => r.hurt).length,
      why: [...new Set(runs.flatMap((r) => r.why))].filter((k) => k.startsWith("why.nature") || k.startsWith("why.hold")),
    });
  }
  return rows;
}

export function nonPenLabMarkdown(rows: NonPenRow[]): string {
  const out = [
    `One hull firing at a halted enemy hull at ${RANGE_M} m (or the range its row names) for ${SECONDS} s. "ordered": the order to fire armour-piercing at it (aimed at the hull); "own": the crew's own choice with no missile aboard (degrading fire: high explosive first, aimed at the turret). Rounds and hits are means per run; "parts out" counts the runs in which a part of that kind was wrecked at the end; "hits to" is the mean number of hits that did not get through before the first sight (track, wheel) was wrecked, and "s to sights out" the seconds of fire until then, over the runs in which one was. A high-explosive burst on the armour that damages nothing is no hit event and is not counted. The target is frozen where it stands: "left" = its crew got out because it could neither move nor fire (a hull that can drive backs away instead).`, "",
    "| Shooter at target | Face | Mode | Runs | Rounds | Hits not through | Hits through | Parts out (runs) | Hits to sights out | s to sights out | Hits to track or wheel out | Burning | Destroyed | Left | Men hurt inside | Crew's reasons |",
    "|---|---|---|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---|",
  ];
  const n = (x: number) => (Number.isNaN(x) ? "-" : x.toFixed(1));
  for (const r of rows) {
    const parts = Object.entries(r.out).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k, c]) => `${k} ${c}`).join(", ") || "-";
    out.push(`| ${r.label} | ${r.aspect} | ${r.mode} | ${r.runs} | ${n(r.rounds)} | ${n(r.stopped)} | ${n(r.penetrated)} | ${parts} | ${n(r.hitsToSights)} | ${n(r.secondsToSights)} | ${n(r.hitsToRunningGear)} | ${r.fire} | ${r.destroyed} | ${r.left} | ${r.hurt} | ${r.why.join(", ") || "-"} |`);
  }
  return out.join("\n");
}
