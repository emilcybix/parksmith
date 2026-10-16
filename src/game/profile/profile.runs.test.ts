import { describe, expect, it } from 'vitest';
import { STARTING_CARD_IDS } from '../cards/content';
import { ProfileManager, type ProfileStorage } from './ProfileManager';
import { PROFILE_STORAGE_KEY, freshProfile, mergeProfiles, migrateProfile, serializeProfile } from './schema';
import type { ProfileV2, RunResultInput } from './types';

/** Phase 23: the profile's run statistics and rewards (discovered cards and unlocks only, never raw power). */
interface Fake extends ProfileStorage { entries: Map<string, string> }
const fake = (initial: Record<string, string> = {}): Fake => {
  const entries = new Map(Object.entries(initial));
  return { entries, getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, value); }, removeItem: (key) => { entries.delete(key); } };
};
const stored = (storage: Fake): ProfileV2 => migrateProfile(JSON.parse(storage.entries.get(PROFILE_STORAGE_KEY)!)).profile;
const result = (over: Partial<RunResultInput> = {}): RunResultInput => ({
  runKey: '1-standard-aaaa', difficulty: 'standard', outcome: 'won', levelsCleared: 5, deckCardIds: ['grand-opening', 'velvet-ropes', 'lean-crew', 'quick-turnaround'], ...over,
});

