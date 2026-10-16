import { describe, expect, it } from 'vitest';
import { BUILD_CATALOG } from './catalog';
import {
  COLOURABLE_DEFINITION_IDS,
  COLOUR_SLOT_IDS,
  COLOUR_SWATCHES,
  ENTRANCE_COLOUR_ID,
  SWATCH_COUNT,
  colourSlotsFor,
  isSlotDefaultSwatch,
  sameObjectColours,
  type ObjectColours,
} from './colours';
import {
  COLOUR_PRESETS,
  COLOUR_PRESET_BY_ID,
  brushPrimaryRgb,
  paintIsNoOp,
  paintRecord,
  paintTargetFor,
  placementRecord,
  presetDots,
  presetRecord,
  rolesOfRecord,
  sameBrush,
  type ColourPresetId,
  type PaintBrush,
  type PaintTarget,
} from './colourPresets';

const SWATCH: (index: number) => PaintBrush = (swatch) => ({ kind: 'swatch', swatch });
const DEFAULT: PaintBrush = { kind: 'default' };
const everyId = [...COLOURABLE_DEFINITION_IDS, ENTRANCE_COLOUR_ID];

describe('presets are pinned data', () => {
  it('six presets in panel order, each a role map over swatch indices', () => {
    expect(COLOUR_PRESETS.map((preset) => [preset.id, preset.name])).toEqual([
      ['candy', 'Candy'], ['seaside', 'Seaside'], ['midnight', 'Midnight'], ['autumn', 'Autumn'], ['meadow', 'Meadow'], ['berry', 'Berry'],
    ]);
    const row = (id: ColourPresetId) => COLOUR_SLOT_IDS.map((role) => COLOUR_PRESET_BY_ID.get(id)!.roles[role]);
    expect(row('candy')).toEqual([null, null, null, null, null]);
    expect(row('seaside')).toEqual([16, 6, 17, 14, 20]);
    expect(row('midnight')).toEqual([12, 4, 11, 5, 13]);
    expect(row('autumn')).toEqual([0, 3, 2, 1, 13]);
    expect(row('meadow')).toEqual([18, 8, 5, 6, 19]);
    expect(row('berry')).toEqual([7, 6, 9, 8, 11]);
    expect(COLOUR_PRESET_BY_ID.size).toBe(COLOUR_PRESETS.length);
  });

  it('ids and names are unique, texts are present, everything is frozen', () => {
    expect(new Set(COLOUR_PRESETS.map((preset) => preset.id)).size).toBe(COLOUR_PRESETS.length);
    expect(new Set(COLOUR_PRESETS.map((preset) => preset.name)).size).toBe(COLOUR_PRESETS.length);
    for (const preset of COLOUR_PRESETS) {
      expect(preset.description.length, preset.id).toBeGreaterThan(5);
      expect(Object.isFrozen(preset), preset.id).toBe(true);
      expect(Object.isFrozen(preset.roles), preset.id).toBe(true);
      for (const role of Object.keys(preset.roles)) expect(COLOUR_SLOT_IDS, `${preset.id}.${role}`).toContain(role);
    }
    expect(Object.isFrozen(COLOUR_PRESETS)).toBe(true);
  });

  it('every set role is a valid swatch and the swatches of one preset are all different (an object shows several at once)', () => {
    for (const preset of COLOUR_PRESETS) {
      const chosen = Object.values(preset.roles).filter((value): value is number => value !== null && value !== undefined);
      for (const swatch of chosen) expect(Number.isInteger(swatch) && swatch >= 0 && swatch < SWATCH_COUNT, `${preset.id} ${swatch}`).toBe(true);
      expect(new Set(chosen).size, `${preset.id} uses distinct swatches`).toBe(chosen.length);
    }
  });

  it('Candy leaves every role on the default; every other preset sets all five roles', () => {
    expect(Object.values(COLOUR_PRESET_BY_ID.get('candy')!.roles).every((value) => value === null)).toBe(true);
    for (const preset of COLOUR_PRESETS.filter((entry) => entry.id !== 'candy')) {
      for (const role of COLOUR_SLOT_IDS) expect(typeof preset.roles[role], `${preset.id}.${role}`).toBe('number');
    }
  });

  it('presetDots: primary, secondary and trim (rail when there is none)', () => {
    expect(presetDots('candy')).toEqual([null, null, null]);
    expect(presetDots('seaside')).toEqual([16, 6, 17]);
    expect(presetDots('nope' as ColourPresetId)).toEqual([null, null, null]);
  });
});

