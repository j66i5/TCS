/**
 * Sprite fix (2026-11-15, owner: "sometimes, characters look wrong"): the frame for every soldier state, carrying
 * parties, atlas keys and padding, and turning without losing the figure.
 */
import { describe, expect, it } from "vitest";
import { FRAMES, NO_LAUNCHER, type FrameId } from "../src/sprites/soldier-art";
import { CELL, FACINGS, GUTTER, KEYS_PER_SLOT, LETTERS, cellOrigin, composeFrame, enclosedMask, frameKey, outlineMask, rimMask, rotateFrame, type WeaponLook } from "../src/sprites/atlas";
import { carryLookOf, carryOffset, frameFor, type CarryRole, type ManState } from "../src/sprites/frames";
import { loadData } from "../../tools/src/scenarios";

const frames = Object.keys(FRAMES) as FrameId[];
const variants: { weapon: WeaponLook; launcher: boolean; firing: boolean; wounded: boolean }[] = [
  { weapon: "rifle", launcher: false, firing: false, wounded: false },
  { weapon: "mg", launcher: false, firing: true, wounded: false },
  { weapon: "marksman", launcher: true, firing: false, wounded: true },
  { weapon: "rifle", launcher: true, firing: true, wounded: true },
];
const FLASH = new Set([LETTERS.indexOf("f"), LETTERS.indexOf("x")]);
/** 8-connected groups of figure pixels (the muzzle flash and white cloth left out). */
function components(g: Uint8Array): number {
  const seen = new Uint8Array(g.length);
  let n = 0;
  for (let i = 0; i < g.length; i++) {
    if (seen[i] || g[i] === 0 || FLASH.has(g[i]!)) continue;
    n++;
    const st = [i]; seen[i] = 1;
    while (st.length) {
      const j = st.pop()!, x = j % CELL, y = (j / CELL) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy, k = Y * CELL + X;
        if (X < 0 || Y < 0 || X >= CELL || Y >= CELL || seen[k] || g[k] === 0 || FLASH.has(g[k]!)) continue;
        seen[k] = 1; st.push(k);
      }
    }
  }
  return n;
}
const count = (g: Uint8Array, l: number) => g.reduce((s, v) => s + (v === l ? 1 : 0), 0);

describe("frame for each soldier state", () => {
  const man = (o: Partial<ManState>): ManState => ({ casualty: "none", captive: null, posture: "standing", moving: false, step: 0, carry: null, ...o });
  const role = (o: Partial<CarryRole>): CarryRole => ({ look: "drag", index: -1, bearers: 1, phase: "move", leaderProne: false, ...o });
  it("postures, movement, casualties and prisoners", () => {
    expect(frameFor(man({}))).toBe("stand");
    expect(frameFor(man({ moving: true }))).toBe("walk1");
    expect(frameFor(man({ moving: true, step: 1 }))).toBe("walk2");
    expect(frameFor(man({ posture: "crouching" }))).toBe("crouch");
    expect(frameFor(man({ posture: "crouching", moving: true, step: 1 }))).toBe("crouchWalk");
    expect(frameFor(man({ posture: "prone" }))).toBe("prone");
    expect(frameFor(man({ posture: "prone", moving: true, step: 1 }))).toBe("crawl");
    expect(frameFor(man({ casualty: "incapacitated", posture: "prone" }))).toBe("down");
    // A casualty crawling to cover crawls (he used to slide along on his back).
    expect(frameFor(man({ casualty: "incapacitated", posture: "prone", moving: true, step: 1 }))).toBe("crawl");
    expect(frameFor(man({ casualty: "killed", carry: role({}) }))).toBe("dead");
    expect(frameFor(man({ captive: "surrendered", moving: true }))).toBe("surrender");
    expect(frameFor(man({ captive: "captured" }))).toBe("captive");
  });
  it("carrying parties: each method its own picture; nobody drawn lying on top of his bearer", () => {
    const hurt = { casualty: "incapacitated" as const, posture: "prone" as const };
    expect(frameFor(man({ ...hurt, carry: role({ look: "drag" }) }))).toBe("carried");
    expect(frameFor(man({ ...hurt, carry: role({ look: "drag", phase: "gather" }) }))).toBe("down");
    expect(frameFor(man({ ...hurt, carry: role({ look: "drag", phase: "rest" }) }))).toBe("down");
    expect(frameFor(man({ ...hurt, carry: role({ look: "litter", bearers: 4, phase: "setup" }) }))).toBe("stretcher");
    expect(frameFor(man({ ...hurt, carry: role({ look: "litter", bearers: 4, phase: "rest" }) }))).toBe("stretcher");
    expect(frameFor(man({ ...hurt, carry: role({ look: "seat", bearers: 2 }) }))).toBe("seated");
    // Fireman's carry: the bearer's frame shows both; put down when the bearer goes prone.
    expect(frameFor(man({ ...hurt, carry: role({ look: "shoulder" }) }))).toBeNull();
    expect(frameFor(man({ carry: role({ look: "shoulder", index: 0 }), moving: true }))).toBe("shoulder");
    expect(frameFor(man({ ...hurt, carry: role({ look: "shoulder", leaderProne: true }) }))).toBe("down");
    expect(frameFor(man({ posture: "prone", carry: role({ look: "shoulder", index: 0, leaderProne: true }) }))).toBe("prone");
    expect(frameFor(man({ carry: role({ look: "shoulder", index: 0, phase: "gather" }) }))).toBe("stand");
    // Supported: he walks (wounded but on his feet), beside his helper.
    expect(frameFor(man({ moving: true, carry: role({ look: "walks" }) }))).toBe("walk1");
    expect(frameFor(man({ moving: true, carry: role({ look: "drag", index: 0 }) }))).toBe("walk1");
  });
  it("carry methods in the data map to looks", () => {
    const med = loadData().medical!;
    const looks = Object.fromEntries(med.carry.map((m) => [m.id, carryLookOf(m, m.id === "stretcher")]));
    expect(looks).toMatchObject({ walking: "walks", supported: "walks", drag: "drag", "two-man-drag": "drag", fireman: "shoulder", "two-man": "seat", stretcher: "litter" });
    expect(carryLookOf(undefined, false)).toBe("drag");
  });
  it("bearers of a litter in pairs at its ends, two draggers side by side (drawn positions only)", () => {
    const at = (r: Partial<CarryRole>, trailBack: number) => { const o = carryOffset(role(r)); return { back: trailBack - o.ahead, right: o.right }; };
    // Sim trail: bearer 0 at 0 m, 1 at 0.3 m, 2 at 1.9 m, 3 at 2.2 m behind the leader's point.
    const b = [0, 0.3, 1.9, 2.2].map((d, i) => at({ look: "litter", bearers: 4, index: i }, d));
    expect(b[0]!.back).toBeCloseTo(b[1]!.back, 6); expect(b[2]!.back).toBeCloseTo(b[3]!.back, 6);
    expect(Math.abs(b[0]!.right - b[1]!.right)).toBeGreaterThan(0.55);
    const d = [0, 0.4].map((x, i) => at({ look: "drag", bearers: 2, index: i }, x));
    expect(d[0]!.back).toBeCloseTo(d[1]!.back, 6);
    expect(Math.abs(d[0]!.right - d[1]!.right)).toBeGreaterThan(0.55);
    expect(carryOffset(role({ look: "drag", bearers: 1, index: 0 }))).toEqual({ ahead: 0, right: 0 });
    expect(carryOffset(role({ look: "litter", bearers: 4, index: 1, phase: "gather" }))).toEqual({ ahead: 0, right: 0 });
    expect(carryOffset(null)).toEqual({ ahead: 0, right: 0 });
  });
});

