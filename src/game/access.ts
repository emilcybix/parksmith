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

/**
 * Phase 40: the kinds guests use from the front only, in a park whose ruleset has `frontAccess`: services (food, drink,
 * souvenirs, toilets) and benches. Rides keep every side (a real queue entrance belongs with custom queue paths), and
 * bins and scenery have no access at all.
 */
export const isFrontOnly = (definition: BuildDefinition): boolean =>
  definition.stats?.serviceType !== undefined || (definition.kind === 'amenity' && definition.stats?.amenityType === undefined);

/**
 * Phase 40: the rotations to try, in order, when turning a building to face a path without moving it: the one given,
 * the half turn (same footprint), and for a square footprint the two quarter turns.
 */
export const sameFootprintRotations = (definition: BuildDefinition, rotation: Rotation): Rotation[] => {
  const turns: Rotation[] = [rotation, ((rotation + 2) % 4) as Rotation];
  if (definition.footprint[0] === definition.footprint[1]) turns.push(((rotation + 1) % 4) as Rotation, ((rotation + 3) % 4) as Rotation);
  return turns;
};
