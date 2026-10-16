import { describe, expect, it } from 'vitest';
import type { RecoveryOffer } from '../app/saves/recoveryTypes';
import type { SaveSlotMeta } from '../app/saves/types';
import { buildModeChooser, buildPauseMenu, buildStartMenu, describeContinue, menuBackTarget, menuEscapeStep, modeResumeOffer, type StartMenuInput } from './menuModel';
import { MODE_DETAIL, slotRunOf } from './modeLabels';
import { describeInterruptedPark, describeRecoveryOffer } from './recoveryModel';
import { rowDisplayName, rowPlaceText, type SlotRow } from './saveLoadModel';
import { describeLeaveRun, shouldConfirmLeavingRun } from './leaveRunModel';
import { describeMapOffer } from './mapOfferModel';
import { autosavedRunAtStake, latestRunSlot } from '../app/runSlots';
import { buildRunSetup } from './runSetupModel';
import { runSummaryOf } from '../game/run';
import { baseRun } from './runTestSupport';

const NOW = 10_000_000;

const runMeta = (overrides: Partial<SaveSlotMeta> & { run?: unknown } = {}): SaveSlotMeta => ({
  id: 'autosave', kind: 'auto', name: 'Autosave', scenarioId: 'the-map-stage' as never, scenarioName: 'Level 3 · Winter', mode: 'run',
  playtimeSeconds: 640, savedAt: NOW - 5 * 60_000, schemaVersion: 11, contentVersion: 1, savedAtTick: 1, guestCount: 80, cash: 4200, rating: 61, sizeBytes: 1, revision: 1,
  writerTabId: 't', status: { state: 'ok' },
  run: { seed: 4242, difficulty: 'standard', levelNumber: 3, levelCount: 5, biomeId: 'winter', phase: 'loadout', levelsCleared: 2 },
  ...overrides,
} as SaveSlotMeta);

const input = (slots: SaveSlotMeta[]): StartMenuInput => ({ slots, listState: 'ready', recoveryPhase: 'idle', busy: false, previewPhase: 'ready', now: NOW });

describe('The Map in the start menu', () => {
  it('the entry says what a run is', () => {
    expect(MODE_DETAIL.run).toBe('Five generated parks, one deck of cards');
    const model = buildStartMenu(input([]));
    expect(model.items[0].id).toBe('the-map');
    expect(model.items[0].detail).toBe('Five generated parks, one deck of cards');
    expect(buildModeChooser(null)[0].detail).toBe('Five generated parks, one deck of cards');
  });

  it('Continue names the run: "The Map · level 3/5 · seed N", at the run map between stages', () => {
    const card = describeContinue(runMeta(), NOW);
    expect(card.title).toBe('Level 3 · Winter');
    expect(card.mode).toBe('run');
    expect(card.subtitle).toBe('The Map · level 3/5 · seed 4242 · at the run map · Autosave · 5 min ago');
    const inStage = describeContinue(runMeta({ run: { seed: 4242, difficulty: 'standard', levelNumber: 3, levelCount: 5, biomeId: 'winter', phase: 'stage', levelsCleared: 2 } }), NOW);
    expect(inStage.subtitle).toBe('The Map · level 3/5 · seed 4242 · Autosave · 5 min ago');
    const over = describeContinue(runMeta({ run: { seed: 4242, difficulty: 'standard', levelNumber: 3, levelCount: 5, biomeId: 'winter', phase: 'lost', levelsCleared: 2 } }), NOW);
    expect(over.subtitle).toContain('run over');
    const model = buildStartMenu(input([runMeta()]));
    expect(model.items[0].detail).toBe(card.subtitle);
    expect(model.defaultFocus).toBe('continue');
  });

  it('a run record without a valid summary keeps the plain Scenario-style text, never a crash', () => {
    for (const run of [undefined, null, 7, { seed: 'x' }]) {
      const card = describeContinue(runMeta({ run: run as never }), NOW);
      expect(card.mode).toBe('run');
      expect(card.subtitle.startsWith('The Map')).toBe(true);
      expect(card.subtitle).not.toContain('level ');
    }
    expect(slotRunOf(runMeta({ run: undefined }))).toBeNull();
    expect(slotRunOf(null)).toBeNull();
  });

  it('a Sandbox or Scenario save never reads a run', () => {
    const sandbox = { ...runMeta(), mode: 'sandbox', scenarioId: null, scenarioName: 'Sandbox park' } as SaveSlotMeta;
    expect(describeContinue(sandbox, NOW).subtitle.startsWith('Sandbox')).toBe(true);
  });

  it('offers the latest run only when Continue does not already mean it, naming its level', () => {
    const sandbox = { ...runMeta({ id: 'manual-1', kind: 'manual', name: 'x', savedAt: NOW - 1000 }), mode: 'sandbox', scenarioId: null, scenarioName: 'Sandbox park', run: undefined } as SaveSlotMeta;
    const offer = modeResumeOffer([sandbox, runMeta()], 'run', NOW);
    expect(offer?.text).toContain('Level 3 · Winter (level 3/5 · seed 4242)');
    expect(modeResumeOffer([runMeta()], 'run', NOW)).toBeNull();
  });
});

