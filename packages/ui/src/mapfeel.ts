/**
 * The "map-feel" step (owner choices S5, S7, S8, S13, S14 of 2026-11-13): pure helpers for what the map shows
 * besides the men — where every own unit is going (one line per unit) and where fire missions will land, the
 * "last seen" pins of lost contacts, the keyboard, unit cycling and the help card's contents. Nothing here changes
 * the simulation: the lines and pins are read from the state the side may know (its own units, its own contacts),
 * and the keys send the same orders as the buttons.
 */
import { isAble, type EntityId, type SimView } from "@tcs/sim";
import { PIN_AFTER_S } from "@tcs/render";

type Pt = { x: number; y: number };

// ---- S7: unit-to-destination lines

/** One line per own unit on the move (to its destination), or per fire mission (from the caller to the target). */
export interface IntentLine {
  x0: number; y0: number; x1: number; y1: number;
  kind: "move" | "fire";
  /** The selected unit (or one of its sub-units): drawn bright, along the route still ahead. */
  selected: boolean;
  /** For a selected unit's move: the route points still ahead (the last one is the destination). */
  route?: Pt[];
}

/** Is `unit` the unit `ancestor` or one of its sub-units? */
export function unitWithin(view: SimView, ancestor: EntityId, unit: EntityId): boolean {
  let u: EntityId | null = unit;
  for (let k = 0; u !== null && k < 16; k++) {
    if (u === ancestor) return true;
    u = view.unit.get(u)?.parent ?? null;
  }
  return false;
}

/**
 * The side's lines (S7): every own unit carrying out a move — from the middle of its men on foot (a crew: its hull)
 * to the end of its leader's route (a hull's route) — and every fire mission of the side, called or on its way to
 * the caller, from the caller to the target. One line per unit, never per man (owner rule).
 */
export function intentLines(view: SimView, side: string, selected: EntityId | null): IntentLine[] {
  const out: IntentLine[] = [];
  const sel = (uid: EntityId) => selected !== null && unitWithin(view, selected, uid);
  for (const [uid, u] of view.unit.entries()) {
    if (u.side !== side || !u.moving) continue;
    if (u.vehicle !== undefined) {
      const v = view.vehicle.get(u.vehicle), t = view.transform.get(u.vehicle);
      if (!v || !t || v.drive.arrived) continue;
      const ahead = v.drive.route.slice(v.drive.routeIdx);
      const end = ahead[ahead.length - 1];
      if (!end) continue;
      const s = sel(uid);
      out.push({ x0: t.x, y0: t.y, x1: end.x, y1: end.y, kind: "move", selected: s, ...(s ? { route: ahead.map((w) => ({ x: w.x, y: w.y })) } : {}) });
      continue;
    }
    if (u.leader === null) continue;
    const lead = view.soldier.get(u.leader), m = view.mover.get(u.leader);
    if (!lead || lead.mount !== undefined || !m || m.waypoints.length === 0) continue;
    let x = 0, y = 0, n = 0;
    for (const id of u.members) {
      const s = view.soldier.get(id), t = view.transform.get(id);
      if (!s || !t || s.mount !== undefined || !isAble(s)) continue;
      x += t.x; y += t.y; n++;
    }
    if (n === 0) continue;
    const end = m.waypoints[m.waypoints.length - 1]!;
    const s = sel(uid);
    out.push({ x0: x / n, y0: y / n, x1: end.x, y1: end.y, kind: "move", selected: s, ...(s ? { route: m.waypoints.map((w) => ({ x: w.x, y: w.y })) } : {}) });
  }
  // Fire missions: called (in the air soon) and still on their way to the caller (the radio).
  const callerAt = (id: EntityId): Pt | null => {
    const s = view.soldier.get(id);
    const t = view.transform.get(s?.mount !== undefined ? s.mount.vehicle : id);
    return t ? { x: t.x, y: t.y } : null;
  };
  for (const f of view.fireMissions) {
    if (f.side !== side || f.left <= 0) continue;
    const from = callerAt(f.caller);
    if (!from) continue;
    const u = view.identity.get(f.caller)?.unit;
    out.push({ x0: from.x, y0: from.y, x1: f.x, y1: f.y, kind: "fire", selected: u !== undefined && sel(u) });
  }
  for (const p of [...view.inbox, ...view.pendingOrders]) {
    const o = p.order;
    if (o.kind !== "callFire" || o.issuer !== side) continue;
    const u = view.unit.get(o.target);
    const from = u?.leader !== null && u?.leader !== undefined ? callerAt(u.leader) : null;
    if (!from) continue;
    out.push({ x0: from.x, y0: from.y, x1: o.x, y1: o.y, kind: "fire", selected: sel(o.target) });
  }
  return out;
}