describe('run statistics', () => {
  it('a fresh profile has zeros, an old profile without `runs` reads as zeros, and `runs` is serialized after `notice`', () => {
    const profile = freshProfile();
    expect(profile.runs).toEqual({ started: 0, victories: { relaxed: 0, standard: 0, tough: 0 }, losses: { relaxed: 0, standard: 0, tough: 0 }, bestLevel: { relaxed: 0, standard: 0, tough: 0 }, recentRunKeys: [] });
    const { runs: _runs, ...old } = JSON.parse(serializeProfile(profile));
    void _runs;
    expect(migrateProfile(old).profile.runs).toEqual(profile.runs);
    expect(Object.keys(JSON.parse(serializeProfile(profile))).at(-1)).toBe('runs');
    expect(Object.keys(JSON.parse(serializeProfile(profile))).at(-2)).toBe('notice');
  });

  it('recordRunStarted counts every start, and persists', () => {
    const storage = fake();
    const manager = new ProfileManager(storage);
    manager.recordRunStarted('standard');
    manager.recordRunStarted('tough');
    expect(manager.snapshot().runs.started).toBe(2);
    expect(stored(storage).runs.started).toBe(2);
    manager.recordRunStarted('nope' as never);
    expect(manager.snapshot().runs.started).toBe(2);
  });

  it('a victory discovers the deck cards that were not in the collection, opens Tough and records the best level', () => {
    const manager = new ProfileManager(fake());
    expect(manager.runDifficultyAvailability('tough')).toEqual({ available: false, conditionText: 'Win a Standard run to unlock' });
    expect(manager.runDifficultyAvailability('relaxed')).toEqual({ available: true, conditionText: null });
    const reward = manager.recordRunResult(result(), true);
    expect(reward).toMatchObject({ eligible: true, alreadyRecorded: false, outcome: 'won', newBestLevel: true, previousBestLevel: 0, bestLevel: 5, newlyUnlockedDifficulties: ['tough'] });
    // The starter collection cards are not "new".
    expect(reward.newlyDiscoveredCardIds).toEqual(['velvet-ropes', 'lean-crew', 'quick-turnaround']);
    expect(manager.snapshot().discoveredCardIds).toEqual(['velvet-ropes', 'lean-crew', 'quick-turnaround']);
    for (const id of STARTING_CARD_IDS) expect(manager.snapshot().discoveredCardIds).not.toContain(id);
    expect(manager.runDifficultyAvailability('tough')).toEqual({ available: true, conditionText: null });
    expect(manager.snapshot().runs).toMatchObject({ victories: { standard: 1 }, bestLevel: { standard: 5 } });
    expect(manager.snapshot().stats.run.wins).toBe(1);
  });

  it('a Relaxed victory does not open Tough; a Tough victory counts as the unlock too', () => {
    const manager = new ProfileManager(fake());
    expect(manager.recordRunResult(result({ difficulty: 'relaxed', runKey: 'r' }), true).newlyUnlockedDifficulties).toEqual([]);
    expect(manager.runDifficultyAvailability('tough').available).toBe(false);
    manager.snapshot();
    const other = new ProfileManager(fake());
    expect(other.recordRunResult(result({ difficulty: 'tough', runKey: 't' }), true).newlyUnlockedDifficulties).toEqual(['tough']);
  });

  it('a loss records the best level and the loss, discovers nothing and unlocks nothing', () => {
    const manager = new ProfileManager(fake());
    const reward = manager.recordRunResult(result({ outcome: 'lost', levelsCleared: 3 }), true);
    expect(reward).toMatchObject({ outcome: 'lost', newBestLevel: true, bestLevel: 3, newlyDiscoveredCardIds: [], newlyUnlockedDifficulties: [] });
    expect(manager.snapshot().discoveredCardIds).toEqual([]);
    expect(manager.snapshot().runs).toMatchObject({ losses: { standard: 1 }, bestLevel: { standard: 3 } });
    const worse = manager.recordRunResult(result({ outcome: 'lost', levelsCleared: 1, runKey: 'two' }), true);
    expect(worse).toMatchObject({ newBestLevel: false, previousBestLevel: 3, bestLevel: 3 });
    expect(manager.snapshot().stats.run.losses).toBe(2);
  });

  it('is idempotent by run key: a second report of the same run changes nothing', () => {
    const storage = fake();
    const manager = new ProfileManager(storage);
    manager.recordRunResult(result(), true);
    const text = storage.entries.get(PROFILE_STORAGE_KEY);
    const again = manager.recordRunResult(result(), true);
    expect(again).toMatchObject({ alreadyRecorded: true, newlyDiscoveredCardIds: [], newlyUnlockedDifficulties: [] });
    expect(storage.entries.get(PROFILE_STORAGE_KEY)).toBe(text);
    expect(manager.snapshot().runs.victories.standard).toBe(1);
  });

  it('an ineligible run (a hand-edited plan) counts nothing and is not remembered as recorded', () => {
    const manager = new ProfileManager(fake());
    manager.recordRunStarted('standard');
    const reward = manager.recordRunResult(result(), false);
    expect(reward).toMatchObject({ eligible: false, alreadyRecorded: false, newlyDiscoveredCardIds: [], newlyUnlockedDifficulties: [] });
    expect(manager.snapshot().runs).toMatchObject({ started: 1, victories: { standard: 0 }, bestLevel: { standard: 0 }, recentRunKeys: [] });
    expect(manager.snapshot().discoveredCardIds).toEqual([]);
    expect(manager.snapshot().stats.run.wins).toBe(0);
  });

  it('hostile results are ignored: a bad difficulty, key or level count', () => {
    const manager = new ProfileManager(fake());
    expect(manager.recordRunResult(result({ difficulty: 'x' as never }), true).newlyDiscoveredCardIds).toEqual([]);
    expect(manager.recordRunResult(result({ runKey: '' }), true).newlyDiscoveredCardIds).toEqual([]);
    expect(manager.recordRunResult(result({ runKey: 'k'.repeat(81) }), true).newlyDiscoveredCardIds).toEqual([]);
    expect(manager.snapshot().runs.victories.standard).toBe(0);
    manager.recordRunResult(result({ runKey: 'big', levelsCleared: 1e9, outcome: 'lost' }), true);
    expect(manager.snapshot().runs.bestLevel.standard).toBe(8);
    manager.recordRunResult(result({ runKey: 'nan', levelsCleared: Number.NaN, outcome: 'lost', difficulty: 'relaxed' }), true);
    expect(manager.snapshot().runs.bestLevel.relaxed).toBe(0);
    manager.recordRunResult(result({ runKey: 'cards', deckCardIds: ['nope', 'lean-crew'] as never }), true);
    expect(manager.snapshot().discoveredCardIds).toEqual(['lean-crew']);
  });

  it('keeps only the last 32 run keys', () => {
    const manager = new ProfileManager(fake());
    for (let index = 0; index < 40; index += 1) manager.recordRunResult(result({ runKey: `run-${index}`, outcome: 'lost', levelsCleared: 1 }), true);
    const keys = manager.snapshot().runs.recentRunKeys;
    expect(keys).toHaveLength(32);
    expect(keys[0]).toBe('run-8');
    expect(keys.at(-1)).toBe('run-39');
  });
});

