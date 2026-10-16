import { describe, expect, it } from 'vitest';
import { STARTING_CARD_IDS } from '../cards/content';
import { PULSE_CARDS } from '../cards/content';
import { compileParkRules, preBonusStartingCash, MULTIPLIER_DIRECTION, type CardModifiableRule } from '../scenarios/rules';
import { SCENARIOS, SCENARIO_BY_ID } from '../scenarios/content';
import type { ScenarioId } from '../scenarios/types';
import { migrateSave } from '../save/migrate';
import { testStageSession } from '../run/testSupport';
import { ParkSession } from '../session/ParkSession';
import { TOUR_START_NODE_ID } from '../tour/content';
import { legacyTourOver } from './legacyTourSupport';
import { BONUSES, BONUS_CLAMPS, compileBonusLayer, type BonusDefinition, type BonusId } from './bonuses';
import { rewardEligible } from './eligibility';
import { ProfileManager, type ProfileStorage } from './ProfileManager';
import {
  PROFILE_STORAGE_KEY,
  PROFILE_V1_BACKUP_KEY,
  PROFILE_V2_SHADOW_KEY,
  freshProfile,
  mergeProfiles,
  migrateProfile,
  serializeProfile,
} from './schema';
import { PROFILE_GATED_IDS } from './unlocks';
import type { ProfileV2 } from './types';
import { sessionFromSave } from '../session/fromSave';

/**
 * Phase 22 adversarial review: profile safety, save safety and the bonus rules. `it.fails` marks a confirmed finding:
 * the test asserts what the spec asks for and fails today. Drop `.fails` once the finding is fixed.
 */

interface FakeStorage extends ProfileStorage {
  entries: Map<string, string>;
  failReads: boolean;
  failWrites: boolean;
}

const fakeStorage = (initial: Record<string, string> = {}): FakeStorage => {
  const entries = new Map(Object.entries(initial));
  const storage: FakeStorage = {
    entries,
    failReads: false,
    failWrites: false,
    getItem: (key) => {
      if (storage.failReads) throw new Error('blocked');
      return entries.get(key) ?? null;
    },
    setItem: (key, value) => {
      if (storage.failWrites) throw new DOMException('full', 'QuotaExceededError');
      entries.set(key, value);
    },
  };
  return storage;
};

/** Exactly what the pre-Phase-22 TourManager writes for a profile it could not read (`version !== 1`): a fresh v1. */
const OLD_BUILD_FRESH_V1 = JSON.stringify({
  version: 1,
  discoveredCardIds: [],
  tour: { ownedCardIds: [...STARTING_CARD_IDS], unlockedNodeIds: [TOUR_START_NODE_ID], completedNodeIds: [] },
  ui: { mapSeen: true, tourOffered: false },
});

const winAll = (manager: ProfileManager): void => {
  for (const scenario of SCENARIOS) {
    manager.recordScenarioResult({ scenarioId: scenario.id, mode: 'scenario', outcome: 'succeeded', atSeconds: 100, progressPercent: 100 }, true);
  }
};

