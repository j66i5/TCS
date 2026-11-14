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
import { createSim, detonate, EventSink, exposureAt, heightAt, hypot2, indoorAt, indoorSpots, isAble, isOut, navFor, step, submitOrder, type Order, type Sim } from "@tcs/sim";

export type HouseDefence = "all in" | "mixed";
export interface HouseDefendRun {
  seed: number; defence: HouseDefence; blueMen: number; blueDown: number; woundsIn: number; woundsOut: number;
  insideAtSpread: number; max10AtSpread: number; heOnHouse: number; heNear: number; redDown: number;
}

const SECONDS = 300, HE_AT_S = 150, HE_ROUNDS = 4, SPREAD_AT_S = 140;

/** The AI's mixed defence around the house at (hx, hy) for blue's men `ids`, facing `facing`, as orders at tick 0. */
function mixedOrders(sim: Sim, ids: readonly number[], hx: number, hy: number, facing: number): Order[] {
  const orders: Order[] = [];
  const ms = ids.map((id) => { const t = sim.state.transform.req(id); return { id, x: t.x, y: t.y }; });
  for (const p of siteDefence(sim.ctx, [{ men: ms, cx: hx, cy: hy }], approachPoints(sim.ctx, hx, hy, facing))) {
    if (p.building !== undefined) orders.push({ tick: 0, issuer: "blue", target: p.id, kind: "occupy", building: p.building, windowIndex: p.windowIndex!, mode: "walk" });
    else if (p.move) orders.push({ tick: 0, issuer: "blue", target: p.id, kind: "move", waypoints: [{ x: p.x, y: p.y, mode: "walk" }], facing: Number.isNaN(p.facing) ? facing : p.facing });
    else orders.push({ tick: 0, issuer: "blue", target: p.id, kind: "posture", posture: "prone" });
  }
  return orders;
}

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
  else orders.push(...mixedOrders(sim, men("blue"), hx, hy, facing));
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

/**
 * HOUSE LAB, mode `leave` (M7.5e step "leave", plan m7.5e D10): the same house and squad, the men put in by the
 * player's Occupy facing red ("flank": the AI's mixed defence, its window men facing red; red 300 m off, both sides
 * holding fire), then at `LEAVE_AT_S` one trigger:
 *   - "trap": two red hand grenades burst in two rooms of the house 2 s apart, then four mortar bombs on it 20, 25, 30
 *     and 35 s later (direct bursts under its roof, in the top storey: a bomb through the roof);
 *   - "enemy": a red man is put in a ground-floor room of the house (holding fire);
 *   - "flank": two red men are put in the open 70-90 m behind the house and walk up to 40 m from it; red opens fire
 *     and the rest of it walks 60 m closer in front (counted from when blue knows of both).
 * Each trigger with the rule on and off (`soldier.houseLeave`). The table: men inside at the trigger, the share out
 * (or fighting in their room, "enemy") within 20 s (15 s for "enemy") of the trigger (the second grenade for a trap;
 * for "enemy" and "flank" when a man inside first knows of the red men: runs where none does are left out),
 * the share of leavers whose spot is in cover (exposure < 0.9) and within 60 degrees of straight away from the threat
 * (red's middle for a trap, the men behind for a flank), blue men down at the end.
 */
export type HouseTrigger = "trap" | "enemy" | "flank";
export interface HouseLeaveRun {
  seed: number; trigger: HouseTrigger; leave: boolean; inside: number; outInTime: number; fighting: number; seenInside: boolean;
  covered: number; awayOk: number; leavers: number; blueDown: number; reasons: string[];
  /** When the trigger counted from (s; -1: never) and the first man got out (s; -1: none). */
  triggerS: number; firstOutS: number;
}

const LEAVE_AT_S = 90, LEAVE_SECONDS = 180;
/** A trap's mortar bombs on the house, s after the second grenade. */
const TRAP_HE_S = [20, 25, 30, 35];

