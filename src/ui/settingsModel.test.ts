import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTING_OPTIONS } from '../settings';
import {
  AUTOSAVE_HINT_OFF,
  SETTINGS_GROUPS,
  developerToolsState,
  flashesAvailability,
  isDefault,
  motionStatus,
  optionLabel,
  persistenceNotice,
  segmentedHint,
  uiScaleStatus,
  VOLUME_CONTROLS,
} from './settingsModel';

describe('settings panel model', () => {
  it('offers exactly the schema options for every segmented control, in order', () => {
    for (const group of SETTINGS_GROUPS) {
      for (const control of group.controls) {
        expect(control.options.map((option) => option.value)).toEqual([...SETTING_OPTIONS[control.key]]);
      }
    }
  });

  it('covers every setting except the two switches and the key bindings, which the component draws itself', () => {
    const keys = SETTINGS_GROUPS.flatMap((group) => group.controls.map((control) => control.key)).sort();
    // Phase 15: the six volumes are sliders in the Sound group (VOLUME_CONTROLS), drawn by the component.
    const volumes = VOLUME_CONTROLS.map((control) => control.key as string);
    const expected = (Object.keys(DEFAULT_SETTINGS) as string[]).filter((key) => key !== 'lightningFlashes' && key !== 'developerTools' && key !== 'keybindings' && !volumes.includes(key)).sort();
    expect(keys).toEqual(expected);
  });

  it('labels are unique within a control and never empty', () => {
    for (const group of SETTINGS_GROUPS) {
      for (const control of group.controls) {
        const labels = control.options.map((option) => option.label);
        expect(new Set(labels).size).toBe(labels.length);
        expect(labels.every((label) => label.length > 0)).toBe(true);
      }
    }
  });

  it('labels the readable cases', () => {
    expect(optionLabel('uiScale', 115)).toBe('115%');
    expect(optionLabel('autosaveMinutes', 0)).toBe('Off');
    expect(optionLabel('autosaveMinutes', 5)).toBe('5 min');
    expect(optionLabel('notifications', 'important')).toBe('Important only');
  });

  it('hints follow the value where the meaning changes', () => {
    expect(segmentedHint('autosaveMinutes', { ...DEFAULT_SETTINGS, autosaveMinutes: 0 })).toBe(AUTOSAVE_HINT_OFF);
    expect(segmentedHint('autosaveMinutes', DEFAULT_SETTINGS)).not.toBe(AUTOSAVE_HINT_OFF);
    expect(segmentedHint('notifications', { ...DEFAULT_SETTINGS, notifications: 'minimal' })).toMatch(/problems/);
    expect(segmentedHint('uiScale', DEFAULT_SETTINGS)).toMatch(/park view/);
  });

  it('flashes explain why they are unavailable', () => {
    expect(flashesAvailability({ weatherEffects: 'full' }, false)).toEqual({ disabled: false, reason: null });
    expect(flashesAvailability({ weatherEffects: 'reduced' }, false).disabled).toBe(true);
    expect(flashesAvailability({ weatherEffects: 'off' }, false).reason).toMatch(/Full/);
    expect(flashesAvailability({ weatherEffects: 'full' }, true).reason).toMatch(/reduced motion/);
  });

  it('motion status names the effective value and the source', () => {
    expect(motionStatus({ reducedMotion: 'system' }, true)).toBe('Currently: reduced (from your device)');
    expect(motionStatus({ reducedMotion: 'off' }, false)).toBe('Currently: full');
  });

  it('only reports a UI scale cap when the window forces one', () => {
    expect(uiScaleStatus({ uiScale: 130 }, 1280, 720)).toMatch(/104%/);
    expect(uiScaleStatus({ uiScale: 130 }, 1920, 1080)).toBeNull();
    expect(uiScaleStatus({ uiScale: 85 }, 800, 600)).toBeNull();
    expect(uiScaleStatus({ uiScale: 100 }, 800, 600)).toBeNull();
  });

  it('developer tools wait for a reload when they differ from the running value', () => {
    expect(developerToolsState(false, false)).toBe('off');
    expect(developerToolsState(true, true)).toBe('on');
    expect(developerToolsState(true, false)).toBe('pending-on');
    expect(developerToolsState(false, true)).toBe('pending-off');
  });

  it('knows defaults and the storage notice', () => {
    expect(isDefault({ ...DEFAULT_SETTINGS })).toBe(true);
    expect(isDefault({ ...DEFAULT_SETTINGS, uiScale: 115 })).toBe(false);
    expect(persistenceNotice('ok')).toBeNull();
    expect(persistenceNotice('unavailable')).toMatch(/Not saved/);
  });
});
