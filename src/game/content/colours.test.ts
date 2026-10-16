import { describe, expect, it } from 'vitest';
import { BUILD_BY_ID, BUILD_CATALOG } from './catalog';
import {
  COASTER_COLOUR_SLOTS,
  COLOURABLE_DEFINITION_IDS,
  COLOUR_SLOTS,
  COLOUR_SLOT_IDS,
  COLOUR_SLOT_TAG,
  COLOUR_SWATCHES,
  COMFORT_COLOUR_SLOTS,
  DEFAULT_COLOUR_NAMES,
  ENTRANCE_COLOUR_ID,
  ENTRANCE_COLOUR_SLOTS,
  MAX_COLOUR_SLOTS,
  RIDE_COLOUR_SLOTS,
  SCENERY_COLOUR_SLOTS,
  STALL_COLOUR_SLOTS,
  SWATCH_COUNT,
  SWATCH_ROWS,
  colourKindOf,
  colourSlotTag,
  colourSlotsFor,
  isColourable,
  isSlotDefaultSwatch,
  normaliseObjectColours,
  sameObjectColours,
  swatchOfRgb,
  validateObjectColours,
} from './colours';

const FLAT_RIDES = [
  'petal-roundabout', 'comet-cups', 'cloud-hopper', 'aurora-wheel', 'moonpetal-carousel',
  'bumble-coach', 'harbor-swings', 'splash-rings', 'gale-spinner', 'thunder-drum', 'tiki-tumbler',
  // Phase 16.
  'puddle-jumpers', 'rocket-pendulum', 'temple-trek',
] as const;

describe('swatches', () => {
  it('are pinned: [index, id, name, rgb, row] is the save format and may only ever be appended to', () => {
    expect(COLOUR_SWATCHES.map((s) => [s.index, s.id, s.name, s.rgb.toString(16).padStart(6, '0'), s.row])).toEqual([
      [0, 'cherry', 'Cherry', 'c0392b', 0], [1, 'vermilion', 'Vermilion', 'fa6539', 0], [2, 'apricot', 'Apricot', 'fa9157', 0],
      [3, 'honey', 'Honey', 'e8b23a', 0], [4, 'buttercup', 'Buttercup', 'ffea2b', 0], [5, 'citron', 'Citron', 'f4ff52', 0],
      [6, 'cream', 'Cream', 'fff0c8', 0],
      [7, 'rose', 'Rose', 'ef6f8f', 1], [8, 'bubblegum', 'Bubblegum', 'ffa6ce', 1], [9, 'orchid', 'Orchid', 'd977b8', 1],
      [10, 'lavender', 'Lavender', '8f7cf7', 1], [11, 'violet', 'Violet', '9557d1', 1], [12, 'indigo', 'Indigo', '6a49b3', 1],
      [13, 'ink', 'Ink', '2b2d42', 1],
      [14, 'glacier', 'Glacier', '96cfff', 2], [15, 'sky', 'Sky', '53b7e8', 2], [16, 'azure', 'Azure', '3a90c7', 2],
      [17, 'mint', 'Mint', '61e7d3', 2], [18, 'emerald', 'Emerald', '24d692', 2], [19, 'teal', 'Teal', '3aa7a3', 2],
      [20, 'lagoon', 'Lagoon', '1b7f79', 2],
    ]);
    expect(SWATCH_COUNT).toBe(21);
  });

  it('have unique ids, names and colours, a classic colour equal to the voxel one, and three rows of seven', () => {
    expect(new Set(COLOUR_SWATCHES.map((s) => s.id)).size).toBe(SWATCH_COUNT);
    expect(new Set(COLOUR_SWATCHES.map((s) => s.name)).size).toBe(SWATCH_COUNT);
    expect(new Set(COLOUR_SWATCHES.map((s) => s.rgb)).size).toBe(SWATCH_COUNT);
    for (const swatch of COLOUR_SWATCHES) expect(swatch.classicRgb, swatch.id).toBe(swatch.rgb);
    expect(SWATCH_ROWS.map((row) => row.swatches.length)).toEqual([7, 7, 7]);
    expect(SWATCH_ROWS.flatMap((row) => [...row.swatches])).toEqual(COLOUR_SWATCHES.map((s) => s.index));
    expect(COLOUR_SWATCHES.every((s) => s.rgb >= 0 && s.rgb <= 0xffffff)).toBe(true);
  });

  it('are immutable data', () => {
    expect(Object.isFrozen(COLOUR_SWATCHES)).toBe(true);
    expect(Object.isFrozen(COLOUR_SWATCHES[0])).toBe(true);
    expect(Object.isFrozen(SWATCH_ROWS[0].swatches)).toBe(true);
  });
});

