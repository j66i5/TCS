/**
 * A fixed script for demonstrations and regression tests (not an AI): the side's top-level units go prone,
 * open fire on the middle of the enemy, renew the order now and then, send one grenade from a launcher or a
 * hand, and cease fire at the end. It has no memory: what it orders depends only on the tick and the view.
 */
import { secondsToTicks, type Controller, type Order, type SideId, type SimView } from "@tcs/sim";

export interface ShootoutScript { proneAtS: number; fireAtS: number; renewEveryS: number; grenadeAtS: number; ceaseAtS: number }

export const DEFAULT_SHOOTOUT: ShootoutScript = { proneAtS: 0, fireAtS: 6, renewEveryS: 20, grenadeAtS: 45, ceaseAtS: 150 };

export function shootoutController(side: SideId, script: ShootoutScript = DEFAULT_SHOOTOUT): Controller {
  const at = (s: number) => secondsToTicks(s);
  return {
    side,
    think(view: SimView, tick: number): Order[] {
      const fire = tick >= at(script.fireAtS) && tick < at(script.ceaseAtS) && (tick - at(script.fireAtS)) % at(script.renewEveryS) === 0;
      const prone = tick === at(script.proneAtS), grenade = tick === at(script.grenadeAtS), cease = tick === at(script.ceaseAtS);
      if (!fire && !prone && !grenade && !cease) return [];
      // Middle of the enemy's living men.
      let ex = 0, ey = 0, n = 0;
      for (const [id, ident] of view.identity.entries()) {
        if (ident.side === side || view.soldier.get(id)?.physiology.alive !== true) continue;
        const t = view.transform.get(id);
        if (t) { ex += t.x; ey += t.y; n++; }
      }
      const out: Order[] = [];
      for (const [uid, u] of view.unit.entries()) {
        if (u.side !== side || u.parent !== null) continue;
        if (prone) out.push({ tick, issuer: side, target: uid, kind: "posture", posture: "prone" });
        if (cease) out.push({ tick, issuer: side, target: uid, kind: "ceaseFire" });
        if (n === 0) continue;
        if (fire) out.push({ tick, issuer: side, target: uid, kind: "fire", x: ex / n, y: ey / n, heightM: 0.3 });
        if (grenade) out.push({ tick, issuer: side, target: uid, kind: "grenade", x: ex / n, y: ey / n });
      }
      return out;
    },
  };
}
