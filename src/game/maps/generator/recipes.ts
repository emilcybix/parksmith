import type { BiomeId } from '../../biomes/types';
import type { Facing } from '../types';
import { GROUND_ALT, GROUND_BASE, GROUND_WATER, FACINGS } from '../types';
import { CELLS, SIZE, indexOf, inside, tryPlace, RESERVED_HALO } from './draft';
import {
  ADJACENT_SIDES, FAR_SIDE, TAG, bandAcross, blobCells, cellAt, clearHalo, lateralOfLane, rimWithAlt, sideAlong, sideDistance, smoothWater,
  withWaterCap, type GenContext, type Side,
} from './features';
import { scaled, topFraction, type PropRule, type Triple } from './place';

/**
 * The per-biome recipes (Phase 24 step 2): data tables for the prop rules and the code of each biome's terrain and
 * decision features. Every number here shapes the output, so a change is a GENERATOR_VERSION bump (the golden
 * hashes fail otherwise).
 */

export interface BiomeRecipe {
  readonly biome: BiomeId;
  /** Alt-ground patches over the remaining base land, in per mille of those cells; null = none. */
  readonly altFraction: ((ctx: GenContext) => number) | null;
  /** Water, beaches, bands (everything that changes the ground). Runs first. */
  readonly terrain: (ctx: GenContext) => void;
  /** Obstacle features that place props or mark regions the rules read. Runs after the halo is cleared. */
  readonly decide: (ctx: GenContext) => void;
  readonly rules: readonly PropRule[];
  readonly blurb: (facing: Facing, water: boolean) => string;
}

const rule = (
  kind: PropRule['kind'], zone: PropRule['zone'], normal: number,
  options: { cluster?: PropRule['cluster']; spacing?: number; max?: Triple | null; exact?: Triple } = {},
): PropRule => ({
  kind, zone, perMille: options.exact ?? scaled(normal), cluster: options.cluster ?? null, spacing: options.spacing ?? 0, maxCount: options.max ?? null,
});
const byDensity = (values: Triple) => (ctx: GenContext): number => values[ctx.density];
const cluster = (shift: 2 | 3 | 4, keep: number): PropRule['cluster'] => ({ shift, keep });

const GATE_EDGE: Readonly<Record<Facing, string>> = { north: 'south', south: 'north', east: 'west', west: 'east' };
const edge = (facing: Facing): string => GATE_EDGE[facing];

const gateCell = (ctx: GenContext): number => indexOf(ctx.draft.gate.x, ctx.draft.gate.y);

/** A free interior cell for a feature centre, found by up to 8 positional tries (never an unbounded loop). */
const featureCentre = (ctx: GenContext, tag: number, margin: number): number => {
  const span = SIZE - 2 * margin;
  let fallback = indexOf(margin, margin);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const x = margin + (ctx.noise.h(tag + attempt, 1, 0) % span);
    const y = margin + (ctx.noise.h(tag + attempt, 2, 0) % span);
    const index = indexOf(x, y);
    if (attempt === 0) fallback = index;
    if (ctx.draft.reserved[index] === 0 && ctx.draft.ground[index] !== GROUND_WATER) return index;
  }
  return fallback;
};

const markDisc = (ctx: GenContext, mask: Uint8Array, cx: number, cy: number, r: number, tag: number, value: 0 | 1): void => {
  for (const index of blobCells(ctx.noise, tag, cx, cy, r)) {
    if (ctx.draft.ground[index] === GROUND_WATER || (ctx.draft.reserved[index] & RESERVED_HALO) !== 0) continue;
    mask[index] = value;
  }
};

// ---------------------------------------------------------------------------------------------------------------
// Meadow: a pond with a brook, and groves to clear
// ---------------------------------------------------------------------------------------------------------------

