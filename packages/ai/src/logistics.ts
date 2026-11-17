/**
 * THE COMMANDER'S LOGISTICS (M11.8, plan slice 52 point 1). Most of a side's supply runs in the sim the same for both
 * sides and for the player (squads ask, the platoon sends bearers, a supply point low or a squad asking calls a
 * delivery, idle hulls re-arm and refuel, the mortar men fetch rounds, M11.3-M11.5); the commander shells enemy caches
 * it has seen (commander.ts, M11.3). This adds what only a commander decides, as orders (rule 3):
 *
 * - **A threatened supply point** (an enemy its men know within `supply.site.threatM` of it — seen, or placed to within
 *   half that: review fix, one stray report must not move a full point — while it still holds
 *   ammunition): the platoon's supply point moves back, away from that enemy (`supplyPoint`: the crates left there
 *   become a plain cache that the squads near it still use; the next delivery and the bearers go to the new point),
 *   and men of the side within `request.useM` of the old one who are short fill up there before it is lost
 *   (`resupplyAt`, each man). Once per point.
 * - **A low squad far from its supply** (below `request.below` of its standard load, quiet for `quietS`, halted, no
 *   drill, no known enemy within `enemyClearM`, no bearers on their way, no own crate within `request.useM`): its
 *   shortest men, at most half of its able men, go to the nearest own cache within `supply.take.reachM` (a captured
 *   enemy cache too) and come back (`resupplyAt`). The other half stays: a held position is never stripped. At most
 *   every `squadEveryS` per squad.
 *
 * Values not from data are listed in LOGISTICS_AI (game values, low).
 */
import { cacheHolds, hypot2, roundsOfMan, type Contact, type EntityId, type Order, type SideId, type SimContext, type SimView } from "@tcs/sim";

export const LOGISTICS_AI = { lookSeconds: 10, quietS: 30, enemyClearM: 200, squadEveryS: 120, fillUpMax: 4, manShareBelow: 0.5 } as const;

export interface LogisticsMemory {
  /** Supply point caches moved back from a threat (one move each), the last look, each squad's last errand. */
  pointsMoved?: number[]; lastLogisticsLook?: number; cacheErrand?: Record<string, number>;
}

/** Does this cache hold anything the side can take (not burning, not being carried)? */
function full(view: SimView, cid: EntityId, side: SideId): boolean {
  const c = view.cache.get(cid);
  return c !== undefined && c.side === side && c.cookoff === undefined && c.burnt !== true && c.carried !== true && cacheHolds(view.container.get(cid));
}

/** Does the cache hold rounds for any of these men's weapons (a magazine, belt or package of their cartridge with
 *  rounds in it)? Review fix: as the sim's own test (`takePlan`) — never a trip to a pile of the wrong calibre. */
function fits(ctx: SimContext, view: SimView, cid: EntityId, men: readonly EntityId[]): boolean {
  const k = view.container.get(cid);
  if (!k) return false;
  const carts = new Set<string>();
  for (const m of men) {
    const w = view.weapon.get(m), wd = w ? ctx.catalog.weapons[w.weapon] : undefined;
    const cart = wd ? ctx.catalog.items[wd.feed.magazine]?.chargeItem : undefined;
    if (cart !== undefined) carts.add(cart);
  }
  for (const s of k.stacks) {
    const d = ctx.catalog.items[s.type];
    if (s.count > 0 && (s.charge ?? 0) > 0 && d?.chargeItem !== undefined && (d.category === "magazine" || d.category === "ammo-package") && carts.has(d.chargeItem)) return true;
  }
  return false;
}