describe('The Map in the pause menu', () => {
  const pause = (run: ReturnType<typeof runSummaryOf> | null) => buildPauseMenu({ quickSaveSlotId: 'manual-1', persistence: 'ready', unsavedChanges: false, run });

  it('a park on The Map gets a Run map entry right under Resume', () => {
    const items = pause(runSummaryOf(baseRun())).items;
    expect(items.map((item) => item.id).slice(0, 3)).toEqual(['resume', 'run-map', 'save']);
    expect(items[1].detail).toMatch(/^level 1\/5 · seed 1234 · /);
    expect(pause(null).items.some((item) => item.id === 'run-map')).toBe(false);
  });

  it('a run that is over has no map to open', () => {
    expect(pause({ ...runSummaryOf(baseRun()), phase: 'lost' }).items.some((item) => item.id === 'run-map')).toBe(false);
    expect(pause({ ...runSummaryOf(baseRun()), phase: 'won' }).items.some((item) => item.id === 'run-map')).toBe(false);
    expect(buildPauseMenu({ quickSaveSlotId: null, persistence: 'ready', unsavedChanges: false }).items.map((item) => item.id)).not.toContain('run-map');
  });
});

describe('The Map setup panel navigation', () => {
  it('Back and Escape return where the panel was opened from', () => {
    expect(menuBackTarget('start', 'the-map')).toBe('main');
    expect(menuBackTarget('pause', 'the-map')).toBe('modes');
    expect(menuEscapeStep('start', 'the-map')).toBe('back');
    expect(menuEscapeStep('pause', 'the-map')).toBe('back');
  });
});

