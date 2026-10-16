import { useEffect, useRef, useState } from 'react';
import { gameBridge } from '../app/gameBridge';
import { CARD_BY_ID, PULSE_CARDS } from '../game/cards/content';
import type { ActiveCardSnapshot } from '../game/cards/types';
import type { PulseCardDefinition, PulseCardId } from '../game/cards/types';
import { SCENARIO_BY_ID } from '../game/scenarios/content';
import type { ScenarioDefinition, ScenarioSnapshot } from '../game/scenarios/types';
import { useModalFocus } from './a11yHooks';
import { buildLoadout } from './loadoutModel';
import { CardTile } from './CardTile';
import { runBridge } from './runBridge';
import { biomeName } from './runCopy';
import { buildRewardsSection, buildResultActions, type ResultActionId } from './resultRewardsModel';
import { METRIC_COPY, formatClock, objectiveSentence } from './scenarioCopy';
import { countdownText, timeLimitText } from './scenarioDeadlineModel';
import { useUiStore, type UiState } from './store';
import type { GameMode } from '../game/modes/types';
import type { ActiveBonusSnapshot } from '../game/profile/bonuses';
import type { ProfileSnapshot, ScenarioRewardResult } from '../game/profile/types';

// --- Phase 25: the stage's cards in Park Pulse (design 10.3) --------------------------------------------------

/** "$2,400" from a ledger amount (negative = owed). */
const dollars = (amount: number): string => `$${Math.round(Math.abs(amount)).toLocaleString('en-US')}`;

/** The chip's short name under a narrow UI (the longest word: "Bridging", "Inspection"); the full name stays accessible. */
export const shortCardName = (name: string): string => {
  const words = name.split(/\s+/).filter((word) => word !== '');
  return words.reduce((best, word) => (word.length > best.length ? word : best), words[0] ?? name);
};

export type CardRow =
  | { kind: 'stage'; key: string; id: string; icon: string; name: string; state: string; title: string }
  | { kind: 'ready'; key: string; id: string; icon: string; name: string; upside: string; downside: string; playable: boolean; hint: string | null; descriptionId: string }
  | { kind: 'played'; key: string; id: string; icon: string; name: string; text: string }
  | { kind: 'due'; key: string; id: string; text: string };

/**
 * The card list as rows: a stage card is "in play" (run) or "active" (Scenario); a one-shot is a Play button until it is
 * played, then "played at 3:12"; a deferred cost adds its own row "Bridging Loan: $2,400 due in 3:12".
 */
export const cardRowsOf = (cards: readonly ActiveCardSnapshot[], inRun: boolean): CardRow[] => {
  const rows: CardRow[] = [];
  for (const card of cards) {
    if (card.playState === 'stage') {
      rows.push({ kind: 'stage', key: card.id, id: card.id, icon: card.icon, name: card.name, state: inRun ? 'in play' : 'active', title: `${card.name} — ${card.upside} ${card.downside}` });
    } else if (card.playState === 'ready') {
      rows.push({
        kind: 'ready', key: card.id, id: card.id, icon: card.icon, name: card.name, upside: card.upside, downside: card.downside,
        playable: card.playable, hint: card.playable ? null : card.hint, descriptionId: `card-play-about-${card.id}`,
      });
    } else {
      rows.push({ kind: 'played', key: card.id, id: card.id, icon: card.icon, name: card.name, text: `played at ${formatClock(card.playedAtSeconds ?? 0)}` });
      if (card.pending !== null) {
        rows.push({ kind: 'due', key: `${card.id}-due`, id: card.id, text: `${card.name}: ${dollars(card.pending.amount)} due in ${formatClock(card.pending.dueInSeconds)}` });
      }
    }
  }
  return rows;
};

/**
 * Where focus goes after a play (design 10.3): the next ready Play button after the played card (in the order they
 * stood when it was pressed), else the first one still ready, else null (the caller then focuses the Undo control).
 */
export const focusAfterPlay = (readyBefore: readonly string[], playedId: string, readyNow: readonly string[]): string | null => {
  const from = readyBefore.indexOf(playedId);
  const after = readyBefore.slice(from + 1).find((id) => readyNow.includes(id));
  return after ?? readyNow[0] ?? null;
};

