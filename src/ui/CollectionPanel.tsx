import { useId, useRef, useState } from 'react';
import { gameBridge } from '../app/gameBridge';
import type { ProfileSnapshot } from '../game/profile/types';
import { COLLECTION_TABS, buildCollection, moveCollectionTab, type CollectionTabId } from './collectionModel';
import { useUiStore } from './store';
import { CardBadges } from './CardTile';

interface CollectionPanelProps {
  onBack: () => void;
  /** Tests pass this; the menu leaves it out and the panel reads the store. */
  profile?: ProfileSnapshot | null;
  /** The tab shown first (tests); the menu opens on Buildings. */
  initialTab?: CollectionTabId;
}

/**
 * The Collection (Phase 22): what the profile has earned. Four tabs with automatic activation (one tab stop, arrows
 * move and select), the bonus switch as three native checkboxes. `collectionModel.ts` decides everything.
 */
export const CollectionPanel = ({ onBack, profile: profileProp, initialTab = 'buildings' }: CollectionPanelProps): React.JSX.Element => {
  const storeProfile = useUiStore((state) => state.profile);
  const profile = profileProp !== undefined ? profileProp : storeProfile;
  const [tab, setTab] = useState<CollectionTabId>(initialTab);
  const baseId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const model = buildCollection(profile);

  const onTabKey = (event: React.KeyboardEvent): void => {
    const current = ((event.target as HTMLElement).closest<HTMLElement>('[data-collection-tab]')?.dataset.collectionTab ?? tab) as CollectionTabId;
    const next = moveCollectionTab(current, event.key);
    if (next === null) return;
    event.preventDefault();
    setTab(next);
    listRef.current?.querySelector<HTMLElement>(`[data-collection-tab="${next}"]`)?.focus();
  };

  const summary: Record<CollectionTabId, string> = {
    buildings: model.buildingsSummary,
    cards: model.cardsSummary,
    bonuses: model.bonusesSummary,
    stats: '',
  };

  return (
    <section className="menu-picker collection-panel" aria-label="Collection">
      <h2>Collection</h2>
      {model.persistenceNote !== null && <p className="collection-persistence" role="status">{model.persistenceNote}</p>}
      <div className="collection-tabs" role="tablist" aria-label="Collection sections" ref={listRef} onKeyDown={onTabKey}>
        {COLLECTION_TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            id={`${baseId}-tab-${entry.id}`}
            aria-selected={tab === entry.id}
            aria-controls={tab === entry.id ? `${baseId}-panel-${entry.id}` : undefined}
            tabIndex={tab === entry.id ? 0 : -1}
            className={`collection-tab${tab === entry.id ? ' selected' : ''}`}
            data-collection-tab={entry.id}
            data-panel-focus={tab === entry.id ? '' : undefined}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}{summary[entry.id] === '' ? '' : <small> · {summary[entry.id]}</small>}
          </button>
        ))}
      </div>
      <div
        className="collection-body"
        role="tabpanel"
        id={`${baseId}-panel-${tab}`}
        aria-labelledby={`${baseId}-tab-${tab}`}
        tabIndex={-1}
      >
        {tab === 'buildings' && (
          <>
            <ul className="collection-list" aria-label="Buildings">
              {model.buildings.map((row) => (
                <li key={row.id} className={row.unlocked ? 'unlocked' : 'locked'} aria-label={row.label}>
                  <span className="collection-icon" aria-hidden="true">{row.unlocked ? row.icon : '🔒'}</span>
                  <span className="collection-text"><strong>{row.name}</strong><small>{row.detail}</small></span>
                </li>
              ))}
            </ul>
            <p className="collection-note">{model.buildingsNote}</p>
          </>
        )}
        {tab === 'cards' && (
          <>
            {model.cardFamilies.map((group) => (
              <section key={group.family} className="collection-family" aria-labelledby={`${baseId}-family-${group.family}`} data-collection-family={group.family}>
                <h3 id={`${baseId}-family-${group.family}`}>{group.label} <small>{group.summary}</small></h3>
                <ul className="collection-list">
                  {group.cards.map((card) => (
                    <li key={card.id} className={card.owned ? 'unlocked' : 'locked'}>
                      <span className="collection-icon" aria-hidden="true">{card.icon}</span>
                      <span className="collection-text">
                        <strong>{card.name}</strong>
                        {card.owned
                          ? (
                            <>
                              <CardBadges card={{ kind: card.kind ?? undefined, rarity: card.rarity, slotCost: card.slotCost }} />
                              <small className="collection-effects">
                                <span><span aria-hidden="true">▲</span><span className="sr-only">Upside: </span> {card.upside}</span>
                                <span><span aria-hidden="true">▼</span><span className="sr-only">Downside: </span> {card.downside}</span>
                              </small>
                            </>
                          )
                          : <small>{card.undiscoveredLine}</small>}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            <p className="collection-note">{model.cardsNote}</p>
          </>
        )}
        {tab === 'bonuses' && (
          <>
            <ul className="collection-list" aria-label="Permanent bonuses">
              {model.bonuses.map((bonus) => (
                <li key={bonus.id} className={bonus.earned ? 'unlocked' : 'locked'}>
                  <span className="collection-icon" aria-hidden="true">{bonus.earned ? bonus.icon : '🔒'}</span>
                  <span className="collection-text">
                    <strong>{bonus.name}{bonus.earned ? '' : <span className="sr-only"> (not earned)</span>}</strong>
                    <small>{bonus.earned ? `${bonus.summary.replace(/\.$/, '')} · ${bonus.detail}` : bonus.detail}</small>
                  </span>
                </li>
              ))}
            </ul>
            <fieldset className="collection-switches">
              <legend>Use permanent bonuses</legend>
              {model.bonusSwitches.map((row) => (
                <label key={row.mode}>
                  <input
                    type="checkbox"
                    checked={row.checked}
                    data-bonus-switch={row.mode}
                    onChange={(event) => gameBridge.setUseBonuses(row.mode, event.target.checked)}
                  />
                  <span>{row.label}</span>
                </label>
              ))}
              <p className="collection-note">{model.bonusNote}</p>
            </fieldset>
          </>
        )}
        {tab === 'stats' && (
          <>
          <table className="collection-stats">
            <caption className="sr-only">Parks per game mode</caption>
            <thead><tr><th scope="col">Mode</th><th scope="col">Parks started</th><th scope="col">Wins</th><th scope="col">Losses</th></tr></thead>
            <tbody>
              {model.stats.map((row) => (
                <tr key={row.mode}>
                  <th scope="row">{row.label}</th>
                  <td>{row.parksStarted}</td>
                  <td>{row.wins}</td>
                  <td>{row.losses}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="collection-stats" data-collection-runs>
            <caption>Runs on The Map · {model.runs.started} started</caption>
            <thead><tr><th scope="col">Difficulty</th><th scope="col">Best run</th><th scope="col">Won</th><th scope="col">Lost</th></tr></thead>
            <tbody>
              {model.runs.rows.map((row) => (
                <tr key={row.difficulty}>
                  <th scope="row">{row.label}</th>
                  <td>{row.best} levels</td>
                  <td>{row.victories}</td>
                  <td>{row.losses}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </>
        )}
      </div>
      <div className="pick-actions collection-actions">
        <button type="button" className="menu-back pick-back" data-pick-back onClick={onBack}>Back</button>
      </div>
    </section>
  );
};
