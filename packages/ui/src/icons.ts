/**
 * Small line icons for the order bar and the unit card (the "bar-card" step, owner choices S3, S4, S6). Original
 * drawings in a 20 x 20 box, stroked in the button's text colour (`currentColor`), so they follow its state
 * (greyed, lit). Pure strings: no DOM, testable.
 */

const P: Record<string, string> = {
  // ---- orders
  move: `<path d="M3 10h12"/><path d="M11 5.5l4.5 4.5-4.5 4.5"/>`,
  assault: `<path d="M3 5l5 5-5 5"/><path d="M9 5l5 5-5 5"/><path d="M16.5 4v12"/>`,
  withdraw: `<path d="M17 10H5"/><path d="M9 5.5L4.5 10 9 14.5"/><path d="M17 5v10" stroke-dasharray="2 2"/>`,
  occupy: `<path d="M3 10l7-6 7 6"/><path d="M5 8.5V17h10V8.5"/><path d="M8.5 17v-4h3v4"/>`,
  fire: `<circle cx="10" cy="10" r="5"/><path d="M10 2v4M10 14v4M2 10h4M14 10h4"/><circle cx="10" cy="10" r="0.8" fill="currentColor"/>`,
  antitank: `<path d="M3.5 16.5l7-7"/><path d="M9 8l3-3h3v3l-3 3z"/><path d="M3 13.5l3.5 3.5"/>`,
  grenade: `<circle cx="9" cy="12" r="5"/><path d="M9 7V4.5h4"/><circle cx="15" cy="4.5" r="1.5"/><path d="M6.5 12h5M9 9.5v5" stroke-width="1.2"/>`,
  grenades: `<circle cx="6.5" cy="12.5" r="3.5"/><circle cx="13.5" cy="12.5" r="3.5"/><path d="M6.5 9V6.5M13.5 9V6.5M10 5.5V3"/>`,
  mortar: `<path d="M3 17C5 6 12 3 16 13" stroke-dasharray="2.2 1.8"/><path d="M13.5 16l2.5-3 2 3.5"/><path d="M3 17h4"/>`,
  smoke: `<circle cx="7" cy="12" r="3.5"/><circle cx="12" cy="9" r="4"/><circle cx="14.5" cy="13.5" r="3"/><path d="M3 17h14"/>`,
  support: `<path d="M2.5 15C4 6 9 3 12.5 9" stroke-dasharray="2 1.8"/><circle cx="14.5" cy="13.5" r="3.6"/><path d="M14.5 8.2v2.2M14.5 16.6v2.2M9.2 13.5h2.2M17.6 13.5h2.2"/>`,
  halt: `<path d="M7 2.8h6l4.2 4.2v6L13 17.2H7L2.8 13V7z"/><path d="M6.5 10h7"/>`,
  mount: `<path d="M3.5 11.5v5h13v-5"/><path d="M10 2.5v9"/><path d="M6.5 8.5l3.5 3.5 3.5-3.5"/>`,
  dismount: `<path d="M3.5 11.5v5h13v-5"/><path d="M10 12V3"/><path d="M6.5 6.5L10 3l3.5 3.5"/>`,
  ceaseFire: `<circle cx="10" cy="10" r="5"/><path d="M10 2v4M10 14v4M2 10h4M14 10h4"/><path d="M4 16L16 4" stroke-width="2.2"/>`,
  discharge: `<path d="M10 17v-4"/><circle cx="5" cy="7" r="2.3"/><circle cx="10" cy="5" r="2.3"/><circle cx="15" cy="7" r="2.3"/><path d="M10 13L5.8 9M10 13l4.2-4" stroke-dasharray="1.5 1.5"/>`,
  nature: `<path d="M7 17V8.5L10 3l3 5.5V17z"/><path d="M7 13h6"/>`,
  rules: `<path d="M4 5h1M4 10h1M4 15h1"/><path d="M8 5h8M8 10h8M8 15h8"/>`,
  standing: `<circle cx="10" cy="3.8" r="1.8"/><path d="M10 6v6M10 12l-2.5 5.5M10 12l2.5 5.5M6.5 8.5h7"/>`,
  crouching: `<circle cx="9" cy="6" r="1.8"/><path d="M9 8l1 4.5h4l-0.5 4.5M10 12.5L7 17M6 10.5h6"/>`,
  prone: `<circle cx="4" cy="12.5" r="1.8"/><path d="M6 13.5h11M9 13.5l-2 3M13 13.5l2-2"/>`,
  caret: `<path d="M6 8.5l4 4 4-4"/>`,
  men: `<circle cx="7" cy="6" r="2.2"/><circle cx="13.5" cy="7" r="1.9"/><path d="M3 16c0-3.5 1.8-5.5 4-5.5s4 2 4 5.5M12 16c0-2.8 0.6-4.5 2-4.5s2.5 1.7 2.5 4.5"/>`,
  close: `<path d="M5 5l10 10M15 5L5 15"/>`,
  // ---- paces (S3)
  run: `<path d="M3 5l5 5-5 5"/><path d="M9 5l5 5-5 5"/><path d="M15 5l3 5-3 5" stroke-width="1.2"/>`,
  walk: `<path d="M5 5l5 5-5 5"/><path d="M11 5l5 5-5 5" stroke-width="1.2"/>`,
  sneak: `<path d="M7 5l5 5-5 5"/><path d="M2.5 17h2M7.5 17h2M12.5 17h2" stroke-width="1.4"/>`,
  crawl: `<path d="M2.5 14c2-2 3.5 2 5.5 0s3.5 2 5.5 0 2.5 0 4 0"/><path d="M12 6l3 3-3 3" stroke-width="1.4"/>`,
  reverse: `<path d="M15 5l-5 5 5 5"/><path d="M9 5l-5 5 5 5" stroke-width="1.2"/>`,
  // ---- fire behaviour (S3)
  free: `<circle cx="10" cy="10" r="4"/><circle cx="10" cy="10" r="0.8" fill="currentColor"/><path d="M10 1.5v3M10 15.5v3M1.5 10h3M15.5 10h3M4 4l2 2M16 4l-2 2M4 16l2-2M16 16l-2-2"/>`,
  return: `<path d="M3 7h12"/><path d="M12 4l3 3-3 3"/><path d="M17 13H5"/><path d="M8 10l-3 3 3 3"/>`,
  hold: `<circle cx="10" cy="10" r="7"/><path d="M8 6.5v7M12 6.5v7" stroke-width="2"/>`,
  ambush: `<path d="M2.5 10c2-3.5 4.5-5 7.5-5s5.5 1.5 7.5 5c-2 3.5-4.5 5-7.5 5s-5.5-1.5-7.5-5z"/><circle cx="10" cy="10" r="2.2"/><path d="M10 1v1.5M10 17.5V19" stroke-width="1.2"/>`,
};

