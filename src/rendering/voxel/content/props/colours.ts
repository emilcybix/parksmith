import { MAT_COLOR } from '../../contracts/palette';

/**
 * The colours the prop art uses, by rgb. The fixed ones are `MAT_COLOR` values; the others are the NEW palette
 * colours the biomes declare in game/maps/props.ts and game/biomes/content.ts (`colors` / ground), registered by
 * `collectBiomeMaterials`. props.test.ts pins both lists against each other: every colour a blueprint asks the palette
 * for is either a fixed colour or listed in its kind's `colors`.
 */
export const C = {
  // Fixed materials.
  FOLIAGE: MAT_COLOR.FOLIAGE,
  FOLIAGE_DARK: MAT_COLOR.FOLIAGE_DARK,
  WOOD: MAT_COLOR.WOOD,
  TIMBER: MAT_COLOR.TIMBER,
  STONE: MAT_COLOR.STONE,
  FLOWER_PINK: MAT_COLOR.FLOWER_PINK,
  ARCH_PINK: MAT_COLOR.ARCH_PINK,
  WHITE: MAT_COLOR.WHITE,
  INK: MAT_COLOR.INK,
  SIGN: MAT_COLOR.SIGN,
  MECHANIC: MAT_COLOR.MECHANIC_UNIFORM,
  TRACK: MAT_COLOR.TRACK,
  SOIL: MAT_COLOR.SOIL,
  // Seaside.
  PALM_TRUNK: 0xc49a6c,
  DRIFTWOOD: 0xd2c3a8,
  SEA_ROCK: 0x8a9aa0,
  SAND: 0xf8d384,
  // Desert Canyon.
  CACTUS: 0x5fa463,
  CANYON_ROCK: 0xb8643f,
  CANYON_STRATA: 0xa65a3c,
  RED_ROCK_FLOOR: 0xc97a52,
  // Winter.
  SNOW: 0xf2f7fc,
  PACKED_SNOW: 0xdfe9f3,
  THIN_ICE: 0xb9e2f2,
  GRANITE: 0x8e939c,
  CARROT: 0xf4b94e,
  // Jungle.
  JUNGLE_LEAF: 0x2e8b4a,
  RUIN_STONE: 0xa9a48c,
  BLOOM_YELLOW: 0xffcf56,
  // Autumn Forest.
  MAPLE_RED: 0xd6503a,
  MAPLE_ORANGE: 0xf08b3a,
  BIRCH_GOLD: 0xf3c24f,
} as const;
