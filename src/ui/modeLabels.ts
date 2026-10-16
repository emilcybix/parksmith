import { GAME_MODE_LABELS, isGameMode, legacyModeOf, type GameMode } from '../game/modes/types';
import type { SaveSlotMeta } from '../app/saves/types';
import type { RunSummary } from '../game/run/types';
import { mapModeDetail, readRunSummary } from './runCopy';

/**
 * Where the three game modes are named for the player (Phase 22). The labels themselves live with the mode
 * (`GAME_MODE_LABELS`); this file is the one place the UI reads a save's mode from, so every screen agrees:
 * a record with a valid `mode` says it, anything else (a record from before schema 10, a hostile value) reads
 * as the plan's rule, `legacyModeOf(scenarioId)`.
 */

export const modeLabel = (mode: GameMode): string => GAME_MODE_LABELS[mode];

/** The mode a save slot's metadata describes. */
export const slotModeOf = (meta: Pick<SaveSlotMeta, 'mode' | 'scenarioId'>): GameMode => (
  isGameMode(meta.mode) ? meta.mode : legacyModeOf(typeof meta.scenarioId === 'string' ? meta.scenarioId : null)
);

/** The mode a recovery offer or marker names, or null when it does not say (the prompt then keeps today's text). */
export const knownMode = (value: unknown): GameMode | null => (isGameMode(value) ? value : null);

/** The three modes in the order the menu lists them: The Map, Scenario, Sandbox. */
export const MENU_MODE_ORDER: readonly GameMode[] = ['run', 'scenario', 'sandbox'];

/** Short descriptions used by the start menu entries and the pause menu's Parks chooser (one source). */
export const MODE_DETAIL: Readonly<Record<GameMode, string>> = {
  run: mapModeDetail(),
  scenario: 'Goals, deadlines and lasting rewards',
  sandbox: 'Build freely on any map',
};

/**
 * The run a save slot belongs to (Phase 23): `SaveSlotMeta.run`, written at capture from `runSummaryOf`. A record without
 * it (Sandbox, Scenario, anything older) or with a malformed one reads as null and keeps today's texts. The UI never
 * parses names.
 */
export const slotRunOf = (meta: Pick<SaveSlotMeta, 'mode'> | null | undefined): RunSummary | null => (
  meta === null || meta === undefined ? null : readRunSummary((meta as { run?: unknown }).run)
);

/**
 * Phase 33: the park's own name for the top bar's subtitle (it said "Garden Gate" in every park): a Scenario's name, a
 * Map level's name ("Level 3 · Seaside") or, in a Sandbox, the map's name ("Meadow Garden", a generated map's name).
 */
export const parkTitleOf = (park: { mode: GameMode; scenarioName: string | null; mapName: string }): string => (
  park.mode !== 'sandbox' && park.scenarioName !== null && park.scenarioName !== '' ? park.scenarioName : park.mapName
);
