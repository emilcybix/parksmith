import { afterEach, describe, expect, it } from 'vitest';
import { closeSettings, openSettings } from './openSettings';
import { useUiStore } from './store';

afterEach(() => useUiStore.getState().closeSettings());

describe('openSettings', () => {
  it('opens and closes the panel from non-React code, and starts closed', () => {
    expect(useUiStore.getState().settingsOpen).toBe(false);
    openSettings();
    expect(useUiStore.getState().settingsOpen).toBe(true);
    openSettings();
    expect(useUiStore.getState().settingsOpen).toBe(true);
    closeSettings();
    expect(useUiStore.getState().settingsOpen).toBe(false);
  });
});
