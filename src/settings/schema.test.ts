import { describe, expect, it } from 'vitest';
import {
  CAMERA_SPEED_FACTORS,
  DEFAULT_SETTINGS,
  migrateStored,
  OPTION_SETTING_KEYS,
  SETTING_KEYS,
  SETTING_OPTIONS,
  SETTINGS_VERSION,
  serializeSettings,
  validateSettings,
} from './schema';
import v1Fixture from './__fixtures__/settings-v1.json';
import v2Fixture from './__fixtures__/settings-v2-keybindings.json';
import { AUTOSAVE_INTERVAL_SECONDS } from '../app/saves/constants';
import { KEY_PAN_CSS_PER_MS } from '../rendering/worldInput';

const none = { devFlag: null };

describe('defaults', () => {
  it('reproduce the behaviour from before settings existed', () => {
    expect(DEFAULT_SETTINGS.autosaveMinutes * 60).toBe(AUTOSAVE_INTERVAL_SECONDS);
    expect(CAMERA_SPEED_FACTORS[DEFAULT_SETTINGS.cameraKeySpeed] * KEY_PAN_CSS_PER_MS).toBe(0.55);
    expect(CAMERA_SPEED_FACTORS[DEFAULT_SETTINGS.cameraZoomStep]).toBe(1);
    expect(DEFAULT_SETTINGS).toMatchObject({ uiScale: 100, reducedMotion: 'system', weatherEffects: 'full', lightningFlashes: true, notifications: 'all', developerTools: false });
  });

  it('every default is one of its options, and every field has options', () => {
    for (const key of OPTION_SETTING_KEYS) {
      expect(SETTING_OPTIONS[key], key).toContain(DEFAULT_SETTINGS[key]);
    }
    // Every field has options except the key bindings, which validate per entry (keybindings.ts).
    expect(Object.keys(SETTING_OPTIONS).sort()).toEqual(SETTING_KEYS.filter((key) => key !== 'keybindings').sort());
  });

  it('has the six Phase 15 volumes (in steps of 10) and no shake field (nothing consumes one)', () => {
    expect(SETTING_KEYS.filter((key) => /volume/i.test(key))).toEqual(['masterVolume', 'musicVolume', 'ambienceVolume', 'ridesVolume', 'guestsVolume', 'uiVolume']);
    for (const key of ['masterVolume', 'musicVolume', 'ambienceVolume', 'ridesVolume', 'guestsVolume', 'uiVolume'] as const) {
      expect(SETTING_OPTIONS[key]).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    }
    expect(SETTING_KEYS.filter((key) => /shake|sfx/i.test(key))).toEqual([]);
  });
});

