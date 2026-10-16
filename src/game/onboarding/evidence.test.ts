import { describe, expect, it } from 'vitest';
import { ARRIVAL_TARGET, LITTER_SEEN_UNITS, ONBOARDING_STEPS, PATH_TILE_TARGET, PROFIT_TARGET, RATING_MIN_ARRIVALS, RATING_TARGET } from './content';
import { EVIDENCE, observeFlags } from './evidence';
import { freshInput, rideInput, serviceInput } from './testInput';
import type { OnboardingFlags, OnboardingInput, OnboardingStepId } from './types';

const noFlags = (): OnboardingFlags => ({ sawLitter: false });
const evaluate = (id: OnboardingStepId, input: OnboardingInput, flags: OnboardingFlags = noFlags()): number | null => (
  EVIDENCE[id](input, flags)
);

describe('evidence catalog', () => {
  it('has exactly one evidence function per step, and none is true on a fresh park', () => {
    expect(Object.keys(EVIDENCE).sort()).toEqual(ONBOARDING_STEPS.map((step) => step.id).sort());
    for (const step of ONBOARDING_STEPS) {
      expect(evaluate(step.id, freshInput()), `${step.id} must not be complete at creation`).toBeNull();
    }
  });

  it('is pure: the same input gives the same answer and the input is never mutated', () => {
    const input = freshInput({ connectedPathTiles: 9, rides: [rideInput({ satisfactionCount: 3 })], totalArrivals: 70 });
    const frozen = JSON.stringify(input);
    for (const step of ONBOARDING_STEPS) expect(evaluate(step.id, input)).toEqual(evaluate(step.id, input));
    expect(JSON.stringify(input)).toBe(frozen);
  });

  it('every step has a distinct title, a hint and a label for its evidence', () => {
    expect(new Set(ONBOARDING_STEPS.map((step) => step.title)).size).toBe(ONBOARDING_STEPS.length);
    for (const step of ONBOARDING_STEPS) {
      expect(step.hint.length, step.id).toBeGreaterThan(5);
      expect(step.evidenceLabel(1).length, step.id).toBeGreaterThan(3);
    }
  });
});

describe('lay-path', () => {
  it('flips at the boundary and reports the tile count', () => {
    expect(evaluate('lay-path', freshInput({ connectedPathTiles: PATH_TILE_TARGET - 1 }))).toBeNull();
    expect(evaluate('lay-path', freshInput({ connectedPathTiles: PATH_TILE_TARGET }))).toBe(PATH_TILE_TARGET);
    expect(evaluate('lay-path', freshInput({ connectedPathTiles: 40 }))).toBe(40);
  });
});

describe('first-ride', () => {
  it('needs a ride whose access side touches the connected path', () => {
    expect(evaluate('first-ride', freshInput({ rides: [rideInput({ connected: false })] })), 'a ride off the path').toBeNull();
    expect(evaluate('first-ride', freshInput({ rides: [rideInput({ connected: true })] }))).toBe(1);
    expect(evaluate('first-ride', freshInput({ rides: [rideInput({ connected: false }), rideInput({ objectId: 5 })] })), 'one is enough').toBe(1);
  });

  it('is unaffected by anything about the ride being open: the input has no such field', () => {
    expect('open' in rideInput(), 'rides carry no open flag').toBe(false);
    expect('status' in rideInput()).toBe(false);
  });

  it('a demolished ride (absent from the input) leaves a pending step pending', () => {
    expect(evaluate('first-ride', freshInput({ rides: [] }))).toBeNull();
  });
});

describe('set-price', () => {
  it('a ride at its default price does not count; a deliberate change does', () => {
    expect(evaluate('set-price', freshInput({ rides: [rideInput()] }))).toBeNull();
    expect(evaluate('set-price', freshInput({ rides: [rideInput({ ticketPrice: 4.5 })] })), 'the evidence is the new price').toBe(4.5);
    expect(evaluate('set-price', freshInput({ rides: [rideInput({ ticketPrice: 2 })] })), 'cheaper counts too').toBe(2);
  });

  it('is found on any ride, not only the first', () => {
    const rides = [rideInput({ objectId: 1 }), rideInput({ objectId: 2, ticketPrice: 7 })];
    expect(evaluate('set-price', freshInput({ rides }))).toBe(7);
  });

  it('a price changed and then put back reads as unchanged here (the tracker is what keeps it done)', () => {
    expect(evaluate('set-price', freshInput({ rides: [rideInput({ ticketPrice: 4 })] }))).toBeNull();
  });

  it('is independent of the ride being connected or closed', () => {
    expect(evaluate('set-price', freshInput({ rides: [rideInput({ connected: false, ticketPrice: 6 })] }))).toBe(6);
  });
});

describe('first-rider', () => {
  it('needs one finished ride cycle with a rider, summed over live rides', () => {
    expect(evaluate('first-rider', freshInput({ rides: [rideInput({ satisfactionCount: 0 })] }))).toBeNull();
    expect(evaluate('first-rider', freshInput({ rides: [rideInput({ satisfactionCount: 1 })] }))).toBe(1);
    expect(evaluate('first-rider', freshInput({ rides: [rideInput({ satisfactionCount: 2 }), rideInput({ objectId: 3, satisfactionCount: 5 })] }))).toBe(7);
  });

  it('a closed ride keeps its completions, a demolished one drops out of the sum', () => {
    expect(evaluate('first-rider', freshInput({ rides: [rideInput({ satisfactionCount: 4 })] })), 'closed rides are still in the input').toBe(4);
    expect(evaluate('first-rider', freshInput({ rides: [] })), 'demolished: nothing to sum').toBeNull();
  });
});

