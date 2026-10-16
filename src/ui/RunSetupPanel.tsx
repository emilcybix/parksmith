import { runBridge } from './runBridge';
import { useRef, useState } from 'react';
import type { ProfileSnapshot } from '../game/profile/types';
import type { SaveSlotMeta } from '../app/saves/types';
import { formatLastPlayed } from './saveLoadModel';
import { autosavedRunAtStake, latestRunSlot } from '../app/runSlots';
import { slotRunOf } from './modeLabels';
import type { RunDifficulty } from '../game/run/types';
import {
  DEFAULT_DIFFICULTY,
  buildRunSetup,
  describeContinueRun,
  nextDifficulty,
  randomSeedText,
  sanitiseDifficulty,
} from './runSetupModel';
import { useUiStore } from './store';
import { continueRunNote } from './runCopy';

interface RunSetupPanelProps {
  slots: readonly SaveSlotMeta[];
  profile: ProfileSnapshot | null;
  now: number;
  onBack: () => void;
}

/**
 * The Map's setup (menu panel `the-map`): Continue run when a run is saved, then a new run (seed, difficulty, the route
 * it makes) and Back. `runSetupModel.ts` decides every text and every rule; Enter in the seed field starts the run.
 */
export const RunSetupPanel = ({ slots, profile, now, onBack }: RunSetupPanelProps): React.JSX.Element => {
  const [draft, setDraft] = useState(() => ({ seedText: randomSeedText(Math.random), difficulty: DEFAULT_DIFFICULTY }));
  const panelRef = useRef<HTMLElement>(null);
  const pending = useUiStore((state) => state.saves.busy.loading !== null);
  // The same slot Continue run loads (the app's rule: the newest readable run save whose run has not ended).
  const runSlot = latestRunSlot(slots);
  const resumable = runSlot === null ? null : slotRunOf(runSlot);
  // The note names the run a new one would replace (the autosave's) before any run that is safe in its own slot.
  const atStake = autosavedRunAtStake(slots);
  const noted = atStake === null ? resumable : slotRunOf(atStake);
  const difficulty = sanitiseDifficulty(profile, draft.difficulty);
  const setup = buildRunSetup({ ...draft, difficulty }, profile, noted, atStake !== null);
  const card = resumable === null ? null : describeContinueRun(resumable);
  const continueNote = resumable === null ? null : continueRunNote(resumable);

  const start = (): void => {
    if (!setup.canStart || setup.seed === null) return;
    runBridge.startRun(setup.seed, difficulty);
  };

  const onDifficultyKey = (event: React.KeyboardEvent): void => {
    const focused = (event.target as HTMLElement).closest<HTMLElement>('[data-run-difficulty]')?.dataset.runDifficulty as RunDifficulty | undefined;
    const move = nextDifficulty(profile, focused ?? difficulty, event.key);
    if (move === null) return;
    event.preventDefault();
    // Focus goes to every difficulty (a locked one reads its unlock text); selection follows only onto an open one.
    if (move.canSelect) setDraft((previous) => ({ ...previous, difficulty: move.focus }));
    panelRef.current?.querySelector<HTMLElement>(`[data-run-difficulty="${move.focus}"]`)?.focus();
  };

  return (
    <section className="menu-picker menu-run-setup" aria-label="The Map" ref={panelRef}>
      <h2>The Map</h2>
      <p className="menu-picker-lead">{setup.intro}</p>
      {card !== null && runSlot !== null && (
        <button
          type="button"
          className="run-continue-card"
          data-run-continue
          data-panel-focus
          aria-disabled={pending}
          onClick={() => { if (!pending) void runBridge.continueRun(); }}
        >
          <span className="run-continue-title">Continue run</span>
          <span className="run-continue-level">{card.title}</span>
          <span className="run-continue-sub">
            {card.subtitle}{card.atMap ? ' · at the run map' : ''} · {formatLastPlayed(runSlot.savedAt, now)}
          </span>
          {continueNote !== null && <span className="run-continue-note" data-run-continue-note>{continueNote}</span>}
        </button>
      )}
      <div className="pick-controls run-new" role="group" aria-label="New run">
        <h3 className="run-new-title">New run</h3>
        <div className="pick-field">
          <label htmlFor="run-seed">Seed</label>
          <input
            id="run-seed"
            className="pick-seed"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            maxLength={12}
            value={draft.seedText}
            aria-invalid={setup.seedError !== null}
            aria-describedby="run-seed-help"
            data-run-seed
            onChange={(event) => setDraft((previous) => ({ ...previous, seedText: event.target.value }))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                start();
              } else if (event.key === 'Escape') {
                // Escape in a text field is the field's (the menu ignores it): it leaves the field for the difficulty.
                event.preventDefault();
                panelRef.current?.querySelector<HTMLElement>(`[data-run-difficulty="${difficulty}"]`)?.focus();
              }
            }}
          />
          <button type="button" className="pick-reroll" data-run-reroll onClick={() => setDraft((previous) => ({ ...previous, seedText: randomSeedText(Math.random) }))}>
            Random seed
          </button>
        </div>
        <p id="run-seed-help" className={`pick-seed-help${setup.seedError === null ? '' : ' error'}`} aria-live="polite">
          {setup.seedError ?? 'The same seed and difficulty always make the same run.'}
        </p>
        <div className="pick-field run-difficulty-field">
          <span id="run-difficulty-label">Difficulty</span>
          <div className="run-difficulties" role="radiogroup" aria-labelledby="run-difficulty-label" onKeyDown={onDifficultyKey}>
            {setup.difficulties.map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={option.selected}
                aria-disabled={option.locked !== null}
                aria-describedby={`run-difficulty-${option.id}`}
                tabIndex={option.selected ? 0 : -1}
                className={`run-difficulty${option.selected ? ' selected' : ''}${option.locked === null ? '' : ' locked'}`}
                data-run-difficulty={option.id}
                onClick={() => { if (option.locked === null) setDraft((previous) => ({ ...previous, difficulty: option.id })); }}
              >
                <span className="run-difficulty-label">{option.label}{option.locked === null ? '' : ' 🔒'}</span>
                <span id={`run-difficulty-${option.id}`} className="run-difficulty-detail">{option.locked ?? option.detail}</span>
              </button>
            ))}
          </div>
        </div>
        <p className="run-route" data-run-route>
          {setup.route === null ? 'Enter a seed to see the route.' : (
            <>
              <b>Route</b> {setup.route}
              {setup.starterDeck !== null && <><br /><span>{setup.starterDeck}</span></>}
            </>
          )}
        </p>
        {setup.replaceNote !== null && <p className="run-replace-note" data-run-replace-note>{setup.replaceNote}</p>}
      </div>
      <div className="pick-actions">
        <button
          type="button"
          className={`menu-entry primary pick-start${setup.canStart ? '' : ' waiting'}`}
          data-run-start
          data-panel-focus={card === null ? '' : undefined}
          aria-disabled={!setup.canStart}
          onClick={start}
        >
          <span className="menu-entry-label">Start run</span>
        </button>
        <button type="button" className="menu-back pick-back" data-run-back onClick={onBack}>Back</button>
      </div>
    </section>
  );
};

