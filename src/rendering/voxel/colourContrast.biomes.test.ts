import { describe, expect, it } from 'vitest';
import { COLOUR_SWATCHES } from '../../game/content/colours';
import type { DayWeights } from '../dayCycle';
import type { WeatherKind } from '../../game/weather/types';
import { createWeatherDrivers, createWeatherEffects, weatherEffectsFrom, weatherTargetDrivers } from '../weatherLook';
import { blendLightPreset, createDayLook } from './dayLook';
import { lambertTerm } from './contracts/gbuffer';
import { BIOMES } from '../../game/biomes/content';
import type { BiomeDefinition } from '../../game/biomes/types';
import { PROP_KINDS } from '../../game/maps/props';

/**
 * Phase 24: the park stays colourful and readable in every biome. The biome grounds (lawn, sand, snow, red rock ...),
 * their paving and curb are looked at through the same CPU twin of the voxel composite as Phase 28's swatch test
 * (copied here: that file keeps its machinery private), in the twelve real looks (day, dusk, night x sunny, cloudy,
 * rain, storm): every colour swatch against each biome's grounds, paving and curb; the paving against both grounds;
 * the curb against the paving; and the main colour of every prop against its biome's grounds. Floors are Phase 28's.
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

const FACES: readonly (readonly [string, number])[] = [
  ['top', 1],
  ['lit side (+y)', lambertTerm(0, 1, 0)],
  ['shaded side (+x)', lambertTerm(1, 0, 0)],
];
/** The faces compared against the ground and against each other: what the camera mostly sees of a slot. */
const COMPARED_FACES = FACES.slice(0, 2);

interface Look {
  name: string;
  night: boolean;
  /** A slot surface: face light, cloud shadow, grade. */
  surface(rgb: number, lambert: number, cloud: boolean): Rgb;
  /** A ground top face: face light, cloud shadow, wet ground, grade. */
  ground(rgb: number, cloud: boolean): Rgb;
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
  };
}));


const FLOOR = {
  saturation: 0.25,
  groundDay: 40 / 255,
  groundNight: 24 / 255,
  neutralLumaDay: 0.06,
  neutralLumaNight: 0.04,
  pavingDay: 24 / 255,
  pavingNight: 14 / 255,
  propDay: 22 / 255,
  propNight: 12 / 255,
} as const;

/** The grounds a swatch must stay visible on in a biome: both grounds, the paving and the curb (tops). */
const groundsOf = (biome: BiomeDefinition): readonly (readonly [string, number])[] => [
  [`${biome.name} ground`, biome.ground.base.rgb],
  [`${biome.name} ground (second shade)`, biome.ground.base.secondary],
  [`${biome.name} second ground`, biome.ground.alt.rgb],
  [`${biome.name} paving`, biome.ground.paving.rgb],
  [`${biome.name} curb`, biome.ground.curb.rgb],
];

const failuresOn = (rgb: number, tone: 'candy' | 'neutral', grounds: readonly (readonly [string, number])[]): string[] => {
  const failures: string[] = [];
  for (const look of LOOKS) {
    for (const cloud of [false, true]) {
      const sky = cloud ? 'cloud shadow' : 'open sky';
      for (const [face, lambert] of FACES) {
        const shown = look.surface(rgb, lambert, cloud);
        if (tone === 'candy' && saturation(shown) < FLOOR.saturation) failures.push(`greys out: ${look.name}, ${sky}, ${face}`);
      }
      for (const [face, lambert] of tone === 'candy' ? COMPARED_FACES : FACES.slice(0, 1)) {
        const shown = look.surface(rgb, lambert, cloud);
        for (const [groundName, ground] of grounds) {
          const lit = look.ground(ground, cloud);
          if (tone === 'neutral') {
            if (Math.abs(luma(shown) - luma(lit)) < (look.night ? FLOOR.neutralLumaNight : FLOOR.neutralLumaDay)) {
              failures.push(`vanishes: ${look.name}, ${sky}, ${face} on ${groundName}`);
            }
          } else if (distance(shown, lit) < (look.night ? FLOOR.groundNight : FLOOR.groundDay)) {
            failures.push(`vanishes: ${look.name}, ${sky}, ${face} ${Math.round(distance(shown, lit) * 255)} RGB from ${groundName}`);
          }
        }
      }
    }
  }
  return failures;
};

/** The worst (smallest) distance between two ground colours over every look, top face, open sky, as RGB/255. */
const worstGroundGap = (a: number, b: number, night: boolean): number => Math.min(...LOOKS
  .filter((look) => look.night === night)
  .map((look) => distance(look.ground(a, false), look.ground(b, false))));

