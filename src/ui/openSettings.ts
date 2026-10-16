import { useUiStore } from './store';

/** Opens the settings panel from anywhere (menus, non-React code). The panel is an input layer. */
export const openSettings = (): void => {
  useUiStore.getState().openSettings();
};

export const closeSettings = (): void => {
  useUiStore.getState().closeSettings();
};
