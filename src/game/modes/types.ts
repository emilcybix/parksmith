/**
 * How a park is played (Phase 22). Typed in the session and in the save; the simulation itself never branches on
 * it, only the ruleset (through the profile-bonus layer) and the profile rewards do.
 */
export type GameMode = 'sandbox' | 'scenario' | 'run';

export const GAME_MODES: readonly GameMode[] = ['sandbox', 'scenario', 'run'];

export const GAME_MODE_LABELS: Readonly<Record<GameMode, string>> = {
  sandbox: 'Sandbox',
  scenario: 'Scenario',
  run: 'The Map',
};

export const isGameMode = (value: unknown): value is GameMode => (
  value === 'sandbox' || value === 'scenario' || value === 'run'
);

/**
 * Schema 9 and older saves have no mode: by scenarioId only. A park started from a Park Tour node (app.tourNodeId)
 * is a `scenario` here as well; the app keeps restoring the tour node, so clearing it still advances the tour.
 */
export const legacyModeOf = (scenarioId: string | null): 'sandbox' | 'scenario' => (
  scenarioId === null ? 'sandbox' : 'scenario'
);

/** Phase 28 recolour-cost plumbing per mode: the Map (run) uses the 'map' column. */
export const colourCostModeOf = (mode: GameMode): 'sandbox' | 'scenario' | 'map' => (mode === 'run' ? 'map' : mode);

/** Pulse Cards exist in Scenario and The Map only. */
export const modeHasCards = (mode: GameMode): boolean => mode !== 'sandbox';