describe('Save / Load and recovery texts for a run', () => {
  const row = (meta: SaveSlotMeta): SlotRow => ({ slotId: meta.id, kind: meta.kind, label: String(meta.id), meta });

  it('a run row says the level and the seed after the mode chip', () => {
    expect(rowPlaceText(runMeta(), 'Meadow Garden · Meadow')).toBe('level 3/5 · seed 4242 · Standard');
    expect(rowDisplayName(row(runMeta()))).toBe('Autosave · The Map');
    const sandbox = { ...runMeta(), mode: 'sandbox', scenarioId: null, run: undefined } as SaveSlotMeta;
    expect(rowPlaceText(sandbox, 'Meadow Garden · Meadow')).toBe('Meadow Garden · Meadow');
    expect(rowPlaceText(runMeta({ run: { nonsense: true } as never }), 'fallback')).toBe('fallback');
  });

  const offer = (run: unknown, mode: RecoveryOffer['mode'] = 'run'): RecoveryOffer => ({
    interruptedSessionIds: ['a'], sessionId: 'a', parkName: 'Level 3 · Winter', scenarioId: null, mode, startedAt: NOW - 3_600_000, lastSeenAt: NOW - 200_000,
    autosave: { name: 'Autosave', scenarioName: 'Level 3 · Winter', savedAt: NOW - 5 * 60_000, playtimeSeconds: 725, guestCount: 100, cash: 5000, rating: 70, revision: 1, run } as RecoveryOffer['autosave'],
    evidence: 'lock-free',
  });

  it('the recovery prompt offers the run back with its level and seed', () => {
    const run = { seed: 4242, difficulty: 'standard', levelNumber: 3, levelCount: 5, biomeId: 'winter', phase: 'stage', levelsCleared: 2 };
    const model = describeRecoveryOffer(offer(run), NOW);
    expect(model.title).toBe('Pick up your run where you left off?');
    expect(model.summary).toContain('your run on The Map (Level 3 · Winter, level 3/5 · seed 4242)');
    expect(describeInterruptedPark(offer(run))).toBe('your run on The Map (Level 3 · Winter, level 3/5 · seed 4242)');
  });

  it('a recovery without a readable run keeps the Phase 22 text', () => {
    expect(describeRecoveryOffer(offer(undefined), NOW).title).toBe('Pick up where you left off?');
    expect(describeInterruptedPark(offer(undefined))).toBe('Level 3 · Winter on The Map');
    expect(describeInterruptedPark(offer({ seed: 1 }, 'sandbox'))).toBe('your Sandbox park');
  });
});

