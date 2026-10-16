import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SaveSlotMeta } from '../app/saves/types';
import type { RunRewardResult } from '../game/profile/types';
import { runSnapshotOf } from '../game/run';
import { MapOffer } from './FirstDayCard';
import { LeaveRunPrompt } from './LeaveRunPrompt';
import { RunScreen } from './RunScreen';
import { CardBadges, CardTile } from './CardTile';
import { RunSetupPanel } from './RunSetupPanel';
import { ScenarioPanel } from './ScenarioHud';
import { TopBar } from './Hud';
import { useUiStore } from './store';
import { profileAfter } from './profileTestSupport';
import { runAt, snapshotAt, type TestPhase } from './runTestSupport';
import { effectiveRunView } from './runViewModel';

const count = (html: string, pattern: RegExp): number => (html.match(pattern) ?? []).length;
type Patch = Partial<ReturnType<typeof useUiStore.getState>>;

/**
 * Renders a store-bound component against a patched store. React's server render reads zustand's INITIAL state, and that
 * object is the one `getInitialState()` returns every time, so the patch is written onto it for the render and put back.
 */
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

const screen = (level: number, phase: TestPhase, view: Patch['runView'], extra: Patch = {}): string => (
  renderWith({ run: snapshotAt(level, phase), runView: view, ...extra }, <RunScreen />)
);

