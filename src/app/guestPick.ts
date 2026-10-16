import { isExposed } from '../game/guests/life';
import type { Guest } from '../game/guests/types';
import type { Cell } from '../game/types';
import { vectorFromView, type ViewRotation } from '../rendering/viewRotation';

/**
 * Phase 36: how far, in view cells along each view axis, a guest figure reaches up the screen. A figure stands on its
 * ground point and is about 20 px tall where one view cell along the view diagonal is 32 px (the same ratio at every
 * zoom), so a click on its head lands on the ground about 0.6 of a cell BEHIND the guest on both view axes. Measured
 * in headless Chromium: with the plain distance test a click 8 px or more above the feet missed the guest.
 */
export const FIGURE_PICK_REACH = 0.7;

/** Phase 30's pick radius: a guest within this many cells of the clicked cell (or of its figure's column) is picked. */
export const GUEST_PICK_RADIUS = 0.75;

/**
 * The guest whose drawn figure covers the clicked ground `cell`, or null. A figure covers the cells from its ground
 * point up the screen, so the test is the distance from the guest to the segment that starts at the clicked cell and
 * runs `reach` view cells TOWARDS the viewer (the cells in front, whose figures rise over it), in world cells for the
 * view `rotation`. Riders, shoppers and guests in a facility are not drawn and are skipped. Nearest wins, the lower id
 * on a tie (Phase 30's rule). `reach` 0 is Phase 30's plain `guestNear`. A pure read: the simulation is not touched.
 */
export const pickGuest = (
  guests: Iterable<Pick<Guest, 'id' | 'position' | 'state'>>,
  cell: Cell,
  rotation: ViewRotation,
  reach = FIGURE_PICK_REACH,
  radius = GUEST_PICK_RADIUS,
): number | null => {
  const towardsViewer = vectorFromView(rotation, reach, reach, { x: 0, y: 0 });
  const lengthSquared = towardsViewer.x * towardsViewer.x + towardsViewer.y * towardsViewer.y;
  let best: number | null = null;
  let nearest = radius;
  for (const guest of guests) {
    if (!isExposed(guest.state)) continue;
    const dx = guest.position.x - cell.x;
    const dy = guest.position.y - cell.y;
    const t = lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, (dx * towardsViewer.x + dy * towardsViewer.y) / lengthSquared));
    const distance = Math.hypot(dx - t * towardsViewer.x, dy - t * towardsViewer.y);
    if (distance < nearest || (distance === nearest && best !== null && guest.id < best)) {
      best = guest.id;
      nearest = distance;
    }
  }
  return best;
};