/** The list without state (rendered by `ScenarioCards`; a test walks its elements). */
export const ScenarioCardList = ({ rows, inRun, onPlay }: { rows: readonly CardRow[]; inRun: boolean; onPlay: (id: string) => void }): React.JSX.Element => (
  <ul className="scenario-cards" aria-label={inRun ? 'Cards this level' : 'Active Pulse Cards'}>
    {rows.map((row) => {
      switch (row.kind) {
        case 'stage':
          return (
            <li key={row.key} className="scenario-card-chip" title={row.title}>
              <span aria-hidden="true">{row.icon}</span> <CardChipName name={row.name} /> <em>{row.state}</em>
            </li>
          );
        case 'ready':
          return (
            <li key={row.key} className="scenario-card-chip one-shot">
              {/* Native button: Tab reaches it, Enter and Space play it. Not playable now: aria-disabled (it stays focusable) and the press says why. */}
              <button type="button" className="card-play" data-play-card={row.id} aria-describedby={row.descriptionId} aria-disabled={row.playable ? undefined : true} onClick={() => onPlay(row.id)}>
                <span aria-hidden="true">▶</span> Play <CardChipName name={row.name} />
              </button>
              <small id={row.descriptionId}>
                <span aria-hidden="true">▲ </span><span className="sr-only">Upside: </span>{row.upside} <span aria-hidden="true">▼ </span><span className="sr-only">Downside: </span>{row.downside}
                {row.hint !== null && <> <b className="card-play-hint">Not now: {row.hint}</b></>}
              </small>
            </li>
          );
        case 'played':
          return (
            <li key={row.key} className="scenario-card-chip played" data-played-card={row.id}>
              <span aria-hidden="true">{row.icon}</span> <CardChipName name={row.name} /> · {row.text}
            </li>
          );
        case 'due':
          return <li key={row.key} className="scenario-card-due">{row.text}</li>;
      }
    })}
  </ul>
);

/** The full name, with the short one shown instead under a narrow UI (the full one stays in the accessibility tree). */
const CardChipName = ({ name }: { name: string }): React.JSX.Element => {
  const short = shortCardName(name);
  if (short === name) return <span className="card-chip-name">{name}</span>;
  return (
    <span className="card-chip-name">
      <span className="card-chip-full">{name}</span>
      <span className="card-chip-short" aria-hidden="true">{short}</span>
    </span>
  );
};

/**
 * Phase 35 (the Phase 25 open line): whether a scrolling list hides rows below its fold. A pixel of slack, because a
 * zoomed page reports fractional scroll positions.
 */
export const hasMoreBelow = (box: { scrollTop: number; clientHeight: number; scrollHeight: number }): boolean => (
  box.scrollHeight - box.scrollTop - box.clientHeight > 1
);

/** The cue under the card list while rows are hidden below it. Drawn only: a screen reader already hears every row. */
export const MoreBelowCue = ({ shown }: { shown: boolean }): React.JSX.Element => (
  <span className="scenario-cards-more" aria-hidden="true" hidden={!shown}>more below <b>▾</b></span>
);

