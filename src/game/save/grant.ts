import { BUILD_BY_ID } from '../content/catalog';
import type { GameMode } from '../modes/types';
import { BONUSES, BONUS_BY_ID, isBonusId, type BonusId } from '../profile/bonuses';
import { PROFILE_GATED_IDS, isProfileGated } from '../profile/unlocks';
import type { ParkGrantState } from './state';
import { SaveError } from './version';

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

/** The longest id list a saved grant may hold (checked before walking it). */
const MAXIMUM_GRANT_IDS = 64;

/**
 * Validates a saved grant (schema 10) per the Phase 12 policy: refuse, never silently trust. Shape problems and a
 * known id in the wrong place are `invalid-state`; an id this build does not have is `content-mismatch`.
 */
export const readGrant = (value: unknown, mode: GameMode): ParkGrantState => {
  if (!isRecord(value)) throw new SaveError('invalid-state', 'ParkSession cannot restore: grant is missing or not an object');
  const { unlockedBuildingIds, bonusIds } = value;
  if (!Array.isArray(unlockedBuildingIds) || !Array.isArray(bonusIds)) {
    throw new SaveError('invalid-state', 'ParkSession cannot restore: grant.unlockedBuildingIds and grant.bonusIds must be arrays');
  }
  if (unlockedBuildingIds.length > MAXIMUM_GRANT_IDS || bonusIds.length > MAXIMUM_GRANT_IDS) {
    throw new SaveError('invalid-state', `ParkSession cannot restore: a grant list is longer than ${MAXIMUM_GRANT_IDS}`);
  }
  if (unlockedBuildingIds.some((id) => typeof id !== 'string') || bonusIds.some((id) => typeof id !== 'string')) {
    throw new SaveError('invalid-state', 'ParkSession cannot restore: grant ids must be strings');
  }
  if (new Set(unlockedBuildingIds).size !== unlockedBuildingIds.length || new Set(bonusIds).size !== bonusIds.length) {
    throw new SaveError('invalid-state', 'ParkSession cannot restore: grant ids must be unique');
  }
  for (const id of unlockedBuildingIds as string[]) {
    if (!BUILD_BY_ID.has(id)) throw new SaveError('content-mismatch', `This save unlocks building '${id}', which this version of the game does not have.`);
    if (!isProfileGated(id)) throw new SaveError('invalid-state', `ParkSession cannot restore: grant.unlockedBuildingIds holds '${id}', which is not a profile-gated building`);
  }
  for (const id of bonusIds as string[]) {
    if (!isBonusId(id)) throw new SaveError('content-mismatch', `This save uses permanent bonus '${id}', which this version of the game does not have.`);
    if (!BONUS_BY_ID.get(id)?.modes.includes(mode)) throw new SaveError('invalid-state', `ParkSession cannot restore: bonus '${id}' does not apply in ${mode} mode`);
  }
  const inCatalogOrder = PROFILE_GATED_IDS.filter((id) => (unlockedBuildingIds as string[]).includes(id));
  if (inCatalogOrder.some((id, index) => id !== unlockedBuildingIds[index])) {
    throw new SaveError('invalid-state', 'ParkSession cannot restore: grant.unlockedBuildingIds is not in catalog order');
  }
  const canonical = BONUSES.map((bonus) => bonus.id).filter((id) => (bonusIds as string[]).includes(id));
  if (canonical.some((id, index) => id !== bonusIds[index])) {
    throw new SaveError('invalid-state', 'ParkSession cannot restore: grant.bonusIds is not in canonical order');
  }
  return { unlockedBuildingIds: [...(unlockedBuildingIds as string[])], bonusIds: [...(bonusIds as BonusId[])] };
};
