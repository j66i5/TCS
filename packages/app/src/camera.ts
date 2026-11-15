/** S5: centring on a unit and the follow camera (from the `main.ts` split, D2). */
import type { EntityId } from "@tcs/sim";
import { screenToWorld, shownCallsigns, worldToScreen } from "@tcs/render";
import { centreOf, easeToward } from "@tcs/ui";
import type { App, Pt } from "./app";
import { droneAt, placesOf } from "./units";

/** The map area left free by the bars, the sidebar and (review fix) the radio log and the unit card. */
export function viewInsets(a: App) {
  const ins = a.hud.insets();
  return { ...ins, bottom: Math.max(ins.bottom, Math.min(a.hud.bottomCover(), a.renderer.app.screen.height * 0.6)) };
}

/** The world point at the middle of the free map area. */
function viewCentre(a: App): Pt {
  const ins = viewInsets(a), scr = a.renderer.app.screen;
  return screenToWorld(a.renderer.camera, ins.left + (scr.width - ins.left - ins.right) / 2, ins.top + (scr.height - ins.top - ins.bottom) / 2);
}

export function centreOn(a: App, uid: EntityId): void {
  const p = centreOf(placesOf(a, uid));
  if (p) { a.renderer.focusScale(p.x, p.y, a.renderer.camera.scale, viewInsets(a)); void a.renderer.primeDetail(); }
}

/** Review fix: the selected unit kept clear of the card when it grows (Men opened): centred if it went under it. */
export function keepSelectedClear(a: App): void {
  const uid = a.overlay.selectedUnit;
  if (uid === null || a.following !== null) return;
  const p = centreOf(placesOf(a, uid));
  if (!p) return;
  const s = worldToScreen(a.renderer.camera, p.x, p.y), ins = viewInsets(a);
  if (s.y > a.renderer.app.screen.height - ins.bottom - 20) centreOn(a, uid);
}

/** Is the camera on the unit already (within 24 px of the middle of the free area)? */
export function centredOn(a: App, uid: EntityId): boolean {
  const p = centreOf(placesOf(a, uid));
  if (!p) return true;
  const v = viewCentre(a);
  return Math.hypot(p.x - v.x, p.y - v.y) * a.renderer.camera.scale <= 24;
}

/** M9.4a: centre on the unit's airborne drone (else on the unit). */
export function centreOnDrone(a: App, uid: EntityId): void {
  const p = droneAt(a, uid);
  if (!p) { centreOn(a, uid); return; }
  a.renderer.focusScale(p.x, p.y, a.renderer.camera.scale, viewInsets(a)); void a.renderer.primeDetail();
}
/** Is the camera on the unit's airborne drone already (else: on the unit)? */
export function droneCentred(a: App, uid: EntityId): boolean {
  const p = droneAt(a, uid);
  if (!p) return centredOn(a, uid);
  const v = viewCentre(a);
  return Math.hypot(p.x - v.x, p.y - v.y) * a.renderer.camera.scale <= 24;
}

function followText(a: App): void {
  const f = a.following, u = f === null ? undefined : a.sim.state.unit.get(f);
  a.hud.setFollowing(u && f !== null ? a.strings.t("follow.badge", { callsign: shownCallsigns(a.sim.state.unit.entries()).get(f) ?? u.callsign }) : null);
}
export function startFollow(a: App, uid: EntityId): void { a.following = uid; followText(a); }
export function stopFollow(a: App): void { if (a.following === null) return; a.following = null; followText(a); }

/** Each frame: ease the camera toward the followed unit's middle (stops when the unit has no one left). */
export function followStep(a: App): void {
  if (a.following === null) return;
  const p = centreOf(placesOf(a, a.following));
  if (!p) { stopFollow(a); return; }
  const e = easeToward(viewCentre(a), p);
  a.renderer.focusScale(e.x, e.y, a.renderer.camera.scale, viewInsets(a));
}
