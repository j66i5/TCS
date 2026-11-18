/**
 * SCENARIO FORMAT AND GENERATOR (M6, owner decisions 2026-11-12): platoon against platoon, one side attacks,
 * the other defends; points for the objectives held at the end minus a share for men down; a side that breaks
 * or is wiped out loses at once.
 *
 * A scenario is plain data (`ScenarioDef`, JSON-safe): what kind of battle, the seed, the map kind, the faction
 * of each side and which side attacks. `buildScenario` turns it into a BattleInput deterministically (the same
 * definition always gives the same battle). Blue always starts in the west, red in the east; either may attack.
 */
import { buildCatalog, type DataSet } from "@tcs/data";
import {
  atan2, buildBallistics, buildMapIndex, buildNavGrid, heightAt, hypot2, nearestPassable, newVehicleRecord, PI, sight, TICK_HZ,
  type BattleInput, type Catalog, type ForceInput, type MapDef, type NavGrid, type ObjectiveDef, type Placement, type SimContext, type UnitInput, type VehicleRecord,
} from "@tcs/sim";
import { defaultRules, freeSpot, SIDES } from "./demo";
import { allMembers, buildForceWithVehicles, withoutVehicles, type ForceVehicle } from "./forces";
import { generateMap, type MapKind } from "./mapgen/index";
import { addMpAssets, addRecoveryAssets, addSupplyAssets, platoonTemplateOf, type CarrierClass } from "./vehicles";

export interface ScenarioDef {
  kind: "platoon-attack";
  seed: number;
  mapKind: MapKind;
  /** Faction of blue (west) and red (east). */
  factions: [string, string];
  /** Which side attacks: the other holds the objectives at the start. */
  attacker: "blue" | "red";
  /** Platoons on the attacking side (owner, M6 review: two against one); the defender always has one. */
  attackerPlatoons?: number;
  /** Unit template per side (defaults: the faction manifest's platoon template for `carriers`, else its demo
   *  template). */
  templates?: [string, string];
  /** M7.6c: the class of carriers each side's platoon rides in (one for both sides, or blue, red): the manifest's
   *  `platoonTemplates[class]`, falling back to `platoonTemplate` (default: that, the tracked platoon). */
  carriers?: CarrierClass | [CarrierClass, CarrierClass];
  timeLimitSeconds?: number;
  mapWidthM?: number;
  mapHeightM?: number;
  /** With vehicles (M7.2; owner Q26: opt-in until M7.4a): the platoons' crews and vehicles take part; the attacker
   *  starts mounted at its map edge, the defender's vehicles stand behind its main objective with only their
   *  crews aboard. Off: the same platoons on foot, without their crews (as before M7.2). */
  vehicles?: boolean;
  /** With vehicles: the attacker's hulls start in dead ground, out of the defenders' sight (owner 2026-11-13;
   *  default true). False: the old line across the attacker's map edge (for comparisons). */
  deadGroundStart?: boolean;
  /** On-map mortars (M8.3a): each side gets its faction's mortar section (manifest `mortarTemplate`) behind its own
   *  line instead of the off-map allotment (a side whose faction has none keeps the allotment). */
  mortars?: boolean;
  /** Dismounted missile teams (M9.3b; owner: a Metis-M team at company level attached to the platoon battle): each
   *  side whose faction has a `missileTeamTemplate` gets one team as a unit of its own (not part of a platoon): the
   *  defender's 300 m behind its main objective, the attacker's 150 m behind its start on a flank. */
  missileTeams?: boolean;
  /** M7.6d: automatic grenade launcher teams: each side named (true: both) whose faction has an `aglTeamTemplate`
   *  gets one team as a unit of its own, placed as the missile team but on the other flank (the defender's 250 m
   *  behind its main objective, 60 m aside). */
  aglTeams?: boolean | "attacker" | "defender";
  /** M7.6d: this side's platoon is its faction's assault group (manifest `assaultGroupTemplate`; on foot) unless
   *  `templates` names one. */
  assaultGroup?: "blue" | "red";
  /** Off-map artillery (M8.4): each side whose faction has an `artillery` battery also gets its allotment
   *  (`SCENARIO_ARTILLERY`). The AI commander does not call it yet (M8.5). */
  artillery?: boolean;
  /** M9.5: sides with an off-map fixed-wing reconnaissance drone overhead (it locates targets and watches falls). */
  airRecon?: string[];
  /** Tanks (M7.6b): each side named (true: both) whose faction has a `tankSectionTemplate` gets its tank section as
   *  a unit of its own (not part of a platoon): the attacker's in dead ground behind its carriers' start, the
   *  defender's 150-210 m behind its main objective. With or without `vehicles`. */
  tanks?: boolean | "attacker" | "defender";
  /** Tank section template per side (blue, red), instead of the faction manifest's (null: the manifest's). */
  tankTemplates?: [string | null, string | null];
  /** M10.6a: each side gets its faction's ambulances off the map (manifest `ambulance`), called to its platoons'
   *  Verwundetennester. Default true; false: none (comparisons). */
  ambulances?: boolean;
  /** M11.7b: each side with vehicles of its own gets its faction's recovery vehicles off the map (manifest
   *  `recovery`), called to tow disabled hulls. Default true; false: none (comparisons, `--no-recovery`). */
  recovery?: boolean;
  /** M11.9b: each side gets its faction's military police team off the map (manifest `mp`), called to its platoons'
   *  prisoner collection points. Default true; false: none (comparisons, `--no-mp`). */
  mp?: boolean;
  /** M11.1 (hold-resupply): the main objective at the building nearest the map's centre (the village centre). */
  hold?: boolean;
  /** Balance pass after M11: the defender's men dig in where they are sited in the first minutes (fighting positions,
   *  `rules.prepared` over `SCENARIO_PREPARED_S`), as in the hold battle. Default true; false: in the open (comparisons). */
  prepared?: boolean;
  /** Balance pass 2: how deep the defender's holes are (default SCENARIO_HASTY_DEPTH_M; null: the data's
   *  `fightingPosition.depthM`, as the hold battle). */
  preparedDepthM?: number | null;
}

/** Balance pass after M11: the window (s) in which the platoon battle's defenders dig in where they halt (the hold
 *  battle's, after the commander's siting walk; game values). */
export const SCENARIO_PREPARED_S = [60, 90] as const;

