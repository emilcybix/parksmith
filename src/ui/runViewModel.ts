import type { RunSnapshot } from '../game/run/types';

/**
 * The run overlay's views. The app opens the overlay and sets 'map', 'stage-result' or 'end'; the screens move between
 * 'map', 'offer' and 'loadout'. A view that does not match the run's phase is never shown: it reads as the one that
 * does, so a late or stale value cannot show the wrong screen.
 */
export type RunView = 'map' | 'offer' | 'loadout' | 'stage-result' | 'end';

export const effectiveRunView = (run: RunSnapshot | null, view: RunView | null): RunView | null => {
  if (view === null || run === null) return null;
  if (run.phase === 'won' || run.phase === 'lost') return 'end';
  switch (view) {
    case 'offer': return run.phase === 'offer' ? 'offer' : 'map';
    case 'loadout': return run.phase === 'loadout' ? 'loadout' : 'map';
    case 'end': return 'map';
    default: return view;
  }
};
