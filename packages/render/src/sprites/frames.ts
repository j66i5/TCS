/**
 * Which soldier frame a man is drawn with (M7.5b; sprite fix 2026-11-15), as a pure function of his state, and
 * where the men of a carrying party are drawn (render-only offsets: the sim keeps them on the leader's trail in a
 * line, which drew pairs of bearers, and a man on his bearer's shoulders, on top of one another).
 */
import type { FrameId } from "./soldier-art";

/** How a carrying party looks: he walks (supported), dragged on his back, on a seat of hands, across the shoulders, on a litter. */
export type CarryLook = "walks" | "drag" | "seat" | "shoulder" | "litter";

/** The look of a carry method (core/medical.json `carry`), by its shape. */
export function carryLookOf(def: { carriers: number; upright: boolean; casualtyWalks?: boolean } | undefined, litter: boolean): CarryLook {
  if (litter) return "litter";
  if (!def) return "drag";
  if (def.casualtyWalks || def.carriers === 0) return "walks";
  if (!def.upright) return "drag";
  return def.carriers === 1 ? "shoulder" : "seat";
}

/** A man's part in a carrying party, if any. */
export interface CarryRole {
  look: CarryLook;
  /** -1: he is carried; 0: he leads (carriers[0]); 1..: a following bearer. */
  index: number;
  /** How many bearers the party has. */
  bearers: number;
  /** The party's phase (sim `Carry.phase`). */
  phase: "gather" | "setup" | "move" | "rest" | "cover" | "hold";
  /** The leading bearer lies prone (the party took cover). */
  leaderProne: boolean;
}

export interface ManState {
  casualty: "none" | "incapacitated" | "killed";
  captive: "surrendered" | "captured" | null;
  posture: "standing" | "crouching" | "prone";
  moving: boolean;
  /** The walk cycle's step (0 or 1). */
  step: number;
  carry: CarryRole | null;
}

/** True while he is lifted (the bearers have him; not while they gather, unfold a litter, or rest). */
function lifted(r: CarryRole): boolean {
  if (r.bearers === 0) return false;
  if (r.look === "litter") return r.phase !== "gather";
  return r.phase === "move" || r.phase === "cover";
}

/** The bearer carries him across his shoulders right now (and he is not drawn on his own). */
function onShoulders(r: CarryRole): boolean {
  return r.look === "shoulder" && lifted(r) && !r.leaderProne;
}

/**
 * His frame, or null when he is not drawn on his own (carried across his bearer's shoulders: the bearer's
 * `shoulder` frame shows both).
 */
export function frameFor(m: ManState): FrameId | null {
  const c = m.carry;
  if (m.casualty === "killed") return "dead";
  if (c && c.index < 0 && c.look !== "walks" && lifted(c)) {
    // (Before the fix every carried man got the lying "carried" frame, even one walking with a comrade's support,
    // and one on his bearer's shoulders was drawn lying on top of him.)
    if (c.look === "litter") return "stretcher";
    if (c.look === "shoulder") return onShoulders(c) ? null : "down";
    if (c.look === "seat") return "seated";
    return "carried";
  }
  if (c && c.index === 0 && onShoulders(c)) return "shoulder";
  if (m.casualty !== "none") {
    // A casualty who crawls to cover (conscious, legs gone, M10.3b) crawls; otherwise he lies on his back.
    return m.moving ? (m.step ? "crawl" : "prone") : "down";
  }
  if (m.captive) return m.captive === "captured" ? "captive" : "surrender";
  if (m.posture === "prone") return m.moving && m.step ? "crawl" : "prone";
  if (m.posture === "crouching") return m.moving && m.step ? "crouchWalk" : "crouch";
  return m.moving ? (m.step ? "walk2" : "walk1") : "stand";
}

/**
 * Where a man of a carrying party is drawn relative to his sim position, in metres along his heading (`ahead`) and
 * to his right (`right`): the litter's bearers in pairs at its two ends, two draggers side by side, a supported man
 * beside his helper, a man put down off his bearer's shoulders beside him. The sim's positions stay as they are
 * (orders, fire and spotting use them).
 */
export function carryOffset(r: CarryRole | null): { ahead: number; right: number } {
  const none = { ahead: 0, right: 0 };
  if (!r || r.phase === "gather" || r.bearers === 0) return none;
  // Bearers 0 and 1 (0.3 m apart on the trail) at the litter's head end, 2 and 3 at its foot end.
  if (r.look === "litter" && r.index >= 0) return r.index % 2 === 0 ? { ahead: -0.15, right: -0.32 } : { ahead: 0.15, right: 0.32 };
  if (r.look === "drag" && r.bearers >= 2 && r.index >= 0) return r.index === 0 ? { ahead: -0.2, right: -0.3 } : { ahead: 0.2, right: 0.3 };
  if (r.look === "walks") return r.index < 0 ? { ahead: 0.25, right: 0.35 } : { ahead: 0, right: -0.1 };
  if (r.look === "shoulder" && r.index < 0 && !onShoulders(r)) return { ahead: 0, right: 0.7 };
  return none;
}