describe('first-food and first-drink', () => {
  it('count only connected stalls of the right kind', () => {
    const food = serviceInput({ objectId: 10, kind: 'food' });
    const drink = serviceInput({ objectId: 11, kind: 'drink' });
    const toilet = serviceInput({ objectId: 12, kind: 'toilet' });
    expect(evaluate('first-food', freshInput({ services: [drink, toilet] }))).toBeNull();
    expect(evaluate('first-food', freshInput({ services: [food, drink] }))).toBe(1);
    expect(evaluate('first-drink', freshInput({ services: [food, toilet] }))).toBeNull();
    expect(evaluate('first-drink', freshInput({ services: [food, drink] }))).toBe(1);
  });

  it('a stall not touching the connected path does not count', () => {
    const stray = serviceInput({ kind: 'food', connected: false });
    expect(evaluate('first-food', freshInput({ services: [stray] }))).toBeNull();
    const stray2 = serviceInput({ kind: 'drink', connected: false });
    expect(evaluate('first-drink', freshInput({ services: [stray2] }))).toBeNull();
  });

  it('two food stalls are reported as two; a demolished stall is simply absent', () => {
    expect(evaluate('first-food', freshInput({ services: [serviceInput({ objectId: 1 }), serviceInput({ objectId: 2 })] }))).toBe(2);
    expect(evaluate('first-food', freshInput({ services: [] }))).toBeNull();
  });
});

describe('guest-target', () => {
  it('flips at 50 cumulative arrivals', () => {
    expect(evaluate('guest-target', freshInput({ totalArrivals: ARRIVAL_TARGET - 1 }))).toBeNull();
    expect(evaluate('guest-target', freshInput({ totalArrivals: ARRIVAL_TARGET }))).toBe(ARRIVAL_TARGET);
  });

  it('does not read the guests currently inside, so guests leaving cannot undo it', () => {
    expect(evaluate('guest-target', freshInput({ totalArrivals: 80 }))).toBe(80);
  });
});

describe('first-profit', () => {
  it('flips at the $100 floor, with fractional boundaries', () => {
    expect(evaluate('first-profit', freshInput({ operatingProfit: PROFIT_TARGET - 0.01 }))).toBeNull();
    expect(evaluate('first-profit', freshInput({ operatingProfit: PROFIT_TARGET }))).toBe(PROFIT_TARGET);
    expect(evaluate('first-profit', freshInput({ operatingProfit: -50 })), 'a loss is not a profit').toBeNull();
  });
});

describe('fix-problem', () => {
  it('a completed repair is enough on its own', () => {
    expect(evaluate('fix-problem', freshInput({ rides: [rideInput({ repairsCompleted: 1 })] }))).toBe(1);
    expect(evaluate('fix-problem', freshInput({ rides: [rideInput({ repairsCompleted: 2 }), rideInput({ objectId: 4, repairsCompleted: 1 })] }))).toBe(3);
  });

  it('a mechanic hired but no repair yet is not enough', () => {
    expect(evaluate('fix-problem', freshInput({ rides: [rideInput({ repairsCompleted: 0 })] }))).toBeNull();
  });

  it('litter branch: seen, a cleaner employed, and the park clean again', () => {
    expect(evaluate('fix-problem', freshInput({ cleaners: 1, litterUnits: 0 }), { sawLitter: true }), 'seen + cleaner + zero').toBe(0);
  });

  it('litter branch: never seen is not enough (a clean park with a new cleaner proves nothing)', () => {
    expect(evaluate('fix-problem', freshInput({ cleaners: 1, litterUnits: 0 }), { sawLitter: false })).toBeNull();
  });

  it('litter branch: a cleaner is employed but litter is still on the paths', () => {
    expect(evaluate('fix-problem', freshInput({ cleaners: 1, litterUnits: 2 }), { sawLitter: true })).toBeNull();
  });

  it('litter branch: the litter is gone but nobody was hired (it was swept up some other way)', () => {
    expect(evaluate('fix-problem', freshInput({ cleaners: 0, litterUnits: 0 }), { sawLitter: true })).toBeNull();
  });

  it('a repair counts even when the ride is now closed or the litter is back', () => {
    expect(evaluate('fix-problem', freshInput({ litterUnits: 9, rides: [rideInput({ repairsCompleted: 1 })] }), noFlags())).toBe(1);
  });
});

describe('good-rating', () => {
  it('flips at the target once enough guests have visited', () => {
    const base = { totalArrivals: RATING_MIN_ARRIVALS };
    expect(evaluate('good-rating', freshInput({ ...base, parkRating: RATING_TARGET - 0.1 }))).toBeNull();
    expect(evaluate('good-rating', freshInput({ ...base, parkRating: RATING_TARGET }))).toBe(RATING_TARGET);
  });

  it('ignores a high default rating before guests have formed an opinion', () => {
    expect(evaluate('good-rating', freshInput({ totalArrivals: RATING_MIN_ARRIVALS - 1, parkRating: 100 }))).toBeNull();
    expect(evaluate('good-rating', freshInput({ totalArrivals: 0, parkRating: 95 }))).toBeNull();
  });
});

describe('observeFlags', () => {
  it('latches litter at the threshold and never clears it', () => {
    const flags = noFlags();
    observeFlags(flags, freshInput({ litterUnits: LITTER_SEEN_UNITS - 1 }));
    expect(flags.sawLitter, 'below the threshold').toBe(false);
    observeFlags(flags, freshInput({ litterUnits: LITTER_SEEN_UNITS }));
    expect(flags.sawLitter, 'at the threshold').toBe(true);
    observeFlags(flags, freshInput({ litterUnits: 0 }));
    expect(flags.sawLitter, 'cleaned up: still seen').toBe(true);
  });
});
