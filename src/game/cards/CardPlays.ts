import { MAXIMUM_SAVED_AMOUNT } from '../save/ranges';
import type { CardPlaysState } from '../save/state';
import { SaveError } from '../save/version';
import type { TransactionCategory } from '../types';
import { CARD_BY_ID } from './content';
import type { ActiveCardSnapshot, PulseCardDefinition, PulseCardId } from './types';

/**
 * The one-shot ledger of a run park (Phase 25, design 3.1): which one-shot cards this park has played (and when) and the
 * deferred costs they scheduled. Owned by ParkSession in mode `run` only and saved as the park's `plays` key. It never
 * touches the rules, the active cards or the run: a play is undone by rewinding the whole park (snapshot undo), and a
 * cost still pending when the stage resolves becomes the run's debt (RunLevelResult.unpaidDebt).
 */

/**
 * The face of a card as the HUD snapshot shows it (ParkSession.cardsSnapshot): name, copy, kind, rarity and slot cost.
 * Built here so the session never reads a card's rarity itself (cards/rarity.static.test.ts).
 */
export const cardFaceOf = (card: PulseCardDefinition): Pick<ActiveCardSnapshot, 'id' | 'name' | 'icon' | 'upside' | 'downside' | 'kind' | 'rarity' | 'slotCost'> => ({
  id: card.id,
  name: card.name,
  icon: card.icon,
  upside: card.upside,
  downside: card.downside,
  kind: card.kind,
  rarity: card.rarity,
  slotCost: card.slotCost,
});

export type CardPlayRecord = CardPlaysState['played'][number];
export type CardPlaysPending = CardPlaysState['pending'][number];

/** What a restore checks the ledger against (the park's run and world). */
export interface CardPlaysLaws {
  /** The run's loadout (= the park's active cards): every played card is one of its one-shots. */
  loadout: readonly PulseCardId[];
  /** The restored world tick. */
  worldTick: number;
  /**
   * True while the park is the run's live stage: then nothing pending may already be due. A backdrop (the run has moved
   * on) never steps its ledger, so the bound is not needed there.
   */
  liveStage: boolean;
  /** A backdrop: what the run's history recorded for this park's stage. The ledger must say exactly that. */
  settled: { playedCardIds: readonly PulseCardId[]; unpaidDebt: number } | null;
}

export const MAXIMUM_PLAYED = 5;
export const MAXIMUM_PENDING = 8;
export const MAXIMUM_PENDING_LABEL = 80;
/** A deferred cost is due at most this many ticks after the save (a day is 7,200 ticks; a stage is at most 30 days). */
export const MAXIMUM_PENDING_TICKS = 1_000_000;

const PENDING_CATEGORIES: readonly CardPlaysPending['category'][] = ['other', 'maintenance'];

const bad = (path: string, problem: string): never => {
  throw new SaveError('invalid-state', `CardPlays cannot restore: ${path} ${problem}`);
};

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);

const exactKeys = (value: unknown, keys: readonly string[], path: string): Raw => {
  if (!isRecord(value)) return bad(path, 'is not an object');
  for (const key of Object.keys(value)) if (!keys.includes(key)) bad(path, `has the unknown key '${key.slice(0, 40)}'`);
  for (const key of keys) if (!Object.hasOwn(value, key)) bad(path, `is missing '${key}'`);
  return value;
};

const integer = (value: unknown, path: string, minimum: number, maximum: number): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) bad(path, `must be an integer in ${minimum}..${maximum}`);
  return value as number;
};

const isOneShot = (id: PulseCardId): boolean => CARD_BY_ID.get(id)?.kind === 'one-shot';

