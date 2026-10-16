import { BIOME_IDS } from '../biomes/types';
import { CARD_BY_ID, PULSE_CARDS, slotCostTotal } from '../cards/content';
import type { PulseCardId } from '../cards/types';
import { GAME_CONFIG } from '../config';
import { readRecipe, isMapSeed } from '../maps/recipe';
import { readGrant } from '../save/grant';
import { MAXIMUM_SAVED_AMOUNT, MAXIMUM_SAVED_SECONDS } from '../save/ranges';
import { SaveError } from '../save/version';
import { isRunConditionId } from './content';
import { slotsOf, sortDeck } from './deck';
import {
  RUN_FORMAT_VERSION, RUN_OBJECTIVE_FAMILIES, RUN_PHASES, RUN_DIFFICULTIES, RUN_UNPLAYED_ONE_SHOTS,
  type RunLevelResult, type RunLevelState, type RunObjectiveFamily, type RunState, type RunUsedCard,
} from './types';

/**
 * Reads a saved run (Phase 12 policy: refuse, never normalise). Order: shape, then ids, then the internal laws.
 * A shape or law problem is `invalid-state`; an id this build does not have (biome, card, condition) is
 * `content-mismatch`. Returns an independent copy. A run that passes here may still be refused rewards (see
 * runRewardEligible): plausible is not the same as planned.
 */

const MAXIMUM_LEVELS = 8;
const MAXIMUM_CARDS = 64;
const MAXIMUM_OFFER = 6;
const MAXIMUM_SLOTS = 4;
const MAXIMUM_EVIDENCE = 500;
const MAXIMUM_PLAN_VERSION = 0xffff;
const MAXIMUM_NAME = 80;
const DAY_SECONDS = GAME_CONFIG.calendar.defaultDayLengthSeconds;

const bad = (path: string, problem: string): never => {
  throw new SaveError('invalid-state', `The saved run is invalid: ${path} ${problem}`);
};
const unknown = (path: string, what: string, id: string): never => {
  throw new SaveError('content-mismatch', `This save uses ${what} '${id.slice(0, 40)}' (${path}), which this version of the game does not have.`);
};

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);

const exactKeys = (value: unknown, keys: readonly string[], path: string): Raw => {
  if (!isRecord(value)) return bad(path, 'is not an object');
  for (const key of Object.keys(value)) if (!keys.includes(key)) bad(path, `has the unknown key '${key.slice(0, 40)}'`);
  for (const key of keys) if (!Object.hasOwn(value, key)) bad(path, `is missing '${key}'`);
  return value;
};

const int = (value: unknown, path: string, minimum: number, maximum: number): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) bad(path, `must be an integer in ${minimum}..${maximum}`);
  return value as number;
};

const num = (value: unknown, path: string, minimum: number, maximum: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) bad(path, `must be a finite number in ${minimum}..${maximum}`);
  return value as number;
};

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], path: string): T => {
  if (typeof value !== 'string' || !allowed.includes(value as T)) bad(path, `must be one of ${allowed.join(', ')}`);
  return value as T;
};

const cardList = (value: unknown, path: string, maximum: number): PulseCardId[] => {
  if (!Array.isArray(value)) return bad(path, 'is not an array');
  if (value.length > maximum) bad(path, `is longer than ${maximum}`);
  for (const id of value) {
    if (typeof id !== 'string') bad(path, 'must hold card ids (strings)');
    if (!CARD_BY_ID.has(id as PulseCardId)) unknown(path, 'Pulse Card', id as string);
  }
  return value as PulseCardId[];
};

const isCanonical = (ids: readonly PulseCardId[]): boolean => sortDeck(ids).every((id, index) => id === ids[index]);

const counts = (ids: readonly PulseCardId[]): Map<PulseCardId, number> => {
  const map = new Map<PulseCardId, number>();
  for (const id of ids) map.set(id, (map.get(id) ?? 0) + 1);
  return map;
};

const FAMILY_SHAPE: Readonly<Record<RunObjectiveFamily, { kind: string; metric: string }>> = {
  visitors: { kind: 'earn', metric: 'cumulativeGuests' },
  profit: { kind: 'earn', metric: 'operatingProfit' },
  crowd: { kind: 'reach', metric: 'guestCount' },
  spirits: { kind: 'sustain', metric: 'averageHappiness' },
};

