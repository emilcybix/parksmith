import { describe, expect, it } from 'vitest';
import { ProfileManager } from '../game/profile/ProfileManager';
import { RUN_DIFFICULTIES } from '../game/run';
import { planRun } from '../game/run/plan';
import { MAX_SEED } from '../game/maps/recipe';
import { biomeName } from './runCopy';
import {
  DEFAULT_DIFFICULTY, RUN_SEED_HELP, buildRunSetup, describeContinueRun, difficultyAvailability, nextDifficulty, randomSeedText, sanitiseDifficulty,
} from './runSetupModel';
import { memoryStorage, profileAfter } from './profileTestSupport';

const profile = () => profileAfter([]).snapshot;
const wonStandard = () => {
  const manager = new ProfileManager(memoryStorage());
  manager.recordRunResult({ runKey: 'k1', difficulty: 'standard', outcome: 'won', levelsCleared: 5, deckCardIds: [] }, true);
  return manager;
};

describe('run setup model', () => {
  it('validates the seed text with the Sandbox rule and says how to fix it', () => {
    for (const text of ['', ' ', 'abc', '-1', '1.5', '12x', String(MAX_SEED + 1)]) {
      const model = buildRunSetup({ seedText: text, difficulty: 'standard' }, profile(), null);
      expect(model.seed, text).toBeNull();
      expect(model.seedError).toBe(RUN_SEED_HELP);
      expect(model.canStart).toBe(false);
      expect(model.route).toBeNull();
    }
    for (const text of ['0', '1234', ` ${MAX_SEED} `]) {
      const model = buildRunSetup({ seedText: text, difficulty: 'standard' }, profile(), null);
      expect(model.seed, text).not.toBeNull();
      expect(model.seedError).toBeNull();
      expect(model.canStart).toBe(true);
    }
  });

  it('shows the route and the starter deck the plan makes for that seed, and nothing else', () => {
    const model = buildRunSetup({ seedText: '1234', difficulty: 'standard' }, profile(), null);
    const plan = planRun({ seed: 1234, difficulty: 'standard' });
    expect(model.route).toBe(plan.levels.map((level) => biomeName(level.biomeId)).join(' → '));
    expect(model.route?.startsWith('Meadow')).toBe(true);
    expect(model.starterDeck).toMatch(/^Starter deck: .+, .+, .+$/);
    expect(buildRunSetup({ seedText: '1234', difficulty: 'standard' }, profile(), null)).toEqual(model);
  });

  it('lists the three difficulties with one selected and Tough locked until a Standard win', () => {
    const model = buildRunSetup({ seedText: '1', difficulty: 'standard' }, profile(), null);
    expect(model.difficulties.map((option) => option.id)).toEqual([...RUN_DIFFICULTIES]);
    expect(model.difficulties.filter((option) => option.selected).map((option) => option.id)).toEqual(['standard']);
    expect(model.difficulties.find((option) => option.id === 'tough')?.locked).toBe('Win a Standard run to unlock');
    expect(model.difficulties.find((option) => option.id === 'relaxed')?.locked).toBeNull();
    const open = buildRunSetup({ seedText: '1', difficulty: 'tough' }, wonStandard().snapshot(), null);
    expect(open.difficulties.every((option) => option.locked === null)).toBe(true);
    expect(open.canStart).toBe(true);
  });

  it('a locked difficulty cannot start, and falls back to the default', () => {
    expect(buildRunSetup({ seedText: '1', difficulty: 'tough' }, profile(), null).canStart).toBe(false);
    expect(sanitiseDifficulty(profile(), 'tough')).toBe(DEFAULT_DIFFICULTY);
    expect(sanitiseDifficulty(profile(), 'relaxed')).toBe('relaxed');
    expect(sanitiseDifficulty(null, 'tough')).toBe('standard');
  });

  it('agrees with the profile about which difficulty is open (one rule, two places)', () => {
    const states = [new ProfileManager(memoryStorage()), wonStandard()];
    const tough = new ProfileManager(memoryStorage());
    tough.recordRunResult({ runKey: 'k2', difficulty: 'tough', outcome: 'won', levelsCleared: 5, deckCardIds: [] }, true);
    const relaxed = new ProfileManager(memoryStorage());
    relaxed.recordRunResult({ runKey: 'k3', difficulty: 'relaxed', outcome: 'won', levelsCleared: 5, deckCardIds: [] }, true);
    states.push(tough, relaxed);
    for (const manager of states) {
      for (const difficulty of RUN_DIFFICULTIES) {
        expect(difficultyAvailability(manager.snapshot(), difficulty), difficulty).toEqual(manager.runDifficultyAvailability(difficulty));
      }
    }
    expect(difficultyAvailability(null, 'tough').available).toBe(false);
  });

  it('arrow keys reach every difficulty and wrap; selection follows only onto an open one', () => {
    expect(nextDifficulty(profile(), 'standard', 'ArrowRight')).toEqual({ focus: 'tough', canSelect: false });
    expect(nextDifficulty(profile(), 'tough', 'ArrowRight')).toEqual({ focus: 'relaxed', canSelect: true });
    expect(nextDifficulty(profile(), 'relaxed', 'ArrowLeft')).toEqual({ focus: 'tough', canSelect: false });
    expect(nextDifficulty(profile(), 'relaxed', 'End')).toEqual({ focus: 'tough', canSelect: false });
    expect(nextDifficulty(profile(), 'tough', 'Home')).toEqual({ focus: 'relaxed', canSelect: true });
    expect(nextDifficulty(wonStandard().snapshot(), 'standard', 'ArrowRight')).toEqual({ focus: 'tough', canSelect: true });
    expect(nextDifficulty(profile(), 'standard', 'a')).toBeNull();
  });

  it('notes the saved run a new run would meet, only while that run is unfinished', () => {
    const saved = { seed: 5, difficulty: 'standard', levelNumber: 3, levelCount: 5, biomeId: 'winter', phase: 'loadout', levelsCleared: 2 } as const;
    expect(buildRunSetup({ seedText: '1', difficulty: 'standard' }, profile(), saved).replaceNote).toContain('level 3/5');
    expect(buildRunSetup({ seedText: '1', difficulty: 'standard' }, profile(), { ...saved, phase: 'lost' }).replaceNote).toBeNull();
    expect(buildRunSetup({ seedText: '1', difficulty: 'standard' }, profile(), null).replaceNote).toBeNull();
  });

  it('describes the Continue run card from the saved summary', () => {
    const card = describeContinueRun({ seed: 4242, difficulty: 'tough', levelNumber: 3, levelCount: 5, biomeId: 'winter', phase: 'offer', levelsCleared: 2 });
    expect(card).toEqual({ title: 'Level 3 · Winter', subtitle: 'level 3/5 · seed 4242 · Tough', atMap: true });
    expect(describeContinueRun({ seed: 1, difficulty: 'standard', levelNumber: 1, levelCount: 5, biomeId: 'meadow', phase: 'stage', levelsCleared: 0 }).atMap).toBe(false);
  });

  it('a random seed is a uint32 and the injected source makes it exact', () => {
    expect(randomSeedText(() => 0)).toBe('0');
    expect(randomSeedText(() => 0.5)).toBe(String(Math.floor(0.5 * (MAX_SEED + 1))));
    expect(randomSeedText(() => 0.9999999999)).toBe(String(MAX_SEED));
  });
});
