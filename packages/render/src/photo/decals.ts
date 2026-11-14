/**
 * Small pictures for the photo look's units and overlays (plan "photo", step "polish"), painted once in our own code:
 * - `contactShadow`: a soft round shadow under a man (tinted and stretched by the renderer);
 * - `scorchDecal`: the burnt ground round a wreck (radial falloff, ragged edge, soot patches);
 * - `grainTile`: neutral fine grain for close zoom (lighter and darker specks, world-anchored, repeats seamlessly);
 * All RGBA, premultiplied alpha. Deterministic (hash noise), pure: no Pixi, no DOM, no `Math.random`, no clock.
 */
import { fbm, hash2, smoothstep } from "./noise";

/** A soft round shadow, black, alpha 1 in the middle falling smoothly to 0 at the edge (`size` px square). */
export function contactShadow(size = 16): Uint8Array {
  const out = new Uint8Array(size * size * 4), c = size / 2;
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const dx = (i + 0.5 - c) / c, dy = (j + 0.5 - c) / c, d = Math.sqrt(dx * dx + dy * dy);
    const a = 1 - smoothstep(0.1, 1, d);
    out[(j * size + i) * 4 + 3] = Math.round(255 * a);
  }
  return out;
}

/**
 * Scorched ground (`size` px square for a disc of the whole square): dark soot brown, alpha up to `maxAlpha` in the
 * middle, a ragged edge (fbm on the radius) and darker soot patches.
 */
export function scorchDecal(size = 64, maxAlpha = 0.5): Uint8Array {
  const out = new Uint8Array(size * size * 4), c = size / 2;
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const x = (i + 0.5 - c) / c, y = (j + 0.5 - c) / c, d = Math.sqrt(x * x + y * y);
    const edge = 0.78 + 0.2 * fbm(x * 3 + 11, y * 3 + 7, 1, 3, 41);
    const soot = 0.5 + 0.5 * fbm(x * 6, y * 6, 1, 2, 43);
    let a = (1 - smoothstep(edge * 0.35, edge, d)) * (0.55 + 0.45 * soot) * maxAlpha;
    a *= 0.85 + 0.3 * hash2(i, j, 47);
    if (a > maxAlpha) a = maxAlpha;
    const r = 0x26 * (1 - 0.4 * soot), g = 0x1e * (1 - 0.4 * soot), b = 0x17 * (1 - 0.4 * soot), o = (j * size + i) * 4;
    out[o] = Math.round(r * a); out[o + 1] = Math.round(g * a); out[o + 2] = Math.round(b * a); out[o + 3] = Math.round(255 * a);
  }
  return out;
}

/**
 * Neutral grain, `size` px square, seamless when repeated: each pixel lightens (white at low alpha) or darkens
 * (black at low alpha) by up to `amp` (fraction of full brightness), two scales of hashed specks.
 */
export function grainTile(size = 256, amp = 0.1): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    // A coarse speck (2 px, wraps at the tile edge) and a fine one.
    const v = 0.6 * (hash2(i >> 1, j >> 1, 53) * 2 - 1) + 0.4 * (hash2(i, j, 59) * 2 - 1);
    const a = Math.min(1, Math.abs(v) * amp * 1.4), w = v > 0 ? 255 : 0, o = (j * size + i) * 4;
    out[o] = out[o + 1] = out[o + 2] = Math.round(w * a); out[o + 3] = Math.round(255 * a);
  }
  return out;
}
