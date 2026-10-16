import { describe, expect, it } from 'vitest';
import { ProfileManager, type ProfileStorage } from '../game/profile/ProfileManager';
import { PROFILE_STORAGE_KEY } from '../game/profile/schema';

/**
 * Adversarial review of step 2 (Phase 13), kept through the Park Tour's retirement (Phase 23): first-run detection now lives in
 * the profile (`ProfileManager.isFirstRun`), and a first run lands in the Sandbox First Day park.
 */

const memory = (failWrites = false): ProfileStorage & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { if (failWrites) throw new Error('quota'); map.set(key, value); },
  };
};

describe('first-run detection (review)', () => {
  it('the first session is a first run and writes the profile; the next one is not', () => {
    const storage = memory();
    expect(new ProfileManager(storage).isFirstRun).toBe(true);
    expect(storage.map.has(PROFILE_STORAGE_KEY)).toBe(true);
    expect(new ProfileManager(storage).isFirstRun).toBe(false);
  });

  it('with writable-read but throwing-write storage nothing is treated as a first run on every page load', () => {
    const storage = memory(true);
    expect(new ProfileManager(storage).isFirstRun, 'a profile that cannot be remembered is never "first"').toBe(false);
    expect(new ProfileManager(storage).isFirstRun).toBe(false);
  });
});