describe('profile: the old build (a stale tab of the pre-Phase-22 game) and the v2 profile', () => {
  it('precondition: an old build treats a v2 profile as unreadable and would write a fresh v1 over it', () => {
    // The pre-Phase-22 TourManager.load(): `version !== 1` -> freshProfile(); its next save() writes that over the key.
    const storage = fakeStorage();
    const manager = new ProfileManager(storage);
    winAll(manager);
    expect(manager.snapshot().unlockedBuildingIds).toEqual([...PROFILE_GATED_IDS]);
    const parsed = JSON.parse(storage.entries.get(PROFILE_STORAGE_KEY)!) as { version: number };
    expect(parsed.version).not.toBe(1);
  });

  it('FIXED: unlocks and bonuses survive a stale old-build tab writing a fresh v1 over the v2 profile', () => {
    const storage = fakeStorage();
    const manager = new ProfileManager(storage);
    winAll(manager);
    // The stale tab (old build) marks the map seen / completes a node: it writes its fresh v1 over the key.
    storage.entries.set(PROFILE_STORAGE_KEY, OLD_BUILD_FRESH_V1);
    // The new build loads again (a reload, or the next day): the v2 data is nowhere in storage.
    const reloaded = new ProfileManager(storage);
    expect(reloaded.snapshot().unlockedBuildingIds).toEqual([...PROFILE_GATED_IDS]);
    expect(reloaded.snapshot().bonusIds.length).toBe(BONUSES.length);
  });

  it('FIXED: a v1 text arriving through the storage event is merged AND written back, so closing the tab loses nothing', () => {
    const storage = fakeStorage();
    const manager = new ProfileManager(storage);
    winAll(manager);
    storage.entries.set(PROFILE_STORAGE_KEY, OLD_BUILD_FRESH_V1);
    manager.applyExternal(OLD_BUILD_FRESH_V1);
    // In memory everything is kept ...
    expect(manager.snapshot().unlockedBuildingIds).toEqual([...PROFILE_GATED_IDS]);
    // ... but storage still holds the old build's empty v1 until this tab happens to change something.
    const stored = migrateProfile(JSON.parse(storage.entries.get(PROFILE_STORAGE_KEY)!)).profile;
    expect(stored.unlockedBuildingIds).toEqual([...PROFILE_GATED_IDS]);
  });

  it('the first v1 backup is never refreshed; the v2 shadow copy is what keeps v2 progress', () => {
    const storage = fakeStorage({ [PROFILE_STORAGE_KEY]: OLD_BUILD_FRESH_V1 });
    new ProfileManager(storage);
    expect(storage.entries.get(PROFILE_V1_BACKUP_KEY)).toBe(OLD_BUILD_FRESH_V1);
    // The v1 backup keeps the first v1 only; the v2 progress is kept by the rolling v2 shadow copy instead.
    const keys = [...storage.entries.keys()].sort();
    expect(keys).toEqual([PROFILE_STORAGE_KEY, PROFILE_V1_BACKUP_KEY, PROFILE_V2_SHADOW_KEY].sort());
    expect(storage.entries.get(PROFILE_V2_SHADOW_KEY)).toBe(storage.entries.get(PROFILE_STORAGE_KEY));
  });
});

