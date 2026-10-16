import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../../game/config';
import { createDayWeights, dayWeights } from '../dayCycle';
import { LIGHT_PRESET_DAY, LIGHT_PRESET_DUSK, LIGHT_PRESET_NIGHT } from './contracts/blueprint';
import { blendLightPreset, createDayLook, presetBitsFor, type DayLook } from './dayLook';
import { LIGHT_PRESETS, type LightPresetName } from './lightPresets';

/**
 * The day cycle only INTERPOLATES the authored looks. This frozen copy is the guard: any edit to a
 * preset value (the player likes the night look as it is) fails here and must be a deliberate decision.
 */
const FROZEN_PRESETS = {
  day: {
    ambient: [0.5, 0.53, 0.62], key: [0.5, 0.47, 0.38], exposure: 1, saturation: 1, tint: [1, 1, 1], background: null,
    emissiveScale: 0.35, glassGlow: 0, lightPass: false, lightStrength: 0, outlineTint: [0.42, 0.45, 0.55], outlineInkMix: 0.3,
    contourFactor: 0.8, shadowStrength: 1, shadowTint: [0.5, 0.56, 0.84],
  },
  dusk: {
    ambient: [0.4, 0.4, 0.62], key: [0.7, 0.5, 0.3], exposure: 1, saturation: 1.12, tint: [1.02, 0.97, 0.95], background: null,
    emissiveScale: 0.9, glassGlow: 0.9, lightPass: true, lightStrength: 0.9, outlineTint: [0.4, 0.4, 0.55], outlineInkMix: 0.35,
    contourFactor: 0.78, shadowStrength: 1, shadowTint: [0.6, 0.62, 0.86],
  },
  night: {
    ambient: [0.27, 0.32, 0.52], key: [0.12, 0.15, 0.26], exposure: 1, saturation: 1.1, tint: [0.95, 0.99, 1.08], background: 0x10201e,
    emissiveScale: 1, glassGlow: 1, lightPass: true, lightStrength: 1.3, outlineTint: [0.35, 0.38, 0.55], outlineInkMix: 0.4,
    contourFactor: 0.75, shadowStrength: 1, shadowTint: [0.6, 0.64, 0.9],
  },
};

const lookAt = (hour: number, out: DayLook = createDayLook()): DayLook => (
  blendLightPreset(out, dayWeights(createDayWeights(), hour / 24))
);

/** The preset-shaped part of a look (what toEqual compares against LIGHT_PRESETS). */
const asPreset = (look: DayLook) => {
  const preset: Record<string, unknown> = { ...look };
  delete preset.backgroundAlpha;
  delete preset.backgroundRgb;
  return preset;
};

describe('the authored presets are untouched', () => {
  it('day, dusk and night still hold exactly the values the player has seen', () => {
    expect(LIGHT_PRESETS).toEqual(FROZEN_PRESETS);
  });
});

