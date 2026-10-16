import {
  DEFAULT_SETTINGS,
  SETTING_OPTIONS,
  settingsEqual,
  effectiveUiScale,
  isUiScaleCapped,
  type Settings,
} from '../settings';

/**
 * What the settings panel shows, as plain data derived from the settings schema, so a new option
 * or a renamed label is a one-line change here and the component stays a loop. Pure: no DOM.
 */
/** Phase 15: the volume settings, drawn as sliders (eleven steps would not fit a segmented row). */
export type VolumeKey = 'masterVolume' | 'musicVolume' | 'ambienceVolume' | 'ridesVolume' | 'guestsVolume' | 'uiVolume';

export type SegmentedKey = Exclude<keyof Settings, 'lightningFlashes' | 'developerTools' | 'keybindings' | VolumeKey>;

export interface VolumeControl {
  readonly key: VolumeKey;
  readonly label: string;
}

/** The Sound group, master first: what each bus carries is in its label. */
export const VOLUME_CONTROLS: readonly VolumeControl[] = [
  { key: 'masterVolume', label: 'Master' },
  { key: 'musicVolume', label: 'Music' },
  { key: 'ambienceVolume', label: 'Ambience' },
  { key: 'ridesVolume', label: 'Rides' },
  { key: 'guestsVolume', label: 'Guests' },
  { key: 'uiVolume', label: 'Interface and money' },
];

/** The slider's spoken value: "70%", or "Off" at 0. */
export const volumeText = (value: number): string => (value === 0 ? 'Off' : `${value}%`);

export const SOUND_HINT = 'Sound starts after your first click or key press. Master 0 silences everything.';

export interface ChoiceOption<T> {
  value: T;
  label: string;
}

export interface SegmentedControl<K extends SegmentedKey = SegmentedKey> {
  key: K;
  legend: string;
  hint: string;
  options: readonly ChoiceOption<Settings[K]>[];
}

export type SettingsGroupId = 'interface' | 'motion' | 'weather' | 'camera' | 'graphics' | 'saving' | 'notifications';

export interface SettingsGroup {
  id: SettingsGroupId;
  title: string;
  /** Segmented controls in order; the weather group adds its Flashes switch in the component. */
  controls: readonly SegmentedControl[];
}

const OPTION_LABELS: { readonly [K in SegmentedKey]: (value: Settings[K]) => string } = {
  uiScale: (value) => `${value}%`,
  reducedMotion: (value) => ({ system: 'System', on: 'On', off: 'Off' })[value],
  weatherEffects: (value) => ({ full: 'Full', reduced: 'Reduced', off: 'Off' })[value],
  cameraKeySpeed: (value) => ({ slow: 'Slow', normal: 'Normal', fast: 'Fast' })[value],
  cameraZoomStep: (value) => ({ slow: 'Fine', normal: 'Normal', fast: 'Coarse' })[value],
  autosaveMinutes: (value) => (value === 0 ? 'Off' : `${value} min`),
  notifications: (value) => ({ all: 'All', important: 'Important only', minimal: 'Minimal' })[value],
  renderer: (value) => ({ voxel: 'Voxel', classic: 'Classic' })[value],
  graphicsDetail: (value) => ({ full: 'Full', lite: 'Lite' })[value],
};

export const optionLabel = <K extends SegmentedKey>(key: K, value: Settings[K]): string => OPTION_LABELS[key](value);