describe('profile: corrupt and hostile stored values never block start and never lose unlocks', () => {
  const hostile: unknown[] = [
    '', 'null', 'undefined', '{', '[]', '"x"', '42', 'true', '{"version":"2"}', '{"version":2.5}', '{"version":-1}',
    '{"version":1e400}', '{"version":2,"__proto__":{"unlockedBuildingIds":["tiki-tumbler"]}}',
    '{"version":2,"scenarios":{"__proto__":{"clears":5}},"unlockedBuildingIds":"tiki-tumbler"}',
    '{"version":2,"scenarios":{"sunny-start":{"clears":1e309,"attempts":-5,"bestClearSeconds":-1}}}',
    '{"version":2,"useBonuses":{"sandbox":"yes","scenario":0,"run":null}}',
    '{"version":2,"stats":{"sandbox":{"wins":Infinity}}}',
    '{"version":2,"tour":{"epoch":-3,"unlockedNodeIds":[],"ownedCardIds":["nope"]}}',
    `{"version":2,"unlockedBuildingIds":${JSON.stringify(Array(100_000).fill('tiki-tumbler'))}}`,
  ];

  it.each(hostile.map((text, index) => [index, text] as const))('hostile text #%i: constructs, snapshot is valid, a park grant works', (_index, text) => {
    const storage = fakeStorage({ [PROFILE_STORAGE_KEY]: text as string });
    const manager = new ProfileManager(storage);
    const snapshot = manager.snapshot();
    expect(Array.isArray(snapshot.unlockedBuildingIds)).toBe(true);
    for (const id of snapshot.unlockedBuildingIds) expect(PROFILE_GATED_IDS).toContain(id);
    for (const mode of ['sandbox', 'scenario', 'run'] as const) {
      expect(typeof snapshot.useBonuses[mode]).toBe('boolean');
      const grant = manager.parkGrant(mode);
      expect(() => (mode === 'run' ? testStageSession({ grant }) : new ParkSession(mode === 'sandbox' ? null : SCENARIOS[0], [], { mode, grant }))).not.toThrow();
    }
    // What is stored afterwards is always readable by this build.
    const after = storage.entries.get(PROFILE_STORAGE_KEY);
    if (after !== undefined && after !== text) expect(migrateProfile(JSON.parse(after)).status).toBe('ok');
  });

  it('an inherited __proto__ key never grants anything', () => {
    const storage = fakeStorage({ [PROFILE_STORAGE_KEY]: '{"version":2,"__proto__":{"unlockedBuildingIds":["tiki-tumbler"],"bonusIds":["nest-egg"]}}' });
    const manager = new ProfileManager(storage);
    expect(manager.snapshot().unlockedBuildingIds).toEqual([]);
    expect(manager.snapshot().bonusIds).toEqual([]);
  });

  it('a corrupt write cannot lose unlocks: a write that fails leaves the previous stored text intact, memory keeps everything', () => {
    const storage = fakeStorage();
    const manager = new ProfileManager(storage);
    manager.recordScenarioResult({ scenarioId: 'sunny-start', mode: 'scenario', outcome: 'succeeded', atSeconds: 50, progressPercent: 100 }, true);
    const before = storage.entries.get(PROFILE_STORAGE_KEY)!;
    storage.failWrites = true;
    winAll(manager);
    expect(manager.persistence).toBe('unavailable');
    expect(storage.entries.get(PROFILE_STORAGE_KEY)).toBe(before);
    expect(manager.snapshot().unlockedBuildingIds).toEqual([...PROFILE_GATED_IDS]);
    storage.failWrites = false;
    manager.dismissNotice();
    manager.setUseBonuses('sandbox', true);
    const stored = migrateProfile(JSON.parse(storage.entries.get(PROFILE_STORAGE_KEY)!)).profile;
    expect(stored.unlockedBuildingIds).toEqual([...PROFILE_GATED_IDS]);
  });

  it('garbage written by something else AFTER load is replaced on the next write (memory wins; nothing held is lost)', () => {
    const storage = fakeStorage();
    const manager = new ProfileManager(storage);
    winAll(manager);
    storage.entries.set(PROFILE_STORAGE_KEY, '{oops');
    manager.setUseBonuses('sandbox', true);
    const stored = migrateProfile(JSON.parse(storage.entries.get(PROFILE_STORAGE_KEY)!)).profile;
    expect(stored.unlockedBuildingIds).toEqual([...PROFILE_GATED_IDS]);
  });

  it('a too-new profile is never overwritten by any action of this build, including the tour', () => {
    const newer = JSON.stringify({ version: 3, anything: true });
    const storage = fakeStorage({ [PROFILE_STORAGE_KEY]: newer });
    const manager = new ProfileManager(storage);
    const tour = legacyTourOver(manager);
    winAll(manager);
    tour.markMapSeen();
    tour.resetTour();
    manager.setUseBonuses('sandbox', true);
    manager.addDiscoveredCard(PULSE_CARDS[PULSE_CARDS.length - 1].id);
    manager.applyExternal(newer);
    expect(storage.entries.get(PROFILE_STORAGE_KEY)).toBe(newer);
    expect(manager.persistence).toBe('read-only');
  });

  it('a too-new profile written by another tab AFTER this one loaded stops this tab writing (never destroyed)', () => {
    const storage = fakeStorage();
    const manager = new ProfileManager(storage);
    const newer = JSON.stringify({ version: 3, anything: true });
    storage.entries.set(PROFILE_STORAGE_KEY, newer);
    winAll(manager);
    expect(storage.entries.get(PROFILE_STORAGE_KEY)).toBe(newer);
  });
});