describe('slots', () => {
  it('every flat ride declares 2 or 3 slots from the shared vocabulary, in primary, secondary, trim order', () => {
    expect(Object.keys(RIDE_COLOUR_SLOTS).sort()).toEqual([...FLAT_RIDES].sort());
    for (const id of FLAT_RIDES) {
      const slots = colourSlotsFor(id);
      expect(slots.length, id).toBeGreaterThanOrEqual(2);
      expect(slots.length, id).toBeLessThanOrEqual(3);
      expect(slots.length, id).toBeLessThanOrEqual(MAX_COLOUR_SLOTS);
      expect(slots.map((s) => s.id), id).toEqual(COLOUR_SLOT_IDS.slice(0, slots.length));
      for (const slot of slots) {
        expect(slot.label.length, `${id}.${slot.id} label`).toBeGreaterThan(0);
        expect(slot.label.length, `${id}.${slot.id} label fits the column`).toBeLessThanOrEqual(8);
        expect(slot.description.length, `${id}.${slot.id} description`).toBeGreaterThan(5);
        expect(Number.isInteger(slot.defaultRgb) && slot.defaultRgb >= 0 && slot.defaultRgb <= 0xffffff).toBe(true);
      }
    }
  });

  it('only aurora-wheel, moonpetal-carousel and harbor-swings have a trim slot', () => {
    const withTrim = FLAT_RIDES.filter((id) => colourSlotsFor(id).some((s) => s.id === 'trim')).sort();
    expect(withTrim).toEqual(['aurora-wheel', 'harbor-swings', 'moonpetal-carousel']);
  });

  it('primary and secondary defaults are the catalog colour and accent; trim defaults are the documented literals', () => {
    for (const id of FLAT_RIDES) {
      const definition = BUILD_BY_ID.get(id)!;
      const slots = colourSlotsFor(id);
      expect(slots[0].defaultRgb, `${id} primary`).toBe(definition.color);
      expect(slots[1].defaultRgb, `${id} secondary`).toBe(definition.accent);
    }
    const trim = (id: string): number => colourSlotsFor(id)[2].defaultRgb;
    expect(trim('aurora-wheel')).toBe(0xfff0c8);
    expect(trim('moonpetal-carousel')).toBe(0xffd166);
    expect(trim('harbor-swings')).toBe(0xfff0c8);
  });

  it('every slot default has a name; it is a swatch name only when that swatch is exactly the default', () => {
    const byName = new Map(COLOUR_SWATCHES.map((s) => [s.name, s]));
    const defaults = new Set<number>();
    for (const [id, slots] of Object.entries(COLOUR_SLOTS)) {
      for (const slot of slots) {
        defaults.add(slot.defaultRgb);
        expect(slot.defaultName.length, `${id}.${slot.id}`).toBeGreaterThan(0);
        const swatch = byName.get(slot.defaultName);
        if (swatch) expect(swatch.rgb, `${id}.${slot.id} is named ${swatch.name}`).toBe(slot.defaultRgb);
        else expect(DEFAULT_COLOUR_NAMES[slot.defaultRgb], `${id}.${slot.id}`).toBe(slot.defaultName);
      }
    }
    for (const name of Object.values(DEFAULT_COLOUR_NAMES)) expect(byName.has(name), `${name} is no swatch name`).toBe(false);
    expect(new Set(Object.values(DEFAULT_COLOUR_NAMES)).size, 'default names are unique').toBe(Object.keys(DEFAULT_COLOUR_NAMES).length);
    for (const rgb of Object.keys(DEFAULT_COLOUR_NAMES).map(Number)) {
      expect(defaults.has(rgb), `${rgb.toString(16)} is a slot default`).toBe(true);
      expect(swatchOfRgb(rgb), `${rgb.toString(16)} is no swatch`).toBeUndefined();
    }
    // Twelve slot defaults are swatches ("what it was" stays pickable): the eleven of step 1 plus Lagoon (the
    // Skyline Serpent's train). Every other default is reached by the Default chip and named in DEFAULT_COLOUR_NAMES.
    expect([...defaults].filter((rgb) => swatchOfRgb(rgb)).map((rgb) => swatchOfRgb(rgb)!.name).sort()).toEqual(
      ['Cherry', 'Cream', 'Honey', 'Ink', 'Lagoon', 'Lavender', 'Mint', 'Orchid', 'Rose', 'Sky', 'Teal', 'Violet'],
    );
    // + Clover and Peony (Phase 22: Cactus Cooler), + Lily pad (Phase 16: Puddle Jumpers).
    expect(Object.keys(DEFAULT_COLOUR_NAMES)).toHaveLength(5 + 29 + 2 + 1);
  });

  it('isSlotDefaultSwatch: exactly the swatch whose colour is that slot\'s default', () => {
    for (const id of FLAT_RIDES) {
      colourSlotsFor(id).forEach((slot, slotIndex) => {
        for (const swatch of COLOUR_SWATCHES) {
          expect(isSlotDefaultSwatch(id, slotIndex, swatch.index), `${id}.${slot.id} ${swatch.name}`).toBe(swatch.rgb === slot.defaultRgb);
        }
      });
    }
    expect(isSlotDefaultSwatch('petal-roundabout', 0, 7), 'Rose is the petal roundabout\'s Main').toBe(true);
    expect(isSlotDefaultSwatch('petal-roundabout', 5, 7), 'no such slot').toBe(false);
    expect(isSlotDefaultSwatch('ribbon-bench', 0, 7), 'not colourable').toBe(false);
    expect(isSlotDefaultSwatch('petal-roundabout', 0, Number.NaN)).toBe(false);
    expect(isSlotDefaultSwatch('petal-roundabout', 0, 99)).toBe(false);
  });

  it('slot tags are positional (index + 1, at most five); the step-1 tags still hold for every flat ride', () => {
    expect(COLOUR_SLOT_TAG.primary).toBe(1);
    expect(COLOUR_SLOT_TAG.secondary).toBe(2);
    expect(COLOUR_SLOT_TAG.trim).toBe(3);
    for (const [id, slots] of Object.entries(COLOUR_SLOTS)) {
      slots.forEach((slot, index) => {
        expect(slot.tag, `${id}.${slot.id}`).toBe(index + 1);
        expect(slot.tag).toBeLessThanOrEqual(MAX_COLOUR_SLOTS);
        expect(colourSlotTag(id, slot.id), `${id}.${slot.id}`).toBe(slot.tag);
      });
    }
    for (const id of FLAT_RIDES) for (const slot of colourSlotsFor(id)) expect(slot.tag, `${id}.${slot.id}`).toBe(COLOUR_SLOT_TAG[slot.id as 'primary']);
    expect(() => colourSlotTag('petal-roundabout', 'rail')).toThrow(/no colour slot/);
    expect(() => colourSlotTag('confetti-tree', 'primary')).toThrow(/no colour slot/);
  });
});

