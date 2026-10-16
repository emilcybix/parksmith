import { GAME_CONFIG } from '../../game/config';
import type { DayWeights } from '../dayCycle';
import { LIGHT_PRESET_DAY, LIGHT_PRESET_DUSK, LIGHT_PRESET_NIGHT } from './contracts/blueprint';
import { LIGHT_PRESETS, type LightPreset, type MutableLightPreset, type MutableRgb } from './lightPresets';

/**
 * The look at any time of day: the three authored presets, blended by weights (dayCycle.ts). The
 * presets are never edited; where one weight is exactly 1 the result is that preset, field for
 * field, so the day plateau is the day look, 21:30 to 05:00 is the night look as the player knows it.
 * Everything is written into a caller-owned scratch object: the per-frame path allocates nothing.
 */
export interface DayLook extends MutableLightPreset {
  /** The background's opacity: 0 = the page's own gradient shows, 1 = the opaque night backdrop. */
  backgroundAlpha: number;
  /** The background colour in 0..1 sRGB (meaningful while backgroundAlpha > 0). */
  backgroundRgb: MutableRgb;
}

/**
 * Step 3 (weather) hooks in here: a modifier scales the blended look after the time of day. Every
 * field is optional, undefined means identity; nothing uses them yet.
 */
export interface LookModifiers {
  exposureScale?: number;
  saturationScale?: number;
  ambientScale?: number;
  tintMul?: readonly [number, number, number];
}

type RgbKey = 'ambient' | 'key' | 'tint' | 'outlineTint' | 'shadowTint';
type NumberKey = 'exposure' | 'saturation' | 'emissiveScale' | 'glassGlow' | 'lightStrength'
  | 'outlineInkMix' | 'contourFactor' | 'shadowStrength';

const RGB_KEYS: readonly RgbKey[] = ['ambient', 'key', 'tint', 'outlineTint', 'shadowTint'];
const NUMBER_KEYS: readonly NumberKey[] = [
  'exposure', 'saturation', 'emissiveScale', 'glassGlow', 'lightStrength', 'outlineInkMix', 'contourFactor', 'shadowStrength',
];

const CHANNELS: readonly (0 | 1 | 2)[] = [0, 1, 2];

const rgbUnit = (hex: number, index: 0 | 1 | 2): number => ((hex >> (16 - index * 8)) & 0xff) / 255;

const hexOf = (rgb: MutableRgb): number => (
  (Math.round(rgb[0] * 255) << 16) | (Math.round(rgb[1] * 255) << 8) | Math.round(rgb[2] * 255)
);

export const createDayLook = (): DayLook => ({
  ambient: [0, 0, 0], key: [0, 0, 0], tint: [1, 1, 1], outlineTint: [0, 0, 0], shadowTint: [0, 0, 0],
  exposure: 1, saturation: 1, emissiveScale: 0, glassGlow: 0, lightStrength: 0,
  outlineInkMix: 0, contourFactor: 1, shadowStrength: 1,
  background: null, backgroundAlpha: 0, backgroundRgb: [0, 0, 0],
  lightPass: false,
});

const copyPreset = (out: DayLook, preset: LightPreset): void => {
  for (const key of RGB_KEYS) {
    const target = out[key];
    const source = preset[key];
    target[0] = source[0];
    target[1] = source[1];
    target[2] = source[2];
  }
  for (const key of NUMBER_KEYS) out[key] = preset[key];
  const background = preset.background;
  out.background = background;
  out.backgroundAlpha = background === null ? 0 : 1;
  out.backgroundRgb[0] = background === null ? 0 : rgbUnit(background, 0);
  out.backgroundRgb[1] = background === null ? 0 : rgbUnit(background, 1);
  out.backgroundRgb[2] = background === null ? 0 : rgbUnit(background, 2);
};

const { day: DAY, dusk: DUSK, night: NIGHT } = LIGHT_PRESETS;