const meadowTerrain = (ctx: GenContext): void => {
  if (!ctx.water) return;
  const { draft, noise } = ctx;
  const radius = noise.range(TAG.pond, 3, 5);
  const l = noise.range(TAG.pond + 1, -6, 6);
  const d = noise.range(TAG.pond + 2, 19, 25);
  const brookWidth = noise.range(TAG.brook, 1, 2);
  const centre = draft.frame.toWorld(l, d);
  const cx = Math.min(Math.max(centre.x, radius + 2), SIZE - 3 - radius);
  const cy = Math.min(Math.max(centre.y, radius + 2), SIZE - 3 - radius);
  withWaterCap(draft, (shrink) => {
    for (const index of blobCells(noise, TAG.pond + 3, cx, cy, Math.max(2, radius - (shrink >> 1)))) draft.ground[index] = GROUND_WATER;
    smoothWater(draft);
    // The brook runs from the pond to the far border, 1 to 2 wide, joined so it stays 4-connected.
    let previous = l;
    for (let depth = d; depth < SIZE; depth += 1) {
      const lateral = l + noise.meander(TAG.brook + 1, depth, 3, 2);
      for (let at = Math.min(previous, lateral); at <= Math.max(previous, lateral) + brookWidth - 1; at += 1) {
        const index = cellAt(ctx, at, depth);
        if (index >= 0) draft.ground[index] = GROUND_WATER;
      }
      previous = lateral;
    }
  });
};

const meadowDecide = (ctx: GenContext): void => {
  const { draft, noise, density } = ctx;
  const groves = noise.range(TAG.grove, 3, 5) + (density === 2 ? 1 : 0) - (density === 0 ? 1 : 0);
  for (let i = 0; i < groves; i += 1) {
    const centre = featureCentre(ctx, TAG.grove + 16 + i * 8, 3);
    markDisc(ctx, draft.forest, centre % SIZE, Math.floor(centre / SIZE), noise.range(TAG.grove + 8 + i, 3, 4), TAG.grove + 4, 1);
  }
};

// ---------------------------------------------------------------------------------------------------------------
// Seaside: sea on the far side (and sometimes one flank), a beach, a pier, islets
// ---------------------------------------------------------------------------------------------------------------

interface Sea { readonly side: Side; readonly depth: number; readonly beach: number }

const seaSides = (ctx: GenContext): Sea[] => {
  const { noise, facing } = ctx;
  const far = FAR_SIDE[facing];
  const sides: Side[] = [far];
  if (noise.h(TAG.seaExtra, 0, 0) % 2 === 0) sides.push(ADJACENT_SIDES[far][noise.pick(TAG.seaAdj, 2)]);
  return sides.map((side, i) => ({ side, depth: noise.range(TAG.seaDepth + i, 5, 8), beach: noise.range(TAG.seaBeach + i, 3, 6) }));
};

const seasideTerrain = (ctx: GenContext): void => {
  const { draft, noise } = ctx;
  if (!ctx.water) return;
  const seas = seaSides(ctx);
  const lagoon = noise.h(TAG.lagoon, 0, 0) % 10 < 3;
  const lagoonRadius = noise.range(TAG.lagoon + 1, 2, 3);
  const lagoonCentre = cellAt(ctx, noise.range(TAG.lagoon + 2, -8, 8), noise.range(TAG.lagoon + 3, 15, 22));
  const beach = new Uint8Array(CELLS);
  withWaterCap(draft, (shrink) => {
    beach.fill(0);
    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        const index = indexOf(x, y);
        seas.forEach((sea, i) => {
          const dist = sideDistance(sea.side, x, y);
          const along = sideAlong(sea.side, x, y);
          const shore = Math.max(2, sea.depth - shrink) + noise.meander(TAG.seaShore + i, along, 3, 2);
          if (dist < shore) draft.ground[index] = GROUND_WATER;
          else if (dist < shore + sea.beach + noise.meander(TAG.seaBeachEdge + i, along, 3, 1)) beach[index] = 1;
        });
      }
    }
    if (lagoon && lagoonCentre >= 0) {
      const cx = Math.min(Math.max(lagoonCentre % SIZE, 4), SIZE - 5);
      const cy = Math.min(Math.max(Math.floor(lagoonCentre / SIZE), 4), SIZE - 5);
      for (const index of blobCells(noise, TAG.lagoon + 4, cx, cy, lagoonRadius)) draft.ground[index] = GROUND_WATER;
    }
    smoothWater(draft);
  });
  for (let index = 0; index < CELLS; index += 1) if (beach[index] === 1 && draft.ground[index] === GROUND_BASE) draft.ground[index] = GROUND_ALT;
  if (lagoon) rimWithAlt(draft, 1);
};