describe('leaving a run', () => {
  it('asks only while the run has levels to play', () => {
    const summary = runSummaryOf(baseRun());
    expect(shouldConfirmLeavingRun(summary)).toBe(true);
    expect(shouldConfirmLeavingRun({ ...summary, phase: 'stage' })).toBe(true);
    expect(shouldConfirmLeavingRun({ ...summary, phase: 'won' })).toBe(false);
    expect(shouldConfirmLeavingRun({ ...summary, phase: 'lost' })).toBe(false);
    expect(shouldConfirmLeavingRun(null)).toBe(false);
  });

  it('says which run is at stake and what replaces it, with three choices and Save first as the main one', () => {
    const model = describeLeaveRun({ reason: 'new-park' }, { levelIndex: 2, levelCount: 5, seed: 1234 });
    expect(model.title).toBe('Leave the run?');
    expect(model.text).toContain('level 3/5 · seed 1234');
    expect(model.text).toContain('a new park');
    expect(model.choices.map((choice) => choice.id)).toEqual(['save-first', 'leave', 'cancel']);
    expect(model.choices.filter((choice) => choice.primary).map((choice) => choice.id)).toEqual(['save-first']);
    expect(describeLeaveRun({ reason: 'load' }, null).text).toContain('another save');
    expect(describeLeaveRun({ reason: 'scenario' }, null).text).toContain('a Scenario park');
    expect(describeLeaveRun({ reason: 'new-run' }, null).text).toContain('a new run');
  });

  it('on the start screen names the autosaved run, offers no Save first, and focuses Cancel', () => {
    const saved = { seed: 5150, difficulty: 'standard', levelNumber: 2, levelCount: 5, biomeId: 'winter', phase: 'offer', levelsCleared: 1 } as const;
    const model = describeLeaveRun({ reason: 'new-run', saved }, { levelIndex: 0, levelCount: 5, seed: 1 });
    expect(model.text).toContain('level 2/5 · seed 5150');
    expect(model.text).toContain('a new run');
    expect(model.choices.map((choice) => choice.id)).toEqual(['cancel', 'leave']);
    expect(model.choices.filter((choice) => choice.primary).map((choice) => choice.id)).toEqual(['cancel']);
  });

  it('the in-park text does not claim the autosave already holds the run (a new run may not be autosaved yet)', () => {
    const text = describeLeaveRun({ reason: 'load' }, { levelIndex: 0, levelCount: 5, seed: 7 }).text;
    expect(text).not.toMatch(/Only the autosave holds/);
    expect(text).toContain('unless you save it to a slot first');
  });

  it('autosavedRunAtStake: the autosave\'s unfinished run, unless the load is that run', () => {
    const auto = runMeta();
    const manualSame = runMeta({ id: 'manual-1' as never, kind: 'manual' });
    const manualOther = runMeta({ id: 'manual-2' as never, kind: 'manual', run: { seed: 9, difficulty: 'standard', levelNumber: 1, levelCount: 5, biomeId: 'meadow', phase: 'offer', levelsCleared: 0 } as never });
    const slots = [auto, manualSame, manualOther];
    expect(autosavedRunAtStake(slots)?.id).toBe('autosave');
    expect(autosavedRunAtStake(slots, 'autosave')).toBeNull();
    expect(autosavedRunAtStake(slots, 'manual-1'), 'another save of the same run').toBeNull();
    expect(autosavedRunAtStake(slots, 'manual-2')?.id).toBe('autosave');
    expect(autosavedRunAtStake([runMeta({ run: { ...auto.run!, phase: 'won' } })])).toBeNull();
    expect(autosavedRunAtStake([manualOther]), 'only the autosave is replaced').toBeNull();
    expect(autosavedRunAtStake([runMeta({ status: { state: 'unreadable', code: 'corrupt', message: 'x' } as never })])).toBeNull();
  });

  it('autosavedRunAtStake and latestRunSlot see both autosave generations (Phase 31)', () => {
    const sandbox = runMeta({ mode: 'sandbox', run: undefined, scenarioId: null });
    const previousRun = runMeta({ id: 'autosave-previous' as never, savedAt: NOW - 10 * 60_000 });
    // A new park's first autosave rotates the sandbox into the previous slot and pushes the run out.
    expect(autosavedRunAtStake([sandbox, previousRun])?.id, 'the run in the previous generation is at stake').toBe('autosave-previous');
    expect(autosavedRunAtStake([sandbox, previousRun], 'autosave-previous'), 'loading it is continuing it').toBeNull();
    expect(autosavedRunAtStake([runMeta(), previousRun])?.id, 'the current generation first').toBe('autosave');
    expect(latestRunSlot([runMeta({ savedAt: NOW - 60 * 60_000 }), runMeta({ id: 'autosave-previous' as never, savedAt: NOW })])?.id, 'never the previous beside a readable current').toBe('autosave');
    expect(latestRunSlot([runMeta({ status: { state: 'unreadable', code: 'corrupt', message: 'x' } as never }), previousRun])?.id, 'the fallback').toBe('autosave-previous');
  });

  it('the setup note says Start run asks before replacing an autosaved run, and that a slot run is safe', () => {
    const saved = { seed: 5150, difficulty: 'standard', levelNumber: 2, levelCount: 5, biomeId: 'winter', phase: 'offer', levelsCleared: 1 } as const;
    const inAutosave = buildRunSetup({ seedText: '1', difficulty: 'standard' }, null, saved, true).replaceNote ?? '';
    expect(inAutosave).toContain('kept only by the autosave');
    expect(inAutosave).toContain('Start run asks first');
    expect(inAutosave).not.toMatch(/leaves your current run/);
    expect(buildRunSetup({ seedText: '1', difficulty: 'standard' }, null, saved, false).replaceNote).toContain('stays in its save slot');
  });
});

describe('the Map offer in Park Pulse', () => {
  it('is hidden until pending, then asks once with two buttons', () => {
    expect(describeMapOffer(false)).toEqual({ visible: false });
    const view = describeMapOffer(true);
    expect(view).toMatchObject({ visible: true, line: 'Ready for The Map? Five parks in a row with a deck of cards.', openLabel: 'Open The Map', dismissLabel: 'Not now' });
  });
});
