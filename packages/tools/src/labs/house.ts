/**
 * HOUSE LAB (M7.5e, plan m7.5e D10), mode `defend`: one squad holds a house. The village-occupy setting (the demo
 * squads on the village; blue by the two-storey house nearest to it, red 300 m off), with two defences on the same
 * seeds:
 *   - "all in": the player's Occupy, every man at a window or inside (M7.5d);
 *   - "mixed": the AI's defence siting around the house (M7.5e: a few men at windows, upper floors where they see
 *     more, the rest outside clear of the walls, one watching the back).
 * Red advances to 60 m short of the house and fires at will; at `heAtS` it calls `heRounds` mortar rounds on the
 * house's middle (ranging first). The table: blue men down, wounds inside / outside, how many a burst could catch
 * (most blue men within 10 m of one of them at `spreadAtS`), mortar bursts on or in the house, red men down.
 */
import type { DataSet } from "@tcs/data";
import { approachPoints, siteDefence } from "@tcs/ai";
import { demoBattle } from "@tcs/scenario";
import { createSim, hypot2, indoorAt, isAble, isOut, step, submitOrder, type Order, type Sim } from "@tcs/sim";

export type HouseDefence = "all in" | "mixed";
export interface HouseDefendRun {
  seed: number; defence: HouseDefence; blueMen: number; blueDown: number; woundsIn: number; woundsOut: number;
  insideAtSpread: number; max10AtSpread: number; heOnHouse: number; heNear: number; redDown: number;
}

const SECONDS = 300, HE_AT_S = 150, HE_ROUNDS = 4, SPREAD_AT_S = 140;

export function houseDefendRun(data: DataSet, seed: number, defence: HouseDefence): HouseDefendRun {
  const input = demoBattle(data, { seed, factions: ["de", "ru"], timeLimitSeconds: SECONDS, mapKind: "village", frontM: 300 });
  input.rules.support = [{ side: "red", he: HE_ROUNDS + 4, smoke: 0 }];
  const centre = (side: string) => {
    const f = input.forces.find((x) => x.side === side)!;
    return { x: f.placements.reduce((a, p) => a + p.x, 0) / f.placements.length, y: f.placements.reduce((a, p) => a + p.y, 0) / f.placements.length };
  };
  const b = centre("blue"), r = centre("red");
  let bi = -1, bd = Infinity, hx = 0, hy = 0;
  input.map.buildings.forEach((bl, i) => {
    if (!bl.interior || bl.storeys < 2) return;
    const n = bl.footprint.length / 2;
    let cx = 0, cy = 0;
    for (let k = 0; k < n; k++) { cx += bl.footprint[k * 2]! / n; cy += bl.footprint[k * 2 + 1]! / n; }
    const d = hypot2(cx - b.x, cy - b.y);
    if (d < bd) { bd = d; bi = i; hx = cx; hy = cy; }
  });
  const house = input.map.buildings[bi]!;
  const sim: Sim = createSim(input);
  const st = sim.state;
  const tops = (side: string) => [...st.unit.entries()].filter(([, u]) => u.side === side && u.parent === null).map(([id]) => id);
  const men = (side: string) => [...st.identity.entries()].filter(([, i]) => i.side === side).map(([id]) => id).sort((x, y) => x - y);
  const dx = r.x - hx, dy = r.y - hy, dl = hypot2(dx, dy) || 1, facing = Math.atan2(dy, dx);
  const orders: Order[] = [];
  for (const id of tops("blue")) orders.push({ tick: 0, issuer: "blue", target: id, kind: "rules", fire: "free" });
  if (defence === "all in") for (const id of tops("blue")) orders.push({ tick: 0, issuer: "blue", target: id, kind: "occupy", building: house.id, facing });
  else {
    const ms = men("blue").map((id) => { const t = st.transform.req(id); return { id, x: t.x, y: t.y }; });
    for (const p of siteDefence(sim.ctx, [{ men: ms, cx: hx, cy: hy }], approachPoints(sim.ctx, hx, hy, facing))) {
      if (p.building !== undefined) orders.push({ tick: 0, issuer: "blue", target: p.id, kind: "occupy", building: p.building, windowIndex: p.windowIndex!, mode: "walk" });
      else if (p.move) orders.push({ tick: 0, issuer: "blue", target: p.id, kind: "move", waypoints: [{ x: p.x, y: p.y, mode: "walk" }], facing: Number.isNaN(p.facing) ? facing : p.facing });
      else orders.push({ tick: 0, issuer: "blue", target: p.id, kind: "posture", posture: "prone" });
    }
  }
  const clamp = (v: number, m: number) => Math.min(Math.max(v, 2), m - 2);
  for (const id of tops("red")) {
    orders.push({ tick: 0, issuer: "red", target: id, kind: "rules", fire: "free" });
    orders.push({ tick: 0, issuer: "red", target: id, kind: "move", waypoints: [{ x: clamp(hx + (dx / dl) * 60, input.map.widthM), y: clamp(hy + (dy / dl) * 60, input.map.heightM), mode: "walk" }] });
  }
  for (const o of orders) submitOrder(sim, o);
  const blue = men("blue"), red = men("red");
  const run: HouseDefendRun = { seed, defence, blueMen: blue.length, blueDown: 0, woundsIn: 0, woundsOut: 0, insideAtSpread: 0, max10AtSpread: 0, heOnHouse: 0, heNear: 0, redDown: 0 };
  const heAmmo = input.catalog.factions["ru"]?.fireSupport?.heAmmo;
  for (let k = 0; k < SECONDS * 60 && !st.ended; k++) {
    if (k === HE_AT_S * 60) submitOrder(sim, { tick: k, issuer: "red", target: tops("red")[0]!, kind: "callFire", x: hx, y: hy, ammo: "he", rounds: HE_ROUNDS });
    if (k === SPREAD_AT_S * 60) {
      const ps = blue.filter((m) => isAble(st.soldier.req(m))).map((m) => st.transform.req(m));
      run.insideAtSpread = ps.filter((t) => indoorAt(sim.ctx, t.x, t.y) >= 0).length;
      for (const t of ps) run.max10AtSpread = Math.max(run.max10AtSpread, ps.filter((o) => hypot2(o.x - t.x, o.y - t.y) <= 10).length);
    }
    for (const e of step(sim)) {
      if (e.kind === "wound" && blue.includes(e.soldier)) { const t = st.transform.req(e.soldier); if (indoorAt(sim.ctx, t.x, t.y) >= 0) run.woundsIn++; else run.woundsOut++; }
      else if (e.kind === "explosion" && e.ammo === heAmmo) { if (indoorAt(sim.ctx, e.x, e.y) === bi) run.heOnHouse++; else if (hypot2(e.x - hx, e.y - hy) <= 30) run.heNear++; }
    }
  }
  run.blueDown = blue.filter((m) => isOut(st.soldier.req(m))).length;
  run.redDown = red.filter((m) => isOut(st.soldier.req(m))).length;
  return run;
}

