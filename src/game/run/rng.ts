import { hash32 } from '../weather/random';

/**
 * The run's random streams (Phase 23). Every draw is a STATELESS function of (seed, stream, keys): there is no live
 * RNG state to save, and a draw can never depend on the order of other draws, on the wall clock, on the guest RNG or on
 * the profile. mulberry32 over a hash32 mix of the seed, the stream salt and the keys.
 */
export type RunStream = 'starter' | 'biomes' | 'family' | 'conditions' | 'offer' | 'map' | 'park';

const STREAM_SALT: Readonly<Record<RunStream, number>> = {
  starter: 0x1a2b3c01,
  biomes: 0x1a2b3c02,
  family: 0x1a2b3c03,
  conditions: 0x1a2b3c04,
  offer: 0x1a2b3c05,
  map: 0x1a2b3c06,
  park: 0x1a2b3c07,
};

/** A uint32 from (seed, stream, a, b): used for map and park seeds. */
export const runHash32 = (seed: number, stream: RunStream, a = 0, b = 0): number => (
  hash32(hash32((seed ^ STREAM_SALT[stream]) >>> 0, a, b), 0x6a09e667, a ^ 0x51ed270b)
);

/** A draw sequence in [0, 1) for (seed, stream, a, b). */
export const runRandom = (seed: number, stream: RunStream, a = 0, b = 0): (() => number) => {
  let state = runHash32(seed, stream, a, b);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** A seeded Fisher-Yates shuffle into a new array. */
export const shuffled = <T>(items: readonly T[], random: () => number): T[] => {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
};

/** A stable uint32 key of a card id: FNV-1a over the UTF-16 code units. Depends on the id only. */
export const cardKey32 = (id: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
};

/** One candidate of a keyed weighted draw: an id and an integer weight (0 = never drawn). */
export interface KeyedCandidate<T extends string> {
  id: T;
  weight: number;
}

/**
 * The keyed weighted draw (Phase 25, design 5.1). A candidate of integer weight `w` gets `w` keys
 * `hash32(base, cardKey32(id), r)` for r = 0..w-1; all keys are sorted ascending (ties by id, then r) and walked: a
 * candidate is taken the first time one of its keys comes up and `accept(id, chosen)` passes, until `count` are taken.
 * The first pick has probability exactly w / sum(w). Integer hashing and comparisons only (no float, no engine
 * dependence), and a candidate's keys depend only on (base, its own id): a new candidate changes an old draw only where
 * its own key wins a place. Returns the ids in draw order.
 */
export const keyedWeightedDraw = <T extends string>(
  base: number,
  candidates: readonly KeyedCandidate<T>[],
  count: number,
  accept: (id: T, chosen: readonly T[]) => boolean = () => true,
): T[] => {
  const keys: Array<{ key: number; id: T; r: number }> = [];
  for (const { id, weight } of candidates) {
    if (!Number.isInteger(weight) || weight < 0) throw new RangeError(`a draw weight must be a non-negative integer (${id}: ${weight})`);
    const idKey = cardKey32(id);
    for (let r = 0; r < weight; r += 1) keys.push({ key: hash32(base >>> 0, idKey | 0, r), id, r });
  }
  keys.sort((left, right) => (left.key - right.key) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0) || (left.r - right.r));
  const chosen: T[] = [];
  for (const { id } of keys) {
    if (chosen.length >= count) break;
    if (chosen.includes(id)) continue;
    if (accept(id, chosen)) chosen.push(id);
  }
  return chosen;
};
