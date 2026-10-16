import { describe, expect, it } from 'vitest';
import { assessParkStall, type StallInputs } from './parkStall';

/**
 * The false cases matter more than the true one here. A detector that cries deadlock at a park
 * that is simply young and poor is worse than no detector, because the player learns to ignore it.
 */
const healthy: StallInputs = {
  cash: 930,
  pathCost: 12,
  cheapestRideCost: 900,
  guestCount: 0,
  reachableRides: 0,
  unreachableRides: 0,
  reachableServices: 0,
  dismissableStaff: 0,
  staffWageBill: 0,
  demolitionValue: 0,
};

const inputs = (overrides: Partial<StallInputs>): StallInputs => ({ ...healthy, ...overrides });

describe('park stall detection', () => {
  it('does not fire on a young park that can still afford a ride', () => {
    // Minute one: $5,000, nothing built. Poor and idle is not the same as stuck.
    expect(assessParkStall(inputs({ cash: 5_000 })).stalled).toBe(false);
  });

  it('does not fire on three closed rides just before opening', () => {
    // The case the naive "no open ride and cash below a ride" rule got wrong: it is minute four,
    // and opening what is already built costs nothing.
    const assessment = assessParkStall(inputs({ cash: 930, reachableRides: 3 }));
    expect(assessment.stalled).toBe(false);
  });

  it('does not fire while a stranded ride can still be connected for a tile', () => {
    expect(assessParkStall(inputs({ cash: 40, unreachableRides: 1 })).stalled).toBe(false);
    // Below the price of a single path tile, connecting it is no longer an option.
    expect(assessParkStall(inputs({ cash: 5, unreachableRides: 1 })).stalled).toBe(true);
  });

  it('does not fire while a service can still earn from the crowd already inside', () => {
    expect(assessParkStall(inputs({ cash: 0, reachableServices: 1, guestCount: 14 })).stalled)
      .toBe(false);
    // Once they have gone home, a stall cannot bring anybody back on its own.
    expect(assessParkStall(inputs({ cash: 0, reachableServices: 1, guestCount: 0 })).stalled)
      .toBe(true);
  });

  it('fires when no ride can earn and nothing on hand can change that', () => {
    const assessment = assessParkStall(inputs({ cash: -500 }));
    expect(assessment.stalled).toBe(true);
    expect(assessment.exits).toEqual([]);
    expect(assessment.message).toContain('cannot recover');
    expect(assessment.message).toContain('Parks menu');
  });

  it('names dismissing staff as a way to stop the bleeding', () => {
    const assessment = assessParkStall(inputs({ cash: -200, dismissableStaff: 3, staffWageBill: 42 }));
    expect(assessment.stalled).toBe(true);
    expect(assessment.message).toContain('dismiss your 3 staff');
    expect(assessment.message).toContain('$42');
    expect(assessment.message).not.toContain('cannot recover');
  });

  it('names demolition only when it would actually buy a ride', () => {
    const enough = assessParkStall(inputs({ cash: 100, demolitionValue: 1_200 }));
    expect(enough.message).toContain('demolish');
    expect(enough.message).toContain('$1,200');

    const notEnough = assessParkStall(inputs({ cash: 100, demolitionValue: 300 }));
    expect(notEnough.stalled).toBe(true);
    expect(notEnough.message).not.toContain('demolish');
  });

  it('lists every exit it found, not just the first', () => {
    const assessment = assessParkStall(inputs({
      cash: -50,
      dismissableStaff: 2,
      staffWageBill: 30,
      demolitionValue: 2_000,
    }));
    expect(assessment.exits).toHaveLength(2);
    expect(assessment.message).toContain('dismiss');
    expect(assessment.message).toContain('demolish');
  });

  it('says nothing at all when the park is fine', () => {
    const assessment = assessParkStall(inputs({ cash: 10_000, reachableRides: 4, guestCount: 60 }));
    expect(assessment).toEqual({ stalled: false, exits: [], message: '' });
  });
});
