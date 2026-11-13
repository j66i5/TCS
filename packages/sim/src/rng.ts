/**
 * Seeded random numbers with NAMED SUB-STREAMS.
 *
 * Every system draws from its own stream ("ballistics", "spotting", "ai/soldier/17", ...). A stream's
 * starting state depends only on (battle seed, stream name), so adding a random call in one system
 * never shifts the numbers another system sees. This keeps golden replays of unrelated systems stable.
 *
 * Generator: sfc32 (Small Fast Counting, 128-bit state, passes PractRand). Pure 32-bit integer maths,
 * so it is bit-identical on every JavaScript engine. Seeding via a string hash + splitmix32.
 *
 * The whole RNG state is plain data (stream name -> four uint32) and is part of the serialised SimState.
 */

export type StreamState = [number, number, number, number];
export interface RngState {
  /** Battle seed (uint32). */
  seed: number;
  /** Lazily created streams. Creation is deterministic, so laziness does not affect results. */
  streams: Record<string, StreamState>;
}

/** Well-known stream names. Systems may also use hierarchical names such as `ai/soldier/<id>`. */
export const Streams = {
  setup: "setup",
  ballistics: "ballistics",
  spotting: "spotting",
  wounds: "wounds",
  ai: "ai",
  comms: "comms",
  movement: "movement",
  fire: "fire",
  fragments: "fragments",
  contacts: "contacts",
  support: "support",
  /** Vehicle gunnery (M7.3): range errors of station tasks. Created on first use (vehicle-free battles never draw). */
  station: "station",
  /** Armour (M7.4a): ricochets, fuses, what a penetration strikes inside, fires. Created on first use. */
  armour: "armour",
  /** Shoulder-fired anti-tank weapons (M7.4a): aiming errors. Created on first use. */
  antitank: "antitank",
  /** Guided missiles (owner 2026-11-13): gunners' tracking errors, lost missiles. Created on first use. */
  missile: "missile",
} as const;

/** FNV-1a 32-bit hash of a string (UTF-16 code units). */
export function hashString32(s: string, h = 0x811c9dc5): number {
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function splitmix32(a: number): () => number {
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let z = a;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
}

export function createRng(seed: number): RngState {
  return { seed: seed >>> 0, streams: {} };
}

function initStream(seed: number, name: string): StreamState {
  const sm = splitmix32(hashString32(name, seed >>> 0 ^ 0x811c9dc5));
  const s: StreamState = [sm(), sm(), sm(), sm()];
  // Warm up so that similar names do not give correlated first outputs.
  for (let i = 0; i < 12; i++) sfc32Next(s);
  return s;
}

function sfc32Next(s: StreamState): number {
  let a = s[0], b = s[1], c = s[2], d = s[3];
  const t = (((a + b) | 0) + d) | 0;
  d = (d + 1) | 0;
  a = b ^ (b >>> 9);
  b = (c + (c << 3)) | 0;
  c = (c << 21) | (c >>> 11);
  c = (c + t) | 0;
  s[0] = a >>> 0; s[1] = b >>> 0; s[2] = c >>> 0; s[3] = d >>> 0;
  return t >>> 0;
}

function stream(rng: RngState, name: string): StreamState {
  let s = rng.streams[name];
  if (s === undefined) {
    s = initStream(rng.seed, name);
    rng.streams[name] = s;
  }
  return s;
}

/**
 * For hot loops: fetch a stream once, then draw from it with `streamFloat` (the same numbers, in the same
 * order, as repeated `nextFloat(rng, name)` calls).
 */
export function rngStream(rng: RngState, name: string): StreamState {
  return stream(rng, name);
}
export function streamFloat(s: StreamState): number {
  return sfc32Next(s) / 4294967296;
}

/** Uniform uint32. */
export function nextU32(rng: RngState, name: string): number {
  return sfc32Next(stream(rng, name));
}

/** Uniform float in [0, 1) with 32 bits of randomness. */
export function nextFloat(rng: RngState, name: string): number {
  return sfc32Next(stream(rng, name)) / 4294967296;
}

/** Uniform float in [lo, hi). */
export function nextRange(rng: RngState, name: string, lo: number, hi: number): number {
  return lo + (hi - lo) * nextFloat(rng, name);
}

/** Uniform integer in [0, n). n must be >= 1. */
export function nextInt(rng: RngState, name: string, n: number): number {
  return Math.floor(nextFloat(rng, name) * n);
}

/** True with probability p. */
export function chance(rng: RngState, name: string, p: number): boolean {
  return nextFloat(rng, name) < p;
}

/**
 * Approximately normal(0,1) sample using the Irwin-Hall sum of 12 uniforms.
 * Uses no transcendental maths, so it is engine-independent. Tails are cut at +-6 sigma,
 * which is fine for game abstractions. Swap for Box-Muller via sim/math if exact tails matter.
 */
export function nextNormal(rng: RngState, name: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += nextFloat(rng, name);
  return sum - 6;
}

/** Pick one element uniformly. Array must be non-empty. */
export function pick<T>(rng: RngState, name: string, items: readonly T[]): T {
  const v = items[nextInt(rng, name, items.length)];
  if (v === undefined) throw new Error("pick from empty array");
  return v;
}
