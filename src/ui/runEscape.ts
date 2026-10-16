import { runBridge } from './runBridge';
import { useUiStore } from './store';
import { effectiveRunView } from './runViewModel';

/**
 * What Escape does in the two run layers (the input contexts `runMap` and `leaveRun`). GameApp's `popInputContext`
 * calls this for those two contexts, exactly as it calls the store for the others.
 */
export const escapeRunLayer = (context: 'runMap' | 'leaveRun'): void => {
  const state = useUiStore.getState();
  if (context === 'leaveRun') {
    runBridge.resolveLeaveRun('cancel');
    return;
  }
  if (state.runDrawer !== null) {
    state.setRunDrawer(null);
    return;
  }
  const view = effectiveRunView(state.run, state.runView);
  if (view === 'offer' || view === 'loadout') {
    state.setRunView('map');
    return;
  }
  // The cleared-level screen and the end screens are answered with their buttons (nothing is lost by pressing Escape).
  if (view === 'map') runBridge.closeRunMap();
};
