import { describe, expect, it } from 'vitest';
import { BIOME_IDS } from '../biomes/types';
import { BIOME_WORDS, NAME_SUFFIXES, assignNames, gateNameOf, nameCandidate, sectorOf } from './names';

describe('neighborhood names', () => {
  it('have eight words per biome and eight suffixes, all distinct', () => {
    expect(Object.keys(BIOME_WORDS).sort()).toEqual([...BIOME_IDS].sort());
    for (const id of BIOME_IDS) {
      expect(BIOME_WORDS[id]).toHaveLength(8);
      expect(new Set(BIOME_WORDS[id]).size).toBe(8);
    }
    expect(NAME_SUFFIXES).toEqual(['Quarter', 'Corner', 'Green', 'Row', 'Square', 'Lanes', 'Court', 'Walk']);
  });

  it('name the gate after the biome', () => {
    expect(gateNameOf('meadow')).toBe('Meadow Gate');
    expect(gateNameOf('seaside')).toBe('Harbor Gate');
    expect(gateNameOf('desert-canyon')).toBe('Mesa Gate');
    expect(gateNameOf('winter')).toBe('Frost Gate');
    expect(gateNameOf('jungle')).toBe('Vine Gate');
    expect(gateNameOf('autumn-forest')).toBe('Maple Gate');
    expect(gateNameOf('unknown')).toBe('Meadow Gate');
  });

  it('hash the biome and the anchor (pure, biome-aware)', () => {
    const anchor = { x: 7, y: 12 };
    expect(nameCandidate('meadow', anchor)).toBe(nameCandidate('meadow', { ...anchor }));
    for (const id of BIOME_IDS) {
      const [word, suffix] = nameCandidate(id, anchor).split(' ');
      expect(BIOME_WORDS[id]).toContain(word);
      expect(NAME_SUFFIXES).toContain(suffix);
    }
    // Different anchors spread over the vocabulary.
    const names = new Set<string>();
    for (let y = 0; y < 32; y += 4) for (let x = 0; x < 32; x += 4) names.add(nameCandidate('jungle', { x, y }));
    expect(names.size).toBeGreaterThan(30);
  });

  it('resolve collisions in key order, so an older neighborhood keeps its name', () => {
    const anchor = { x: 3, y: 3 };
    // Two leaders on the same anchor collide on purpose: the first keeps the first candidate, the second steps.
    const names = assignNames('winter', [{ key: 2, anchor }, { key: 9, anchor }]);
    expect(names.get(2)).toBe(nameCandidate('winter', anchor));
    expect(names.get(9)).not.toBe(names.get(2));
    expect(names.get(9)).toBe(nameCandidate('winter', anchor, 1) === names.get(2) ? nameCandidate('winter', anchor, 2) : nameCandidate('winter', anchor, 1));
    // Adding a newer leader never renames an older one.
    const more = assignNames('winter', [{ key: 2, anchor }, { key: 9, anchor }, { key: 14, anchor: { x: 20, y: 5 } }]);
    expect(more.get(2)).toBe(names.get(2));
    expect(more.get(9)).toBe(names.get(9));
  });

  it('stay unique for more leaders than word/suffix pairs (numbered fallback)', () => {
    const leaders = Array.from({ length: 70 }, (_, index) => ({ key: index + 1, anchor: { x: index % 32, y: Math.floor(index / 32) } }));
    const names = [...assignNames('meadow', leaders).values()];
    expect(new Set(names).size).toBe(70);
    expect(names).not.toContain('Meadow Gate');
  });

  it('put a point in a 3x3 split of the map in world compass words (north = low y)', () => {
    expect(sectorOf(0, 0, 32, 32)).toBe('north-west');
    expect(sectorOf(15.5, 0, 32, 32)).toBe('north');
    expect(sectorOf(31, 0, 32, 32)).toBe('north-east');
    expect(sectorOf(0, 15.5, 32, 32)).toBe('west');
    expect(sectorOf(15.5, 15.5, 32, 32)).toBe('centre');
    expect(sectorOf(31, 15, 32, 32)).toBe('east');
    expect(sectorOf(2, 31, 32, 32)).toBe('south-west');
    expect(sectorOf(15, 31, 32, 32)).toBe('south');
    expect(sectorOf(31, 31, 32, 32)).toBe('south-east');
  });
});
