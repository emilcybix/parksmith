import { describe, expect, it } from 'vitest';
import { sceneryNextStepLine } from './themeCopy';

describe('Phase 49: the inspector next scenery step line', () => {
  const next = { objectId: 7, step: { gain: 5.6 }, name: 'Confetti Tree' };
  it('says which piece and how far it lifts the score', () => {
    expect(sceneryNextStepLine(62.4, next, 7)).toBe('Next step: one more Confetti Tree within reach adds about ＋6 (to 68)');
    expect(sceneryNextStepLine(97, next, 7), 'never past the top').toBe('Next step: one more Confetti Tree within reach adds about ＋6 (to 100)');
    expect(sceneryNextStepLine(40, { ...next, step: { gain: 0.6 } }, 7), 'a sliver still reads as one').toMatch(/＋1 \(to 41\)$/);
  });

  it('says a ride is fully decorated when nothing within reach adds more, and nothing at the top or for another object', () => {
    expect(sceneryNextStepLine(38, { objectId: 7, step: null, name: null }, 7)).toBe('Fully decorated for the scenery you have: no free spot within reach lifts it further');
    expect(sceneryNextStepLine(100, next, 7)).toBeNull();
    expect(sceneryNextStepLine(50, next, 8)).toBeNull();
    expect(sceneryNextStepLine(50, null, 7)).toBeNull();
  });
});
