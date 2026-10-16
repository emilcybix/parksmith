import { BIOME_BY_ID } from '../game/biomes/content';
import { GAME_CONFIG } from '../game/config';
import { CARD_BY_ID } from '../game/cards/content';
import type { CardFamily, CardKind, CardRarity, PulseCardId } from '../game/cards/types';
import { isRunDifficulty, RUN_DIFFICULTY_LABELS, RUN_PHASES, RUN_PLAN_VERSION, type RunDifficulty, type RunPhase, type RunSummary } from '../game/run/types';
import { METRIC_COPY, formatClock } from './scenarioCopy';
import type { ObjectiveDefinition } from '../game/scenarios/types';
import { plural } from './unlockCopy';

/**
 * The words of The Map (Phase 23): one source for the menu, Save / Load, the recovery prompt, the HUD and the run
 * screens, so a level is always "level 3/5 · seed 1234" and never spelt two ways. UI copy only, never parsed.
 */

export const THE_MAP = 'The Map';

/** Sentence-start number words for the few run sizes a player meets; larger counts stay digits. */
const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
export const numberWord = (count: number): string => NUMBER_WORDS[count] ?? String(count);

/** "5 generated parks, one deck of cards": the menu entry's line. */
export const mapModeDetail = (levelCount: number = GAME_CONFIG.run.levelCount): string => (
  `${numberWord(levelCount).replace(/^./, (letter) => letter.toUpperCase())} generated parks, one deck of cards`
);

export const MAP_INTRO = (levelCount: number = GAME_CONFIG.run.levelCount): string => (
  `${numberWord(levelCount).replace(/^./, (letter) => letter.toUpperCase())} generated parks in a row. Your deck grows before every level; `
  + 'cards you play are used up. Fail a level and the run is over.'
);

export const difficultyLabel = (difficulty: RunDifficulty): string => RUN_DIFFICULTY_LABELS[difficulty];

export const DIFFICULTY_DETAIL: Readonly<Record<RunDifficulty, string>> = {
  relaxed: "Room to breathe: the first release's deadlines and targets.",
  standard: 'Shorter deadlines, higher targets, a little less cash.',
  tough: 'An extra condition from level 2 and a cash squeeze: cards make it comfortable.',
};

/** Under Continue run (Phase 25): a run made by an older plan finishes, but without rewards (`run/rewards.ts`). */
export const OLDER_RUN_NOTE = 'Runs started before this update finish without rewards.';

/**
 * The Continue note for a saved run: null when the summary says the run was made by this build's plan, the note
 * otherwise. A summary that does not carry its plan version (every save header today) cannot be told apart, so it
 * gets the note: it is a statement about older runs, true of any run.
 */
export const continueRunNote = (run: RunSummary): string | null => {
  const planVersion = (run as RunSummary & { planVersion?: unknown }).planVersion;
  return planVersion === RUN_PLAN_VERSION ? null : OLDER_RUN_NOTE;
};
/** Reads the `RunSummary` a save header or a recovery marker may carry; anything malformed reads as no run. */
export const readRunSummary = (value: unknown): RunSummary | null => {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const { seed, difficulty, levelNumber, levelCount, biomeId, phase, levelsCleared } = record;
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0) return null;
  if (!isRunDifficulty(difficulty)) return null;
  if (typeof levelNumber !== 'number' || !Number.isInteger(levelNumber) || levelNumber < 1) return null;
  if (typeof levelCount !== 'number' || !Number.isInteger(levelCount) || levelCount < levelNumber) return null;
  if (typeof biomeId !== 'string' || typeof phase !== 'string' || !(RUN_PHASES as readonly string[]).includes(phase)) return null;
  if (typeof levelsCleared !== 'number' || !Number.isInteger(levelsCleared) || levelsCleared < 0) return null;
  const summary: RunSummary = { seed, difficulty, levelNumber, levelCount, biomeId: biomeId as RunSummary['biomeId'], phase: phase as RunPhase, levelsCleared };
  // A plan version, when a header carries one, is kept for the Continue note (continueRunNote); anything else is dropped.
  const { planVersion } = record;
  return typeof planVersion === 'number' && Number.isInteger(planVersion) && planVersion > 0 ? { ...summary, planVersion } as RunSummary : summary;
};

