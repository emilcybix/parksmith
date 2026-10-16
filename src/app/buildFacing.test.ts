import { describe, expect, it } from 'vitest';
import { facingOnScreen } from './buildFacing';

describe('Phase 40: where the front points on screen', () => {
  it('view 0: south lower left, east lower right, north upper right, west upper left', () => {
    expect([0, 1, 2, 3].map((rotation) => facingOnScreen(rotation as 0 | 1 | 2 | 3, 0))).toEqual(['lower left', 'lower right', 'upper right', 'upper left']);
  });

  it('a turned view turns the screen direction with it, and the four turns stay distinct in every view', () => {
    for (const view of [0, 1, 2, 3] as const) {
      expect(new Set([0, 1, 2, 3].map((rotation) => facingOnScreen(rotation as 0 | 1 | 2 | 3, view))).size).toBe(4);
    }
    expect(facingOnScreen(0, 1)).not.toBe(facingOnScreen(0, 0));
  });
});
