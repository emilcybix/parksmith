import { describe, expect, it } from 'vitest';
import { STARTING_CARD_IDS } from '../cards/content';
import { SCENARIOS } from '../scenarios/content';
import { legacyTourOver } from './legacyTourSupport';
import {
  PROFILE_CORRUPT_BACKUP_KEY,
  PROFILE_STORAGE_KEY,
  PROFILE_V1_BACKUP_KEY,
  freshProfile,
  mergeProfiles,
  migrateProfile,
  serializeProfile,
} from './schema';
import { ProfileManager, type ProfileStorage } from './ProfileManager';
import { PROFILE_VERSION, type ProfileV2 } from './types';

const fixtures = import.meta.glob<string>('./__fixtures__/profile-v1-*.json', { import: 'default', query: '?raw', eager: true });
const fixtureText = (name: string): string => fixtures[`./__fixtures__/${name}`] ?? '';

interface FakeStorage extends ProfileStorage {
  entries: Map<string, string>;
  failReads: boolean;
  failWrites: boolean;
  writes: number;
}

const fakeStorage = (initial: Record<string, string> = {}): FakeStorage => {
  const entries = new Map(Object.entries(initial));
  const storage: FakeStorage = {
    entries,
    failReads: false,
    failWrites: false,
    writes: 0,
    getItem: (key) => {
      if (storage.failReads) throw new Error('blocked');
      return entries.get(key) ?? null;
    },
    setItem: (key, value) => {
      if (storage.failWrites) throw new DOMException('full', 'QuotaExceededError');
      storage.writes += 1;
      entries.set(key, value);
    },
  };
  return storage;
};

const storedProfile = (storage: FakeStorage): ProfileV2 => JSON.parse(storage.entries.get(PROFILE_STORAGE_KEY)!) as ProfileV2;

describe('the v1 fixtures are real v1 profiles written by the Park Tour code', () => {
  it('are version 1 and carry no scenarios, bonuses or epoch', () => {
    for (const name of ['profile-v1-fresh.json', 'profile-v1-midtour.json', 'profile-v1-finished.json', 'profile-v1-no-ui.json', 'profile-v1-hostile.json']) {
      const parsed = JSON.parse(fixtureText(name));
      expect(parsed.version, name).toBe(1);
      expect('scenarios' in parsed, name).toBe(false);
      expect('epoch' in parsed.tour, name).toBe(false);
    }
  });
});

describe('migrateProfile: v1 to v2 (golden)', () => {
  const convert = (name: string) => migrateProfile(JSON.parse(fixtureText(name)));
  const cleared = (via: 'tour-conversion' = 'tour-conversion') => ({ clears: 1, attempts: 1, bestClearSeconds: null, bestProgressPercent: 100, firstClearVia: via });

  it('a fresh v1 profile becomes a fresh v2 profile, with no notice', () => {
    const { profile, status } = convert('profile-v1-fresh.json');
    expect(status).toBe('migrated-v1');
    expect(profile).toEqual(freshProfile());
    expect(profile.notice).toBeNull();
  });

  it('a mid-tour profile keeps its route, cards and flags, counts the completed nodes as clears and earns their bonuses', () => {
    const { profile } = convert('profile-v1-midtour.json');
    expect(profile).toEqual({
      version: 2,
      discoveredCardIds: ['lean-crew', 'velvet-ropes'],
      tour: {
        ownedCardIds: ['grand-opening', 'local-contractors', 'hungry-tourists', 'lean-crew', 'velvet-ropes'],
        unlockedNodeIds: ['opener', 'branch-profit', 'branch-garden', 'finale'],
        completedNodeIds: ['opener', 'branch-profit'],
        epoch: 0,
      },
      ui: { mapSeen: true, tourOffered: true },
      scenarios: { 'sunny-start': cleared(), 'penny-lane': cleared() },
      unlockedBuildingIds: [],
      bonusIds: ['nest-egg', 'research-grant'],
      useBonuses: { sandbox: false, scenario: true, run: true },
      stats: {
        sandbox: { parksStarted: 0, wins: 0, losses: 0 },
        scenario: { parksStarted: 0, wins: 0, losses: 0 },
        run: { parksStarted: 0, wins: 2, losses: 0 },
      },
      notice: { kind: 'tour-converted', clearedScenarioIds: ['sunny-start', 'penny-lane'], bonusIds: ['nest-egg', 'research-grant'], unlockedBuildingIds: [] },
      runs: { started: 0, victories: { relaxed: 0, standard: 0, tough: 0 }, losses: { relaxed: 0, standard: 0, tough: 0 }, bestLevel: { relaxed: 0, standard: 0, tough: 0 }, recentRunKeys: [] },
    });
  });

  it('a finished tour earns all four shipped bonuses and clears the four scenarios', () => {
    const { profile } = convert('profile-v1-finished.json');
    expect(Object.keys(profile.scenarios)).toEqual(['sunny-start', 'penny-lane', 'garden-gala', 'starlight-finale']);
    expect(profile.bonusIds).toEqual(['nest-egg', 'research-grant', 'builders-discount', 'spare-slot']);
    expect(profile.notice?.clearedScenarioIds).toHaveLength(4);
    expect(profile.stats.run.wins).toBe(4);
  });

  it('a profile without ui flags converts with both flags false', () => {
    expect(convert('profile-v1-no-ui.json').profile.ui).toEqual({ mapSeen: false, tourOffered: false });
  });

  it('a hostile v1 profile is sanitised: unknown ids and wrong types dropped, a completed-but-locked node ignored', () => {
    const { profile } = convert('profile-v1-hostile.json');
    expect(profile.discoveredCardIds).toEqual(['grand-opening']);
    expect(profile.tour.ownedCardIds).toEqual([...STARTING_CARD_IDS]);
    expect(profile.tour.unlockedNodeIds).toEqual(['opener', 'branch-profit']);
    expect(profile.ui).toEqual({ mapSeen: false, tourOffered: false });
    expect(Object.keys(profile.scenarios), 'finale was completed but never unlocked: it does not count').toEqual(['sunny-start']);
    expect(profile.bonusIds).toEqual(['nest-egg']);
    expect('extra' in profile).toBe(false);
  });

  it('conversion is stable: a v2 round trip gives the same profile', () => {
    for (const name of ['profile-v1-fresh.json', 'profile-v1-midtour.json', 'profile-v1-finished.json', 'profile-v1-hostile.json']) {
      const { profile } = convert(name);
      const again = migrateProfile(JSON.parse(serializeProfile(profile)));
      expect(again.status, name).toBe('ok');
      expect(again.profile, name).toEqual(profile);
    }
  });
});

