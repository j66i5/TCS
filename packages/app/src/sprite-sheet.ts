/** The soldier sprite sheet for screenshots (M7.5b), from the `main.ts` split (D2). */
import { lookOf, type Appearance } from "@tcs/data";
import { CELL, FRAMES, composeFrame, outlineMask, paletteFor, rotateFrame, type FrameId } from "@tcs/render";

/**
 * The soldier sprite sheet (M7.5b, screenshots): per side, every frame facing east, then the variants (machine gun
 * firing, marksman with a launcher wounded) and a turn through the 16 facings, at 3x on a grass-coloured canvas.
 */
export function showSpriteSheet(on: boolean, sides: { faction: string; colour: number }[], app: Appearance): void {
  document.getElementById("sprite-sheet")?.remove();
  if (!on) return;
  const Z = 3, frames = Object.keys(FRAMES) as FrameId[];
  const rows: { side: number; frame: FrameId; facing: number; v: { weapon: "rifle" | "mg" | "marksman"; launcher: boolean; firing: boolean; wounded: boolean } }[] = [];
  sides.forEach((_, si) => {
    for (const v of [{ weapon: "rifle", launcher: false, firing: false, wounded: false }, { weapon: "mg", launcher: false, firing: true, wounded: false }, { weapon: "marksman", launcher: true, firing: false, wounded: true }] as const) {
      for (const f of frames) rows.push({ side: si, frame: f, facing: 0, v });
    }
    for (let k = 0; k < 16; k++) rows.push({ side: si, frame: k % 2 ? "walk1" : "prone", facing: k, v: { weapon: "rifle", launcher: false, firing: false, wounded: false } });
  });
  const perRow = frames.length, cols = 16;
  const W = cols * CELL * Z, lines = Math.ceil(rows.length / perRow) + 2;
  const cv = document.createElement("canvas");
  cv.id = "sprite-sheet";
  cv.width = W; cv.height = lines * CELL * Z;
  Object.assign(cv.style, { position: "fixed", left: "0", top: "0", zIndex: "50", width: "100vw", imageRendering: "pixelated", background: "#6a8648" });
  const g = cv.getContext("2d")!;
  g.fillStyle = "#6a8648"; g.fillRect(0, 0, cv.width, cv.height);
  let line = 0, col = 0, last = -1;
  rows.forEach((r, i) => {
    const group = r.facing > 0 || (r.frame === "prone" && i > 0 && rows[i - 1]!.facing > 0) ? 1 : 0;
    const key = r.side * 10 + (r.v.weapon === "rifle" ? 0 : r.v.weapon === "mg" ? 1 : 2) * 2 + group;
    if (key !== last && col > 0) { line++; col = 0; }
    last = key;
    const pal = paletteFor(lookOf(app, sides[r.side]!.faction));
    const cell = rotateFrame(composeFrame({ frame: r.frame, ...r.v }), r.facing), out = outlineMask(cell);
    const ox = col * CELL * Z, oy = line * CELL * Z;
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      const l = cell[y * CELL + x]!;
      const c = l ? pal[l]! : out[y * CELL + x] ? sides[r.side]!.colour : -1;
      if (c < 0) continue;
      g.fillStyle = `#${c.toString(16).padStart(6, "0")}`;
      g.fillRect(ox + x * Z, oy + y * Z, Z, Z);
    }
    if (++col >= cols) { col = 0; line++; }
  });
  document.body.append(cv);
}
