/**
 * Status pictograms (the "insignia" step, owner 2026-11-14): a tiny soldier per row of the unit card showing how the
 * man is — ready, shaken, pinned, mounted, lightly or seriously wounded, down, dead, surrendered, prisoner, missing.
 * Original drawings in a 20 x 20 box: the figure's posture tells the state (standing, prone, kneeling, lying, hands
 * up), its colour repeats it, and a small badge at the top right adds the detail (red cross, blood drop, flag,
 * question mark). Every pictogram carries a text label (title) from the string table (`card.status.<status>`).
 * Pure strings: no DOM, testable.
 */

/** How a man is, as the card's pictogram shows it (worst first in `manStatus`). */
export type ManStatus = "ready" | "shaken" | "pinned" | "mounted" | "wounded" | "serious" | "down" | "dead" | "surrendered" | "captured" | "missing";

export const MAN_STATUSES: readonly ManStatus[] = ["ready", "shaken", "pinned", "mounted", "wounded", "serious", "down", "dead", "surrendered", "captured", "missing"];

/** The figure's colour per status (also the row's accent); chosen to read on the dark card. */
export const STATUS_COLOUR: Record<ManStatus, string> = {
  ready: "#8fd36a", shaken: "#ffd23d", pinned: "#ffb347", mounted: "#7cc6d6", wounded: "#ff9a57", serious: "#ff6b57",
  down: "#d9776a", dead: "#8a8a8a", surrendered: "#f2f2f2", captured: "#9fb3c8", missing: "#a0a0a0",
};

const RED = "#e8372c", WHITE = "#ffffff";

// ---- figure parts (filled in the status colour)
/** Standing, rifle slung at his right; arms by his side. */
const STAND = `<circle cx="9" cy="3.7" r="2.1"/><path d="M6.6 3.5a2.4 2.4 0 0 1 4.8 0z"/><rect x="6.7" y="6.4" width="4.6" height="6.4" rx="1"/>`
  + `<rect x="5.2" y="6.9" width="1.5" height="5.2" rx="0.75"/><rect x="11.3" y="6.9" width="1.5" height="5.2" rx="0.75"/>`
  + `<rect x="6.9" y="12.4" width="1.9" height="6.2" rx="0.6"/><rect x="9.2" y="12.4" width="1.9" height="6.2" rx="0.6"/>`;
const RIFLE = `<path d="M13.6 3.2l1.3 0.4-2 10.2-1.2-0.3z"/>`;
/** Prone, head to the left. */
const PRONE = `<circle cx="3.6" cy="14" r="2"/><path d="M1.3 13.8a2.3 2.3 0 0 1 4.6 0z"/><rect x="5.6" y="12.6" width="8" height="3.4" rx="1.2"/><rect x="13" y="13.1" width="5.6" height="1.6" rx="0.6"/><rect x="13" y="15" width="5.6" height="1.5" rx="0.6"/><path d="M2 11.3l7.5-0.6v0.9L2 12.2z"/>`;
/** Down on one knee, bent over, a hand on his wound. */
const KNEEL = `<circle cx="9.2" cy="5.6" r="2.1"/><path d="M6.8 5.4a2.4 2.4 0 0 1 4.8 0z"/>`
  + `<rect x="6.4" y="7.6" width="4.6" height="6.2" rx="1" transform="rotate(14 8.7 10.7)"/>`
  + `<rect x="8" y="12.6" width="5.6" height="2" rx="0.8"/><rect x="11.8" y="12.6" width="1.9" height="6.2" rx="0.6"/>`
  + `<rect x="6.6" y="12.4" width="1.9" height="5.8" rx="0.6"/><rect x="3.6" y="16.9" width="4.9" height="1.8" rx="0.6"/>`
  + `<rect x="10.4" y="8" width="1.5" height="4.6" rx="0.75" transform="rotate(-35 11.1 10.3)"/>`;
/** Lying on his back, head to the left, at the bottom of the box. */
const LYING = `<circle cx="3.4" cy="15.6" r="2"/><rect x="5.4" y="14.1" width="8" height="3.3" rx="1.2"/><rect x="13" y="14.4" width="5.8" height="1.4" rx="0.6"/><rect x="13" y="16" width="5.8" height="1.4" rx="0.6"/>`;
/** Hands up (and a white flag in his right hand). */
const HANDS_UP = `<circle cx="9" cy="5.7" r="2.1"/><path d="M6.6 5.5a2.4 2.4 0 0 1 4.8 0z"/><rect x="6.7" y="8.4" width="4.6" height="5.2" rx="1"/>`
  + `<rect x="4.6" y="2.6" width="1.5" height="6.8" rx="0.75" transform="rotate(-12 5.3 6)"/><rect x="11.9" y="2.6" width="1.5" height="6.8" rx="0.75" transform="rotate(12 12.6 6)"/>`
  + `<rect x="6.9" y="13.2" width="1.9" height="5.6" rx="0.6"/><rect x="9.2" y="13.2" width="1.9" height="5.6" rx="0.6"/>`;
/** Upper body only (in a hatch). */
const HALF = `<circle cx="10" cy="3.6" r="2.1"/><path d="M7.6 3.4a2.4 2.4 0 0 1 4.8 0z"/><rect x="7.7" y="6.2" width="4.6" height="4.4" rx="1"/>`;