export function houseDefendLab(data: DataSet, trials = 10): HouseDefendRun[] {
  const rows: HouseDefendRun[] = [];
  for (let seed = 1; seed <= trials; seed++) for (const d of ["all in", "mixed"] as const) rows.push(houseDefendRun(data, seed, d));
  return rows;
}

export function houseDefendMarkdown(rows: readonly HouseDefendRun[]): string {
  const m = (rs: readonly HouseDefendRun[], f: (r: HouseDefendRun) => number) => (rs.reduce((a, r) => a + f(r), 0) / Math.max(1, rs.length)).toFixed(2);
  const out = [
    `Mode defend: one squad holds the two-storey house nearest to it; red closes to 60 m, fires at will and calls ${HE_ROUNDS} mortar rounds on the house at ${HE_AT_S} s; ${SECONDS} s per run.`,
    "",
    "| defence | runs | blue down / men | wounds inside / outside | inside at 140 s | most within 10 m at 140 s | HE in or on the house / within 30 m | red down |",
    "|---|---:|---|---|---:|---:|---|---:|",
  ];
  for (const d of ["all in", "mixed"] as const) {
    const rs = rows.filter((r) => r.defence === d);
    out.push(`| ${d} | ${rs.length} | ${m(rs, (r) => r.blueDown)} / ${m(rs, (r) => r.blueMen)} | ${m(rs, (r) => r.woundsIn)} / ${m(rs, (r) => r.woundsOut)} | ${m(rs, (r) => r.insideAtSpread)} | ${m(rs, (r) => r.max10AtSpread)} | ${m(rs, (r) => r.heOnHouse)} / ${m(rs, (r) => r.heNear)} | ${m(rs, (r) => r.redDown)} |`);
  }
  return out.join("\n");
}
