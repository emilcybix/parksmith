import { describe, expect, it } from 'vitest';
import type { SaveSlotMeta } from '../app/saves/types';
import type { ScenarioRecord } from '../game/profile/types';
import { SCENARIOS } from '../game/scenarios/content';
import {
  buildScenarioBrowser,
  clearedSummary,
  describeBest,
  initialScenarioSelection,
  latestScenarioSaves,
  moveScenarioSelection,
  rewardLines,
} from './scenarioBrowserModel';
import { profileAfter } from './profileTestSupport';

const slot = (id: string, scenarioId: string | null, savedAt: number, mode?: SaveSlotMeta['mode']): SaveSlotMeta => ({
  id: id as SaveSlotMeta['id'],
  kind: id === 'autosave' ? 'auto' : 'manual',
  name: id,
  scenarioId: scenarioId as SaveSlotMeta['scenarioId'],
  scenarioName: scenarioId ?? 'Sandbox park',
  playtimeSeconds: 10,
  savedAt,
  schemaVersion: 10,
  contentVersion: 1,
  savedAtTick: 1,
  guestCount: 0,
  cash: 0,
  rating: 0,
  sizeBytes: 1,
  revision: 1,
  writerTabId: 't',
  status: { state: 'ok' },
  ...(mode === undefined ? {} : { mode }),
});

describe('scenario browser rows', () => {
  it('lists every scenario with difficulty text, and only the always-open ones are unlocked for a fresh profile', () => {
    const model = buildScenarioBrowser(profileAfter([]).snapshot, SCENARIOS[0].id);
    expect(model.rows.map((row) => row.id)).toEqual(SCENARIOS.map((definition) => definition.id));
    expect(model.total).toBe(SCENARIOS.length);
    expect(model.clearedCount).toBe(0);
    for (const row of model.rows) {
      expect(row.dots).toHaveLength(4);
      expect(row.difficultyLabel).not.toBe('');
      const always = SCENARIOS.find((definition) => definition.id === row.id)!.unlockedBy.kind === 'always';
      expect(row.status, row.id).toBe(always ? 'new' : 'locked');
      expect(row.lockedReason === null, row.id).toBe(always);
    }
    expect(model.rows.filter((row) => row.status === 'new').map((row) => row.id)).toContain('sunny-start');
  });

  it('shows a locked row with its condition and keeps Start refused with that reason', () => {
    const locked = SCENARIOS.find((definition) => definition.unlockedBy.kind !== 'always')!;
    const model = buildScenarioBrowser(profileAfter([]).snapshot, locked.id);
    expect(model.detail.canStart).toBe(false);
    expect(model.detail.lockedReason).toMatch(/^🔒 Clear .+ first\.$/);
    expect(model.rows.find((row) => row.id === locked.id)?.statusLabel).toBe('🔒 Locked');
  });

  it('opens a scenario once one of its prerequisites is cleared and marks the cleared one', () => {
    const { snapshot } = profileAfter(['sunny-start']);
    const model = buildScenarioBrowser(snapshot, 'sunny-start');
    expect(model.rows.find((row) => row.id === 'sunny-start')).toMatchObject({ status: 'cleared', statusLabel: 'Cleared ✓' });
    expect(model.clearedCount).toBe(1);
    const opened = SCENARIOS.filter((definition) => definition.unlockedBy.kind === 'clear-any' && definition.unlockedBy.scenarioIds.includes('sunny-start'));
    expect(opened.length).toBeGreaterThan(0);
    for (const definition of opened) expect(model.rows.find((row) => row.id === definition.id)?.status).not.toBe('locked');
  });

  it('describes the selected scenario: place, objective, facts, condition, best and rewards', () => {
    const { snapshot } = profileAfter(['sunny-start'], 872);
    const detail = buildScenarioBrowser(snapshot, 'sunny-start').detail;
    expect(detail.name).toBe('Sunny Start');
    expect(detail.place).toContain(' · ');
    expect(detail.objective).toMatch(/visitors/);
    expect(detail.facts).toMatch(/^Deadline: .+ · Starting cash: \$[\d,]+ · \d+ card slots?$/);
    expect(detail.best).toMatch(/^Best: cleared at 14:32 of /);
    expect(detail.startLabel).toBe('Choose cards and start');
    expect(detail.previewLabel).toMatch(/^Map preview: /);
    expect(detail.rewards[0].text).toContain('Nest egg');
    expect(detail.rewards[0].earned).toBe(true);
  });

  it('names the map preview and gate edge of a scenario on a Phase 24 map', () => {
    const detail = buildScenarioBrowser(profileAfter([]).snapshot, 'boardwalk-breeze').detail;
    expect(detail.place).toBe('Seaside Cove · Seaside');
    expect(detail.previewLabel).toMatch(/^Map preview: Seaside Cove, gate on the (north|east|south|west) edge$/);
    expect(detail.preview).not.toBeNull();
    expect(detail.rewards[0].text).toBe('Reward: unlocks Tiki Tumbler (ride) for every new park');
  });

  it('works without a profile (before the app published one)', () => {
    const model = buildScenarioBrowser(null, 'sunny-start');
    expect(model.clearedCount).toBe(0);
    expect(model.detail.canStart).toBe(true);
    expect(clearedSummary(null)).toBe(`0 of ${SCENARIOS.length} cleared`);
  });

  it('offers Resume only for a readable Scenario-mode save of that scenario, the newest one', () => {
    const saves = latestScenarioSaves([
      slot('autosave', 'sunny-start', 100, 'scenario'),
      slot('manual-1', 'sunny-start', 300, 'scenario'),
      slot('manual-2', 'sunny-start', 900, 'run'),
      slot('manual-3', null, 999, 'sandbox'),
      { ...slot('manual-4', 'penny-lane', 500, 'scenario'), status: { state: 'unreadable', code: 'corrupt', message: 'x' } },
    ]);
    expect(saves.get('sunny-start')).toBe('manual-1');
    expect(saves.has('penny-lane')).toBe(false);
    const model = buildScenarioBrowser(profileAfter([]).snapshot, 'sunny-start', [slot('manual-1', 'sunny-start', 300, 'scenario')]);
    expect(model.detail.savedSlotId).toBe('manual-1');
    expect(model.rows.find((row) => row.id === 'sunny-start')?.savedSlotId).toBe('manual-1');
    // a legacy record (no mode) of a scenario park reads as Scenario
    expect(latestScenarioSaves([slot('manual-1', 'penny-lane', 5)]).get('penny-lane')).toBe('manual-1');
  });
});

