import { describe, expect, it } from 'vitest';
import { BUILD_BY_ID } from '../game/content/catalog';
import { COLOUR_SWATCHES, colourSlotsFor, type ObjectColours } from '../game/content/colours';
import type { Rotation } from '../game/types';
import { createRideArt, DEFAULT_RIDE_PAINT, linkedTone, ridePaintFor } from './rideArt';
import { fingerprintNode } from './sceneFingerprint';

/**
 * Phase 28 step 1, classic ride art. Three promises:
 *
 * - DEFAULTS ARE PIXEL-IDENTICAL. The hashes below were taken from the art as it was before slots
 *   existed (the fingerprint is every transform and every recorded drawing instruction, in the idle
 *   pose and in a mid-ride pose), for every ride and every rotation. A ride with no record, an empty
 *   record or an all-default record draws exactly that.
 * - A SLOT OWNS ITS PARTS. Recolouring a slot changes the art and puts the swatch colour into it;
 *   what no slot owns (steel, timber, glass, lights, riders, the plot) is byte for byte unchanged.
 * - HOSTILE RECORDS ARE READ LIKE RESTORE READS THEM: a bad entry is the default for its slot.
 */

const GOLDEN: Readonly<Record<string, readonly string[]>> = {
  'petal-roundabout': ['8706688c08a8', '8706688c08a8', '8706688c08a8', '8706688c08a8'],
  'comet-cups': ['006217b87a9d', '006217b87a9d', '006217b87a9d', '006217b87a9d'],
  'cloud-hopper': ['6c0c844abaee', '6c0c844abaee', '6c0c844abaee', '6c0c844abaee'],
  'aurora-wheel': ['66164ebf5cd4', '66164ebf5cd4', '66164ebf5cd4', '66164ebf5cd4'],
  'moonpetal-carousel': ['660af333b667', '660af333b667', '660af333b667', '660af333b667'],
  'bumble-coach': ['d07af8c15bb6', 'f7cceb133b2a', 'd07af8c15bb6', 'f7cceb133b2a'],
  'harbor-swings': ['c2a29ac08e41', 'c2a29ac08e41', 'c2a29ac08e41', 'c2a29ac08e41'],
  'splash-rings': ['acafa46da955', '61963386d439', 'acafa46da955', '61963386d439'],
  'gale-spinner': ['9bd5f68a84bf', '9bd5f68a84bf', '9bd5f68a84bf', '9bd5f68a84bf'],
  'thunder-drum': ['37cc67df9f2a', '37cc67df9f2a', '37cc67df9f2a', '37cc67df9f2a'],
};

const POSES = [
  { spin: 0, motion: 0, progress: 0, elapsedMs: 0, status: 'idle' as const },
  { spin: 5000, motion: 1, progress: 0.4, elapsedMs: 3000, status: 'running' as const },
];

const fingerprint = (id: string, rotation: Rotation, colours?: ObjectColours | null): string => {
  const art = createRideArt(BUILD_BY_ID.get(id)!, rotation, colours);
  const parts: string[] = [];
  for (const pose of POSES) {
    art.animate(pose);
    parts.push(fingerprintNode(art.container));
  }
  art.container.destroy({ children: true, context: true });
  return parts.join('##');
};

/** SHA-1 through Web Crypto (the project has no Node typings), first 12 hex digits. */
const hash = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 12);
};

const RIDE_IDS = Object.keys(GOLDEN);
const LAGOON = COLOUR_SWATCHES.find((swatch) => swatch.id === 'lagoon')!;
const CHERRY = COLOUR_SWATCHES.find((swatch) => swatch.id === 'cherry')!;

