import { describe, expect, it } from 'vitest';
import { BIOME_BY_ID } from '../../biomes/content';
import { BIOME_IDS, type BiomeId } from '../../biomes/types';
import { GAME_CONFIG } from '../../config';
import { entranceFrame } from '../frame';
import { propFootprintSize } from '../parse';
import { PROP_KIND_BY_ID } from '../props';
import { GROUND_BASE, GROUND_WATER, type MapLayout } from '../types';
import { hash32 } from '../../weather/random';
import { validateMapDefinition } from '../validate';
import { biomeWaterOption, generateMap, generatedMapId, MAP_DENSITIES, recipeOf, propWeightPerChunk, type GeneratedMap, type MapDensity } from './index';

const REPORT = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env.GENERATOR_REPORT === '1';

/**
 * The generator fuzz (Phase 24 step 2): 500 seeds x 6 biomes x 3 densities (water on) plus 100 x 6 water off. Every
 * check below is written against the emitted layout, not the generator's own bookkeeping.
 */

const SEEDS = 500;
const gen = GAME_CONFIG.maps.generator;

const checkMap = (map: GeneratedMap, label: string): void => {
  const { layout, stats, recipe, definition } = map;
  const problems: string[] = [];
  const check = (condition: boolean, what: string): void => { if (!condition) problems.push(`${label}: ${what}`); };
  const validation = validateMapDefinition(definition);
  check(validation.length === 0, `validator ${JSON.stringify(validation)}`);
  check(stats.open >= gen.minimumOpenArea, `open ${stats.open}`);
  check(stats.cleared >= gen.minimumClearedArea, `cleared ${stats.cleared}`);
  check(stats.stranded === 0, `${stats.stranded} land cells walled off for ever by permanent props and water`);

  // Entrance: on a border, not a corner, lateral 6..25, base ground, the apron free and the halo dry.
  const { entrance } = layout;
  const along = entrance.facing === 'north' || entrance.facing === 'south' ? entrance.x : entrance.y;
  check(along >= 6 && along <= 25, `gate lateral position ${along}`);
  check(layout.ground[entrance.y * 32 + entrance.x] === GROUND_BASE, 'gate on base ground');
  const frame = entranceFrame(entrance);
  const propAt = new Map<number, string>();
  for (const prop of layout.props) {
    const kind = PROP_KIND_BY_ID.get(prop.kind)!;
    const [w, d] = propFootprintSize(kind, prop.rotation);
    check(kind.biome === recipe.biomeId, `${prop.kind} belongs to the biome`);
    for (let dy = 0; dy < d; dy += 1) {
      for (let dx = 0; dx < w; dx += 1) {
        check(Number.isInteger(prop.x + dx) && Number.isInteger(prop.y + dy), 'integer coordinates');
        const index = (prop.y + dy) * 32 + prop.x + dx;
        check(!propAt.has(index), 'overlap');
        propAt.set(index, prop.kind);
        // Right surface: a pier on water, everything else on land.
        check((layout.ground[index] === GROUND_WATER) === (kind.surface === 'water'), `${prop.kind} surface`);
      }
    }
  }
  for (let d = 0; d < 12; d += 1) {
    for (let l = -2; l <= 3; l += 1) {
      const cell = frame.toWorld(l, d);
      check(!(propAt.has(cell.y * 32 + cell.x) || layout.ground[cell.y * 32 + cell.x] === GROUND_WATER), `apron ${l},${d}`);
    }
  }
  for (let d = 0; d <= 12; d += 1) {
    for (let l = -3; l <= 4; l += 1) {
      const cell = frame.toWorld(l, d);
      if (cell.x < 0 || cell.y < 0 || cell.x > 31 || cell.y > 31) continue;
      check(layout.ground[cell.y * 32 + cell.x] !== GROUND_WATER, `halo ${l},${d}`);
    }
  }

  // Caps.
  check(layout.props.length <= gen.maxGeneratedProps, `props ${layout.props.length}`);
  check(stats.maxPropCellsPerChunk <= GAME_CONFIG.maps.maxPropCellsPerChunk, `chunk cells ${stats.maxPropCellsPerChunk}`);
  const weights = propWeightPerChunk(layout, layout.props);
  check(Math.max(...weights) <= gen.chunkPropWeightCap, `chunk weight ${Math.max(...weights)}`);
  check(weights.reduce((a, b) => a + b, 0) <= gen.mapPropWeightCap, 'map weight');

  // Ground bytes, ids, water rules.
  let water = 0;
  for (const byte of layout.ground) {
    check(byte === 0 || byte === 1 || byte === 2, 'ground byte');
    if (byte === 2) water += 1;
  }
  check(water / 1024 <= 0.3, `water share ${water}`);
  if (!recipe.water) check(water === 0, `dry map has ${water} water`);
  if (!biomeWaterOption(recipe.biomeId).available) check(!recipe.water, 'water option');
  layout.props.forEach((prop, index) => check(prop.id === index + 1, 'ids ascend from 1'));
  check(layout.id === generatedMapId(recipe), 'id');
  check(Number.isFinite(stats.open + stats.cleared + stats.totalWeight), 'finite stats');
  expect(problems).toEqual([]);
};