describe('migrateProfile: statuses and hostile v2 values', () => {
  it('maps absent, garbage, unknown-old and too-new input', () => {
    expect(migrateProfile(null).status).toBe('fresh');
    expect(migrateProfile(undefined).status).toBe('fresh');
    for (const raw of ['text', 5, true, [], [1], { nope: 1 }, { version: 0 }, { version: 'two' }, { version: 1.5 }, { version: -1 }]) {
      expect(migrateProfile(raw).status, JSON.stringify(raw)).toBe('garbage');
    }
    expect(migrateProfile({ version: 3 }).status).toBe('too-new');
    expect(migrateProfile({ version: 99 }).status).toBe('too-new');
    expect(migrateProfile({ version: 3 }).profile).toEqual(freshProfile());
  });

  it('validates every v2 field per entry', () => {
    const hostile = {
      version: 2,
      discoveredCardIds: ['velvet-ropes', 'velvet-ropes', 'no-such-card', 4],
      tour: { ownedCardIds: [], unlockedNodeIds: ['finale'], completedNodeIds: ['ghost'], epoch: -4 },
      ui: { mapSeen: 'yes', tourOffered: true },
      scenarios: {
        'sunny-start': { clears: 2.9, attempts: -3, bestClearSeconds: -1, bestProgressPercent: 40, firstClearVia: 'cheating' },
        'penny-lane': { clears: 0, attempts: 3, bestClearSeconds: 99, bestProgressPercent: 250, firstClearVia: 'run' },
        'garden-gala': 'cleared',
        'no-such-scenario': { clears: 1 },
        __proto__: { clears: 9 },
      },
      unlockedBuildingIds: ['lantern-maple', 'comet-cups', 'tiki-tumbler', 3],
      bonusIds: ['spare-slot', 'bogus', 'nest-egg'],
      useBonuses: { sandbox: 'yes', scenario: false, run: 1 },
      stats: { sandbox: { parksStarted: 1e12, wins: -5, losses: 'many' }, run: 'x' },
      notice: { kind: 'elsewhere' },
    };
    const { profile, status } = migrateProfile(JSON.parse(JSON.stringify(hostile)));
    expect(status).toBe('ok');
    expect(profile.discoveredCardIds).toEqual(['velvet-ropes']);
    expect(profile.tour.ownedCardIds).toEqual([...STARTING_CARD_IDS]);
    expect(profile.tour.unlockedNodeIds).toEqual(['opener', 'finale']);
    expect(profile.tour.completedNodeIds).toEqual([]);
    expect(profile.tour.epoch).toBe(0);
    expect(profile.ui).toEqual({ mapSeen: false, tourOffered: true });
    expect(profile.scenarios['sunny-start']).toEqual({ clears: 2, attempts: 2, bestClearSeconds: null, bestProgressPercent: 100, firstClearVia: null });
    expect(profile.scenarios['penny-lane']).toEqual({ clears: 0, attempts: 3, bestClearSeconds: 99, bestProgressPercent: 100, firstClearVia: 'run' });
    expect(profile.scenarios['garden-gala']).toBeUndefined();
    expect(Object.keys(profile.scenarios).sort()).toEqual(['penny-lane', 'sunny-start']);
    // sunny-start is cleared, so its bonus is part of the profile whatever the stored list says; unknown ids are gone.
    expect(profile.bonusIds).toEqual(['nest-egg', 'spare-slot']);
    expect(profile.unlockedBuildingIds).toEqual(['tiki-tumbler', 'lantern-maple']);
    expect(profile.useBonuses).toEqual({ sandbox: false, scenario: false, run: true });
    expect(profile.stats.sandbox).toEqual({ parksStarted: 1_000_000, wins: 0, losses: 0 });
    expect(profile.stats.run).toEqual({ parksStarted: 0, wins: 0, losses: 0 });
    expect(profile.notice).toBeNull();
    expect(Object.getPrototypeOf(profile.scenarios)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).clears).toBeUndefined();
  });

  it('the rewards of a cleared scenario are part of the profile by definition (content may grow what a clear gave)', () => {
    const stored = freshProfile();
    stored.scenarios['harvest-festival'] = { clears: 1, attempts: 1, bestClearSeconds: 100, bestProgressPercent: 100, firstClearVia: 'scenario' };
    const { profile } = migrateProfile(JSON.parse(serializeProfile(stored)));
    expect(profile.unlockedBuildingIds).toEqual(['lantern-maple']);
    expect(profile.bonusIds).toEqual(['trusted-crew']);
  });
});

