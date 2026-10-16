import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { PROP_KIND_BY_ID, PROP_KINDS } from '../maps/props';
import { MAPS } from '../maps/content';
import { NEUTRAL_MIX, stationaryDistribution, transitionRow } from '../weather/chain';
import { WEATHER_KINDS } from '../weather/types';
import { BIOMES, BIOME_BY_ID, DEFAULT_BIOME_ID, NEUTRAL_BIOME_RULES, isBiomeId } from './content';
import { BIOME_IDS, type BiomeDefinition } from './types';
import { validateBiome } from './validate';

describe('biome data', () => {
  it('lists the six biomes in BIOME_IDS order and every definition validates', () => {
    expect(BIOMES.map((biome) => biome.id)).toEqual([...BIOME_IDS]);
    for (const biome of BIOMES) expect(validateBiome(biome), biome.id).toEqual([]);
    expect(DEFAULT_BIOME_ID).toBe('meadow');
    expect(BIOME_BY_ID.size).toBe(6);
    expect(isBiomeId('jungle')).toBe(true);
    expect(isBiomeId('tundra')).toBe(false);
  });

  it('Meadow is today\'s park: every weight exactly 1, temperature 0, neutral rules, the live clock', () => {
    const meadow = BIOME_BY_ID.get('meadow') as BiomeDefinition;
    expect([...meadow.weatherMix]).toEqual([1, 1, 1, 1, 1]);
    expect(meadow.weatherMix.every((weight) => Object.is(weight, 1))).toBe(true);
    expect(meadow.temperature).toBe(0);
    expect(meadow.rules).toEqual({ hungerRateMultiplier: 1, thirstRateMultiplier: 1 });
    expect(meadow.rules).toBe(NEUTRAL_BIOME_RULES);
    expect(meadow.sandboxDefaults).toEqual({ dayLengthPresetId: 'standard', timeLock: 'auto' });
    expect(meadow.ground.base).toEqual({ rgb: 0x92d47f, secondary: 0x8bce78 });
    expect(meadow.ground.classic).toEqual({ grid: 0x5faa66, pathDot: 0xfff0c7 });
  });

  it('only Autumn Forest changes the sandbox clock (relaxed, dusk)', () => {
    for (const biome of BIOMES) {
      const changes = biome.sandboxDefaults.dayLengthPresetId !== 'standard' || biome.sandboxDefaults.timeLock !== 'auto';
      expect(changes, biome.id).toBe(biome.id === 'autumn-forest');
    }
    expect(BIOME_BY_ID.get('autumn-forest')?.sandboxDefaults).toEqual({ dayLengthPresetId: 'relaxed', timeLock: 'dusk' });
  });

  it('the legend kinds belong to the biome and every prop kind is reachable from exactly one legend', () => {
    const reachable = new Set<string>();
    for (const biome of BIOMES) {
      for (const kindId of Object.values(biome.legend)) {
        const kind = PROP_KIND_BY_ID.get(kindId);
        expect(kind?.biome, `${biome.id} ${kindId}`).toBe(biome.id);
        reachable.add(kindId);
      }
    }
    expect(reachable.size).toBe(PROP_KINDS.length);
    expect(PROP_KINDS.length).toBe(32);
  });

  it('three to six kinds of props per biome beyond the big permanent ones; footprints and prices are sane', () => {
    for (const biome of BIOMES) {
      const kinds = PROP_KINDS.filter((kind) => kind.biome === biome.id);
      expect(kinds.length, biome.id).toBeGreaterThanOrEqual(4);
      expect(kinds.length, biome.id).toBeLessThanOrEqual(6);
    }
    for (const kind of PROP_KINDS) {
      expect(kind.appeal, `${kind.id} gives no scenery appeal in step 1`).toBe(0);
      if (kind.clearCost !== null) expect(kind.clearCost).toBeGreaterThan(0);
      const [w, d] = kind.footprint;
      expect([[1, 1], [2, 1], [2, 2]]).toContainEqual([w, d]);
      for (const rgb of [kind.color, kind.accent, ...kind.colors]) expect(rgb).toBeGreaterThanOrEqual(0);
    }
    // Every biome offers something the player can clear cheaply and something that never moves or costs a lot.
    for (const biome of BIOMES) {
      const kinds = PROP_KINDS.filter((kind) => kind.biome === biome.id);
      expect(kinds.some((kind) => kind.clearCost !== null && kind.clearCost <= 30), `${biome.id} cheap`).toBe(true);
    }
  });

  it('the new palette colours: exactly 31 distinct materials beyond today\'s palette (131 -> 162 of 256)', () => {
    // Colours the palette already holds as a base colour (Meadow ground, the fixed white and soil, two catalog colours).
    const existing = new Set<number>([0x92d47f, 0x8a6a4a, 0xf1d49a, 0xd8b878, 0xfff8ec, 0x6e523a, 0xf4b94e, 0xffcf56]);
    const used = new Set<number>();
    for (const biome of BIOMES) {
      const g = biome.ground;
      for (const colour of [g.base, g.alt, g.soil, g.paving, g.curb, ...(g.waterMaterial === 'plain' ? [g.water] : [])]) used.add(colour.rgb);
    }
    for (const kind of PROP_KINDS) for (const rgb of kind.colors) used.add(rgb);
    const fresh = [...used].filter((rgb) => !existing.has(rgb));
    expect(fresh.length).toBe(31);
    // Per biome (ground and its own props): 0 / 8 / 7 / 6 / 3 / 7.
    const perBiome = Object.fromEntries(BIOMES.map((biome) => {
      const g = biome.ground;
      const own = new Set<number>([g.base, g.alt, g.soil, g.paving, g.curb, ...(g.waterMaterial === 'plain' ? [g.water] : [])].map((colour) => colour.rgb));
      for (const kind of PROP_KINDS.filter((candidate) => candidate.biome === biome.id)) for (const rgb of kind.colors) own.add(rgb);
      return [biome.id, [...own].filter((rgb) => !existing.has(rgb)).length];
    }));
    expect(perBiome).toEqual({ meadow: 0, seaside: 8, 'desert-canyon': 7, winter: 6, jungle: 3, 'autumn-forest': 7 });
  });
});

