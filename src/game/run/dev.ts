import type { ParkSession } from '../session/ParkSession';

/**
 * Development only (called from the app's `__parksmithDev` hooks, never from a game flow): latches the stage's result
 * now, with the same event a real result emits (the app drains it on the next step like any other). Does nothing outside
 * a running stage of The Map.
 */
export const forceStageOutcomeForDevelopment = (session: ParkSession, outcome: 'succeeded' | 'failed'): void => {
  if (session.mode !== 'run' || session.run === null || session.run.phase !== 'stage') return;
  session.scenario?.forceResultForDevelopment(outcome);
};