describe('mergeProfiles', () => {
  const profileA = (): ProfileV2 => {
    const profile = freshProfile();
    profile.discoveredCardIds = ['velvet-ropes'];
    profile.scenarios['sunny-start'] = { clears: 2, attempts: 5, bestClearSeconds: 300, bestProgressPercent: 100, firstClearVia: 'run' };
    profile.unlockedBuildingIds = ['tiki-tumbler'];
    profile.bonusIds = ['nest-egg'];
    profile.stats.scenario = { parksStarted: 4, wins: 2, losses: 1 };
    profile.tour.completedNodeIds = ['opener'];
    profile.tour.unlockedNodeIds = ['opener', 'branch-profit', 'branch-garden'];
    profile.ui.mapSeen = true;
    return profile;
  };
  const profileB = (): ProfileV2 => {
    const profile = freshProfile();
    profile.discoveredCardIds = ['lean-crew', 'velvet-ropes'];
    profile.scenarios['sunny-start'] = { clears: 1, attempts: 7, bestClearSeconds: 250, bestProgressPercent: 100, firstClearVia: 'scenario' };
    profile.scenarios['penny-lane'] = { clears: 0, attempts: 1, bestClearSeconds: null, bestProgressPercent: 55, firstClearVia: null };
    profile.unlockedBuildingIds = ['lantern-maple', 'tiki-tumbler'];
    profile.bonusIds = ['research-grant'];
    profile.stats.scenario = { parksStarted: 3, wins: 3, losses: 0 };
    profile.tour.completedNodeIds = ['opener', 'branch-garden'];
    profile.tour.unlockedNodeIds = ['opener', 'branch-garden'];
    profile.ui.tourOffered = true;
    return profile;
  };
  /** The monotonic part: everything but the last-writer fields. */
  const monotonic = (profile: ProfileV2): unknown => ({
    ...profile,
    // Card lists keep the order each tab discovered them in; as sets they are equal.
    discoveredCardIds: [...profile.discoveredCardIds].sort(),
    tour: { ...profile.tour, ownedCardIds: [...profile.tour.ownedCardIds].sort() },
    useBonuses: null,
    notice: null,
  });

  it('unions what only grows, takes the best of every record, ORs the flags', () => {
    const merged = mergeProfiles(profileA(), profileB());
    expect(merged.discoveredCardIds).toEqual(['velvet-ropes', 'lean-crew']);
    expect(merged.scenarios['sunny-start']).toEqual({ clears: 2, attempts: 7, bestClearSeconds: 250, bestProgressPercent: 100, firstClearVia: 'scenario' });
    expect(merged.scenarios['penny-lane']?.bestProgressPercent).toBe(55);
    expect(merged.unlockedBuildingIds).toEqual(['tiki-tumbler', 'lantern-maple']);
    expect(merged.bonusIds).toEqual(['nest-egg', 'research-grant']);
    expect(merged.stats.scenario).toEqual({ parksStarted: 4, wins: 3, losses: 1 });
    expect(merged.tour.completedNodeIds).toEqual(['opener', 'branch-garden']);
    expect(merged.tour.unlockedNodeIds).toEqual(['opener', 'branch-profit', 'branch-garden']);
    expect(merged.ui).toEqual({ mapSeen: true, tourOffered: true });
  });

  it('is commutative on the monotonic parts and idempotent', () => {
    expect(monotonic(mergeProfiles(profileA(), profileB()))).toEqual(monotonic(mergeProfiles(profileB(), profileA())));
    const merged = mergeProfiles(profileA(), profileB());
    expect(mergeProfiles(merged, merged)).toEqual(merged);
    expect(mergeProfiles(merged, profileA())).toEqual(merged);
    expect(mergeProfiles(merged, profileB())).toEqual(merged);
  });

  it('a higher tour epoch (a reset) wins wholesale, equal epochs union', () => {
    const reset = profileA();
    reset.tour = { ownedCardIds: [...STARTING_CARD_IDS], unlockedNodeIds: ['opener'], completedNodeIds: [], epoch: 1 };
    const merged = mergeProfiles(profileB(), reset);
    expect(merged.tour).toEqual(reset.tour);
    expect(mergeProfiles(reset, profileB()).tour).toEqual(reset.tour);
    // Permanent progress is not touched by a tour reset.
    expect(merged.scenarios['sunny-start']?.clears).toBe(2);
  });

  it('the last writer wins useBonuses and notice', () => {
    const left = profileA();
    left.useBonuses.sandbox = true;
    left.notice = { kind: 'tour-converted', clearedScenarioIds: [], bonusIds: [], unlockedBuildingIds: [] };
    const right = profileB();
    expect(mergeProfiles(left, right).useBonuses.sandbox).toBe(false);
    expect(mergeProfiles(left, right).notice).toBeNull();
    expect(mergeProfiles(right, left).useBonuses.sandbox).toBe(true);
    expect(mergeProfiles(right, left).notice).not.toBeNull();
  });
});

