import { useEffect, useRef, useState } from 'react';
import { runBridge } from './runBridge';
import { useModalFocus } from './a11yHooks';
import { activeInputContext } from './inputContext';
import { MapPreview } from './MapPreview';
import type { MapPreviewImage } from '../game/maps/preview';
import type { RunSnapshot } from '../game/run/types';
import type { RunRewardResult } from '../game/profile/types';
import {
  DECK_EMPTY_TEXT,
  USED_EMPTY_TEXT,
  buildRunMap,
  defaultSelectedLevel,
  deckRowsOf,
  moveLevelFocus,
  usedRowsOf,
  type RunMapNode,
} from './runMapModel';
import { buildRunOffer, canAcceptOffer, offerPayload, togglePick, type OfferCard } from './runOfferModel';
import { buildRunLoadout, sanitiseLoadout, type LoadoutDeckCard } from './runLoadoutModel';
import { buildRunEnd, buildStageResult } from './runResultModel';
import { cachedLevelPreview, levelPreviewOf } from './runPreview';
import { effectiveRunView, type RunView } from './runViewModel';
import { useUiStore } from './store';
import { CardTile } from './CardTile';

/**
 * The Map's overlay (Phase 23): the run map, the offer, the loadout, the cleared-level screen and the run-over / victory
 * screen. Pure models decide everything (`run*Model.ts`); this renders and moves focus. The app opens and closes the
 * overlay (`runView`), the screens move between map, offer and loadout. One full-screen layer, input context `runMap`.
 */
export const RunScreen = (): React.JSX.Element | null => {
  const run = useUiStore((state) => state.run);
  const requested = useUiStore((state) => state.runView);
  const view = effectiveRunView(run, requested);
  if (run === null || view === null) return null;
  return <RunOverlay run={run} view={view} />;
};

const RunOverlay = ({ run, view }: { run: RunSnapshot; view: RunView }): React.JSX.Element => {
  const rootRef = useRef<HTMLDivElement>(null);
  // Inert while another layer owns the keyboard (the leave-run question, Settings, Save / Load, the recovery prompt).
  const topmost = useUiStore((state) => activeInputContext(state) === 'runMap');
  const resetSelection = useUiStore((state) => state.resetRunLoadoutSelection);
  // Focus moves into the layer when it opens, Tab stays inside it and focus returns to what opened it.
  useModalFocus(true, rootRef, '[data-run-focus]');
  // Moving between views replaces the focused control: put focus on the new view's first one.
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) { firstView.current = false; return; }
    rootRef.current?.querySelector<HTMLElement>('[data-run-focus]')?.focus();
  }, [view]);
  // A new level starts with an empty loadout (a stale tick must never carry a card into another level).
  useEffect(() => { resetSelection(); }, [run.levelIndex, resetSelection]);
  return (
    <div ref={rootRef} className="scenario-picker-backdrop run-backdrop" role="dialog" aria-modal="true" aria-labelledby="run-title" data-run-view={view} inert={!topmost}>
      <section className="run-screen">
        {view === 'map' && <MapView run={run} />}
        {view === 'offer' && <OfferView run={run} />}
        {view === 'loadout' && <LoadoutView run={run} />}
        {view === 'stage-result' && <StageResultView run={run} />}
        {view === 'end' && <EndView run={run} />}
      </section>
    </div>
  );
};

// --- Shared pieces -------------------------------------------------------------------------------------

const ScreenHead = ({ kicker, title, onClose, closeLabel }: { kicker: string; title: string; onClose?: () => void; closeLabel?: string }): React.JSX.Element => (
  <header className="run-head">
    <span>
      <small>{kicker}</small>
      <strong id="run-title" role="heading" aria-level={2} tabIndex={-1} data-run-title>{title}</strong>
    </span>
    {onClose !== undefined && (
      <button type="button" className="run-close" onClick={onClose} title="Close (Esc)" aria-label={closeLabel ?? 'Close'}><span aria-hidden="true">×</span></button>
    )}
  </header>
);