describe('validateSettings', () => {
  it('gives defaults for anything that is not an object', () => {
    for (const raw of [null, undefined, 0, 'x', [], true, 42n]) {
      expect(validateSettings(raw)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('keeps every valid field and replaces only the bad ones', () => {
    const result = validateSettings({ uiScale: 115, reducedMotion: 'banana', weatherEffects: 'off', lightningFlashes: 'yes', autosaveMinutes: 7, notifications: 'minimal' });
    expect(result).toEqual({ ...DEFAULT_SETTINGS, uiScale: 115, weatherEffects: 'off', notifications: 'minimal' });
  });

  it('rejects wrong types of the right value (numeric strings, NaN)', () => {
    expect(validateSettings({ uiScale: '115', autosaveMinutes: '5' })).toEqual(DEFAULT_SETTINGS);
    expect(validateSettings({ uiScale: Number.NaN })).toEqual(DEFAULT_SETTINGS);
  });

  it('returns a fresh object each time and ignores unknown fields', () => {
    const a = validateSettings({ extra: 1 });
    expect(a).not.toBe(DEFAULT_SETTINGS);
    expect(Object.keys(a).sort()).toEqual([...SETTING_KEYS].sort());
  });
});

describe('migrateStored', () => {
  it('absent blob: defaults, no write', () => {
    expect(migrateStored(undefined, none)).toEqual({ settings: DEFAULT_SETTINGS, needsWrite: false });
    expect(migrateStored(undefined, { devFlag: false })).toEqual({ settings: DEFAULT_SETTINGS, needsWrite: false });
  });

  it('absent blob with the legacy dev flag imports developerTools and asks for a write', () => {
    const result = migrateStored(undefined, { devFlag: true });
    expect(result.settings).toEqual({ ...DEFAULT_SETTINGS, developerTools: true });
    expect(result.needsWrite).toBe(true);
  });

  it('a current blob round-trips and never needs a write (the legacy flag is ignored once a blob exists)', () => {
    const settings = { ...DEFAULT_SETTINGS, uiScale: 85 as const, autosaveMinutes: 0 as const };
    const blob = JSON.parse(serializeSettings(settings));
    expect(blob.version).toBe(SETTINGS_VERSION);
    expect(migrateStored(blob, { devFlag: true })).toEqual({ settings, needsWrite: false });
  });

  it('garbage (not an object, no or fractional version) gives per-field values and asks for a repair write', () => {
    expect(migrateStored(0, none)).toEqual({ settings: DEFAULT_SETTINGS, needsWrite: true });
    expect(migrateStored('x', none).needsWrite).toBe(true);
    expect(migrateStored([], none).needsWrite).toBe(true);
    const noVersion = migrateStored({ uiScale: 130 }, none);
    expect(noVersion.settings.uiScale).toBe(130);
    expect(noVersion.needsWrite).toBe(true);
    expect(migrateStored({ version: 1.5, uiScale: 85 }, none).needsWrite).toBe(true);
  });

  it('an old version is upgraded and rewritten', () => {
    const result = migrateStored({ version: 0, uiScale: 115 }, none);
    expect(result.settings.uiScale).toBe(115);
    expect(result.needsWrite).toBe(true);
  });

  it('a newer version is read best-effort and never rewritten by loading', () => {
    const result = migrateStored({ version: SETTINGS_VERSION + 1, uiScale: 85, futureField: 1, notifications: 'loud' }, none);
    expect(result.settings).toEqual({ ...DEFAULT_SETTINGS, uiScale: 85 });
    expect(result.needsWrite).toBe(false);
  });
});

describe('schema version 2 (keybindings)', () => {
  it('is version 2 and defaults to no overrides', () => {
    expect(SETTINGS_VERSION).toBe(2);
    expect(DEFAULT_SETTINGS.keybindings).toEqual({});
  });

  it('migrates the frozen v1 blob: every v1 field intact, empty keybindings, and a rewrite', () => {
    const result = migrateStored(v1Fixture, none);
    expect(result.settings).toEqual({
      uiScale: 115,
      reducedMotion: 'on',
      weatherEffects: 'reduced',
      lightningFlashes: false,
      cameraKeySpeed: 'fast',
      cameraZoomStep: 'slow',
      autosaveMinutes: 5,
      notifications: 'important',
      developerTools: true,
      // Phase 15 and the voxel leftovers: a blob without volumes or Graphics settings reads the defaults.
      renderer: 'voxel', graphicsDetail: 'full',
      masterVolume: 70, musicVolume: 40, ambienceVolume: 60, ridesVolume: 70, guestsVolume: 60, uiVolume: 70,
      keybindings: {},
    });
    expect(result.needsWrite).toBe(true);
  });

  it('reads the frozen v2 blob: valid overrides kept, unknown ids dropped, conflicts dropped', () => {
    const result = migrateStored(v2Fixture, none);
    expect(result.needsWrite).toBe(false);
    // rotate = g conflicts with the already accepted toggleGrid? No: toggleGrid moved to j, so rotate = g is free.
    expect(result.settings.keybindings).toEqual({
      toggleGrid: 'k:j',
      peek: null,
      speed1: 'shift+c:Digit5',
      panUp: 'c:KeyZ',
      rotate: 'k:g',
    });
  });

  it('serializes keybindings and reads them back', () => {
    const settings = { ...DEFAULT_SETTINGS, keybindings: { toggleGrid: 'k:j' } };
    const blob = JSON.parse(serializeSettings(settings));
    expect(blob.keybindings).toEqual({ toggleGrid: 'k:j' });
    expect(migrateStored(blob, none)).toEqual({ settings, needsWrite: false });
  });

  it('garbage keybindings fall back to defaults without touching other fields', () => {
    for (const keybindings of ['x', 5, [], null, { toggleGrid: 3 }]) {
      const result = validateSettings({ uiScale: 85, keybindings });
      expect(result.uiScale).toBe(85);
      expect(result.keybindings).toEqual({});
    }
  });
});
