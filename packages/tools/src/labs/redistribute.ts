/**
 * REDISTRIBUTION LAB (M11.2, plan slice 44): does a quiet squad even out its ammunition?
 *
 * A German Schuetzentrupp and a Russian motor rifle squad (data templates, on foot) stand 5 m apart on open ground, an
 * enemy team far off holding its fire. Each rifleman's spare magazines are set to 0..6 (a different spread per trial),
 * the machine gunner has no spare belt and the man who carries belts for him keeps them. Nobody is fired on, so after
 * `consolidate.quietS` (60 s) the squad leader evens it out. Measured at 60 s after the quiet began: the largest
 * difference of any man's spare magazines from the squad's mean (target: at most one), the gunner's spare belts and
 * whether the first hand-over was a belt to him, the hand-overs, and the ledger (rounds and items unchanged).
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import { buildForce, withoutVehicles } from "@tcs/scenario";
import {
  createSim, DEFAULT_COMMS, flatMap, ledgerOf, step, TICK_HZ,
  type BattleInput, type Catalog, type EntityId, type SimEvent, type UnitInput,
} from "@tcs/sim";

export interface RedistributeRow {
  faction: string; trial: number; men: number; before: number[]; after: number[]; maxDev: number;
  gunnerBelts: [number, number] | null; beltFirst: boolean | null; handovers: number; firstS: number | null; ledgerExact: boolean;
}

const SPREADS = [[0, 6, 1, 5, 2, 4, 3], [6, 6, 0, 0, 3, 1, 2], [0, 0, 0, 6, 6, 6, 1], [2, 3, 4, 5, 6, 0, 1]];

function members(u: UnitInput): UnitInput["members"] { return [...u.members, ...u.subunits.flatMap(members)]; }

function oneTrial(data: DataSet, catalog: Catalog, faction: string, template: string, trial: number): RedistributeRow {
  const squad = withoutVehicles(buildForce(data, { faction, template, seed: trial, keyPrefix: "b" }));
  const foe = withoutVehicles(buildForce(data, { faction: faction === "de" ? "ru" : "de", template: "demo-team", seed: trial, keyPrefix: "r" }));
  const spread = SPREADS[(trial - 1) % SPREADS.length]!;
  let k = 0;
  let gunnerId: string | null = null;
  for (const m of members(squad)) {
    const wd = m.weapon !== undefined ? catalog.weapons[m.weapon] : undefined;
    if (!wd) continue;
    const feed = wd.feed.magazine;
    const st = m.load.find((l) => l.type === feed);
    if (wd.sustained !== undefined) {
      // The gunner: only the belt in his gun (no spare).
      gunnerId = m.personId;
      m.load = m.load.filter((l) => l.type !== feed);
      m.load.push({ type: feed, count: 1, charge: st?.charge ?? catalog.items[feed]!.chargeCapacity! });
      continue;
    }
    const n = spread[k++ % spread.length]!;
    const charge = st?.charge ?? catalog.items[feed]!.chargeCapacity!;
    m.load = m.load.filter((l) => l.type !== feed);
    m.load.push({ type: feed, count: n + 1, charge }); // (one goes into the weapon)
  }
  const all = members(squad), fm = members(foe);
  const input: BattleInput = {
    map: flatMap("redistribute", 2000, 200, 4), catalog, seed: trial, orders: [],
    rules: { timeLimitSeconds: 600, commsModel: "simple", comms: { ...DEFAULT_COMMS, orderDelaySeconds: 0, orderDelayJitterSeconds: 0 }, physiologyModel: "none", physiologyParams: {}, objectives: [] },
    forces: [
      { side: "blue", faction, units: [squad], placements: all.map((m, i) => ({ personId: m.personId, x: 40 + (i % 4) * 5, y: 90 + Math.floor(i / 4) * 5, heading: 0 })) },
      { side: "red", faction: faction === "de" ? "ru" : "de", units: [foe], placements: fm.map((m, i) => ({ personId: m.personId, x: 1950, y: 90 + i * 5, heading: Math.PI })) },
    ],
  };
  const sim = createSim(input);
  for (const [uid, u] of sim.state.unit.entries()) { sim.state.unit.req(uid).fireRule = "hold"; void u; }
  const blue = [...sim.state.identity.entries()].filter(([, i]) => i.side === "blue").map(([id]) => id);
  const person = (id: EntityId) => sim.state.identity.req(id).personId;
  const gunner = blue.find((id) => person(id) === gunnerId) ?? null;
  const spare = (id: EntityId) => {
    const w = sim.state.weapon.get(id), feed = w ? catalog.weapons[w.weapon]?.feed.magazine : undefined;
    return (sim.state.container.get(id)?.stacks ?? []).filter((s) => s.type === feed && (s.charge ?? 0) > 0).reduce((n, s) => n + s.count, 0);
  };
  const riflemen = blue.filter((id) => id !== gunner && sim.state.weapon.has(id));
  const before = riflemen.map(spare);
  const beltsBefore = gunner !== null ? spare(gunner) : 0;
  const start = ledgerOf(catalog, sim.state);
  const quiet = catalog.behaviour.consolidate?.quietS ?? 60;
  const ev: SimEvent[] = [];
  for (let t = 0; t < (quiet + 60) * TICK_HZ; t++) ev.push(...step(sim));
  const tr = ev.filter((e) => e.kind === "items.transferred" && blue.includes(e.from) && blue.includes(e.to));
  const after = riflemen.map(spare);
  // (The deviation from the mean among men of the same weapon: a marksman's magazines fit nobody else's rifle.)
  const feedOf = (id: EntityId) => catalog.weapons[sim.state.weapon.req(id).weapon]!.feed.magazine;
  const devs = riflemen.map((id, i) => {
    const same = riflemen.map((o, j) => (feedOf(o) === feedOf(id) ? after[j]! : null)).filter((x): x is number => x !== null);
    return Math.abs(after[i]! - same.reduce((a, b) => a + b, 0) / same.length);
  });
  const end = ledgerOf(catalog, sim.state);
  const same = (a: Record<string, number>, b: Record<string, number>) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
  const first = tr[0];
  const gunFeed = gunner !== null ? catalog.weapons[sim.state.weapon.req(gunner).weapon]!.feed.magazine : null;
  return {
    faction, trial, men: blue.length, before, after, maxDev: Math.max(0, ...devs),
    gunnerBelts: gunner !== null ? [beltsBefore, spare(gunner)] : null,
    beltFirst: gunner === null || first === undefined || first.kind !== "items.transferred" ? null : first.to === gunner && first.item === gunFeed,
    handovers: tr.length, firstS: first ? first.tick / TICK_HZ : null, ledgerExact: same(start.ammo, end.ammo) && same(start.items, end.items),
  };
}

export function redistributeLab(data: DataSet, trials = 4): RedistributeRow[] {
  const catalog = buildCatalog(data, ["de", "ru"]);
  const rows: RedistributeRow[] = [];
  for (const [f, t] of [["de", "pzgren-schuetzentrupp"], ["ru", "motor-rifle-squad"]] as const) for (let k = 1; k <= trials; k++) rows.push(oneTrial(data, catalog, f, t, k));
  return rows;
}

export function redistributeLabMarkdown(rows: RedistributeRow[]): string {
  const out = [
    "A squad on open ground, nobody fired on; spare magazines per rifleman set to 0-6, the gunner without a spare belt. Measured 60 s after the quiet began (`consolidate.quietS`). Target: no man more than one magazine from the mean of the men with his weapon (the German marksman's G28 magazines fit nobody else's), belts to the gunner first, ledger unchanged.", "",
    "| squad | trial | men | spare magazines before | after | largest difference from the mean (same weapon) | gunner's spare belts before -> after | first hand-over a belt to him | hand-overs | first at (s) | ledger |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    out.push(`| ${r.faction} | ${r.trial} | ${r.men} | ${r.before.join(" ")} | ${r.after.join(" ")} | ${r.maxDev.toFixed(2)}${r.maxDev <= 1 ? "" : " **miss**"} | ${r.gunnerBelts ? `${r.gunnerBelts[0]} -> ${r.gunnerBelts[1]}` : "-"} | ${r.beltFirst === null ? "-" : r.beltFirst ? "yes" : "**no**"} | ${r.handovers} | ${r.firstS === null ? "-" : r.firstS.toFixed(1)} | ${r.ledgerExact ? "exact" : "**changed**"} |`);
  }
  const met = rows.filter((r) => r.maxDev <= 1 && r.ledgerExact && r.beltFirst !== false).length;
  out.push("", `Met in ${met} of ${rows.length} trials.`);
  return out.join("\n");
}