describe('weather mix per biome', () => {
  it('the neutral mix leaves every transition row bit-identical', () => {
    for (const from of WEATHER_KINDS) {
      for (const wet of [0.5, 0.6, 1, 2]) {
        const unweighted = transitionRow(from, wet);
        expect(transitionRow(from, wet, NEUTRAL_MIX), `${from}@${wet}`).toEqual(unweighted);
        expect(transitionRow(from, wet, [1, 1, 1, 1, 1]).every((value, index) => Object.is(value, unweighted[index]))).toBe(true);
      }
    }
  });

  it('every row keeps a positive probability sum in every biome; Winter never draws hot', () => {
    for (const biome of BIOMES) {
      for (const from of WEATHER_KINDS) {
        const row = transitionRow(from, 1, biome.weatherMix);
        expect(row.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
        expect(row.every((value) => Number.isFinite(value) && value >= 0), `${biome.id} ${from}`).toBe(true);
      }
    }
    const winter = BIOME_BY_ID.get('winter') as BiomeDefinition;
    expect(stationaryDistribution(1, winter.weatherMix).hot).toBe(0);
    for (const from of WEATHER_KINDS) expect(transitionRow(from, 1, winter.weatherMix)[1]).toBe(0);
  });

  it('the long-run mix of each biome matches the designed table to 0.1 %', () => {
    // sunny / hot / cloudy / rain / storm, percent (stationary, wet multiplier 1).
    const designed: Record<string, readonly number[]> = {
      meadow: [38.1, 10.7, 30.7, 16.1, 4.5],
      seaside: [42.5, 9.1, 26.4, 16.6, 5.3],
      'desert-canyon': [45.8, 34.5, 14.9, 2.6, 2.2],
      winter: [33.5, 0, 44.4, 19.8, 2.3],
      jungle: [24.2, 10.5, 28.5, 29.6, 7.2],
      'autumn-forest': [31.7, 2.3, 39.8, 22.6, 3.7],
    };
    for (const biome of BIOMES) {
      const mix = stationaryDistribution(1, biome.weatherMix);
      WEATHER_KINDS.forEach((kind, index) => {
        expect(Math.abs(mix[kind] * 100 - designed[biome.id][index]), `${biome.id} ${kind}`).toBeLessThanOrEqual(0.1);
      });
    }
  });

  it('is declared small: biome rule multipliers stay inside the clamp and the climate is declared in GAME_CONFIG', () => {
    for (const biome of BIOMES) {
      expect(biome.rules.hungerRateMultiplier).toBeGreaterThanOrEqual(GAME_CONFIG.maps.biomeRuleClamp.minimum);
      expect(biome.rules.thirstRateMultiplier).toBeLessThanOrEqual(GAME_CONFIG.maps.biomeRuleClamp.maximum);
    }
    expect(GAME_CONFIG.weather.climate.cold.warmFoodBonus).toBeLessThan(GAME_CONFIG.weather.effects.serviceBias.storm.warm + 1);
  });

  it('every shipped map belongs to a known biome and every biome has a map', () => {
    for (const map of MAPS) expect(isBiomeId(map.biome), map.id).toBe(true);
    for (const biome of BIOMES) expect(MAPS.some((map) => map.biome === biome.id), biome.id).toBe(true);
  });
});

describe('validateBiome refuses bad data', () => {
  const meadow = BIOME_BY_ID.get('meadow') as BiomeDefinition;
  const bad = (change: Partial<BiomeDefinition>): string[] => validateBiome({ ...meadow, ...change } as BiomeDefinition);
  it('catches each rule', () => {
    expect(bad({ weatherMix: [1, 1, 1, 1, 2] }).join()).toMatch(/meadow weatherMix/);
    expect(bad({ weatherMix: [1, -1, 1, 1, 1] }).join()).toMatch(/finite weights/);
    expect(bad({ weatherMix: [0, 0, 0, 0, 0] }).join()).toMatch(/no probability/);
    expect(bad({ temperature: 2 }).join()).toMatch(/temperature/);
    expect(bad({ temperature: 0.8 }).join()).toMatch(/climate/);
    expect(bad({ rules: { hungerRateMultiplier: 3, thirstRateMultiplier: 1 } }).join()).toMatch(/rules\.hunger/);
    expect(bad({ legend: { T: 'palm-tree' } }).join()).toMatch(/belongs to seaside/);
    expect(bad({ legend: { T: 'nothing' as never } }).join()).toMatch(/unknown prop kind/);
    expect(bad({ tagline: 'x'.repeat(60) }).join()).toMatch(/tagline/);
    expect(bad({ swatches: [1, 2, 3, 4] as never }).join()).toMatch(/swatches/);
    expect(bad({ ground: { ...meadow.ground, waterMaterial: 'plain' } }).join()).toMatch(/waterMaterial/);
    expect(bad({ sandboxDefaults: { dayLengthPresetId: 'relaxed', timeLock: 'auto' } }).join()).toMatch(/meadow sandbox defaults/);
  });
});

/** Seaside refresh (Phase 24 step 2): the palest and weakest biome became a candy sea-mint with golden sand. */
describe('the refreshed Seaside palette', () => {
  const saturation = (rgb: number): number => {
    const channels = [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255];
    const high = Math.max(...channels);
    return high === 0 ? 0 : (high - Math.min(...channels)) / high;
  };
  const distance = (a: number, b: number): number => Math.hypot(((a >> 16) & 255) - ((b >> 16) & 255), ((a >> 8) & 255) - ((b >> 8) & 255), (a & 255) - (b & 255));
  const seaside = BIOME_BY_ID.get('seaside')!;

  it('the ground is saturated (no longer washed out) and clearly not Meadow or Jungle', () => {
    expect(saturation(seaside.ground.base.rgb)).toBeGreaterThanOrEqual(0.5);
    expect(saturation(seaside.ground.alt.rgb)).toBeGreaterThanOrEqual(0.45);
    expect(distance(seaside.ground.base.rgb, BIOME_BY_ID.get('meadow')!.ground.base.rgb)).toBeGreaterThan(60);
    expect(distance(seaside.ground.base.rgb, BIOME_BY_ID.get('jungle')!.ground.base.rgb)).toBeGreaterThan(40);
    expect(distance(seaside.ground.base.rgb, seaside.ground.alt.rgb), 'grass and sand read apart').toBeGreaterThan(90);
  });

  it('the coral paving keeps a gap from both grounds and the palette stays valid and in step with the props', () => {
    expect(distance(seaside.ground.paving.rgb, seaside.ground.base.rgb)).toBeGreaterThan(60);
    expect(distance(seaside.ground.paving.rgb, seaside.ground.alt.rgb)).toBeGreaterThan(40);
    expect(validateBiome(seaside)).toEqual([]);
    // The prop SAND colour is the alt ground colour, so the voxel palette does not grow a near-duplicate material.
    expect(PROP_KIND_BY_ID.get('dune-grass')!.colors).toContain(seaside.ground.alt.rgb);
    expect(seaside.swatches[1]).toBe(seaside.ground.alt.rgb);
    expect(seaside.swatches[0]).toBe(seaside.ground.base.rgb);
  });

  it('the other biomes and Meadow did not move', () => {
    expect(BIOME_BY_ID.get('meadow')!.ground.base).toEqual({ rgb: 0x92d47f, secondary: expect.any(Number) });
    expect(PROP_KINDS.filter((kind) => kind.biome === 'seaside').map((kind) => kind.id)).toEqual(['palm-tree', 'dune-grass', 'driftwood', 'sea-stack', 'tide-rock', 'boardwalk-pier']);
  });
});