const readObjective = (value: unknown, family: RunObjectiveFamily, path: string): RunLevelState['objective'] => {
  const shape = FAMILY_SHAPE[family];
  const keys = family === 'spirits' ? ['id', 'name', 'kind', 'metric', 'target', 'comparison', 'durationSeconds'] : ['id', 'name', 'kind', 'metric', 'target'];
  const raw = exactKeys(value, keys, path);
  if (raw.id !== `run-${family}`) bad(`${path}.id`, `must be run-${family}`);
  if (typeof raw.name !== 'string' || raw.name.length === 0 || raw.name.length > MAXIMUM_NAME) bad(`${path}.name`, `must be a string of 1..${MAXIMUM_NAME} characters`);
  if (raw.kind !== shape.kind || raw.metric !== shape.metric) bad(path, `does not match the ${family} family`);
  if (family === 'visitors' || family === 'crowd') int(raw.target, `${path}.target`, 1, 100_000);
  else if (family === 'profit') num(raw.target, `${path}.target`, 1, MAXIMUM_SAVED_AMOUNT);
  else {
    num(raw.target, `${path}.target`, 0, 100);
    if (raw.comparison !== 'atLeast') bad(`${path}.comparison`, 'must be atLeast');
    num(raw.durationSeconds, `${path}.durationSeconds`, 1, MAXIMUM_SAVED_SECONDS);
  }
  return structuredClone(raw) as unknown as RunLevelState['objective'];
};

const LEVEL_KEYS = ['index', 'biomeId', 'recipe', 'parkSeed', 'family', 'objective', 'timeLimitDays', 'startingCash', 'conditionIds', 'slots', 'offer'];

const readLevel = (value: unknown, index: number): RunLevelState => {
  const path = `levels[${index}]`;
  const raw = exactKeys(value, LEVEL_KEYS, path);
  if (raw.index !== index) bad(`${path}.index`, `must equal its position ${index}`);
  if (typeof raw.biomeId !== 'string') bad(`${path}.biomeId`, 'must be a biome id');
  if (!(BIOME_IDS as readonly string[]).includes(raw.biomeId as string)) unknown(`${path}.biomeId`, 'biome', raw.biomeId as string);
  const read = readRecipe(raw.recipe);
  if ('problem' in read) return bad(`${path}.recipe`, read.problem);
  const recipe = read;
  if (recipe.biomeId !== raw.biomeId) bad(`${path}.recipe`, 'is for another biome than the level');
  int(raw.parkSeed, `${path}.parkSeed`, 0, 0xffff_ffff);
  const family = oneOf(raw.family, RUN_OBJECTIVE_FAMILIES, `${path}.family`);
  const objective = readObjective(raw.objective, family, `${path}.objective`);
  const days = num(raw.timeLimitDays, `${path}.timeLimitDays`, 0.25, 30);
  if (Math.abs(days * 4 - Math.round(days * 4)) > 1e-9) bad(`${path}.timeLimitDays`, 'must be a multiple of 0.25');
  num(raw.startingCash, `${path}.startingCash`, 0, 1_000_000);
  if (!Array.isArray(raw.conditionIds) || raw.conditionIds.length > 9) bad(`${path}.conditionIds`, 'must be an array of at most 9 condition ids');
  for (const id of raw.conditionIds as unknown[]) {
    if (typeof id !== 'string') bad(`${path}.conditionIds`, 'must hold condition ids (strings)');
    if (!isRunConditionId(id)) unknown(`${path}.conditionIds`, 'run condition', id as string);
  }
  if (new Set(raw.conditionIds as unknown[]).size !== (raw.conditionIds as unknown[]).length) bad(`${path}.conditionIds`, 'must be unique');
  int(raw.slots, `${path}.slots`, 0, MAXIMUM_SLOTS);
  const offer = cardList(raw.offer, `${path}.offer`, MAXIMUM_OFFER);
  if (new Set(offer).size !== offer.length) bad(`${path}.offer`, 'must be distinct');
  if (!isCanonical(offer)) bad(`${path}.offer`, 'is not in canonical card order');
  return { ...(structuredClone(raw) as unknown as RunLevelState), objective, recipe: { ...recipe } };
};

const isOneShot = (id: PulseCardId): boolean => CARD_BY_ID.get(id)?.kind === 'one-shot';

