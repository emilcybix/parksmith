import { describe, expect, it } from 'vitest';
import { BUILD_CATALOG } from '../../game/content/catalog';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../game/guests/GuestSimulation';
import { COLOUR_PRESETS } from '../../game/content/colourPresets';
import { COLOUR_SLOTS, COLOUR_SWATCHES, DEFAULT_COLOUR_NAMES, swatchOfRgb } from '../../game/content/colours';
import type { DayWeights } from '../dayCycle';
import { classicTint } from '../classicDayTint';
import type { WeatherKind } from '../../game/weather/types';
import { createWeatherDrivers, createWeatherEffects, weatherEffectsFrom, weatherTargetDrivers } from '../weatherLook';
import { blendLightPreset, createDayLook } from './dayLook';
import { lambertTerm } from './contracts/gbuffer';
import { MAT_COLOR } from './contracts/palette';
import { buildPalette, GRASS_ALTERNATE_COLOR } from './palette';

/**
 * Phase 28 step 1, readability: a curated candy swatch must stay a colour (not grey out), must stay
 * visible on every ground a ride stands on or next to, and must stay a different colour from every
 * other swatch, in every light the game has. A swatch that fails is retuned, never excused (that is
 * how Vermilion, Apricot, Buttercup, Citron, Bubblegum, Indigo, Glacier, Azure and Emerald came to
 * differ from the catalog colours they started as, see SWATCH_SEEDS in game/content/colours.ts).
 *
 * The test is a CPU twin of the voxel composite (gpu/shaders/compositeLook.ts, compositeWeather.ts):
 * - face light `base x (ambient + key x lambert)` for the three faces a box shows (top, lit side,
 *   shaded side);
 * - the weather surface hook: the cloud shadow (`x cloudTint` inside a shadow; a swatch and the ground
 *   next to it are compared under the same sky) and, on ground top faces only, wet ground (darken by
 *   up to 7 %, saturation lift up to 14 %);
 * - `vxGrade`: exposure, luma-mix saturation, tint;
 * with the look blended from the real light presets (`blendLightPreset`, so a retune of
 * lightPresets.ts shows up here) and the real weather modifiers (gloom), for day, dusk and night under
 * sunny (which has cloud shadows), cloudy, rain and storm at full intensity. Twelve looks.
 * The classic renderer's twin is `rgb x classicTint` (day/dusk/night, with the weather gloom).
 *
 * Grounds: both grass shades, paving and curb (paths), the stone and concrete decks of the flat rides,
 * and (step 2) the plot tint of EVERY catalog definition (palette.plotTint, the slab an object stands on:
 * rides, coasters, stalls, facilities, comforts, scenery), so a recoloured stall roof or a lamp post is judged
 * against the plot it stands on and the paving beside it, not only against ride plots.
 *
 * Floors (the reviewer's measurements from real voxel frames are what they must catch: Sunflower
 * 0xffd166 at night renders #4e4f4c, saturation 0.14; Lemon 0.22 and Apricot 0.24 at night; Sunflower
 * 18 RGB from the wet paving in rain; Sunflower/Lemon 16 RGB apart at night):
 * - candy saturation >= 0.25 on every face, in every look, in and out of a cloud shadow;
 * - candy against the ground (top and lit side, vs every ground top): >= 40/255 RGB distance by day and
 *   dusk, >= 24/255 at night (night compresses everything; the floor is still above the 16 to 19 RGB
 *   collapses measured);
 * - neutral (Cream, the white of canopies and cabins) is judged by lightness: its top face's luma is
 *   >= 0.06 (day, dusk) / 0.04 (night) away from every ground's;
 * - every pair of swatches, same face (top and lit side), every look: >= 28/255 by day and dusk,
 *   >= 20/255 at night;
 * - classic: the tinted swatch keeps >= 45 % of its saturation and is >= 40/255 from the tinted grass
 *   and paving.
 * There is no floor relative to "the least readable colour the game ships": that let the shipped
 * Sunflower and Lemon excuse themselves. The shipped defaults are pixel-pinned elsewhere and are not
 * swatches unless they pass here.
 */

type Rgb = readonly [number, number, number];