const seasideDecide = (ctx: GenContext): void => {
  const { draft, noise } = ctx;
  if (!ctx.water) return;
  // The pier: straight out to sea from a beach cell on the far side, 4 to 6 cells of boardwalk on water.
  const far = FAR_SIDE[ctx.facing];
  const step = { N: [0, -1], S: [0, 1], W: [-1, 0], E: [1, 0] }[far];
  const origin = (along: number): [number, number] => (far === 'N' ? [along, SIZE - 1] : far === 'S' ? [along, 0] : far === 'W' ? [SIZE - 1, along] : [0, along]);
  const length = noise.range(TAG.pier, 4, 6);
  const start = noise.range(TAG.pier + 1, 4, SIZE - 5);
  for (let offset = 0; offset < SIZE; offset += 1) {
    const along = 1 + ((start - 1 + offset) % (SIZE - 2));
    const [ox, oy] = origin(along);
    // The first water cell walking from the inland border toward the sea, with land just before it.
    let first = -1;
    for (let k = 0; k < SIZE; k += 1) {
      if (draft.ground[indexOf(ox + step[0] * k, oy + step[1] * k)] === GROUND_WATER) { first = k; break; }
    }
    if (first < 1) continue;
    const cells: Array<[number, number]> = [];
    for (let k = first; k < first + length; k += 1) {
      const px = ox + step[0] * k;
      const py = oy + step[1] * k;
      if (!inside(px, py) || draft.ground[indexOf(px, py)] !== GROUND_WATER) break;
      cells.push([px, py]);
    }
    if (cells.length < 4) continue;
    if (cells.every(([px, py]) => draft.occupancy[indexOf(px, py)] === 0 && draft.reserved[indexOf(px, py)] === 0)) {
      for (const [px, py] of cells) tryPlace(draft, 'boardwalk-pier', px, py);
      break;
    }
  }
  // Islets: 1 to 3 sea stacks on 2x2 sand islets well offshore.
  const islets = noise.range(TAG.islet, 1, 3);
  let placed = 0;
  const order = Array.from({ length: CELLS }, (_, index) => index).sort((a, b) => (noise.h(TAG.islet + 1, a, 5) - noise.h(TAG.islet + 1, b, 5)) || (a - b));
  for (const index of order) {
    if (placed >= islets) break;
    const x = index % SIZE;
    const y = Math.floor(index / SIZE);
    let clear = true;
    for (let dy = -1; dy <= 2 && clear; dy += 1) {
      for (let dx = -1; dx <= 2; dx += 1) {
        const cx = x + dx;
        const cy = y + dy;
        if (!inside(cx, cy) || draft.ground[indexOf(cx, cy)] !== GROUND_WATER || draft.occupancy[indexOf(cx, cy)] !== 0) { clear = false; break; }
      }
    }
    if (!clear) continue;
    const cells = [indexOf(x, y), indexOf(x + 1, y), indexOf(x, y + 1), indexOf(x + 1, y + 1)];
    for (const cell of cells) draft.ground[cell] = GROUND_ALT;
    if (tryPlace(draft, 'sea-stack', x, y)) placed += 1;
    else for (const cell of cells) draft.ground[cell] = GROUND_WATER;
  }
};

// ---------------------------------------------------------------------------------------------------------------
// Desert Canyon: a canyon corridor of permanent walls with side passes choked by boulders
// ---------------------------------------------------------------------------------------------------------------

const desertDecide = (ctx: GenContext): void => {
  const { draft, noise, density } = ctx;
  const length = noise.range(TAG.wall, 20, 28);
  const walls: Array<{ lateral: number; tag: number }> = [
    { lateral: -noise.range(TAG.wall + 1, 5, 7), tag: 0 },
    { lateral: noise.range(TAG.wall + 2, 6, 8), tag: 1 },
  ];
  walls.forEach(({ lateral, tag }) => {
    const passes = noise.range(TAG.pass + tag, 2, 3) + (density === 0 ? -1 : 0);
    const gaps: number[] = [];
    for (let i = 0; i < passes; i += 1) {
      const at = 3 + (noise.h(TAG.pass + 8 + tag * 8 + i, 1, 0) % Math.max(1, length - 6));
      if (!gaps.some((other) => Math.abs(other - at) < 5)) gaps.push(at);
    }
    // One pass per wall stays open half the time.
    const openPass = noise.h(TAG.pass + 4 + tag, 0, 0) % 2 === 0 ? 0 : -1;
    for (let d = 1; d < length; d += 1) {
      const l = lateral + noise.meander(TAG.wall + 4 + tag, d, 3, 1);
      const index = gaps.findIndex((gap) => d >= gap && d < gap + 2 + (noise.h(TAG.pass + 20 + tag, gap, 0) & 1));
      const cell = draft.frame.toWorld(l, d);
      if (!inside(cell.x, cell.y)) continue;
      if (index >= 0) {
        if (index !== openPass) tryPlace(draft, 'red-boulder', cell.x, cell.y);
      } else {
        tryPlace(draft, 'canyon-wall', cell.x, cell.y);
      }
    }
  });
};

