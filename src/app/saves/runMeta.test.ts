import { describe, expect, it } from 'vitest';
import { readRunSummary } from './runMeta';
import { parseSlotMeta } from './memorySaveStore';

const good = { seed: 4242, difficulty: 'standard', levelNumber: 3, levelCount: 5, biomeId: 'winter', phase: 'offer', levelsCleared: 2 };

const row = (extra: Record<string, unknown> = {}) => ({
  id: 'manual-1', kind: 'manual', name: 'x', scenarioId: 'the-map-stage', scenarioName: 'Level 3 · Winter', mode: 'run', playtimeSeconds: 1, savedAt: 1, schemaVersion: 11,
  contentVersion: 2, savedAtTick: 1, guestCount: 0, cash: 0, rating: 0, sizeBytes: 1, revision: 1, writerTabId: 't', status: { state: 'ok' }, ...extra,
});

describe('the run summary a slot row carries (Phase 23)', () => {
  it('reads a well-formed summary exactly', () => {
    expect(readRunSummary(good)).toEqual(good);
  });

  it.each<[string, unknown]>([
    ['null', null], ['an array', [1]], ['a string', 'level 3'], ['an extra key', { ...good, extra: 1 }], ['a missing key', { ...good, levelsCleared: undefined }],
    ['a bad seed', { ...good, seed: -1 }], ['a float seed', { ...good, seed: 1.5 }], ['a seed past u32', { ...good, seed: 2 ** 32 }],
    ['an unknown difficulty', { ...good, difficulty: 'nightmare' }], ['level 0', { ...good, levelNumber: 0 }], ['level past the count', { ...good, levelNumber: 6 }],
    ['an absurd level count', { ...good, levelCount: 500, levelNumber: 3 }], ['more cleared than levels', { ...good, levelsCleared: 6 }], ['negative cleared', { ...good, levelsCleared: -1 }],
    ['a float plan version', { ...good, planVersion: 2.5 }], ['plan version 0', { ...good, planVersion: 0 }], ['a string plan version', { ...good, planVersion: '3' }],
    ['an unknown biome', { ...good, biomeId: 'moon' }], ['an unknown phase', { ...good, phase: 'paused' }], ['a numeric biome', { ...good, biomeId: 3 }],
  ])('drops %s', (_name, value) => {
    expect(readRunSummary(value)).toBeNull();
  });

  it('keeps an integer plan version (Phase 25), and reads a header without one as before', () => {
    expect(readRunSummary({ ...good, planVersion: 3 })).toEqual({ ...good, planVersion: 3 });
    expect(readRunSummary(good)).not.toHaveProperty('planVersion');
  });

  it('parseSlotMeta keeps a good summary and drops a hostile one without losing the row', () => {
    expect(parseSlotMeta(row({ run: good }))?.run).toEqual(good);
    const hostile = parseSlotMeta(row({ run: { ...good, seed: 'lots' } }));
    expect(hostile).not.toBeNull();
    expect(hostile?.run, 'the row falls back to the ordinary park texts').toBeUndefined();
    expect(parseSlotMeta(row())?.run).toBeUndefined();
  });
});
