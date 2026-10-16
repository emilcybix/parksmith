import { useRef, useState } from 'react';
import { gameBridge } from '../app/gameBridge';
import { MapPreview } from './MapPreview';
import {
  buildScenarioBrowser,
  initialScenarioSelection,
  moveScenarioSelection,
} from './scenarioBrowserModel';
import { useUiStore } from './store';
import type { SaveSlotMeta } from '../app/saves/types';
import type { ProfileSnapshot } from '../game/profile/types';
import type { ScenarioId } from '../game/scenarios/types';

interface ScenarioBrowserProps {
  onBack: () => void;
  /** Tests pass these; the menu leaves them out and the browser reads the store. */
  profile?: ProfileSnapshot | null;
  slots?: readonly SaveSlotMeta[];
}

/**
 * The Scenario browser (Phase 22): nine scenarios in a radio group (roving tab stop, arrows select as they move,
 * Enter starts), the detail of the selected one beside it. Locked scenarios stay listed with their condition and the
 * Start button of a locked one stays focusable, `aria-disabled`, and says why. `scenarioBrowserModel.ts` decides.
 */
export const ScenarioBrowser = ({ onBack, profile: profileProp, slots: slotsProp }: ScenarioBrowserProps): React.JSX.Element => {
  const storeProfile = useUiStore((state) => state.profile);
  const storeSlots = useUiStore((state) => state.saves.slots);
  const profile = profileProp !== undefined ? profileProp : storeProfile;
  const slots = slotsProp ?? storeSlots;
  const [selectedId, setSelectedId] = useState<ScenarioId>(() => initialScenarioSelection(profile));
  const panelRef = useRef<HTMLElement>(null);
  const model = buildScenarioBrowser(profile, selectedId, slots);
  const detail = model.detail;

  const start = (): void => {
    if (!detail.canStart) return;
    useUiStore.getState().openScenarioLoadout(detail.id);
  };

  const onRowKey = (event: React.KeyboardEvent): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      start();
      return;
    }
    // The focused radio is the truth even when React has not rendered the previous key yet.
    const current = ((event.target as HTMLElement).closest<HTMLElement>('[data-scenario-row]')?.dataset.scenarioRow ?? selectedId) as ScenarioId;
    const next = moveScenarioSelection(current, event.key);
    if (next === null) return;
    event.preventDefault();
    setSelectedId(next);
    panelRef.current?.querySelector<HTMLElement>(`[data-scenario-row="${next}"]`)?.focus();
  };

  return (
    <section className="menu-picker scenario-browser" aria-label="Scenarios" ref={panelRef}>
      <h2>Scenarios <small className="browser-count">{model.clearedCount} of {model.total} cleared</small></h2>
      <div className="browser-body">
        <div className="browser-rows" role="radiogroup" aria-label="Scenarios" onKeyDown={onRowKey}>
          {model.rows.map((row) => (
            <button
              key={row.id}
              type="button"
              role="radio"
              aria-checked={row.selected}
              tabIndex={row.selected ? 0 : -1}
              className={`browser-row ${row.status}${row.selected ? ' selected' : ''}`}
              data-scenario-row={row.id}
              data-panel-focus={row.selected ? '' : undefined}
              aria-label={`${row.name}. Difficulty: ${row.difficultyLabel}. ${row.statusLabel.replace('🔒 ', '')}.`}
              onClick={() => setSelectedId(row.id)}
            >
              <span className="browser-row-name" aria-hidden="true">{row.name}</span>
              <span className="browser-row-meta" aria-hidden="true">
                <span className="browser-dots">{row.dots}</span> {row.difficultyLabel}
              </span>
              <span className={`browser-chip ${row.status}`} aria-hidden="true">{row.statusLabel}</span>
              {row.savedSlotId !== null && <span className="browser-chip saved" aria-hidden="true">Saved park</span>}
            </button>
          ))}
        </div>
        <article className="browser-detail" aria-label={`${detail.name} details`} data-scenario-detail={detail.id}>
          <div className="browser-detail-head">
            <figure className="browser-preview">
              <MapPreview image={detail.preview} label={detail.previewLabel} className="browser-preview-canvas" />
            </figure>
            <div>
              <h3>{detail.name}</h3>
              <p className="browser-place">{detail.place}</p>
              <p className="browser-tagline">{detail.tagline}</p>
            </div>
          </div>
          <p className="browser-objective"><strong>Goal:</strong> {detail.objective}</p>
          <p className="browser-facts">{detail.facts}</p>
          <p className="browser-condition">{detail.condition}</p>
          <p className="browser-best">{detail.best}</p>
          <ul className="browser-rewards" aria-label="Rewards">
            {detail.rewards.map((line) => (
              <li key={line.text} className={line.earned ? 'earned' : undefined}>
                {line.text}{line.earned ? ' · earned ✓' : ''}
              </li>
            ))}
          </ul>
          {detail.lockedReason !== null && <p className="browser-locked" id="browser-locked-reason">{detail.lockedReason}</p>}
        </article>
      </div>
      <div className="pick-actions browser-actions">
        <button
          type="button"
          className="menu-entry primary pick-start"
          data-scenario-start
          aria-disabled={!detail.canStart}
          aria-describedby={detail.lockedReason === null ? undefined : 'browser-locked-reason'}
          onClick={start}
        >
          <span className="menu-entry-label">{detail.startLabel}</span>
        </button>
        {detail.savedSlotId !== null && (
          <button
            type="button"
            className="menu-back pick-back"
            data-scenario-resume
            onClick={() => { const slotId = detail.savedSlotId; if (slotId !== null) void gameBridge.menuLoadSlot(slotId); }}
          >
            Resume saved park
          </button>
        )}
        <button type="button" className="menu-back pick-back" data-pick-back onClick={onBack}>Back</button>
      </div>
    </section>
  );
};