describe('biome grounds stay colourful and readable (Phase 24)', () => {
  it('judges the twelve real looks', () => {
    expect(LOOKS).toHaveLength(12);
    expect(BIOMES).toHaveLength(6);
  });

  it.each(BIOMES.map((biome) => [biome.name, biome] as const))('%s: every colour swatch stays visible on its grounds, paving and curb in every light and weather', (_name, biome) => {
    const failing = COLOUR_SWATCHES.filter((swatch) => failuresOn(swatch.rgb, swatch.tone, groundsOf(biome)).length > 0).map((swatch) => swatch.name);
    expect(failing).toEqual(PINNED_FAILING_SWATCHES[biome.id] ?? []);
    // Whatever is pinned fails for a stated reason, never because a candy colour greys out: every swatch keeps its saturation everywhere.
    for (const swatch of COLOUR_SWATCHES.filter((candidate) => candidate.tone === 'candy')) {
      expect(failuresOn(swatch.rgb, swatch.tone, []).filter((failure) => failure.startsWith('greys out')), swatch.name).toEqual([]);
    }
    // And the ground tops alone (both lawns and the second ground): only the colours of the ground's own hue family are lost.
    const tops = groundsOf(biome).filter(([name]) => !name.includes('paving') && !name.includes('curb'));
    const lostOnGround = COLOUR_SWATCHES.filter((swatch) => failuresOn(swatch.rgb, swatch.tone, tops).length > 0).map((swatch) => swatch.name);
    expect(lostOnGround.length, `swatches lost on the ground itself: ${lostOnGround.join(', ')}`).toBeLessThanOrEqual(4);
  });

  it.each(BIOMES.map((biome) => [biome.name, biome] as const))('%s: paving reads against both grounds and the curb differs from the paving', (_name, biome) => {
    const { base, alt, paving, curb } = biome.ground;
    for (const night of [false, true]) {
      const floor = night ? FLOOR.pavingNight : FLOOR.pavingDay;
      for (const [name, ground] of [['ground', base.rgb], ['second ground', alt.rgb]] as const) {
        expect(worstGroundGap(paving.rgb, ground, night), `paving vs ${name}, ${night ? 'night' : 'day'}`).toBeGreaterThanOrEqual(floor);
      }
    }
    // The curb outlines the paving: darker, or (Winter's white snow-bank edge on peppermint) clearly lighter.
    expect(Math.abs(luma(unit(curb.rgb)) - luma(unit(paving.rgb))), 'the curb differs from the paving it edges').toBeGreaterThanOrEqual(0.08);
  });

  it.each(BIOMES.map((biome) => [biome.name, biome] as const))('%s: its props stand out from its grounds (outlines carry the exceptions below)', (_name, biome) => {
    const grounds: readonly number[] = [biome.ground.base.rgb, biome.ground.alt.rgb];
    const lowContrast: string[] = [];
    for (const kind of PROP_KINDS.filter((candidate) => candidate.biome === biome.id)) {
      for (const night of [false, true]) {
        const floor = night ? FLOOR.propNight : FLOOR.propDay;
        const worst = Math.min(...grounds.map((ground) => LOOKS
          .filter((look) => look.night === night)
          .map((look) => distance(look.surface(kind.color, 1, false), look.ground(ground, false)))
          .reduce((m, d) => Math.min(m, d), Infinity)));
        if (worst < floor) lowContrast.push(`${kind.id} (${night ? 'night' : 'day'})`);
      }
    }
    expect(lowContrast).toEqual(LOW_CONTRAST_PROPS[biome.id] ?? []);
  });
});

/** Props whose main colour is close to the ground of their biome: white snow on snow reads by its outline and its shaded sides. */



/**
 * Props whose main colour is close to the ground of their biome on a TOP face (red rock on a red-rock floor, white snow on
 * snow, a driftwood log on sand at night). They stay readable by their outline, their shaded sides and their strata or
 * ice bands; this pins which, so a retune of a ground colour that makes another prop vanish shows up here.
 */
const LOW_CONTRAST_PROPS: Readonly<Record<string, string[]>> = {
  // Seaside: the golden sand and candy sea-mint (Phase 24 step 2) leave driftwood readable at night, so nothing is pinned.
  'desert-canyon': ['red-boulder (day)', 'canyon-wall (day)', 'rock-spire (day)'],
  winter: ['snow-drift (day)', 'snow-drift (night)', 'snowman (day)', 'glacier-rock (night)'],
  'autumn-forest': ['pumpkin-patch (day)'],
};

/**
 * Colour swatches that vanish against some ground, paving or curb of a biome in some look at the Phase 28 floors: colours
 * of the biome's own hue (orange rides on orange desert and leaf litter, cream on snow) and the curb's colour (turquoise
 * curbs in the canyon, plum in the forest). A ride stands on its own plot slab (the Meadow-green tint, unchanged) and is
 * outlined, so these are the cases where the player picks another swatch; Meadow and Jungle lose none.
 */
const PINNED_FAILING_SWATCHES: Readonly<Record<string, string[]>> = {
  // Seaside (candy sea-mint 0x5ed6a4, golden sand): the greens vanish on the mint (its own hue family), Cream now reads on the sand.
  seaside: ['Apricot', 'Rose', 'Bubblegum', 'Mint', 'Emerald', 'Teal'],
  'desert-canyon': ['Vermilion', 'Apricot', 'Honey', 'Cream', 'Sky', 'Azure', 'Mint', 'Emerald', 'Teal'],
  winter: ['Cream', 'Rose', 'Bubblegum', 'Orchid', 'Glacier'],
  'autumn-forest': ['Vermilion', 'Apricot', 'Honey', 'Citron', 'Bubblegum', 'Orchid', 'Violet', 'Indigo'],
};
