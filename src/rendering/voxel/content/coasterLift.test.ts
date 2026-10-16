import { describe, expect, it } from 'vitest';
import { COASTER_TYPE_BY_ID } from '../../../game/coaster/content';
import type { CoasterPiece } from '../../../game/coaster/design';
import { liftRuns, setLiftRunChained } from '../../../game/coaster/lift';
import { hillDipLayout, withFreeLifts } from '../../../game/coaster/testLayouts';
import { BUILD_BY_ID, BUILD_CATALOG } from '../../../game/content/catalog';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import type { BuildDefinition } from '../../../game/types';
import { createModelCache } from '../blueprint/compile';
import { BOX_FLOATS, BoxWriter, unpackBoxWord } from '../contracts/boxes';
import { MAT } from '../contracts/palette';
import { buildPalette } from '../palette';
import { CoasterDraft } from '../scene/coasterDraft';
import { REGISTRY_CONTENT, SceneModels } from '../scene/staticWorld';
import { coasterContent } from './coaster';

/**
 * Phase 27 step 4: the lift chain (dashes of MAT.FENCE_RAIL between the rails) is data-driven. A
 * climbing piece shows it only while its lift is chained; a free climb shows none, built or drafted.
 */

const PALETTE = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS);
const TYPE = COASTER_TYPE_BY_ID.get('star-chaser')!;
const DEFINITION: BuildDefinition = BUILD_BY_ID.get(TYPE.definitionId)!;
const models = (): SceneModels => new SceneModels(PALETTE, createModelCache(), REGISTRY_CONTENT, (message) => {
  throw new Error(message);
});

const chainDashes = (data: Float32Array, count: number): number => {
  let dashes = 0;
  for (let box = 0; box < count; box += 1) if (unpackBoxWord(data[box * BOX_FLOATS + 3]).material === MAT.FENCE_RAIL) dashes += 1;
  return dashes;
};

const builtDashes = (pieces: readonly CoasterPiece[]): number[] => {
  const perPiece: number[] = [];
  for (let index = 0; index < pieces.length; index += 1) {
    const writer = new BoxWriter(16);
    coasterContent.pieceBoxes(pieces, index, DEFINITION, PALETTE, 7, writer);
    perPiece.push(chainDashes(writer.data, writer.count));
  }
  return perPiece;
};

describe('lift chain strips follow the layout data', () => {
  it('shows chain dashes on a chained climb and none once that lift is free, leaving the other lift alone', () => {
    const chained = hillDipLayout();
    const runs = liftRuns(chained);
    expect(runs.length).toBeGreaterThanOrEqual(2);
    const before = builtDashes(chained);
    const mixed = hillDipLayout();
    setLiftRunChained(mixed, runs[1].start, false);
    const after = builtDashes(mixed);
    const free = hillDipLayout();
    for (const run of runs) setLiftRunChained(free, run.start, false);
    const none = builtDashes(free);
    const total = (list: number[]): number => list.reduce((sum, value) => sum + value, 0);
    expect(total(before), 'chained climbs have dashes').toBeGreaterThan(0);
    expect(total(none), 'a coaster with every lift free has no chain at all').toBe(0);
    expect(total(after), 'one lift freed removes some, not all').toBeGreaterThan(0);
    expect(total(after)).toBeLessThan(total(before));
    // The dashes of the first (still chained) lift are exactly as before.
    for (let index = 0; index <= runs[0].start + 1; index += 1) expect(after[index], `piece ${index}`).toBe(before[index]);
  });

  it('keeps every other box of the track the same when a lift is freed', () => {
    const chained = hillDipLayout();
    const free = withFreeLifts(hillDipLayout(), 'all');
    const count = (pieces: CoasterPiece[]): number => {
      const writer = new BoxWriter(16);
      for (let index = 0; index < pieces.length; index += 1) coasterContent.pieceBoxes(pieces, index, DEFINITION, PALETTE, 7, writer);
      return writer.count;
    };
    const difference = count(chained) - count(free);
    expect(difference).toBe(builtDashes(chained).reduce((sum, value) => sum + value, 0));
  });

  it('draws the draft with the same rule, open and closed, and rebuilds when a lift is toggled', () => {
    const shared = models();
    const draft = new CoasterDraft();
    const full = hillDipLayout();
    for (const pieces of [full, full.slice(0, 14)]) {
      const copy = pieces.map((piece) => ({ ...piece, cell: { ...piece.cell } }));
      const state = draft.resolve(copy, DEFINITION, true, shared)!;
      const chainedDashes = chainDashes(state.boxes, state.boxCount);
      expect(chainedDashes, 'a chained draft shows its chain').toBeGreaterThan(0);
      // A new array per edit (as the designer's toggle makes): the draft's own signature sees the flag too.
      const toggled = copy.map((piece) => ({ ...piece, cell: { ...piece.cell } }));
      for (const run of liftRuns(toggled)) setLiftRunChained(toggled, run.start, false);
      const freed = draft.resolve(toggled, DEFINITION, true, shared)!;
      expect(chainDashes(freed.boxes, freed.boxCount), 'the toggled draft rebuilds without chain').toBe(0);
    }
  });
});