const unit = (rgb: number): Rgb => [((rgb >> 16) & 255) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255];
const luma = (c: Rgb): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const saturation = (c: Rgb): number => {
  const high = Math.max(...c);
  return high <= 0 ? 0 : (high - Math.min(...c)) / high;
};
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const distance = (a: Rgb, b: Rgb): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const rgb255 = (c: Rgb): string => c.map((v) => Math.round(v * 255)).join(',');

const FACES: readonly (readonly [string, number])[] = [
  ['top', 1],
  ['lit side (+y)', lambertTerm(0, 1, 0)],
  ['shaded side (+x)', lambertTerm(1, 0, 0)],
];
/** The faces compared against the ground and against each other: what the camera mostly sees of a slot. */
const COMPARED_FACES = FACES.slice(0, 2);

const PALETTE = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS, COLOUR_SWATCHES.map((swatch) => swatch.rgb));
/** Every catalog definition that stands on a plot or on the ground (paths are paving, already a ground). */
const STANDING = BUILD_CATALOG.filter((definition) => definition.kind !== 'path');
const GROUNDS: readonly (readonly [string, number])[] = [
  ['grass', MAT_COLOR.GRASS],
  ['grass (second shade)', GRASS_ALTERNATE_COLOR],
  ['paving', MAT_COLOR.PAVING],
  ['curb', MAT_COLOR.CURB],
  ['stone deck', MAT_COLOR.STONE],
  ['concrete deck', MAT_COLOR.CONCRETE],
  ...STANDING.map((definition): readonly [string, number] => [`${definition.id} plot`, PALETTE.baseColor(PALETTE.plotTint(definition.color))]),
];
const CLASSIC_GROUNDS: readonly (readonly [string, number])[] = [['grass', 0x92d47f], ['grass (second shade)', 0x8bce78], ['paving', 0xf1d49a]];

interface Look {
  name: string;
  night: boolean;
  /** A slot surface: face light, cloud shadow, grade. */
  surface(rgb: number, lambert: number, cloud: boolean): Rgb;
  /** A ground top face: face light, cloud shadow, wet ground, grade. */
  ground(rgb: number, cloud: boolean): Rgb;
  classic(rgb: number): Rgb;
}

const TIMES: readonly (readonly [string, DayWeights])[] = [
  ['day', { day: 1, dusk: 0, night: 0 }],
  ['dusk', { day: 0, dusk: 1, night: 0 }],
  ['night', { day: 0, dusk: 0, night: 1 }],
];
const WEATHERS: readonly WeatherKind[] = ['sunny', 'cloudy', 'rain', 'storm'];

const LOOKS: readonly Look[] = TIMES.flatMap(([time, weights]) => WEATHERS.map((kind): Look => {
  const look = createDayLook();
  const drivers = createWeatherDrivers();
  weatherTargetDrivers(true, kind, 1, drivers);
  const effects = weatherEffectsFrom(drivers, weights, createWeatherEffects());
  blendLightPreset(look, weights, effects.modifiers);
  const cloudTint = [...effects.cloudTint];
  const wetness = effects.wetness;
  const lit = (rgb: number, lambert: number, cloud: boolean): number[] => unit(rgb).map(
    (v, i) => v * (look.ambient[i] + look.key[i] * lambert) * (cloud ? cloudTint[i] : 1),
  );
  const grade = (c: number[]): Rgb => {
    const exposed = c.map((v) => v * look.exposure);
    const l = luma([exposed[0], exposed[1], exposed[2]]);
    const out = exposed.map((v, i) => clamp01((l + (v - l) * look.saturation) * look.tint[i]));
    return [out[0], out[1], out[2]];
  };
  const tint = unit(classicTint(weights, effects.gloom));
  return {
    name: `${time} ${kind}`,
    night: time === 'night',
    surface: (rgb, lambert, cloud) => grade(lit(rgb, lambert, cloud)),
    ground: (rgb, cloud) => {
      // vxWetGround: lit * mix(1, 0.93, wet), then the saturation lift 1 + 0.14 * wet.
      const wet = lit(rgb, 1, cloud).map((v) => v * (1 + (0.93 - 1) * wetness));
      const l = luma([wet[0], wet[1], wet[2]]);
      return grade(wet.map((v) => l + (v - l) * (1 + 0.14 * wetness)));
    },
    classic: (rgb) => {
      const base = unit(rgb);
      return [base[0] * tint[0], base[1] * tint[1], base[2] * tint[2]];
    },
  };
}));

