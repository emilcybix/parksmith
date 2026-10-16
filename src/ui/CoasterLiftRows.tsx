import { gameBridge } from '../app/gameBridge';
import { ariaKeyShortcuts, withKeyHint, type KeybindingOverrides } from '../settings';
import { liftRowModels } from './coasterLiftRowsModel';
import type { DraftLiftRun } from './store';

/** The designer's "LIFT HILLS" block: one row per climb with its chain or free toggle. */
export const CoasterLiftRows = ({ runs, chainSavings, keys }: {
  runs: readonly DraftLiftRun[];
  chainSavings: number;
  keys: KeybindingOverrides;
}): React.JSX.Element | null => {
  if (runs.length === 0) return null;
  return (
    <div className="coaster-lift-rows" role="group" aria-label="Lift hills">
      <small>LIFT HILLS · CHAIN OR FREE CLIMB</small>
      {liftRowModels(runs).map((row) => (
        <div className="coaster-lift-row" key={row.start}>
          <span>{row.label}</span>
          {row.badge && <b className={`lift-badge ${row.badgeTone}`}>{row.badge}</b>}
          <button
            className={row.chained ? 'active' : ''}
            aria-pressed={row.chained}
            aria-label={`${row.label}: ${row.chained ? 'chain lift' : 'free climb'}`}
            aria-keyshortcuts={ariaKeyShortcuts('coasterToggleLift', keys)}
            title={withKeyHint(row.chained
              ? 'Chain lift: steady climb. Click to let it climb free.'
              : 'Free climb: the train slows on the way up. Click to add a chain.', 'coasterToggleLift', keys)}
            onClick={() => gameBridge.coasterSetLift(row.start, !row.chained)}
          >{row.chained ? 'Chain' : 'Free'}</button>
        </div>
      ))}
      {chainSavings > 0 && <em>Free climbs save ${chainSavings.toLocaleString()}</em>}
    </div>
  );
};
