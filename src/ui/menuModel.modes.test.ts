import { describe, expect, it } from 'vitest';
import type { SaveSlotMeta } from '../app/saves/types';
import { PULSE_CARDS } from '../game/cards/content';
import { BONUSES } from '../game/profile/bonuses';
import { PROFILE_GATED_IDS } from '../game/profile/unlocks';
import { SCENARIOS } from '../game/scenarios/content';
import {
  buildModeChooser,
  buildStartMenu,
  collectionSummary,
  describeContinue,
  describeProfileNotice,
  latestSlotByMode,
  menuBackTarget,
  menuEscapeStep,
  modeEntryDetails,
  modeResumeOffer,
  type StartMenuInput,
} from './menuModel';
import { MODE_DETAIL, MENU_MODE_ORDER, knownMode, modeLabel, slotModeOf } from './modeLabels';
import { profileAfter } from './profileTestSupport';

const NOW = 1_000_000_000;
const DAY = 86_400_000;

const slot = (id: string, over: Partial<SaveSlotMeta> = {}): SaveSlotMeta => ({
  id: id as SaveSlotMeta['id'],
  kind: id === 'autosave' ? 'auto' : 'manual',
  name: id === 'autosave' ? 'Autosave' : `Park ${id}`,
  scenarioId: null,
  scenarioName: 'Sandbox park',
  playtimeSeconds: 600,
  savedAt: NOW - 5 * 60_000,
  schemaVersion: 10,
  contentVersion: 1,
  savedAtTick: 1,
  guestCount: 10,
  cash: 100,
  rating: 50,
  sizeBytes: 1,
  revision: 1,
  writerTabId: 't',
  status: { state: 'ok' },
  ...over,
});

const input = (over: Partial<StartMenuInput> = {}): StartMenuInput => ({
  slots: [], listState: 'ready', recoveryPhase: 'idle', busy: false, previewPhase: 'ready', now: NOW, ...over,
});

describe('mode labels', () => {
  it('names the three modes, in the menu order The Map, Scenario, Sandbox', () => {
    expect(MENU_MODE_ORDER.map(modeLabel)).toEqual(['The Map', 'Scenario', 'Sandbox']);
    expect(knownMode('run')).toBe('run');
    expect(knownMode('chaos')).toBeNull();
    expect(knownMode(undefined)).toBeNull();
  });

  it('reads a save slot by its mode, else by its scenario (legacy saves), and survives a hostile value', () => {
    expect(slotModeOf({ mode: 'run', scenarioId: 'penny-lane' })).toBe('run');
    expect(slotModeOf({ scenarioId: 'penny-lane' })).toBe('scenario');
    expect(slotModeOf({ scenarioId: null })).toBe('sandbox');
    expect(slotModeOf({ mode: 'weird' as never, scenarioId: null })).toBe('sandbox');
    expect(slotModeOf({ mode: 'weird' as never, scenarioId: 'penny-lane' })).toBe('scenario');
  });
});

describe('Continue names the mode first', () => {
  it('sandbox, scenario and The Map', () => {
    expect(describeContinue(slot('autosave', { mapName: 'Red Rock Canyon', mode: 'sandbox' }), NOW).subtitle).toBe('Sandbox · Red Rock Canyon · Autosave · 5 min ago');
    expect(describeContinue(slot('autosave', { scenarioId: 'penny-lane', scenarioName: 'Penny Lane', mode: 'scenario' }), NOW).subtitle).toBe('Scenario · Penny Lane · Autosave · 5 min ago');
    expect(describeContinue(slot('manual-1', { scenarioId: 'garden-gala', scenarioName: 'Garden Gala', mode: 'run', name: 'Garden Gala' }), NOW).subtitle).toBe('The Map · Garden Gala · 5 min ago');
    expect(describeContinue(slot('autosave', { scenarioId: 'garden-gala', scenarioName: 'Garden Gala' }), NOW).mode, 'legacy').toBe('scenario');
  });
});

describe('latest park of each mode', () => {
  const slots = [
    slot('autosave', { savedAt: NOW - 1000, mode: 'scenario', scenarioId: 'penny-lane', scenarioName: 'Penny Lane' }),
    slot('manual-1', { savedAt: NOW - 2 * DAY, mode: 'sandbox', mapName: 'Red Rock Canyon' }),
    slot('manual-2', { savedAt: NOW - 3 * DAY, mode: 'sandbox', mapName: 'Old map' }),
    slot('manual-3', { savedAt: NOW - 9 * DAY, mode: 'run', scenarioId: 'garden-gala', scenarioName: 'Garden Gala' }),
    slot('manual-4', { savedAt: NOW, mode: 'run', status: { state: 'unreadable', code: 'corrupt', message: 'x' } }),
  ];

  it('picks the newest readable save per mode', () => {
    const map = latestSlotByMode(slots);
    expect(map.get('scenario')?.id).toBe('autosave');
    expect(map.get('sandbox')?.id).toBe('manual-1');
    expect(map.get('run')?.id).toBe('manual-3');
  });

  it('offers a resume only for a mode Continue does not already mean', () => {
    expect(modeResumeOffer(slots, 'scenario', NOW)).toBeNull();
    expect(modeResumeOffer(slots, 'sandbox', NOW)).toEqual({
      slotId: 'manual-1',
      text: 'Resume your latest sandbox — Red Rock Canyon · 2 days ago',
      short: 'Red Rock Canyon, 2 days ago',
    });
    expect(modeResumeOffer(slots, 'run', NOW)?.text).toBe('Resume your latest park on The Map — Garden Gala · 9 days ago');
    expect(modeResumeOffer([], 'sandbox', NOW)).toBeNull();
    expect(modeResumeOffer([slots[0]], 'sandbox', NOW)).toBeNull();
  });

  it('ends the entry detail with "Latest: ..." only then', () => {
    const details = modeEntryDetails(null, slots, NOW);
    expect(details.sandbox).toBe(`${MODE_DETAIL.sandbox} · Latest: Red Rock Canyon, 2 days ago`);
    expect(details.scenario).not.toContain('Latest');
    expect(details.run).toBe(`${MODE_DETAIL.run} · Latest: Garden Gala, 9 days ago`);
  });
});