/** The orders of this look (at most every `lookSeconds`). */
export function logisticsOrders(view: SimView, ctx: SimContext, side: SideId, tick: number, mem: LogisticsMemory, contactsOf: () => readonly Contact[]): Order[] {
  const S = ctx.catalog.supply;
  if (!S || ctx.rules.resupply === false || view.cache.size === 0) return [];
  if (tick - (mem.lastLogisticsLook ?? -1e9) < LOGISTICS_AI.lookSeconds * 60) return [];
  mem.lastLogisticsLook = tick;
  const out: Order[] = [];
  let contacts: readonly Contact[] | null = null;
  const enemies = () => (contacts ??= contactsOf().filter((c) => c.down !== true && c.surrendered !== true));
  // (A threat to a supply point: seen, or placed well enough to be one.)
  const sure = (c: Contact) => c.kind === "seen" || c.errM <= S.site.threatM * 0.5;
  const nearestEnemy = (x: number, y: number, only?: (c: Contact) => boolean) => {
    let best: Contact | null = null, d = Infinity;
    for (const c of enemies()) { if (only && !only(c)) continue; const e = hypot2(c.x - x, c.y - y); if (e < d) { d = e; best = c; } }
    return { c: best, d };
  };
  // ---- a threatened supply point moves back; men near it fill up first
  const moved = (mem.pointsMoved ??= []);
  for (const [, p] of view.rear.entries()) {
    if (p.kind !== "supply" || p.side !== side || p.cache === undefined || moved.includes(p.cache) || !full(view, p.cache, side)) continue;
    const t = view.transform.get(p.cache);
    if (!t) continue;
    const n = nearestEnemy(t.x, t.y, sure);
    if (n.c === null || n.d > S.site.threatM) continue;
    moved.push(p.cache);
    const ux = n.d > 1 ? (t.x - n.c.x) / n.d : 0, uy = n.d > 1 ? (t.y - n.c.y) / n.d : 0;
    const W = ctx.map.widthM, H = ctx.map.heightM;
    const x = Math.min(Math.max(t.x + ux * S.site.backM, 10), W - 10), y = Math.min(Math.max(t.y + uy * S.site.backM, 10), H - 10);
    out.push({ tick, issuer: side, target: p.unit, kind: "supplyPoint", x, y });
    // (Men of the side close by who are short take what they can carry before it is lost.)
    const near: { m: EntityId; share: number }[] = [];
    const R = S.request;
    // mounted: ok men aboard are skipped below
    for (const [m, so] of view.soldier.entries()) {
      if (view.identity.get(m)?.side !== side || so.captive !== null || !so.physiology.alive || so.physiology.consciousness < 0.5 || so.mount !== undefined || so.intent !== null) continue;
      const mt = view.transform.get(m);
      if (!mt || !R || hypot2(mt.x - t.x, mt.y - t.y) > R.useM) continue;
      const r = roundsOfMan(ctx, view, m);
      if (r.full > 0 && r.rounds < r.full) near.push({ m, share: r.rounds / r.full });
    }
    near.sort((a, b) => a.share - b.share || a.m - b.m);
    for (const x of near.slice(0, LOGISTICS_AI.fillUpMax)) out.push({ tick, issuer: side, target: x.m, kind: "resupplyAt", cache: p.cache });
  }
  // ---- a low squad far from its supply: half of it to the nearest own cache and back
  const R = S.request;
  if (!R) return out;
  const errand = (mem.cacheErrand ??= {});
  for (const [uid, u] of view.unit.entries()) {
    if (u.side !== side || u.parent === null || u.vehicle !== undefined || u.asset !== undefined || u.mortar !== undefined || u.missileTeam !== undefined) continue;
    if (u.moving || u.drill !== null || u.broken || tick - (u.ownFireTick ?? -1e9) < LOGISTICS_AI.quietS * 60) continue;
    if (tick - (errand[String(uid)] ?? -1e9) < LOGISTICS_AI.squadEveryS * 60) continue;
    if ((u.supplyAsk?.bearers?.length ?? 0) > 0) continue;
    const men: { m: EntityId; share: number; x: number; y: number }[] = [];
    let rounds = 0, fullR = 0;
    for (const m of u.members) {
      const so = view.soldier.get(m), mt = view.transform.get(m);
      if (!so || !mt || so.captive !== null || !so.physiology.alive || so.physiology.consciousness < 0.5 || so.mount !== undefined || so.atNest !== undefined || !so.impair.canWalk) continue;
      const r = roundsOfMan(ctx, view, m);
      rounds += r.rounds; fullR += r.full;
      men.push({ m, share: r.full > 0 ? r.rounds / r.full : 1, x: mt.x, y: mt.y });
    }
    if (men.length < 2 || fullR <= 0 || rounds / fullR >= R.below) continue;
    const cx = men.reduce((a, q) => a + q.x, 0) / men.length, cy = men.reduce((a, q) => a + q.y, 0) / men.length;
    if (nearestEnemy(cx, cy).d < LOGISTICS_AI.enemyClearM) continue;
    const go = men.filter((q) => q.share < LOGISTICS_AI.manShareBelow).sort((a, b) => a.share - b.share || a.m - b.m).slice(0, Math.floor(men.length / 2));
    if (go.length === 0) continue;
    const goIds = go.map((q) => q.m);
    let pick: EntityId | null = null, bestD = S.take.reachM, closeBy = false;
    for (const [cid] of view.cache.entries()) {
      if (!full(view, cid, side) || !fits(ctx, view, cid, goIds)) continue;
      const ct = view.transform.get(cid);
      if (!ct) continue;
      const d = hypot2(ct.x - cx, ct.y - cy);
      if (d <= R.useM) { closeBy = true; break; }
      if (d < bestD) { bestD = d; pick = cid; }
    }
    if (closeBy || pick === null) continue; // (a crate beside them: the sim's own rule; none in reach: the bearers)
    errand[String(uid)] = tick;
    for (const q of go) out.push({ tick, issuer: side, target: q.m, kind: "resupplyAt", cache: pick });
  }
  return out;
}