describe('profile: cross-tab', () => {
  it('fuzzed interleavings of two tabs never lose a clear, unlock, bonus or discovered card', () => {
    let seed = 12345;
    const random = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let round = 0; round < 30; round += 1) {
      const storage = fakeStorage();
      const tabs = [new ProfileManager(storage), new ProfileManager(storage)];
      const expectedClears = new Set<string>();
      const expectedCards = new Set<string>();
      for (let action = 0; action < 25; action += 1) {
        const tab = tabs[Math.floor(random() * 2)];
        const roll = random();
        if (roll < 0.4) {
          const scenario = SCENARIOS[Math.floor(random() * SCENARIOS.length)];
          tab.recordScenarioResult({ scenarioId: scenario.id, mode: random() < 0.5 ? 'scenario' : 'run', outcome: 'succeeded', atSeconds: 10, progressPercent: 100 }, true);
          expectedClears.add(scenario.id);
        } else if (roll < 0.6) {
          const card = PULSE_CARDS[Math.floor(random() * PULSE_CARDS.length)];
          if (tab.addDiscoveredCard(card.id)) expectedCards.add(card.id);
          else expectedCards.add(card.id);
        } else if (roll < 0.8) {
          tab.setUseBonuses('sandbox', random() < 0.5);
        } else {
          // A storage event is delivered (sometimes late, sometimes never before the other tab writes).
          const other = tabs[0] === tab ? tabs[1] : tabs[0];
          other.applyExternal(storage.entries.get(PROFILE_STORAGE_KEY) ?? null);
        }
      }
      const stored = migrateProfile(JSON.parse(storage.entries.get(PROFILE_STORAGE_KEY)!)).profile;
      const storedCleared = new Set(Object.entries(stored.scenarios).filter(([, record]) => (record?.clears ?? 0) > 0).map(([id]) => id));
      for (const id of expectedClears) expect(storedCleared.has(id), `round ${round}: clear ${id}`).toBe(true);
      for (const id of expectedCards) {
        if (!STARTING_CARD_IDS.includes(id as never)) expect(stored.discoveredCardIds, `round ${round}: card ${id}`).toContain(id);
      }
    }
  });

  it.fails('FINDING: the bonuses switch is last TOGGLE wins, not last write: a stale tab writing something else reverts it', () => {
    const storage = fakeStorage();
    const tabA = new ProfileManager(storage);
    const tabB = new ProfileManager(storage);
    tabA.setUseBonuses('sandbox', true);
    // Tab B has not processed the storage event yet and records a result: its persist merges with itself as `incoming`.
    tabB.recordScenarioResult({ scenarioId: 'sunny-start', mode: 'scenario', outcome: 'failed', atSeconds: 10, progressPercent: 10 }, true);
    const stored = migrateProfile(JSON.parse(storage.entries.get(PROFILE_STORAGE_KEY)!)).profile;
    expect(stored.useBonuses.sandbox).toBe(true);
  });

  it.fails('FINDING: a dismissed notice stays dismissed when a stale tab writes afterwards', () => {
    const v1 = JSON.stringify({
      version: 1, discoveredCardIds: [],
      tour: { ownedCardIds: [...STARTING_CARD_IDS], unlockedNodeIds: [TOUR_START_NODE_ID], completedNodeIds: [TOUR_START_NODE_ID] },
      ui: { mapSeen: true, tourOffered: true },
    });
    const storage = fakeStorage({ [PROFILE_STORAGE_KEY]: v1 });
    const tabA = new ProfileManager(storage);
    const tabB = new ProfileManager(storage);
    expect(tabA.snapshot().notice).not.toBeNull();
    tabA.dismissNotice();
    tabB.addDiscoveredCard(PULSE_CARDS[PULSE_CARDS.length - 1].id);
    const stored = migrateProfile(JSON.parse(storage.entries.get(PROFILE_STORAGE_KEY)!)).profile;
    expect(stored.notice).toBeNull();
  });

  it('mergeProfiles never drops an unlock or bonus, whatever the order', () => {
    const left: ProfileV2 = { ...freshProfile(), unlockedBuildingIds: [PROFILE_GATED_IDS[0]], bonusIds: ['nest-egg'] };
    const right: ProfileV2 = { ...freshProfile(), unlockedBuildingIds: [PROFILE_GATED_IDS[3]], bonusIds: ['trusted-crew'] };
    for (const merged of [mergeProfiles(left, right), mergeProfiles(right, left)]) {
      expect(merged.unlockedBuildingIds).toEqual([PROFILE_GATED_IDS[0], PROFILE_GATED_IDS[3]]);
      expect(merged.bonusIds).toEqual(['nest-egg', 'trusted-crew']);
    }
  });
});

