import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { MAP_BY_ID } from './content';
import { layoutOfMap } from './parse';
import { validateMapDefinition } from './validate';
import { MapFormatError, type MapDefinition, type MapProblemCode } from './types';

const BASE = MAP_BY_ID.get('brookside-meadow') as MapDefinition;
const EMPTY = MAP_BY_ID.get('meadow') as MapDefinition;

const blank = (fill = '.'): string[] => Array.from({ length: 32 }, () => fill.repeat(32));
const set = (rows: readonly string[], x: number, y: number, ch: string): string[] => rows.map((row, index) => (
  index === y ? row.slice(0, x) + ch + row.slice(x + 1) : row
));
const withRows = (rows: string[], extra: Partial<MapDefinition> = {}): MapDefinition => ({ ...EMPTY, rows, ...extra });
/** A Seaside map with a pier ('#') or a palm ('T') on the given ground character, everything else base. */
const seasideWith = (char: string, under: string): MapDefinition => {
  const rows = set(set(blank(), 15, 31, 'E'), 5, 5, char);
  return { ...EMPTY, biome: 'seaside', rows, ground: set(blank(), 5, 5, under) };
};
const codes = (definition: MapDefinition): MapProblemCode[] => validateMapDefinition(definition).map((problem) => problem.code);