describe('presetRecord', () => {
  it('Candy is every-default for every colourable definition and the gate (applying it is a reset)', () => {
    for (const id of everyId) expect(presetRecord(id, 'candy'), id).toBeNull();
  });

  it('maps roles to slots by id, one entry per slot of the definition', () => {
    expect(presetRecord('comet-cups', 'seaside')).toEqual([16, 6]);
    expect(presetRecord('aurora-wheel', 'seaside')).toEqual([16, 6, 17]);
    expect(presetRecord('star-chaser', 'seaside')).toEqual([16, 6, 14, 20]);
    expect(presetRecord('picnic-pocket', 'midnight')).toEqual([12, 4]);
    expect(presetRecord('ripple-fountain', 'autumn'), 'a one-slot object takes only its primary').toEqual([0]);
    expect(presetRecord(ENTRANCE_COLOUR_ID, 'berry')).toEqual([7, 6, 9]);
  });

  it('a role the definition does not have is ignored (rail on a stall), and the result is always aligned', () => {
    for (const preset of COLOUR_PRESETS) {
      for (const id of everyId) {
        const record = presetRecord(id, preset.id);
        if (record) expect(record.length, `${preset.id} ${id}`).toBe(colourSlotsFor(id).length);
      }
    }
  });

  it('a swatch equal to the slot default is stored as null (so applying a preset never stores a no-op swatch)', () => {
    // Seaside's secondary is Cream (6): the Moonpetal Carousel's secondary default is Cream.
    expect(isSlotDefaultSwatch('moonpetal-carousel', 1, 6)).toBe(true);
    expect(presetRecord('moonpetal-carousel', 'seaside')).toEqual([16, null, 17]);
    // The Skyline Serpent's train default is Lagoon (20): Seaside's support is Lagoon, its primary Azure.
    expect(presetRecord('skyline-serpent', 'seaside')).toEqual([16, 6, 14, 20]);
    expect(isSlotDefaultSwatch('skyline-serpent', 0, 20)).toBe(true);
    // A preset all of whose swatches equal a definition's defaults gives no record at all.
    for (const preset of COLOUR_PRESETS) {
      for (const id of everyId) {
        const record = presetRecord(id, preset.id);
        if (record) expect(record.some((entry) => entry !== null), `${preset.id} ${id}`).toBe(true);
        if (record) record.forEach((entry, index) => { if (entry !== null) expect(isSlotDefaultSwatch(id, index, entry), `${preset.id} ${id}[${index}]`).toBe(false); });
      }
    }
  });

  it('is not colourable, unknown or hostile: null', () => {
    for (const id of ['confetti-tree', 'sunstone-path', 'nope', 'constructor', '__proto__']) expect(presetRecord(id, 'seaside'), id).toBeNull();
    expect(presetRecord('comet-cups', 'nope' as ColourPresetId)).toBeNull();
  });

  it('every non-Candy preset recolours every colourable definition and the gate (a whole-park preset touches everything)', () => {
    for (const preset of COLOUR_PRESETS.filter((entry) => entry.id !== 'candy')) {
      for (const id of everyId) expect(presetRecord(id, preset.id), `${preset.id} ${id}`).not.toBeNull();
    }
  });

  it('returns frozen records', () => {
    expect(Object.isFrozen(presetRecord('star-chaser', 'meadow'))).toBe(true);
  });
});

