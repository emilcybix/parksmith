import { CARD_BY_ID, STARTING_CARD_IDS } from '../cards/content';
import type { PulseCardId } from '../cards/types';
import type { GameMode } from '../modes/types';
import { MAXIMUM_SAVED_SECONDS } from '../save/ranges';
import { SCENARIOS } from '../scenarios/content';
import type { RunDifficulty } from '../run/types';
import { RUN_DIFFICULTIES } from '../run/types';
import type { ScenarioId } from '../scenarios/types';
import { TOUR_NODE_BY_ID, TOUR_NODES, TOUR_START_NODE_ID } from '../tour/content';
import type { TourNodeId } from '../tour/types';
import { BONUSES, type BonusId } from './bonuses';
import { normaliseGatedIds } from './unlocks';
import {
  PROFILE_VERSION,
  type FirstClearVia,
  type ModeStats,
  type ProfileNotice,
  type ProfileRunsSlice,
  type ProfileV2,
  type ScenarioRecord,
} from './types';

/** The one localStorage key: the Park Tour profile of v1 grew into this one (same key, so nothing is orphaned). */
export const PROFILE_STORAGE_KEY = 'parksmith-profile';
/** The original v1 text, copied once before the first v2 write. */
export const PROFILE_V1_BACKUP_KEY = 'parksmith-profile-v1-backup';
/** Raw text that was not a profile at all (garbage, an unknown old version), kept for a human to find. */
export const PROFILE_CORRUPT_BACKUP_KEY = 'parksmith-profile-corrupt-backup';

/**
 * A copy of the last v2 text this build wrote. A stale tab of the pre-Phase-22 build reads a v2 profile as unreadable and
 * writes a fresh v1 over the main key; whenever this build then reads a v1 (or garbage) it merges this copy back in, so
 * scenario records, unlocks and bonuses are never lost to an old tab.
 */
export const PROFILE_V2_SHADOW_KEY = 'parksmith-profile-v2-shadow';

/** Counters are integers 0..1,000,000. */
export const MAXIMUM_PROFILE_COUNTER = 1_000_000;

export const DEFAULT_USE_BONUSES: Readonly<Record<GameMode, boolean>> = Object.freeze({ sandbox: false, scenario: true, run: true });

const zeroStats = (): ModeStats => ({ parksStarted: 0, wins: 0, losses: 0 });

const perDifficulty = (value: number): Record<RunDifficulty, number> => ({ relaxed: value, standard: value, tough: value });

/** The most levels a run may record (matches the run state's own limit). */
export const MAXIMUM_RUN_LEVELS = 8;
/** The longest run key and the number of keys kept. */
const MAXIMUM_RUN_KEY_LENGTH = 80;
export const MAXIMUM_RECENT_RUN_KEYS = 32;

export const freshRuns = (): ProfileRunsSlice => ({
  started: 0,
  victories: perDifficulty(0),
  losses: perDifficulty(0),
  bestLevel: perDifficulty(0),
  recentRunKeys: [],
});

export const freshProfile = (): ProfileV2 => ({
  version: PROFILE_VERSION,
  discoveredCardIds: [],
  tour: { ownedCardIds: [...STARTING_CARD_IDS], unlockedNodeIds: [TOUR_START_NODE_ID], completedNodeIds: [], epoch: 0 },
  ui: { mapSeen: false, tourOffered: false },
  scenarios: {},
  unlockedBuildingIds: [],
  bonusIds: [],
  useBonuses: { ...DEFAULT_USE_BONUSES },
  stats: { sandbox: zeroStats(), scenario: zeroStats(), run: zeroStats() },
  notice: null,
  runs: freshRuns(),
});

// ---------------------------------------------------------------------------------------------
// Reading: every field validated per entry; nothing from storage is trusted
// ---------------------------------------------------------------------------------------------

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);

