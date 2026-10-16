import { GAME_CONFIG } from '../config';
import { BUILD_CATALOG } from '../content/catalog';
import { runBotOnSession, type BotPlan, type BotResult, type BotRunOptions } from '../scenarios/bot/scenarioBot';
import { richPlan } from '../scenarios/bot/plans';
import { ParkSession } from '../session/ParkSession';
import { CARD_BY_ID, PULSE_CARDS } from '../cards/content';
import { downsideAxesOf, effectVectorOf } from '../cards/vector';
import type { PulseCardId } from '../cards/types';
import { deadCardIdsIn, lockedIdsOf } from './content';
import { slotsOf, startStage } from './deck';
import { buildStage } from './stage';
import type { RunState } from './types';

/**
 * Test support (not imported by the app): the Phase 22 scripted player on a stage of The Map, built exactly as the app
 * builds it (`buildStage`, the run's grant, mode `run`). `run` must be at phase `loadout` of the level to play. The
 * plan defaults to `richPlan(locked)`, `locked` being what the level's conditions lock.
 */
export const runStageBot = (
  run: RunState,
  cardIds: readonly PulseCardId[] = [],
  plan?: BotPlan,
  options: BotRunOptions = {},
): BotResult & { definitionTarget: number; deadlineSeconds: number } => {
  const started = startStage(run, cardIds);
  if (!started.ok) throw new Error(`runStageBot: ${started.reason}`);
  const level = started.run.levels[started.run.levelIndex];
  const { definition, layout } = buildStage(started.run, started.run.levelIndex);
  const session = new ParkSession(definition, cardIds, { mode: 'run', grant: started.run.grant, layout, run: started.run });
  const result = runBotOnSession(session, plan ?? richPlan(lockedIdsOf(level.conditionIds)), options);
  return { ...result, definitionTarget: level.objective.target, deadlineSeconds: definition.timeLimitSeconds };
};

const DECORATIVE: ReadonlySet<string> = new Set(BUILD_CATALOG.filter((definition) => definition.kind === 'scenery').map((definition) => definition.id));

/** Placements the bot could not build that matter: scenery that does not fit on a crowded generated map is not one. */
export const essentialSkips = (result: BotResult): string[] => result.skipped.filter((entry) => !DECORATIVE.has(entry.split(':')[0]));

/** The margin rule of the proof: succeeded, no ride, stall or amenity skipped, never broke, and done by `margin` of the deadline. */
export const withinMargin = (result: BotResult, deadlineSeconds: number, margin: number): boolean => (
  result.status === 'succeeded'
  && essentialSkips(result).length === 0
  && result.minimumCash >= 0
  && (result.completedAtSeconds ?? Infinity) <= deadlineSeconds * margin
);

export const marginOf = (run: RunState): number => GAME_CONFIG.run.difficulties[run.difficulty].botMargin;

/** The margin a plausible deck must clear Tough levels 4 and 5 within (design 7.3). */
export const deckMarginOf = (run: RunState): number => GAME_CONFIG.run.difficulties[run.difficulty].deckMargin;

/**
 * When the bot plays a one-shot (design 8): an effect that pays off from the start (a loan, a surge, research, cheer) at
 * 30 s; one that needs a park to act on (repair, sweep, forecast) at 40 % of the deadline, retried at 60 % if refused
 * (a second play of a played card is a harmless refusal). A stage card is never played.
 */
export const oneShotPlayTimes = (cardId: PulseCardId, deadlineSeconds: number): number[] => {
  const card = CARD_BY_ID.get(cardId);
  if (!card || card.kind !== 'one-shot') return [];
  switch (card.effect.kind) {
    case 'repair':
    case 'sweep':
    case 'forecast':
      return [Math.round(deadlineSeconds * 0.4), Math.round(deadlineSeconds * 0.6)];
    default:
      return [30];
  }
};

/** `plan` plus card-only steps that play `plays` (card, second) through `BotActions.playCards`. */
export const withCardPlays = (plan: BotPlan, plays: ReadonlyArray<readonly [PulseCardId, number]>): BotPlan => ({
  ...plan,
  steps: [...(plan.steps ?? []), ...plays.map(([cardId, atSeconds]) => ({ atSeconds, playCards: [cardId] }))],
});

/** The level's deadline in seconds (the stage definition's time limit: park days of the default length, design 2). */
export const deadlineSecondsOf = (run: RunState, levelIndex: number = run.levelIndex): number => (
  run.levels[levelIndex].timeLimitDays * GAME_CONFIG.calendar.defaultDayLengthSeconds
);

/**
 * The scripted player with `cardIds` in the loadout and every one-shot among them played at its `oneShotPlayTimes`
 * (or at `oneShotAt` seconds when given): the bot as a player who uses the cards they brought.
 */
export const runStageBotWithCards = (
  run: RunState,
  cardIds: readonly PulseCardId[],
  options: { plan?: BotPlan; oneShotAt?: number; options?: BotRunOptions } = {},
): ReturnType<typeof runStageBot> => {
  const level = run.levels[run.levelIndex];
  const deadline = deadlineSecondsOf(run);
  const plays: Array<readonly [PulseCardId, number]> = [];
  for (const id of cardIds) {
    const times = oneShotPlayTimes(id, deadline);
    if (times.length === 0) continue;
    if (options.oneShotAt !== undefined) plays.push([id, options.oneShotAt], [id, Math.round(deadline * 0.6)]);
    else for (const at of times) plays.push([id, at]);
  }
  return runStageBot(run, cardIds, withCardPlays(options.plan ?? richPlan(lockedIdsOf(level.conditionIds)), plays), options.options);
};

/**
 * A plausible loadout (design 7.3): the run's real deck at its current level, in canonical order; stage cards that are
 * live in the level's biome while their slot cost fits, then one one-shot if a slot is left. One judgement a player
 * makes from the card's own downside line (Phase 25 wave 3, measured): a card that slows arrivals is not brought to a
 * visitors or crowd level (Velvet Ropes took seed 3's Tough level 5 from 80 % with no card to 91 %).
 */
export const plausibleLoadout = (run: RunState): PulseCardId[] => {
  const level = run.levels[run.levelIndex];
  const dead: PulseCardId[] = [...deadCardIdsIn(level.biomeId)];
  if (level.family === 'visitors' || level.family === 'crowd') {
    for (const card of PULSE_CARDS) if (card.kind === 'stage' && downsideAxesOf(effectVectorOf(card)).includes('arrivalIntervalMultiplier')) dead.push(card.id);
  }
  const slots = slotsOf(run);
  const distinct = run.deck.filter((id, index, all) => all.indexOf(id) === index);
  const chosen: PulseCardId[] = [];
  let used = 0;
  for (const id of distinct) {
    const card = CARD_BY_ID.get(id);
    if (!card || card.kind !== 'stage' || dead.includes(id)) continue;
    if (used + card.slotCost > slots) continue;
    chosen.push(id);
    used += card.slotCost;
  }
  const oneShot = distinct.find((id) => CARD_BY_ID.get(id)?.kind === 'one-shot' && (CARD_BY_ID.get(id)?.slotCost ?? 1) + used <= slots);
  if (oneShot !== undefined) chosen.push(oneShot);
  return chosen;
};