describe('paintRecord: brush x target x kind', () => {
  it('a swatch brush on Main paints the primary slot only and keeps the rest', () => {
    expect(paintRecord('comet-cups', null, SWATCH(19), 'primary')).toEqual([19, null]);
    expect(paintRecord('comet-cups', [3, 4], SWATCH(19), 'primary')).toEqual([19, 4]);
    expect(paintRecord('star-chaser', [null, 2, 3, 4], SWATCH(19), 'primary')).toEqual([19, 2, 3, 4]);
  });

  it('Accent paints the secondary slot', () => {
    expect(paintRecord('comet-cups', [3, null], SWATCH(19), 'secondary')).toEqual([3, 19]);
    expect(paintRecord('picnic-pocket', null, SWATCH(19), 'secondary')).toEqual([null, 19]);
    expect(paintRecord('star-chaser', null, SWATCH(19), 'secondary')).toEqual([null, 19, null, null]);
  });

  it('All paints every slot, rails and supports included', () => {
    expect(paintRecord('aurora-wheel', null, SWATCH(19), 'all')).toEqual([19, 19, 19]);
    expect(paintRecord('star-chaser', null, SWATCH(19), 'all')).toEqual([19, 19, 19, 19]);
    expect(paintRecord(ENTRANCE_COLOUR_ID, [1, null, 2], SWATCH(19), 'all')).toEqual([19, 19, 19]);
  });

  it('a swatch that is the slot default is stored as null (painting the default colour resets that slot)', () => {
    expect(paintRecord('petal-roundabout', [19, 19], SWATCH(7), 'primary')).toEqual([null, 19]);
    expect(paintRecord('petal-roundabout', [null, 19], SWATCH(7), 'primary'), 'Rose is the primary default: nothing left').toEqual([null, 19]);
    expect(paintRecord('petal-roundabout', [19, null], SWATCH(7), 'primary')).toBeNull();
    expect(paintRecord('skyline-serpent', null, SWATCH(20), 'primary'), 'Lagoon is the serpent train').toBeNull();
  });

  it('the Default brush resets the targeted slots', () => {
    expect(paintRecord('comet-cups', [3, 4], DEFAULT, 'primary')).toEqual([null, 4]);
    expect(paintRecord('comet-cups', [3, 4], DEFAULT, 'secondary')).toEqual([3, null]);
    expect(paintRecord('comet-cups', [3, 4], DEFAULT, 'all')).toBeNull();
    expect(paintRecord('comet-cups', null, DEFAULT, 'all')).toBeNull();
  });

  it('a preset brush replaces the whole record whatever the target', () => {
    const preset: PaintBrush = { kind: 'preset', presetId: 'seaside' };
    for (const target of ['primary', 'secondary', 'all'] as const) {
      expect(paintRecord('comet-cups', [3, 4], preset, target), target).toEqual([16, 6]);
    }
    expect(paintRecord('star-chaser', [1, 2, 3, 4], { kind: 'preset', presetId: 'candy' }, 'primary')).toBeNull();
  });

  it('a copied brush replaces the whole record from its roles; roles the target lacks are ignored, absent roles are default', () => {
    const copied: PaintBrush = { kind: 'copied', sourceName: 'Picnic Pocket', roles: { primary: 19, secondary: 6 } };
    expect(paintRecord('comet-cups', [3, 4], copied, 'primary')).toEqual([19, 6]);
    expect(paintRecord('star-chaser', [1, 2, 3, 4], copied, 'all'), 'rails and supports go to default').toEqual([19, 6, null, null]);
    expect(paintRecord('ripple-fountain', null, copied, 'all'), 'one slot').toEqual([19]);
    expect(paintRecord('comet-cups', [3, 4], { kind: 'copied', sourceName: 'x', roles: {} }, 'all')).toBeNull();
  });

  it('Accent on a one-slot object is skipped; trees, paths and unknown ids are skipped for every brush', () => {
    expect(paintRecord('ripple-fountain', null, SWATCH(19), 'secondary')).toBe('skip');
    expect(paintRecord('ripple-fountain', null, DEFAULT, 'secondary')).toBe('skip');
    expect(paintRecord('ripple-fountain', null, SWATCH(19), 'primary')).toEqual([19]);
    expect(paintRecord('ripple-fountain', null, SWATCH(19), 'all')).toEqual([19]);
    const brushes: PaintBrush[] = [DEFAULT, SWATCH(3), { kind: 'preset', presetId: 'berry' }, { kind: 'copied', sourceName: 'x', roles: { primary: 3 } }];
    for (const id of ['confetti-tree', 'sunstone-path', 'nope', 'constructor']) {
      for (const brush of brushes) for (const target of ['primary', 'secondary', 'all'] as const) {
        expect(paintRecord(id, null, brush, target), `${id} ${brush.kind} ${target}`).toBe('skip');
      }
    }
  });

  it('a no-op returns an equal record (never skip), and paintIsNoOp says so', () => {
    const current: ObjectColours = Object.freeze([19, null]);
    const result = paintRecord('comet-cups', current, SWATCH(19), 'primary');
    expect(result).not.toBe('skip');
    expect(sameObjectColours(current, result === 'skip' ? null : result)).toBe(true);
    expect(paintIsNoOp('comet-cups', current, SWATCH(19), 'primary')).toBe(true);
    expect(paintIsNoOp('comet-cups', current, SWATCH(4), 'primary')).toBe(false);
    expect(paintIsNoOp('comet-cups', null, DEFAULT, 'all')).toBe(true);
    expect(paintIsNoOp('confetti-tree', null, SWATCH(4), 'all'), 'a skipped object changes nothing').toBe(true);
    expect(paintIsNoOp('comet-cups', null, { kind: 'preset', presetId: 'candy' }, 'all')).toBe(true);
    expect(paintIsNoOp('comet-cups', null, { kind: 'preset', presetId: 'seaside' }, 'all')).toBe(false);
  });

  it('the matrix: every brush kind x target x colourable id gives an aligned, frozen, never-all-null record or null', () => {
    const brushes: PaintBrush[] = [DEFAULT, SWATCH(0), SWATCH(20), { kind: 'preset', presetId: 'midnight' }, { kind: 'copied', sourceName: 'x', roles: { primary: 1, rail: 2 } }];
    const targets: PaintTarget[] = ['primary', 'secondary', 'all'];
    for (const id of everyId) {
      for (const brush of brushes) for (const target of targets) {
        const current = presetRecord(id, 'autumn');
        const next = paintRecord(id, current, brush, target);
        if (next === 'skip') { expect(target, `${id} ${brush.kind}`).toBe('secondary'); expect(colourSlotsFor(id).some((slot) => slot.id === 'secondary')).toBe(false); continue; }
        if (next === null) continue;
        expect(next.length, `${id} ${brush.kind} ${target}`).toBe(colourSlotsFor(id).length);
        expect(Object.isFrozen(next)).toBe(true);
        expect(next.some((entry) => entry !== null)).toBe(true);
        for (const entry of next) expect(entry === null || (Number.isInteger(entry) && entry >= 0 && entry < SWATCH_COUNT)).toBe(true);
      }
    }
  });

  it('does not mutate the current record and does not alias it', () => {
    const current: ObjectColours = Object.freeze([3, 4]);
    const next = paintRecord('comet-cups', current, SWATCH(9), 'primary');
    expect(current).toEqual([3, 4]);
    expect(next).not.toBe(current);
  });

  it('hostile brush values are the default for that slot, not a crash', () => {
    expect(paintRecord('comet-cups', [3, 4], SWATCH(99), 'primary')).toEqual([null, 4]);
    expect(paintRecord('comet-cups', [3, 4], SWATCH(Number.NaN), 'primary')).toEqual([null, 4]);
    expect(paintRecord('comet-cups', [3, 4], { kind: 'copied', sourceName: 'x', roles: { primary: 99, secondary: -1 } }, 'all')).toBeNull();
  });
});