const Conditions = ({ conditions }: { conditions: Array<{ id: string; icon: string; name: string; detail: string }> }): React.JSX.Element | null => (
  conditions.length === 0 ? null : (
    <ul className="run-conditions">
      {conditions.map((condition) => (
        <li key={condition.id}><span aria-hidden="true">{condition.icon}</span> <b>{condition.name}</b> — {condition.detail}</li>
      ))}
    </ul>
  )
);

/** Previews are built one level per tick, so opening the map never freezes on five generated maps at once. */
const useLevelPreviews = (run: RunSnapshot): ReadonlyMap<number, MapPreviewImage> => {
  const [images, setImages] = useState<ReadonlyMap<number, MapPreviewImage>>(() => {
    const known = new Map<number, MapPreviewImage>();
    run.levels.forEach((level, index) => { const image = cachedLevelPreview(level.recipe); if (image !== null) known.set(index, image); });
    return known;
  });
  const key = run.levels.map((level) => `${level.recipe.biomeId}:${level.recipe.seed}:${level.recipe.density}:${level.recipe.water}`).join('|');
  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const next = new Map<number, MapPreviewImage>();
    const step = (index: number): void => {
      if (cancelled || index >= run.levels.length) return;
      try {
        const known = cachedLevelPreview(run.levels[index].recipe);
        next.set(index, known ?? levelPreviewOf(run.levels[index].recipe));
        setImages(new Map(next));
      } catch {
        // A recipe this build cannot make has no preview; the card keeps its swatches.
      }
      timer = window.setTimeout(() => step(index + 1), 0);
    };
    timer = window.setTimeout(() => step(0), 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  // The recipes are the run's fixed levels; the key says when they change.
  }, [key]);
  return images;
};

// --- The run map ----------------------------------------------------------------------------------------