/** Zoomed out to unit symbols, more move lines than this (not the selected unit's) are left out (clutter). */
export const INTENT_CLUTTER = 6;

/** The lines drawn at a zoom level: at the symbol level, the faint move lines only while there are few. */
export function linesShown(lines: readonly IntentLine[], symbols: boolean, max = INTENT_CLUTTER): IntentLine[] {
  if (!symbols) return [...lines];
  const faint = lines.filter((l) => l.kind === "move" && !l.selected).length;
  return faint > max ? lines.filter((l) => l.kind === "fire" || l.selected) : [...lines];
}

// ---- S8: "last seen" pins

/** What the side knows of an enemy (the shape of `sideKnowledge`'s entries). */
export interface KnownLike {
  target: EntityId; x: number; y: number; kind: "seen" | "heard" | "reported"; ageS: number;
  cls?: "vehicle"; vtype?: string; heading?: number;
}

// A contact unseen PIN_AFTER_S (6 s, the renderer's: the sim keeps a man in sight 6 s after the last sighting,
// `spotting.forgetSeconds`) is "lost": a hollow pin with its age instead of a mark.
/** The spot must be in clear view this long (s of game time) to count as seen empty. */
export const EMPTY_AFTER_S = 5;

export interface LastSeenPin {
  target: EntityId; x: number; y: number;
  /** Tick of the last sighting. */
  seenTick: number;
  cls?: "vehicle"; vtype?: string; heading?: number;
}

interface Entry extends LastSeenPin { live: boolean; watchedS: number; checkTick: number }

/**
 * The side's "last seen" pins (S8; UI only, from the contacts the side already has). A contact seen or reported
 * becomes a pin once it has been out of sight `PIN_AFTER_S`; the pin stays — also after the simulation has
 * forgotten the contact — until the enemy is seen again (a fresh sighting: the pin goes) or the spot has been in
 * clear view of own men for `EMPTY_AFTER_S` (seen empty). A contact that vanishes from what the side knows while
 * still in sight (the men saw him fall, or get into a vehicle) leaves no pin. A heard contact never makes a pin.
 */
export class LastSeenBook {
  private entries = new Map<EntityId, Entry>();
  /** Pins cleared as seen empty: the sighting they came from (no new pin until a newer one). */
  private cleared = new Map<EntityId, number>();
  private turn = 0;

  update(known: readonly KnownLike[], tick: number): void {
    const present = new Set<EntityId>();
    for (const k of known) {
      if (k.kind === "heard") continue;
      present.add(k.target);
      const seenTick = tick - Math.round(k.ageS * 60);
      const was = this.entries.get(k.target);
      const live = k.ageS < PIN_AFTER_S;
      const clearedAt = this.cleared.get(k.target);
      if (clearedAt !== undefined) {
        if (seenTick <= clearedAt) continue; // nothing newer than the empty spot
        this.cleared.delete(k.target);
      }
      const e: Entry = {
        target: k.target, x: k.x, y: k.y, seenTick, live,
        watchedS: was && !was.live && !live ? was.watchedS : 0,
        checkTick: was?.checkTick ?? tick,
        ...(k.cls !== undefined ? { cls: k.cls } : {}), ...(k.vtype !== undefined ? { vtype: k.vtype } : {}), ...(k.heading !== undefined ? { heading: k.heading } : {}),
      };
      this.entries.set(k.target, e);
    }
    for (const [id, e] of this.entries) if (!present.has(id) && e.live) this.entries.delete(id);
  }