describe('ProfileManager: first run, storage failures and the policy for what it finds', () => {
  it('a missing key with writable storage is a fresh v2 profile written at once, and a first run (exactly once)', () => {
    const storage = fakeStorage();
    const first = new ProfileManager(storage);
    expect(first.isFirstRun).toBe(true);
    expect(first.persistence).toBe('ok');
    expect(storedProfile(storage)).toEqual(freshProfile());
    expect(new ProfileManager(storage).isFirstRun).toBe(false);
  });

  it('the isFirstRun matrix is the Park Tour one: no storage, unreadable and unwritable storage are never a first run', () => {
    expect(new ProfileManager(null).isFirstRun).toBe(false);
    const unreadable = fakeStorage();
    unreadable.failReads = true;
    expect(new ProfileManager(unreadable).isFirstRun).toBe(false);
    const unwritable = fakeStorage();
    unwritable.failWrites = true;
    expect(new ProfileManager(unwritable).isFirstRun).toBe(false);
    const full = fakeStorage({ [PROFILE_STORAGE_KEY]: serializeProfile(freshProfile()) });
    expect(new ProfileManager(full).isFirstRun).toBe(false);
    expect(new ProfileManager(fakeStorage()).isFirstRun).toBe(true);
  });

  it('blocked, full or throwing storage never blocks start: an in-memory profile, persistence unavailable', () => {
    for (const mode of ['reads', 'writes', 'null'] as const) {
      const storage = fakeStorage();
      if (mode === 'reads') storage.failReads = true;
      if (mode === 'writes') storage.failWrites = true;
      const manager = new ProfileManager(mode === 'null' ? null : storage);
      expect(manager.persistence, mode).toBe('unavailable');
      expect(manager.snapshot().persistence).toBe('unavailable');
      manager.recordParkStarted('sandbox');
      expect(manager.recordScenarioResult({ scenarioId: 'sunny-start', mode: 'scenario', outcome: 'succeeded', atSeconds: 100, progressPercent: 100 }, true).firstClear, mode).toBe(true);
      expect(manager.snapshot().unlockedBuildingIds).toEqual([]);
      expect(manager.snapshot().bonusIds).toEqual(['nest-egg']);
      expect(manager.parkGrant('scenario').bonusIds).toEqual(['nest-egg']);
    }
  });

  it('a write that fails midway marks persistence unavailable and the next good write recovers it', () => {
    const storage = fakeStorage();
    const manager = new ProfileManager(storage);
    storage.failWrites = true;
    manager.recordParkStarted('sandbox');
    expect(manager.persistence).toBe('unavailable');
    storage.failWrites = false;
    manager.recordParkStarted('sandbox');
    expect(manager.persistence).toBe('ok');
    expect(storedProfile(storage).stats.sandbox.parksStarted).toBe(2);
  });

  it('garbage text is copied to the corrupt backup, replaced by a fresh profile and is not a first run', () => {
    for (const text of ['not json at all', '[1,2]', '{"version":0}', '"just a string"']) {
      const storage = fakeStorage({ [PROFILE_STORAGE_KEY]: text });
      const manager = new ProfileManager(storage);
      expect(manager.isFirstRun, text).toBe(false);
      expect(storage.entries.get(PROFILE_CORRUPT_BACKUP_KEY), text).toBe(text);
      expect(storedProfile(storage), text).toEqual(freshProfile());
      expect(manager.persistence).toBe('ok');
    }
  });

  it('keeps the first corrupt backup (a later garbage does not overwrite it)', () => {
    const storage = fakeStorage({ [PROFILE_STORAGE_KEY]: 'first garbage' });
    new ProfileManager(storage);
    storage.entries.set(PROFILE_STORAGE_KEY, 'second garbage');
    new ProfileManager(storage);
    expect(storage.entries.get(PROFILE_CORRUPT_BACKUP_KEY)).toBe('first garbage');
  });

  it('a NEWER version is read-only: fresh in memory, never written, never destroyed', () => {
    const newer = JSON.stringify({ version: 3, future: { shiny: true } });
    const storage = fakeStorage({ [PROFILE_STORAGE_KEY]: newer });
    const manager = new ProfileManager(storage);
    expect(manager.persistence).toBe('read-only');
    expect(manager.isFirstRun).toBe(false);
    manager.recordParkStarted('sandbox');
    manager.setUseBonuses('sandbox', true);
    manager.recordScenarioResult({ scenarioId: 'sunny-start', mode: 'run', outcome: 'succeeded', atSeconds: 5, progressPercent: 100 }, true);
    expect(storage.entries.get(PROFILE_STORAGE_KEY)).toBe(newer);
    expect(storage.writes).toBe(0);
    expect(manager.snapshot().persistence).toBe('read-only');
    expect(manager.snapshot().bonusIds).toEqual(['nest-egg']);
  });

  it('a v1 profile is migrated, the original text is copied once to the v1 backup, and v2 is written', () => {
    const text = fixtureText('profile-v1-midtour.json');
    const storage = fakeStorage({ [PROFILE_STORAGE_KEY]: text });
    const manager = new ProfileManager(storage);
    expect(manager.isFirstRun).toBe(false);
    expect(storage.entries.get(PROFILE_V1_BACKUP_KEY)).toBe(text);
    expect(storedProfile(storage).version).toBe(PROFILE_VERSION);
    expect(manager.snapshot().clearedScenarioIds).toEqual(['sunny-start', 'penny-lane']);
    expect(manager.snapshot().notice?.kind).toBe('tour-converted');
    expect(manager.snapshot().bonusIds).toEqual(['nest-egg', 'research-grant']);
    // A second start reads v2 and never touches the backup.
    storage.entries.set(PROFILE_V1_BACKUP_KEY, 'kept');
    new ProfileManager(storage);
    expect(storage.entries.get(PROFILE_V1_BACKUP_KEY)).toBe('kept');
  });

  it('the notice is shown once: dismissing clears it for good', () => {
    const storage = fakeStorage({ [PROFILE_STORAGE_KEY]: fixtureText('profile-v1-finished.json') });
    const manager = new ProfileManager(storage);
    expect(manager.snapshot().notice).not.toBeNull();
    manager.dismissNotice();
    expect(manager.snapshot().notice).toBeNull();
    expect(new ProfileManager(storage).snapshot().notice).toBeNull();
    expect(new ProfileManager(storage).snapshot().bonusIds).toHaveLength(4);
  });

  it('a throwing backup write never stops the migration', () => {
    const storage = fakeStorage({ [PROFILE_STORAGE_KEY]: fixtureText('profile-v1-midtour.json') });
    const realSet = storage.setItem;
    storage.setItem = (key, value) => {
      if (key === PROFILE_V1_BACKUP_KEY) throw new Error('quota');
      realSet(key, value);
    };
    const manager = new ProfileManager(storage);
    expect(manager.snapshot().bonusIds).toEqual(['nest-egg', 'research-grant']);
    expect(storedProfile(storage).version).toBe(2);
  });
});

