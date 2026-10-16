import { describe, expect, it } from 'vitest';
import { BUILD_BY_ID, BUILD_CATALOG } from '../../../game/content/catalog';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import { BOX_FLOATS } from '../contracts/boxes';
import type { CompiledModel } from '../contracts/blueprint';
import { visualQuarterTurn } from '../contracts/space';
import { contentFor } from '../content/registry';
import { buildPalette } from '../palette';
import { compileBlueprint, createModelCache, rotateModel } from './compile';

/** Phase 40: a building is drawn facing each of the four ways its rotation names. */
const palette = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS);
const stall = BUILD_BY_ID.get('picnic-pocket')!;
const pavilion = BUILD_BY_ID.get('comfort-pavilion')!;

/** The body's boxes as a sorted multiset of position, size and material (the word's turn bits dropped). */
const signature = (model: CompiledModel): string[] => {
  const body = model.parts[0];
  const rows: string[] = [];
  for (let box = 0; box < body.boxCount; box += 1) {
    const at = box * BOX_FLOATS;
    rows.push([0, 1, 2, 4, 5, 6].map((field) => body.boxes[at + field]).join(',') + `|${body.boxes[at + 3] % 2_097_152}`);
  }
  return rows.sort();
};

describe('Phase 40: four directions', () => {
  it('every rotation is its own visual turn', () => {
    expect([0, 1, 2, 3].map((rotation) => visualQuarterTurn(rotation as 0 | 1 | 2 | 3))).toEqual([0, 1, 2, 3]);
  });

  it.each([['picnic-pocket', stall], ['comfort-pavilion', pavilion]] as const)('%s: four distinct models, and four turns come back to the start', (_id, definition) => {
    const base = compileBlueprint(contentFor(definition.id).blueprint(definition, palette));
    const turns = [0, 1, 2, 3].map((turn) => rotateModel(base, turn as 0 | 1 | 2 | 3));
    expect(new Set(turns.map((model) => signature(model).join(';'))).size).toBe(4);
    expect(turns[2].footprint).toEqual(base.footprint);
    expect(turns[3].footprint).toEqual([base.footprint[1], base.footprint[0]]);
    expect(signature(rotateModel(turns[2], 2))).toEqual(signature(base));
    expect(signature(rotateModel(turns[1], 3))).toEqual(signature(base));
  });

  it('the model cache keeps all four turns apart', () => {
    const cache = createModelCache();
    const blueprint = contentFor(stall.id).blueprint(stall, palette);
    const models = [0, 1, 2, 3].map((turn) => cache.model(blueprint, turn as 0 | 1 | 2 | 3));
    expect(new Set(models).size).toBe(4);
    expect(cache.model(blueprint, 2)).toBe(models[2]);
    expect(cache.flat(blueprint, 3).boxCount).toBe(models[3].boxCount);
  });
});
