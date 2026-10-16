import { describe, expect, it } from 'vitest';
import { parseSlotMeta } from './memorySaveStore';
import { slotMode } from './mapMeta';

const row = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'manual-1', kind: 'manual', name: 'A', scenarioId: null, scenarioName: 'Sandbox park', playtimeSeconds: 1, savedAt: 1, schemaVersion: 10,
  contentVersion: 2, savedAtTick: 1, guestCount: 0, cash: 0, rating: 0, sizeBytes: 1, revision: 1, writerTabId: 't', status: { state: 'ok' }, ...extra,
});

describe('slot metadata mode (Phase 22)', () => {
  it('keeps a valid mode', () => {
    expect(parseSlotMeta(row({ mode: 'run', scenarioId: 'penny-lane' }))?.mode).toBe('run');
  });

  it('drops a hostile mode instead of rejecting the row, and the row reads the schema 9 rule', () => {
    for (const bad of ['hax', 3, null, {}, ['sandbox']]) {
      const parsed = parseSlotMeta(row({ mode: bad, scenarioId: 'penny-lane' }));
      expect(parsed, String(bad)).not.toBeNull();
      expect(parsed?.mode).toBeUndefined();
      expect(slotMode(parsed!)).toBe('scenario');
    }
  });

  it('a row written before the field has no mode and reads Sandbox for no scenario', () => {
    const parsed = parseSlotMeta(row());
    expect(parsed?.mode).toBeUndefined();
    expect(slotMode(parsed!)).toBe('sandbox');
  });
});
