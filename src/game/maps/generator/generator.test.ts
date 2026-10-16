import { describe, expect, it } from 'vitest';
import { BIOME_IDS } from '../../biomes/types';
import { GAME_CONFIG } from '../../config';
import { hash32 } from '../../weather/random';
import { groundRowsOf, layoutOfMap } from '../parse';
import { GROUND_WATER } from '../types';
import {
  DEFAULT_GENERATOR_OPTIONS, GENERATOR_VERSION, MAP_DENSITIES, MAX_SEED, biomeWaterOption, generateMap, generatedMapHash, generatedMapId,
  generatedMapName, parseSeedText, readRecipe, recipeOf,
} from './index';
import { makeNoise } from './noise';
import { PROP_KIND_IDS } from '../props';
import { PROP_BOX_WEIGHT, weightPerCell } from './weights';

describe('recipes and seeds', () => {
  it('recipeOf defaults, forces water off where a biome has none and rejects bad seeds', () => {
    expect(recipeOf('meadow', 7)).toEqual({ generatorVersion: GENERATOR_VERSION, biomeId: 'meadow', seed: 7, density: 'normal', water: true });
    expect(DEFAULT_GENERATOR_OPTIONS).toEqual({ density: 'normal', water: true, size: 32 });
    expect(recipeOf('desert-canyon', 7, { water: true }).water).toBe(false);
    expect(recipeOf('seaside', 0, { water: false, density: 'high' })).toMatchObject({ water: false, density: 'high', seed: 0 });
    for (const bad of [-1, 1.5, MAX_SEED + 1, Number.NaN, Infinity]) expect(() => recipeOf('meadow', bad)).toThrow(RangeError);
    expect(() => recipeOf('nowhere' as never, 1)).toThrow(RangeError);
    expect(() => recipeOf('meadow', 1, { density: 'dense' as never })).toThrow(RangeError);
    expect(recipeOf('meadow', MAX_SEED).seed).toBe(MAX_SEED);
  });

  it('water options: a label for five biomes and none for Desert Canyon', () => {
    expect(BIOME_IDS.map((id) => biomeWaterOption(id).label)).toEqual(['Ponds and brooks', 'Sea', null, 'Thin ice', 'River', 'Streams']);
    expect(biomeWaterOption('desert-canyon').available).toBe(false);
    expect(biomeWaterOption('seaside').available).toBe(true);
  });

  it('ids and names: gen-<biome>-<seed>-<density letter><w or d>', () => {
    expect(generatedMapId(recipeOf('seaside', 1234))).toBe('gen-seaside-1234-nw');
    expect(generatedMapId(recipeOf('autumn-forest', 5, { density: 'low', water: false }))).toBe('gen-autumn-forest-5-ld');
    expect(generatedMapId(recipeOf('jungle', MAX_SEED, { density: 'high' }))).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(generatedMapName({ seed: 1234 })).toBe('Generated · seed 1234');
  });

  it.each([
    ['', null], ['   ', null], [' 12 ', 12], ['01', 1], ['0', 0], ['-1', null], ['+5', null], ['4294967295', 4294967295], ['4294967296', null],
    ['1e3', null], ['12a', null], ['1 2', null], ['12345678901', null], ['0x10', null], ['١٢', null], ['1.5', null],
  ])('parseSeedText(%j) = %j', (text, expected) => {
    expect(parseSeedText(text)).toBe(expected);
  });

  it('readRecipe accepts what recipeOf makes and reports the first problem without throwing', () => {
    const good = recipeOf('winter', 99, { density: 'low' });
    expect(readRecipe(JSON.parse(JSON.stringify(good)))).toEqual(good);
    const problem = (value: unknown): string => {
      const read = readRecipe(value);
      return 'problem' in read ? read.problem : 'OK';
    };
    expect(problem(null)).toMatch(/not an object/);
    expect(problem([])).toMatch(/not an object/);
    expect(problem({ ...good, extra: 1 })).toMatch(/unknown key/);
    expect(problem({ ...good, seed: undefined })).toMatch(/seed|missing/);
    expect(problem({ ...good, generatorVersion: 0 })).toMatch(/generatorVersion/);
    expect(problem({ ...good, generatorVersion: 65536 })).toMatch(/generatorVersion/);
    expect(problem({ ...good, seed: -1 })).toMatch(/seed/);
    expect(problem({ ...good, density: 'x' })).toMatch(/density/);
    expect(problem({ ...good, water: 1 })).toMatch(/water/);
    expect(problem({ ...good, biomeId: 'desert-canyon', water: true })).toMatch(/no water option/);
    expect(problem({ ...good, biomeId: 'moon' })).toMatch(/biome/);
  });
});

