import { NEUTRAL_RULES_OF_BIOME } from '../scenarios/rules';
import type { BiomeDefinition, BiomeId, BiomeRules } from './types';

/**
 * The six biomes (Phase 24 step 1). Colours that are not Meadow's are NEW palette materials for the voxel
 * renderer (31 in all; the registry appends them in this order, after the colour swatches); Meadow resolves
 * to the existing fixed materials and so costs nothing. Meadow is exactly today's park: every weight 1,
 * temperature 0, both rule multipliers 1, the live clock (see ARCHITECTURE.md, Biomes and maps).
 */

export const NEUTRAL_BIOME_RULES: BiomeRules = NEUTRAL_RULES_OF_BIOME;

const MEADOW_WATER = { rgb: 0x2b6f8e, secondary: 0x3b8fb0 } as const;
const MEADOW_SOIL = { rgb: 0x8a6a4a, secondary: 0x7c5f43 } as const;
const MEADOW_PAVING = { rgb: 0xf1d49a, secondary: 0xd8b878 } as const;
const MEADOW_CURB = { rgb: 0xd8b878, secondary: 0xba9e67 } as const;
const MEADOW_GRASS = { rgb: 0x92d47f, secondary: 0x8bce78 } as const;

export const BIOMES: readonly BiomeDefinition[] = [
  {
    id: 'meadow',
    name: 'Meadow',
    tagline: 'Soft lawns and gentle weather.',
    climateLabel: 'Mild',
    ground: {
      base: MEADOW_GRASS,
      alt: MEADOW_GRASS,
      water: MEADOW_WATER,
      waterMaterial: 'water',
      soil: MEADOW_SOIL,
      paving: MEADOW_PAVING,
      curb: MEADOW_CURB,
      classic: { grid: 0x5faa66, pathDot: 0xfff0c7 },
    },
    swatches: [0x92d47f, 0x8bce78, 0xf1d49a, 0xd8b878, 0x48a96b],
    weatherMix: [1, 1, 1, 1, 1],
    temperature: 0,
    climate: 'mild',
    weatherLabels: {},
    rules: NEUTRAL_BIOME_RULES,
    sandboxDefaults: { dayLengthPresetId: 'standard', timeLock: 'auto' },
    sceneryThemes: ['garden'],
    legend: { T: 'oak-tree', b: 'shrub', R: 'meadow-boulder', L: 'mossy-log', X: 'great-oak' },
  },
  {
    id: 'seaside',
    name: 'Seaside',
    tagline: 'Sea breeze, sandy beaches, the odd squall.',
    climateLabel: 'Breezy',
    ground: {
      base: { rgb: 0x5ed6a4, secondary: 0x53ca98 },
      alt: { rgb: 0xf8d384, secondary: 0xefc673 },
      water: MEADOW_WATER,
      waterMaterial: 'water',
      soil: { rgb: 0xc8a26e, secondary: 0xb8915f },
      paving: { rgb: 0xf6b8a8, secondary: 0xe9a493 },
      curb: { rgb: 0xd98576, secondary: 0xc9786a },
      classic: { grid: 0x3fae84, pathDot: 0xfde2da },
    },
    swatches: [0x5ed6a4, 0xf8d384, 0xf6b8a8, 0xd98576, 0x2b6f8e],
    weatherMix: [1.15, 0.9, 0.9, 1.1, 1.3],
    temperature: 0.2,
    climate: 'mild',
    weatherLabels: {},
    rules: { hungerRateMultiplier: 1, thirstRateMultiplier: 1.06 },
    sandboxDefaults: { dayLengthPresetId: 'standard', timeLock: 'auto' },
    sceneryThemes: ['seaside'],
    legend: { T: 'palm-tree', t: 'dune-grass', R: 'tide-rock', L: 'driftwood', '#': 'boardwalk-pier', X: 'sea-stack' },
  },
  {
    id: 'desert-canyon',
    name: 'Desert Canyon',
    tagline: 'Red rock, hot days, almost no rain.',
    climateLabel: 'Hot and dry',
    ground: {
      base: { rgb: 0xebb57c, secondary: 0xe2a86f },
      alt: { rgb: 0xc97a52, secondary: 0xbd6e48 },
      water: MEADOW_WATER,
      waterMaterial: 'water',
      soil: { rgb: 0xa65a3c, secondary: 0x8f4c33 },
      paving: { rgb: 0xfbe6c8, secondary: 0xefd6b2 },
      curb: { rgb: 0x3fb8af, secondary: 0x359f97 },
      classic: { grid: 0xc98a55, pathDot: 0xfff6e8 },
    },
    swatches: [0xebb57c, 0xc97a52, 0xfbe6c8, 0x3fb8af, 0x5fa463],
    weatherMix: [1.2, 2.2, 0.6, 0.25, 0.5],
    temperature: 1,
    climate: 'hot',
    weatherLabels: {},
    rules: { hungerRateMultiplier: 1, thirstRateMultiplier: 1.12 },
    sandboxDefaults: { dayLengthPresetId: 'standard', timeLock: 'auto' },
    sceneryThemes: ['adventure'],
    legend: { T: 'saguaro', t: 'barrel-cactus', R: 'red-boulder', '#': 'canyon-wall', X: 'rock-spire' },
  },
  {
    id: 'winter',
    name: 'Winter',
    tagline: 'Snow, sleet and blizzards.',
    climateLabel: 'Cold',
    ground: {
      base: { rgb: 0xf2f7fc, secondary: 0xe4edf6 },
      alt: { rgb: 0xdfe9f3, secondary: 0xd2dfec },
      // Thin ice stands in for water: a plain material, not the flagged MAT.WATER.
      water: { rgb: 0xb9e2f2, secondary: 0xa9d6ea },
      waterMaterial: 'plain',
      soil: { rgb: 0x7d8ea5, secondary: 0x6d7d94 },
      paving: { rgb: 0xf2a7b2, secondary: 0xe894a1 },
      curb: { rgb: 0xfff8ec, secondary: 0xccc6bd },
      classic: { grid: 0xb5c6d8, pathDot: 0xfde3e8 },
    },
    swatches: [0xf2f7fc, 0xb9e2f2, 0xf2a7b2, 0xfff8ec, 0x2f855a],
    weatherMix: [0.9, 0, 1.4, 1.1, 0.6],
    temperature: -1,
    climate: 'cold',
    weatherLabels: { rain: 'Sleet', storm: 'Blizzard' },
    rules: { hungerRateMultiplier: 1.08, thirstRateMultiplier: 0.9 },
    sandboxDefaults: { dayLengthPresetId: 'standard', timeLock: 'auto' },
    sceneryThemes: ['carnival'],
    legend: { T: 'snowy-pine', b: 'snow-drift', s: 'snowman', R: 'granite-boulder', X: 'glacier-rock' },
  },
  {
    id: 'jungle',
    name: 'Jungle',
    tagline: 'Steamy, green and very wet.',
    climateLabel: 'Hot and wet',
    ground: {
      base: { rgb: 0x62bf6e, secondary: 0x58b364 },
      alt: MEADOW_SOIL,
      water: MEADOW_WATER,
      waterMaterial: 'water',
      soil: { rgb: 0x6e523a, secondary: 0x614833 },
      paving: MEADOW_PAVING,
      curb: MEADOW_CURB,
      classic: { grid: 0x3f8f4c, pathDot: 0xfff0c7 },
    },
    swatches: [0x62bf6e, 0x8a6a4a, 0xf1d49a, 0x2e8b4a, 0xff7ca3],
    weatherMix: [0.8, 1.3, 1, 1.8, 1.5],
    temperature: 0.5,
    climate: 'hot',
    weatherLabels: {},
    rules: { hungerRateMultiplier: 1, thirstRateMultiplier: 1.06 },
    sandboxDefaults: { dayLengthPresetId: 'standard', timeLock: 'auto' },
    sceneryThemes: ['adventure'],
    legend: { T: 'kapok-tree', t: 'fern', b: 'jungle-bloom', R: 'mossy-rock', X: 'temple-ruin' },
  },
  {
    id: 'autumn-forest',
    name: 'Autumn Forest',
    tagline: 'Golden woods and cool grey days.',
    climateLabel: 'Cool',
    ground: {
      base: { rgb: 0xc3c56e, secondary: 0xb9bb64 },
      alt: { rgb: 0xe59a4c, secondary: 0xd98d40 },
      water: MEADOW_WATER,
      waterMaterial: 'water',
      soil: MEADOW_SOIL,
      paving: { rgb: 0xdcc6ea, secondary: 0xcfb6e0 },
      curb: { rgb: 0x9a6fa8, secondary: 0x8a6197 },
      classic: { grid: 0x9d9a4c, pathDot: 0xf3e9fa },
    },
    swatches: [0xc3c56e, 0xe59a4c, 0xdcc6ea, 0x9a6fa8, 0xd6503a],
    weatherMix: [0.9, 0.3, 1.3, 1.3, 0.9],
    temperature: -0.4,
    climate: 'cold',
    weatherLabels: {},
    rules: { hungerRateMultiplier: 1.04, thirstRateMultiplier: 1 },
    // The one biome that changes the sandbox clock: a slow, golden-hour day.
    sandboxDefaults: { dayLengthPresetId: 'relaxed', timeLock: 'dusk' },
    sceneryThemes: ['garden'],
    legend: { T: 'maple-tree', t: 'golden-birch', b: 'pumpkin-patch', s: 'toadstools', L: 'fallen-log', '#': 'stone-wall' },
  },
];

export const BIOME_BY_ID: ReadonlyMap<BiomeId, BiomeDefinition> = new Map(BIOMES.map((biome) => [biome.id, biome]));

export const DEFAULT_BIOME_ID: BiomeId = 'meadow';

export const isBiomeId = (value: unknown): value is BiomeId => (
  typeof value === 'string' && BIOME_BY_ID.has(value as BiomeId)
);

/** The definition for an id; the default biome for anything unknown (callers that must refuse check `isBiomeId`). */
export const biomeOf = (id: BiomeId): BiomeDefinition => BIOME_BY_ID.get(id) ?? (BIOMES[0] as BiomeDefinition);