// ---------------------------------------------------------------------------------------------------------------
// Winter: thin ice, and a ring forest around an open hollow
// ---------------------------------------------------------------------------------------------------------------

const winterTerrain = (ctx: GenContext): void => {
  if (!ctx.water) return;
  const { draft, noise } = ctx;
  const radius = noise.range(TAG.ice, 4, 5);
  const left = noise.h(TAG.ice + 1, 0, 0) % 2 === 0;
  const lane = left ? noise.range(TAG.ice + 2, 4, 8) : noise.range(TAG.ice + 3, 23, 27);
  const depth = noise.range(TAG.ice + 4, 22, 26);
  const centre = cellAt(ctx, lateralOfLane(ctx, lane), depth);
  if (centre < 0) return;
  const cx = Math.min(Math.max(centre % SIZE, radius + 1), SIZE - 2 - radius);
  const cy = Math.min(Math.max(Math.floor(centre / SIZE), radius + 1), SIZE - 2 - radius);
  withWaterCap(draft, () => {
    for (const index of blobCells(noise, TAG.ice + 5, cx, cy, radius)) draft.ground[index] = GROUND_WATER;
    smoothWater(draft);
  });
};

const EIGHT: ReadonlyArray<readonly [number, number]> = [[1000, 0], [707, 707], [0, 1000], [-707, 707], [-1000, 0], [-707, -707], [0, -1000], [707, -707]];

const winterDecide = (ctx: GenContext): void => {
  const { draft, noise } = ctx;
  const radius = noise.range(TAG.ring, 8, 11);
  const centre = draft.frame.toWorld(noise.range(TAG.ring + 1, -4, 4), noise.range(TAG.ring + 2, 13, 16));
  const hollow = new Uint8Array(CELLS);
  for (const index of blobCells(noise, TAG.ring + 3, centre.x, centre.y, radius)) hollow[index] = 1;
  for (let index = 0; index < CELLS; index += 1) {
    if (hollow[index] === 0 && draft.ground[index] !== GROUND_WATER) draft.forest[index] = 1;
  }
  // 1 to 2 clearings cut through the ring.
  const clearings = noise.range(TAG.clearing, 1, 2);
  for (let i = 0; i < clearings; i += 1) {
    const [dx, dy] = EIGHT[noise.pick(TAG.clearing + 1 + i, 8)];
    const cx = centre.x + Math.round((dx * radius) / 1000);
    const cy = centre.y + Math.round((dy * radius) / 1000);
    markDisc(ctx, draft.forest, cx, cy, noise.range(TAG.clearing + 4 + i, 2, 3), TAG.clearing + 8, 0);
  }
};

// ---------------------------------------------------------------------------------------------------------------
// Jungle: a river with exactly one land bridge, dense near bank, ruins on the far bank
// ---------------------------------------------------------------------------------------------------------------

const jungleTerrain = (ctx: GenContext): void => {
  const { draft, noise } = ctx;
  const middle = noise.range(TAG.river, 18, 22);
  const width = noise.range(TAG.river + 1, 2, 4);
  const bridge = noise.range(TAG.bridge, 5, 26);
  const centre = (lane: number): number => middle + noise.meander(TAG.river + 2, lane, 3, 2);
  const band = bandAcross(ctx, centre, width, (lane) => ctx.water && lane >= bridge && lane < bridge + 3);
  for (const index of band) draft.ground[index] = ctx.water ? GROUND_WATER : GROUND_ALT;
  // Everything beyond the band is the far bank.
  for (let lane = 0; lane < SIZE; lane += 1) {
    for (let d = centre(lane) + width; d < SIZE; d += 1) {
      const index = cellAt(ctx, lateralOfLane(ctx, lane), d);
      if (index >= 0) draft.far[index] = 1;
    }
  }
};

// ---------------------------------------------------------------------------------------------------------------
// Autumn Forest: a stream with fords, and stone-walled paddocks
// ---------------------------------------------------------------------------------------------------------------