describe('integer noise', () => {
  it('is a pure positional function: same inputs, same outputs, in any order, integers in range', () => {
    const a = makeNoise(0x1234);
    const b = makeNoise(0x1234);
    const forward: number[] = [];
    for (let i = 0; i < 200; i += 1) forward.push(a.fbm(5, i, 200 - i));
    const backward: number[] = [];
    for (let i = 199; i >= 0; i -= 1) backward.unshift(b.fbm(5, i, 200 - i));
    expect(backward).toEqual(forward);
    for (const value of forward) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(65536);
    }
    for (let t = -10; t < 80; t += 1) {
      const offset = a.meander(3, t, 3, 3);
      expect(Number.isInteger(offset)).toBe(true);
      expect(Math.abs(offset)).toBeLessThanOrEqual(3);
    }
    expect(makeNoise(1).fbm(5, 3, 4)).not.toBe(makeNoise(2).fbm(5, 3, 4));
  });
});

describe('generateMap', () => {
  const samples = BIOME_IDS.flatMap((biome) => [1, 1234, 0xdeadbeef].map((seed) => recipeOf(biome, seed)));

  it('the same recipe gives the identical map, 1,000 repeats', () => {
    const recipe = recipeOf('seaside', 1234);
    const first = generatedMapHash(generateMap(recipe));
    for (let run = 0; run < 1_000; run += 1) {
      if (generatedMapHash(generateMap(recipe)) !== first) throw new Error(`run ${run} differs`);
    }
  }, 120_000);

  it('the call order does not matter: biomes forward and backward give the same hashes', () => {
    const forward = samples.map((recipe) => generatedMapHash(generateMap(recipe)));
    const backward = [...samples].reverse().map((recipe) => generatedMapHash(generateMap(recipe))).reverse();
    expect(backward).toEqual(forward);
  });

  it('different seeds, biomes, densities and water give different maps', () => {
    const hashes = new Set<string>();
    for (const recipe of samples) hashes.add(generatedMapHash(generateMap(recipe)));
    expect(hashes.size).toBe(samples.length);
    const base = generatedMapHash(generateMap(recipeOf('meadow', 5)));
    expect(generatedMapHash(generateMap(recipeOf('meadow', 5, { density: 'high' })))).not.toBe(base);
    expect(generatedMapHash(generateMap(recipeOf('meadow', 5, { water: false })))).not.toBe(base);
  });

  it('round trip: the definition parses back to exactly the layout, with the recipe, name, id and the seed as park seed', () => {
    for (const recipe of samples) {
      const map = generateMap(recipe);
      const parsed = layoutOfMap(map.definition, recipe);
      expect(groundRowsOf(parsed.ground, 32, 32)).toEqual(map.definition.ground);
      expect(parsed.props).toEqual(map.layout.props);
      expect(parsed.entrance).toEqual(map.layout.entrance);
      expect(map.layout.recipe).toBe(recipe);
      expect(map.layout.name).toBe(generatedMapName(recipe));
      expect(map.layout.id).toBe(generatedMapId(recipe));
      expect(map.layout.seed).toBe(recipe.seed);
      expect(map.definition.blurb.length).toBeLessThanOrEqual(160);
      map.layout.props.forEach((prop, index) => expect(prop.id).toBe(index + 1));
      expect(Object.isFrozen(map.layout)).toBe(true);
    }
  });

  it('water off means no water, and Desert Canyon never has any', () => {
    for (const biome of BIOME_IDS) {
      for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
        const map = generateMap(recipeOf(biome, seed, { water: false }));
        expect(map.layout.ground.includes(GROUND_WATER), `${biome} ${seed}`).toBe(false);
      }
    }
    for (const seed of [1, 2, 3, 4]) {
      expect(generateMap(recipeOf('desert-canyon', seed, { water: true })).layout.ground.includes(GROUND_WATER)).toBe(false);
    }
  });

  it('water on gives water in the five biomes that have it (most seeds)', () => {
    for (const biome of BIOME_IDS.filter((id) => biomeWaterOption(id).available)) {
      let wet = 0;
      for (let i = 0; i < 20; i += 1) if (generateMap(recipeOf(biome, hash32(i, 3))).stats.water > 0) wet += 1;
      expect(wet, biome).toBeGreaterThanOrEqual(19);
    }
  });

  it('refuses a recipe of another generator version', () => {
    expect(() => generateMap({ ...recipeOf('meadow', 1), generatorVersion: GENERATOR_VERSION + 1 })).toThrow(RangeError);
    expect(() => generateMap({ ...recipeOf('meadow', 1), generatorVersion: 0 })).toThrow(RangeError);
  });

  it('density changes the obstacle count in the expected direction', () => {
    for (const biome of BIOME_IDS) {
      let low = 0;
      let high = 0;
      for (let i = 0; i < 12; i += 1) {
        low += generateMap(recipeOf(biome, i, { density: 'low' })).stats.props;
        high += generateMap(recipeOf(biome, i, { density: 'high' })).stats.props;
      }
      expect(high, biome).toBeGreaterThan(low);
    }
    expect(MAP_DENSITIES).toEqual(['low', 'normal', 'high']);
  });
});