  /** The pins now (lost contacts), in target order. */
  pins(): LastSeenPin[] {
    const out: LastSeenPin[] = [];
    for (const e of [...this.entries.values()].sort((a, b) => a.target - b.target)) {
      if (e.live) continue;
      out.push({ target: e.target, x: e.x, y: e.y, seenTick: e.seenTick, ...(e.cls !== undefined ? { cls: e.cls } : {}), ...(e.vtype !== undefined ? { vtype: e.vtype } : {}), ...(e.heading !== undefined ? { heading: e.heading } : {}) });
    }
    return out;
  }

  /**
   * Look at up to `max` pins (round robin): `inView(pin)` says whether own men have the spot in clear view now.
   * Time in view adds up (game time since the pin was last looked at); out of view starts it again.
   */
  look(tick: number, inView: (p: LastSeenPin) => boolean, max = 4): void {
    const pins = [...this.entries.values()].filter((e) => !e.live).sort((a, b) => a.target - b.target);
    if (pins.length === 0) return;
    for (let k = 0; k < Math.min(max, pins.length); k++) {
      const e = pins[(this.turn + k) % pins.length]!;
      const dt = Math.max(0, tick - e.checkTick) / 60;
      e.checkTick = tick;
      e.watchedS = inView(e) ? e.watchedS + dt : 0;
      if (e.watchedS >= EMPTY_AFTER_S) { this.entries.delete(e.target); this.cleared.set(e.target, e.seenTick); }
    }
    this.turn = (this.turn + Math.min(max, pins.length)) % Math.max(1, pins.length);
  }

  clear(): void { this.entries.clear(); this.cleared.clear(); }
}

/** The pin's age label: its string key and parameters ("40 s", "3 min"). Seconds in 5 s steps under a minute. */
export function ageLabel(ageS: number): { key: string; params: { n: number } } {
  const s = Math.max(0, ageS);
  if (s < 60) return { key: "map.lastSeen.s", params: { n: Math.max(5, Math.floor(s / 5) * 5) } };
  return { key: "map.lastSeen.min", params: { n: Math.floor(s / 60) } };
}

// ---- S5 / S13: cycling units, following, keys

/** The next unit in `order` after `current` (`dir` -1: before it); none selected: the first (or last). */
export function cycleUnit(order: readonly EntityId[], current: EntityId | null, dir: 1 | -1): EntityId | null {
  if (order.length === 0) return null;
  const k = current === null ? -1 : order.indexOf(current);
  if (k < 0) return dir > 0 ? order[0]! : order[order.length - 1]!;
  return order[(k + dir + order.length) % order.length]!;
}

/** The follow camera eases toward the unit: this share of the way each frame (60 frames a second). */
export const FOLLOW_EASE = 0.2;
export function easeToward(from: Pt, to: Pt, k = FOLLOW_EASE): Pt {
  return { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
}

/** What a key does (S13). Pan keys are held (see `panVector`); everything else acts once per press. */
export type KeyAction =
  | { kind: "pause" }
  | { kind: "speed"; index: number }
  | { kind: "cancel" }
  | { kind: "cycle"; dir: 1 | -1 }
  | { kind: "follow" }
  | { kind: "order"; order: "move" | "fire" | "halt" | "mount" | "grenade" }
  | { kind: "go" }
  | { kind: "undo" }
  | { kind: "contours" }
  | { kind: "help" };

const PAN_CODES: Readonly<Record<string, [number, number]>> = {
  KeyW: [0, -1], ArrowUp: [0, -1], KeyS: [0, 1], ArrowDown: [0, 1], KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0],
};
export const isPanKey = (code: string): boolean => code in PAN_CODES;