describe('RunScreen', () => {
  it('renders nothing without a run or without a view', () => {
    expect(renderWith({ run: null, runView: 'map' }, <RunScreen />)).toBe('');
    expect(renderWith({ run: snapshotAt(0, 'offer'), runView: null }, <RunScreen />)).toBe('');
  });

  it('is one labelled modal dialog with a named heading', () => {
    const html = screen(1, 'loadout', 'map');
    expect(html).toContain('role="dialog" aria-modal="true" aria-labelledby="run-title"');
    expect(html).toContain('id="run-title"');
    expect(count(html, /id="run-title"/g)).toBe(1);
    expect(html).toContain('data-run-view="map"');
  });

  it('the map: a radio group of the levels with one tab stop, one selected, status words, previews with a text alternative', () => {
    const html = screen(2, 'loadout', 'map');
    expect(html).toContain('role="radiogroup" aria-label="Levels"');
    expect(count(html, /role="radio"/g)).toBe(5);
    expect(count(html, /aria-checked="true"/g)).toBe(1);
    expect(count(html, /tabindex="0"/g)).toBe(1);
    expect(count(html, /data-run-node="/g)).toBe(5);
    expect(html).toContain('data-run-status="cleared"');
    expect(html).toContain('data-run-status="current"');
    expect(html).toContain('data-run-status="ahead"');
    expect(html).toMatch(/<canvas[^>]*role="img"[^>]*aria-label="[^"]+ map preview"/);
    expect(html).toContain('Choose cards for level 3');
    expect(count(html, /data-run-focus/g)).toBe(1);
    expect(html).toContain('THE MAP · STANDARD · SEED 1234');
    expect(html).toContain('data-run-summary');
  });

  it('the map: Deck and Used are disclosure buttons, the drawer renders only when open', () => {
    const closed = screen(2, 'loadout', 'map');
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain('aria-controls');
    expect(closed).not.toContain('data-run-drawer');
    const open = screen(2, 'loadout', 'map', { runDrawer: 'deck' });
    expect(open).toContain('data-run-drawer="deck"');
    expect(open).toContain('aria-expanded="true" aria-controls="run-drawer"');
    expect(open).toContain('Upside: ');
    expect(open).toContain('Downside: ');
    expect(screen(2, 'loadout', 'map', { runDrawer: 'used' })).toContain('data-run-drawer="used"');
    expect(screen(0, 'offer', 'map', { runDrawer: 'used' })).toContain('No card has been used yet.');
  });

  it('the map in a stage offers Back to the park; once the run is over there is no abandon and the end screen shows', () => {
    const stage = screen(1, 'stage', 'map');
    expect(stage).toContain('Back to the park');
    expect(stage).toContain('data-run-abandon');
    expect(screen(1, 'lost', 'map')).toContain('data-run-view="end"');
    expect(screen(1, 'lost', 'map')).not.toContain('data-run-abandon');
  });

  it('the offer: the offered cards with upside and downside, what the deck becomes, Add to deck as the focus target', () => {
    const html = screen(2, 'offer', 'offer');
    expect(html).toContain('data-run-view="offer"');
    expect(html).toContain('Before level 3: new cards');
    expect(count(html, /data-run-offer-card=/g)).toBe(2);
    expect(count(html, /Upside: /g)).toBe(2);
    expect(html).toContain('data-run-deck-after');
    expect(html).toMatch(/Your deck will have \d+ cards\./);
    expect(html).toContain('data-run-accept');
    expect(count(html, /data-run-focus/g)).toBe(1);
    expect(html).toContain('Back to the map');
  });

  it('the pick-N offer renders toggle buttons and a disabled Add until picked', () => {
    const run = { ...snapshotAt(2, 'offer'), offerRule: { kind: 'pick', pick: 1 } as const };
    const html = renderWith({ run, runView: 'offer' }, <RunScreen />);
    expect(count(html, /<button type="button" class="pulse-card-tile run-offer-card"/g)).toBe(2);
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('aria-disabled="true"');
  });

  it('the loadout: deck cards as toggles with counts, the slot counter, the rules, Start and Back', () => {
    const html = screen(3, 'loadout', 'loadout');
    expect(html).toContain('data-run-view="loadout"');
    expect(html).toContain('Choose cards for level 4');
    expect(count(html, /data-run-deck-card=/g)).toBeGreaterThan(2);
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('0 of 2 slots chosen');
    expect(html).toContain('No cards: this level plays with the conditions only.');
    expect(html).toContain('Start level 4 without cards');
    expect(html).toContain('Combined park rules');
    expect(html).toContain('Back to the map');
    expect(html).toContain('After this level:');
  });

  it('the loadout with picks: selected tiles, full slots block the rest by aria-disabled', () => {
    const run = snapshotAt(3, 'loadout');
    const [a, b] = run.deck.map((row) => row.cardId);
    const html = renderWith({ run, runView: 'loadout', runLoadoutSelection: [a, b] }, <RunScreen />);
    expect(html).toContain('2 of 2 slots chosen');
    expect(count(html, /aria-pressed="true"/g)).toBe(2);
    expect(html).toContain('slots-full');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('Start level 4');
    expect(html).not.toContain('without cards');
  });

  it('the grant bonuses the app publishes show as the bonus line, else the profile decides', () => {
    expect(screen(2, 'loadout', 'loadout', { runBonusIds: ['nest-egg'] })).toContain('data-loadout-bonuses');
    expect(screen(2, 'loadout', 'loadout', { runBonusIds: [] })).not.toContain('data-loadout-bonuses');
    expect(screen(2, 'loadout', 'loadout', { runBonusIds: null, profile: null })).not.toContain('data-loadout-bonuses');
  });

  it('the cleared-level screen: heading, evidence, next level, one Continue button that takes the focus', () => {
    const html = screen(1, 'cleared', 'stage-result');
    expect(html).toContain('Level 2 cleared');
    expect(html).toContain('data-run-evidence');
    expect(html).toContain('data-run-next');
    expect(html).toContain('Continue to The Map');
    expect(count(html, /data-run-focus/g)).toBe(1);
    expect(count(html, /<button/g)).toBe(1);
  });

  it('victory and run over: a table with row headers, the rewards the profile answered, the end buttons', () => {
    const rewards: RunRewardResult = { eligible: true, alreadyRecorded: false, outcome: 'won', newlyDiscoveredCardIds: ['velvet-ropes'], newlyUnlockedDifficulties: ['tough'], newBestLevel: true, previousBestLevel: 0, bestLevel: 5 };
    const won = screen(0, 'won', 'end', { runRewards: rewards });
    expect(won).toContain('The Map is yours!');
    expect(count(won, /<th scope="row">/g)).toBe(5);
    expect(won).toContain('data-result-rewards');
    expect(won).toContain('New cards discovered: Velvet Ropes');
    expect(won).toContain('Tough difficulty unlocked');
    expect(won).toContain('data-run-end="same-seed"');
    expect(won).toContain('data-run-end="new-run"');
    expect(won).toContain('data-run-end="main-menu"');
    expect(count(won, /data-run-focus/g)).toBe(1);
    const lost = screen(2, 'lost', 'end', { runRewards: { ...rewards, outcome: 'lost', newlyDiscoveredCardIds: [], newlyUnlockedDifficulties: [], bestLevel: 2 } });
    expect(lost).toContain('Run over — level 3 of 5');
    expect(lost).toContain('Try this seed again');
    expect(lost).toContain('Cards are discovered when you win a run.');
    expect(screen(2, 'lost', 'end')).not.toContain('data-result-rewards');
  });

  it('while a question is open over it the whole overlay is inert', () => {
    expect(screen(1, 'loadout', 'map')).not.toContain(' inert');
    expect(screen(1, 'loadout', 'map', { leaveRunPrompt: { reason: 'new-run' } })).toContain('inert');
  });

  it('a view that does not match the phase reads as the one that does', () => {
    const offerRun = snapshotAt(1, 'offer');
    const loadoutRun = snapshotAt(1, 'loadout');
    expect(effectiveRunView(offerRun, 'loadout')).toBe('map');
    expect(effectiveRunView(loadoutRun, 'offer')).toBe('map');
    expect(effectiveRunView(loadoutRun, 'end')).toBe('map');
    expect(effectiveRunView(snapshotAt(1, 'lost'), 'map')).toBe('end');
    expect(effectiveRunView(offerRun, 'offer')).toBe('offer');
    expect(effectiveRunView(null, 'map')).toBeNull();
    expect(effectiveRunView(offerRun, null)).toBeNull();
    expect(screen(1, 'loadout', 'offer')).toContain('data-run-view="map"');
  });
});

describe('Phase 25 cards on The Map', () => {
  const withDeck = (ids: readonly string[]) => ({
    ...snapshotAt(3, 'loadout'),
    deck: ids.map((cardId) => ({ cardId: cardId as never, count: 1 })),
    deckSize: ids.length,
  });

  it('the shared tile keeps the pinned hooks and adds text badges and notes', () => {
    const html = renderToStaticMarkup(
      <CardTile as="button" card={{ icon: '💰', name: 'Big Loan', tagline: 't', upside: 'u', downside: 'd', kind: 'one-shot', rarity: 'rare', slotCost: 2 }} count={2} pressed={false} disabled notes={['Needs 2 free slots']} data={{ 'data-run-deck-card': 'big-loan' }} />,
    );
    expect(html).toMatch(/^<button type="button" class="pulse-card-tile" aria-pressed="false" aria-disabled="true" data-run-deck-card="big-loan">/);
    expect(html).toContain('<span class="pulse-card-head"><span aria-hidden="true">💰</span> <strong>Big Loan</strong> <b class="run-count">×2</b></span>');
    expect(html).toContain('<span class="card-badges"><span class="card-badge">One-shot</span><span class="card-badge">Rare · 2 slots</span></span>');
    expect(html).toContain('<span class="sr-only">Upside: </span>');
    expect(html).toContain('<span class="sr-only">Downside: </span>');
    expect(html).toContain('<span class="card-notes"><span class="card-note">Needs 2 free slots</span></span>');
    expect(renderToStaticMarkup(<CardBadges card={{ kind: 'stage', rarity: 'common', slotCost: 1 }} />)).toBe('');
    expect(renderToStaticMarkup(<CardTile card={{ icon: 'x', name: 'Y', upside: 'u', downside: 'd' }} />)).toMatch(/^<article class="pulse-card-tile">/);
  });

  it('the offer shows badges, notes and the one-shot line', () => {
    const run = { ...snapshotAt(2, 'offer'), pendingOffer: ['coach-party', 'master-builders'] as never };
    const html = renderWith({ run, runView: 'offer' }, <RunScreen />);
    expect(html).toContain('A one-shot is played from Park Pulse during a level; if you never play it, it comes back.');
    expect(html).toContain('<span class="card-badge">One-shot</span>');
    expect(html).toContain('<span class="card-badge">Rare · 2 slots</span>');
    expect(html).toContain('<span class="card-note">Takes 2 slots</span>');
    expect(count(html, /data-run-offer-card=/g)).toBe(2);
  });

  it('the loadout counts slots, blocks a rare that does not fit with the reason, and lists the pocket', () => {
    const run = withDeck(['grand-opening', 'master-builders', 'coach-party']);
    const html = renderWith({ run, runView: 'loadout', runLoadoutSelection: ['grand-opening', 'coach-party'] as never }, <RunScreen />);
    expect(html).toContain('2 of 2 slots chosen');
    expect(html).toContain('data-run-pocket');
    expect(html).toContain('Pocket: Coach Party');
    expect(html).toMatch(/aria-pressed="false" aria-disabled="true" data-run-deck-card="master-builders">/);
    const one = renderWith({ run, runView: 'loadout', runLoadoutSelection: ['grand-opening'] as never }, <RunScreen />);
    expect(one).toContain('Needs 2 free slots');
    expect(one).not.toContain('data-run-pocket');
  });

  it('the used drawer marks this level\'s unplayed one-shots as in the pocket', () => {
    const stage = snapshotAt(2, 'stage');
    const run = { ...stage, usedPile: [...stage.usedPile, { cardId: 'coach-party' as const, levelIndex: 2 }, { cardId: 'bridging-loan' as const, levelIndex: 2 }] };
    const played = [{ id: 'bridging-loan', name: 'Bridging Loan', icon: '🏦', upside: 'u', downside: 'd', kind: 'one-shot', playState: 'played' }] as never;
    const html = renderWith({ run, runView: 'map', runDrawer: 'used', activeCards: played }, <RunScreen />);
    expect(count(html, /in your pocket this level/g)).toBe(1);
    expect(count(html, /class="in-pocket"/g)).toBe(1);
    expect(html).toContain('<span class="card-badge">One-shot</span>');
  });
});

describe('RunScreen with a hostile snapshot (the screens never throw)', () => {
  it('no levels, an out-of-range level, unknown cards and an empty deck render something', () => {
    const good = snapshotAt(2, 'loadout');
    const cases = [
      { ...good, levels: [], levelCount: 0 },
      { ...good, levelIndex: 9 },
      { ...good, deck: [{ cardId: 'not-a-card' as never, count: 2 }], deckSize: 2 },
      { ...good, deck: [], deckSize: 0 },
      { ...snapshotAt(2, 'offer'), pendingOffer: ['not-a-card' as never] },
      { ...good, usedPile: [{ cardId: 'not-a-card' as never, levelIndex: 40 }] },
    ];
    for (const run of cases) {
      for (const view of ['map', 'offer', 'loadout', 'stage-result', 'end'] as const) {
        expect(() => renderWith({ run, runView: view, runDrawer: 'deck' }, <RunScreen />), `${view}`).not.toThrow();
      }
    }
  });
});

describe('LeaveRunPrompt', () => {
  it('is an alert dialog naming the run at stake, with the three choices', () => {
    const html = renderWith({ run: snapshotAt(2, 'loadout'), leaveRunPrompt: { reason: 'new-run' } }, <LeaveRunPrompt />);
    expect(html).toContain('role="alertdialog" aria-modal="true"');
    expect(html).toContain('Leave the run?');
    expect(html).toContain('level 3/5 · seed 1234');
    expect(html).toContain('data-leave-run="save-first"');
    expect(html).toContain('data-leave-run="leave"');
    expect(html).toContain('data-leave-run="cancel"');
    expect(renderWith({ leaveRunPrompt: null }, <LeaveRunPrompt />)).toBe('');
  });
});

describe('RunSetupPanel', () => {
  const setup = (slots: SaveSlotMeta[] = [], profile = profileAfter([]).snapshot): string => (
    renderToStaticMarkup(<RunSetupPanel slots={slots} profile={profile} now={10_000_000} onBack={() => undefined} />)
  );
  const runSlot = (phase: string): SaveSlotMeta => ({
    id: 'autosave', kind: 'auto', name: 'Autosave', scenarioId: 'the-map-stage', scenarioName: 'Level 3 · Winter', mode: 'run', playtimeSeconds: 1, savedAt: 9_000_000, schemaVersion: 11,
    contentVersion: 1, savedAtTick: 1, guestCount: 0, cash: 0, rating: 0, sizeBytes: 1, revision: 1, writerTabId: 't', status: { state: 'ok' },
    run: { seed: 4242, difficulty: 'standard', levelNumber: 3, levelCount: 5, biomeId: 'winter', phase, levelsCleared: 2 },
  } as unknown as SaveSlotMeta);

  it('a labelled seed field, a difficulty radio group with one stop, the route, Start run as the focus target', () => {
    const html = setup();
    expect(html).toContain('aria-label="The Map"');
    expect(html).toMatch(/<label for="run-seed">Seed<\/label>/);
    expect(html).toContain('data-run-seed');
    expect(html).toContain('role="radiogroup" aria-labelledby="run-difficulty-label"');
    expect(count(html, /role="radio"/g)).toBe(3);
    expect(count(html, /aria-checked="true"/g)).toBe(1);
    expect(count(html, /tabindex="0"/g)).toBe(1);
    expect(html).toContain('data-run-route');
    expect(html).toContain('Starter deck: ');
    expect(count(html, /data-panel-focus/g)).toBe(1);
    expect(html).toContain('data-run-start');
    expect(html).not.toContain('data-run-continue');
  });

  it('Tough is aria-disabled with the way to unlock it', () => {
    const html = setup();
    expect(html).toMatch(/aria-disabled="true"[^>]*data-run-difficulty="tough"/);
    expect(html).toContain('Win a Standard run to unlock');
  });

  it('a saved run adds Continue run (the focus target) and the warning above Start run', () => {
    const html = setup([runSlot('loadout')]);
    expect(html).toContain('data-run-continue');
    expect(html).toContain('Level 3 · Winter');
    expect(html).toContain('level 3/5 · seed 4242 · Standard · at the run map');
    expect(html).toContain('data-run-replace-note');
    expect(count(html, /data-panel-focus/g)).toBe(1);
    expect(html.indexOf('data-run-continue')).toBeLessThan(html.indexOf('data-run-start'));
  });

  it('the Continue card says older runs finish without rewards (Phase 25)', () => {
    expect(setup([runSlot('loadout')])).toContain('data-run-continue-note');
    expect(setup([runSlot('loadout')])).toContain('Runs started before this update finish without rewards.');
    expect(setup()).not.toContain('data-run-continue-note');
  });

  it('the difficulty details are the retune words', () => {
    expect(setup()).toContain('Shorter deadlines, higher targets, a little less cash.');
  });

  it('a run that is over is not continued', () => {
    expect(setup([runSlot('lost')])).not.toContain('data-run-continue');
    expect(setup([runSlot('won')])).not.toContain('data-run-replace-note');
  });
});

describe('the park HUD on The Map', () => {
  it('the objective panel names the run and lists its stage cards as in play', () => {
    const run = snapshotAt(2, 'stage');
    const scenario = { status: 'running', name: 'Level 3 · X', scenarioId: 'the-map-stage', objective: { name: 'Keep spirits high', metric: 'averageHappiness', kind: 'sustain', target: 70, current: 66, progressPercent: 20, onPace: true, sustainedSeconds: 60, requiredSustainSeconds: 300, projectedValue: null, comparison: 'atLeast', durationSeconds: 300 }, constraint: null, elapsedSeconds: 10, timeLimitSeconds: 1000, completedAtSeconds: null, resultEvidence: null } as never;
    const html = renderWith({ sessionMode: 'run', run, scenario, activeCards: [{ id: 'grand-opening', name: 'Grand Opening', icon: '🎈', upside: 'u', downside: 'd', kind: 'stage', rarity: 'common', slotCost: 1, playState: 'stage', playedAtSeconds: null, playable: false, hint: null, pending: null }] }, <ScenarioPanel />);
    expect(html).toContain(`THE MAP · LEVEL 3 OF 5 · ${run.levels[2].biomeName.toUpperCase()}`);
    expect(html).toContain('<ul class="scenario-cards" aria-label="Cards this level">');
    expect(html).toContain('<em>in play</em>');
    const scenarioHtml = renderWith({ sessionMode: 'scenario', run: null, scenario, activeCards: [] }, <ScenarioPanel />);
    expect(scenarioHtml).toContain('LEVEL 3 · X');
    expect(scenarioHtml).not.toContain('THE MAP');
  });

  it('the top bar says Run map in a run and Parks everywhere else', () => {
    const run = snapshotAt(1, 'stage');
    expect(renderWith({ sessionMode: 'run', run }, <TopBar />)).toContain('Run map');
    expect(renderWith({ sessionMode: 'run', run }, <TopBar />)).toContain('data-run-map-button');
    expect(renderWith({ sessionMode: 'sandbox', run: null }, <TopBar />)).not.toContain('Run map');
    expect(renderWith({ sessionMode: 'sandbox', run: null }, <TopBar />)).toContain('Parks');
  });

  it('the Map offer asks once with two buttons', () => {
    const html = renderWith({ mapOfferPending: true }, <MapOffer />);
    expect(html).toContain('Ready for The Map?');
    expect(html).toContain('Open The Map');
    expect(html).toContain('Not now');
    expect(renderWith({ mapOfferPending: false }, <MapOffer />)).toBe('');
  });
});

describe('the run snapshot the screens read', () => {
  it('is the model snapshot of the same state', () => {
    const state = runAt(1, 'loadout');
    expect(snapshotAt(1, 'loadout')).toEqual(runSnapshotOf(state));
  });
});