describe('box weights', () => {
  it('every prop kind has a positive weight (the voxel honesty test asserts measured <= weight) and the caps leave room for the gate', () => {
    for (const id of PROP_KIND_IDS) {
      expect(PROP_BOX_WEIGHT[id], id).toBeGreaterThan(0);
      expect(PROP_BOX_WEIGHT[id] % 5, `${id} is a multiple of 5`).toBe(0);
      expect(weightPerCell(id)).toBeGreaterThan(0);
    }
    expect(Object.keys(PROP_BOX_WEIGHT).length).toBe(PROP_KIND_IDS.length);
    // PROP_MAP_BOX_BUDGET (rendering/voxel/budgets.ts) is 1,650 per chunk and 9,100 total with the gate (112) and about 150 of ground.
    expect(GAME_CONFIG.maps.generator.chunkPropWeightCap + 112 + 50).toBeLessThanOrEqual(1_650);
    expect(GAME_CONFIG.maps.generator.mapPropWeightCap + 150).toBeLessThanOrEqual(9_100);
  });
});

describe('generator source discipline', () => {
  const sources = import.meta.glob<string>(['./*.ts', '!./*.test.ts'], { query: '?raw', import: 'default', eager: true });

  it('uses no Math.random, clock, float math, guest RNG or weather RNG (integers and positional hashes only)', () => {
    expect(Object.keys(sources).length).toBeGreaterThanOrEqual(8);
    const forbidden = [/Math\.random/, /Date\.now/, /new Date/, /performance\./, /Math\.(sin|cos|tan|sqrt|pow|exp|log|atan|hypot|cbrt)/, /WeatherRandom/, /guests\//, /\bparseFloat\b/, /toFixed/];
    for (const [file, raw] of Object.entries(sources)) {
      const text = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const pattern of forbidden) expect(pattern.test(text), `${file} must not match ${pattern}`).toBe(false);
    }
  });
});