/** A small deterministic generator for the lab's own choices (not the sim's streams). */
function labRng(seed: number): () => number {
  let a = (seed * 2654435761) >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function houseLeaveRun(data: DataSet, seed: number, trigger: HouseTrigger, leave: boolean): HouseLeaveRun {
  const input = demoBattle(data, { seed, factions: ["de", "ru"], timeLimitSeconds: LEAVE_SECONDS + 10, mapKind: "village", frontM: 300 });
  input.catalog = { ...input.catalog, behaviour: { ...input.catalog.behaviour, soldier: { ...input.catalog.behaviour.soldier, houseLeave: leave } } };
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
  const st = sim.state, ctx = sim.ctx;
  const tops = (side: string) => [...st.unit.entries()].filter(([, u]) => u.side === side && u.parent === null).map(([id]) => id);
  const men = (side: string) => [...st.identity.entries()].filter(([, i]) => i.side === side).map(([id]) => id).sort((x, y) => x - y);
  const facing = Math.atan2(r.y - hy, r.x - hx);
  for (const side of ["blue", "red"]) for (const id of tops(side)) submitOrder(sim, { tick: 0, issuer: side, target: id, kind: "rules", fire: "hold" });
  // (Cut off from behind: the AI's mixed defence, its window men facing red; the other triggers: the player's Occupy.)
  if (trigger === "flank") for (const o of mixedOrders(sim, men("blue"), hx, hy, facing)) submitOrder(sim, o);
  else for (const id of tops("blue")) submitOrder(sim, { tick: 0, issuer: "blue", target: id, kind: "occupy", building: house.id, facing });
  const blue = men("blue"), red = men("red");
  const rnd = labRng(seed * 7 + (trigger === "trap" ? 1 : trigger === "enemy" ? 2 : 3));
  const run: HouseLeaveRun = { seed, trigger, leave, inside: 0, outInTime: 0, fighting: 0, seenInside: trigger === "trap", covered: 0, awayOk: 0, leavers: 0, blueDown: 0, reasons: [], triggerS: -1, firstOutS: -1 };
  // (Each man's own house at the trigger: the mixed defence may hold a neighbouring one.)
  const home = new Map<number, number>();
  const isIn = (id: number) => { const t = st.transform.req(id); const h = indoorAt(ctx, t.x, t.y); return home.has(id) ? h === home.get(id) : h >= 0; };
  let atIn: number[] = [], t0 = -1, threat: { x: number; y: number } | null = null;
  const outTick = new Map<number, number>();
  const sink = new EventSink();
  const grenade = input.catalog.ammoIds.indexOf("ru-rgd5"), he = input.catalog.ammoIds.indexOf(input.catalog.factions["ru"]?.fireSupport?.heAmmo ?? "ru-82-he");
  const indoorPoint = () => {
    const spots = indoorSpots(ctx, bi, hx, hy, 12, 0);
    const p = spots[Math.floor(rnd() * spots.length)] ?? { x: hx, y: hy, z: 0 };
    return p;
  };
  const roofPoint = () => {
    const xs = house.footprint.filter((_, i) => i % 2 === 0), ys = house.footprint.filter((_, i) => i % 2 === 1);
    for (let k = 0; k < 20; k++) {
      const x = Math.min(...xs) + rnd() * (Math.max(...xs) - Math.min(...xs)), y = Math.min(...ys) + rnd() * (Math.max(...ys) - Math.min(...ys));
      if (indoorAt(ctx, x, y) === bi) return { x, y };
    }
    return { x: hx, y: hy };
  };
  const T = LEAVE_AT_S * 60;
  for (let k = 0; k < LEAVE_SECONDS * 60 && !st.ended; k++) {
    if (k === T) {
      atIn = blue.filter((m) => isAble(st.soldier.req(m)) && isIn(m));
      for (const m of atIn) { const t = st.transform.req(m); home.set(m, indoorAt(ctx, t.x, t.y)); }
      if (trigger === "trap") {
        const p = indoorPoint();
        detonate(ctx, st, sink, p.x, p.y, heightAt(ctx.map, p.x, p.y) + p.z + 0.05, grenade, red[0]!);
        threat = r;
      } else if (trigger === "enemy") {
        const p = indoorPoint(), t = st.transform.req(red[0]!);
        t.x = p.x; t.y = p.y; t.z = p.z;
        t0 = -1;
      } else {
        const back = facing + Math.PI;
        for (const [j, m] of red.slice(0, 2).entries()) {
          const d = 70 + rnd() * 20, a = back + (j === 0 ? -0.3 : 0.3) * rnd();
          const t = st.transform.req(m);
          t.x = Math.min(Math.max(hx + Math.cos(a) * d, 5), input.map.widthM - 5); t.y = Math.min(Math.max(hy + Math.sin(a) * d, 5), input.map.heightM - 5); t.z = 0;
        }
        threat = { x: hx + Math.cos(back) * 80, y: hy + Math.sin(back) * 80 };
        // (Red opens fire, in front and behind: blue sees or hears where they are.)
        for (const id of tops("red")) submitOrder(sim, { tick: k, issuer: "red", target: id, kind: "rules", fire: "free" });
        // (The two behind walk up to 40 m from it: blue may see them on the way.)
        for (const [j, m] of red.slice(0, 2).entries()) {
          const a = back + (j === 0 ? -0.25 : 0.25);
          submitOrder(sim, { tick: k, issuer: "red", target: m, kind: "move", waypoints: [{ x: Math.min(Math.max(hx + Math.cos(a) * 40, 5), input.map.widthM - 5), y: Math.min(Math.max(hy + Math.sin(a) * 40, 5), input.map.heightM - 5), mode: "walk" }] });
        }
        // (The rest walk 60 m closer in front: blue sees where its front is.)
        for (const m of red.slice(2)) {
          const t = st.transform.req(m), dl = hypot2(t.x - hx, t.y - hy) || 1;
          submitOrder(sim, { tick: k, issuer: "red", target: m, kind: "move", waypoints: [{ x: t.x + ((hx - t.x) / dl) * 60, y: t.y + ((hy - t.y) / dl) * 60, mode: "walk" }] });
        }
        t0 = -1;
      }
    }
    if (trigger === "trap" && k === T + 120) {
      const p = indoorPoint();
      detonate(ctx, st, sink, p.x, p.y, heightAt(ctx.map, p.x, p.y) + p.z + 0.05, grenade, red[0]!);
      t0 = k;
    }
    if (trigger === "trap" && TRAP_HE_S.some((s) => k === T + 120 + s * 60)) {
      // (A bomb through the roof bursts in the top storey.)
      const p = roofPoint();
      detonate(ctx, st, sink, p.x, p.y, heightAt(ctx.map, p.x, p.y) + (house.storeys - 1) * house.storeyHeightM + 1.2, he, red[0]!);
    }
    // (The trigger counts from when a man inside knows of it: the red man inside seen, a man behind seen or heard.)
    if (trigger !== "trap" && k > T && t0 < 0) {
      const watch = trigger === "enemy" ? red.slice(0, 1) : red.slice(0, 2);
      const knows = (m: number) => st.soldier.req(m).contacts.some((c) => watch.includes(c.target) && (trigger === "flank" || c.kind === "seen") && st.tick - c.tick < 300 && (trigger === "enemy" || hypot2(c.x - hx, c.y - hy) <= 150));
      // (Cut off: a man behind known, and a red man in front remembered by the unit.)
      const front = trigger === "enemy" || blue.some((m) => st.soldier.req(m).contacts.some((c) => red.slice(2).includes(c.target)));
      if (front && atIn.some(knows)) { t0 = k; run.seenInside = true; }
    }
    for (const e of [...step(sim), ...sink.events.splice(0)]) {
      if (e.kind === "radio" && e.side === "blue" && e.key.startsWith("radio.houseLeft")) run.reasons.push(e.key.slice("radio.houseLeft".length).toLowerCase());
    }
    if (k > T) for (const m of atIn) if (!outTick.has(m) && !isIn(m) && isAble(st.soldier.req(m))) outTick.set(m, k);
  }
  const limit = (trigger === "enemy" ? 15 : 20) * 60;
  run.triggerS = t0 >= 0 ? t0 / 60 : -1;
  run.firstOutS = outTick.size > 0 ? Math.min(...outTick.values()) / 60 : -1;
  const { grid } = navFor(ctx, "foot");
  if (t0 >= 0) {
    run.inside = atIn.length;
    for (const m of atIn) {
      const ot = outTick.get(m);
      if (ot !== undefined && ot - t0 <= limit) run.outInTime++;
      else if (trigger === "enemy" && isAble(st.soldier.req(m))) {
        const t = st.transform.req(m), e = st.transform.req(red[0]!);
        if (hypot2(t.x - e.x, t.y - e.y) <= 4 && Math.abs(t.z - e.z) < 1) { run.fighting++; run.outInTime++; }
      }
      if (ot === undefined) continue;
      run.leavers++;
      const t = st.transform.req(m);
      if (exposureAt(grid, t.x, t.y) < 0.9) run.covered++;
      if (threat) {
        const fp = input.map.buildings[home.get(m) ?? bi]!.footprint, n = fp.length / 2;
        let ox = 0, oy = 0;
        for (let q = 0; q < n; q++) { ox += fp[q * 2]! / n; oy += fp[q * 2 + 1]! / n; }
        const ax = ox - threat.x, ay = oy - threat.y, gx = t.x - ox, gy = t.y - oy;
        if ((ax * gx + ay * gy) / ((hypot2(ax, ay) || 1) * (hypot2(gx, gy) || 1)) >= Math.cos(Math.PI / 3)) run.awayOk++;
      } else run.awayOk++;
    }
  } else run.inside = atIn.length;
  run.blueDown = blue.filter((m) => isOut(st.soldier.req(m))).length;
  return run;
}

export function houseLeaveLab(data: DataSet, trials = 20): HouseLeaveRun[] {
  const rows: HouseLeaveRun[] = [];
  for (const trigger of ["trap", "enemy", "flank"] as const) for (let seed = 1; seed <= trials; seed++) for (const leave of [true, false]) rows.push(houseLeaveRun(data, seed, trigger, leave));
  return rows;
}

export function houseLeaveMarkdown(rows: readonly HouseLeaveRun[]): string {
  const sum = (rs: readonly HouseLeaveRun[], f: (r: HouseLeaveRun) => number) => rs.reduce((a, r) => a + f(r), 0);
  const pct = (a: number, b: number) => (b > 0 ? `${Math.round((100 * a) / b)} %` : "–");
  const out = [
    `Mode leave: the squad occupies the two-storey house nearest to it (player's Occupy facing red 300 m off; flank: the AI's mixed defence; both sides holding fire); at ${LEAVE_AT_S} s one trigger; ${LEAVE_SECONDS} s per run. trap: 2 grenades inside 2 s apart, then 4 mortar bombs through the roof 20-35 s later; enemy: a red man put in a ground-floor room; flank: 2 red men put 70-90 m behind the house walk up to 40 m from it, red opening fire and its rest walking 60 m closer in front (counted from when blue knows of both).`,
    "",
    "| trigger | rule | runs | men inside | out in time (enemy: or fighting in his room) | in cover | within 60 deg of away | blue down / run | leave calls (reason) |",
    "|---|---|---:|---:|---|---|---|---:|---|",
  ];
  for (const trigger of ["trap", "enemy", "flank"] as const) for (const leave of [true, false]) {
    const rs = rows.filter((r) => r.trigger === trigger && r.leave === leave && r.seenInside);
    const lv = sum(rs, (r) => r.leavers);
    const reasons = new Map<string, number>();
    for (const r of rs) for (const k of r.reasons) reasons.set(k, (reasons.get(k) ?? 0) + 1);
    out.push(`| ${trigger} | ${leave ? "on" : "off"} | ${rs.length} | ${sum(rs, (r) => r.inside)} | ${pct(sum(rs, (r) => r.outInTime), sum(rs, (r) => r.inside))}${trigger === "enemy" ? ` (${sum(rs, (r) => r.fighting)} fighting)` : ""} | ${pct(sum(rs, (r) => r.covered), lv)} | ${pct(sum(rs, (r) => r.awayOk), lv)} | ${(sum(rs, (r) => r.blueDown) / Math.max(1, rs.length)).toFixed(2)} | ${[...reasons.entries()].map(([k, n]) => `${k} ${n}`).join(", ") || "–"} |`);
  }
  const unseen = rows.filter((r) => !r.seenInside).length;
  if (unseen > 0) out.push("", `(${unseen} "enemy" / "flank" runs left out: no man inside knew of the red men within the run.)`);
  return out.join("\n");
}
