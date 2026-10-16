import { beforeEach, describe, expect, it } from 'vitest';
import { activeInputContext } from './inputContext';
import { EMPTY_UNDO_STATUS } from '../app/undo/constants';
import { DEFAULT_RECOVERY_SNAPSHOT, DEFAULT_SAVES_SNAPSHOT, useUiStore } from './store';

/**
 * The tool state machine PA-007 rests on: something is always armed, only the player changes it,
 * and Escape steps back to the pointer rather than to nothing. A regression here is what let a
 * stray click in the world leave the player empty-handed.
 */
describe('tool state machine', () => {
  beforeEach(() => {
    useUiStore.getState().selectPointer();
  });

  it('always has exactly one armed tool', () => {
    const store = useUiStore.getState();
    expect(store.tool).toBe('pointer');
    store.selectBuild('petal-roundabout');
    expect(useUiStore.getState().tool).toBe('build');
    useUiStore.getState().selectBulldozer();
    expect(useUiStore.getState().tool).toBe('bulldoze');
    useUiStore.getState().selectPointer();
    expect(useUiStore.getState().tool).toBe('pointer');
  });

  it('steps back to the pointer on cancel, never to an empty tool', () => {
    useUiStore.getState().selectBuild('sunstone-path');
    useUiStore.getState().cancelTool();
    const state = useUiStore.getState();
    expect(state.tool).toBe('pointer');
    expect(state.selectedDefinitionId).toBeNull();
    expect(state.previewCost).toBe(0);
    // A second Escape has nothing left to pop: the pointer is the resting layer.
    expect(activeInputContext(state)).toBe('world');
  });

  it('keeps the armed definition when only the category changes', () => {
    useUiStore.getState().selectBuild('petal-roundabout');
    useUiStore.getState().setCategory('scenery');
    const state = useUiStore.getState();
    expect(state.tool).toBe('build');
    expect(state.selectedDefinitionId).toBe('petal-roundabout');
  });

  it('drops the armed definition when the bulldozer is armed, so no ghost lingers', () => {
    useUiStore.getState().selectBuild('petal-roundabout');
    useUiStore.getState().selectBulldozer();
    expect(useUiStore.getState().selectedDefinitionId).toBeNull();
  });
});

/**
 * The save slice is written only by the manager and read by the dialog, the banner and the
 * indicator; the dialog flag is an input context layer.
 */
describe('saves slice', () => {
  beforeEach(() => {
    useUiStore.getState().closeSavesDialog();
    useUiStore.getState().setSavesSnapshot(DEFAULT_SAVES_SNAPSHOT);
  });

  it('starts with persistence still being checked, so no failure flashes on boot', () => {
    expect(useUiStore.getState().saves.persistence.state).toBe('checking');
    expect(useUiStore.getState().saves.slots).toEqual([]);
  });

  it('replaces the snapshot as a whole and leaves the rest of the HUD state alone', () => {
    const cashBefore = useUiStore.getState().cash;
    const next = { ...DEFAULT_SAVES_SNAPSHOT, unsavedChanges: true, quickSaveSlotId: 'manual-2' as const };
    useUiStore.getState().setSavesSnapshot(next);
    expect(useUiStore.getState().saves).toBe(next);
    expect(useUiStore.getState().cash).toBe(cashBefore);
  });

  it('opens and closes the dialog and takes the keyboard while it is open', () => {
    useUiStore.getState().openSavesDialog();
    expect(activeInputContext(useUiStore.getState())).toBe('saveLoad');
    useUiStore.getState().closeSavesDialog();
    expect(activeInputContext(useUiStore.getState())).not.toBe('saveLoad');
  });
});

describe('undo and recovery slices', () => {
  it('starts with undo closed for the stated reason and recovery still checking', () => {
    const state = useUiStore.getState();
    expect(state.undoStatus, 'the dock button reads this before the first gesture').toBe(EMPTY_UNDO_STATUS);
    expect(state.undoStatus.canUndo).toBe(false);
    expect(state.recovery, 'the prompt must not flash before detection ran').toBe(DEFAULT_RECOVERY_SNAPSHOT);
    expect(state.recovery.phase).toBe('checking');
  });

  it('takes the controller snapshot as is and opens the recovery input layer for an offer', () => {
    useUiStore.getState().setRecoverySnapshot({ phase: 'offered', offer: null, error: null, notice: null });
    expect(activeInputContext(useUiStore.getState())).toBe('recovery');
    useUiStore.getState().setRecoverySnapshot(DEFAULT_RECOVERY_SNAPSHOT);
    expect(activeInputContext(useUiStore.getState())).not.toBe('recovery');
  });

  it('remembers which recovery banner was closed', () => {
    useUiStore.getState().dismissRecoveryBanner('notice:3');
    expect(useUiStore.getState().recoveryBannerDismissedKey).toBe('notice:3');
    useUiStore.setState({ recoveryBannerDismissedKey: null });
  });
});

