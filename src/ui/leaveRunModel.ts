import type { RunSnapshot, RunSummary } from '../game/run/types';
import { runIsOver, runPositionText } from './runCopy';
import type { LeaveRunPrompt } from './store';

/** Leaving an unfinished run: when to ask and what to say. */

/** True for a run that still has levels to play (a won or lost run has nothing to lose). */
export const shouldConfirmLeavingRun = (run: RunSummary | null): boolean => run !== null && !runIsOver(run.phase);

export type LeaveRunChoiceId = 'save-first' | 'leave' | 'cancel';

export interface LeaveRunModel {
  title: string;
  text: string;
  choices: Array<{ id: LeaveRunChoiceId; label: string; primary: boolean }>;
}

const LEAVING: Readonly<Record<LeaveRunPrompt['reason'], string>> = {
  'new-run': 'a new run',
  'new-park': 'a new park',
  scenario: 'a Scenario park',
  load: 'another save',
};

/**
 * `run` is the live run (the store's `run`); a missing run still gets a sensible question. A prompt raised from the start
 * screen names the autosaved run instead (`prompt.saved`) and has no "Save first": nothing is live there to save.
 */
export const describeLeaveRun = (prompt: LeaveRunPrompt, run: Pick<RunSnapshot, 'levelIndex' | 'levelCount' | 'seed'> | null): LeaveRunModel => {
  const leaving = LEAVING[prompt.reason];
  if (prompt.saved !== undefined) {
    return {
      title: 'Leave the run?',
      text: `Your run, ${runPositionText(prompt.saved)}, is kept only by the autosave, and ${leaving} will replace it there. To keep it, cancel, continue the run and save it to a slot.`,
      choices: [
        { id: 'cancel', label: 'Cancel', primary: true },
        { id: 'leave', label: 'Leave the run', primary: false },
      ],
    };
  }
  const where = run === null ? 'your run' : `your run, ${runPositionText({ levelNumber: run.levelIndex + 1, levelCount: run.levelCount, seed: run.seed })}`;
  return {
    title: 'Leave the run?',
    // True whether or not the run was autosaved yet: the autosave keeps one park, and what comes next takes its place.
    text: `Leaving now loses ${where}, unless you save it to a slot first: the autosave keeps only one park, and ${leaving} takes its place.`,
    choices: [
      { id: 'save-first', label: 'Save to a slot first', primary: true },
      { id: 'leave', label: 'Leave the run', primary: false },
      { id: 'cancel', label: 'Cancel', primary: false },
    ],
  };
};