describe('start menu with a profile', () => {
  it('says how many scenarios are cleared and what the Collection holds', () => {
    const { snapshot } = profileAfter(['sunny-start', 'penny-lane']);
    const model = buildStartMenu(input({ profile: snapshot }));
    const byId = new Map(model.items.map((item) => [item.id, item]));
    expect(byId.get('scenarios')?.detail).toBe(`${MODE_DETAIL.scenario} · 2 of ${SCENARIOS.length} cleared`);
    expect(byId.get('the-map')?.detail).toBe('Five generated parks, one deck of cards');
    expect(byId.get('collection')?.detail).toBe(collectionSummary(snapshot));
    expect(byId.get('collection')?.detail).toMatch(/^\d+ of \d+ buildings · \d+ of \d+ cards · 2 of \d+ bonuses$/);
    expect(model.notice).toBeNull();
  });

  it('counts a fresh profile honestly and without a profile at all', () => {
    expect(collectionSummary(null)).toBe(`0 of ${PROFILE_GATED_IDS.length} buildings · 0 of ${PULSE_CARDS.length} cards · 0 of ${BONUSES.length} bonuses`);
    // Phase 25: the whole pool of 48 counts (one-shots too: a won run discovers every card in its deck).
    expect(PULSE_CARDS).toHaveLength(48);
    expect(collectionSummary(profileAfter([]).snapshot)).toContain('3 of 48 cards');
    const fresh = profileAfter([]).snapshot;
    expect(collectionSummary(fresh)).toContain(`of ${PROFILE_GATED_IDS.length} buildings`);
    expect(buildStartMenu(input()).items.find((item) => item.id === 'scenarios')?.detail).toBe(`${MODE_DETAIL.scenario} · 0 of ${SCENARIOS.length} cleared`);
  });

  it('The Map is the primary, focused entry without a save; Continue wins with one', () => {
    const none = buildStartMenu(input());
    expect(none.defaultFocus).toBe('the-map');
    expect(none.items.filter((item) => item.primary).map((item) => item.id)).toEqual(['the-map']);
    const some = buildStartMenu(input({ slots: [slot('autosave')] }));
    expect(some.defaultFocus).toBe('continue');
    expect(some.items.filter((item) => item.primary).map((item) => item.id)).toEqual(['continue']);
  });

  it('turns the conversion notice into one calm sentence', () => {
    expect(describeProfileNotice(null)).toBeNull();
    const text = describeProfileNotice({
      kind: 'tour-converted',
      clearedScenarioIds: ['sunny-start', 'penny-lane'],
      bonusIds: ['nest-egg', 'research-grant'],
      unlockedBuildingIds: [],
    })?.text;
    expect(text).toBe('Your Park Tour progress carried over: 2 parks (Sunny Start, Penny Lane) now count as cleared scenarios. You earned Nest egg, Research grant.');
    const mid = profileAfter([]).snapshot;
    expect(buildStartMenu(input({ profile: { ...mid, notice: { kind: 'tour-converted', clearedScenarioIds: ['sunny-start'], bonusIds: [], unlockedBuildingIds: [] } } })).notice?.text)
      .toBe('Your Park Tour progress carried over: 1 park (Sunny Start) now count as cleared scenarios.');
  });
});

describe('the Parks chooser and Back', () => {
  it('lists The Map, Scenario and Sandbox with the start menu details', () => {
    const choices = buildModeChooser(null);
    expect(choices.map((choice) => [choice.id, choice.label, choice.mode])).toEqual([
      ['the-map', 'The Map', 'run'], ['scenarios', 'Scenario', 'scenario'], ['sandbox', 'Sandbox', 'sandbox'],
    ]);
    expect(choices[0].detail).toBe(MODE_DETAIL.run);
    expect(choices[2].detail).toBe(MODE_DETAIL.sandbox);
  });

  it('Back from a mode panel in the pause menu returns to the chooser; everywhere else to the list', () => {
    expect(menuBackTarget('pause', 'scenarios')).toBe('modes');
    expect(menuBackTarget('pause', 'new-park')).toBe('modes');
    expect(menuBackTarget('pause', 'modes')).toBe('main');
    expect(menuBackTarget('pause', 'collection')).toBe('main');
    expect(menuBackTarget('start', 'scenarios')).toBe('main');
    expect(menuBackTarget('start', 'collection')).toBe('main');
  });

  it('Escape in any sub-panel goes back; the pause list resumes; the start list stays', () => {
    for (const panel of ['scenarios', 'collection', 'modes', 'new-park'] as const) expect(menuEscapeStep('pause', panel)).toBe('back');
    expect(menuEscapeStep('pause', 'main')).toBe('resume');
    expect(menuEscapeStep('start', 'main')).toBe('none');
  });
});
