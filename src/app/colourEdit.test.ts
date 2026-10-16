import { describe, expect, it } from 'vitest';
import { validateObjectColours } from '../game/content/colours';
import { withSlotColour } from './colourEdit';

describe('withSlotColour', () => {
  it('sets one slot and keeps the others', () => {
    expect(withSlotColour('aurora-wheel', null, 1, 7)).toEqual([null, 7, null]);
    expect(withSlotColour('aurora-wheel', Object.freeze([3, null, 9]), 1, 7)).toEqual([3, 7, 9]);
    expect(withSlotColour('aurora-wheel', Object.freeze([3, 5, 9]), 0, null)).toEqual([null, 5, 9]);
  });

  it('never aliases or mutates the current record', () => {
    const current = Object.freeze([3, null]);
    const next = withSlotColour('petal-roundabout', current, 1, 4)!;
    expect(next).not.toBe(current);
    expect(current).toEqual([3, null]);
  });

  it('stores the swatch that IS the slot default as the default (null), so the Default chip\'s swatch changes nothing', () => {
    // Petal roundabout: Main defaults to Rose (7). Aurora wheel: Trim defaults to Cream (6).
    expect(withSlotColour('petal-roundabout', null, 0, 7)).toEqual([null, null]);
    expect(withSlotColour('petal-roundabout', Object.freeze([0, 3]), 0, 7)).toEqual([null, 3]);
    expect(withSlotColour('aurora-wheel', null, 2, 6)).toEqual([null, null, null]);
    expect(withSlotColour('aurora-wheel', null, 0, 6), 'Cream is not the Main default there').toEqual([6, null, null]);
    expect(validateObjectColours('petal-roundabout', withSlotColour('petal-roundabout', null, 0, 7)), 'which the world stores as no record').toBeNull();
  });

  it('pads a record from an older, shorter slot list', () => {
    expect(withSlotColour('aurora-wheel', Object.freeze([3]), 2, 5)).toEqual([3, null, 5]);
  });

  it('refuses what the world would refuse', () => {
    for (const [slot, swatch] of [[3, 1], [-1, 1], [0.5, 1], [Number.NaN, 1], [0, 21], [0, -1], [0, 1.5], [0, Number.NaN], [0, Infinity]] as Array<[number, number]>) {
      expect(withSlotColour('aurora-wheel', null, slot, swatch), `${slot},${swatch}`).toBeNull();
    }
    expect(withSlotColour('confetti-tree', null, 0, 1), 'not colourable').toBeNull();
    expect(withSlotColour('sunstone-path', null, 0, 1), 'not colourable').toBeNull();
    expect(withSlotColour('nope', null, 0, 1)).toBeNull();
  });

  it('only ever produces records the world validator accepts', () => {
    for (const id of ['petal-roundabout', 'aurora-wheel', 'thunder-drum']) {
      for (let slot = 0; slot < 2; slot += 1) for (let swatch = -1; swatch <= 20; swatch += 7) {
        const next = withSlotColour(id, null, slot, swatch < 0 ? null : swatch);
        expect(validateObjectColours(id, next), `${id} ${slot} ${swatch}`).not.toBe('invalid');
      }
    }
  });
});
