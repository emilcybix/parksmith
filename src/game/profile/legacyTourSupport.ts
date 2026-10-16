import { CARD_BY_ID } from '../cards/content';
import type { PulseCardId } from '../cards/types';
import { TOUR_NODE_BY_ID } from '../tour/content';
import type { TourNodeId } from '../tour/types';
import type { ProfileManager } from './ProfileManager';
import { freshProfile } from './schema';

/**
 * Test support (not imported by the app): the retired Park Tour's writes on the profile (Phase 23 deleted TourManager), kept
 * so the tests can still prove that profiles written by the old tour read, merge and convert safely.
 */
export const legacyTourOver = (profile: ProfileManager) => ({
  markMapSeen: (): void => profile.tourSlice.update((draft) => { draft.ui.mapSeen = true; }),
  completeNode: (nodeId: TourNodeId): void => {
    const node = TOUR_NODE_BY_ID.get(nodeId);
    if (!node || !profile.tourSlice.read().tour.unlockedNodeIds.includes(nodeId)) return;
    profile.tourSlice.update((draft) => {
      if (!draft.tour.completedNodeIds.includes(nodeId)) draft.tour.completedNodeIds.push(nodeId);
      for (const nextId of node.nextNodeIds) if (!draft.tour.unlockedNodeIds.includes(nextId)) draft.tour.unlockedNodeIds.push(nextId);
    });
  },
  addCard: (cardId: PulseCardId): void => {
    if (!CARD_BY_ID.has(cardId)) return;
    profile.tourSlice.update((draft) => {
      if (!draft.tour.ownedCardIds.includes(cardId)) draft.tour.ownedCardIds.push(cardId);
      if (!draft.discoveredCardIds.includes(cardId)) draft.discoveredCardIds.push(cardId);
    });
  },
  resetTour: (): void => profile.tourSlice.update((draft) => {
    draft.tour = { ...freshProfile().tour, epoch: draft.tour.epoch + 1 };
  }),
});
