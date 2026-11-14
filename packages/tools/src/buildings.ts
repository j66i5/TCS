/**
 * BUILDINGS TALLY (M7.5e, plan m7.5e D10): how a battle's men use the houses, from the outside (events and the
 * state as tools may read it): man-seconds indoors and upstairs per side (sampled once a second, able men on
 * foot), wounds and casualties of men indoors and outdoors, grenades aimed at a point in a house, explosions in or
 * on houses (mortar high explosive apart), and the defence's spread at `spreadAtS` (men within 10 m / 5 m of each
 * defender, men per house and per room, units with men inside and how many of theirs are outside).
 */
import { floorAtZ, hypot2, indoorAt, isAble, roomAt, type BattleInput, type SimEvent, type Sim } from "@tcs/sim";

export interface SideBuildings {
  manS: number; manSIn: number; manSUp: number; everIn: number;
  woundsIn: number; woundsOut: number; downIn: number; downOut: number;
  grenades: number; grenadesAtHouse: number; blastsInHouse: number;
}
export interface Spread {
  men: number; inside: number; upper: number; max10: number; mean10: number; max5: number;
  houses: number; houseMax: number; roomMax: number; unitsIn: number; unitsInTwoOut: number;
}
export interface BuildingsTally { sides: Record<string, SideBuildings>; mortarHeOnHouse: number; mortarHeElsewhere: number; spread: Spread | null }

const empty = (): SideBuildings => ({ manS: 0, manSIn: 0, manSUp: 0, everIn: 0, woundsIn: 0, woundsOut: 0, downIn: 0, downOut: 0, grenades: 0, grenadesAtHouse: 0, blastsInHouse: 0 });

/** A tally and its two hooks for `runBattle` (call `onTick` and `onEvents` from the batch's own hooks). */
export function buildingsTally(input: BattleInput, spreadAtS = 239): { tally: BuildingsTally; onTick: (sim: Sim) => void; onEvents: (ev: readonly SimEvent[]) => void } {
  const tally: BuildingsTally = { sides: { blue: empty(), red: empty() }, mortarHeOnHouse: 0, mortarHeElsewhere: 0, spread: null };
  const defender = input.rules.objectives[0]?.holder ?? "blue";
  const mortarHe = new Set(Object.values(input.catalog.factions).map((f) => f.fireSupport?.heAmmo).filter((x): x is string => x !== undefined));
  const everIn = new Set<number>();
  let sim: Sim | null = null;
  const sideOf = (id: number) => tally.sides[sim?.state.identity.get(id)?.side ?? ""];
  const indoors = (id: number) => { const t = sim?.state.transform.get(id); return t !== undefined && indoorAt(sim!.ctx, t.x, t.y) >= 0; };
  return {
    tally,
    onTick: (s) => {
      sim = s;
      const st = s.state;
      if (st.tick % 60 !== 0) return;
      const spreadNow = st.tick === spreadAtS * 60;
      const men: { x: number; y: number; bi: number; floor: number; room: number; unit: number }[] = [];
      for (const [id, so] of st.soldier.entries()) {
        if (!isAble(so) || so.mount !== undefined) continue;
        const t = st.transform.get(id), idn = st.identity.get(id), side = tally.sides[idn?.side ?? ""];
        if (!t || !side) continue;
        const bi = indoorAt(s.ctx, t.x, t.y);
        side.manS++;
        if (bi >= 0) { side.manSIn++; if (!everIn.has(id)) { everIn.add(id); side.everIn++; } if (t.z > 1) side.manSUp++; }
        if (spreadNow && idn!.side === defender) {
          const b = bi >= 0 ? s.ctx.map.buildings[bi]! : null, floor = b ? floorAtZ(b, t.z) : 0;
          men.push({ x: t.x, y: t.y, bi, floor, room: b ? roomAt(b, floor, t.x, t.y) : -1, unit: idn!.unit });
        }
      }
      if (!spreadNow) return;
      let max10 = 0, sum10 = 0, max5 = 0;
      for (const m of men) {
        let n10 = 0, n5 = 0;
        for (const o of men) { const d = hypot2(o.x - m.x, o.y - m.y); if (d <= 10) n10++; if (d <= 5) n5++; }
        max10 = Math.max(max10, n10); max5 = Math.max(max5, n5); sum10 += n10;
      }
      const houses = new Map<number, number>(), rooms = new Map<string, number>(), units = new Map<number, [number, number]>();
      for (const m of men) {
        const u = units.get(m.unit) ?? [0, 0];
        u[m.bi >= 0 ? 0 : 1]++;
        units.set(m.unit, u);
        if (m.bi < 0) continue;
        houses.set(m.bi, (houses.get(m.bi) ?? 0) + 1);
        const k = `${m.bi}:${m.floor}:${m.room}`;
        rooms.set(k, (rooms.get(k) ?? 0) + 1);
      }
      const uin = [...units.values()].filter((u) => u[0] > 0);
      tally.spread = {
        men: men.length, inside: men.filter((m) => m.bi >= 0).length, upper: men.filter((m) => m.floor > 0).length,
        max10, mean10: sum10 / Math.max(1, men.length), max5, houses: houses.size, houseMax: Math.max(0, ...houses.values()),
        roomMax: Math.max(0, ...rooms.values()), unitsIn: uin.length, unitsInTwoOut: uin.filter((u) => u[1] >= 2).length,
      };
    },
    onEvents: (ev) => {
      if (!sim) return;
      for (const e of ev) {
        if (e.kind === "wound") { const sd = sideOf(e.soldier); if (sd) { if (indoors(e.soldier)) sd.woundsIn++; else sd.woundsOut++; } }
        else if (e.kind === "casualty") { const sd = sideOf(e.soldier); if (sd) { if (indoors(e.soldier)) sd.downIn++; else sd.downOut++; } }
        else if (e.kind === "grenade.launched") { const sd = sideOf(e.soldier); if (sd) { sd.grenades++; if (indoorAt(sim.ctx, e.x, e.y) >= 0) sd.grenadesAtHouse++; } }
        else if (e.kind === "explosion") {
          const inHouse = indoorAt(sim.ctx, e.x, e.y) >= 0;
          if (mortarHe.has(e.ammo)) { if (inHouse) tally.mortarHeOnHouse++; else tally.mortarHeElsewhere++; }
          else if (inHouse) { const sd = sideOf(e.owner); if (sd) sd.blastsInHouse++; }
        }
      }
    },
  };
}

