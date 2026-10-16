import { CARD_BY_ID, STARTING_CARD_IDS } from '../cards/content';
import { isRunDifficulty, type RunDifficulty } from '../run/types';
import type { PulseCardId } from '../cards/types';
import { GAME_MODES, type GameMode } from '../modes/types';
import { MAXIMUM_SAVED_SECONDS } from '../save/ranges';
import { SCENARIOS, SCENARIO_BY_ID } from '../scenarios/content';
import type { ScenarioId } from '../scenarios/types';
import { describeUnlockCondition, isScenarioUnlocked } from '../scenarios/unlock';
import type { ParkGrant } from '../session/ParkSession';
import { BONUSES } from './bonuses';
import {
  PROFILE_CORRUPT_BACKUP_KEY,
  PROFILE_STORAGE_KEY,
  PROFILE_V1_BACKUP_KEY,
  PROFILE_V2_SHADOW_KEY,
  MAXIMUM_RECENT_RUN_KEYS,
  MAXIMUM_RUN_LEVELS,
  freshProfile,
  mergeProfiles,
  migrateProfile,
  serializeProfile,
} from './schema';
import type {
  ProfilePersistence,
  ProfileSnapshot,
  ProfileV2,
  RunResultInput,
  RunRewardResult,
  ScenarioRecord,
  ScenarioResultInput,
  ScenarioRewardResult,
} from './types';
import { normaliseGatedIds } from './unlocks';

export interface ProfileStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/**
 * Legacy access to the Park Tour slice (retired in Phase 23; the slice stays in the profile for migration safety). The
 * app never calls it; tests use it to prove old profiles still read, merge and convert. The draft is a copy; `update`
 * writes it back, persists and bumps the revision.
 */
export interface TourSliceDraft {
  tour: ProfileV2['tour'];
  ui: ProfileV2['ui'];
  discoveredCardIds: PulseCardId[];
}

export interface TourSliceAccess {
  read(): Readonly<TourSliceDraft>;
  update(change: (draft: TourSliceDraft) => void): void;
}

const clampPercent = (value: number): number => (Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0);

/**
 * The one owner of the persisted profile (`parksmith-profile`): unlocks, bonuses, scenario records, discovered cards,
 * the Park Tour slice and the mode stats. Separate from park saves and from the settings store. Corruption-safe:
 * garbage is backed up and replaced, a newer build's data is never written over (read-only), and blocked, full or
 * throwing storage never blocks starting a park (the profile then lives in memory). Every write reads the stored value,
 * merges (monotonic) and writes, so two tabs cannot erase each other's progress.
 */
export class ProfileManager {
  private profile: ProfileV2;
  private revision = 0;
  private persistenceState: ProfilePersistence;
  private cached: ProfileSnapshot | null = null;
  private readonly listeners = new Set<() => void>();
  /** True when storage is readable and writable and held no profile yet: this browser had never run the game. */
  readonly isFirstRun: boolean;

  constructor(private readonly storage: ProfileStorage | null = null) {
    this.persistenceState = storage ? 'ok' : 'unavailable';
    this.profile = freshProfile();
    let absent = false;
    if (storage) {
      let text: string | null = null;
      let readable = true;
      try {
        text = storage.getItem(PROFILE_STORAGE_KEY);
      } catch {
        readable = false;
        this.persistenceState = 'unavailable';
      }
      if (readable) absent = text === null;
      if (readable && text !== null) this.adoptStored(text);
      // A missing key is only a first run when this browser can also remember that it has been seen.
      if (readable && (text === null || this.needsWriteAfterLoad)) {
        const written = this.write(this.profile);
        if (text === null) absent = written;
        else absent = false;
      }
    }
    this.isFirstRun = absent;
  }

  private needsWriteAfterLoad = false;

