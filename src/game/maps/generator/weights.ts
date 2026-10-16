import { propFootprintSize } from '../parse';
import { PROP_KIND_BY_ID, type PropKindId } from '../props';
import type { MapLayout, PropPlacement } from '../types';

/**
 * Game-side UPPER BOUNDS of the voxel box count of each prop kind (the measured value rounded up to a multiple of
 * 5, from the voxel registry content; a renderer test asserts measured <= weight). The generator caps the summed
 * weight per 8x8 chunk and per map (GAME_CONFIG.maps.generator), which is how it respects the voxel box budget
 * BY CONSTRUCTION without importing the renderer. Changing a weight or a cap changes generator output: bump
 * GENERATOR_VERSION.
 */
export const PROP_BOX_WEIGHT: Readonly<Record<PropKindId, number>> = Object.freeze({
  'oak-tree': 35, shrub: 30, 'meadow-boulder': 20, 'mossy-log': 40, 'great-oak': 30,
  'palm-tree': 115, 'dune-grass': 95, driftwood: 110, 'sea-stack': 30, 'tide-rock': 40, 'boardwalk-pier': 40,
  saguaro: 20, 'barrel-cactus': 15, 'red-boulder': 15, 'canyon-wall': 10, 'rock-spire': 25,
  'snowy-pine': 35, 'snow-drift': 20, snowman: 60, 'granite-boulder': 15, 'glacier-rock': 25,
  'kapok-tree': 30, fern: 40, 'jungle-bloom': 20, 'mossy-rock': 25, 'temple-ruin': 35,
  'maple-tree': 25, 'golden-birch': 25, 'pumpkin-patch': 35, toadstools: 45, 'fallen-log': 40, 'stone-wall': 5,
});

export const CHUNK_TILES = 8;

/** The weight a prop adds to each footprint cell: its box weight split evenly, rounded up. */
export const weightPerCell = (kind: PropKindId): number => {
  const definition = PROP_KIND_BY_ID.get(kind);
  if (!definition) return 0;
  return Math.ceil(PROP_BOX_WEIGHT[kind] / (definition.footprint[0] * definition.footprint[1]));
};

/** Summed prop weight per 8x8 chunk, row-major (the generator's cap is checked on exactly this). */
export const propWeightPerChunk = (layout: Pick<MapLayout, 'width' | 'height'>, props: readonly PropPlacement[]): number[] => {
  const perRow = Math.ceil(layout.width / CHUNK_TILES);
  const perColumn = Math.ceil(layout.height / CHUNK_TILES);
  const chunks = new Array<number>(perRow * perColumn).fill(0);
  for (const prop of props) {
    const kind = PROP_KIND_BY_ID.get(prop.kind);
    if (!kind) continue;
    const cell = weightPerCell(prop.kind);
    const [w, d] = propFootprintSize(kind, prop.rotation);
    for (let dy = 0; dy < d; dy += 1) {
      for (let dx = 0; dx < w; dx += 1) {
        chunks[Math.floor((prop.y + dy) / CHUNK_TILES) * perRow + Math.floor((prop.x + dx) / CHUNK_TILES)] += cell;
      }
    }
  }
  return chunks;
};
