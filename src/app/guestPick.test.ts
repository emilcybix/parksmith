import { describe, expect, it } from 'vitest';
import type { Guest } from '../game/guests/types';
import { FIGURE_PICK_REACH, pickGuest } from './guestPick';

/**
 * Phase 36: in headless Chromium a click on a guest's body or head (8 px or more above the feet at the default zoom,
 * where the figure is about 20 px tall) missed the guest: the clicked ground cell is BEHIND the figure, about 0.6 of a
 * view cell on both view axes for the head, and Phase 30's plain 0.75-cell distance test only caught the feet.
 */

type G = Pick<Guest, 'id' | 'position' | 'state'>;
const guest = (id: number, x: number, y: number, state: Guest['state'] = 'wandering'): G => ({ id, position: { x, y }, state });

describe('pickGuest: the clicked cell, or the figure rising over it', () => {
  it('keeps Phase 30: a guest on the clicked cell, within 0.75 of a cell, nearest first, lower id on a tie', () => {
    expect(pickGuest([guest(1, 10, 10)], { x: 10, y: 10 }, 0, 0)).toBe(1);
    expect(pickGuest([guest(1, 10.7, 10)], { x: 10, y: 10 }, 0, 0)).toBe(1);
    expect(pickGuest([guest(1, 10.8, 10)], { x: 10, y: 10 }, 0, 0)).toBeNull();
    expect(pickGuest([guest(2, 10.2, 10), guest(1, 9.8, 10)], { x: 10, y: 10 }, 0, 0)).toBe(1);
    expect(pickGuest([guest(2, 10.1, 10), guest(1, 10.3, 10)], { x: 10, y: 10 }, 0, 0)).toBe(2);
  });

  it('a click on the head (the ground about 0.6 of a view cell behind the guest on both axes) picks the guest', () => {
    const guests = [guest(5, 12, 12)];
    // View 0: towards the viewer is +x, +y.
    expect(pickGuest(guests, { x: 11, y: 11 }, 0)).toBe(5);
    expect(pickGuest(guests, { x: 11, y: 11 }, 0, 0)).toBeNull();
    // The cell IN FRONT of the guest is not covered by the figure.
    expect(pickGuest(guests, { x: 13, y: 13 }, 0)).toBeNull();
  });

  it('follows the view rotation: "behind" is a different world direction in each view', () => {
    const guests = [guest(7, 12, 12)];
    const behind: Record<0 | 1 | 2 | 3, { x: number; y: number }> = {
      0: { x: 11, y: 11 }, // towards the viewer (+1, +1)
      1: { x: 11, y: 13 }, // (+1, -1)
      2: { x: 13, y: 13 }, // (-1, -1)
      3: { x: 13, y: 11 }, // (-1, +1)
    };
    for (const rotation of [0, 1, 2, 3] as const) {
      expect(pickGuest(guests, behind[rotation], rotation), `view ${rotation}`).toBe(7);
      const front = { x: 24 - behind[rotation].x, y: 24 - behind[rotation].y };
      expect(pickGuest(guests, front, rotation), `view ${rotation} front`).toBeNull();
    }
  });

  it('skips riders, shoppers and guests in a facility (not drawn)', () => {
    for (const state of ['riding', 'shopping', 'usingFacility'] as const) {
      expect(pickGuest([guest(1, 10, 10, state)], { x: 10, y: 10 }, 0)).toBeNull();
    }
  });

  it('reaches no further than the figure: two cells behind misses', () => {
    expect(FIGURE_PICK_REACH).toBeLessThan(1);
    expect(pickGuest([guest(1, 12, 12)], { x: 10, y: 10 }, 0)).toBeNull();
  });
});
