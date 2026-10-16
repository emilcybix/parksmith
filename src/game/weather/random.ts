/**
 * The weather-only random stream. It never shares draws with the guests' generator, so adding or
 * removing a weather draw can never move a single guest, and the whole stream is one saved uint32.
 */

/** Scrambles a park seed into the initial stream state (frozen copy lives in the 3->4 migration). */
export const mixSeed = (seed: number): number => {
  let hash = (seed ^ 0x9e3779b9) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
};

/** One mulberry32 step over a uint32 state: returns the new state and the draw in [0, 1). */
export class WeatherRandom {
  constructor(private state: number) {}

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let mixed = this.state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  }

  getState(): number {
    return this.state;
  }

  setState(value: number): void {
    this.state = value >>> 0;
  }
}

/** Pure uint32 hash of up to three integers, for storm slots and flash cells. */
export const hash32 = (a: number, b: number, c = 0): number => {
  let hash = Math.imul((a >>> 0) ^ 0x9e3779b9, 0x85ebca6b);
  hash ^= Math.imul((b | 0) + 0x7f4a7c15, 0xc2b2ae35);
  hash ^= Math.imul((c | 0) + 0x165667b1, 0x27d4eb2f);
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return hash >>> 0;
};