export const biomeName = (biomeId: string): string => BIOME_BY_ID.get(biomeId as RunSummary['biomeId'])?.name ?? biomeId;

/** "level 3/5 · seed 1234" (lower case, it follows "The Map ·"). */
export const runPositionText = (run: Pick<RunSummary, 'levelNumber' | 'levelCount' | 'seed'>): string => (
  `level ${run.levelNumber}/${run.levelCount} · seed ${run.seed}`
);

/** "Level 3 · Desert Canyon". */
export const runLevelTitle = (run: Pick<RunSummary, 'levelNumber' | 'biomeId'>): string => `Level ${run.levelNumber} · ${biomeName(run.biomeId)}`;

/** Between stages the park behind the menu is a frozen backdrop; the Continue card says so. */
export const runIsAtMap = (phase: RunPhase): boolean => phase === 'offer' || phase === 'loadout';

/** A run that is over cannot be continued. */
export const runIsOver = (phase: RunPhase): boolean => phase === 'won' || phase === 'lost';

/** "level 3/5 · seed 1234 · Standard" for Save / Load rows. */
export const runRowText = (run: RunSummary): string => `${runPositionText(run)} · ${difficultyLabel(run.difficulty)}`;

/** "150 total visitors", "Crowd 65 for 4:00": the objective as a short line (the card and the path). */
export const objectiveShort = (objective: Pick<ObjectiveDefinition, 'kind' | 'metric' | 'target'> & { comparison?: 'atLeast' | 'atMost'; durationSeconds?: number }): string => {
  const copy = METRIC_COPY[objective.metric];
  if (objective.kind === 'sustain') {
    return `${copy.label} ${objective.comparison === 'atMost' ? '≤' : '≥'} ${copy.format(objective.target)} for ${formatClock(objective.durationSeconds ?? 0)}`;
  }
  return `${copy.format(objective.target)} ${copy.label}`;
};

/** 1.5 -> "1.5 days", 1 -> "1 day", 2 -> "2 days". */
export const daysText = (days: number): string => `${Number.isInteger(days) ? days : days.toFixed(2).replace(/0$/, '')} ${days === 1 ? 'day' : 'days'}`;

export const cardNames = (cardIds: readonly PulseCardId[]): string => (
  cardIds.length === 0 ? 'none' : cardIds.map((id) => CARD_BY_ID.get(id)?.name ?? id).join(', ')
);

export const cardCountText = (count: number): string => plural(count, 'card');

export const money = (amount: number): string => `$${Math.round(amount).toLocaleString('en-US')}`;

// --- Card words (Phase 25): badges, families, rarity. Text, never colour alone. ---------------------------------

export const RARITY_LABELS: Readonly<Record<CardRarity, string>> = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare' };

/** Section 4's family headings: the Collection groups the cards under them. */
export const CARD_FAMILY_LABELS: Readonly<Record<CardFamily, string>> = {
  weather: 'Weather',
  'day-night': 'Day and night',
  arrivals: 'Arrivals',
  staff: 'Cleanliness and staff',
  rides: 'Rides and coasters',
  economy: 'Economy and pricing',
  scenery: 'Scenery and themes',
  build: 'Build and tools',
};

/** "2 slots" / "1 slot". */
export const slotText = (count: number): string => plural(count, 'slot');

/**
 * The badges of a card: "One-shot" for a one-shot (a stage card shows none), then "Uncommon" or "Rare · 2 slots" (a
 * common shows none). Missing fields (an older snapshot) read as a common stage card.
 */
export const cardBadgeLabels = (card: { kind?: CardKind; rarity?: CardRarity; slotCost?: number }): string[] => {
  const labels: string[] = [];
  if (card.kind === 'one-shot') labels.push('One-shot');
  if (card.rarity === 'uncommon') labels.push(RARITY_LABELS.uncommon);
  if (card.rarity === 'rare') labels.push(`${RARITY_LABELS.rare} · ${slotText(card.slotCost ?? 2)}`);
  else if ((card.slotCost ?? 1) > 1) labels.push(slotText(card.slotCost ?? 1));
  return labels;
};