const MapView = ({ run }: { run: RunSnapshot }): React.JSX.Element => {
  const [picked, setPicked] = useState<number | null>(null);
  const [confirmAbandon, setConfirmAbandon] = useState(false);
  const drawer = useUiStore((state) => state.runDrawer);
  const setDrawer = useUiStore((state) => state.setRunDrawer);
  const setView = useUiStore((state) => state.setRunView);
  const previews = useLevelPreviews(run);
  const pathRef = useRef<HTMLDivElement>(null);
  const selected = picked ?? defaultSelectedLevel(run);
  const model = buildRunMap(run, selected);

  // Opening a drawer brings it into view inside the scrolling body (it is the last thing in it and opens below the fold on a short
  // screen). The body is scrolled itself: scrollIntoView would also scroll the page behind the overlay.
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const body = bodyRef.current;
    if (drawer !== null && body !== null) body.scrollTop = body.scrollHeight;
  }, [drawer]);

  // The abandon question replaces the footer's buttons: focus follows into it and back out to the button that opened it.
  const askedAbandon = useRef(false);
  useEffect(() => {
    if (confirmAbandon) {
      askedAbandon.current = true;
      document.querySelector<HTMLElement>('[data-run-abandon-cancel]')?.focus();
    } else if (askedAbandon.current) {
      askedAbandon.current = false;
      document.querySelector<HTMLElement>('[data-run-abandon]')?.focus();
    }
  }, [confirmAbandon]);

  if (model === null) return <ScreenHead kicker="THE MAP" title="Nothing to show" onClose={() => runBridge.closeRunMap()} closeLabel="Close the run map" />;

  const focusNode = (index: number): void => {
    pathRef.current?.querySelector<HTMLElement>(`[data-run-node="${index}"]`)?.focus();
  };
  const onPathKey = (event: React.KeyboardEvent): void => {
    const current = Number((event.target as HTMLElement).closest<HTMLElement>('[data-run-node]')?.dataset.runNode ?? selected);
    const next = moveLevelFocus(model.nodes.length, current, event.key);
    if (next === null) return;
    event.preventDefault();
    setPicked(next);
    focusNode(next);
  };

  const primary = (): void => {
    if (model.primary.id === 'see-offer') setView('offer');
    else if (model.primary.id === 'choose-cards') setView('loadout');
    else if (model.primary.id === 'back-to-park') runBridge.closeRunMap();
  };
  const closeLabel = run.phase === 'stage' ? 'Back to the park' : 'Close the run map';

  return (
    <>
      <ScreenHead kicker={model.kicker} title={model.heading} onClose={() => runBridge.closeRunMap()} closeLabel={closeLabel} />
      <div className="run-body" ref={bodyRef}>
        <div className="run-path" role="radiogroup" aria-label="Levels" ref={pathRef} onKeyDown={onPathKey}>
          {model.nodes.map((node) => (
            <NodeCard key={node.index} node={node} image={previews.get(node.index) ?? null} onSelect={() => setPicked(node.index)} />
          ))}
        </div>
        <section className="run-detail" aria-label={`Level ${model.detail.index + 1} details`} data-run-detail>
          <h3>{model.detail.heading} <small>{model.detail.climateLabel}</small></h3>
          <p className="run-detail-goal">{model.detail.objectiveSentence}</p>
          <p className="run-detail-facts">
            <span>{model.detail.deadline}</span><span>{model.detail.startingCash}</span><span>{model.detail.slots}</span><span>{model.detail.offer}</span>
          </p>
          <Conditions conditions={model.detail.conditions} />
          {model.detail.conditions.length === 0 && <p className="run-detail-quiet">No conditions on this level.</p>}
          {model.detail.resultLines.length > 0 && (
            <ul className="run-detail-result">{model.detail.resultLines.map((line) => <li key={line}>{line}</li>)}</ul>
          )}
        </section>
        <p className="run-summary" data-run-summary>{model.summary}</p>
        <div className="run-toolbar">
          <button type="button" className="run-chip" aria-expanded={drawer === 'deck'} aria-controls={drawer === 'deck' ? 'run-drawer' : undefined} data-run-deck onClick={() => setDrawer(drawer === 'deck' ? null : 'deck')}>{model.deckLabel}</button>
          <button type="button" className="run-chip" aria-expanded={drawer === 'used'} aria-controls={drawer === 'used' ? 'run-drawer' : undefined} data-run-used onClick={() => setDrawer(drawer === 'used' ? null : 'used')}>{model.usedLabel}</button>
        </div>
        {drawer !== null && <Drawer run={run} kind={drawer} />}
      </div>
      <footer className="run-foot">
        {confirmAbandon ? (
          <div className="run-confirm" role="group" aria-label="Abandon the run">
            <span>Abandon this run? It ends as a loss at level {run.levelIndex + 1}.</span>
            <button type="button" className="danger" data-run-abandon-confirm onClick={() => { setConfirmAbandon(false); runBridge.abandonRun(); }}>Abandon run</button>
            <button type="button" data-run-focus data-run-abandon-cancel onClick={() => setConfirmAbandon(false)}>Keep playing</button>
          </div>
        ) : (
          <>
            {model.primary.id !== 'none' && (
              <button type="button" className="primary" data-run-primary data-run-focus onClick={primary}>{model.primary.label}</button>
            )}
            {model.canAbandon && <button type="button" data-run-abandon onClick={() => setConfirmAbandon(true)}>Abandon run</button>}
            <button type="button" data-run-main-menu onClick={() => runBridge.runEndAction('main-menu')}>Main menu</button>
          </>
        )}
      </footer>
    </>
  );
};

const NodeCard = ({ node, image, onSelect }: { node: RunMapNode; image: MapPreviewImage | null; onSelect: () => void }): React.JSX.Element => (
  <button
    type="button"
    role="radio"
    aria-checked={node.selected}
    aria-label={node.ariaLabel}
    tabIndex={node.selected ? 0 : -1}
    className={`run-node ${node.status}${node.current ? ' current' : ''}${node.selected ? ' selected' : ''}`}
    data-run-node={node.index}
    data-run-status={node.status}
    onClick={onSelect}
  >
    <span className="run-node-strip" aria-hidden="true">{node.swatches.map((colour, index) => <i key={index} style={{ background: colour }} />)}</span>
    <span className="run-node-top" aria-hidden="true">
      <span className="run-node-icon">{node.biomeIcon}</span>
      <span className="run-node-number">Level {node.index + 1}</span>
    </span>
    <span className="run-node-biome" aria-hidden="true">{node.biomeName}</span>
    <MapPreview image={image} label={`${node.biomeName} map preview`} className="run-node-preview" />
    <span className={`run-node-status ${node.status}${node.current ? ' current' : ''}`} aria-hidden="true">
      {node.status === 'cleared' ? '✓ ' : node.status === 'failed' || node.status === 'abandoned' ? '✗ ' : node.current ? '➜ ' : ''}{node.statusLabel}
    </span>
    <span className="run-node-goal" aria-hidden="true">{node.objective}</span>
    {node.conditionIcons.length > 0 && (
      <span className="run-node-conditions" aria-hidden="true">{node.conditionIcons.map((condition) => <span key={condition.id} title={condition.name}>{condition.icon}</span>)}</span>
    )}
  </button>
);

