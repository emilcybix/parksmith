import { frontOf, type Rotation } from '../game/types';
import { vectorToView, type ViewRotation } from '../rendering/viewRotation';

/**
 * Phase 40: where a building's front points on screen, for the rotate toast. In view coordinates +v is screen lower
 * left, +u lower right, −v upper right and −u upper left (the isometric diamond); the map view turns the world first.
 */
export const facingOnScreen = (rotation: Rotation, view: ViewRotation): 'lower left' | 'lower right' | 'upper right' | 'upper left' => {
  const front = frontOf(rotation);
  const onScreen = vectorToView(view, front.x, front.y, { x: 0, y: 0 });
  if (onScreen.y > 0) return 'lower left';
  if (onScreen.x > 0) return 'lower right';
  if (onScreen.y < 0) return 'upper right';
  return 'upper left';
};
