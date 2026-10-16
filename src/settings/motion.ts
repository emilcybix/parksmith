import type { MotionPreference, Settings, WeatherEffects } from './schema';
import { settingsEnv, settingsStore, type SettingsEnv, type SettingsStore } from './settingsStore';

/**
 * The ONE place that decides whether motion is reduced. The effective value is the player's
 * setting (System / On / Off) combined with the OS preference; every consumer (weather look,
 * see-through fade, hint pulse, camera sweep, CSS via `<html data-motion>`) reads it from here.
 * Nothing else may ask the OS media query (motion.consumers.test.ts scans the source).
 */
export const MOTION_ATTRIBUTE = 'data-motion';

export const resolveReducedMotion = (mode: MotionPreference, osReduce: boolean): boolean => (
  mode === 'system' ? osReduce : mode === 'on'
);

export interface PresentationPrefs {
  reducedMotion: boolean;
  weatherEffects: WeatherEffects;
  lightningFlashes: boolean;
}

export interface MotionModel {
  reducedMotion(): boolean;
  /** Fires when the EFFECTIVE value changes; never on subscribe. */
  onReducedMotionChange(cb: (reduced: boolean) => void): () => void;
  /** A reused object: read it, never mutate or keep a reference across changes you care about. */
  getPresentation(): PresentationPrefs;
  onPresentationChange(cb: (prefs: Readonly<PresentationPrefs>) => void): () => void;
}

export const createMotionModel = (store: SettingsStore, env: SettingsEnv): MotionModel => {
  const effective = (settings: Settings): boolean => resolveReducedMotion(settings.reducedMotion, env.osReducedMotion());
  const presentation: PresentationPrefs = {
    reducedMotion: effective(store.getState().settings),
    weatherEffects: store.getState().settings.weatherEffects,
    lightningFlashes: store.getState().settings.lightningFlashes,
  };
  const motionListeners = new Set<(reduced: boolean) => void>();
  const presentationListeners = new Set<(prefs: Readonly<PresentationPrefs>) => void>();
  let stopStore: (() => void) | null = null;
  let stopOs: (() => void) | null = null;

  const refresh = (): void => {
    const settings = store.getState().settings;
    const reduced = effective(settings);
    const motionChanged = reduced !== presentation.reducedMotion;
    const changed = motionChanged
      || settings.weatherEffects !== presentation.weatherEffects
      || settings.lightningFlashes !== presentation.lightningFlashes;
    presentation.reducedMotion = reduced;
    presentation.weatherEffects = settings.weatherEffects;
    presentation.lightningFlashes = settings.lightningFlashes;
    if (motionChanged) for (const cb of [...motionListeners]) cb(reduced);
    if (changed) for (const cb of [...presentationListeners]) cb(presentation);
  };

  const attach = (): void => {
    if (stopStore !== null) return;
    refresh(); // listeners attach lazily, so resync before the first change can be missed
    stopStore = store.subscribe(refresh);
    stopOs = env.onOsReducedMotionChange(refresh);
  };
  const detachIfIdle = (): void => {
    if (motionListeners.size > 0 || presentationListeners.size > 0) return;
    stopStore?.();
    stopOs?.();
    stopStore = null;
    stopOs = null;
  };
  const subscribe = <T>(set: Set<T>, cb: T): (() => void) => {
    set.add(cb);
    attach();
    return () => {
      set.delete(cb);
      detachIfIdle();
    };
  };

  return {
    reducedMotion: () => effective(store.getState().settings),
    onReducedMotionChange: (cb) => subscribe(motionListeners, cb),
    getPresentation: () => {
      if (stopStore === null) {
        // Nobody is listening, so the cached object may be stale: refresh it in place.
        const settings = store.getState().settings;
        presentation.reducedMotion = effective(settings);
        presentation.weatherEffects = settings.weatherEffects;
        presentation.lightningFlashes = settings.lightningFlashes;
      }
      return presentation;
    },
    onPresentationChange: (cb) => subscribe(presentationListeners, cb),
  };
};

const model = createMotionModel(settingsStore, settingsEnv);

/** Effective reduced-motion value NOW (setting combined with the OS preference). */
export const reducedMotion = (): boolean => model.reducedMotion();
export const onReducedMotionChange = (cb: (reduced: boolean) => void): (() => void) => model.onReducedMotionChange(cb);
export const getPresentation = (): PresentationPrefs => model.getPresentation();
export const onPresentationChange = (cb: (prefs: Readonly<PresentationPrefs>) => void): (() => void) => model.onPresentationChange(cb);