const FLOOR = {
  saturation: 0.25,
  groundDay: 40 / 255,
  groundNight: 24 / 255,
  neutralLumaDay: 0.06,
  neutralLumaNight: 0.04,
  pairDay: 28 / 255,
  pairNight: 24 / 255,
  classicRetain: 0.45,
  classicGround: 40 / 255,
} as const;

/** Every readability failure of one colour, as text (empty = readable). */
const failuresOf = (rgb: number, tone: 'candy' | 'neutral'): string[] => {
  const failures: string[] = [];
  const plain = saturation(unit(rgb));
  for (const look of LOOKS) {
    for (const cloud of [false, true]) {
      const sky = cloud ? 'cloud shadow' : 'open sky';
      for (const [face, lambert] of FACES) {
        const shown = look.surface(rgb, lambert, cloud);
        if (tone === 'candy' && saturation(shown) < FLOOR.saturation) {
          failures.push(`greys out: ${look.name}, ${sky}, ${face} renders ${rgb255(shown)} (saturation ${saturation(shown).toFixed(2)})`);
        }
      }
      for (const [face, lambert] of tone === 'candy' ? COMPARED_FACES : FACES.slice(0, 1)) {
        const shown = look.surface(rgb, lambert, cloud);
        for (const [groundName, ground] of GROUNDS) {
          const lit = look.ground(ground, cloud);
          if (tone === 'neutral') {
            const delta = Math.abs(luma(shown) - luma(lit));
            if (delta < (look.night ? FLOOR.neutralLumaNight : FLOOR.neutralLumaDay)) {
              failures.push(`vanishes: ${look.name}, ${sky}, ${face} luma ${luma(shown).toFixed(3)} vs ${groundName} ${luma(lit).toFixed(3)}`);
            }
          } else {
            const d = distance(shown, lit);
            if (d < (look.night ? FLOOR.groundNight : FLOOR.groundDay)) {
              failures.push(`vanishes: ${look.name}, ${sky}, ${face} ${rgb255(shown)} is ${Math.round(d * 255)} RGB from ${groundName} ${rgb255(lit)}`);
            }
          }
        }
      }
    }
    const classic = look.classic(rgb);
    if (tone === 'candy' && plain > 0.05 && saturation(classic) / plain < FLOOR.classicRetain) {
      failures.push(`classic greys out: ${look.name} keeps ${(saturation(classic) / plain).toFixed(2)} of its saturation`);
    }
    for (const [groundName, ground] of CLASSIC_GROUNDS) {
      const d = distance(classic, look.classic(ground));
      if (d < FLOOR.classicGround) failures.push(`classic vanishes: ${look.name}, ${Math.round(d * 255)} RGB from ${groundName}`);
    }
  }
  return failures;
};

/** Pairs of colours that render too alike in some look (same face, open sky). */
const collapsedPairs = (colours: readonly (readonly [string, number])[]): string[] => {
  const failures: string[] = [];
  for (let i = 0; i < colours.length; i += 1) {
    for (let j = i + 1; j < colours.length; j += 1) {
      let worst = { d: Infinity, where: '' };
      for (const look of LOOKS) {
        for (const [face, lambert] of FACES) {
          const d = distance(look.surface(colours[i][1], lambert, false), look.surface(colours[j][1], lambert, false));
          const floor = look.night ? FLOOR.pairNight : FLOOR.pairDay;
          if (d < floor && d / floor < worst.d) worst = { d: d / floor, where: `${look.name}, ${face}: ${Math.round(d * 255)} RGB apart` };
        }
      }
      if (worst.where) failures.push(`${colours[i][0]} / ${colours[j][0]} collapse (${worst.where})`);
    }
  }
  return failures;
};

