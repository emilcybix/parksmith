import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { STARTING_CARD_IDS } from '../game/cards/content';
import type { SaveSlotMeta } from '../app/saves/types';
import type { ProfileSnapshot, ScenarioRewardResult } from '../game/profile/types';
import type { ScenarioSnapshot } from '../game/scenarios/types';
import { CollectionPanel } from './CollectionPanel';
import { NewParkPanel } from './NewParkPanel';
import { ActiveCardsView, ResultOverlayView } from './ScenarioHud';
import { ScenarioBrowser } from './ScenarioBrowser';
import { profileAfter } from './profileTestSupport';

const count = (html: string, pattern: RegExp): number => (html.match(pattern) ?? []).length;

const noop = (): void => undefined;
const browser = (props: Partial<Parameters<typeof ScenarioBrowser>[0]> = {}): string => renderToStaticMarkup(
  <ScenarioBrowser onBack={noop} profile={profileAfter([]).snapshot} {...props} />,
);

describe('Scenario browser markup', () => {
  it('is a labelled radio group of every scenario with one tab stop, and the focus target on the selected row', () => {
    const html = browser();
    expect(html).toContain('role="radiogroup" aria-label="Scenarios"');
    expect(count(html, /role="radio"/g)).toBe(10);
    expect(count(html, /aria-checked="true"/g)).toBe(1);
    expect(count(html, /tabindex="0"/g)).toBe(1);
    expect(count(html, /data-panel-focus/g)).toBe(1);
    expect(html).toContain('Difficulty: ');
  });

  it('lists locked scenarios by name and state, and the open one starts', () => {
    const html = browser();
    expect(count(html, /browser-row locked/g)).toBe(9);
    expect(html).toContain('Locked.');
    expect(html).toContain('data-scenario-start');
    expect(html).toContain('aria-disabled="false"');
    expect(html).toContain('Choose cards and start');
    expect(html).toContain('0 of 10 cleared');
  });

  it('selects the first open uncleared scenario and shows its goal, rewards and best', () => {
    const html = browser({ profile: profileAfter(['sunny-start']).snapshot });
    expect(html).toContain('1 of 10 cleared');
    expect(html).toContain('Cleared ✓');
    expect(html).toContain('Reward: ');
    expect(html).toContain('data-scenario-detail=');
    expect(html).not.toContain('data-scenario-detail="sunny-start"');
  });

  it('offers Resume only with a saved Scenario-mode park of the selected scenario', () => {
    expect(browser()).not.toContain('data-scenario-resume');
    const saved = { id: 'manual-1', kind: 'manual', name: 'x', scenarioId: 'sunny-start', scenarioName: 'Sunny Start', mode: 'scenario', playtimeSeconds: 1, savedAt: 5, schemaVersion: 10, contentVersion: 1, savedAtTick: 1, guestCount: 0, cash: 0, rating: 0, sizeBytes: 1, revision: 1, writerTabId: 't', status: { state: 'ok' } } as SaveSlotMeta;
    const html = browser({ slots: [saved] });
    expect(html).toContain('data-scenario-resume');
    expect(html).toContain('Saved park');
  });

  it('draws a map preview canvas with a text alternative', () => {
    expect(browser()).toMatch(/<canvas[^>]*role="img"[^>]*aria-label="Map preview: [^"]+"/);
  });
});

describe('Collection markup', () => {
  const collection = (profile: ProfileSnapshot | null): string => renderToStaticMarkup(<CollectionPanel onBack={noop} profile={profile} />);

  it('is a tablist of four tabs with one tab stop and a labelled tabpanel', () => {
    const html = collection(profileAfter([]).snapshot);
    expect(html).toContain('role="tablist"');
    expect(count(html, /role="tab"/g)).toBe(4);
    expect(count(html, /tabindex="0"/g)).toBe(1);
    expect(count(html, /aria-selected="true"/g)).toBe(1);
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('Unlocked buildings are in every new park, in every mode.');
    expect(html).toContain('Clear Boardwalk Breeze to unlock');
  });

  it('shows the storage note when progress cannot be kept, and not otherwise', () => {
    expect(collection({ ...profileAfter([]).snapshot, persistence: 'unavailable' })).toContain('Progress is not saved in this browser');
    expect(collection({ ...profileAfter([]).snapshot, persistence: 'read-only' })).toContain('written by a newer Parksmith');
    expect(collection(profileAfter([]).snapshot)).not.toContain('collection-persistence');
  });

  it('renders without a profile at all', () => {
    expect(collection(null)).toContain('0 of 4 unlocked');
  });

  it('the Pulse Cards tab groups the cards by family under headings, with text badges and hidden undiscovered cards', () => {
    const profile = { ...profileAfter([]).snapshot, collectionCardIds: ['grand-opening', 'master-builders', 'coach-party'] as never[] };
    const html = renderToStaticMarkup(<CollectionPanel onBack={noop} profile={profile} initialTab="cards" />);
    expect(count(html, /<h3 /g)).toBe(8);
    expect(count(html, /data-collection-family=/g)).toBe(8);
    expect(html).toMatch(/<h3 id="[^"]+">Day and night <small>0 of 6 discovered<\/small><\/h3>/);
    expect(html).toContain('Build and tools <small>1 of 4 discovered</small>');
    expect(html).toContain('<span class="card-badge">Rare · 2 slots</span>');
    expect(html).toContain('<span class="card-badge">One-shot</span>');
    expect(html).toContain('Undiscovered · Uncommon');
    expect(count(html, /<strong>\?\?\?<\/strong>/g)).toBe(45);
    expect(count(html, /Upside: /g)).toBe(3);
    expect(html).toMatch(/aria-labelledby="[^"]+-family-weather"/);
  });
});

