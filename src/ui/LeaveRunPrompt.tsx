import { useRef } from 'react';
import { runBridge } from './runBridge';
import { useModalFocus } from './a11yHooks';
import { describeLeaveRun } from './leaveRunModel';
import { useUiStore } from './store';

/** "Leave the run?" (Phase 23): the one autosave holds a run, so replacing it is asked first (in a park and on the start screen). `leaveRunModel.ts` has the words. */
export const LeaveRunPrompt = (): React.JSX.Element | null => {
  const prompt = useUiStore((state) => state.leaveRunPrompt);
  const run = useUiStore((state) => state.run);
  const rootRef = useRef<HTMLDivElement>(null);
  // The primary choice takes focus: Save first in a live park, Cancel on the start screen (nothing to save there).
  useModalFocus(prompt !== null, rootRef, prompt?.saved !== undefined ? '[data-leave-run="cancel"]' : '[data-leave-run="save-first"]');
  if (prompt === null) return null;
  const model = describeLeaveRun(prompt, run);
  return (
    <div ref={rootRef} className="scenario-picker-backdrop leave-run-backdrop" role="alertdialog" aria-modal="true" aria-labelledby="leave-run-title" aria-describedby="leave-run-text">
      <section className="leave-run">
        <h2 id="leave-run-title">{model.title}</h2>
        <p id="leave-run-text">{model.text}</p>
        <div className="leave-run-actions">
          {model.choices.map((choice) => (
            <button key={choice.id} type="button" className={choice.primary ? 'primary' : undefined} data-leave-run={choice.id} onClick={() => runBridge.resolveLeaveRun(choice.id)}>{choice.label}</button>
          ))}
        </div>
      </section>
    </div>
  );
};
