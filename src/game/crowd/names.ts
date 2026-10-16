/**
 * Phase 14: the neighborhood vocabulary (design Q3.5 and Q3.6). Names are hashed from the biome and the leader ride's
 * anchor, never from an object id, so a ride rebuilt on the same spot (undo, rebuild) gives the same name. A collision
 * is resolved in key order by stepping the hash, so an older neighborhood (lower key) always keeps its name. Never
 * player-authored, never saved.
 */
import { BIOME_IDS, type BiomeId } from '../biomes/types';
import type { Cell } from '../types';
import { hash32 } from '../weather/random';
import type { SectorWord } from './types';

/** Eight words per biome (owner may edit). The first word also names the gate ("Meadow Gate"). */
export const BIOME_WORDS: Readonly<Record<BiomeId, readonly string[]>> = Object.freeze({
  meadow: ['Meadow', 'Clover', 'Bramble', 'Willow', 'Buttercup', 'Thistle', 'Foxglove', 'Hawthorn'],
  seaside: ['Harbor', 'Shell', 'Driftwood', 'Lighthouse', 'Pebble', 'Gull', 'Tide', 'Coral'],
  'desert-canyon': ['Mesa', 'Sandstone', 'Cactus', 'Dune', 'Canyon', 'Sunrock', 'Arroyo', 'Sage'],
  winter: ['Frost', 'Pine', 'Snowdrift', 'Icicle', 'Sledge', 'Aurora', 'Birch', 'Hearth'],
  jungle: ['Vine', 'Orchid', 'Canopy', 'Temple', 'Mango', 'Fern', 'Lagoon', 'Parrot'],
  'autumn-forest': ['Maple', 'Acorn', 'Russet', 'Hollow', 'Chestnut', 'Ember', 'Bracken', 'Oak'],
});

export const NAME_SUFFIXES: readonly string[] = Object.freeze(['Quarter', 'Corner', 'Green', 'Row', 'Square', 'Lanes', 'Court', 'Walk']);

/** Hash steps tried before a numbered fallback (64 word/suffix pairs per biome; a 32x32 map holds far fewer). */
const MAX_STEPS = 256;

const biomeIndexOf = (biomeId: string): number => {
  const index = (BIOME_IDS as readonly string[]).indexOf(biomeId);
  return index < 0 ? 0 : index;
};

const wordsOf = (biomeId: string): readonly string[] => BIOME_WORDS[BIOME_IDS[biomeIndexOf(biomeId)]];

/** "Meadow Gate", "Harbor Gate", ... (an unknown biome falls back to Meadow's words). */
export const gateNameOf = (biomeId: string): string => `${wordsOf(biomeId)[0]} Gate`;

/** The first-choice name for a leader anchored at `anchor` (step 0 of the hash sequence). */
export const nameCandidate = (biomeId: string, anchor: Readonly<Cell>, step = 0): string => {
  const biome = biomeIndexOf(biomeId);
  let hash = hash32(biome + 1, anchor.x, anchor.y);
  for (let index = 0; index < step; index += 1) hash = hash32(hash, index + 1, biome + 1);
  const words = wordsOf(biomeId);
  return `${words[hash % words.length]} ${NAME_SUFFIXES[(hash >>> 8) % NAME_SUFFIXES.length]}`;
};

/**
 * Names for the leaders, processed in the order given (callers pass ascending key). Each takes its first hash
 * candidate not already taken by an earlier leader (or by the gate name); after `MAX_STEPS` tries a numbered form.
 */
export const assignNames = (
  biomeId: string,
  leaders: readonly { readonly key: number; readonly anchor: Readonly<Cell> }[],
): Map<number, string> => {
  const taken = new Set<string>([gateNameOf(biomeId)]);
  const names = new Map<number, string>();
  for (const leader of leaders) {
    let name: string | null = null;
    for (let step = 0; step < MAX_STEPS && name === null; step += 1) {
      const candidate = nameCandidate(biomeId, leader.anchor, step);
      if (!taken.has(candidate)) name = candidate;
    }
    if (name === null) {
      const base = nameCandidate(biomeId, leader.anchor);
      let suffix = 2;
      while (taken.has(`${base} ${suffix}`)) suffix += 1;
      name = `${base} ${suffix}`;
    }
    taken.add(name);
    names.set(leader.key, name);
  }
  return names;
};

const SECTORS: readonly (readonly SectorWord[])[] = [
  ['north-west', 'north', 'north-east'],
  ['west', 'centre', 'east'],
  ['south-west', 'south', 'south-east'],
];

/** World compass word for a point in a 3x3 split of the map (north = row 0, west = column 0). */
export const sectorOf = (x: number, y: number, width: number, height: number): SectorWord => {
  const column = Math.min(2, Math.max(0, Math.floor(((x + 0.5) * 3) / width)));
  const row = Math.min(2, Math.max(0, Math.floor(((y + 0.5) * 3) / height)));
  return SECTORS[row][column];
};
