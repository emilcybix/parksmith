import { describe, expect, it } from 'vitest';

/**
 * Phase 24: the entrance is a MAP property. After this phase nothing in src/game, src/app or src/rendering may
 * hard-code the Meadow gate: not the cell (15, 31), not the framing cell (15.5, 20) the voxel camera and the
 * classic camera centre on, and nothing outside src/game may read the map size constant (the world and the
 * layout carry their own size; Phase 21 lifts the constant). One literal is allowed: the frozen Meadow state of
 * migration 7->8 in src/game/save/migrate.ts (comment `frozen: schema 7 entrance`; in version.ts until Phase 34 moved the chain), and the Meadow map data
 * itself, which is ASCII (an `E` in a row), not a coordinate.
 *
 * `PENDING_OUTSIDE_GAME` listed the files that still carried a literal while the renderer and app builders of
 * Phase 24 step 1 had not landed. The test fails when an entry no longer matches, so the list could only shrink;
 * step 1 is done and it is EMPTY: nothing may be added back.
 */
const PENDING_OUTSIDE_GAME: readonly string[] = [];

const ALLOWED_LITERALS = new Set(['src/game/save/migrate.ts']);

const LITERALS: ReadonlyArray<[string, RegExp]> = [
  ['the gate cell (15, 31)', /\bx:\s*15\s*,\s*y:\s*31\b/],
  ['the entrance framing cell (15.5, 20)', /15\.5\s*,\s*20\b/],
  ['ENTRANCE_VIEW_CELL', /\bENTRANCE_VIEW_CELL\b/],
  ['the map size constant halved (sweep centre)', /mapWidth\s*\/\s*2|mapHeight\s*\/\s*2/],
];
const MAP_SIZE_CONSTANT = /\bGAME_CONFIG\.map(Width|Height)\b|\bmapWidth\b|\bmapHeight\b/;

/** Every non-test source file of the folders that may not carry the literal, as raw text (the browser build has no Node typings). */
const sources = import.meta.glob(
  ['/src/game/**/*.{ts,tsx}', '/src/app/**/*.{ts,tsx}', '/src/rendering/**/*.{ts,tsx}', '/src/ui/**/*.{ts,tsx}', '/src/settings/**/*.{ts,tsx}', '!**/*.test.{ts,tsx}'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

const files = Object.entries(sources).map(([path, text]) => ({ path: path.replace(/^\//, ''), text }));

const offenders = (): string[] => {
  const found: string[] = [];
  for (const { path, text } of files) {
    if (ALLOWED_LITERALS.has(path)) continue;
    for (const [name, pattern] of LITERALS) if (pattern.test(text)) found.push(`${path}: ${name}`);
    if (!path.startsWith('src/game/') && MAP_SIZE_CONSTANT.test(text)) found.push(`${path}: the map size constant`);
  }
  return found;
};

describe('no hard-coded entrance outside the map data', () => {
  it('only the pending files (renderers and app, until their step lands) carry an entrance literal', () => {
    const unexpected = offenders().filter((entry) => !PENDING_OUTSIDE_GAME.some((file) => entry.startsWith(`${file}:`)));
    expect(unexpected, 'a literal gate cell or map size crept in').toEqual([]);
  });

  it('src/game is clean: the only gate literal is the frozen migration state', () => {
    expect(offenders().filter((entry) => entry.startsWith('src/game/'))).toEqual([]);
    const version = files.find((file) => file.path === 'src/game/save/migrate.ts')!;
    expect(version.text).toContain('frozen: schema 7 entrance');
    const matches = version.text.match(/x:\s*15\s*,\s*y:\s*31/g) ?? [];
    expect(matches.length, 'exactly one literal').toBe(1);
  });

  it('the pending list only shrinks: every entry still has a literal to remove', () => {
    const stale = PENDING_OUTSIDE_GAME.filter((file) => !offenders().some((entry) => entry.startsWith(`${file}:`)));
    expect(stale, 'remove these entries from PENDING_OUTSIDE_GAME: their literals are gone').toEqual([]);
  });

  it('the shipped Meadow map is the only place that spells the default gate, as an ASCII row', () => {
    const content = files.find((file) => file.path === 'src/game/maps/content.ts')!;
    expect(content.text).toContain('\'...............E................\'');
  });
});