  private adoptStored(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.backup(PROFILE_CORRUPT_BACKUP_KEY, text);
      this.profile = this.withShadow(freshProfile());
      this.needsWriteAfterLoad = true;
      return;
    }
    const { profile, status } = migrateProfile(parsed);
    if (status === 'too-new') {
      // A newer build's data is never destroyed: this session plays on a fresh in-memory profile, never written.
      this.persistenceState = 'read-only';
      return;
    }
    if (status === 'garbage') {
      this.backup(PROFILE_CORRUPT_BACKUP_KEY, text);
      this.profile = this.withShadow(freshProfile());
      this.needsWriteAfterLoad = true;
      return;
    }
    if (status === 'migrated-v1') {
      this.backup(PROFILE_V1_BACKUP_KEY, text);
      this.needsWriteAfterLoad = true;
      // A v1 after this build has written v2 means a stale old-build tab wrote over it: the shadow holds what it lost.
      this.profile = this.withShadow(profile);
      return;
    }
    this.profile = profile;
  }

  /** `profile` merged with the shadow copy of the last v2 this build wrote (unchanged when there is none or it is unreadable). */
  private withShadow(profile: ProfileV2): ProfileV2 {
    if (!this.storage) return profile;
    try {
      const text = this.storage.getItem(PROFILE_V2_SHADOW_KEY);
      if (text === null) return profile;
      const { profile: shadow, status } = migrateProfile(JSON.parse(text));
      return status === 'ok' ? mergeProfiles(profile, shadow) : profile;
    } catch {
      return profile;
    }
  }

  /** Copies raw text to a backup key once (never over an earlier backup); failures are swallowed. */
  private backup(key: string, text: string): void {
    if (!this.storage) return;
    try {
      if (this.storage.getItem(key) === null) this.storage.setItem(key, text);
    } catch {
      // The backup is a courtesy; the profile still loads.
    }
  }

  get persistence(): ProfilePersistence {
    return this.persistenceState;
  }

  // ---------------------------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------------------------

  /** The same object while the revision is unchanged. */
  snapshot(): ProfileSnapshot {
    if (this.cached && this.cached.revision === this.revision && this.cached.persistence === this.persistenceState) return this.cached;
    const profile = this.profile;
    const cleared = SCENARIOS.map((scenario) => scenario.id).filter((id) => (profile.scenarios[id]?.clears ?? 0) > 0);
    const records: ProfileSnapshot['records'] = {};
    for (const id of Object.keys(profile.scenarios) as ScenarioId[]) {
      const record = profile.scenarios[id];
      if (record) records[id] = { ...record };
    }
    this.cached = {
      revision: this.revision,
      persistence: this.persistenceState,
      clearedScenarioIds: cleared,
      records,
      unlockedBuildingIds: [...profile.unlockedBuildingIds],
      collectionCardIds: [...new Set<PulseCardId>([...STARTING_CARD_IDS, ...profile.discoveredCardIds])],
      discoveredCardIds: [...profile.discoveredCardIds],
      bonusIds: [...profile.bonusIds],
      useBonuses: { ...profile.useBonuses },
      stats: { sandbox: { ...profile.stats.sandbox }, scenario: { ...profile.stats.scenario }, run: { ...profile.stats.run } },
      notice: profile.notice ? structuredClone(profile.notice) : null,
      runs: structuredClone(profile.runs),
    };
    return this.cached;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** The one-time UI flags (Phase 23: `tourOffered` is "the Map offer has been shown"; `mapSeen` is legacy and unread). */
  uiFlags(): { mapSeen: boolean; tourOffered: boolean } {
    return { ...this.profile.ui };
  }

  /** What a NEW park in `mode` gets: every unlock; the bonuses only when the mode's switch is on (and the bonus applies there). */
  parkGrant(mode: GameMode): ParkGrant {
    const bonusIds = this.profile.useBonuses[mode]
      ? BONUSES.filter((bonus) => this.profile.bonusIds.includes(bonus.id) && bonus.modes.includes(mode)).map((bonus) => bonus.id)
      : [];
    return { unlockedBuildingIds: [...this.profile.unlockedBuildingIds], bonusIds };
  }

  scenarioAvailability(id: ScenarioId): { unlocked: boolean; conditionText: string | null } {
    const definition = SCENARIO_BY_ID.get(id);
    if (!definition) return { unlocked: false, conditionText: 'Unknown scenario' };
    const unlocked = isScenarioUnlocked(definition, this.clearedSet());
    return { unlocked, conditionText: unlocked ? null : describeUnlockCondition(definition) };
  }

  private clearedSet(): Set<ScenarioId> {
    return new Set(SCENARIOS.map((scenario) => scenario.id).filter((id) => (this.profile.scenarios[id]?.clears ?? 0) > 0));
  }

  // ---------------------------------------------------------------------------------------------
  // Changing
  // ---------------------------------------------------------------------------------------------

  recordParkStarted(mode: GameMode): void {
    if (!GAME_MODES.includes(mode)) return;
    this.profile.stats[mode].parksStarted = Math.min(1_000_000, this.profile.stats[mode].parksStarted + 1);
    this.changed();
  }

  /**
   * Records the attempt; on the first clear grants the scenario's rewards. `eligible` false (the park's rules did not
   * match a park started in this game) counts the attempt and grants nothing, not even the clear.
   */
  recordScenarioResult(input: ScenarioResultInput, eligible: boolean): ScenarioRewardResult {
    const definition = SCENARIO_BY_ID.get(input.scenarioId);
    const none = (outcome: 'succeeded' | 'failed'): ScenarioRewardResult => ({
      scenarioId: input.scenarioId,
      outcome,
      firstClear: false,
      newlyUnlockedBuildingIds: [],
      newlyEarnedBonusIds: [],
      newlyAvailableScenarioIds: [],
      previousBestSeconds: null,
      newBest: false,
      eligible,
    });
    const outcome = input.outcome === 'succeeded' ? 'succeeded' : 'failed';
    if (!definition || (input.mode !== 'scenario' && input.mode !== 'run')) return none(outcome);
    const previous = this.profile.scenarios[input.scenarioId];
    const record: ScenarioRecord = previous
      ? { ...previous }
      : { clears: 0, attempts: 0, bestClearSeconds: null, bestProgressPercent: 0, firstClearVia: null };
    record.attempts = Math.min(1_000_000, record.attempts + 1);
    const result = { ...none(outcome), previousBestSeconds: record.bestClearSeconds };
    if (!eligible) {
      this.profile.scenarios[input.scenarioId] = record;
      this.changed();
      return result;
    }
    const mode = input.mode;
    if (outcome === 'failed') {
      record.bestProgressPercent = Math.max(record.bestProgressPercent, clampPercent(input.progressPercent));
      this.profile.stats[mode].losses = Math.min(1_000_000, this.profile.stats[mode].losses + 1);
      this.profile.scenarios[input.scenarioId] = record;
      this.changed();
      return result;
    }
    const seconds = Number.isFinite(input.atSeconds) && input.atSeconds >= 0 ? Math.min(MAXIMUM_SAVED_SECONDS, input.atSeconds) : null;
    const wasCleared = record.clears > 0;
    const clearedBefore = this.clearedSet();
    record.clears = Math.min(1_000_000, record.clears + 1);
    record.bestProgressPercent = 100;
    if (record.firstClearVia === null) record.firstClearVia = mode;
    if (seconds !== null && (record.bestClearSeconds === null || seconds < record.bestClearSeconds)) {
      result.newBest = record.bestClearSeconds !== null;
      record.bestClearSeconds = seconds;
    }
    this.profile.stats[mode].wins = Math.min(1_000_000, this.profile.stats[mode].wins + 1);
    this.profile.scenarios[input.scenarioId] = record;
    result.firstClear = !wasCleared;
    // Rewards: once per scenario, on the first clear; anything already held is not "new".
    const unlocks = normaliseGatedIds([...this.profile.unlockedBuildingIds, ...definition.rewards.unlocks]);
    result.newlyUnlockedBuildingIds = unlocks.filter((id) => !this.profile.unlockedBuildingIds.includes(id));
    const bonuses = BONUSES.map((bonus) => bonus.id).filter((id) => this.profile.bonusIds.includes(id) || definition.rewards.bonuses.includes(id));
    result.newlyEarnedBonusIds = bonuses.filter((id) => !this.profile.bonusIds.includes(id));
    this.profile.unlockedBuildingIds = unlocks;
    this.profile.bonusIds = bonuses;
    const clearedAfter = this.clearedSet();
    result.newlyAvailableScenarioIds = SCENARIOS
      .filter((candidate) => !isScenarioUnlocked(candidate, clearedBefore) && isScenarioUnlocked(candidate, clearedAfter))
      .map((candidate) => candidate.id);
    this.changed();
    return result;
  }

  markTourOffered(): void {
    if (this.profile.ui.tourOffered) return;
    this.profile.ui = { ...this.profile.ui, tourOffered: true };
    this.changed();
  }

  /** Tough opens with a victory on Standard or Tough (a profile unlock; never raw power). Relaxed and Standard are always open. */
  runDifficultyAvailability(difficulty: RunDifficulty): { available: boolean; conditionText: string | null } {
    if (!isRunDifficulty(difficulty)) return { available: false, conditionText: 'Unknown difficulty' };
    if (difficulty !== 'tough') return { available: true, conditionText: null };
    const { victories } = this.profile.runs;
    const available = victories.standard + victories.tough > 0;
    return { available, conditionText: available ? null : 'Win a Standard run to unlock' };
  }

  /** A run began (the profile's `runs.started`). Counts every run, eligible or not. */
  recordRunStarted(difficulty: RunDifficulty): void {
    if (!isRunDifficulty(difficulty)) return;
    this.profile.runs.started = Math.min(1_000_000, this.profile.runs.started + 1);
    this.changed();
  }

  /**
   * Records the end of a run, once per run key. A loss updates the best level and the loss counters; a victory also
   * discovers every card of the run's deck for good and opens Tough. Never raw power: no bonus, no cash. `eligible` false
   * (the run's plan did not match what this game plans: a hand-edited run) counts nothing at all.
   */
  recordRunResult(input: RunResultInput, eligible: boolean): RunRewardResult {
    const outcome = input.outcome === 'won' ? 'won' : 'lost';
    const none = (alreadyRecorded: boolean): RunRewardResult => ({
      eligible,
      alreadyRecorded,
      outcome,
      newlyDiscoveredCardIds: [],
      newlyUnlockedDifficulties: [],
      newBestLevel: false,
      previousBestLevel: isRunDifficulty(input.difficulty) ? this.profile.runs.bestLevel[input.difficulty] : 0,
      bestLevel: isRunDifficulty(input.difficulty) ? this.profile.runs.bestLevel[input.difficulty] : 0,
    });
    if (!isRunDifficulty(input.difficulty) || typeof input.runKey !== 'string' || input.runKey.length === 0 || input.runKey.length > 80) return none(false);
    if (this.profile.runs.recentRunKeys.includes(input.runKey)) return none(true);
    if (!eligible) return none(false);
    const runs = this.profile.runs;
    const difficulty = input.difficulty;
    const levels = Number.isFinite(input.levelsCleared) ? Math.min(MAXIMUM_RUN_LEVELS, Math.max(0, Math.floor(input.levelsCleared))) : 0;
    const result = none(false);
    const toughBefore = this.runDifficultyAvailability('tough').available;
    runs.recentRunKeys = [...runs.recentRunKeys, input.runKey].slice(-MAXIMUM_RECENT_RUN_KEYS);
    result.newBestLevel = levels > runs.bestLevel[difficulty];
    runs.bestLevel[difficulty] = Math.max(runs.bestLevel[difficulty], levels);
    result.bestLevel = runs.bestLevel[difficulty];
    if (outcome === 'lost') {
      runs.losses[difficulty] = Math.min(1_000_000, runs.losses[difficulty] + 1);
      this.profile.stats.run.losses = Math.min(1_000_000, this.profile.stats.run.losses + 1);
      this.changed();
      return result;
    }
    runs.victories[difficulty] = Math.min(1_000_000, runs.victories[difficulty] + 1);
    this.profile.stats.run.wins = Math.min(1_000_000, this.profile.stats.run.wins + 1);
    const known = new Set<string>([...STARTING_CARD_IDS, ...this.profile.discoveredCardIds]);
    for (const cardId of input.deckCardIds) {
      if (!CARD_BY_ID.has(cardId) || known.has(cardId)) continue;
      known.add(cardId);
      this.profile.discoveredCardIds.push(cardId);
      result.newlyDiscoveredCardIds.push(cardId);
    }
    if (!toughBefore && this.runDifficultyAvailability('tough').available) result.newlyUnlockedDifficulties.push('tough');
    this.changed();
    return result;
  }

  /** Discovers a card for good. Returns whether it was new (a starting card or an unknown id is not). */
  addDiscoveredCard(cardId: PulseCardId): boolean {
    if (!CARD_BY_ID.has(cardId) || this.profile.discoveredCardIds.includes(cardId)) return false;
    this.profile.discoveredCardIds.push(cardId);
    this.changed();
    return true;
  }

  setUseBonuses(mode: GameMode, on: boolean): void {
    if (!GAME_MODES.includes(mode) || typeof on !== 'boolean' || this.profile.useBonuses[mode] === on) return;
    this.profile.useBonuses[mode] = on;
    this.changed();
  }

  dismissNotice(): void {
    if (this.profile.notice === null) return;
    this.profile.notice = null;
    this.changed();
  }

  /**
   * Cross-tab: the `storage` event's `newValue` for PROFILE_STORAGE_KEY. Merges (never loses what this tab holds) and
   * reports whether anything changed. Garbage, a newer version or `null` (the key was removed) change nothing.
   */
  applyExternal(newValue: string | null): boolean {
    if (newValue === null) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(newValue);
    } catch {
      return false;
    }
    const { profile: incoming, status } = migrateProfile(parsed);
    if (status !== 'ok' && status !== 'migrated-v1') return false;
    const merged = mergeProfiles(this.profile, incoming);
    // A v1 arriving here is a stale old-build tab writing over the v2 profile: the merged profile is written back at
    // once, so storage never keeps the loss even if this tab closes without another change.
    if (status === 'migrated-v1') this.write(merged);
    if (serializeProfile(merged) === serializeProfile(this.profile)) return false;
    this.profile = merged;
    this.bump();
    return true;
  }

  /** The Park Tour's access (one writer: TourManager changes the tour slice only through here). */
  readonly tourSlice: TourSliceAccess = {
    read: () => ({
      tour: structuredClone(this.profile.tour),
      ui: { ...this.profile.ui },
      discoveredCardIds: [...this.profile.discoveredCardIds],
    }),
    update: (change) => {
      const draft: TourSliceDraft = {
        tour: structuredClone(this.profile.tour),
        ui: { ...this.profile.ui },
        discoveredCardIds: [...this.profile.discoveredCardIds],
      };
      change(draft);
      this.profile.tour = draft.tour;
      this.profile.ui = draft.ui;
      this.profile.discoveredCardIds = draft.discoveredCardIds;
      this.changed();
    },
  };

  // ---------------------------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------------------------

  private bump(): void {
    this.revision += 1;
    this.cached = null;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A listener must never break a profile change.
      }
    }
  }

  private changed(): void {
    this.persist();
    this.bump();
  }

  /** Read-merge-write: what another tab stored meanwhile is merged in, never overwritten. */
  private persist(): void {
    if (!this.storage || this.persistenceState === 'read-only') return;
    let toWrite = this.profile;
    try {
      const text = this.storage.getItem(PROFILE_STORAGE_KEY);
      if (text !== null) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = undefined;
        }
        if (parsed !== undefined) {
          const { profile: stored, status } = migrateProfile(parsed);
          if (status === 'too-new') {
            this.persistenceState = 'read-only';
            return;
          }
          if (status === 'ok') toWrite = mergeProfiles(stored, this.profile);
          else if (status === 'migrated-v1') toWrite = mergeProfiles(this.withShadow(stored), this.profile);
        }
      }
    } catch {
      // An unreadable store falls through to the write below, which reports the real state.
    }
    this.profile = toWrite;
    this.write(toWrite);
  }

  /** Returns whether the profile was persisted. */
  private write(profile: ProfileV2): boolean {
    if (!this.storage || this.persistenceState === 'read-only') return false;
    try {
      const text = serializeProfile(profile);
      this.storage.setItem(PROFILE_STORAGE_KEY, text);
      this.persistenceState = 'ok';
      try {
        this.storage.setItem(PROFILE_V2_SHADOW_KEY, text);
      } catch {
        // The shadow is a safety copy; the profile itself was written.
      }
      return true;
    } catch {
      // Storage may be full or blocked; the in-memory profile still works for this session.
      this.persistenceState = 'unavailable';
      return false;
    }
  }
}