const readResult = (value: unknown, index: number): RunLevelResult => {
  const path = `history[${index}]`;
  const raw = exactKeys(value, ['levelIndex', 'outcome', 'atSeconds', 'evidence', 'cardIds', 'playedCardIds', 'unpaidDebt'], path);
  if (raw.levelIndex !== index) bad(`${path}.levelIndex`, `must equal its position ${index}`);
  oneOf(raw.outcome, ['succeeded', 'failed', 'abandoned'] as const, `${path}.outcome`);
  num(raw.atSeconds, `${path}.atSeconds`, 0, MAXIMUM_SAVED_SECONDS);
  if (raw.evidence !== null && (typeof raw.evidence !== 'string' || raw.evidence.length > MAXIMUM_EVIDENCE)) bad(`${path}.evidence`, `must be null or a string of at most ${MAXIMUM_EVIDENCE} characters`);
  const cards = cardList(raw.cardIds, `${path}.cardIds`, MAXIMUM_SLOTS + 1);
  if (new Set(cards).size !== cards.length) bad(`${path}.cardIds`, 'must be distinct');
  // Run format 2: the stage's played one-shots (a subset of the loadout's one-shots, in loadout order) and its debt.
  const played = cardList(raw.playedCardIds, `${path}.playedCardIds`, MAXIMUM_SLOTS + 1);
  if (played.some((id) => !isOneShot(id))) bad(`${path}.playedCardIds`, 'must hold one-shot cards only');
  const expected = cards.filter((id) => played.includes(id));
  if (new Set(played).size !== played.length || expected.length !== played.length || expected.some((id, at) => id !== played[at])) {
    bad(`${path}.playedCardIds`, 'must be distinct cards of the loadout, in loadout order');
  }
  const debt = int(raw.unpaidDebt, `${path}.unpaidDebt`, 0, MAXIMUM_SAVED_AMOUNT);
  if (played.length === 0 && debt !== 0) bad(`${path}.unpaidDebt`, 'must be 0 when no one-shot was played');
  return structuredClone(raw) as unknown as RunLevelResult;
};

const RUN_KEYS = [
  'version', 'planVersion', 'seed', 'difficulty', 'consumeAt', 'offerRule', 'unplayedOneShots', 'grant', 'levels', 'starterDeck',
  'levelIndex', 'parkLevelIndex', 'phase', 'deck', 'usedPile', 'loadout', 'offersSeen', 'history',
];

export const readRunState = (raw: unknown): RunState => {
  const state = exactKeys(raw, RUN_KEYS, 'run');
  if (state.version !== RUN_FORMAT_VERSION) bad('version', `must be ${RUN_FORMAT_VERSION}`);
  int(state.planVersion, 'planVersion', 1, MAXIMUM_PLAN_VERSION);
  if (!isMapSeed(state.seed)) bad('seed', 'must be an integer in 0..4294967295');
  const difficulty = oneOf(state.difficulty, RUN_DIFFICULTIES, 'difficulty');
  const consumeAt = oneOf(state.consumeAt, ['stage-start', 'stage-clear'] as const, 'consumeAt');
  const unplayedOneShots = oneOf(state.unplayedOneShots, RUN_UNPLAYED_ONE_SHOTS, 'unplayedOneShots');
  const phase = oneOf(state.phase, RUN_PHASES, 'phase');
  const offerRuleRaw = state.offerRule;
  if (!isRecord(offerRuleRaw)) bad('offerRule', 'is not an object');
  const offerRule = (offerRuleRaw as Raw).kind === 'pick'
    ? (() => { exactKeys(offerRuleRaw, ['kind', 'pick'], 'offerRule'); return { kind: 'pick' as const, pick: int((offerRuleRaw as Raw).pick, 'offerRule.pick', 1, MAXIMUM_OFFER) }; })()
    : (() => { exactKeys(offerRuleRaw, ['kind'], 'offerRule'); if ((offerRuleRaw as Raw).kind !== 'all') bad('offerRule.kind', 'must be all or pick'); return { kind: 'all' as const }; })();
  const grant = readGrant(state.grant, 'run');
  if (!Array.isArray(state.levels) || state.levels.length < 1 || state.levels.length > MAXIMUM_LEVELS) bad('levels', `must be an array of 1..${MAXIMUM_LEVELS} levels`);
  const levels = (state.levels as unknown[]).map((level, index) => readLevel(level, index));
  const starterDeck = cardList(state.starterDeck, 'starterDeck', MAXIMUM_CARDS);
  const deck = cardList(state.deck, 'deck', MAXIMUM_CARDS);
  const loadout = cardList(state.loadout, 'loadout', MAXIMUM_SLOTS + 1);
  if (!isCanonical(starterDeck)) bad('starterDeck', 'is not in canonical card order');
  if (!isCanonical(deck)) bad('deck', 'is not in canonical card order');
  if (new Set(loadout).size !== loadout.length) bad('loadout', 'must be distinct');
  if (!Array.isArray(state.usedPile) || state.usedPile.length > MAXIMUM_CARDS) bad('usedPile', `must be an array of at most ${MAXIMUM_CARDS} entries`);
  const usedPile: RunUsedCard[] = (state.usedPile as unknown[]).map((entry, index) => {
    const used = exactKeys(entry, ['cardId', 'levelIndex'], `usedPile[${index}]`);
    cardList([used.cardId], `usedPile[${index}].cardId`, 1);
    return { cardId: used.cardId as PulseCardId, levelIndex: int(used.levelIndex, `usedPile[${index}].levelIndex`, 0, levels.length - 1) };
  });
  const levelIndex = int(state.levelIndex, 'levelIndex', 0, levels.length - 1);
  const parkLevelIndex = int(state.parkLevelIndex, 'parkLevelIndex', 0, levels.length - 1);
  if (parkLevelIndex > levelIndex || levelIndex - parkLevelIndex > 1) bad('parkLevelIndex', 'must be the current level or the one before it');
  if (!Array.isArray(state.offersSeen) || state.offersSeen.length > levels.length) bad('offersSeen', 'must be an array of level indices');
  const offersSeen = (state.offersSeen as unknown[]).map((entry, index) => int(entry, `offersSeen[${index}]`, 0, levels.length - 1));
  if (!Array.isArray(state.history) || state.history.length > levels.length) bad('history', 'must hold at most one result per level');
  const history = (state.history as unknown[]).map((entry, index) => readResult(entry, index));

  const run: RunState = {
    version: RUN_FORMAT_VERSION, planVersion: state.planVersion as number, seed: state.seed as number, difficulty, consumeAt, offerRule, unplayedOneShots, grant, levels,
    starterDeck, levelIndex, parkLevelIndex, phase, deck, usedPile, loadout, offersSeen, history,
  };
  checkLaws(run);
  return run;
};