describe('ProfileManager: recording results, grants and availability', () => {
  const win = (manager: ProfileManager, scenarioId: Parameters<ProfileManager['recordScenarioResult']>[0]['scenarioId'], atSeconds = 400, mode: 'scenario' | 'run' = 'scenario') => (
    manager.recordScenarioResult({ scenarioId, mode, outcome: 'succeeded', atSeconds, progressPercent: 100 }, true)
  );

  it('a fresh profile opens exactly the scenarios that are always open', () => {
    const manager = new ProfileManager(fakeStorage());
    expect(manager.scenarioAvailability('sunny-start')).toEqual({ unlocked: true, conditionText: null });
    expect(manager.scenarioAvailability('penny-lane')).toEqual({ unlocked: false, conditionText: 'Clear Sunny Start first' });
    expect(manager.scenarioAvailability('starlight-finale').conditionText).toBe('Clear Penny Lane or Garden Gala first');
    expect(manager.scenarioAvailability('nope' as never).unlocked).toBe(false);
  });

  it('the first clear grants the rewards once, lists what is new and what opened', () => {
    const manager = new ProfileManager(fakeStorage());
    const first = win(manager, 'sunny-start');
    expect(first).toEqual({
      scenarioId: 'sunny-start', outcome: 'succeeded', firstClear: true,
      newlyUnlockedBuildingIds: [], newlyEarnedBonusIds: ['nest-egg'],
      newlyAvailableScenarioIds: ['penny-lane', 'garden-gala', 'boardwalk-breeze', 'frost-fair', 'room-to-grow'],
      previousBestSeconds: null, newBest: false, eligible: true,
    });
    expect(manager.snapshot().bonusIds).toEqual(['nest-egg']);
    const again = win(manager, 'sunny-start', 300);
    expect(again).toMatchObject({ firstClear: false, newlyEarnedBonusIds: [], newlyUnlockedBuildingIds: [], newlyAvailableScenarioIds: [], previousBestSeconds: 400, newBest: true });
    expect(win(manager, 'sunny-start', 350)).toMatchObject({ newBest: false, previousBestSeconds: 300 });
    expect(manager.snapshot().records['sunny-start']).toMatchObject({ clears: 3, attempts: 3, bestClearSeconds: 300, bestProgressPercent: 100, firstClearVia: 'scenario' });
  });

  it('a clear on The Map (run) counts like a Scenario clear and remembers where it happened', () => {
    const manager = new ProfileManager(fakeStorage());
    win(manager, 'sunny-start', 100, 'run');
    expect(manager.snapshot().records['sunny-start']?.firstClearVia).toBe('run');
    expect(manager.snapshot().stats.run.wins).toBe(1);
    expect(manager.snapshot().stats.scenario.wins).toBe(0);
  });

  it('a gated building is granted by its scenario and shows in every later park grant, in every mode', () => {
    const manager = new ProfileManager(fakeStorage());
    expect(win(manager, 'boardwalk-breeze')).toMatchObject({ newlyUnlockedBuildingIds: ['tiki-tumbler'] });
    for (const mode of ['sandbox', 'scenario', 'run'] as const) expect(manager.parkGrant(mode).unlockedBuildingIds).toEqual(['tiki-tumbler']);
  });

  it('a failed attempt counts the attempt and the best progress, never a clear or a reward', () => {
    const manager = new ProfileManager(fakeStorage());
    const lost = manager.recordScenarioResult({ scenarioId: 'penny-lane', mode: 'scenario', outcome: 'failed', atSeconds: 1200, progressPercent: 72.5 }, true);
    expect(lost).toMatchObject({ outcome: 'failed', firstClear: false, newlyEarnedBonusIds: [] });
    manager.recordScenarioResult({ scenarioId: 'penny-lane', mode: 'scenario', outcome: 'failed', atSeconds: 1200, progressPercent: 40 }, true);
    expect(manager.snapshot().records['penny-lane']).toEqual({ clears: 0, attempts: 2, bestClearSeconds: null, bestProgressPercent: 72.5, firstClearVia: null });
    expect(manager.snapshot().clearedScenarioIds).toEqual([]);
    expect(manager.snapshot().stats.scenario.losses).toBe(2);
  });

  it('an ineligible result (a hand-edited park) counts the attempt and grants nothing, not even the clear', () => {
    const manager = new ProfileManager(fakeStorage());
    const result = manager.recordScenarioResult({ scenarioId: 'sunny-start', mode: 'scenario', outcome: 'succeeded', atSeconds: 10, progressPercent: 100 }, false);
    expect(result).toMatchObject({ eligible: false, firstClear: false, newlyEarnedBonusIds: [], newlyAvailableScenarioIds: [] });
    expect(manager.snapshot().bonusIds).toEqual([]);
    expect(manager.snapshot().clearedScenarioIds).toEqual([]);
    expect(manager.snapshot().records['sunny-start']?.attempts).toBe(1);
    expect(manager.snapshot().stats.scenario.wins).toBe(0);
  });

  it('refuses hostile input without throwing or changing anything', () => {
    const manager = new ProfileManager(fakeStorage());
    const before = serializeProfile(freshProfile());
    manager.recordScenarioResult({ scenarioId: 'nope' as never, mode: 'scenario', outcome: 'succeeded', atSeconds: 1, progressPercent: 100 }, true);
    manager.recordScenarioResult({ scenarioId: 'sunny-start', mode: 'sandbox' as never, outcome: 'succeeded', atSeconds: 1, progressPercent: 100 }, true);
    manager.recordParkStarted('creative' as never);
    manager.setUseBonuses('creative' as never, true);
    expect(manager.addDiscoveredCard('no-such-card' as never)).toBe(false);
    expect(serializeProfile(freshProfile())).toBe(before);
    expect(manager.snapshot().clearedScenarioIds).toEqual([]);
    const odd = manager.recordScenarioResult({ scenarioId: 'sunny-start', mode: 'scenario', outcome: 'succeeded', atSeconds: Number.NaN, progressPercent: Number.NaN }, true);
    expect(odd.firstClear).toBe(true);
    expect(manager.snapshot().records['sunny-start']?.bestClearSeconds).toBeNull();
  });

  it('the bonuses switch: defaults on for Scenario and The Map, off for Sandbox, applied to the NEXT park grant only', () => {
    const manager = new ProfileManager(fakeStorage());
    win(manager, 'sunny-start');
    expect(manager.snapshot().useBonuses).toEqual({ sandbox: false, scenario: true, run: true });
    expect(manager.parkGrant('sandbox').bonusIds).toEqual([]);
    expect(manager.parkGrant('scenario').bonusIds).toEqual(['nest-egg']);
    const grantBefore = manager.parkGrant('scenario');
    manager.setUseBonuses('scenario', false);
    manager.setUseBonuses('sandbox', true);
    expect(manager.parkGrant('scenario').bonusIds).toEqual([]);
    expect(manager.parkGrant('sandbox').bonusIds).toEqual(['nest-egg']);
    expect(grantBefore.bonusIds, 'a grant already handed out is a copy').toEqual(['nest-egg']);
  });

  it('a mode filter on the grant: the spare slot is not granted to Sandbox even when the switch is on', () => {
    const manager = new ProfileManager(fakeStorage());
    win(manager, 'sunny-start');
    win(manager, 'penny-lane');
    win(manager, 'starlight-finale');
    manager.setUseBonuses('sandbox', true);
    expect(manager.parkGrant('sandbox').bonusIds).toEqual(['nest-egg', 'research-grant']);
    expect(manager.parkGrant('scenario').bonusIds).toEqual(['nest-egg', 'research-grant', 'spare-slot']);
  });

  it('discovered cards: a new one is added once; the collection is the starting cards plus the discovered ones', () => {
    const manager = new ProfileManager(fakeStorage());
    expect(manager.snapshot().collectionCardIds).toEqual([...STARTING_CARD_IDS]);
    expect(manager.addDiscoveredCard('velvet-ropes')).toBe(true);
    expect(manager.addDiscoveredCard('velvet-ropes')).toBe(false);
    expect(manager.addDiscoveredCard('grand-opening')).toBe(true);
    expect(manager.snapshot().collectionCardIds).toEqual([...STARTING_CARD_IDS, 'velvet-ropes']);
    expect(manager.snapshot().discoveredCardIds).toEqual(['velvet-ropes', 'grand-opening']);
  });

  it('snapshot() is the same object until something changes; subscribers hear every change', () => {
    const manager = new ProfileManager(fakeStorage());
    const first = manager.snapshot();
    expect(manager.snapshot()).toBe(first);
    let heard = 0;
    const stop = manager.subscribe(() => { heard += 1; });
    manager.recordParkStarted('sandbox');
    expect(heard).toBe(1);
    expect(manager.snapshot()).not.toBe(first);
    expect(manager.snapshot().revision).toBe(first.revision + 1);
    expect(manager.snapshot().stats.sandbox.parksStarted).toBe(1);
    manager.setUseBonuses('sandbox', false);
    expect(heard, 'no change, no notification').toBe(1);
    stop();
    manager.recordParkStarted('sandbox');
    expect(heard).toBe(1);
  });

  it('a throwing subscriber never breaks a profile change', () => {
    const manager = new ProfileManager(fakeStorage());
    manager.subscribe(() => { throw new Error('boom'); });
    expect(() => manager.recordParkStarted('sandbox')).not.toThrow();
  });

  it('the snapshot is a copy: mutating it never reaches the profile', () => {
    const manager = new ProfileManager(fakeStorage());
    win(manager, 'sunny-start');
    const snapshot = manager.snapshot();
    snapshot.bonusIds.push('trusted-crew');
    snapshot.useBonuses.sandbox = true;
    (snapshot.records['sunny-start'] as { clears: number }).clears = 99;
    manager.recordParkStarted('sandbox');
    expect(manager.snapshot().bonusIds).toEqual(['nest-egg']);
    expect(manager.snapshot().useBonuses.sandbox).toBe(false);
    expect(manager.snapshot().records['sunny-start']?.clears).toBe(1);
  });

  it('every scenario in the content can be recorded', () => {
    const manager = new ProfileManager(fakeStorage());
    for (const scenario of SCENARIOS) expect(win(manager, scenario.id).firstClear, scenario.id).toBe(true);
    expect(manager.snapshot().bonusIds).toHaveLength(7);
    expect(manager.snapshot().unlockedBuildingIds).toHaveLength(4);
  });
});