describe('the step-2 slot tables', () => {
  const ids = (table: Readonly<Record<string, unknown>>): string[] => Object.keys(table);
  const summary = (id: string): string => colourSlotsFor(id).map((slot) => `${slot.id}:${slot.label}:${slot.defaultRgb.toString(16)}:${slot.defaultName}`).join(' ');

  it('exactly these definitions are colourable, by kind', () => {
    expect(ids(RIDE_COLOUR_SLOTS)).toEqual([...FLAT_RIDES]);
    expect(ids(COASTER_COLOUR_SLOTS)).toEqual(['comet-trail', 'star-chaser', 'skyline-serpent', 'whisker-mouse', 'timber-twister', 'thunder-launch', 'bat-wing', 'titan-hyper']);
    expect(ids(STALL_COLOUR_SLOTS)).toEqual(['picnic-pocket', 'fizz-foundry', 'glacier-scoop', 'lemon-light', 'waffle-windmill', 'snack-sprint', 'cactus-cooler', 'cocoa-chalet', 'comfort-cabin', 'comfort-pavilion', 'pretzel-pram', 'coconut-cove',
      // Phase 29 souvenir stalls and the warm drink barrow.
      'brolly-booth', 'hat-hutch', 'balloon-bouquet', 'plushie-parlour', 'glow-cart', 'bean-barrow']);
    expect(ids(COMFORT_COLOUR_SLOTS)).toEqual(['ribbon-bench', 'tidy-totem']);
    expect(ids(SCENERY_COLOUR_SLOTS)).toEqual([
      'lollipop-lamp', 'sunburst-flowers', 'ripple-fountain',
      // Phase 16 themed scenery.
      'bunting-mast', 'shell-planter', 'harbor-lighthouse', 'tiki-torch', 'jungle-idol', 'neon-pylon', 'orbit-globe',
    ]);
    expect(ids(ENTRANCE_COLOUR_SLOTS)).toEqual([ENTRANCE_COLOUR_ID]);
    expect([...COLOURABLE_DEFINITION_IDS].sort()).toEqual(BUILD_CATALOG.filter((d) => d.kind !== 'path' && d.id !== 'confetti-tree' && d.id !== 'lantern-maple').map((d) => d.id).sort());
    expect(COLOURABLE_DEFINITION_IDS).not.toContain(ENTRANCE_COLOUR_ID);
    expect(Object.keys(COLOUR_SLOTS)).toHaveLength(COLOURABLE_DEFINITION_IDS.length + 1);
    for (const definition of BUILD_CATALOG) {
      expect(isColourable(definition.id), definition.id).toBe(definition.kind !== 'path' && definition.id !== 'confetti-tree' && definition.id !== 'lantern-maple');
    }
    expect(isColourable(ENTRANCE_COLOUR_ID)).toBe(true);
  });

  it('colourKindOf', () => {
    expect(colourKindOf('petal-roundabout')).toBe('ride');
    expect(colourKindOf('star-chaser')).toBe('coaster');
    expect(colourKindOf('picnic-pocket')).toBe('stall');
    expect(colourKindOf('comfort-pavilion')).toBe('stall');
    expect(colourKindOf('ribbon-bench')).toBe('comfort');
    expect(colourKindOf('ripple-fountain')).toBe('scenery');
    expect(colourKindOf(ENTRANCE_COLOUR_ID)).toBe('gate');
    for (const id of ['confetti-tree', 'sunstone-path', 'nope', 'constructor', '__proto__', 'toString']) expect(colourKindOf(id), id).toBeNull();
  });

  it('every slot list uses the shared vocabulary, starts with primary, and fits the label column', () => {
    for (const [id, slots] of Object.entries(COLOUR_SLOTS)) {
      expect(slots[0].id, id).toBe('primary');
      expect(new Set(slots.map((slot) => slot.id)).size, `${id} ids are unique`).toBe(slots.length);
      for (const slot of slots) {
        expect(COLOUR_SLOT_IDS, `${id}.${slot.id}`).toContain(slot.id);
        expect(slot.label.length, `${id}.${slot.id}`).toBeGreaterThan(0);
        expect(slot.label.length, `${id}.${slot.id} label fits`).toBeLessThanOrEqual(8);
        expect(slot.description.length, `${id}.${slot.id}`).toBeGreaterThan(5);
        expect(Object.isFrozen(slot)).toBe(true);
      }
      // One-slot objects: the fountain (its water and spray are fixed) and the Phase 16 tiki torch (its accent tongues are flame).
      const oneSlot = id === 'ripple-fountain' || id === 'tiki-torch';
      if (!oneSlot) expect(slots.length, `${id} has a secondary`).toBeGreaterThanOrEqual(2);
      if (!oneSlot) expect(slots[1].id, id).toBe('secondary');
      expect(Object.isFrozen(slots)).toBe(true);
    }
  });

  it('coasters: train, seats, rails and supports, defaulting to each type\'s shipped palette', () => {
    const catalog = (id: string) => BUILD_BY_ID.get(id)!;
    for (const id of ids(COASTER_COLOUR_SLOTS)) {
      const slots = colourSlotsFor(id);
      expect(slots.map((slot) => [slot.id, slot.label])).toEqual([['primary', 'Train'], ['secondary', 'Seats'], ['rail', 'Rails'], ['support', 'Supports']]);
      expect(slots[0].defaultRgb, `${id} train is the catalog colour`).toBe(catalog(id).color);
      expect(slots[1].defaultRgb, `${id} seats are the catalog accent`).toBe(catalog(id).accent);
      expect(slots[2].defaultRgb, `${id} rails are the accent`).toBe(catalog(id).accent);
    }
    expect(summary('comet-trail')).toBe('primary:Train:e4572e:Flame secondary:Seats:ffd166:Sunflower rail:Rails:ffd166:Sunflower support:Supports:79543a:Timber');
    expect(summary('star-chaser')).toBe('primary:Train:7048c9:Amethyst secondary:Seats:61e7d3:Mint rail:Rails:61e7d3:Mint support:Supports:2c5b64:Steel');
    expect(summary('skyline-serpent')).toBe('primary:Train:1b7f79:Lagoon secondary:Seats:f5f06c:Lemon rail:Rails:f5f06c:Lemon support:Supports:4d7f86:Pale steel');
  });

  it('shops and facilities: walls and roof, defaulting to the catalog colour and accent', () => {
    for (const id of ids(STALL_COLOUR_SLOTS)) {
      const slots = colourSlotsFor(id);
      expect(slots.map((slot) => [slot.id, slot.label])).toEqual([['primary', 'Walls'], ['secondary', 'Roof']]);
      expect(slots[0].defaultRgb, id).toBe(BUILD_BY_ID.get(id)!.color);
      expect(slots[1].defaultRgb, id).toBe(BUILD_BY_ID.get(id)!.accent);
    }
    expect(colourSlotsFor('picnic-pocket').map((slot) => slot.defaultName)).toEqual(['Tangerine', 'Custard']);
    expect(colourSlotsFor('comfort-pavilion').map((slot) => slot.defaultName)).toEqual(['Eucalyptus', 'Seafoam']);
  });

  it('benches, bins, lamps, flowers and the fountain', () => {
    expect(summary('ribbon-bench')).toBe('primary:Seat:b96748:Terracotta secondary:Back:ffd166:Sunflower');
    expect(summary('tidy-totem')).toBe('primary:Body:48786b:Moss secondary:Lid:8ee3c5:Spearmint');
    expect(summary('lollipop-lamp')).toBe('primary:Post:335c67:Slate teal secondary:Cap:ffe66d:Lamp yellow');
    expect(summary('sunburst-flowers')).toBe('primary:Blooms:ffcf56:Saffron secondary:Petals:ff7ca3:Carnation');
    expect(summary('ripple-fountain')).toBe('primary:Basin:4ea8de:Fountain blue');
    expect(colourSlotsFor('confetti-tree')).toEqual([]);
  });

  it('Phase 16: the new rides, stalls and themed scenery default to their catalog colour and accent', () => {
    const phase16 = ['puddle-jumpers', 'rocket-pendulum', 'temple-trek', 'pretzel-pram', 'coconut-cove', 'bunting-mast', 'shell-planter', 'harbor-lighthouse', 'tiki-torch', 'jungle-idol', 'neon-pylon', 'orbit-globe'];
    for (const id of phase16) {
      const definition = BUILD_BY_ID.get(id)!;
      const slots = colourSlotsFor(id);
      expect(slots[0].defaultRgb, `${id} primary`).toBe(definition.color);
      if (slots.length > 1) expect(slots[1].defaultRgb, `${id} secondary`).toBe(definition.accent);
    }
    expect(summary('puddle-jumpers')).toBe('primary:Main:52b788:Lily pad secondary:Accent:ffcf56:Saffron');
    expect(summary('tiki-torch')).toBe('primary:Bindings:e4572e:Flame');
    expect(summary('orbit-globe')).toBe('primary:Globe:8f7cf7:Lavender secondary:Orbits:61e7d3:Mint');
  });

  it('the entrance gate: arch, sign and posts under the pseudo id', () => {
    expect(summary(ENTRANCE_COLOUR_ID)).toBe('primary:Arch:ff6f91:Flamingo secondary:Sign:ffd166:Sunflower trim:Posts:254f4a:Pine');
    expect(BUILD_BY_ID.has(ENTRANCE_COLOUR_ID)).toBe(false);
    expect(validateObjectColours(ENTRANCE_COLOUR_ID, [19, null, 13])).toEqual([19, null, 13]);
    expect(validateObjectColours(ENTRANCE_COLOUR_ID, [19, null])).toBe('invalid');
  });

  it('isSlotDefaultSwatch works for the new kinds (the Skyline Serpent\'s Lagoon train, a flat ride\'s Cherry)', () => {
    expect(isSlotDefaultSwatch('skyline-serpent', 0, 20)).toBe(true);
    expect(isSlotDefaultSwatch('star-chaser', 2, 17), 'Mint rails').toBe(true);
    expect(isSlotDefaultSwatch('star-chaser', 2, 18)).toBe(false);
    expect(isSlotDefaultSwatch(ENTRANCE_COLOUR_ID, 0, 7)).toBe(false);
    expect(isSlotDefaultSwatch('confetti-tree', 0, 7)).toBe(false);
  });
});

