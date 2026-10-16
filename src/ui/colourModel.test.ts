import { describe, expect, it } from 'vitest';
import {
  COLOURABLE_DEFINITION_IDS,
  COLOUR_SWATCHES,
  RIDE_COLOUR_SLOTS,
  SWATCH_ROWS,
  colourSlotsFor,
} from '../game/content/colours';
import { contrastRatio, rovingTarget } from './a11yModel';
import { colourSection, hexOf, SWATCH_COLUMNS } from './colourModel';

const RIDES = Object.keys(RIDE_COLOUR_SLOTS);
/** Phase 28 step 2: every colourable catalog id gets the section (rides, coasters, stalls, comforts and scenery); the gate has no inspector. */
const COLOURABLE = [...COLOURABLE_DEFINITION_IDS];

describe('colourSection model', () => {
  it('exists for every colourable ride and for nothing else', () => {
    for (const id of RIDES) expect(colourSection(id, null), id).not.toBeNull();
    for (const id of ['sunstone-path', 'confetti-tree', 'nope', '']) {
      expect(colourSection(id, null), id).toBeNull();
    }
  });

  it('has one row per slot, in slot order, labelled and described from the slot data', () => {
    for (const id of RIDES) {
      const model = colourSection(id, null)!;
      const slots = colourSlotsFor(id);
      expect(model.rows.map((row) => row.id)).toEqual(slots.map((slot) => slot.id));
      expect(model.rows.map((row) => row.slotIndex)).toEqual(slots.map((_slot, index) => index));
      for (const [index, row] of model.rows.entries()) {
        expect(row.label).toBe(slots[index].label);
        expect(row.description).toBe(slots[index].description);
        expect(row.groupLabel).toBe(`${slots[index].label} colour`);
        expect(row.label.length, 'fits the 62 px label column').toBeLessThanOrEqual(8);
      }
    }
  });

  it('offers every swatch once per slot, in catalog order, grouped as seven per themed row', () => {
    const model = colourSection('aurora-wheel', null)!;
    for (const row of model.rows) {
      expect(row.swatches.map((swatch) => swatch.index)).toEqual(COLOUR_SWATCHES.map((swatch) => swatch.index));
      expect(row.swatches.map((swatch) => swatch.label), 'each is labelled by its name only').toEqual(COLOUR_SWATCHES.map((swatch) => swatch.name));
    }
    expect(SWATCH_COLUMNS).toBe(7);
    expect(SWATCH_ROWS.every((row) => row.swatches.length === SWATCH_COLUMNS), 'a grid row is a themed row').toBe(true);
    const first = colourSection('petal-roundabout', null)!.rows[0].swatches;
    expect(first.slice(0, 7).every((swatch) => swatch.rowLabel === 'Sunny')).toBe(true);
    expect(first.slice(7, 14).every((swatch) => swatch.rowLabel === 'Berry')).toBe(true);
    expect(first.slice(14).every((swatch) => swatch.rowLabel === 'Sea')).toBe(true);
  });

  it('shows defaults when there is no record, naming the default colour', () => {
    const model = colourSection('petal-roundabout', null)!;
    expect(model.customised).toBe(false);
    expect(model.title).toBe('Default colours');
    expect(model.resetLabel).toBe('Colours are at their defaults');
    for (const row of model.rows) {
      expect(row.isDefault).toBe(true);
      expect(row.swatches.some((swatch) => swatch.selected)).toBe(false);
      expect(row.initialStop).toBe(0);
    }
    expect(model.rows[0]).toMatchObject({ currentName: 'Default (Rose)', currentHex: '#ef6f8f', defaultHex: '#ef6f8f', defaultName: 'Rose' });
    expect(model.rows[1]).toMatchObject({ currentName: 'Default (Sunflower)', defaultChipLabel: 'Accent: default, Sunflower' });
  });

  it('the Default chip always names the default, and names a swatch only when that swatch is exactly the default', () => {
    const swatchByName = new Map(COLOUR_SWATCHES.map((swatch) => [swatch.name, swatch]));
    for (const id of RIDES) {
      const model = colourSection(id, null)!;
      for (const row of model.rows) {
        const slot = colourSlotsFor(id)[row.slotIndex];
        expect(row.defaultName.length, `${id} ${slot.id}`).toBeGreaterThan(0);
        expect(row.defaultHex).toBe(hexOf(slot.defaultRgb));
        const named = swatchByName.get(row.defaultName);
        if (named) expect(named.rgb, `${id} ${slot.id}: the chip names ${named.name}, which must be the default itself`).toBe(slot.defaultRgb);
      }
    }
    // A default that no swatch offers any more (the catalog Sunflower was retuned to Buttercup) keeps its own name.
    expect(colourSection('petal-roundabout', null)!.rows[1].defaultName).toBe('Sunflower');
    expect(swatchByName.has('Sunflower')).toBe(false);
  });

  it('marks exactly the chosen swatch of exactly the chosen slot, and makes it the tab stop', () => {
    const model = colourSection('moonpetal-carousel', Object.freeze([19, null, 4]))!;
    expect(model.customised).toBe(true);
    expect(model.title).toBe('Custom colours');
    expect(model.resetLabel).toBe('Reset to default colours');
    expect(model.rows[0].swatches.filter((swatch) => swatch.selected).map((swatch) => swatch.name)).toEqual(['Teal']);
    expect(model.rows[1].swatches.some((swatch) => swatch.selected)).toBe(false);
    expect(model.rows[1].isDefault).toBe(true);
    expect(model.rows[2].swatches.filter((swatch) => swatch.selected).map((swatch) => swatch.name)).toEqual(['Buttercup']);
    expect(model.rows.map((row) => row.initialStop)).toEqual([19, 0, 4]);
    expect(model.rows[0]).toMatchObject({ currentName: 'Teal', currentHex: '#3aa7a3', isDefault: false });
    expect(model.dots.map((dot) => dot.hex)).toEqual(['#3aa7a3', '#fff0c8', '#ffea2b']);
    expect(model.summary).toBe('Colours: Main Teal; Accent default, Cream; Trim Buttercup.');
  });

  it('reads a hostile or legacy record like restore: a bad entry is the slot default', () => {
    const odd = [
      [Number.NaN, 3], [-1, 3], [99, 3], [1.5, 3], ['x', 3], [undefined, 3], [null, 3],
    ] as unknown as readonly (number | null)[][];
    for (const record of odd) {
      const model = colourSection('comet-cups', record as never)!;
      expect(model.rows[0].isDefault, JSON.stringify(record)).toBe(true);
      expect(model.rows[1].swatches.find((swatch) => swatch.selected)?.index).toBe(3);
    }
    expect(colourSection('comet-cups', Object.freeze([2]) as never)!.rows[0].swatches[2].selected, 'a short record').toBe(true);
    expect(colourSection('comet-cups', Object.freeze([2, 3, 4, 5]) as never)!.rows.length, 'a long one').toBe(2);
    expect(colourSection('comet-cups', Object.freeze([null, null]))!.customised).toBe(false);
  });

  it('the check mark always has at least 3:1 against its swatch, so selection is never colour alone', () => {
    const model = colourSection('petal-roundabout', null)!;
    for (const swatch of model.rows[0].swatches) {
      const against = swatch.checkTone === 'light' ? '#ffffff' : '#1d2b27';
      expect(contrastRatio(swatch.hex, against), `${swatch.name} ${swatch.checkTone}`).toBeGreaterThanOrEqual(3);
    }
    const tones = new Set(model.rows[0].swatches.map((swatch) => swatch.checkTone));
    expect(tones.size, 'both tones are used: pale swatches get a dark mark').toBe(2);
  });

  it('gives the toggle a spoken summary of every slot, defaults named', () => {
    const model = colourSection('petal-roundabout', Object.freeze([7, null]))!;
    expect(model.toggleSummary).toBe('Main Rose, Accent Default (Sunflower)');
  });

  it('is deterministic and does not touch the record it is given', () => {
    const record = Object.freeze([5, null]);
    expect(colourSection('petal-roundabout', record)).toEqual(colourSection('petal-roundabout', record));
    expect(record).toEqual([5, null]);
  });
});