describe("atlas keys and padding", () => {
  it("keys are unique per faction slot (a second faction never gets the first one's cells)", () => {
    let max = 0;
    const keys = new Set<number>();
    for (const f of frames) for (const v of variants) for (const launcher of [false, true]) for (let facing = 0; facing < FACINGS; facing++) {
      const k = frameKey({ frame: f, ...v, launcher, facing });
      keys.add(k); max = Math.max(max, k);
    }
    expect(max).toBeLessThan(KEYS_PER_SLOT);
    expect(keys.size).toBe(frames.length * variants.length * 2 * FACINGS);
  });
  it("every turned figure, its outline and its rim stay a pixel inside the cell; cells are a gutter apart", () => {
    for (const f of frames) for (const v of variants) for (let k = 0; k < FACINGS; k++) {
      const g = rotateFrame(composeFrame({ frame: f, ...v }), k), o = outlineMask(g), r = rimMask(o, g, true);
      for (let i = 0; i < CELL; i++) for (const j of [i, (CELL - 1) * CELL + i, i * CELL, i * CELL + CELL - 1]) {
        expect(g[j] || o[j] || r[j], `${f} ${v.weapon} ${k} at ${j}`).toBe(0);
      }
    }
    const w = 32 * (CELL + GUTTER);
    const a = cellOrigin(0, w), b = cellOrigin(1, w), c = cellOrigin(32, w);
    expect(b.x - a.x).toBe(CELL + GUTTER);
    expect(c.y - a.y).toBe(CELL + GUTTER);
    expect(a.x).toBeGreaterThanOrEqual(1);
    expect(GUTTER).toBeGreaterThanOrEqual(2);
  });
});

describe("turning keeps the figure whole", () => {
  it("every frame is one piece facing east; the outline never marks a gap inside the figure", () => {
    for (const f of frames) for (const v of variants) {
      const g = composeFrame({ frame: f, ...v });
      expect(components(g), `${f} ${JSON.stringify(v)}`).toBe(1);
      for (let k = 0; k < FACINGS; k++) {
        const r = rotateFrame(g, k), o = outlineMask(r), enc = enclosedMask(r);
        for (let i = 0; i < r.length; i++) if (enc[i]) expect(o[i], `${f} ${k}`).toBe(0);
      }
    }
  });
  it("no facing tears off a piece or loses a colour beyond tolerance", () => {
    for (const f of frames) for (const v of variants) {
      const g = composeFrame({ frame: f, ...v });
      for (let k = 1; k < FACINGS; k++) {
        const r = rotateFrame(g, k), tag = `${f} ${v.weapon}${v.firing ? " firing" : ""} facing ${k}`;
        expect(components(r), tag).toBe(1);
        for (let l = 1; l < LETTERS.length; l++) {
          const n0 = count(g, l);
          if (n0 === 0) continue;
          const n = count(r, l);
          // Every colour survives; larger areas keep at least 60 % of their pixels (and do not swell past 170 %).
          expect(n, `${tag} '${LETTERS[l]}'`).toBeGreaterThan(0);
          if (n0 >= 4) { expect(n / n0, `${tag} '${LETTERS[l]}'`).toBeGreaterThanOrEqual(0.6); expect(n / n0, `${tag} '${LETTERS[l]}'`).toBeLessThanOrEqual(1.7); }
        }
      }
    }
  });
  it("frames lying on the back or carried get no launcher", () => {
    for (const f of NO_LAUNCHER) expect(composeFrame({ frame: f, weapon: "rifle", launcher: true, firing: false, wounded: false })).toEqual(composeFrame({ frame: f, weapon: "rifle", launcher: false, firing: false, wounded: false }));
  });
});