/** Validates a saved ledger completely (refuse, never normalise) and returns an independent copy. */
export const readCardPlays = (raw: unknown, laws: CardPlaysLaws): CardPlaysState => {
  const state = exactKeys(raw, ['played', 'pending'], 'plays');
  if (!Array.isArray(state.played) || state.played.length > MAXIMUM_PLAYED) bad('plays.played', `must be an array of at most ${MAXIMUM_PLAYED} entries`);
  if (!Array.isArray(state.pending) || state.pending.length > MAXIMUM_PENDING) bad('plays.pending', `must be an array of at most ${MAXIMUM_PENDING} entries`);
  const loadoutOneShots = new Set(laws.loadout.filter(isOneShot));
  const played: CardPlayRecord[] = (state.played as unknown[]).map((entry, index) => {
    const path = `plays.played[${index}]`;
    const record = exactKeys(entry, ['cardId', 'tick'], path);
    const cardId = record.cardId;
    if (typeof cardId !== 'string') return bad(`${path}.cardId`, 'must be a card id');
    if (!CARD_BY_ID.has(cardId as PulseCardId)) {
      throw new SaveError('content-mismatch', `This save uses Pulse Card '${cardId.slice(0, 40)}' (${path}), which this version of the game does not have.`);
    }
    if (!isOneShot(cardId as PulseCardId)) bad(`${path}.cardId`, 'is not a one-shot card');
    if (!loadoutOneShots.has(cardId as PulseCardId)) bad(`${path}.cardId`, "is not in the run's loadout");
    return { cardId: cardId as PulseCardId, tick: integer(record.tick, `${path}.tick`, 0, laws.worldTick) };
  });
  if (new Set(played.map((entry) => entry.cardId)).size !== played.length) bad('plays.played', 'must not play a card twice');
  const playedIds = new Set(played.map((entry) => entry.cardId));
  const earliestDue = laws.liveStage ? laws.worldTick + 1 : 1;
  const pending: CardPlaysPending[] = (state.pending as unknown[]).map((entry, index) => {
    const path = `plays.pending[${index}]`;
    const record = exactKeys(entry, ['cardId', 'dueTick', 'amount', 'label', 'category'], path);
    if (typeof record.cardId !== 'string' || !playedIds.has(record.cardId as PulseCardId)) bad(`${path}.cardId`, 'is not a played card');
    const dueTick = integer(record.dueTick, `${path}.dueTick`, earliestDue, laws.worldTick + MAXIMUM_PENDING_TICKS);
    const amount = integer(record.amount, `${path}.amount`, -MAXIMUM_SAVED_AMOUNT, -1);
    if (typeof record.label !== 'string' || record.label.length === 0 || record.label.length > MAXIMUM_PENDING_LABEL) {
      bad(`${path}.label`, `must be a string of 1..${MAXIMUM_PENDING_LABEL} characters`);
    }
    if (!PENDING_CATEGORIES.includes(record.category as CardPlaysPending['category'])) bad(`${path}.category`, `must be one of ${PENDING_CATEGORIES.join(', ')}`);
    return { cardId: record.cardId as PulseCardId, dueTick, amount, label: record.label as string, category: record.category as CardPlaysPending['category'] };
  });
  pending.forEach((entry, index) => {
    if (index > 0 && entry.dueTick < pending[index - 1].dueTick) bad('plays.pending', 'is not in ascending dueTick order');
  });
  if (laws.settled !== null) {
    const expected = new Set(laws.settled.playedCardIds);
    if (expected.size !== playedIds.size || [...playedIds].some((id) => !expected.has(id))) {
      bad('plays.played', "differs from the cards the run's history says this stage played");
    }
    const unpaid = pending.reduce((sum, entry) => sum - entry.amount, 0);
    if (unpaid !== laws.settled.unpaidDebt) bad('plays.pending', "differs from the debt the run's history says this stage left");
  }
  return { played, pending };
};

export class CardPlays {
  private played: CardPlayRecord[] = [];
  private pending: CardPlaysPending[] = [];

  /** Records a play (the caller has checked it is legal). */
  record(cardId: PulseCardId, tick: number): void {
    this.played.push({ cardId, tick });
  }

  /** Schedules a deferred cost, keeping `pending` ascending by (dueTick, insertion). */
  schedule(entry: CardPlaysPending): void {
    let index = this.pending.length;
    while (index > 0 && this.pending[index - 1].dueTick > entry.dueTick) index -= 1;
    this.pending.splice(index, 0, { ...entry });
  }

  /** Applies every cost due at `tick` (in order) through the world's ledger. Called right after the world's tick advanced. */
  step(tick: number, world: { postTransaction(amount: number, label: string, category: TransactionCategory): void }): void {
    while (this.pending.length > 0 && this.pending[0].dueTick <= tick) {
      const entry = this.pending.shift()!;
      world.postTransaction(entry.amount, entry.label, entry.category);
    }
  }

  /** The played cards in `order` (the caller's canonical order, the run's loadout). */
  playedIds(order: readonly PulseCardId[]): PulseCardId[] {
    const ids = new Set(this.played.map((entry) => entry.cardId));
    return order.filter((id) => ids.has(id));
  }

  hasPlayed(cardId: PulseCardId): boolean {
    return this.played.some((entry) => entry.cardId === cardId);
  }

  /** The tick a card was played at, or null. */
  playedTick(cardId: PulseCardId): number | null {
    return this.played.find((entry) => entry.cardId === cardId)?.tick ?? null;
  }

  /** The first cost a card still has pending, or null. */
  pendingOf(cardId: PulseCardId): CardPlaysPending | null {
    const entry = this.pending.find((candidate) => candidate.cardId === cardId);
    return entry ? { ...entry } : null;
  }

  /** What is still owed (integer dollars >= 0). */
  unpaidTotal(): number {
    return this.pending.reduce((sum, entry) => sum - entry.amount, 0);
  }

  serialize(): CardPlaysState {
    return {
      played: this.played.map((entry) => ({ cardId: entry.cardId, tick: entry.tick })),
      pending: this.pending.map((entry) => ({
        cardId: entry.cardId, dueTick: entry.dueTick, amount: entry.amount, label: entry.label, category: entry.category,
      })),
    };
  }

  /** Validates `state` against `laws` before changing anything (SaveError), then replaces the ledger. */
  restore(state: CardPlaysState, laws: CardPlaysLaws): void {
    const read = readCardPlays(state, laws);
    this.played = read.played;
    this.pending = read.pending;
  }
}
