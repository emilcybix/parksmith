import type { PropKindId } from '../../../../game/maps/props';
import type { PropContent } from '../../contracts/content';
import { greatOak, meadowBoulder, mossyLog, oakTree, shrub } from './meadow';
import { mapleTree, goldenBirch, pumpkinPatch, toadstools, fallenLog, stoneWall } from './autumn';
import { barrelCactus, canyonWall, redBoulder, rockSpire, saguaro } from './desert';
import { fern, jungleBloom, kapokTree, mossyRock, templeRuin } from './jungle';
import { duneGrass, driftwood, palmTree, seaStack, tideRock, boardwalkPier } from './seaside';
import { glacierRock, graniteBoulder, snowDrift, snowman, snowyPine } from './winter';

/** Every prop kind's content (props.test.ts requires an entry for each PROP_KINDS id). */
export const PROP_CONTENT: Readonly<Record<PropKindId, PropContent>> = {
  'oak-tree': oakTree,
  shrub,
  'meadow-boulder': meadowBoulder,
  'mossy-log': mossyLog,
  'great-oak': greatOak,
  'palm-tree': palmTree,
  'dune-grass': duneGrass,
  driftwood: driftwood,
  'sea-stack': seaStack,
  'tide-rock': tideRock,
  'boardwalk-pier': boardwalkPier,
  saguaro: saguaro,
  'barrel-cactus': barrelCactus,
  'red-boulder': redBoulder,
  'canyon-wall': canyonWall,
  'rock-spire': rockSpire,
  'snowy-pine': snowyPine,
  'snow-drift': snowDrift,
  snowman: snowman,
  'granite-boulder': graniteBoulder,
  'glacier-rock': glacierRock,
  'kapok-tree': kapokTree,
  fern: fern,
  'jungle-bloom': jungleBloom,
  'mossy-rock': mossyRock,
  'temple-ruin': templeRuin,
  'maple-tree': mapleTree,
  'golden-birch': goldenBirch,
  'pumpkin-patch': pumpkinPatch,
  toadstools: toadstools,
  'fallen-log': fallenLog,
  'stone-wall': stoneWall,
};
