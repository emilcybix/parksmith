import { saveBridge } from '../app/gameBridge';
import { useUiStore } from './store';

/** Reads the list fresh each time the dialog opens: another tab may have saved since. */
export const openSaveLoadDialog = (): void => {
  useUiStore.getState().openSavesDialog();
  void saveBridge.refresh();
};
