/**
 * THE OPPOSING COMMANDER (M6.3, owner decision 2026-11-12: "doctrinal and cautious").
 *
 * A Controller like a human player: it sees what its OWN men know (their contacts, the objective holders)
 * and acts only through orders, every few seconds. Squads (the platoon's sub-units) fight with the M4 drills
 * and decisions; the commander decides what each squad does.
 *
 * Defence: everyone down in his position, fire at will out to `defenceRangeM`; a squad that has lost half its
 *   men pulls back behind the main objective; if the main objective is lost while two squads are still fit (or
 *   one nearly whole), the strongest counterattacks it.
 * Attack: the platoon moves up to a support line about `supportM` from the main objective, on an axis turned away
 *   from the other objective's garrison (blinded with smoke), each squad to a place with a field of fire (going
 *   to ground on contact, then moving on to it), and looks for the enemy there (up to `reconSeconds`) while the
 *   mortars' high explosive and a smoke screen come in; then half the squads fire on the objective man by man
 *   from the support line while the others run in under the smoke on a flank and assault it by fire and
 *   movement, with grenades; once it is taken, the base of fire comes up and the strongest squad assaults the
 *   second objective, supported by the rest. Losses beyond the faction's doctrine
 *   (`casualtyToleranceBeforeWithdrawal`) make it break off and withdraw to the start (balance pass 2026-11-13,
 *   docs/research/inf-assault.md).
 *
 * Its memory is plain data (saved with the game). Values not from data are listed in COMMANDER.
 */
import {
  atan2, backblastBlocked, cos, createContext, heightAt, indoorAt, navCostAt, navFor, PI, sin, hypot2, isCaptive, isOut, rebuildVehicleGrid, sight, supportLeft, syncTerrainDamage,
  type BattleInput, type Controller, type EntityId, type ObjectiveDef, type Order, type SideId, type SimContext, type SimState, type SimView, type SoldierState,
} from "@tcs/sim";

export const COMMANDER = { stepSeconds: 5, supportM: 330, reconSeconds: 60, defenceRangeM: 300, refireSeconds: 20, reassaultSeconds: 30, fallBackM: 100, grenadeRangeM: 35, grenadeEverySeconds: 20, heEverySeconds: 45, heRounds: 6, smokeEverySeconds: 120, smokeRounds: 3, smokeAheadM: 45, defenceHeEverySeconds: 120, defenceHeRounds: 4, rideTimeoutSeconds: 300, dismountStepM: 50, dismountCandidates: 3, vehicleSlotM: 60, vehicleLossShare: 2 / 3, vehicleFireNearOwnM: 80, followReplanM: 40, supportFireEverySeconds: 20,
  // Anti-tank tasks (M7.4b): how often the commander looks for a shot, how fresh a vehicle contact must be, how
  // long a man waits between shots, how far beyond his weapon's range he goes after a halted vehicle (and where
  // he stops: this share of the range), how many such hunters a side sends at once and for how long.
  atEverySeconds: 5, atContactSeconds: 10, atRefireSeconds: 12, huntBeyondM: 300, huntAtRangeShare: 0.8, huntersMax: 2, huntSeconds: 150, atSidestepM: 8,
  // Getting out at once on an anti-tank threat (M7.4b): enemy men known this close to a carrier, or an enemy
  // vehicle seen this close; a crew reversing out is left to it this long (its hold, behaviour crew.reverseHoldSeconds);
  // vehicles reverse this far on withdrawal.
  dismountThreatMenM: 400, dismountThreatVehicleM: 600, reverseOutHoldSeconds: 15, withdrawReverseM: 80,
  // The infantry attack (balance pass 2026-11-13, game values, low confidence; docs/research/inf-assault.md; the
  // pass also moved supportM 300 -> 330, sneakM 200 -> 50 and heEverySeconds 90 -> 45):
  // - axis (on foot): the way in is turned about the objective by up to `axisMaxDeg` so that the support line keeps
  //   `flankClearM` from the other objectives the enemy holds; their garrisons are blinded with smoke laid
  //   `blindAheadM` in front of them;
  // - support line: each squad's place is chosen once near its slot (`placeDepthsM` x `placeAsideM` around it)
  //   for its field of fire onto the objective (a line of fire allowed to end `lineAllowanceM` short of the point);
  //   a squad gone to ground short of it moves on after `resumeSeconds` (at a run under fire, at most `resumeMax`
  //   times); in place within `arrivedM`; two thirds in place is enough; the advance stops waiting after
  //   `advanceTimeoutSeconds`; the fires before the assault are called when the first squad is `prepLeadM` short;
  // - base of fire: man by man at the enemies known near the objective (full rate), lifting off any its own men are
  //   within `liftM` of; one squad keeps the other objective's garrison down;
  // - assault element: runs (screened by smoke `screenShare` of the way from the objective to the assault position)
  //   toward a point `closeInM` short, on the bearing up to `flankMaxDeg` off the axis seen least from the
  //   objectives; under fire (a man's suppression >= `underFireSuppression`) within `assaultPositionM` it goes over
  //   to fire and movement at once, and after `closeTimeoutSeconds` in any case; its grenade launchers engage
  //   from `launcherReachM`.
  sneakM: 50, resumeSeconds: 15, resumeMax: 4, arrivedM: 40, advanceTimeoutSeconds: 600, assaultPositionM: 120, flankMaxDeg: 50, closeTimeoutSeconds: 180, closeInM: 60, underFireSuppression: 0.1, prepLeadM: 100, blindAheadM: 10, axisMaxDeg: 45, screenShare: 0.5, liftM: 40, lineAllowanceM: 5, placeDepthsM: [0, 20, -10], placeAsideM: [0, -20, 20, -40, 40], flankClearM: 320, launcherReachM: 200 } as const;

type Phase = "start" | "ride" | "advance" | "recon" | "assault" | "second" | "hold" | "withdraw";
interface Memory {
  phase: Phase; phaseTick: number; target: number; lastFire: number; lastAssault: Record<string, number>; pulledBack: number[]; counterTick: number; lastGrenade?: Record<string, number>; lastHe?: number; lastSmoke?: number;
  /** M7.2 ride and dismount: the last vehicle hit it has seen (polled `lastHitTick`), squads and men ordered out,
   *  vehicles waiting for their squad to get back in during a withdrawal. */
  lastHitSeen?: number; out?: number[]; remount?: number[];
  /** M7.3 after the dismount: vehicle crews set loose (fire free), where each following vehicle was last sent,
   *  and when the vehicles last got a fire order. */
  crewsFree?: boolean; followAt?: Record<string, [number, number]>; lastVehicleFire?: number;
  /** M7.4b: crews that bailed out and were sent back; anti-tank tasks: the last look, each gunner's last shot
   *  order, and the men sent after a vehicle (target, since when). */
  sentBack?: number[]; lastAt?: number; atShot?: Record<string, number>; hunt?: Record<string, [number, number]>;
  /** Infantry attack (balance pass 2026-11-13): when each squad was last sent on toward its place; the assault
   *  position (bearing off the line of advance, rad); squads that have reached it (or stopped trying). */
  resumeAt?: Record<string, number>; resumeN?: Record<string, number>; flank?: number; closed?: number[]; maxRate?: number[]; lastBlind?: number;
  /** The turn of the attack's axis about its objective (rad), chosen once per objective. */
  axis?: number;
  /** Each squad's support-by-fire place for objective `placesFor` (chosen once from the map: its field of fire). */
  places?: Record<string, [number, number]>; placesFor?: number;
}

/**
 * A controller's own view of the ground (built once, when first needed; derived, never saved): before each use it
 * is brought up to the view it is given, holes blown in walls (when there are new ones) and the hulls and wrecks
 * as they stand (once per tick), so sight lines and back-blast checks agree with the sim's (M7 review).
 */
