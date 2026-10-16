import { CARD_BY_ID } from '../game/cards/content';
import { MAX_SEED, parseSeedText } from '../game/maps/recipe';
import type { ProfileSnapshot } from '../game/profile/types';
import { planRun } from '../game/run/plan';
import { RUN_DIFFICULTIES, type RunDifficulty, type RunSummary } from '../game/run/types';
import { DIFFICULTY_DETAIL, MAP_INTRO, biomeName, difficultyLabel, runIsOver, runLevelTitle, runPositionText } from './runCopy';
import { moveRadio } from './newParkModel';

/**
 * The Map's setup panel (menu panel `the-map`) as pure data: the seed field, the difficulty radios, the live route
 * line, the Continue run card and what Enter and Escape mean. The component renders it.
 */

export const RUN_SEED_HELP = `Use a whole number from 0 to ${MAX_SEED.toLocaleString('en-US')}.`;

export interface RunSetupDraft {
  seedText: string;
  difficulty: RunDifficulty;
}

/** The seed a Random seed button puts in the field: a uint32 from `random` (0 <= random() < 1). Injected so tests are exact. */
export const randomSeedText = (random: () => number): string => String(Math.min(MAX_SEED, Math.floor(random() * (MAX_SEED + 1))));

export const DEFAULT_DIFFICULTY: RunDifficulty = 'standard';

export interface DifficultyOption {
  id: RunDifficulty;
  label: string;
  detail: string;
  selected: boolean;
  /** Why it cannot be chosen yet ("Win a Standard run to unlock"), or null. */
  locked: string | null;
}

/**
 * Whether a difficulty is open on this profile. This repeats ProfileManager.runDifficultyAvailability on the snapshot
 * (Tough opens with the first Standard or Tough victory); a test keeps the two equal.
 */
export const difficultyAvailability = (profile: ProfileSnapshot | null, difficulty: RunDifficulty): { available: boolean; conditionText: string | null } => {
  if (difficulty !== 'tough') return { available: true, conditionText: null };
  const victories = profile?.runs.victories;
  const available = victories !== undefined && victories.standard + victories.tough > 0;
  return { available, conditionText: available ? null : 'Win a Standard run to unlock' };
};

export interface ContinueRunCard {
  title: string;
  /** "The Map · level 3/5 · seed 1234 · Standard · Autosave · 5 min ago" is the menu's; this one is the panel's. */
  subtitle: string;
  atMap: boolean;
}

export interface RunSetupModel {
  intro: string;
  /** Null when the field is empty or invalid (then `seedError` says why). */
  seed: number | null;
  seedError: string | null;
  difficulties: DifficultyOption[];
  /** "Meadow → Seaside → Winter → Jungle → Desert Canyon", or null without a valid seed. */
  route: string | null;
  /** "Starter deck: Grand Opening, Lean Crew, Hungry Tourists". */
  starterDeck: string | null;
  canStart: boolean;
  /**
   * The note above Start run when an unfinished run is saved: whether starting replaces it (the autosave holds it, and
   * Start run asks first) or leaves it in its own slot (only the autosave is replaced).
   */
  replaceNote: string | null;
}

/** `savedInAutosave`: the autosave is the save that holds `saved` (see `autosavedRunAtStake`), so a new run replaces it. */
export const buildRunSetup = (draft: RunSetupDraft, profile: ProfileSnapshot | null, saved: RunSummary | null, savedInAutosave = false): RunSetupModel => {
  const seed = parseSeedText(draft.seedText);
  const difficulties: DifficultyOption[] = RUN_DIFFICULTIES.map((id) => ({
    id,
    label: difficultyLabel(id),
    detail: DIFFICULTY_DETAIL[id],
    selected: id === draft.difficulty,
    locked: difficultyAvailability(profile, id).conditionText,
  }));
  let route: string | null = null;
  let starterDeck: string | null = null;
  if (seed !== null) {
    try {
      const plan = planRun({ seed, difficulty: draft.difficulty });
      route = plan.levels.map((level) => biomeName(level.biomeId)).join(' → ');
      starterDeck = `Starter deck: ${plan.starterDeck.map((id) => CARD_BY_ID.get(id)?.name ?? id).join(', ')}`;
    } catch {
      route = null;
    }
  }
  const lockedSelected = difficulties.some((option) => option.selected && option.locked !== null);
  const open = saved !== null && !runIsOver(saved.phase);
  return {
    intro: MAP_INTRO(),
    seed,
    seedError: seed === null ? RUN_SEED_HELP : null,
    difficulties,
    route,
    starterDeck,
    canStart: seed !== null && !lockedSelected,
    replaceNote: !open
      ? null
      : savedInAutosave
        ? `Your current run (${runPositionText(saved)}) is kept only by the autosave, and a new run replaces it. Start run asks first; to keep it, continue it and save it to a slot.`
        : `Your current run (${runPositionText(saved)}) stays in its save slot: a new run replaces only the autosave.`,
  };
};

export const describeContinueRun = (run: RunSummary): ContinueRunCard => ({
  title: runLevelTitle(run),
  subtitle: `${runPositionText(run)} · ${difficultyLabel(run.difficulty)}`,
  atMap: run.phase === 'offer' || run.phase === 'loadout',
});

/**
 * Where an arrow key moves focus in the difficulty radio group: every difficulty is reachable (a locked one is focused so
 * its unlock text is read aloud), and selection follows focus only onto an open one (`canSelect`).
 */
export const nextDifficulty = (profile: ProfileSnapshot | null, current: RunDifficulty, key: string): { focus: RunDifficulty; canSelect: boolean } | null => {
  const next = moveRadio([...RUN_DIFFICULTIES], current, key);
  if (next === null) return null;
  const focus = next as RunDifficulty;
  return { focus, canSelect: difficultyAvailability(profile, focus).available };
};

/** After a locked option was chosen the draft falls back to the default (a profile cannot lose Tough, but a hostile draft may name it). */
export const sanitiseDifficulty = (profile: ProfileSnapshot | null, difficulty: RunDifficulty): RunDifficulty => (
  difficultyAvailability(profile, difficulty).available ? difficulty : DEFAULT_DIFFICULTY
);