const Drawer = ({ run, kind }: { run: RunSnapshot; kind: 'deck' | 'used' }): React.JSX.Element => {
  const activeCards = useUiStore((state) => state.activeCards);
  // The one-shots played so far this level (the park's card snapshot; the run itself only moves at the stage's end).
  const played = activeCards.filter((card) => card.playState === 'played').map((card) => card.id);
  const deck = deckRowsOf(run);
  const used = usedRowsOf(run, played);
  return (
    <section className="run-drawer" id="run-drawer" aria-label={kind === 'deck' ? 'Deck' : 'Used cards'} data-run-drawer={kind}>
      <h3>{kind === 'deck' ? `Deck · ${run.deckSize} cards` : `Used cards · ${run.usedPile.length}`}</h3>
      {kind === 'deck' && (deck.length === 0 ? <p className="run-detail-quiet">{DECK_EMPTY_TEXT}</p> : (
        <ul className="run-drawer-list">
          {deck.map((row) => <CardTile key={row.cardId} as="li" className="" card={row} count={row.count} />)}
        </ul>
      ))}
      {kind === 'used' && (used.length === 0 ? <p className="run-detail-quiet">{USED_EMPTY_TEXT}</p> : (
        <ul className="run-drawer-list used">
          {used.map((row, index) => (
            <CardTile key={`${row.cardId}-${index}`} as="li" className={row.inPocket ? 'in-pocket' : ''} card={row} facts={false}>
              <small>{row.where}</small>
            </CardTile>
          ))}
        </ul>
      ))}
    </section>
  );
};

// --- The offer ------------------------------------------------------------------------------------------

const OfferView = ({ run }: { run: RunSnapshot }): React.JSX.Element => {
  const setView = useUiStore((state) => state.setRunView);
  const [picked, setPicked] = useState<string[]>([]);
  const offer = buildRunOffer(run, picked);
  if (offer === null) return <ScreenHead kicker="THE MAP" title="No offer now" onClose={() => setView('map')} closeLabel="Back to the run map" />;
  const accept = (): void => {
    if (!canAcceptOffer(offer, picked)) return;
    runBridge.acceptRunOffer(offerPayload(offer, picked));
    setView('loadout');
  };
  return (
    <>
      <ScreenHead kicker={`THE MAP · LEVEL ${run.levelIndex + 1} OF ${run.levelCount}`} title={offer.heading} onClose={() => setView('map')} closeLabel="Back to the run map" />
      <div className="run-body">
        <p className="run-lead">{offer.intro}</p>
        <div className="run-card-grid" role="group" aria-label="Offered cards">
          {offer.cards.map((card) => (offer.mode === 'pick'
            ? <PickTile key={card.cardId} card={card} on={picked.includes(card.cardId)} onToggle={() => setPicked(togglePick(offer, picked, card.cardId))} />
            : <OfferTile key={card.cardId} card={card} />))}
        </div>
        <p className="run-deck-after" data-run-deck-after>{offer.deckAfter}</p>
      </div>
      <footer className="run-foot">
        <button type="button" className="primary" data-run-focus data-run-accept aria-disabled={!canAcceptOffer(offer, picked)} onClick={accept}>{offer.actionLabel}</button>
        <button type="button" data-run-back onClick={() => setView('map')}>Back to the map</button>
      </footer>
    </>
  );
};

const OfferTile = ({ card }: { card: OfferCard }): React.JSX.Element => (
  <CardTile card={card} className="pulse-card-tile run-offer-card" notes={card.notes} data={{ 'data-run-offer-card': card.cardId }}>
    {card.inDeck > 0 && <small className="run-in-deck">You already hold {card.inDeck}</small>}
  </CardTile>
);