describe('blendLightPreset', () => {
  it('equals each preset on its plateau, field for field, with identical numbers', () => {
    const plateaus: Array<[LightPresetName, number]> = [['day', 12], ['day', 9], ['dusk', 19], ['night', 0], ['night', 2], ['night', 22]];
    for (const [name, hour] of plateaus) {
      const look = lookAt(hour);
      expect(asPreset(look), `${name} at ${hour}`).toEqual(LIGHT_PRESETS[name]);
      const preset = LIGHT_PRESETS[name];
      for (const key of ['exposure', 'saturation', 'emissiveScale', 'glassGlow', 'lightStrength', 'outlineInkMix', 'contourFactor', 'shadowStrength'] as const) {
        expect(Object.is(look[key], preset[key]), `${name}.${key}`).toBe(true);
      }
      expect(look.backgroundAlpha).toBe(preset.background === null ? 0 : 1);
    }
  });

  it('keeps the night teal exactly while night is full, and the page gradient by day and dusk', () => {
    const night = lookAt(1);
    expect(night.background).toBe(0x10201e);
    expect(night.backgroundRgb[0]).toBeCloseTo(0x10 / 255, 12);
    expect(night.backgroundRgb[1]).toBeCloseTo(0x20 / 255, 12);
    expect(night.backgroundRgb[2]).toBeCloseTo(0x1e / 255, 12);
    expect(lookAt(12).background).toBeNull();
    expect(lookAt(19).background).toBeNull();
  });

  it('background opacity is the night weight and never changes the teal colour', () => {
    const w = createDayWeights();
    for (let minute = 0; minute < 1440; minute += 1) {
      dayWeights(w, minute / 1440);
      const look = blendLightPreset(createDayLook(), w);
      expect(look.backgroundAlpha, `minute ${minute}`).toBeCloseTo(w.night, 12);
      if (look.backgroundAlpha > 0) {
        expect(look.backgroundRgb[0]).toBeCloseTo(0x10 / 255, 9);
        expect(look.backgroundRgb[2]).toBeCloseTo(0x1e / 255, 9);
      }
    }
  });

  it('is continuous over the whole day: no field moves more than 2 % of its range between minutes', () => {
    const numeric = ['exposure', 'saturation', 'emissiveScale', 'glassGlow', 'lightStrength', 'outlineInkMix', 'contourFactor', 'shadowStrength'] as const;
    const rgb = ['ambient', 'key', 'tint', 'outlineTint', 'shadowTint'] as const;
    const range = (read: (preset: { [K in typeof numeric[number] | typeof rgb[number]]: K extends typeof rgb[number] ? number[] : number }) => number): number => {
      const values = Object.values(FROZEN_PRESETS).map(read);
      return Math.max(Math.max(...values) - Math.min(...values), 1e-9);
    };
    let previous = lookAt(0);
    for (let minute = 1; minute <= 1440; minute += 1) {
      const current = lookAt((minute % 1440) / 60);
      for (const key of numeric) {
        expect(Math.abs(current[key] - previous[key]), `${key} at minute ${minute}`).toBeLessThan(0.02 * range((p) => p[key]));
      }
      for (const key of rgb) {
        for (const channel of [0, 1, 2]) {
          expect(Math.abs(current[key][channel] - previous[key][channel]), `${key}[${channel}] at minute ${minute}`)
            .toBeLessThan(0.02 * range((p) => p[key][channel]));
        }
      }
      expect(Math.abs(current.backgroundAlpha - previous.backgroundAlpha), `background at ${minute}`).toBeLessThan(0.02);
      previous = current;
    }
  });

  it('light pass has a defined threshold: off below 0.02 strength, on above, and the strength fades continuously', () => {
    const threshold = GAME_CONFIG.calendar.lightPassMinStrength;
    let sawOn = false;
    let sawOff = false;
    for (let minute = 0; minute < 1440; minute += 1) {
      const look = lookAt(minute / 60);
      expect(look.lightPass, `minute ${minute}`).toBe(look.lightStrength > threshold);
      if (look.lightPass) sawOn = true; else sawOff = true;
    }
    expect(sawOn && sawOff).toBe(true);
    expect(lookAt(12).lightPass).toBe(false);
    expect(lookAt(20).lightPass).toBe(true);
    expect(lookAt(2).lightPass).toBe(true);
  });

  it('the lamps can only appear gradually: dusk strength at the first minute the pass runs is far below its first visible band', () => {
    // Pools are quantised floor(sqrt(min(amount,1)) * 3 + seam), seam >= 0.4: a pixel needs
    // lightStrength * amount >= ((1 - 0.6) / 3)^2 = 0.0178 to reach band 1.
    // Walk the evening ramp (17:00 -> 19:00) and take the first minute with the pass on.
    let firstEvening = -1;
    for (let minute = 17 * 60; minute < 19 * 60; minute += 1) {
      if (lookAt(minute / 60).lightPass) { firstEvening = minute; break; }
    }
    expect(firstEvening).toBeGreaterThan(17 * 60);
    expect(lookAt(firstEvening / 60).lightStrength).toBeLessThan(0.05);
    expect(lookAt((firstEvening - 1) / 60).lightStrength).toBeLessThanOrEqual(GAME_CONFIG.calendar.lightPassMinStrength);
  });

  it('keeps the park colourful all day: saturation never drops below 1, contact shadows stay on and cool', () => {
    for (let minute = 0; minute < 1440; minute += 1) {
      const look = lookAt(minute / 60);
      expect(look.saturation, `saturation at ${minute}`).toBeGreaterThanOrEqual(1 - 1e-9);
      expect(look.shadowStrength).toBeGreaterThan(0);
      expect(look.shadowTint[2]).toBeGreaterThan(look.shadowTint[0]);
      expect(look.exposure).toBeGreaterThanOrEqual(1 - 1e-9);
    }
  });

  it('writes into the scratch and returns it, allocating nothing', () => {
    const out = createDayLook();
    const ambient = out.ambient;
    expect(blendLightPreset(out, { day: 0.3, dusk: 0.3, night: 0.4 })).toBe(out);
    expect(out.ambient).toBe(ambient);
  });

  it('leaves a room for weather: modifiers scale the blended look and undefined means identity', () => {
    const plain = lookAt(12);
    const moody = blendLightPreset(createDayLook(), { day: 1, dusk: 0, night: 0 }, {
      exposureScale: 0.9, saturationScale: 0.8, ambientScale: 0.5, tintMul: [1, 1, 0.9],
    });
    expect(moody.exposure).toBeCloseTo(0.9, 12);
    expect(moody.saturation).toBeCloseTo(0.8, 12);
    expect(moody.ambient[0]).toBeCloseTo(plain.ambient[0] * 0.5, 12);
    expect(moody.tint[2]).toBeCloseTo(0.9, 12);
    expect(asPreset(blendLightPreset(createDayLook(), { day: 1, dusk: 0, night: 0 }, {}))).toEqual(asPreset(plain));
  });
});

describe('presetBitsFor', () => {
  it('is the union of the presets that carry weight, so authored dusk/night lights stay eligible', () => {
    expect(presetBitsFor({ day: 1, dusk: 0, night: 0 })).toBe(LIGHT_PRESET_DAY);
    expect(presetBitsFor({ day: 0, dusk: 1, night: 0 })).toBe(LIGHT_PRESET_DUSK);
    expect(presetBitsFor({ day: 0, dusk: 0, night: 1 })).toBe(LIGHT_PRESET_NIGHT);
    expect(presetBitsFor({ day: 0.5, dusk: 0.5, night: 0 })).toBe(LIGHT_PRESET_DAY | LIGHT_PRESET_DUSK);
    expect(presetBitsFor({ day: 0.99, dusk: 0.01, night: 0 })).toBe(LIGHT_PRESET_DAY);
    expect(presetBitsFor({ day: 0, dusk: 0.6, night: 0.4 })).toBe(LIGHT_PRESET_DUSK | LIGHT_PRESET_NIGHT);
  });
});
