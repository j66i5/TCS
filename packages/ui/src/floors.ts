/**
 * The floor switch (M7.5d, plan m7.5 §6): buttons G, 1, 2 … for the floor of the buildings shown. It appears when
 * the selected unit is indoors or a building with more than one storey is opened up on screen (roofs faded), and
 * follows the selected unit's floor (the floor most of its men in buildings stand on) until the player picks one
 * himself; a pick holds until that unit changes floor or another unit is selected. Pure helpers plus the element.
 */

/** Button label of a floor: `ground` (the string table's "ui.floor.ground") for the ground floor, else its number. */
export function floorLabel(floor: number, ground: string): string {
  return floor <= 0 ? ground : String(floor);
}

/**
 * The floor a unit is on (pure): the floor most of its men indoors stand on (ties: the lower), or null when none
 * of them is in a building. `floors` lists each man's floor, or -1 for a man outdoors.
 */
export function unitFloor(floors: readonly number[]): number | null {
  const n = new Map<number, number>();
  for (const f of floors) if (f >= 0) n.set(f, (n.get(f) ?? 0) + 1);
  let best: number | null = null, bc = 0;
  for (const [f, c] of [...n.entries()].sort((a, b) => a[0] - b[0])) if (c > bc) { bc = c; best = f; }
  return best;
}

/** The follow rule's state: the floor shown, and what it last followed. */
export interface FloorFollow { shown: number; unit: number | null; unitFloor: number | null; manual: boolean }

/**
 * One step of the follow rule (pure): a new selection or a change of the selected unit's floor moves the floor
 * shown to that unit's floor; otherwise a manual pick holds. `pick` is the player's pick this frame (or null).
 */
export function followFloor(prev: FloorFollow, unit: number | null, floor: number | null, pick: number | null, maxFloor: number): FloorFollow {
  const clamp = (f: number) => Math.min(Math.max(f, 0), Math.max(0, maxFloor));
  if (pick !== null) return { shown: clamp(pick), unit, unitFloor: floor, manual: true };
  if (unit !== prev.unit || floor !== prev.unitFloor) {
    if (floor !== null) return { shown: clamp(floor), unit, unitFloor: floor, manual: false };
    return { shown: prev.manual ? clamp(prev.shown) : 0, unit, unitFloor: floor, manual: prev.manual && unit === prev.unit };
  }
  return { ...prev, shown: clamp(prev.shown) };
}

export interface FloorSwitch {
  readonly el: HTMLElement;
  /** Show (with `count` floors) or hide (count < 2) the switch, the floor `shown` lit. */
  set(count: number, shown: number): void;
}

/** The switch element: a small column of buttons (`ground`: the ground floor's label); `onPick` gets the floor picked. */
export function createFloorSwitch(root: HTMLElement, title: string, ground: string, onPick: (floor: number) => void): FloorSwitch {
  const el = document.createElement("div");
  el.className = "hud-floors";
  el.setAttribute("role", "group");
  el.setAttribute("aria-label", title);
  el.hidden = true;
  root.append(el);
  let count = 0, lit = -1;
  const btns: HTMLButtonElement[] = [];
  return {
    el,
    set(n, shown) {
      if (n < 2) { el.hidden = true; return; }
      el.hidden = false;
      if (n !== count) {
        count = n;
        el.replaceChildren();
        btns.length = 0;
        // Top floor first (a building seen from above, floors stacked).
        for (let f = n - 1; f >= 0; f--) {
          const b = document.createElement("button");
          b.className = "hud-btn hud-floor";
          b.textContent = floorLabel(f, ground);
          b.setAttribute("aria-label", `${title} ${floorLabel(f, ground)}`);
          b.onclick = () => onPick(f);
          btns[f] = b;
          el.append(b);
        }
        lit = -1;
      }
      if (shown !== lit) { btns.forEach((b, f) => b.classList.toggle("on", f === shown)); lit = shown; }
    },
  };
}