/** The batch report's buildings lines (means over the runs; the defender holds the first objective). */
export function buildingsMarkdown(tallies: readonly BuildingsTally[], defender: string): string[] {
  const n = Math.max(1, tallies.length);
  const sum = (f: (t: BuildingsTally) => number) => tallies.reduce((a, t) => a + f(t), 0);
  const pct = (a: number, b: number) => `${b > 0 ? ((100 * a) / b).toFixed(1) : "0.0"} %`;
  const lines: string[] = [];
  for (const side of ["blue", "red"]) {
    const g = (k: keyof SideBuildings) => sum((t) => t.sides[side]?.[k] ?? 0);
    const msIn = g("manSIn"), msOut = g("manS") - msIn;
    const rate = (w: number, ms: number) => (ms > 0 ? ((100 * w) / (ms / 60)).toFixed(1) : "-");
    lines.push(`- Buildings, ${side}${side === defender ? " (defends)" : ""}: indoors ${pct(msIn, g("manS"))} of man-seconds, upstairs ${pct(g("manSUp"), g("manS"))}; men ever inside ${(g("everIn") / n).toFixed(1)}; wounds per 100 man-minutes inside ${rate(g("woundsIn"), msIn)} / outside ${rate(g("woundsOut"), msOut)}; down inside ${(g("downIn") / n).toFixed(2)} / outside ${(g("downOut") / n).toFixed(2)}; grenades ${(g("grenades") / n).toFixed(1)} (at a house ${(g("grenadesAtHouse") / n).toFixed(2)}), own bursts in or on houses ${(g("blastsInHouse") / n).toFixed(2)}`);
  }
  const sp = tallies.map((t) => t.spread).filter((s): s is Spread => s !== null);
  lines.push(`- Mortar HE per battle: on houses ${(sum((t) => t.mortarHeOnHouse) / n).toFixed(2)}, elsewhere ${(sum((t) => t.mortarHeElsewhere) / n).toFixed(1)}`);
  if (sp.length > 0) {
    const m = (f: (s: Spread) => number) => (sp.reduce((a, s) => a + f(s), 0) / sp.length);
    lines.push(`- Defence spread at 239 s (${sp.length} runs): inside ${m((s) => s.inside).toFixed(1)} of ${m((s) => s.men).toFixed(1)} (upstairs ${m((s) => s.upper).toFixed(1)}); men within 10 m of a defender max ${m((s) => s.max10).toFixed(1)} (worst ${Math.max(...sp.map((s) => s.max10))}), mean ${m((s) => s.mean10).toFixed(2)}; within 5 m max ${m((s) => s.max5).toFixed(1)}; most in a house ${Math.max(...sp.map((s) => s.houseMax))}, in a room ${Math.max(...sp.map((s) => s.roomMax))}; units with men inside ${sp.reduce((a, s) => a + s.unitsIn, 0)}, of them with 2+ outside ${sp.reduce((a, s) => a + s.unitsInTwoOut, 0)}`);
  }
  return lines;
}