export function viewGround(input: BattleInput): (view: SimView, tick: number) => SimContext {
  let ctx: SimContext | null = null;
  let seenBreaches = -1, groundTick = -1;
  return (view, tick) => {
    const c = ctx ??= createContext({ ...input, orders: [] });
    const st = view as unknown as SimState;
    if (st.terrain.breaches.length !== seenBreaches) { syncTerrainDamage(c, st); seenBreaches = st.terrain.breaches.length; }
    if (groundTick !== tick) { rebuildVehicleGrid(c, st); groundTick = tick; }
    return c;
  };
}

const able = (s: SoldierState | undefined) => s !== undefined && !isOut(s) && s.mental.behaviour !== "routed";

/** The men of a unit and its sub-units, vehicle crews left out (they fight from their vehicles). */
function members(view: SimView, uid: EntityId): EntityId[] {
  const u = view.unit.get(uid);
  if (!u) return [];
  return [...u.members, ...u.children.filter((c) => isFootUnit(view, c)).flatMap((c) => members(view, c))];
}

/** A unit on foot that fights as a squad: not a vehicle crew, nor a crew that bailed out (M7.4b). */
function isFootUnit(view: SimView, uid: EntityId): boolean {
  const u = view.unit.get(uid);
  return u !== undefined && u.vehicle === undefined && u.exVehicle === undefined;
}

/** Able men of a unit who are aboard a vehicle (not crew): they ride, and are never ordered to walk. */
function riders(view: SimView, uid: EntityId): EntityId[] {
  const u = view.unit.get(uid);
  if (!u || u.vehicle !== undefined) return [];
  return u.members.filter((m) => { const s = view.soldier.get(m) as SoldierState | undefined; return s?.mount !== undefined && able(s) && s.impair.canWalk; });
}

/** The anti-tank round (and its effective range) a man of the side carries ready to fire: a launcher and a round. */
function launcherReady(view: SimView, input: BattleInput, m: EntityId): { range: number; ammo: string } | null {
  const c = view.container.get(m);
  if (!c) return null;
  for (const st of c.stacks) {
    if (st.count <= 0) continue;
    const d = input.catalog.ammo[st.type]?.delivery;
    if (d?.method !== "direct" || d.launcher === undefined) continue;
    if (c.stacks.some((x) => x.type === d.launcher && x.count > 0)) return { range: d.maxRangeM ?? 300, ammo: st.type };
  }
  return null;
}