/**
 * Blends the presets by `weights` into `out` (and returns it). A weight of exactly 1 copies that
 * preset verbatim. `lightPass` is a defined threshold on the blended light strength; the lamps do
 * not pop there because the pools are quantised and nothing can reach the first band below it
 * (see GAME_CONFIG.calendar.lightPassMinStrength and the design note in dayLook.test.ts).
 */
export const blendLightPreset = (out: DayLook, weights: DayWeights, modifiers?: LookModifiers): DayLook => {
  const { day, dusk, night } = weights;
  if (day === 1) copyPreset(out, DAY);
  else if (dusk === 1) copyPreset(out, DUSK);
  else if (night === 1) copyPreset(out, NIGHT);
  else {
    for (const key of RGB_KEYS) {
      const target = out[key];
      const a = DAY[key];
      const b = DUSK[key];
      const c = NIGHT[key];
      target[0] = a[0] * day + b[0] * dusk + c[0] * night;
      target[1] = a[1] * day + b[1] * dusk + c[1] * night;
      target[2] = a[2] * day + b[2] * dusk + c[2] * night;
    }
    for (const key of NUMBER_KEYS) out[key] = DAY[key] * day + DUSK[key] * dusk + NIGHT[key] * night;
    // Backgrounds: a preset without one is transparent. The opacity is the weight of the presets that
    // have one; the colour is their weighted mean (today only night has one, so it stays the night teal).
    const dayBg = DAY.background;
    const duskBg = DUSK.background;
    const nightBg = NIGHT.background;
    const dayW = dayBg === null ? 0 : day;
    const duskW = duskBg === null ? 0 : dusk;
    const nightW = nightBg === null ? 0 : night;
    const alpha = dayW + duskW + nightW;
    out.backgroundAlpha = alpha;
    for (const index of CHANNELS) {
      out.backgroundRgb[index] = alpha > 0
        ? ((dayBg === null ? 0 : rgbUnit(dayBg, index)) * dayW
          + (duskBg === null ? 0 : rgbUnit(duskBg, index)) * duskW
          + (nightBg === null ? 0 : rgbUnit(nightBg, index)) * nightW) / alpha
        : 0;
    }
    out.background = alpha > 0 ? hexOf(out.backgroundRgb) : null;
  }
  if (modifiers) {
    if (modifiers.exposureScale !== undefined) out.exposure *= modifiers.exposureScale;
    if (modifiers.saturationScale !== undefined) out.saturation *= modifiers.saturationScale;
    if (modifiers.ambientScale !== undefined) {
      out.ambient[0] *= modifiers.ambientScale;
      out.ambient[1] *= modifiers.ambientScale;
      out.ambient[2] *= modifiers.ambientScale;
    }
    if (modifiers.tintMul !== undefined) {
      out.tint[0] *= modifiers.tintMul[0];
      out.tint[1] *= modifiers.tintMul[1];
      out.tint[2] *= modifiers.tintMul[2];
    }
  }
  out.lightPass = out.lightStrength > GAME_CONFIG.calendar.lightPassMinStrength;
  return out;
};

/** A preset's weight below this contributes no lights (its authored lights are not eligible). */
export const PRESET_BIT_MIN_WEIGHT = 0.02;

/**
 * The `uPresetBit` mask: the union of the presets that carry weight. Every authored light declares
 * dusk and night, so it is eligible whenever either has weight and the fade is the global
 * lightStrength / emissive / glass ramp; a day-only light would drop out as soon as day stops
 * being the only preset with weight.
 */
export const presetBitsFor = (weights: DayWeights): number => (
  (weights.day >= PRESET_BIT_MIN_WEIGHT ? LIGHT_PRESET_DAY : 0)
  | (weights.dusk >= PRESET_BIT_MIN_WEIGHT ? LIGHT_PRESET_DUSK : 0)
  | (weights.night >= PRESET_BIT_MIN_WEIGHT ? LIGHT_PRESET_NIGHT : 0)
);
