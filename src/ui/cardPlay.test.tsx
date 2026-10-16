import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActiveCardSnapshot } from '../game/cards/types';
import { CARD_BY_ID } from '../game/cards/content';
import { registerRunCommands, runBridge, type RunCommands } from './runBridge';
import { ManagementDashboard } from './ManagementDashboard';
import { ActiveCardsView, ScenarioCardList, ScenarioPanel, ScenarioPicker, cardRowsOf, cardStateText, focusAfterPlay, shortCardName } from './ScenarioHud';
import { profileAfter } from './profileTestSupport';
import { snapshotAt } from './runTestSupport';
import { useUiStore } from './store';

/**
 * Phase 25 (design 10.3, 11.1 "UI cardPlay"): the one-shot play affordance in Park Pulse. Three play states, a native
 * button described by the card's facts, `aria-disabled` with the reason, the press reaching `runBridge.playCard`, focus
 * after a play, the dashboard states and the Scenario loadout drawn with the shared tile. The project's tests have no DOM,
 * so the markup is rendered on the server and the click handler is reached by walking the element tree.
 */

const snapshot = (id: string, patch: Partial<ActiveCardSnapshot> = {}): ActiveCardSnapshot => {
  const card = CARD_BY_ID.get(id as never)!;
  return {
    id: card.id, name: card.name, icon: card.icon, upside: card.upside, downside: card.downside, kind: card.kind, rarity: card.rarity, slotCost: card.slotCost,
    playState: card.kind === 'stage' ? 'stage' : 'ready', playedAtSeconds: null, playable: card.kind !== 'stage', hint: null, pending: null, ...patch,
  };
};

const STAGE = snapshot('grand-opening');
const READY = snapshot('coach-party');
const BLOCKED = snapshot('repair-crew', { playable: false, hint: 'No ride is broken' });
const PLAYED = snapshot('bridging-loan', { playState: 'played', playedAtSeconds: 192, playable: false, pending: { amount: -2_400, dueInSeconds: 192, label: 'Bridging Loan repaid' } });

type Patch = Partial<ReturnType<typeof useUiStore.getState>>;
const renderWith = (patch: Patch, element: React.JSX.Element): string => {
  const seed = useUiStore.getInitialState() as unknown as Record<string, unknown>;
  const saved: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) saved[key] = seed[key];
  Object.assign(seed, patch);
  try {
    return renderToStaticMarkup(element);
  } finally {
    Object.assign(seed, saved);
  }
};

/** Every element in a tree of plain (hook-free) elements, function components expanded. */
const elementsOf = (node: ReactNode): ReactElement<Record<string, unknown>>[] => {
  if (Array.isArray(node)) return node.flatMap(elementsOf);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  if (typeof node.type === 'function') return elementsOf((node.type as (props: unknown) => ReactNode)(node.props));
  return [node, ...elementsOf(node.props.children as ReactNode)];
};

afterEach(() => registerRunCommands(null));

describe('the card rows', () => {
  it('a stage card is in play (run) or active (Scenario); a one-shot is ready, then played with its time and a due row', () => {
    const rows = cardRowsOf([STAGE, READY, BLOCKED, PLAYED], true);
    expect(rows.map((row) => row.kind)).toEqual(['stage', 'ready', 'ready', 'played', 'due']);
    expect(rows[0]).toMatchObject({ state: 'in play' });
    expect(cardRowsOf([STAGE], false)[0]).toMatchObject({ state: 'active' });
    expect(rows[1]).toMatchObject({ playable: true, hint: null, descriptionId: 'card-play-about-coach-party' });
    expect(rows[2]).toMatchObject({ playable: false, hint: 'No ride is broken' });
    expect(rows[3]).toMatchObject({ text: 'played at 3:12' });
    expect(rows[4]).toMatchObject({ text: 'Bridging Loan: $2,400 due in 3:12' });
  });

  it('a played card without a pending cost has no due row', () => {
    expect(cardRowsOf([snapshot('coach-party', { playState: 'played', playedAtSeconds: 30, playable: false })], true).map((row) => row.kind)).toEqual(['played']);
  });

  it('the chip short name is the longest word, the whole name when it is one word', () => {
    expect(shortCardName('Bridging Loan')).toBe('Bridging');
    expect(shortCardName('Sweep the Park')).toBe('Sweep');
    expect(shortCardName('Fireworks Night')).toBe('Fireworks');
    expect(shortCardName('Apprentices')).toBe('Apprentices');
  });
});