describe('Shift rule', () => {
  it('Shift widens the target to every slot; without it the target is kept', () => {
    expect(paintTargetFor('primary', true)).toBe('all');
    expect(paintTargetFor('secondary', true)).toBe('all');
    expect(paintTargetFor('all', true)).toBe('all');
    expect(paintTargetFor('primary', false)).toBe('primary');
    expect(paintTargetFor('secondary', false)).toBe('secondary');
  });

  it('Shift adds nothing for a preset or copied brush (already whole-object)', () => {
    const brushes: PaintBrush[] = [{ kind: 'preset', presetId: 'meadow' }, { kind: 'copied', sourceName: 'x', roles: { primary: 3, secondary: 5 } }];
    for (const brush of brushes) {
      for (const id of everyId) {
        expect(paintRecord(id, null, brush, paintTargetFor('primary', true)), `${id} ${brush.kind}`).toEqual(paintRecord(id, null, brush, 'primary'));
      }
    }
  });

  it('Shift-click on a swatch brush paints every slot of an object', () => {
    for (const id of everyId) {
      const slots = colourSlotsFor(id);
      const record = paintRecord(id, null, SWATCH(19), paintTargetFor('primary', true));
      expect(record, id).not.toBe('skip');
      if (record === 'skip' || record === null) continue;
      record.forEach((entry, index) => expect(entry, `${id}.${slots[index].id}`).toBe(isSlotDefaultSwatch(id, index, 19) ? null : 19));
    }
  });
});

