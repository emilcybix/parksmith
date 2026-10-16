import type { TourNodeDefinition, TourNodeId } from './types';

/**
 * LEGACY (retired in Phase 23, replaced by The Map, see src/game/run): these ids exist only so an old profile's `tour` slice
 * and an old save's `app.tourNodeId` still validate, merge and convert. Nothing plays the tour any more; its four parks are
 * the scenarios Sunny Start, Penny Lane, Garden Gala and Starlight Finale in the Scenario browser.
 *
 * The first vertical slice of the Park Tour: an opener, a choice of two branches,
 * and a finale. Clearing either branch unlocks the finale.
 */
export const TOUR_NODES: readonly TourNodeDefinition[] = [
  { id: 'opener', scenarioId: 'sunny-start', stage: 0, nextNodeIds: ['branch-profit', 'branch-garden'] },
  { id: 'branch-profit', scenarioId: 'penny-lane', stage: 1, nextNodeIds: ['finale'] },
  { id: 'branch-garden', scenarioId: 'garden-gala', stage: 1, nextNodeIds: ['finale'] },
  { id: 'finale', scenarioId: 'starlight-finale', stage: 2, nextNodeIds: [] },
] as const;

export const TOUR_START_NODE_ID: TourNodeId = 'opener';

export const TOUR_NODE_BY_ID = new Map<TourNodeId, TourNodeDefinition>(
  TOUR_NODES.map((node) => [node.id, node]),
);

export const TOUR_NODE_BY_SCENARIO = new Map(
  TOUR_NODES.map((node) => [node.scenarioId, node]),
);