describe('clean view', () => {
  it('toggles without touching the armed tool, the build selection or open panels', () => {
    const store = useUiStore;
    store.getState().selectBuild('sunstone-path');
    store.getState().openManagement('overview');
    const before = store.getState();
    store.getState().toggleCleanView();
    expect(store.getState().cleanView).toBe(true);
    expect(store.getState().tool).toBe(before.tool);
    expect(store.getState().selectedDefinitionId).toBe(before.selectedDefinitionId);
    expect(store.getState().managementOpen).toBe(true);
    store.getState().toggleCleanView();
    expect(store.getState().cleanView).toBe(false);
    store.getState().closeManagement();
    store.getState().selectPointer();
  });
});

/** Phase 28 step 2: the Paint tool's UI state. Session-only: nothing here is saved, hashed or undone. */
describe('paint tool state', () => {
  beforeEach(() => {
    useUiStore.getState().selectPointer();
    useUiStore.setState({ paintBrush: { kind: 'default' }, paintTarget: 'primary', paintPicking: false, paintPanelOpen: false, paintReadout: null });
  });

  it('arms as one more tool: it replaces the armed card, is exactly one tool at a time, and is a build-capability context', () => {
    useUiStore.getState().selectBuild('petal-roundabout');
    useUiStore.getState().selectPaint();
    const state = useUiStore.getState();
    expect(state.tool).toBe('paint');
    expect(state.selectedDefinitionId).toBeNull();
    expect(state.paintPicking).toBe(false);
    expect(activeInputContext(state)).toBe('build');
    useUiStore.getState().selectBulldozer();
    expect(useUiStore.getState().tool).toBe('bulldoze');
  });

  it('arms in pick mode on request, and leaving the tool by any route ends pick mode', () => {
    useUiStore.getState().selectPaint(true);
    expect(useUiStore.getState().paintPicking).toBe(true);
    useUiStore.getState().selectBuild('ribbon-bench');
    expect(useUiStore.getState().paintPicking).toBe(false);
    useUiStore.getState().selectPaint(true);
    useUiStore.getState().selectBulldozer();
    expect(useUiStore.getState().paintPicking).toBe(false);
    useUiStore.getState().selectPaint(true);
    useUiStore.getState().selectPointer();
    expect(useUiStore.getState().paintPicking).toBe(false);
  });

  it('Escape (cancelTool) puts it down, closes the panel and the readout, and KEEPS the brush for next time', () => {
    useUiStore.getState().selectPaint();
    useUiStore.getState().setPaintBrush({ kind: 'swatch', swatch: 19 });
    useUiStore.getState().setPaintTarget('all');
    useUiStore.getState().setPaintPanelOpen(true);
    useUiStore.setState({ paintReadout: { title: 'x', detail: 'y', muted: false } });
    useUiStore.getState().cancelTool();
    const state = useUiStore.getState();
    expect(state.tool).toBe('pointer');
    expect(state.paintPanelOpen).toBe(false);
    expect(state.paintReadout).toBeNull();
    expect(state.paintBrush).toEqual({ kind: 'swatch', swatch: 19 });
    expect(state.paintTarget).toBe('all');
    expect(activeInputContext(state)).toBe('world');
  });

  it('starts as the default brush on Main, with the panel closed', () => {
    const state = useUiStore.getState();
    expect(state.paintBrush).toEqual({ kind: 'default' });
    expect(state.paintTarget).toBe('primary');
    expect(state.paintPanelOpen).toBe(false);
  });
});

/**
 * Phase 11 (PA-009, PA-015, PA-024): the app-published fields start neutral, and the demolish confirmation is plain UI
 * state that opens on one object and closes without touching the selection or the tool.
 */
describe('Phase 11 fields', () => {
  it('start neutral before GameApp publishes anything', () => {
    const fresh = useUiStore.getInitialState();
    expect(fresh.guestCapacity).toBeNull();
    expect(fresh.atCapacity).toBe(false);
    expect(fresh.noPathAccessIds).toEqual([]);
    expect(fresh.selectedDemolitionRefund).toBeNull();
    expect(fresh.demolishConfirmId).toBeNull();
  });

  it('opens and closes the demolish confirmation for one object, leaving the tool alone', () => {
    useUiStore.getState().selectPointer();
    useUiStore.getState().openDemolishConfirm(7);
    expect(useUiStore.getState().demolishConfirmId).toBe(7);
    expect(useUiStore.getState().tool).toBe('pointer');
    useUiStore.getState().openDemolishConfirm(9);
    expect(useUiStore.getState().demolishConfirmId).toBe(9);
    useUiStore.getState().closeDemolishConfirm();
    expect(useUiStore.getState().demolishConfirmId).toBeNull();
  });
});