const control = <K extends SegmentedKey>(key: K, legend: string, hint: string): SegmentedControl<K> => ({
  key,
  legend,
  hint,
  options: (SETTING_OPTIONS[key] as readonly Settings[K][]).map((value) => ({ value, label: optionLabel(key, value) })),
});

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    id: 'interface',
    title: 'Interface',
    controls: [control('uiScale', 'UI scale', 'Size of menus and buttons. The park view is not scaled.')],
  },
  {
    id: 'motion',
    title: 'Motion',
    controls: [control('reducedMotion', 'Reduced motion', 'Calms animations, fades and weather. System follows your device.')],
  },
  {
    id: 'weather',
    title: 'Weather',
    controls: [control('weatherEffects', 'Weather effects', 'Looks only. The weather itself keeps running.')],
  },
  {
    id: 'camera',
    title: 'Camera',
    controls: [
      control('cameraKeySpeed', 'Key pan speed', 'WASD and arrow keys.'),
      control('cameraZoomStep', 'Zoom step', 'How far one wheel notch zooms.'),
    ],
  },
  {
    id: 'graphics',
    title: 'Graphics',
    controls: [
      control('renderer', 'Renderer', 'Voxel is the game\'s look; Classic is the simpler fallback for a GPU that struggles.'),
      control('graphicsDetail', 'Light and shading', 'Lite skips the soft lights and some weather: try it if the game stutters.'),
    ],
  },
  {
    id: 'saving',
    title: 'Saving',
    controls: [control('autosaveMinutes', 'Autosave', '')],
  },
  {
    id: 'notifications',
    title: 'Notifications',
    controls: [control('notifications', 'Pop-ups', '')],
  },
];

export const AUTOSAVE_HINT_ON = 'Also saves when you leave the tab.';
export const AUTOSAVE_HINT_OFF = 'Off: saves only when you save, when a scenario ends, or when you leave the tab.';
export const NOTIFICATION_HINTS: Readonly<Record<Settings['notifications'], string>> = {
  all: 'Every confirmation and event.',
  important: 'Events and problems; no confirmations.',
  minimal: 'Only problems and refusals. Park Pulse keeps the full history.',
};

export const segmentedHint = (key: SegmentedKey, settings: Settings): string => {
  if (key === 'autosaveMinutes') return settings.autosaveMinutes === 0 ? AUTOSAVE_HINT_OFF : AUTOSAVE_HINT_ON;
  if (key === 'notifications') return NOTIFICATION_HINTS[settings.notifications];
  for (const group of SETTINGS_GROUPS) {
    const found = group.controls.find((candidate) => candidate.key === key);
    if (found) return found.hint;
  }
  return '';
};

/** The Flashes switch is only live in Full weather with motion not reduced; otherwise it says why. */
export const flashesAvailability = (
  settings: Pick<Settings, 'weatherEffects'>,
  reduced: boolean,
): { disabled: boolean; reason: string | null } => {
  if (settings.weatherEffects !== 'full') return { disabled: true, reason: 'Needs Weather effects: Full.' };
  if (reduced) return { disabled: true, reason: 'Off while reduced motion is on.' };
  return { disabled: false, reason: null };
};

export const motionStatus = (settings: Pick<Settings, 'reducedMotion'>, reduced: boolean): string => (
  `Currently: ${reduced ? 'reduced' : 'full'}${settings.reducedMotion === 'system' ? ' (from your device)' : ''}`
);

export const uiScaleStatus = (settings: Pick<Settings, 'uiScale'>, innerWidth: number, innerHeight: number): string | null => {
  if (!isUiScaleCapped(settings.uiScale, innerWidth, innerHeight)) return null;
  const percent = Math.round(effectiveUiScale(settings.uiScale, innerWidth, innerHeight) * 100);
  return `This window fits ${percent}%, so the menus are capped there.`;
};

/** The Graphics settings apply at start: a value other than the running one says so. */
export const graphicsStatus = (key: 'renderer' | 'graphicsDetail', setting: string, running: string): string | null => (
  setting === running ? null : `Applies after a reload (running: ${optionLabel(key, running as never)}).`
);

export type DeveloperToolsState = 'off' | 'on' | 'pending-on' | 'pending-off';

/** The setting is read once at start, so a difference from the running value waits for a reload. */
export const developerToolsState = (setting: boolean, running: boolean): DeveloperToolsState => {
  if (setting === running) return setting ? 'on' : 'off';
  return setting ? 'pending-on' : 'pending-off';
};

export const isDefault = (settings: Settings): boolean => (
  settingsEqual(settings, DEFAULT_SETTINGS)
);

export const persistenceNotice = (persistence: 'ok' | 'unavailable'): string | null => (
  persistence === 'unavailable' ? 'Not saved in this browser. Changes last until you close the tab.' : null
);
