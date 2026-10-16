import { describe, expect, it } from 'vitest';
import { SaveError } from '../save/version';
import type { CardPlaysState } from '../save/state';
import { CardPlays, readCardPlays, type CardPlaysLaws } from './CardPlays';
import type { PulseCardId } from './types';

/** Phase 25 (design 3.1): the one-shot ledger's round trip, its restore laws and the order in which costs fall due. */
const LOAN: PulseCardId = 'bridging-loan';
const COACH: PulseCardId = 'coach-party';
const LAWS: CardPlaysLaws = { loadout: ['hungry-tourists', LOAN, COACH], worldTick: 1_000, liveStage: true, settled: null };

const filled = (): CardPlays => {
  const plays = new CardPlays();
  plays.record(LOAN, 100);
  plays.schedule({ cardId: LOAN, dueTick: 2_500, amount: -2_400, label: 'Bridging Loan repaid', category: 'other' });
  plays.record(COACH, 400);
  plays.schedule({ cardId: COACH, dueTick: 1_000 + 600, amount: -900, label: 'Coach Party bill', category: 'other' });
  return plays;
};

const refusal = (state: unknown, laws: CardPlaysLaws = LAWS): string | null => {
  try {
    readCardPlays(state, laws);
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(SaveError);
    return (error as SaveError).code;
  }
};

describe('CardPlays', () => {
  it('round-trips through serialize and restore, deep-copied, byte for byte', () => {
    const plays = filled();
    const state = plays.serialize();
    expect(state.pending.map((entry) => entry.dueTick)).toEqual([1_600, 2_500]);
    const twin = new CardPlays();
    twin.restore(JSON.parse(JSON.stringify(state)) as CardPlaysState, LAWS);
    expect(JSON.stringify(twin.serialize())).toBe(JSON.stringify(state));
    state.played[0].tick = 7;
    expect(plays.serialize().played[0].tick, 'serialize does not alias').toBe(100);
    expect(twin.unpaidTotal()).toBe(3_300);
    expect(twin.playedIds(['hungry-tourists', COACH, LOAN])).toEqual([COACH, LOAN]);
    expect(twin.hasPlayed(LOAN)).toBe(true);
    expect(twin.hasPlayed('hungry-tourists')).toBe(false);
    expect(twin.playedTick(COACH)).toBe(400);
    expect(twin.pendingOf(LOAN)).toMatchObject({ amount: -2_400 });
    expect(twin.pendingOf('hungry-tourists')).toBeNull();
  });

  it('applies due costs in (dueTick, insertion) order, once, through postTransaction', () => {
    const plays = new CardPlays();
    plays.record(LOAN, 0);
    plays.record(COACH, 0);
    plays.schedule({ cardId: LOAN, dueTick: 20, amount: -3, label: 'c', category: 'other' });
    plays.schedule({ cardId: COACH, dueTick: 10, amount: -1, label: 'a', category: 'maintenance' });
    plays.schedule({ cardId: LOAN, dueTick: 10, amount: -2, label: 'b', category: 'other' });
    const posted: string[] = [];
    const world = { postTransaction: (amount: number, label: string, category: string) => { posted.push(`${label}${amount}${category}`); } };
    plays.step(9, world);
    expect(posted).toEqual([]);
    plays.step(10, world);
    expect(posted).toEqual(['a-1maintenance', 'b-2other']);
    plays.step(10, world);
    expect(posted).toHaveLength(2);
    plays.step(50, world);
    expect(posted).toEqual(['a-1maintenance', 'b-2other', 'c-3other']);
    expect(plays.unpaidTotal()).toBe(0);
  });

  it('a backdrop ledger must say exactly what the history settled, and may hold costs past their tick', () => {
    const state = filled().serialize();
    const backdrop = (playedCardIds: PulseCardId[], unpaidDebt: number): CardPlaysLaws => ({ ...LAWS, worldTick: 5_000, liveStage: false, settled: { playedCardIds, unpaidDebt } });
    expect(refusal(state, backdrop([LOAN, COACH], 3_300))).toBeNull();
    expect(refusal(state, backdrop([COACH, LOAN], 3_300)), 'a set, any order').toBeNull();
    expect(refusal(state, backdrop([LOAN], 3_300))).toBe('invalid-state');
    expect(refusal(state, backdrop([LOAN, COACH], 2_400))).toBe('invalid-state');
    expect(refusal(state, { ...LAWS, worldTick: 5_000 }), 'a live stage never holds a due cost').toBe('invalid-state');
  });

  it.each<[string, (state: Record<string, any>) => void, string]>([
    ['not an object', (s) => { s.played = null; }, 'invalid-state'],
    ['an extra key', (s) => { s.extra = 1; }, 'invalid-state'],
    ['a missing pending', (s) => { delete s.pending; }, 'invalid-state'],
    ['a stage card played', (s) => { s.played.push({ cardId: 'hungry-tourists', tick: 1 }); }, 'invalid-state'],
    ['a one-shot outside the loadout', (s) => { s.played.push({ cardId: 'sweep-the-park', tick: 1 }); }, 'invalid-state'],
    ['an unknown card', (s) => { s.played[0].cardId = 'loaded-dice'; }, 'content-mismatch'],
    ['a duplicate play', (s) => { s.played[1].cardId = LOAN; s.pending[0].cardId = LOAN; }, 'invalid-state'],
    ['a play after the world tick', (s) => { s.played[0].tick = 1_001; }, 'invalid-state'],
    ['a negative play tick', (s) => { s.played[0].tick = -1; }, 'invalid-state'],
    ['a cost due now', (s) => { s.pending[0].dueTick = 1_000; }, 'invalid-state'],
    ['a positive amount', (s) => { s.pending[0].amount = 900; }, 'invalid-state'],
    ['a fractional amount', (s) => { s.pending[0].amount = -0.5; }, 'invalid-state'],
    ['an Infinity amount', (s) => { s.pending[0].amount = -Infinity; }, 'invalid-state'],
    ['an 81-character label', (s) => { s.pending[0].label = 'x'.repeat(81); }, 'invalid-state'],
    ['a label that is not a string', (s) => { s.pending[0].label = 5; }, 'invalid-state'],
    ['a grant category', (s) => { s.pending[0].category = 'grant'; }, 'invalid-state'],
    ['out of order', (s) => { s.pending.reverse(); }, 'invalid-state'],
    ['a cost of a card not played', (s) => { s.played.pop(); }, 'invalid-state'],
  ])('refuses %s', (_name, edit, code) => {
    const state = JSON.parse(JSON.stringify(filled().serialize())) as Record<string, any>;
    edit(state);
    expect(refusal(state)).toBe(code);
  });

  it('a refused restore leaves the ledger untouched', () => {
    const plays = filled();
    const before = JSON.stringify(plays.serialize());
    expect(() => plays.restore({ played: [{ cardId: 'hungry-tourists', tick: 1 }], pending: [] } as CardPlaysState, LAWS)).toThrow(SaveError);
    expect(JSON.stringify(plays.serialize())).toBe(before);
  });
});