const PickTile = ({ card, on, onToggle }: { card: OfferCard; on: boolean; onToggle: () => void }): React.JSX.Element => (
  <CardTile
    card={card}
    as="button"
    className={`pulse-card-tile run-offer-card${on ? ' selected' : ''}`}
    pressed={on}
    notes={card.notes}
    data={{ 'data-run-offer-card': card.cardId }}
    onClick={onToggle}
  >
    {card.inDeck > 0 && <small className="run-in-deck">You already hold {card.inDeck}</small>}
  </CardTile>
);

// --- The loadout ----------------------------------------------------------------------------------------

const LoadoutView = ({ run }: { run: RunSnapshot }): React.JSX.Element => {
  const setView = useUiStore((state) => state.setRunView);
  const selected = useUiStore((state) => state.runLoadoutSelection);
  const toggle = useUiStore((state) => state.toggleRunLoadoutCard);
  const grantBonuses = useUiStore((state) => state.runBonusIds);
  const profile = useUiStore((state) => state.profile);
  // The grant snapshot when the app publishes it, else the profile's bonuses for The Map (the grant is taken from them at run start).
  const bonusIds = grantBonuses ?? (profile === null || !profile.useBonuses.run ? [] : profile.bonusIds);
  const model = buildRunLoadout(run, selected, bonusIds);
  if (model === null) return <ScreenHead kicker="THE MAP" title="No level to prepare" onClose={() => setView('map')} />;
  const start = (): void => {
    if (!model.startEnabled) return;
    runBridge.startRunStage(sanitiseLoadout(run, selected));
  };
  return (
    <>
      <ScreenHead kicker={`THE MAP · LEVEL ${run.levelIndex + 1} OF ${run.levelCount} · ${model.biomeName.toUpperCase()}`} title={model.heading} onClose={() => setView('map')} closeLabel="Back to the run map" />
      <div className="run-body">
        <section className="loadout-brief" aria-label="This level">
          <p>{model.objective}</p>
          <p className="run-detail-facts"><span>{model.deadline}</span><span>{model.startingCash}</span></p>
          <Conditions conditions={model.conditions} />
        </section>
        <section className="loadout-cards" aria-label="Choose cards from your deck">
          <header>
            <strong>Your deck</strong>
            <em data-run-counter>{model.counter}</em>
          </header>
          {model.deck.length === 0 ? <p className="run-detail-quiet">{DECK_EMPTY_TEXT}</p> : (
            <div className="run-card-grid">
              {model.deck.map((card, index) => <DeckTile key={card.cardId} card={card} first={index === 0} onToggle={() => toggle(card.cardId)} />)}
            </div>
          )}
          {model.note !== null && <p className="run-detail-quiet" data-run-no-cards>{model.note}</p>}
          {model.pocketLine !== null && <p className="loadout-pocket" data-run-pocket>{model.pocketLine}</p>}
        </section>
        <section className="loadout-effects" aria-label="Combined park rules">
          <header><strong>Combined park rules</strong></header>
          {model.effective.length === 0
            ? <p className="loadout-neutral">Standard rules — no conditions or cards change this park.</p>
            : (
              <ul>
                {model.effective.map((modifier) => (
                  <li key={modifier.rule} className={modifier.beneficial ? 'good' : 'bad'}>
                    <span aria-hidden="true">{modifier.beneficial ? '▲' : '▼'}</span><span className="sr-only">{modifier.beneficial ? 'Helps: ' : 'Hurts: '}</span> {modifier.text}
                  </li>
                ))}
              </ul>
            )}
          {model.bonusLine !== null && <p className="loadout-bonuses" data-loadout-bonuses>{model.bonusLine}</p>}
        </section>
        <p className="run-deck-after" data-run-after>{model.afterLine}</p>
      </div>
      <footer className="run-foot">
        <button type="button" className="primary" data-run-start-level aria-disabled={!model.startEnabled} onClick={start}>{model.startLabel}</button>
        <button type="button" data-run-back onClick={() => setView('map')}>Back to the map</button>
      </footer>
    </>
  );
};

