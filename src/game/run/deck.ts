import { PULSE_CARDS, CARD_BY_ID, slotCostTotal } from '../cards/content';
import { GAME_CONFIG } from '../config';
import type { PulseCardId } from '../cards/types';
import { compileBonusLayer } from '../profile/bonuses';
import { normaliseGatedIds } from '../profile/unlocks';
import { hashState } from '../save/hash';
import { MAXIMUM_SAVED_AMOUNT, MAXIMUM_SAVED_SECONDS } from '../save/ranges';
import type { ParkGrantState } from '../save/state';
import { acceptedRecipeOf, planRun } from './plan';
import {
  RUN_FORMAT_VERSION, type RunLevelResult, type RunPlanInput, type RunState, type RunStep, type RunSummary, type RunUsedCard,
} from './types';

/**
 * The deck and the run's state machine (Phase 23). Every transition returns a NEW state or a typed refusal; none mutates
 * its input and none throws on player input. See ARCHITECTURE.md, The Map (runs), for the phase diagram.
 */

const CARD_ORDER: ReadonlyMap<PulseCardId, number> = new Map(PULSE_CARDS.map((card, index) => [card.id, index]));

/** Canonical deck order: PULSE_CARDS order, copies adjacent (stable). */
export const sortDeck = (ids: readonly PulseCardId[]): PulseCardId[] => (
  [...ids].sort((left, right) => (CARD_ORDER.get(left) ?? 0) - (CARD_ORDER.get(right) ?? 0))
);

export const deckCounts = (deck: readonly PulseCardId[]): Array<{ cardId: PulseCardId; count: number }> => {
  const counts = new Map<PulseCardId, number>();
  for (const id of deck) counts.set(id, (counts.get(id) ?? 0) + 1);
  return PULSE_CARDS.filter((card) => counts.has(card.id)).map((card) => ({ cardId: card.id, count: counts.get(card.id) ?? 0 }));
};

/** A grant as a run holds it: gated ids in catalog order, bonuses that apply in mode `run`, canonical order. */
export const runGrantOf = (grant: { readonly unlockedBuildingIds: readonly string[]; readonly bonusIds: readonly string[] }): ParkGrantState => ({
  unlockedBuildingIds: normaliseGatedIds(grant.unlockedBuildingIds),
  bonusIds: [...compileBonusLayer(grant.bonusIds, 'run', 0).appliedBonusIds],
});

/** Base slots plus the grant's Spare card slot, for a 0-based level (default: the current one). */
export const slotsOf = (run: RunState, levelIndex: number = run.levelIndex): number => {
  const level = run.levels[levelIndex];
  if (!level) return 0;
  return level.slots + compileBonusLayer(run.grant.bonusIds, 'run', 0).extraCardSlots;
};

/** Plan plus the accepted map of every level, at phase `offer` of level 1 with the starter deck. */
export const createRun = (input: RunPlanInput & { grant: { readonly unlockedBuildingIds: readonly string[]; readonly bonusIds: readonly string[] } }): RunState => {
  const plan = planRun(input);
  const levels = plan.levels.map((planned) => {
    const { density: _density, ...level } = planned;
    void _density;
    return { ...level, recipe: acceptedRecipeOf(plan.seed, planned).recipe };
  });
  return {
    version: RUN_FORMAT_VERSION,
    planVersion: plan.planVersion,
    seed: plan.seed,
    difficulty: plan.difficulty,
    consumeAt: plan.consumeAt,
    offerRule: { ...plan.offerRule },
    unplayedOneShots: GAME_CONFIG.run.unplayedOneShots,
    grant: runGrantOf(input.grant),
    levels,
    starterDeck: [...plan.starterDeck],
    levelIndex: 0,
    parkLevelIndex: 0,
    phase: 'offer',
    deck: [...plan.starterDeck],
    usedPile: [],
    loadout: [],
    offersSeen: [],
    history: [],
  };
};

const refuse = (reason: Extract<RunStep, { ok: false }>['reason']): RunStep => ({ ok: false, reason });

const clone = (run: RunState): RunState => structuredClone(run);

const isCardId = (value: unknown): value is PulseCardId => typeof value === 'string' && CARD_BY_ID.has(value as PulseCardId);