describe('validateObjectColours (strict, for the world API)', () => {
  it('accepts exactly one entry per slot, each null or a swatch index', () => {
    expect(validateObjectColours('comet-cups', [19, null])).toEqual([19, null]);
    expect(validateObjectColours('aurora-wheel', [0, 20, 7])).toEqual([0, 20, 7]);
    expect(validateObjectColours('comet-cups', [null, null]), 'all default is no record').toBeNull();
    expect(Object.isFrozen(validateObjectColours('comet-cups', [1, 2]))).toBe(true);
  });

  it('refuses everything else', () => {
    const bad: unknown[] = [
      [1], [1, 2, 3], [], 'ab', null, undefined, 5, {}, { 0: 1, 1: 2, length: 2 },
      [-1, null], [21, null], [1.5, null], [Number.NaN, null], [Number.POSITIVE_INFINITY, null], [1e300, null],
      ['1', null], [true, null], [undefined, null], [[1], null], [{}, null],
    ];
    for (const value of bad) expect(validateObjectColours('comet-cups', value), JSON.stringify(value)).toBe('invalid');
    expect(validateObjectColours('picnic-pocket', [])).toBe('invalid');
    expect(validateObjectColours('comet-trail', [1, 2])).toBe('invalid');
    expect(validateObjectColours('confetti-tree', [1, 2])).toBe('invalid');
    expect(validateObjectColours('nope', [1, 2])).toBe('invalid');
  });
});

