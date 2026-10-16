import { BUILD_CATALOG } from '../content/catalog';
import { SCENARIOS } from '../scenarios/content';
import type { ScenarioId } from '../scenarios/types';

/** The profile-gated catalog ids, in catalog order. */
export const PROFILE_GATED_IDS: readonly string[] = BUILD_CATALOG
  .filter((definition) => definition.profileGate === true)
  .map((definition) => definition.id);

const GATED = new Set(PROFILE_GATED_IDS);

export const isProfileGated = (definitionId: string): boolean => GATED.has(definitionId);

/** The scenario whose first clear grants this entry (exactly one; validated by a test). */
export const unlockSourceOf = (definitionId: string): ScenarioId | undefined => (
  SCENARIOS.find((scenario) => scenario.rewards.unlocks.includes(definitionId))?.id
);

/** "Clear Frost Fair in Scenario mode" (plain data for the lock text everywhere). A run stage never clears a scenario (Phase 23). */
export const unlockConditionText = (definitionId: string): string => {
  const source = unlockSourceOf(definitionId);
  const scenario = source === undefined ? undefined : SCENARIOS.find((candidate) => candidate.id === source);
  return scenario === undefined
    ? 'Unlock it by playing scenarios'
    : `Clear ${scenario.name} in Scenario mode`;
};

/** Gated ids in catalog order, restricted to `ids` (unknown and non-gated ids dropped, duplicates collapsed). */
export const normaliseGatedIds = (ids: readonly unknown[]): string[] => {
  const wanted = new Set(ids.filter((id): id is string => typeof id === 'string'));
  return PROFILE_GATED_IDS.filter((id) => wanted.has(id));
};
