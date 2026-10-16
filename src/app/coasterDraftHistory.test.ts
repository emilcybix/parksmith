import { describe, expect, it } from 'vitest';
import { EMPTY_LIFT_HISTORY, MAX_LIFT_HISTORY, planDraftUndo, recordLiftToggle } from './coasterDraftHistory';

describe('coasterDraftHistory', () => {
  it('pops a piece when there is no toggle', () => {
    expect(planDraftUndo(EMPTY_LIFT_HISTORY, 10)).toEqual({ kind: 'pop-piece', history: [] });
  });

  it('reverts the newest toggle while the piece count still matches', () => {
    const history = recordLiftToggle(recordLiftToggle(EMPTY_LIFT_HISTORY, { pieceCount: 8, runStart: 3 }), { pieceCount: 10, runStart: 6 });
    const first = planDraftUndo(history, 10);
    expect(first.kind).toBe('revert-toggle');
    expect(first.kind === 'revert-toggle' && first.entry.runStart).toBe(6);
    expect(first.history).toHaveLength(1);
  });

  it('a piece laid after a toggle is undone before the toggle', () => {
    const history = recordLiftToggle(EMPTY_LIFT_HISTORY, { pieceCount: 10, runStart: 3 });
    const step = planDraftUndo(history, 11);
    expect(step.kind).toBe('pop-piece');
    // Back at ten pieces the toggle is the newest thing again.
    expect(planDraftUndo(step.history, 10).kind).toBe('revert-toggle');
  });

  it('forgets toggles that belonged to pieces that are gone', () => {
    const history = recordLiftToggle(EMPTY_LIFT_HISTORY, { pieceCount: 10, runStart: 3 });
    expect(planDraftUndo(history, 10).kind).toBe('revert-toggle');
    const step = planDraftUndo([{ pieceCount: 12, runStart: 4 }, { pieceCount: 10, runStart: 3 }], 11);
    expect(step.history).toEqual([{ pieceCount: 10, runStart: 3 }]);
  });

  it('is bounded', () => {
    let history = EMPTY_LIFT_HISTORY;
    for (let i = 0; i < MAX_LIFT_HISTORY + 20; i += 1) history = recordLiftToggle(history, { pieceCount: 5, runStart: 1 });
    expect(history).toHaveLength(MAX_LIFT_HISTORY);
  });
});
