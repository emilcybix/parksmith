/**
 * Phase 19: one-shot flags that survive a reload of the same tab (sessionStorage), so the fatal-error screen's
 * "Reload and recover" can ask the next boot to continue the newest save as soon as the start screen has read it.
 * Every access is guarded: storage that throws or is missing simply means "no flag".
 */

export const RECOVER_FLAG_KEY = 'parksmith-recover-on-boot';

interface FlagStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const sessionStore = (): FlagStorage | null => {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
};

/** Asks the next boot of this tab to continue the newest save. */
export const requestRecoverOnBoot = (storage: FlagStorage | null = sessionStore()): void => {
  try {
    storage?.setItem(RECOVER_FLAG_KEY, '1');
  } catch {
    // No storage: the reload still shows the start screen, where Continue does the same.
  }
};

/** True once if the previous page asked for a recovery; the flag is cleared by reading it. */
export const consumeRecoverOnBoot = (storage: FlagStorage | null = sessionStore()): boolean => {
  try {
    const set = storage?.getItem(RECOVER_FLAG_KEY) === '1';
    storage?.removeItem(RECOVER_FLAG_KEY);
    return set;
  } catch {
    return false;
  }
};
