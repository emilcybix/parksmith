/**
 * Player preferences: the typed, versioned shape and its pure validation and migration.
 *
 * Stored under its own localStorage key (`parksmith-settings`), never in a ParkSave (a preference
 * is not part of a park) and never in the Park Tour profile. Nothing here touches storage, the DOM
 * or the clock: see settingsStore.ts for that.
 *
 * Screen shake is deliberately NOT a field: nothing shakes the camera, and a field with no consumer is data without
 * meaning. The six volumes arrived with Phase 15 (src/audio): master and one per bus, in steps of 10; a blob without
 * them reads the defaults (no migration: validation fills a missing field).
 *
 * Version 2 added `keybindings`: sparse key overrides (see keybindings.ts).
 */
import { keybindingsEqual, validateKeybindings, type KeybindingOverrides } from './keybindings';


export const SETTINGS_VERSION = 2;
export const SETTINGS_STORAGE_KEY = 'parksmith-settings';

export type UiScale = 85 | 100 | 115 | 130;
/** 'on' means "reduce motion". */
export type MotionPreference = 'system' | 'on' | 'off';
export type WeatherEffects = 'full' | 'reduced' | 'off';
export type CameraSpeed = 'slow' | 'normal' | 'fast';
/** 0 = Off (no timed autosave). */
export type AutosaveMinutes = 0 | 1 | 2 | 5 | 10;
export type NotificationIntensity = 'all' | 'important' | 'minimal';
/** Voxel leftovers: the renderer and the voxel composite as settings (read at start; a change applies after a reload). */
export type RendererPreference = 'voxel' | 'classic';
export type GraphicsDetail = 'full' | 'lite';
/** Phase 15: a volume in steps of 10 (0 = silent). */
export type VolumeLevel = 0 | 10 | 20 | 30 | 40 | 50 | 60 | 70 | 80 | 90 | 100;
const VOLUME_LEVELS: readonly VolumeLevel[] = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

export interface Settings {
  uiScale: UiScale;
  reducedMotion: MotionPreference;
  weatherEffects: WeatherEffects;
  /** Lightning flashes (still capped at 3 per second). */
  lightningFlashes: boolean;
  /** Key-pan speed. */
  cameraKeySpeed: CameraSpeed;
  /** Wheel-zoom sensitivity. */
  cameraZoomStep: CameraSpeed;
  autosaveMinutes: AutosaveMinutes;
  notifications: NotificationIntensity;
  developerTools: boolean;
  /** The renderer to start (a URL `?renderer=` wins); the voxel renderer still falls back to classic by itself. */
  renderer: RendererPreference;
  /** The voxel composite: full, or the lite one (simpler light, cheaper on a weak GPU). `&voxelComposite=lite` wins. */
  graphicsDetail: GraphicsDetail;
  /** Phase 15: the master volume and one per audio bus (src/audio/AudioEngine.ts). */
  masterVolume: VolumeLevel;
  musicVolume: VolumeLevel;
  ambienceVolume: VolumeLevel;
  ridesVolume: VolumeLevel;
  guestsVolume: VolumeLevel;
  uiVolume: VolumeLevel;
  /** Sparse overrides of the default key bindings; `{}` = all defaults. */
  keybindings: KeybindingOverrides;
}

/** Defaults reproduce the behaviour from before settings existed. */
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  uiScale: 100,
  reducedMotion: 'system',
  weatherEffects: 'full',
  lightningFlashes: true,
  cameraKeySpeed: 'normal',
  cameraZoomStep: 'normal',
  autosaveMinutes: 2,
  notifications: 'all',
  developerTools: false,
  renderer: 'voxel',
  graphicsDetail: 'full',
  masterVolume: 70,
  musicVolume: 40,
  ambienceVolume: 60,
  ridesVolume: 70,
  guestsVolume: 60,
  uiVolume: 70,
  keybindings: Object.freeze({}),
});

/** The settings that are a pick from a fixed list; keybindings is validated on its own. */
export type OptionSettingKey = Exclude<keyof Settings, 'keybindings'>;