// ---- badges (top right)
const badgeCross = `<rect x="13.2" y="0.6" width="6.2" height="6.2" rx="1.2" fill="${WHITE}"/><path d="M15.6 1.6h1.4v1.7h1.7v1.4H17v1.7h-1.4V4.7h-1.7V3.3h1.7z" fill="${RED}"/>`;
const badgeDrop = `<path d="M16.3 0.8c1.6 2.3 2.6 3.6 2.6 4.9a2.6 2.6 0 0 1-5.2 0c0-1.3 1-2.6 2.6-4.9z" fill="${RED}" stroke="${WHITE}" stroke-width="0.7"/>`;

function svg(px: number, colour: string, body: string, title: string): string {
  const t = title.replace(/[&<>"]/g, "");
  return `<svg class="hud-picto" viewBox="0 0 20 20" width="${px}" height="${px}" role="img" aria-label="${t}"><title>${t}</title><g fill="${colour}">${body}</g></svg>`;
}

/** Crouched low, arms over his head (panicked, fleeing, routed: the Men list's second badge, morale rework). */
const COWER = `<circle cx="9" cy="9.4" r="2.1"/><rect x="6.3" y="10.6" width="5.6" height="4.4" rx="1.2" transform="rotate(18 9.1 12.8)"/>`
  + `<path d="M5.6 9.6c0.4-3.2 2.2-4.6 4-4.6s3.4 1.2 3.8 3.6l-1.2 0.4c-0.4-1.8-1.4-2.7-2.6-2.7s-2.4 1-2.7 3.5z"/>`
  + `<rect x="6" y="14.6" width="7.6" height="1.9" rx="0.8"/><rect x="5.4" y="16.6" width="1.9" height="2.2" rx="0.6"/><rect x="11.8" y="16.6" width="1.9" height="2.2" rx="0.6"/>`;
/** The panic badge's colour (red-orange: worse than pinned). */
export const PANIC_COLOUR = "#ff7a3d";

/** A man's state of mind as a small pictogram (the Men list's second badge): shaken, pinned, or panicked/fleeing/routed. */
export function mentalPictogram(mental: "shaken" | "pinned" | "panicked" | "fleeing" | "routed", px = 12, title = ""): string {
  if (mental === "shaken" || mental === "pinned") return statusPictogram(mental, px, title);
  return svg(px, PANIC_COLOUR, COWER + `<path d="M15.6 1v5.2M15.6 7.6v1.2M18.4 1v5.2M18.4 7.6v1.2" fill="none" stroke="${PANIC_COLOUR}" stroke-width="1.4"/>`, title);
}

/** The status pictogram as inline SVG `px` square, labelled `title` (the translated status). */
export function statusPictogram(status: ManStatus, px = 20, title = ""): string {
  const c = STATUS_COLOUR[status];
  switch (status) {
    case "ready": return svg(px, c, STAND + RIFLE, title);
    case "shaken": return svg(px, c, STAND + RIFLE + `<path d="M1.2 2.2l2 1.4-2 1.4 2 1.4M18.8 6.6l-2 1.4 2 1.4 2 1.4" fill="none" stroke="${c}" stroke-width="1.1"/>`, title);
    case "pinned": return svg(px, c, PRONE + `<path d="M8 1.5l2.2 4.3M12.5 1l2.2 4.3M17 1.5l2 4" fill="none" stroke="${c}" stroke-width="1.4" stroke-linecap="round"/><path d="M9 7.6l2.4-0.4-1.6 1.9zM13.5 7.1l2.4-0.4-1.6 1.9zM17.9 7.3l1.8-0.3-1.2 1.5z"/>`, title);
    case "mounted": return svg(px, c, HALF + `<path d="M1 11.2h18l-1.6 4.6H2.6z"/><circle cx="5" cy="17.3" r="1.7"/><circle cx="10" cy="17.3" r="1.7"/><circle cx="15" cy="17.3" r="1.7"/>`, title);
    case "wounded": return svg(px, c, STAND + `<rect x="11" y="8.4" width="2.1" height="1.6" fill="${WHITE}"/>` + badgeCross, title);
    case "serious": return svg(px, c, KNEEL + `<circle cx="15.6" cy="18.6" r="1" fill="${RED}"/><circle cx="17.8" cy="17.8" r="0.7" fill="${RED}"/>` + badgeDrop, title);
    case "down": return svg(px, c, LYING + badgeCross, title);
    case "dead": return svg(px, c, LYING + `<path d="M14.8 1v8.5M12 3.8h5.6" fill="none" stroke="${c}" stroke-width="1.6"/>`, title);
    case "surrendered": return svg(px, c, HANDS_UP + `<rect x="13.6" y="0.6" width="0.9" height="8" fill="${c}"/><path d="M14.5 0.8h5v3.8h-5z" fill="${WHITE}" stroke="#555" stroke-width="0.5"/>`, title);
    case "captured": return svg(px, c, `<g opacity="0.75">${STAND}</g><path d="M3.6 1v18.4M8 1v18.4M12.4 1v18.4M16.8 1v18.4M2 1.2h16.4" fill="none" stroke="${c}" stroke-width="1.3"/>`, title);
    case "missing": return svg(px, c, `<g fill="none" stroke="${c}" stroke-width="1" stroke-dasharray="1.6 1.2"><circle cx="9" cy="3.7" r="2.1"/><rect x="6.7" y="6.4" width="4.6" height="6.4" rx="1"/><path d="M7.8 12.8v5.8M10.2 12.8v5.8"/></g><path d="M14 3.2a2.3 2.3 0 1 1 3.2 2.1c-0.6 0.3-0.9 0.7-0.9 1.4v0.6" fill="none" stroke="${c}" stroke-width="1.4" stroke-linecap="round"/><circle cx="16.3" cy="9.6" r="0.9"/>`, title);
  }
}
