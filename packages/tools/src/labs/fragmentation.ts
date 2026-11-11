/**
 * FRAGMENTATION LAB (SPEC 5.4, M2 acceptance): a grenade bursts on open flat ground with men standing or lying
 * in a ring around it at a given distance, all facing the burst, wearing helmet and vest. Every fragment is a
 * real projectile; blast is by distance. Afterwards each man's physiology runs for an hour with no care.
 * A second table puts a brick wall between the burst and the men.
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import {
  createSim, DEFAULT_COMMS, detonate, EventSink, flatMap, simplePhysiology, step,
  type BattleInput, type Catalog, type Posture, type SoldierRecord,
} from "@tcs/sim";

export type FragCover = "brick wall 2 m" | "brick wall 1 m" | "wooden fence 1.8 m" | "hedge 1.5 m";
export interface FragCase { ammo: string; targetFaction: string; posture: Posture; distanceM: number; wall?: boolean; cover?: FragCover; seeds?: number }
export interface FragRow extends FragCase {
  men: number;
  /** Men with at least one wound from a fragment or the blast. */
  wounded: number;
  /** Fragment wounds per man (all men). */
  woundsPerMan: number;
  /** Fragments stopped by helmet or vest per man. */
  stoppedPerMan: number;
  /** Dead, unconscious or collapsed 5 s after the burst. */
  downAtOnce: number;
  deadAtOnce: number;
  dead60min: number;
  /** Not wounded but stunned by the blast. */
  stunnedOnly: number;
}

export function burstCase(catalog: Catalog, c: FragCase): FragRow {
  const row: FragRow = { ...c, men: 0, wounded: 0, woundsPerMan: 0, stoppedPerMan: 0, downAtOnce: 0, deadAtOnce: 0, dead60min: 0, stunnedOnly: 0 };
  const armour = Object.values(catalog.items).filter((i) => i.armour && i.id.startsWith(`${c.targetFaction}-`)).map((i) => ({ type: i.id, count: 1 }));
  // As many men as fit on the ring with 1.5 m between them, at most 16.
  const perRing = Math.max(4, Math.min(16, Math.floor((2 * Math.PI * c.distanceM) / 1.5)));
  let fragWounds = 0, stopped = 0;
  for (let seed = 1; seed <= (c.seeds ?? 10); seed++) {
    const map = flatMap("frag", 120, 120, 4);
    const cx = 60, cy = 60;
    const cover: FragCover | undefined = c.cover ?? (c.wall ? "brick wall 2 m" : undefined);
    if (cover) {
      // The cover runs all round the burst, 1.5 m inside the ring of men.
      const r = Math.max(1, c.distanceM - 1.5), pts: number[] = [];
      for (let k = 0; k <= 24; k++) pts.push(cx + r * Math.cos((k / 24) * 2 * Math.PI), cy + r * Math.sin((k / 24) * 2 * Math.PI));
      const spec = { "brick wall 2 m": ["brick-wall", 2, 0.24, "brick"], "brick wall 1 m": ["brick-wall", 1, 0.24, "brick"], "wooden fence 1.8 m": ["wooden-fence", 1.8, 0.02, "wood"], "hedge 1.5 m": ["hedge", 1.5, 1, "hedge"] }[cover] as [string, number, number, string];
      map.obstacles.push({ id: 1, kind: spec[0], points: pts, heightM: spec[1], thicknessM: spec[2], material: spec[3] });
    }
    const members: SoldierRecord[] = Array.from({ length: perRing }, (_, i) => ({
      personId: `m#${i}`, given: "Lab", family: `m${i}`, rank: "r", role: "rifleman", skills: { marksmanship: 0.5 }, fatigue: 0, stress: 0, wounds: [], load: armour.map((a) => ({ ...a })), status: "fit",
    }));
    // Rotate the ring a little each run so men do not always stand at the same bearings.
    const a0 = seed * 0.37;
    const input: BattleInput = {
      map, catalog, seed, orders: [],
      rules: { timeLimitSeconds: 3600, commsModel: "simple", comms: { ...DEFAULT_COMMS }, physiologyModel: "simple", physiologyParams: {}, objectives: [] },
      forces: [{
        side: "red", faction: c.targetFaction, units: [{ key: "t", callsign: "T", echelon: "team", leaderIndex: 0, subunits: [], members }],
        placements: members.map((m, i) => { const a = a0 + (i / perRing) * 2 * Math.PI; return { personId: m.personId, x: cx + c.distanceM * Math.cos(a), y: cy + c.distanceM * Math.sin(a), heading: a + Math.PI }; }),
      }],
    };
    const sim = createSim(input);
    for (const [, s] of sim.state.soldier.entries()) s.posture = c.posture;
    const sink = new EventSink();
    detonate(sim.ctx, sim.state, sink, cx, cy, 0.05, catalog.ammoIds.indexOf(c.ammo), 0);
    const events = [...sink.events];
    for (let t = 0; t < 300; t++) events.push(...step(sim));
    for (const e of events) if (e.kind === "hit" && e.armour === "stopped") stopped++;
    const params = sim.ctx.physiologyParams, dt = params["stepSeconds"] ?? 0.5;
    for (const [, s] of sim.state.soldier.entries()) {
      row.men++;
      const real = s.wounds.filter((w) => w.mechanism !== "blunt");
      fragWounds += real.filter((w) => w.mechanism === "fragment").length;
      if (real.length === 0) { if (s.stunnedUntilTick > 0) row.stunnedOnly++; continue; }
      row.wounded++;
      if (!s.physiology.alive) row.deadAtOnce++;
      if (s.casualty !== "none") row.downAtOnce++;
      const p = { ...s.physiology }, wounds = s.wounds.map((w) => ({ ...w }));
      for (let sec = 0; sec < 3600 && p.alive; sec += dt) simplePhysiology.step(p, wounds, dt, params);
      if (!p.alive) row.dead60min++;
    }
  }
  row.woundsPerMan = fragWounds / Math.max(1, row.men);
  row.stoppedPerMan = stopped / Math.max(1, row.men);
  return row;
}

