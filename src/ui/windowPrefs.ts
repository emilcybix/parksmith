import { DEFAULT_BUILDINGS_VIEW, parseBuildingsView, type BuildingsView } from './buildingsWindowModel';

/**
 * Phase 42: per-player window preferences (which windows were open, the Buildings window's filters and sort), kept in
 * the browser's local storage. Presentation only: never in a save. Every access is guarded, so a browser that refuses
 * storage (private mode, tests without a window) simply forgets.
 */
export type WindowId = 'staff' | 'buildings';
export const WINDOW_IDS: readonly WindowId[] = ['staff', 'buildings'];

const KEY = 'parksmith-windows';

interface StoredWindows {
  open: WindowId[];
  buildings: BuildingsView;
}

const storage = (): Storage | null => {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
};

export const loadWindowPrefs = (): StoredWindows => {
  try {
    const raw = storage()?.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const open = Array.isArray(parsed.open) ? parsed.open.filter((id): id is WindowId => WINDOW_IDS.includes(id as WindowId)) : [];
    return { open: [...new Set(open)], buildings: parseBuildingsView(parsed.buildings) };
  } catch {
    return { open: [], buildings: { ...DEFAULT_BUILDINGS_VIEW } };
  }
};

export const saveWindowPrefs = (prefs: StoredWindows): void => {
  try {
    storage()?.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Storage full or refused: the preference is simply not remembered.
  }
};
