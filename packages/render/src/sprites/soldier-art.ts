/**
 * Soldier pixel art (M7.5b, plan m7.5 §4): ORIGINAL 16 x 16 frames, drawn for this project as string grids (not
 * taken or traced from any game). Top-down, the man faces EAST (right); his position is the centre of pixel
 * (8, 8). 16 art pixels = `SPRITE_M` metres, so at 16 px/m a sprite is drawn pixel for pixel.
 *
 * Letters (palette slots; the colours come from the faction's appearance data, `atlas.ts`):
 *   .  transparent        u  uniform            d  uniform, dark       l  uniform, light
 *   h  helmet             s  skin               g  webbing and pack    w  weapon (blackened steel)
 *   t  anti-tank tube     f  muzzle flash       x  white (cloth, flash core, bandage)   r  blood
 *
 * Frames with a weapon draw a rifle as one horizontal run of `w` (the longest run is "the weapon"): the weapon
 * variants (machine gun, marksman rifle) and the muzzle flash are made from that run by `atlas.ts`.
 */

/** Metres covered by the 16 art pixels: 1 m (plan §7.3), so a man's shoulders and pack are about 0.55 m. */
export const SPRITE_M = 1;
export const ART = 16;

export type FrameId = "stand" | "walk1" | "walk2" | "crouch" | "crouchWalk" | "prone" | "crawl" | "down" | "dead" | "surrender" | "captive";

export const FRAMES: Record<FrameId, readonly string[]> = {
  stand: [
    "................",
    "................",
    "................",
    "................",
    ".......uuu......",
    "......luuuu.....",
    "...ggluhhhuu....",
    "...gguhlhhh.u...",
    "...gguhhhhh.u...",
    "...gguhhhhd..s..",
    "...ggduhhdwwwwww",
    "......ddddds....",
    ".......ddd......",
    "................",
    "................",
    "................",
  ],
  // Walking: a boot shows behind him, left and right in turn.
  walk1: [
    "................",
    "................",
    "................",
    "................",
    ".......uuu......",
    "...dd.luuuu.....",
    "...ggluhhhuu....",
    "...gguhlhhh.u...",
    "...gguhhhhh.u...",
    "...gguhhhhd..s..",
    "...ggduhhdwwwwww",
    "......ddddds....",
    ".......ddd......",
    "................",
    "................",
    "................",
  ],
  walk2: [
    "................",
    "................",
    "................",
    "................",
    ".......uuu......",
    "......luuuu.....",
    "...ggluhhhuu....",
    "...gguhlhhh.u...",
    "...gguhhhhh.u...",
    "...gguhhhhd..s..",
    "...ggduhhdwwwwww",
    "...dd.ddddds....",
    ".......ddd......",
    "................",
    "................",
    "................",
  ],
  // Crouching: head forward over the knees, a boot behind.
  crouch: [
    "................",
    "................",
    "................",
    "................",
    ".......uuu......",
    "......luuuu.....",
    "...gglulhhhu....",
    "...gguuhlhhhu...",
    "...gguuhhhhhu...",
    "...gguuhhhhd.s..",
    "...ggduuhhdwwwww",
    "...dd.ddddds....",
    ".......ddd.uu...",
    "................",
    "................",
    "................",
  ],
  crouchWalk: [
    "................",
    "................",
    "................",
    "................",
    ".......uuu......",
    "...dd.luuuu.....",
    "...gglulhhhu....",
    "...gguuhlhhhu...",
    "...gguuhhhhhu...",
    "...gguuhhhhd.s..",
    "...ggduuhhdwwwww",
    "......ddddds....",
    ".......ddd.uu...",
    "................",
    "................",
    "................",
  ],
  // Prone: lying along his facing, legs spread behind, the rifle forward beside the head.
  prone: [
    "................",
    "................",
    "................",
    "................",
    "........uuuuu...",
    "......luuuuuu...",
    "dddddluuuuu.hh..",
    "ddddduggguuhlhh.",
    ".....uggguuhhhh.",
    "ddddduggguuhhhd.",
    "ddddddduuuu.hds.",
    "......ddddduwwww",
    "........dddd....",
    "................",
    "................",
    "................",
  ],
  // Crawling: one knee drawn up.
  crawl: [
    "................",
    "................",
    "................",
    "................",
    "........uuuuu...",
    "......luuuuuu...",
    "..dddluuuuu.hh..",
    ".dddduggguuhlhh.",
    ".....uggguuhhhh.",
    "ddddduggguuhhhd.",
    "ddddddduuuu.hds.",
    "......ddddduwwww",
    "........dddd....",
    "................",
    "................",
    "................",
  ],
  // Down (unconscious or unable to act): on his back, face up, arms out, the rifle dropped beside him.
  down: [
    "................",
    "................",
    "................",
    "..........s.....",
    ".........u......",
    "........uu......",
    "dddddluuuuu.hh..",
    "ddddduuuuuuhssh.",
    ".....uuuuuuhssh.",
    "ddddduuuuuuhhhd.",
    "dddddddddddd.hd.",
    "........dd......",
    ".........d......",
    "..........s..ww.",
    "...........ww...",
    "................",
  ],
  // Dead: face down, one arm flung forward, blood under him.
  dead: [
    "................",
    "................",
    "................",
    "................",
    "................",
    "......uuuuuuuuus",
    "..dddluuuuu.hh..",
    ".ddddduuuuuhhhh.",
    ".....uuuuuuhhhh.",
    "...ddduuuuuhhhd.",
    "..ddddddddd.hd..",
    ".....rddddds....",
    ".....rrrrr......",
    "......rrr...ww..",
    "..........ww....",
    "................",
  ],
  // Surrendered: no weapon, hands up and out, a white cloth in one hand.
  surrender: [
    "................",
    ".........xxx....",
    "........sxx.....",
    "........u.......",
    ".......uuu......",
    "......luuuu.....",
    "...ggluhhhu.....",
    "...gguhhhhh.....",
    "...gguhhhhh.....",
    "...gguhhhhh.....",
    "...ggduhhhu.....",
    "......ddddd.....",
    ".......ddd......",
    "........u.......",
    "........s.......",
    "................",
  ],
  // Taken prisoner: kneeling, hands on his helmet.
  captive: [
    "................",
    "................",
    "................",
    "........u.......",
    ".......uuu......",
    "......luuuu.....",
    "...gglshhhu.....",
    "...gguhhhhhd....",
    "...gguhhhhh.....",
    "...gguhhhhhd....",
    "...ggdshhhu.....",
    "......ddddd.....",
    ".......ddd......",
    "........d.......",
    "................",
    "................",
  ],
};

/** Frames in which he holds his weapon (the others: none, or dropped beside him). */
export const ARMED: ReadonlySet<FrameId> = new Set(["stand", "walk1", "walk2", "crouch", "crouchWalk", "prone", "crawl"]);

/** Wounded but fighting: blood and a field dressing, per frame family (x, y, letter). */
export const WOUND_MARKS: Record<"upright" | "lying", readonly [number, number, string][]> = {
  upright: [[8, 11, "r"], [9, 11, "r"], [6, 5, "x"]],
  lying: [[8, 10, "r"], [9, 10, "r"], [9, 4, "x"]],
};
export const LYING: ReadonlySet<FrameId> = new Set(["prone", "crawl", "down", "dead"]);