describe('Park Tour v1 conversion as documented', () => {
  it('a completed tour node converts into a clear, its rewards and a notice; a never-completed tour converts silently', () => {
    const v1 = (completed: string[]) => JSON.stringify({
      version: 1, discoveredCardIds: [],
      tour: { ownedCardIds: [...STARTING_CARD_IDS], unlockedNodeIds: [TOUR_START_NODE_ID], completedNodeIds: completed },
      ui: { mapSeen: true, tourOffered: true },
    });
    const done = new ProfileManager(fakeStorage({ [PROFILE_STORAGE_KEY]: v1([TOUR_START_NODE_ID]) }));
    expect(done.snapshot().clearedScenarioIds.length).toBe(1);
    expect(done.snapshot().notice?.kind).toBe('tour-converted');
    const none = new ProfileManager(fakeStorage({ [PROFILE_STORAGE_KEY]: v1([]) }));
    expect(none.snapshot().clearedScenarioIds).toEqual([]);
    expect(none.snapshot().notice).toBeNull();
    expect(none.isFirstRun).toBe(false);
  });

  it('conversion is idempotent across reloads: the v2 written is read back identically and the notice is not re-added once dismissed', () => {
    const storage = fakeStorage({ [PROFILE_STORAGE_KEY]: JSON.stringify({
      version: 1, discoveredCardIds: [],
      tour: { ownedCardIds: [...STARTING_CARD_IDS], unlockedNodeIds: [TOUR_START_NODE_ID], completedNodeIds: [TOUR_START_NODE_ID] },
      ui: { mapSeen: true, tourOffered: true },
    }) });
    const first = new ProfileManager(storage);
    first.dismissNotice();
    const second = new ProfileManager(storage);
    expect(second.snapshot().notice).toBeNull();
    expect(serializeProfile(migrateProfile(JSON.parse(storage.entries.get(PROFILE_STORAGE_KEY)!)).profile)).toBe(storage.entries.get(PROFILE_STORAGE_KEY));
  });
});