/** Seaside's sea is on the far side: at most half of the gate border is water. */
const seaNotOnGateSide = (layout: MapLayout): boolean => {
  const { entrance } = layout;
  let wet = 0;
  for (let t = 0; t < 32; t += 1) {
    const x = entrance.facing === 'north' ? t : entrance.facing === 'south' ? t : entrance.facing === 'east' ? 0 : 31;
    const y = entrance.facing === 'north' ? 31 : entrance.facing === 'south' ? 0 : t;
    if (layout.ground[y * 32 + x] === GROUND_WATER) wet += 1;
  }
  return wet <= 16;
};

describe('generator fuzz', () => {
  const report: string[] = [];

  describe.each(BIOME_IDS)('%s', (biome: BiomeId) => {
    it(`${SEEDS} seeds x 3 densities (water on): every invariant holds, the repair fallback is rare`, () => {
      let r3 = 0;
      let maps = 0;
      for (const density of MAP_DENSITIES) {
        const stats: { props: number[]; open: number[]; cleared: number[]; weight: number[]; carves: number } = { props: [], open: [], cleared: [], weight: [], carves: 0 };
        for (let i = 0; i < SEEDS; i += 1) {
          const map = generateMap(recipeOf(biome, hash32(i, 77), { density }));
          checkMap(map, `${biome} ${density} #${i}`);
          if (biome === 'seaside') if (!seaNotOnGateSide(map.layout)) throw new Error(`seaside #${i} ${density}: the sea is on the gate side`);
          r3 += map.stats.repair.r3;
          maps += 1;
          stats.props.push(map.stats.props);
          stats.open.push(map.stats.open);
          stats.cleared.push(map.stats.cleared);
          stats.weight.push(map.stats.maxChunkWeight);
          stats.carves += map.stats.repair.r1 + map.stats.repair.r2;
        }
        const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
        report.push(`${biome.padEnd(14)} ${density.padEnd(6)} props ${median(stats.props)} open ${median(stats.open)} cleared ${median(stats.cleared)} maxChunkWeight ${median(stats.weight)} carves ${stats.carves}`);
      }
      report.push(`${biome.padEnd(14)} R3 ${r3} of ${maps}`);
      expect(r3 / maps, `${biome} R3 rate`).toBeLessThanOrEqual(0.005);
    }, 120_000);

    it('100 seeds with the water option off: dry, valid, same caps', () => {
      for (let i = 0; i < 100; i += 1) {
        for (const density of MAP_DENSITIES) {
          const map = generateMap(recipeOf(biome, hash32(i, 78), { density, water: false }));
          checkMap(map, `${biome} dry ${density} #${i}`);
        }
      }
    }, 120_000);
  });

  it('prints the stats table (median per biome and density)', () => {
    expect(report.length).toBeGreaterThan(0);
    if (REPORT) console.log(report.sort().join('\n'));
  });

  it('biomes with a water option have named features: Seaside piers exist on most sea maps', () => {
    let piers = 0;
    for (let i = 0; i < 60; i += 1) {
      if (generateMap(recipeOf('seaside', hash32(i, 5))).layout.props.some((prop) => prop.kind === 'boardwalk-pier')) piers += 1;
    }
    expect(piers).toBeGreaterThanOrEqual(45);
    expect(BIOME_BY_ID.get('seaside')?.legend['#']).toBe('boardwalk-pier');
    const densities: MapDensity[] = ['low', 'normal', 'high'];
    expect(densities).toEqual(MAP_DENSITIES);
  });
});
