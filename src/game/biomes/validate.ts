import { GAME_CONFIG } from '../config';
import { PROP_KIND_BY_ID } from '../maps/props';
import { WEATHER_KINDS } from '../weather/types';
import { TIME_LOCKS } from '../calendar/calendarMath';
import { BIOME_IDS, WEATHER_MIX_LENGTH, type BiomeDefinition } from './types';

const isRgb = (value: unknown): boolean => (
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffff
);

const WATER_RGB = 0x2b6f8e;

/**
 * Validates one biome definition (pure). Returns the problems as plain sentences; [] = valid.
 * The data tests run it over BIOMES; it is also what a step-2 generator or a mod would call.
 */
export const validateBiome = (definition: BiomeDefinition): string[] => {
  const problems: string[] = [];
  const say = (text: string): void => { problems.push(`${definition.id}: ${text}`); };
  if (!(BIOME_IDS as readonly string[]).includes(definition.id)) say('id is not a known biome id');
  if (definition.name.trim().length === 0) say('name is empty');
  if (definition.tagline.length === 0 || definition.tagline.length > 48) say('tagline must be 1..48 characters');
  if (definition.climateLabel.length === 0) say('climateLabel is empty');

  const colours = definition.ground;
  const slots: Array<[string, { rgb: number; secondary: number }]> = [
    ['base', colours.base], ['alt', colours.alt], ['water', colours.water], ['soil', colours.soil],
    ['paving', colours.paving], ['curb', colours.curb],
  ];
  for (const [name, colour] of slots) {
    if (!isRgb(colour.rgb) || !isRgb(colour.secondary)) say(`ground.${name} has an rgb outside 0..0xffffff`);
  }
  if (!isRgb(colours.classic.grid) || !isRgb(colours.classic.pathDot)) say('ground.classic has an rgb outside 0..0xffffff');
  if ((colours.waterMaterial === 'water') !== (colours.water.rgb === WATER_RGB)) {
    say('waterMaterial is "water" exactly when water.rgb is the fixed water colour 0x2b6f8e');
  }
  if (colours.waterMaterial !== 'water' && colours.waterMaterial !== 'plain') say('waterMaterial must be water or plain');
  if (definition.swatches.length !== 5 || definition.swatches.some((rgb) => !isRgb(rgb))) say('swatches must be 5 rgb values');

  // Weather mix: finite, >= 0, and every transition row keeps a positive sum after weighting.
  const mix = definition.weatherMix;
  if (mix.length !== WEATHER_MIX_LENGTH || mix.some((weight) => !Number.isFinite(weight) || weight < 0)) {
    say(`weatherMix must hold ${WEATHER_MIX_LENGTH} finite weights >= 0`);
  } else {
    for (const from of WEATHER_KINDS) {
      const row = GAME_CONFIG.weather.transitions[from];
      const total = WEATHER_KINDS.reduce((sum, _kind, index) => sum + row[index] * mix[index], 0);
      if (!(total > 0)) say(`weatherMix leaves the transition row out of ${from} with no probability`);
    }
  }
  if (definition.id === 'meadow' && !mix.every((weight) => weight === 1)) say('meadow weatherMix must be exactly [1,1,1,1,1]');

  if (!Number.isFinite(definition.temperature) || definition.temperature < -1 || definition.temperature > 1) {
    say('temperature must be within -1..1');
  } else {
    const expected = definition.temperature >= 0.3 ? 'hot' : definition.temperature <= -0.3 ? 'cold' : 'mild';
    if (definition.climate !== expected) say(`climate '${definition.climate}' disagrees with temperature ${definition.temperature} (expects '${expected}')`);
  }
  if (definition.id === 'meadow' && definition.temperature !== 0) say('meadow temperature must be 0');

  const clamp = GAME_CONFIG.maps.biomeRuleClamp;
  for (const [name, value] of Object.entries(definition.rules)) {
    if (!Number.isFinite(value) || value < clamp.minimum || value > clamp.maximum) {
      say(`rules.${name} must be within ${clamp.minimum}..${clamp.maximum}`);
    }
  }
  if (definition.id === 'meadow' && (definition.rules.hungerRateMultiplier !== 1 || definition.rules.thirstRateMultiplier !== 1)) {
    say('meadow rules must be exactly 1');
  }

  const presets = GAME_CONFIG.calendar.dayLengthPresets as readonly { id: string }[];
  if (!presets.some((preset) => preset.id === definition.sandboxDefaults.dayLengthPresetId)) say('sandboxDefaults.dayLengthPresetId is not a day length preset');
  if (!(TIME_LOCKS as readonly string[]).includes(definition.sandboxDefaults.timeLock)) say('sandboxDefaults.timeLock is not a time lock');
  if (definition.id === 'meadow' && (definition.sandboxDefaults.dayLengthPresetId !== 'standard' || definition.sandboxDefaults.timeLock !== 'auto')) {
    say('meadow sandbox defaults must be standard / auto');
  }

  for (const [char, kindId] of Object.entries(definition.legend)) {
    const kind = kindId ? PROP_KIND_BY_ID.get(kindId) : undefined;
    if (!kind) say(`legend '${char}' names an unknown prop kind`);
    else if (kind.biome !== definition.id) say(`legend '${char}' names '${kind.id}', which belongs to ${kind.biome}`);
  }
  if (definition.sceneryThemes.length === 0) say('sceneryThemes is empty');
  return problems;
};
