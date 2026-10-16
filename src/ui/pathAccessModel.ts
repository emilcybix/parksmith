/**
 * Pure copy for rides and services that no path from the gate reaches (Phase 11, PA-024): the estate row suffix and
 * class, and the inspector note, which is the text equivalent of the voxel `no-access` badge. GameApp publishes the
 * ids as `noPathAccessIds` (sorted ascending, a new array only when the content changes).
 */

export const NO_PATH_ACCESS_ROW_SUFFIX = ' · no path access';
export const NO_PATH_ACCESS_ROW_CLASS = 'no-access';
export const NO_PATH_ACCESS_NOTE = 'No path access: no path from the gate reaches it, so guests cannot use it.';

/** Whether `objectId` is in the sorted `noPathAccessIds` (binary search; no allocation). */
export const lacksPathAccess = (noPathAccessIds: readonly number[], objectId: number): boolean => {
  let low = 0;
  let high = noPathAccessIds.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const value = noPathAccessIds[middle];
    if (value === objectId) return true;
    if (value < objectId) low = middle + 1;
    else high = middle - 1;
  }
  return false;
};

/** The estate row's `<em>` text: the existing status, with ` · no path access` appended when it lacks access. */
export const estateRowStatus = (status: string, noAccess: boolean): string =>
  noAccess ? `${status}${NO_PATH_ACCESS_ROW_SUFFIX}` : status;

/** The inspector `p.inspector-warning` (`role="note"`) text, or null when the object has access. */
export const pathAccessNote = (noAccess: boolean): string | null => (noAccess ? NO_PATH_ACCESS_NOTE : null);