export function commanderController(side: SideId, input: BattleInput): Controller {
  const objectives: readonly ObjectiveDef[] = input.rules.objectives;
  const W = input.map.widthM, H = input.map.heightM;
  const force = input.forces.find((f) => f.side === side)!;
  const doctrine = input.catalog.factions[force.faction]?.doctrine ?? {};
  const tolerance = doctrine["casualtyToleranceBeforeWithdrawal"] ?? 0.3;
  const fireDelayS = input.catalog.factions[force.faction]?.fireSupport?.delaySeconds ?? 0;
  // Where this side starts (its men's mean position): the way back, and the side the attack comes from.
  const sx = force.placements.reduce((a, p) => a + p.x, 0) / Math.max(1, force.placements.length);
  const sy = force.placements.reduce((a, p) => a + p.y, 0) / Math.max(1, force.placements.length);
  const defending = objectives.length > 0 && objectives[0]!.holder === side;
  let mem: Memory = { phase: "start", phaseTick: 0, target: 0, lastFire: -1e9, lastAssault: {}, pulledBack: [], counterTick: -1e9 };
  const every = COMMANDER.stepSeconds * 60;
  // Where the attacker gets out (M7.2, owner Q22): this far short of the objective, from its faction's doctrine;
  // without one, the plan's formula from the willingness to dismount.
  const dismountM = input.catalog.factions[force.faction]?.dismountM ?? 300 + (1 - (doctrine["willingnessToDismount"] ?? 0.5)) * 500;
  const M = input.catalog.behaviour.mounting;
  // Its own view of the ground for sight lines and back-blast checks [C58], kept up with the view (M7 review).
  const groundOf = viewGround(input);
  let curView: SimView | null = null, curTick = -1;
  const ground = (): SimContext => groundOf(curView!, curTick);
  /** Out of sight of (ox, oy) from a man standing there to a hull's top at (x, y)? */
  const hidden = (ox: number, oy: number, x: number, y: number): boolean => {
    const ctx = ground();
    // ground: ok (the commander's view of open ground)
    const z0 = heightAt(input.map, ox, oy) + 1.7, z1 = heightAt(input.map, x, y) + 2.2;
    return sight(ctx, ox, oy, z0, x, y, z1).blockedBy !== null;
  };

  return {
    side,
    think(view, tick): Order[] {
      if (view.ended || tick % every !== 0) return [];
      curView = view; curTick = tick;
      const out: Order[] = [];
      const order = (target: EntityId, body: Record<string, unknown>) => out.push({ tick, issuer: side, target, ...body } as Order);
      // Every platoon of the side (the attacker may have two): their squads and their own men.
      const tops = [...view.unit.entries()].filter(([, u]) => u.side === side && u.parent === null);
      if (tops.length === 0) return out;
      const topIds = tops.map(([id]) => id);
      // Squads on foot and vehicle crews (M7.2), paired by the squad's carrier.
      const children = tops.flatMap(([, u]) => u.children).sort((a, b) => a - b);
      const squads = children.filter((c) => isFootUnit(view, c));
      const crews = children.filter((c) => view.unit.get(c)?.vehicle !== undefined);
      // Crews that bailed out (M7.4b): on foot, they go back to where the side started (once each).
      const bailed = children.filter((c) => view.unit.get(c)?.exVehicle !== undefined);
      const crewOfVehicle = (vid: EntityId | undefined) => crews.find((c) => view.unit.get(c)?.vehicle === vid);
      const hq = tops.flatMap(([, u]) => u.members).filter((m) => able(view.soldier.get(m) as SoldierState | undefined));
      const toAll = (body: Record<string, unknown>) => { for (const id of topIds) order(id, body); };
      // What its men know of the enemy: not what its own prisoners know, and never an enemy they know has
      // given up (M6.6: the commander does not fire, shell or throw at him).
      const known = (m: EntityId) => { const s = view.soldier.get(m); return s === undefined || isCaptive(s) ? [] : s.contacts.filter((c) => c.surrendered !== true && c.down !== true); };
      // Men only (M7.3): no mortar, grenade or rifle base of fire at a vehicle contact (plan §12).
      const knownMen = (m: EntityId) => known(m).filter((c) => c.cls !== "vehicle");
      // Fire is called through the first platoon that still has a man who can use the radio.
      const caller = topIds.find((id) => members(view, id).some((m) => { const s = view.soldier.get(m); return able(s as SoldierState | undefined) && s!.impair.canSpeak; })) ?? topIds[0]!;
      const strength = (uid: EntityId) => { const ms = members(view, uid); return ms.length ? ms.filter((m) => able(view.soldier.get(m) as SoldierState | undefined)).length / ms.length : 0; };
      /** Men not killed or out (a man who panicked and ran is not lost: his unit rallies). */
      const fitShare = (uid: EntityId) => { const ms = members(view, uid); return ms.length ? ms.filter((m) => { const s = view.soldier.get(m); return s !== undefined && !isOut(s); }).length / ms.length : 0; };
      const all = topIds.flatMap((id) => members(view, id));
      // Vehicles (M7.2): the polled state the plan lists (§12): status, arrival, hits since the last look.
      const vehicleOf = (c: EntityId) => { const vid = view.unit.get(c)?.vehicle; return vid === undefined ? undefined : view.vehicle.get(vid); };
      const hitNow = crews.some((c) => (vehicleOf(c)?.lastHitTick ?? -1e9) > (mem.lastHitSeen ?? -1e9));
      for (const c of crews) mem.lastHitSeen = Math.max(mem.lastHitSeen ?? -1e9, vehicleOf(c)?.lastHitTick ?? -1e9);
      // Its own vehicles (a crew that bailed out no longer has one: count the hulls of its side).
      const ownVehicles = [...view.vehicle.values()].filter((v) => v.side === side);
      const lostVehicles = ownVehicles.filter((v) => v.status === "destroyed" || v.status === "abandoned" || v.status === "immobilised").length;
      mem.sentBack ??= [];
      for (const c of bailed) {
        if (mem.sentBack.includes(c)) continue;
        order(c, { kind: "move", waypoints: [{ x: clamp(sx, W), y: clamp(sy, H), mode: "run" }] });
        mem.sentBack.push(c);
      }
      // ---- anti-tank tasks (M7.4b): men with a Panzerfaust or an RPG engage the enemy vehicles their side knows
      // within their weapon's range (an order to the man: he fires once, his squad's drill goes on), under their
      // unit's anti-tank rule; a halted vehicle a little beyond it is stalked by up to two of them, who go to a
      // point inside their range on the line to it (the AI's "tank-hunting team").
      if (mem.phase !== "start" && mem.phase !== "ride" && tick - (mem.lastAt ?? -1e9) >= COMMANDER.atEverySeconds * 60) {
        mem.lastAt = tick;
        mem.atShot ??= {}; mem.hunt ??= {};
        // Enemy vehicles its men know (seen or reported recently, not wrecks), the freshest report of each.
        const vk = new Map<EntityId, { x: number; y: number; tick: number; moving: boolean }>();
        for (const m of all) for (const c of known(m)) {
          if (c.cls !== "vehicle" || c.wreck === true || c.kind === "heard" || tick - c.tick > COMMANDER.atContactSeconds * 60) continue;
          const prev = vk.get(c.target);
          if (!prev || c.tick > prev.tick) vk.set(c.target, { x: c.x, y: c.y, tick: c.tick, moving: Math.abs(c.vx ?? 0) + Math.abs(c.vy ?? 0) > 1 });
        }
        // Hunters whose target is gone, or who have been out long enough, are let go (their squad's next order takes them back).
        for (const [k, h] of Object.entries(mem.hunt)) if (!vk.has(h[0]) || tick - h[1] > COMMANDER.huntSeconds * 60) delete mem.hunt[k];
        if (vk.size > 0) {
          const atRule = (uid: EntityId): string => {
            for (let u = view.unit.get(uid); u; u = u.parent === null ? undefined : view.unit.get(u.parent)) if (u.atRule !== undefined) return u.atRule;
            return input.catalog.behaviour.antitank.atRuleDefault;
          };
          const targets = [...vk.entries()].sort((a, b) => a[0] - b[0]);
          for (const m of all) {
            const s = view.soldier.get(m) as SoldierState | undefined;
            if (!able(s) || s!.mount !== undefined || !s!.impair.canUseArms || view.action.has(m)) continue;
            const uid = view.identity.get(m)?.unit;
            if (uid === undefined || atRule(uid) === "hold") continue;
            const rd = launcherReady(view, input, m);
            const t = view.transform.get(m);
            if (!rd || !t) continue;
            let best: { id: EntityId; x: number; y: number; d: number; moving: boolean } | null = null;
            for (const [id, k] of targets) { const d = hypot2(k.x - t.x, k.y - t.y); if (!best || d < best.d) best = { id, x: k.x, y: k.y, d, moving: k.moving }; }
            if (!best) continue;
            if (best.d <= rd.range && best.d >= 20) {
              if (tick - (mem.atShot[String(m)] ?? -1e9) < COMMANDER.atRefireSeconds * 60) continue;
              // A comrade (or a wall) in the danger zone behind him (owner Q20): he first steps a few metres aside,
              // and fires at the next look.
              const az = atan2(best.y - t.y, best.x - t.x);
              if (backblastBlocked(ground(), view as unknown as SimState, m, rd.ammo, az) !== null) {
                const side = m % 2 === 0 ? 1 : -1;
                order(m, { kind: "move", waypoints: [{ x: clamp(t.x - sin(az) * side * COMMANDER.atSidestepM, W), y: clamp(t.y + cos(az) * side * COMMANDER.atSidestepM, H), mode: "run" }] });
                mem.atShot[String(m)] = tick - (COMMANDER.atRefireSeconds - COMMANDER.atEverySeconds) * 60;
                continue;
              }
              order(m, { kind: "fire", x: best.x, y: best.y, contact: best.id, nature: "at" });
              mem.atShot[String(m)] = tick;
              continue;
            }
            // Stalk a halted vehicle a little out of reach (not while the platoon breaks off).
            if (mem.phase === "withdraw" || best.moving || best.d > rd.range + COMMANDER.huntBeyondM) continue;
            const h = mem.hunt[String(m)];
            // A hunter already out: sent on again if he has stopped short (pulled back by a squad order, or gone to ground).
            if (h !== undefined && (h[0] !== best.id || (view.mover.get(m)?.waypoints.length ?? 0) > 0)) continue;
            if (h === undefined && Object.keys(mem.hunt).length >= COMMANDER.huntersMax) continue;
            const goal = rd.range * COMMANDER.huntAtRangeShare;
            const gx = clamp(best.x + ((t.x - best.x) / best.d) * goal, W), gy = clamp(best.y + ((t.y - best.y) / best.d) * goal, H);
            order(m, { kind: "move", waypoints: [{ x: gx, y: gy, mode: "run" }] });
            if (h === undefined) mem.hunt[String(m)] = [best.id, tick];
          }
        }
      }
      const down = all.filter((m) => { const s = view.soldier.get(m); return s !== undefined && isOut(s); }).length / Math.max(1, all.length);
      const holds = (i: number) => view.objectives[i]?.holder === side;
      const main = objectives[0];
      if (!main) return out;

      if (defending) {
        if (mem.phase === "start") {
          toAll({ kind: "rules", fire: "free", maxEngageM: COMMANDER.defenceRangeM });
          toAll({ kind: "posture", posture: "prone" });
          mem.phase = "hold";
          return out;
        }
        // Away from the attack: from the map's middle through the objective.
        const ax = main.x - W / 2, ay = main.y - H / 2, al = hypot2(ax, ay) || 1;
        for (const sq of squads) {
          if (fitShare(sq) < 0.5 && fitShare(sq) > 0 && !mem.pulledBack.includes(sq)) {
            order(sq, { kind: "withdraw", x: clamp(main.x + (ax / al) * COMMANDER.fallBackM, W), y: clamp(main.y + (ay / al) * COMMANDER.fallBackM, H) });
            mem.pulledBack.push(sq);
          }
        }
        // Mortars on attackers its men have seen out in the open (not near its own men).
        if (supportLeft(view, side, "he") > 0 && tick - (mem.lastHe ?? -1e9) >= COMMANDER.defenceHeEverySeconds * 60) {
          let sx2 = 0, sy2 = 0, n = 0;
          for (const m of all) for (const c of knownMen(m)) {
            if (c.kind === "reported" || hypot2(c.x - main.x, c.y - main.y) < 120) continue;
            sx2 += c.x; sy2 += c.y; n++;
          }
          if (n >= 3) {
            const px = sx2 / n, py = sy2 / n;
            const nearOwn = all.some((f) => { const ft = view.transform.get(f); return ft !== undefined && hypot2(ft.x - px, ft.y - py) < 100; });
            if (!nearOwn) { order(caller, { kind: "callFire", x: px, y: py, ammo: "he", rounds: COMMANDER.defenceHeRounds }); mem.lastHe = tick; }
          }
        }
        if (!holds(0) && tick - mem.counterTick > 60 * 60) {
          const fit = squads.filter((sq) => !mem.pulledBack.includes(sq) && strength(sq) >= 0.5);
          const best = [...fit].sort((a, b) => strength(b) - strength(a) || a - b)[0];
          if (best !== undefined && (fit.length >= 2 || strength(best) >= 0.7)) {
            order(best, { kind: "assault", x: main.x, y: main.y });
            mem.counterTick = tick;
          }
        }
        return out;
      }

      // ---- attack
      // (Holding what it took, it stays: breaking off would give the objectives back.)
      const tgt = objectives[mem.target] ?? main;
      // The axis of the attack (balance pass 2026-11-13): from the start, turned about the objective (up to
      // `axisMaxDeg`) so that the support line keeps `flankClearM` from the other objectives the enemy holds
      // (their garrisons would fire into the flank of the attack); the least turn that does, else the best.
      // (A mounted attack keeps the straight way in: its carriers' route and dismount points are planned on it.)
      if (mem.axis === undefined && mem.phase === "start" && squads.some((sq) => riders(view, sq).length > 0)) mem.axis = 0;
      if (mem.axis === undefined) {
        const b0 = atan2(sy - tgt.y, sx - tgt.x), R = COMMANDER.supportM, half = 2 * 45;
        let best = 0, bestScore = -Infinity;
        for (const k of [0, -1, 1, -2, 2, -3, 3]) {
          const a = b0 + (k * COMMANDER.axisMaxDeg * PI) / 180 / 3;
          const cx = tgt.x + cos(a) * R, cy = tgt.y + sin(a) * R;
          if (cx < 40 || cy < 40 || cx > W - 40 || cy > H - 40) continue;
          const pts = [-half, 0, half].map((o) => ({ x: cx - sin(a) * o, y: cy + cos(a) * o }));
          let gap = Infinity;
          objectives.forEach((o, i) => { if (i !== mem.target && o.holder !== side) for (const p of pts) gap = Math.min(gap, hypot2(o.x - p.x, o.y - p.y)); });
          const score = Math.min(gap, COMMANDER.flankClearM) - Math.abs(k) * 1;
          if (score > bestScore) { bestScore = score; best = a - b0; }
        }
        mem.axis = best;
      }
      const ax = tgt.x + cos(mem.axis) * (sx - tgt.x) - sin(mem.axis) * (sy - tgt.y), ay = tgt.y + sin(mem.axis) * (sx - tgt.x) + cos(mem.axis) * (sy - tgt.y);
      const dx = tgt.x - ax, dy = tgt.y - ay, L = hypot2(dx, dy) || 1, ux = dx / L, uy = dy / L;
      /** Back to the start, each vehicle to its own spot in a line across the way in. */
      const back = (c: EntityId): Record<string, unknown> => {
        const off = (crews.indexOf(c) - (crews.length - 1) / 2) * 20;
        const end = { x: clamp(sx - uy * off, W), y: clamp(sy + ux * off, H), mode: "run" };
        // M7.4b: it first reverses out a little (its front and gun still toward the enemy), then turns for home.
        const vt = (() => { const vid = view.unit.get(c)?.vehicle; return vid === undefined ? undefined : view.transform.get(vid); })();
        if (!vt || hypot2(vt.x - sx, vt.y - sy) < COMMANDER.withdrawReverseM * 2) return { kind: "move", waypoints: [end] };
        return { kind: "move", waypoints: [{ x: clamp(vt.x - ux * COMMANDER.withdrawReverseM, W), y: clamp(vt.y - uy * COMMANDER.withdrawReverseM, H), mode: "run", reverse: true }, end] };
      };
      const vehiclesLost = ownVehicles.length > 0 && lostVehicles >= COMMANDER.vehicleLossShare * ownVehicles.length;
      if (mem.phase !== "withdraw" && mem.phase !== "hold" && (down > tolerance || vehiclesLost)) {
        // Squads within reach of their vehicle get back in (owner Q24); the others break contact on foot.
        mem.remount = [];
        const near = (uid: EntityId, men: EntityId[]): EntityId | undefined => {
          const vid = view.unit.get(uid)?.carrier;
          const v = vid === undefined ? undefined : view.vehicle.get(vid);
          const vt = vid === undefined ? undefined : view.transform.get(vid);
          const crew = crewOfVehicle(vid);
          if (!v || !vt || crew === undefined || v.status !== "ok") return undefined;
          const fit = men.filter((m) => able(view.soldier.get(m) as SoldierState | undefined));
          if (fit.length === 0) return undefined;
          const cx = fit.reduce((a, m) => a + view.transform.get(m)!.x, 0) / fit.length, cy = fit.reduce((a, m) => a + view.transform.get(m)!.y, 0) / fit.length;
          return hypot2(cx - vt.x, cy - vt.y) <= M.remountM ? crew : undefined;
        };
        for (const sq of squads) {
          const crew = near(sq, members(view, sq));
          if (riders(view, sq).length > 0 && crew !== undefined) { mem.remount.push(crew); continue; } // still aboard: ride back
          if (crew !== undefined) { order(sq, { kind: "mount" }); mem.remount.push(crew); } else order(sq, { kind: "withdraw", x: sx, y: sy });
        }
        const hqFoot = hq.filter((m) => (view.soldier.get(m) as SoldierState | undefined)?.mount === undefined);
        const hqCrew = tops.length > 0 ? near(tops[0]![0], hqFoot) : undefined;
        for (const m of hqFoot) order(m, hqCrew !== undefined ? { kind: "mount" } : { kind: "move", waypoints: [{ x: sx, y: sy, mode: "run" }] });
        if (hqCrew !== undefined && !mem.remount.includes(hqCrew)) mem.remount.push(hqCrew);
        // Vehicles with nobody to pick up go back at once.
        for (const c of crews) if (!mem.remount.includes(c) && vehicleOf(c)?.status === "ok") order(c, back(c));
        mem.phase = "withdraw"; mem.phaseTick = tick;
        return out;
      }
      // A vehicle drives back once its men are in (or after a minute).
      if (mem.phase === "withdraw" && (mem.remount?.length ?? 0) > 0) {
        mem.remount = mem.remount!.filter((c) => {
          const vid = view.unit.get(c)?.vehicle;
          const boarding = [...view.unit.values()].some((u) => u.boarding?.kind === "mount" && u.boarding.vehicle === vid);
          if (boarding && tick - mem.phaseTick < 60 * 60) return true;
          order(c, back(c));
          return false;
        });
      }
      // A squad still aboard close to an objective gets out to hold it [C29].
      if (mem.phase !== "start" && mem.phase !== "ride" && mem.phase !== "withdraw") {
        for (const sq of squads) {
          const vid = view.unit.get(sq)?.carrier;
          const vt = vid === undefined ? undefined : view.transform.get(vid);
          if (!vt || riders(view, sq).length === 0 || view.unit.get(sq)?.boarding) continue;
          if (objectives.some((o) => hypot2(o.x - vt.x, o.y - vt.y) <= M.holdDismountM + o.radiusM)) order(sq, { kind: "dismount" });
        }
      }
      const support = { x: clamp(tgt.x - ux * COMMANDER.supportM, W), y: clamp(tgt.y - uy * COMMANDER.supportM, H) };
      const lateral = (k: number) => ({ x: clamp(support.x - uy * k, W), y: clamp(support.y + ux * k, H) });
      /** The advance on foot to the support line: walk most of the way, sneak the last stretch (from where the
       *  squad is: men who got out near the line only sneak). */
      /** Can a man lying (or, failing that, kneeling) at (x, y) fire at (tx, ty), `hz` above the ground there? 1, 0.6, 0. */
      const posture = input.catalog.body.postures;
      const fireLine = (x: number, y: number, tx: number, ty: number, hz: number): number => {
        const ctx = ground();
        // ground: ok (the commander's view of the open ground)
        const z0 = heightAt(input.map, x, y), z1 = heightAt(input.map, tx, ty) + hz, d = hypot2(tx - x, ty - y);
        const ok = (h: number) => { const r = sight(ctx, x, y, z0 + h, tx, ty, z1); return r.blockedBy === null || (1 - r.blockedAt) * d <= COMMANDER.lineAllowanceM; };
        return ok(posture.prone.muzzleHeightM) ? 1 : ok(posture.crouching.muzzleHeightM) ? 0.6 : 0;
      };
      /** Support-by-fire places (balance pass 2026-11-13): each squad its slot on the support line, moved to the
       *  nearby spot (closer, farther, aside) with the best field of fire onto the objective; chosen once. */
      const slot = (i: number) => (i - (squads.length - 1) / 2) * (squads.length > 3 ? 45 : 60);
      const ensurePlaces = () => {
        if (mem.placesFor === mem.target && mem.places !== undefined) return;
        const foot = navFor(ground(), "foot").grid;
        const aims = [{ x: tgt.x, y: tgt.y }, ...[0, 1, 2, 3].map((k) => ({ x: tgt.x + cos((k * PI) / 2) * tgt.radiusM * 0.6, y: tgt.y + sin((k * PI) / 2) * tgt.radiusM * 0.6 }))];
        mem.places = {};
        squads.forEach((sq, i) => {
          let best: [number, number] | null = null, bestScore = -1;
          for (const dd of COMMANDER.placeDepthsM) for (const da of COMMANDER.placeAsideM) {
            const lat = slot(i) + da, d = COMMANDER.supportM + dd;
            const x = clamp(tgt.x - ux * d - uy * lat, W), y = clamp(tgt.y - uy * d + ux * lat, H);
            if (navCostAt(foot, x, y) <= 0 || indoorAt(ground(), x, y) >= 0) continue;
            const score = aims.reduce((a, t) => a + fireLine(x, y, t.x, t.y, 0.9), 0) - (Math.abs(dd) + Math.abs(da)) * 0.002;
            if (score > bestScore) { bestScore = score; best = [x, y]; }
          }
          const p = lateral(slot(i));
          mem.places![String(sq)] = best ?? [p.x, p.y];
        });
        mem.placesFor = mem.target;
      };
      /** A squad's place on the support line. */
      const placeOf = (i: number) => { ensurePlaces(); const p = mem.places?.[String(squads[i])]; return p ? { x: p[0], y: p[1] } : lateral(slot(i)); };
      const centre = (sq: EntityId): { x: number; y: number } | null => {
        const ms = members(view, sq).filter((m) => able(view.soldier.get(m) as SoldierState | undefined)).map((m) => view.transform.get(m)).filter((x) => x !== undefined);
        return ms.length > 0 ? { x: ms.reduce((a, b) => a + b.x, 0) / ms.length, y: ms.reduce((a, b) => a + b.y, 0) / ms.length } : null;
      };
      /** Under fire now: one of its men is being suppressed. */
      const underFire = (sq: EntityId) => members(view, sq).some((m) => { const s = view.soldier.get(m) as SoldierState | undefined; return able(s) && s!.mental.suppression >= COMMANDER.underFireSuppression; });
      /** Halted, not in a drill, getting in or out, broken or mostly pinned: free to be sent on. */
      const idle = (sq: EntityId) => {
        const u = view.unit.get(sq);
        if (!u || u.moving || u.drill || u.boarding || u.broken || riders(view, sq).length > 0) return false;
        const ms = members(view, sq).filter((m) => able(view.soldier.get(m) as SoldierState | undefined));
        const pinned = ms.filter((m) => { const b = view.soldier.get(m)!.mental.behaviour; return b === "pinned" || b === "panicked"; }).length;
        return ms.length > 0 && pinned * 2 < ms.length;
      };
      /** On (or past) its place on the support line: within `arrivedM` of it, measured along the way in. */
      const onLine = (sq: EntityId) => {
        const c = centre(sq), i = squads.indexOf(sq), p = placeOf(i < 0 ? 0 : i);
        return c !== null && (tgt.x - c.x) * ux + (tgt.y - c.y) * uy <= (tgt.x - p.x) * ux + (tgt.y - p.y) * uy + COMMANDER.arrivedM;
      };
      /** Gone to ground short of `p` (balance pass 2026-11-13): sent on after a short while, at a run under fire. */
      const sendOn = (sq: EntityId, p: { x: number; y: number }, run = false): boolean => {
        mem.resumeAt ??= {};
        const c = centre(sq);
        if (!c || hypot2(c.x - p.x, c.y - p.y) <= COMMANDER.arrivedM) return false;
        if (!idle(sq) || tick - (mem.resumeAt[String(sq)] ?? -1e9) < COMMANDER.resumeSeconds * 60) return true;
        // Sent on often enough (its place cannot be reached, or it keeps being stopped): it stays where it is.
        mem.resumeN ??= {};
        if ((mem.resumeN[String(sq)] ?? 0) >= COMMANDER.resumeMax) return false;
        mem.resumeN[String(sq)] = (mem.resumeN[String(sq)] ?? 0) + 1;
        order(sq, { kind: "move", waypoints: [{ x: p.x, y: p.y, mode: run || underFire(sq) ? "run" : "walk" }], facing: atan2(tgt.y - p.y, tgt.x - p.x) });
        mem.resumeAt[String(sq)] = tick;
        return true;
      };
      /** The assault position (balance pass 2026-11-13): `assaultPositionM` short of the objective, `ang` off the
       *  line of advance (toward the start), `off` across it. */
      const assaultPos = (ang: number, off = 0, dist: number = COMMANDER.assaultPositionM) => {
        const bx = -ux * cos(ang) + uy * sin(ang), by = -uy * cos(ang) - ux * sin(ang);
        return { x: clamp(tgt.x + bx * dist - by * off, W), y: clamp(tgt.y + by * dist + bx * off, H) };
      };
      /** Choose its bearing once: the candidate seen from the fewest of the objectives' edges and the enemies its men
       *  know, the straighter one when equal ("flanking along covered routes"). */
      const chooseFlank = (): number => {
        if (mem.flank !== undefined) return mem.flank;
        const eyes = [...objectives.flatMap((o) => [{ x: o.x - ux * o.radiusM, y: o.y - uy * o.radiusM }, { x: o.x - uy * o.radiusM, y: o.y + ux * o.radiusM }, { x: o.x + uy * o.radiusM, y: o.y - ux * o.radiusM }]),
          ...all.flatMap((m) => knownMen(m)).sort((a, b) => a.target - b.target).slice(0, 6)];
        const lim = (COMMANDER.flankMaxDeg * PI) / 180;
        let best = 0, bestScore = Infinity;
        for (const k of [0, -1, 1, -2, 2]) {
          const a = (k * lim) / 2, p = assaultPos(a);
          // (Away from the other objectives the enemy holds: their men would fire into its flank.)
          const exposed = objectives.filter((o, oi) => oi !== mem.target && view.objectives[oi]?.holder !== side && hypot2(o.x - p.x, o.y - p.y) < COMMANDER.flankClearM).length;
          const score = eyes.filter((e) => !hidden(e.x, e.y, p.x, p.y)).length + Math.abs(k) * 0.25 + exposed * 2;
          if (score < bestScore) { bestScore = score; best = a; }
        }
        mem.flank = best;
        return best;
      };
      const advance = (sq: EntityId, i: number) => {
        const p = placeOf(i);
        (mem.resumeAt ??= {})[String(sq)] = tick;
        const q = { x: clamp(p.x - ux * COMMANDER.sneakM, W), y: clamp(p.y - uy * COMMANDER.sneakM, H) };
        const ms = members(view, sq).map((m) => view.transform.get(m)).filter((x) => x !== undefined);
        const here = ms.length > 0 ? { x: ms.reduce((a, b) => a + b.x, 0) / ms.length, y: ms.reduce((a, b) => a + b.y, 0) / ms.length } : { x: sx, y: sy };
        const ahead = hypot2(q.x - tgt.x, q.y - tgt.y) < hypot2(here.x - tgt.x, here.y - tgt.y);
        order(sq, { kind: "move", waypoints: ahead ? [{ x: q.x, y: q.y, mode: "walk" }, { x: p.x, y: p.y, mode: "sneak" }] : [{ x: p.x, y: p.y, mode: "sneak" }], facing: atan2(uy, ux) });
      };
      // ---- vehicles after the dismount (M7.3, plan §12): fire free; German overwatch (they stay where they dropped
      // the squads), Russian following (each about followM behind its squad); support by fire on the objective.
      if (crews.length > 0 && mem.phase !== "start" && mem.phase !== "ride" && mem.phase !== "withdraw") {
        const fighting = crews.filter((c) => { const v = vehicleOf(c); return v !== undefined && (v.status === "ok" || v.status === "immobilised"); });
        if (!mem.crewsFree) { for (const c of fighting) order(c, { kind: "rules", fire: "free" }); mem.crewsFree = true; }
        const after = input.catalog.factions[force.faction]?.afterDismount;
        if (after?.kind === "follow") {
          mem.followAt ??= {};
          for (const c of fighting) {
            const vid = view.unit.get(c)?.vehicle;
            const sq = squads.find((u) => view.unit.get(u)?.carrier === vid);
            const v = vehicleOf(c), vt = vid === undefined ? undefined : view.transform.get(vid);
            if (sq === undefined || !v || !vt || v.status !== "ok" || riders(view, sq).length > 0 || view.unit.get(sq)?.boarding) continue;
            // A crew reversing out of danger (M7.4b) is left to it for a while.
            if (v.crewReaction === "reverseOut" && tick - v.reactionTick < COMMANDER.reverseOutHoldSeconds * 60) continue;
            const men = members(view, sq).filter((m) => able(view.soldier.get(m) as SoldierState | undefined)).map((m) => view.transform.get(m)).filter((x) => x !== undefined);
            if (men.length === 0) continue;
            const cx = men.reduce((a, b) => a + b.x, 0) / men.length, cy = men.reduce((a, b) => a + b.y, 0) / men.length;
            const px = clamp(cx - ux * after.followM, W), py = clamp(cy - uy * after.followM, H);
            const prev = mem.followAt[String(c)];
            // Only once the squad has moved on (and the vehicle is not on its way already).
            if (prev && hypot2(prev[0] - px, prev[1] - py) < COMMANDER.followReplanM) continue;
            if (hypot2(vt.x - px, vt.y - py) < COMMANDER.followReplanM) { mem.followAt[String(c)] = [px, py]; continue; }
            order(c, { kind: "move", waypoints: [{ x: px, y: py, mode: "walk" }], facing: atan2(uy, ux) });
            mem.followAt[String(c)] = [px, py];
          }
        }
        // Support by fire: during the assault each vehicle fires at an enemy its side knows near the objective,
        // never close to its own men on foot (they shift or stop, plan §12).
        if ((mem.phase === "assault" || mem.phase === "second") && tick - (mem.lastVehicleFire ?? -1e9) >= COMMANDER.supportFireEverySeconds * 60) {
          const used = new Set<number>();
          const ownFoot = all.filter((f) => { const s = view.soldier.get(f); return s !== undefined && s.mount === undefined && s.physiology.alive; }).map((f) => view.transform.get(f)).filter((x) => x !== undefined);
          for (const c of fighting) {
            let best: { target: EntityId; x: number; y: number } | null = null, bestD = 150;
            for (const m of all) for (const k of known(m)) {
              if (k.kind === "heard") continue;
              const d = hypot2(k.x - tgt.x, k.y - tgt.y) + (used.has(k.target) ? 60 : 0);
              if (d >= bestD) continue;
              if (ownFoot.some((f) => hypot2(f.x - k.x, f.y - k.y) < COMMANDER.vehicleFireNearOwnM)) continue;
              bestD = d; best = { target: k.target, x: k.x, y: k.y };
            }
            if (!best) continue;
            used.add(best.target);
            order(c, { kind: "fire", x: best.x, y: best.y, contact: best.target });
          }
          mem.lastVehicleFire = tick;
        }
      }
      /** What its men know of the enemy around the objective (seen or heard). */
      const knownNear = () => { let n = 0; for (const m of all) for (const c of known(m)) if (hypot2(c.x - tgt.x, c.y - tgt.y) < 150) n++; return n; };
      /** Blinding smoke (balance pass 2026-11-13): on the garrison of each other objective the enemy holds, which
       *  would fire into the flank of the attack, repeated as the cloud thins (while rounds last). */
      const blind = () => {
        if (tick - (mem.lastBlind ?? -1e9) < COMMANDER.smokeEverySeconds * 60) return;
        let any = false;
        objectives.forEach((o, i) => {
          if (i === mem.target || view.objectives[i]?.holder === side || supportLeft(view, side, "smoke") <= 0) return;
          order(caller, { kind: "callFire", x: clamp(o.x - ux * COMMANDER.blindAheadM, W), y: clamp(o.y - uy * COMMANDER.blindAheadM, H), ammo: "smoke", rounds: COMMANDER.smokeRounds });
          any = true;
        });
        if (any) mem.lastBlind = tick;
      };
      /** The fires before the assault: high explosive on the enemy its men know nearest the objective (else on it),
       *  and (balance pass 2026-11-13) smoke between the objective and the assault position, so that the assault
       *  element crosses the open ground under it. Each called once. */
      const prepFires = () => {
        if (supportLeft(view, side, "he") > 0 && mem.lastHe === undefined) {
          let hx = tgt.x, hy = tgt.y, best = 150;
          for (const m of all) for (const c of knownMen(m)) { const d = hypot2(c.x - tgt.x, c.y - tgt.y); if (d < best) { best = d; hx = c.x; hy = c.y; } }
          order(caller, { kind: "callFire", x: hx, y: hy, ammo: "he", rounds: Math.max(COMMANDER.heRounds, Math.floor(supportLeft(view, side, "he") / 4)) });
          mem.lastHe = tick;
        }
        if (supportLeft(view, side, "smoke") > 0 && mem.lastSmoke === undefined) {
          const sp = assaultPos(chooseFlank()), f = COMMANDER.screenShare;
          order(caller, { kind: "callFire", x: clamp(tgt.x + (sp.x - tgt.x) * f, W), y: clamp(tgt.y + (sp.y - tgt.y) * f, H), ammo: "smoke", rounds: COMMANDER.smokeRounds });
          mem.lastSmoke = tick;
        }
        blind();
      };
      switch (mem.phase) {
        case "start":
          toAll({ kind: "rules", fire: "return", onContact: "ground" });
          // Mounted (M7.2): the vehicles drive the squads to their dismount points; the squads ride.
          if (squads.some((sq) => riders(view, sq).length > 0)) {
            // The dismount point: this far short of the objective along the way in, the nearest point at or beyond
            // it out of sight of the objective (and of enemies its men know); none hidden: at the distance itself.
            // Each vehicle its own slot across the way in; "short of the objective" counts from every objective
            // (the nearer one may lie on a flank), and "out of sight" from the objectives' near edges.
            const known0 = all.flatMap((m) => known(m)).slice(0, 4);
            const eyes = [...objectives.flatMap((o) => [{ x: o.x - ux * o.radiusM, y: o.y - uy * o.radiusM }, { x: o.x - uy * o.radiusM, y: o.y + ux * o.radiusM }, { x: o.x + uy * o.radiusM, y: o.y - ux * o.radiusM }]), ...known0];
            const carried = crews.filter((c) => squads.some((sq) => view.unit.get(sq)?.carrier === view.unit.get(c)?.vehicle) || topIds.some((tp) => view.unit.get(tp)?.carrier === view.unit.get(c)?.vehicle));
            carried.forEach((c, i) => {
              const off = (i - (carried.length - 1) / 2) * COMMANDER.vehicleSlotM;
              // The headquarters' vehicle a little behind the others.
              const hqV = topIds.some((tp) => view.unit.get(tp)?.carrier === view.unit.get(c)?.vehicle) && !squads.some((sq) => view.unit.get(sq)?.carrier === view.unit.get(c)?.vehicle);
              const behind = hqV ? 40 : 0;
              const at = (d: number) => ({ x: clamp(tgt.x - ux * d - uy * off, W), y: clamp(tgt.y - uy * d + ux * off, H) });
              const far = (p: { x: number; y: number }) => objectives.every((o) => hypot2(o.x - p.x, o.y - p.y) >= dismountM);
              // The first point far enough from every objective, then up to 100 m farther back for one out of sight.
              let k0 = 0;
              while (k0 < 20 && !far(at(dismountM + behind + k0 * COMMANDER.dismountStepM))) k0++;
              const first = at(dismountM + behind + k0 * COMMANDER.dismountStepM);
              let spot: { x: number; y: number } | null = null;
              for (let k = k0; k < k0 + COMMANDER.dismountCandidates && spot === null; k++) {
                const p = at(dismountM + behind + k * COMMANDER.dismountStepM);
                if (eyes.every((e) => hidden(e.x, e.y, p.x, p.y))) spot = p;
              }
              const p = spot ?? first;
              order(c, { kind: "move", waypoints: [{ x: p.x, y: p.y, mode: "run" }], facing: atan2(uy, ux) });
            });
            toAll({ kind: "rules", fire: "return" });
            mem.out = [];
            mem.phase = "ride"; mem.phaseTick = tick;
            break;
          }
          // Walk most of the way, sneak the last stretch to the support line (M6.5b); routes keep to cover as
          // the faction's doctrine prefers (systems/orders.ts).
          squads.forEach((sq, i) => advance(sq, i));
          for (const m of hq) order(m, { kind: "move", waypoints: [{ x: support.x - ux * 30, y: support.y - uy * 30, mode: "walk" }] });
          mem.phase = "advance"; mem.phaseTick = tick;
          break;
        case "ride": {
          // An anti-tank threat (M7.4b, plan §12): enemy men its crews know close to the carrier (any of them may
          // carry a Panzerfaust or an RPG), or an enemy vehicle seen: out at once.
          const crewKnown = crews.flatMap((c) => view.unit.get(c)?.members ?? []).flatMap((m) => known(m));
          const atThreat = (vid: EntityId): boolean => {
            const vt = view.transform.get(vid);
            if (!vt) return false;
            return crewKnown.some((c) => c.wreck !== true && tick - c.tick <= 60 * 60 && c.kind !== "heard"
              && hypot2(c.x - vt.x, c.y - vt.y) <= (c.cls === "vehicle" ? (c.kind === "seen" ? COMMANDER.dismountThreatVehicleM : 0) : COMMANDER.dismountThreatMenM));
          };
          // Out when its vehicle has arrived, at once when a vehicle was hit, or after the ride has taken too long:
          // the squad is ordered to its support-line position and gets out first (Q12).
          const late = tick - mem.phaseTick >= COMMANDER.rideTimeoutSeconds * 60;
          mem.out ??= [];
          squads.forEach((sq, i) => {
            if (mem.out!.includes(sq)) return;
            const vid = view.unit.get(sq)?.carrier;
            const v = vid === undefined ? undefined : view.vehicle.get(vid);
            const there = v === undefined || v.drive.arrived || v.drive.routeIdx >= v.drive.route.length || v.status !== "ok";
            if (riders(view, sq).length > 0 && !(there || hitNow || late || (vid !== undefined && atThreat(vid)))) return;
            advance(sq, i);
            mem.out!.push(sq);
          });
          const hqIn = hq.filter((m) => (view.soldier.get(m) as SoldierState | undefined)?.mount !== undefined);
          const hqV = tops.length > 0 ? view.unit.get(tops[0]![0])?.carrier : undefined;
          const hv = hqV === undefined ? undefined : view.vehicle.get(hqV);
          if (hqIn.length > 0 && !mem.out.includes(-1) && (hv === undefined || hv.drive.arrived || hitNow || late || (hqV !== undefined && atThreat(hqV)))) {
            for (const m of hqIn) order(m, { kind: "move", waypoints: [{ x: support.x - ux * 30, y: support.y - uy * 30, mode: "walk" }] });
            mem.out.push(-1);
          }
          if (squads.every((sq) => mem.out!.includes(sq))) { mem.phase = "advance"; mem.phaseTick = tick; }
          break;
        }
        case "advance": {
          // (A squad still getting out before its move has not arrived.) A squad that went to ground on contact
          // short of its place moves on to it (balance pass 2026-11-13: it used to count as arrived, and the base
          // of fire lay 430-480 m out, beyond the reach of its rifles).
          let short = 0;
          squads.forEach((sq, i) => { if (strength(sq) >= 0.5 && !onLine(sq) && sendOn(sq, placeOf(i))) short++; });
          // (Two thirds of the squads in place is enough: the others come on as the fires go in.)
          const placed = squads.filter((sq) => onLine(sq) && !view.unit.get(sq)?.boarding).length;
          const arrived = (short === 0 && squads.every((sq) => !view.unit.get(sq)?.boarding && (onLine(sq) || !view.unit.get(sq)?.moving))) || placed * 3 >= squads.length * 2;
          // The first squad nearing the line: the fires are called now, to land about as the squads arrive.
          if (squads.some((sq) => { const c = centre(sq); return c !== null && (tgt.x - c.x) * ux + (tgt.y - c.y) * uy <= COMMANDER.supportM + COMMANDER.prepLeadM; })) prepFires();
          if (arrived || tick - mem.phaseTick > COMMANDER.advanceTimeoutSeconds * 60) { mem.phase = "recon"; mem.phaseTick = tick; toAll({ kind: "rules", fire: "free" }); }
          break;
        }
        case "recon": {
          // Look for the enemy around the objective before going in (what the men have seen or heard); call the
          // mortars (they take a minute or more) unless already called, and go in when their rounds are landing.
          prepFires();
          const fireLanding = mem.lastHe === undefined || tick - mem.lastHe >= (fireDelayS + 10) * 60;
          if ((knownNear() > 0 && fireLanding) || tick - mem.phaseTick >= Math.max(COMMANDER.reconSeconds, fireDelayS + 30) * 60) { mem.phase = "assault"; mem.phaseTick = tick; mem.lastAssault = {}; mem.closed = []; mem.resumeN = {}; }
          break;
        }
        case "hold":
          // The enemy has taken an objective back: go for it again.
          if (objectives.some((_, i) => !holds(i))) { mem.target = objectives.findIndex((_, i) => !holds(i)); mem.phase = mem.target === 0 ? "assault" : "second"; mem.phaseTick = tick; mem.lastAssault = {}; }
          break;
        case "assault":
        case "second": {
          // In the second phase, the main objective lost again comes first.
          if (mem.phase === "second" && !holds(0)) { mem.target = 0; mem.phase = "assault"; mem.lastAssault = {}; }
          if (holds(mem.target)) {
            // Then the next objective the enemy still holds, the main one first; the main one is assaulted afresh
            // (closing in, then fire and movement), any other by the strongest squad.
            const next = objectives.findIndex((_, i) => !holds(i));
            if (next >= 0) {
              mem.target = next; mem.phase = next === 0 ? "assault" : "second"; mem.phaseTick = tick; mem.lastAssault = {};
              delete mem.flank; delete mem.axis;
              if (next === 0) { mem.closed = []; mem.resumeN = {}; }
            } else { mem.phase = "hold"; toAll({ kind: "posture", posture: "prone" }); }
            break;
          }
          // The base of fire: the first squad still standing (in the second phase the weakest), the rest assault.
          const live = squads.filter((sq) => strength(sq) > 0);
          if (live.length === 0) break;
          const ranked = mem.phase === "second" ? [...live].sort((a, b) => strength(a) - strength(b) || a - b) : live;
          // Mortars (M6.5c): high explosive on the enemies its men know near the objective (else on it), smoke on
          // its near edge to blind them while the assault goes in; repeated while rounds last.
          // (Its own men near the point now, or squads assaulting toward it — they will be there when the rounds land.)
          const ownNear = (px: number, py: number, r: number) => all.some((f) => { const ft = view.transform.get(f); return ft !== undefined && view.soldier.get(f)?.physiology.alive === true && hypot2(ft.x - px, ft.y - py) < r; })
            || squads.some((sq) => { const d = view.unit.get(sq)?.drill; return d !== null && d !== undefined && d.kind === "assault" && hypot2(d.x - px, d.y - py) < 150; });
          if (supportLeft(view, side, "he") > 0 && tick - (mem.lastHe ?? -1e9) >= COMMANDER.heEverySeconds * 60) {
            let hx = tgt.x, hy = tgt.y, best = 150;
            for (const m of all) for (const c of knownMen(m)) { const d = hypot2(c.x - tgt.x, c.y - tgt.y); if (d < best) { best = d; hx = c.x; hy = c.y; } }
            if (!ownNear(hx, hy, 90)) { order(caller, { kind: "callFire", x: hx, y: hy, ammo: "he", rounds: Math.max(COMMANDER.heRounds, Math.floor(supportLeft(view, side, "he") / 4)) }); mem.lastHe = tick; }
          }
          if (mem.phase === "assault") blind();
          if (supportLeft(view, side, "smoke") > 0 && tick - (mem.lastSmoke ?? -1e9) >= COMMANDER.smokeEverySeconds * 60) {
            // (On the assault position's side of the objective.)
            const ap = assaultPos(chooseFlank()), af = COMMANDER.smokeAheadM / COMMANDER.assaultPositionM;
            const sx3 = clamp(tgt.x + (ap.x - tgt.x) * af, W), sy3 = clamp(tgt.y + (ap.y - tgt.y) * af, H);
            order(caller, { kind: "callFire", x: sx3, y: sy3, ammo: "smoke", rounds: COMMANDER.smokeRounds });
            mem.lastSmoke = tick;
          }
          // Half the squads fire (at least one), the others assault (M6.5b).
          const nBase = live.length > 1 ? Math.max(1, Math.floor(live.length / 2)) : 0;
          const bases = ranked.slice(0, nBase);
          const assaulters = live.length > 1 ? live.filter((sq) => !bases.includes(sq)) : [ranked[0]!];
          if (bases.length > 0 && tick - mem.lastFire >= COMMANDER.refireSeconds * 60) {
            // Distribution of fire (balance pass 2026-11-13): each man of the base of fire at another enemy its men
            // know near the objective, at the full rate; fire lifts off an enemy its own men are close to (they
            // are going in there); none known: at the objective while it is clear of its own men.
            const ownFoot = all.filter((f) => { const s = view.soldier.get(f) as SoldierState | undefined; return able(s) && s!.mount === undefined && !bases.includes(view.identity.get(f)?.unit ?? -1); })
              .map((f) => view.transform.get(f)).filter((x) => x !== undefined);
            const clear = (x: number, y: number) => !ownFoot.some((f) => hypot2(f.x - x, f.y - y) < COMMANDER.liftM);
            /** The enemies the base's men know within `r` of (px, py), not near its own men, in a fixed order. */
            const near = (px: number, py: number, r: number): [EntityId, { x: number; y: number }][] => {
              const targets = new Map<EntityId, { x: number; y: number }>();
              for (const base of bases) for (const m of members(view, base)) for (const c of knownMen(m)) {
                if (hypot2(c.x - px, c.y - py) > r || targets.has(c.target)) continue;
                targets.set(c.target, { x: c.x, y: c.y });
              }
              return [...targets.entries()].sort((a, b) => a[0] - b[0]).filter(([, p]) => clear(p.x, p.y));
            };
            // One squad of the base keeps the other objective's garrison down while the main one is attacked
            // (it lies on the flank of the way in), when the base has two squads or more.
            const other = mem.target === 0 && objectives.length > 1 && !holds(1) && bases.length > 1 ? objectives[1]! : null;
            const mainList = near(tgt.x, tgt.y, 120);
            const sideList = other ? near(other.x, other.y, other.radiusM + 30) : [];
            let k = 0;
            bases.forEach((base, bi) => {
              if (mem.maxRate?.includes(base) !== true) { order(base, { kind: "rules", ammo: "max" }); (mem.maxRate ??= []).push(base); }
              const flankBase = other !== null && bi === bases.length - 1;
              const list = flankBase ? sideList : mainList, aim = flankBase ? other : tgt;
              for (const m of members(view, base)) {
                if (!able(view.soldier.get(m) as SoldierState | undefined) || view.action.has(m)) continue;
                // (The next enemy on the list he has a line of fire to; none: the objective, if he can fire at it.)
                const mt = view.transform.get(m);
                if (!mt) continue;
                let done = false;
                for (let j = 0; j < list.length && !done; j++) {
                  const [id, p] = list[(k + j) % list.length]!;
                  if (fireLine(mt.x, mt.y, p.x, p.y, 0.9) > 0) { order(m, { kind: "fire", x: p.x, y: p.y, contact: id }); k += j + 1; done = true; }
                }
                if (!done && clear(aim.x, aim.y) && fireLine(mt.x, mt.y, aim.x, aim.y, 0.5) > 0) order(m, { kind: "fire", x: aim.x, y: aim.y, heightM: 0.5 });
              }
            });
            mem.lastFire = tick;
          }
          // Close in: grenades at an enemy an assaulting squad knows within throwing range (M6.5b); from the
          // assault position on (balance pass 2026-11-13) also its grenade launchers, at the nearest enemy it knows
          // within their reach (the order's men pick hand grenade or launcher by range).
          mem.lastGrenade ??= {};
          for (const sq of assaulters) {
            if (tick - (mem.lastGrenade[String(sq)] ?? -1e9) < COMMANDER.grenadeEverySeconds * 60) continue;
            const reach = mem.closed?.includes(sq) === true ? COMMANDER.launcherReachM : COMMANDER.grenadeRangeM;
            const men = members(view, sq).filter((m) => able(view.soldier.get(m) as SoldierState | undefined));
            let hit: { x: number; y: number } | null = null, hitD = Infinity;
            for (const m of men) {
              const t = view.transform.get(m);
              if (!t) continue;
              for (const c of knownMen(m)) {
                const dc = hypot2(c.x - t.x, c.y - t.y);
                if (dc > reach || dc >= hitD) continue;
                // Never where a friend is close to the burst.
                if (all.some((f) => { const ft = view.transform.get(f); return ft !== undefined && view.soldier.get(f)?.physiology.alive === true && hypot2(ft.x - c.x, ft.y - c.y) < 15; })) continue;
                hit = { x: c.x, y: c.y }; hitD = dc;
              }
            }
            if (hit) { order(sq, { kind: "grenade", x: hit.x, y: hit.y, count: 2 }); mem.lastGrenade[String(sq)] = tick; }
          }
          // The assault element first runs to the assault position (once, in the first phase), then assaults.
          mem.closed ??= [];
          const flank = chooseFlank();
          assaulters.forEach((sq, i) => {
            if (mem.closed!.includes(sq)) return;
            const off = (i - (assaulters.length - 1) / 2) * 25;
            const late = mem.phase === "second" || tick - mem.phaseTick >= COMMANDER.closeTimeoutSeconds * 60;
            // Not under fire, it goes on past the assault position to `closeInM`; under fire within reach of it,
            // it goes over to fire and movement from where it is.
            const c = centre(sq), d = c === null ? 0 : hypot2(c.x - tgt.x, c.y - tgt.y);
            const there = d <= COMMANDER.closeInM + COMMANDER.arrivedM || (d <= COMMANDER.assaultPositionM + COMMANDER.arrivedM && underFire(sq));
            if (late || there || !sendOn(sq, assaultPos(flank, off, COMMANDER.closeInM), true)) mem.closed!.push(sq);
          });
          assaulters.forEach((sq, i) => {
            const u = view.unit.get(sq);
            const last = mem.lastAssault[String(sq)] ?? -1e9;
            if (!mem.closed!.includes(sq)) return;
            if (u && !u.drill && !u.broken && strength(sq) >= 0.5 && tick - last >= COMMANDER.reassaultSeconds * 60) {
              const off = (i - (assaulters.length - 1) / 2) * 20;
              order(sq, { kind: "assault", x: clamp(tgt.x - uy * off, W), y: clamp(tgt.y + ux * off, H) });
              mem.lastAssault[String(sq)] = tick;
            }
          });
          break;
        }
        default:
          break;
      }
      return out;
    },
    saveState: () => JSON.parse(JSON.stringify(mem)) as unknown,
    loadState: (d) => { mem = JSON.parse(JSON.stringify(d)) as Memory; },
  };
}

function clamp(v: number, max: number): number { return Math.min(Math.max(v, 5), max - 5); }
