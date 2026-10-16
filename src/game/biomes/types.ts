import type { TimeLock } from '../calendar/calendarMath';
import type { PropKindId } from '../maps/props';
import type { SceneryThemeId } from '../types';
import type { BiomeRules } from '../scenarios/rules';
import type { WeatherKind } from '../weather/types';

/**
 * Biome data types (Phase 24). A biome is pure data: the ground colours of a park, the weather mix and
 * climate of the place, the sandbox defaults and the prop vocabulary of its maps. Nothing here reads a
 * clock or touches a world; the renderers and the session read the definitions.
 */

export const BIOME_IDS = ['meadow', 'seaside', 'desert-canyon', 'winter', 'jungle', 'autumn-forest'] as const;
export type BiomeId = (typeof BIOME_IDS)[number];

/** Phase 16's theme vocabulary lives with the catalog types; re-exported here for the biome data. */
export type { SceneryThemeId };
export type ClimateKind = 'mild' | 'hot' | 'cold';

/**
 * A ground colour: `rgb` is the voxel material base AND the classic even diamond; `secondary` is the voxel
 * pattern's second colour (the GRASS checker's second shade, the paving bond) AND the classic odd diamond.
 */
export interface GroundColour {
  readonly rgb: number;
  readonly secondary: number;
}

export interface BiomeGround {
  /** '.' open land. */
  readonly base: GroundColour;
  /** ',' second ground (sand beach, red-rock floor, packed snow, mud, leaf litter). */
  readonly alt: GroundColour;
  /** '~' water (classic colours; the voxel material is `waterMaterial`). */
  readonly water: GroundColour;
  /** 'water' = the fixed flagged MAT.WATER (rgb must equal 0x2b6f8e); 'plain' = a plain material (Winter ice). */
  readonly waterMaterial: 'water' | 'plain';
  /** Diorama edge strata. */
  readonly soil: GroundColour;
  /** Path top. */
  readonly paving: GroundColour;
  /** Path curb. */
  readonly curb: GroundColour;
  readonly classic: { readonly grid: number; readonly pathDot: number };
}

/** The legend characters of a map that stand for a prop kind (the kind per biome is `BiomeDefinition.legend`). */
export type PropLegendChar = 'T' | 't' | 'b' | 'R' | 's' | 'L' | '#' | 'X';

/** The two biome rule multipliers (hunger and thirst growth); 1 = neutral. Defined with the ruleset compiler. */
export type { BiomeRules };

export const WEATHER_MIX_LENGTH = 5;
/** Column weights on the weather transitions, in WEATHER_KINDS order (sunny, hot, cloudy, rain, storm). */
export type WeatherMix = readonly [number, number, number, number, number];

export interface BiomeDefinition {
  readonly id: BiomeId;
  readonly name: string;
  /** One line for the picker card (at most 48 characters). */
  readonly tagline: string;
  /** Picker chip: 'Mild', 'Hot and dry', ... */
  readonly climateLabel: string;
  readonly ground: BiomeGround;
  /** Picker swatch strip, 5 rgb, left to right. */
  readonly swatches: readonly [number, number, number, number, number];
  /** Column weights on GAME_CONFIG.weather.transitions, WEATHER_KINDS order. Meadow: all exactly 1. */
  readonly weatherMix: WeatherMix;
  /** -1 (cold) .. +1 (hot). 0 = no climate term (Meadow). */
  readonly temperature: number;
  /** Must agree with `temperature` (validator: >= 0.3 hot, <= -0.3 cold, else mild). */
  readonly climate: ClimateKind;
  /** Display names that replace the weather labels for this biome (UI only; the kinds and effects are unchanged). */
  readonly weatherLabels: Readonly<Partial<Record<WeatherKind, string>>>;
  /** Biome rule layer (ParkRuleset), each within the biome clamp 0.8..1.25. */
  readonly rules: BiomeRules;
  /** Applied once to a NEW sandbox park on a map of this biome; the player's switches win afterwards. */
  readonly sandboxDefaults: {
    readonly dayLengthPresetId: 'brisk' | 'standard' | 'relaxed' | 'leisurely';
    readonly timeLock: TimeLock;
  };
  /** The biome's local style (Phase 16): the themes the build cards call "local style". UI only. */
  readonly sceneryThemes: readonly SceneryThemeId[];
  /** ASCII legend: which prop kind a map character means in this biome. */
  readonly legend: Readonly<Partial<Record<PropLegendChar, PropKindId>>>;
}
