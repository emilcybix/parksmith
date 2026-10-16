import { describe, expect, it } from 'vitest';
import { EMPTY_UNDO_STATUS } from '../app/undo/constants';
import type { UndoStatus } from '../app/undo/types';
import { describeUndoButton } from './undoModel';

const ready: UndoStatus = {
  ...EMPTY_UNDO_STATUS,
  canUndo: true,
  depth: 3,
  label: 'Undo · rewinds 42 s',
  tooltip: 'Undo Ferris Wheel demolished: rewinds the whole park by 42 s (Ctrl+Z)',
  target: 'Ferris Wheel demolished',
  kind: 'demolition',
  rewindSeconds: 42,
  cashAfterUndo: 4200,
  reason: null,
  message: '',
};

describe('describeUndoButton', () => {
  it('greys out and explains an empty ring without hiding the control', () => {
    const model = describeUndoButton(EMPTY_UNDO_STATUS);
    expect(model.className, 'unavailable class keeps the dock layout').toBe('undo-tab unavailable');
    expect(model.disabled).toBe(true);
    expect(model.depthBadge, 'no badge while disabled').toBeNull();
    expect(model.ariaLabel).toBe('Undo, unavailable: Nothing to undo yet');
    expect(model.title).toContain('Nothing to undo yet');
  });

  it('shows the rewind in the label and the step count as a badge', () => {
    const model = describeUndoButton(ready);
    expect(model.label).toBe('Undo · rewinds 42 s');
    expect(model.className).toBe('undo-tab');
    expect(model.depthBadge).toBe(3);
    expect(model.ariaLabel).toBe('Undo · rewinds 42 s: Ferris Wheel demolished. 3 steps available');
    expect(model.disabled).toBe(false);
  });

  it('shows no badge for a single step and says "1 step"', () => {
    const model = describeUndoButton({ ...ready, depth: 1 });
    expect(model.depthBadge).toBeNull();
    expect(model.ariaLabel).toContain('1 step available');
  });

  it('marks an armed rewind and asks for the second press in words', () => {
    const model = describeUndoButton({ ...ready, armed: true, needsConfirmation: true, label: 'Confirm rewind 3 min 20 s' });
    expect(model.className).toBe('undo-tab armed');
    expect(model.armed).toBe(true);
    expect(model.ariaLabel).toBe('Confirm rewind 3 min 20 s. Press again to confirm. Ferris Wheel demolished');
  });

  it('says why undo is closed after a scenario ended', () => {
    const model = describeUndoButton({
      ...EMPTY_UNDO_STATUS,
      reason: 'scenario-ended',
      message: 'The scenario is over, so nothing can be rewound',
    });
    expect(model.ariaLabel).toContain('The scenario is over');
    expect(model.disabled).toBe(true);
  });
});
