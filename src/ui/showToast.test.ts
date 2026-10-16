import { afterEach, describe, expect, it } from 'vitest';
import { resetSettings, updateSettings } from '../settings';
import { showToast } from './showToast';
import { useUiStore } from './store';

afterEach(() => {
  resetSettings();
  useUiStore.getState().setToast(null);
});

describe('showToast', () => {
  const cases = [
    ['all', 'routine', true], ['all', 'important', true], ['all', 'alert', true],
    ['important', 'routine', false], ['important', 'important', true], ['important', 'alert', true],
    ['minimal', 'routine', false], ['minimal', 'important', false], ['minimal', 'alert', true],
  ] as const;
  it.each(cases)('at %s, a %s toast is shown: %s', (level, cls, shown) => {
    updateSettings({ notifications: level });
    expect(showToast('Hello', cls)).toBe(shown);
    expect(useUiStore.getState().toast).toBe(shown ? 'Hello' : null);
  });

  it('a suppressed toast leaves the one already showing alone', () => {
    useUiStore.getState().setToast('Refused');
    updateSettings({ notifications: 'minimal' });
    showToast('Built', 'routine');
    expect(useUiStore.getState().toast).toBe('Refused');
  });
});