const DeckTile = ({ card, first, onToggle }: { card: LoadoutDeckCard; first: boolean; onToggle: () => void }): React.JSX.Element => (
  <CardTile
    card={card}
    as="button"
    className={`pulse-card-tile${card.selected ? ' selected' : ''}${card.blocked ? ' slots-full' : ''}`}
    count={card.count}
    pressed={card.selected}
    disabled={card.blocked}
    notes={card.blockedReason === null ? [] : [card.blockedReason]}
    data={{ 'data-run-focus': first ? '' : undefined, 'data-run-deck-card': card.cardId }}
    onClick={onToggle}
  />
);

// --- A cleared level ------------------------------------------------------------------------------------

const StageResultView = ({ run }: { run: RunSnapshot }): React.JSX.Element => {
  const model = buildStageResult(run);
  if (model === null) {
    return (
      <>
        <ScreenHead kicker="THE MAP" title="Level cleared" />
        <footer className="run-foot"><button type="button" className="primary" data-run-focus onClick={() => runBridge.continueAfterStage()}>Continue to The Map</button></footer>
      </>
    );
  }
  return (
    <>
      <ScreenHead kicker={`THE MAP · ${run.levelsCleared} OF ${run.levelCount} CLEARED`} title={model.heading} />
      <div className="run-body run-result">
        {model.evidence !== null && model.evidence !== '' && <p className="run-evidence" data-run-evidence>{model.evidence}</p>}
        <p>{model.parkTime}</p>
        <p>{model.cardsUsed}</p>
        {model.debt !== null && <p className="run-debt" data-run-debt>{model.debt}</p>}
        {model.next !== null && <p className="run-next" data-run-next><b>Next:</b> {model.next}</p>}
        <p className="scenario-result-meta">Your run is autosaved.</p>
      </div>
      <footer className="run-foot">
        <button type="button" className="primary" data-run-focus data-run-continue-after onClick={() => runBridge.continueAfterStage()}>{model.primaryLabel}</button>
      </footer>
    </>
  );
};

// --- The end of a run -----------------------------------------------------------------------------------

const EndView = ({ run }: { run: RunSnapshot }): React.JSX.Element => {
  const rewards: RunRewardResult | null = useUiStore((state) => state.runRewards);
  const model = buildRunEnd(run, rewards);
  if (model === null) return <ScreenHead kicker="THE MAP" title="Run over" />;
  return (
    <>
      <ScreenHead kicker={`THE MAP · ${run.difficulty.toUpperCase()} · SEED ${run.seed}`} title={model.heading} />
      <div className={`run-body run-end ${model.kind}`}>
        {model.evidence !== null && model.evidence !== '' && <p className="run-evidence" data-run-evidence>{model.evidence}</p>}
        <table className="run-table" aria-label="Levels played">
          <thead><tr><th scope="col">Level</th><th scope="col">Biome</th><th scope="col">Objective</th><th scope="col">Result</th><th scope="col">Cards played</th></tr></thead>
          <tbody>
            {model.rows.map((row) => (
              <tr key={row.index}>
                <th scope="row">{row.level}</th><td>{row.biome}</td><td>{row.objective}</td><td>{row.outcome}</td><td>{row.cards === '' ? '—' : row.cards}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="run-totals">{model.totals}</p>
        {model.debt !== null && <p className="run-debt" data-run-debt>{model.debt}</p>}
        {model.rewardLines.length > 0 && (
          <section className="result-rewards" aria-label="Rewards" data-result-rewards>
            <h3>{model.kind === 'won' ? 'Rewards' : 'What was learned'}</h3>
            <ul>{model.rewardLines.map((line) => <li key={line.id}><span aria-hidden="true">{line.icon}</span> {line.text}</li>)}</ul>
          </section>
        )}
        {model.note !== null && <p className="result-rewards-note">{model.note}</p>}
      </div>
      <footer className="run-foot">
        {model.actions.map((action, index) => (
          <button key={action.id} type="button" className={action.primary ? 'primary' : undefined} data-run-focus={index === 0 ? '' : undefined} data-run-end={action.id} onClick={() => runBridge.runEndAction(action.id)}>{action.label}</button>
        ))}
      </footer>
    </>
  );
};