/** Combinations of `size` elements of `items`, in order (the `pick` offer rule: at most C(6,k) of them). */
const combinations = <T>(items: readonly T[], size: number): T[][] => {
  if (size === 0) return [[]];
  const out: T[][] = [];
  items.forEach((item, index) => {
    for (const rest of combinations(items.slice(index + 1), size - 1)) out.push([item, ...rest]);
  });
  return out;
};

/** The cards an offer adds under the run's rule; null if `picked` is not a legal pick. */
const addedByOffer = (run: RunState, picked: readonly unknown[] | undefined): { ok: true; cards: PulseCardId[] } | { ok: false; reason: 'bad-pick' | 'duplicate' | 'unknown-card' | 'too-many' } => {
  const offer = run.levels[run.levelIndex]?.offer ?? [];
  if (run.offerRule.kind === 'all') return { ok: true, cards: [...offer] };
  const want = Math.min(run.offerRule.pick, offer.length);
  if (!Array.isArray(picked)) return { ok: false, reason: 'bad-pick' };
  if (picked.some((id) => !isCardId(id))) return { ok: false, reason: 'unknown-card' };
  if (new Set(picked).size !== picked.length) return { ok: false, reason: 'duplicate' };
  if (picked.length > want) return { ok: false, reason: 'too-many' };
  if (picked.length !== want || picked.some((id) => !offer.includes(id as PulseCardId))) return { ok: false, reason: 'bad-pick' };
  return { ok: true, cards: picked as PulseCardId[] };
};

/** phase offer -> loadout: the offered cards join the deck (all of them, or the picked ones under the `pick` rule). */
export const acceptOffer = (run: RunState, picked?: readonly PulseCardId[]): RunStep => {
  if (run.phase !== 'offer') return refuse('wrong-phase');
  const added = addedByOffer(run, picked);
  if (!added.ok) return refuse(added.reason);
  const next = clone(run);
  next.deck = sortDeck([...run.deck, ...added.cards]);
  next.offersSeen = [...run.offersSeen, run.levelIndex];
  next.phase = 'loadout';
  return { ok: true, run: next };
};

/** Known, distinct, in the deck, a total slot cost (a rare takes two) within the slots. Zero cards is legal. */
export const validateLoadout = (run: RunState, cardIds: readonly string[]): { ok: true } | Extract<RunStep, { ok: false }> => {
  if (run.phase !== 'loadout') return { ok: false, reason: 'wrong-phase' };
  if (!Array.isArray(cardIds)) return { ok: false, reason: 'bad-pick' };
  if (cardIds.some((id) => !isCardId(id))) return { ok: false, reason: 'unknown-card' };
  if (new Set(cardIds).size !== cardIds.length) return { ok: false, reason: 'duplicate' };
  if (slotCostTotal(cardIds as PulseCardId[]) > slotsOf(run)) return { ok: false, reason: 'too-many' };
  if (cardIds.some((id) => !run.deck.includes(id as PulseCardId))) return { ok: false, reason: 'not-in-deck' };
  return { ok: true };
};

const removeOne = (deck: PulseCardId[], id: PulseCardId): void => {
  const index = deck.indexOf(id);
  if (index >= 0) deck.splice(index, 1);
};

/**
 * phase loadout -> stage. The result is handed to a NEW session (never applied to a live one): `parkLevelIndex`
 * moves to this level. With `stage-start` the cards leave the deck now and go to the used pile.
 */
export const startStage = (run: RunState, cardIds: readonly PulseCardId[]): RunStep => {
  const check = validateLoadout(run, cardIds);
  if (!check.ok) return check;
  const next = clone(run);
  next.loadout = [...cardIds];
  next.parkLevelIndex = run.levelIndex;
  next.phase = 'stage';
  if (run.consumeAt === 'stage-start') {
    for (const id of cardIds) {
      removeOne(next.deck, id);
      next.usedPile.push({ cardId: id, levelIndex: run.levelIndex });
    }
  }
  return { ok: true, run: next };
};

const sanitiseSeconds = (value: number): number => (
  Number.isFinite(value) ? Math.min(MAXIMUM_SAVED_SECONDS, Math.max(0, Math.round(value * 10) / 10)) : 0
);

