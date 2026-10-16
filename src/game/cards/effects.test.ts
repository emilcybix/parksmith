import { describe, expect, it } from 'vitest';
import { CARD_BY_ID } from './content';
import { applyOneShot, canPlay, costNowOf, type OneShotHost } from './effects';
import type { OneShotEffect, PulseCardId } from './types';

/**
 * Phase 25 (design 2.3): each one-shot calls exactly its owner methods and posts exactly its transactions, against a fake
 * structural host; canPlay refuses with the HUD's hints.
 */
interface FakeState {
  running: boolean;
  cash: number;
  tick: number;
  broken: number;
  serviceable: number;
  litter: number;
  bins: number;
  guests: number;
  maximum: number;
  researchCostScale: number;
}

const fakeHost = (overrides: Partial<FakeState> = {}) => {
  const state: FakeState = { running: true, cash: 10_000, tick: 3_000, broken: 2, serviceable: 3, litter: 5, bins: 1, guests: 40, maximum: 500, researchCostScale: 1, ...overrides };
  const calls: string[] = [];
  const transactions: Array<{ amount: number; label: string; category: string }> = [];
  const host: OneShotHost = {
    levelRunning: () => state.running,
    cash: () => state.cash,
    tick: () => state.tick,
    postTransaction: (amount, label, category) => {
      transactions.push({ amount, label, category });
      state.cash += amount;
    },
    grantResearchPoints: (points) => { calls.push(`grantResearchPoints(${points})`); return points; },
    researchCostScale: () => state.researchCostScale,
    brokenRideCount: () => state.broken,
    serviceableRideCount: () => state.serviceable,
    repairBroken: () => { calls.push('repairBroken'); return Array.from({ length: state.broken }, (_, index) => index + 1); },
    serviceAll: () => { calls.push('serviceAll'); return Array.from({ length: state.serviceable }, (_, index) => index + 1); },
    litterCount: () => state.litter,
    usedBinCount: () => state.bins,
    sweepLitter: () => { calls.push('sweepLitter'); return state.litter; },
    emptyBins: () => { calls.push('emptyBins'); return state.bins; },
    rewriteForecast: (kind, count, intensity) => { calls.push(`rewriteForecast(${kind},${count},${intensity})`); return count; },
    guestCount: () => state.guests,
    guestMaximum: () => state.maximum,
    spawnGuests: (count) => { calls.push(`spawnGuests(${count})`); return count; },
    adjustHappiness: (delta) => { calls.push(`adjustHappiness(${delta})`); return state.guests; },
  };
  return { host, calls, transactions, state };
};

const play = (id: PulseCardId, overrides: Partial<FakeState> = {}) => {
  const card = CARD_BY_ID.get(id)!;
  if (card.kind !== 'one-shot') throw new Error(id);
  const fake = fakeHost(overrides);
  const outcome = applyOneShot(card.effect, fake.host, card.name);
  return { ...fake, outcome };
};