/** An own property, never one inherited through the prototype chain (`__proto__`, `constructor`, ...). */
const own = (record: unknown, key: string): unknown => (
  isRecord(record) && Object.hasOwn(record, key) ? record[key] : undefined
);

const counter = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) ? Math.min(MAXIMUM_PROFILE_COUNTER, Math.max(0, Math.floor(value))) : 0
);

const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);

const cardIds = (value: unknown): PulseCardId[] => (
  Array.isArray(value)
    ? [...new Set(value)].filter((id): id is PulseCardId => typeof id === 'string' && CARD_BY_ID.has(id as PulseCardId))
    : []
);

const nodeIds = (value: unknown): TourNodeId[] => (
  Array.isArray(value)
    ? [...new Set(value)].filter((id): id is TourNodeId => typeof id === 'string' && TOUR_NODE_BY_ID.has(id as TourNodeId))
    : []
);

const scenarioIds = (value: unknown): ScenarioId[] => (
  Array.isArray(value)
    ? SCENARIOS.map((scenario) => scenario.id).filter((id) => value.includes(id))
    : []
);

const bonusIdsOf = (value: unknown): BonusId[] => (
  Array.isArray(value) ? BONUSES.map((bonus) => bonus.id).filter((id) => value.includes(id)) : []
);

const VIA_ORDER: readonly FirstClearVia[] = ['scenario', 'run', 'tour-conversion'];

const readRecord = (value: unknown): ScenarioRecord | null => {
  if (!isRecord(value)) return null;
  const seconds = own(value, 'bestClearSeconds');
  const via = own(value, 'firstClearVia');
  const progress = own(value, 'bestProgressPercent');
  const clears = counter(own(value, 'clears'));
  return {
    clears,
    attempts: Math.max(clears, counter(own(value, 'attempts'))),
    bestClearSeconds: typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 && seconds <= MAXIMUM_SAVED_SECONDS ? seconds : null,
    bestProgressPercent: clears > 0 ? 100 : typeof progress === 'number' && Number.isFinite(progress) ? Math.min(100, Math.max(0, progress)) : 0,
    firstClearVia: VIA_ORDER.find((candidate) => candidate === via) ?? null,
  };
};

const readStats = (value: unknown): ModeStats => ({
  parksStarted: counter(own(value, 'parksStarted')),
  wins: counter(own(value, 'wins')),
  losses: counter(own(value, 'losses')),
});

const readPerDifficulty = (value: unknown, maximum: number): Record<RunDifficulty, number> => {
  const out = perDifficulty(0);
  for (const difficulty of RUN_DIFFICULTIES) out[difficulty] = Math.min(maximum, counter(own(value, difficulty)));
  return out;
};

const readRuns = (value: unknown): ProfileRunsSlice => {
  const keys = own(value, 'recentRunKeys');
  return {
    started: counter(own(value, 'started')),
    victories: readPerDifficulty(own(value, 'victories'), MAXIMUM_PROFILE_COUNTER),
    losses: readPerDifficulty(own(value, 'losses'), MAXIMUM_PROFILE_COUNTER),
    bestLevel: readPerDifficulty(own(value, 'bestLevel'), MAXIMUM_RUN_LEVELS),
    recentRunKeys: Array.isArray(keys)
      ? [...new Set(keys.filter((key): key is string => typeof key === 'string' && key.length > 0 && key.length <= MAXIMUM_RUN_KEY_LENGTH))].slice(-MAXIMUM_RECENT_RUN_KEYS)
      : [],
  };
};

const readNotice = (value: unknown): ProfileNotice | null => {
  if (!isRecord(value) || own(value, 'kind') !== 'tour-converted') return null;
  return {
    kind: 'tour-converted',
    clearedScenarioIds: scenarioIds(own(value, 'clearedScenarioIds')),
    bonusIds: bonusIdsOf(own(value, 'bonusIds')),
    unlockedBuildingIds: normaliseGatedIds(Array.isArray(own(value, 'unlockedBuildingIds')) ? own(value, 'unlockedBuildingIds') as unknown[] : []),
  };
};

