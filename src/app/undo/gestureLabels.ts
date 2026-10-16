/**
 * What a construction gesture is called in the Undo control, its tooltip and its toast ("Undid
 * <label> · rewound 42 s"). Kept next to the ring and free of GameApp so the wording is testable.
 */

/** "1 path tile built", "12 path tiles built". */
export const pathsBuiltLabel = (tiles: number): string =>
  `${tiles} path tile${tiles === 1 ? '' : 's'} built`;

/** "Ferris Wheel built". */
export const objectBuiltLabel = (name: string): string => `${name} built`;

/** The label `World.bulldoze` reports for a bare path tile. */
const PATH_TILE_LABEL = 'a path tile';

/**
 * A bulldozer drag is one gesture however many things it crossed, named by what it took out:
 * "Ferris Wheel demolished" for one thing, "5 path tiles demolished" when every tile was a path,
 * "7 things demolished" when it was a mixture.
 */
export const demolitionLabel = (removedLabels: readonly string[], clearedCount = 0): string => {
  if (removedLabels.length === 0) return 'Demolition';
  // Phase 24: a drag that only cleared props ("Red boulder cleared", "3 obstacles cleared").
  if (clearedCount > 0 && clearedCount === removedLabels.length) {
    return removedLabels.length === 1 ? `${removedLabels[0]} cleared` : `${removedLabels.length} obstacles cleared`;
  }
  if (removedLabels.length === 1) {
    const only = removedLabels[0];
    return only === PATH_TILE_LABEL ? 'Path tile demolished' : `${only} demolished`;
  }
  const allPaths = removedLabels.every((label) => label === PATH_TILE_LABEL);
  return allPaths
    ? `${removedLabels.length} path tiles demolished`
    : `${removedLabels.length} things demolished`;
};

/** "Aurora Wheel recoloured": a colour change on one ride (Phase 28). Several picks on one ride are one entry. */
export const recolourLabel = (name: string): string => `${name} recoloured`;

/** "Coach Party played": a one-shot card played in a run stage (Phase 25). Undo brings the card back, ready. */
export const cardPlayedLabel = (name: string): string => `${name} played`;
