/** LEGACY (retired in Phase 23): the Park Tour's ids and shapes, kept read-only for profile and save migration safety. See tour/content.ts. */
import type { PulseCardId } from '../cards/types';
import type { ScenarioId } from '../scenarios/types';

export type TourNodeId = 'opener' | 'branch-profit' | 'branch-garden' | 'finale';

/**
 * One park node on the handcrafted tour map. Nodes reference scenarios and cards
 * only by their stable ids so a persisted profile survives content additions.
 */
export interface TourNodeDefinition {
  id: TourNodeId;
  scenarioId: ScenarioId;
  /** Column on the map: 0 = opener, rising toward the finale. */
  stage: number;
  nextNodeIds: readonly TourNodeId[];
}

export type TourNodeStatus = 'locked' | 'available' | 'completed';

export interface TourNodeSnapshot {
  id: TourNodeId;
  scenarioId: ScenarioId;
  stage: number;
  status: TourNodeStatus;
  nextNodeIds: TourNodeId[];
}

/** Versioned profile persisted between parks and browser sessions. */
export interface TourProfileV1 {
  version: 1;
  /** Cards ever earned, kept across tours; discoveries never add raw power by themselves. */
  discoveredCardIds: PulseCardId[];
  tour: {
    /** The current tour's usable collection. */
    ownedCardIds: PulseCardId[];
    unlockedNodeIds: TourNodeId[];
    completedNodeIds: TourNodeId[];
  };
  /**
   * First-run bookkeeping, optional so every stored v1 profile still loads. Both flags are
   * remembered across tours (a tour reset must not bring the welcome back).
   */
  ui?: TourProfileUiFlags;
}

export interface TourProfileUiFlags {
  /** The Parks map has been opened for the player once on a first run. */
  mapSeen: boolean;
  /** The Park Tour offer has been shown once in Park Pulse. */
  tourOffered: boolean;
}

export interface TourStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