describe('cross-tab: two managers over one storage never erase each other', () => {
  it('interleaved writes merge: progress made in both tabs survives', () => {
    const storage = fakeStorage();
    const tabA = new ProfileManager(storage);
    const tabB = new ProfileManager(storage);
    tabA.recordScenarioResult({ scenarioId: 'sunny-start', mode: 'scenario', outcome: 'succeeded', atSeconds: 100, progressPercent: 100 }, true);
    tabB.addDiscoveredCard('velvet-ropes');
    tabB.recordScenarioResult({ scenarioId: 'boardwalk-breeze', mode: 'run', outcome: 'succeeded', atSeconds: 200, progressPercent: 100 }, true);
    tabA.recordParkStarted('scenario');
    const stored = storedProfile(storage);
    expect(Object.keys(stored.scenarios).sort()).toEqual(['boardwalk-breeze', 'sunny-start']);
    expect(stored.discoveredCardIds).toEqual(['velvet-ropes']);
    expect(stored.unlockedBuildingIds).toEqual(['tiki-tumbler']);
    expect(stored.bonusIds).toEqual(['nest-egg']);
    expect(stored.stats.scenario.parksStarted).toBe(1);
    // Tab A adopted what tab B wrote when it merged on write.
    expect(tabA.snapshot().unlockedBuildingIds).toEqual(['tiki-tumbler']);
  });

  it('applyExternal merges the storage event into memory and reports whether anything changed', () => {
    const storage = fakeStorage();
    const tabA = new ProfileManager(storage);
    const tabB = new ProfileManager(storage);
    tabB.recordScenarioResult({ scenarioId: 'boardwalk-breeze', mode: 'scenario', outcome: 'succeeded', atSeconds: 5, progressPercent: 100 }, true);
    const text = storage.entries.get(PROFILE_STORAGE_KEY)!;
    let heard = 0;
    tabA.subscribe(() => { heard += 1; });
    expect(tabA.applyExternal(text)).toBe(true);
    expect(heard).toBe(1);
    expect(tabA.snapshot().unlockedBuildingIds).toEqual(['tiki-tumbler']);
    expect(tabA.applyExternal(text), 'the same value again changes nothing').toBe(false);
    expect(heard).toBe(1);
    // Applying never writes.
    const writes = storage.writes;
    tabA.applyExternal(text);
    expect(storage.writes).toBe(writes);
  });

  it('applyExternal ignores a removed key, garbage and a newer version, and never loses local progress', () => {
    const storage = fakeStorage();
    const tab = new ProfileManager(storage);
    tab.recordScenarioResult({ scenarioId: 'sunny-start', mode: 'scenario', outcome: 'succeeded', atSeconds: 5, progressPercent: 100 }, true);
    expect(tab.applyExternal(null)).toBe(false);
    expect(tab.applyExternal('garbage')).toBe(false);
    expect(tab.applyExternal(JSON.stringify({ version: 9 }))).toBe(false);
    expect(tab.applyExternal(serializeProfile(freshProfile())), 'an older, emptier profile adds nothing').toBe(false);
    expect(tab.snapshot().bonusIds).toEqual(['nest-egg']);
  });

  it('a v1 text arriving from an old tab is converted, not lost', () => {
    const storage = fakeStorage();
    const tab = new ProfileManager(storage);
    expect(tab.applyExternal(fixtureText('profile-v1-midtour.json'))).toBe(true);
    expect(tab.snapshot().clearedScenarioIds).toEqual(['sunny-start', 'penny-lane']);
  });

  it('a tour reset in one tab survives another tab\'s older tour progress (the epoch)', () => {
    const storage = fakeStorage();
    const tabA = new ProfileManager(storage);
    const tabB = new ProfileManager(storage);
    const tourA = legacyTourOver(tabA);
    const tourB = legacyTourOver(tabB);
    tourA.completeNode('opener');
    tourA.resetTour();
    tourB.completeNode('opener');
    const stored = storedProfile(storage);
    expect(stored.tour.epoch).toBe(1);
    expect(stored.tour.completedNodeIds).toEqual([]);
  });
});