/** The pan direction of the keys held (screen axes, each -1, 0 or 1). */
export function panVector(held: Iterable<string>): { x: number; y: number } {
  let x = 0, y = 0;
  for (const c of held) { const v = PAN_CODES[c]; if (v) { x += v[0]; y += v[1]; } }
  return { x: Math.sign(x), y: Math.sign(y) };
}
/** Keyboard pan speed, screen px per second (whatever the zoom). */
export const PAN_PX_PER_S = 700;

/**
 * The action of a key press (`code`: the physical key, so WASD works on any layout; `key`: the character, for "?").
 * Ctrl, Alt or Meta held: none (the browser's own shortcuts stay).
 */
export function keyAction(code: string, key: string, mods: { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean }): KeyAction | null {
  if (mods.ctrl || mods.alt || mods.meta) return null;
  if (key === "?" || code === "F1") return { kind: "help" };
  switch (code) {
    case "Space": return { kind: "pause" };
    case "Digit1": case "Numpad1": return { kind: "speed", index: 0 };
    case "Digit2": case "Numpad2": return { kind: "speed", index: 1 };
    case "Digit3": case "Numpad3": return { kind: "speed", index: 2 };
    case "Digit4": case "Numpad4": return { kind: "speed", index: 3 };
    case "Escape": return { kind: "cancel" };
    case "Tab": return { kind: "cycle", dir: mods.shift ? -1 : 1 };
    case "KeyF": return { kind: "follow" };
    case "KeyM": return { kind: "order", order: "move" };
    case "KeyT": return { kind: "order", order: "fire" };
    case "KeyH": return { kind: "order", order: "halt" };
    case "KeyB": return { kind: "order", order: "mount" };
    case "KeyG": return { kind: "order", order: "grenade" };
    case "Enter": case "NumpadEnter": return { kind: "go" };
    case "Backspace": return { kind: "undo" };
    case "KeyC": return { kind: "contours" };
    default: return null;
  }
}

/** The help card (S13): sections of rows, each a key (or gesture) label and what it does, as string keys. */
export const HELP_SECTIONS: readonly { title: string; rows: readonly [string, string][] }[] = [
  {
    title: "help.keys",
    rows: [
      ["help.k.space", "help.space"], ["help.k.speed", "help.speed"], ["help.k.pan", "help.pan"], ["help.k.esc", "help.esc"],
      ["help.k.tab", "help.tab"], ["help.k.f", "help.f"], ["help.k.m", "help.m"], ["help.k.t", "help.t"], ["help.k.h", "help.h"],
      ["help.k.b", "help.b"], ["help.k.g", "help.g"], ["help.k.enter", "help.enter"], ["help.k.back", "help.back"],
      ["help.k.c", "help.c"], ["help.k.help", "help.help"],
    ],
  },
  {
    title: "help.mouse",
    rows: [
      ["help.g.click", "help.click"], ["help.g.dragUnit", "help.dragUnit"], ["help.g.right", "help.right"],
      ["help.g.dragMap", "help.dragMap"], ["help.g.wheel", "help.wheel"], ["help.g.holdFire", "help.holdFire"],
      ["help.g.marker", "help.marker"], ["help.g.handle", "help.handle"],
      ["help.g.tile", "help.tile"], ["help.g.tileHold", "help.tileHold"], ["help.g.double", "help.double"],
    ],
  },
  {
    title: "help.touch",
    rows: [
      ["help.t.tap", "help.click"], ["help.t.dragUnit", "help.dragUnit"], ["help.t.dragMap", "help.dragMap"],
      ["help.t.pinch", "help.wheel"], ["help.t.holdFire", "help.holdFire"], ["help.t.tile", "help.tile"],
      ["help.t.tileHold", "help.tileHold"],
    ],
  },
];