/** The rewards of every cleared scenario are part of the profile by definition (content can grow, never shrink, what a clear gave). */
const withGrantedRewards = (profile: ProfileV2): ProfileV2 => {
  const unlocks = new Set(profile.unlockedBuildingIds);
  const bonuses = new Set<string>(profile.bonusIds);
  for (const scenario of SCENARIOS) {
    if ((profile.scenarios[scenario.id]?.clears ?? 0) <= 0) continue;
    for (const id of scenario.rewards.unlocks) unlocks.add(id);
    for (const id of scenario.rewards.bonuses) bonuses.add(id);
  }
  return { ...profile, unlockedBuildingIds: normaliseGatedIds([...unlocks]), bonusIds: bonusIdsOf([...bonuses]) };
};

const readTour = (value: unknown, withEpoch: boolean): ProfileV2['tour'] => {
  const unlockedNodeIds = nodeIds(own(value, 'unlockedNodeIds'));
  if (!unlockedNodeIds.includes(TOUR_START_NODE_ID)) unlockedNodeIds.unshift(TOUR_START_NODE_ID);
  const owned = cardIds(own(value, 'ownedCardIds'));
  return {
    ownedCardIds: owned.length === 0 ? [...STARTING_CARD_IDS] : owned,
    unlockedNodeIds,
    completedNodeIds: nodeIds(own(value, 'completedNodeIds')),
    epoch: withEpoch ? counter(own(value, 'epoch')) : 0,
  };
};

export type ProfileReadStatus = 'fresh' | 'ok' | 'migrated-v1' | 'garbage' | 'too-new';

/**
 * Any stored value (already JSON-parsed) in, a valid v2 profile out. Pure. `null`/`undefined` is a fresh profile;
 * a non-record or a version below 1 is garbage (a fresh profile; the caller keeps the raw text); a version above 2 is
 * `too-new` (a fresh in-memory profile that must never be written); version 1 is the Park Tour profile and is converted
 * (every completed tour node counts as a clear of its scenario).
 */
export const migrateProfile = (raw: unknown): { profile: ProfileV2; status: ProfileReadStatus } => {
  if (raw === null || raw === undefined) return { profile: freshProfile(), status: 'fresh' };
  if (!isRecord(raw)) return { profile: freshProfile(), status: 'garbage' };
  const version = own(raw, 'version');
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return { profile: freshProfile(), status: 'garbage' };
  if (version > PROFILE_VERSION) return { profile: freshProfile(), status: 'too-new' };
  if (version === 1) return { profile: convertV1(raw), status: 'migrated-v1' };

  const scenariosRaw = own(raw, 'scenarios');
  const scenarios: ProfileV2['scenarios'] = {};
  for (const scenario of SCENARIOS) {
    const record = readRecord(own(scenariosRaw, scenario.id));
    if (record && (record.clears > 0 || record.attempts > 0 || record.bestProgressPercent > 0)) scenarios[scenario.id] = record;
  }
  const useBonusesRaw = own(raw, 'useBonuses');
  const statsRaw = own(raw, 'stats');
  const uiRaw = own(raw, 'ui');
  const profile: ProfileV2 = {
    version: PROFILE_VERSION,
    discoveredCardIds: cardIds(own(raw, 'discoveredCardIds')),
    tour: readTour(own(raw, 'tour'), true),
    ui: { mapSeen: own(uiRaw, 'mapSeen') === true, tourOffered: own(uiRaw, 'tourOffered') === true },
    scenarios,
    unlockedBuildingIds: normaliseGatedIds(Array.isArray(own(raw, 'unlockedBuildingIds')) ? own(raw, 'unlockedBuildingIds') as unknown[] : []),
    bonusIds: bonusIdsOf(own(raw, 'bonusIds')),
    useBonuses: {
      sandbox: bool(own(useBonusesRaw, 'sandbox'), DEFAULT_USE_BONUSES.sandbox),
      scenario: bool(own(useBonusesRaw, 'scenario'), DEFAULT_USE_BONUSES.scenario),
      run: bool(own(useBonusesRaw, 'run'), DEFAULT_USE_BONUSES.run),
    },
    stats: { sandbox: readStats(own(statsRaw, 'sandbox')), scenario: readStats(own(statsRaw, 'scenario')), run: readStats(own(statsRaw, 'run')) },
    notice: readNotice(own(raw, 'notice')),
    runs: readRuns(own(raw, 'runs')),
  };
  return { profile: withGrantedRewards(profile), status: 'ok' };
};