describe('bonus layer: caps hold for every subset and for hostile tables', () => {
  const subsets = (ids: readonly BonusId[]): BonusId[][] => ids.reduce<BonusId[][]>((all, id) => [...all, ...all.map((set) => [...set, id])], [[]]);

  it('every subset of the shipped bonuses, in every mode and every scenario: per-rule factors in [0.95, 1/0.95], cash <= min(1000, 10%), RP <= 30, slots <= 1', () => {
    for (const ids of subsets(BONUSES.map((bonus) => bonus.id))) {
      for (const mode of ['sandbox', 'scenario', 'run'] as const) {
        for (const definition of [undefined, ...SCENARIOS.map((scenario) => scenario.rules)]) {
          const base = preBonusStartingCash(definition);
          const layer = compileBonusLayer(ids, mode, base);
          expect(layer.startingCashBonus).toBeLessThanOrEqual(Math.min(BONUS_CLAMPS.maxCashBonus, Math.floor((base * 0.1) / 10) * 10));
          expect(layer.startingResearchPoints).toBeLessThanOrEqual(BONUS_CLAMPS.maxResearchPoints);
          expect(layer.extraCardSlots).toBeLessThanOrEqual(mode === 'sandbox' ? 0 : 1);
          for (const [rule, factor] of Object.entries(layer.multipliers)) {
            expect(factor).toBeGreaterThanOrEqual(0.95 - 1e-12);
            expect(factor).toBeLessThanOrEqual(1 / 0.95 + 1e-12);
            const direction = MULTIPLIER_DIRECTION[rule as CardModifiableRule];
            if (direction === 'lowerIsBetter') expect(factor).toBeLessThanOrEqual(1);
            if (direction === 'higherIsBetter') expect(factor).toBeGreaterThanOrEqual(1);
          }
        }
      }
    }
  });

  it('a hostile table (40 oversized bonuses on one rule) still lands inside every total cap', () => {
    const table: BonusDefinition[] = Array.from({ length: 40 }, (_, index) => ({
      id: `b${index}` as BonusId, name: 'x', icon: 'x', summary: 'x', modes: ['sandbox', 'scenario', 'run'],
      effect: index % 4 === 0 ? { kind: 'startingCash', amount: 1e9 }
        : index % 4 === 1 ? { kind: 'startingResearchPoints', amount: 1e9 }
          : index % 4 === 2 ? { kind: 'extraCardSlots', amount: 1 }
            : { kind: 'multiplier', rule: 'constructionCostMultiplier', factor: 0.0001 },
    }));
    const layer = compileBonusLayer(table.map((bonus) => bonus.id), 'scenario', 1e12, table);
    expect(layer.appliedBonusIds.length).toBeLessThanOrEqual(BONUS_CLAMPS.maxBonuses);
    expect(layer.startingCashBonus).toBeLessThanOrEqual(BONUS_CLAMPS.maxCashBonus);
    expect(layer.startingResearchPoints).toBeLessThanOrEqual(BONUS_CLAMPS.maxResearchPoints);
    expect(layer.extraCardSlots).toBeLessThanOrEqual(1);
    expect(layer.multipliers.constructionCostMultiplier).toBeGreaterThanOrEqual(0.95);
  });

  it('a park with every bonus AND the best cards stays inside the safety clamps, and the bonus layer never pushes a rule past what cards alone could reach by more than its cap', () => {
    for (const scenario of SCENARIOS) {
      const layer = compileBonusLayer(BONUSES.map((bonus) => bonus.id), 'scenario', preBonusStartingCash(scenario.rules));
      const cards = PULSE_CARDS.map((card) => card.modifiers);
      const withBonus = compileParkRules(scenario.rules, cards, undefined, layer);
      const without = compileParkRules(scenario.rules, cards, undefined);
      for (const rule of Object.keys(MULTIPLIER_DIRECTION) as CardModifiableRule[]) {
        const a = withBonus[rule] as number;
        const b = without[rule] as number;
        expect(Number.isFinite(a)).toBe(true);
        if (b !== 0) {
          expect(a / b, `${scenario.id} ${rule}`).toBeGreaterThanOrEqual(0.95 - 1e-9);
          expect(a / b, `${scenario.id} ${rule}`).toBeLessThanOrEqual(1 / 0.95 + 1e-9);
        }
      }
      expect(withBonus.startingCash - without.startingCash).toBeLessThanOrEqual(BONUS_CLAMPS.maxCashBonus);
    }
  });
});

describe('save: old saves map to the right mode and stay reward-eligible', () => {
  const allFixtures = import.meta.glob<Record<string, unknown>>('../save/fixtures/park-v*.json', { import: 'default', eager: true });
  // Schema 10 and 11 fixtures carry grants and `run`-mode parks (the interim Map, real runs); modes.test.ts,
  // runSave.test.ts and v11Fixtures.test.ts own them.
  const all = Object.fromEntries(Object.entries(allFixtures).filter(([key]) => !/park-v1[0-2]-/.test(key)));

  it.each(Object.keys(all).sort().map((key) => [key.split('/').pop()!, key] as const))('%s: mode by scenarioId, empty grant, loads', (_name, key) => {
    const raw = structuredClone(all[key]);
    const save = migrateSave(raw);
    const state = save.state as unknown as { scenarioId: string | null; mode: string; grant: unknown };
    expect(state.mode).toBe(state.scenarioId === null ? 'sandbox' : 'scenario');
    expect(state.grant).toEqual({ unlockedBuildingIds: [], bonusIds: [] });
    const { session } = sessionFromSave(structuredClone(all[key]));
    expect(session.mode).toBe(state.mode);
    for (const id of PROFILE_GATED_IDS) expect(session.buildLockOf(id)?.kind).toBe('profile');
  });

  const scenarioFixtures = Object.keys(all).filter((key) => /scenario|tour/.test(key)).sort();
  it.each(scenarioFixtures.map((key) => [key.split('/').pop()!, key] as const))('%s: a legitimately played old scenario save is reward-eligible', (_name, key) => {
    const { session } = sessionFromSave(structuredClone(all[key]));
    expect(SCENARIO_BY_ID.has(session.scenarioDefinition!.id as ScenarioId)).toBe(true);
    expect(rewardEligible(session)).toBe(true);
  });
});
