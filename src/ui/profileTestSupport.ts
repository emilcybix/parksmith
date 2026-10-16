import { ProfileManager, type ProfileStorage } from '../game/profile/ProfileManager';
import type { ProfileSnapshot } from '../game/profile/types';
import type { ScenarioId } from '../game/scenarios/types';

/** Test support: a real ProfileManager over an in-memory storage, so UI models are tested against real snapshots. */
export const memoryStorage = (): ProfileStorage => {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value); },
  };
};

export const profileAfter = (clears: readonly ScenarioId[], atSeconds = 840): { manager: ProfileManager; snapshot: ProfileSnapshot } => {
  const manager = new ProfileManager(memoryStorage());
  for (const scenarioId of clears) {
    manager.recordScenarioResult({ scenarioId, mode: 'scenario', outcome: 'succeeded', atSeconds, progressPercent: 100 }, true);
  }
  return { manager, snapshot: manager.snapshot() };
};