describe('validateMapDefinition', () => {
  it('accepts the empty meadow and a populated map', () => {
    expect(validateMapDefinition(EMPTY)).toEqual([]);
    expect(validateMapDefinition(BASE)).toEqual([]);
  });

  const gate = (rows: string[]): string[] => set(rows, 15, 31, 'E');
  const failing: Array<[MapProblemCode, () => MapDefinition]> = [
    ['format', () => ({ ...EMPTY, formatVersion: 2 as never })],
    // Phase 21: 32..64 in whole 8-cell parcels; 36 is not whole parcels, 72 is above the maximum.
    ['size', () => ({ ...EMPTY, width: 36, height: 32 })],
    ['size', () => ({ ...EMPTY, width: 72, height: 72 })],
    ['rows', () => withRows(blank().slice(1))],
    ['char', () => withRows(set(gate(blank()), 3, 3, '?'))],
    ['entrance-count', () => withRows(blank())],
    ['entrance-border', () => withRows(set(blank(), 10, 10, 'E'))],
    ['entrance-corner', () => withRows(set(blank(), 0, 0, 'E'))],
    ['entrance-inward-blocked', () => withRows(set(gate(blank()), 15, 30, '~'))],
    ['legend', () => withRows(set(gate(blank()), 3, 3, 's'))],
    ['block-shape', () => withRows(set(gate(blank()), 3, 3, 'X'), { biome: 'meadow' })],
    ['too-many-props', () => {
      // 321 single oaks in the rows above the First Day apron (the density rule fires as well; only the count is asserted).
      let rows = gate(blank());
      let placed = 0;
      for (let y = 0; y < 20 && placed < GAME_CONFIG.maps.maxProps + 1; y += 1) {
        for (let x = 0; x < 32 && placed < GAME_CONFIG.maps.maxProps + 1; x += 1) {
          if (x % 3 !== 2) { rows = set(rows, x, y, 'T'); placed += 1; }
        }
      }
      return withRows(rows);
    }],
    ['chunk-density', () => {
      let rows = gate(blank());
      for (let y = 0; y < 7; y += 1) for (let x = 0; x < 7; x += 1) rows = set(rows, x, y, 'b');
      return withRows(rows);
    }],
    ['apron-blocked', () => withRows(set(gate(blank()), 14, 25, 'T'))],
    ['open-area', () => {
      // Walls of water around the apron leave about 66 open cells: below the 160 minimum.
      let rows = gate(blank());
      for (let y = 0; y < 20; y += 1) rows = set(rows, 12, y, '~');
      for (let y = 0; y < 20; y += 1) rows = set(rows, 19, y, '~');
      for (let x = 12; x <= 19; x += 1) rows = set(rows, x, 19, '~');
      for (let y = 20; y < 32; y += 1) { rows = set(rows, 10, y, '~'); rows = set(rows, 21, y, '~'); }
      for (let x = 10; x <= 21; x += 1) rows = set(rows, x, 20, x >= 13 && x <= 18 ? '.' : '~');
      return withRows(rows);
    }],
    ['cleared-area', () => {
      // Permanent canyon walls close the same pocket, so clearing frees nothing.
      let rows = gate(blank());
      for (let y = 0; y < 32; y += 1) { rows = set(rows, 12, y, '#'); rows = set(rows, 19, y, '#'); }
      for (let x = 12; x <= 19; x += 1) rows = set(rows, x, 19, '#');
      return withRows(rows, { biome: 'desert-canyon' });
    }],
    ['starting-object', () => ({ ...EMPTY, startingObjects: { paths: [{ x: 50, y: 50 }], objects: [] } })],
    ['owned-area', () => ({ ...EMPTY, ownedArea: { x0: 0, y0: 0, x1: 5, y1: 5 } })],
    // Phase 21: a rectangle holding the gate but not whole parcels.
    ['owned-area', () => ({ ...EMPTY, ownedArea: { x0: 5, y0: 20, x1: 25, y1: 31 } })],
    ['seed', () => ({ ...EMPTY, seed: -1 })],
    // Explicit ground rows: a wrong shape, and a disagreement with `rows` at a cell without a prop.
    ['ground', () => withRows(gate(blank()), { ground: blank().slice(1) })],
    ['surface', () => seasideWith('#', '.')],
  ];

  it.each(failing.map(([code, make]) => [code, make] as const))('reports %s', (code, make) => {
    expect(codes(make())).toContain(code);
  });

  it('covers every problem code', () => {
    const covered = new Set(failing.map(([code]) => code));
    const all: MapProblemCode[] = [
      'format', 'size', 'rows', 'char', 'entrance-count', 'entrance-border', 'entrance-corner', 'entrance-inward-blocked',
      'legend', 'block-shape', 'too-many-props', 'chunk-density', 'apron-blocked', 'open-area', 'cleared-area',
      'starting-object', 'owned-area', 'seed', 'ground', 'surface',
    ];
    for (const code of all) expect(covered.has(code), code).toBe(true);
  });

  it('a lonely L and a broken 2x2 are block-shape problems; a valid pair and square are not', () => {
    expect(codes(withRows(set(gate(blank()), 3, 3, 'L')))).toContain('block-shape');
    expect(codes(withRows(set(set(gate(blank()), 3, 3, 'L'), 4, 3, 'L')))).not.toContain('block-shape');
    expect(codes(withRows(set(gate(blank()), 3, 3, 'X'), { biome: 'meadow' }))).toContain('block-shape');
    let rows = gate(blank());
    for (const [x, y] of [[3, 3], [4, 3], [3, 4], [4, 4]]) rows = set(rows, x, y, 'X');
    expect(codes(withRows(rows))).not.toContain('block-shape');
  });

  it('a kind of the wrong footprint for its character is a legend problem', () => {
    // 'L' in the desert legend does not exist.
    expect(codes(withRows(set(set(gate(blank()), 3, 3, 'L'), 4, 3, 'L'), { biome: 'desert-canyon' }))).toContain('legend');
  });

  it('ground rows: a disagreement, a pier on land, a palm on water and the E cell are checked; valid ground passes', () => {
    const disagreement = withRows(gate(blank()), { ground: set(blank(), 3, 3, ',') });
    expect(validateMapDefinition(disagreement).map((p) => p.code)).toEqual(['ground']);
    expect(codes(seasideWith('#', '.'))).toContain('surface');
    expect(codes(seasideWith('T', '~'))).toContain('surface');
    expect(codes({ ...EMPTY, biome: 'seaside', rows: set(set(blank(), 15, 31, 'E'), 5, 5, 'T'), ground: set(blank(), 5, 5, ',') })).not.toContain('surface');
    expect(codes(seasideWith('#', '~'))).not.toContain('surface');
    expect(codes(withRows(gate(blank()), { ground: set(blank(), 15, 31, ',') }))).toContain('ground');
    expect(codes(withRows(gate(blank()), { ground: set(blank(), 3, 3, 'x') }))).toContain('ground');
  });

  it('a valid owned area is accepted and the map ids are checked', () => {
    expect(validateMapDefinition({ ...EMPTY, ownedArea: { x0: 0, y0: 16, x1: 31, y1: 31 } })).toEqual([]);
    expect(codes({ ...EMPTY, id: 'Bad Id' as never })).toContain('format');
    expect(codes({ ...EMPTY, blurb: '' })).toContain('format');
  });

  it('layoutOfMap throws MapFormatError listing the problems of a malformed map', () => {
    expect(() => layoutOfMap(withRows(blank()))).toThrow(MapFormatError);
    try {
      layoutOfMap(withRows(set(blank(), 10, 10, 'E')));
    } catch (error) {
      expect((error as MapFormatError).problems.join()).toMatch(/entrance-border/);
    }
  });

  it('starting objects are stamped through scenario setup (free): a valid starting path passes, a blocked one fails', () => {
    const ok = { ...EMPTY, startingObjects: { paths: [{ x: 15, y: 30 }, { x: 15, y: 29 }], objects: [{ definitionId: 'picnic-pocket', anchor: { x: 16, y: 26 } }] } };
    expect(validateMapDefinition(ok)).toEqual([]);
    const lake = withRows(set(gate(blank()), 3, 3, '~'), { startingObjects: { paths: [{ x: 3, y: 3 }], objects: [] } });
    expect(codes(lake)).toContain('starting-object');
  });
});