/**
 * The Park Tour conversion. The route, the discovered cards and the ui flags are kept (the tour is the interim The
 * Map); every completed node that was also unlocked counts as a clear of its scenario (no recorded time) and grants
 * that scenario's rewards. A one-time notice says what carried over, only when something was cleared.
 */
const convertV1 = (raw: Raw): ProfileV2 => {
  const profile = freshProfile();
  profile.discoveredCardIds = cardIds(own(raw, 'discoveredCardIds'));
  profile.tour = readTour(own(raw, 'tour'), false);
  const uiRaw = own(raw, 'ui');
  profile.ui = { mapSeen: own(uiRaw, 'mapSeen') === true, tourOffered: own(uiRaw, 'tourOffered') === true };
  const cleared: ScenarioId[] = [];
  for (const node of TOUR_NODES) {
    if (!profile.tour.completedNodeIds.includes(node.id) || !profile.tour.unlockedNodeIds.includes(node.id)) continue;
    profile.scenarios[node.scenarioId] = { clears: 1, attempts: 1, bestClearSeconds: null, bestProgressPercent: 100, firstClearVia: 'tour-conversion' };
    cleared.push(node.scenarioId);
  }
  profile.stats.run.wins = cleared.length;
  const granted = withGrantedRewards(profile);
  if (cleared.length > 0) {
    granted.notice = {
      kind: 'tour-converted',
      clearedScenarioIds: scenarioIds(cleared),
      bonusIds: [...granted.bonusIds],
      unlockedBuildingIds: [...granted.unlockedBuildingIds],
    };
  }
  return granted;
};

// ---------------------------------------------------------------------------------------------
// Merging (cross-tab): monotonic, so two tabs can never erase each other's progress
// ---------------------------------------------------------------------------------------------

const unionInOrder = <T>(first: readonly T[], second: readonly T[]): T[] => [...new Set([...first, ...second])];

const mergeRecords = (left: ScenarioRecord | undefined, right: ScenarioRecord | undefined): ScenarioRecord | undefined => {
  if (!left) return right ? { ...right } : undefined;
  if (!right) return { ...left };
  const seconds = [left.bestClearSeconds, right.bestClearSeconds].filter((value): value is number => value !== null);
  const via = [left.firstClearVia, right.firstClearVia].filter((value): value is FirstClearVia => value !== null);
  return {
    clears: Math.max(left.clears, right.clears),
    attempts: Math.max(left.attempts, right.attempts),
    bestClearSeconds: seconds.length > 0 ? Math.min(...seconds) : null,
    bestProgressPercent: Math.max(left.bestProgressPercent, right.bestProgressPercent),
    firstClearVia: via.length > 0 ? via.sort((a, b) => VIA_ORDER.indexOf(a) - VIA_ORDER.indexOf(b))[0] : null,
  };
};

const byContentOrder = <T extends string>(ids: readonly T[], order: readonly T[]): T[] => order.filter((id) => ids.includes(id));

