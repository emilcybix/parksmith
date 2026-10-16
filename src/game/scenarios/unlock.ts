import { SCENARIO_BY_ID } from './content';
import type { ScenarioDefinition, ScenarioId } from './types';

/** Whether a scenario is playable in Scenario mode given the scenarios already cleared. */
export const isScenarioUnlocked = (definition: ScenarioDefinition, cleared: ReadonlySet<ScenarioId>): boolean => (
  definition.unlockedBy.kind === 'always' || definition.unlockedBy.scenarioIds.some((id) => cleared.has(id))
);

const nameOf = (id: ScenarioId): string => SCENARIO_BY_ID.get(id)?.name ?? id;

/** "Clear Sunny Start first" / "Clear Penny Lane or Garden Gala first"; null when it is always open. */
export const describeUnlockCondition = (definition: ScenarioDefinition): string | null => {
  const condition = definition.unlockedBy;
  if (condition.kind === 'always') return null;
  return `Clear ${condition.scenarioIds.map(nameOf).join(' or ')} first`;
};