describe('best result and reward text', () => {
  const definition = SCENARIOS[0];
  const record = (over: Partial<ScenarioRecord>): ScenarioRecord => ({
    clears: 0, attempts: 0, bestClearSeconds: null, bestProgressPercent: 0, firstClearVia: null, ...over,
  });

  it('reads every state of a record', () => {
    expect(describeBest(definition, undefined)).toBe('Not played yet');
    expect(describeBest(definition, record({ clears: 3, attempts: 4, bestClearSeconds: 872, bestProgressPercent: 100, firstClearVia: 'scenario' }))).toMatch(/^Best: cleared at 14:32 of \d+:\d\d · 3 clears$/);
    expect(describeBest(definition, record({ attempts: 2, bestProgressPercent: 72 }))).toBe('Best try: 72% of the goal');
    expect(describeBest(definition, record({ attempts: 1, bestProgressPercent: 0 }))).toBe('Not played yet');
    expect(describeBest(definition, record({ clears: 1, attempts: 1, bestProgressPercent: 100, firstClearVia: 'tour-conversion' }))).toBe('Cleared on the Park Tour');
    expect(describeBest(definition, record({ attempts: 2, bestProgressPercent: 250 }))).toBe('Best try: 99% of the goal');
  });

  it('lists unlock and bonus rewards, marks earned ones and never leaves the list empty', () => {
    const maple = SCENARIOS.find((candidate) => candidate.id === 'harvest-festival')!;
    const lines = rewardLines(maple, null);
    expect(lines.map((line) => line.text)).toEqual([
      'Reward: unlocks Lantern Maple (scenery) for every new park',
      expect.stringMatching(/^Reward: permanent bonus Trusted crew · /),
    ]);
    expect(lines.every((line) => !line.earned)).toBe(true);
    const bare = { ...maple, rewards: { ...maple.rewards, unlocks: [], bonuses: [] } };
    expect(rewardLines(bare, null)).toEqual([{ text: 'Reward: a new Pulse Card draft', earned: false }]);
  });
});

describe('selection and keys', () => {
  it('starts on the first open, uncleared scenario, else the first', () => {
    expect(initialScenarioSelection(null)).toBe(SCENARIOS[0].id);
    expect(initialScenarioSelection(profileAfter(['sunny-start']).snapshot)).not.toBe('sunny-start');
    expect(initialScenarioSelection(profileAfter(SCENARIOS.map((definition) => definition.id)).snapshot)).toBe(SCENARIOS[0].id);
  });

  it('moves like a radio group: arrows wrap, Home and End jump, other keys are not ours', () => {
    const ids = SCENARIOS.map((definition) => definition.id);
    expect(moveScenarioSelection(ids[0], 'ArrowDown')).toBe(ids[1]);
    expect(moveScenarioSelection(ids[0], 'ArrowUp')).toBe(ids[ids.length - 1]);
    expect(moveScenarioSelection(ids[ids.length - 1], 'ArrowRight')).toBe(ids[0]);
    expect(moveScenarioSelection(ids[3], 'Home')).toBe(ids[0]);
    expect(moveScenarioSelection(ids[3], 'End')).toBe(ids[ids.length - 1]);
    for (const key of ['Enter', ' ', 'Tab', 'a', 'Escape']) expect(moveScenarioSelection(ids[0], key), key).toBeNull();
  });

  it('falls back to the first scenario for an unknown selection', () => {
    expect(buildScenarioBrowser(null, 'nope' as never).selectedId).toBe(SCENARIOS[0].id);
  });
});