describe('classic ride art: defaults are pixel-identical', () => {
  it('covers every colourable ride', () => {
    for (const id of RIDE_IDS) expect(colourSlotsFor(id).length, id).toBeGreaterThanOrEqual(2);
    expect(RIDE_IDS.length).toBe(10);
  });

  it('draws the pre-colour art for every ride and rotation when there is no record', async () => {
    for (const id of RIDE_IDS) {
      for (const rotation of [0, 1, 2, 3] as Rotation[]) {
        expect(await hash(fingerprint(id, rotation)), `${id} rotation ${rotation}`).toBe(GOLDEN[id][rotation]);
        expect(await hash(fingerprint(id, rotation, null)), `${id} null`).toBe(GOLDEN[id][rotation]);
      }
    }
  });

  it('treats an empty, short or all-default record as defaults', async () => {
    for (const id of RIDE_IDS) {
      const slots = colourSlotsFor(id).length;
      const expected = GOLDEN[id][0];
      expect(await hash(fingerprint(id, 0, Object.freeze(new Array<number | null>(slots).fill(null)))), id).toBe(expected);
      expect(await hash(fingerprint(id, 0, Object.freeze([]))), id).toBe(expected);
    }
    expect(ridePaintFor('petal-roundabout', null)).toBe(DEFAULT_RIDE_PAINT);
    expect(ridePaintFor('petal-roundabout', Object.freeze([null, null]))).toBe(DEFAULT_RIDE_PAINT);
  });
});

describe('classic ride art: a slot owns its parts', () => {
  it('recolouring any one slot changes the art, puts the swatch colour in and leaves the others alone', () => {
    for (const id of RIDE_IDS) {
      const slots = colourSlotsFor(id);
      const base = fingerprint(id, 0);
      expect(base.includes(String(LAGOON.classicRgb)), `${id} default never uses lagoon`).toBe(false);
      const seen = new Set<string>([base]);
      for (const [index, slot] of slots.entries()) {
        const record = Object.freeze(slots.map((_slot, at) => (at === index ? LAGOON.index : null)));
        const painted = fingerprint(id, 0, record);
        expect(painted, `${id} ${slot.id} changes the art`).not.toBe(base);
        expect(painted.includes(String(LAGOON.classicRgb)), `${id} ${slot.id} shows the swatch`).toBe(true);
        expect(seen.has(painted), `${id} ${slot.id} differs from every other slot`).toBe(false);
        seen.add(painted);
      }
    }
  });

  it('the swatch that is a slot\'s default draws the default art, even where the classic art drew that slot in its own literal', () => {
    // Review finding: the carousel's manes, finial (Trim) and pennant (Main) and the aurora's cabins (Trim)
    // were drawn in cream literals before slots existed, so painting the default-named swatch repainted them.
    let checked = 0;
    for (const id of RIDE_IDS) {
      const slots = colourSlotsFor(id);
      const base = fingerprint(id, 0);
      for (const [index, slot] of slots.entries()) {
        const swatch = COLOUR_SWATCHES.find((candidate) => candidate.rgb === slot.defaultRgb);
        if (!swatch) continue;
        const record = Object.freeze(slots.map((_slot, at) => (at === index ? swatch.index : null)));
        expect(fingerprint(id, 0, record), `${id}/${slot.id} (${swatch.name})`).toBe(base);
        checked += 1;
      }
    }
    expect(checked, 'every slot whose default is a swatch').toBe(14);
    const cream = COLOUR_SWATCHES.find((swatch) => swatch.id === 'cream')!;
    const orchid = COLOUR_SWATCHES.find((swatch) => swatch.id === 'orchid')!;
    expect(fingerprint('aurora-wheel', 0, Object.freeze([null, null, cream.index]))).toBe(fingerprint('aurora-wheel', 0));
    expect(fingerprint('moonpetal-carousel', 0, Object.freeze([orchid.index, null, null]))).toBe(fingerprint('moonpetal-carousel', 0));
    // Cream is not the carousel's Trim default (that is Sunflower, no swatch any more), so it does repaint it.
    expect(fingerprint('moonpetal-carousel', 0, Object.freeze([null, null, cream.index]))).not.toBe(fingerprint('moonpetal-carousel', 0));
  });

  it('keeps every fixed colour: steel, timber and the lights count the same before and after', () => {
    const FIXED = [0x2c5b64, 0x4d7f86, 0x79543a, 0xfff3d0, 0x1f4a52, 0x143c40, 0xa8bcb6, 0xdfeaf2, 0x1c5563, 0x35635f, 0x4a7f78, 0x2f5d63];
    const count = (text: string, colour: number): number => text.split(`{${colour}/`).length - 1;
    for (const id of RIDE_IDS) {
      const slots = colourSlotsFor(id);
      const base = fingerprint(id, 0);
      const all = fingerprint(id, 0, Object.freeze(slots.map(() => CHERRY.index)));
      expect(FIXED.reduce((sum, colour) => sum + count(base, colour), 0), `${id} has fixed parts to protect`).toBeGreaterThan(0);
      for (const colour of FIXED) {
        if (id === 'aurora-wheel' && colour === 0xfff3d0) continue; // the cream cabins ARE the trim slot
        expect(count(all, colour), `${id} ${colour.toString(16)}`).toBe(count(base, colour));
      }
    }
  });

  it('draws the same shapes in a recolour: only colours move, never geometry', () => {
    const stripColours = (text: string): string => text.replace(/\{[^}]*\}/g, '{}');
    for (const id of RIDE_IDS) {
      const slots = colourSlotsFor(id);
      const all = fingerprint(id, 1, Object.freeze(slots.map((_slot, at) => (at * 7 + 3) % COLOUR_SWATCHES.length)));
      expect(stripColours(all), id).toBe(stripColours(fingerprint(id, 1)));
    }
  });

  it('reads hostile records like restore: a bad entry is the default for its slot', async () => {
    const id = 'comet-cups';
    const onlyFirst = Object.freeze([LAGOON.index, null]);
    const expected = await hash(fingerprint(id, 0, onlyFirst));
    const hostile: unknown[][] = [
      [LAGOON.index, Number.NaN], [LAGOON.index, -1], [LAGOON.index, 999], [LAGOON.index, 1.5],
      [LAGOON.index, 'x'], [LAGOON.index, undefined], [LAGOON.index], [LAGOON.index, null, 4, 5],
    ];
    for (const record of hostile) {
      expect(() => fingerprint(id, 0, record as never), JSON.stringify(record)).not.toThrow();
      expect(await hash(fingerprint(id, 0, record as never)), JSON.stringify(record)).toBe(expected);
    }
    expect(await hash(fingerprint(id, 0, [Number.NaN, Infinity] as never))).toBe(GOLDEN[id][0]);
  });

  it('colours a definition with no slots as the catalog does (the generic art ignores a record)', () => {
    const generic = { ...BUILD_BY_ID.get('petal-roundabout')!, id: 'not-a-bespoke-ride' };
    const plain = createRideArt(generic, 0);
    const painted = createRideArt(generic, 0, Object.freeze([LAGOON.index, null]));
    expect(fingerprintNode(painted.container)).toBe(fingerprintNode(plain.container));
  });
});