const range = (count: number): number[] => Array.from({ length: count }, (_, index) => index);
const sameNumbers = (left: readonly number[], right: readonly number[]): boolean => left.length === right.length && left.every((value, index) => value === right[index]);
const sameCards = (left: readonly PulseCardId[], right: readonly PulseCardId[]): boolean => left.length === right.length && left.every((value, index) => value === right[index]);

/** The internal laws of a run (the state machine's invariants), `invalid-state` on any violation. */
const checkLaws = (run: RunState): void => {
  const { phase, levelIndex: L, parkLevelIndex: P, history, loadout, levels } = run;
  // History: one entry per finished level, all succeeded before the end.
  history.forEach((entry, index) => {
    const level = levels[index];
    if (!level) bad(`history[${index}]`, 'has no level');
    if (entry.atSeconds > level.timeLimitDays * DAY_SECONDS + 1) bad(`history[${index}].atSeconds`, 'is later than the level deadline');
    if (slotCostTotal(entry.cardIds) > slotsOf(run, index)) bad(`history[${index}].cardIds`, 'costs more slots than the level has');
    if (index < history.length - 1 && entry.outcome !== 'succeeded') bad(`history[${index}].outcome`, 'a level before the last result must have succeeded');
  });
  const last = history[history.length - 1];
  const offersExpected = (through: number): number[] => range(through + 1);
  if (phase === 'offer' || phase === 'loadout') {
    if (history.length !== L) bad('history', `must hold ${L} results before level ${L + 1}`);
    if (L === 0 ? P !== 0 : P !== L - 1) bad('parkLevelIndex', 'does not fit the phase');
    if (!sameNumbers(run.offersSeen, offersExpected(phase === 'offer' ? L - 1 : L).filter((value) => value >= 0))) bad('offersSeen', 'does not fit the phase');
    if (P < history.length ? !sameCards(loadout, history[P].cardIds) : loadout.length > 0) bad('loadout', 'must be the cards of the park on screen');
  } else if (phase === 'stage') {
    if (P !== L) bad('parkLevelIndex', 'must be the current level during a stage');
    if (history.length !== L) bad('history', `must hold ${L} results during level ${L + 1}`);
    if (!sameNumbers(run.offersSeen, offersExpected(L))) bad('offersSeen', 'does not fit the phase');
    if (slotCostTotal(loadout) > slotsOf(run, L)) bad('loadout', 'costs more slots than the level has');
  } else if (phase === 'won') {
    if (L !== levels.length - 1 || P !== L) bad('levelIndex', 'must be the last level when the run is won');
    if (history.length !== levels.length || history.some((entry) => entry.outcome !== 'succeeded')) bad('history', 'must hold one success per level when the run is won');
    if (!sameNumbers(run.offersSeen, offersExpected(L))) bad('offersSeen', 'does not fit the phase');
    if (!sameCards(loadout, history[P].cardIds)) bad('loadout', 'must be the cards of the last park');
  } else {
    if (!last || last.outcome === 'succeeded' || history.length !== L + 1) bad('history', 'must end with the failed or abandoned level when the run is lost');
    const seen = run.offersSeen;
    if (!sameNumbers(seen, offersExpected(L - 1).filter((value) => value >= 0)) && !sameNumbers(seen, offersExpected(L))) bad('offersSeen', 'does not fit the phase');
    if (last.outcome === 'failed') {
      if (P !== L || !sameCards(loadout, last.cardIds)) bad('loadout', 'must be the cards of the failed stage');
    } else if (P === L) {
      if (!sameCards(loadout, last.cardIds)) bad('loadout', 'must be the cards of the abandoned stage');
    } else if (P === L - 1) {
      if (last.cardIds.length > 0 || !sameCards(loadout, history[P].cardIds)) bad('loadout', 'does not fit an abandon between stages');
    } else {
      bad('parkLevelIndex', 'does not fit the phase');
    }
  }
  // The used pile is exactly what each started stage consumed, in play order (design 3.7). A finished stage: under
  // `stage-start` its loadout minus the unplayed one-shots that returned; under `stage-clear` the same on a success and
  // only the played one-shots otherwise. A running stage under `stage-start` adds its whole loadout.
  const expectedUsed: RunUsedCard[] = [];
  history.forEach((entry, index) => {
    const returned = run.unplayedOneShots === 'return' ? entry.cardIds.filter((id) => isOneShot(id) && !entry.playedCardIds.includes(id)) : [];
    const kept = entry.cardIds.filter((id) => !returned.includes(id));
    const used = run.consumeAt === 'stage-start' || entry.outcome === 'succeeded' ? kept : entry.playedCardIds;
    for (const cardId of used) expectedUsed.push({ cardId, levelIndex: index });
  });
  if (phase === 'stage' && run.consumeAt === 'stage-start') for (const cardId of loadout) expectedUsed.push({ cardId, levelIndex: L });
  if (JSON.stringify(run.usedPile) !== JSON.stringify(expectedUsed)) bad('usedPile', 'is not what the played stages used up');
  // Card conservation: the starter deck plus every accepted offer is the deck plus the used pile.
  const ever = counts([...run.starterDeck, ...levels.flatMap((level) => level.offer)]);
  for (const [id, count] of ever) if (count > GAME_CONFIG.run.copyCap) bad('levels', `offers more than ${GAME_CONFIG.run.copyCap} copies of '${id}' over the run`);
  const held = counts([...run.deck, ...run.usedPile.map((used) => used.cardId)]);
  if (run.offerRule.kind === 'all') {
    const accepted = counts([...run.starterDeck, ...run.offersSeen.flatMap((index) => levels[index].offer)]);
    for (const card of PULSE_CARDS) {
      if ((held.get(card.id) ?? 0) !== (accepted.get(card.id) ?? 0)) bad('deck', `does not add up: the copies of '${card.id}' differ from the starter deck plus the accepted offers`);
    }
  } else {
    const picked = run.offersSeen.reduce((sum, index) => sum + Math.min(run.offerRule.kind === 'pick' ? run.offerRule.pick : 0, levels[index].offer.length), 0);
    if (run.deck.length + run.usedPile.length !== run.starterDeck.length + picked) bad('deck', 'does not add up to the starter deck plus the picked cards');
    for (const [id, count] of held) if (count > (ever.get(id) ?? 0)) bad('deck', `holds more copies of '${id}' than were ever offered`);
  }
  // With `stage-clear` the loadout of a running stage is still in the deck.
  if (phase === 'stage' && run.consumeAt === 'stage-clear') {
    const deckCounts = counts(run.deck);
    for (const id of loadout) if ((deckCounts.get(id) ?? 0) < 1) bad('loadout', 'holds a card that is not in the deck');
  }
};