describe('colour swatch readability (voxel composite twin and classic tint, Phase 28)', () => {
  it('uses the real face light, the twelve real looks and the real grounds', () => {
    expect(FACES.map(([, lambert]) => Number(lambert.toFixed(3)))).toEqual([1, 0.714, 0.416]);
    expect(LOOKS.map((look) => look.name)).toEqual([
      'day sunny', 'day cloudy', 'day rain', 'day storm',
      'dusk sunny', 'dusk cloudy', 'dusk rain', 'dusk storm',
      'night sunny', 'night cloudy', 'night rain', 'night storm',
    ]);
    expect(GROUNDS.length, 'six materials and the plot tint of every catalog definition (rides, coasters, stalls, facilities, comforts, scenery)').toBe(6 + STANDING.length);
    expect(GROUNDS.length, '37 before Phase 16, plus the plot tints of its 12 entries, the 6 Phase 29 stalls, the 4 Phase 39 coasters and the Phase 45 Titan Hyper').toBe(60);
    // Calibration against the reviewer's CPU twin and frames: the catalog Sunflower's top face at night.
    const night = LOOKS.find((look) => look.name === 'night sunny')!;
    expect(rgb255(night.surface(0xffd166, 1, false))).toBe('95,97,84');
  });

  it('keeps every candy swatch a colour, and every swatch visible on every ground, in every light and weather', () => {
    const report = COLOUR_SWATCHES.flatMap((swatch) => failuresOf(swatch.rgb, swatch.tone).map((failure) => `${swatch.name}: ${failure}`));
    expect(report).toEqual([]);
  });

  it('keeps every pair of swatches distinguishable in every light and weather, night included', () => {
    expect(collapsedPairs(COLOUR_SWATCHES.map((swatch) => [swatch.name, swatch.rgb] as const))).toEqual([]);
  });

  it('only Cream is judged as a neutral', () => {
    expect(COLOUR_SWATCHES.filter((swatch) => swatch.tone === 'neutral').map((swatch) => swatch.name)).toEqual(['Cream']);
  });

  it('fails on what the reviewer measured in real frames: the catalog colours the swatches were retuned from', () => {
    const night = (failures: string[]): boolean => failures.some((failure) => failure.startsWith('greys out: night'));
    expect(night(failuresOf(0xffd166, 'candy')), 'the catalog Sunflower greys out at night').toBe(true);
    expect(night(failuresOf(0xf5f06c, 'candy')), 'the catalog Lemon greys out at night').toBe(true);
    expect(night(failuresOf(0xf59e55, 'candy')), 'the catalog Apricot greys out at night').toBe(true);
    expect(failuresOf(0xffd166, 'candy').some((failure) => failure.includes('rain') && failure.includes('paving')), 'Sunflower sinks into the wet paving').toBe(true);
    expect(failuresOf(0xbde0fe, 'candy').some((failure) => failure.startsWith('greys out: dusk')), 'the catalog Ice greys out at dusk').toBe(true);
    expect(failuresOf(0x36c99f, 'candy').some((failure) => failure.includes('night') && failure.includes('plot')), 'the catalog Jade sinks into a plot at night').toBe(true);
    expect(collapsedPairs([['Sunflower', 0xffd166], ['Lemon', 0xf5f06c]]), 'the catalog yellows collapse at night').toHaveLength(1);
    expect(collapsedPairs([['Bubblegum', 0xf687b3], ['Orchid', 0xd977b8]]), 'and the pinks at dusk and night').toHaveLength(1);
    expect(collapsedPairs([['Violet', 0x9557d1], ['Indigo', 0x7048c9]]), 'and the purples at night').toHaveLength(1);
  });

  it('fails on a grey, on the ground colours themselves and on a dark neutral (the test can fail)', () => {
    expect(failuresOf(0x8a8a8a, 'candy').some((failure) => failure.startsWith('greys out'))).toBe(true);
    expect(failuresOf(MAT_COLOR.STONE, 'candy').some((failure) => failure.includes('from stone deck'))).toBe(true);
    expect(failuresOf(MAT_COLOR.PAVING, 'neutral').some((failure) => failure.includes('paving'))).toBe(true);
    expect(failuresOf(0x303030, 'candy').length).toBeGreaterThan(0);
  });
});

/** The swatch indices a preset sets (null roles are the slot defaults and are not a swatch). */
const swatchesOf = (preset: (typeof COLOUR_PRESETS)[number]): number[] => Object.values(preset.roles).filter((swatch): swatch is number => typeof swatch === 'number');

