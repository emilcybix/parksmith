import { useStore } from 'zustand';
import type { KeybindingOverrides } from './keybindings';
import { settingsStore } from './settingsStore';

/** The player's key overrides; re-renders the component when a binding changes (also from another tab). */
export const useKeybindings = (): KeybindingOverrides => useStore(settingsStore, (state) => state.settings.keybindings);