const MAXIMUM_EVIDENCE_LENGTH = 500;
const sanitiseEvidence = (value: string | null): string | null => (
  typeof value === 'string' ? value.slice(0, MAXIMUM_EVIDENCE_LENGTH) : null
);

const MAXIMUM_DEBT = MAXIMUM_SAVED_AMOUNT;
const sanitiseDebt = (value: number): number => (
  Number.isFinite(value) ? Math.min(MAXIMUM_DEBT, Math.max(0, Math.round(value))) : 0
);

const isOneShot = (id: PulseCardId): boolean => CARD_BY_ID.get(id)?.kind === 'one-shot';

/** The stage's played one-shots in loadout order, or null when `played` is not a distinct subset of the loadout's one-shots. */
const playedOf = (run: RunState, played: readonly unknown[]): PulseCardId[] | null => {
  if (!Array.isArray(played)) return null;
  if (new Set(played).size !== played.length) return null;
  const loadoutOneShots = run.loadout.filter(isOneShot);
  if (played.some((id) => !loadoutOneShots.includes(id as PulseCardId))) return null;
  return loadoutOneShots.filter((id) => played.includes(id));
};

/**
 * The settlement of a stage (design 3.5), any outcome. Under `stage-start` the whole loadout went to the used pile when
 * the stage started: with `return`, the unplayed one-shots come back to the deck. Under `stage-clear` nothing has moved
 * yet: a success uses the stage cards and the played one-shots (and the unplayed ones with `consume`); a failure or an
 * abandon uses the played one-shots only.
 */
const settle = (run: RunState, next: RunState, played: readonly PulseCardId[], succeeded: boolean): void => {
  const L = run.levelIndex;
  const unplayed = run.loadout.filter((id) => isOneShot(id) && !played.includes(id));
  const returned = run.unplayedOneShots === 'return' ? unplayed : [];
  if (run.consumeAt === 'stage-start') {
    if (returned.length === 0) return;
    next.usedPile = next.usedPile.filter((used) => used.levelIndex !== L || !returned.includes(used.cardId));
    next.deck = sortDeck([...next.deck, ...returned]);
    return;
  }
  const used = succeeded ? run.loadout.filter((id) => !returned.includes(id)) : [...played];
  for (const id of used) {
    removeOne(next.deck, id);
    next.usedPile.push({ cardId: id, levelIndex: L });
  }
};

/**
 * phase stage -> offer (next level) | won | lost, with the stage's settlement (see `settle`). `playedCardIds` are the
 * one-shots the stage played (a distinct subset of the loadout's one-shots, else `bad-pick`) and `unpaidDebt` what their
 * deferred costs still owe: it comes off the next level's starting cash. Both default to none, the app's values come
 * from the park's `plays`.
 */
export const resolveStage = (
  run: RunState,
  result: { outcome: 'succeeded' | 'failed'; atSeconds: number; evidence: string | null; playedCardIds?: readonly PulseCardId[]; unpaidDebt?: number },
): RunStep => {
  if (run.phase !== 'stage') return refuse('wrong-phase');
  if (result.outcome !== 'succeeded' && result.outcome !== 'failed') return refuse('bad-pick');
  const played = playedOf(run, result.playedCardIds ?? []);
  if (played === null) return refuse('bad-pick');
  const next = clone(run);
  const entry: RunLevelResult = {
    levelIndex: run.levelIndex,
    outcome: result.outcome,
    atSeconds: sanitiseSeconds(result.atSeconds),
    evidence: sanitiseEvidence(result.evidence),
    cardIds: [...run.loadout],
    playedCardIds: played,
    unpaidDebt: sanitiseDebt(result.unpaidDebt ?? 0),
  };
  next.history.push(entry);
  settle(run, next, played, result.outcome === 'succeeded');
  if (result.outcome === 'failed') {
    next.phase = 'lost';
    return { ok: true, run: next };
  }
  if (run.levelIndex >= run.levels.length - 1) {
    next.phase = 'won';
  } else {
    next.levelIndex = run.levelIndex + 1;
    next.phase = 'offer';
  }
  return { ok: true, run: next };
};