/** Balance pass 2 (range rule on): the platoon battle's defence digs hasty holes at most this deep (game value; the
 *  hold battle keeps the data's `fightingPosition.depthM`, 1.2 m). A prone man's rim (0.3 m) is the same in both. */
export const SCENARIO_HASTY_DEPTH_M = 0.6;

/** Artillery rounds each side may call with `artillery` (M8.4; game values). */
export const SCENARIO_ARTILLERY = { he: 12, smoke: 4, illum: 4 } as const;

/** Mortar rounds each side may call (game values; M9.6: illumination rounds for the night, game values, low). */
export const SCENARIO_SUPPORT = { attackerHe: 24, attackerSmoke: 12, defenderHe: 12, defenderSmoke: 4, attackerIllum: 4, defenderIllum: 4 } as const;

/** Points of the main and the second objective, and what each man down costs his side. */
export const SCENARIO_POINTS = { main: 100, second: 50, perManDown: 5, vehicleLost: 20, vehicleImmobilised: 10 } as const;

function centroid(c: number[]): { x: number; y: number } {
  let x = 0, y = 0;
  const n = c.length / 2;
  for (let i = 0; i < c.length; i += 2) { x += c[i]!; y += c[i + 1]!; }
  return { x: x / n, y: y / n };
}

/** The building nearest to a point within `maxM` (its centre), else the point itself. */
function nearBuilding(map: MapDef, x: number, y: number, maxM: number, not: { x: number; y: number }[] = []): { x: number; y: number } {
  let best: { x: number; y: number } | null = null, bestD = maxM;
  for (const b of map.buildings) {
    const c = centroid(b.footprint);
    if (not.some((p) => hypot2(p.x - c.x, p.y - c.y) < 80)) continue;
    const d = hypot2(c.x - x, c.y - y);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best ?? { x, y };
}

export function buildScenario(data: DataSet, def: ScenarioDef): BattleInput {
  const catalog = buildCatalog(data, [...def.factions]);
  const W = def.mapWidthM ?? 1200, H = def.mapHeightM ?? 900;
  const map = generateMap(catalog.terrain, { kind: def.mapKind, seed: def.seed, widthM: W, heightM: H });
  const defender = def.attacker === "blue" ? "red" : "blue";
  // Objectives on the defender's side of the map: the main one at a building near its middle, the second at
  // another building (or the ground) on a flank.
  const dx = defender === "red" ? 1 : -1;
  const mainP = def.hold === true ? nearBuilding(map, W / 2, H / 2, 250) : nearBuilding(map, W / 2 + dx * W * 0.2, H / 2, 250);
  let secondP = nearBuilding(map, W / 2 + dx * W * 0.1, H / 2 + (def.seed % 2 === 0 ? 1 : -1) * H * 0.2, 200, [mainP]);
  // The two areas never overlap (their radii are 40 and 30 m): at least 90 m apart.
  if (hypot2(secondP.x - mainP.x, secondP.y - mainP.y) < 90) secondP = { x: mainP.x, y: Math.min(Math.max(mainP.y + (mainP.y < H / 2 ? 1 : -1) * 120, 20), H - 20) };
  const objectives: ObjectiveDef[] = [
    { id: "main", nameKey: "objective.main", x: mainP.x, y: mainP.y, radiusM: 40, points: SCENARIO_POINTS.main, holder: defender },
    { id: "second", nameKey: "objective.second", x: secondP.x, y: secondP.y, radiusM: 30, points: SCENARIO_POINTS.second, holder: defender },
  ];
  // The defender is built first: the attacker's start (dead ground) depends on where the defenders stand.
  let observers: { x: number; y: number; z: number; thermal?: boolean }[] = [];
  const buildSide = (side: "blue" | "red", s: number): ForceInput => {
    const faction = def.factions[s]!;
    const pack = data.factions[faction];
    const carriers = Array.isArray(def.carriers) ? def.carriers[s] : def.carriers;
    const assault = def.assaultGroup === side ? pack?.manifest.assaultGroupTemplate : undefined;
    const template = def.templates?.[s] ?? assault ?? platoonTemplateOf(data, faction, carriers) ?? pack?.manifest.demoTemplate ?? "demo-team";
    const count = side === def.attacker ? Math.max(1, def.attackerPlatoons ?? 2) : 1;
    const built = Array.from({ length: count }, (_, k) => buildForceWithVehicles(data, { faction, template, seed: def.seed * 31 + s * 7 + k * 101, keyPrefix: `${side}-${k + 1}`, number: k + 1 }));
    const withVehicles = def.vehicles === true && built.some((b) => b.vehicles.length > 0);
    const units = built.map((b) => (withVehicles ? b.unit : withoutVehicles(b.unit)));
    const placements: Placement[] = [];
    const heading = side === "blue" ? 0 : PI; // facing the other side
    const attacking = side === def.attacker;
    const fv = withVehicles ? placeVehicles(catalog, map, built.flatMap((b) => b.vehicles), attacking, side, mainP, dx, W, H, attacking && def.deadGroundStart !== false ? { observers, objectives: [mainP, secondP] } : null) : null;
    if (fv) placements.push(...fv.placements);
    // Tanks (M7.6b): the side's tank section, a unit of its own, its crews in their seats.
    const tankWanted = def.tanks === true || def.tanks === (attacking ? "attacker" : "defender");
    const tt = tankWanted ? (def.tankTemplates?.[s] ?? pack?.manifest.tankSectionTemplate) : undefined;
    let tv: ReturnType<typeof placeVehicles> | null = null;
    if (tt) {
      const sec = buildForceWithVehicles(data, { faction, template: tt, seed: def.seed * 47 + s * 19, keyPrefix: `${side}-t`, number: 1 });
      units.push(sec.unit);
      const ifvs = fv?.vehiclePlacements ?? [];
      let home: { x: number; y: number } | null = null, behind: { x: number; y: number }[] = [];
      if (attacking && ifvs.length > 0) {
        // Behind the carriers' group, away from the main objective: 60 m for the dead-ground search, 40 m as the
        // fallback line.
        let cx = 0, cy = 0;
        for (const p of ifvs) { cx += p.x; cy += p.y; }
        cx /= ifvs.length; cy /= ifvs.length;
        const L = Math.max(1, hypot2(mainP.x - cx, mainP.y - cy)), ux = (mainP.x - cx) / L, uy = (mainP.y - cy) / L;
        home = { x: cx - ux * 60, y: cy - uy * 60 };
        behind = sec.vehicles.map((_, i) => ({ x: cx - ux * 40 - uy * (i - (sec.vehicles.length - 1) / 2) * 25, y: cy - uy * 40 + ux * (i - (sec.vehicles.length - 1) / 2) * 25 }));
      }
      tv = placeVehicles(catalog, map, sec.vehicles, attacking, side, mainP, dx, W, H, attacking && def.deadGroundStart !== false ? { observers, objectives: [mainP, secondP] } : null, { home, avoid: ifvs, behind });
      placements.push(...tv.placements);
    }
    // Each sub-unit (squad) and each platoon's own men get a spot; men stand in a loose line, 6 m apart.
    // (With vehicles: crews are in their seats, and the attacker's carried men start aboard.)
    const footGroups = (unit: UnitInput): SoldierGroup[] => {
      const kids = unit.subunits.filter((u) => u.vehicleId === undefined);
      return unit.subunits.length > 0 ? [{ men: unit.members.map((m) => m.personId), carrier: unit.carrierId }, ...kids.map((u) => ({ men: allMembers(u).map((m) => m.personId), carrier: u.carrierId }))].filter((g) => g.men.length > 0) : [{ men: allMembers(unit).map((m) => m.personId), carrier: unit.carrierId }];
    };
    const groups = units.flatMap(footGroups);
    if (fv && attacking) {
      for (const g of groups) {
        const vp = g.carrier === undefined ? undefined : fv.vehiclePlacements.find((p) => p.vehicleId === g.carrier);
        if (!vp) throw new Error(`scenario: no vehicle for carried men ${g.men[0] ?? ""}`);
        for (const pid of g.men) placements.push({ personId: pid, x: vp.x, y: vp.y, heading: vp.heading, mountedIn: vp.vehicleId });
      }
    } else groups.map((g) => g.men).forEach((men, gi) => {
      let cx: number, cy: number;
      if (side === defender) {
        // Defence: the platoon's men behind the main objective's centre and two squads at its front corners (all
        // inside its 40 m ring), one squad at the second objective, in front of its centre.
        const sp = defenceSpots(mainP, secondP, dx)[Math.min(gi, 3)]!;
        cx = sp.x; cy = sp.y;
      } else {
        // Attack: start in a line of squads near the own map edge, opposite the objectives.
        cx = side === "blue" ? W * 0.08 : W * 0.92;
        cy = H / 2 + (gi - (groups.length - 1) / 2) * (groups.length > 4 ? 45 : 70);
      }
      men.forEach((m, mi) => {
        const p = freeSpot(map, catalog, cx, cy + (mi - (men.length - 1) / 2) * 6);
        placements.push({ personId: m, x: p.x, y: p.y, heading });
      });
    });
    // On-map mortars (M8.3a): the section behind the own line (the defender 250 m behind its main objective, the
    // attacker at its map edge), its two teams 30 m apart across the front, the men 4 m apart.
    const mt = def.mortars === true ? pack?.manifest.mortarTemplate : undefined;
    if (mt) {
      const sec = buildForceWithVehicles(data, { faction, template: mt, seed: def.seed * 37 + s * 11, keyPrefix: `${side}-m`, number: 1 }).unit;
      units.push(sec);
      // (Review fix: at least the tube's minimum range + 50 m from the main objective where the map allows; a
      // section that still cannot reach it leaves the side its off-map allotment as well.)
      let minR = 0;
      for (const m of allMembers(sec)) for (const l of m.load) minR = Math.max(minR, catalog.items[l.type]?.mortar?.minRangeM ?? 0);
      const back = Math.max(250, minR + 50);
      const bx = side === defender ? Math.min(Math.max(mainP.x + dx * back, 20), W - 20) : side === "blue" ? W * 0.02 : W * 0.98;
      const teams = sec.subunits.length > 0 ? sec.subunits : [sec];
      teams.forEach((tm, ti) => {
        const ms = allMembers(tm);
        ms.forEach((m, mi) => {
          const p = freeSpot(map, catalog, bx + (mi % 2) * 4 * (side === "blue" ? -1 : 1), H / 2 + (ti - (teams.length - 1) / 2) * 30 + (Math.floor(mi / 2) - 1) * 4);
          placements.push({ personId: m.personId, x: p.x, y: p.y, heading });
        });
      });
      if (hypot2(bx - mainP.x, H / 2 - mainP.y) >= minR) mortarSides.add(side);
    }
    // Dismounted missile team (M9.3b): a unit of its own, behind the own line (never mounted, not a foot group).
    // (M7.6d: an automatic grenade launcher team the same, on the other flank.)
    const at = def.missileTeams === true ? pack?.manifest.missileTeamTemplate : undefined;
    const aglWanted = def.aglTeams === true || def.aglTeams === (attacking ? "attacker" : "defender");
    const gt = aglWanted ? pack?.manifest.aglTeamTemplate : undefined;
    for (const [tpl, prefix, seedK, other] of [[at, "a", 41, false], [gt, "g", 53, true]] as const) {
      if (!tpl) continue;
      const team = buildForceWithVehicles(data, { faction, template: tpl, seed: def.seed * seedK + s * 13, keyPrefix: `${side}-${prefix}`, number: 1 }).unit;
      units.push(team);
      const flank = (def.seed % 2 === 0 ? -1 : 1) * (other ? -1 : 1); // (the missile team: the flank away from the second objective)
      let bx = side === defender ? Math.min(Math.max(mainP.x + dx * (other ? 250 : 300), 20), W - 20) : side === "blue" ? Math.max(20, W * 0.08 - 150) : Math.min(W - 20, W * 0.92 + 150);
      let by = side === defender ? mainP.y + (other ? 60 * flank : 0) : H / 2 + flank * H * 0.3;
      // Review fix: the attacker's team starts in dead ground as its vehicles do (hidden from the defence's sights
      // and men, nearest the flank spot, clear of the hulls); else next to the vehicles' start, behind them.
      if (attacking && def.deadGroundStart !== false) {
        const spot = teamDeadGround(catalog, map, side, observers, [mainP, secondP], W, H, { x: bx, y: by }, fv?.vehiclePlacements ?? []);
        if (spot) { bx = spot.x; by = spot.y; }
        else if (fv && fv.vehiclePlacements.length > 0) {
          let sx = 0, sy = 0;
          for (const p of fv.vehiclePlacements) { sx += p.x; sy += p.y; }
          bx = Math.min(Math.max(sx / fv.vehiclePlacements.length - dx * 30, 20), W - 20); by = sy / fv.vehiclePlacements.length;
        }
      }
      allMembers(team).forEach((m, mi) => {
        const p = freeSpot(map, catalog, bx + (mi % 2) * 4 * (side === "blue" ? -1 : 1), by + (Math.floor(mi / 2) - 0.5) * 4);
        placements.push({ personId: m.personId, x: p.x, y: p.y, heading });
      });
    }
    const force: ForceInput = { side, faction, units, placements, posture: side === def.attacker ? "attack" : "defend" };
    if (fv) { force.vehicles = fv.records; force.vehiclePlacements = fv.vehiclePlacements; }
    if (tv) { force.vehicles = [...(force.vehicles ?? []), ...tv.records]; force.vehiclePlacements = [...(force.vehiclePlacements ?? []), ...tv.vehiclePlacements]; }
    // Ambulances off the map (M10.6a): crews and hulls from the faction's data, waiting at the rear to be called.
    const amb = def.ambulances !== false ? pack?.manifest.ambulance : undefined;
    if (amb && amb.count > 0) {
      const vtype = pack!.units[amb.template]?.vehicle;
      if (vtype !== undefined && catalog.vehicles[vtype]) {
        for (let k = 0; k < amb.count; k++) {
          const crew = buildForceWithVehicles(data, { faction, template: amb.template, seed: def.seed * 43 + s * 17 + k, keyPrefix: `${side}-amb${k + 1}`, number: k + 1 }).unit;
          crew.vehicleId = crew.key;
          units.push(crew);
          (force.vehicles ??= []).push(newVehicleRecord(catalog, vtype, crew.key));
          (force.offMap ??= []).push({ vehicleId: crew.key, kind: "ambulance" });
        }
      }
    }
    // Recovery vehicles off the map (M11.7b): only for a side with vehicles of its own, after the ambulances.
    if (def.recovery !== false && (fv !== null || tv !== null)) addRecoveryAssets(data, catalog, force, def.seed * 47 + s * 19);
    // The military police off the map (M11.9b): every side (built last of all in the battle: setup.ts).
    if (def.mp !== false) addMpAssets(data, catalog, force, def.seed * 59 + s * 23);
    if (!attacking) {
      // What the defence sees from (dead ground for the attacker's start): its vehicles' sights and its men.
      const eye = (type: string) => { const vd = catalog.vehicles[type]; let z = vd?.body.heightM ?? 2.5; for (const q of vd?.seats ?? []) for (const k of q.sensors ?? []) z = Math.max(z, k.pos?.[2] ?? 0); return z; };
      // (Balance pass 2: a hull with a thermal sight sees heat through thin cover: `deadGroundStarts`.)
      const hot = (type: string) => (catalog.vehicles[type]?.seats ?? []).some((q) => (q.sensors ?? []).some((k) => catalog.spotting.sensors[k.kind]?.thermal === true));
      observers = [
        ...(force.vehiclePlacements ?? []).map((p) => { const type = force.vehicles?.find((r) => r.vehicleId === p.vehicleId)?.type ?? ""; return { x: p.x, y: p.y, z: eye(type), ...(hot(type) ? { thermal: true } : {}) }; }),
        ...defenceSpots(mainP, secondP, dx).map((p) => ({ x: p.x, y: p.y, z: 1.7 })),
      ];
    }
    return force;
  };
  const forces: ForceInput[] = [];
  const clampX = (x: number) => Math.min(Math.max(x, 10), W - 10);
  const mortarSides = new Set<string>();
  const dIdx = SIDES.indexOf(defender), aIdx = SIDES.indexOf(def.attacker);
  forces[dIdx] = buildSide(defender, dIdx);
  forces[aIdx] = buildSide(def.attacker, aIdx);
  const rules = defaultRules(def.timeLimitSeconds ?? 2400);
  rules.objectives = objectives;
  rules.victory = { casualtyPoints: SCENARIO_POINTS.perManDown, endOnDefeat: true };
  // A prepared defence (balance pass after M11; SPEC M4: "a prepared defence"): the defenders dig in where their
  // commander sites them, as in the hold battle (owner 2026-11-16).
  // Balance pass 2: a hasty dig-in (`SCENARIO_HASTY_DEPTH_M`), shallower than the hold battle's prepared holes.
  if (def.prepared !== false) {
    const depthM = def.preparedDepthM === undefined ? SCENARIO_HASTY_DEPTH_M : def.preparedDepthM;
    // (Review fix: a hole is deeper than nothing and no deeper than the data's.)
    const dataDepth = catalog.ballistics.fightingPosition?.depthM;
    if (depthM !== null && (!(depthM > 0) || (dataDepth !== undefined && depthM > dataDepth))) throw new Error(`preparedDepthM ${depthM} is outside (0, ${dataDepth ?? "∞"}] m`);
    rules.prepared = [{ side: defender, fromS: SCENARIO_PREPARED_S[0], untilS: SCENARIO_PREPARED_S[1], ...(depthM !== null ? { depthM } : {}) }];
  }
  // Vehicles (M7.4a, owner Q9): an IFV destroyed or abandoned costs 20 points, immobilised 10.
  if (forces.some((f) => (f.vehicles?.length ?? 0) > 0)) rules.victory.vehiclePoints = { lost: SCENARIO_POINTS.vehicleLost, immobilised: SCENARIO_POINTS.vehicleImmobilised };
  // Mortar rounds (owner, M6 review: support fire pulled forward): the attacker more, with smoke.
  rules.support = SIDES.filter((side) => !mortarSides.has(side)).map((side) => {
    const s = SIDES.indexOf(side);
    const k = catalog.factions[def.factions[s]!]?.fireSupport?.roundsFactor ?? 1;
    const att = side === def.attacker;
    // Planned fires (M8.5): the defender's mortars registered before the battle on the ground in front of its
    // objectives, where the attack must cross (150 and 300 m before the main one, 150 m before the second).
    const planned = att ? [] : [
      { x: clampX(mainP.x - dx * 150), y: mainP.y }, { x: clampX(mainP.x - dx * 300), y: mainP.y }, { x: clampX(secondP.x - dx * 150), y: secondP.y },
    ];
    return { side, he: Math.round(k * (att ? SCENARIO_SUPPORT.attackerHe : SCENARIO_SUPPORT.defenderHe)), smoke: Math.round(k * (att ? SCENARIO_SUPPORT.attackerSmoke : SCENARIO_SUPPORT.defenderSmoke)), illum: att ? SCENARIO_SUPPORT.attackerIllum : SCENARIO_SUPPORT.defenderIllum, ...(planned.length > 0 ? { planned } : {}) };
  });
  if (def.artillery === true) {
    SIDES.forEach((side, s) => {
      if (catalog.factions[def.factions[s]!]?.artillery) rules.support!.push({ side, ...SCENARIO_ARTILLERY, asset: "artillery" });
    });
  }
  if (def.airRecon && def.airRecon.length > 0) rules.airRecon = [...def.airRecon];
  return { map, catalog, forces, rules, seed: def.seed, orders: [] };
}

interface SoldierGroup { men: string[]; carrier: string | undefined }

/** Where the defence stands at the start: its platoon's men behind the main objective's centre, two squads at
 *  its front corners (inside its 40 m ring), one squad in front of the second objective. */
function defenceSpots(mainP: { x: number; y: number }, secondP: { x: number; y: number }, dx: number): { x: number; y: number }[] {
  return [{ x: mainP.x + dx * 10, y: mainP.y }, { x: mainP.x - dx * 14, y: mainP.y - 20 }, { x: mainP.x - dx * 14, y: mainP.y + 20 }, { x: secondP.x - dx * 8, y: secondP.y }];
}

/** Dead ground (owner 2026-11-13): candidate starts this far apart, at least this far from every objective, and on
 *  the attacker's side of this share of the map. A spot is hidden from an observer when the line to a hull's middle
 *  and to its top is blocked (ground, walls, roofs) or seen through less than this share (woods, hedges); a group
 *  of hulls stays within groupRadiusM of its first spot. Balance pass 2: an observer with a thermal sight also sees
 *  it when the heat channel comes through at `heatAbove` or more (vegetation hides heat far less than it hides a
 *  hull from the eye: the defenders' Pumas saw "hidden" BMP-2s at their starts in 4 of 10 seeds). */
const DEAD_GROUND = { stepM: 20, minFromObjectiveM: 600, ownShare: 0.4, edgeM: 30, seenAbove: 0.15, heatAbove: 0.001, spacingM: 20, groupRadiusM: 200 } as const;

/**
 * The attacker's vehicle starts in dead ground (owner 2026-11-13): spots on its side of the map, at least 600 m
 * from the objectives, that no defender (its vehicles' sights, its men) can see, sampled every 20 m. The spot
 * hidden from everyone and nearest the usual start (the middle of the attacker's edge) anchors the group; the
 * hulls take the hidden spots nearest it, 20 m apart. Where too few spots are hidden from all, the least seen
 * ones are used (on open, flat ground that is the usual line at the edge); a group stays within 200 m. Deterministic: the map and the
 * defenders' places only.
 */
function deadGroundStarts(
  catalog: Catalog, map: MapDef, grid: NavGrid, region: number, n: number, side: string, hullHeightM: number,
  observers: readonly { x: number; y: number; z: number; thermal?: boolean }[], objectives: readonly { x: number; y: number }[], W: number, H: number,
  home: { x: number; y: number } | null = null, avoid: readonly { x: number; y: number }[] = [], avoidM = 0, seenAbove: number = DEAD_GROUND.seenAbove,
): { x: number; y: number }[] | null {
  if (observers.length === 0 || n === 0) return null;
  const D = DEAD_GROUND;
  const mapIndex = buildMapIndex(map);
  const ctx = { catalog, map, mapIndex, ballistics: buildBallistics(map, catalog, mapIndex, TICK_HZ) } as unknown as SimContext;
  const homeX = home ? home.x : side === "blue" ? W * 0.08 : W * 0.92, homeY = home ? home.y : H / 2;
  const cands: { x: number; y: number; seen: number; home: number }[] = [];
  for (let x = D.edgeM; x <= W - D.edgeM; x += D.stepM) {
    if (side === "blue" ? x > W * D.ownShare : x < W * (1 - D.ownShare)) continue;
    for (let y = D.edgeM; y <= H - D.edgeM; y += D.stepM) {
      if (objectives.some((o) => hypot2(o.x - x, o.y - y) < D.minFromObjectiveM)) continue;
      if (avoid.some((o) => hypot2(o.x - x, o.y - y) < avoidM)) continue;
      const cell = nearestPassable(grid, x, y, 0, region);
      if (cell < 0) continue;
      const g = heightAt(map, x, y);
      let seen = 0;
      for (const o of observers) {
        const oz = heightAt(map, o.x, o.y) + o.z;
        for (const h of [1.2, hullHeightM - 0.1]) {
          const r = sight(ctx, o.x, o.y, oz, x, y, g + h);
          if (r.blockedBy === null && (r.visibility >= seenAbove || (o.thermal === true && (r.heatVisibility ?? 0) >= D.heatAbove))) { seen++; break; }
        }
      }
      cands.push({ x, y, seen, home: hypot2(x - homeX, y - homeY) });
    }
  }
  if (cands.length === 0) return null;
  cands.sort((a, b) => a.seen - b.seen || a.home - b.home || a.x - b.x || a.y - b.y);
  // A group round each of the best anchors: the least seen spots nearest it, at least 20 m apart. The group seen
  // least wins, then the tighter one, then the one nearer the usual start.
  let best: { x: number; y: number; seen: number }[] | null = null, bestCost = Infinity;
  for (const anchor of cands.slice(0, 80)) {
    const near = [...cands].sort((a, b) => a.seen - b.seen || hypot2(a.x - anchor.x, a.y - anchor.y) - hypot2(b.x - anchor.x, b.y - anchor.y) || a.x - b.x || a.y - b.y);
    const out: { x: number; y: number; seen: number }[] = [];
    let seen = 0, spread = 0;
    for (const c of near) {
      if (out.length >= n) break;
      if (out.some((p) => hypot2(p.x - c.x, p.y - c.y) < D.spacingM - 1e-6) || hypot2(c.x - anchor.x, c.y - anchor.y) > D.groupRadiusM) continue;
      out.push(c); seen += c.seen; spread = Math.max(spread, hypot2(c.x - anchor.x, c.y - anchor.y));
    }
    if (out.length < n) continue;
    const cost = seen * 1000 + spread + 0.3 * anchor.home;
    if (cost < bestCost) { bestCost = cost; best = out; }
  }
  if (!best) return null;
  lastDeadGround = { seen: best.map((c) => c.seen), observers: observers.length, candidates: cands.length, hidden: cands.filter((c) => c.seen === 0).length };
  return best.map((c) => ({ x: c.x, y: c.y }));
}

/** Men are seen through thin cover by thermal sights: the team's start must hide it almost wholly. */
const TEAM_SEEN_ABOVE = 0.001;

/** Review fix (M9.3b): a dead-ground start for the attacker's missile team (men's height, one spot, nearest
 *  `home`, at least 30 m from the vehicles' starts); null if no spot is hidden from every observer. */
function teamDeadGround(
  catalog: Catalog, map: MapDef, side: string, observers: readonly { x: number; y: number; z: number; thermal?: boolean }[], objectives: readonly { x: number; y: number }[],
  W: number, H: number, home: { x: number; y: number }, hulls: readonly { x: number; y: number }[],
): { x: number; y: number } | null {
  const grid = buildNavGrid(map, catalog.terrain, "foot", 2, 0, [], { clearanceCells: 1 });
  const region = grid.region[Math.floor(H / 2 / 2) * grid.cols + Math.floor(W / 2 / 2)] ?? 0;
  const keep = lastDeadGround; // (the diagnostics describe the vehicles' start)
  const spots = deadGroundStarts(catalog, map, grid, region, 1, side, 1.8, observers, objectives, W, H, home, hulls, 30, TEAM_SEEN_ABOVE);
  const hidden = lastDeadGround !== null && lastDeadGround !== keep && lastDeadGround.seen[0] === 0;
  lastDeadGround = keep;
  return spots && hidden ? spots[0]! : null;
}

/** Diagnostics of the last dead-ground choice (tools and tests): observers seeing each start, hidden spots. */
export let lastDeadGround: { seen: number[]; observers: number; candidates: number; hidden: number } | null = null;

/** Diagnostics of the attacker's tanks' dead-ground start (M7.6b; null: not searched or none found). */
export let lastTankDeadGround: { seen: number[]; observers: number; candidates: number; hidden: number } | null = null;

/** M7.6b: how a side's tanks are placed: the dead-ground search's home (behind the carriers; null: the usual start),
 *  the carriers' starts to keep clear of, and the fallback line behind the carriers (empty: the usual start). */
interface TankPlacing { home: { x: number; y: number } | null; avoid: readonly { x: number; y: number }[]; behind: { x: number; y: number }[] }

/** Tanks start at least this far from every carrier, m (M7.6b). */
const TANK_AVOID_M = 25;

/** Spacing of the vehicles at the start, m. */
const VEHICLE_SPACING_M = 20;

/**
 * Where a side's vehicles start (M7.2, plan §11): the attacker's in a line across its map edge, 8 % in, facing
 * the enemy; the defender's 60-120 m behind the main objective. Each on ground its class can drive (the class
 * grid with extra clearance, in the map's main connected area). Crewmen whose template names a seat take it.
 */
function placeVehicles(
  catalog: Catalog, map: MapDef, vehicles: ForceVehicle[], attacking: boolean, side: string, mainP: { x: number; y: number }, dx: number, W: number, H: number,
  dead: { observers: readonly { x: number; y: number; z: number; thermal?: boolean }[]; objectives: readonly { x: number; y: number }[] } | null = null,
  tank: TankPlacing | null = null,
): { records: VehicleRecord[]; vehiclePlacements: NonNullable<ForceInput["vehiclePlacements"]>; placements: Placement[] } {
  const records: VehicleRecord[] = [], vehiclePlacements: NonNullable<ForceInput["vehiclePlacements"]> = [], placements: Placement[] = [];
  const grids = new Map<string, NavGrid>();
  let heading = side === "blue" ? 0 : PI;
  // Dead ground for the attacker's start (owner 2026-11-13): spots chosen for the first vehicle's class.
  let starts: { x: number; y: number }[] | null = null;
  if (dead && vehicles.length > 0) {
    const def0 = catalog.vehicles[vehicles[0]!.type];
    if (def0) {
      const grid = buildNavGrid(map, catalog.terrain, def0.class, 2, 0, [], { clearanceCells: 3 });
      grids.set(def0.class, grid);
      const mainRegion = grid.region[Math.floor(H / 2 / 2) * grid.cols + Math.floor(W / 2 / 2)] ?? 0;
      let tallest = 0;
      for (const fv of vehicles) tallest = Math.max(tallest, catalog.vehicles[fv.type]?.body.heightM ?? 2.5);
      if (tank) {
        // M7.6b: tanks hidden behind the carriers' group, 25 m clear of every carrier; seen by anyone: the line behind
        // the carriers (or, with no carriers, the usual start). The carriers' diagnostics stay as they were.
        const keep = lastDeadGround;
        starts = deadGroundStarts(catalog, map, grid, mainRegion, vehicles.length, side, tallest, dead.observers, dead.objectives, W, H, tank.home, tank.avoid, TANK_AVOID_M);
        lastTankDeadGround = starts ? lastDeadGround : null;
        lastDeadGround = keep;
        if (starts && lastTankDeadGround !== null && lastTankDeadGround.seen.some((k) => k > 0) && tank.behind.length === vehicles.length) starts = tank.behind.map((p) => ({ ...p }));
      } else starts = deadGroundStarts(catalog, map, grid, mainRegion, vehicles.length, side, tallest, dead.observers, dead.objectives, W, H);
      if (starts) {
        // Facing the main objective from the group's middle.
        let sx = 0, sy = 0;
        for (const p of starts) { sx += p.x; sy += p.y; }
        heading = atan2(mainP.y - sy / starts.length, mainP.x - sx / starts.length);
      }
    }
  }
  // (M7.6b: an attacker's tanks with no dead-ground start stand behind the carriers.)
  if (tank && attacking && !starts && tank.behind.length === vehicles.length) starts = tank.behind.map((p) => ({ ...p }));
  vehicles.forEach((fv, i) => {
    const def = catalog.vehicles[fv.type];
    if (!def) throw new Error(`scenario: vehicle type '${fv.type}' not in the catalog`);
    let grid = grids.get(def.class);
    if (!grid) { grid = buildNavGrid(map, catalog.terrain, def.class, 2, 0, [], { clearanceCells: 3 }); grids.set(def.class, grid); }
    const mainRegion = grid.region[Math.floor(H / 2 / 2) * grid.cols + Math.floor(W / 2 / 2)] ?? 0;
    const lat = (i - (vehicles.length - 1) / 2) * VEHICLE_SPACING_M;
    // Attack: a line across the own edge. Defence: behind the main objective (away from the attack), staggered.
    // (M7.6b: the defender's tanks 150-210 m behind the main objective, 40 m apart.)
    const x0 = starts ? starts[i]!.x : attacking ? (side === "blue" ? W * 0.08 : W * 0.92) : mainP.x + dx * (tank ? 150 + (i % 2) * 60 : 60 + (i % 2) * 60);
    const y0 = starts ? starts[i]!.y : attacking ? H / 2 + lat : mainP.y + lat * (tank ? 2 : 1.5);
    const cx0 = Math.min(Math.max(x0, 1), W - 1), cy0 = Math.min(Math.max(y0, 1), H - 1);
    let cell = nearestPassable(grid, cx0, cy0, 80, mainRegion);
    // (M7.6b review fix: drivable ground also where the main region is not near: wider, then any region.)
    if (cell < 0) cell = nearestPassable(grid, cx0, cy0, 250, mainRegion);
    if (cell < 0) cell = nearestPassable(grid, cx0, cy0, 250);
    const taken = (x: number, y: number) => vehiclePlacements.some((p) => hypot2(p.x - x, p.y - y) < 12);
    let vx = cell < 0 ? cx0 : ((cell % grid.cols) + 0.5) * grid.cellM, vy = cell < 0 ? cy0 : (Math.floor(cell / grid.cols) + 0.5) * grid.cellM;
    // Never two hulls on the same spot: step along the line until free.
    for (let k = 1; taken(vx, vy) && k < 40; k++) {
      const c2 = nearestPassable(grid, vx, Math.min(Math.max(vy + (k % 2 === 0 ? 1 : -1) * k * 6, 1), H - 1), 40, mainRegion);
      if (c2 >= 0) { vx = ((c2 % grid.cols) + 0.5) * grid.cellM; vy = (Math.floor(c2 / grid.cols) + 0.5) * grid.cellM; }
    }
    records.push(newVehicleRecord(catalog, fv.type, fv.vehicleId));
    vehiclePlacements.push({ vehicleId: fv.vehicleId, x: vx, y: vy, heading });
    for (const cs of fv.crewSeats) {
      const seat = def.seats.findIndex((q) => q.id === cs.seat);
      if (seat >= 0) placements.push({ personId: cs.personId, x: vx, y: vy, heading, seat });
    }
  });
  return { records, vehiclePlacements, placements };
}

/** M11.1 hold-resupply: what the waves and the supply point are (game values). */
export const HOLD = {
  waveS: [0, 900, 1800], timeLimitSeconds: 3600, supplyBehindM: 150, canMaxRounds: 1200, attackerMortarShare: 1 / 6, preparedS: [60, 90],
  /** M11.4b: the defender's off-map stock holds this many times the supply point's starting load (deliveries by its
   *  supply vehicle), and tops its mortar allotment up by `topUpRounds` every `topUpEveryS` (game values). */
  stockLoads: 2, topUpRounds: 6, topUpEveryS: 600,
  /** M11.8 balance option: the defenders have been fighting since first light: of each man's spare magazines, belts and
   *  loose rounds only this share is still loaded (the rest empty). 1 (off): measured at 0.5 over 20 seeds each way it
   *  lowered the holds with and without resupply alike (DECISIONS "M11.8"); kept for the owner's choice. */
  defenderLoadShare: 1,
  /** Balance pass 2 (owner 2026-11-17: "resupply must matter more"): the defenders have been fighting since first light:
   *  of each stack of two or more magazines or belts only this share is still loaded (at least one: the one in the
   *  weapon; the rest empty), their loose rounds in full: without resupply (no refilling) the loose rounds cannot be
   *  loaded. 0.25 leaves a rifleman only the magazine in his weapon (no loaded spare: he holds it for close defence,
   *  `reserveTargetOk`, until he refills; about half carry no loose rounds) and a gunner one belt. Review: with a
   *  loaded spare kept (and fewer loose rounds) the gap closed (8 seeds, German defence: 3 / 4 holds with / without
   *  resupply; with no loose rounds at all 1 of 8 held with resupply): ammunition decides this battle only when the
   *  men are short enough to hold their fire (DECISIONS "Balance pass 2", review fixes). */
  defenderMagazineShare: 0.25,
  /** Balance pass 2: the supply point (and with it the off-map stock, `stockLoads` times it) holds this share of the
   *  rounds of one can per squad and cartridge: full cans and one part-filled can per cartridge (so a fresh point's
   *  marker reads 0.75 full). */
  pointShare: 0.5,
} as const;

export interface HoldDef {
  seed: number;
  /** Faction of blue (west) and red (east). */
  factions: [string, string];
  /** The side that holds (default blue: the German platoon holds against Russian waves; red: swapped). */
  defender?: "blue" | "red";
  timeLimitSeconds?: number;
  /** When each wave (an attacking platoon) enters, s after the start (default HOLD.waveS). */
  waveS?: number[];
  /** M11.4b: false: no off-map stock and no supply vehicle (the battle as in slice 46). Default true. */
  deliveries?: boolean;
  /** M11.8: the share of the defenders' spare rounds still loaded (default HOLD.defenderLoadShare; 1: a full load). */
  defenderLoadShare?: number;
  /** Balance pass 2: the share of their spare magazines and belts still loaded (default HOLD.defenderMagazineShare;
   *  the smaller of this and `defenderLoadShare` applies to magazines). */
  defenderMagazineShare?: number;
  /** Balance pass 2: the share of the supply point's full load it holds (default HOLD.pointShare). */
  pointShare?: number;
}

/**
 * M11.1 hold-resupply (plan slice 43 point 6): one platoon on foot holds the village centre (main objective) and a
 * flank (second) against the other side's platoons coming in waves from the far map edge (late arrival,
 * `UnitInput.arriveS`), with a third of the platoon battle's mortar allotment for the attacker; 60 minutes. The defender has a
 * supply point 150 m behind the village: per squad one can (tin) of loose rounds for each cartridge its men fire —
 * the faction's largest ammunition package up to HOLD.canMaxRounds, from the data — as a crate entity on the
 * ground. Nothing else comes forward in this slice.
 */
export function holdBattle(data: DataSet, def: HoldDef): BattleInput {
  const defender = def.defender ?? "blue";
  const attacker = defender === "blue" ? "red" : "blue";
  const waves = def.waveS ?? [...HOLD.waveS];
  const input = buildScenario(data, {
    kind: "platoon-attack", seed: def.seed, mapKind: "village", factions: def.factions, attacker, attackerPlatoons: waves.length,
    timeLimitSeconds: def.timeLimitSeconds ?? HOLD.timeLimitSeconds, hold: true,
  });
  const af = input.forces.find((f) => f.side === attacker)!, df = input.forces.find((f) => f.side === defender)!;
  const plats = af.units.filter((u) => u.echelon === "platoon");
  plats.forEach((u, k) => { if ((waves[k] ?? 0) > 0) u.arriveS = waves[k]!; });
  // The attacker's mortar allotment: the platoon battle's spread over the waves (`HOLD.attackerMortarShare` of it),
  // all available from the start. (Three waves' worth at once, wave 1 shelled the defence to pieces before wave 2
  // came; with the platoon battle's full allotment it still did in 2 of 3 trial seeds. Each wave's own allotment
  // arriving with it is for the off-map deliveries of slice 47.)
  for (const sp of input.rules.support ?? []) if (sp.side === attacker && sp.asset === undefined) { sp.he = Math.round(sp.he * HOLD.attackerMortarShare); sp.smoke = Math.round(sp.smoke * HOLD.attackerMortarShare); }
  // Prepared positions (owner 2026-11-16, "a stronger defence"): the defenders dug in where their commander sites
  // them; a man halted on the ground in the first minutes is in a fighting position there.
  input.rules.prepared = [{ side: defender, fromS: HOLD.preparedS[0], untilS: HOLD.preparedS[1] }];
  // M11.8 balance: the defenders start with part of their spare rounds spent (`defenderLoadShare`): of each stack of
  // magazines or belts that share stays full (rounded down; the one in the weapon is the fullest) and the rest is empty;
  // loose rounds (packages) keep that share of their rounds.
  // Balance pass 2: magazines and belts at `defenderMagazineShare` (the smaller of the two), loose rounds full.
  const share = def.defenderLoadShare ?? HOLD.defenderLoadShare;
  const magShare = Math.min(share, def.defenderMagazineShare ?? HOLD.defenderMagazineShare);
  if (share < 1 || magShare < 1) for (const u of df.units) for (const m of allMembers(u)) {
    const out: typeof m.load = [];
    for (const l of m.load) {
      const d = input.catalog.items[l.type];
      if (d?.chargeItem === undefined || l.charge === undefined || l.charge <= 0) { out.push(l); continue; }
      if (d.category === "ammo-package") { out.push({ ...l, charge: Math.floor(l.charge * share) }); continue; }
      if (d.category !== "magazine" || l.count < 2) { out.push(l); continue; }
      const full = Math.max(1, Math.floor(l.count * magShare));
      out.push({ ...l, count: full });
      if (l.count - full > 0) out.push({ ...l, count: l.count - full, charge: 0 });
    }
    m.load = out;
  }
  // The supply point: behind the main objective, away from the attack.
  const main = input.rules.objectives[0]!;
  const dx = defender === "blue" ? -1 : 1;
  const W = input.map.widthM;
  const sx = Math.min(Math.max(main.x + dx * HOLD.supplyBehindM, 20), W - 20);
  const sp = freeSpot(input.map, input.catalog, sx, main.y);
  const cat = input.catalog;
  const packages = Object.values(cat.items).filter((d) => d.category === "ammo-package" && d.id.startsWith(`${df.faction}-`));
  const loads: { type: string; count: number; charge: number }[] = [];
  const squads = df.units.flatMap((u) => u.subunits.filter((x) => x.vehicleId === undefined));
  for (const sq of squads) {
    const carts = new Set<string>();
    for (const m of allMembers(sq)) for (const l of m.load) { const ci = cat.items[l.type]?.chargeItem; if (ci !== undefined && cat.items[l.type]?.category === "magazine") carts.add(ci); }
    for (const c of [...carts].sort()) {
      const best = packages.filter((d) => d.chargeItem === c && (d.chargeCapacity ?? 0) <= HOLD.canMaxRounds).sort((a, b) => (b.chargeCapacity ?? 0) - (a.chargeCapacity ?? 0) || (a.id < b.id ? -1 : 1))[0];
      if (best) loads.push({ type: best.id, count: 1, charge: best.chargeCapacity! });
    }
  }
  const merged = new Map<string, { type: string; count: number; charge: number }>();
  for (const l of loads) { const m = merged.get(l.type); if (m) m.count += l.count; else merged.set(l.type, { ...l }); }
  // Balance pass 2: the point holds `pointShare` of the rounds of each package: full ones and one part-filled one.
  const pShare = def.pointShare ?? HOLD.pointShare;
  const pointLoad: { type: string; count: number; charge: number }[] = [];
  for (const l of [...merged.values()].sort((a, b) => (a.type < b.type ? -1 : 1))) {
    const total = Math.floor(l.count * l.charge * pShare), full = Math.floor(total / l.charge), rest = total - full * l.charge;
    if (full > 0) pointLoad.push({ type: l.type, count: full, charge: l.charge });
    if (rest > 0) pointLoad.push({ type: l.type, count: 1, charge: rest });
  }
  df.caches = [{ x: sp.x, y: sp.y, load: pointLoad, point: true }];
  // M11.4b: the defender's stock at the rear (deliveries of `stockLoads` times the point's load, and the mortar
  // rounds of the top-up over the whole battle) and its supply vehicle off the map.
  if (def.deliveries !== false) {
    const limit = def.timeLimitSeconds ?? HOLD.timeLimitSeconds;
    const fsDef = cat.factions[df.faction]?.fireSupport;
    const mortarRounds = HOLD.topUpRounds * Math.floor(limit / HOLD.topUpEveryS);
    const load: { type: string; count: number; charge?: number }[] = pointLoad.map((l) => ({ ...l, count: l.count * HOLD.stockLoads }));
    if (fsDef && mortarRounds > 0) load.push({ type: fsDef.heAmmo, count: mortarRounds });
    df.stock = { load, ...(fsDef ? { supportTopUp: { rounds: HOLD.topUpRounds, everyS: HOLD.topUpEveryS } } : {}) };
    addSupplyAssets(data, cat, df, def.seed * 53 + 7);
  }
  return input;
}
