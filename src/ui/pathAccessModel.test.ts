import { describe, expect, it } from 'vitest';
import {
  NO_PATH_ACCESS_NOTE, NO_PATH_ACCESS_ROW_CLASS, NO_PATH_ACCESS_ROW_SUFFIX, estateRowStatus, lacksPathAccess, pathAccessNote,
} from './pathAccessModel';

describe('path access copy (Phase 11, PA-024)', () => {
  it('finds ids in the sorted list', () => {
    const ids = [2, 5, 9, 14, 30];
    for (const id of ids) expect(lacksPathAccess(ids, id), String(id)).toBe(true);
    for (const id of [0, 1, 3, 10, 31]) expect(lacksPathAccess(ids, id), String(id)).toBe(false);
    expect(lacksPathAccess([], 1)).toBe(false);
    expect(lacksPathAccess([7], 7)).toBe(true);
  });

  it('appends the estate row suffix and names the class', () => {
    expect(estateRowStatus('Running', true)).toBe('Running · no path access');
    expect(estateRowStatus('Running', false)).toBe('Running');
    expect(NO_PATH_ACCESS_ROW_SUFFIX).toBe(' · no path access');
    expect(NO_PATH_ACCESS_ROW_CLASS).toBe('no-access');
  });

  it('words the inspector note', () => {
    expect(pathAccessNote(true)).toBe('No path access: no path from the gate reaches it, so guests cannot use it.');
    expect(pathAccessNote(false)).toBeNull();
    expect(NO_PATH_ACCESS_NOTE).toBe(pathAccessNote(true));
  });
});