describe('colour preset readability (Phase 28 step 2)', () => {
  it('has the named presets, Candy (today\'s defaults) first', () => {
    expect(COLOUR_PRESETS.map((preset) => preset.id)).toEqual(['candy', 'seaside', 'midnight', 'autumn', 'meadow', 'berry']);
    expect(swatchesOf(COLOUR_PRESETS[0]), 'Candy sets nothing').toEqual([]);
  });

  it.each(COLOUR_PRESETS.map((preset) => [preset.name, preset] as const))('%s: its swatches are distinct, none collapses into another in any of the twelve looks, and each is readable on every ground', (_name, preset) => {
    const swatches = swatchesOf(preset);
    expect(new Set(swatches).size, 'one swatch per role: all five roles show at once on a coaster').toBe(swatches.length);
    expect(collapsedPairs(swatches.map((swatch) => [COLOUR_SWATCHES[swatch].name, COLOUR_SWATCHES[swatch].rgb] as const))).toEqual([]);
    const report = swatches.flatMap((swatch) => failuresOf(COLOUR_SWATCHES[swatch].rgb, COLOUR_SWATCHES[swatch].tone).map((failure) => `${COLOUR_SWATCHES[swatch].name}: ${failure}`));
    expect(report).toEqual([]);
  });

  it('a preset swatch that is no slot default would never be dropped silently: every role is a valid swatch index', () => {
    for (const preset of COLOUR_PRESETS) {
      for (const swatch of swatchesOf(preset)) expect(Number.isInteger(swatch) && swatch >= 0 && swatch < COLOUR_SWATCHES.length).toBe(true);
    }
  });
});

describe('step 2 default materials against the grounds (a report, not a floor)', () => {
  /**
   * The shipped colours of coasters, stalls, comforts, scenery and the gate are pixel-pinned (a default may not
   * change in Phase 28) and some of them fail floors the swatches are held to: pale roofs and accents melt into
   * the paving, the shipped Sunflower, Lemon and Timber grey out at night. This pins WHICH, so a regression or a
   * well-meant "fix" of a default shows up here instead of silently; it is an art question for a later phase.
   */
  const defaults = new Map<number, string>();
  for (const slots of Object.values(COLOUR_SLOTS)) {
    for (const slot of slots) defaults.set(slot.defaultRgb, swatchOfRgb(slot.defaultRgb)?.name ?? DEFAULT_COLOUR_NAMES[slot.defaultRgb]);
  }
  /** A default that is a swatch is judged as that swatch is (Cream is a neutral); any other default as a candy colour. */
  const failures = (rgb: number): string[] => failuresOf(rgb, swatchOfRgb(rgb)?.tone ?? 'candy');

  it('lists the defaults that grey out at night or vanish on a ground, and every default that passes', () => {
    const failing = [...defaults].filter(([rgb]) => failures(rgb).length > 0).map(([, name]) => name).sort();
    expect(failing).toEqual(PINNED_FAILING_DEFAULTS);
    const passing = [...defaults].filter(([rgb]) => failures(rgb).length === 0).map(([, name]) => name).sort();
    expect(passing).toEqual(PINNED_PASSING_DEFAULTS);
  });
});

const PINNED_FAILING_DEFAULTS: string[] = [
  'Blush white', 'Custard', 'Eucalyptus', 'Frost', 'Ice', 'Jade', 'Lamp yellow', 'Lemon', 'Lemonade',
  // Phase 16: the Puddle Jumpers' primary (the Sunburst Flowers' catalog colour, first a slot default here).
  'Lily pad',
  'Marigold', 'Mist', 'Pale steel', 'Saffron', 'Sage', 'Seafoam', 'Spearmint', 'Sunflower', 'Tangerine', 'Timber', 'Vanilla',
];
const PINNED_PASSING_DEFAULTS: string[] = [
  'Amethyst', 'Caramel', 'Carnation', 'Cherry', 'Clover', 'Cream', 'Cyan', 'Flame', 'Flamingo', 'Fountain blue', 'Harbour', 'Honey', 'Ink',
  'Lagoon', 'Lavender', 'Mint', 'Moss', 'Orchid', 'Peony', 'Pine', 'Powder blue', 'Rose', 'Sky', 'Slate teal', 'Steel', 'Teal', 'Terracotta', 'Violet',
];
