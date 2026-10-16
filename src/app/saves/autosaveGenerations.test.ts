import { describe, expect, it } from 'vitest';
import {
  autosaveGeneration,
  autosaveGenerations,
  autosaveLabel,
  continuableSlots,
  isAutosaveSlotId,
  resumableAutosave,
  slotDisplayName,
  slotsToDelete,
} from './autosaveGenerations';
import { makeSlotMeta } from './fakeIndexedDb.storeSupport';
import type { SaveSlotId, SaveSlotMeta } from './types';

const row = (id: SaveSlotId, overrides: Partial<SaveSlotMeta> = {}): SaveSlotMeta => (
  makeSlotMeta(id, { kind: isAutosaveSlotId(id) ? 'auto' : 'manual', name: isAutosaveSlotId(id) ? 'Autosave' : `Park ${id}`, ...overrides })
);
const broken = (id: SaveSlotId): SaveSlotMeta => row(id, { status: { state: 'unreadable', code: 'corrupt', message: 'bad' } });

describe('autosave generations (Phase 31)', () => {
  it('knows which slot is which generation', () => {
    expect(autosaveGeneration('autosave')).toBe('current');
    expect(autosaveGeneration('autosave-previous')).toBe('previous');
    expect(autosaveGeneration('manual-1')).toBeNull();
    expect(isAutosaveSlotId('autosave-previous')).toBe(true);
    expect(isAutosaveSlotId('manual-1')).toBe(false);
    expect(autosaveGenerations([row('manual-1'), row('autosave-previous')])).toEqual({ current: null, previous: row('autosave-previous') });
  });

  it('resumes the newest readable generation and falls back to the previous one', () => {
    const current = row('autosave', { savedAt: 200 });
    const previous = row('autosave-previous', { savedAt: 100 });
    expect(resumableAutosave([current, previous]), 'current readable').toBe(current);
    expect(resumableAutosave([current, row('autosave-previous', { savedAt: 999 })]), 'never the previous while the current is readable, whatever the clock').toBe(current);
    expect(resumableAutosave([broken('autosave'), previous]), 'current unreadable').toBe(previous);
    expect(resumableAutosave([previous]), 'current quarantined away').toBe(previous);
    expect(resumableAutosave([broken('autosave'), broken('autosave-previous')]), 'nothing readable').toBeNull();
    expect(resumableAutosave([row('autosave', { savedAt: Number.NaN }), previous]), 'a row without a time is not readable').toBe(previous);
  });

  it('offers at most one autosave generation among the continuable slots', () => {
    const current = row('autosave');
    const previous = row('autosave-previous');
    const manual = row('manual-1');
    expect(continuableSlots([current, previous, manual]), 'previous hidden behind a readable current').toEqual([current, manual]);
    expect(continuableSlots([broken('autosave'), previous, manual]), 'previous stands in').toEqual([previous, manual]);
    expect(continuableSlots([broken('manual-2'), manual]), 'unreadable rows are never candidates').toEqual([manual]);
  });

  it('labels the generations by their place, and keeps a renamed autosave name', () => {
    expect(autosaveLabel(row('autosave'))).toBe('Autosave');
    expect(autosaveLabel(row('autosave-previous'))).toBe('Previous autosave');
    expect(autosaveLabel(row('manual-3'))).toBe('Park manual-3');
    expect(slotDisplayName(row('autosave-previous'))).toBe('Previous autosave');
    expect(slotDisplayName(row('autosave-previous', { name: 'My park' }))).toBe('My park');
    expect(slotDisplayName(row('autosave'))).toBe('Autosave');
  });

  describe('deletion policy', () => {
    it('deleting a readable autosave deletes both generations, previous first', () => {
      expect(slotsToDelete('autosave', [row('autosave'), row('autosave-previous')])).toEqual(['autosave-previous', 'autosave']);
    });

    it('deleting an unreadable autosave keeps the previous generation as the fallback', () => {
      expect(slotsToDelete('autosave', [broken('autosave'), row('autosave-previous')])).toEqual(['autosave']);
    });

    it('deleting the previous generation, a lone autosave or a manual slot deletes only that slot', () => {
      expect(slotsToDelete('autosave-previous', [row('autosave'), row('autosave-previous')])).toEqual(['autosave-previous']);
      expect(slotsToDelete('autosave', [row('autosave')])).toEqual(['autosave']);
      expect(slotsToDelete('manual-1', [row('autosave'), row('autosave-previous'), row('manual-1')])).toEqual(['manual-1']);
    });
  });
});
