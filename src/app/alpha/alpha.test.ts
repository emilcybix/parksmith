import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../settings/schema';
import { SAVE_CONTENT_VERSION, SAVE_SCHEMA_VERSION } from '../../game/save/version';
import { RECOVER_FLAG_KEY, consumeRecoverOnBoot, requestRecoverOnBoot } from './bootFlags';
import { FEEDBACK_MESSAGE_LIMIT, buildFeedbackReport, feedbackFileName, feedbackText } from './feedbackReport';

const environment = {
  gameVersion: '0.2.0',
  renderer: 'voxel',
  userAgent: 'Test/1.0',
  screen: { width: 1280, height: 800, pixelRatio: 2 },
  createdAt: '2026-10-14T12:30:05.123Z',
};

describe('feedback report (Phase 19)', () => {
  it('carries the version, the save format, the environment, a few settings and the trimmed message; no park unless given', () => {
    const report = buildFeedbackReport('  hi  ', environment, { ...DEFAULT_SETTINGS }, null);
    expect(report).toMatchObject({
      kind: 'parksmith-feedback', reportVersion: 1, gameVersion: '0.2.0', saveSchema: SAVE_SCHEMA_VERSION,
      contentVersion: SAVE_CONTENT_VERSION, renderer: 'voxel', message: 'hi', fatalError: null, save: null,
    });
    expect(Object.keys(report.settings!).sort()).toEqual(['masterVolume', 'notifications', 'reducedMotion', 'uiScale', 'weatherEffects']);
    expect(buildFeedbackReport('x'.repeat(FEEDBACK_MESSAGE_LIMIT + 50), environment, null, null).message.length).toBe(FEEDBACK_MESSAGE_LIMIT);
    expect(buildFeedbackReport('', { ...environment, fatalError: 'TypeError: boom' }, null, null).fatalError).toBe('TypeError: boom');
    expect(JSON.parse(feedbackText(report))).toEqual(report);
    expect(feedbackFileName(report)).toBe('parksmith-feedback-0.2.0-2026-10-14T12-30-05.json');
  });
});

describe('boot flags (Phase 19)', () => {
  const memory = () => {
    const values = new Map<string, string>();
    return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); }, values };
  };

  it('a recovery request is read once', () => {
    const storage = memory();
    expect(consumeRecoverOnBoot(storage)).toBe(false);
    requestRecoverOnBoot(storage);
    expect(storage.values.get(RECOVER_FLAG_KEY)).toBe('1');
    expect(consumeRecoverOnBoot(storage)).toBe(true);
    expect(consumeRecoverOnBoot(storage)).toBe(false);
  });

  it('storage that is missing or throws means no flag, never an error', () => {
    expect(consumeRecoverOnBoot(null)).toBe(false);
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } };
    expect(() => requestRecoverOnBoot(broken)).not.toThrow();
    expect(consumeRecoverOnBoot(broken)).toBe(false);
  });
});

describe('degradation notice (voxel leftovers)', () => {
  it('names what went and where to look', async () => {
    const { degradationNotice } = await import('./degradationNotice');
    expect(degradationNotice('no-lights+no-shadows')).toContain('no lamp light, no soft shadows');
    expect(degradationNotice('composite-lite')).toContain('simpler light');
    expect(degradationNotice('mystery')).toContain('some effects are off');
    expect(degradationNotice('no-lights')).toContain('Settings > Graphics');
  });
});