export const FRAG_DISTANCES = [2, 5, 10, 15, 20, 30];

export function fragmentationLab(data: DataSet): { open: FragRow[]; wall: FragRow[]; cover: FragRow[] } {
  const cat = buildCatalog(data, ["de", "ru"]);
  const munitions: [string, string][] = [["de-dm51", "ru"], ["ru-rgd5", "de"], ["de-40mm-he", "ru"], ["ru-vog25", "de"]];
  const open: FragRow[] = [], wall: FragRow[] = [], cover: FragRow[] = [];
  for (const [ammo, targetFaction] of munitions) {
    for (const posture of ["standing", "prone"] as Posture[]) for (const distanceM of FRAG_DISTANCES) open.push(burstCase(cat, { ammo, targetFaction, posture, distanceM }));
    wall.push(burstCase(cat, { ammo, targetFaction, posture: "standing", distanceM: 5, wall: true }));
    if (ammo === munitions[0]![0] || ammo === munitions[1]![0]) {
      for (const cv of ["brick wall 1 m", "wooden fence 1.8 m", "hedge 1.5 m"] as FragCover[]) for (const posture of ["standing", "crouching"] as Posture[]) cover.push(burstCase(cat, { ammo, targetFaction, posture, distanceM: 5, cover: cv }));
    }
  }
  return { open, wall, cover };
}

export function fragmentationLabMarkdown(r: ReturnType<typeof fragmentationLab>): string {
  const pct = (a: number, b: number) => (b > 0 ? `${Math.round((100 * a) / b)} %` : "–");
  const out: string[] = [
    "A burst on open flat ground; men in a ring facing it, with helmet and vest. \"Down at once\" = dead, unconscious or collapsed within 5 s.",
    "Deaths within the hour are with no care at all.", "",
    "### Open ground", "", "| munition | posture | distance m | men | wounded | fragment wounds per man | stopped by armour per man | down at once | dead at once | dead within 60 min | only stunned |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  const line = (x: FragRow) => `| ${x.ammo} | ${x.posture} | ${x.distanceM} | ${x.men} | ${pct(x.wounded, x.men)} | ${x.woundsPerMan.toFixed(1)} | ${x.stoppedPerMan.toFixed(1)} | ${pct(x.downAtOnce, x.men)} | ${pct(x.deadAtOnce, x.men)} | ${pct(x.dead60min, x.men)} | ${pct(x.stunnedOnly, x.men)} |`;
  for (const x of r.open) out.push(line(x));
  out.push("", "### Behind a brick wall (2 m high, 24 cm), men standing 5 m from the burst", "", "| munition | posture | distance m | men | wounded | fragment wounds per man | stopped by armour per man | down at once | dead at once | dead within 60 min | only stunned |", "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const x of r.wall) out.push(line(x));
  out.push("", "### Behind other cover, 5 m from the burst (hand grenades)", "", "| munition | cover | posture | men | wounded | fragment wounds per man | down at once | dead within 60 min | only stunned |", "|---|---|---|---:|---:|---:|---:|---:|---:|");
  for (const x of r.cover) out.push(`| ${x.ammo} | ${x.cover ?? ""} | ${x.posture} | ${x.men} | ${pct(x.wounded, x.men)} | ${x.woundsPerMan.toFixed(1)} | ${pct(x.downAtOnce, x.men)} | ${pct(x.dead60min, x.men)} | ${pct(x.stunnedOnly, x.men)} |`);
  return out.join("\n");
}