describe('placementRecord (colour before placing)', () => {
  it('a swatch colours the primary slot only, default colours nothing, a preset gives its roles', () => {
    expect(placementRecord('comet-cups', SWATCH(19))).toEqual([19, null]);
    expect(placementRecord('star-chaser', SWATCH(19))).toEqual([19, null, null, null]);
    expect(placementRecord('picnic-pocket', DEFAULT)).toBeNull();
    expect(placementRecord('comet-cups', { kind: 'preset', presetId: 'seaside' })).toEqual([16, 6]);
    expect(placementRecord('star-chaser', { kind: 'preset', presetId: 'candy' })).toBeNull();
    expect(placementRecord('ripple-fountain', SWATCH(19))).toEqual([19]);
    expect(placementRecord('ribbon-bench', { kind: 'copied', sourceName: 'x', roles: { primary: 3, secondary: 4 } })).toEqual([3, 4]);
  });

  it('a definition that is not colourable gets nothing (a tree card with a Teal brush)', () => {
    expect(placementRecord('confetti-tree', SWATCH(19))).toBeNull();
    expect(placementRecord('sunstone-path', SWATCH(19))).toBeNull();
    expect(placementRecord('nope', { kind: 'preset', presetId: 'berry' })).toBeNull();
  });
});

describe('rolesOfRecord (the eyedropper)', () => {
  it('copies what each role shows: the chosen swatch, or the default when it is exactly a swatch, else null', () => {
    // Petal Roundabout: Rose (a swatch) and Sunflower (not a swatch).
    expect(rolesOfRecord('petal-roundabout', null)).toEqual({ primary: 7, secondary: null });
    expect(rolesOfRecord('petal-roundabout', [19, null])).toEqual({ primary: 19, secondary: null });
    expect(rolesOfRecord('petal-roundabout', [null, 3])).toEqual({ primary: 7, secondary: 3 });
    expect(rolesOfRecord('skyline-serpent', null)).toEqual({ primary: 20, secondary: null, rail: null, support: null });
    expect(rolesOfRecord('star-chaser', null)).toEqual({ primary: null, secondary: 17, rail: 17, support: null });
  });

  it('only the roles the definition has are present', () => {
    expect(Object.keys(rolesOfRecord('ripple-fountain', [4]))).toEqual(['primary']);
    expect(Object.keys(rolesOfRecord(ENTRANCE_COLOUR_ID, null))).toEqual(['primary', 'secondary', 'trim']);
    expect(rolesOfRecord('confetti-tree', [1, 2])).toEqual({});
  });

  it('round trip: pick then paint on the same definition reproduces the record', () => {
    const samples: [string, ObjectColours | null][] = [
      ['petal-roundabout', [19, null]], ['petal-roundabout', null], ['aurora-wheel', [null, 4, 13]],
      ['star-chaser', [3, null, 8, 12]], ['star-chaser', null], ['skyline-serpent', [null, null, 5, null]],
      ['picnic-pocket', [19, 6]], ['ripple-fountain', [9]], [ENTRANCE_COLOUR_ID, [2, null, 13]], ['ribbon-bench', null],
    ];
    for (const [id, record] of samples) {
      const brush: PaintBrush = { kind: 'copied', sourceName: id, roles: rolesOfRecord(id, record) };
      expect(paintRecord(id, [1, 1, 1, 1].slice(0, colourSlotsFor(id).length), brush, 'primary'), `${id} ${JSON.stringify(record)}`).toEqual(record);
    }
  });

  it('round trip over every swatch in every slot of every colourable id', () => {
    for (const id of everyId) {
      colourSlotsFor(id).forEach((_slot, index) => {
        for (const swatch of COLOUR_SWATCHES) {
          const record = paintRecord(id, null, SWATCH(swatch.index), 'all') as ObjectColours | null;
          const entries = (record ?? colourSlotsFor(id).map(() => null)) as (number | null)[];
          const only = entries.map((entry, i) => (i === index ? entry : null));
          const rec = only.every((entry) => entry === null) ? null : only;
          const brush: PaintBrush = { kind: 'copied', sourceName: id, roles: rolesOfRecord(id, rec) };
          expect(paintRecord(id, null, brush, 'all')).toEqual(rec);
        }
      });
    }
  });

  it('a copied brush paints the look of one object onto another kind', () => {
    // A Teal Picnic Pocket's colours onto a coaster: primary and secondary, rails and supports stay default.
    const brush: PaintBrush = { kind: 'copied', sourceName: 'Picnic Pocket', roles: rolesOfRecord('picnic-pocket', [19, null]) };
    expect(brush.kind === 'copied' && brush.roles).toEqual({ primary: 19, secondary: null });
    expect(paintRecord('comet-trail', null, brush, 'all')).toEqual([19, null, null, null]);
  });
});