describe('the legacy tour slice and the Map offer flag', () => {
  it('the retired tour writes still merge safely, with one writer for the key', () => {
    const storage = fakeStorage();
    const profile = new ProfileManager(storage);
    const tour = legacyTourOver(profile);
    tour.markMapSeen();
    tour.completeNode('opener');
    tour.addCard('lean-crew');
    expect(profile.snapshot().discoveredCardIds).toEqual(['lean-crew']);
    expect(storedProfile(storage).tour.completedNodeIds).toEqual(['opener']);
    expect(storedProfile(storage).ui.mapSeen).toBe(true);
    // A tour clear on its own is not a scenario clear.
    expect(profile.snapshot().clearedScenarioIds).toEqual([]);
    tour.resetTour();
    expect(profile.snapshot().discoveredCardIds).toEqual(['lean-crew']);
    expect(profile.uiFlags().mapSeen).toBe(true);
  });

  it('the Map offer flag (ui.tourOffered) is written once through markTourOffered and survives a reload', () => {
    const storage = fakeStorage();
    const profile = new ProfileManager(storage);
    expect(profile.uiFlags()).toEqual({ mapSeen: false, tourOffered: false });
    profile.markTourOffered();
    profile.markTourOffered();
    expect(new ProfileManager(storage).uiFlags().tourOffered).toBe(true);
    expect(storedProfile(storage).ui.tourOffered).toBe(true);
  });
});
