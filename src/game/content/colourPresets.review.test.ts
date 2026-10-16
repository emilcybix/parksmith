import { describe, expect, it } from 'vitest';
import { recolourCharge } from './colourCost';
import { COLOUR_PRESETS, paintIsNoOp, paintRecord, placementRecord, presetRecord, rolesOfRecord } from './colourPresets';
import { COLOURABLE_DEFINITION_IDS, ENTRANCE_COLOUR_ID, colourSlotsFor } from './colours';

/**
 * Phase 28 step 2, adversarial review of the pure Paint model and the cost plumbing. `it.fails` marks a confirmed
 * finding (asserts the spec, fails today).
 */

const ALL_IDS = [...COLOURABLE_DEFINITION_IDS, ENTRANCE_COLOUR_ID];

describe('review: a preset id that no longer exists', () => {
  it('the whole-park path treats it as nothing (World.applyPresetToPark), and presetRecord gives no record', () => {
    expect(presetRecord('picnic-pocket', 'retired' as never)).toBeNull();
  });

  it.fails('FINDING: a paint brush holding it is a no-op (skip), not "reset to defaults" (today paintRecord returns null = defaults)', () => {
    for (const id of ALL_IDS) {
      const current = Object.freeze(colourSlotsFor(id).map(() => 19));
      expect(paintRecord(id, current, { kind: 'preset', presetId: 'retired' as never }, 'primary'), id).toBe('skip');
      expect(paintIsNoOp(id, current, { kind: 'preset', presetId: 'retired' as never }, 'primary'), id).toBe(true);
    }
  });
});

describe('review: the eyedropper and placement never invent colours', () => {
  it('a non-colourable definition copies no roles and places with no record, whatever the brush', () => {
    for (const id of ['confetti-tree', 'sunstone-path', 'no-such-thing']) {
      expect(rolesOfRecord(id, null)).toEqual({});
      expect(rolesOfRecord(id, Object.freeze([1, 2, 3]))).toEqual({});
      for (const brush of [{ kind: 'swatch', swatch: 19 }, { kind: 'preset', presetId: 'berry' }, { kind: 'copied', sourceName: 'X', roles: { primary: 1 } }] as const) {
        expect(placementRecord(id, brush as never), `${id} ${brush.kind}`).toBeNull();
        expect(paintRecord(id, null, brush as never, 'all'), `${id} ${brush.kind}`).toBe('skip');
      }
    }
  });

  it('copy then paste onto the same definition reproduces exactly what the object shows, for every kind and preset', () => {
    for (const id of ALL_IDS) {
      for (const preset of COLOUR_PRESETS) {
        const record = presetRecord(id, preset.id);
        const pasted = paintRecord(id, null, { kind: 'copied', sourceName: 'X', roles: rolesOfRecord(id, record) }, 'primary');
        expect(pasted, `${id} ${preset.id}`).toEqual(record);
      }
    }
  });

  it('a hostile brush (out-of-range or fractional swatch) never writes an invalid index', () => {
    for (const id of ALL_IDS) {
      for (const swatch of [-1, 21, 1.5, Number.NaN, 2 ** 40]) {
        const result = paintRecord(id, null, { kind: 'swatch', swatch }, 'all');
        expect(result === null || result === 'skip', `${id} ${swatch}`).toBe(true);
        const copied = paintRecord(id, null, { kind: 'copied', sourceName: 'X', roles: { primary: swatch, secondary: swatch, trim: swatch, rail: swatch, support: swatch } }, 'all');
        expect(copied === null || copied === 'skip', `${id} copied ${swatch}`).toBe(true);
      }
    }
  });
});

describe('review: recolourCharge composes and clamps', () => {
  const PRICED = { scenario: 10, map: 10 } as const;
  it('charges exactly perObject x multiplier (rounded per object) x changed objects, and never in the Sandbox', () => {
    expect(recolourCharge('scenario', 3, 1.5, PRICED)).toBe(45);
    expect(recolourCharge('map', 3, 0.25, PRICED)).toBe(9);
    expect(recolourCharge('sandbox', 3, 4, PRICED)).toBe(0);
  });

  it('a compiled multiplier can never be 0 (clamped to 0.25), so a zero reaching recolourCharge is hostile data and reads as 1 (documented)', () => {
    expect(recolourCharge('scenario', 1, 0, PRICED)).toBe(10);
  });
});
