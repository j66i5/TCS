/**
 * CONTACT LAB (review 2026-11-24 problem 2, contact drill part 1): battles on foot where one side is fired on first
 * (the ambush) or both walk into each other (the meeting), AI against AI by plan, for a set of seeds and maps. Per side:
 * when the first enemy direct round was fired at it (a shot by a man or an on-map hull of the other side), how long
 * until it fired its first direct round back, direct rounds fired (of them at a place: return or area fire with no
 * enemy in sight), men hit (killed and wounded) and whether it was still on the map. Off-map mortar and support
 * rounds are not direct fire and are not counted.
 */
import { planControllers } from "@tcs/ai";
import type { DataSet } from "@tcs/data";
import { buildScenario, type MapKind } from "@tcs/scenario";
import { runBattle, TICK_HZ, type Sim, type SimEvent } from "@tcs/sim";
import { ON_POSTS } from "../scenarios";
import { kindScenario } from "./kinds";

export interface ContactSide {
  /** First enemy direct round (s; -1 none), first own direct round after it (s; -1 none). */
  firstIn: number; firstBack: number;
  /** Direct rounds fired; of them at a place (no enemy in sight: return or area fire). */
  rounds: number; atPlace: number;
  killed: number; wounded: number;
}
export interface ContactRow { kind: string; map: string; seed: number; endReason: string; endS: number; winner: string | null; blue: ContactSide; red: ContactSide }

export function contactBattle(data: DataSet, kind: string, map: MapKind, seed: number, seconds: number): ContactRow {
  const input = buildScenario(data, kindScenario(kind, map, seed, seconds), ON_POSTS);
  const S: Record<"blue" | "red", ContactSide> = {
    blue: { firstIn: -1, firstBack: -1, rounds: 0, atPlace: 0, killed: 0, wounded: 0 },
    red: { firstIn: -1, firstBack: -1, rounds: 0, atPlace: 0, killed: 0, wounded: 0 },
  };
  let pending: SimEvent[] = [];
  const result = runBattle(input, {
    controllers: planControllers(input),
    onEvents: (ev) => { for (const e of ev) if (e.kind === "shot.fired" || e.kind === "grenade.launched") pending.push(e); },
    onTick: (sim: Sim) => {
      const st = sim.state;
      for (const e of pending) {
        let side: string | undefined, shooter: number | undefined;
        if (e.kind === "shot.fired") {
          // (Off-map hulls never fire direct; an on-map hull's gun counts as its side's.)
          side = e.vehicle !== undefined ? st.vehicle.get(e.vehicle)?.side : st.identity.get(e.shooter)?.side;
          if (e.vehicle === undefined) shooter = e.shooter;
        } else if (e.kind === "grenade.launched") side = st.identity.get(e.soldier)?.side;
        if (side !== "blue" && side !== "red") continue;
        const me = S[side], them = S[side === "blue" ? "red" : "blue"];
        const s = Math.round((e.tick / TICK_HZ) * 10) / 10;
        me.rounds++;
        if (shooter !== undefined) { const sup = st.fire.get(shooter)?.suppress; if (sup === "return" || sup === "known" || sup === "area") me.atPlace++; }
        if (them.firstIn < 0) them.firstIn = s;
        if (me.firstIn >= 0 && me.firstBack < 0) me.firstBack = s;
      }
      pending = [];
    },
  });
  for (const side of ["blue", "red"] as const) {
    const r = result.sides.find((x) => x.side === side)!;
    S[side].killed = r.killed; S[side].wounded = r.wounded;
  }
  return { kind, map, seed, endReason: result.endReason, endS: Math.round(result.durationSeconds), winner: result.winner, blue: S.blue, red: S.red };
}

export function contactLab(data: DataSet, o: { kinds: readonly string[]; maps: readonly MapKind[]; seeds: readonly number[]; seconds: number; onRow?: (r: ContactRow) => void }): ContactRow[] {
  const rows: ContactRow[] = [];
  for (const kind of o.kinds) for (const map of o.maps) for (const seed of o.seeds) {
    const r = contactBattle(data, kind, map, seed, o.seconds);
    rows.push(r);
    o.onRow?.(r);
  }
  return rows;
}

const reply = (x: ContactSide) => (x.firstIn < 0 ? "-" : x.firstBack < 0 ? "never" : `${Math.round((x.firstBack - x.firstIn) * 10) / 10}`);

export function contactLine(r: ContactRow): string {
  const side = (n: string, x: ContactSide) => `${n} in ${x.firstIn} back +${reply(x)} rounds ${x.rounds} (${x.atPlace} at a place) hit ${x.killed}k/${x.wounded}w`;
  return `${r.kind} ${r.map} ${r.seed}: ${r.endReason} ${r.endS}s winner ${r.winner ?? "draw"} | ${side("blue", r.blue)} | ${side("red", r.red)}`;
}

export function contactMarkdown(rows: readonly ContactRow[]): string {
  const out = [
    "| kind | map | seed | end | s | winner | blue first in s | blue back after s | blue rounds (at a place) | blue killed/wounded | red first in s | red back after s | red rounds (at a place) | red killed/wounded |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    const c = (x: ContactSide) => `${x.firstIn} | ${reply(x)} | ${x.rounds} (${x.atPlace}) | ${x.killed}/${x.wounded}`;
    out.push(`| ${r.kind} | ${r.map} | ${r.seed} | ${r.endReason} | ${r.endS} | ${r.winner ?? "draw"} | ${c(r.blue)} | ${c(r.red)} |`);
  }
  const never = rows.flatMap((r) => [r.blue, r.red]).filter((x) => x.firstIn >= 0 && x.firstBack < 0).length;
  out.push("", `${rows.length} battles; sides fired on that never fired back: ${never}. "back after": seconds from the first enemy direct round to the side's first direct round (- = never fired on).`);
  return out.join("\n");
}
