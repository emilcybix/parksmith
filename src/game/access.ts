import { footprintSize, frontOf, type BuildDefinition, type Cell, type Rotation } from './types';

/**
 * Phase 40: the cells just outside a footprint's front edge (one per front edge cell, in order along the edge). The
 * front follows the rotation (`frontOf`): 0 → +y, 1 → +x, 2 → −y, 3 → −x. Pure; the cells may lie off the map.
 */
export const frontEdgeCells = (definition: BuildDefinition, anchor: Cell, rotation: Rotation): Cell[] => {
  const [width, depth] = footprintSize(definition, rotation);
  const front = frontOf(rotation);
  const cells: Cell[] = [];
  if (front.y !== 0) {
    const y = front.y > 0 ? anchor.y + depth : anchor.y - 1;
    for (let x = anchor.x; x < anchor.x + width; x += 1) cells.push({ x, y });
  } else {
    const x = front.x > 0 ? anchor.x + width : anchor.x - 1;
    for (let y = anchor.y; y < anchor.y + depth; y += 1) cells.push({ x, y });
  }
  return cells;
};

/** Phase 40: whether a kind of building has a front that means something (the ghost marks it). Scenery and paths do not. */
export const hasMeaningfulFront = (definition: BuildDefinition): boolean =>
  definition.kind === 'ride' || definition.kind === 'shop' || definition.kind === 'facility' || definition.kind === 'amenity';