describe('swatch grid keyboard (the roving rules the component applies)', () => {
  const count = COLOUR_SWATCHES.length;
  const grid = { orientation: 'both', columns: SWATCH_COLUMNS, wrap: false } as const;

  it('moves by one with Left and Right and by a themed row with Up and Down, without wrapping', () => {
    expect(rovingTarget('ArrowRight', 3, count, grid)).toBe(4);
    expect(rovingTarget('ArrowLeft', 3, count, grid)).toBe(2);
    expect(rovingTarget('ArrowDown', 3, count, grid)).toBe(10);
    expect(rovingTarget('ArrowUp', 10, count, grid)).toBe(3);
    expect(rovingTarget('ArrowUp', 3, count, grid), 'top row stays').toBe(3);
    expect(rovingTarget('ArrowDown', 17, count, grid), 'bottom row stays').toBe(17);
    expect(rovingTarget('ArrowRight', count - 1, count, grid)).toBe(count - 1);
    expect(rovingTarget('ArrowLeft', 0, count, grid)).toBe(0);
  });

  it('Home and End reach the ends and unrelated keys are left to the browser', () => {
    expect(rovingTarget('Home', 9, count, grid)).toBe(0);
    expect(rovingTarget('End', 9, count, grid)).toBe(count - 1);
    for (const key of ['Enter', ' ', 'Tab', 'a', 'Escape']) expect(rovingTarget(key, 9, count, grid), key).toBeNull();
  });

  it('walking Down from any swatch visits the same column of each themed row', () => {
    for (let start = 0; start < SWATCH_COLUMNS; start += 1) {
      const path = [start];
      for (let step = 0; step < 2; step += 1) path.push(rovingTarget('ArrowDown', path[path.length - 1], count, grid)!);
      expect(path.map((index) => COLOUR_SWATCHES[index].row)).toEqual([0, 1, 2]);
    }
  });
});

