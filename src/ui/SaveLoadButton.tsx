import { openSaveLoadDialog } from './openSaveLoad';

/**
 * The entry point shared by the HUD and the Parks menu, so both open the dialog the same way. Phase 34: its own module,
 * so the HUD does not pull the lazily loaded dialog in.
 */
export const SaveLoadButton = ({ className, children }: { className: string; children?: React.ReactNode }): React.JSX.Element => (
  <button
    className={className}
    onClick={openSaveLoadDialog}
    title="Save or load a park (Ctrl+S quick-saves)"
    aria-haspopup="dialog"
  >
    {children ?? <><span aria-hidden="true">⇅</span> Save / Load</>}
  </button>
);