/** Tracks `hasMoreBelow` for the list inside `wrap`: on scroll, on a resize of the list and when its rows change. */
const useMoreBelow = (wrap: React.RefObject<HTMLDivElement | null>, rowsKey: string): boolean => {
  const [more, setMore] = useState(false);
  useEffect(() => {
    const list = wrap.current?.querySelector('ul');
    if (!list) return undefined;
    const update = (): void => setMore(hasMoreBelow(list));
    update();
    list.addEventListener('scroll', update, { passive: true });
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    observer?.observe(list);
    return () => {
      list.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, [wrap, rowsKey]);
  return more;
};

/** Focus target when no Play button is left: the Undo control in the build dock. */
const focusUndoControl = (): void => {
  const undo = document.querySelector('.undo-label')?.closest('button');
  if (undo instanceof HTMLElement) undo.focus();
};

/** The stage's cards with the one-shot Play buttons, and focus that never falls to `body` after a play. */
const ScenarioCards = ({ cards, inRun }: { cards: readonly ActiveCardSnapshot[]; inRun: boolean }): React.JSX.Element => {
  const rows = cardRowsOf(cards, inRun);
  const listRef = useRef<HTMLDivElement>(null);
  const pending = useRef<{ playedId: string; readyBefore: string[] } | null>(null);
  const readyNow = rows.filter((row) => row.kind === 'ready').map((row) => row.id);
  const readyKey = readyNow.join(',');
  useEffect(() => {
    const wanted = pending.current;
    if (wanted === null) return;
    pending.current = null;
    // Refused (the card is still ready): focus stays on its button.
    if (readyKey.split(',').includes(wanted.playedId)) return;
    const target = focusAfterPlay(wanted.readyBefore, wanted.playedId, readyKey === '' ? [] : readyKey.split(','));
    const button = target === null ? null : listRef.current?.querySelector<HTMLElement>(`[data-play-card="${target}"]`);
    if (button) button.focus();
    else focusUndoControl();
  }, [readyKey]);
  const play = (id: string): void => {
    pending.current = { playedId: id, readyBefore: readyNow };
    runBridge.playCard(id);
    // The app answers synchronously: a refused play leaves the card ready, and focus stays where it is.
    if (useUiStore.getState().activeCards.some((card) => card.id === id && card.playState === 'ready')) pending.current = null;
  };
  const more = useMoreBelow(listRef, rows.map((row) => `${row.kind}:${row.key}`).join(','));
  return (
    <div ref={listRef} className="scenario-cards-wrap">
      <ScenarioCardList rows={rows} inRun={inRun} onPlay={play} />
      <MoreBelowCue shown={more} />
    </div>
  );
};

const PaceChip = ({ scenario }: { scenario: ScenarioSnapshot }): React.JSX.Element => {
  if (scenario.status === 'succeeded') return <b className="scenario-pace success">Complete</b>;
  if (scenario.status === 'failed') return <b className="scenario-pace failed">Failed</b>;
  return scenario.objective.onPace
    ? <b className="scenario-pace on">On pace</b>
    : <b className="scenario-pace behind">Behind pace</b>;
};

export const ScenarioPanel = (): React.JSX.Element | null => {
  const scenario = useUiStore((state) => state.scenario);
  const activeCards = useUiStore((state) => state.activeCards);
  const run = useUiStore((state) => (state.sessionMode === 'run' ? state.run : null));
  const dayLengthSeconds = useUiStore((state) => state.dayLengthSeconds);
  if (!scenario) return null;
  // On The Map the header names the run ("THE MAP · LEVEL 3 OF 5 · DESERT CANYON"); the cards played are used up.
  const kicker = run === null
    ? scenario.name.toUpperCase()
    : `THE MAP · LEVEL ${run.parkLevelIndex + 1} OF ${run.levelCount} · ${biomeName(run.levels[run.parkLevelIndex]?.biomeId ?? '').toUpperCase()}`;
  const copy = METRIC_COPY[scenario.objective.metric];
  const current = scenario.objective.current;
  const progressLine = scenario.objective.kind === 'sustain'
    ? `${formatClock(scenario.objective.sustainedSeconds)} of ${formatClock(scenario.objective.requiredSustainSeconds)} held`
      + (current !== null ? ` · now ${copy.format(current)}` : '')
    : `${current === null ? '—' : copy.format(current)} of ${copy.format(scenario.objective.target)}`
      // A straight-line pace only means something for a total that grows from zero (visitors, profit): a "reach" level
      // that starts high (owned parcels, guests in the park) extrapolated from a few seconds read as nonsense (QA 2026-10-14).
      + (scenario.objective.kind === 'earn' && scenario.objective.projectedValue !== null && scenario.status === 'running'
        ? ` · pace → ${copy.format(scenario.objective.projectedValue)}`
        : '');
  return (
    <div className={`scenario-panel ${scenario.status}`} role="group" aria-label={`Scenario objective: ${scenario.objective.name}`}>
      <header>
        <span>
          <small>{kicker}</small>
          <strong>{scenario.objective.name}</strong>
        </span>
        <PaceChip scenario={scenario} />
      </header>
      {/* The snapshot carries the hold as requiredSustainSeconds (the definition's durationSeconds): the sentence said 0:00 without it. */}
      <p className="scenario-objective-line">{objectiveSentence({ ...scenario.objective, durationSeconds: scenario.objective.requiredSustainSeconds })}</p>
      <i aria-hidden="true"><b style={{ width: `${Math.min(100, scenario.objective.progressPercent)}%` }} /></i>
      <footer>
        <em>{progressLine}</em>
        <em className="scenario-clock"><span aria-hidden="true">⏱</span> {countdownText(scenario, dayLengthSeconds)}</em>
      </footer>
      {scenario.constraint && (
        <p className="scenario-constraint" title={scenario.constraint.detail}><span aria-hidden="true">⚑</span> {scenario.constraint.name}</p>
      )}
      {activeCards.length > 0 && <ScenarioCards cards={activeCards} inRun={run !== null} />}
    </div>
  );
};

const LoadoutView = ({ definition }: { definition: ScenarioDefinition }): React.JSX.Element => {
  const selected = useUiStore((state) => state.loadoutCardIds);
  const mode = 'scenario' as const;
  const profile = useUiStore((state) => state.profile);
  const toggle = useUiStore((state) => state.toggleLoadoutCard);
  const closeLoadout = useUiStore((state) => state.closeLoadout);
  const loadout = buildLoadout(definition, mode, profile, selected, []);
  const poolCards = PULSE_CARDS.filter((card) => loadout.poolCardIds.includes(card.id));
  const start = (): void => {
    gameBridge.menuStartScenario(definition.id, selected);
  };
  return (
    <div className="scenario-loadout">
      <section className="loadout-brief">
        <h3>{definition.name}</h3>
        <p>{objectiveSentence(definition.objective)} Time limit {timeLimitText(definition)}.</p>
        {definition.constraint && <p className="loadout-constraint"><span aria-hidden="true">⚑</span> {definition.constraint.name} — {definition.constraint.detail}</p>}
      </section>
      <section className="loadout-cards" aria-label="Choose Pulse Cards">
        <header>
          <strong>Pulse Cards</strong>
          <em>{loadout.slotsUsed} of {loadout.slots} slot{loadout.slots === 1 ? '' : 's'} · locked once the park starts</em>
        </header>
        {loadout.oneShotNote !== null && <p className="loadout-one-shot-note">{loadout.oneShotNote}</p>}
        <div className="loadout-card-grid">
          {poolCards.map((card) => {
            const active = selected.includes(card.id);
            // Slot cost (Phase 25): a rare takes two slots, so a card fits only when its cost fits in what is left.
            const full = !active && loadout.slotsUsed + card.slotCost > loadout.slots;
            const notes = full ? [card.slotCost > 1 ? `Needs ${card.slotCost} free slots` : 'No free slot'] : [];
            return (
              <CardTile
                key={card.id}
                as="button"
                card={card}
                className={['pulse-card-tile', active ? 'selected' : '', full ? 'slots-full' : ''].filter((name) => name !== '').join(' ')}
                pressed={active}
                disabled={full}
                notes={notes}
                onClick={() => toggle(card.id, loadout.slots)}
              />
            );
          })}
        </div>
      </section>
      <section className="loadout-effects" aria-label="Combined park rules">
        <header><strong>Combined park rules</strong></header>
        {loadout.effective.length === 0
          ? <p className="loadout-neutral">Standard rules — no conditions or cards change this park.</p>
          : (
            <ul>
              {loadout.effective.map((modifier) => (
                <li key={modifier.rule} className={modifier.beneficial ? 'good' : 'bad'}>
                  <span aria-hidden="true">{modifier.beneficial ? '▲' : '▼'}</span><span className="sr-only">{modifier.beneficial ? 'Helps: ' : 'Hurts: '}</span> {modifier.text}
                </li>
              ))}
            </ul>
          )}
        {loadout.bonusLine !== null && <p className="loadout-bonuses" data-loadout-bonuses>{loadout.bonusLine}</p>}
      </section>
      <div className="loadout-actions">
        <button className="primary" onClick={start}>
          Start park{selected.length > 0 ? ` with ${selected.length} card${selected.length === 1 ? '' : 's'}` : ' without cards'}
        </button>
        <button onClick={closeLoadout}>Back to scenarios</button>
      </div>
    </div>
  );
};


/**
 * The Scenario-mode loadout layer (opened from the Scenario browser or the result overlay). It is all that is left of the
 * old Parks map: The Map has its own overlay (RunScreen) and the Park Tour is retired.
 */
export const ScenarioPicker = (): React.JSX.Element | null => {
  const open = useUiStore((state) => state.scenarioPickerOpen && state.loadoutScenarioId !== null);
  const close = useUiStore((state) => state.closeScenarioPicker);
  const loadoutScenarioId = useUiStore((state) => state.loadoutScenarioId);
  const rootRef = useRef<HTMLDivElement>(null);
  // Focus moves into the loadout when it opens, Tab stays inside it and focus returns to the control that opened it.
  useModalFocus(open, rootRef, '.loadout-cards button, header button');
  if (!open) return null;
  const loadoutDefinition = loadoutScenarioId
    ? SCENARIO_BY_ID.get(loadoutScenarioId as Parameters<typeof SCENARIO_BY_ID.get>[0])
    : undefined;
  if (loadoutDefinition === undefined) return null;
  return (
    <div ref={rootRef} className="scenario-picker-backdrop" role="dialog" aria-modal="true" aria-labelledby="scenario-picker-title">
      <section className="scenario-picker">
        <header>
          <span><small>SCENARIO</small><strong id="scenario-picker-title" role="heading" aria-level={2}>Prepare your loadout</strong></span>
          <button onClick={close} title="Close (Esc)" aria-label="Close the loadout"><span aria-hidden="true">×</span></button>
        </header>
        <LoadoutView definition={loadoutDefinition} />
      </section>
    </div>
  );
};

/**
 * Takes resolved cards, never raw ids: the draft is the one overlay Escape will not close, so it
 * must be impossible to render it with nothing to click.
 */
const RewardDraft = ({ cards }: { cards: PulseCardDefinition[] }): React.JSX.Element => (
  <div className="reward-draft" role="group" aria-label="Choose one reward card">
    <p className="reward-draft-title">Draft one new Pulse Card for your collection:</p>
    <div className="loadout-card-grid">
      {cards.map((card) => (
        <CardTile key={card.id} as="button" card={card} className="pulse-card-tile reward" onClick={() => gameBridge.chooseRewardCard(card.id)} />
      ))}
    </div>
  </div>
);

export const ScenarioResultOverlay = (): React.JSX.Element | null => {
  const scenario = useUiStore((state) => state.scenario);
  const dismissed = useUiStore((state) => state.scenarioResultDismissed);
  const rewardDraft = useUiStore((state) => state.rewardDraft);
  const mode = useUiStore((state) => state.sessionMode);
  const rewards = useUiStore((state) => state.scenarioRewards);
  const profile = useUiStore((state) => state.profile);
  // The start screen's sweep may be a finished scenario park: its result waits for Continue.
  const startScreen = useUiStore((state) => state.menuKind === 'start');
  return <ResultOverlayView {...{ scenario, dismissed, rewardDraft, mode, rewards, profile, startScreen }} />;
};

interface ResultOverlayViewProps {
  scenario: ScenarioSnapshot | null;
  dismissed: boolean;
  rewardDraft: string[] | null;
  mode: GameMode;
  rewards: ScenarioRewardResult | null;
  profile: ProfileSnapshot | null;
  startScreen: boolean;
}

/** The result overlay's body as a function of its inputs (the wrapper above reads the store), so it can be rendered in tests. */
export const ResultOverlayView = ({ scenario, dismissed, rewardDraft, mode, rewards, profile, startScreen }: ResultOverlayViewProps): React.JSX.Element | null => {
  const dismiss = useUiStore((state) => state.dismissScenarioResult);
  const openScenarioLoadout = useUiStore((state) => state.openScenarioLoadout);
  // A park on The Map has its own result screens (RunScreen), never this overlay.
  const showing = scenario !== null && scenario.status !== 'running' && !dismissed && !startScreen && mode !== 'run';
  const rootRef = useRef<HTMLDivElement>(null);
  // The result takes the keyboard like the other overlays: focus lands on its main action, Tab stays inside.
  useModalFocus(showing, rootRef, '.pulse-card-tile, button.primary');
  if (scenario === null || !showing) return null;
  const succeeded = scenario.status === 'succeeded';
  // Resolved here, so an empty or unrecognised draft falls through to the ordinary actions rather
  // than rendering a draft with no cards in it.
  const draftableCards = (rewardDraft ?? [])
    .map((cardId) => CARD_BY_ID.get(cardId as PulseCardId))
    .filter((card): card is PulseCardDefinition => card !== undefined);
  // The rewards block belongs to this scenario's result only (a stale result of another scenario is never shown).
  const ownRewards = rewards !== null && rewards.scenarioId === scenario.scenarioId ? rewards : null;
  const section = buildRewardsSection(ownRewards, profile, scenario.completedAtSeconds ?? scenario.elapsedSeconds);
  const actions = buildResultActions(succeeded, ownRewards);
  const run = (id: ResultActionId, nextScenarioId?: string): void => {
    switch (id) {
      case 'keep-exploring':
        dismiss();
        return;
      case 'try-again':
        dismiss();
        openScenarioLoadout(scenario.scenarioId);
        return;
      case 'next-scenario':
        if (nextScenarioId === undefined) return;
        dismiss();
        openScenarioLoadout(nextScenarioId);
        return;
      case 'back-to-scenarios':
        dismiss();
        gameBridge.openParksChooser('scenarios');
        return;
      case 'quick-restart':
        gameBridge.restartScenario();
        return;
    }
  };
  return (
    <div ref={rootRef} className="scenario-result-backdrop" role="dialog" aria-modal="true" aria-labelledby="scenario-result-title" aria-describedby="scenario-result-evidence">
      <section className={`scenario-result ${scenario.status}`}>
        <small>{scenario.name.toUpperCase()}</small>
        <h2 id="scenario-result-title">{succeeded ? 'Objective complete!' : 'Objective failed'}</h2>
        <p className="scenario-result-evidence" id="scenario-result-evidence">{scenario.resultEvidence}</p>
        <p className="scenario-result-meta">
          Decided at {formatClock(scenario.completedAtSeconds ?? scenario.elapsedSeconds)} of {formatClock(scenario.timeLimitSeconds)} park time.
        </p>
        {section !== null && (
          <section className="result-rewards" aria-label={section.title} data-result-rewards>
            <h3>{section.title}</h3>
            <ul>
              {section.lines.map((line) => (
                <li key={line.id}><span aria-hidden="true">{line.icon}</span> {line.text}</li>
              ))}
            </ul>
            {section.note !== null && <p className="result-rewards-note">{section.note}</p>}
          </section>
        )}
        <p className="scenario-result-meta">Your progress is autosaved; Save / Load is available once you leave this screen.</p>
        {succeeded && draftableCards.length > 0
          ? <RewardDraft cards={draftableCards} />
          : (
            <div className="scenario-result-actions">
              {actions.map((action) => (
                <button
                  key={action.id}
                  className={action.primary ? 'primary' : undefined}
                  onClick={() => run(action.id, action.scenarioId)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
      </section>
    </div>
  );
};

/** A card's state on the dashboard (design 10.2): "In play" / "Active", "Ready", "Played at 3:12". */
export const cardStateText = (card: Pick<ActiveCardSnapshot, 'playState' | 'playedAtSeconds' | 'playable' | 'hint'>, mode: GameMode): string => {
  switch (card.playState) {
    case 'stage': return mode === 'run' ? 'In play' : 'Active';
    case 'ready': return card.playable || card.hint === null ? 'Ready' : `Ready · not now: ${card.hint}`;
    case 'played': return `Played at ${formatClock(card.playedAtSeconds ?? 0)}`;
  }
};

/** Active-card and permanent-bonus list for the management dashboard: both consequences stay visible all park. */
export const ActiveCardsSection = (): React.JSX.Element | null => {
  const activeCards = useUiStore((state) => state.activeCards);
  const activeBonuses = useUiStore((state) => state.activeBonuses);
  const mode = useUiStore((state) => state.sessionMode);
  return <ActiveCardsView activeCards={activeCards} activeBonuses={activeBonuses} mode={mode} />;
};

export const ActiveCardsView = ({ activeCards, activeBonuses, mode }: {
  activeCards: UiState['activeCards'];
  activeBonuses: ActiveBonusSnapshot[];
  mode: GameMode;
}): React.JSX.Element | null => {
  // A Sandbox without bonuses has nothing to list (as before Phase 22); a Scenario or Map park always says what it has.
  if (activeCards.length === 0 && activeBonuses.length === 0 && mode === 'sandbox') return null;
  return (
    <section className="management-section active-cards-section">
      <header><span><small>CARDS AND BONUSES</small><strong>Active this park</strong></span></header>
      {activeCards.length > 0 && (
        <div className="active-cards-list">
          {activeCards.map((card) => (
            <CardTile key={card.id} card={card} className="" data={{ 'data-active-card': card.id }}>
              <b className="card-state">{cardStateText(card, mode)}</b>
              {card.pending !== null && (
                <em className="card-due">{dollars(card.pending.amount)} due in {formatClock(card.pending.dueInSeconds)}</em>
              )}
            </CardTile>
          ))}
        </div>
      )}
      <div className="active-bonuses" data-active-bonuses>
        <strong>Permanent bonuses</strong>
        {activeBonuses.length === 0
          ? <em>None</em>
          : (
            <ul>
              {activeBonuses.map((bonus) => (
                <li key={bonus.id}><span aria-hidden="true">{bonus.icon}</span> <b>{bonus.name}</b> — {bonus.summary}</li>
              ))}
            </ul>
          )}
      </div>
    </section>
  );
};
