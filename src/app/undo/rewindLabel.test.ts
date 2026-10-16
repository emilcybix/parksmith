import { describe, expect, it } from 'vitest';
import { confirmButtonLabel, formatRewind, rewindSecondsBetween, undoButtonLabel } from './rewindLabel';

describe('formatRewind', () => {
  it.each([
    [0, '0 s'],
    [1, '1 s'],
    [42, '42 s'],
    [59, '59 s'],
    [60, '1 min'],
    [61, '1 min 1 s'],
    [200, '3 min 20 s'],
    [3_599, '59 min 59 s'],
    [3_600, '1 h'],
    [3_900, '1 h 5 min'],
    [7_322, '2 h 2 min'],
  ])('%i s reads "%s"', (seconds, expected) => {
    expect(formatRewind(seconds)).toBe(expected);
  });

  it('floors fractions and clamps negatives', () => {
    expect(formatRewind(41.9)).toBe('41 s');
    expect(formatRewind(-5)).toBe('0 s');
  });
});

describe('button labels', () => {
  it('says just "Undo" below one simulated second (for example while paused)', () => {
    expect(undoButtonLabel(0)).toBe('Undo');
  });

  it('states how far an undo rewinds', () => {
    expect(undoButtonLabel(1)).toBe('Undo · rewinds 1 s');
    expect(undoButtonLabel(42)).toBe('Undo · rewinds 42 s');
    expect(undoButtonLabel(200)).toBe('Undo · rewinds 3 min 20 s');
    expect(undoButtonLabel(3_900)).toBe('Undo · rewinds 1 h 5 min');
  });

  it('asks for the second press when armed', () => {
    expect(confirmButtonLabel(200)).toBe('Confirm rewind 3 min 20 s');
  });
});

describe('rewindSecondsBetween', () => {
  it('counts whole simulated seconds and never goes negative', () => {
    expect(rewindSecondsBetween(1_000, 43_999)).toBe(42);
    expect(rewindSecondsBetween(5_000, 1_000)).toBe(0);
  });
});