describe('the card list markup', () => {
  const html = renderToStaticMarkup(<ScenarioCardList rows={cardRowsOf([STAGE, READY, BLOCKED, PLAYED], true)} inRun onPlay={() => undefined} />);

  it('is a labelled list with one native Play button per ready one-shot', () => {
    expect(html).toMatch(/^<ul class="scenario-cards" aria-label="Cards this level">/);
    expect((html.match(/<button /g) ?? []).length).toBe(2);
    expect(html).toContain('<button type="button" class="card-play" data-play-card="coach-party" aria-describedby="card-play-about-coach-party">');
    expect(html).toContain('<span aria-hidden="true">▶</span> Play <span class="card-chip-name"><span class="card-chip-full">Coach Party</span>');
    expect(html, 'the short name is drawn only, never read twice').toContain('<span class="card-chip-short" aria-hidden="true">Coach</span>');
  });

  it('describes a Play button with the card facts, which exist under that id', () => {
    const about = (/<small id="card-play-about-coach-party">(.*?)<\/small>/.exec(html)?.[1] ?? '').replace(/&#x27;/g, "'");
    expect(about).toContain('Upside: ');
    expect(about).toContain(READY.upside);
    expect(about).toContain('Downside: ');
    expect(about).toContain(READY.downside);
  });

  it('a one-shot that cannot be played now stays focusable with aria-disabled, and its description says why', () => {
    expect(html).toContain('<button type="button" class="card-play" data-play-card="repair-crew" aria-describedby="card-play-about-repair-crew" aria-disabled="true">');
    expect(/<small id="card-play-about-repair-crew">(.*?)<\/small>/.exec(html)?.[1]).toContain('Not now: No ride is broken');
    expect(html).not.toMatch(/ disabled=""/);
  });

  it('a played one-shot has no button, its time, and a due row for its cost', () => {
    expect(html).toMatch(/<li class="scenario-card-chip played" data-played-card="bridging-loan">.*Bridging Loan.*· played at 3:12<\/li>/);
    expect(html).toContain('<li class="scenario-card-due">Bridging Loan: $2,400 due in 3:12</li>');
    expect(html).toContain('<em>in play</em>');
  });

  it('a press (click, or Enter and Space on the native button) calls onPlay with the card id, playable or not', () => {
    const onPlay = vi.fn();
    const buttons = elementsOf(ScenarioCardList({ rows: cardRowsOf([STAGE, READY, BLOCKED], true), inRun: true, onPlay })).filter((element) => element.type === 'button');
    expect(buttons.map((button) => button.props['data-play-card'])).toEqual(['coach-party', 'repair-crew']);
    for (const button of buttons) expect(button.props.type, 'a native button: Enter and Space activate it').toBe('button');
    (buttons[0].props.onClick as () => void)();
    (buttons[1].props.onClick as () => void)();
    // The app refuses the second and toasts the reason: an aria-disabled control still answers a press.
    expect(onPlay.mock.calls).toEqual([['coach-party'], ['repair-crew']]);
  });

  it('runBridge.playCard reaches the registered app command', () => {
    const playCard = vi.fn();
    registerRunCommands({ playCard } as unknown as RunCommands);
    runBridge.playCard('coach-party');
    expect(playCard).toHaveBeenCalledWith('coach-party');
    registerRunCommands(null);
    expect(() => runBridge.playCard('coach-party'), 'no app, no-op').not.toThrow();
  });

  it('the objective panel draws the list in a run park', () => {
    const run = snapshotAt(1, 'stage');
    const scenario = { status: 'running', name: 'Level 2 · X', scenarioId: 'the-map-stage', objective: { name: 'Keep spirits high', metric: 'averageHappiness', kind: 'sustain', target: 70, current: 66, progressPercent: 20, onPace: true, sustainedSeconds: 60, requiredSustainSeconds: 300, projectedValue: null, comparison: 'atLeast', durationSeconds: 300 }, constraint: null, elapsedSeconds: 10, timeLimitSeconds: 1440, completedAtSeconds: null, resultEvidence: null, timeLimitDays: 2, remainingDays: 1.99, remainingSeconds: 1430 } as never;
    const panel = renderWith({ sessionMode: 'run', run, scenario, activeCards: [STAGE, READY] }, <ScenarioPanel />);
    expect(panel).toContain('data-play-card="coach-party"');
    expect(panel).toContain('1.99 days left');
    const longDays = renderWith({ sessionMode: 'run', run, scenario, activeCards: [STAGE], dayLengthSeconds: 1_080 }, <ScenarioPanel />);
    expect(longDays, 'a day-length card: the countdown is park time').toContain('23:50 left');
  });
});

describe('focus after a play', () => {
  it('moves to the next ready Play button, else the first one still ready, else nowhere (the caller focuses Undo)', () => {
    expect(focusAfterPlay(['a', 'b', 'c'], 'b', ['a', 'c'])).toBe('c');
    expect(focusAfterPlay(['a', 'b', 'c'], 'c', ['a', 'b'])).toBe('a');
    expect(focusAfterPlay(['a'], 'a', [])).toBeNull();
  });
});

describe('the dashboard', () => {
  it('names each card state: in play, ready (or why not), played at a time', () => {
    expect(cardStateText(STAGE, 'run')).toBe('In play');
    expect(cardStateText(STAGE, 'scenario')).toBe('Active');
    expect(cardStateText(READY, 'run')).toBe('Ready');
    expect(cardStateText(BLOCKED, 'run')).toBe('Ready · not now: No ride is broken');
    expect(cardStateText(PLAYED, 'run')).toBe('Played at 3:12');
  });

  it('draws the cards with the shared tile, their badges, state and a pending line', () => {
    const html = renderToStaticMarkup(<ActiveCardsView activeCards={[STAGE, PLAYED]} activeBonuses={[]} mode="run" />);
    expect(html).toContain('data-active-card="bridging-loan"');
    expect(html).toContain('<span class="card-badge">One-shot</span>');
    expect(html).toContain('<b class="card-state">Played at 3:12</b>');
    expect(html).toContain('<em class="card-due">$2,400 due in 3:12</em>');
    expect(html).toContain('<b class="card-state">In play</b>');
  });
});

describe('the Scenario loadout and draft (stage cards only, slot cost counted)', () => {
  it('draws the stage cards of the collection as tiles, notes the one-shots left out and blocks a rare that does not fit', () => {
    const profile = { ...profileAfter([]).snapshot, collectionCardIds: ['grand-opening', 'local-contractors', 'season-ticket', 'bridging-loan'] } as never;
    const html = renderWith({ scenarioPickerOpen: true, loadoutScenarioId: 'sunny-start', profile, loadoutCardIds: ['grand-opening'] }, <ScenarioPicker />);
    expect(html).toContain('1 of 2 slots');
    expect(html).toContain('One-shot cards are played on The Map.');
    expect(html).not.toContain('Bridging Loan');
    expect(html).toMatch(/<button type="button" class="pulse-card-tile selected" aria-pressed="true" aria-disabled="false">.*?Grand Opening/);
    expect(html).toContain('<span class="card-badge">Rare · 2 slots</span>');
    expect(html).toMatch(/class="pulse-card-tile slots-full" aria-pressed="false" aria-disabled="true">.*?Season Ticket.*?Needs 2 free slots/);
  });
});

describe('the dashboard report scroller (Phase 25 audit)', () => {
  it('is a named Tab stop, so a keyboard can scroll the overview once the card list makes it overflow', () => {
    const html = renderWith({ managementOpen: true, managementTab: 'overview' }, <ManagementDashboard />);
    expect(html).toContain('<div class="management-scroll" role="region" aria-label="Report" tabindex="0">');
  });
});