describe('one-shot effects against a fake host', () => {
  it('loans: cash now as a grant, the repayment deferred as "other" (240 s = 2,400 ticks)', () => {
    const { calls, transactions, outcome } = play('bridging-loan');
    expect(calls).toEqual([]);
    expect(transactions).toEqual([{ amount: 2_000, label: 'Bridging Loan cash', category: 'grant' }]);
    expect(outcome.deferred).toEqual({ amount: -2_400, dueTick: 3_000 + 2_400, label: 'Bridging Loan repaid', category: 'other' });
    expect(outcome.summary).toBe('+$2,000 now · $2,400 due in 4:00');
    expect(play('big-loan').outcome.deferred).toEqual({ amount: -6_250, dueTick: 6_000, label: 'Big Loan repaid', category: 'other' });
  });

  it('research: points through the progression owner, the fee in "research"', () => {
    const { calls, transactions, outcome } = play('research-grant');
    expect(calls).toEqual(['grantResearchPoints(20)']);
    expect(transactions).toEqual([{ amount: -700, label: 'Research Grant fee', category: 'research' }]);
    expect(outcome.deferred).toBeNull();
  });

  it('research (Phase 16): the base points are granted at the park\'s research cost scale; the fee is unscaled', () => {
    const { calls, transactions, outcome } = play('research-grant', { researchCostScale: 10 });
    expect(calls).toEqual(['grantResearchPoints(200)']);
    expect(transactions).toEqual([{ amount: -700, label: 'Research Grant fee', category: 'research' }]);
    expect(outcome.summary).toBe('+200 research points · -$700');
  });

  it('repair broken: every broken ride repaired now, $250 a ride billed 90 s later in "maintenance"', () => {
    const { calls, transactions, outcome } = play('repair-crew', { broken: 3 });
    expect(calls).toEqual(['repairBroken']);
    expect(transactions).toEqual([]);
    expect(outcome.deferred).toEqual({ amount: -750, dueTick: 3_900, label: 'Repair Crew repairs', category: 'maintenance' });
    expect(outcome.summary).toBe('3 rides repaired · $750 due in 1:30');
  });

  it('repair all: every eligible ride serviced, $150 a ride now in "maintenance"', () => {
    const { calls, transactions, outcome } = play('inspection-day', { serviceable: 4 });
    expect(calls).toEqual(['serviceAll']);
    expect(transactions).toEqual([{ amount: -600, label: 'Inspection Day repairs', category: 'maintenance' }]);
    expect(outcome.deferred).toBeNull();
  });

  it('sweep: litter and bins through the operations owner, wages in "staff-salaries"', () => {
    const { calls, transactions } = play('sweep-the-park');
    expect(calls).toEqual(['sweepLitter', 'emptyBins']);
    expect(transactions).toEqual([{ amount: -400, label: 'Sweep crew wages', category: 'staff-salaries' }]);
  });

  it('forecast: four sunny slots at 0.7, the fee in "other"', () => {
    const { calls, transactions } = play('clear-skies');
    expect(calls).toEqual(['rewriteForecast(sunny,4,0.7)']);
    expect(transactions).toEqual([{ amount: -600, label: 'Clear Skies fee', category: 'other' }]);
  });

  it('surge: twenty guests now, a $900 bill deferred 60 s', () => {
    const { calls, transactions, outcome } = play('coach-party');
    expect(calls).toEqual(['spawnGuests(20)']);
    expect(transactions).toEqual([]);
    expect(outcome.deferred).toEqual({ amount: -900, dueTick: 3_600, label: 'Coach Party bill', category: 'other' });
  });

  it('cheer: happiness by the sign, a positive fee costs ("other"), a negative fee pays ("grant")', () => {
    const fireworks = play('fireworks-night');
    expect(fireworks.calls).toEqual(['adjustHappiness(12)']);
    expect(fireworks.transactions).toEqual([{ amount: -1_200, label: 'Fireworks Night costs', category: 'other' }]);
    const sponsor = play('sponsor-banner');
    expect(sponsor.calls).toEqual(['adjustHappiness(-8)']);
    expect(sponsor.transactions).toEqual([{ amount: 1_500, label: 'Sponsor Banner cash', category: 'grant' }]);
    expect(play('bloom-festival').transactions).toEqual([{ amount: -600, label: 'Bloom Festival costs', category: 'other' }]);
  });
});

describe('canPlay refusals', () => {
  const effectOf = (id: PulseCardId): OneShotEffect => {
    const card = CARD_BY_ID.get(id)!;
    if (card.kind !== 'one-shot') throw new Error(id);
    return card.effect;
  };
  const hint = (id: PulseCardId, overrides: Partial<FakeState>): string | null => {
    const result = canPlay(effectOf(id), fakeHost(overrides).host);
    return result.ok ? null : result.hint;
  };

  it('refuses every card once the level is over', () => {
    for (const id of ['bridging-loan', 'coach-party', 'sweep-the-park', 'fireworks-night'] as const) expect(hint(id, { running: false })).toBe('The level is over');
  });

  it('refuses with the reason the effect cannot happen', () => {
    expect(hint('repair-crew', { broken: 0 })).toBe('No ride is broken');
    expect(hint('inspection-day', { serviceable: 0 })).toBe('Every ride is in top shape');
    expect(hint('sweep-the-park', { litter: 0, bins: 0 })).toBe('The park is clean');
    expect(hint('sweep-the-park', { litter: 0, bins: 2 })).toBeNull();
    expect(hint('coach-party', { guests: 500, maximum: 500 })).toBe('The park is full');
    expect(hint('fireworks-night', { guests: 0 })).toBe('No guests yet');
    expect(hint('sponsor-banner', { guests: 0 })).toBe('No guests yet');
  });

  it('refuses a cost paid now that the cash cannot cover, and never refuses a deferred or paying card for cash', () => {
    expect(hint('clear-skies', { cash: 599 })).toBe('Not enough cash ($600)');
    expect(hint('clear-skies', { cash: 600 })).toBeNull();
    expect(hint('inspection-day', { cash: 449, serviceable: 3 })).toBe('Not enough cash ($450)');
    expect(costNowOf(effectOf('inspection-day'), fakeHost({ serviceable: 3 }).host)).toBe(450);
    for (const id of ['bridging-loan', 'coach-party', 'repair-crew', 'sponsor-banner'] as const) expect(hint(id, { cash: 0 }), id).toBeNull();
  });

  it('applyOneShot throws when canPlay refuses (the session checks first)', () => {
    expect(() => applyOneShot(effectOf('repair-crew'), fakeHost({ broken: 0 }).host, 'Repair Crew')).toThrow(RangeError);
  });
});
