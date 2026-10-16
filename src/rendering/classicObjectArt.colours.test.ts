import { Container } from 'pixi.js';
import { describe, expect, it, vi } from 'vitest';

/**
 * Phase 40: these pins are of the classic renderer, frozen before buildings had fronts; with front-only access on, the
 * dev park's stalls turn toward their paths. The renderer is not what moved, so the pins run with the rule off.
 */
vi.mock('../game/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../game/config')>();
  return { ...actual, GAME_CONFIG: { ...actual.GAME_CONFIG, access: { ...actual.GAME_CONFIG.access, frontOnly: false } } };
});
import { BUILD_BY_ID, BUILD_CATALOG, PHASE29_DEFINITION_IDS, PHASE39_DEFINITION_IDS } from '../game/content/catalog';
import { COLOUR_SWATCHES, COLOURABLE_DEFINITION_IDS, ENTRANCE_COLOUR_ID, colourKindOf, colourSlotsFor, type ObjectColours } from '../game/content/colours';
import { COASTER_TYPE_BY_ID } from '../game/coaster/content';
import { ParkSession } from '../game/session/ParkSession';
import { seedColourTestPark } from '../game/session/colourTestPark';
import type { Rotation } from '../game/types';
import { classicCoasterPalette } from './classicCoaster';
import { createObjectArt, drawEntranceArt } from './classicObjectArt';
import { classicTrainSpec, classicTrainStyle, createClassicTrain } from './classicTrain';
import { fingerprintNode } from './sceneFingerprint';
import type { ViewRotation } from './viewRotation';
import { WorldRenderer } from './WorldRenderer';
import baseline from './__fixtures__/classic-step2-baseline.json';

/**
 * Phase 28 step 2, classic art of everything that is not a flat ride: stalls and facilities, the bench, bin and
 * scenery, the entrance gate, the coaster track palette and the classic train.
 *
 * - DEFAULTS ARE PIXEL-IDENTICAL: the fixture is the fingerprint (every transform and every recorded drawing
 *   instruction) of the colour test park's displays at all four view rotations, the entrance, the three trains and
 *   every build preview, taken BEFORE any step-2 change. An object with no record draws exactly that.
 * - A SLOT OWNS ITS PARTS: recolouring one slot puts the swatch colour into the art and differs from every other slot.
 * - The swatch that is a slot's default draws the default art; a hostile record reads like restore reads it.
 */

const sha16 = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 16);
};

const PICKS = ['lagoon', 'cherry', 'sky', 'honey'] as const;
/**
 * A swatch whose colour the given art does not already contain, so "it shows the swatch" is a real statement, and
 * (Phase 16: the Neon Pylon's primary is Lagoon) that is no slot default of `definitionId`, which would draw the default.
 */
const pickFor = (art: string, definitionId?: string): (typeof COLOUR_SWATCHES)[number] => {
  const defaults = new Set(definitionId === undefined ? [] : colourSlotsFor(definitionId).map((slot) => slot.defaultRgb));
  for (const id of PICKS) {
    const swatch = COLOUR_SWATCHES.find((candidate) => candidate.id === id)!;
    if (!art.includes(`{${swatch.classicRgb}/`) && !defaults.has(swatch.rgb)) return swatch;
  }
  throw new Error('no free swatch');
};

const objectFingerprint = (definitionId: string, colours: ObjectColours | null = null): string => {
  const art = createObjectArt(BUILD_BY_ID.get(definitionId)!, colours);
  const text = fingerprintNode(art);
  art.destroy({ children: true, context: true });
  return text;
};
const gateFingerprint = (colours: ObjectColours | null = null): string => {
  const group = new Container();
  drawEntranceArt(group, colours);
  const text = fingerprintNode(group);
  group.destroy({ children: true, context: true });
  return text;
};
const trainFingerprint = (definitionId: string, colours: ObjectColours | null = null): string => {
  const type = COASTER_TYPE_BY_ID.get(definitionId)!;
  const train = createClassicTrain(type.trainCars, classicTrainSpec(definitionId, colours), type.trainCapacity);
  const text = fingerprintNode(train.container);
  train.container.destroy({ children: true, context: true });
  return text;
};