export const SETTING_OPTIONS: { readonly [K in OptionSettingKey]: readonly Settings[K][] } = {
  uiScale: [85, 100, 115, 130],
  reducedMotion: ['system', 'on', 'off'],
  weatherEffects: ['full', 'reduced', 'off'],
  lightningFlashes: [false, true],
  cameraKeySpeed: ['slow', 'normal', 'fast'],
  cameraZoomStep: ['slow', 'normal', 'fast'],
  autosaveMinutes: [0, 1, 2, 5, 10],
  notifications: ['all', 'important', 'minimal'],
  developerTools: [false, true],
  renderer: ['voxel', 'classic'],
  graphicsDetail: ['full', 'lite'],
  masterVolume: VOLUME_LEVELS,
  musicVolume: VOLUME_LEVELS,
  ambienceVolume: VOLUME_LEVELS,
  ridesVolume: VOLUME_LEVELS,
  guestsVolume: VOLUME_LEVELS,
  uiVolume: VOLUME_LEVELS,
};

/** Every field, keybindings included. */
export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];
export const OPTION_SETTING_KEYS = Object.keys(SETTING_OPTIONS) as OptionSettingKey[];

export const CAMERA_SPEED_FACTORS: Readonly<Record<CameraSpeed, number>> = Object.freeze({
  slow: 0.5,
  normal: 1,
  fast: 1.75,
});

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

/**
 * Per-field validation: a bad field falls back to its own default and the other fields survive.
 * Never throws; a non-object gives all defaults. Always returns a fresh object.
 */
export const validateSettings = (raw: unknown): Settings => {
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS, keybindings: {} };
  if (!isRecord(raw)) return out as unknown as Settings;
  out.keybindings = validateKeybindings(raw.keybindings);
  for (const key of OPTION_SETTING_KEYS) {
    const options = SETTING_OPTIONS[key] as readonly unknown[];
    const stored = raw[key];
    // -0 equals 0 for `includes`, so normalise it: a stored -0 must come out as a plain 0.
    const value = stored === 0 ? 0 : stored;
    if (options.includes(value)) out[key] = value;
  }
  return out as unknown as Settings;
};

export interface LegacyInputs {
  /** The old `parksmith-dev` flag: true/false when it was present, null when absent. */
  devFlag: boolean | null;
}

export interface MigrationResult {
  settings: Settings;
  /** True when the caller should write the result back (legacy import or repaired garbage). */
  needsWrite: boolean;
}

/**
 * Each entry upgrades a blob from version N to N + 1. Version 0 is the pre-settings shape: there
 * was no blob at all, only the legacy dev flag, so the v0 step is applied to the absent-blob case
 * in `migrateStored`. Future renames go here.
 */
const MIGRATIONS: Readonly<Record<number, (blob: Record<string, unknown>) => Record<string, unknown>>> = {
  // v1 -> v2: key bindings arrive, every existing field is kept.
  1: (blob) => ({ ...blob, keybindings: {} }),
};

/** Turns whatever was stored (already JSON-parsed, or undefined when absent) into valid settings. */
/** `undefined` means nothing was stored; a stored JSON `null` is garbage and gets repaired. */
export const migrateStored = (raw: unknown, legacy: LegacyInputs): MigrationResult => {
  if (raw === undefined) {
    const imported = legacy.devFlag === true;
    return {
      settings: { ...DEFAULT_SETTINGS, keybindings: {}, developerTools: imported },
      needsWrite: imported,
    };
  }
  if (!isRecord(raw)) return { settings: validateSettings(null), needsWrite: true };
  const version = raw.version;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return { settings: validateSettings(raw), needsWrite: true };
  }
  if (version > SETTINGS_VERSION) {
    // An older app reading a newer blob: keep what is understood and never rewrite on load.
    return { settings: validateSettings(raw), needsWrite: false };
  }
  let blob: Record<string, unknown> = raw;
  for (let v = Math.max(0, version); v < SETTINGS_VERSION; v += 1) {
    const step = MIGRATIONS[v];
    if (step) blob = step(blob);
  }
  const settings = validateSettings(blob);
  if (version < 0) return { settings, needsWrite: true };
  return { settings, needsWrite: version < SETTINGS_VERSION };
};

export const serializeSettings = (settings: Settings): string => (
  JSON.stringify({ version: SETTINGS_VERSION, ...settings })
);

/** Whether one field is equal; keybindings compare entry by entry, the rest by value. */
export const settingValueEqual = (key: keyof Settings, a: Settings, b: Settings): boolean => (
  key === 'keybindings' ? keybindingsEqual(a.keybindings, b.keybindings) : a[key] === b[key]
);

export const settingsEqual = (a: Settings, b: Settings): boolean => (
  SETTING_KEYS.every((key) => settingValueEqual(key, a, b))
);