/**
 * Any non-terminal phase -> lost. In a stage it records the stage's cards, park seconds, plays and debt and settles the
 * stage like a failure; elsewhere an empty entry (the plays and debt arguments are ignored: the park on screen is a
 * backdrop whose stage was already settled).
 */
export const abandonRun = (run: RunState, atSeconds = 0, playedCardIds: readonly PulseCardId[] = [], unpaidDebt = 0): RunStep => {
  if (run.phase === 'won' || run.phase === 'lost') return refuse('wrong-phase');
  const inStage = run.phase === 'stage';
  const played = inStage ? playedOf(run, playedCardIds) : [];
  if (played === null) return refuse('bad-pick');
  const next = clone(run);
  next.history.push({
    levelIndex: run.levelIndex,
    outcome: 'abandoned',
    atSeconds: inStage ? sanitiseSeconds(atSeconds) : 0,
    evidence: null,
    cardIds: inStage ? [...run.loadout] : [],
    playedCardIds: played,
    unpaidDebt: inStage ? sanitiseDebt(unpaidDebt) : 0,
  });
  if (inStage) settle(run, next, played, false);
  next.phase = 'lost';
  return { ok: true, run: next };
};

const sameState = (left: RunState, right: RunState): boolean => hashState(left) === hashState(right);

const PLAN_KEYS = ['version', 'planVersion', 'seed', 'difficulty', 'consumeAt', 'offerRule', 'unplayedOneShots', 'grant', 'levels', 'starterDeck'] as const;

/**
 * The advanceRun guard: true only when `next` is exactly what acceptOffer, resolveStage or abandonRun makes of
 * `previous`. The plan, the grant and the park level are unchanged. startStage is never a live transition (it builds a
 * new session), so it is false here.
 */
export const isRunTransition = (previous: RunState, next: RunState): boolean => {
  try {
    for (const key of PLAN_KEYS) if (hashState(previous[key]) !== hashState(next[key])) return false;
    if (previous.parkLevelIndex !== next.parkLevelIndex) return false;
    if (previous.phase === 'offer' && next.phase === 'loadout') {
      const offer = previous.levels[previous.levelIndex]?.offer ?? [];
      const candidates = previous.offerRule.kind === 'all' ? [undefined] : combinations(offer, Math.min(previous.offerRule.pick, offer.length));
      return candidates.some((picked) => {
        const step = acceptOffer(previous, picked);
        return step.ok && sameState(step.run, next);
      });
    }
    const last = next.history[next.history.length - 1];
    if (!last || next.history.length !== previous.history.length + 1) return false;
    if (previous.phase === 'stage' && last.outcome !== 'abandoned') {
      const step = resolveStage(previous, {
        outcome: last.outcome, atSeconds: last.atSeconds, evidence: last.evidence, playedCardIds: last.playedCardIds, unpaidDebt: last.unpaidDebt,
      });
      return step.ok && sameState(step.run, next);
    }
    if (last.outcome === 'abandoned') {
      const step = abandonRun(previous, last.atSeconds, last.playedCardIds, last.unpaidDebt);
      return step.ok && sameState(step.run, next);
    }
    return false;
  } catch {
    return false;
  }
};

export const runSummaryOf = (run: RunState): RunSummary => ({
  planVersion: run.planVersion,
  seed: run.seed,
  difficulty: run.difficulty,
  levelNumber: run.levelIndex + 1,
  levelCount: run.levels.length,
  biomeId: run.levels[run.levelIndex].biomeId,
  phase: run.phase,
  levelsCleared: run.history.filter((entry) => entry.outcome === 'succeeded').length,
});

/** A fingerprint of the whole run state (hashState, 16 hex): for tests and the guards. */
export const runHash = (run: RunState): string => hashState(run);

/** The planned part of a run (everything fixed at run start), hashed: the profile's idempotency key and the eligibility proof. */
export const plannedPartHash = (run: RunState): string => hashState({
  planVersion: run.planVersion,
  consumeAt: run.consumeAt,
  offerRule: run.offerRule,
  unplayedOneShots: run.unplayedOneShots,
  starterDeck: run.starterDeck,
  levels: run.levels,
});

export const runKeyOf = (run: RunState): string => `${run.seed}-${run.difficulty}-${plannedPartHash(run)}`;

export type { RunUsedCard };
export const RUN_DECK_LIMIT = 64;