describe('Sandbox panel', () => {
  it('is titled Sandbox and shows the resume row only when offered', () => {
    expect(renderToStaticMarkup(<NewParkPanel onBack={() => undefined} />)).not.toContain('data-pick-resume');
    const html = renderToStaticMarkup(
      <NewParkPanel onBack={() => undefined} resume={{ slotId: 'manual-1', text: 'Resume your latest sandbox — Red Rock Canyon · 2 days ago', short: 'x' }} />,
    );
    expect(html).toContain('<h2>Sandbox</h2>');
    expect(html).toContain('data-pick-resume');
    expect(html).toContain('Resume your latest sandbox — Red Rock Canyon · 2 days ago');
  });
});

describe('Result overlay and dashboard markup', () => {
  const scenario = {
    scenarioId: 'sunny-start', name: 'Sunny Start', status: 'succeeded', resultEvidence: 'Reached the goal.',
    completedAtSeconds: 725, elapsedSeconds: 725, timeLimitSeconds: 1080,
  } as unknown as ScenarioSnapshot;
  const rewards = (over: Partial<ScenarioRewardResult> = {}): ScenarioRewardResult => ({
    scenarioId: 'sunny-start', outcome: 'succeeded', firstClear: true,
    newlyUnlockedBuildingIds: ['tiki-tumbler'], newlyEarnedBonusIds: ['nest-egg'], newlyAvailableScenarioIds: ['boardwalk-breeze'],
    previousBestSeconds: null, newBest: true, eligible: true, ...over,
  });
  const view = (over: Partial<Parameters<typeof ResultOverlayView>[0]>): string => renderToStaticMarkup(
    <ResultOverlayView scenario={scenario} dismissed={false} rewardDraft={null} mode="scenario" rewards={null} profile={profileAfter([]).snapshot} startScreen={false} {...over} />,
  );

  it('lists the rewards of a first clear above the actions of the Scenario mode', () => {
    const html = view({ rewards: rewards() });
    expect(html).toContain('Rewards earned for good');
    expect(html).toContain('Tiki Tumbler unlocked');
    expect(html).toContain('Nest egg');
    expect(html).toContain('New scenario available: Boardwalk Breeze');
    expect(html).toContain('Back to scenarios');
    expect(html).toContain('Next: Boardwalk Breeze');
    expect(html).not.toContain('Back to the tour map');
    expect(html.indexOf('data-result-rewards')).toBeLessThan(html.indexOf('Back to scenarios'));
  });

  it('shows the draft instead of the actions while a draft is pending, rewards still above it', () => {
    const html = view({ rewards: rewards(), rewardDraft: [STARTING_CARD_IDS[0]] });
    expect(html).toContain('Choose one reward card');
    expect(html).toContain('data-result-rewards');
    expect(html).not.toContain('Back to scenarios');
  });

  it('ignores a reward result that belongs to another scenario', () => {
    const html = view({ rewards: rewards({ scenarioId: 'penny-lane' }) });
    expect(html).not.toContain('data-result-rewards');
    expect(html).toContain('Back to scenarios');
  });

  it('never renders for a park on The Map: the run screens are its result', () => {
    expect(view({ mode: 'run', rewards: rewards() })).toBe('');
  });

  it('says there are no rewards for an ineligible park', () => {
    expect(view({ rewards: rewards({ eligible: false }) })).toContain('No rewards: this park&#x27;s rules do not match');
  });

  it('offers Try again with the same seed after a failure in Scenario mode', () => {
    const html = view({ scenario: { ...scenario, status: 'failed' } as ScenarioSnapshot });
    expect(html).toContain('Try again (same seed)');
    expect(html).not.toContain('data-result-rewards');
  });

  it('is not shown while running, dismissed or behind the start screen', () => {
    expect(view({ scenario: { ...scenario, status: 'running' } as ScenarioSnapshot })).toBe('');
    expect(view({ dismissed: true })).toBe('');
    expect(view({ startScreen: true })).toBe('');
    expect(view({ scenario: null })).toBe('');
  });

  it('the dashboard lists permanent bonuses (or None) in Scenario parks and stays hidden in a plain Sandbox', () => {
    const bonus = { id: 'nest-egg' as const, name: 'Nest egg', icon: '$', summary: 'Parks start with $500 more cash.' };
    expect(renderToStaticMarkup(<ActiveCardsView activeCards={[]} activeBonuses={[]} mode="sandbox" />)).toBe('');
    expect(renderToStaticMarkup(<ActiveCardsView activeCards={[]} activeBonuses={[]} mode="scenario" />)).toContain('None');
    const html = renderToStaticMarkup(<ActiveCardsView activeCards={[]} activeBonuses={[bonus]} mode="sandbox" />);
    expect(html).toContain('Permanent bonuses');
    expect(html).toContain('Nest egg');
  });
});
