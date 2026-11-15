/**
 * What the map shows beyond the units (from the `main.ts` split, D2): the floor switch (M7.5d), the "last seen"
 * pins (S8) and the debug sight overlay. Read-only views of the state.
 */
import { eyeHeightM, floorOf, heightAt, indoorAt, isOut, sight, standZ, unitSoldiers, type EntityId } from "@tcs/sim";
import type { Overlay } from "@tcs/render";
import { createFloorSwitch, followFloor, unitFloor } from "@tcs/ui";
import type { App } from "./app";

/** The floor switch: follows the selected unit's floor; shown when it is indoors or a house is opened up. Returns
 *  the per-frame update. */
export function attachFloors(a: App, hudRoot: HTMLElement): () => void {
  const floorSwitch = createFloorSwitch(hudRoot, a.strings.t("ui.floor"), a.strings.t("ui.floor.ground"), (f) => { a.floorPick = f; });
  return () => {
    const uid = a.overlay.selectedUnit, st = a.sim.state, map = a.input.map;
    let fl: number | null = null, count = 1;
    if (uid !== null && st.unit.has(uid)) {
      const floors: number[] = [];
      for (const m of unitSoldiers(st, uid)) {
        const ms = st.soldier.get(m), t = st.transform.get(m);
        if (!ms || !t || ms.mount !== undefined || !ms.physiology.alive) continue;
        const bi = indoorAt(a.sim.ctx, t.x, t.y);
        if (bi < 0) { floors.push(-1); continue; }
        floors.push(floorOf(a.sim.ctx, t.x, t.y, t.z));
        count = Math.max(count, map.buildings[bi]!.storeys);
      }
      fl = unitFloor(floors);
    }
    // Zoomed in close (roofs lifted): the tallest building with an interior in view.
    const r = a.renderer, cam = r.camera;
    if ((r.zoomLevel() ?? 0) >= 3) {
      const hw = r.app.screen.width / cam.scale / 2, hh = r.app.screen.height / cam.scale / 2;
      for (const b of map.buildings) {
        if (!b.interior || b.storeys <= count) continue;
        const x = b.footprint[0]!, y = b.footprint[1]!;
        if (Math.abs(x - cam.x) < hw + 20 && Math.abs(y - cam.y) < hh + 20) count = b.storeys;
      }
    }
    a.floorState = followFloor(a.floorState, uid, fl, a.floorPick, count - 1);
    a.floorPick = null;
    floorSwitch.set(count, a.floorState.shown);
    a.overlay.floor = count > 1 ? a.floorState.shown : 0;
  };
}

type EyePt = { x: number; y: number; z: number; ignore: number };
/** Own men on foot (eyes) and crewed own hulls (sights) that can look now. */
function ownEyes(a: App): EyePt[] {
  const eyes: EyePt[] = [], st = a.sim.state, map = a.input.map;
  // mounted: ok men aboard are skipped (their hull's sights are added below)
  for (const [id, s] of st.soldier.entries()) {
    if (s.mount !== undefined || isOut(s) || s.physiology.consciousness < 0.5 || st.identity.get(id)?.side !== a.playerSide) continue;
    const t = st.transform.get(id);
    if (t) eyes.push({ x: t.x, y: t.y, z: standZ(map, t) + eyeHeightM(a.sim.ctx, s.posture), ignore: -1 });
  }
  for (const [vid, v] of st.vehicle.entries()) {
    if (v.side !== a.playerSide || v.unit === null || v.status === "destroyed" || v.status === "abandoned") continue;
    const t = st.transform.get(vid);
    if (t) eyes.push({ x: t.x, y: t.y, z: heightAt(map, t.x, t.y) + 2.3, ignore: vid });
  }
  return eyes;
}

/** A spot is seen empty when one of the 3 nearest own eyes within range (200 m; a hull's spot 600 m) has it in clear
 *  view: for a man, low enough to see one lying there (0.4 m), for a hull 1.5 m up. */
const SEEN_EMPTY_M = 200, SEEN_EMPTY_HULL_M = 600;
let pinsTick = -1;
/** S8: the side's "last seen" pins, and whether own men see a pin's spot empty (once per tick). */
export function updatePins(a: App, known: NonNullable<Overlay["known"]>): void {
  const tick = a.sim.state.tick;
  if (pinsTick === tick) return;
  pinsTick = tick;
  a.lastSeen.update(known, tick);
  let eyes: EyePt[] | null = null;
  a.lastSeen.look(tick, (p) => {
    eyes ??= ownEyes(a);
    const R = p.cls === "vehicle" ? SEEN_EMPTY_HULL_M : SEEN_EMPTY_M;
    const near = eyes.map((e) => ({ e, d: (e.x - p.x) ** 2 + (e.y - p.y) ** 2 })).filter((x) => x.d <= R * R).sort((x, y) => x.d - y.d).slice(0, 3);
    const tz = heightAt(a.input.map, p.x, p.y) + (p.cls === "vehicle" ? 1.5 : 0.4);
    return near.some(({ e }) => { const v = sight(a.sim.ctx, e.x, e.y, e.z, p.x, p.y, tz, e.ignore); return v.blockedBy === null && v.visibility >= 0.6; });
  });
}

/** Debug: what the selected unit's leader can see of a kneeling man, within 400 m, every 10 m. */
export function sightView(a: App) {
  const st = a.sim.state, map = a.input.map;
  const uid = a.overlay.selectedUnit;
  const u = uid === null ? undefined : st.unit.get(uid);
  // The leader, or the first of the unit's men who is alive and conscious.
  const able = (id: EntityId) => { const x = st.soldier.get(id); return x !== undefined && x.physiology.alive && x.physiology.consciousness >= 0.5; };
  const leader = u?.leader ?? u?.members.find(able);
  const t = leader === undefined ? undefined : st.transform.get(leader);
  const s = leader === undefined ? undefined : st.soldier.get(leader);
  if (!t || !s) return null;
  const R = 400, cellM = 10, n = (2 * R) / cellM;
  const x0 = t.x - R, y0 = t.y - R;
  const ez = heightAt(map, t.x, t.y) + eyeHeightM(a.sim.ctx, s.posture);
  const vis = new Uint8Array(n * n).fill(255); // beyond the radius: not tinted (not looked at)
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const x = x0 + (c + 0.5) * cellM, y = y0 + (r + 0.5) * cellM;
    if (x < 0 || y < 0 || x >= map.widthM || y >= map.heightM || (x - t.x) ** 2 + (y - t.y) ** 2 > R * R) continue;
    const v = sight(a.sim.ctx, t.x, t.y, ez, x, y, heightAt(map, x, y) + 0.75).visibility;
    vis[r * n + c] = Math.max(0, Math.min(255, Math.round(v * 255)));
  }
  return { vis, cols: n, rows: n, cellM, x0, y0 };
}