const autumnTerrain = (ctx: GenContext): void => {
  if (!ctx.water) return;
  const { draft, noise } = ctx;
  const middle = noise.range(TAG.stream, 16, 22);
  const fordA = noise.range(TAG.ford, 2, 12);
  const fordB = noise.range(TAG.ford + 1, 18, 28);
  const centre = (lane: number): number => middle + noise.meander(TAG.stream + 1, lane, 3, 3);
  for (const index of bandAcross(ctx, centre, 1, (lane) => (lane >= fordA && lane < fordA + 2) || (lane >= fordB && lane < fordB + 2))) {
    draft.ground[index] = GROUND_WATER;
  }
};

const autumnDecide = (ctx: GenContext): void => {
  const { draft, noise, density } = ctx;
  const lines = 1 + (noise.h(TAG.paddock, 0, 0) % 2) + (density === 2 ? 0 : 0);
  const first = noise.range(TAG.paddock + 1, 13, 17);
  const depths = lines === 1 ? [first] : [first, first + noise.range(TAG.paddock + 2, 4, 6)];
  const frame = draft.frame;
  depths.forEach((depth, lineIndex) => {
    const gaps = noise.range(TAG.paddock + 3 + lineIndex, 1, 3);
    const gapLanes: Array<{ lane: number; closed: boolean }> = [];
    for (let g = 0; g < gaps; g += 1) {
      const lane = 2 + (noise.h(TAG.paddock + 8 + lineIndex * 8 + g, 1, 0) % (SIZE - 5));
      if (!gapLanes.some((other) => Math.abs(other.lane - lane) < 5)) gapLanes.push({ lane, closed: noise.h(TAG.paddock + 40 + g, lineIndex, 0) % 2 === 0 });
    }
    for (let lane = 0; lane < SIZE; lane += 1) {
      const l = lateralOfLane(ctx, lane);
      const gap = gapLanes.find((candidate) => lane >= candidate.lane && lane < candidate.lane + 2);
      const cell = frame.toWorld(l, depth);
      if (gap) {
        if (gap.closed && lane === gap.lane) {
          const anchor = frame.rectToWorld(Math.min(l, lateralOfLane(ctx, lane + 1)), depth, 2, 1);
          tryPlace(draft, 'fallen-log', anchor.x, anchor.y, frame.rotation);
        }
      } else if (inside(cell.x, cell.y)) {
        tryPlace(draft, 'stone-wall', cell.x, cell.y);
      }
    }
  });
  // One cross wall from the gate edge side up to the first paddock line, at lateral <= -4 or >= 5.
  const side = noise.h(TAG.paddock + 60, 0, 0) % 2 === 0 ? -noise.range(TAG.paddock + 61, 4, 6) : noise.range(TAG.paddock + 62, 5, 7);
  const gapAt = noise.range(TAG.paddock + 63, 4, Math.max(5, depths[0] - 3));
  const closed = noise.h(TAG.paddock + 64, 0, 0) % 2 === 0;
  for (let d = 2; d < depths[0]; d += 1) {
    const cell = frame.toWorld(side, d);
    if (d >= gapAt && d < gapAt + 2) {
      if (closed && d === gapAt) {
        const anchor = frame.rectToWorld(side, d, 1, 2);
        tryPlace(draft, 'fallen-log', anchor.x, anchor.y, (1 - frame.rotation) as 0 | 1);
      }
    } else if (inside(cell.x, cell.y)) {
      tryPlace(draft, 'stone-wall', cell.x, cell.y);
    }
  }
};

const none = (): void => undefined;