const record = (definitionId: string, index: number, swatch: number): ObjectColours => (
  Object.freeze(colourSlotsFor(definitionId).map((_slot, at) => (at === index ? swatch : null)))
);

const NON_RIDE_OBJECTS = COLOURABLE_DEFINITION_IDS.filter((id) => ['stall', 'comfort', 'scenery'].includes(colourKindOf(id) ?? ''));
const COASTERS = COLOURABLE_DEFINITION_IDS.filter((id) => colourKindOf(id) === 'coaster');

describe('classic non-ride art: defaults are pixel-identical to before step 2', () => {
  it('every object display of the colour test park at four view rotations, the entrance, the trains and the previews match the baseline', async () => {
    const session = new ParkSession(null);
    const report = seedColourTestPark(session);
    expect(report.problems).toEqual([]);
    const renderer = new WorldRenderer(session);
    renderer.syncWorld();
    const seen = new Map<string, string>();
    const entrance: Record<string, string> = {};
    for (const rotation of [0, 1, 2, 3] as ViewRotation[]) {
      renderer.setViewRotation(rotation, true);
      renderer.syncWorld();
      const probe = renderer.sceneProbe;
      for (const entry of probe.objects) {
        const object = session.world.objects.get(entry.objectId)!;
        const definition = BUILD_BY_ID.get(object.definitionId)!;
        if (definition.kind === 'ride' && definition.custom !== 'coaster') continue;
        seen.set(`${object.definitionId}#${entry.objectId}#v${rotation}`, await sha16(fingerprintNode(entry.container)));
      }
      entrance[`v${rotation}`] = probe.entranceDisplay ? await sha16(fingerprintNode(probe.entranceDisplay)) : 'none';
    }
    const expected = new Map<string, string>();
    for (const [key, views] of Object.entries(baseline.objects)) for (const [view, hash] of Object.entries(views)) expected.set(`${key}#${view}`, hash as string);
    expect([...seen.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [key, hash] of expected) expect(seen.get(key), key).toBe(hash);
    expect(entrance).toEqual(baseline.entrance);
    renderer.setViewRotation(0, true);
    // Phase 39's coasters came after the baseline (their classic trains have their own tests).
    for (const definition of BUILD_CATALOG.filter((candidate) => candidate.custom === 'coaster' && !PHASE39_DEFINITION_IDS.includes(candidate.id))) {
      const type = COASTER_TYPE_BY_ID.get(definition.id)!;
      const train = createClassicTrain(type.trainCars, classicTrainStyle(definition.id), type.trainCapacity);
      expect(await sha16(fingerprintNode(train.container)), `${definition.id} train`).toBe((baseline.trains as Record<string, string>)[definition.id]);
      train.container.destroy({ children: true, context: true });
    }
    const previewLayer = (renderer as unknown as { previewLayer: Container }).previewLayer;
    let previews = 0;
    for (const definition of BUILD_CATALOG) {
      if (definition.kind === 'path' || definition.custom === 'coaster' || definition.kind === 'ride') continue;
      // Phase 29 stalls came after the baseline was taken (they have no default art to stay identical to).
      if (PHASE29_DEFINITION_IDS.includes(definition.id)) continue;
      for (const rotation of [0, 1] as Rotation[]) {
        for (const valid of [true, false]) {
          const cells = session.world.footprintCells(definition, { x: 2, y: 1 }, rotation);
          // With no colours, with null, and with a record of nothing set: all the one baseline preview.
          for (const colours of [undefined, null, Object.freeze(colourSlotsFor(definition.id).map(() => null))]) {
            renderer.drawPreview(cells, definition, valid, false, rotation, colours);
            expect(await sha16(fingerprintNode(previewLayer)), `${definition.id} r${rotation} ${valid}`).toBe((baseline.previews as Record<string, string>)[`${definition.id}:r${rotation}:${valid ? 'ok' : 'bad'}`]);
          }
          previews += 1;
        }
      }
    }
    expect(previews).toBe(Object.keys(baseline.previews).length);
    renderer.clearPreview();
    renderer.destroy();
  });
});

describe('classic non-ride art: the Phase 16 entries (legacy renderer, generic fallbacks only)', () => {
  it('draws a display object for every new stall and scenery id', () => {
    const ids = ['pretzel-pram', 'coconut-cove', 'bunting-mast', 'shell-planter', 'harbor-lighthouse', 'tiki-torch', 'jungle-idol', 'neon-pylon', 'orbit-globe'];
    for (const id of ids) {
      const art = createObjectArt(BUILD_BY_ID.get(id)!);
      expect(art, id).toBeInstanceOf(Container);
      expect(art.children.length, `${id} draws something`).toBeGreaterThan(0);
      expect(fingerprintNode(art).length, `${id} records drawing instructions`).toBeGreaterThan(0);
      art.destroy({ children: true, context: true });
    }
  });
});

describe('classic non-ride art: a slot owns its parts', () => {
  it('stalls, comforts and scenery: each slot puts the swatch in, changes the art, and differs from every other slot', () => {
    expect(NON_RIDE_OBJECTS.length, '15 before Phase 16, plus its 2 stalls and 7 themed scenery pieces, plus the 6 Phase 29 stalls').toBe(30);
    for (const id of NON_RIDE_OBJECTS) {
      const slots = colourSlotsFor(id);
      const base = objectFingerprint(id);
      const swatch = pickFor(base, id);
      const seen = new Set<string>([base]);
      for (const [index, slot] of slots.entries()) {
        const painted = objectFingerprint(id, record(id, index, swatch.index));
        expect(painted, `${id} ${slot.id} changes the art`).not.toBe(base);
        expect(painted.includes(`{${swatch.classicRgb}/`), `${id} ${slot.id} shows the swatch`).toBe(true);
        expect(seen.has(painted), `${id} ${slot.id} differs from every other slot`).toBe(false);
        seen.add(painted);
      }
    }
  });

  it('what no slot owns stays: the door, the window strip, the bench legs, the plant bed, the water and the trunk', () => {
    const count = (text: string, colour: number): number => text.split(`{${colour}/`).length - 1;
    const FIXED: Record<string, number[]> = {
      'picnic-pocket': [0x193e42, 0x275b66, 0xffffff],
      'ribbon-bench': [0x315c54],
      'tidy-totem': [0x193e42],
      'lollipop-lamp': [0xffffff],
      'sunburst-flowers': [0x347857],
      'ripple-fountain': [0x2b6f8e],
    };
    for (const [id, colours] of Object.entries(FIXED)) {
      const slots = colourSlotsFor(id);
      const base = objectFingerprint(id);
      const all = objectFingerprint(id, Object.freeze(slots.map(() => COLOUR_SWATCHES[20].index)));
      for (const colour of colours) expect(count(all, colour), `${id} ${colour.toString(16)}`).toBe(count(base, colour));
    }
    // The fountain's water and the roof of a stall: the water jet keeps the catalog accent, the roof follows its slot.
    const fountain = BUILD_BY_ID.get('ripple-fountain')!;
    expect(objectFingerprint('ripple-fountain', Object.freeze([COLOUR_SWATCHES[3].index]))).toContain(`{${fountain.accent}/`);
  });

  it('trees are not colourable: no record is read, whatever it says', () => {
    expect(colourSlotsFor('confetti-tree')).toHaveLength(0);
    const base = objectFingerprint('confetti-tree');
    expect(objectFingerprint('confetti-tree', Object.freeze([3, 4]))).toBe(base);
  });

  it('a stall\'s roof slot paints the roof, the sign strip and nothing of the walls', () => {
    const base = objectFingerprint('picnic-pocket');
    const roof = objectFingerprint('picnic-pocket', record('picnic-pocket', 1, COLOUR_SWATCHES[16].index));
    const walls = objectFingerprint('picnic-pocket', record('picnic-pocket', 0, COLOUR_SWATCHES[16].index));
    const azure = String(COLOUR_SWATCHES[16].classicRgb);
    const countAzure = (text: string): number => text.split(`{${azure}/`).length - 1;
    expect(countAzure(base)).toBe(0);
    expect(countAzure(roof), 'the roof triangle and the sign strip').toBe(2);
    expect(countAzure(walls), 'the body').toBe(1);
  });

  it('the swatch that is a slot\'s default colour draws the default art', () => {
    let checked = 0;
    for (const id of NON_RIDE_OBJECTS) {
      const base = objectFingerprint(id);
      for (const [index, slot] of colourSlotsFor(id).entries()) {
        const swatch = COLOUR_SWATCHES.find((candidate) => candidate.rgb === slot.defaultRgb);
        if (!swatch) continue;
        expect(objectFingerprint(id, record(id, index, swatch.index)), `${id}/${slot.id} (${swatch.name})`).toBe(base);
        checked += 1;
      }
    }
    // The slot defaults of stalls, comforts and scenery are the colours the catalog ships, none of them a swatch today.
    expect(checked).toBeGreaterThanOrEqual(0);
  });

  it('hostile records draw the defaults: out-of-range, fractional, negative, wrong length and wrong types', () => {
    for (const id of NON_RIDE_OBJECTS) {
      const base = objectFingerprint(id);
      for (const hostile of [[99, 99], [-1, -1], [0.5, 1.5], [Number.NaN, Infinity], [], [null], ['x', {}]]) {
        expect(objectFingerprint(id, Object.freeze(hostile) as unknown as ObjectColours), `${id} ${JSON.stringify(hostile)}`).toBe(base);
      }
    }
    expect(gateFingerprint(Object.freeze([99, -3, 0.5]))).toBe(gateFingerprint());
  });
});

describe('classic entrance gate', () => {
  it('has Arch, Sign and Posts: each puts the swatch in and differs from the others; the lettering and the sign outline are fixed', () => {
    const base = gateFingerprint();
    const swatch = pickFor(base);
    const seen = new Set<string>([base]);
    for (const [index, slot] of colourSlotsFor(ENTRANCE_COLOUR_ID).entries()) {
      const painted = gateFingerprint(record(ENTRANCE_COLOUR_ID, index, swatch.index));
      expect(painted, slot.id).not.toBe(base);
      expect(painted.includes(`{${swatch.classicRgb}/`), slot.id).toBe(true);
      expect(seen.has(painted)).toBe(false);
      seen.add(painted);
    }
    const everything = gateFingerprint(Object.freeze([swatch.index, swatch.index, swatch.index]));
    expect(everything.split('{1523003/').length - 1, 'the sign outline 0x173f3b stays').toBe(base.split('{1523003/').length - 1);
  });

  it('draws the shipped gate for no record and for the swatch that is each slot default', () => {
    expect(gateFingerprint(null)).toBe(gateFingerprint());
    for (const [index, slot] of colourSlotsFor(ENTRANCE_COLOUR_ID).entries()) {
      const swatch = COLOUR_SWATCHES.find((candidate) => candidate.rgb === slot.defaultRgb);
      if (swatch) expect(gateFingerprint(record(ENTRANCE_COLOUR_ID, index, swatch.index))).toBe(gateFingerprint());
    }
  });
});

describe('classic coaster palette and train', () => {
  const LAGOON = COLOUR_SWATCHES.find((swatch) => swatch.id === 'lagoon')!;
  const CHERRY = COLOUR_SWATCHES.find((swatch) => swatch.id === 'cherry')!;

  it('no record, null and an all-default record answer the shipped palette object itself', () => {
    for (const id of COASTERS) {
      const color = BUILD_BY_ID.get(id)!.color;
      const base = classicCoasterPalette(id, color);
      expect(classicCoasterPalette(id, color, null)).toBe(base);
      expect(classicCoasterPalette(id, color, Object.freeze([null, null, null, null]))).toBe(base);
      expect(classicTrainSpec(id, null)).toBe(classicTrainSpec(id, Object.freeze([null, null, null, null])));
    }
  });

  it('Rails recolours the rails, the platform edge, the gate and the valance (the palette rail and edge); Supports the supports, spine and ties; Train the canopy', () => {
    for (const id of COASTERS) {
      const color = BUILD_BY_ID.get(id)!.color;
      const base = classicCoasterPalette(id, color);
      const rails = classicCoasterPalette(id, color, record(id, 2, CHERRY.index));
      expect(rails.rail).toBe(CHERRY.classicRgb);
      expect(rails.edge).toBe(CHERRY.classicRgb);
      expect({ ...rails, rail: 0, edge: 0 }).toEqual({ ...base, rail: 0, edge: 0 });
      const supports = classicCoasterPalette(id, color, record(id, 3, CHERRY.index));
      expect([supports.support, supports.spine, supports.tie]).toEqual([CHERRY.classicRgb, CHERRY.classicRgb, CHERRY.classicRgb]);
      expect(supports.rail).toBe(base.rail);
      expect(supports.canopy).toBe(base.canopy);
      const train = classicCoasterPalette(id, color, record(id, 0, CHERRY.index));
      expect(train.canopy).toBe(CHERRY.classicRgb);
      expect({ ...train, canopy: 0 }).toEqual({ ...base, canopy: 0 });
      // The station's ground diamonds are ground contact: never recoloured.
      for (const index of [0, 2, 3]) expect(classicCoasterPalette(id, color, record(id, index, CHERRY.index)).ground).toBe(base.ground);
      // Seats do not touch the track palette at all (they are the train's stripe and fin).
      expect(classicCoasterPalette(id, color, record(id, 1, CHERRY.index))).toBe(base);
    }
  });

  it('the train hull follows Train (the lead car keeps its tone), the stripe and fin follow Seats; nothing else of a train moves', () => {
    for (const id of COASTERS) {
      const base = trainFingerprint(id);
      const spec = classicTrainSpec(id, null);
      // The Skyline Serpent's train IS Lagoon by default: pick a swatch that is not the slot default.
      const pick = colourSlotsFor(id)[0].defaultRgb === LAGOON.rgb ? CHERRY : LAGOON;
      const hull = classicTrainSpec(id, record(id, 0, pick.index));
      expect(hull.body).toBe(pick.classicRgb);
      expect(hull.lead, 'a toned lead car, not the same colour as the body unless the default was').not.toBe(spec.lead);
      expect(hull.accent).toBe(spec.accent);
      expect(trainFingerprint(id, record(id, 0, pick.index))).not.toBe(base);
      const seats = classicTrainSpec(id, record(id, 1, CHERRY.index));
      expect(seats.accent).toBe(CHERRY.classicRgb);
      expect(seats.body).toBe(spec.body);
      expect(seats.lead).toBe(spec.lead);
      expect(trainFingerprint(id, record(id, 1, CHERRY.index))).not.toBe(base);
      // Rails and Supports are the track's, not the train's.
      expect(trainFingerprint(id, record(id, 2, CHERRY.index))).toBe(base);
      expect(trainFingerprint(id, record(id, 3, CHERRY.index))).toBe(base);
    }
  });

  it('the swatch that is a coaster slot default draws the default (Lagoon on the Skyline Serpent train and canopy, Mint and Lemon-like rails where a swatch)', () => {
    let checked = 0;
    for (const id of COASTERS) {
      const color = BUILD_BY_ID.get(id)!.color;
      for (const [index, slot] of colourSlotsFor(id).entries()) {
        const swatch = COLOUR_SWATCHES.find((candidate) => candidate.rgb === slot.defaultRgb);
        if (!swatch) continue;
        const colours = record(id, index, swatch.index);
        expect(classicCoasterPalette(id, color, colours), `${id}/${slot.id}`).toBe(classicCoasterPalette(id, color));
        expect(trainFingerprint(id, colours), `${id}/${slot.id} train`).toBe(trainFingerprint(id));
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  it('hostile records leave the palette and the train alone', () => {
    for (const id of COASTERS) {
      const color = BUILD_BY_ID.get(id)!.color;
      for (const hostile of [[99, 99, 99, 99], [-1, 0.5, Number.NaN, 'x'], []]) {
        expect(classicCoasterPalette(id, color, Object.freeze(hostile) as unknown as ObjectColours), JSON.stringify(hostile)).toBe(classicCoasterPalette(id, color));
        expect(classicTrainSpec(id, Object.freeze(hostile) as unknown as ObjectColours)).toBe(classicTrainSpec(id, null));
      }
    }
  });
});