describe('colourSection model for the step-2 kinds', () => {
  it('exists for every colourable catalog id, with labels that fit the 62 px column, and for nothing else', () => {
    expect(COLOURABLE.length, "29 before Phase 16, plus its 12 entries and Phase 29's 6 stalls").toBe(47);
    for (const id of COLOURABLE) {
      const model = colourSection(id, null);
      expect(model, id).not.toBeNull();
      for (const row of model!.rows) expect(row.label.length, `${id}/${row.id}`).toBeLessThanOrEqual(8);
    }
    for (const id of ['confetti-tree', 'sunstone-path', 'nope', '']) expect(colourSection(id, null), id).toBeNull();
  });

  it('a coaster has four rows: Train, Seats, Rails and Supports, with the preset roles as ids', () => {
    for (const id of ['comet-trail', 'star-chaser', 'skyline-serpent']) {
      const model = colourSection(id, null)!;
      expect(model.rows.map((row) => row.label)).toEqual(['Train', 'Seats', 'Rails', 'Supports']);
      expect(model.rows.map((row) => row.id)).toEqual(['primary', 'secondary', 'rail', 'support']);
    }
  });

  it('a stall or facility has Walls and Roof; a fountain has the one Basin row', () => {
    for (const id of ['picnic-pocket', 'fizz-foundry', 'glacier-scoop', 'lemon-light', 'waffle-windmill', 'snack-sprint', 'comfort-cabin', 'comfort-pavilion']) {
      expect(colourSection(id, null)!.rows.map((row) => row.label), id).toEqual(['Walls', 'Roof']);
    }
    expect(colourSection('ripple-fountain', null)!.rows.map((row) => row.label)).toEqual(['Basin']);
  });

  it('a coaster record shows its colours per slot and a Default chip named for the shipped colour', () => {
    const model = colourSection('star-chaser', [19, null, 4, null])!;
    expect(model.rows.map((row) => row.currentName)).toEqual(['Teal', 'Default (Mint)', 'Buttercup', 'Default (Steel)']);
    expect(model.rows[3].defaultChipLabel).toBe('Supports: default, Steel');
    expect(model.customised).toBe(true);
    expect(model.toggleSummary).toBe('Train Teal, Seats Default (Mint), Rails Buttercup, Supports Default (Steel)');
  });
});