describe('the runs slice: reading, merging, two tabs', () => {
  it('hostile stored values are normalised: counters clamp, keys filter, nonsense reads as zeros', () => {
    const raw = JSON.parse(serializeProfile(freshProfile()));
    raw.runs = { started: -5, victories: { standard: 'x', tough: 3.9, __proto__: { relaxed: 9 } }, losses: 7, bestLevel: { standard: 99, relaxed: -1 }, recentRunKeys: ['a', 1, null, 'a', 'b'.repeat(200), 'c'] };
    const { runs } = migrateProfile(raw).profile;
    expect(runs.started).toBe(0);
    expect(runs.victories).toEqual({ relaxed: 0, standard: 0, tough: 3 });
    expect(runs.losses).toEqual({ relaxed: 0, standard: 0, tough: 0 });
    expect(runs.bestLevel).toEqual({ relaxed: 0, standard: 8, tough: 0 });
    expect(runs.recentRunKeys).toEqual(['a', 'c']);
    raw.runs = 'junk';
    expect(migrateProfile(raw).profile.runs).toEqual(freshProfile().runs);
  });

  it('merges by maximum and union, commutatively on the counters and idempotently', () => {
    const left = freshProfile();
    left.runs = { started: 3, victories: { relaxed: 1, standard: 0, tough: 0 }, losses: { relaxed: 0, standard: 2, tough: 0 }, bestLevel: { relaxed: 5, standard: 2, tough: 0 }, recentRunKeys: ['a', 'b'] };
    const right = freshProfile();
    right.runs = { started: 5, victories: { relaxed: 0, standard: 1, tough: 0 }, losses: { relaxed: 0, standard: 1, tough: 0 }, bestLevel: { relaxed: 1, standard: 4, tough: 0 }, recentRunKeys: ['b', 'c'] };
    const merged = mergeProfiles(left, right);
    expect(merged.runs).toEqual({ started: 5, victories: { relaxed: 1, standard: 1, tough: 0 }, losses: { relaxed: 0, standard: 2, tough: 0 }, bestLevel: { relaxed: 5, standard: 4, tough: 0 }, recentRunKeys: ['a', 'b', 'c'] });
    expect(mergeProfiles(merged, merged).runs).toEqual(merged.runs);
    expect(mergeProfiles(right, left).runs.victories).toEqual(merged.runs.victories);
  });

  it('two tabs recording different runs never erase each other, and the same run is recorded once', () => {
    const storage = fake();
    const tabA = new ProfileManager(storage);
    const tabB = new ProfileManager(storage);
    tabA.recordRunResult(result({ runKey: 'a', outcome: 'lost', levelsCleared: 2 }), true);
    tabB.recordRunResult(result({ runKey: 'b', outcome: 'won' }), true);
    expect(stored(storage).runs.victories.standard).toBe(1);
    expect(stored(storage).runs.losses.standard).toBe(1);
    expect(stored(storage).runs.recentRunKeys).toEqual(['a', 'b']);
    expect(tabA.applyExternal(storage.entries.get(PROFILE_STORAGE_KEY)!)).toBe(true);
    expect(tabA.runDifficultyAvailability('tough').available).toBe(true);
  });

  it('while this tab is open, an old-build write without `runs` is merged away (the in-memory statistics win)', () => {
    const storage = fake();
    const manager = new ProfileManager(storage);
    manager.recordRunResult(result(), true);
    const withoutRuns = JSON.parse(storage.entries.get(PROFILE_STORAGE_KEY)!);
    delete withoutRuns.runs;
    storage.entries.set(PROFILE_STORAGE_KEY, JSON.stringify(withoutRuns));
    manager.recordRunStarted('standard');
    expect(stored(storage).runs.victories.standard).toBe(1);
  });

  it.fails('KNOWN LIMIT: a tab of the build before Phase 23 writes the profile without `runs` while no new tab is open, which drops the run statistics', () => {
    // The old serializeProfile lists its keys: `runs` is not among them. Same class of limit as Phase 22's shadow copy for v1.
    const storage = fake();
    new ProfileManager(storage).recordRunResult(result(), true);
    const withoutRuns = JSON.parse(storage.entries.get(PROFILE_STORAGE_KEY)!);
    delete withoutRuns.runs;
    storage.entries.set(PROFILE_STORAGE_KEY, JSON.stringify(withoutRuns));
    expect(new ProfileManager(storage).snapshot().runs.victories.standard).toBe(1);
  });

  it('no run reward is ever raw power: the profile holds no bonus, no unlock and no cash after a victory', () => {
    const manager = new ProfileManager(fake());
    manager.recordRunResult(result(), true);
    expect(manager.snapshot().bonusIds).toEqual([]);
    expect(manager.snapshot().unlockedBuildingIds).toEqual([]);
    expect(manager.parkGrant('run')).toEqual({ unlockedBuildingIds: [], bonusIds: [] });
  });
});