export const BIOME_RECIPES: Readonly<Record<BiomeId, BiomeRecipe>> = {
  meadow: {
    biome: 'meadow',
    altFraction: null,
    terrain: meadowTerrain,
    decide: meadowDecide,
    rules: [
      rule('oak-tree', 'forest', 700),
      rule('oak-tree', 'open', 22),
      rule('shrub', 'shore', 150),
      rule('shrub', 'open', 45),
      rule('meadow-boulder', 'land', 6, { spacing: 5, max: [4, 6, 8] }),
      rule('mossy-log', 'land', 3, { max: [3, 4, 5] }),
      rule('great-oak', 'open', 4, { spacing: 10, max: [1, 2, 2] }),
    ],
    blurb: (facing, water) => `A generated meadow: the gate on the ${edge(facing)} edge, groves to clear${water ? ' and a pond with a brook' : ''}.`,
  },
  seaside: {
    biome: 'seaside',
    altFraction: (ctx) => (ctx.water ? [60, 100, 140][ctx.density] : [300, 400, 500][ctx.density]),
    terrain: seasideTerrain,
    decide: seasideDecide,
    rules: [
      rule('palm-tree', 'beach-edge', 430),
      rule('palm-tree', 'base', 40, { cluster: cluster(3, 350) }),
      rule('dune-grass', 'alt', 170, { cluster: cluster(2, 600) }),
      rule('tide-rock', 'shore', 200, { spacing: 2 }),
      rule('driftwood', 'alt', 15, { max: [2, 4, 5] }),
    ],
    blurb: (facing, water) => `A generated cove: the gate on the ${edge(facing)} edge, ${water ? 'sea along the far shore, a pier and ' : 'dune heath and '}palm lines to clear.`,
  },
  'desert-canyon': {
    biome: 'desert-canyon',
    altFraction: byDensity([180, 250, 320]),
    terrain: none,
    decide: desertDecide,
    rules: [
      rule('saguaro', 'land', 90, { cluster: cluster(3, 300), spacing: 2 }),
      rule('barrel-cactus', 'land', 120, { cluster: cluster(3, 300) }),
      rule('red-boulder', 'land', 22),
      rule('rock-spire', 'alt', 30, { spacing: 6, max: [2, 3, 4] }),
    ],
    blurb: (facing) => `A generated canyon: the gate on the ${edge(facing)} edge, rock walls to follow and boulders to blast through.`,
  },
  winter: {
    biome: 'winter',
    altFraction: byDensity([180, 250, 320]),
    terrain: winterTerrain,
    decide: winterDecide,
    rules: [
      rule('snowy-pine', 'forest', 300),
      rule('snowy-pine', 'open', 25),
      rule('snow-drift', 'forest', 60),
      rule('snow-drift', 'open', 20),
      rule('snowman', 'open', 6, { spacing: 6, max: [3, 5, 6] }),
      rule('granite-boulder', 'land', 6),
      rule('glacier-rock', 'forest', 4, { spacing: 6, max: [1, 2, 3] }),
    ],
    blurb: (facing, water) => `A generated hollow: the gate on the ${edge(facing)} edge, a ring of pines${water ? ', thin ice' : ''} and room to grow inside.`,
  },
  jungle: {
    biome: 'jungle',
    altFraction: byDensity([150, 200, 260]),
    terrain: jungleTerrain,
    decide: none,
    rules: [
      rule('temple-ruin', 'far', 8, { spacing: 7, max: [2, 3, 4] }),
      rule('kapok-tree', 'near', 330, { cluster: cluster(3, 450) }),
      rule('kapok-tree', 'far', 100, { cluster: cluster(3, 400) }),
      rule('fern', 'land', 160, { cluster: cluster(2, 450) }),
      rule('jungle-bloom', 'land', 100),
      rule('mossy-rock', 'land', 6),
    ],
    blurb: (facing, water) => `A generated jungle: the gate on the ${edge(facing)} edge, ${water ? 'a river with one land bridge' : 'a mud flat'} and ruins beyond.`,
  },
  'autumn-forest': {
    biome: 'autumn-forest',
    altFraction: byDensity([180, 250, 320]),
    terrain: autumnTerrain,
    decide: autumnDecide,
    rules: [
      rule('maple-tree', 'land', 230, { cluster: cluster(3, 400) }),
      rule('golden-birch', 'land', 150, { cluster: cluster(3, 400) }),
      rule('pumpkin-patch', 'land', 60),
      rule('toadstools', 'land', 50),
      rule('fallen-log', 'land', 6, { max: [2, 4, 5] }),
    ],
    blurb: (facing, water) => `A generated woodland: the gate on the ${edge(facing)} edge, stone-walled paddocks${water ? ' and a stream' : ''}.`,
  },
};

export const altPatches = (ctx: GenContext, recipe: BiomeRecipe): void => {
  if (recipe.altFraction === null) return;
  const { draft, noise } = ctx;
  const fraction = recipe.altFraction(ctx);
  const mask = topFraction(
    (index) => noise.fbm(TAG.alt, index % SIZE, Math.floor(index / SIZE)),
    (index) => draft.ground[index] === GROUND_BASE && index !== gateCell(ctx),
    fraction,
  );
  for (let index = 0; index < CELLS; index += 1) if (mask[index] === 1) draft.ground[index] = GROUND_ALT;
};

export const finishTerrain = (ctx: GenContext, recipe: BiomeRecipe): void => {
  recipe.terrain(ctx);
  altPatches(ctx, recipe);
  clearHalo(ctx.draft);
};

export { FACINGS };
