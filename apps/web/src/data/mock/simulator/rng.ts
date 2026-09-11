/**
 * Deterministic seeded PRNG for the demo simulator (spec 12.3).
 * mulberry32: tiny, fast, good enough for plausible-looking factory data.
 */

export interface Rng {
  /** Uniform [0, 1). */
  next(): number;
  /** Uniform float in [min, max). */
  range(min: number, max: number): number;
  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** Uniform element of a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** In-place Fisher-Yates shuffle of a copy. */
  shuffle<T>(items: readonly T[]): T[];
  /** Multiplicative noise centred on 1 (log-normal-ish, median exactly 1). */
  noise(spread: number): number;
}

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng: Rng = {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
    shuffle: <T,>(items: readonly T[]): T[] => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const tmp = out[i]!;
        out[i] = out[j]!;
        out[j] = tmp;
      }
      return out;
    },
    /**
     * Symmetric multiplicative noise: exp(u) with u uniform in [-spread, spread].
     * Median is exactly 1 so it does not bias computed standards.
     */
    noise: (spread) => Math.exp((next() * 2 - 1) * spread),
  };
  return rng;
}

/** Stable 32-bit hash of a string, used to derive per-entity sub-seeds. */
export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