describe('classic linked tones and lights', () => {
  it('linkedTone returns the literal exactly at the default colour', () => {
    expect(linkedTone(0x7a1f16, 0xc0392b, 0xc0392b)).toBe(0x7a1f16);
    expect(linkedTone(0xf6d4e6, 0xd977b8, 0xd977b8)).toBe(0xf6d4e6);
    expect(linkedTone(0x123456, 0x654321, 0x654321)).toBe(0x123456);
  });

  it('a darker literal keeps its luma ratio to the slot colour, a lighter one its share of the way to white', () => {
    const luma = (rgb: number): number => 0.2126 * ((rgb >> 16) & 255) + 0.7152 * ((rgb >> 8) & 255) + 0.0722 * (rgb & 255);
    const lagoon = COLOUR_SWATCHES.find((swatch) => swatch.id === 'lagoon')!.rgb;
    const dark = linkedTone(0x7a1f16, 0xc0392b, lagoon);
    expect(luma(dark) / luma(lagoon)).toBeCloseTo(luma(0x7a1f16) / luma(0xc0392b), 1);
    expect(luma(dark)).toBeLessThan(luma(lagoon));
    const cream = COLOUR_SWATCHES.find((swatch) => swatch.id === 'cream')!.rgb;
    const light = linkedTone(0xf6d4e6, 0xd977b8, LAGOON.rgb);
    expect(luma(light), 'lighter than the colour it is a tone of').toBeGreaterThan(luma(LAGOON.rgb));
    expect(linkedTone(0xf6d4e6, 0xd977b8, 0xffffff), 'white stays white').toBe(0xffffff);
    expect(luma(linkedTone(0x7a1f16, 0xc0392b, cream))).toBeLessThan(luma(cream));
    for (const now of [0x000000, 0xffffff, 0x123456]) for (const literal of [0x000000, 0xffffff, 0x7a1f16, 0xf6d4e6]) {
      const tone = linkedTone(literal, 0xc0392b, now);
      expect(tone).toBeGreaterThanOrEqual(0);
      expect(tone).toBeLessThanOrEqual(0xffffff);
      expect(Number.isInteger(tone)).toBe(true);
    }
  });

  it('a thunder drum recoloured Main shades its rim and underside from the new colour, not the old red', () => {
    const base = fingerprint('thunder-drum', 0);
    expect(base.includes(String(0x7a1f16)) && base.includes(String(0x8f2a1f))).toBe(true);
    const painted = fingerprint('thunder-drum', 0, Object.freeze([LAGOON.index, null]));
    expect(painted.includes(String(0x7a1f16)), 'no old underside').toBe(false);
    expect(painted.includes(String(0x8f2a1f)), 'no old rim').toBe(false);
    expect(painted.includes(String(linkedTone(0x7a1f16, 0xc0392b, LAGOON.rgb)))).toBe(true);
    expect(painted.includes(String(linkedTone(0x8f2a1f, 0xc0392b, LAGOON.rgb)))).toBe(true);
  });

  it('the carousel drum follows Main too, and Accent leaves it alone', () => {
    const id = 'moonpetal-carousel';
    const base = fingerprint(id, 0);
    const main = fingerprint(id, 0, Object.freeze([LAGOON.index, null, null]));
    const accent = fingerprint(id, 0, Object.freeze([null, LAGOON.index, null]));
    for (const literal of [0x7c4a6d, 0xf6d4e6]) {
      expect(base.includes(String(literal))).toBe(true);
      expect(main.includes(String(literal)), `${literal.toString(16)} follows Main`).toBe(false);
      expect(accent.includes(String(literal)), `${literal.toString(16)} ignores Accent`).toBe(true);
    }
  });

  it('platforms, plates and booths that are tones of the ride colour follow Main, and ignore the other slots', () => {
    const LINKED: Record<string, number[]> = {
      'comet-cups': [0x3a3560, 0x574d8c, 0x6f61a8],
      'moonpetal-carousel': [0x6d3f61, 0x9a5f88, 0x7c4a6d, 0xf6d4e6],
      'gale-spinner': [0x3c2f5e, 0x3f3a63],
      'thunder-drum': [0x4a2320, 0x5c2b26, 0x7a1f16, 0x8f2a1f],
    };
    for (const [id, literals] of Object.entries(LINKED)) {
      const slots = colourSlotsFor(id);
      const base = fingerprint(id, 0);
      const main = fingerprint(id, 0, Object.freeze(slots.map((_slot, at) => (at === 0 ? LAGOON.index : null))));
      const rest = fingerprint(id, 0, Object.freeze(slots.map((_slot, at) => (at === 0 ? null : LAGOON.index))));
      for (const literal of literals) {
        expect(base.includes(`{${literal}/`), `${id} ${literal.toString(16)} is drawn by default`).toBe(true);
        expect(main.includes(`{${literal}/`), `${id} ${literal.toString(16)} follows Main`).toBe(false);
        expect(rest.includes(`{${literal}/`), `${id} ${literal.toString(16)} ignores the other slots`).toBe(true);
      }
    }
  });

  it('lamps keep their glow: the cloud hopper beacon and the thunder drum glow stay catalog yellow', () => {
    for (const id of ['cloud-hopper', 'thunder-drum']) {
      const accent = BUILD_BY_ID.get(id)!.accent;
      const painted = fingerprint(id, 0, Object.freeze(colourSlotsFor(id).map(() => LAGOON.index)));
      expect(painted.includes(`{${accent}/`), id).toBe(true);
    }
  });
});