describe('brushPrimaryRgb and sameBrush', () => {
  it('only a swatch brush has a tint (its classic colour)', () => {
    expect(brushPrimaryRgb(SWATCH(19))).toBe(COLOUR_SWATCHES[19].classicRgb);
    expect(brushPrimaryRgb(DEFAULT)).toBeNull();
    expect(brushPrimaryRgb({ kind: 'preset', presetId: 'seaside' })).toBeNull();
    expect(brushPrimaryRgb({ kind: 'copied', sourceName: 'x', roles: { primary: 3 } })).toBeNull();
    expect(brushPrimaryRgb(SWATCH(99))).toBeNull();
  });

  it('sameBrush compares by value', () => {
    expect(sameBrush(SWATCH(3), SWATCH(3))).toBe(true);
    expect(sameBrush(SWATCH(3), SWATCH(4))).toBe(false);
    expect(sameBrush(DEFAULT, DEFAULT)).toBe(true);
    expect(sameBrush(DEFAULT, SWATCH(3))).toBe(false);
    expect(sameBrush({ kind: 'preset', presetId: 'berry' }, { kind: 'preset', presetId: 'berry' })).toBe(true);
    expect(sameBrush({ kind: 'preset', presetId: 'berry' }, { kind: 'preset', presetId: 'meadow' })).toBe(false);
    expect(sameBrush({ kind: 'copied', sourceName: 'a', roles: { primary: 1 } }, { kind: 'copied', sourceName: 'a', roles: { primary: 1, rail: null } })).toBe(true);
    expect(sameBrush({ kind: 'copied', sourceName: 'a', roles: { primary: 1 } }, { kind: 'copied', sourceName: 'a', roles: { primary: 2 } })).toBe(false);
  });
});

describe('the catalog and the presets agree', () => {
  it('every catalog definition either has slots or is one of the fixed kinds (paths, the tree)', () => {
    for (const definition of BUILD_CATALOG) {
      const colourable = colourSlotsFor(definition.id).length > 0;
      expect(colourable || definition.kind === 'path' || definition.id === 'confetti-tree' || definition.id === 'lantern-maple', definition.id).toBe(true);
    }
  });
});