/** A pace id (foot or vehicle) as one of the five pace drawings. */
export function paceIcon(pace: string): string {
  if (pace === "reverse") return "reverse";
  if (pace === "run" || pace.endsWith("-fast")) return "run";
  if (pace === "sneak" || pace.endsWith("-slow")) return "sneak";
  if (pace === "crawl") return "crawl";
  return "walk";
}

/** The icon as inline SVG (20 x 20 box drawn at `px`), or an empty string for an unknown name. */
export function icon(name: string, px = 18): string {
  const p = P[name];
  if (p === undefined) return "";
  return `<svg class="hud-ico" viewBox="0 0 20 20" width="${px}" height="${px}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}

export const ICON_NAMES: readonly string[] = Object.keys(P);

/** A man's state as a small filled mark (S6): a dot, a down arrow (pinned), a cross (wounded), an X (down), a flag. */
export function stateMark(state: "steady" | "shaken" | "pinned" | "wounded" | "down" | "captive", px = 14): string {
  const body = state === "steady" ? `<circle cx="7" cy="7" r="4.2" fill="currentColor"/>`
    : state === "shaken" ? `<circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" stroke-width="2"/>`
    : state === "pinned" ? `<path d="M7 1.5v7M3.5 5.5L7 9l3.5-3.5M2 12.5h10" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>`
    : state === "wounded" ? `<path d="M5 1.5h4v3.5h3.5v4H9v3.5H5V9H1.5V5H5z" fill="currentColor"/>`
    : state === "down" ? `<path d="M2.5 2.5l9 9M11.5 2.5l-9 9" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>`
    : `<path d="M3 13V1.5M3 2h8l-2 2.5 2 2.5H3" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/>`;
  return `<svg class="hud-mark" viewBox="0 0 14 14" width="${px}" height="${px}" aria-hidden="true">${body}</svg>`;
}