describe('normaliseObjectColours (lenient, for restore)', () => {
  it('keeps valid entries, pads and truncates, and turns anything invalid into the default', () => {
    expect(normaliseObjectColours('comet-cups', [19, null])).toEqual([19, null]);
    expect(normaliseObjectColours('comet-cups', [19])).toEqual([19, null]);
    expect(normaliseObjectColours('comet-cups', [null, 3, 9, 9, 9])).toEqual([null, 3]);
    expect(normaliseObjectColours('aurora-wheel', [1, null])).toEqual([1, null, null]);
    expect(normaliseObjectColours('comet-cups', [-1, 21])).toBeNull();
    expect(normaliseObjectColours('comet-cups', [1.5, '2'])).toBeNull();
    expect(normaliseObjectColours('comet-cups', [1e300, 4])).toEqual([null, 4]);
    expect(normaliseObjectColours('comet-cups', [true, {}])).toBeNull();
    expect(normaliseObjectColours('comet-cups', [[1], [2]])).toBeNull();
    expect(normaliseObjectColours('comet-cups', [null, null])).toBeNull();
    expect(normaliseObjectColours('comet-cups', [])).toBeNull();
  });

  it('pads and truncates to the step-2 slot counts, and keeps the gate record', () => {
    expect(normaliseObjectColours('comet-trail', [1, 2, 3])).toEqual([1, 2, 3, null]);
    expect(normaliseObjectColours('star-chaser', [null, null, null, 4, 9, 9])).toEqual([null, null, null, 4]);
    expect(normaliseObjectColours('picnic-pocket', [1, 2, 3])).toEqual([1, 2]);
    expect(normaliseObjectColours('ripple-fountain', [5, 6])).toEqual([5]);
    expect(normaliseObjectColours(ENTRANCE_COLOUR_ID, [4, 'x', 99])).toEqual([4, null, null]);
    expect(normaliseObjectColours(ENTRANCE_COLOUR_ID, [null, null, null])).toBeNull();
    expect(normaliseObjectColours(ENTRANCE_COLOUR_ID, 'ab')).toBeNull();
  });

  it('drops a record that is not an array, or that sits on something that is not colourable', () => {
    for (const raw of [undefined, null, 'ab', 5, true, {}, { 0: 1, length: 2 }]) {
      expect(normaliseObjectColours('comet-cups', raw), JSON.stringify(raw)).toBeNull();
    }
    expect(normaliseObjectColours('confetti-tree', [1, 2])).toBeNull();
    expect(normaliseObjectColours('sunstone-path', [1, 2])).toBeNull();
    expect(normaliseObjectColours('unknown-id', [1, 2])).toBeNull();
  });

  it('returns a frozen record and never aliases the input', () => {
    const raw = [3, 4];
    const record = normaliseObjectColours('comet-cups', raw)!;
    expect(Object.isFrozen(record)).toBe(true);
    raw[0] = 9;
    expect(record).toEqual([3, 4]);
  });

  it('sparse arrays and very long arrays are handled', () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(normaliseObjectColours('comet-cups', [, 4])).toEqual([null, 4]);
    expect(normaliseObjectColours('comet-cups', new Array<number>(100_000).fill(1))).toEqual([1, 1]);
  });
});

describe('sameObjectColours', () => {
  it('treats null and undefined as defaults and compares by value', () => {
    expect(sameObjectColours(null, undefined)).toBe(true);
    expect(sameObjectColours([1, null], [1, null])).toBe(true);
    expect(sameObjectColours([1, null], null)).toBe(false);
    expect(sameObjectColours([1, null], [1, 2])).toBe(false);
    expect(sameObjectColours([1], [1, null])).toBe(false);
  });
});
