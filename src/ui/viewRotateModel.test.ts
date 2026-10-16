import { describe, expect, it } from 'vitest';
import { VIEW_ROTATIONS } from '../rendering/viewRotation';
import { describeViewRotation } from './viewRotateModel';
import { useUiStore } from './store';

describe('view rotation readout', () => {
  it('turns the compass a quarter turn per view and names each view', () => {
    expect(VIEW_ROTATIONS.map((q) => describeViewRotation(q).compassDegrees)).toEqual([45, 135, 225, 315]);
    expect(VIEW_ROTATIONS.map((q) => describeViewRotation(q).label)).toEqual([
      'Map view 1 of 4', 'Map view 2 of 4', 'Map view 3 of 4', 'Map view 4 of 4',
    ]);
  });

  it('the store starts at view 0', () => {
    expect(useUiStore.getState().viewRotation).toBe(0);
  });
});