/**
 * Union of everything that only ever grows (discovered cards, unlocks, bonuses, cleared records, stats), the higher tour
 * `epoch` wins wholesale (equal epochs union their nodes and cards), the ui flags OR together, and the two settings-like
 * fields (`useBonuses`, `notice`) take the INCOMING value: last writer wins. Commutative on the monotonic parts and
 * idempotent.
 */
export const mergeProfiles = (local: ProfileV2, incoming: ProfileV2): ProfileV2 => {
  const nodeOrder = TOUR_NODES.map((node) => node.id);
  const tour = local.tour.epoch === incoming.tour.epoch
    ? {
      ownedCardIds: unionInOrder(local.tour.ownedCardIds, incoming.tour.ownedCardIds),
      unlockedNodeIds: byContentOrder(unionInOrder(local.tour.unlockedNodeIds, incoming.tour.unlockedNodeIds), nodeOrder),
      completedNodeIds: byContentOrder(unionInOrder(local.tour.completedNodeIds, incoming.tour.completedNodeIds), nodeOrder),
      epoch: local.tour.epoch,
    }
    : structuredClone(local.tour.epoch > incoming.tour.epoch ? local.tour : incoming.tour);
  const scenarios: ProfileV2['scenarios'] = {};
  for (const scenario of SCENARIOS) {
    const merged = mergeRecords(local.scenarios[scenario.id], incoming.scenarios[scenario.id]);
    if (merged) scenarios[scenario.id] = merged;
  }
  const mergeRuns = (): ProfileRunsSlice => {
    const best = (select: (runs: ProfileRunsSlice) => Record<RunDifficulty, number>): Record<RunDifficulty, number> => {
      const out = perDifficulty(0);
      for (const difficulty of RUN_DIFFICULTIES) out[difficulty] = Math.max(select(local.runs)[difficulty], select(incoming.runs)[difficulty]);
      return out;
    };
    return {
      started: Math.max(local.runs.started, incoming.runs.started),
      victories: best((runs) => runs.victories),
      losses: best((runs) => runs.losses),
      bestLevel: best((runs) => runs.bestLevel),
      recentRunKeys: unionInOrder(local.runs.recentRunKeys, incoming.runs.recentRunKeys).slice(-MAXIMUM_RECENT_RUN_KEYS),
    };
  };
  const stat = (mode: GameMode): ModeStats => ({
    parksStarted: Math.max(local.stats[mode].parksStarted, incoming.stats[mode].parksStarted),
    wins: Math.max(local.stats[mode].wins, incoming.stats[mode].wins),
    losses: Math.max(local.stats[mode].losses, incoming.stats[mode].losses),
  });
  return {
    version: PROFILE_VERSION,
    discoveredCardIds: unionInOrder(local.discoveredCardIds, incoming.discoveredCardIds),
    tour,
    ui: { mapSeen: local.ui.mapSeen || incoming.ui.mapSeen, tourOffered: local.ui.tourOffered || incoming.ui.tourOffered },
    scenarios,
    unlockedBuildingIds: normaliseGatedIds([...local.unlockedBuildingIds, ...incoming.unlockedBuildingIds]),
    bonusIds: bonusIdsOf([...local.bonusIds, ...incoming.bonusIds]),
    useBonuses: { ...incoming.useBonuses },
    stats: { sandbox: stat('sandbox'), scenario: stat('scenario'), run: stat('run') },
    notice: incoming.notice ? structuredClone(incoming.notice) : null,
    runs: mergeRuns(),
  };
};

/** Stable key order, so equal profiles are equal text. */
export const serializeProfile = (profile: ProfileV2): string => JSON.stringify({
  version: PROFILE_VERSION,
  discoveredCardIds: profile.discoveredCardIds,
  tour: profile.tour,
  ui: profile.ui,
  scenarios: profile.scenarios,
  unlockedBuildingIds: profile.unlockedBuildingIds,
  bonusIds: profile.bonusIds,
  useBonuses: profile.useBonuses,
  stats: profile.stats,
  notice: profile.notice,
  runs: profile.runs,
});
